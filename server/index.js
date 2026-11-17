import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createConversation, describe, dropConversation, say, step } from './agent.js';
import { readSkill } from './skills.js';
const HERE = dirname(fileURLToPath(import.meta.url));
const BODY_LIMIT = 2 * 1024 * 1024;

// --------------------------------------------------------------- tiny dotenv

function loadDotEnv() {
  const file = join(HERE, '.env');
  if (!existsSync(file)) return {};

  const out = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const fileEnv = loadDotEnv();
const env = { ...fileEnv, ...process.env };

function resolveToken() {
  if (env.COPILOT_TOKEN) return env.COPILOT_TOKEN;
  const file = join(HERE, '.token');
  if (existsSync(file)) {
    const saved = readFileSync(file, 'utf8').trim();
    if (saved) return saved;
  }
  const token = randomBytes(24).toString('base64url');
  writeFileSync(file, token, 'utf8');
  return token;
}

// Everything provider-specific lives in this table. Adding a provider is one
// entry; no other file needs to learn its name.
//
// Verified against the live API on this machine (test/deepseek-probe.mjs):
//   - model ids are `deepseek-flash` and `deepseek-v4-pro`; `deepseek-chat`
//     no longer exists.
//   - `deepseek-flash` accepts images; `deepseek-v4-pro` does not.
//   - tool calling round-trips in ~1s with thinking disabled.
const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    adapter: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-flash',
    keys: ['DEEPSEEK_API_KEY'],
    vision: true,
  },
  gemini: {
    label: 'Google Gemini',
    adapter: 'gemini',
    baseUrl: '',
    model: 'gemini-2.5-flash',
    keys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    vision: true,
  },
  openai: {
    label: 'OpenAI',
    adapter: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    keys: ['OPENAI_API_KEY'],
    vision: true,
  },
};

const provider = (env.PROVIDER || 'deepseek').toLowerCase();
const preset = PROVIDERS[provider];

// Models that cannot accept images regardless of what their provider supports.
const TEXT_ONLY_MODELS = new Set(['deepseek-v4-pro']);

if (!preset) {
  console.error(
    `Unknown PROVIDER "${provider}". Use one of: ${Object.keys(PROVIDERS).join(', ')}.`,
  );
  process.exit(1);
}

// Thinking mode is on by default and defaults to effort "high". That buys
// reasoning we do not need for "click e12", and it costs latency on every step,
// so it is off unless asked for.
const thinking = (env.THINKING || 'disabled').toLowerCase();
const effort = (env.REASONING_EFFORT || 'low').toLowerCase();

const extras =
  provider === 'deepseek'
    ? {
        thinking: { type: thinking === 'disabled' ? 'disabled' : 'enabled' },
        ...(thinking === 'disabled' ? {} : { reasoning_effort: effort }),
      }
    : {};

// A single MODEL= line in .env is easy to leave behind when you switch
// providers, and the failure is a confusing 404 from the wrong API. Ignore a
// model name that belongs to a different provider family, with a warning.
function modelFitsProvider(model, forProvider) {
  if (!model) return false;
  if (forProvider === 'deepseek') return model.startsWith('deepseek');
  if (forProvider === 'gemini') return model.startsWith('gemini');
  if (forProvider === 'openai') return !model.startsWith('deepseek') && !model.startsWith('gemini');
  return true;
}

const modelOverride = modelFitsProvider(env.MODEL, provider) ? env.MODEL : '';
if (env.MODEL && !modelOverride) {
  console.warn(
    `[copilot] ignoring MODEL=${env.MODEL} because provider is "${provider}"; using the default instead.`,
  );
}

const model = modelOverride || preset.model;

const config = {
  port: Number(env.PORT || 8787),
  host: '127.0.0.1',
  provider,
  adapter: preset.adapter,
  // Model-level capability: deepseek-v4-pro is text-only even though the
  // provider's default model accepts images.
  vision: env.VISION ? env.VISION !== '0' : preset.vision && !TEXT_ONLY_MODELS.has(model),
  model,
  baseUrl: env.BASE_URL || preset.baseUrl,
  apiKey: preset.keys.map((k) => env[k]).find(Boolean) || '',
  keySource: preset.keys.find((k) => env[k]) || preset.keys[0],
  thinking,
  extras,
  token: resolveToken(),
  allowOrigin: env.ALLOW_ORIGIN || '',
};

// ------------------------------------------------------------------ helpers

function corsHeaders(req) {
  const origin = req.headers.origin || '';

  let allowed = '';
  const pinned = String(config.allowOrigin || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (pinned.includes(origin)) {
    allowed = origin;
  } else if (/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    // Unpacked extension origin. Still gated by the pairing token.
    allowed = origin;
  }

  if (!allowed) return {};
  return {
    'access-control-allow-origin': allowed,
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-copilot-token',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function send(req, res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...corsHeaders(req),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('Body must be JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

// DNS-rebinding guard: a browser page cannot reach this server using a hostname.
function hostAllowed(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

function tokenAllowed(req) {
  return String(req.headers['x-copilot-token'] || '') === config.token;
}

// The panel attaches base64 screenshots. Validate rather than trusting them:
// anything that is not an image mime is dropped, and an oversized payload is
// refused before it reaches the provider.
const MAX_IMAGE_CHARS = 6 * 1024 * 1024;

function readImage(body) {
  const raw = body?.image;
  if (!raw || typeof raw.data !== 'string' || !raw.data) return undefined;

  const mime = String(raw.mime || 'image/jpeg');
  if (!/^image\/(png|jpeg|jpg|webp)$/.test(mime)) {
    throw Object.assign(new Error(`Unsupported image type: ${mime}`), { status: 400 });
  }
  if (raw.data.length > MAX_IMAGE_CHARS) {
    throw Object.assign(new Error('Screenshot too large'), { status: 413 });
  }
  return { mime, data: raw.data };
}

// ------------------------------------------------------------------- routes

const ROUTES = {
  'GET /api/health': async (req, res) => {
    send(req, res, 200, {
      ok: true,
      provider: config.provider,
      model: config.model,
      adapter: config.adapter,
      vision: config.vision,
      thinking: config.thinking,
      hasKey: Boolean(config.apiKey),
      keySource: config.apiKey ? config.keySource : null,
      maxSteps: null,
      ...describe(),
    });
  },

  'POST /api/turn': async (req, res, body) => {
    const conversationId = createConversation(body.surface);
    const result = await step(config, conversationId, {
      message: String(body.message || '').slice(0, 4000),
      observation: body.observation,
      image: readImage(body),
    });
    send(req, res, 200, result);
  },

  // Continue the current task with a new instruction. Same conversation, same
  // history, fresh step budget.
  'POST /api/message': async (req, res, body) => {
    const id = String(body.conversationId || '');
    if (!id) return send(req, res, 400, { error: 'conversationId is required' });
    const result = await say(config, id, {
      message: String(body.message || '').slice(0, 4000),
      observation: body.observation,
      image: readImage(body),
    });
    send(req, res, 200, result);
  },

  // Skill content lives on the server; the panel asks for it when the model
  // calls use_skill / read_skill. Only listed files are readable.
  'POST /api/skill': async (req, res, body) => {
    const result = readSkill(String(body.name || ''), String(body.file || ''));
    send(req, res, result.ok ? 200 : 404, result);
  },

  'POST /api/step': async (req, res, body) => {
    const id = String(body.conversationId || '');
    if (!id) return send(req, res, 400, { error: 'conversationId is required' });
    const result = await step(config, id, {
      actionResult: body.actionResult,
      observation: body.observation,
      image: readImage(body),
    });
    send(req, res, 200, result);
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (!hostAllowed(req)) {
    return send(req, res, 403, { error: 'Host not allowed' });
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  try {
    if (path === '/api/health' && req.method === 'GET') {
      return await ROUTES['GET /api/health'](req, res);
    }

    if (!tokenAllowed(req)) {
      return send(req, res, 401, { error: 'Missing or wrong x-copilot-token' });
    }

    if (req.method === 'DELETE' && path.startsWith('/api/conversation/')) {
      const id = decodeURIComponent(path.slice('/api/conversation/'.length));
      const removed = dropConversation(id);
      return send(req, res, 200, { ok: true, removed });
    }

    const key = `${req.method} ${path}`;
    const handler = ROUTES[key];
    if (!handler) return send(req, res, 404, { error: `No route for ${key}` });

    const body = req.method === 'POST' ? await readBody(req) : {};
    return await handler(req, res, body);
  } catch (err) {
    const status = err?.status || 500;
    if (status >= 500) console.error('[copilot]', err);
    return send(req, res, status, { error: String(err?.message || err) });
  }
});

server.listen(config.port, config.host, () => {
  const keyState = config.apiKey
    ? `loaded (${config.keySource})`
    : `MISSING — set ${config.keySource} in server/.env`;
  console.log('');
  console.log('  Browser Cowork backend');
  console.log(`  listening   http://${config.host}:${config.port}`);
  console.log(`  provider    ${preset.label} - ${config.provider} / ${config.model}`);
  console.log(`  api key     ${keyState}`);
  console.log(`  token       ${config.token}`);
  if (config.provider === 'deepseek') {
    console.log(`  thinking    ${config.thinking}${config.thinking === 'disabled' ? '' : ` (${config.extras.reasoning_effort})`}`);
  }
  if (!config.vision) {
    console.log(`  images      unsupported by ${config.model}; screenshots are skipped`);
  }
  console.log('');
  console.log("  Paste that token into the panel's Settings once, then press Connect this tab.");
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
