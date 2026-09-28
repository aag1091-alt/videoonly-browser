'use strict';

// Ad & tracker blocking via Ghostery's adblocker engine (EasyList + EasyPrivacy).
// Everything here is best-effort: if the module is missing or the lists can't be
// fetched (and no cached copy exists), the browser still runs with popup/redirect
// blocking — just without request filtering.

const fs = require('fs');
const path = require('path');

let blocker = null;
let enabledIn = new Set();

async function init({ cacheDir, onBlocked, onStatus }) {
  let mod;
  try {
    mod = require('@ghostery/adblocker-electron');
  } catch (e) {
    onStatus('unavailable');
    console.warn('adblock: module not installed —', e.message);
    return null;
  }
  const { ElectronBlocker } = mod;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    blocker = await ElectronBlocker.fromPrebuiltAdsAndTracking(fetch, {
      path: path.join(cacheDir, 'adblock-engine.bin'),
      read: fs.promises.readFile,
      write: fs.promises.writeFile,
    });
  } catch (e) {
    onStatus('lists-unavailable');
    console.warn('adblock: could not load filter lists —', e.message);
    return null;
  }
  blocker.on('request-blocked', () => onBlocked());
  blocker.on('request-redirected', () => onBlocked());
  onStatus('ready');
  return blocker;
}

function enable(sess) {
  if (!blocker || enabledIn.has(sess)) return false;
  blocker.enableBlockingInSession(sess);
  enabledIn.add(sess);
  return true;
}

function disable(sess) {
  if (!blocker || !enabledIn.has(sess)) return false;
  blocker.disableBlockingInSession(sess);
  enabledIn.delete(sess);
  return true;
}

function isReady() {
  return !!blocker;
}

module.exports = { init, enable, disable, isReady };
