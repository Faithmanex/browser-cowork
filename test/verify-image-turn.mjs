// Proves the screenshot path still works now that the default provider is
// DeepSeek: an image attached to a turn must reach the model intact.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TOKEN = readFileSync(join(ROOT, 'server', '.token'), 'utf8').trim();
const BASE = process.env.BASE || 'http://127.0.0.1:8787';

const png = readFileSync(join(HERE, 'fixtures', 'screenshot.png'));

const started = Date.now();
const res = await fetch(`${BASE}/api/turn`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-copilot-token': TOKEN },
  body: JSON.stringify({
    message: 'You cannot click anything on this page. Look at the screenshot and tell me what the page is, in one sentence.',
    observation: 'URL: https://formatly.app\nTITLE: Formatly\nSCROLL: 0/0 (top)\n\n(no interactive elements)',
    image: { mime: 'image/png', data: png.toString('base64') },
  }),
});

const json = await res.json();
console.log(
  JSON.stringify(
    {
      status: res.status,
      ms: Date.now() - started,
      step: json.step,
      action: json.action?.name ?? null,
      text: (json.text || '').slice(0, 240),
      error: json.error ?? null,
      done: json.done,
    },
    null,
    2,
  ),
);
process.exit(res.ok ? 0 : 1);
