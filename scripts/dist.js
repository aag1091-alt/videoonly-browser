'use strict';

// Builds the installers for one platform:  node scripts/dist.js [--win | --mac | --linux]
// (defaults to the platform you run it on). Output goes to dist/.
//
// macOS signing:
//   * With a "Developer ID Application" certificate — from CSC_LINK/CSC_KEY_PASSWORD (CI) or
//     your login keychain (local) — the app is signed with the hardened runtime, and it is
//     notarized when APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (or
//     APPLE_KEYCHAIN_PROFILE) are set.
//   * Without one it is ad-hoc signed, so it still runs on Apple Silicon; the first launch then
//     needs System Settings → Privacy & Security → "Open Anyway".

const { execSync } = require('child_process');
const builder = require('electron-builder');

const flag = process.argv.slice(2).find((a) => ['--win', '--mac', '--linux'].includes(a));
const platform = flag ? flag.slice(2) : { win32: 'win', darwin: 'mac', linux: 'linux' }[process.platform];
if (!platform) {
  console.error(`Unsupported platform: ${process.platform}`);
  process.exit(1);
}

function hasDeveloperId() {
  if (process.env.CSC_LINK || process.env.CSC_NAME) return true;
  if (process.platform !== 'darwin') return false;
  try {
    const out = execSync('security find-identity -v -p codesigning', { encoding: 'utf8' });
    return /Developer ID Application/.test(out);
  } catch {
    return false;
  }
}

const config = {};
if (platform === 'mac') {
  if (hasDeveloperId()) {
    const notarize = !!(process.env.APPLE_ID || process.env.APPLE_KEYCHAIN_PROFILE || process.env.APPLE_API_KEY);
    console.log(`macOS: signing with your Developer ID certificate${notarize ? ' and notarizing' : ' (notarization credentials not set, skipping notarization)'}`);
  } else {
    console.log('macOS: no Developer ID certificate found, using an ad-hoc signature');
    config.mac = { identity: '-', hardenedRuntime: false };
  }
}

builder
  .build({ [platform]: [], config, publish: 'never' })
  .then((files) => {
    console.log('\nBuilt:');
    for (const f of files) console.log('  ' + f);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
