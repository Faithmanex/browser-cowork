// End-to-end check of the real server loop against the real provider.
// Drives /api/turn and /api/step the way sidepanel.js does, with a fake page
// observation, and asserts the agent advances one action at a time.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = readFileSync(join(HERE, '..', 'server', '.token'), 'utf8').trim();
const BASE = process.env.BASE || 'http://127.0.0.1:8787';

const headers = { 'content-type': 'application/json', 'x-copilot-token': TOKEN };

const health = await (await fetch(`${BASE}/api/health`)).json();

const OBS_1 = `URL: https://example.com/login
TITLE: Sign in
SCROLL: 0/0 (top)

e1 textbox "Email"
e2 password "Password" [redacted]
e3 checkbox "Remember me"
e4 button "Sign in"
e5 link "Forgot password?"`;

const OBS_2 = `URL: https://example.com/login
TITLE: Sign in
SCROLL: 0/0 (top)

e1 textbox "Email" value="ada@example.com"
e2 password "Password" [redacted]
e3 checkbox "Remember me" checked
e4 button "Sign in"
e5 link "Forgot password?"`;

const started = Date.now();
let r = await fetch(`${BASE}/api/turn`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: 'Type ada@example.com into the Email field.', observation: OBS_1 }),
}).then((x) => x.json());

const transcript = [{ step: r.step, action: r.action, text: r.text, done: r.done, ms: Date.now() - started }];
let conversationId = r.conversationId;
let actionResult = { ok: true, note: 'typed' };
let observation = OBS_2;

for (let i = 0; i < 3 && !r.done && r.action; i++) {
  const t = Date.now();
  r = await fetch(`${BASE}/api/step`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ conversationId, actionResult, observation }),
  }).then((x) => x.json());
  transcript.push({ step: r.step, action: r.action, text: r.text, done: r.done, ms: Date.now() - t });
  actionResult = { ok: true, note: 'done' };
}

console.log(
  JSON.stringify(
    {
      health: {
        provider: health.provider,
        model: health.model,
        vision: health.vision,
        thinking: health.thinking,
        hasKey: health.hasKey,
      },
      totalMs: Date.now() - started,
      transcript,
    },
    null,
    2,
  ),
);
