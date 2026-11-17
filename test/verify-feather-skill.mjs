// Does the model use the skill mechanism properly: load on demand?
//
// With progressive disclosure the system prompt only lists name + description.
// A question that needs the procedure should produce use_skill (and, if the
// detail is in a reference, read_skill after it), not an answer from guesswork.
//
//   node test/verify-feather-skill.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = readFileSync(join(HERE, '..', 'server', '.token'), 'utf8').trim();
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const headers = { 'content-type': 'application/json', 'x-copilot-token': TOKEN };

const OBS = `PANEL: 3 "Vector" (sportybet)
ACCOUNTS: 3 "Vector" sportybet
SETTINGS: sync_scroll=on auto_login=on auto_rebet=off
PANELS: 3 "Vector" sportybet (focused)

URL: https://www.sportybet.com/ng/m
TITLE: SportyBet
SCROLL: y=0 of 0 (top, viewport 800)
INTERACTIVE:
e1 button "Football"

PAGE TEXT:
SportyBet mobile`;

const failed = [];
const check = (name, cond, detail) => {
  if (!cond) failed.push(`${name}${detail ? `: ${detail}` : ''}`);
};

const turn = (message) =>
  fetch(`${BASE}/api/turn`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ surface: 'feather', message, observation: OBS }),
  }).then((r) => r.json());

// 1. A procedural question should make it load the skill.
const a = await turn(
  'Before doing anything else: what are the exact steps for setting up a game here, and what should you check if a market says it failed to load?',
);
check('loaded a skill', ['use_skill', 'read_skill'].includes(a.action?.name), `got ${a.action?.name}`);
check('asked for the right skill', a.action?.args?.name === 'feather-bet-setup', JSON.stringify(a.action?.args));

// 2. The endpoint serves the body and a reference.
const body = await fetch(`${BASE}/api/skill`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: 'feather-bet-setup' }),
}).then((r) => r.json());
check('skill body served', body.ok && /operating manual/i.test(body.text || ''), String(body.error || ''));

const ref = await fetch(`${BASE}/api/skill`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: 'feather-bet-setup', file: 'references/hud.md' }),
}).then((r) => r.json());
check('reference served', ref.ok && /market failed to load/i.test(ref.text || ''), String(ref.error || ''));

if (a.conversationId) {
  await fetch(`${BASE}/api/conversation/${a.conversationId}`, { method: 'DELETE', headers }).catch(() => {});
}

console.log(
  JSON.stringify(
    {
      pass: failed.length === 0,
      failures: failed,
      action: a.action?.name,
      args: a.action?.args,
      text: (a.text || '').slice(0, 160),
    },
    null,
    2,
  ),
);

process.exitCode = failed.length === 0 ? 0 : 1;
