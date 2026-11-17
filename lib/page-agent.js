// Injected into the page's isolated world.
// Produces versioned observations of the page and exposes the primitives the
// background worker drives. Re-injection is a no-op.
(() => {
  if (globalThis.__bp) return;

  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    'summary',
    '[role=button]',
    '[role=link]',
    '[role=checkbox]',
    '[role=radio]',
    '[role=tab]',
    '[role=menuitem]',
    '[role=menuitemcheckbox]',
    '[role=switch]',
    '[role=combobox]',
    '[role=option]',
    '[role=slider]',
    '[role=searchbox]',
    '[role=textbox]',
    '[contenteditable=true]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  // Fields whose contents must never enter an observation or a log.
  const SENSITIVE =
    /(pass(word|phrase)?|pwd|card.?number|card.?num|cc.?num|cvv|cvc|csc|ssn|social.?security|tax.?id|pin\b|iban|account.?(number|no)|routing|sort.?code|secret|otp|one.?time.?code|security.?answer)/i;

  /** @type {Map<string, Element>} ref -> element for the latest observation only */
  let refs = new Map();

  /**
   * element -> ref, kept for the lifetime of this document.
   *
   * An element keeps the same ref across observations, which is what makes a
   * diff meaningful: "e7 changed" can only be true if e7 is the same element.
   * An element that leaves the page keeps its entry here but drops out of
   * `refs`, so an old ref fails cleanly instead of silently pointing at
   * whatever now occupies that position.
   */
  const index = new WeakMap();

  let counter = 0;
  let version = 0;

  // Identifies this injected script instance. A reload or navigation produces a
  // new one, which tells the panel its cached refs are from another document
  // even when the URL looks the same.
  const INSTANCE = Math.random().toString(36).slice(2, 10);

  const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const frames = () => new Promise((r) => requestAnimationFrame(() => r()));

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < -3000 || r.top > window.innerHeight + 6000) return false;
    return true;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (el.isContentEditable) return 'textbox';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'password') return 'password';
      if (type === 'checkbox' || type === 'radio') return type;
      // A range input is a slider, not a text field. Reporting it as a textbox
      // made the model try to type a value into a scrubber.
      if (type === 'range') return 'slider';
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    // Frames are reported so the model knows the page continues inside one, and
    // where. Coordinate actions (click_at, drag, hover) reach into them because
    // the browser delivers events by hit-testing, not per document.
    if (tag === 'iframe' || tag === 'frame') return 'frame';
    return tag;
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent)
        .filter(Boolean)
        .join(' ');
      if (norm(text)) return norm(text);
    }

    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return norm(label.textContent);
    }

    for (const attr of ['placeholder', 'alt', 'title', 'name']) {
      const v = el.getAttribute(attr);
      if (v && norm(v)) return norm(v);
    }

    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes((el.type || '').toLowerCase())) {
      if (norm(el.value)) return norm(el.value);
    }

    return norm(el.innerText || el.textContent || '').slice(0, 160);
  }

  /** True when this field holds a secret the model must never see or fill. */
  function isSensitive(el) {
    if ((el.type || '').toLowerCase() === 'password') return true;
    const hints = [
      el.getAttribute('name'),
      el.id,
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      el.getAttribute('autocomplete'),
      el.getAttribute('data-testid'),
    ]
      .filter(Boolean)
      .join(' ');
    return SENSITIVE.test(hints);
  }

  function pageText(limit) {
    const root = document.body || document.documentElement;
    let text = '';
    try {
      text = root.innerText || '';
    } catch {
      text = root.textContent || '';
    }
    text = text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (limit && text.length > limit) return `${text.slice(0, limit)}\n…[truncated]`;
    return text;
  }

  /** Stable ref for an element. Never reused, so a diff can trust it. */
  function refFor(el) {
    let ref = index.get(el);
    if (!ref) {
      ref = `e${++counter}`;
      index.set(el, ref);
    }
    refs.set(ref, el);
    return ref;
  }

  /** A frame has no text content, so name it from its attributes or its src. */
  function frameName(el) {
    const label = el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('name');
    if (label && norm(label)) return norm(label).slice(0, 80);
    const src = el.getAttribute('src') || '';
    if (!src) return 'inline frame';
    try {
      const u = new URL(src, location.href);
      return `${u.host}${u.pathname}`.slice(0, 80);
    } catch {
      return src.slice(0, 80);
    }
  }

  function snapshot(maxElements, maxText) {
    version += 1;
    refs = new Map();

    const elements = [];
    const seen = new Set();

    for (const el of document.querySelectorAll(SELECTOR)) {
      if (elements.length >= maxElements) break;
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;

      const rect = el.getBoundingClientRect();
      const ref = refFor(el);
      const role = roleOf(el);
      const item = {
        ref,
        role,
        name: nameOf(el),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };

      if (el.disabled) item.disabled = true;
      if (role === 'checkbox' || role === 'radio') item.checked = Boolean(el.checked);
      if (role === 'password' || isSensitive(el)) {
        item.sensitive = true;
      } else if (role === 'slider') {
        // A slider's position is the thing you want; min/max say what the
        // number means, and where the handle sits on the track.
        const native = el.tagName === 'INPUT';
        const value = native ? el.value : el.getAttribute('aria-valuenow');
        if (value != null && value !== '') item.value = String(value);
        const min = native ? el.min : el.getAttribute('aria-valuemin');
        const max = native ? el.max : el.getAttribute('aria-valuemax');
        if (min != null && min !== '') item.min = String(min);
        if (max != null && max !== '') item.max = String(max);
      } else if (['textbox', 'searchbox', 'combobox'].includes(role) && 'value' in el && el.value) {
        item.value = String(el.value).slice(0, 120);
      }
      if (el.tagName === 'A' && el.href) item.href = el.href;
      const expanded = el.getAttribute('aria-expanded');
      if (expanded) item.expanded = expanded === 'true';

      elements.push(item);
    }

    // Frames are appended last so they cannot renumber the controls above.
    // The size is included because the model needs to know the region it can
    // click into, and because a canvas editor inside a frame is otherwise
    // invisible to this observation.
    for (const el of document.querySelectorAll('iframe, frame')) {
      if (elements.length >= maxElements + 8) break;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const item = {
        ref: refFor(el),
        role: 'frame',
        name: frameName(el),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
      if (el.src) item.href = el.src;
      elements.push(item);
    }

    return {
      version,
      instance: INSTANCE,
      url: location.href,
      title: document.title,
      scrollY: Math.round(window.scrollY),
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      docH: document.documentElement.scrollHeight,
      elements,
      text: pageText(maxText),
    };
  }

  /** Viewport and pixel ratio, for mapping screenshots back to click points. */
  const viewport = () => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  });

  /** What is actually at a point? Lets click_at report what it hit. */
  function hitTest(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return { tag: el.tagName.toLowerCase(), label: describeNode(el).slice(0, 80) };
  }

  const currentVersion = () => version;

  function describeNode(el) {
    if (!el) return '';
    const label = nameOf(el).slice(0, 40);
    return label ? `${el.tagName.toLowerCase()} "${label}"` : el.tagName.toLowerCase();
  }

  /**
   * Scroll a ref into view and return viewport-relative centre coordinates,
   * plus the checks the caller needs before sending a real mouse event:
   * is it enabled, is it still moving, and is something else on top of it.
   * Returns `{ stale: true }` when the ref belongs to an older observation.
   */
  async function rectOf(ref, expectedVersion) {
    if (typeof expectedVersion === 'number' && expectedVersion !== version) {
      return { stale: true, expectedVersion, currentVersion: version };
    }

    const el = refs.get(ref);
    if (!el || !el.isConnected) return { missing: true };

    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await frames();

    // A moving target is a mis-click waiting to happen. Most transitions have
    // settled by the next frame; report honestly if this one never does.
    let r = el.getBoundingClientRect();
    let moving = false;
    for (let i = 0; i < 4; i++) {
      const before = r;
      await frames();
      r = el.getBoundingClientRect();
      moving = Math.abs(r.left - before.left) > 1 || Math.abs(r.top - before.top) > 1;
      if (!moving) break;
    }

    if (r.width < 1 || r.height < 1) return { missing: true };

    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);

    // What is actually at that point? If it is neither this element nor a
    // descendant, a real mouse click would land on whatever is covering it.
    const hit = document.elementFromPoint(x, y);
    const covered = Boolean(hit) && hit !== el && !el.contains(hit);

    return {
      x,
      y,
      w: Math.round(r.width),
      h: Math.round(r.height),
      label: nameOf(el).slice(0, 80),
      sensitive: isSensitive(el),
      role: roleOf(el),
      disabled: Boolean(el.disabled),
      moving,
      covered,
      covering: covered ? describeNode(hit) : undefined,
    };
  }

  /**
   * Search the latest observation instead of re-reading the whole page.
   * Plain text matches case-insensitively against role and accessible name;
   * `/pattern/flags` is treated as a regular expression.
   */
  function find(query, maxResults = 20) {
    const q = String(query || '').trim();
    if (!q) return { matches: [], error: 'Empty query.' };

    let test;
    try {
      if (/^\/.*\/[a-z]*$/.test(q)) {
        const end = q.lastIndexOf('/');
        const re = new RegExp(q.slice(1, end), q.slice(end + 1) || 'i');
        test = (s) => re.test(s);
      } else {
        const needle = q.toLowerCase();
        test = (s) => s.toLowerCase().includes(needle);
      }
    } catch (err) {
      return { matches: [], error: `Bad pattern: ${err.message}` };
    }

    const matches = [];
    for (const [ref, el] of refs) {
      if (matches.length >= maxResults) break;
      if (!el.isConnected) continue;

      const role = roleOf(el);
      const name = nameOf(el);
      if (!test(name) && !test(role)) continue;

      const r = el.getBoundingClientRect();
      matches.push({
        ref,
        role,
        name: name.slice(0, 120),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        disabled: Boolean(el.disabled) || undefined,
        sensitive: isSensitive(el) || undefined,
      });
    }

    return { count: matches.length, matches };
  }

  function describe(ref) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) return null;
    return {
      role: roleOf(el),
      name: nameOf(el).slice(0, 120),
      href: el.tagName === 'A' ? el.href : undefined,
      sensitive: isSensitive(el),
    };
  }

  // --- fallbacks used only when the debugger API is unavailable -------------

  function clickDom(ref) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2),
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  }

  function setValue(ref, text) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) return false;
    if (isSensitive(el)) return false;
    el.focus({ preventScroll: true });
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter && 'value' in el) setter.call(el, text);
    else if (el.isContentEditable) el.textContent = text;
    else if ('value' in el) el.value = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function selectOption(ref, wanted) {
    const el = refs.get(ref);
    if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'That element is not a <select>.' };

    const want = String(wanted).trim().toLowerCase();
    const options = [...el.options];
    const match =
      options.find((o) => o.value.toLowerCase() === want) ||
      options.find((o) => norm(o.textContent).toLowerCase() === want) ||
      options.find((o) => norm(o.textContent).toLowerCase().includes(want));

    if (!match) {
      return { ok: false, error: `No option matching "${wanted}".`, options: options.map((o) => norm(o.textContent)).slice(0, 40) };
    }

    el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: norm(match.textContent) };
  }

  /**
   * Set a native range input's value. Dragging the handle is the other way, but
   * for a scrubber a numeric set is more precise and does not depend on the
   * thumb's pixel position. ARIA sliders are refused: writing aria-valuenow
   * would change nothing on the page's own model.
   */
  function setRange(ref, value) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) return { ok: false, error: 'That ref is no longer on the page.' };
    if (el.tagName !== 'INPUT' || (el.type || '').toLowerCase() !== 'range') {
      return { ok: false, error: 'Not a native range input. Click or drag its handle instead.' };
    }

    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: 'value must be a number.' };

    const min = Number(el.min || 0);
    const max = Number(el.max || 100);
    const target = Math.min(max, Math.max(min, n));

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, String(target));
    else el.value = String(target);

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: Number(el.value), min, max };
  }

  function scrollByPage(dy) {
    window.scrollBy({ top: dy, left: 0, behavior: 'instant' });
    return Math.round(window.scrollY);
  }

  globalThis.__bp = {
    instance: () => INSTANCE,
    snapshot,
    viewport,
    hitTest,
    currentVersion,
    rectOf,
    find,
    describe,
    clickDom,
    setValue,
    setRange,
    selectOption,
    scrollByPage,
  };
})();
