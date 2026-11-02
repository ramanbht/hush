'use strict';
const api = globalThis.browser || globalThis.chrome;
const $ = (id) => document.getElementById(id);

async function send(msg) {
  const res = await api.runtime.sendMessage(msg);
  if (res && res.error) throw new Error(res.error);
  return res;
}

// Requests blocked in this tab. Rule ids below ALLOW_ID_BASE are blocking
// rules (see shared/abp.js); allow rules also show up in matched rules.
async function blockedCount(tabId) {
  try {
    const { rulesMatchedInfo } = await api.declarativeNetRequest.getMatchedRules({ tabId });
    return rulesMatchedInfo.filter((m) => !m.rule || m.rule.ruleId < HushABP.ALLOW_ID_BASE).length;
  } catch (e) {
    try {
      const text = await api.action.getBadgeText({ tabId });
      return text ? parseInt(text, 10) || null : 0;
    } catch (e2) {
      return null;
    }
  }
}

function render(st, count) {
  const app = $('app');
  if (!st.host) {
    app.dataset.state = 'unsupported';
    $('site').textContent = 'Nothing to block here';
    $('status').textContent = 'Hush works on websites. This is a browser or extension page.';
    return;
  }
  app.dataset.state = st.paused ? 'paused' : 'active';
  $('site').textContent = st.site;
  $('mute').setAttribute('aria-checked', String(!st.paused));
  $('mute-label').textContent = st.paused ? 'Paused on this site' : 'Blocking on this site';
  if (st.paused) {
    $('status').textContent = 'Ads and trackers load normally here.';
  } else if (count === null) {
    $('status').textContent = 'Blocking ads and trackers.';
  } else {
    $('status').textContent = count === 1 ? '1 request blocked on this page' : `${count.toLocaleString()} requests blocked on this page`;
  }
}

(async () => {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  let st = await send({ type: 'siteState', url: tab.url || '' });
  render(st, st.host ? await blockedCount(tab.id) : null);

  $('mute').addEventListener('click', async () => {
    const pause = !st.paused;
    $('mute').disabled = true;
    try {
      await send({ type: 'setPaused', host: st.host, paused: pause });
      st = Object.assign({}, st, { paused: pause });
      render(st, null);
      $('status').textContent = pause ? 'Paused. Reloading the page.' : 'Blocking again. Reloading the page.';
      await api.tabs.reload(tab.id);
    } catch (e) {
      $('status').textContent = 'Could not change this: ' + e.message;
    } finally {
      $('mute').disabled = false;
    }
  });

  $('pick').addEventListener('click', async () => {
    try {
      await api.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/picker.js'] });
      window.close();
    } catch (e) {
      $('status').textContent = 'The picker cannot run on this page.';
    }
  });

  $('settings').addEventListener('click', (e) => {
    e.preventDefault();
    api.runtime.openOptionsPage();
    window.close();
  });
})().catch((e) => {
  $('status').textContent = 'Something went wrong: ' + e.message;
});
