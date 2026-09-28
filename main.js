'use strict';

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, session, clipboard } = require('electron');
const path = require('path');
const settings = require('./lib/settings');
const adblock = require('./lib/adblock');
const { normalizeInput, sameSite, isWebUrl, displayHost } = require('./lib/urlutil');

const TOOLBAR_H = 48;
const START_PAGE = path.join(__dirname, 'ui', 'start.html');
const ERROR_PAGE = path.join(__dirname, 'ui', 'error.html');
const NOTICE_MS = 8000;
const IS_MAC = process.platform === 'darwin';
const APP_ID = 'com.aag1091.videoonly';
const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

// Optional separate profile folder (used by the tests so each run starts clean).
if (process.env.VO_PROFILE_DIR) app.setPath('userData', process.env.VO_PROFILE_DIR);

// ---------- startup switches ----------
// Let isolated players resume playback without a fresh click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Sites treat the default "Electron/xx" UA oddly; present as plain Chrome of the same version.
function chromeUA() {
  const chrome = process.versions.chrome.split('.')[0];
  const os =
    process.platform === 'win32'
      ? 'Windows NT 10.0; Win64; x64'
      : process.platform === 'darwin'
        ? 'Macintosh; Intel Mac OS X 10_15_7'
        : 'X11; Linux x86_64';
  return `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`;
}
app.userAgentFallback = chromeUA();

function urlFromArgs(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  for (const a of args) {
    if (a.startsWith('--url=')) return a.slice(6);
    if (/^https?:\/\//i.test(a)) return a;
  }
  return null;
}

// ---------- state ----------
let win = null;
let view = null;
let adblockReady = null; // promise
let noticeTimer = null;
let noticeSeq = 0;
let isolateGen = 0;
let uiReady = false;
let pushQueued = false;

const state = {
  url: '',
  pendingUrl: null,
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  voActive: false,
  voFrame: null, // WebFrameMain currently isolated (not sent to UI)
  voArea: 0,
  voMode: settings.get('voMode') === 'video' ? 'video' : 'player',
  autoVideo: !!settings.get('autoVideo'),
  // user turned video-only off by hand: auto mode may only re-enter for a clearly bigger video
  autoSuppressArea: null,
  staySite: !!settings.get('staySite'),
  adblock: !!settings.get('adblock'),
  adblockStatus: 'loading',
  userNav: false, // navigation started from the address bar (redirects allowed)
  htmlFullscreen: false,
  weSetFullscreen: false,
  counts: { popups: 0, redirects: 0, downloads: 0, ads: 0 },
  blocked: [], // recent { kind, url, t }
  notice: null,
};

function uiState() {
  const isInternal = !state.url || state.url.startsWith('file:');
  return {
    url: state.pendingUrl || (isInternal ? '' : state.url),
    title: state.title,
    loading: state.loading,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    voActive: state.voActive,
    voMode: state.voMode,
    autoVideo: state.autoVideo,
    staySite: state.staySite,
    adblock: state.adblock,
    adblockStatus: state.adblockStatus,
    counts: state.counts,
    notice: state.notice,
  };
}

function pushState() {
  if (pushQueued) return;
  pushQueued = true;
  setImmediate(() => {
    pushQueued = false;
    if (win && !win.isDestroyed() && uiReady) win.webContents.send('vo:state', uiState());
  });
}

function showNotice(n) {
  state.notice = { id: ++noticeSeq, ...n };
  pushState();
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    state.notice = null;
    pushState();
  }, n.ms || NOTICE_MS);
}

function recordBlock(kind, url) {
  const key = kind === 'popup' ? 'popups' : kind === 'redirect' ? 'redirects' : 'downloads';
  state.counts[key]++;
  const recent = state.blocked[0];
  const dup = recent && recent.url === url && Date.now() - recent.t < 2000;
  if (!dup) {
    state.blocked.unshift({ kind, url, t: Date.now() });
    state.blocked = state.blocked.slice(0, 25);
    const label = kind === 'popup' ? 'Popup blocked:' : kind === 'redirect' ? 'Redirect blocked:' : 'Download blocked:';
    showNotice({ kind, label, text: displayHost(url), url: kind === 'download' ? null : url, openLabel: 'Open here' });
  }
  pushState();
}

// ---------- window ----------
function createWindow() {
  const bounds = settings.get('windowBounds') || {};
  uiReady = false;
  win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 820,
    x: bounds.x,
    y: bounds.y,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#15171c',
    title: 'VideoOnly Browser',
    autoHideMenuBar: true,
    show: false,
    // macOS takes the icon from the app bundle; Windows/Linux dev runs need it here
    ...(IS_MAC ? {} : { icon: path.join(__dirname, 'ui', 'icon.png') }),
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'ui', 'toolbar.html'));

  view = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'content-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      nodeIntegrationInSubFrames: true, // so the preload runs in every iframe too
    },
  });
  view.setBackgroundColor('#0b0c10');
  win.contentView.addChildView(view);
  layout();

  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, layout);
  win.on('leave-full-screen', () => {
    // user left window fullscreen (F11/Esc) while the page thought it was fullscreen
    if (state.htmlFullscreen) view.webContents.executeJavaScript('document.exitFullscreen && document.exitFullscreen()').catch(() => {});
  });
  win.on('close', () => {
    if (!win.isFullScreen() && !win.isMaximized()) settings.set('windowBounds', win.getBounds());
  });
  win.on('closed', () => {
    win = null;
    view = null;
  });
  win.once('ready-to-show', () => win.show());

  wireContent(view.webContents);
  win.webContents.on('before-input-event', (e, input) => handleShortcut(e, input, win.webContents));
  view.webContents.loadFile(START_PAGE);
}

function layout() {
  if (!win || win.isDestroyed() || !view) return;
  const { width, height } = win.getContentBounds();
  const top = state.htmlFullscreen ? 0 : TOOLBAR_H;
  view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
}

// ---------- content events ----------
function wireContent(wc) {
  // 1. Popups: every window.open / target=_blank / popunder is denied and logged.
  wc.setWindowOpenHandler(({ url }) => {
    recordBlock('popup', url);
    return { action: 'deny' };
  });

  // 2. Redirect guard: the page may not send the main frame to another site on its own.
  const guard = (event, url) => guardNavigation(event, url);
  wc.on('will-navigate', guard);
  wc.on('will-redirect', guard);

  // 3. "Are you sure you want to leave?" traps are ignored.
  wc.on('will-prevent-unload', (event) => event.preventDefault());

  wc.on('did-start-loading', () => {
    state.loading = true;
    pushState();
  });
  wc.on('did-stop-loading', () => {
    state.loading = false;
    state.userNav = false;
    state.pendingUrl = null;
    syncNav();
    pushState();
  });
  wc.on('did-navigate', (_e, url) => {
    // new document in the main frame: any isolation is gone with the old DOM
    state.url = url;
    state.pendingUrl = null;
    state.userNav = false;
    state.voActive = false;
    state.voFrame = null;
    state.voArea = 0;
    state.autoSuppressArea = null;
    state.speed = 1;
    state.counts = { popups: 0, redirects: 0, downloads: 0, ads: 0 };
    state.blocked = [];
    syncNav();
    pushState();
  });
  wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
    if (!isMainFrame) return;
    state.url = url;
    syncNav();
    pushState();
  });
  wc.on('page-title-updated', (_e, title) => {
    state.title = title;
    if (win) win.setTitle(title ? `${title} — VideoOnly` : 'VideoOnly Browser');
  });
  wc.on('did-fail-load', (_e, code, desc, validatedURL, isMainFrame) => {
    state.userNav = false;
    if (!isMainFrame || code === -3 /* aborted */) return;
    state.pendingUrl = validatedURL;
    wc.loadFile(ERROR_PAGE, { query: { url: validatedURL, code: String(code), desc } }).catch(() => {});
    pushState();
  });
  wc.on('render-process-gone', (_e, details) => {
    showNotice({ kind: 'info', label: 'Page crashed', text: `(${details.reason}) — press Ctrl+R to reload` });
  });

  // HTML5 fullscreen (the player's own fullscreen button): give the view the whole window.
  wc.on('enter-html-full-screen', () => {
    state.htmlFullscreen = true;
    if (win && !win.isFullScreen()) {
      state.weSetFullscreen = true;
      win.setFullScreen(true);
    }
    layout();
  });
  wc.on('leave-html-full-screen', () => {
    state.htmlFullscreen = false;
    if (win && state.weSetFullscreen && win.isFullScreen()) win.setFullScreen(false);
    state.weSetFullscreen = false;
    layout();
  });

  wc.on('before-input-event', (e, input) => handleShortcut(e, input, wc));
  wc.on('context-menu', (_e, params) => showContextMenu(params));
}

function guardNavigation(event, url) {
  const current = view ? view.webContents.getURL() : '';
  // never let the page hand off to external protocol handlers (ms-windows-store:, magnet:, ...)
  if (!/^(https?|file|about|blob|data):/i.test(url)) {
    event.preventDefault();
    recordBlock('redirect', url);
    return;
  }
  if (!state.staySite || state.userNav) return;
  if (!isWebUrl(current)) return; // start page, error page: go anywhere
  if (sameSite(current, url)) return;
  event.preventDefault();
  recordBlock('redirect', url);
}

function syncNav() {
  if (!view) return;
  const wc = view.webContents;
  const nh = wc.navigationHistory;
  state.canGoBack = nh ? nh.canGoBack() : wc.canGoBack();
  state.canGoForward = nh ? nh.canGoForward() : wc.canGoForward();
}

// ---------- navigation ----------
async function navigate(input, { fromUser = true } = {}) {
  const url = normalizeInput(input);
  if (!url || !view) return;
  state.userNav = fromUser;
  state.pendingUrl = url;
  pushState();
  // give the ad-block engine a moment to come up on first launch, so the first page is filtered too
  if (state.adblock && adblockReady) await Promise.race([adblockReady, new Promise((r) => setTimeout(r, 6000))]);
  if (!view) return;
  view.webContents.loadURL(url).catch(() => {});
}

function goBack() {
  const wc = view && view.webContents;
  if (!wc) return;
  if (wc.navigationHistory) wc.navigationHistory.goBack();
  else wc.goBack();
}
function goForward() {
  const wc = view && view.webContents;
  if (!wc) return;
  if (wc.navigationHistory) wc.navigationHistory.goForward();
  else wc.goForward();
}
function reload(ignoreCache) {
  if (!view) return;
  state.userNav = true;
  if (ignoreCache) view.webContents.reloadIgnoringCache();
  else view.webContents.reload();
}

// ---------- video-only: frame orchestration ----------
let reqSeq = 0;
const pendingReqs = new Map();

function request(frame, cmd, payload = {}, timeout = 1500) {
  return new Promise((resolve) => {
    const id = ++reqSeq;
    const t = setTimeout(() => {
      pendingReqs.delete(id);
      resolve(null);
    }, timeout);
    pendingReqs.set(id, (res) => {
      clearTimeout(t);
      resolve(res);
    });
    try {
      frame.send('vo:cmd', { id, cmd, ...payload });
    } catch {
      clearTimeout(t);
      pendingReqs.delete(id);
      resolve(null);
    }
  });
}

ipcMain.on('vo:reply', (_e, msg) => {
  const cb = msg && pendingReqs.get(msg.id);
  if (cb) {
    pendingReqs.delete(msg.id);
    cb(msg);
  }
});

function contentFrames() {
  try {
    return view.webContents.mainFrame.framesInSubtree;
  } catch {
    return [];
  }
}

function parentOf(frame) {
  try {
    return frame.parent;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Find the frame holding the most promising video (playing beats paused, bigger beats smaller).
// With `peek`, frames hidden by the current isolation are briefly laid out (invisibly) so
// videos inside them can be measured; the currently isolated frame is skipped.
async function findBestVideoFrame({ peek = false } = {}) {
  const frames = contentFrames();
  if (peek) {
    await Promise.all(frames.map((f) => request(f, 'measure', { on: true }, 500)));
    await sleep(200); // cross-process iframes learn their new size asynchronously
  }
  const results = await Promise.all(frames.map((f) => request(f, 'scan', {}, 800).then((r) => ({ f, r }))));
  if (peek) await Promise.all(frames.map((f) => request(f, 'measure', { on: false }, 500)));
  let best = null;
  for (const { f, r } of results) {
    if (!r || !r.ok || !r.count) continue;
    if (peek && (f === state.voFrame || r.isolated)) continue;
    const s = r.bestArea * (r.playing ? 3 : 1);
    if (!best || s > best.score) best = { frame: f, area: r.bestArea, playing: r.playing, score: s };
  }
  return best;
}

// Isolate the video in `frame`, then walk up through each parent frame isolating the
// <iframe> element that hosts the child — so a player inside nested embeds still ends
// up filling the window.
async function isolateFrom(frame) {
  const gen = ++isolateGen;
  let res = await request(frame, 'isolate', { mode: state.voMode });
  if (res && !res.ok && res.reason === 'no-video') {
    // frame may have just been un-hidden and not have its size yet
    await sleep(300);
    if (gen !== isolateGen) return false;
    res = await request(frame, 'isolate', { mode: state.voMode });
  }
  if (!res || !res.ok) return false;
  let child = frame;
  let childInfo = res;
  let parent = parentOf(frame);
  while (parent) {
    let childUrl = '';
    try {
      childUrl = child.url;
    } catch {
      /* frame gone */
    }
    const r = await request(parent, 'isolate-iframe', { childUrl, vw: childInfo.vw, vh: childInfo.vh });
    if (!r || !r.ok) break;
    childInfo = r;
    child = parent;
    parent = parentOf(parent);
  }
  if (gen !== isolateGen) return false;
  state.voActive = true;
  state.voFrame = frame;
  state.voArea = res.area || 0;
  pushState();
  return true;
}

async function clearAll() {
  isolateGen++;
  await Promise.all(contentFrames().map((f) => request(f, 'clear', {}, 600)));
  state.voActive = false;
  state.voFrame = null;
  state.voArea = 0;
  pushState();
}

async function setVideoOnly(on, { manual = false } = {}) {
  if (!view) return;
  if (on) {
    const best = await findBestVideoFrame();
    if (!best) {
      showNotice({ kind: 'info', label: 'No video found yet.', text: 'Start playback first — it switches automatically once a video plays.' });
      return;
    }
    const ok = await isolateFrom(best.frame);
    if (ok && manual) state.autoSuppressArea = null;
    if (!ok) showNotice({ kind: 'info', label: 'Could not isolate the video.', text: 'Try again once it is playing.' });
  } else {
    const area = state.voArea;
    await clearAll();
    if (manual) state.autoSuppressArea = area || 1;
  }
}

// Auto mode: a video started playing somewhere. Debounce, then pick the best candidate
// across all frames rather than trusting the first reporter (a trailer or pre-roll may
// start before the real player).
let autoTimer = null;
let lastPeek = 0;
let autoBusy = false;

ipcMain.on('vo:playing', (event, info) => {
  const frame = event.senderFrame;
  if (!frame || !view || event.sender !== view.webContents) return;
  if (!state.autoVideo) return;
  if (state.voActive && frame === state.voFrame) return; // that frame re-targets itself
  const hidden = !!info.hidden;
  if (hidden && !state.voActive) return; // a display:none video on a normal page: not interesting
  if (hidden) {
    if (Date.now() - lastPeek < 5000) return;
    lastPeek = Date.now();
  }
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => autoIsolate(state.voActive), 600);
});

async function autoIsolate(peek) {
  if (!view || !state.autoVideo || autoBusy) return;
  autoBusy = true;
  try {
    const best = await findBestVideoFrame({ peek });
    if (!best) return;
    if (state.voActive) {
      if (best.frame === state.voFrame || best.area < state.voArea * 1.3) return;
      await clearAll();
      await sleep(150); // let un-hidden frames get their size back
    } else if (state.autoSuppressArea != null && best.area < state.autoSuppressArea * 1.3) {
      return;
    }
    await isolateFrom(best.frame);
  } finally {
    autoBusy = false;
  }
}

ipcMain.on('vo:retargeted', (event, res) => {
  if (!view || event.sender !== view.webContents || !res || !res.ok) return;
  state.voArea = res.area || state.voArea;
});

async function setMode(mode) {
  if (mode !== 'player' && mode !== 'video') return;
  state.voMode = mode;
  settings.set('voMode', mode);
  if (state.voActive) {
    await clearAll();
    await setVideoOnly(true);
  }
  pushState();
}

// ---------- playback speed & picture-in-picture ----------

function frameAlive(f) {
  try {
    return !!(f && !f.isDestroyed() && f.url !== undefined);
  } catch {
    return false;
  }
}

// The frame holding the video being watched: the isolated one, else the best candidate.
async function watchedFrame() {
  if (state.voActive && frameAlive(state.voFrame)) return state.voFrame;
  const best = await findBestVideoFrame();
  return best ? best.frame : null;
}

function speedLabel(r) {
  return r === 1 ? 'Normal (1×)' : `${r}×`;
}

async function applySpeed(payload) {
  const frame = await watchedFrame();
  const res = frame && (await request(frame, 'speed', payload));
  if (!res || !res.ok) {
    showNotice({ kind: 'info', label: 'No video to change the speed of.', ms: 3000 });
    return null;
  }
  state.speed = res.rate;
  showNotice({ kind: 'ok', label: 'Speed', text: speedLabel(res.rate), ms: 2000 });
  return res.rate;
}

const changeSpeed = (delta) => applySpeed({ delta });
const setSpeed = (rate) => applySpeed({ set: rate });

// Runs in the page's own world with a user gesture (required by requestPictureInPicture).
const PIP_SCRIPT = `(async () => {
  try {
    if (document.pictureInPictureElement) { await document.exitPictureInPicture(); return 'exited'; }
    const v = document.querySelector('video[data-vo-pip]');
    if (!v) return 'no-video';
    if (v.disablePictureInPicture) v.disablePictureInPicture = false;
    if (v.readyState < 1) return 'not-ready';
    await v.requestPictureInPicture();
    return 'entered';
  } catch (e) { return 'error: ' + (e && e.message || e); }
})()`;

async function togglePip() {
  if (!view) return 'no-view';
  // already in PiP somewhere on the page? leave it
  for (const f of contentFrames()) {
    try {
      if (await f.executeJavaScript('!!document.pictureInPictureElement')) {
        await f.executeJavaScript('document.exitPictureInPicture()', true);
        return 'exited';
      }
    } catch {
      /* frame went away */
    }
  }
  const frame = await watchedFrame();
  const marked = frame && (await request(frame, 'mark-video'));
  if (!marked || !marked.ok) {
    showNotice({ kind: 'info', label: 'No video found for picture-in-picture.', ms: 3000 });
    return 'no-video';
  }
  let result;
  try {
    result = await frame.executeJavaScript(PIP_SCRIPT, true);
  } catch (e) {
    result = 'error: ' + e.message;
  }
  if (result !== 'entered') showNotice({ kind: 'info', label: 'Picture-in-picture not available here.', text: result === 'not-ready' ? 'Start the video first.' : '', ms: 4000 });
  return result;
}

// ---------- menus ----------
function speedSubmenu() {
  return SPEEDS.map((r) => ({
    label: speedLabel(r),
    type: 'radio',
    checked: Math.abs((state.speed || 1) - r) < 0.01,
    click: () => setSpeed(r),
  }));
}

function showVideoOnlyMenu() {
  Menu.buildFromTemplate([
    { label: 'Video-only style', enabled: false },
    { label: 'Player — keeps the site’s controls & subtitles', type: 'radio', checked: state.voMode === 'player', click: () => setMode('player') },
    { label: 'Bare video — just the <video> with native controls', type: 'radio', checked: state.voMode === 'video', click: () => setMode('video') },
    { type: 'separator' },
    {
      label: 'Switch automatically when a video starts playing',
      type: 'checkbox',
      checked: state.autoVideo,
      click: (item) => {
        state.autoVideo = item.checked;
        settings.set('autoVideo', item.checked);
        pushState();
      },
    },
    { type: 'separator' },
    { label: 'Picture-in-picture', accelerator: 'CmdOrCtrl+Shift+P', click: () => togglePip() },
    { label: 'Playback speed', submenu: speedSubmenu() },
  ]).popup({ window: win });
}

function showSettingsMenu() {
  Menu.buildFromTemplate([
    {
      label: state.adblockStatus === 'ready' ? 'Block ads & trackers (EasyList + EasyPrivacy)' : 'Block ads & trackers — lists not loaded',
      type: 'checkbox',
      checked: state.adblock,
      enabled: state.adblockStatus === 'ready',
      click: (item) => setAdblock(item.checked),
    },
    {
      label: 'Stay on site — block redirects to other sites',
      type: 'checkbox',
      checked: state.staySite,
      click: (item) => {
        state.staySite = item.checked;
        settings.set('staySite', item.checked);
        pushState();
      },
    },
    {
      label: 'Auto video-only when playback starts',
      type: 'checkbox',
      checked: state.autoVideo,
      click: (item) => {
        state.autoVideo = item.checked;
        settings.set('autoVideo', item.checked);
        pushState();
      },
    },
    {
      label: 'Video-only style',
      submenu: [
        { label: 'Player (site controls & subtitles)', type: 'radio', checked: state.voMode === 'player', click: () => setMode('player') },
        { label: 'Bare video (native controls)', type: 'radio', checked: state.voMode === 'video', click: () => setMode('video') },
      ],
    },
    { type: 'separator' },
    { label: 'Clear cookies & site data', click: clearSiteData },
    { label: 'Open page developer tools', accelerator: 'CmdOrCtrl+Shift+I', click: toggleDevTools },
    {
      label: 'Restart app (picks up updated files)',
      click: () => {
        app.relaunch();
        app.exit(0);
      },
    },
    { type: 'separator' },
    { label: `Chromium ${process.versions.chrome} · Electron ${process.versions.electron}`, enabled: false },
  ]).popup({ window: win });
}

function showBlockedMenu() {
  const c = state.counts;
  const items = [
    { label: `${c.popups} popups · ${c.redirects} redirects · ${c.downloads} downloads · ${c.ads} ad/tracker requests`, enabled: false },
    { type: 'separator' },
  ];
  if (!state.blocked.length) items.push({ label: 'Nothing blocked on this page yet', enabled: false });
  for (const b of state.blocked.slice(0, 15)) {
    const short = b.url.length > 80 ? b.url.slice(0, 77) + '…' : b.url;
    items.push({
      label: `${b.kind === 'popup' ? 'Popup' : b.kind === 'redirect' ? 'Redirect' : 'Download'}: ${short}`,
      enabled: b.kind !== 'download',
      click: () => navigate(b.url),
    });
  }
  Menu.buildFromTemplate(items).popup({ window: win });
}

function showContextMenu(params) {
  const wc = view.webContents;
  const tpl = [];
  if (params.linkURL) {
    tpl.push(
      { label: 'Open link here', click: () => navigate(params.linkURL) },
      { label: 'Copy link address', click: () => clipboard.writeText(params.linkURL) },
      { type: 'separator' }
    );
  }
  if (params.isEditable) tpl.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' });
  else if (params.selectionText) tpl.push({ role: 'copy' }, { type: 'separator' });
  tpl.push(
    { label: 'Back', enabled: state.canGoBack, click: goBack },
    { label: 'Forward', enabled: state.canGoForward, click: goForward },
    { label: 'Reload', click: () => reload(false) },
    { type: 'separator' },
    { label: state.voActive ? 'Exit video-only' : 'Video only', click: () => setVideoOnly(!state.voActive, { manual: true }) },
    { label: 'Picture-in-picture', click: () => togglePip() },
    { label: 'Playback speed', submenu: speedSubmenu() },
    { type: 'separator' },
    { label: 'Inspect element', click: () => wc.inspectElement(params.x, params.y) }
  );
  Menu.buildFromTemplate(tpl).popup({ window: win });
}

function toggleDevTools() {
  const wc = view && view.webContents;
  if (!wc) return;
  if (wc.isDevToolsOpened()) wc.closeDevTools();
  else wc.openDevTools({ mode: 'detach' });
}

async function clearSiteData() {
  const s = session.defaultSession;
  await s.clearStorageData();
  await s.clearCache();
  showNotice({ kind: 'ok', label: 'Cookies and site data cleared.' });
}

function setAdblock(on) {
  state.adblock = on;
  settings.set('adblock', on);
  if (on) adblock.enable(session.defaultSession);
  else adblock.disable(session.defaultSession);
  showNotice({ kind: on ? 'ok' : 'info', label: on ? 'Ad & tracker blocking on.' : 'Ad & tracker blocking off.', text: 'Reload the page to apply.' });
  pushState();
}

// ---------- keyboard ----------
// Ctrl on Windows/Linux, Cmd on macOS.
function handleShortcut(event, input, sender) {
  if (input.type !== 'keyDown' || !win) return;
  const mod = IS_MAC ? input.meta : input.control;
  const key = (input.key || '').toLowerCase();
  const code = input.code || '';
  const inContent = view && sender === view.webContents;
  let handled = true;

  if (mod && !input.shift && code === 'KeyL') focusUrl();
  else if ((mod && code === 'KeyR') || key === 'f5') reload(input.shift);
  else if ((input.alt && key === 'arrowleft') || (IS_MAC && mod && code === 'BracketLeft')) goBack();
  else if ((input.alt && key === 'arrowright') || (IS_MAC && mod && code === 'BracketRight')) goForward();
  else if (mod && input.shift && code === 'KeyV') setVideoOnly(!state.voActive, { manual: true });
  else if (mod && input.shift && code === 'KeyP') togglePip();
  else if (mod && code === 'Period') changeSpeed(+0.25);
  else if (mod && code === 'Comma') changeSpeed(-0.25);
  else if (mod && code === 'Slash') setSpeed(1);
  else if (mod && input.shift && code === 'KeyI') toggleDevTools();
  else if (key === 'f11' || (IS_MAC && input.meta && input.control && code === 'KeyF')) win.setFullScreen(!win.isFullScreen());
  else if (mod && (key === '=' || key === '+')) zoom(+0.5);
  else if (mod && key === '-') zoom(-0.5);
  else if (mod && key === '0') zoom(0);
  else if (mod && code === 'KeyW') win.close();
  else if (mod && code === 'KeyQ') app.quit();
  else if (key === 'escape' && inContent) {
    if (state.loading) view.webContents.stop();
    else if (state.voActive && !state.htmlFullscreen && !win.isFullScreen()) setVideoOnly(false, { manual: true });
    else handled = false;
  } else handled = false;

  if (handled) event.preventDefault();
}

function zoom(delta) {
  const wc = view && view.webContents;
  if (!wc) return;
  wc.setZoomLevel(delta === 0 ? 0 : wc.getZoomLevel() + delta);
}

function focusUrl() {
  if (!win) return;
  win.webContents.focus();
  win.webContents.send('vo:focus-url');
}

// ---------- IPC from the toolbar ----------
ipcMain.on('ui:ready', () => {
  uiReady = true;
  pushState();
});
ipcMain.on('ui:navigate', (_e, input) => navigate(input));
ipcMain.on('ui:back', goBack);
ipcMain.on('ui:forward', goForward);
ipcMain.on('ui:reload', () => reload(false));
ipcMain.on('ui:stop', () => view && view.webContents.stop());
ipcMain.on('ui:toggle-video-only', () => setVideoOnly(!state.voActive, { manual: true }));
ipcMain.on('ui:video-only-menu', showVideoOnlyMenu);
ipcMain.on('ui:settings-menu', showSettingsMenu);
ipcMain.on('ui:blocked-menu', showBlockedMenu);
ipcMain.on('ui:open-blocked', (_e, url) => navigate(url));
ipcMain.on('ui:dismiss-notice', () => {
  state.notice = null;
  pushState();
});
ipcMain.on('ui:focus-content', () => view && view.webContents.focus());

// ---------- app lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const u = urlFromArgs(argv);
    if (!win && app.isReady()) createWindow(); // macOS: app still running with its window closed
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    if (u) navigate(u);
  });

  // Defense in depth: no webContents anywhere may open windows.
  app.on('web-contents-created', (_e, wc) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  // Windows: must match the installer's AppUserModelID so taskbar pinning/grouping works.
  if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

  app.whenReady().then(async () => {
    const s = session.defaultSession;
    s.setUserAgent(chromeUA());
    // No notification / camera / location / clipboard prompts — deny everything.
    s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    s.setPermissionCheckHandler(() => false);
    // Downloads are never wanted from a video page (drive-by installers).
    s.on('will-download', (event, item) => {
      event.preventDefault();
      recordBlock('download', item.getURL());
    });

    if (process.platform === 'darwin') {
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    } else {
      Menu.setApplicationMenu(null);
    }

    adblockReady = adblock
      .init({
        cacheDir: app.getPath('userData'),
        onBlocked: () => {
          state.counts.ads++;
          pushState();
        },
        onStatus: (st) => {
          state.adblockStatus = st;
          pushState();
        },
      })
      .then((b) => {
        if (b && state.adblock) adblock.enable(s);
      })
      .catch(() => {});

    createWindow();

    const startUrl = urlFromArgs(process.argv);
    if (startUrl) navigate(startUrl);
  });

  // macOS convention: closing the window keeps the app in the Dock; clicking the Dock icon
  // opens a fresh window. Everywhere else, closing the window quits.
  app.on('window-all-closed', () => {
    if (!IS_MAC) app.quit();
  });
  app.on('activate', () => {
    if (!win && app.isReady()) createWindow();
  });
}

// Hooks for the automated test (test/e2e.js); inert unless VO_TEST is set.
if (process.env.VO_TEST) {
  global.__vo = {
    state,
    getView: () => view,
    getWin: () => win,
    setVideoOnly,
    navigate,
    clearAll,
    setMode,
    togglePip,
    changeSpeed,
    setSpeed,
    saveShot: async (p) => {
      const img = await view.webContents.capturePage();
      require('fs').writeFileSync(p, img.toPNG());
    },
  };
}
