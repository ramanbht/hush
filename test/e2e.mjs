#!/usr/bin/env node
// End-to-end test: loads dist/chrome into Chrome for Testing (headless), maps
// every hostname to a local server, and checks real behavior: blocked
// requests never reach the server, ad elements are hidden, scriptlets patch
// page JavaScript, pausing and "My filters" work.
//
//   npm run build:chrome && npm run test:e2e
//   CHROME=/path/to/chrome-for-testing npm run test:e2e
// Branded Google Chrome ignores --load-extension since v137; use Chrome for
// Testing or Chromium (npx @puppeteer/browsers install chrome@stable).
import http from 'node:http';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'dist', 'chrome');
// Hostnames resolve to 127.0.0.1 with their normal ports, so the test needs
// ports 80 and 443 (run as root, or in a container).
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(EXT, p), 'utf8'));

// ------------------------------------------------ pick fixtures from the build
const rulesets = Object.fromEntries(['easylist', 'easyprivacy', 'ubo-filters', 'ubo-privacy', 'pgl'].map((id) => [id, readJSON(`rules/${id}.json`)]));
const plainBucket = rulesets.easylist.find((r) => r.condition.requestDomains && Object.keys(r.condition).length === 1 && r.action.type === 'block');
const adHost = plainBucket.condition.requestDomains.find((h) => /^[a-z0-9-]+\.[a-z]+$/.test(h));
const privacyBucket = rulesets.easyprivacy.find((r) => r.condition.requestDomains && Object.keys(r.condition).length === 1);
const trackerHost = privacyBucket.condition.requestDomains.find((h) => /^[a-z0-9-]+\.[a-z]+$/.test(h));
const redirectRule = Object.values(rulesets).flat().find((r) => r.action.type === 'redirect'
  && r.action.redirect.extensionPath.endsWith('noop.js') && Object.keys(r.condition).every((k) => ['urlFilter', 'resourceTypes'].includes(k))
  && /^\|\|[a-z0-9.-]+\/[a-z0-9/._-]+\.js$/.test(r.condition.urlFilter || ''));

const generic = readJSON('cosmetic/generic.json');
const specific = readJSON('cosmetic/specific.json');
const simple = (s) => /^[.#][a-zA-Z][\w-]*$/.test(s);
const genericSel = generic.sels.find((s) => /^\.[a-z][\w-]*$/.test(s));
const excludedSet = new Set(specific.genericExcluded);
const specificHost = Object.keys(specific.hide).find((h) => /^[a-z0-9-]+\.com$/.test(h) && !excludedSet.has(h)
  && !specific.unhide[h] && specific.hide[h].some((i) => simple(specific.sels[i]) && !specific.styles[i]));
const specificSel = specific.hide[specificHost].map((i) => specific.sels[i]).find(simple);
// A site with an exception to a generic rule: that rule must NOT apply there,
// while other generic rules still must.
const exceptionHost = Object.keys(specific.unhide).find((h) => /^[a-z0-9-]+\.com$/.test(h)
  && !specific.ghide.includes(h) && !specific.ehide.includes(h) && specific.unhide[h].some((s) => simple(s) && generic.sels.includes(s)));
const exceptedSel = specific.unhide[exceptionHost].find((s) => simple(s) && generic.sels.includes(s));
const otherGenericSel = generic.sels.find((s) => /^\.[a-z][\w-]*$/.test(s) && s !== exceptedSel && !specific.unhide[exceptionHost].includes(s));

function el(sel, id) {
  return sel.startsWith('#') ? `<div id="${sel.slice(1)}">x</div>` : `<div id="${id}" class="${sel.slice(1)}">x</div>`;
}

// ------------------------------------------------------------ local server
const seen = [];
const handler = (req, res) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  seen.push(host + req.url);
  const url = req.url;
  const send = (type, body) => { res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
  if (url.endsWith('.png') || url.endsWith('.gif')) return send('image/png', fs.readFileSync(path.join(EXT, 'web_accessible_resources/2x2.png')));
  if (url.endsWith('.js')) return send('text/javascript', 'window.__loaded = (window.__loaded || 0) + 1;');
  if (host === 'news.test') {
    return send('text/html', `<!doctype html><title>news</title>
      <img id="ad" src="http://${adHost}/banner.gif" onload="window.adLoaded=1" onerror="window.adFailed=1">
      <img id="tracker" src="http://${trackerHost}/pixel.gif">
      <img id="logo" src="/logo.png" onload="window.logoLoaded=1">
      <img id="custom" src="http://evil.test/x.gif">
      ${redirectRule ? `<script src="${redirectRule.condition.urlFilter.replace('||', 'http://')}" onload="window.redirectLoaded=1" onerror="window.redirectFailed=1"></script>` : ''}
      ${el(genericSel, 'generic')}<div id="custom-junk" class="custom-junk">x</div><p id="content">Story text</p>
      <div class="hush-test-widget" style="width:300px;height:120px;background:#ccc">Pick me</div>`);
  }
  if (host === 'bench.test') {
    // 5,000 elements with ordinary class names, inserted after load; measures
    // the style-recalculation cost of the generic hiding stylesheet.
    return send('text/html', `<!doctype html><body><script>
      const cls = ['item','card','post','title','meta','sidebar','widget','header','footer','nav','content','article','teaser','media','thumb','link','btn','row','col','grid'];
      window.bench = () => {
        const root = document.createElement('div');
        for (let i = 0; i < 5000; i++) {
          const d = document.createElement(i % 3 ? 'div' : 'span');
          d.className = cls[i % 20] + ' ' + cls[(i * 7) % 20] + '-' + (i % 50);
          d.id = 'n' + i;
          d.setAttribute('data-k', String(i));
          root.appendChild(d);
        }
        const t0 = performance.now();
        document.body.appendChild(root);
        document.body.offsetHeight;
        const t = performance.now() - t0;
        root.remove();
        return t;
      };
    </script>`);
  }
  if (host === specificHost) return send('text/html', `<!doctype html>${el(specificSel, 'specific')}<p id="content">ok</p>`);
  if (host === exceptionHost) return send('text/html', `<!doctype html>${el(exceptedSel, 'excepted')}${el(otherGenericSel, 'other')}`);
  if (host === 'www.youtube.com') {
    if (url.startsWith('/youtubei/v1/player')) {
      return send('application/json', JSON.stringify({ responseContext: {}, adPlacements: [{ a: 1 }], adSlots: [{ b: 2 }], videoDetails: { videoId: 'v' } }));
    }
    return send('text/html', `<!doctype html><script>
      window.ytInitialPlayerResponse = { adPlacements: [1], playerAds: [2], videoDetails: { videoId: 'v' } };
      window.r1 = JSON.stringify(window.ytInitialPlayerResponse);
      fetch('/youtubei/v1/player?key=1', { method: 'POST' }).then((r) => r.json()).then((j) => { window.r2 = JSON.stringify(j); });
      const x = new XMLHttpRequest();
      x.open('POST', '/youtubei/v1/player');
      x.onload = () => { window.r3 = x.responseText; };
      x.send();
    </script>`);
  }
  if (host === 'timesofindia.com') {
    return send('text/html', `<!doctype html><script>
      try { window.detector; window.r = 'not aborted'; } catch (e) { window.r = 'aborted'; }
    </script>`);
  }
  send('text/html', '<!doctype html><p>default</p>');
};
// Some hosts (youtube.com) are HSTS-preloaded, so serve HTTPS too, with a
// throwaway self-signed certificate (Chrome runs with --ignore-certificate-errors).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hush-e2e-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=hush-test',
  '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')], { stdio: 'ignore' });
const server = http.createServer(handler);
const tlsServer = https.createServer({ key: fs.readFileSync(path.join(tmp, 'key.pem')), cert: fs.readFileSync(path.join(tmp, 'cert.pem')) }, handler);

// ------------------------------------------------------------------- run
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function poll(fn, ms = 4000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v || Date.now() > end) return v;
    await sleep(100);
  }
}
const hidden = (page, id) => page.evaluate((i) => {
  const e = document.getElementById(i);
  return !!e && getComputedStyle(e).display === 'none';
}, id);

await new Promise((r) => server.listen(80, '127.0.0.1', r));
await new Promise((r) => tlsServer.listen(443, '127.0.0.1', r));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/usr/bin/google-chrome',
  headless: true,
  pipe: true,
  enableExtensions: [EXT],
  args: [
    '--no-sandbox',
    '--no-proxy-server',
    '--host-resolver-rules=MAP * 127.0.0.1, EXCLUDE localhost',
    '--ignore-certificate-errors',
    '--disable-features=HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,HttpsFirstModeV2ForEngagedSites',
  ],
});

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().endsWith('/background.js'), { timeout: 15000 });
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;
  console.log('fixtures:', { adHost, trackerHost, redirect: redirectRule && redirectRule.condition.urlFilter, genericSel, specificHost, specificSel, exceptionHost, exceptedSel });

  const registered = await poll(async () => {
    const ids = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id)));
    return ids.length === 3 ? ids : null;
  }, 10000);
  check('content scripts registered (generic CSS, cosmetic, scriptlets)', !!registered, String(registered));

  const ruleInfo = await sw.evaluate(async () => {
    const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
    const available = await chrome.declarativeNetRequest.getAvailableStaticRuleCount();
    const regexes = [];
    for (const id of enabled) {
      const rules = await (await fetch(`/rules/${id}.json`)).json();
      for (const r of rules) if (r.condition.regexFilter) regexes.push(r.condition.regexFilter);
    }
    const bad = [];
    for (const re of regexes) {
      const res = await chrome.declarativeNetRequest.isRegexSupported({ regex: re });
      if (!res.isSupported) bad.push(re + ' ' + res.reason);
    }
    return { enabled, available, regexCount: regexes.length, bad };
  });
  const expectedRules = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'report-chrome.json'), 'utf8')).enabledRuleCount;
  check('all 7 rulesets enabled', ruleInfo.enabled.length === 7, ruleInfo.enabled.join(','));
  // Chrome's static pool is 300k shared + 30k guaranteed; what is indexed = 330k - available.
  check('Chrome indexed every compiled rule', 330000 - ruleInfo.available === expectedRules, `${330000 - ruleInfo.available} of ${expectedRules}`);
  check('every regex rule is RE2-compatible', ruleInfo.bad.length === 0, `${ruleInfo.regexCount} regex rules, bad: ${ruleInfo.bad.join(' | ')}`);

  const page = await browser.newPage();

  // Network blocking + element hiding
  seen.length = 0;
  await page.goto('http://news.test/', { waitUntil: 'load' });
  await sleep(500);
  check(`ad server request blocked (${adHost})`, !seen.some((s) => s.startsWith(adHost)) && await page.evaluate(() => !!window.adFailed));
  check(`tracker request blocked (${trackerHost})`, !seen.some((s) => s.startsWith(trackerHost)));
  check('first-party content still loads', await page.evaluate(() => !!window.logoLoaded) && seen.includes('news.test/logo.png'));
  if (redirectRule) {
    const host = redirectRule.condition.urlFilter.slice(2).split('/')[0];
    check('redirect rule serves a harmless stand-in (onload fires, server never hit)',
      await page.evaluate(() => !!window.redirectLoaded && !window.redirectFailed) && !seen.some((s) => s.startsWith(host)));
  }
  check(`generic element hiding (${genericSel})`, !!await poll(() => hidden(page, 'generic')));
  check('normal content stays visible', !await hidden(page, 'content'));

  await page.goto(`http://${specificHost}/`, { waitUntil: 'load' });
  check(`site-specific hiding on ${specificHost} (${specificSel})`, !!await poll(() => hidden(page, 'specific')));

  await page.goto(`http://${exceptionHost}/`, { waitUntil: 'load' });
  check(`generic rule still applies on a site with exceptions (${otherGenericSel})`, !!await poll(() => hidden(page, 'other')));
  check(`list exception honored on ${exceptionHost} (${exceptedSel} stays visible)`, !await hidden(page, 'excepted'));

  // Scriptlets
  await page.goto('http://www.youtube.com/', { waitUntil: 'load' });
  const yt = await poll(() => page.evaluate(() => (window.r2 && window.r3 ? { r1: window.r1, r2: window.r2, r3: window.r3 } : null)));
  check('set-constant strips ads from ytInitialPlayerResponse', !!yt && !yt.r1.includes('adPlacements') && yt.r1.includes('videoId'), yt && yt.r1);
  check('fetch response rewritten (adPlacements gone, video kept)', !!yt && !yt.r2.includes('adPlacements') && yt.r2.includes('videoId'), yt && yt.r2);
  check('XHR response rewritten (adPlacements gone, video kept)', !!yt && !yt.r3.includes('adPlacements') && yt.r3.includes('videoId'), yt && yt.r3);
  await page.goto('http://timesofindia.com/', { waitUntil: 'load' });
  check('abort-on-property-read stops an anti-adblock script', await page.evaluate(() => window.r) === 'aborted');

  // Options page: My filters + pause
  const opts = await browser.newPage();
  await opts.goto(`chrome-extension://${extId}/options/options.html`, { waitUntil: 'load' });
  const saved = await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'saveUserFilters', text: 'news.test##.custom-junk\n||evil.test^\nbad line $$$' }));
  check('My filters compile (1 network, 1 hiding, 1 rejected)', saved.networkRules === 1 && saved.cosmeticRules === 1 && saved.rejected.length === 1, JSON.stringify(saved));
  seen.length = 0;
  await page.goto('http://news.test/', { waitUntil: 'load' });
  await sleep(300);
  check('user network rule blocks evil.test', !seen.some((s) => s.startsWith('evil.test')));
  check('user hiding rule hides .custom-junk', !!await poll(() => hidden(page, 'custom-junk')));

  await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'setPaused', host: 'news.test', paused: true }));
  seen.length = 0;
  await page.goto('http://news.test/', { waitUntil: 'load' });
  await sleep(1000);
  check('paused site: ad request allowed through', seen.some((s) => s.startsWith(adHost)));
  check('paused site: no element hiding', !await hidden(page, 'generic'));
  await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'setPaused', host: 'news.test', paused: false }));
  seen.length = 0;
  await page.goto('http://news.test/', { waitUntil: 'load' });
  await sleep(300);
  check('resumed site: blocking is back', !seen.some((s) => s.startsWith(adHost)) && !!await poll(() => hidden(page, 'generic')));

  // Element picker: inject it the way the popup does, then click an element.
  await page.goto('http://news.test/', { waitUntil: 'load' });
  const tabId = await sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://news.test/*' }))[0].id);
  await sw.evaluate((id) => chrome.scripting.executeScript({ target: { tabId: id }, files: ['content/picker.js'] }), tabId);
  const box = await (await page.$('.hush-test-widget')).boundingBox();
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.click(box.x + 20, box.y + 20);
  const pickedNow = await poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.hush-test-widget')).display === 'none'));
  const stored = await poll(async () => {
    const { userFilters } = await sw.evaluate(() => chrome.storage.local.get('userFilters'));
    return /news\.test##.*hush-test-widget/.test(userFilters) ? userFilters : null;
  });
  check('picker hides the clicked element and saves a rule', !!pickedNow && !!stored, stored && stored.split('\n').pop());
  await page.goto('http://news.test/', { waitUntil: 'load' });
  check('picked element stays hidden after reload', !!await poll(() => page.evaluate(() =>
    getComputedStyle(document.querySelector('.hush-test-widget')).display === 'none')));

  // Cost of the generic stylesheet: same page, blocking vs paused.
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const runBench = async () => {
    await page.goto('http://bench.test/', { waitUntil: 'load' });
    await sleep(300);
    const xs = [];
    for (let i = 0; i < 7; i++) xs.push(await page.evaluate(() => window.bench()));
    return median(xs);
  };
  const withSheet = await runBench();
  await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'setPaused', host: 'bench.test', paused: true }));
  const withoutSheet = await runBench();
  await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'setPaused', host: 'bench.test', paused: false }));
  console.log(`INFO  inserting 5,000 elements: ${withSheet.toFixed(1)} ms with generic hiding, ${withoutSheet.toFixed(1)} ms without`);

  const optionsOk = await opts.evaluate(() => chrome.runtime.sendMessage({ type: 'optionsState' }));
  check('options state loads', optionsOk.rulesets.length === 7 && optionsOk.target === 'chrome');
} finally {
  await browser.close();
  server.close();
  tlsServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
