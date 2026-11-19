// Turns a page snapshot into the text the model reads, and turns two
// consecutive snapshots into the smallest honest statement of what changed.
//
// Why a diff at all: the panel used to re-send the whole page every step, so a
// 40-element page cost the same tokens on step 9 as on step 1, and the model had
// to re-read it to notice that one checkbox had flipped. Refs are stable across
// observations (lib/page-agent.js keeps an element -> ref WeakMap for the life
// of the document), which is exactly what makes "e4 changed" a true statement
// rather than a guess. That stability is the precondition for everything here.
//
// This file is deliberately DOM-free and browser-free: it is plain text in,
// plain text out, so it can be unit-tested in Node (test/verify-observe.mjs).
//
// Three rules keep the diff trustworthy:
//   1. A ref that disappears is reported as removed. Silence would let the model
//      click a ref it thinks still exists.
//   2. A ref is never reused for a different element, so a changed line always
//      means the same element changed.
//   3. When the diff would be most of the page anyway (a new document, a big
//      re-render, a navigation), send the full snapshot instead. A diff that is
//      not cheaper is just a harder-to-read full snapshot.

export const MAX_OBS_CHARS = 7000;

/** One element, one line. The single source of shape for both full and diff. */
export function elementLine(e) {
  let line = `${e.ref} ${e.role} "${e.name}"`;
  if (e.value) line += ` value="${e.value}"`;
  // A slider without its range is a number with no meaning.
  if (e.min !== undefined) line += ` min=${e.min}`;
  if (e.max !== undefined) line += ` max=${e.max}`;
  if (e.sensitive) line += ' [sensitive: only the user may fill this]';
  if (e.href) line += ` href=${e.href}`;
  if (e.checked !== undefined) line += e.checked ? ' [checked]' : ' [unchecked]';
  if (e.disabled) line += ' [disabled]';
  if (e.expanded !== undefined) line += e.expanded ? ' [expanded]' : ' [collapsed]';
  // A frame's clickable region, which is the only thing coordinate actions need.
  if (e.role === 'frame' && e.w) line += ` ${e.w}x${e.h}`;
  return line;
}

/** Normalise a raw snapshot into the comparable form used by both formatters. */
export function buildState(snap) {
  const order = [];
  const lines = new Map();

  for (const e of snap.elements || []) {
    if (!e?.ref) continue;
    order.push(e.ref);
    lines.set(e.ref, elementLine(e));
  }

  return {
    version: snap.version,
    instance: snap.instance,
    url: snap.url || '',
    title: snap.title || '',
    // Which fixture the page is on, when the site exposes it.
    match: snap.match || '',
    scrollY: Number(snap.scrollY) || 0,
    viewportW: Number(snap.viewportW) || 0,
    viewportH: Number(snap.viewportH) || 0,
    dpr: Number(snap.dpr) || 1,
    docH: Number(snap.docH) || 0,
    order,
    lines,
    text: String(snap.text || ''),
  };
}

function scrollLine(s) {
  const max = Math.max(0, s.docH - s.viewportH);
  const where = s.scrollY <= 0 ? 'top' : s.scrollY >= max ? 'bottom' : `${Math.round((s.scrollY / max) * 100)}%`;
  return `SCROLL: y=${s.scrollY} of ${max} (${where}, viewport ${s.viewportH})`;
}

/**
 * The model cannot turn a screenshot pixel into a click point without knowing
 * the page's CSS size and how many image pixels a CSS pixel became.
 */
function viewportLine(s) {
  if (!s.viewportW) return null;
  const scale = s.dpr && s.dpr !== 1 ? ` @${s.dpr}x (screenshot pixels are ${s.dpr}x CSS pixels)` : '';
  return `VIEWPORT: ${s.viewportW}x${s.viewportH} CSS${scale}`;
}

function clip(text) {
  return text.length > MAX_OBS_CHARS ? `${text.slice(0, MAX_OBS_CHARS)}\n…[truncated]` : text;
}

export function formatFull(state) {
  const out = [`URL: ${state.url}`, `TITLE: ${state.title}`];
  // The fixture first, because "which game is this" is the first thing a
  // multi-panel task asks and the title usually does not answer it.
  if (state.match) out.push(`MATCH: ${state.match}`);
  out.push(scrollLine(state));
  const vp = viewportLine(state);
  if (vp) out.push(vp);
  out.push('INTERACTIVE:');
  for (const ref of state.order) out.push(state.lines.get(ref));
  if (state.text) out.push('PAGE TEXT:', state.text);
  return out.join('\n');
}

/**
 * Line-level diff of the visible page text. Only the differing middle is
 * reported, with one line of context on each side, so an appended paragraph
 * costs one line rather than the whole document.
 */
export function textDelta(before, after) {
  if (before === after) return null;

  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  return {
    context: start > 0 ? a[start - 1] : null,
    removed: a.slice(start, endA),
    added: b.slice(start, endB),
    atLine: start + 1,
  };
}

function formatTextDelta(delta) {
  const out = [`PAGE TEXT changed at line ${delta.atLine}:`];
  if (delta.context) out.push(`  ${delta.context}`);
  for (const line of delta.removed) out.push(`- ${line}`);
  for (const line of delta.added) out.push(`+ ${line}`);
  return out;
}

/**
 * What changed between two observations, in the model's vocabulary.
 *
 * Additions and edits are listed in document order, removed refs after them, so
 * the model reads a diff the same way it reads a page: top to bottom.
 */
export function formatDiff(prev, next) {
  // Always identify the page, even when nothing changed. A caller may be
  // driving more than one panel/tab, and a diff with no URL is unusable: it
  // cannot be attributed to a tab, and "no change" would be the only thing the
  // caller sees.
  const out = [`URL: ${next.url}`, `TITLE: ${next.title}`];
  if (prev.match !== next.match && (prev.match || next.match)) {
    out.push(`MATCH: ${next.match || '(none on this page)'}`);
  }
  out.push(scrollLine(next));

  // Only worth repeating when it changed; a resize is rare.
  if (prev.viewportW !== next.viewportW || prev.viewportH !== next.viewportH || prev.dpr !== next.dpr) {
    const vp = viewportLine(next);
    if (vp) out.push(vp);
  }

  const added = [];
  const changed = [];
  const removed = [];

  for (const ref of next.order) {
    const line = next.lines.get(ref);
    if (!prev.lines.has(ref)) added.push(line);
    else if (prev.lines.get(ref) !== line) changed.push(line);
  }

  for (const ref of prev.order) {
    if (!next.lines.has(ref)) removed.push(prev.lines.get(ref));
  }

  const delta = textDelta(prev.text, next.text);

  // URL, title and scroll are in the header above, so "nothing" here means
  // nothing about the page's elements or text moved.
  if (!added.length && !changed.length && !removed.length && !delta) {
    out.push('No change since the last observation.');
    return out.join('\n');
  }

  const total = next.order.length;
  out.push(`INTERACTIVE: ${total} elements total; ${added.length} added, ${changed.length} changed, ${removed.length} removed since the last observation.`);

  for (const line of added) out.push(`+ ${line}`);
  for (const line of changed) out.push(`~ ${line}`);
  for (const line of removed) out.push(`- ${line}`);

  if (delta) out.push(...formatTextDelta(delta));

  return out.join('\n');
}

/**
 * The one call the panel makes per step.
 *
 * Returns `{ text, state, mode, reason }`. `state` is what the caller caches for
 * the next step; `mode` is `'full'` or `'diff'` and exists so the test can assert
 * the fallback triggers, not just the output.
 */
export function observation(snap, prev) {
  const next = buildState(snap);
  const full = formatFull(next);

  const fallback = (reason) => ({ text: clip(full), state: next, mode: 'full', reason });

  if (!prev) return fallback('first observation');
  // A reload or navigation gives a new injected instance even when the URL is
  // identical, and every cached ref in it now points at another document.
  if (prev.instance !== next.instance) return fallback('page reloaded');
  if (prev.url !== next.url) return fallback('url changed');

  const diff = formatDiff(prev, next);

  // A diff that is not meaningfully smaller is worse than the full snapshot:
  // more tokens per unit of information, and harder to read.
  if (diff.length > full.length * 0.7) return fallback('diff not smaller than full');

  return { text: clip(diff), state: next, mode: 'diff', reason: 'incremental' };
}
