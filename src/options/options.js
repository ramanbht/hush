'use strict';
const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function send(msg) {
  const res = await api.runtime.sendMessage(msg);
  if (res && res.error) throw new Error(res.error);
  return res;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

function switchButton(checked, label, onChange) {
  const b = el('button', { class: 'switch', role: 'switch', 'aria-checked': String(checked), 'aria-label': label });
  b.addEventListener('click', async () => {
    const next = b.getAttribute('aria-checked') !== 'true';
    b.disabled = true;
    try {
      await onChange(next);
      b.setAttribute('aria-checked', String(next));
    } catch (e) {
      const row = b.closest('.row');
      row.querySelector('.error')?.remove();
      row.firstElementChild.append(el('div', { class: 'error' }, e.message));
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

let S;

function renderLists() {
  const ul = $('lists');
  ul.replaceChildren(...S.rulesets.map((r) => el('li', { class: 'row' },
    el('div', {}, el('div', { class: 'row-title' }, r.name), el('div', { class: 'muted' }, r.about)),
    el('div', { class: 'row-end' },
      el('span', { class: 'count muted' }, `${r.filterCount.toLocaleString()} filters`),
      switchButton(r.enabled, r.name, async (on) => {
        await send({ type: 'setRuleset', id: r.id, enabled: on });
        r.enabled = on;
        renderBudget();
      })))));
  renderBudget();
}

function renderBudget() {
  if (S.target !== 'safari') { $('budget').textContent = ''; return; }
  const used = S.rulesets.filter((r) => r.enabled).reduce((n, r) => n + r.safariCost, 0);
  $('budget').textContent = `Safari compiles enabled lists into one blocker of at most 150,000 rules. Using ${used.toLocaleString()}.`;
}

function renderPaused() {
  const ul = $('paused');
  if (!S.paused.length) {
    ul.replaceChildren(el('li', { class: 'row empty' }, 'No paused sites. Use the toolbar button on a site to pause Hush there.'));
    return;
  }
  ul.replaceChildren(...S.paused.map((site) => el('li', { class: 'row' },
    el('div', { class: 'row-title' }, site),
    el('button', {
      class: 'button',
      onclick: async () => {
        await send({ type: 'setPaused', host: site, paused: false });
        S.paused = S.paused.filter((p) => p !== site);
        renderPaused();
      },
    }, 'Resume blocking'))));
}

function renderSources() {
  $('sources').replaceChildren(...S.rulesets.map((r) => el('li', {},
    el('a', { href: r.homepage, target: '_blank', rel: 'noopener' }, r.name), ` (${r.license})`)));
}

async function saveFilters() {
  const status = $('save-status');
  status.textContent = 'Saving…';
  $('rejected').replaceChildren();
  try {
    const r = await send({ type: 'saveUserFilters', text: $('filters').value });
    const parts = [`${r.networkRules} network ${r.networkRules === 1 ? 'rule' : 'rules'}`,
      `${r.cosmeticRules} hiding ${r.cosmeticRules === 1 ? 'rule' : 'rules'}`];
    status.textContent = `Saved: ${parts.join(', ')}.` + (r.rejected.length ? ` ${r.rejected.length} line(s) not used:` : '');
    $('rejected').replaceChildren(...r.rejected.map((x) => el('li', {},
      x.line ? `Line ${x.line}: ` : '', el('code', {}, x.text), ` (${x.reason})`)));
  } catch (e) {
    status.textContent = 'Not saved: ' + e.message;
  }
}

(async () => {
  S = await send({ type: 'optionsState' });
  const built = new Date(S.builtAt);
  $('built').textContent = `${S.target === 'safari' ? 'Safari' : 'Chrome'} build. Lists compiled ${built.toLocaleDateString(undefined, { dateStyle: 'medium' })}; rebuild to refresh them.`;
  renderLists();
  for (const b of document.querySelectorAll('[data-setting]')) {
    const key = b.dataset.setting;
    const label = $(b.getAttribute('aria-labelledby')).textContent;
    b.replaceWith(switchButton(!!S.settings[key], label, (on) => send({ type: 'setSetting', key, value: on })));
  }
  renderPaused();
  renderSources();
  $('filters').value = S.userFilters || '';
  $('save').addEventListener('click', saveFilters);
})().catch((e) => {
  $('built').textContent = 'Could not load settings: ' + e.message;
});
