// Browser Cowork — side panel.
//
// Three jobs, in order of authority:
//   1. Hold the tab connection. It is explicit and survives tab switching,
//      so an instruction can never land on whatever happens to be focused.
//   2. Drive the loop: ask the backend for one action, execute it here, report
//      the result back. The backend never touches the browser.
//   3. Refuse. Guards and confirmations live on this side of the wire.

import { observation as buildObservation } from './lib/observe.js';

const SETTLE_MS = 220;

const DEFAULTS = {
  backendUrl: 'http://127.0.0.1:8787',
  token: '',
  blockedHosts: [],
  requireApproval: true,
};

// Consequential but reversible-enough to allow with a confirmation. Anything
// that moves money irreversibly is refused in background.js, not asked about.
const CONSEQUENTIAL =
  /\b(send|submit|publish|post|delete|remove|purchase|buy|order|checkout|pay|confirm|accept|agree|allow|install|subscribe|unsubscribe|log ?out|sign ?out|cancel|book|reserve|invite|share|save|create)\b/i;

const state = {
  settings: { ...DEFAULTS },
  tab: null,
  // The last observation sent to the model, so the next one can be a diff
  // against it. Null means "no baseline": send the full page.
  obs: null,
  // Version of the newest snapshot. Sent with every ref-bearing action so the
  // page agent can reject a ref from before the latest re-read.
  obsVersion: null,
  obsMode: 'full',
  obsReason: 'not observed yet',
  running: false,
  stop: false,
  ctrl: null,
  conversationId: null,
  pendingShot: null,
};

/* ------------------------------------------------------------------ dom */

const $ = (id) => document.getElementById(id);
const feed = $('feed');
const input = $('input');
const sendBtn = $('send');
const emptyEl = $('empty');
const settingsEl = $('settings');

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/* ------------------------------------------------------------ rendering */

function renderMarkdown(text) {
  const blocks = [];
  let src = escapeHtml(text).replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _l, code) => {
    blocks.push(`<pre><code>${code.replace(/\n$/, '')}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });

  src = src
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noreferrer">$2</a>')
    .replace(/^[-*] (.+)$/gm, '<li>$1</li>');

  const out = [];
  for (const chunk of src.split(/\n{2,}/)) {
    if (/^\u0000\d+\u0000$/.test(chunk.trim())) out.push(chunk.trim());
    else if (/^<li>/.test(chunk.trim())) out.push(`<ul>${chunk}</ul>`);
    else if (chunk.trim()) out.push(`<p>${chunk.replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)]);
}

const scrollDown = () => {
  feed.scrollTop = feed.scrollHeight;
};

const hideEmpty = () => {
  if (emptyEl && emptyEl.isConnected) emptyEl.remove();
};

function addMsg(role, text) {
  hideEmpty();
  const el = document.createElement('div');
  el.className = `msg ${role}`;
  el.innerHTML = `<div class="who">${escapeHtml(role)}</div><div class="body">${renderMarkdown(text)}</div>`;
  feed.appendChild(el);
  scrollDown();
  return el;
}

function addShot(dataUrl) {
  hideEmpty();
  const el = document.createElement('img');
  el.className = 'shot';
  el.src = dataUrl;
  el.alt = 'Screenshot of the connected tab';
  feed.appendChild(el);
  scrollDown();
}

function addToolCard(name, args) {
  hideEmpty();
  const el = document.createElement('div');
  el.className = 'tool';
  const argText = Object.entries(args || {})
    .filter(([k]) => k !== 'observationVersion')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  el.innerHTML =
    `<span class="name">${escapeHtml(name)}</span>` +
    `<span class="args">${escapeHtml(argText.slice(0, 80))}</span>` +
    `<span class="res"><span class="spin"></span></span>`;
  feed.appendChild(el);
  scrollDown();
  return {
    done(summary) {
      el.classList.add('ok');
      el.querySelector('.res').textContent = summary || 'ok';
      scrollDown();
    },
    fail(error) {
      el.classList.add('bad');
      el.querySelector('.res').textContent = error;
      scrollDown();
    },
  };
}

function askApproval(reason, call) {
  hideEmpty();
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'approval';
    el.innerHTML = `
      <div class="a-title">Approval needed</div>
      <div class="a-body">${escapeHtml(call)}<br><br>${escapeHtml(reason)}</div>
      <div class="a-actions">
        <button class="ok">Do it</button>
        <button class="no">Skip</button>
      </div>`;
    el.querySelector('.ok').onclick = () => {
      el.remove();
      resolve(true);
    };
    el.querySelector('.no').onclick = () => {
      el.remove();
      resolve(false);
    };
    feed.appendChild(el);
    scrollDown();
  });
}

/* ------------------------------------------------------- extension bridge */

function rpc(tool, args = {}) {
  return new Promise((resolve, reject) => {
    if (!state.tab) return reject(new Error('No tab connected'));
    chrome.runtime.sendMessage({ type: 'bp:exec', tool, args, tabId: state.tab.id }, (res) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!res) return reject(new Error('The extension worker did not respond. Reload the extension.'));
      if (!res.ok) return reject(new Error(res.error || 'Action failed'));
      resolve(res.result);
    });
  });
}

/* --------------------------------------------------------------- backend */

function api(path, { method = 'GET', body, signal } = {}) {
  const root = state.settings.backendUrl.replace(/\/+$/, '');
  const headers = { 'x-copilot-token': state.settings.token };
  if (body) headers['content-type'] = 'application/json';

  return fetch(`${root}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Backend returned ${res.status}`);
    return data;
  });
}

/* ----------------------------------------------------------- observation */

// One snapshot in, one block of text out. `lib/observe.js` decides whether that
// text is the whole page or only what changed since the last step; this
// function's only job is to keep the baseline and hand the text onward.
async function observe(full = true) {
  const out = await rpc('inspect_page', { full });
  const result = buildObservation(out.snapshot, state.obs);

  state.obs = result.state;
  state.obsVersion = out.snapshot.version;
  state.obsMode = result.mode;
  state.obsReason = result.reason;
  return result.text;
}

// Drop the baseline. The next observation will be the full page, which is what
// a new task needs: the conversation that receives it has never seen these refs.
function forgetObservation() {
  state.obs = null;
  state.obsVersion = null;
}

/* -------------------------------------------------------------- execution */

async function riskOf(name, args) {
  if (name === 'navigate' && CONSEQUENTIAL.test(String(args.url || ''))) {
    return `Navigate to ${args.url}`;
  }
  if (name === 'type_text' && args.submit) return 'Type and press Enter, which may submit the form.';

  // Blind pointer actions — click_at, or a drag with no ref at either end — do
  // not prompt. There is no element to label there, so every prompt would say
  // the same unhelpful thing ("I cannot see what is under this point"), and a
  // prompt that never says anything new is one the user learns to dismiss
  // unread. The setting itself remains the global switch for everything.
  const ref = name === 'drag' ? args.from_ref : name === 'click_element' ? args.ref : null;
  if (!ref) return null;

  try {
    const probe = await rpc('probe', { ref });
    const info = probe?.info;
    if (!info) return null;
    const target = `${info.role} "${info.name}"${info.href ? ` → ${info.href}` : ''}`;
    if (CONSEQUENTIAL.test(info.name) || CONSEQUENTIAL.test(info.href || '')) {
      return `${name === 'drag' ? 'Dragging this looks consequential' : 'This looks consequential'}: ${target}`;
    }
  } catch {
    /* probe is best-effort */
  }
  return null;
}

async function executeAction(action) {
  const { name, args = {} } = action;

  if (state.settings.requireApproval) {
    const reason = await riskOf(name, args);
    if (reason) {
      const call = `${name}(${Object.entries(args)
        .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
        .join(', ')})`;
      const approved = await askApproval(reason, call);
      if (!approved) {
        addToolCard(name, args).fail('declined');
        return { ok: false, error: 'The user declined this action. Do not retry it.' };
      }
    }
  }

  const card = addToolCard(name, args);
  const call = { ...args };
  // Refs can arrive under three names: click/type/hover use `ref`, drag uses
  // from_ref/to_ref. All of them are checked against the latest observation.
  if (call.ref || call.from_ref || call.to_ref) call.observationVersion = state.obsVersion;

  try {
    const out = await rpc(name, call);

    if (name === 'capture_screenshot' && out.dataUrl) {
      addShot(out.dataUrl);
      const [meta, base64] = String(out.dataUrl).split(',');
      state.pendingShot = {
        mime: /data:([^;]+)/.exec(meta)?.[1] || 'image/jpeg',
        data: base64,
      };
      card.done('captured');
      const vp = out.viewport;
      return {
        ok: true,
        note: vp
          ? `Screenshot attached as an image in the next observation. The image is ${vp.dpr}x the ${vp.w}x${vp.h} CSS viewport; pass image pixels to click_at with from_image=true.`
          : 'Screenshot attached as an image in the next observation.',
      };
    }

    card.done(out.via ? `ok (${out.via})` : out.selected ? `ok "${out.selected}"` : 'ok');
    return out;
  } catch (err) {
    card.fail(err.message);
    return { ok: false, error: err.message };
  }
}

/* ------------------------------------------------------------------- loop */

function stopRequested() {
  return state.stop;
}

async function runTask(message) {
  if (!state.tab) {
    addMsg('error', 'Connect a tab first.');
    return;
  }

  state.running = true;
  state.stop = false;
  state.ctrl = new AbortController();
  const signal = state.ctrl.signal;
  updateBusy();

  try {
    addMsg('user', message);

    // A new task starts a new conversation, which has never seen a ref from the
    // previous one. A diff here would describe changes to a baseline the model
    // does not have, so the first observation is always the full page.
    forgetObservation();

    const observation = await observe(true);
    let reply = await api('/api/turn', {
      method: 'POST',
      body: { message, observation },
      signal,
    });
    state.conversationId = reply.conversationId;

    for (;;) {
      if (stopRequested()) break;

      if (reply.text) addMsg('assistant', reply.text);
      if (reply.notice) addMsg('note', reply.notice);
      if (reply.rejected) addMsg('note', `Rejected that action: ${reply.rejected}`);
      if (reply.done) break;

      if (reply.retry) {
        reply = await api('/api/step', {
          method: 'POST',
          body: { conversationId: state.conversationId, observation: await observe(false) },
          signal,
        });
        continue;
      }

      if (!reply.action) break;

      const result = await executeAction(reply.action);
      if (stopRequested()) break;

      await new Promise((r) => setTimeout(r, SETTLE_MS));

      let observation;
      try {
        observation = await observe(false);
      } catch (err) {
        // The agent is about to be told the page state is unknown, so the
        // baseline no longer describes anything: force a full read next step.
        forgetObservation();
        observation = `[The page could not be read after the action: ${err.message}]`;
      }

      const shot = state.pendingShot;
      state.pendingShot = null;

      reply = await api('/api/step', {
        method: 'POST',
        body: {
          conversationId: state.conversationId,
          actionResult: result,
          observation,
          ...(shot ? { image: shot } : {}),
        },
        signal,
      });
    }

    if (stopRequested()) addMsg('note', 'Stopped. Nothing further will run.');
  } catch (err) {
    if (err.name === 'AbortError') {
      addMsg('note', 'Stopped.');
    } else {
      addMsg('error', err.message || String(err));
    }
  } finally {
    state.running = false;
    state.ctrl = null;
    updateBusy();
  }
}

/* ------------------------------------------------------------- connection */

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

function renderConnection() {
  const connected = Boolean(state.tab);
  $('btnConnect').classList.toggle('hidden', connected);
  $('btnDisconnect').classList.toggle('hidden', !connected);
  $('dot').classList.toggle('live', connected && !state.running);

  if (connected) {
    $('tabTitle').textContent = state.tab.title || 'Untitled';
    $('tabUrl').textContent = state.tab.url || '';
    $('connNote').textContent = 'Stays connected while you switch tabs.';
  } else {
    $('tabTitle').textContent = 'Not connected';
    $('tabUrl').textContent = 'No tab connected';
    $('connNote').textContent = '';
  }
}

async function attachTab(tab) {
  if (!tab || tab.id == null) return false;
  if (!/^https?:/i.test(tab.url || '')) return false;

  state.tab = { id: tab.id, title: tab.title, url: tab.url };
  forgetObservation();
  renderConnection();

  // Warm the page agent so the first observation is not delayed by injection.
  await observe(true).catch(() => {});
  renderConnection();
  return true;
}

async function connectTab() {
  const tab = await activeTab();
  if (!tab || tab.id == null) return;

  if (!/^https?:/i.test(tab.url || '')) {
    addMsg('error', 'That tab cannot be operated. Open a normal http(s) website first.');
    return;
  }

  await attachTab(tab);
}

async function disconnectTab() {
  if (state.running) {
    state.stop = true;
    state.ctrl?.abort();
  }
  if (state.conversationId) {
    api(`/api/conversation/${state.conversationId}`, { method: 'DELETE' }).catch(() => {});
    state.conversationId = null;
  }
  if (state.tab) rpc('detach', {}).catch(() => {});
  state.tab = null;
  forgetObservation();
  renderConnection();
}

function updateBusy() {
  sendBtn.disabled = state.running;
  $('btnStop').disabled = !state.running;
  renderConnection();
}

/* ------------------------------------------------------------------- wire */

async function saveSettings() {
  const hosts = $('blockedHosts')
    .value.split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);

  state.settings = {
    backendUrl: $('backendUrl').value.trim() || DEFAULTS.backendUrl,
    token: $('token').value.trim(),
    blockedHosts: hosts,
    requireApproval: $('requireApproval').checked,
  };

  await chrome.storage.local.set({ settings: state.settings, blockedHosts: hosts });
}

function applySettingsToForm() {
  const s = state.settings;
  $('backendUrl').value = s.backendUrl;
  $('token').value = s.token;
  $('blockedHosts').value = (s.blockedHosts || []).join('\n');
  $('requireApproval').checked = s.requireApproval;
}

async function testConnection() {
  const line = $('statusLine');
  line.textContent = 'Checking…';
  try {
    const health = await api('/api/health');
    const keyNote = health.hasKey ? '' : ' — no API key on the server, add one to server/.env';
    line.textContent = `Connected. ${health.provider} / ${health.model}${keyNote}.`;
    return health.hasKey;
  } catch (err) {
    line.textContent = `Failed: ${err.message}`;
    return false;
  }
}

function submit() {
  const text = input.value.trim();
  if (!text || state.running) return;

  input.value = '';
  input.style.height = 'auto';

  if (!state.settings.token) {
    settingsEl.classList.remove('hidden');
    addMsg('error', 'Add the pairing token first — it is printed when the server starts.');
    return;
  }

  runTask(text);
}

async function init() {
  const stored = await chrome.storage.local.get(['settings']);
  state.settings = { ...DEFAULTS, ...(stored.settings || {}) };
  applySettingsToForm();
  renderConnection();
  updateBusy();

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });

  sendBtn.addEventListener('click', submit);

  $('btnConnect').addEventListener('click', () => {
    connectTab().catch((err) => addMsg('error', err.message));
  });

  $('btnDisconnect').addEventListener('click', () => {
    disconnectTab().catch(() => {});
  });

  $('btnStop').addEventListener('click', () => {
    state.stop = true;
    state.ctrl?.abort();
    if (state.conversationId) {
      api(`/api/conversation/${state.conversationId}`, { method: 'DELETE' }).catch(() => {});
    }
  });

  $('btnSettings').addEventListener('click', () => settingsEl.classList.toggle('hidden'));

  for (const id of ['backendUrl', 'token', 'blockedHosts']) {
    $(id).addEventListener('change', saveSettings);
  }
  $('requireApproval').addEventListener('change', saveSettings);
  $('btnTest').addEventListener('click', testConnection);

  for (const chip of document.querySelectorAll('.chip')) {
    chip.addEventListener('click', () => {
      input.value = chip.dataset.prompt || '';
      submit();
    });
  }

  // Deliberately not following the active tab: the connection must not drift.
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (!state.tab || state.tab.id !== tabId) return;
    if (info.url) state.tab.url = info.url;
    if (info.title) state.tab.title = info.title;
    if (info.url) forgetObservation();
    renderConnection();
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (!state.tab || state.tab.id !== tabId) return;
    disconnectTab();
    addMsg('note', 'The connected tab was closed, so the connection ended.');
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'bp:tabRemoved' && state.tab?.id === msg.tabId) {
      disconnectTab();
    }
  });
}

init();

/* ------------------------------------------------------------ agent bridge */
//
// The panel owns the loop and every tab action. This adapter exposes a small
// loopback command channel so an external agent on this machine can hand the
// panel a task, approve consequential actions, stop, and read progress. It
// deliberately reuses the existing UI paths (submit(), the approval buttons,
// connectTab()/disconnectTab()) rather than duplicating their logic.

const BRIDGE = {
  base: 'http://127.0.0.1:8788',
  token: 'bc-local-bridge-v1',
  interval: null,
  panelId: '',
  label: '',
};

// One panel per Chrome profile, so a stable per-profile id is enough to tell
// panels apart. Without it the relay hands every command to whichever panel
// polls first, and the caller cannot say which profile it meant.
const PANEL_ID_KEY = 'bcBridgePanelId';
const PANEL_LABEL_KEY = 'bcBridgePanelLabel';

function initPanelIdentity() {
  try {
    let id = localStorage.getItem(PANEL_ID_KEY);
    if (!id) {
      id = `panel-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(PANEL_ID_KEY, id);
    }
    BRIDGE.panelId = id;
    BRIDGE.label = localStorage.getItem(PANEL_LABEL_KEY) || '';
  } catch {
    BRIDGE.panelId = BRIDGE.panelId || `panel-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function bridgePanelInfo() {
  return {
    id: BRIDGE.panelId,
    label: BRIDGE.label || null,
    tab: state.tab ? `${state.tab.title} | ${state.tab.url}` : null,
  };
}

function bridgeQuery() {
  const q = new URLSearchParams({ panel: BRIDGE.panelId });
  if (BRIDGE.label) q.set('label', BRIDGE.label);
  if (state.tab) q.set('tab', `${state.tab.title} | ${state.tab.url}`);
  return q.toString();
}

function bridgeHeaders() {
  return { 'content-type': 'application/json', 'x-bridge-token': BRIDGE.token };
}

function bridgeEmit(type, data = {}) {
  fetch(`${BRIDGE.base}/event`, {
    method: 'POST',
    headers: bridgeHeaders(),
    body: JSON.stringify({ type, panel: BRIDGE.panelId, ...data }),
  }).catch(() => {});
}

async function bridgePostResult(id, result) {
  try {
    await fetch(`${BRIDGE.base}/result`, {
      method: 'POST',
      headers: bridgeHeaders(),
      body: JSON.stringify({ id, panel: BRIDGE.panelId, ...result }),
    });
  } catch {
    /* the caller will time out if the relay went away */
  }
}

/**
 * One unresolved action must not wedge the bridge. A tool that is parked on an
 * approval gate (or on a page that never settles) would otherwise swallow every
 * later command, because the caller only ever sees a timeout. The underlying
 * promise keeps running, so a later `approve` still resolves the action.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} still pending after ${ms}ms`)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function bridgeFeedText() {
  if (!feed) return '';
  return [...feed.querySelectorAll('.msg')]
    .map((el) => {
      const who = el.querySelector('.who')?.textContent || '';
      const body = el.querySelector('.body')?.innerText || '';
      return `${who}: ${body}`;
    })
    .join('\n')
    .slice(-8000);
}

function bridgePendingApproval() {
  const el = feed?.querySelector('.approval');
  if (!el) return null;
  return {
    reason: el.querySelector('.a-body')?.innerText || '',
    text: el.querySelector('.a-body')?.textContent || '',
  };
}

async function bridgeStatus() {
  return {
    panel: bridgePanelInfo(),
    extensionId: chrome.runtime?.id || null,
    extensionName: chrome.runtime?.getManifest?.().name || null,
    connected: Boolean(state.tab),
    tab: state.tab ? { id: state.tab.id, title: state.tab.title, url: state.tab.url } : null,
    running: state.running,
    stop: state.stop,
    conversationId: state.conversationId,
    obsMode: state.obsMode,
    obsReason: state.obsReason,
    tokenConfigured: Boolean(state.settings.token),
    backendUrl: state.settings.backendUrl,
    requireApproval: Boolean(state.settings.requireApproval),
    pendingApproval: bridgePendingApproval(),
    feed: bridgeFeedText(),
  };
}

async function bridgeHandle(cmd) {
  const { type } = cmd;

  switch (type) {
    case 'ping':
      return { ok: true, pong: true };

    case 'identify':
      return { ok: true, ...bridgePanelInfo() };

    // Name this panel so the caller can pick it by profile instead of by tab.
    case 'label': {
      const label = String(cmd.label || '').trim().slice(0, 60);
      if (!label) return { ok: false, error: 'label is required' };
      BRIDGE.label = label;
      try {
        localStorage.setItem(PANEL_LABEL_KEY, label);
      } catch {
        /* private/incognito contexts can refuse storage; the id still works */
      }
      bridgeEmit('panel_ready', { href: location.href });
      return { ok: true, ...bridgePanelInfo() };
    }

    case 'configure': {
      const s = { ...state.settings };
      if (typeof cmd.backendUrl === 'string' && cmd.backendUrl.trim()) {
        s.backendUrl = cmd.backendUrl.trim();
      }
      if (typeof cmd.token === 'string') s.token = cmd.token.trim();
      if (typeof cmd.requireApproval === 'boolean') s.requireApproval = cmd.requireApproval;

      // Go through the form so saveSettings() writes the same shape it always does.
      $('backendUrl').value = s.backendUrl;
      $('token').value = s.token;
      $('requireApproval').checked = s.requireApproval;
      await saveSettings();

      return {
        ok: true,
        settings: {
          backendUrl: s.backendUrl,
          tokenConfigured: Boolean(s.token),
          requireApproval: s.requireApproval,
        },
      };
    }

    case 'connect':
      await connectTab();
      return { ok: true, ...(await bridgeStatus()) };

    // Attach a specific tab instead of whatever is active. `connect` can only
    // adopt the active tab, which is the wrong one whenever the caller is not
    // the person clicking around the window.
    case 'use_tab': {
      const tabs = await chrome.tabs.query({});
      const byUrl = String(cmd.urlIncludes || '');
      const tab = cmd.tabId != null
        ? tabs.find((t) => t.id === Number(cmd.tabId))
        : byUrl
          ? tabs.find((t) => (t.url || '').includes(byUrl))
          : null;
      if (!tab) {
        return {
          ok: false,
          error: byUrl ? `no tab matching "${byUrl}"` : 'tabId or urlIncludes is required',
          openTabs: tabs.map((t) => t.url).filter(Boolean),
        };
      }
      await chrome.tabs.update(tab.id, { active: true });
      try {
        await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        /* a background window cannot always be focused */
      }
      const attached = await attachTab(tab);
      return { ok: attached, ...(await bridgeStatus()) };
    }

    case 'disconnect':
      await disconnectTab();
      return { ok: true, connected: false };

    case 'task': {
      const text = String(cmd.text || '').slice(0, 4000);
      if (!text) return { ok: false, error: 'text is required' };
      if (!state.tab) return { ok: false, error: 'No tab connected' };
      if (!state.settings.token) return { ok: false, error: 'Pairing token not configured' };
      if (state.running) return { ok: false, error: 'A task is already running' };

      input.value = text;
      submit();
      return { ok: true, started: true, text };
    }

    case 'approve': {
      const el = feed?.querySelector('.approval');
      if (!el) return { ok: false, error: 'No approval pending' };
      const btn = cmd.ok === false ? el.querySelector('.no') : el.querySelector('.ok');
      if (!btn) return { ok: false, error: 'Approval button missing' };
      btn.click();
      return { ok: true, approved: cmd.ok !== false };
    }

    case 'stop': {
      if (!state.running) return { ok: false, error: 'No task running' };
      $('btnStop').click();
      return { ok: true, stopped: true };
    }

    // Manual pilot mode: an external agent reads the observation and chooses
    // actions itself, bypassing the model backend (e.g. when it is out of
    // credit). Approval and the action guards in executeAction still apply.
    case 'observe': {
      const text = await observe(cmd.full !== false);
      return {
        ok: true,
        observation: text,
        version: state.obsVersion,
        mode: state.obsMode,
        reason: state.obsReason,
      };
    }

    case 'execute': {
      const name = String(cmd.name || '');
      if (!name) return { ok: false, error: 'name is required' };
      try {
        // A tool parked on an approval gate returns a timeout to the caller but
        // keeps waiting internally, so `approve` can still resolve it.
        const result = await withTimeout(
          executeAction({ name, args: cmd.args || {} }),
          45000,
          `tool "${name}"`,
        );
        return { ok: true, result };
      } catch (err) {
        return { ok: false, error: err?.message || String(err), pending: true };
      }
    }

    case 'screenshot': {
      const out = await rpc('capture_screenshot', {});
      return { ok: true, dataUrl: out.dataUrl || '', viewport: out.viewport || null, via: out.via || null };
    }

    case 'tabs': {
      const tabs = await chrome.tabs.query({});
      return {
        ok: true,
        tabs: tabs.map((t) => ({
          id: t.id,
          windowId: t.windowId,
          active: Boolean(t.active),
          title: t.title || '',
          url: t.url || '',
        })),
      };
    }

    case 'status':
      return { ok: true, ...(await bridgeStatus()) };

    default:
      return { ok: false, error: `Unknown command type: ${type}` };
  }
}

async function bridgePoll() {
  try {
    const res = await fetch(`${BRIDGE.base}/cmd?${bridgeQuery()}`, { headers: bridgeHeaders() });
    if (!res.ok) return;
    const { cmd } = await res.json();
    if (!cmd) return;

    // A command addressed to another panel must never be executed here, even if
    // this panel somehow received it.
    if (cmd.panel && cmd.panel !== BRIDGE.panelId) return;

    let result;
    try {
      result = await bridgeHandle(cmd);
    } catch (err) {
      result = { ok: false, error: err?.message || String(err) };
    }
    await bridgePostResult(cmd.id, result);
  } catch {
    /* relay not running yet — stay quiet and keep polling */
  }
}

// Observe the existing UI paths; this is how the external agent sees progress.
const _addMsg = addMsg;
addMsg = function (role, text) {
  bridgeEmit('message', { role, text });
  return _addMsg(role, text);
};

const _addToolCard = addToolCard;
addToolCard = function (name, args) {
  const card = _addToolCard(name, args);
  bridgeEmit('tool', { name, args });
  const done = card.done;
  const fail = card.fail;
  card.done = function (...a) {
    bridgeEmit('tool_done', { name, detail: a[0] });
    return done.apply(this, a);
  };
  card.fail = function (...a) {
    bridgeEmit('tool_fail', { name, error: a[0] });
    return fail.apply(this, a);
  };
  return card;
};

const _askApproval = askApproval;
askApproval = function (reason, call) {
  bridgeEmit('approval', { reason, call });
  return _askApproval(reason, call).then((ok) => {
    bridgeEmit('approval_resolved', { ok });
    return ok;
  });
};

const _runTask = runTask;
runTask = async function (message) {
  bridgeEmit('task_start', { text: message });
  try {
    return await _runTask(message);
  } finally {
    bridgeEmit('task_end', { text: message, status: await bridgeStatus() });
  }
};

const _connectTab = connectTab;
connectTab = async function () {
  const out = await _connectTab();
  bridgeEmit('connection', await bridgeStatus());
  return out;
};

const _disconnectTab = disconnectTab;
disconnectTab = async function () {
  const out = await _disconnectTab();
  bridgeEmit('connection', await bridgeStatus());
  return out;
};

initPanelIdentity();
BRIDGE.interval = setInterval(bridgePoll, 700);
bridgeEmit('panel_ready', { href: location.href });
