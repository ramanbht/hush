#!/usr/bin/env node
// Builds the extension for Chrome and Safari.
//
//   node tools/build.mjs                 download lists (if older than 12h) and build both targets
//   node tools/build.mjs --target=chrome only one target (chrome | safari)
//   node tools/build.mjs --offline       use cached lists only
//   node tools/build.mjs --refresh       force a fresh download
//
// Output: dist/chrome, dist/safari (load these as unpacked extensions) and
// dist/report-<target>.json (what was compiled, what was skipped and why).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../src/shared/abp.js');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const CACHE = path.join(ROOT, '.cache', 'lists');
const LISTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'lists.json'), 'utf8'));

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const TARGETS = args.target ? [args.target] : ['chrome', 'safari'];
const MAX_AGE_MS = 12 * 3600 * 1000;

// Flags for uBO's "!#if" preprocessor. Sections marked "!#if !ext_ubol" need
// capabilities MV3 lacks, so we behave like uBO Lite.
const ENV = {
  chrome: { env_chromium: true, env_chrome: true, env_mv3: true, ext_ubol: true, ext_ublock: true, cap_user_stylesheet: true },
  safari: { env_safari: true, env_mv3: true, ext_ubol: true, ext_ublock: true },
};

// Chrome guarantees 30,000 static rules per extension (more from a shared
// pool). WebKit merges all enabled rulesets into one content blocker with a
// hard cap of 150,000 rules; going over silently disables blocking.
const LIMITS = { chromeGuaranteed: 30000, chromeRegex: 1000, safariBudget: 140000 };

async function download(list) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, list.id + '.txt');
  const fresh = fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS;
  if (args.offline || (fresh && !args.refresh)) {
    if (!fs.existsSync(file)) throw new Error(`No cached copy of ${list.id}; run without --offline`);
    return fs.readFileSync(file, 'utf8');
  }
  for (const url of list.urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (text.length < 1000) throw new Error('suspiciously short');
      fs.writeFileSync(file, text);
      console.log(`  fetched ${list.id.padEnd(16)} ${(text.length / 1024).toFixed(0).padStart(5)} KB  ${url}`);
      return text;
    } catch (e) {
      console.warn(`  ${list.id}: ${url} failed (${e.message})`);
    }
  }
  if (fs.existsSync(file)) {
    console.warn(`  ${list.id}: using cached copy`);
    return fs.readFileSync(file, 'utf8');
  }
  throw new Error(`Could not download ${list.id}`);
}

function bump(obj, key, n = 1) { obj[key] = (obj[key] || 0) + n; }

function compile(target, texts) {
  const env = ENV[target];
  const store = A.newCosmeticStore();
  const badfilters = new Set();
  const perList = [];

  // Pass 1: parse everything, collect $badfilter (which applies across lists).
  for (const list of LISTS) {
    const lines = A.preprocess(texts[list.id], env);
    const parsed = [];
    const stats = { lines: lines.length, network: 0, hide: 0, scriptlets: 0, skipped: {} };
    for (const line of lines) {
      const p = A.parseLine(line, list.format);
      if (!p) continue;
      if (p.kind === 'skip') { bump(stats.skipped, p.reason); continue; }
      if (p.kind === 'network' && p.badfilter) { badfilters.add(p.key); continue; }
      parsed.push(p);
    }
    perList.push({ list, parsed, stats });
  }

  // Pass 2: compile.
  let regexBudget = LIMITS.chromeRegex;
  const rulesets = [];
  for (const { list, parsed, stats } of perList) {
    const dnr = [];
    for (const p of parsed) {
      if (p.kind === 'network') {
        if (badfilters.has(p.key)) { bump(stats.skipped, 'badfilter'); continue; }
        A.addNetworkFlags(store, p);
        const r = A.toDNR(p);
        if (!r) continue;
        if (r.condition.regexFilter && target === 'chrome') {
          if (regexBudget <= 0) { bump(stats.skipped, 'regex-over-limit'); continue; }
          regexBudget--;
        }
        dnr.push(r);
        stats.network++;
      } else {
        A.addCosmetic(store, p);
        stats[p.kind === 'hide' ? 'hide' : 'scriptlets']++;
      }
    }
    let rules = A.assembleRules(dnr);
    if (target === 'safari') rules = rules.map(A.adaptRuleForSafari).filter(Boolean);
    const safariCost = rules.reduce((n, r) => n + A.safariRuleCost(r), 0);
    rulesets.push({
      id: list.id, name: list.name, about: list.about, license: list.license, homepage: list.homepage,
      enabled: !!list.enabled[target], rules, ruleCount: rules.length, safariCost, stats,
      filterCount: stats.network + stats.hide + stats.scriptlets,
    });
  }
  return { rulesets, cosmetic: A.finalizeCosmetic(store) };
}

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, ent.name), b = path.join(to, ent.name);
    if (skip(a)) continue;
    if (ent.isDirectory()) copyDir(a, b, skip);
    else fs.copyFileSync(a, b);
  }
}

function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

function version() {
  const now = new Date();
  const day = Math.floor((now - new Date(Date.UTC(2026, 0, 1))) / 86400000);
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  return `0.1.${day}.${minute}`;
}

function manifest(target, rulesets) {
  const icons = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
  const m = {
    manifest_version: 3,
    name: 'Hush',
    version: version(),
    description: 'A small ad blocker: network blocking, element hiding and anti-adblock fixes.',
    icons,
    action: { default_popup: 'popup/popup.html', default_title: 'Hush', default_icon: { 16: icons[16], 32: icons[32] } },
    options_ui: { page: 'options/options.html', open_in_tab: true },
    permissions: ['declarativeNetRequest', 'scripting', 'storage', 'activeTab'],
    host_permissions: ['<all_urls>'],
    declarative_net_request: {
      rule_resources: rulesets.map((r) => ({ id: r.id, enabled: r.enabled, path: `rules/${r.id}.json` })),
    },
    web_accessible_resources: [{ resources: ['web_accessible_resources/*'], matches: ['<all_urls>'] }],
  };
  if (target === 'chrome') {
    m.minimum_chrome_version = '121';
    m.background = { service_worker: 'background.js' };
  } else {
    // Safari runs MV3 background scripts as a non-persistent event page.
    m.background = { scripts: ['shared/abp.js', 'background.js'] };
    m.browser_specific_settings = { safari: { strict_min_version: '17.0' } };
  }
  return m;
}

function build(target, texts) {
  const t0 = Date.now();
  const { rulesets, cosmetic } = compile(target, texts);
  const out = path.join(ROOT, 'dist', target);
  fs.rmSync(out, { recursive: true, force: true });
  copyDir(SRC, out, (p) => p.endsWith('scriptlets.template.js'));

  for (const rs of rulesets) writeJSON(path.join(out, 'rules', rs.id + '.json'), rs.rules);
  fs.mkdirSync(path.join(out, 'cosmetic'), { recursive: true });
  fs.writeFileSync(path.join(out, 'cosmetic', 'generic.css'), cosmetic.genericCss);
  writeJSON(path.join(out, 'cosmetic', 'generic.json'), cosmetic.generic);
  writeJSON(path.join(out, 'cosmetic', 'specific.json'), cosmetic.specific);

  const template = fs.readFileSync(path.join(SRC, 'content', 'scriptlets.template.js'), 'utf8');
  const marker = '/*__HUSH_SCRIPTLET_DATA__*/null';
  if (!template.includes(marker)) throw new Error('scriptlet template marker missing');
  fs.writeFileSync(path.join(out, 'content', 'scriptlets.js'),
    template.replace(marker, () => JSON.stringify(cosmetic.scriptlets)));

  const scriptletHosts = Object.keys(cosmetic.scriptlets.hosts).sort();
  writeJSON(path.join(out, 'data', 'meta.json'), {
    target,
    builtAt: new Date().toISOString(),
    rulesets: rulesets.map(({ id, name, about, license, homepage, enabled, ruleCount, safariCost, filterCount }) =>
      ({ id, name, about, license, homepage, enabledByDefault: enabled, ruleCount, safariCost, filterCount })),
    limits: LIMITS,
    scriptletHosts,
    genericExcluded: cosmetic.specific.genericExcluded,
  });
  writeJSON(path.join(out, 'manifest.json'), manifest(target, rulesets));

  // Report
  const enabled = rulesets.filter((r) => r.enabled);
  const report = {
    target,
    rulesets: rulesets.map(({ id, enabled, ruleCount, safariCost, stats }) => ({ id, enabled, ruleCount, safariCost, stats })),
    enabledRuleCount: enabled.reduce((n, r) => n + r.ruleCount, 0),
    enabledSafariCost: enabled.reduce((n, r) => n + r.safariCost, 0),
    genericSelectors: cosmetic.generic.sels.length,
    genericCssKB: Math.round(cosmetic.genericCss.length / 1024),
    specificSelectors: cosmetic.specific.sels.length,
    specificHosts: Object.keys(cosmetic.specific.hide).length,
    genericExcludedHosts: cosmetic.specific.genericExcluded.length,
    scriptletHosts: scriptletHosts.length,
    scriptletCalls: Object.values(cosmetic.scriptlets.hosts).reduce((n, c) => n + c.length, 0),
  };
  writeJSON(path.join(ROOT, 'dist', `report-${target}.json`), report);

  console.log(`\n${target}: built in ${Date.now() - t0} ms -> dist/${target}`);
  console.log('  ruleset            on  DNR rules  safari-cost  filters-used  skipped');
  for (const r of rulesets) {
    const skipped = Object.values(r.stats.skipped).reduce((a, b) => a + b, 0);
    console.log(`  ${r.id.padEnd(17)} ${r.enabled ? 'yes' : ' no'} ${String(r.ruleCount).padStart(10)} ${String(r.safariCost).padStart(12)}`
      + ` ${String(r.stats.network + r.stats.hide + r.stats.scriptlets).padStart(13)} ${String(skipped).padStart(8)}`);
  }
  console.log(`  enabled DNR rules: ${report.enabledRuleCount} (Chrome guarantees ${LIMITS.chromeGuaranteed})`);
  if (target === 'safari') {
    console.log(`  enabled Safari content-blocker rules: ${report.enabledSafariCost} (hard cap 150000)`);
    if (report.enabledSafariCost > LIMITS.safariBudget) throw new Error('Default Safari rulesets exceed the content-blocker budget');
  } else if (report.enabledRuleCount > LIMITS.chromeGuaranteed) {
    console.warn('  WARNING: enabled rules exceed the guaranteed static rule count');
  }
  console.log(`  element hiding: ${report.genericSelectors} generic selectors (${report.genericCssKB} KB CSS),`
    + ` ${report.specificSelectors} site-specific across ${report.specificHosts} sites`);
  console.log(`  scriptlets: ${report.scriptletCalls} calls across ${report.scriptletHosts} sites`);
}

console.log('Filter lists:');
const texts = {};
for (const list of LISTS) texts[list.id] = await download(list);
for (const target of TARGETS) build(target, texts);
