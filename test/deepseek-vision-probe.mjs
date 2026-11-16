// Vision check with a real screenshot, since a 1x1 PNG is rejected as invalid
// and proves nothing about whether the model can see.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(join(HERE, '..', 'server', '.env'), 'utf8');
const KEY = /DEEPSEEK_API_KEY=(.+)/.exec(env)?.[1]?.trim();
const img = readFileSync(join(HERE, 'fixtures', 'screenshot.png')).toString('base64');

const res = await fetch('https://api.deepseek.com/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({
    model: process.argv[2] || 'deepseek-flash',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this screenshot in under 15 words.' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${img}` } },
        ],
      },
    ],
    max_tokens: 80,
    thinking: { type: 'disabled' },
  }),
});

const json = await res.json().catch(() => null);
console.log(
  JSON.stringify(
    {
      status: res.status,
      ms: null,
      answer: json?.choices?.[0]?.message?.content ?? null,
      error: json?.error?.message ?? null,
      bytes: Math.round((img.length * 3) / 4),
    },
    null,
    2,
  ),
);
