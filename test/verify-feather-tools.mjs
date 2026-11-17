// Checks the Feather tool surface: the app tools exist for surface=feather and
// are absent for a Chrome tab, and the live model actually reaches for
// open_panel when asked to add a view.
//
//   node test/verify-feather-tools.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = readFileSync(join(HERE, '..', 'server', '.token'), 'utf8').trim();
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const headers = { 'content-type': 'application/json', 'x-copilot-token': TOKEN };

const failed = [];
const check = (name, cond, detail) => {
  if (!cond) failed.push(`${name}${detail ? `: ${detail}` : ''}`);
};

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
check('health.lists feather tools', Array.isArray(health.featherTools), String(health.featherTools));
check('chrome surface has no app tools', !health.tools.includes('open_panel'), health.tools.join(','));
check('feather surface has app tools', health.featherTools.includes('open_panel'), JSON.stringify(health.featherTools));

const OBS = `PANEL: 1 "Vector" (sportybet)
PANELS: 1 "Vector" sportybet (focused) | 2 "08130857417" sportybet

URL: https://www.sportybet.com/ng/m
TITLE: SportyBet
SCROLL: y=0 of 0 (top, viewport 800)
INTERACTIVE:
e1 button "Deposit"

PAGE TEXT:
SportyBet mobile`;

const started = Date.now();
const reply = await fetch(`${BASE}/api/turn`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    surface: 'feather',
    message:
      'Open https://www.betano.ng/ live football in a new panel so I can watch the same match as the SportyBet tab.',
    observation: OBS,
  }),
}).then((r) => r.json());

if (reply.conversationId) {
  await fetch(`${BASE}/api/conversation/${reply.conversationId}`, { method: 'DELETE', headers }).catch(() => {});
}

const action = reply.action || {};
const args = action.args || {};

check('model used an app tool', action.name === 'open_panel' || action.name === 'list_accounts', `got ${action.name}`);
check(
  'opened a panel rather than a page action',
  action.name === 'open_panel',
  `got ${action.name} ${JSON.stringify(args)}`,
);
if (action.name === 'open_panel') {
  const url = String(args.url || '');
  check(
    'pointed at Betano',
    /betano/i.test(url) || Number.isFinite(Number(args.accountId)),
    JSON.stringify(args),
  );
}

/* --- multiple views: does it survey them rather than act on one blind? ---- */

const multi = await fetch(`${BASE}/api/turn`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    surface: 'feather',
    message:
      'Which of my open tabs are showing live football right now, and do any two of them have the same match?',
    observation: OBS,
  }),
}).then((r) => r.json());

if (multi.conversationId) {
  await fetch(`${BASE}/api/conversation/${multi.conversationId}`, { method: 'DELETE', headers }).catch(() => {});
}

const multiAction = multi.action?.name;
check(
  'surveyed the views instead of guessing',
  multiAction === 'survey_panels' || multiAction === 'read_panel' || multiAction === 'inspect_page',
  `got ${multiAction} ${JSON.stringify(multi.action?.args || {})}`,
);

console.log(
  JSON.stringify(
    {
      pass: failed.length === 0,
      failures: failed,
      totalMs: Date.now() - started,
      action,
      text: (reply.text || '').slice(0, 200),
    },
    null,
    2,
  ),
);
process.exitCode = failed.length === 0 ? 0 : 1;
