// A follow-up message must continue the current task, not start a new one.
//
// The failure this guards: a run stops after N steps, the user says "you had to
// zoom out", and the agent answers "I don't have the earlier context for this
// task" — because /api/turn created a new conversation. /api/message keeps the
// history and resets only the step budget.
//
//   node test/verify-feather-continue.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = readFileSync(join(HERE, '..', 'server', '.token'), 'utf8').trim();
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const headers = { 'content-type': 'application/json', 'x-copilot-token': TOKEN };

const OBS = `PANEL: 10 "Vector" (sportybet)
ACCOUNTS: 3 "Vector" sportybet | 4 "Betano" betano
PANELS: 10 "Vector" sportybet (focused)

URL: https://www.sportybet.com/ng/m
TITLE: SportyBet
SCROLL: y=0 of 0 (top, viewport 800)
VIEWPORT: 1000x800 CSS
INTERACTIVE:
e1 button "Football"
e2 button "My Bets"

PAGE TEXT:
SportyBet mobile`;

const LOST_CONTEXT =
  /don'?t have (the )?(earlier|previous) context|no (earlier|previous) context|start of (this|the) session|i (do not|don't) have access to (the )?(earlier|previous)/i;

const failed = [];
const check = (name, cond, detail) => {
  if (!cond) failed.push(`${name}${detail ? `: ${detail}` : ''}`);
};

const post = (path, body) =>
  fetch(`${BASE}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }).then((r) => r.json());

// 1. Start a task.
const first = await post('/api/turn', {
  surface: 'feather',
  message: 'setup 4 games on the vector account',
  observation: OBS,
});
check('turn started', Boolean(first.conversationId), JSON.stringify(first).slice(0, 120));

// 2. Same task, new instruction: the missing piece the user gave after a stop.
const followUp = await post('/api/message', {
  conversationId: first.conversationId,
  message: 'you had to zoom out',
  observation: OBS,
});
check(
  'same conversation',
  followUp.conversationId === first.conversationId,
  `${first.conversationId} → ${followUp.conversationId}`,
);
check('did not claim lost context', !LOST_CONTEXT.test(followUp.text || ''), (followUp.text || '').slice(0, 160));
check('acted on the follow-up', Boolean(followUp.action), `action=${followUp.action?.name}`);

const zoomish =
  followUp.action?.name === 'set_zoom' ||
  /zoom/i.test(followUp.text || '') ||
  ['inspect_page', 'survey_panels', 'read_panel', 'scroll_page'].includes(followUp.action?.name || '');
check('connected "zoom out" to something', zoomish, `${followUp.action?.name} / ${(followUp.text || '').slice(0, 120)}`);

// 3. History is really there: ask it to recall the task.
const recall = await post('/api/message', {
  conversationId: first.conversationId,
  message: 'In one line, remind me what my task was before this message.',
  observation: OBS,
});
check(
  'remembered the earlier instruction',
  /(4|four)\s*games|vector/i.test(recall.text || ''),
  (recall.text || '').slice(0, 200),
);

await fetch(`${BASE}/api/conversation/${first.conversationId}`, { method: 'DELETE', headers }).catch(() => {});

console.log(
  JSON.stringify(
    {
      pass: failed.length === 0,
      failures: failed,
      followUp: { action: followUp.action?.name, args: followUp.action?.args, text: (followUp.text || '').slice(0, 200) },
      recall: (recall.text || '').slice(0, 200),
    },
    null,
    2,
  ),
);

process.exitCode = failed.length === 0 ? 0 : 1;
