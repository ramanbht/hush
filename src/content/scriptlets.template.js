/*
 * Hush scriptlets. Runs in the page's own JavaScript world at document_start,
 * before any page script, and only on sites that have scriptlet rules.
 *
 * Scriptlets neutralize ad and anti-adblock code that network blocking cannot
 * reach, for example ads described inside a first-party JSON response
 * (YouTube) or a script that checks whether an ad loaded. Names and argument
 * conventions follow uBlock Origin so its filter lists can be used directly.
 *
 * The build tool replaces the DATA marker below with the compiled rules.
 */
(function () {
  'use strict';
  const DATA = /*__HUSH_SCRIPTLET_DATA__*/null;
  if (!DATA || typeof location === 'undefined' || !location.hostname) return;

  // Capture natives before any page script can replace them.
  const win = window;
  const ObjectDefine = Object.defineProperty;
  const ObjectGetDesc = Object.getOwnPropertyDescriptor;
  const ObjectKeys = Object.keys;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const ReflectApply = Reflect.apply;
  const JSONParse = JSON.parse;
  const JSONStringify = JSON.stringify;
  const NativeProxy = Proxy;
  const NativeRegExp = RegExp;
  const NativeResponse = win.Response;
  const NativeHeaders = win.Headers;
  const NativeURL = URL;
  const nativeSetTimeout = win.setTimeout.bind(win);
  const isArray = Array.isArray;

  // ---------------------------------------------------- which rules apply
  const calls = new Map();
  const except = new Set();
  for (let h = location.hostname; ;) {
    if (hasOwn(DATA.hosts, h)) for (const c of DATA.hosts[h]) calls.set(JSONStringify(c), c);
    if (hasOwn(DATA.except, h)) for (const s of DATA.except[h]) except.add(s);
    const dot = h.indexOf('.');
    if (dot === -1) break;
    h = h.slice(dot + 1);
  }
  if (!calls.size || except.has('*')) return;

  // ------------------------------------------------------------- helpers
  const MAGIC = 'hush-' + Math.random().toString(36).slice(2);
  let errorsHooked = false;
  function abortError() {
    if (!errorsHooked) {
      errorsHooked = true;
      // Keep our deliberate aborts out of the console and the page's error handlers.
      win.addEventListener('error', (e) => {
        if (e && typeof e.message === 'string' && e.message.includes(MAGIC)) {
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }, true);
    }
    return new ReferenceError(MAGIC);
  }

  // uBO pattern syntax: "/regex/flags" or a literal substring. "" matches all.
  function toRegExp(pattern, defaultFlags) {
    pattern = pattern === undefined ? '' : String(pattern);
    const m = /^\/(.+)\/([dgimsuy]*)$/.exec(pattern);
    try {
      if (m) return new NativeRegExp(m[1], m[2] || defaultFlags || '');
      return new NativeRegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), defaultFlags || '');
    } catch (e) {
      return null;
    }
  }
  // Same, with a leading "!" meaning "does not match".
  function matcher(raw) {
    raw = raw === undefined ? '' : String(raw);
    let not = false;
    if (raw.startsWith('!')) { not = true; raw = raw.slice(1); }
    let re = toRegExp(raw);
    // .test() with a global/sticky regex is stateful; drop those flags.
    if (re && (re.global || re.sticky)) re = new NativeRegExp(re.source, re.flags.replace(/[gy]/g, ''));
    return (s) => (re ? re.test(s) !== not : false);
  }
  function safeString(v) {
    try { return String(v); } catch (e) { return ''; }
  }
  function namedArgs(rest) {
    const out = {};
    for (let i = 0; i + 1 < rest.length; i += 2) out[rest[i]] = rest[i + 1];
    return out;
  }

  // Walks "a.b.c" from `root`, waiting (via accessors) for missing parents to
  // be assigned, then calls onLeaf(owner, "c").
  function trapChain(owner, chain, onLeaf) {
    const dot = chain.indexOf('.');
    if (dot === -1) { onLeaf(owner, chain); return; }
    const prop = chain.slice(0, dot);
    const rest = chain.slice(dot + 1);
    let value;
    try { value = owner[prop]; } catch (e) { return; }
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      trapChain(value, rest, onLeaf);
      return;
    }
    const desc = ObjectGetDesc(owner, prop);
    if (desc && desc.configurable === false) return;
    // Several rules may wait on the same parent (a.x, a.y): chain to any
    // accessor an earlier rule installed instead of replacing it.
    const prevGet = desc && desc.get;
    const prevSet = desc && desc.set;
    try {
      ObjectDefine(owner, prop, {
        configurable: true,
        enumerable: true,
        get() { return prevGet ? ReflectApply(prevGet, this, []) : value; },
        set(v) {
          if (prevSet) ReflectApply(prevSet, this, [v]);
          value = v;
          if (v !== null && (typeof v === 'object' || typeof v === 'function')) trapChain(v, rest, onLeaf);
        },
      });
    } catch (e) { /* frozen */ }
  }

  function defineLeaf(owner, prop, make) {
    const desc = ObjectGetDesc(owner, prop);
    if (desc && desc.configurable === false) return;
    try { ObjectDefine(owner, prop, Object.assign({ configurable: true, enumerable: true }, make(desc))); } catch (e) { /* ignore */ }
  }

  // --------------------------------------------------- property scriptlets
  function abortOnPropertyRead(chain) {
    if (!chain) return;
    trapChain(win, chain, (owner, prop) => defineLeaf(owner, prop, () => ({
      get() { throw abortError(); },
      set() { /* swallow */ },
    })));
  }

  function abortOnPropertyWrite(chain) {
    if (!chain) return;
    trapChain(win, chain, (owner, prop) => defineLeaf(owner, prop, (desc) => {
      const value = desc && !desc.get ? desc.value : undefined;
      return { get() { return value; }, set() { throw abortError(); } };
    }));
  }

  const NO_VALUE = {};
  function constantValue(raw) {
    switch (raw) {
      case 'undefined': return undefined;
      case 'null': return null;
      case 'false': return false;
      case 'true': return true;
      case 'noopFunc': return function () {};
      case 'trueFunc': return function () { return true; };
      case 'falseFunc': return function () { return false; };
      case 'throwFunc': return function () { throw abortError(); };
      case 'emptyObj': case '{}': return {};
      case 'emptyArr': case '[]': return [];
      case "''": case 'emptyStr': case '': return '';
      case 'yes': case 'no': case 'on': case 'off': case 'ok': return raw;
      default:
        if (/^-?\d+$/.test(raw) && Math.abs(parseInt(raw, 10)) <= 0x7fff) return parseInt(raw, 10);
        return NO_VALUE;
    }
  }

  function setConstant(chain, raw) {
    if (!chain) return;
    const value = constantValue(raw === undefined ? '' : String(raw));
    if (value === NO_VALUE) return;
    trapChain(win, chain, (owner, prop) => defineLeaf(owner, prop, () => ({
      get() { return value; },
      set() { /* page writes are ignored */ },
    })));
  }

  function abortCurrentScript(chain, needle, context) {
    if (!chain) return;
    const matches = matcher(needle);
    const ctx = context ? toRegExp(context) : null;
    trapChain(win, chain, (owner, prop) => defineLeaf(owner, prop, (desc) => {
      let value = desc && !desc.get ? desc.value : undefined;
      const getter = desc && desc.get;
      const setter = desc && desc.set;
      const check = () => {
        const e = document.currentScript;
        if (!(e instanceof HTMLScriptElement)) return;
        if (ctx && !ctx.test(e.src)) return;
        const text = e.src ? e.src : e.textContent;
        if (!needle || matches(text)) throw abortError();
      };
      return {
        get() { check(); return getter ? ReflectApply(getter, this, []) : value; },
        set(v) { check(); if (setter) ReflectApply(setter, this, [v]); else value = v; },
      };
    }));
  }

  // ------------------------------------------------------- call defusers
  function noSetTimeoutIf(needle, delay) {
    needle = needle === undefined ? '' : String(needle);
    delay = delay === undefined ? '' : String(delay);
    if (needle === '' && delay === '') return;
    const matches = matcher(needle);
    let delayNot = false;
    if (delay.startsWith('!')) { delayNot = true; delay = delay.slice(1); }
    const want = delay === '' ? null : parseInt(delay, 10);
    win.setTimeout = new NativeProxy(win.setTimeout, {
      apply(target, thisArg, args) {
        const delayOk = want === null || Number.isNaN(want) || ((Number(args[1]) === want) !== delayNot);
        if (delayOk && matches(safeString(args[0]))) args = [function () {}, args[1]];
        return ReflectApply(target, thisArg, args);
      },
    });
  }

  function addEventListenerDefuser(type, pattern) {
    if (!type && !pattern) return;
    const typeOk = matcher(type);
    const handlerOk = matcher(pattern);
    const proto = win.EventTarget.prototype;
    proto.addEventListener = new NativeProxy(proto.addEventListener, {
      apply(target, thisArg, args) {
        const handler = args[1];
        const text = typeof handler === 'function' ? safeString(handler)
          : handler && typeof handler.handleEvent === 'function' ? safeString(handler.handleEvent) : safeString(handler);
        if (typeOk(safeString(args[0])) && handlerOk(text)) return undefined;
        return ReflectApply(target, thisArg, args);
      },
    });
  }

  function noWindowOpenIf(pattern) {
    const matches = matcher(pattern);
    win.open = new NativeProxy(win.open, {
      apply(target, thisArg, args) {
        if (matches(args[0] === undefined ? '' : safeString(args[0]))) return null;
        return ReflectApply(target, thisArg, args);
      },
    });
  }

  // ---------------------------------------------------------- JSON pruning
  // Paths are dot-separated. "[]" iterates every element or property;
  // "[-]" removes the elements whose subtree contains the rest of the path.
  function parsePaths(raw) {
    return String(raw || '').split(/ +/).filter(Boolean).map((p) => p.split('.'));
  }
  function keysOf(obj) {
    return isArray(obj) ? obj.map((_, i) => i) : ObjectKeys(obj);
  }
  function hasPath(obj, segs, i) {
    if (i === segs.length) return true;
    if (obj === null || typeof obj !== 'object') return false;
    const seg = segs[i];
    if (seg === '[]' || seg === '[-]') return keysOf(obj).some((k) => hasPath(obj[k], segs, i + 1));
    return hasOwn(obj, seg) && hasPath(obj[seg], segs, i + 1);
  }
  function prunePath(obj, segs, i) {
    if (obj === null || typeof obj !== 'object') return false;
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === '[-]') {
      let removed = false;
      if (isArray(obj)) {
        for (let k = obj.length - 1; k >= 0; k--) {
          if (hasPath(obj[k], segs, i + 1)) { obj.splice(k, 1); removed = true; }
        }
      } else {
        for (const k of ObjectKeys(obj)) if (hasPath(obj[k], segs, i + 1)) { delete obj[k]; removed = true; }
      }
      return removed;
    }
    if (seg === '[]') {
      if (last) {
        const n = keysOf(obj).length;
        if (isArray(obj)) obj.length = 0; else for (const k of ObjectKeys(obj)) delete obj[k];
        return n > 0;
      }
      let removed = false;
      for (const k of keysOf(obj)) if (prunePath(obj[k], segs, i + 1)) removed = true;
      return removed;
    }
    if (!hasOwn(obj, seg)) return false;
    if (last) { delete obj[seg]; return true; }
    return prunePath(obj[seg], segs, i + 1);
  }
  function makePruner(rawPrune, rawNeedles) {
    const prunes = parsePaths(rawPrune);
    const needles = parsePaths(rawNeedles);
    if (!prunes.length) return null;
    return (obj) => {
      if (obj === null || typeof obj !== 'object') return false;
      if (needles.length && !needles.every((n) => hasPath(obj, n, 0))) return false;
      let pruned = false;
      for (const p of prunes) if (prunePath(obj, p, 0)) pruned = true;
      return pruned;
    };
  }

  function jsonPrune(rawPrune, rawNeedles) {
    const prune = makePruner(rawPrune, rawNeedles);
    if (!prune) return;
    JSON.parse = new NativeProxy(JSON.parse, {
      apply(target, thisArg, args) {
        const out = ReflectApply(target, thisArg, args);
        try { prune(out); } catch (e) { /* never break parsing */ }
        return out;
      },
    });
    const proto = NativeResponse.prototype;
    proto.json = new NativeProxy(proto.json, {
      apply(target, thisArg, args) {
        return ReflectApply(target, thisArg, args).then((out) => {
          try { prune(out); } catch (e) { /* ignore */ }
          return out;
        });
      },
    });
  }

  // ------------------------------------------------- fetch / XHR hooking
  const PROP_KEYS = new Set(['url', 'method', 'body', 'mode', 'credentials', 'cache', 'redirect', 'referrer', 'referrerPolicy', 'integrity', 'keepalive', 'headers']);
  // "propsToMatch": space-separated "key:pattern" pairs; a bare pattern matches the URL.
  function propsMatcher(raw) {
    raw = raw === undefined ? '' : String(raw).trim();
    if (!raw) return () => true;
    const conds = [];
    for (const tok of raw.split(/\s+/)) {
      const colon = tok.indexOf(':');
      const key = colon > 0 ? tok.slice(0, colon) : '';
      if (PROP_KEYS.has(key)) conds.push([key, matcher(tok.slice(colon + 1))]);
      else conds.push(['url', matcher(tok)]);
    }
    return (d) => conds.every(([k, m]) => m(safeString(d[k] === undefined ? '' : d[k])));
  }
  function absoluteURL(u) {
    try { return new NativeURL(safeString(u), location.href).href; } catch (e) { return safeString(u); }
  }
  function fetchDetails(args) {
    const input = args[0];
    const init = args[1] || {};
    const d = { url: '', method: 'GET' };
    try {
      if (input instanceof win.Request) {
        for (const k of PROP_KEYS) if (k !== 'body' && k !== 'headers') d[k] = input[k];
      } else {
        d.url = input;
      }
      for (const k of PROP_KEYS) if (init[k] !== undefined) d[k] = init[k];
    } catch (e) { /* odd input */ }
    d.url = absoluteURL(d.url);
    d.method = safeString(d.method || 'GET').toUpperCase();
    return d;
  }
  function rebuildResponse(original, body) {
    const headers = new NativeHeaders(original.headers);
    headers.delete('content-length');
    const r = new NativeResponse(body, { status: original.status, statusText: original.statusText, headers });
    try {
      Object.defineProperties(r, {
        url: { value: original.url }, type: { value: original.type },
        redirected: { value: original.redirected }, ok: { value: original.ok },
      });
    } catch (e) { /* ignore */ }
    return r;
  }
  // transform(text) returns new text, or null to leave the response alone.
  function hookFetchText(shouldHandle, transform) {
    win.fetch = new NativeProxy(win.fetch, {
      apply(target, thisArg, args) {
        const pending = ReflectApply(target, thisArg, args);
        let d;
        try { d = fetchDetails(args); } catch (e) { return pending; }
        if (!shouldHandle(d)) return pending;
        return pending.then((response) => response.clone().text().then((text) => {
          const out = transform(text);
          return out === null ? response : rebuildResponse(response, out);
        }).catch(() => response));
      },
    });
  }

  function hookXhrText(shouldHandle, transform) {
    const Base = win.XMLHttpRequest;
    const xhrState = new WeakMap(); // per hook: hooks stack as nested subclasses
    class HushXHR extends Base {
      open(method, url, ...rest) {
        xhrState.set(this, { d: { method: safeString(method).toUpperCase(), url: absoluteURL(url) }, out: undefined });
        return super.open(method, url, ...rest);
      }
      get response() {
        const raw = super.response;
        const s = xhrState.get(this);
        if (!s || this.readyState !== 4 || !shouldHandle(s.d)) return raw;
        if (s.out === undefined) s.out = rewrite(this.responseType, raw);
        return s.out === null ? raw : s.out.value;
      }
      get responseText() {
        const raw = super.responseText;
        const s = xhrState.get(this);
        if (!s || this.readyState !== 4 || !shouldHandle(s.d)) return raw;
        if (s.out === undefined) s.out = rewrite(this.responseType, super.response);
        return s.out === null ? raw : s.out.text;
      }
    }
    function rewrite(type, raw) {
      try {
        if (type === '' || type === 'text') {
          const text = transform(raw);
          return text === null ? null : { value: text, text };
        }
        if (type === 'json' && raw !== null) {
          const text = transform(JSONStringify(raw));
          return text === null ? null : { value: JSONParse(text), text };
        }
      } catch (e) { /* leave untouched */ }
      return null;
    }
    win.XMLHttpRequest = HushXHR;
  }

  function jsonTextPruner(rawPrune, rawNeedles) {
    const prune = makePruner(rawPrune, rawNeedles);
    if (!prune) return null;
    return (text) => {
      let obj;
      try { obj = JSONParse(text); } catch (e) { return null; }
      return prune(obj) ? JSONStringify(obj) : null;
    };
  }

  function jsonPruneFetchResponse(rawPrune, rawNeedles, ...rest) {
    const t = jsonTextPruner(rawPrune, rawNeedles);
    if (t) hookFetchText(propsMatcher(namedArgs(rest).propsToMatch), t);
  }

  function jsonPruneXhrResponse(rawPrune, rawNeedles, ...rest) {
    const t = jsonTextPruner(rawPrune, rawNeedles);
    if (t) hookXhrText(propsMatcher(namedArgs(rest).propsToMatch), t);
  }

  function textReplacer(pattern, replacement) {
    if (!pattern) return null;
    const re = toRegExp(pattern, 'gms');
    if (!re) return null;
    const rep = replacement === undefined ? '' : String(replacement);
    return (text) => {
      const out = text.replace(re, rep);
      return out === text ? null : out;
    };
  }

  function trustedReplaceFetchResponse(pattern, replacement, props) {
    const t = textReplacer(pattern, replacement);
    if (t) hookFetchText(propsMatcher(props), t);
  }

  function trustedReplaceXhrResponse(pattern, replacement, props) {
    const t = textReplacer(pattern, replacement);
    if (t) hookXhrText(propsMatcher(props), t);
  }

  function noFetchIf(props, body) {
    if (!props) return;
    const matches = propsMatcher(props);
    const text = body === 'emptyObj' ? '{}' : body === 'emptyArr' ? '[]' : '';
    win.fetch = new NativeProxy(win.fetch, {
      apply(target, thisArg, args) {
        let d;
        try { d = fetchDetails(args); } catch (e) { return ReflectApply(target, thisArg, args); }
        if (!matches(d)) return ReflectApply(target, thisArg, args);
        const r = new NativeResponse(text, { status: 200, statusText: 'OK' });
        try { ObjectDefine(r, 'url', { value: d.url }); } catch (e) { /* ignore */ }
        return Promise.resolve(r);
      },
    });
  }

  function noXhrIf(props) {
    if (!props) return;
    const matches = propsMatcher(props);
    const Base = win.XMLHttpRequest;
    const blocked = new WeakMap();
    class HushXHR extends Base {
      open(method, url, ...rest) {
        blocked.set(this, { d: { method: safeString(method).toUpperCase(), url: absoluteURL(url) }, on: false });
        return super.open(method, url, ...rest);
      }
      send(body) {
        const s = blocked.get(this);
        if (!s || !matches(s.d)) return super.send(body);
        s.on = true;
        nativeSetTimeout(() => {
          for (const type of ['readystatechange', 'load', 'loadend']) this.dispatchEvent(new Event(type));
        }, 1);
      }
      get readyState() { const s = blocked.get(this); return s && s.on ? 4 : super.readyState; }
      get status() { const s = blocked.get(this); return s && s.on ? 200 : super.status; }
      get statusText() { const s = blocked.get(this); return s && s.on ? 'OK' : super.statusText; }
      get response() { const s = blocked.get(this); return s && s.on ? (this.responseType === 'json' ? null : '') : super.response; }
      get responseText() { const s = blocked.get(this); return s && s.on ? '' : super.responseText; }
      get responseURL() { const s = blocked.get(this); return s && s.on ? s.d.url : super.responseURL; }
    }
    win.XMLHttpRequest = HushXHR;
  }

  // ------------------------------------------------------------ DOM edits
  function removeAttr(rawAttrs, selector, behavior) {
    const attrs = String(rawAttrs || '').split(/\s*\|\s*/).filter(Boolean);
    if (!attrs.length) return;
    behavior = String(behavior || '');
    let sel;
    try { sel = selector || attrs.map((a) => `[${CSS.escape(a)}]`).join(','); document.createDocumentFragment().querySelector(sel); }
    catch (e) { return; }
    let queued = false;
    const run = () => {
      queued = false;
      try { for (const el of document.querySelectorAll(sel)) for (const a of attrs) el.removeAttribute(a); } catch (e) { /* ignore */ }
    };
    const queue = () => { if (!queued) { queued = true; nativeSetTimeout(run, 0); } };
    const start = () => {
      run();
      const obs = new MutationObserver(queue);
      obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: attrs });
      if (!/stay/.test(behavior)) win.addEventListener('load', () => nativeSetTimeout(() => obs.disconnect(), 1000), { once: true });
    };
    if (document.readyState === 'loading' && !/asap/.test(behavior)) document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  // --------------------------------------------------------------- run
  const IMPL = {
    'abort-on-property-read': abortOnPropertyRead,
    'abort-on-property-write': abortOnPropertyWrite,
    'set-constant': setConstant,
    'abort-current-script': abortCurrentScript,
    'no-setTimeout-if': noSetTimeoutIf,
    'addEventListener-defuser': addEventListenerDefuser,
    'no-window-open-if': noWindowOpenIf,
    'json-prune': jsonPrune,
    'json-prune-fetch-response': jsonPruneFetchResponse,
    'json-prune-xhr-response': jsonPruneXhrResponse,
    'no-fetch-if': noFetchIf,
    'no-xhr-if': noXhrIf,
    'remove-attr': removeAttr,
    'trusted-replace-fetch-response': trustedReplaceFetchResponse,
    'trusted-replace-xhr-response': trustedReplaceXhrResponse,
  };
  for (const [sig, call] of calls) {
    if (except.has(sig)) continue;
    const fn = IMPL[call[0]];
    if (!fn) continue;
    try { fn(...call.slice(1)); } catch (e) { /* one broken rule must not stop the rest */ }
  }
})();
