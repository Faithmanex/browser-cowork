// Can the live model drive a canvas editor through coordinates?
//
// The observation describes a timeline in page text only — no elements, like a
// real canvas editor — and the task is a drag. What is being checked is whether
// the model reaches for drag/click_at with sensible coordinates instead of
// asking for a ref that does not exist.
//
//   node test/verify-editor-loop.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = readFileSync(join(HERE, '..', 'server', '.token'), 'utf8').trim();
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const headers = { 'content-type': 'application/json', 'x-copilot-token': TOKEN };

const TASK =
  'In the timeline, drag the clip "Intro" so its left edge moves from x=120 to x=420. Keep it on the same track.';

const OBS_BEFORE = `URL: https://editor.test/project
TITLE: Project — Editor
SCROLL: y=0 of 0 (top, viewport 800)
VIEWPORT: 1000x800 CSS
INTERACTIVE:
e1 button "Play"
e2 slider "Zoom" value="50" min="0" max="100"
e3 button "Add track"

PAGE TEXT:
Timeline
Track 1: clip "Intro" drawn on a canvas, spanning x=120..280 at y=300
Track 2: empty
The timeline is a canvas; clips are not DOM elements.`;

const OBS_AFTER = `URL: https://editor.test/project
TITLE: Project — Editor
SCROLL: y=0 of 0 (top, viewport 800)
INTERACTIVE:
e1 button "Play"
e2 slider "Zoom" value="50" min="0" max="100"
e3 button "Add track"

PAGE TEXT:
Timeline
Track 1: clip "Intro" drawn on a canvas, spanning x=420..580 at y=300
Track 2: empty
The timeline is a canvas; clips are not DOM elements.`;

const failed = [];
const check = (name, cond, detail) => {
  if (!cond) failed.push(`${name}${detail ? `: ${detail}` : ''}`);
};

const started = Date.now();
let reply = await fetch(`${BASE}/api/turn`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: TASK, observation: OBS_BEFORE }),
}).then((r) => r.json());

const actions = [];
const conversationId = reply.conversationId;

// The page only changes if a drag actually happened. Serving the "after" state
// regardless is worse than a failing test: the model would then be telling the
// truth about a page we invented.
let dragged = false;

for (let i = 0; i < 5 && !reply.done && reply.action; i++) {
  const action = reply.action;
  actions.push({ name: action.name, args: action.args });

  let result;
  if (action.name === 'drag') {
    dragged = true;
    result = { ok: true, via: 'cdp', from: { x: 200, y: 320 }, to: { x: 500, y: 320 } };
  } else if (action.name === 'click_at') {
    result = { ok: true, via: 'cdp', clicked: { x: action.args.x, y: action.args.y } };
  } else if (action.name === 'capture_screenshot') {
    // No real tab here, so say so rather than returning a note that implies an
    // image was attached — that is what sent the model in circles last time.
    result = {
      ok: false,
      error: 'This harness has no screen to capture. The timeline is described in the page text; act on those coordinates.',
    };
  } else if (action.name === 'find_on_page') {
    result = { ok: true, count: 0, matches: [] };
  } else if (action.name === 'inspect_page') {
    result = { ok: true, snapshot: dragged ? OBS_AFTER : OBS_BEFORE };
  } else if (action.name === 'finish_task') break;
  else result = { ok: false, error: `The harness cannot run ${action.name}.` };

  reply = await fetch(`${BASE}/api/step`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversationId,
      actionResult: result,
      observation: dragged ? OBS_AFTER : OBS_BEFORE,
    }),
  }).then((r) => r.json());
}

await fetch(`${BASE}/api/conversation/${conversationId}`, { method: 'DELETE', headers }).catch(() => {});

/* ------------------------------------------------------------- assertions */

const first = actions[0] || {};
const drag = actions.find((a) => a.name === 'drag');
const dragIndex = actions.findIndex((a) => a.name === 'drag');

check('used drag, not a ref-based tool', Boolean(drag), `actions: ${actions.map((a) => a.name).join(' → ')}`);
check('dragged before wandering', dragIndex >= 0 && dragIndex <= 2, `drag was action ${dragIndex + 1}`);
check('did not invent an element ref', !actions.some((a) => a.name === 'click_element'), JSON.stringify(actions.map((a) => a.name)));

if (drag) {
  const a = drag.args || {};
  const fromX = Number(a.from_x);
  const fromY = Number(a.from_y ?? a.to_y);
  const toX = Number(a.to_x);
  const toY = Number(a.to_y ?? a.from_y);

  // The clip spans x=120..280. Any point on it is a valid grab: pressing the
  // middle and moving it +300 is correct and does not trim the clip.
  check(
    'pressed inside the clip (x 120..280)',
    Number.isFinite(fromX) && fromX >= 110 && fromX <= 290,
    `from_x=${a.from_x}`,
  );
  check(
    'stayed on the clip track (y≈300)',
    Number.isFinite(fromY) && fromY >= 260 && fromY <= 340 && Number.isFinite(toY) && toY >= 260 && toY <= 340,
    `y=${a.from_y} → ${a.to_y}`,
  );
  check(
    'moved it right by the requested 300px',
    Number.isFinite(toX) && Math.abs(toX - fromX - 300) <= 60,
    `from ${a.from_x} to ${a.to_x} = ${toX - fromX}`,
  );
  check('dragged rightwards', toX > fromX, `${a.from_x} → ${a.to_x}`);
}

check('finished the task', Boolean(reply.done), `ended on ${reply.action?.name}`);

console.log(
  JSON.stringify(
    {
      pass: failed.length === 0,
      failures: failed,
      totalMs: Date.now() - started,
      actions,
      summary: reply.text?.slice(0, 300) || null,
    },
    null,
    2,
  ),
);

process.exit(failed.length === 0 ? 0 : 1);
