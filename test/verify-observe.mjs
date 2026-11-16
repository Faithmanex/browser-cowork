// Checks lib/observe.js: the full/diff decision and the diff itself.
// Pure text in, pure text out — no browser, no server, no API key.
//
//   node test/verify-observe.mjs
import assert from 'node:assert/strict';
import { observation, formatFull, formatDiff, buildState, textDelta } from '../lib/observe.js';

let checks = 0;
const ok = (name, fn) => {
  fn();
  checks++;
  console.log(`  ok  ${name}`);
};

/* ------------------------------------------------------------------ fixtures */

function el(ref, role, name, extra = {}) {
  return { ref, role, name, x: 10, y: 10, ...extra };
}

function snap(overrides = {}) {
  return {
    version: 1,
    instance: 'aaaa1111',
    url: 'https://shop.example/cart',
    title: 'Your cart',
    scrollY: 0,
    viewportH: 900,
    docH: 900,
    elements: [
      el('e1', 'link', 'Home'),
      el('e2', 'textbox', 'Search'),
      el('e3', 'link', 'Cart (2)'),
      el('e4', 'button', 'Checkout'),
      el('e5', 'checkbox', 'Gift wrap', { checked: false }),
      el('e6', 'textbox', 'Coupon'),
    ],
    text: 'Your cart\nTwo items\nSubtotal $40.00\nTax $3.20\nTotal $43.20',
    ...overrides,
  };
}

// A page big enough that the token argument is realistic rather than a rounding
// artefact: 40 elements and a paragraph of body text, like a real listing page.
function bigSnap(overrides = {}) {
  const elements = [el('e1', 'textbox', 'Search products')];
  for (let i = 2; i <= 40; i++) {
    elements.push(el(`e${i}`, 'link', `Product ${i}: a reasonably long descriptive title`));
  }
  const text = Array.from({ length: 12 }, (_, i) => `Paragraph ${i + 1}: lorem ipsum dolor sit amet, consectetur adipiscing elit.`).join('\n');
  return snap({ elements, text, url: 'https://shop.example/list', title: 'All products', docH: 4000, ...overrides });
}

/* --------------------------------------------------------------------- tests */

ok('first observation is the full page', () => {
  const r = observation(snap(), null);
  assert.equal(r.mode, 'full');
  assert.equal(r.reason, 'first observation');
  assert.match(r.text, /^URL: https:\/\/shop\.example\/cart/);
  assert.match(r.text, /TITLE: Your cart/);
  assert.match(r.text, /INTERACTIVE:/);
  assert.match(r.text, /PAGE TEXT:/);
  assert.match(r.text, /e4 button "Checkout"/);
});

ok('element line carries value, checked and disabled state', () => {
  const r = observation(
    snap({
      elements: [
        el('e1', 'textbox', 'Email', { value: 'ada@example.com' }),
        el('e2', 'password', 'Password', { sensitive: true }),
        el('e3', 'checkbox', 'Remember', { checked: true }),
        el('e4', 'button', 'Submit', { disabled: true }),
      ],
      text: '',
    }),
    null,
  );
  assert.match(r.text, /e1 textbox "Email" value="ada@example\.com"/);
  assert.match(r.text, /e2 password "Password" \[sensitive: only the user may fill this\]/);
  assert.doesNotMatch(r.text, /value=.*\[sensitive/);
  assert.match(r.text, /e3 checkbox "Remember" \[checked\]/);
  assert.match(r.text, /e4 button "Submit" \[disabled\]/);
});

ok('an identical page produces no diff noise', () => {
  const first = observation(snap(), null);
  const again = observation(snap({ version: 2 }), first.state);
  assert.equal(again.mode, 'diff');
  assert.match(again.text, /No change since the last observation\./);
  assert.doesNotMatch(again.text, /e4 button/);
  assert.ok(again.text.length < 400, `unexpectedly long: ${again.text.length} chars`);
});

ok('scroll alone does not masquerade as a page change', () => {
  const first = observation(snap(), null);
  const moved = observation(snap({ version: 2, scrollY: 300, docH: 1800 }), first.state);
  assert.equal(moved.mode, 'diff');
  assert.match(moved.text, /SCROLL: y=300 of 900 \(33%/);
  assert.match(moved.text, /No change since the last observation\./);
});

ok('added, changed and removed elements are all reported', () => {
  // formatDiff directly, not observation(): on a six-element page a diff is not
  // actually cheaper than the full snapshot, so observation() correctly falls
  // back. The fallback is tested separately; this test is about the content.
  const first = buildState(snap());
  const next = buildState(
    snap({
      version: 2,
      elements: [
        el('e1', 'link', 'Home'),
        // e2 removed: the search box went away
        el('e3', 'link', 'Cart (2)'),
        el('e4', 'button', 'Checkout', { disabled: true }), // changed
        el('e5', 'checkbox', 'Gift wrap', { checked: true }), // changed
        el('e6', 'textbox', 'Coupon'),
        el('e9', 'link', 'Apply promo code'), // added
      ],
    }),
  );
  const r = { text: formatDiff(first, next) };

  assert.match(r.text, /^\+ e9 link "Apply promo code"$/m);
  assert.match(r.text, /^~ e4 button "Checkout" \[disabled\]$/m);
  assert.match(r.text, /^~ e5 checkbox "Gift wrap" \[checked\]$/m);
  assert.match(r.text, /^- e2 textbox "Search"$/m);
  assert.match(r.text, /6 elements total; 1 added, 2 changed, 1 removed/);
  // The unchanged elements must not be repeated.
  assert.doesNotMatch(r.text, /e1 link "Home"/);
});

ok('refs are never reused, so a removal cannot look like an edit', () => {
  const first = buildState(snap());
  const next = buildState(
    snap({
      version: 2,
      elements: [
        el('e1', 'link', 'Home'),
        el('e3', 'link', 'Cart (2)'),
        el('e4', 'button', 'Checkout'),
        el('e5', 'checkbox', 'Gift wrap', { checked: false }),
        el('e6', 'textbox', 'Coupon'),
        el('e10', 'button', 'Continue shopping'),
      ],
    }),
  );
  const r = { text: formatDiff(first, next) };
  assert.match(r.text, /^- e2 textbox "Search"$/m);
  assert.match(r.text, /^\+ e10 button "Continue shopping"$/m);
  assert.doesNotMatch(r.text, /~ e2/);
});

ok('page text is diffed, not resent', () => {
  const first = observation(bigSnap(), null);
  const longer = bigSnap({
    version: 2,
    text: `${bigSnap().text}\nParagraph 13: a newly rendered footer note.`,
  });
  const r = observation(longer, first.state);

  assert.equal(r.mode, 'diff');
  assert.match(r.text, /^\+ Paragraph 13: a newly rendered footer note\.$/m);
  assert.match(r.text, /PAGE TEXT changed at line 13/);
  // Only the new line, not the twelve identical ones above it.
  assert.doesNotMatch(r.text, /Paragraph 1:/);
});

ok('a diff is at least three times smaller than the full page', () => {
  const first = observation(bigSnap(), null);
  const oneChanged = bigSnap({
    version: 2,
    elements: bigSnap().elements.map((e) => (e.ref === 'e20' ? { ...e, name: 'Product 20: price reduced' } : e)),
  });
  const r = observation(oneChanged, first.state);

  assert.equal(r.mode, 'diff');
  const full = formatFull(buildState(oneChanged));
  const ratio = full.length / r.text.length;
  assert.ok(ratio >= 3, `diff is only ${ratio.toFixed(1)}x smaller than full`);
  console.log(`      full ${full.length} chars vs diff ${r.text.length} chars = ${ratio.toFixed(1)}x`);
});

ok('a reload sends the full page again, even at the same URL', () => {
  const first = observation(snap(), null);
  const reloaded = observation(snap({ version: 1, instance: 'bbbb2222' }), first.state);
  assert.equal(reloaded.mode, 'full');
  assert.equal(reloaded.reason, 'page reloaded');
  assert.match(reloaded.text, /INTERACTIVE:/);
});

ok('a navigation sends the full page again', () => {
  const first = observation(snap(), null);
  const moved = observation(snap({ version: 2, url: 'https://shop.example/pay' }), first.state);
  assert.equal(moved.mode, 'full');
  assert.equal(moved.reason, 'url changed');
});

ok('a diff that is most of the page falls back to full', () => {
  const first = observation(snap(), null);
  const churned = observation(
    snap({
      version: 2,
      elements: [
        el('e1', 'link', 'Homepage'),
        el('e2', 'textbox', 'Search the catalogue'),
        el('e3', 'link', 'Basket'),
        el('e4', 'button', 'Pay now'),
        el('e5', 'checkbox', 'Gift options', { checked: true }),
        el('e6', 'textbox', 'Discount code'),
      ],
      text: 'Basket\nFour items\nSubtotal $80.00\nTax $6.40\nTotal $86.40',
    }),
    first.state,
  );
  assert.equal(churned.mode, 'full');
  assert.equal(churned.reason, 'diff not smaller than full');
});

ok('the state passed forward is the one diffed against next time', () => {
  const first = observation(snap(), null);
  const step2 = observation(snap({ version: 2, elements: [...snap().elements, el('e7', 'button', 'Apply')] }), first.state);
  const step3 = observation(snap({ version: 3, elements: [...snap().elements, el('e7', 'button', 'Apply')] }), step2.state);

  assert.equal(step3.mode, 'diff');
  assert.match(step3.text, /No change since the last observation\./);
  assert.doesNotMatch(step3.text, /e7/, 'an element added last step must not be re-announced');
});

ok('textDelta returns nothing for identical text', () => {
  assert.equal(textDelta('a\nb', 'a\nb'), null);
});

ok('long observations are clipped rather than overflowing the request', () => {
  const huge = bigSnap({
    text: Array.from({ length: 400 }, (_, i) => `Line ${i}: filler filler filler filler filler filler`).join('\n'),
  });
  const r = observation(huge, null);
  assert.ok(r.text.length <= 7100, `not clipped: ${r.text.length}`);
  assert.match(r.text, /…\[truncated\]$/);
});

console.log(`\n${checks} checks passed`);
