// Service worker: the privileged half, and the execution authority.
// The panel decides what to attempt; nothing reaches a tab without passing the
// guards below.
import {
  MODIFIER_BITS,
  planClick,
  planDoubleClick,
  planDrag,
  planHover,
  planKey,
  planScroll,
} from './lib/input.js';

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

/** Send a planned mouse sequence in order. One round trip per event is the
 * pacing: it keeps drags from being a single instantaneous teleport. */
async function dispatchMouse(tabId, events) {
  for (const ev of events) await send(tabId, 'Input.dispatchMouseEvent', ev);
}

async function mouseClick(tabId, x, y, clickCount = 1) {
  const point = { x, y };
  await dispatchMouse(tabId, clickCount > 1 ? planDoubleClick(point) : planClick(point));
}

/** Modifier bitmask from ["shift"] or "shift". */
function maskOf(keys) {
  const list = Array.isArray(keys) ? keys : keys ? [keys] : [];
  let mask = 0;
  for (const raw of list) {
    const name = String(raw || '').trim().toLowerCase();
    const bit = MODIFIER_BITS[name] || MODIFIER_BITS[name === 'control' ? 'ctrl' : name] || 0;
    mask |= bit;
  }
  return mask;
}

async function pressKey(tabId, combo) {
  const events = planKey(combo);
  if (!events) throw new Error(`Unsupported key "${combo}".`);
  for (const ev of events) await send(tabId, 'Input.dispatchKeyEvent', ev);
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
function blockReason(rect, { dom = false } = {}) {
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
  if (rect.covered && !dom) {
    return {
      kind: 'covered',
      // Naming the coverer matters: it is usually the thing the model should be
      // interacting with (a consent banner, a modal) rather than the page under it.
      message:
        `${what} is covered by ${rect.covering || 'another element'}; a real click would land on that instead. ` +
        'If the blocker is a floating overlay that is not part of the task (a HUD, a fixed bar), retry with dom:true. ' +
        'If it is a dialog or consent prompt, dismiss that first.',
    };
  }
  return null;
}

/**
 * Turn either a ref or a CSS-pixel coordinate pair into a click point.
 * Returns `{ error }` rather than throwing, so a drag can say which end was bad.
 */
async function resolvePoint(tabId, { ref, x, y, observationVersion } = {}) {
  if (ref) {
    const rect = await execInPage(tabId, 'rectOf', [ref, observationVersion]);
    if (!rect || rect.stale) {
      return { error: `Ref ${ref} is from an older observation. Call inspect_page and use the new refs.` };
    }
    if (rect.missing) return { error: `Ref ${ref} is no longer on the page.` };
    return { x: rect.x, y: rect.y, label: rect.label, ref };
  }

  const px = Number(x);
  const py = Number(y);
  if (!Number.isFinite(px) || !Number.isFinite(py)) {
    return { error: 'Give either a ref, or both x and y in CSS pixels.' };
  }
  return { x: Math.round(px), y: Math.round(py) };
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

  async click_element(tabId, { ref, double = false, dom = false, observationVersion } = {}) {
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

    const blocked = blockReason(rect, { dom });
    if (blocked) {
      return { ok: false, blocked: blocked.kind, covering: rect.covering, error: blocked.message };
    }

    // Straight to the element, past whatever is painted on top of it.
    if (dom) {
      const done = await execInPage(tabId, 'clickDom', [ref]);
      return done
        ? { ok: true, via: 'dom', clicked: rect.label }
        : { ok: false, error: `Ref ${ref} could not be clicked through the DOM.` };
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

  async set_range(tabId, { ref, value, observationVersion } = {}) {
    await assertActionable(tabId, 'set_range');

    const current = await execInPage(tabId, 'currentVersion', []);
    if (typeof observationVersion === 'number' && observationVersion !== current) {
      return {
        ok: false,
        stale: true,
        error: 'That ref is from an older observation. Call inspect_page and use the new refs.',
      };
    }

    const out = await execInPage(tabId, 'setRange', [ref, value]);
    if (!out) return { ok: false, error: `Unknown ref ${ref}.` };
    return out;
  },

  async hover(tabId, { ref, x, y, observationVersion } = {}) {
    await assertActionable(tabId, 'hover');

    const point = await resolvePoint(tabId, { ref, x, y, observationVersion });
    if (point.error) return { ok: false, error: point.error };

    try {
      await ensureAttached(tabId);
      // Hover is stateful — it opens tooltips and reveal-on-hover menus — so it
      // is deliberately one move with no click after it.
      await dispatchMouse(tabId, planHover(point));
      const over = await execInPage(tabId, 'hitTest', [point.x, point.y]);
      return { ok: true, via: 'cdp', at: { x: point.x, y: point.y }, over: over?.label || null };
    } catch (err) {
      return { ok: false, error: `Hover failed: ${err.message}` };
    }
  },

  async drag(tabId, { from_ref, to_ref, from_x, from_y, to_x, to_y, steps = 12, keys, observationVersion } = {}) {
    await assertActionable(tabId, 'drag');

    const from = await resolvePoint(tabId, { ref: from_ref, x: from_x, y: from_y, observationVersion });
    if (from.error) return { ok: false, error: `Drag start: ${from.error}` };

    const to = await resolvePoint(tabId, { ref: to_ref, x: to_x, y: to_y, observationVersion });
    if (to.error) return { ok: false, error: `Drag end: ${to.error}` };

    if (from.x === to.x && from.y === to.y) {
      return { ok: false, error: 'Start and end are the same point, which is a click, not a drag.' };
    }

    try {
      await ensureAttached(tabId);
      const events = planDrag(from, to, { steps, mask: maskOf(keys) });
      await dispatchMouse(tabId, events);
      const over = await execInPage(tabId, 'hitTest', [to.x, to.y]);
      return {
        ok: true,
        via: 'cdp',
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y },
        moves: events.length,
        released_on: over?.label || null,
      };
    } catch (err) {
      return { ok: false, error: `Drag failed: ${err.message}` };
    }
  },

  async click_at(tabId, { x, y, from_image = false, double = false, keys } = {}) {
    await assertActionable(tabId, 'click_at');

    let px = Number(x);
    let py = Number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      return { ok: false, error: 'click_at needs numeric x and y.' };
    }

    const view = await execInPage(tabId, 'viewport', []);
    if (!view) return { ok: false, error: 'Could not read the page viewport.' };

    // A screenshot is captured at the device pixel ratio; dividing here means
    // the model can pass the pixel it saw instead of doing arithmetic.
    if (from_image) {
      px /= view.dpr || 1;
      py /= view.dpr || 1;
    }
    px = Math.round(px);
    py = Math.round(py);

    if (px < 0 || py < 0 || px > view.w - 1 || py > view.h - 1) {
      return {
        ok: false,
        error: `(${px}, ${py}) is outside the ${view.w}x${view.h} viewport. Scroll the target into view first.`,
      };
    }

    try {
      await ensureAttached(tabId);
      // Report what is at the point before clicking: after a click the page may
      // already have navigated or replaced the element.
      const before = await execInPage(tabId, 'hitTest', [px, py]);
      const point = { x: px, y: py };
      const mask = maskOf(keys);
      await dispatchMouse(tabId, double ? planDoubleClick(point, { mask }) : planClick(point, { mask }));
      return {
        ok: true,
        via: 'cdp',
        clicked: point,
        on: before?.label || null,
        ...(from_image ? { divided_by_dpr: view.dpr } : {}),
      };
    } catch (err) {
      return { ok: false, error: `Click failed: ${err.message}` };
    }
  },

  async scroll_page(tabId, { dy = 600, dx = 0, x, y } = {}) {
    await assertActionable(tabId, 'scroll_page');
    try {
      await ensureAttached(tabId);
      // Wheel at a point, so the container under the cursor scrolls (a timeline,
      // a side panel) rather than only the document.
      const view = await execInPage(tabId, 'viewport', []);
      const at = {
        x: Number.isFinite(Number(x)) && x != null ? Math.round(Number(x)) : Math.round((view?.w || 1000) / 2),
        y: Number.isFinite(Number(y)) && y != null ? Math.round(Number(y)) : Math.round((view?.h || 800) / 2),
      };
      await dispatchMouse(tabId, planScroll(at, { dx, dy }));
      return { ok: true, via: 'cdp', dx, dy, at };
    } catch {
      const scrolled = await execInPage(tabId, 'scrollByPage', [dy]);
      return { ok: true, via: 'dom', dy, scrollY: scrolled };
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
    const view = await execInPage(tabId, 'viewport', []).catch(() => null);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
    // The viewport is returned so the model can relate image pixels to the
    // coordinate space click_at expects.
    return { ok: true, dataUrl, viewport: view };
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
