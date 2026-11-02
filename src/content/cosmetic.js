/*
 * Runs at document_start in every frame (isolated world). Asks the
 * background for this site's hiding rules; the background injects them as a
 * user-origin stylesheet. If that fails, it sends the CSS back and we add it
 * as a <style> element instead.
 */
(() => {
  'use strict';
  if (window.__hushCosmetic) return;
  window.__hushCosmetic = true;
  const host = location.hostname;
  if (!host) return;
  const api = globalThis.browser || globalThis.chrome;

  function injectStyle(css) {
    const style = document.createElement('style');
    style.textContent = css;
    const attach = () => {
      if (!style.isConnected) (document.head || document.documentElement).appendChild(style);
    };
    attach();
    // Some pages wipe <head>; put the sheet back if it disappears.
    new MutationObserver(attach).observe(document.documentElement, { childList: true });
    document.addEventListener('DOMContentLoaded', () => {
      attach();
      if (document.head) new MutationObserver(attach).observe(document.head, { childList: true });
    }, { once: true });
  }

  api.runtime.sendMessage({ type: 'cosmetic', host }).then((res) => {
    if (res && res.css) injectStyle(res.css);
  }, () => { /* extension reloaded or page unloading */ });
})();
