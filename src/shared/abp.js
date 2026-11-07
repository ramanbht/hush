/*
 * Hush: filter-list parser and declarativeNetRequest (DNR) compiler.
 *
 * Shared by the build tool (Node) and the extension (for "My filters").
 * Understands the common subset of Adblock Plus / uBlock Origin syntax:
 *   network filters   ||ads.example^$script,third-party,domain=a.com|~b.com
 *   exceptions        @@||cdn.example^$script
 *   element hiding    example.com##.ad-box   ##.generic-ad   example.com#@#.ad-box
 *   scriptlets        example.com##+js(set, adsEnabled, false)
 *   hosts files       0.0.0.0 tracker.example
 * Anything it cannot express faithfully is skipped (never approximated by
 * something broader), so a skipped rule can only cause an unblocked ad, not a
 * broken site.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HushABP = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Higher number wins. At equal priority DNR prefers allow over block, so
  // list exceptions sit just above list blocks, and $important sits above both.
  const PRIORITY = Object.freeze({
    block: 10, redirect: 11, allow: 12, allowAllRequests: 13,
    importantBlock: 20, importantRedirect: 21, importantAllow: 22,
    userBlock: 30, userAllow: 31, userAllowAll: 32,
    pause: 100,
  });

  // Rule ids at or above this value are allow-type rules. The popup uses this
  // to count only blocking matches.
  const ALLOW_ID_BASE = 5000000;
  const BUCKET_CHUNK = 5000; // max requestDomains per merged rule

  const TYPE_MAP = {
    script: 'script', image: 'image', stylesheet: 'stylesheet', css: 'stylesheet',
    object: 'object', 'object-subrequest': 'object',
    xmlhttprequest: 'xmlhttprequest', xhr: 'xmlhttprequest',
    subdocument: 'sub_frame', frame: 'sub_frame',
    ping: 'ping', beacon: 'ping', media: 'media', font: 'font',
    websocket: 'websocket', other: 'other',
  };
  const ALL_TYPES = ['main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font',
    'object', 'xmlhttprequest', 'ping', 'media', 'websocket', 'other'];
  const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other']);
  const NOOP_OPTIONS = new Set(['_', 'reason']);
  const UNSUPPORTED_OPTIONS = new Set(['csp', 'removeparam', 'queryprune', 'header', 'replace',
    'urltransform', 'uritransform', 'permissions', 'urlskip', 'ipaddress', 'cname', 'rewrite',
    'sitekey', 'genericblock', 'webrtc', 'inline-script', 'inline-font', 'redirect-rule',
    'popunder', 'mp4', 'network', 'jsinject', 'content', 'extension', 'stealth', 'app']);

  // Surrogate resources served instead of a blocked request, so pages see a
  // successful load instead of an error (a common anti-adblock signal).
  // Complex surrogates (video ad SDKs, fingerprinting libs) are deliberately
  // NOT faked: players handle a failed SDK load better than a fake one.
  const REDIRECTS = {
    'noopjs': 'noop.js', 'noop.js': 'noop.js', 'abp-resource:blank-js': 'noop.js',
    'nooptext': 'noop.txt', 'noop.txt': 'noop.txt', 'empty': 'noop.txt',
    'noopcss': 'noop.css', 'noop.css': 'noop.css',
    'noopjson': 'noop.json', 'noop.json': 'noop.json',
    'noopframe': 'noop.html', 'noop.html': 'noop.html',
    '1x1.gif': '1x1.gif', '1x1-transparent.gif': '1x1.gif',
    '2x2.png': '2x2.png', '2x2-transparent.png': '2x2.png', '3x2.png': '2x2.png', '32x32.png': '2x2.png',
    'googletagservices_gpt.js': 'noop.js', 'googletagservices.com/gpt.js': 'noop.js',
    'googletagmanager_gtm.js': 'noop.js', 'googletagmanager.com/gtm.js': 'noop.js',
    'google-analytics_analytics.js': 'noop.js', 'google-analytics.com/analytics.js': 'noop.js',
    'google-analytics_ga.js': 'noop.js', 'google-analytics.com/ga.js': 'noop.js',
    'googlesyndication_adsbygoogle.js': 'noop.js', 'googlesyndication.com/adsbygoogle.js': 'noop.js',
    'amazon_apstag.js': 'noop.js', 'chartbeat.js': 'noop.js',
    'scorecardresearch_beacon.js': 'noop.js', 'scorecardresearch.com/beacon.js': 'noop.js',
  };
  const RESOURCE_DIR = '/web_accessible_resources/';

  // Scriptlets implemented in content/scriptlets.template.js, with aliases.
  const SCRIPTLETS = {
    'abort-on-property-read': ['aopr'],
    'abort-on-property-write': ['aopw'],
    'set-constant': ['set'],
    'abort-current-script': ['acs', 'abort-current-inline-script', 'acis'],
    'no-setTimeout-if': ['nostif', 'prevent-setTimeout', 'setTimeout-defuser', 'std'],
    'addEventListener-defuser': ['aeld', 'prevent-addEventListener'],
    'no-window-open-if': ['nowoif', 'prevent-window-open', 'window.open-defuser'],
    'json-prune': [],
    'json-prune-fetch-response': [],
    'json-prune-xhr-response': [],
    'no-fetch-if': ['prevent-fetch'],
    'no-xhr-if': ['prevent-xhr'],
    'remove-attr': ['ra'],
    'trusted-replace-fetch-response': ['trusted-rpfr'],
    'trusted-replace-xhr-response': [],
  };
  const SCRIPTLET_ALIASES = new Map();
  for (const [name, aliases] of Object.entries(SCRIPTLETS)) {
    SCRIPTLET_ALIASES.set(name, name);
    for (const a of aliases) SCRIPTLET_ALIASES.set(a, name);
  }

  // ---------------------------------------------------------------- hosts

  const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
  const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

  function normalizeHost(h) {
    h = String(h).trim().toLowerCase();
    if (h.endsWith('.')) h = h.slice(0, -1);
    if (!h) return null;
    if (!/^[a-z0-9.-]+$/.test(h)) {
      try { h = new URL('http://' + h + '/').hostname; } catch (e) { return null; }
    }
    return HOST_RE.test(h) ? h : null;
  }

  function isIPv4(h) { return IPV4_RE.test(h); }

  // Match pattern covering a host and all its subdomains.
  function hostToMatchPattern(h) {
    return isIPv4(h) ? `*://${h}/*` : `*://*.${h}/*`;
  }

  // ["a.b.example.com", "b.example.com", "example.com", "com"]
  function hostSuffixes(host) {
    const out = [];
    let h = host;
    while (h) {
      out.push(h);
      const dot = h.indexOf('.');
      if (dot === -1) break;
      h = h.slice(dot + 1);
    }
    return out;
  }

  // Entities ("amazon.*") mean the site under any public suffix. Network rules
  // cannot express them (DNR has no TLD wildcard); cosmetic rules can, because
  // hosts are matched at runtime (see entityKeys).
  const ENTITY_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.\*$/;
  function isEntity(h) { return h.endsWith('.*'); }

  function parseDomainList(str, sep, allowEntities = false) {
    const include = [], exclude = [];
    let skippedInclude = 0;
    for (let d of str.split(sep)) {
      d = d.trim();
      if (!d) continue;
      const neg = d.startsWith('~');
      if (neg) d = d.slice(1);
      let h = null;
      if (allowEntities && ENTITY_RE.test(d.toLowerCase())) h = d.toLowerCase();
      else if (!d.includes('*') && !d.startsWith('/')) h = normalizeHost(d); // regex domains: unsupported
      if (!h) { if (!neg) skippedInclude++; continue; }
      (neg ? exclude : include).push(h);
    }
    return { include, exclude, skippedInclude };
  }

  // Entity keys a hostname can match, by treating its last one or two labels
  // as the public suffix: www.amazon.co.uk -> amazon.co.*, amazon.*, www.amazon.*.
  // A two-label suffix needs a short second-level label (co, com, org, ne...),
  // which covers the common country forms without bundling the public suffix list.
  function entityKeys(host) {
    const out = [];
    const labels = host.split('.');
    for (let i = 0; i < labels.length - 1; i++) {
      out.push(labels.slice(i, -1).join('.') + '.*');
      if (labels.length - i >= 3 && labels[labels.length - 2].length <= 3) {
        out.push(labels.slice(i, -2).join('.') + '.*');
      }
    }
    return out;
  }

  // Every key a hostname's rules may be stored under.
  function lookupKeys(host) {
    return hostSuffixes(host).concat(entityKeys(host));
  }

  // Common public suffixes, used only to turn an entity into match patterns
  // for content-script exclusions.
  const ENTITY_SUFFIXES = ['com', 'net', 'org', 'io', 'co', 'us', 'ca', 'mx', 'br', 'ar', 'cl', 'uk', 'ie',
    'de', 'at', 'ch', 'fr', 'be', 'nl', 'lu', 'it', 'es', 'pt', 'se', 'no', 'dk', 'fi', 'pl', 'cz', 'sk', 'hu',
    'ro', 'gr', 'tr', 'ru', 'ua', 'in', 'jp', 'cn', 'kr', 'tw', 'hk', 'sg', 'my', 'th', 'vn', 'id', 'ph', 'au',
    'nz', 'za', 'eg', 'ae', 'sa', 'il', 'eu', 'info', 'tv', 'me', 'cc', 'to', 'ws', 'xyz', 'biz', 'site',
    'co.uk', 'co.jp', 'co.in', 'co.nz', 'co.za', 'co.kr', 'com.au', 'com.br', 'com.mx', 'com.tr', 'com.sg',
    'com.ar', 'com.be', 'com.cn', 'com.hk', 'com.tw', 'com.my', 'com.eg', 'com.sa'];

  // Match patterns for a host and its subdomains (an entity expands to many).
  function matchPatternsFor(h) {
    if (!isEntity(h)) return [hostToMatchPattern(h)];
    const base = h.slice(0, -2);
    return ENTITY_SUFFIXES.map((s) => `*://*.${base}.${s}/*`);
  }

  // ---------------------------------------------------------- preprocessor

  // Evaluates uBO's "!#if" expressions: identifiers, !, &&, ||, parentheses.
  function evalCondition(expr, env) {
    const tokens = expr.match(/!|&&|\|\||\(|\)|[A-Za-z0-9_]+/g) || [];
    let i = 0;
    const peek = () => tokens[i];
    const next = () => tokens[i++];
    function primary() {
      const t = next();
      if (t === '!') return !primary();
      if (t === '(') { const v = or(); next(); return v; }
      return !!(t && env[t]);
    }
    function and() { let v = primary(); while (peek() === '&&') { next(); v = primary() && v; } return v; }
    function or() { let v = and(); while (peek() === '||') { next(); v = and() || v; } return v; }
    return or();
  }

  function preprocess(text, env) {
    const out = [];
    const frames = [];
    let active = true;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('!#if ')) {
        const cond = evalCondition(line.slice(5), env || {});
        frames.push({ parent: active, cond });
        active = active && cond;
        continue;
      }
      if (line === '!#else') {
        const f = frames[frames.length - 1];
        if (f) active = f.parent && !f.cond;
        continue;
      }
      if (line === '!#endif') {
        const f = frames.pop();
        active = f ? f.parent : true;
        continue;
      }
      if (active && line) out.push(line);
    }
    return out;
  }

  // -------------------------------------------------------------- parsing

  const COSMETIC_SEP_RE = /^(.*?)(#@?(?:\$\?|\?|\$|%)?#)(.*)$/;
  const DOMAIN_PREFIX_RE = /^[a-z0-9~,.*_:\[\]-]*$/i;
  const HOSTS_LINE_RE = /^(?:0\.0\.0\.0|127\.0\.0\.1|::1?|::)\s+([^\s#]+)/;
  const PROCEDURAL_RE = /:(?:-abp-[a-z-]+|has-text|contains|xpath|upward|matches-css(?:-before|-after)?|matches-attr|matches-path|matches-prop|matches-media|min-text-length|watch-attr|others|shadow|if|if-not|nth-ancestor|-ext-[a-z-]+|properties|remove-attr|remove-class)\(/i;

  function skip(reason) { return { kind: 'skip', reason }; }

  function parseLine(line, format) {
    line = line.trim();
    if (!line || line[0] === '!' || line[0] === '[') return null;
    if (format === 'hosts') {
      if (line[0] === '#') return null;
      const m = HOSTS_LINE_RE.exec(line);
      const host = normalizeHost(m ? m[1] : line.split(/\s+/)[0]);
      if (!host || host === 'localhost' || host === 'localhost.localdomain') return skip('hosts-invalid');
      return parseNetwork('||' + host + '^');
    }
    const m = COSMETIC_SEP_RE.exec(line);
    if (m && DOMAIN_PREFIX_RE.test(m[1])) return parseCosmetic(m[1], m[2], m[3]);
    return parseNetwork(line);
  }

  // ------------------------------------------------------------- cosmetic

  function sanitizeStyle(decls) {
    decls = decls.trim();
    if (!decls || /[{}\\]|\/\*|url\(|expression\(|@|image-set\(/i.test(decls)) return null;
    const parts = decls.split(';').map((d) => d.trim()).filter(Boolean);
    if (!parts.length || parts.some((d) => !/^[a-z-]+\s*:\s*[^:]+$/i.test(d))) return null;
    return parts.map((d) => (/!important\s*$/i.test(d) ? d : d + ' !important')).join('; ');
  }

  function isSafeSelector(s) {
    if (!s || s.length > 1000 || s[0] === '@') return false;
    let quote = null, paren = 0, bracket = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\') { i++; if (i >= s.length) return false; continue; }
      if (quote) { if (c === quote) quote = null; else if (c === '\n' || c === '\r') return false; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === '{' || c === '}' || c === ';' || c === '\n' || c === '\r') return false;
      if (c === '/' && s[i + 1] === '*') return false;
      if (c === '(') paren++;
      else if (c === ')') { if (--paren < 0) return false; }
      else if (c === '[') bracket++;
      else if (c === ']') { if (--bracket < 0) return false; }
    }
    return !quote && paren === 0 && bracket === 0;
  }

  // Returns { selector, style } or a skip reason string.
  function processSelector(sel) {
    sel = sel.trim();
    let style = null;
    const styleAt = sel.lastIndexOf(':style(');
    if (styleAt !== -1 && sel.endsWith(')')) {
      style = sanitizeStyle(sel.slice(styleAt + 7, -1));
      if (!style) return 'bad-style';
      sel = sel.slice(0, styleAt).trim();
    } else if (sel.endsWith(':remove()')) {
      sel = sel.slice(0, -9).trim();
    }
    sel = sel.replace(/:-abp-has\(/g, ':has(');
    if (PROCEDURAL_RE.test(sel)) return 'procedural';
    if (!isSafeSelector(sel)) return 'invalid-selector';
    return { selector: sel, style };
  }

  // Splits uBO scriptlet arguments: commas separate, "\," escapes, and an
  // argument wrapped in matching quotes may contain commas.
  function splitScriptletArgs(s) {
    const args = [];
    let i = 0;
    const n = s.length;
    while (i <= n) {
      while (i < n && s[i] === ' ') i++;
      let arg = '';
      const q = s[i];
      if ((q === "'" || q === '"' || q === '`') && s.indexOf(q, i + 1) !== -1) {
        let j = i + 1;
        while (j < n && !(s[j] === q && s[j - 1] !== '\\')) j++;
        arg = s.slice(i + 1, j).replace(new RegExp('\\\\' + q, 'g'), q);
        i = j + 1;
        while (i < n && s[i] !== ',') i++;
      } else {
        let j = i;
        while (j < n && !(s[j] === ',' && s[j - 1] !== '\\')) j++;
        arg = s.slice(i, j).trim().replace(/\\,/g, ',');
        i = j;
      }
      args.push(arg);
      if (i >= n) break;
      i++; // skip comma
    }
    return args;
  }

  function canonicalScriptlet(name) {
    name = name.trim().replace(/\.js$/, '');
    return SCRIPTLET_ALIASES.get(name) || null;
  }

  function parseCosmetic(prefix, sep, body) {
    const exception = sep.includes('@');
    const domains = parseDomainList(prefix, ',', true);
    if (domains.skippedInclude && !domains.include.length) return skip('cosmetic-bad-domain');
    body = body.trim();
    if (sep === '##' || sep === '#@#') {
      if (body.startsWith('+js(') && body.endsWith(')')) {
        // Scriptlets are registered per host with match patterns, which cannot
        // express "any suffix", so entity domains stay unsupported for them.
        const hadInclude = domains.include.length > 0;
        domains.include = domains.include.filter((h) => !isEntity(h));
        domains.exclude = domains.exclude.filter((h) => !isEntity(h));
        if (hadInclude && !domains.include.length) return skip('scriptlet-entity-domain');
        const inner = body.slice(4, -1).trim();
        if (!inner) return { kind: 'scriptlet', exception, domains, call: null };
        const args = splitScriptletArgs(inner);
        const name = canonicalScriptlet(args[0]);
        if (!name) return skip('scriptlet-unsupported');
        return { kind: 'scriptlet', exception, domains, call: [name, ...args.slice(1)] };
      }
      if (body.startsWith('^')) return skip('html-filter');
    } else if (sep === '#?#' || sep === '#@?#') {
      // Extended CSS: only :-abp-has(), which is native :has(), survives.
    } else {
      return skip('snippet');
    }
    const r = processSelector(body);
    if (typeof r === 'string') return skip(r);
    return { kind: 'hide', exception, domains, selector: r.selector, style: r.style };
  }

  // -------------------------------------------------------------- network

  function splitOptions(s) {
    const out = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && s[i + 1] === ',') { cur += ','; i++; continue; }
      if (c === ',') { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out.map((o) => o.trim()).filter(Boolean);
  }

  const OPTIONS_START_RE = /^~?[a-z0-9_-]+(?:=|,|$)/i;

  function findOptionsStart(s) {
    if (s.startsWith('/')) {
      // A regex pattern may itself contain "$"; options must follow its closing "/".
      const k = s.lastIndexOf('/$');
      if (k > 0 && OPTIONS_START_RE.test(s.slice(k + 2))) return k + 1;
      if (s.endsWith('/')) return -1;
    }
    const i = s.lastIndexOf('$');
    if (i === -1) return -1;
    return OPTIONS_START_RE.test(s.slice(i + 1)) ? i : -1;
  }

  function filterKey(exception, pattern, optionTokens) {
    const opts = optionTokens.filter((o) => o.toLowerCase() !== 'badfilter').sort();
    return (exception ? '@@' : '') + pattern + (opts.length ? '$' + opts.join(',') : '');
  }

  function regexIsRE2Safe(re) {
    // RE2 (Chrome) has no lookaround or backreferences.
    return !/\(\?<?[=!]|\\[1-9]|\(\?<[a-z]/i.test(re);
  }

  // Rough count of the instructions RE2 compiles a regex into. Chrome rejects
  // DNR regexes whose compiled program exceeds a small memory budget
  // ("memoryLimitExceeded") and silently drops those rules. Calibrated
  // against Chrome 153: every rejected list regex scores above 150, every
  // accepted one but one scores below it.
  const MAX_REGEX_COST = 150;
  function regexCost(re) {
    let i = 0;
    const escCost = (e) => (e === 'w' ? 4 : e === 'd' ? 1 : e === 's' ? 4 : 'WDS'.includes(e) ? 8 : 1);
    function atom() {
      const c = re[i];
      if (c === '(') {
        i++;
        if (re[i] === '?') { i++; if (re[i] === ':') i++; }
        const v = alt();
        i++;
        return v;
      }
      if (c === '[') {
        let j = i + 1, n = 0, neg = false;
        if (re[j] === '^') { neg = true; j++; }
        if (re[j] === ']') { n++; j++; }
        while (j < re.length && re[j] !== ']') {
          if (re[j] === '\\') { n += escCost(re[j + 1]); j += 2; }
          else if (re[j + 1] === '-' && re[j + 2] && re[j + 2] !== ']') { n += /[a-z]/i.test(re[j]) ? 2 : 1; j += 3; }
          else { n += /[a-z]/i.test(re[j]) ? 2 : 1; j++; }
        }
        i = j + 1;
        return neg ? n + 8 : n;
      }
      if (c === '\\') { i += 2; return escCost(re[i - 1]); }
      i++;
      return c === '.' ? 8 : 1;
    }
    function quant(size) {
      const c = re[i];
      if (c === '*' || c === '+' || c === '?') { i++; if (re[i] === '?') i++; return size + 1; }
      const m = c === '{' && /^\{(\d+)(,(\d*))?\}/.exec(re.slice(i));
      if (!m) return size;
      i += m[0].length;
      if (re[i] === '?') i++;
      const lo = +m[1];
      const hi = m[2] ? (m[3] === '' ? null : +m[3]) : lo;
      return hi === null ? lo * size + 1 : hi * size + (hi - lo);
    }
    function seq() { let n = 0; while (i < re.length && re[i] !== '|' && re[i] !== ')') n += quant(atom()); return n; }
    function alt() { let n = seq(), k = 0; while (re[i] === '|') { i++; n += seq(); k++; } return n + k; }
    return alt();
  }

  function parseNetwork(line) {
    let s = line;
    let exception = false;
    if (s.startsWith('@@')) { exception = true; s = s.slice(2); }
    let pattern = s;
    let optionTokens = [];
    const at = findOptionsStart(s);
    if (at !== -1) {
      pattern = s.slice(0, at);
      optionTokens = splitOptions(s.slice(at + 1));
    }

    const f = {
      kind: 'network', exception, important: false, badfilter: false,
      key: null, types: new Set(), notTypes: new Set(), popup: false,
      domainType: null, initiator: null, request: null, excludedRequest: [],
      methods: [], notMethods: [], matchCase: false, redirect: null,
      flags: { ehide: false, ghide: false, shide: false }, document: false,
    };

    for (const tok of optionTokens) {
      const eq = tok.indexOf('=');
      let name = (eq === -1 ? tok : tok.slice(0, eq)).toLowerCase();
      const value = eq === -1 ? '' : tok.slice(eq + 1);
      let neg = false;
      if (name.startsWith('~')) { neg = true; name = name.slice(1); }
      if (NOOP_OPTIONS.has(name)) continue;
      if (TYPE_MAP[name]) { (neg ? f.notTypes : f.types).add(TYPE_MAP[name]); continue; }
      switch (name) {
        case 'third-party': case '3p': case 'strict3p':
          f.domainType = neg ? 'firstParty' : 'thirdParty'; break;
        case 'first-party': case '1p': case 'strict1p':
          f.domainType = neg ? 'thirdParty' : 'firstParty'; break;
        case 'domain': case 'from': {
          const d = parseDomainList(value, '|');
          if (d.skippedInclude && !d.include.length) return skip('entity-domain');
          f.initiator = d; break;
        }
        case 'to': {
          const d = parseDomainList(value, '|');
          if (d.skippedInclude && !d.include.length) return skip('entity-domain');
          f.request = d.include.length ? d.include : null;
          f.excludedRequest.push(...d.exclude);
          break;
        }
        case 'denyallow': {
          const d = parseDomainList(value, '|');
          f.excludedRequest.push(...d.include);
          break;
        }
        case 'method':
          for (let m of value.toLowerCase().split('|')) {
            const mneg = m.startsWith('~');
            if (mneg) m = m.slice(1);
            if (!METHODS.has(m)) return skip('bad-method');
            (mneg ? f.notMethods : f.methods).push(m);
          }
          break;
        case 'match-case': f.matchCase = true; break;
        case 'important': f.important = true; break;
        case 'badfilter': f.badfilter = true; break;
        case 'all': for (const t of ALL_TYPES) f.types.add(t); break;
        case 'popup': f.popup = true; break;
        case 'document': case 'doc':
          if (exception) f.document = true; else f.types.add('main_frame');
          break;
        case 'elemhide': case 'ehide': f.flags.ehide = true; break;
        case 'generichide': case 'ghide': f.flags.ghide = true; break;
        case 'specifichide': case 'shide': f.flags.shide = true; break;
        case 'redirect': case 'empty': {
          const res = (name === 'empty' ? 'empty' : value).replace(/:\d+$/, '');
          f.redirect = REDIRECTS[res] || 'block';
          break;
        }
        default:
          if (UNSUPPORTED_OPTIONS.has(name)) return skip('option-' + name);
          return skip('option-unknown');
      }
    }
    f.key = filterKey(exception, pattern, optionTokens);
    if (f.badfilter) return f;

    // A rule that only targets popups cannot be expressed with DNR.
    if (f.popup && !f.types.size && !f.document && !f.flags.ehide && !f.flags.ghide && !f.flags.shide) {
      return skip('popup');
    }

    // Pattern -> urlFilter / regexFilter / bucketable host.
    let p = pattern;
    if (p.length > 2 && p.startsWith('/') && p.endsWith('/')) {
      const re = p.slice(1, -1);
      if (!regexIsRE2Safe(re) || /[^\x20-\x7e]/.test(re)) return skip('regex-unsupported');
      if (regexCost(re) > MAX_REGEX_COST) return skip('regex-too-large');
      f.regex = re;
    } else {
      if (/\s/.test(p)) return skip('whitespace');
      if (p.startsWith('||*')) p = p.slice(2);
      while (p.startsWith('*')) p = p.slice(1);
      while (p.endsWith('*')) p = p.slice(0, -1);
      if (p === '|' || p === '||') p = '';
      if (/[^\x20-\x7e]/.test(p)) {
        const m = /^\|\|([^/^:?|]+)(.*)$/.exec(p);
        const host = m && normalizeHost(m[1]);
        if (!host || /[^\x20-\x7e]/.test(m[2])) return skip('non-ascii');
        p = '||' + host + m[2];
      }
      const inner = p.replace(/^\|\|?/, '').replace(/\|$/, '');
      if (inner.includes('|')) return skip('bad-anchor');
      const hm = /^\|\|([a-z0-9.-]+)\^\|?$/i.exec(p);
      const host = hm && hm[1].includes('.') ? normalizeHost(hm[1]) : null;
      if (host) f.host = host;
      else if (p) f.urlFilter = f.matchCase ? p : p.toLowerCase();
    }

    // Host that cosmetic flags ($elemhide, $generichide, $document) apply to.
    f.flagHosts = f.host ? [f.host]
      : (f.initiator && f.initiator.include.length ? f.initiator.include : []);
    return f;
  }

  // Turns a parsed network filter into { action, priority, condition, host }.
  function toDNR(f, user) {
    if (f.badfilter) return null;
    const hasFlags = f.flags.ehide || f.flags.ghide || f.flags.shide;
    let action;
    if (f.exception) {
      if (f.document) action = 'allowAllRequests';
      else if (hasFlags && !f.types.size && !f.notTypes.size) return null; // cosmetic-only exception
      else action = 'allow';
    } else {
      action = f.redirect && f.redirect !== 'block' ? 'redirect' : 'block';
    }

    const c = {};
    if (f.urlFilter) c.urlFilter = f.urlFilter;
    if (f.regex) c.regexFilter = f.regex;
    if (f.matchCase && (c.urlFilter || c.regexFilter)) c.isUrlFilterCaseSensitive = true;
    if (f.domainType) c.domainType = f.domainType;
    if (f.initiator) {
      if (f.initiator.include.length) c.initiatorDomains = [...new Set(f.initiator.include)].sort();
      if (f.initiator.exclude.length) c.excludedInitiatorDomains = [...new Set(f.initiator.exclude)].sort();
    }
    if (f.request) c.requestDomains = [...new Set(f.request)].sort();
    if (f.excludedRequest.length) c.excludedRequestDomains = [...new Set(f.excludedRequest)].sort();
    if (f.methods.length) c.requestMethods = [...new Set(f.methods)].sort();
    if (f.notMethods.length) c.excludedRequestMethods = [...new Set(f.notMethods)].sort();

    if (action === 'allowAllRequests') {
      c.resourceTypes = ['main_frame', 'sub_frame'];
    } else if (f.types.size) {
      const types = [...f.types].filter((t) => !f.notTypes.has(t));
      if (!types.length) return null;
      c.resourceTypes = types.sort();
    } else if (f.notTypes.size) {
      c.excludedResourceTypes = [...new Set([...f.notTypes, 'main_frame'])].sort();
    }

    // Refuse rules that would match every request on every site.
    const scoped = c.initiatorDomains || c.requestDomains || f.host;
    if (!c.urlFilter && !c.regexFilter && !scoped) return null;

    let priority;
    if (user) {
      priority = action === 'allowAllRequests' ? PRIORITY.userAllowAll
        : action === 'allow' ? PRIORITY.userAllow : PRIORITY.userBlock;
      if (action === 'redirect') action = 'block';
    } else if (action === 'allowAllRequests') {
      priority = f.important ? PRIORITY.importantAllow : PRIORITY.allowAllRequests;
    } else if (action === 'allow') {
      priority = f.important ? PRIORITY.importantAllow : PRIORITY.allow;
    } else if (action === 'redirect') {
      priority = f.important ? PRIORITY.importantRedirect : PRIORITY.redirect;
    } else {
      priority = f.important ? PRIORITY.importantBlock : PRIORITY.block;
    }
    const r = { action, priority, condition: c, host: f.host || null };
    if (action === 'redirect') r.redirect = RESOURCE_DIR + f.redirect;
    return r;
  }

  function makeRule(r, requestDomains) {
    const action = { type: r.action };
    if (r.action === 'redirect') action.redirect = { extensionPath: r.redirect };
    const condition = Object.assign({}, r.condition);
    if (requestDomains) condition.requestDomains = requestDomains;
    return { id: 0, priority: r.priority, action, condition };
  }

  // Drops hosts already covered by a parent domain in the same set.
  function pruneSubdomains(hosts) {
    const set = new Set(hosts);
    const out = [];
    for (const h of set) {
      let covered = false;
      for (const s of hostSuffixes(h).slice(1)) if (set.has(s)) { covered = true; break; }
      if (!covered) out.push(h);
    }
    return out.sort();
  }

  // Merges `||host^` filters that share every other condition into one rule
  // with a requestDomains array (e.g. ~85k host filters become a few rules),
  // then de-duplicates and numbers the rules: blocking rules from blockStart,
  // allow-type rules from ALLOW_ID_BASE + allowOffset.
  function assembleRules(dnrList, blockStart = 1, allowOffset = 0) {
    const buckets = new Map();
    const singles = new Map();
    for (const r of dnrList) {
      if (r.host && !r.condition.requestDomains) {
        const k = JSON.stringify([r.action, r.priority, r.redirect || '', r.condition]);
        let b = buckets.get(k);
        if (!b) buckets.set(k, (b = { r, hosts: [] }));
        b.hosts.push(r.host);
      } else {
        const rule = makeRule(r);
        singles.set(JSON.stringify(rule), rule);
      }
    }
    const rules = [...singles.values()];
    for (const { r, hosts } of buckets.values()) {
      const list = pruneSubdomains(hosts);
      for (let i = 0; i < list.length; i += BUCKET_CHUNK) {
        rules.push(makeRule(r, list.slice(i, i + BUCKET_CHUNK)));
      }
    }
    let blockId = blockStart, allowId = ALLOW_ID_BASE + allowOffset;
    for (const rule of rules) {
      const allowType = rule.action.type === 'allow' || rule.action.type === 'allowAllRequests';
      rule.id = allowType ? allowId++ : blockId++;
    }
    return rules;
  }

  // Adapts rules to WebKit's DNR translator (see README "Safari notes").
  function adaptRuleForSafari(rule) {
    const c = rule.condition;
    if (c.regexFilter) return null; // WebKit's regex dialect rejects common RE2 syntax
    if (c.resourceTypes) {
      c.resourceTypes = c.resourceTypes.filter((t) => t !== 'object');
      if (!c.resourceTypes.length) return null;
    }
    if (c.excludedResourceTypes) {
      c.excludedResourceTypes = c.excludedResourceTypes.filter((t) => t !== 'object');
      if (!c.excludedResourceTypes.length) delete c.excludedResourceTypes;
    }
    if (rule.action.type === 'redirect') rule.action = { type: 'block' };
    return rule;
  }

  // Number of WebKit content-blocker rules a DNR rule turns into. WebKit
  // emits one rule per requestDomains entry, per excluded request domain,
  // and per request method, and merges all of an extension's enabled
  // rulesets into one content blocker capped at 150,000 rules.
  function safariRuleCost(rule) {
    const c = rule.condition;
    const methods = c.requestMethods && rule.action.type !== 'allowAllRequests' ? c.requestMethods.length : 1;
    let n = (c.requestDomains && !c.regexFilter ? c.requestDomains.length : 1) * methods;
    if (c.excludedRequestDomains) n += c.excludedRequestDomains.length;
    if (c.initiatorDomains && c.excludedInitiatorDomains) n += 1;
    return n;
  }

  // ------------------------------------------------------- cosmetic store

  function newCosmeticStore() {
    return {
      generic: new Map(),       // selector -> style|null
      genericUnhide: new Set(), // selectors excepted everywhere
      hide: new Map(),          // host -> Map(selector -> style|null)
      unhide: new Map(),        // host -> Set(selector): #@# exceptions, apply to all hiding
      negate: new Map(),        // host -> Set(selector): ~host in a site-specific rule
      ehide: new Set(), ghide: new Set(), shide: new Set(),
      scriptlets: new Map(),    // host -> Map(signature -> call)
      scriptletExcept: new Map(), // host -> Set(signature | '*')
      genericScriptletExcept: new Set(),
    };
  }

  function mapSet(map, key) {
    let v = map.get(key);
    if (!v) map.set(key, (v = new Set()));
    return v;
  }
  function mapMap(map, key) {
    let v = map.get(key);
    if (!v) map.set(key, (v = new Map()));
    return v;
  }

  function addCosmetic(store, p) {
    const { include, exclude } = p.domains;
    if (p.kind === 'hide') {
      if (p.exception) {
        if (!include.length) store.genericUnhide.add(p.selector);
        for (const h of include) mapSet(store.unhide, h).add(p.selector);
        return;
      }
      if (!include.length) {
        // "~a.com##.x" is generic hiding with an exception for a.com.
        store.generic.set(p.selector, p.style);
        for (const h of exclude) mapSet(store.unhide, h).add(p.selector);
      } else {
        for (const h of include) mapMap(store.hide, h).set(p.selector, p.style);
        for (const h of exclude) mapSet(store.negate, h).add(p.selector);
      }
      return;
    }
    if (p.kind === 'scriptlet') {
      const sig = p.call ? JSON.stringify(p.call) : '*';
      if (p.exception) {
        if (!include.length) store.genericScriptletExcept.add(sig);
        for (const h of include) mapSet(store.scriptletExcept, h).add(sig);
        return;
      }
      if (!p.call || !include.length) return; // generic scriptlets are not supported
      for (const h of include) mapMap(store.scriptlets, h).set(sig, p.call);
      for (const h of exclude) mapSet(store.scriptletExcept, h).add(sig);
    }
  }

  function addNetworkFlags(store, f) {
    if (!f.exception) return;
    const ehide = f.flags.ehide || f.document;
    for (const h of f.flagHosts || []) {
      if (ehide) store.ehide.add(h);
      if (f.flags.ghide) store.ghide.add(h);
      if (f.flags.shide) store.shide.add(h);
      if (f.document) mapSet(store.scriptletExcept, h).add('*');
    }
  }

  function cssRule(sel, style) {
    return `${sel}{${style || 'display:none!important'}}`;
  }

  // Serializes the store into the files the extension loads.
  function finalizeCosmetic(store) {
    const generic = [...store.generic].filter(([s]) => !store.genericUnhide.has(s));
    const genericSet = new Set(generic.map(([s]) => s));
    const genericSels = [], genericStyles = {};
    generic.forEach(([s, style], i) => { genericSels.push(s); if (style) genericStyles[i] = style; });
    const genericCss = generic.map(([s, style]) => cssRule(s, style)).join('\n') + '\n';

    const sels = [], styles = {}, index = new Map();
    const hide = {};
    for (const [host, m] of [...store.hide].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const ids = [];
      for (const [s, style] of m) {
        if (store.genericUnhide.has(s)) continue;
        if (genericSet.has(s) && !style) continue; // already hidden everywhere
        const k = s + '\u0000' + (style || '');
        let id = index.get(k);
        if (id === undefined) {
          id = sels.length; index.set(k, id); sels.push(s);
          if (style) styles[id] = style;
        }
        ids.push(id);
      }
      if (ids.length) hide[host] = ids;
    }
    const unhide = {}, negate = {};
    const genericExcluded = new Set([...store.ehide, ...store.ghide]);
    for (const [host, set] of store.unhide) {
      unhide[host] = [...set];
      for (const s of set) if (genericSet.has(s)) { genericExcluded.add(host); break; }
    }
    for (const [host, set] of store.negate) negate[host] = [...set];

    const scriptlets = {}, scriptletExcept = {};
    for (const [host, m] of store.scriptlets) {
      const calls = [...m].filter(([sig]) => !store.genericScriptletExcept.has(sig)).map(([, c]) => c);
      if (calls.length) scriptlets[host] = calls;
    }
    for (const [host, set] of store.scriptletExcept) scriptletExcept[host] = [...set];

    return {
      genericCss,
      generic: { sels: genericSels, styles: genericStyles },
      specific: {
        sels, styles, hide, unhide, negate,
        ehide: [...store.ehide].sort(), ghide: [...store.ghide].sort(), shide: [...store.shide].sort(),
        genericExcluded: [...genericExcluded].sort(),
      },
      scriptlets: { hosts: scriptlets, except: scriptletExcept },
    };
  }

  // ------------------------------------------------------- user filters

  // Compiles the "My filters" box. Returns dynamic rules (blocking ids from
  // idStart, allow ids from ALLOW_ID_BASE + idStart), cosmetic rules keyed by
  // host ('' = everywhere), exceptions, and the lines that could not be used.
  function compileUserFilters(text, idStart) {
    const dnr = [];
    const css = {};        // host -> [cssRule]
    const unhide = {};     // host -> [selector]
    const rejected = [];
    let lineNo = 0;
    for (const raw of text.split(/\r?\n/)) {
      lineNo++;
      const line = raw.trim();
      if (!line || line.startsWith('!')) continue;
      const p = parseLine(line, 'abp');
      if (!p) continue;
      if (p.kind === 'skip') { rejected.push({ line: lineNo, text: line, reason: p.reason }); continue; }
      if (p.kind === 'scriptlet') { rejected.push({ line: lineNo, text: line, reason: 'scriptlets are list-only' }); continue; }
      if (p.kind === 'hide') {
        const hosts = p.domains.include.length ? p.domains.include : [''];
        if (p.exception) { for (const h of hosts) (unhide[h] = unhide[h] || []).push(p.selector); }
        else for (const h of hosts) (css[h] = css[h] || []).push(cssRule(p.selector, p.style));
        continue;
      }
      if (p.badfilter) { rejected.push({ line: lineNo, text: line, reason: 'badfilter not supported here' }); continue; }
      const r = toDNR(p, true);
      if (!r) { rejected.push({ line: lineNo, text: line, reason: 'not expressible as a network rule' }); continue; }
      dnr.push(r);
    }
    const rules = assembleRules(dnr, idStart, idStart);
    return { rules, css, unhide, rejected };
  }

  return {
    PRIORITY, ALLOW_ID_BASE, SCRIPTLETS, REDIRECTS,
    normalizeHost, isIPv4, hostToMatchPattern, hostSuffixes, parseDomainList,
    isEntity, entityKeys, lookupKeys, matchPatternsFor,
    evalCondition, preprocess, parseLine, parseNetwork, parseCosmetic, processSelector,
    splitScriptletArgs, canonicalScriptlet, isSafeSelector, sanitizeStyle,
    toDNR, assembleRules, adaptRuleForSafari, safariRuleCost, pruneSubdomains, regexCost,
    newCosmeticStore, addCosmetic, addNetworkFlags, finalizeCosmetic, cssRule,
    compileUserFilters,
  };
});
