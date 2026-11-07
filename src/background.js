/*
 * Hush background script.
 * Chrome runs it as a service worker; Safari as a non-persistent event page
 * (with shared/abp.js listed before it in the manifest).
 *
 * Network blocking needs no code at runtime: the browser applies the static
 * DNR rulesets itself. This script only handles what DNR cannot:
 *   - registering the element-hiding and scriptlet content scripts
 *   - serving site-specific hiding CSS on request
 *   - "pause on this site", "My filters", and the element picker
 */
'use strict';

if (typeof HushABP === 'undefined' && typeof importScripts === 'function') {
  importScripts('shared/abp.js');
}
const A = HushABP;
const api = globalThis.browser || globalThis.chrome;

const SCRIPT_IDS = { generic: 'hush-generic', cosmetic: 'hush-cosmetic', scriptlets: 'hush-scriptlets' };
const PAUSE_RULE_ID = A.ALLOW_ID_BASE;
const USER_ID_START = 1000;
const WEB_MATCHES = ['http://*/*', 'https://*/*'];
const DEFAULTS = {
  settings: { cosmetic: true, scriptlets: true },
  paused: [],
  userFilters: '',
  userCompiled: null,
  capabilities: {},
};

// ------------------------------------------------------------------ state

let stateCache = null;
function state() {
  if (!stateCache) stateCache = api.storage.local.get(DEFAULTS);
  return stateCache;
}
async function setState(patch) {
  await api.storage.local.set(patch);
  stateCache = null;
  cssCache.clear();
}
api.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') { stateCache = null; cssCache.clear(); }
});

const loaded = new Map();
function loadJSON(file) {
  if (!loaded.has(file)) {
    loaded.set(file, fetch(api.runtime.getURL(file)).then((r) => r.json()).catch((e) => {
      loaded.delete(file);
      throw e;
    }));
  }
  return loaded.get(file);
}
const meta = () => loadJSON('data/meta.json');
const generic = () => loadJSON('cosmetic/generic.json');
let specificPromise = null;
function specific() {
  if (!specificPromise) {
    specificPromise = loadJSON('cosmetic/specific.json').then((s) => {
      s.sets = {};
      for (const k of ['ehide', 'ghide', 'shide', 'genericExcluded']) s.sets[k] = new Set(s[k]);
      return s;
    });
  }
  return specificPromise;
}

const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const lookup = (obj, key) => (obj && own(obj, key) ? obj[key] : undefined);

function siteOf(host) {
  return host.replace(/^www\./, '');
}
function isPaused(paused, host) {
  return paused.some((p) => host === p || host.endsWith('.' + p));
}

// ------------------------------------------------------- element hiding

const cssCache = new Map();

async function cssForHost(host) {
  if (cssCache.has(host)) return cssCache.get(host);
  const S = await state();
  const user = S.userCompiled || { css: {}, unhide: {} };
  const suffixes = A.lookupKeys(host); // host, parent domains, and entity forms (amazon.*)
  const parts = [];

  const unhide = new Set();
  for (const h of suffixes) for (const s of lookup(user.unhide, h) || []) unhide.add(s);

  if (S.settings.cosmetic) {
    const sp = await specific();
    const flagged = (k) => suffixes.some((h) => sp.sets[k].has(h));
    if (!flagged('ehide')) {
      const negate = new Set();
      for (const h of suffixes) {
        for (const s of lookup(sp.unhide, h) || []) unhide.add(s);
        for (const s of lookup(sp.negate, h) || []) negate.add(s);
      }
      if (!flagged('shide')) {
        for (const h of suffixes) {
          for (const id of lookup(sp.hide, h) || []) {
            const sel = sp.sels[id];
            if (!unhide.has(sel) && !negate.has(sel)) parts.push(A.cssRule(sel, sp.styles[id]));
          }
        }
      }
      // Sites with exceptions to generic rules are excluded from the static
      // generic stylesheet; they get "generic minus exceptions" from here.
      const userExcluded = suffixes.some((h) => lookup(user.unhide, h));
      const needGeneric = S.capabilities.genericCss === false || flagged('genericExcluded') || userExcluded;
      if (needGeneric && !flagged('ghide')) {
        const g = await generic();
        g.sels.forEach((sel, i) => { if (!unhide.has(sel)) parts.push(A.cssRule(sel, g.styles[i])); });
      }
    }
  }
  for (const h of ['', ...suffixes]) for (const rule of lookup(user.css, h) || []) parts.push(rule);

  const css = parts.join('\n');
  if (cssCache.size > 300) cssCache.delete(cssCache.keys().next().value);
  cssCache.set(host, css);
  return css;
}

async function insertCSS(tabId, frameId, css) {
  const target = { tabId, frameIds: [frameId] };
  try {
    // USER origin outranks the page's own !important rules.
    await api.scripting.insertCSS({ target, css, origin: 'USER' });
  } catch (e) {
    await api.scripting.insertCSS({ target, css });
  }
}

async function applyCosmetic(sender, host) {
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null || !host) return {};
  const css = await cssForHost(host);
  if (!css) return {};
  try {
    await insertCSS(tabId, sender.frameId || 0, css);
    return {};
  } catch (e) {
    return { css }; // let the content script inject it as a <style> element
  }
}

// ------------------------------------------------- content-script setup

function excludeFor(hosts) {
  return [...new Set([...new Set(hosts)].flatMap(A.matchPatternsFor))];
}

async function registerOne(def, S) {
  try {
    await api.scripting.registerContentScripts([def]);
    return true;
  } catch (e) {
    // Older engines reject newer optional keys; retry without them.
    const lean = Object.assign({}, def);
    delete lean.matchOriginAsFallback;
    delete lean.persistAcrossSessions;
    try {
      await api.scripting.registerContentScripts([lean]);
      return true;
    } catch (e2) {
      console.warn('Hush: could not register', def.id, e2);
      return false;
    }
  }
}

async function syncContentScripts() {
  const S = await state();
  const M = await meta();
  const paused = S.paused || [];
  const userExcluded = Object.keys((S.userCompiled && S.userCompiled.unhide) || {}).filter(Boolean);

  const existing = await api.scripting.getRegisteredContentScripts();
  const ours = existing.map((s) => s.id).filter((id) => Object.values(SCRIPT_IDS).includes(id));
  if (ours.length) await api.scripting.unregisterContentScripts({ ids: ours });

  const common = { matches: WEB_MATCHES, allFrames: true, runAt: 'document_start', matchOriginAsFallback: true, persistAcrossSessions: true };

  // Asks the background for site-specific CSS (and carries user CSS).
  await registerOne(Object.assign({ id: SCRIPT_IDS.cosmetic, js: ['content/cosmetic.js'], excludeMatches: excludeFor(paused) }, common), S);

  if (S.settings.cosmetic) {
    const ok = await registerOne(Object.assign({}, common, {
      id: SCRIPT_IDS.generic,
      css: ['cosmetic/generic.css'],
      excludeMatches: excludeFor([...paused, ...M.genericExcluded, ...userExcluded]),
    }), S);
    if ((S.capabilities.genericCss !== false) !== ok) {
      await setState({ capabilities: Object.assign({}, S.capabilities, { genericCss: ok }) });
    }
  }

  if (S.settings.scriptlets && M.scriptletHosts.length) {
    await registerOne(Object.assign({}, common, {
      id: SCRIPT_IDS.scriptlets,
      js: ['content/scriptlets.js'],
      matches: M.scriptletHosts.map(A.hostToMatchPattern),
      excludeMatches: excludeFor(paused),
      world: 'MAIN',
    }), S);
  }
}

let syncChain = Promise.resolve();
function queueSync() {
  syncChain = syncChain.then(syncContentScripts).catch((e) => console.warn('Hush: sync failed', e));
  return syncChain;
}

async function syncPauseRule() {
  const { paused } = await state();
  const addRules = paused.length ? [{
    id: PAUSE_RULE_ID,
    priority: A.PRIORITY.pause,
    action: { type: 'allowAllRequests' },
    condition: { requestDomains: paused, resourceTypes: ['main_frame'] },
  }] : [];
  await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [PAUSE_RULE_ID], addRules });
}

async function setupBadge() {
  try {
    await api.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
    await api.action.setBadgeBackgroundColor({ color: '#3d5a58' });
  } catch (e) { /* not supported (Safari) */ }
}

api.runtime.onInstalled.addListener(async () => {
  await setupBadge();
  await syncPauseRule();
  const S = await state();
  if (S.userFilters) await saveUserFilters(S.userFilters, { skipSync: true });
  await queueSync();
});

api.runtime.onStartup.addListener(() => { setupBadge(); queueSync(); });

// If the browser dropped our registrations (or this is a fresh worker after
// an update), restore them. Cheap: one API call per worker start.
(async () => {
  try {
    const existing = await api.scripting.getRegisteredContentScripts({ ids: [SCRIPT_IDS.cosmetic] });
    if (!existing.length) queueSync();
  } catch (e) { queueSync(); }
})();

// ------------------------------------------------------------ user rules

async function saveUserFilters(text, opts = {}) {
  const compiled = A.compileUserFilters(text, USER_ID_START);
  const rejected = compiled.rejected.slice();
  const current = await api.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = current.map((r) => r.id).filter((id) => id !== PAUSE_RULE_ID);
  let added = 0;
  try {
    await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: compiled.rules });
    added = compiled.rules.length;
  } catch (e) {
    // One bad rule fails the whole batch; add them one by one to isolate it.
    await api.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: [] });
    for (const rule of compiled.rules) {
      try {
        await api.declarativeNetRequest.updateDynamicRules({ addRules: [rule] });
        added++;
      } catch (err) {
        rejected.push({ line: 0, text: JSON.stringify(rule.condition), reason: String(err.message || err) });
      }
    }
  }
  await setState({ userFilters: text, userCompiled: { css: compiled.css, unhide: compiled.unhide } });
  if (!opts.skipSync) await queueSync();
  const cosmetic = Object.values(compiled.css).reduce((n, list) => n + list.length, 0);
  return { networkRules: added, cosmeticRules: cosmetic, rejected };
}

// --------------------------------------------------------------- picker

async function pickerSave(sender, host, selector) {
  if (!host || !A.isSafeSelector(selector)) throw new Error('Unusable selector');
  const S = await state();
  const line = `${siteOf(host)}##${selector}`;
  const lines = S.userFilters ? S.userFilters.split('\n') : [];
  if (!lines.includes(line)) lines.push(line);
  await saveUserFilters(lines.join('\n'));
  const css = A.cssRule(selector);
  if (sender.tab) {
    try { await insertCSS(sender.tab.id, sender.frameId || 0, css); } catch (e) { /* page shows it already hidden */ }
  }
  return { line, css };
}

async function pickerUndo(sender, line, css) {
  const S = await state();
  const lines = (S.userFilters || '').split('\n').filter((l) => l !== line);
  await saveUserFilters(lines.join('\n'));
  if (sender.tab && css) {
    const target = { tabId: sender.tab.id, frameIds: [sender.frameId || 0] };
    try { await api.scripting.removeCSS({ target, css, origin: 'USER' }); } catch (e) {
      try { await api.scripting.removeCSS({ target, css }); } catch (e2) { /* reload clears it */ }
    }
  }
  return {};
}

// --------------------------------------------------------- popup/options

async function setPaused(host, paused) {
  const site = siteOf(host);
  const S = await state();
  const list = new Set(S.paused);
  if (paused) list.add(site);
  else for (const p of [...list]) if (host === p || host.endsWith('.' + p)) list.delete(p);
  await setState({ paused: [...list].sort() });
  await syncPauseRule();
  await queueSync();
  return { paused };
}

async function siteState(url) {
  let host = '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname;
  } catch (e) { /* not a web page */ }
  const S = await state();
  return { host, site: host ? siteOf(host) : '', paused: !!host && isPaused(S.paused, host) };
}

async function optionsState() {
  const S = await state();
  const M = await meta();
  const enabled = await api.declarativeNetRequest.getEnabledRulesets();
  let available = null;
  try { available = await api.declarativeNetRequest.getAvailableStaticRuleCount(); } catch (e) { /* Safari */ }
  return {
    target: M.target, builtAt: M.builtAt, limits: M.limits,
    rulesets: M.rulesets.map((r) => Object.assign({}, r, { enabled: enabled.includes(r.id) })),
    availableStaticRules: available,
    settings: S.settings, paused: S.paused, userFilters: S.userFilters,
  };
}

async function setRuleset(id, enabled) {
  const M = await meta();
  if (enabled && M.target === 'safari') {
    const on = new Set(await api.declarativeNetRequest.getEnabledRulesets());
    on.add(id);
    const cost = M.rulesets.filter((r) => on.has(r.id)).reduce((n, r) => n + r.safariCost, 0);
    if (cost > M.limits.safariBudget) {
      throw new Error(`Safari allows about 150,000 rules per extension; this would need ${cost.toLocaleString()}. Turn another list off first.`);
    }
  }
  await api.declarativeNetRequest.updateEnabledRulesets(enabled
    ? { enableRulesetIds: [id] } : { disableRulesetIds: [id] });
  return {};
}

async function setSetting(key, value) {
  const S = await state();
  if (!(key in DEFAULTS.settings)) throw new Error('Unknown setting');
  await setState({ settings: Object.assign({}, S.settings, { [key]: !!value }) });
  await queueSync();
  return {};
}

// -------------------------------------------------------------- messages

const extensionOrigin = api.runtime.getURL('');

async function handle(msg, sender) {
  const fromExtensionPage = typeof sender.url === 'string' && sender.url.startsWith(extensionOrigin);
  switch (msg && msg.type) {
    case 'cosmetic': return applyCosmetic(sender, String(msg.host || ''));
    case 'pickerSave': return pickerSave(sender, String(msg.host || ''), String(msg.selector || ''));
    case 'pickerUndo': return pickerUndo(sender, String(msg.line || ''), String(msg.css || ''));
  }
  if (!fromExtensionPage) throw new Error('Not allowed');
  switch (msg.type) {
    case 'siteState': return siteState(String(msg.url || ''));
    case 'setPaused': return setPaused(String(msg.host || ''), !!msg.paused);
    case 'optionsState': return optionsState();
    case 'setRuleset': return setRuleset(String(msg.id), !!msg.enabled);
    case 'setSetting': return setSetting(String(msg.key), msg.value);
    case 'saveUserFilters': return saveUserFilters(String(msg.text || ''));
    default: throw new Error('Unknown message');
  }
}

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(
    (res) => sendResponse(res || {}),
    (e) => sendResponse({ error: String((e && e.message) || e) }),
  );
  return true; // async response
});
