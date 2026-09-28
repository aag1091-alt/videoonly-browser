'use strict';

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  adblock: true, // block ads & trackers (EasyList / EasyPrivacy)
  staySite: true, // block the page from redirecting to another site
  autoVideo: true, // switch to video-only automatically when a video starts playing
  voMode: 'player', // 'player' (keep the site's player) | 'video' (bare <video>, native controls)
  windowBounds: null,
};

let cache = null;

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  const s = load();
  s[key] = value;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(s, null, 2));
  } catch (e) {
    console.warn('settings: could not save', e.message);
  }
}

module.exports = { get, set, load, DEFAULTS };
