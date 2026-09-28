# VideoOnly Browser

A small desktop browser (Electron/Chromium) for watching a video on a page without the rest of the page getting in the way. Windows, macOS and Linux.

What it does:

- **Popups**: every `window.open`, `target="_blank"` and popunder is denied. Nothing ever opens a second window.
- **Redirects**: a page can't send the tab to a different site on its own. Links and addresses *you* type still work. A blocked redirect shows up in the toolbar with an "Open here" button, in case you wanted it.
- **Downloads**: blocked outright.
- **Dialogs**: `alert` / `confirm` / `prompt` boxes and "are you sure you want to leave?" traps are suppressed.
- **Permission prompts**: notifications, camera, location and similar requests are always denied.
- **Ads and trackers**: request-level blocking with EasyList + EasyPrivacy (Ghostery's engine). The lists are cached locally after the first run.
- **Video-only mode**: as soon as a video starts playing, everything except the player is hidden and the player fills the window. This also works for players inside cross-origin iframes. There are two styles:
  - *Player* (the default) keeps the site's own controls, quality menu and subtitle layer.
  - *Bare video* shows just the `<video>` element with Chromium's native controls.
- **Picture-in-picture and playback speed** for whatever video you're watching.

## Install

Download the latest installer from the **[Releases](../../releases/latest)** page:

| Platform | File | Notes |
| --- | --- | --- |
| Windows | `VideoOnly-Browser-Setup-<version>.exe` | Installs for your user (no admin prompt) and adds desktop and Start menu shortcuts. The installer is unsigned, so SmartScreen may warn: choose **More info → Run anyway**. |
| macOS, Apple Silicon | `VideoOnly-Browser-<version>-mac-arm64.dmg` | Open the DMG and drag the app into Applications. |
| macOS, Intel | `VideoOnly-Browser-<version>-mac-x64.dmg` | Same as above. |
| Linux | `VideoOnly-Browser-<version>-linux-x86_64.AppImage` | Run `chmod +x` on the file, then run it. |

Signed and notarized Mac builds open normally. If a Mac build wasn't notarized (see [Mac signing](#mac-signing-and-notarization)), the first launch needs **System Settings → Privacy & Security → Open Anyway**.

## Using it

| Windows / Linux | macOS | Action |
| --- | --- | --- |
| `Ctrl+L` | `⌘L` | Focus the address bar (type a URL, or words to search DuckDuckGo) |
| `Ctrl+Shift+V` | `⇧⌘V` | Toggle video-only mode by hand |
| `Esc` | `Esc` | Leave video-only mode (or stop loading) |
| `Ctrl+Shift+P` | `⇧⌘P` | Picture-in-picture on/off |
| `Ctrl+.` / `Ctrl+,` / `Ctrl+/` | `⌘.` / `⌘,` / `⌘/` | Faster / slower / normal speed |
| `F11` | `⌃⌘F` | Full-screen window (the player's own full-screen button works too) |
| `Alt+←` / `Alt+→` | `⌘[` / `⌘]` | Back / forward |
| `Ctrl+R` / `F5` | `⌘R` | Reload (add Shift to bypass the cache) |
| `Ctrl` + `+` / `−` / `0` | `⌘` + `+` / `−` / `0` | Zoom |
| `Ctrl+Shift+I` | `⇧⌘I` | Developer tools for the page |

The toolbar has these controls, right to left:

- **Gear**: turn ad-blocking, redirect blocking and auto video-only on or off, pick the video-only style, and clear cookies.
- **Shield**: counts blocked popups, redirects and downloads, plus ad requests after the dot. Click it to see the list and open one on purpose.
- **Video only** button: its arrow menu has the style, picture-in-picture and playback speed.

If a page's video isn't detected automatically, press play and then `Ctrl+Shift+V`. If you turn video-only off by hand, it stays off for that page unless a clearly bigger video starts playing.

## Run from source

```
npm install
npm start
```

`npm start -- --url=https://example.com` opens a page right away.

## Build installers locally

```
npm run dist        # installers for the platform you're on, written to dist/
npm run dist:win    # or pick one: dist:win / dist:mac / dist:linux
```

Build Windows installers on Windows and Mac DMGs on a Mac.

## Releases (GitHub Actions)

Every push to `main` runs `.github/workflows/release.yml`. It builds on Windows, macOS and Linux runners and uploads the installers to the GitHub release for the version in `package.json` (for example `v1.0.0`). To cut a new release, bump `"version"` in `package.json` and push. Pushing without a bump refreshes that version's files. You can also start the workflow by hand from the **Actions** tab (**Run workflow**).

## Mac signing and notarization

The macOS job signs with your **Developer ID Application** certificate and notarizes with Apple when these repository secrets exist. Add them under **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | What to put in it |
| --- | --- |
| `CSC_LINK` | Your Developer ID Application certificate + private key exported as `.p12`, base64-encoded (see below) |
| `CSC_KEY_PASSWORD` | The password you chose when exporting the `.p12` |
| `APPLE_ID` | The Apple ID email of your developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password from [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | Your 10-character Team ID ([developer.apple.com/account](https://developer.apple.com/account) → Membership details) |

To export the certificate on your Mac:

1. Open Keychain Access and go to **login → My Certificates**.
2. Right-click **Developer ID Application: <your name> (<TEAMID>)**, choose **Export**, save it as `.p12` and set a password.
3. Run `base64 -i Certificates.p12 | pbcopy` and paste the result into the `CSC_LINK` secret.

If you only see "Apple Development" certificates, create a **Developer ID Application** certificate first at developer.apple.com → Certificates. Creating one needs the Account Holder role.

After adding the secrets, re-run the workflow (Actions → latest run → **Re-run all jobs**). The Mac DMGs in the release are then replaced with signed, notarized ones. Without the secrets, the Mac app is ad-hoc signed.

For a signed build on your own Mac instead, `npm run dist:mac` picks up the Developer ID certificate from your keychain automatically. To notarize locally too, set `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` in the shell, or store a notarytool profile with `xcrun notarytool store-credentials` and set `APPLE_KEYCHAIN_PROFILE`.

## How video-only works

A script runs in every frame of the page, in an isolated world the page can't see. When asked, it marks the video, its player container or the iframe that holds the player, and every ancestor, with an attribute. It then injects one stylesheet:

- Ancestors are kept.
- The target is `position: fixed` over the whole viewport.
- *Every other child of a kept ancestor* is `display: none`.

Because this is a CSS rule rather than a one-time sweep of the page, overlays the site injects later are hidden too. The main process walks up from the frame that holds the video through each parent frame, so nested embeds end up filling the window.

## Notes and limits

- Sites that use DRM (Widevine) won't play, because plain Electron has no DRM module. Ordinary HLS, DASH and MP4 players work.
- Downloads are blocked by design, and there's no toggle.
- Settings are saved in the app's profile folder: `%APPDATA%\VideoOnly Browser` on Windows, `~/Library/Application Support/VideoOnly Browser` on macOS, and `~/.config/VideoOnly Browser` on Linux.

## Project layout

```
main.js              main process: window, blocking, navigation guard, video-only, speed/PiP, menus, shortcuts
content-preload.js   runs in every page frame: playback reporting, isolation, speed/PiP helpers, dialog suppression
lib/                 ad-block engine wrapper, settings, address-bar parsing
ui/                  toolbar, start page, error page, icon
build/               app icon (SVG source + PNG) and macOS entitlements
scripts/dist.js      installer build (picks Developer ID or ad-hoc signing on macOS)
test/                end-to-end checks against a deliberately hostile local page
.github/workflows/   CI build + release
```

Tests (Linux, needs `playwright` and `xvfb`): `xvfb-run -a node test/e2e.js <video.mp4>`. Set `VO_EXE=<packaged binary>` to run the same checks against a built app.

## License

MIT. See [LICENSE](LICENSE).
