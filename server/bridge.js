// Local loopback bridge for Browser Cowork.
//
// The extension side panel owns the agent loop and all tab access. This relay
// gives an external agent on the same machine a way to hand the panel a task,
// approve consequential actions, stop, and read progress — without CDP access
// to Chrome. It only ever relays; it never talks to a model and never touches
// a tab itself.
//
//   node server/bridge.js
//
// Binds 127.0.0.1 only. The token is a fixed local secret, shared with the
// panel adapter in sidepanel.js; it is not an API key.

import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST = '127.0.0.1';
const PORT = Number(process.env.BRIDGE_PORT || 8788);
const TOKEN = process.env.BRIDGE_TOKEN || 'bc-local-bridge-v1';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(HERE, '.bridge-token');
writeFileSync(TOKEN_FILE, `${TOKEN}\n`, 'utf8');

const MAX_BODY = 2 * 1024 * 1024;
const MAX_EVENTS = 1000;
const MAX_RESULTS = 500;

let nextCmdId = 1;
let nextEventId = 1;
const queue = [];
const results = new Map();
const events = [];
// One entry per connected panel (Chrome profile). Panels identify themselves on
// every poll so a command can be addressed to a specific profile instead of
// being taken by whichever panel polls first.
const panels = new Map();

// A command that nobody collects must not be handed to a later, unrelated
// request. Targeted commands get longer, because the panel may be asleep.
const CMD_TTL = 120000;

function touchPanel({ id, label, tab }) {
  if (!id) return null;
  const prev = panels.get(id) || {};
  const entry = {
    id,
    label: label || prev.label || null,
    tab: tab || prev.tab || null,
    firstSeen: prev.firstSeen || Date.now(),
    lastSeen: Date.now(),
  };
  panels.set(id, entry);
  return entry;
}

function pruneQueue(now = Date.now()) {
  for (let i = queue.length - 1; i >= 0; i--) {
    const cmd = queue[i];
    if (now - cmd.createdAt > (cmd.ttl || CMD_TTL)) queue.splice(i, 1);
  }
}

// Only the panel a command is addressed to may take it. Untargeted commands
// stay first-come-first-served for backwards compatibility.
function takeCommand(panelId) {
  const i = queue.findIndex((c) => !c.panel || (panelId && c.panel === panelId));
  if (i < 0) return null;
  return queue.splice(i, 1)[0];
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'content-type,x-bridge-token',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-max-age': '600',
};

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...CORS,
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}`);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  if (path === '/health' && req.method === 'GET') {
    return json(res, 200, { ok: true, service: 'browser-cowork-bridge', port: PORT });
  }

  if (req.headers['x-bridge-token'] !== TOKEN) {
    return json(res, 401, { error: 'missing or wrong x-bridge-token' });
  }

  try {
    if (path === '/cmd' && req.method === 'POST') {
      const b = await readBody(req);
      const cmd = { ...b, id: nextCmdId++, createdAt: Date.now() };
      if (!cmd.type) return json(res, 400, { error: 'type is required' });
      queue.push(cmd);
      return json(res, 200, { id: cmd.id });
    }

    // The panel polls this. A command is handed out once, then the panel writes
    // its result to /result with the same id. The poll carries the panel's
    // identity, which is both a heartbeat and the routing key.
    if (path === '/cmd' && req.method === 'GET') {
      const panelId = url.searchParams.get('panel') || '';
      touchPanel({
        id: panelId,
        label: url.searchParams.get('label') || '',
        tab: url.searchParams.get('tab') || '',
      });
      pruneQueue();
      return json(res, 200, { cmd: takeCommand(panelId), panel: panelId || null });
    }

    // Which panels are connected right now, and which tab each one is on.
    if (path === '/panels' && req.method === 'GET') {
      const now = Date.now();
      const list = [...panels.values()]
        .map((p) => ({ ...p, ageMs: now - p.lastSeen, live: now - p.lastSeen < 5000 }))
        .sort((a, b) => b.lastSeen - a.lastSeen);
      return json(res, 200, { panels: list, queued: queue.length });
    }

    if (path === '/result' && req.method === 'POST') {
      const b = await readBody(req);
      const id = String(b.id ?? '');
      if (!id) return json(res, 400, { error: 'id is required' });
      results.set(id, { ...b, id, at: Date.now() });
      if (results.size > MAX_RESULTS) results.delete(results.keys().next().value);
      return json(res, 200, { ok: true });
    }

    if (path === '/result' && req.method === 'GET') {
      const id = String(url.searchParams.get('id') || '');
      const result = results.get(id);
      if (!result) return json(res, 200, { pending: true });
      results.delete(id);
      return json(res, 200, result);
    }

    if (path === '/event' && req.method === 'POST') {
      const b = await readBody(req);
      events.push({ id: nextEventId++, t: Date.now(), ...b });
      if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
      return json(res, 200, { id: events[events.length - 1].id });
    }

    if (path === '/events' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      return json(res, 200, { events: events.filter((e) => e.id > since) });
    }

    if (path === '/state' && req.method === 'GET') {
      return json(res, 200, { queued: queue.length, events: events.length, results: results.size });
    }

    return json(res, 404, { error: `no route for ${req.method} ${path}` });
  } catch (err) {
    return json(res, err?.status || 500, { error: String(err?.message || err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Browser Cowork bridge');
  console.log(`  listening   http://${HOST}:${PORT}`);
  console.log(`  token       ${TOKEN}`);
  console.log(`  token file  ${TOKEN_FILE}`);
  console.log('');
  console.log('  Client: node server/bridge-client.mjs status');
  console.log('');
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
