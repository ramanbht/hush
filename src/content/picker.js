/*
 * Element picker. Injected on demand from the popup. Hover to highlight,
 * Up/Down arrows to widen or narrow, click to hide, Esc to cancel.
 * The chosen rule is saved to "My filters" as `site##selector`.
 */
(() => {
  'use strict';
  if (window.__hushPicker) return;
  window.__hushPicker = true;
  const api = globalThis.browser || globalThis.chrome;

  const host = document.createElement('hush-picker');
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .box { position: fixed; pointer-events: none; z-index: 2147483646; box-sizing: border-box;
             border: 2px solid #c2410c; background: rgba(194, 65, 12, .12); border-radius: 3px;
             transition: all .06s ease-out; display: none; }
      .bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2147483647;
             font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #eef2f1;
             background: #1f2b2a; border-radius: 10px; padding: 10px 14px; max-width: min(640px, 90vw);
             box-shadow: 0 6px 24px rgba(0,0,0,.35); display: flex; gap: 12px; align-items: center; }
      .sel { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: #f4b393;
             overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 360px; }
      button { font: inherit; color: #1f2b2a; background: #eef2f1; border: 0; border-radius: 6px;
               padding: 4px 10px; cursor: pointer; }
      .muted { color: #9db0ad; }
    </style>
    <div class="box"></div>
    <div class="bar"><span class="msg">Click an element to hide it.</span>
      <span class="sel"></span><span class="muted">Up/Down to adjust, Esc to cancel</span></div>`;
  const box = shadow.querySelector('.box');
  const bar = shadow.querySelector('.bar');
  const msg = shadow.querySelector('.msg');
  const selLabel = shadow.querySelector('.sel');
  document.documentElement.appendChild(host);

  let target = null;
  const trail = []; // for ArrowDown after ArrowUp

  const looksGenerated = (t) => t.length > 40 || /\d{3,}/.test(t) || /^(css|sc|jsx|emotion)-[a-z0-9]+$/i.test(t);
  const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (e) { return false; } };

  function selectorFor(el) {
    if (el.id && !looksGenerated(el.id) && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node !== el && node.id && !looksGenerated(node.id)) { parts.unshift('#' + CSS.escape(node.id)); break; }
      let part = node.localName;
      const classes = [...node.classList].filter((c) => !looksGenerated(c)).slice(0, 2);
      if (classes.length) part += classes.map((c) => '.' + CSS.escape(c)).join('');
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter((c) => c.localName === node.localName);
        if (same.length > 1 && [...parent.children].filter((c) => c.matches(part)).length > 1) {
          part += `:nth-of-type(${same.indexOf(node) + 1})`;
        }
      }
      parts.unshift(part);
      const sel = parts.join(' > ');
      if (unique(sel)) return sel;
    }
    return parts.join(' > ');
  }

  function highlight(el) {
    target = el;
    if (!el) { box.style.display = 'none'; selLabel.textContent = ''; return; }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: 'block', left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    selLabel.textContent = selectorFor(el);
  }

  function onMove(e) {
    const el = e.composedPath ? e.composedPath()[0] : e.target;
    if (!(el instanceof Element) || el === host || host.contains(el)) return;
    trail.length = 0;
    highlight(el);
  }

  function stop(e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }

  function teardown() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) document.removeEventListener(t, stop, true);
    host.remove();
    window.__hushPicker = false;
  }

  async function onClick(e) {
    stop(e);
    if (!target) return;
    const selector = selectorFor(target);
    const hidden = [...document.querySelectorAll(selector)];
    for (const el of hidden) el.style.setProperty('display', 'none', 'important');
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) document.removeEventListener(t, stop, true);
    box.style.display = 'none';
    let saved = null;
    try {
      saved = await api.runtime.sendMessage({ type: 'pickerSave', host: location.hostname, selector });
      if (saved && saved.error) throw new Error(saved.error);
    } catch (err) {
      msg.textContent = 'Could not save: ' + err.message;
      setTimeout(teardown, 4000);
      return;
    }
    msg.textContent = 'Hidden. Saved to My filters.';
    selLabel.textContent = selector;
    const undo = document.createElement('button');
    undo.textContent = 'Undo';
    bar.lastElementChild.replaceWith(undo);
    undo.addEventListener('click', async (ev) => {
      stop(ev);
      for (const el of hidden) el.style.removeProperty('display');
      await api.runtime.sendMessage({ type: 'pickerUndo', line: saved.line, css: saved.css });
      teardown();
    }, true);
    setTimeout(teardown, 6000);
  }

  function onKey(e) {
    if (e.key === 'Escape') { stop(e); teardown(); return; }
    if (!target) return;
    if (e.key === 'ArrowUp' && target.parentElement && target.parentElement !== document.documentElement) {
      stop(e); trail.push(target); highlight(target.parentElement);
    } else if (e.key === 'ArrowDown' && trail.length) {
      stop(e); highlight(trail.pop());
    }
  }

  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  for (const t of ['mousedown', 'mouseup', 'pointerdown', 'pointerup']) document.addEventListener(t, stop, true);
})();
