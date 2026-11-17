// Stopping mid-run must not poison the conversation.
//
// The bug: Stop aborted the dock's request, the server kept computing, and the
// queued follow-up started a second step on the same conversation. Two steps
// appended to one history, so an assistant tool call ended up after its own
// result. The provider then rejected every later turn with "an assistant message
// with 'tool_calls' must be followed by tool messages" — permanently.
//
// This drives the real server: a turn, then a step that is abandoned mid-flight
// with a follow-up fired straight behind it, then another turn.
//
//   node test/verify-stop-resume.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = readFileSync(join(HERE, '..', 'server', '.token'), 'utf8').trim();
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const headers = { 'content-type': 'application/json', 'x-copilot-token': TOKEN };

const OBS = `PANEL: 3 "Vector" (sportybet)
SETTINGS: sync_scroll=on auto_login=on auto_rebet=off
PANELS: 3 "Vector" sportybet (focused)

URL: https://www.sportybet.com/ng/m
TITLE: SportyBet
MATCH: Arsenal vs Chelsea
SCROLL: y=0 of 0 (top, viewport 800)
INTERACTIVE:
e1 link "Football"
e2 button "Live"

PAGE TEXT:
SportyBet mobile`;

const failed = [];
const check = (name, cond, detail) => {
  if (!cond) failed.push(`${name}${detail ? `: ${detail}` : ''}`);
};

const post = async (path, body, signal) => {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const historyError = (text) => /tool_calls|insufficient tool messages|must be followed by tool/i.test(text);

// 1. Open a conversation and make the model propose an action.
const turn = await post('/api/turn', {
  surface: 'feather',
  message: 'Click the Football link.',
  observation: OBS,
});
const id = turn.body.conversationId;
check('turn returned a conversation', Boolean(id), JSON.stringify(turn.body).slice(0, 200));
check('turn produced no history error', !historyError(JSON.stringify(turn.body)));

if (!id) {
  console.log(JSON.stringify({ pass: false, failures: failed }, null, 2));
  process.exit(1);
}

// 2. Answer it, but abort mid-flight — this is Stop.
const ctrl = new AbortController();
const abandoned = post(
  '/api/step',
  { conversationId: id, actionResult: { ok: true, clicked: 'Football' }, observation: OBS },
  ctrl.signal,
).catch((err) => ({ aborted: true, body: { error: err.message } }));

setTimeout(() => ctrl.abort(), 250);

// 3. The message that was typed while it ran.
const followUp = await post('/api/message', {
  conversationId: id,
  message: 'zoom out to 0.4',
  observation: OBS,
});

const a = await abandoned;
check('the abandoned step did not surface a history error', !historyError(JSON.stringify(a.body)));
check('the follow-up succeeded', followUp.status === 200, `status ${followUp.status}`);
check(
  'the follow-up did not surface a history error',
  !historyError(JSON.stringify(followUp.body)),
  JSON.stringify(followUp.body).slice(0, 300),
);

// 4. And the conversation still works afterwards — the old bug made this fail
//    for the rest of its life.
const after = await post('/api/message', {
  conversationId: id,
  message: 'which fixture is this panel on?',
  observation: OBS,
});

check('the conversation is still usable', after.status === 200, `status ${after.status}`);
check(
  'no history error after the stop',
  !historyError(JSON.stringify(after.body)),
  JSON.stringify(after.body).slice(0, 300),
);

await fetch(`${BASE}/api/conversation/${id}`, { method: 'DELETE', headers }).catch(() => {});

console.log(
  JSON.stringify(
    {
      pass: failed.length === 0,
      failures: failed,
      turn: turn.body.action?.name || turn.body.text?.slice(0, 60),
      followUp: followUp.body.action?.name || followUp.body.text?.slice(0, 60),
      after: after.body.action?.name || after.body.text?.slice(0, 60),
    },
    null,
    2,
  ),
);

process.exitCode = failed.length === 0 ? 0 : 1;
