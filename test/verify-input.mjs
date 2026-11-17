// Checks lib/input.js: the pure planning layer behind drag, hover, click at a
// point, chords and wheel. No browser, no CDP, no API key.
//
//   node test/verify-input.mjs
import assert from 'node:assert/strict';
import {
  keySpec,
  parseKeyCombo,
  planKey,
  planHover,
  planClick,
  planDoubleClick,
  planDrag,
  planScroll,
  MODIFIER_BITS,
} from '../lib/input.js';

let checks = 0;
const ok = (name, fn) => {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
};

/* ---------------------------------------------------------------- keyboard */

ok('letters and digits map to real virtual key codes', () => {
  assert.deepEqual(keySpec('a'), { key: 'a', code: 'KeyA', vk: 65, text: 'a' });
  assert.equal(keySpec('z').vk, 90);
  assert.deepEqual(keySpec('4'), { key: '4', code: 'Digit4', vk: 52, text: '4' });
  assert.equal(keySpec('Q').key, 'q', 'case-insensitive');
});

ok('named keys, aliases and function keys', () => {
  assert.deepEqual(keySpec('space'), { key: ' ', code: 'Space', vk: 32, text: ' ' });
  assert.equal(keySpec('enter').vk, 13);
  assert.equal(keySpec('esc').key, 'Escape');
  assert.equal(keySpec('del').key, 'Delete');
  assert.equal(keySpec('F5').vk, 116);
  assert.equal(keySpec('pageup').code, 'PageUp');
});

ok('an unknown key is refused rather than silently ignored', () => {
  assert.equal(keySpec('hyperkey'), null);
  assert.equal(parseKeyCombo('ctrl+hyperkey'), null);
  assert.equal(parseKeyCombo('ctrl'), null, 'modifiers alone are not a keypress');
  assert.equal(parseKeyCombo(''), null);
});

ok('ctrl+shortcuts carry no text, so they cannot type into the page', () => {
  const parsed = parseKeyCombo('ctrl+z');
  assert.equal(parsed.mask, MODIFIER_BITS.ctrl);
  assert.equal(parsed.spec.key, 'z');
  assert.equal(parsed.text, undefined);

  const events = planKey('ctrl+z');
  assert.equal(events.length, 2);
  assert.equal(events[0].type, 'keyDown');
  assert.equal(events[0].types ?? undefined, undefined);
  assert.equal(events[0].modifiers, 2);
  assert.equal(events[1].type, 'keyUp');
  assert.equal(events[1].text, undefined);
});

ok('shift alone uppercases; shift+arrow has no text', () => {
  assert.equal(parseKeyCombo('shift+a').text, 'A');
  assert.equal(parseKeyCombo('shift+arrowleft').text, undefined);
  assert.equal(parseKeyCombo('cmd+shift+4').mask, MODIFIER_BITS.meta | MODIFIER_BITS.shift);
});

ok('letters, space and modifiers cover editor shortcuts', () => {
  // Premiere/Figma style: space plays, ctrl+z undoes, ctrl+shift+z redoes.
  for (const combo of ['space', 'ctrl+z', 'ctrl+shift+z', 'ctrl+a', 'ctrl+c', 'shift+delete', 'f2']) {
    assert.ok(parseKeyCombo(combo), `${combo} should parse`);
  }
});

/* ------------------------------------------------------------------- mouse */

ok('a hover is one move and nothing else', () => {
  const events = planHover({ x: 10, y: 20 });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { type: 'mouseMoved', x: 10, y: 20, button: 'none', buttons: 0, modifiers: 0 });
});

ok('a click is move, press, release at one point', () => {
  const events = planClick({ x: 100, y: 50 });
  assert.deepEqual(
    events.map((e) => e.type),
    ['mouseMoved', 'mousePressed', 'mouseReleased'],
  );
  assert.ok(events.every((e) => e.x === 100 && e.y === 50));
  assert.equal(events[1].clickCount, 1);
  assert.equal(events[2].buttons, 0);
});

ok('a double-click is two pairs with clickCount 1 then 2', () => {
  const events = planDoubleClick({ x: 5, y: 5 });
  assert.deepEqual(
    events.map((e) => `${e.type}${e.clickCount ?? ''}`),
    ['mouseMoved', 'mousePressed1', 'mouseReleased1', 'mousePressed2', 'mouseReleased2'],
  );
});

ok('a drag presses once, moves along the path, releases at the target', () => {
  const events = planDrag({ x: 0, y: 0 }, { x: 120, y: 60 }, { steps: 6 });
  const types = events.map((e) => e.type);

  assert.equal(types[0], 'mouseMoved');
  assert.equal(types[1], 'mousePressed');
  assert.equal(types.at(-1), 'mouseReleased');
  assert.equal(types.filter((t) => t === 'mousePressed').length, 1, 'exactly one press');
  assert.equal(types.filter((t) => t === 'mouseReleased').length, 1, 'exactly one release');

  const moves = events.filter((e) => e.type === 'mouseMoved');
  assert.equal(moves.length, 7, 'one approach move plus six waypoints');

  // Every waypoint between press and release must report the button as held.
  const held = events.slice(2, -1);
  assert.ok(held.length >= 4, 'several interpolated moves');
  assert.ok(held.every((e) => e.buttons === 1), 'button held during the drag');
  assert.ok(held.every((e) => e.x >= 0 && e.x <= 120 && e.y >= 0 && e.y <= 60));

  assert.equal(held.at(-1).x, 120);
  assert.equal(held.at(-1).y, 60);

  assert.deepEqual({ x: events.at(-1).x, y: events.at(-1).y }, { x: 120, y: 60 });
  assert.equal(events.at(-1).buttons, 0, 'button released at the end');
});

ok('drag waypoints are monotonic and land exactly on the target', () => {
  const events = planDrag({ x: 10, y: 10 }, { x: 210, y: 10 }, { steps: 10 });
  const xs = events.filter((e) => e.type === 'mouseMoved').map((e) => e.x);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] > xs[i - 1], `x must increase: ${xs}`);
  assert.equal(xs.at(-1), 210);
});

ok('a zero-distance drag does not emit a dozen identical moves', () => {
  const events = planDrag({ x: 7, y: 7 }, { x: 7, y: 7 }, { steps: 12 });
  assert.ok(events.length <= 5, `expected a short sequence, got ${events.length}`);
});

ok('drag holds modifiers for shift-select and ctrl-drag', () => {
  const events = planDrag({ x: 0, y: 0 }, { x: 50, y: 0 }, { mask: MODIFIER_BITS.shift });
  assert.ok(events.every((e) => e.modifiers === 8));
});

ok('drag steps are clamped to something sane', () => {
  assert.ok(planDrag({ x: 0, y: 0 }, { x: 1000, y: 0 }, { steps: 9999 }).length <= 63);
  assert.ok(planDrag({ x: 0, y: 0 }, { x: 1000, y: 0 }, { steps: 0 }).length >= 3);
});

ok('a wheel event carries both deltas, so inner panels scroll', () => {
  const events = planScroll({ x: 400, y: 300 }, { dy: -600, dx: 0 });
  assert.deepEqual(events, [
    { type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY: -600 },
  ]);
});

console.log(`\n${checks} checks passed`);
