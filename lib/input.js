// Input planning: pure functions that turn one action into the exact sequence of
// CDP Input events to dispatch.
//
// Why a separate module rather than inline sends: the tests replay these same
// arrays through a real Chromium CDP session (test/verify-pointer.mjs), so the
// thing under test is byte-for-byte the thing the service worker runs. A drag
// that works in the harness but not in the panel would be a bug in the
// dispatcher, not in the plan, and that distinction is worth being able to make.
//
// The shape follows OpenAI's computer-use action set: a drag is a path of
// points, hover is its own action, and mouse actions can hold modifiers (so
// shift+drag extends a selection and ctrl+click opens in a new tab).

/** CDP modifier bitmask: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const MODIFIER_BITS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

/* ---------------------------------------------------------------- keyboard */

// [key, code, windowsVirtualKeyCode, text?]
const NAMED = {
  enter: ['Enter', 'Enter', 13, '\r'],
  tab: ['Tab', 'Tab', 9],
  escape: ['Escape', 'Escape', 27],
  backspace: ['Backspace', 'Backspace', 8],
  delete: ['Delete', 'Delete', 46],
  insert: ['Insert', 'Insert', 45],
  space: [' ', 'Space', 32, ' '],
  home: ['Home', 'Home', 36],
  end: ['End', 'End', 35],
  pageup: ['PageUp', 'PageUp', 33],
  pagedown: ['PageDown', 'PageDown', 34],
  arrowup: ['ArrowUp', 'ArrowUp', 38],
  arrowdown: ['ArrowDown', 'ArrowDown', 40],
  arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39],
  minus: ['-', 'Minus', 189, '-'],
  equal: ['=', 'Equal', 187, '='],
  comma: [',', 'Comma', 188, ','],
  period: ['.', 'Period', 190, '.'],
  slash: ['/', 'Slash', 191, '/'],
  backslash: ['\\', 'Backslash', 220, '\\'],
  semicolon: [';', 'Semicolon', 186, ';'],
  quote: ["'", 'Quote', 222, "'"],
  bracketleft: ['[', 'BracketLeft', 219, '['],
  bracketright: [']', 'BracketRight', 221, ']'],
  backquote: ['`', 'Backquote', 192, '`'],
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => {
      const n = i + 1;
      return [`f${n}`, [`F${n}`, `F${n}`, 112 + i]];
    }),
  ),
};

const ALIASES = {
  return: 'enter',
  esc: 'escape',
  del: 'delete',
  spacebar: 'space',
  control: 'ctrl',
  option: 'alt',
  cmd: 'meta',
  command: 'meta',
  win: 'meta',
  super: 'meta',
};

function normaliseKeyName(raw) {
  const low = String(raw || '').trim().toLowerCase();
  return ALIASES[low] || low;
}

/**
 * Resolve one (non-modifier) key name to a CDP key descriptor.
 * Letters and digits are generated rather than listed: KeyA..KeyZ, Digit0..9.
 */
export function keySpec(raw) {
  const name = normaliseKeyName(raw);
  if (!name) return null;

  if (NAMED[name]) {
    const [key, code, vk, text] = NAMED[name];
    return { key, code, vk, text };
  }
  if (/^[a-z]$/.test(name)) {
    return { key: name, code: `Key${name.toUpperCase()}`, vk: 65 + (name.charCodeAt(0) - 97), text: name };
  }
  if (/^[0-9]$/.test(name)) {
    return { key: name, code: `Digit${name}`, vk: 48 + Number(name), text: name };
  }
  return null;
}

const MODIFIER_NAMES = new Set(['alt', 'ctrl', 'meta', 'shift']);

/**
 * Parse "ctrl+shift+z" into the descriptor needed for Input.dispatchKeyEvent.
 * Returns null for an unknown key, so the caller can refuse rather than send
 * a key event that does nothing.
 */
export function parseKeyCombo(combo) {
  const parts = String(combo || '')
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const mods = new Set();
  let main = null;

  for (const part of parts) {
    const name = normaliseKeyName(part);
    if (MODIFIER_NAMES.has(name)) mods.add(name);
    else main = part;
  }

  // A modifiers-only combo such as "ctrl" is not a keypress.
  if (!main) return null;

  const spec = keySpec(main);
  if (!spec) return null;

  let mask = 0;
  for (const m of mods) mask |= MODIFIER_BITS[m];

  // Text is what the key inserts. Holding Ctrl/Alt/Meta turns a key into a
  // shortcut, which must not insert a character; Shift alone does uppercase it.
  const inserts = spec.text && !(mask & (MODIFIER_BITS.ctrl | MODIFIER_BITS.alt | MODIFIER_BITS.meta));
  const text = inserts ? (mask & MODIFIER_BITS.shift ? spec.text.toUpperCase() : spec.text) : undefined;

  return { spec, mods: [...mods], mask, text };
}

/** The two CDP events for one keypress, with modifiers held around it. */
export function planKey(combo) {
  const parsed = parseKeyCombo(combo);
  if (!parsed) return null;

  const down = {
    type: 'keyDown',
    modifiers: parsed.mask,
    key: parsed.spec.key,
    code: parsed.spec.code,
    windowsVirtualKeyCode: parsed.spec.vk,
    nativeVirtualKeyCode: parsed.spec.vk,
  };
  if (parsed.text) down.text = parsed.text;

  return [down, { ...down, type: 'keyUp', text: undefined }];
}

/* ------------------------------------------------------------------- mouse */

function mouseEvent(type, point, fields) {
  return {
    type,
    x: Math.round(point.x),
    y: Math.round(point.y),
    ...fields,
  };
}

/** Move without pressing. This is the whole of a hover. */
export function planHover(point, { mask = 0 } = {}) {
  return [mouseEvent('mouseMoved', point, { button: 'none', buttons: 0, modifiers: mask })];
}

export function planClick(point, { clickCount = 1, button = 'left', mask = 0 } = {}) {
  const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
  return [
    mouseEvent('mouseMoved', point, { button: 'none', buttons: 0, modifiers: mask }),
    mouseEvent('mousePressed', point, { button, buttons, clickCount, modifiers: mask }),
    mouseEvent('mouseReleased', point, { button, buttons: 0, clickCount, modifiers: mask }),
  ];
}

/**
 * A real double-click is two press/release pairs with clickCount 1 then 2.
 * Sending a single pair with clickCount 2 does not produce a dblclick event,
 * which is why double-clicking list items used to do nothing.
 */
export function planDoubleClick(point, { button = 'left', mask = 0 } = {}) {
  return [
    ...planClick(point, { clickCount: 1, button, mask }),
    ...planClick(point, { clickCount: 2, button, mask }).slice(1),
  ];
}

/**
 * Press at `from`, move through interpolated waypoints, release at `to`.
 *
 * Interpolation matters: editors start a drag on the first mousemove that
 * leaves the press point (often with a few pixels of hysteresis), and a single
 * jump from A to B is also a poor fit for anything that samples the path
 * mid-drag — canvas editors, split panes, sliders.
 */
export function planDrag(from, to, { steps = 12, button = 'left', mask = 0 } = {}) {
  const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
  const n = Math.max(1, Math.min(60, Math.round(steps)));

  const events = [mouseEvent('mouseMoved', from, { button: 'none', buttons: 0, modifiers: mask })];
  events.push(mouseEvent('mousePressed', from, { button, buttons, clickCount: 1, modifiers: mask }));

  let last = { x: from.x, y: from.y };
  for (let i = 1; i <= n; i++) {
    const point = {
      x: Math.round(from.x + ((to.x - from.x) * i) / n),
      y: Math.round(from.y + ((to.y - from.y) * i) / n),
    };
    // Skip repeats so a zero-distance drag is not 12 identical events.
    if (point.x === last.x && point.y === last.y && i !== n) continue;
    events.push(mouseEvent('mouseMoved', point, { button, buttons, modifiers: mask }));
    last = point;
  }

  events.push(mouseEvent('mouseReleased', to, { button, buttons: 0, clickCount: 1, modifiers: mask }));
  return events;
}

/** Wheel at a point, so inner scroll containers (timelines, panels) scroll too. */
export function planScroll(point, { dx = 0, dy = 600 } = {}) {
  return [mouseEvent('mouseWheel', point, { deltaX: Math.round(dx), deltaY: Math.round(dy) })];
}
