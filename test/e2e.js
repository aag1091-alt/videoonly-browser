'use strict';
// End-to-end check: launches the browser against a deliberately hostile local page and
// verifies popups / redirects / downloads are blocked and video-only isolation works
// across a cross-origin iframe. Run:  xvfb-run -a node test/e2e.js <path/to/test.mp4> <shots-dir>
// (Needs `playwright` resolvable; add --no-sandbox automatically when running as root.)

const path = require('path');
const fs = require('fs');
const { _electron: electron } = require('playwright');
const { startServer } = require('./server');

const mp4Path = process.argv[2];
const shots = process.argv[3] || path.join(__dirname, 'shots');
fs.mkdirSync(shots, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Playwright auto-dismisses beforeunload dialogs; the app already suppresses them itself
// (will-prevent-unload), so Playwright's dismiss can race and fail with "No dialog is
// showing". That is harness noise, not an app failure.
process.on('unhandledRejection', (err) => {
  if (/handleJavaScriptDialog|No dialog is showing/.test(String(err && err.message))) return;
  console.error('unhandled rejection:', err);
  process.exit(2);
});

let failures = 0;
function check(name, ok, extra) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`);
  if (!ok) failures++;
}

(async () => {
  const { port, close } = await startServer({ mp4Path });
  const A = `http://127.0.0.1:${port}`;
  // VO_EXE=<path to a packaged app binary> runs the same checks against a built app.
  const packaged = process.env.VO_EXE;
  const profile = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vo-e2e-'));
  const app = await electron.launch({
    executablePath: packaged || require('electron'),
    args: [...(packaged ? [] : [path.join(__dirname, '..')]), '--no-sandbox', `--url=${A}/page.html`],
    env: { ...process.env, VO_TEST: '1', VO_PROFILE_DIR: profile, ELECTRON_ENABLE_LOGGING: '0' },
    cwd: path.join(__dirname, '..'),
  });
  if (packaged) console.log('testing packaged app:', packaged);
  app.process().stderr.on('data', (d) => {
    const s = d.toString();
    if (/error|exception/i.test(s) && !/dbus|gpu|vaapi|sandbox|ozone|xkb/i.test(s)) process.stdout.write('[electron stderr] ' + s);
  });

  const getState = () =>
    app.evaluate(() => {
      const s = global.__vo.state;
      return { counts: s.counts, voActive: s.voActive, voMode: s.voMode, url: s.url, blocked: s.blocked, adblockStatus: s.adblockStatus, autoSuppressArea: s.autoSuppressArea, voArea: s.voArea };
    });
  const frameReport = () =>
    app.evaluate(async () => {
      const wc = global.__vo.getView().webContents;
      const out = [];
      for (const f of wc.mainFrame.framesInSubtree) {
        try {
          out.push({
            url: f.url,
            r: await f.executeJavaScript(`({
              targets: [...document.querySelectorAll('[data-vo-target]')].map(e => e.tagName.toLowerCase() + '#' + e.id + '=' + e.getAttribute('data-vo-target')),
              keeps: document.querySelectorAll('[data-vo-keep]').length,
              style: !!document.getElementById('vo-style-7f3a91'),
              hidden: ['header','aside','#overlay','#cookie','#late','#ad-top','.controls','.bar','.subs'].filter(sel => { const e = document.querySelector(sel); if (!e) return false; const cs = getComputedStyle(e); return cs.display === 'none' || cs.visibility === 'hidden'; }),
              videos: [...document.querySelectorAll('video')].map(v => ({ id: v.id, playing: !v.paused && !v.ended && v.readyState >= 2, controls: v.controls, w: Math.round(v.getBoundingClientRect().width), h: Math.round(v.getBoundingClientRect().height) })),
            })`),
          });
        } catch (e) {
          out.push({ url: f.url, error: String(e) });
        }
      }
      return out;
    });
  // evaluate an expression in the embedded player's frame (page world)
  const embedEval = (expr) =>
    app.evaluate(async (_electron, expr) => {
      const wc = global.__vo.getView().webContents;
      const f = wc.mainFrame.framesInSubtree.find((fr) => fr.url.includes('/embed.html'));
      return f ? f.executeJavaScript(expr) : null;
    }, expr);
  const shot = async (name) => {
    const p = path.join(shots, name);
    await app.evaluate((_electron, p) => global.__vo.saveShot(p), p);
    return p;
  };

  // --- phase 1: hostile page loads; auto video-only should kick in, everything else blocked
  await sleep(7000);
  let st = await getState();
  console.log('state after 7s:', JSON.stringify(st, null, 1));
  check('page was NOT redirected away', st.url.startsWith(A + '/page.html'), st.url);
  check('popups blocked (main page x2 + iframe x1)', st.counts.popups >= 3, st.counts.popups);
  check('redirect blocked', st.counts.redirects >= 1, st.counts.redirects);
  check('download blocked', st.counts.downloads >= 1, st.counts.downloads);
  check('video-only auto-activated', st.voActive === true);
  console.log('adblock status:', st.adblockStatus, '— ad requests blocked:', st.counts.ads);

  let fr = await frameReport();
  console.log('frames:', JSON.stringify(fr, null, 1));
  const main = fr.find((f) => f.url.includes('/page.html'));
  const embed = fr.find((f) => f.url.includes('/embed.html'));
  check('main frame: iframe is the target', main && main.r.targets.includes('iframe#embed=iframe'), main && main.r.targets);
  check('main frame: header/sidebar/overlays/cookie/late overlay hidden', main && ['header', 'aside', '#overlay', '#cookie', '#late'].every((s) => main.r.hidden.includes(s)), main && main.r.hidden);
  check('embed frame: player container is the target (player mode)', embed && embed.r.targets.includes('div#pl=player'), embed && embed.r.targets);
  check('embed frame: top ad hidden, player controls & subtitles kept', embed && embed.r.hidden.includes('#ad-top') && !embed.r.hidden.includes('.bar') && !embed.r.hidden.includes('.subs'), embed && embed.r.hidden);
  check('embed video is playing', embed && embed.r.videos.some((v) => v.id === 'v2' && v.playing), embed && embed.r.videos);
  console.log('screenshot:', await shot('1-auto-player-mode.png'));

  // --- phase 2: turn video-only off by hand → page back to normal, and auto must not re-enter
  await app.evaluate(() => global.__vo.setVideoOnly(false, { manual: true }));
  await sleep(2500);
  fr = await frameReport();
  st = await getState();
  check('off: no targets/keeps left in any frame', fr.every((f) => f.r && f.r.targets.length === 0 && f.r.keeps === 0 && !f.r.style), fr.map((f) => f.r && [f.r.targets, f.r.keeps, f.r.style]));
  check('off: auto does not re-enter after manual exit', st.voActive === false && st.autoSuppressArea > 0, st.autoSuppressArea);
  console.log('screenshot:', await shot('2-normal-page.png'));

  // --- phase 3: bare-video mode, toggled by hand
  await app.evaluate(() => global.__vo.setMode('video'));
  await app.evaluate(() => global.__vo.setVideoOnly(true, { manual: true }));
  await sleep(1500);
  fr = await frameReport();
  st = await getState();
  const embed3 = fr.find((f) => f.url.includes('/embed.html'));
  check('bare mode: <video> itself is the target with native controls', embed3 && embed3.r.targets.includes('video#v2=video') && embed3.r.videos.some((v) => v.id === 'v2' && v.controls), embed3 && [embed3.r.targets, embed3.r.videos]);
  check('bare mode: player chrome hidden', embed3 && embed3.r.hidden.includes('.bar') && embed3.r.hidden.includes('.subs'), embed3 && embed3.r.hidden);
  console.log('screenshot:', await shot('3-bare-video-mode.png'));

  // --- phase 3b: playback speed and picture-in-picture act on the watched video
  let rate = await app.evaluate(() => global.__vo.changeSpeed(0.5));
  let actual = await embedEval("document.getElementById('v2').playbackRate");
  check('speed: change applied to the watched (embedded) video', rate === 1.5 && actual === 1.5, { rate, actual });
  rate = await app.evaluate(() => global.__vo.setSpeed(1));
  actual = await embedEval("document.getElementById('v2').playbackRate");
  check('speed: reset to 1×', rate === 1 && actual === 1, { rate, actual });
  const pipOn = await app.evaluate(() => global.__vo.togglePip());
  await sleep(500);
  const pipEl = await embedEval('document.pictureInPictureElement && document.pictureInPictureElement.id');
  check('pip: entered on the watched video', pipOn === 'entered' && pipEl === 'v2', { pipOn, pipEl });
  const pipOff = await app.evaluate(() => global.__vo.togglePip());
  await sleep(500);
  const stillPip = await embedEval('!!document.pictureInPictureElement');
  check('pip: toggled back off', pipOff === 'exited' && stillPip === false, { pipOff, stillPip });

  // --- phase 4: beforeunload trap must not stop navigation; same-site nav allowed
  await app.evaluate((_e, u) => global.__vo.navigate(u), A + '/other.html');
  await sleep(2500);
  st = await getState();
  check('navigated despite beforeunload trap', st.url === A + '/other.html', st.url);
  check('state reset on new document', st.voActive === false && st.counts.popups === 0);

  // --- phase 5: cross-site navigation typed by the user is allowed (guard is for page-initiated only)
  await app.evaluate((_e, u) => global.__vo.navigate(u), `http://localhost:${port}/other.html?typed`);
  await sleep(2000);
  st = await getState();
  check('user-typed cross-site URL allowed', st.url === `http://localhost:${port}/other.html?typed`, st.url);

  // --- phase 6: alert/confirm/prompt are neutralised in every frame and can't be restored
  await app.evaluate((_e, u) => global.__vo.navigate(u), A + '/dialogs.html');
  await sleep(2500);
  const dlg = await app.evaluate(async () => {
    const wc = global.__vo.getView().webContents;
    const out = {};
    for (const f of wc.mainFrame.framesInSubtree) out[f.url.split('/').pop()] = await f.executeJavaScript('window.__r || null');
    return out;
  });
  const top = dlg['dialogs.html'];
  const inner = dlg['dialogs-inner.html'];
  check('dialogs: confirm/prompt answer "no" without showing, even after the page tries to restore them', top && top.confirm === false && top.prompt === null && top.afterTamper === false && top.writable === false, top);
  check('dialogs: suppressed inside cross-origin iframes too', inner && inner.confirm === false && inner.prompt === null, inner);

  // toolbar screenshot
  try {
    const pages = app.windows();
    for (const p of pages) {
      const u = p.url();
      if (u.includes('toolbar.html')) {
        await p.screenshot({ path: path.join(shots, '4-toolbar.png') });
        console.log('toolbar text:', await p.evaluate(() => document.getElementById('shield').title + ' | ' + document.getElementById('url').value));
      }
    }
  } catch (e) {
    console.log('toolbar screenshot skipped:', e.message);
  }

  await app.close();
  close();
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error('harness error:', e);
  process.exit(2);
});
