// Service worker: the privileged half, and the execution authority.
// The panel decides what to attempt; nothing reaches a tab without passing the
// guards below.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** tabs with an attached debugger session */
const attached = new Set();

/* ------------------------------------------------------------------ guards */

// Never scriptable, whatever the model asks for.
const BLOCKED_SCHEME = /^(chrome|chrome-extension|edge|about|devtools|view-source|file|data):/i;

// Fields the agent may never write into, and whose contents never enter an
// observation. Sensitive-field redaction is a privacy property, not a policy
// opinion: a password typed by an agent into a log is a leak either way.
const FORBIDDEN_FIELD = /(pass(word|phrase)?|pwd|cvv|cvc|csc|card.?number|ssn|social.?security|iban|account.?(number|no)|routing|otp|one.?time.?code)/i;

const READ_ONLY_TOOLS = new Set(['inspect_page', 'find_on_page', 'capture_screenshot', 'scroll_page', 'wait', 'probe']);

async function getTab(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw new Error('The connected tab no longer exists. Press Connect this tab again.');
  return tab;
}

async function blockedHosts() {
  // Empty by default. The precise guard is DENY_LABEL below, which does not
  // need a site list: it refuses the element that actually moves money.
  // This list is an opt-in kill switch for a whole site if you want one.
  const { blockedHosts: list } = await chrome.storage.local.get('blockedHosts');
  return Array.isArray(list) ? list : [];
}

async function assertActionable(tabId, tool) {
  const tab = await getTab(tabId);
  const url = tab.url || tab.pendingUrl || '';

  if (BLOCKED_SCHEME.test(url)) {
    throw new Error('Browser-internal pages cannot be operated. Open a normal website.');
  }
  if (READ_ONLY_TOOLS.has(tool)) return tab;

  let host = '';
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* opaque URL: treat as blocked below */
  }

  const denied = await blockedHosts();
  const hit = denied.find((h) => host === h || host.endsWith(`.${h}`));
  if (hit) {
    throw new Error(
      `${host} is on the blocked list, so this build will not click or type on it. Reading the page still works. Remove it in Settings → Blocked sites if you want to allow actions.`,
    );
  }

  return tab;
}

/* ------------------------------------------------------------ page bridge */

async function execInPage(tabId, method, args = []) {
  const run = async () => {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [method, args],
      func: (m, a) => (globalThis.__bp ? globalThis.__bp[m](...a) : { __bpMissing: true }),
    });
    return out?.result;
  };

  let result = await run();
  if (result && result.__bpMissing) {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['lib/page-agent.js'] });
    result = await run();
  }
  if (result && result.__bpMissing) {
    throw new Error('Could not attach to this page. Reload the tab and try again.');
  }
  return result;
}

/* ------------------------------------------------------------- CDP input */

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  const targets = await chrome.debugger.getTargets();
  if (!targets.some((t) => t.tabId === tabId && t.attached)) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (err) {
      throw new Error(
        `Could not attach the debugger (${err.message}). Close DevTools for this tab and retry.`,
      );
    }
  }
  attached.add(tabId);
}

const send = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params);

async function mouseClick(tabId, x, y, clickCount = 1) {
  await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount,
  });
  await send(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
    clickCount,
  });
}

const KEY_ALIASES = {
  enter: 'Enter',
  tab: 'Tab',
  escape: 'Escape',
  backspace: 'Backspace',
  delete: 'Delete',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
};

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
};

async function pressKey(tabId, combo) {
  const parts = String(combo || '')
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);

  const mods = { alt: false, ctrl: false, meta: false, shift: false };
  let main = null;
  for (const part of parts) {
    const low = part.toLowerCase();
    if (low === 'ctrl' || low === 'control') mods.ctrl = true;
    else if (low === 'alt' || low === 'option') mods.alt = true;
    else if (low === 'shift') mods.shift = true;
    else if (low === 'meta' || low === 'cmd') mods.meta = true;
    else main = part;
  }

  const name = KEY_ALIASES[String(main || '').toLowerCase()] || main;
  const spec = KEYS[name];
  if (!spec) throw new Error(`Unsupported key "${combo}".`);

  const mask = (mods.alt ? 1 : 0) | (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);

  const down = {
    type: 'keyDown',
    modifiers: mask,
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.vk,
    nativeVirtualKeyCode: spec.vk,
  };
  if (spec.text && !mask) down.text = spec.text;

  await send(tabId, 'Input.dispatchKeyEvent', down);
  await send(tabId, 'Input.dispatchKeyEvent', { ...down, type: 'keyUp', text: undefined });
}

async function waitForLoad(tabId, timeout = 20000) {
  const start = Date.now();
  await sleep(150);
  while (Date.now() - start < timeout) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return false;
    if (tab.status === 'complete') return true;
    await sleep(200);
  }
  return false;
}

/* ------------------------------------------------------------------- tools */

// A coordinate click is only as good as whatever is actually sitting under the
// coordinate. Nanobrowser's pre-click rule, kept: enabled, not moving, not
// covered. `rectOf` already waits for motion to settle and reports all three,
// so the job here is to turn that into a reason the model can act on instead of
// a silent no-op or a click on the wrong element.
function blockReason(rect) {
  const what = rect.label ? `"${rect.label}"` : 'That element';

  if (rect.disabled) {
    return { kind: 'disabled', message: `${what} is disabled, so this would do nothing.` };
  }
  if (rect.moving) {
    return {
      kind: 'moving',
      message: `${what} was still moving (animation or layout shift) after being given time to settle.`,
    };
  }
  if (rect.covered) {
    return {
      kind: 'covered',
      // Naming the coverer matters: it is usually the thing the model should be
      // interacting with (a consent banner, a modal) rather than the page under it.
      message: `${what} is covered by ${rect.covering || 'another element'}; a real click would land on that instead. Dismiss or scroll past the blocker first.`,
    };
  }
  return null;
}

const RPC = {
  async inspect_page(tabId, { full = true } = {}) {
    const snap = await execInPage(tabId, 'snapshot', [full ? 250 : 120, full ? 4000 : 1200]);
    if (!snap) throw new Error('Empty observation');
    return { ok: true, snapshot: snap };
  },

  async probe(tabId, { ref } = {}) {
    const info = await execInPage(tabId, 'describe', [ref]);
    return info ? { ok: true, info } : { ok: false, error: `Unknown ref ${ref}` };
  },

  // Search the current observation instead of paying for a new one. This is the
  // Playwright MCP idea: the snapshot already holds the element, so locating it
  // again should not require re-reading the page.
  async find_on_page(tabId, { query, max_results } = {}) {
    const limit = Math.min(Math.max(Number(max_results) || 20, 1), 50);
    const out = await execInPage(tabId, 'find', [String(query || ''), limit]);
    if (!out) throw new Error('The page did not answer; call inspect_page instead.');
    if (out.error) return { ok: false, error: out.error };
    return { ok: true, count: out.count, matches: out.matches };
  },

  async click_element(tabId, { ref, double = false, observationVersion } = {}) {
    await assertActionable(tabId, 'click_element');

    const rect = await execInPage(tabId, 'rectOf', [ref, observationVersion]);
    if (!rect || rect.stale) {
      return {
        ok: false,
        stale: Boolean(rect && rect.stale),
        error: 'That ref is from an older observation. Call inspect_page and use the new refs.',
      };
    }
    if (rect.missing) return { ok: false, error: `Ref ${ref} is no longer on the page.` };

    const blocked = blockReason(rect);
    if (blocked) {
      return { ok: false, blocked: blocked.kind, covering: rect.covering, error: blocked.message };
    }

    try {
      await ensureAttached(tabId);
      await mouseClick(tabId, rect.x, rect.y, double ? 2 : 1);
      return { ok: true, via: 'cdp', clicked: rect.label };
    } catch (err) {
      const done = await execInPage(tabId, 'clickDom', [ref]);
      return done
        ? { ok: true, via: 'dom', clicked: rect.label }
        : { ok: false, error: `Click failed: ${err.message}` };
    }
  },

  async type_text(tabId, { ref, text = '', clear = true, submit = false, observationVersion } = {}) {
    await assertActionable(tabId, 'type_text');

    if (FORBIDDEN_FIELD.test(String(text))) {
      return { ok: false, denied: true, error: 'Refused: that text looks like a secret or a card number.' };
    }

    const rect = await execInPage(tabId, 'rectOf', [ref, observationVersion]);
    if (!rect || rect.stale) {
      return {
        ok: false,
        stale: Boolean(rect && rect.stale),
        error: 'That ref is from an older observation. Call inspect_page and use the new refs.',
      };
    }
    if (rect.missing) return { ok: false, error: `Ref ${ref} is no longer on the page.` };

    if (rect.sensitive || rect.role === 'password' || FORBIDDEN_FIELD.test(rect.label)) {
      return { ok: false, denied: true, error: 'Refused: that is a password or secret field. The user must fill it.' };
    }

    const blocked = blockReason(rect);
    if (blocked) {
      return { ok: false, blocked: blocked.kind, covering: rect.covering, error: blocked.message };
    }

    try {
      await ensureAttached(tabId);
      await mouseClick(tabId, rect.x, rect.y, 1);
      if (clear) {
        await pressKey(tabId, 'ctrl+a');
        await pressKey(tabId, 'Delete');
      }
      await send(tabId, 'Input.insertText', { text });
      if (submit) await pressKey(tabId, 'Enter');
      return { ok: true, via: 'cdp', into: rect.label, submitted: Boolean(submit) };
    } catch (err) {
      const done = await execInPage(tabId, 'setValue', [ref, text]);
      return done
        ? { ok: true, via: 'dom', into: rect.label }
        : { ok: false, error: `Typing failed: ${err.message}` };
    }
  },

  async select_option(tabId, { ref, value, observationVersion } = {}) {
    await assertActionable(tabId, 'select_option');

    const current = await execInPage(tabId, 'currentVersion', []);
    if (typeof observationVersion === 'number' && observationVersion !== current) {
      return {
        ok: false,
        stale: true,
        error: 'That ref is from an older observation. Call inspect_page and use the new refs.',
      };
    }

    const out = await execInPage(tabId, 'selectOption', [ref, value]);
    if (out && out.ok) return { ok: true, selected: out.selected, options: out.options };
    return { ok: false, error: (out && out.error) || `Could not select "${value}".`, options: out?.options };
  },

  async scroll_page(tabId, { dy = 600 } = {}) {
    await assertActionable(tabId, 'scroll_page');
    try {
      await ensureAttached(tabId);
      const tab = await chrome.tabs.get(tabId);
      const x = Math.round((tab.width || 1000) / 2);
      const y = Math.round((tab.height || 800) / 2);
      await send(tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
      return { ok: true, via: 'cdp', dy };
    } catch {
      const y = await execInPage(tabId, 'scrollByPage', [dy]);
      return { ok: true, via: 'dom', dy, scrollY: y };
    }
  },

  async navigate(tabId, { url } = {}) {
    await assertActionable(tabId, 'navigate');
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('navigate only accepts http(s) URLs');
    await chrome.tabs.update(tabId, { url });
    return { ok: true, loaded: await waitForLoad(tabId), url };
  },

  async go_back(tabId) {
    await assertActionable(tabId, 'go_back');
    await chrome.tabs.goBack(tabId).catch(() => {});
    return { ok: true, loaded: await waitForLoad(tabId) };
  },

  async press_key(tabId, { keys = 'Enter' } = {}) {
    await assertActionable(tabId, 'press_key');
    try {
      await ensureAttached(tabId);
      await pressKey(tabId, keys);
      return { ok: true, via: 'cdp', pressed: keys };
    } catch (err) {
      return { ok: false, error: `Key press failed: ${err.message}` };
    }
  },

  async capture_screenshot(tabId) {
    const tab = await getTab(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await sleep(250);
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
    return { ok: true, dataUrl };
  },

  async wait(_tabId, { ms = 500 } = {}) {
    await sleep(Math.min(Math.max(Number(ms) || 500, 100), 10000));
    return { ok: true, waited: ms };
  },

  async detach(tabId) {
    if (attached.has(tabId)) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      attached.delete(tabId);
    }
    return { ok: true };
  },
};

/* ------------------------------------------------------------- lifecycle */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.storage.local
    .get('blockedHosts')
    .then(({ blockedHosts: list }) => {
      if (!Array.isArray(list)) chrome.storage.local.set({ blockedHosts: [] });
    })
    .catch(() => {});
});

chrome.runtime.onStartup?.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) attached.delete(source.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'bp:exec') return undefined;

  const handler = RPC[msg.tool];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown tool "${msg.tool}"` });
    return undefined;
  }
  if (typeof msg.tabId !== 'number') {
    sendResponse({ ok: false, error: 'No connected tab' });
    return undefined;
  }

  handler(msg.tabId, msg.args || {})
    .then((result) => sendResponse({ ok: true, result }))
    .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));

  return true;
});
