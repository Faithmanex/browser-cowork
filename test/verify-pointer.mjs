// Proves the input layer against a real browser: the exact event sequences the
// service worker dispatches, replayed through a Chromium CDP session.
//
// What this covers that nothing else does:
//   - a canvas drag arrives as pointerdown, several pointermoves with the button
//     held, and a pointerup at the target (the video-editor case)
//   - a drag between two HTML5 draggable elements produces a real drop
//   - hover opens hover-only UI, at a point and not just by ref
//   - chords carry their modifiers
//   - a coordinate click lands inside a same-origin iframe
//
// The page records events into a DOM node, not window: page.evaluate runs in an
// isolated world here and cannot see globals set by the page's own scripts.
//
//   node test/verify-pointer.mjs
import { readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { planClick, planDoubleClick, planDrag, planHover, planKey } from '../lib/input.js';

const HERE = dirname(fileURLToPath(import.meta.url));

async function loadPlaywright() {
  try {
    return await import('patchright');
  } catch {
    /* not installed at top level */
  }
  const extRoot = join(process.env.USERPROFILE || process.env.HOME || '', '.vscode', 'extensions');
  if (existsSync(extRoot)) {
    for (const dir of readdirSync(extRoot)) {
      const candidate = join(extRoot, dir, 'standalone', 'node_modules', 'patchright', 'index.js');
      if (existsSync(candidate)) return import(pathToFileURL(candidate).href);
    }
  }
  throw new Error('patchright not found; run with PATCHRIGHT installed or via the browser-automation skill');
}

const pw = await loadPlaywright();
const chromium = pw.chromium || pw.default?.chromium;
if (!chromium) throw new Error('patchright loaded but exposed no chromium');

const fail = [];
const checks = {};
const expect = (name, actual, wanted) => {
  checks[name] = actual;
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail.push(`${name}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  }
};

const parse = (text) =>
  String(text || '')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1000, height: 800 } });
const page = await context.newPage();

try {
  await page.goto(pathToFileURL(join(HERE, 'pages', 'pointer.html')).href);
  await page.waitForTimeout(200);

  const cdp = await page.context().newCDPSession(page);
  const send = (method, params) => cdp.send(method, params);

  const mouse = async (events) => {
    for (const event of events) await send('Input.dispatchMouseEvent', event);
  };
  const keys = async (events) => {
    for (const event of events) await send('Input.dispatchKeyEvent', event);
  };
  const clear = () =>
    page.evaluate(() => {
      document.getElementById('trace').textContent = '';
    });
  const log = async () => parse(await page.evaluate(() => document.getElementById('trace').textContent));

  // --- canvas drag: the timeline case -------------------------------------
  await clear();
  await mouse(planDrag({ x: 100, y: 100 }, { x: 300, y: 200 }, { steps: 10 }));
  const dragLog = await log();

  const down = dragLog.find((e) => e.target === 'canvas' && e.type === 'pointerdown');
  const ups = dragLog.filter((e) => e.target === 'canvas' && e.type === 'pointerup');
  const moves = dragLog.filter((e) => e.target === 'canvas' && e.type === 'pointermove');

  const downIndex = dragLog.findIndex((e) => e.target === 'canvas' && e.type === 'pointerdown');
  // The first move is the approach to the start point, before any button is
  // held; only the moves after the press must show the button down.
  const approach = dragLog.slice(0, downIndex).filter((e) => e.target === 'canvas' && e.type === 'pointermove');
  const heldMoves = dragLog.slice(downIndex + 1).filter((e) => e.target === 'canvas' && e.type === 'pointermove');

  expect('drag.pressedAtStart', [down?.clientX, down?.clientY], [100, 100]);
  expect('drag.releasedAtTarget', [ups[0]?.clientX, ups[0]?.clientY], [300, 200]);
  expect('drag.singleRelease', ups.length, 1);
  expect('drag.interpolated', heldMoves.length >= 5, true);
  expect('drag.approachedBeforePress', approach.every((m) => m.buttons === 0), true);
  expect(
    'drag.buttonHeldThroughout',
    heldMoves.every((m) => m.buttons === 1),
    true,
  );
  expect(
    'drag.pathIsMonotonic',
    heldMoves.every((m, i) => i === 0 || m.clientX >= heldMoves[i - 1].clientX),
    true,
  );

  // --- native HTML5 drag and drop ----------------------------------------
  await clear();
  await mouse(planDrag({ x: 90, y: 330 }, { x: 390, y: 330 }, { steps: 14 }));
  const dndLog = await log();
  expect('drop.fired', Boolean(dndLog.find((e) => e.type === 'drop')), true);
  expect('drop.carriedData', dndLog.find((e) => e.type === 'drop')?.data, 'clip-42');

  // --- hover opens hover-only UI -----------------------------------------
  await clear();
  await mouse(planHover({ x: 140, y: 420 }));
  const hoverLog = await log();
  expect('hover.enteredTarget', Boolean(hoverLog.find((e) => e.target === 'hover')), true);

  // --- click at a point ---------------------------------------------------
  await clear();
  await mouse(planClick({ x: 200, y: 60 }));
  const click = (await log()).find((e) => e.target === 'canvas' && e.type === 'click');
  expect('clickAt.landedOnPoint', [click?.clientX, click?.clientY], [200, 60]);

  // --- shift+click keeps the modifier ------------------------------------
  await clear();
  await mouse(planClick({ x: 210, y: 70 }, { mask: 8 }));
  const shiftClick = (await log()).find((e) => e.target === 'canvas' && e.type === 'click');
  expect('shiftClick.modifierHeld', shiftClick?.shift, true);

  // --- double click is a real dblclick -----------------------------------
  await clear();
  await mouse(planDoubleClick({ x: 390, y: 420 }));
  expect('doubleClick.fired', Boolean((await log()).find((e) => e.type === 'dblclick')), true);

  // --- chords -------------------------------------------------------------
  await clear();
  await keys(planKey('ctrl+z'));
  await keys(planKey('shift+space'));
  const keyLog = await log();
  const undo = keyLog.find((e) => e.key === 'z');
  const space = keyLog.find((e) => e.key === ' ');
  expect('chord.ctrlHeld', [undo?.ctrl, undo?.shift], [true, false]);
  expect('chord.spaceWithShift', [space?.key, space?.shift], [' ', true]);

  // --- a coordinate click reaches inside a same-origin frame -------------
  // The frame sits at (20,470); its button is at (50,50) inside it, 120x40 tall.
  await mouse(planClick({ x: 20 + 50 + 60, y: 470 + 50 + 20 }));
  await page.waitForTimeout(80);

  const inner = page.frames().find((f) => f !== page.mainFrame());
  const innerTrace = inner
    ? parse(await inner.evaluate(() => document.getElementById('itrace')?.textContent || ''))
    : [];
  expect('frame.clickReachedInner', Boolean(innerTrace.find((e) => e.target === 'inner')), true);
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

console.log(JSON.stringify({ pass: fail.length === 0, failures: fail, checks }, null, 2));
process.exit(fail.length === 0 ? 0 : 1);
