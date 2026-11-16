// The question this answers: can the model act correctly when step 2 onward
// shows it only what changed, rather than the whole page again?
//
// It drives /api/turn and /api/step exactly as sidepanel.js does, and builds
// each observation with lib/observe.js — the same code the panel runs — against
// a simulated page. No browser needed; the model is real.
//
//   node test/verify-diff-loop.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { observation, formatFull, buildState } from '../lib/observe.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOKEN = readFileSync(join(HERE, '..', 'server', '.token'), 'utf8').trim();
const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const headers = { 'content-type': 'application/json', 'x-copilot-token': TOKEN };

const TASK = 'Enter ada@example.com in the Email field, then tick Remember me. Do not sign in.';

/* --------------------------------------------------- a very small fake page */

const page = { email: '', remember: false, version: 0 };

function snapshot() {
  page.version += 1;
  return {
    version: page.version,
    instance: 'difftest',
    url: 'https://example.com/login',
    title: 'Sign in',
    scrollY: 0,
    viewportH: 900,
    docH: 900,
    elements: [
      { ref: 'e1', role: 'textbox', name: 'Email', x: 100, y: 100, ...(page.email ? { value: page.email } : {}) },
      { ref: 'e2', role: 'textbox', name: 'Full name', x: 100, y: 140 },
      { ref: 'e3', role: 'checkbox', name: 'Remember me', x: 20, y: 180, checked: page.remember },
      { ref: 'e4', role: 'button', name: 'Sign in', x: 100, y: 220 },
      { ref: 'e5', role: 'link', name: 'Forgot password?', x: 100, y: 260, href: 'https://example.com/reset' },
    ],
    text: 'Sign in to Example',
  };
}

// Answer a non-mutating tool the way the extension would, so a curious model
// does not derail the run.
function serveReadOnly(action) {
  const snap = snapshot();
  if (action.name === 'find_on_page') {
    const q = String(action.args?.query || '').toLowerCase();
    const matches = snap.elements.filter((e) => e.name.toLowerCase().includes(q));
    return { ok: true, count: matches.length, matches };
  }
  if (action.name === 'inspect_page') {
    return { ok: true, note: 'full page', snapshot: formatFull(buildState(snap)) };
  }
  return { ok: false, error: `The test harness cannot execute ${action.name}.` };
}

function applyAction(action) {
  if (action.name === 'type_text' && action.args.ref === 'e1') {
    page.email = action.args.text;
    return { ok: true, via: 'cdp', into: 'Email' };
  }
  if (action.name === 'click_element' && action.args.ref === 'e3') {
    page.remember = !page.remember;
    return { ok: true, via: 'cdp', clicked: 'Remember me' };
  }
  if (action.name === 'click_element' && action.args.ref === 'e4') {
    return { ok: false, error: 'The test harness refuses to sign in; that was explicitly out of scope.' };
  }
  return { ok: false, error: `The test harness cannot execute ${action.name} ${JSON.stringify(action.args)}.` };
}

/* ----------------------------------------------------------------- the loop */

let baseline = null;
const sent = [];

function nextObservation() {
  const snap = snapshot();
  const r = observation(snap, baseline);
  baseline = r.state;
  sent.push({
    mode: r.mode,
    reason: r.reason,
    chars: r.text.length,
    fullChars: formatFull(buildState(snap)).length,
    text: r.text,
  });
  return r.text;
}

const started = Date.now();
const transcript = [];

let reply = await fetch(`${BASE}/api/turn`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ message: TASK, observation: nextObservation() }),
}).then((r) => r.json());

const conversationId = reply.conversationId;
transcript.push({ step: reply.step, action: reply.action?.name, args: reply.action?.args, text: reply.text, done: reply.done });

for (let i = 0; i < 6 && !reply.done && reply.action; i++) {
  const action = reply.action;
  let result;

  if (action.name === 'capture_screenshot' || action.name === 'scroll_page' || action.name === 'find_on_page' || action.name === 'inspect_page') {
    result = serveReadOnly(action);
  } else {
    result = applyAction(action);
  }

  if (action.name === 'finish_task') break;

  const observationText = nextObservation();
  reply = await fetch(`${BASE}/api/step`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ conversationId, actionResult: result, observation: observationText }),
  }).then((r) => r.json());

  transcript.push({ step: reply.step, action: reply.action?.name, args: reply.action?.args, text: reply.text, done: reply.done });
}

await fetch(`${BASE}/api/conversation/${conversationId}`, { method: 'DELETE', headers }).catch(() => {});

/* ------------------------------------------------------------- assertions */

const failed = [];
const check = (name, cond, detail) => {
  if (!cond) failed.push(`${name}${detail ? `: ${detail}` : ''}`);
};

const names = transcript.map((t) => t.action).filter(Boolean);
const byName = transcript.map((t) => `${t.action}:${t.args?.ref || ''}`);

check('task completed', Boolean(reply.done), `ended on ${reply.action?.name}`);
check('touched the Email field', byName.includes('type_text:e1'), byName.join(' | '));
check('ticked Remember me', byName.includes('click_element:e3'), byName.join(' | '));
check('did not sign in', !byName.includes('click_element:e4'), byName.join(' | '));
check('used at least one diff observation', sent.some((s) => s.mode === 'diff'));
check(
  'never re-read the page unnecessarily',
  names.filter((n) => n === 'inspect_page').length <= 1,
  `${names.filter((n) => n === 'inspect_page').length} inspect_page calls`,
);

const diffs = sent.filter((s) => s.mode === 'diff');
if (diffs.length) {
  const smallest = Math.min(...diffs.map((d) => d.fullChars / d.chars));
  // Only a floor here: on a five-element page the SCROLL/count header is a fixed
  // cost, so the achievable ratio is ~1.8x. The 3x+ claim is measured on a
  // realistic 40-element page in test/verify-observe.mjs.
  check('a diff was smaller than the full page', smallest > 1.5, `only ${smallest.toFixed(1)}x smaller`);
}

console.log(
  JSON.stringify(
    {
      pass: failed.length === 0,
      failures: failed,
      totalMs: Date.now() - started,
      actions: byName,
      observations: sent.map((s) => ({ mode: s.mode, reason: s.reason, chars: s.chars, fullChars: s.fullChars })),
      transcript,
      // Show what the model actually had to work with on the last diff step.
      lastDiff: diffs.at(-1)?.text,
    },
    null,
    2,
  ),
);

process.exit(failed.length === 0 ? 0 : 1);
