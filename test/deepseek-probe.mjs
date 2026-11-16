// Probes the live DeepSeek API for the facts this agent depends on:
// which base URL works, whether tool calling works, whether thinking mode
// requires reasoning_content to be echoed back, and whether vision works.
//
//   node test/deepseek-probe.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(join(HERE, '..', 'server', '.env'), 'utf8');
const KEY = /DEEPSEEK_API_KEY=(.+)/.exec(env)?.[1]?.trim();
if (!KEY) throw new Error('DEEPSEEK_API_KEY missing from server/.env');

const MODEL = process.argv[2] || 'deepseek-flash';
const results = {};

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'click_element',
      description: 'Click one element on the page by its ref.',
      parameters: {
        type: 'object',
        properties: { ref: { type: 'string', description: 'Element ref such as e12' } },
        required: ['ref'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish_task',
      description: 'Stop and report the outcome.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
];

async function post(base, body) {
  const started = Date.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error page */
  }
  return { status: res.status, ms: Date.now() - started, json, text: json ? null : text.slice(0, 300) };
}

const SYS = 'You operate a browser. One action per step.';
const OBS = '<observation>\nURL: https://example.com\nTITLE: Example\ne12 button "Sign in"\ne15 textbox "Search"\n</observation>';

// --- 1. which base URL works ------------------------------------------------
for (const base of ['https://api.deepseek.com', 'https://api.deepseek.com/v1']) {
  const r = await post(base, {
    model: MODEL,
    messages: [{ role: 'user', content: 'hi' }],
    max_tokens: 8,
    thinking: { type: 'disabled' },
  });
  results[`base ${base}`] = { status: r.status, ms: r.ms, error: r.json?.error?.message ?? r.text };
}

const BASE = 'https://api.deepseek.com';

// --- 2. tool calling, thinking disabled, timed ------------------------------
const solo = await post(BASE, {
  model: MODEL,
  messages: [
    { role: 'system', content: SYS },
    { role: 'user', content: `Click Sign in.\n\n${OBS}` },
  ],
  tools: TOOLS,
  tool_choice: 'auto',
  thinking: { type: 'disabled' },
});
results['tools + thinking disabled'] = {
  status: solo.status,
  ms: solo.ms,
  finish: solo.json?.choices?.[0]?.finish_reason,
  tool: solo.json?.choices?.[0]?.message?.tool_calls?.[0]?.function ?? null,
  reasoningPresent: Boolean(solo.json?.choices?.[0]?.message?.reasoning_content),
  error: solo.json?.error?.message,
};

// --- 3. tool calling, thinking enabled: is reasoning_content mandatory? -----
const thinkingOff = { type: 'disabled' };
const thinkingOn = { type: 'enabled' };
const r1 = await post(BASE, {
  model: MODEL,
  messages: [
    { role: 'system', content: SYS },
    { role: 'user', content: `Click Sign in.\n\n${OBS}` },
  ],
  tools: TOOLS,
  reasoning_effort: 'low',
  thinking: thinkingOn,
});
const msg1 = r1.json?.choices?.[0]?.message ?? {};
const call1 = msg1.tool_calls?.[0];
results['thinking r1'] = {
  status: r1.status,
  ms: r1.ms,
  tool: call1?.function ?? null,
  reasoningChars: (msg1.reasoning_content || '').length,
  error: r1.json?.error?.message,
};

if (call1) {
  const history = [
    { role: 'system', content: SYS },
    { role: 'user', content: `Click Sign in.\n\n${OBS}` },
    { role: 'assistant', content: msg1.content || null, tool_calls: msg1.tool_calls },
    { role: 'tool', tool_call_id: call1.id, content: JSON.stringify({ ok: true, note: 'clicked' }) },
    { role: 'user', content: '<observation>\nURL: https://example.com\nTITLE: Welcome\n</observation>' },
  ];

  // 3a. assistant message WITHOUT reasoning_content replayed
  const omit = await post(BASE, {
    model: MODEL,
    messages: history,
    tools: TOOLS,
    reasoning_effort: 'low',
    thinking: thinkingOn,
  });
  results['thinking r2 without reasoning_content'] = {
    status: omit.status,
    error: omit.json?.error?.message ?? omit.text,
  };

  // 3b. assistant message WITH reasoning_content replayed
  const withReasoning = history.map((m, i) =>
    i === 2 ? { ...m, reasoning_content: msg1.reasoning_content || '' } : m,
  );
  const keep = await post(BASE, {
    model: MODEL,
    messages: withReasoning,
    tools: TOOLS,
    reasoning_effort: 'low',
    thinking: thinkingOn,
  });
  results['thinking r2 with reasoning_content'] = {
    status: keep.status,
    ms: keep.ms,
    tool: keep.json?.choices?.[0]?.message?.tool_calls?.[0]?.function ?? null,
    content: (keep.json?.choices?.[0]?.message?.content || '').slice(0, 120),
    error: keep.json?.error?.message,
  };
}

// --- 4. vision -------------------------------------------------------------
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const vision = await post(BASE, {
  model: MODEL,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What colour is this image? One word.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
      ],
    },
  ],
  max_tokens: 16,
  thinking: { type: 'disabled' },
});
results['vision'] = {
  status: vision.status,
  content: vision.json?.choices?.[0]?.message?.content ?? null,
  error: vision.json?.error?.message,
};

console.log(JSON.stringify({ model: MODEL, results }, null, 2));
