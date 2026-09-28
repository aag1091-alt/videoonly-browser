'use strict';

// Runs in EVERY frame of the page (main document and all iframes, cross-origin included),
// in an isolated world the page's own scripts cannot see. It does two things:
//   1. reports "a video started playing" to the main process (for auto video-only)
//   2. on command from the main process, isolates the video / player / iframe so that
//      nothing else on the page is visible.
//
// Isolation is done with attributes + one stylesheet rather than by moving DOM nodes,
// so the site's player keeps working:
//   [data-vo-target]  the element shown full-viewport (video, player container, or iframe)
//   [data-vo-keep]    every ancestor of the target (kept visible, layout neutralised)
//   any other child of a kept ancestor is display:none — including elements the site
//   injects later (overlay ads, "click here" layers, modals), because the rule is CSS.

const { ipcRenderer, webFrame } = require('electron');

// No JavaScript dialogs, ever: alert/confirm/prompt are how embeds nag ("install X to
// unlock", "disable your ad blocker") and they block the page until clicked. This runs
// in the page's own world before any page script, and the properties are locked so the
// page cannot restore them. confirm() answers "cancel", prompt() answers null.
try {
  webFrame.executeJavaScript(`(() => {
    const lock = (name, value) => {
      try { Object.defineProperty(window, name, { value, writable: false, configurable: false, enumerable: true }); } catch (e) {}
    };
    lock('alert', () => undefined);
    lock('confirm', () => false);
    lock('prompt', () => null);
  })();`);
} catch {
  /* webFrame unavailable: dialogs stay as they are */
}

const KEEP = 'data-vo-keep';
const TARGET = 'data-vo-target';
const STYLE_ID = 'vo-style-7f3a91';
const MIN_W = 300; // videos smaller than this are ignored for auto mode (thumbnails, ads in sidebars)
const MIN_H = 150;

// The "hide everything else" rule has two flavours: display:none (normal) and
// visibility:hidden (measure mode — elements keep a layout size so videos inside hidden
// subtrees/iframes can be measured without anything becoming visible).
const HIDE_RULE = `[${KEEP}] > :not([${KEEP}]):not([${TARGET}]) { display: none !important; }`;
const MEASURE_RULE = `[${KEEP}] > :not([${KEEP}]):not([${TARGET}]) { visibility: hidden !important; pointer-events: none !important; }`;

const CSS = `
[${KEEP}] {
  transform: none !important; filter: none !important; backdrop-filter: none !important;
  perspective: none !important; contain: none !important; will-change: auto !important;
  overflow: visible !important; clip-path: none !important; mask: none !important;
  opacity: 1 !important; visibility: visible !important; pointer-events: auto !important;
  animation: none !important; transition: none !important;
}
html[${KEEP}], body[${KEEP}] {
  background: #000 !important; overflow: hidden !important; margin: 0 !important; padding: 0 !important;
  width: auto !important; height: auto !important; min-height: 0 !important;
}
[${TARGET}] {
  position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
  width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important;
  min-width: 0 !important; min-height: 0 !important; margin: 0 !important; padding: 0 !important;
  transform: none !important; z-index: 2147483647 !important; background: #000 !important;
  opacity: 1 !important; visibility: visible !important; display: block !important;
  pointer-events: auto !important; border: 0 !important; border-radius: 0 !important;
  box-sizing: border-box !important; inset: 0 !important; aspect-ratio: auto !important;
}
video[${TARGET}] { object-fit: contain !important; }
[${TARGET}="player"] video { max-width: 100% !important; max-height: 100% !important; }
`;

let current = null; // { el, kind: 'video' | 'player' | 'iframe', video, area (natural size when isolated) }
let lastIframeParams = null;
let watchdog = null;
let lastReport = 0;
let measuring = false;

// ---------- helpers ----------

function rectOf(el) {
  try {
    return el.getBoundingClientRect();
  } catch {
    return { width: 0, height: 0, top: 0, left: 0 };
  }
}

function isVisible(el) {
  const r = rectOf(el);
  if (r.width < 2 || r.height < 2) return false;
  try {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return false;
    // in measure mode everything outside the isolated chain is visibility:hidden on purpose
    if (!measuring && cs.visibility === 'hidden') return false;
  } catch {
    /* ignore */
  }
  return true;
}

function isPlaying(v) {
  return !v.paused && !v.ended && v.readyState >= 2;
}

function listVideos() {
  const out = [];
  for (const v of document.querySelectorAll('video')) {
    if (!isVisible(v)) continue;
    const r = rectOf(v);
    out.push({ v, area: r.width * r.height, w: r.width, h: r.height, playing: isPlaying(v) });
  }
  return out;
}

function score(x) {
  return x.area * (x.playing ? 3 : 1);
}

function pickVideo() {
  const vids = listVideos();
  if (!vids.length) return null;
  vids.sort((a, b) => score(b) - score(a));
  return vids[0];
}

// Highest ancestor whose box is roughly the same as the video's box = the player container
// (video.js / JW Player / Plyr / YouTube all wrap <video> in same-size containers that hold
// the controls and subtitle layers). Stops at the first ancestor that is clearly bigger.
function playerContainer(video) {
  const vr = rectOf(video);
  let best = video;
  let node = video.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const r = rectOf(node);
    const dw = Math.abs(r.width - vr.width);
    const dh = Math.abs(r.height - vr.height);
    if (dw <= Math.max(40, vr.width * 0.15) && dh <= Math.max(80, vr.height * 0.3)) best = node;
    else break;
    node = node.parentElement;
  }
  return best;
}

function styleText() {
  return (measuring ? MEASURE_RULE : HIDE_RULE) + CSS;
}

function ensureStyle() {
  let st = document.getElementById(STYLE_ID);
  if (!st) {
    st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = styleText();
    (document.head || document.documentElement).appendChild(st);
  }
  return st;
}

function setMeasure(on) {
  measuring = !!on;
  const st = document.getElementById(STYLE_ID);
  if (st) {
    st.textContent = styleText();
    // force layout so measurements taken right after are up to date
    void document.documentElement.offsetWidth;
  }
}

// Run fn with hidden subtrees laid out (but invisible), then restore.
function withMeasure(fn) {
  if (!current) return fn();
  setMeasure(true);
  try {
    return fn();
  } finally {
    setMeasure(false);
  }
}

function removeStyle() {
  const st = document.getElementById(STYLE_ID);
  if (st) st.remove();
}

function clearAttrs() {
  for (const el of document.querySelectorAll(`[${KEEP}],[${TARGET}]`)) {
    el.removeAttribute(KEEP);
    el.removeAttribute(TARGET);
  }
}

function fireResize() {
  try {
    window.dispatchEvent(new Event('resize'));
  } catch {
    /* ignore */
  }
}

// ---------- isolation ----------

function applyIsolation(target, kind, video, area) {
  clearAttrs();
  measuring = false;
  ensureStyle();
  target.setAttribute(TARGET, kind);
  let n = target.parentElement;
  while (n) {
    n.setAttribute(KEEP, '');
    n = n.parentElement;
  }
  if (kind === 'video' && video) {
    try {
      video.controls = true;
    } catch {
      /* ignore */
    }
  }
  current = { el: target, kind, video, area: area || 0 };
  fireResize();
  startWatchdog();
}

// `pick` must describe the video's NATURAL (un-isolated) size.
function isolateSpecific(video, mode, pick) {
  const target = mode === 'video' ? video : playerContainer(video);
  const kind = mode === 'video' ? 'video' : 'player';
  const r = pick || (() => {
    const b = rectOf(video);
    return { area: b.width * b.height, w: b.width, h: b.height, playing: isPlaying(video) };
  })();
  applyIsolation(target, kind, video, r.area);
  return { ok: true, area: r.area, w: r.w, h: r.h, playing: r.playing, kind, vw: innerWidth, vh: innerHeight };
}

function isolateVideo(mode) {
  // if something is already isolated here, measure candidates with hidden parts laid out
  const pick = withMeasure(pickVideo);
  if (!pick) return { ok: false, reason: 'no-video', vw: innerWidth, vh: innerHeight };
  if (current) clearIsolation();
  return isolateSpecific(pick.v, mode, pick);
}

// Called in a PARENT frame: find the <iframe> that hosts the child frame we just isolated,
// and make that iframe the full-viewport target.
function isolateIframe({ childUrl, vw, vh }) {
  const frames = [...document.querySelectorAll('iframe')].filter(isVisible);
  if (!frames.length) return { ok: false, reason: 'no-iframe', vw: innerWidth, vh: innerHeight };
  let best = null;
  let bestScore = -1;
  for (const f of frames) {
    const r = rectOf(f);
    let s = 0;
    const src = f.src || '';
    if (childUrl && src && src === childUrl) s += 1000;
    else if (childUrl && src) {
      try {
        if (new URL(src, location.href).origin === new URL(childUrl).origin) s += 300;
      } catch {
        /* ignore */
      }
    }
    // an iframe's content viewport is exactly the iframe's box: strong signal
    if (vw && vh && Math.abs(r.width - vw) <= 6 && Math.abs(r.height - vh) <= 6) s += 500;
    s += Math.min((r.width * r.height) / 2000, 300);
    if (s > bestScore) {
      bestScore = s;
      best = f;
    }
  }
  lastIframeParams = { childUrl, vw, vh };
  applyIsolation(best, 'iframe', null, 0);
  return { ok: true, vw: innerWidth, vh: innerHeight };
}

function clearIsolation() {
  stopWatchdog();
  clearAttrs();
  removeStyle();
  measuring = false;
  current = null;
  lastIframeParams = null;
  fireResize();
  return { ok: true };
}

// Sites re-render: re-apply attributes/styles if they get removed, re-find the video if
// the element was replaced (e.g. pre-roll ad element swapped for the real one).
function startWatchdog() {
  stopWatchdog();
  watchdog = setInterval(() => {
    if (!current) return;
    try {
      if (!document.getElementById(STYLE_ID)) ensureStyle();
      const { el, kind, video } = current;
      if (!document.contains(el)) {
        if (kind === 'iframe') {
          if (lastIframeParams) isolateIframe(lastIframeParams);
        } else {
          const r = isolateVideo(kind === 'video' ? 'video' : 'player');
          if (!r.ok) clearIsolation();
          else ipcRenderer.send('vo:retargeted', r);
        }
        return;
      }
      if (!el.hasAttribute(TARGET)) el.setAttribute(TARGET, kind);
      let n = el.parentElement;
      while (n) {
        if (!n.hasAttribute(KEEP)) n.setAttribute(KEEP, '');
        n = n.parentElement;
      }
      if (kind === 'video' && video && !video.controls) video.controls = true;
    } catch {
      /* ignore */
    }
  }, 1000);
}

function stopWatchdog() {
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
}

// ---------- speed / picture-in-picture helpers ----------

const PIP_ATTR = 'data-vo-pip';

// The video the user is watching in this frame: the isolated one if video-only is on,
// otherwise the best candidate.
function activeVideo() {
  if (current && current.video && document.contains(current.video)) return current.video;
  if (current && current.el && current.kind !== 'iframe') {
    const v = current.el.tagName === 'VIDEO' ? current.el : current.el.querySelector('video');
    if (v) return v;
  }
  const pick = withMeasure(pickVideo);
  return pick ? pick.v : null;
}

function setSpeed(msg) {
  const v = activeVideo();
  if (!v) return { ok: false, reason: 'no-video' };
  let rate = typeof msg.set === 'number' ? msg.set : (v.playbackRate || 1) + (msg.delta || 0);
  rate = Math.round(Math.min(4, Math.max(0.25, rate)) * 100) / 100;
  v.playbackRate = rate;
  return { ok: true, rate: v.playbackRate };
}

// PiP itself needs a user gesture in the page's own world, so the main process does the
// request; here we only mark which element it should use.
function markVideo() {
  for (const el of document.querySelectorAll(`[${PIP_ATTR}]`)) el.removeAttribute(PIP_ATTR);
  const v = activeVideo();
  if (v) v.setAttribute(PIP_ATTR, '');
  return { ok: !!v, rate: v ? v.playbackRate : 1 };
}

// ---------- playback reporting ----------

document.addEventListener(
  'playing',
  (e) => {
    const v = e.target;
    if (!v || v.tagName !== 'VIDEO') return;

    // Already isolated in this frame, and a different video started (pre-roll ad element
    // swapped for the real one, trailer vs. episode, ...)? Compare natural sizes and switch
    // if the newcomer is clearly bigger.
    if (current && current.kind !== 'iframe' && current.el !== v && !current.el.contains(v)) {
      const nat = withMeasure(() => rectOf(v));
      if (nat.width >= MIN_W && nat.height >= MIN_H && nat.width * nat.height > current.area * 1.2) {
        const mode = current.kind === 'video' ? 'video' : 'player';
        clearIsolation();
        const res = isolateSpecific(v, mode, { area: nat.width * nat.height, w: nat.width, h: nat.height, playing: true });
        ipcRenderer.send('vo:retargeted', res);
      }
      return;
    }

    const r = rectOf(v);
    const hidden = r.width === 0 || r.height === 0 || innerWidth === 0 || innerHeight === 0;
    if (!hidden && (r.width < MIN_W || r.height < MIN_H)) return;

    const now = Date.now();
    if (now - lastReport < 1500) return;
    lastReport = now;
    // hidden: this frame is display:none — most likely hidden by video-only isolation in a
    // parent frame; the main process decides whether it is worth a look.
    ipcRenderer.send('vo:playing', { w: r.width, h: r.height, vw: innerWidth, vh: innerHeight, hidden });
  },
  true
);

// ---------- commands from the main process ----------

ipcRenderer.on('vo:cmd', (_event, msg) => {
  let res;
  try {
    switch (msg.cmd) {
      case 'scan': {
        const vids = listVideos();
        const best = pickVideo();
        res = { ok: true, count: vids.length, bestArea: best ? best.area : 0, playing: !!(best && best.playing), isolated: !!current, vw: innerWidth, vh: innerHeight };
        break;
      }
      case 'measure':
        setMeasure(!!msg.on);
        res = { ok: true };
        break;
      case 'isolate':
        res = isolateVideo(msg.mode);
        break;
      case 'isolate-iframe':
        res = isolateIframe(msg);
        break;
      case 'clear':
        res = clearIsolation();
        break;
      case 'speed':
        res = setSpeed(msg);
        break;
      case 'mark-video':
        res = markVideo();
        break;
      default:
        res = { ok: false, reason: 'unknown-command' };
    }
  } catch (err) {
    res = { ok: false, reason: String((err && err.message) || err) };
  }
  ipcRenderer.send('vo:reply', Object.assign({ id: msg.id }, res));
});
