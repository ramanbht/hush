// Unit tests for the filter compiler. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const A = require('../src/shared/abp.js');

const dnr = (line) => {
  const p = A.parseLine(line, 'abp');
  return p && p.kind === 'network' ? A.toDNR(p) : p;
};

test('plain host filters bucket into requestDomains', () => {
  const lines = ['||ads.example.com^', '||tracker.net^', '||sub.tracker.net^', '||cdn.example.org^$third-party'];
  const rules = A.assembleRules(lines.map(dnr));
  assert.equal(rules.length, 2);
  const plain = rules.find((r) => !r.condition.domainType);
  assert.deepEqual(plain.condition.requestDomains, ['ads.example.com', 'tracker.net']); // sub.tracker.net pruned
  const third = rules.find((r) => r.condition.domainType === 'thirdParty');
  assert.deepEqual(third.condition.requestDomains, ['cdn.example.org']);
  assert.equal(plain.action.type, 'block');
  assert.equal(plain.priority, A.PRIORITY.block);
});

test('options map to DNR conditions', () => {
  const r = dnr('/banner/*/img^$image,script,domain=a.com|~b.a.com,~third-party');
  assert.equal(r.action, 'block');
  assert.equal(r.condition.urlFilter, '/banner/*/img^');
  assert.deepEqual(r.condition.resourceTypes, ['image', 'script']);
  assert.deepEqual(r.condition.initiatorDomains, ['a.com']);
  assert.deepEqual(r.condition.excludedInitiatorDomains, ['b.a.com']);
  assert.equal(r.condition.domainType, 'firstParty');
});

test('negated types exclude main_frame too', () => {
  const r = dnr('||x.com/ads/$~script,~image');
  assert.deepEqual(r.condition.excludedResourceTypes, ['image', 'main_frame', 'script']);
});

test('exceptions and priorities', () => {
  assert.equal(dnr('@@||cdn.example.com/ads.js$script').priority, A.PRIORITY.allow);
  assert.equal(dnr('||x.com^$important').priority, A.PRIORITY.importantBlock);
  const doc = dnr('@@||example.com^$document');
  assert.equal(doc.action, 'allowAllRequests');
  assert.deepEqual(doc.condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.ok(A.PRIORITY.allow > A.PRIORITY.block && A.PRIORITY.importantBlock > A.PRIORITY.allowAllRequests);
});

test('redirects to bundled surrogates, complex surrogates become blocks', () => {
  const r = dnr('||googletagservices.com/tag/js/gpt.js$script,redirect=googletagservices_gpt.js');
  assert.equal(r.action, 'redirect');
  assert.equal(r.redirect, '/web_accessible_resources/noop.js');
  assert.equal(dnr('||imasdk.googleapis.com/js/sdkloader/ima3.js$script,redirect=google-ima.js').action, 'block');
  assert.equal(dnr('||x.com/a.js$script,redirect=noopjs:10').redirect, '/web_accessible_resources/noop.js');
});

test('unsupported and unsafe filters are skipped, never broadened', () => {
  assert.equal(dnr('||x.com^$popup').kind, 'skip');
  assert.equal(dnr('||x.com^$csp=script-src none').kind, 'skip');
  assert.equal(dnr('||x.com^$domain=example.*').kind, 'skip');
  assert.equal(dnr('||x.com^$weirdoption').kind, 'skip');
  assert.equal(dnr('/(?=ad)/').kind, 'skip'); // lookahead is not RE2
  assert.equal(dnr('$script,third-party'), null); // would block every third-party script
  assert.equal(dnr('||x.com/a|b').kind, 'skip'); // "|" mid-pattern has no DNR meaning
});

test('regex filters keep their options', () => {
  const r = dnr('/^https?:\\/\\/[a-z]{8}\\.com\\//$script,third-party');
  assert.equal(r.condition.regexFilter, '^https?:\\/\\/[a-z]{8}\\.com\\/');
  assert.deepEqual(r.condition.resourceTypes, ['script']);
  const p = A.parseLine('/banner.$image', 'abp'); // starts with "/" but is not a regex
  assert.equal(A.toDNR(p).condition.urlFilter, '/banner.');
  assert.deepEqual(A.toDNR(p).condition.resourceTypes, ['image']);
});

test('cosmetic-only exceptions produce flags, not network rules', () => {
  const p = A.parseLine('@@||example.com^$generichide', 'abp');
  assert.equal(A.toDNR(p), null);
  const store = A.newCosmeticStore();
  A.addNetworkFlags(store, p);
  assert.ok(store.ghide.has('example.com'));
});

test('hosts-file format', () => {
  const r = A.toDNR(A.parseLine('127.0.0.1 ads.example.net', 'hosts'));
  assert.equal(r.host, 'ads.example.net');
  assert.equal(A.parseLine('127.0.0.1 localhost', 'hosts').kind, 'skip');
});

test('preprocessor directives', () => {
  const text = ['a', '!#if env_chromium', 'b', '!#else', 'c', '!#endif', '!#if !ext_ubol', 'd', '!#endif',
    '!#if (env_safari || env_chromium) && !cap_html_filtering', 'e', '!#endif'].join('\n');
  assert.deepEqual(A.preprocess(text, { env_chromium: true, ext_ubol: true }), ['a', 'b', 'e']);
  assert.deepEqual(A.preprocess(text, { env_safari: true, ext_ubol: true }), ['a', 'c', 'e']);
});

test('element hiding: generic, specific, exceptions, styles', () => {
  const store = A.newCosmeticStore();
  for (const line of [
    '##.ad-banner', '###sidebar-ad', 'example.com##.promo', 'example.com,~shop.example.com##.deal',
    'news.com#@#.ad-banner', '#@##sidebar-ad', 'foo.com##.x:style(color: red)',
    'bar.com##.y:has-text(Sponsored)', 'baz.com#?#.z:-abp-has(.sponsor)', 'bad.com##a{}',
  ]) {
    const p = A.parseLine(line, 'abp');
    if (p && p.kind !== 'skip') A.addCosmetic(store, p);
  }
  const out = A.finalizeCosmetic(store);
  assert.deepEqual(out.generic.sels, ['.ad-banner']); // #sidebar-ad excepted everywhere
  assert.ok(out.genericCss.includes('.ad-banner{display:none!important}'));
  const sel = (i) => out.specific.sels[i];
  assert.deepEqual(out.specific.hide['example.com'].map(sel), ['.promo', '.deal']);
  assert.deepEqual(out.specific.negate['shop.example.com'], ['.deal']);
  assert.deepEqual(out.specific.unhide['news.com'], ['.ad-banner']);
  assert.ok(out.specific.genericExcluded.includes('news.com'));
  assert.equal(out.specific.styles[out.specific.hide['foo.com'][0]], 'color: red !important');
  assert.deepEqual(out.specific.hide['baz.com'].map(sel), ['.z:has(.sponsor)']);
  assert.equal(out.specific.hide['bar.com'], undefined); // procedural, skipped
  assert.equal(out.specific.hide['bad.com'], undefined); // unsafe selector, skipped
});

test('scriptlet parsing and exceptions', () => {
  const p = A.parseLine("example.com##+js(trusted-rpfr, '\"adPlacements\"', '\"no_ads\"', player?)", 'abp');
  assert.deepEqual(p.call, ['trusted-replace-fetch-response', '"adPlacements"', '"no_ads"', 'player?']);
  const q = A.parseLine('www.x.com##+js(json-prune-fetch-response, a b, , propsToMatch, /player?/)', 'abp');
  assert.deepEqual(q.call, ['json-prune-fetch-response', 'a b', '', 'propsToMatch', '/player?/']);
  assert.deepEqual(A.parseLine('x.com##+js(aopr, foo\\, bar)', 'abp').call, ['abort-on-property-read', 'foo, bar']);
  assert.equal(A.parseLine('x.com##+js(some-unknown-thing)', 'abp').kind, 'skip');

  const store = A.newCosmeticStore();
  for (const line of ['a.com,b.com##+js(set, ads, false)', 'b.com#@#+js(set, ads, false)', 'c.com#@#+js()']) {
    A.addCosmetic(store, A.parseLine(line, 'abp'));
  }
  const out = A.finalizeCosmetic(store).scriptlets;
  assert.deepEqual(out.hosts['a.com'], [['set-constant', 'ads', 'false']]);
  assert.deepEqual(out.except['b.com'], [JSON.stringify(['set-constant', 'ads', 'false'])]);
  assert.deepEqual(out.except['c.com'], ['*']);
});

test('Safari adaptation and cost model', () => {
  const rules = A.assembleRules(['||a.com^', '||b.com^', '/x/$object,image', '/re[0-9]/'].map(dnr));
  const safari = rules.map((r) => A.adaptRuleForSafari(structuredClone(r))).filter(Boolean);
  assert.equal(safari.some((r) => r.condition.regexFilter), false);
  assert.ok(safari.every((r) => !(r.condition.resourceTypes || []).includes('object')));
  const bucket = safari.find((r) => r.condition.requestDomains);
  assert.equal(A.safariRuleCost(bucket), 2);
});

test('user filters compile to dynamic rules with user priorities', () => {
  const out = A.compileUserFilters('||annoying.com^\n@@||ok.com^\nexample.com##.banner\n##.everywhere\nx.com##+js(set, a, 1)\n', 1000);
  const block = out.rules.find((r) => r.action.type === 'block');
  const allow = out.rules.find((r) => r.action.type === 'allow');
  assert.equal(block.id, 1000);
  assert.equal(allow.id, A.ALLOW_ID_BASE + 1000);
  assert.equal(block.priority, A.PRIORITY.userBlock);
  assert.deepEqual(out.css['example.com'], ['.banner{display:none!important}']);
  assert.deepEqual(out.css[''], ['.everywhere{display:none!important}']);
  assert.equal(out.rejected.length, 1);
});

test('selector safety', () => {
  assert.ok(A.isSafeSelector('a[href*="/ads/"]'));
  assert.ok(A.isSafeSelector('div:not(.a, .b) > span'));
  assert.ok(!A.isSafeSelector('a[href="x'));
  assert.ok(!A.isSafeSelector('a } body { color: red'));
  assert.ok(!A.isSafeSelector('a /* x */'));
  assert.equal(A.sanitizeStyle('background: url(http://x)'), null);
});
