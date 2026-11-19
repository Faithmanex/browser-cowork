// Thin CLI client for the Browser Cowork local bridge.
//
//   node server/bridge-client.mjs <command> [args]
//
//   status                       panel status (connection, running, feed)
//   configure --token=... [--url=...] [--approval=true|false]
//   connect | disconnect
//   task "instruction"           hand a task to the panel
//   approve [true|false]         resolve a pending approval (default true)
//   stop
//   events [since]               one-shot event dump
//   follow [since] [seconds]     stream events until task_end or timeout
//   state                        relay queue/event counts

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BRIDGE_URL || 'http://127.0.0.1:8788';
const TOKEN =
  process.env.BRIDGE_TOKEN || readFileSync(join(HERE, '.bridge-token'), 'utf8').trim();
const HEADERS = { 'content-type': 'application/json', 'x-bridge-token': TOKEN };

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: HEADERS });
  return r.json();
}

async function post(path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: HEADERS,
    body: JSON.stringify(body ?? {}),
  });
  return r.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const print = (x) => console.log(JSON.stringify(x, null, 2));

async function command(type, extra = {}) {
  const { id } = await post('/cmd', { type, ...extra, ...(target ? { panel: target } : {}) });
  for (let i = 0; i < 75; i++) {
    const r = await get(`/result?id=${id}`);
    if (!r.pending) return r;
    await sleep(200);
  }
  return { ok: false, error: 'timed out waiting for the panel to respond' };
}

const [rawCmd, ...rawArgs] = process.argv.slice(2);

// --panel=<id> addresses one Chrome profile's panel. Without it a command goes
// to whichever panel polls first, which is ambiguous when several are open.
let target = process.env.BRIDGE_PANEL || '';
const args = [];
for (const a of rawArgs) {
  const m = a.match(/^--(?:panel|to)=(.+)$/);
  if (m) target = m[1];
  else args.push(a);
}

const cmd = rawCmd;

if (!cmd) {
  console.log(
    'usage: bridge-client.mjs <status|panels|ping|label|tabs|configure|connect|disconnect|observe|do|shot|approve|stop|events|follow|state|task> [--panel=<id>]',
  );
  process.exit(1);
}

try {
  switch (cmd) {
    case 'state':
      print(await get('/state'));
      break;

    case 'panels':
      print(await get('/panels'));
      break;

    case 'ping':
      print(await command('ping'));
      break;

    case 'label': {
      const text = args.join(' ').trim();
      if (!text) throw new Error('label text is required');
      print(await command('label', { label: text }));
      break;
    }

    case 'status':
      print(await command('status'));
      break;

    case 'tabs':
      print(await command('tabs'));
      break;

    case 'observe': {
      const r = await command('observe', { full: args[0] !== 'diff' });
      if (typeof r.observation === 'string') console.log(r.observation);
      else print(r);
      break;
    }

    case 'do': {
      const name = args[0];
      if (!name) throw new Error('usage: do <name> [json-args | key=value ...]');
      let extra = {};
      if (args[1]) {
        try {
          extra = JSON.parse(args[1]);
        } catch {
          // Windows shells mangle quotes in native-process arguments, so also
          // accept plain key=value pairs with simple type coercion.
          for (const pair of args.slice(1)) {
            const i = pair.indexOf('=');
            if (i < 0) throw new Error(`bad arg: ${pair}`);
            const key = pair.slice(0, i);
            const raw = pair.slice(i + 1);
            extra[key] =
              raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
          }
        }
      }
      print(await command('execute', { name, args: extra }));
      break;
    }

    case 'shot': {
      const r = await command('screenshot');
      if (!r.dataUrl) throw new Error(r.error || 'no screenshot returned');
      const path = resolve(args[0] || join(HERE, 'last-screenshot.png'));
      const base64 = String(r.dataUrl).split(',')[1] || '';
      writeFileSync(path, Buffer.from(base64, 'base64'));
      console.log(JSON.stringify({ ok: true, path, viewport: r.viewport, via: r.via }, null, 2));
      break;
    }

    case 'configure': {
      const extra = {};
      for (const a of args) {
        if (a.startsWith('--token=')) extra.token = a.slice(8);
        else if (a.startsWith('--url=')) extra.backendUrl = a.slice(6);
        else if (a.startsWith('--approval=')) extra.requireApproval = a.slice(11) === 'true';
      }
      print(await command('configure', extra));
      break;
    }

    case 'connect':
      print(await command('connect'));
      break;

    case 'disconnect':
      print(await command('disconnect'));
      break;

    case 'task': {
      const text = args.join(' ').trim();
      if (!text) throw new Error('task text is required');
      print(await command('task', { text }));
      break;
    }

    case 'approve': {
      const ok = args[0] !== 'false';
      print(await command('approve', { ok }));
      break;
    }

    case 'stop':
      print(await command('stop'));
      break;

    case 'events': {
      const since = Number(args[0] || 0);
      print(await get(`/events?since=${since}`));
      break;
    }

    case 'follow': {
      let since = Number(args[0] || 0);
      const seconds = Number(args[1] || 60);
      const deadline = Date.now() + seconds * 1000;
      let done = false;
      while (Date.now() < deadline && !done) {
        const { events } = await get(`/events?since=${since}`);
        for (const e of events) {
          since = e.id;
          console.log(JSON.stringify(e));
          if (e.type === 'task_end') done = true;
        }
        if (!events.length) await sleep(300);
      }
      break;
    }

    default:
      throw new Error(`unknown command: ${cmd}`);
  }
} catch (err) {
  console.error(`bridge-client: ${err?.message || err}`);
  process.exit(1);
}
