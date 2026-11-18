// The action vocabulary exposed to the model. Narrow on purpose: every tool is
// implemented in application code, nothing here is a general escape hatch.
//
// Key validation is shared with execution (lib/input.js), so the server cannot
// accept a combo the worker would refuse to send.
import { parseKeyCombo } from '../lib/input.js';
import { listSkills } from './skills.js';

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
    name: 'hover',
    description:
      'Move the pointer onto an element or point without clicking, to open tooltips, hover menus and reveal-on-hover controls. Hovering changes the page, so look again afterwards if a menu appeared.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref, e.g. e12' },
        x: { type: 'number', description: 'CSS-pixel x, if not using a ref' },
        y: { type: 'number', description: 'CSS-pixel y, if not using a ref' },
      },
    },
  },
  {
    name: 'click_at',
    description:
      'Click a viewport coordinate instead of an element: for canvas/WebGL interfaces (video editors, maps, design tools) and for anything inside a frame that is not listed. Coordinates are CSS pixels; with from_image=true pass the pixel you read off a screenshot and it is converted for you.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'x coordinate' },
        y: { type: 'number', description: 'y coordinate' },
        from_image: {
          type: 'boolean',
          description: 'true when x,y come from a screenshot image rather than CSS pixels.',
        },
        double: { type: 'boolean', description: 'Double-click instead of a single click.' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifiers to hold, e.g. ["shift"] or ["ctrl"].',
        },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'drag',
    description:
      'Press, move and release between two points: dragging timeline clips, trimming handles, moving items into a bin, slider handles, canvas selection boxes. Either end may be a ref or a coordinate.',
    parameters: {
      type: 'object',
      properties: {
        from_ref: { type: 'string', description: 'Ref to press on, e.g. e12' },
        to_ref: { type: 'string', description: 'Ref to release on' },
        from_x: { type: 'number', description: 'CSS-pixel x to press on, if not using from_ref' },
        from_y: { type: 'number', description: 'CSS-pixel y to press on' },
        to_x: { type: 'number', description: 'CSS-pixel x to release on, if not using to_ref' },
        to_y: { type: 'number', description: 'CSS-pixel y to release on' },
        steps: { type: 'number', description: 'Intermediate moves along the path (default 12, max 60).' },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Modifiers to hold for the whole drag, e.g. ["shift"] to extend a selection.',
        },
      },
    },
  },
  {
    name: 'set_range',
    description:
      'Set a slider to a value. Works on native range inputs (volume, zoom, scrubbers); for custom ARIA sliders, drag the handle or click the track with click_at instead.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Ref of the slider element' },
        value: { type: 'number', description: 'Target value within the slider range' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'click_element',
    description:
      'Click an element observed in the current observation, by its ref. Dispatches to the element itself (a DOM click), so an overlay cannot intercept it and a re-rendered row cannot move out from under it — use this for every click on something with a ref. Pass real:true only when the hit-test is the point (checking what a person would actually hit); a real click is refused when the target is covered, and the message says how to clear the blocker.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the current observation, e.g. e12' },
        double: { type: 'boolean', description: 'Double-click instead of a single click.' },
        real: {
          type: 'boolean',
          description:
            'Coordinate click through the platform input path instead of the DOM. Respects hit-testing, so it is refused when something covers the target. Default false.',
        },
        dom: {
          type: 'boolean',
          description:
            'Deprecated alias: dom:false means the same as real:true. The DOM click is the default; there is no need to pass this.',
        },
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
    description:
      'Scroll vertically or horizontally, optionally at a point so inner containers (a timeline, a side panel) scroll rather than the document.',
    parameters: {
      type: 'object',
      properties: {
        dy: { type: 'number', description: 'Vertical pixels, e.g. 600 or -600' },
        dx: { type: 'number', description: 'Horizontal pixels, e.g. 400 or -400' },
        x: { type: 'number', description: 'CSS-pixel x to put the pointer before scrolling' },
        y: { type: 'number', description: 'CSS-pixel y to put the pointer before scrolling' },
      },
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
      'Press a key or chord on the focused element. Letters, digits, Space, Enter, Tab, Escape, Backspace, Delete, Home/End/PageUp/PageDown, arrows, F1-F12, with ctrl/cmd/alt/shift — e.g. "ctrl+z", "ctrl+shift+z", "shift+Tab", "space".',
    parameters: {
      type: 'object',
      properties: { keys: { type: 'string', description: 'Key or chord, e.g. "Enter" or "ctrl+z"' } },
      required: ['keys'],
    },
  },
  {
    name: 'capture_screenshot',
    description:
      'Capture the visible tab as an image when structure is not enough (canvas, charts, unusual layouts). Coordinates you read off the image can be passed to click_at with from_image=true. The user sees this happen.',
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
  click_at: ['x', 'y'],
  set_range: ['ref', 'value'],
  read_panel: ['panelId'],
  bind_market: ['marketKey', 'panelId'],
  finish_task: ['summary', 'outcome'],
};

// Tools that only exist inside the Feather app: it has panels to open, focus,
// reorder and navigate, which a single Chrome tab does not.
export const APP_TOOLS = [
  {
    name: 'list_accounts',
    description:
      'List the workspace accounts (id, label, site) so you can open the right logged-in views.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'open_panel',
    description:
      "Open another view: an existing account by accountId, or a URL in a new panel. The new panel appears in the next observation's PANELS line.",
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL to open in a new panel' },
        accountId: { type: 'number', description: 'Open this configured account instead of a URL' },
        label: { type: 'string', description: 'Short name for the new panel' },
      },
    },
  },
  {
    name: 'focus_panel',
    description: 'Focus a view so it is the one shown to the user.',
    parameters: {
      type: 'object',
      properties: { panelId: { type: 'number', description: 'Panel id from the PANELS line' } },
      required: ['panelId'],
    },
  },
  {
    name: 'close_panel',
    description: 'Close a view.',
    parameters: {
      type: 'object',
      properties: { panelId: { type: 'number' } },
      required: ['panelId'],
    },
  },
  {
    name: 'use_skill',
    description:
      "Load a skill's instructions by name. Call this before working in an area a skill covers — for example before setting up games in Feather.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name from the available list, e.g. feather-bet-setup' },
      },
      required: ['name'],
    },
  },
  {
    name: 'read_skill',
    description:
      "Read one reference file of a skill after loading it, for example references/hud.md. Ask for a file the skill lists; it will tell you which exist.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Skill name' },
        file: { type: 'string', description: 'e.g. references/app.md' },
      },
      required: ['name'],
    },
  },
  {
    name: 'set_setting',
    description:
      'Change a workspace setting, for example turning off sync scroll so scrolling one panel stops moving all of them. Returns the settings after the change. Keys: syncScroll, directBet, autoLogin, autoRebet (booleans); maxStake, minStake, resetIntervalMs (numbers).',
    parameters: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'syncScroll | directBet | autoLogin | autoRebet | maxStake | minStake | resetIntervalMs',
        },
        value: { description: 'Boolean for toggles (true/false), number for stakes and intervals.' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'survey_panels',
    description:
      'Compact summary of every open view: id, label, site, URL, title, the fixture it is on (MATCH), its HUD stage, whether it is already bound and to what, and its first few elements. Use this to plan across views without reading each one in full.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'read_panel',
    description:
      'Read another view in full (or only what changed since it was last read) without switching to it. Page tools accept panelId, so you can act on that view next.',
    parameters: {
      type: 'object',
      properties: {
        panelId: { type: 'number', description: 'Panel id from the PANELS line' },
        full: { type: 'boolean', description: 'Force a full observation instead of a diff.' },
      },
      required: ['panelId'],
    },
  },
  {
    name: 'panel_summary',
    description:
      'One SportyBet panel in one short call: fixture, HUD stage, bound market and its key, home/away odds, stake, slip count, whether a Confirm to Pay sheet is open. Use this instead of reading a whole observation to check whether a panel is bound.',
    parameters: {
      type: 'object',
      properties: { panelId: { type: 'number', description: 'Which view' } },
    },
  },
  {
    name: 'bind_market',
    description:
      'Bind a market on a SportyBet panel by its market key (market-8 is the goal market), through the HUD rather than by clicking a card. Returns what was actually bound, with its odds, or the keys this page does have when the requested one is not mounted. Always verify the returned marketKey before touching sides or stake.',
    parameters: {
      type: 'object',
      properties: {
        panelId: { type: 'number', description: 'Which view' },
        marketKey: { type: 'string', description: 'e.g. market-8' },
        title: {
          type: 'string',
          description:
            'Optional title to require, e.g. "1st Goal". Use it when a page carries several cards under one key.',
        },
      },
      required: ['marketKey', 'panelId'],
    },
  },
  {
    name: 'list_live_fixtures',
    description:
      'Rows from a live list: home, away, score, clock, period, the extra markets the row offers, and nextGoal. Use it to pick a fixture that can still carry a goal market, instead of reading a screenshot of a collapsed list.',
    parameters: {
      type: 'object',
      properties: { panelId: { type: 'number', description: 'Which view, on a /live or /live_list page' } },
    },
  },
  {
    name: 'set_zoom',
    description:
      'Zoom a view. factor is a multiplier (0.8 makes it smaller); fit:true picks the zoom that makes the page about target CSS pixels wide, which is how to compensate when the dock has narrowed the panels.',
    parameters: {
      type: 'object',
      properties: {
        panelId: { type: 'number', description: 'Which panel; defaults to the view you last worked on' },
        factor: { type: 'number', description: 'Zoom multiplier, 0.25 to 3' },
        fit: { type: 'boolean', description: 'Fit the page to a target CSS width' },
        target: { type: 'number', description: 'CSS pixels to fit when fit is true (default 1000)' },
      },
    },
  },
  {
    name: 'reload_panel',
    description: 'Reload a panel.',
    parameters: {
      type: 'object',
      properties: { panelId: { type: 'number' } },
    },
  },
  {
    name: 'reorder_panel',
    description: 'Move a panel so it sits before another one in the view strip.',
    parameters: {
      type: 'object',
      properties: {
        panelId: { type: 'number' },
        beforePanelId: { type: 'number' },
      },
      required: ['panelId', 'beforePanelId'],
    },
  },
];

const NAMES = TOOLS.map((t) => t.name);
const FEATHER_NAMES = new Set([...NAMES, ...APP_TOOLS.map((t) => t.name)]);

/** Tools offered to a surface: a Chrome tab gets page tools, Feather gets app
 *  tools too. Keeping them separate means the extension is never offered a
 *  tool it cannot execute. */
export function toolsFor(surface) {
  return surface === 'feather' ? [...TOOLS, ...APP_TOOLS] : TOOLS;
}

export function toolNames(surface) {
  return toolsFor(surface).map((t) => t.name);
}

/**
 * Reject malformed proposals before they ever reach the browser.
 * @returns {{ok: true, args: object} | {ok: false, error: string}}
 */
export function validateAction(name, rawArgs, allowed) {
  const vocabulary = allowed ? new Set(allowed) : FEATHER_NAMES;
  const tool = [...TOOLS, ...APP_TOOLS].find((t) => t.name === name);
  if (!tool || !vocabulary.has(name)) {
    return {
      ok: false,
      error: `Unknown tool "${name}". Valid tools: ${[...vocabulary].join(', ')}.`,
    };
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

  if (name === 'open_panel') {
    if (args.url !== undefined && !/^https?:\/\//i.test(String(args.url))) {
      return { ok: false, error: 'open_panel url must be an absolute http(s) URL.' };
    }
    if (args.url === undefined && args.accountId === undefined) {
      return { ok: false, error: 'open_panel needs a url or an accountId.' };
    }
    if (args.accountId !== undefined && !Number.isFinite(Number(args.accountId))) {
      return { ok: false, error: 'open_panel accountId must be a number.' };
    }
  }

  if (name === 'set_zoom') {
    if (args.fit === true) {
      const target = Number(args.target ?? 1000);
      if (!Number.isFinite(target) || target <= 0) {
        return { ok: false, error: 'set_zoom target must be a positive CSS width.' };
      }
      args.target = Math.round(target);
    } else {
      const factor = Number(args.factor);
      if (!Number.isFinite(factor) || factor <= 0) {
        return { ok: false, error: 'set_zoom needs a positive factor, or fit:true.' };
      }
      args.factor = Math.min(3, Math.max(0.25, factor));
    }
  }

  if (name === 'use_skill' || name === 'read_skill') {
    const skillName = String(args.name || '');
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) {
      // Name the tool actually called and the skills that exist. The old text
      // said "use_skill" for read_skill too, which read as a contradiction and
      // sent the model into a retry loop.
      const known = listSkills()
        .map((s) => s.name)
        .join(', ');
      const got = skillName ? `"${skillName}" is not a skill name` : 'the name argument is missing';
      return { ok: false, error: `${name}: ${got}. Use one of: ${known || '(none installed)'}.` };
    }
    if (name === 'read_skill' && args.file !== undefined && !/^references\/[a-z0-9-]+\.md$/.test(String(args.file))) {
      return { ok: false, error: 'read_skill file must look like references/app.md.' };
    }
  }

  if (name === 'set_setting') {
    const keys = new Set([
      'syncScroll',
      'directBet',
      'autoLogin',
      'autoRebet',
      'maxStake',
      'minStake',
      'rebetEnabled',
      'resetIntervalMs',
    ]);
    if (!keys.has(String(args.key))) {
      return { ok: false, error: `set_setting key must be one of: ${[...keys].join(', ')}.` };
    }
    if (typeof args.value !== 'boolean' && !Number.isFinite(Number(args.value))) {
      return { ok: false, error: 'set_setting value must be a boolean or a number.' };
    }
  }

  for (const key of ['panelId', 'beforePanelId']) {
    if (args[key] !== undefined && !Number.isFinite(Number(args[key]))) {
      return { ok: false, error: `${name} ${key} must be a number.` };
    }
    if (args[key] !== undefined) args[key] = Number(args[key]);
  }

  if (name === 'press_key' && !parseKeyCombo(String(args.keys))) {
    return {
      ok: false,
      error: `press_key cannot send "${args.keys}". Use a letter, digit, Space, Enter, Tab, Escape, Backspace, Delete, Home/End/PageUp/PageDown, an arrow, F1-F12, optionally with ctrl/cmd/alt/shift.`,
    };
  }

  if (name === 'click_at') {
    if (!Number.isFinite(Number(args.x)) || !Number.isFinite(Number(args.y))) {
      return { ok: false, error: 'click_at needs numeric x and y.' };
    }
    args.x = Math.round(Number(args.x));
    args.y = Math.round(Number(args.y));
  }

  if (name === 'drag') {
    const hasFrom = Boolean(args.from_ref) || (args.from_x != null && args.from_y != null);
    const hasTo = Boolean(args.to_ref) || (args.to_x != null && args.to_y != null);
    if (!hasFrom || !hasTo) {
      return {
        ok: false,
        error: 'drag needs a start (from_ref, or from_x and from_y) and an end (to_ref, or to_x and to_y).',
      };
    }
    if (args.steps !== undefined) {
      const steps = Number(args.steps);
      if (!Number.isFinite(steps)) return { ok: false, error: 'drag steps must be a number.' };
      args.steps = Math.max(1, Math.min(60, Math.round(steps)));
    }
  }

  if (name === 'hover' && !args.ref && (args.x == null || args.y == null)) {
    return { ok: false, error: 'hover needs either a ref, or both x and y.' };
  }

  if (name === 'set_range') {
    if (!Number.isFinite(Number(args.value))) {
      return { ok: false, error: 'set_range value must be a number.' };
    }
    args.value = Number(args.value);
  }

  if (name === 'scroll_page') {
    for (const key of ['dy', 'dx', 'x', 'y']) {
      if (args[key] === undefined || args[key] === null || args[key] === '') continue;
      const n = Number(args[key]);
      if (!Number.isFinite(n)) return { ok: false, error: `scroll_page ${key} must be a number.` };
      args[key] = key === 'dy' || key === 'dx' ? Math.max(-5000, Math.min(5000, n)) : Math.round(n);
    }
  }

  if (name === 'finish_task' && !['done', 'blocked', 'failed'].includes(String(args.outcome))) {
    return { ok: false, error: 'finish_task outcome must be one of: done, blocked, failed.' };
  }

  for (const key of ['ref', 'from_ref', 'to_ref', 'text', 'value', 'url', 'keys', 'summary', 'query', 'label']) {
    if (typeof args[key] === 'string') args[key] = args[key].slice(0, 4000);
  }

  // Modifier arrays: cap length and the size of each name.
  for (const key of ['keys']) {
    if (Array.isArray(args[key])) {
      args[key] = args[key].slice(0, 4).map((k) => String(k).slice(0, 20));
    }
  }

  return { ok: true, args };
}
