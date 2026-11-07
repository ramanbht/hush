# Hush

A small ad blocker for Chrome and Safari, built from one Manifest V3 codebase.
It uses the same community filter lists as uBlock Origin (EasyList, EasyPrivacy,
uBlock filters, Peter Lowe's list) and compiles them into each browser's native
blocking format.

What it does on every site:

- **Blocks ad and tracker requests** before they leave the browser (~112,000 network filters compiled into ~16,300 browser rules).
- **Hides leftover ad boxes** with 13,700 generic CSS rules plus 11,450 site-specific ones across 8,800 sites
  (including `amazon.*`-style rules that cover a site on every country domain).
- **Patches page scripts** on ~2,650 sites where ads or anti-adblock live inside the page itself (YouTube player responses, adblock detectors).
- **Pause per site**, an **element picker**, and a **My filters** box for your own rules.

## Install

Get a build one of two ways:

- **Download** `hush-chrome.zip` / `hush-safari.zip` from the repo's
  [latest release](../../releases/latest). GitHub Actions rebuilds it every Monday with
  fresh filter lists. Unzip into a folder you'll keep (the browser loads it from there).
- **Build it yourself** (Node 18+): `npm run build`, which writes `dist/chrome` and
  `dist/safari`.

### Chrome

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and pick the unzipped folder (or `dist/chrome`).
3. Pin Hush from the puzzle-piece menu so the toolbar button is visible.

To update, replace the folder's contents with a newer build and click the reload arrow on
the Hush card.

### Safari (macOS, Safari 17+)

Quick test, no Xcode needed (if your Safari's Developer settings offer it):

1. Safari > Settings > Advanced > check **Show features for web developers**.
2. Safari > Settings > Developer > **Add Temporary Extension…** and pick the unzipped
   folder (or `dist/safari`). Safari removes temporary extensions after 24 hours or when it quits.

Installed app (needs macOS and Xcode; Node 18+ to refresh the lists). Clone the repo, then:

```sh
tools/safari.sh                                              # unsigned
TEAM_ID=ABCDE12345 BUNDLE_ID=io.github.you.hush tools/safari.sh   # signed, permanent
```

The script builds with fresh lists, packages Hush as a macOS app, installs it in
`~/Applications`, and opens it. Then enable Hush under Safari > Settings > Extensions and
choose **Always Allow on Every Website**. Without website access Safari still blocks
requests, but element hiding and script patches cannot run.

- **Unsigned:** Safari only loads it while Settings > Developer > **Allow unsigned
  extensions** is checked, and Safari clears that box every time it quits.
- **Signed (permanent):** needs an Apple Developer Program membership ($99/year). Sign in
  to that Apple ID in Xcode > Settings > Accounts, and pass your team ID (shown at
  developer.apple.com/account under Membership details). Safari then keeps Hush enabled
  across restarts with no developer settings.

Run the same command again to update.

## Updating the lists

Filter lists change daily. Static rules are frozen into the extension at build time, so
rebuild about once a week:

```sh
npm run build            # downloads fresh lists, builds dist/chrome and dist/safari
```

Then click reload on the extension (Chrome) or re-add it (Safari). Node 18+ is the only
requirement; the build has no dependencies.

## How it works

| Layer | Mechanism | Runs where |
|---|---|---|
| Network blocking | Filter lists compiled to `declarativeNetRequest` rules | Inside the browser engine, no extension code per request |
| Generic hiding | One static stylesheet registered as a content script | Every frame, from the first paint |
| Site-specific hiding | Background computes CSS for the hostname and injects it as a user-origin stylesheet | Every frame, on request |
| Script patches ("scriptlets") | 15 uBlock-compatible scriptlets in the page's own JS world, before page scripts | Only on sites with rules |

The compiler (`src/shared/abp.js`) is shared by the build tool and the extension. Two
details matter most:

- **Host merging.** About 86% of network filters are plain `||host^` rules. They are merged
  into a few rules with large `requestDomains` arrays, which is why 112k filters fit in
  16k rules, well under Chrome's guaranteed 30,000.
- **Priorities.** DNR picks the highest priority and, on a tie, prefers allow over block.
  List blocks get 10, list exceptions 12, `$important` 20, your own rules 30, and
  "pause on this site" 100.

The compiler skips any filter it cannot express exactly (it never broadens a rule), so a
gap means an ad slips through, not a broken page. `dist/report-<target>.json` lists every
skip with its reason.

## Chrome vs Safari

| | Chrome | Safari |
|---|---|---|
| Static rules | 30,000 guaranteed per extension, more from a shared 300,000 pool | All enabled rulesets merge into one content blocker capped at **150,000**; over the cap, blocking silently stops |
| How `requestDomains` counts | 1 rule | 1 rule **per domain** |
| Regex rules | RE2, max 1,000, small memory budget | Restricted dialect; Hush ships none |
| Redirect to stand-in scripts | Yes | Converted to plain blocks |
| Background | Service worker | Non-persistent event page |

Because of the cap, the Safari build enables EasyList, uBlock filters and Peter Lowe's list
by default (about 55,000 Safari rules). Turning on EasyPrivacy brings it to about 112,000;
the settings page refuses combinations above 140,000. Large rule sets also take Safari
noticeably longer to compile after an update.

## What it cannot block

No browser extension blocks everything; these are the known gaps:

- **Server-side inserted ads.** When an ad is stitched into the video stream itself (YouTube
  has been rolling this out), it is indistinguishable from content. Scriptlets help today
  where ads are still described in JSON; that is an arms race, so rebuild often.
- **Pop-unders and popups** (`$popup`, about 3,000 EasyList filters). Manifest V3 has no way
  to cancel a new window, though the `no-window-open-if` scriptlet covers many sites.
- **Procedural hiding** (`:has-text()`, `:xpath()`, about 400 filters), and `example.*`
  rules for script patches and network blocking (about 600, mostly piracy sites). Hiding
  rules written that way are supported.
- **Header rewriting** (`$csp`, `$removeparam`): skipped to keep the Safari build safe.
- **Ads inside apps** or other browsers. For whole-device coverage, pair this with a DNS
  blocker (NextDNS, Pi-hole); those miss first-party ads and page cleanup, which this covers.

## Tests

```sh
npm test                 # compiler unit tests (no browser)
npm install              # once, for the end-to-end test
npm run test:e2e         # loads dist/chrome into headless Chrome for Testing
```

The end-to-end test maps every hostname to a local server, then checks 30 behaviors: rules
indexed, ad and tracker requests never reaching the server, stand-in scripts, generic and
site-specific hiding (including Amazon sponsored results), list exceptions, YouTube-style JSON and XHR rewriting, anti-adblock
aborts, My filters, pause and resume, and the element picker. It needs Chrome for Testing or
Chromium (`npx @puppeteer/browsers install chrome@stable`, then set `CHROME=` to its path),
because branded Chrome ignores `--load-extension`. It binds ports 80 and 443.

Measured on Chrome 153: the generic stylesheet adds about 5 ms when a page inserts 5,000
elements (28 ms vs 23 ms).

## Layout

```
src/
  background.js            content-script registration, CSS lookup, pause, My filters, picker
  shared/abp.js            filter parser and DNR compiler (used by build and extension)
  content/cosmetic.js      asks for site-specific CSS
  content/scriptlets.template.js   scriptlet library; build inlines the rules
  content/picker.js        element picker
  popup/, options/, ui/    interface
tools/build.mjs            downloads lists, compiles, writes dist/
tools/lists.json           which lists, from where, enabled by default per browser
tools/safari.sh            wraps dist/safari in a macOS app with Xcode
test/                      unit and end-to-end tests
```

## Licensing

The filter lists are GPL-3.0 (EasyList and EasyPrivacy also CC BY-SA 3.0), and the compiled
rules in `dist/` derive from them. Personal use is fine. If you publish the extension,
release it under GPL-3.0 and keep the attribution on the settings page.

## Next steps worth doing

- **Auto-updating lists.** The whole compiled set (~16k rules) fits under Chrome's 30,000
  dynamic-rule limit, so the background could fetch lists daily, compile them with the same
  `abp.js`, and swap them in without a rebuild.
- **Lazy generic hiding.** Match generic selectors only against classes and ids actually on
  the page, instead of one 526 KB stylesheet per frame.
- **Native Safari hiding.** Emit `css-display-none` content-blocker rules so Safari hides
  elements without website access.
