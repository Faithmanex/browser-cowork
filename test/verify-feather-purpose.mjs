// Does the agent understand what the app is for?
//
// The failure this guards against: being asked "setup 4 games on the vector
// account" and answering with a clarification question instead of doing the
// work. The Feather surface now carries an app-specific brief plus the account
// list, so the same instruction should produce an action.
//
//   node test/verify-feather-purpose.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { followSkill } from './lib/follow-skill.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = readFileSync(join(HERE, '..', 'server', '.token'), 'utf8').trim();
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const headers = { 'content-type': 'application/json', 'x-copilot-token': TOKEN };

const OBS = `PANEL: 3 "Vector" (sportybet)
ACCOUNTS: 1 "Football.com 1" football | 2 "08130857417" sportybet | 3 "Vector" sportybet | 4 "Betano" betano | 5 "Vector 2" sportybet
PANELS: 3 "Vector" sportybet (focused) | 4 "Betano" betano

URL: https://www.sportybet.com/ng/m
TITLE: SportyBet
SCROLL: y=0 of 0 (top, viewport 800)
VIEWPORT: 1000x800 CSS
INTERACTIVE:
e1 button "Football"
e2 button "My Bets"
e3 link "Live"

PAGE TEXT:
SportyBet mobile
Live football`;

const ASKS = /clarif|what do you mean|can you (please )?specif|could you (please )?(clarify|specify)|i need to (know|clarify)|which games do you mean|please provide more/i;

const failed = [];
const check = (name, cond, detail) => {
  if (!cond) failed.push(`${name}${detail ? `: ${detail}` : ''}`);
};

async function turn(message) {
  const first = await fetch(`${BASE}/api/turn`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ surface: 'feather', message, observation: OBS }),
  }).then((r) => r.json());

  // Loading the skill first is correct; judge the action after it.
  const reply = await followSkill(BASE, headers, first, OBS);

  if (reply.conversationId) {
    await fetch(`${BASE}/api/conversation/${reply.conversationId}`, { method: 'DELETE', headers }).catch(() => {});
  }
  return reply;
}

// 1. The exact instruction that previously stalled.
const a = await turn('setup 4 games on the vector account');
check('acted instead of stalling', Boolean(a.action), `action=${a.action?.name} text="${(a.text || '').slice(0, 120)}"`);
check('did not ask for clarification', !ASKS.test(a.text || ''), (a.text || '').slice(0, 160));
check('did not declare the task finished', a.action?.name !== 'finish_task', JSON.stringify(a.action?.args || {}));

// 2. With a stake given, it should also not ask.
const b = await turn('setup 4 games on the vector account, 10 naira each, stop before placing');
check('with a stake, still acts', Boolean(b.action), `action=${b.action?.name}`);
check('with a stake, no clarification', !ASKS.test(b.text || ''), (b.text || '').slice(0, 160));

// 3. "Same game on both sites" should reach for a panel, not a page action.
const c = await turn('open the same match on betano that is showing on the sportybet tab');
check('same-game request acts', Boolean(c.action), `action=${c.action?.name}`);
check(
  'same-game request targets a panel',
  ['survey_panels', 'read_panel', 'inspect_page', 'open_panel', 'navigate', 'focus_panel'].includes(c.action?.name),
  `got ${c.action?.name}`,
);

console.log(
  JSON.stringify(
    {
      pass: failed.length === 0,
      failures: failed,
      first: { action: a.action?.name, args: a.action?.args, text: (a.text || '').slice(0, 200) },
      second: { action: b.action?.name, args: b.action?.args },
      third: { action: c.action?.name, args: c.action?.args },
    },
    null,
    2,
  ),
);

process.exitCode = failed.length === 0 ? 0 : 1;
