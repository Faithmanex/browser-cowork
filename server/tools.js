// The action vocabulary exposed to the model. Narrow on purpose: every tool is
// implemented in application code, nothing here is a general escape hatch.

export const TOOLS = [
  {
    name: 'inspect_page',
    description:
      'Re-read the connected page. Returns a diff against the last observation, or the whole page after a navigation. Prefer find_on_page for one element; use this when you need the full current state.',
    parameters: {
      type: 'object',
      properties: {
        full: {
          type: 'boolean',
          description: 'Include more elements and more page text when the default view misses something.',
        },
      },
    },
  },
  {
    name: 'find_on_page',
    description:
      'Find elements in the current observation by name or role, without re-reading the page. Returns refs, coordinates and state. Use this to re-locate something you know exists when the latest observation only reported changes.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text to match against accessible name or role, e.g. "cart" or "button". /pattern/i is treated as a regular expression.',
        },
        max_results: { type: 'number', description: 'Maximum matches to return (default 20, max 50).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'click_element',
    description: 'Click an element observed in the current observation, by its ref.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the current observation, e.g. e12' },
        double: { type: 'boolean', description: 'Double-click instead of a single click.' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'type_text',
    description:
      'Click a text field by ref and enter text, replacing existing contents by default. Never use on password fields.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Ref of the input, textarea or contenteditable element' },
        text: { type: 'string', description: 'The text to enter' },
        submit: { type: 'boolean', description: 'Press Enter after typing.' },
        clear: { type: 'boolean', description: 'Replace existing contents (default true).' },
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'select_option',
    description: 'Choose an option in a native dropdown by its visible label or value.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Ref of the select element' },
        value: { type: 'string', description: 'Option label or value to select' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'scroll_page',
    description: 'Scroll the page vertically. Positive scrolls down.',
    parameters: {
      type: 'object',
      properties: { dy: { type: 'number', description: 'Pixels, e.g. 600 or -600' } },
    },
  },
  {
    name: 'navigate',
    description: 'Load an http(s) URL in the connected tab and wait for it to finish loading.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
      required: ['url'],
    },
  },
  {
    name: 'go_back',
    description: 'Go back one entry in the tab history.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'press_key',
    description:
      'Press a key on the focused element. Allowed: Enter, Tab, Escape, Backspace, Delete, ArrowUp, ArrowDown, ArrowLeft, ArrowRight.',
    parameters: {
      type: 'object',
      properties: { keys: { type: 'string', description: 'Single key name, e.g. "Enter"' } },
      required: ['keys'],
    },
  },
  {
    name: 'capture_screenshot',
    description:
      'Capture the visible tab as an image when structure is not enough (canvas, charts, unusual layouts). The user sees this happen.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'finish_task',
    description:
      'End the task. Only call this when the page itself shows the outcome you were asked for — a successful click is not evidence.',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'What happened, and what evidence on the page confirms it.' },
        outcome: {
          type: 'string',
          description: 'done, blocked (needs the user) or failed.',
          enum: ['done', 'blocked', 'failed'],
        },
      },
      required: ['summary', 'outcome'],
    },
  },
];

const REQUIRED = {
  click_element: ['ref'],
  type_text: ['ref', 'text'],
  select_option: ['ref', 'value'],
  navigate: ['url'],
  press_key: ['keys'],
  find_on_page: ['query'],
  finish_task: ['summary', 'outcome'],
};

const NAMES = TOOLS.map((t) => t.name);

export function toolNames() {
  return NAMES.slice();
}

/**
 * Reject malformed proposals before they ever reach the browser.
 * @returns {{ok: true, args: object} | {ok: false, error: string}}
 */
export function validateAction(name, rawArgs) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { ok: false, error: `Unknown tool "${name}". Valid tools: ${NAMES.join(', ')}.` };
  }

  const args = rawArgs && typeof rawArgs === 'object' ? { ...rawArgs } : {};

  for (const key of REQUIRED[name] || []) {
    const v = args[key];
    if (v === undefined || v === null || v === '') {
      return { ok: false, error: `${name} requires the "${key}" argument.` };
    }
  }

  if (name === 'navigate' && !/^https?:\/\//i.test(String(args.url))) {
    return { ok: false, error: 'navigate only accepts absolute http(s) URLs.' };
  }

  if (name === 'press_key') {
    const allowed = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
    if (!allowed.includes(String(args.keys))) {
      return { ok: false, error: `press_key allows only: ${allowed.join(', ')}.` };
    }
  }

  if (name === 'finish_task' && !['done', 'blocked', 'failed'].includes(String(args.outcome))) {
    return { ok: false, error: 'finish_task outcome must be one of: done, blocked, failed.' };
  }

  if (name === 'scroll_page' && args.dy !== undefined) {
    const dy = Number(args.dy);
    if (!Number.isFinite(dy)) return { ok: false, error: 'scroll_page dy must be a number.' };
    args.dy = Math.max(-5000, Math.min(5000, dy));
  }

  for (const key of ['ref', 'text', 'value', 'url', 'keys', 'summary', 'query']) {
    if (typeof args[key] === 'string') args[key] = args[key].slice(0, 4000);
  }

  return { ok: true, args };
}
