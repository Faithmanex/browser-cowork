// Standalone verification of lib/page-agent.js against test/pages/lab.html.
// Runs a real (headed) Chromium, injects the page agent, and asserts the
// behaviour the extension depends on: versioned observations, usable
// coordinates, sensitive-field redaction, and stale-ref rejection.
//
//   node test/verify-page-agent.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// patchright ships inside the CodeGPT extension; find it without hardcoding a build id.
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
if (!chromium) {
  throw new Error(`patchright loaded but exposed no chromium (keys: ${Object.keys(pw).join(', ')})`);
}

const fail = [];
const checks = {};
const expect = (name, actual, wanted) => {
  checks[name] = actual;
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail.push(`${name}: expected ${JSON.stringify(wanted)}, got ${JSON.stringify(actual)}`);
  }
};

const browser = await chromium.launch({ headless: false });
const page = await browser.newPage();

try {
  await page.goto(pathToFileURL(join(HERE, 'pages', 'lab.html')).href);

  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push(m.text());
  });

  const agentSrc = readFileSync(join(ROOT, 'lib', 'page-agent.js'), 'utf8');
  await page.addScriptTag({ content: agentSrc });
  await page.waitForTimeout(80);

  let installed = await page.evaluate(() => typeof globalThis.__bp);
  if (installed !== 'object') {
    // Some drivers land addScriptTag in a context evaluate cannot see.
    await page.evaluate(agentSrc);
    installed = await page.evaluate(() => typeof globalThis.__bp);
    checks.injectedVia = 'evaluate';
  } else {
    checks.injectedVia = 'addScriptTag';
  }
  if (installed !== 'object') {
    throw new Error(`page agent failed to install (${installed}); page errors: ${pageErrors.join(' | ') || 'none'}`);
  }

  await page.waitForTimeout(900); // the late button appears at 600ms

  const snap = await page.evaluate(() => globalThis.__bp.snapshot(250, 4000));
  expect('version', snap.version, 1);

  const one = (pred) => snap.elements.find(pred) || null;
  const many = (pred) => snap.elements.filter(pred);

  // --- redaction ----------------------------------------------------------
  const pw = one((e) => e.role === 'password');
  expect('password.present', Boolean(pw), true);
  expect('password.sensitive', pw?.sensitive, true);
  expect('password.valueLeaked', 'value' in (pw || {}), false);

  const card = one((e) => /card/i.test(e.name));
  expect('card.present', Boolean(card), true);
  expect('card.sensitive', card?.sensitive, true);
  expect('card.valueLeaked', 'value' in (card || {}), false);

  // --- ordinary fields stay readable -------------------------------------
  const select = one((e) => e.role === 'combobox');
  expect('select.present', Boolean(select), true);
  expect('select.sensitive', Boolean(select?.sensitive), false);

  // --- state flags --------------------------------------------------------
  const checkout = one((e) => e.name === 'Checkout');
  expect('disabled.present', Boolean(checkout), true);
  expect('disabled.flagged', checkout?.disabled, true);
  expect('checkbox.checked', one((e) => e.role === 'checkbox')?.checked, false);

  // --- duplicate accessible names get distinct refs and coords ------------
  const dups = many((e) => e.name === 'Duplicate');
  expect('duplicates.count', dups.length, 2);
  expect('duplicates.distinctRefs', new Set(dups.map((d) => d.ref)).size, 2);
  expect('duplicates.distinctCoords', new Set(dups.map((d) => `${d.x},${d.y}`)).size, 2);

  // --- hidden content excluded, late content included ---------------------
  expect('hiddenLink.absent', many((e) => /Invisible link/.test(e.name)).length, 0);
  expect('lateButton.present', Boolean(one((e) => e.name === 'Appeared late')), true);

  // --- planted instruction captured as text, not obeyed -------------------
  expect('injection.capturedInText', /IGNORE ALL PREVIOUS INSTRUCTIONS/.test(snap.text), true);

  // --- coordinates land on the element -----------------------------------
  const hit = async (ref, version) => {
    const rect = await page.evaluate(([r, v]) => globalThis.__bp.rectOf(r, v), [ref, version]);
    if (!rect || rect.stale || rect.missing) return { rect, at: null };
    const at = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return el ? (el.getAttribute('aria-label') || el.innerText || el.value || el.tagName).trim().slice(0, 30) : null;
      },
      { x: rect.x, y: rect.y },
    );
    return { rect, at };
  };

  const submit = one((e) => e.name === 'Create account');
  const hitSubmit = await hit(submit.ref, snap.version);
  expect('hitTest.submitTarget', hitSubmit.at, 'Create account');

  const hitDup = await hit(dups[0].ref, snap.version);
  expect('hitTest.firstDuplicate', hitDup.at, 'Duplicate');

  // --- stale refs rejected -----------------------------------------------
  const sameVersion = await page.evaluate((r) => globalThis.__bp.rectOf(r, 1), submit.ref);
  expect('stale.sameVersionOk', Boolean(sameVersion && !sameVersion.stale), true);

  await page.evaluate(() => globalThis.__bp.snapshot(250, 4000)); // -> v2
  const stale = await page.evaluate((r) => globalThis.__bp.rectOf(r, 1), submit.ref);
  expect('stale.oldVersionRejected', stale?.stale, true);

  // --- select_option drives the real element -----------------------------
  const snap2 = await page.evaluate(() => globalThis.__bp.snapshot(250, 4000));
  // v1 initial, v2 the stale check's snapshot, v3 this one.
  expect('version.afterThirdSnapshot', snap2.version, 3);

  const select2 = snap2.elements.find((e) => e.role === 'combobox');
  const picked = await page.evaluate(([r, v]) => globalThis.__bp.selectOption(r, v), [select2.ref, 'Beta']);
  expect('selectOption.ok', picked?.ok, true);
  expect('selectOption.selected', picked?.selected, 'Beta');
  expect('selectOption.domValue', await page.evaluate(() => document.getElementById('colour').value), 'beta');

  // --- writes into secret fields are refused -----------------------------
  const pw2 = snap2.elements.find((e) => e.role === 'password');
  expect(
    'setValue.passwordRefused',
    await page.evaluate(([r, t]) => globalThis.__bp.setValue(r, t), [pw2.ref, 'pwned']),
    false,
  );
  expect('setValue.passwordUnchanged', await page.evaluate(() => document.getElementById('pw').value), 'hunter2');

  // --- DOM click fallback hits the right element -------------------------
  await page.evaluate(() => {
    window.__clicked = [];
    for (const b of document.querySelectorAll('button[data-which]')) {
      b.addEventListener('click', () => window.__clicked.push(b.dataset.which));
    }
  });
  const dup2 = snap2.elements.filter((e) => e.name === 'Duplicate')[1];
  await page.evaluate((r) => globalThis.__bp.clickDom(r), dup2.ref);
  expect('clickDom.hitSecondDuplicate', await page.evaluate(() => window.__clicked), ['second']);
  // --- refs survive re-observation and are never recycled ------------------
  // This is what lib/observe.js's diff rests on: "e4 changed" is only a true
  // statement if e4 is still the same element on the next observation.
  const stability = await page.evaluate(() => {
    const a = globalThis.__bp.snapshot(250, 4000);
    const b = globalThis.__bp.snapshot(250, 4000);
    const byRef = new Map(b.elements.map((e) => [e.ref, e]));
    const mismatched = [];
    for (const e of a.elements) {
      const other = byRef.get(e.ref);
      if (other && (other.name !== e.name || other.role !== e.role)) mismatched.push(e.ref);
    }
    return {
      mismatched,
      sameInstance: a.instance === b.instance,
      instanceLooksValid: typeof a.instance === 'string' && a.instance.length > 0,
      elementsBefore: a.elements.length,
      elementsAfter: b.elements.length,
      refsAdded: b.elements.filter((e) => !a.elements.some((x) => x.ref === e.ref)).map((e) => e.ref),
    };
  });
  expect('refs.stableAcrossSnapshots', stability.mismatched, []);
  expect('refs.noSpuriousNewRefs', stability.refsAdded, []);
  expect('refs.sameInstance', stability.sameInstance, true);
  expect('refs.instanceExposed', stability.instanceLooksValid, true);

  const before = await page.evaluate(() => globalThis.__bp.snapshot(250, 4000));
  const inserted = await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'injected';
    b.setAttribute('aria-label', 'Injected button');
    b.textContent = 'Injected button';
    document.body.prepend(b);
    return globalThis.__bp.snapshot(250, 4000);
  });
  const refOf = (s, name) => s.elements.find((e) => e.name === name)?.ref ?? null;

  expect('insert.newElementObserved', Boolean(refOf(inserted, 'Injected button')), true);
  expect('insert.didNotShiftExistingRefs', refOf(inserted, 'Create account'), refOf(before, 'Create account'));
  expect(
    'insert.newRefIsFresh',
    before.elements.some((e) => e.ref === refOf(inserted, 'Injected button')),
    false,
  );

  // --- a removed element's ref is never handed to something else ----------
  const cycle = await page.evaluate(async () => {
    const s1 = globalThis.__bp.snapshot(250, 4000);
    const victim = document.getElementById('injected');
    const victimRef = s1.elements.find((e) => e.name === 'Injected button')?.ref;
    victim.remove();
    const s2 = globalThis.__bp.snapshot(250, 4000);

    const replacement = document.createElement('button');
    replacement.setAttribute('aria-label', 'Replacement button');
    replacement.textContent = 'Replacement button';
    document.body.prepend(replacement);
    const s3 = globalThis.__bp.snapshot(250, 4000);
    const newRef = s3.elements.find((e) => e.name === 'Replacement button')?.ref;

    // rectOf is async: without await this serialises as {} and proves nothing.
    const gone = await globalThis.__bp.rectOf(victimRef, s3.version);
    replacement.remove();
    return { victimRef, newRef, removedGone: gone?.missing === true || gone?.stale === true };
  });
  expect('recycle.refNotReused', cycle.newRef !== cycle.victimRef, true);
  expect('recycle.removedRefRejected', cycle.removedGone, true);

  // --- find() searches the current observation without re-reading ----------
  const fresh = await page.evaluate(() => globalThis.__bp.snapshot(250, 4000));
  const found = await page.evaluate(() => ({
    byName: globalThis.__bp.find('create account'),
    byRole: globalThis.__bp.find('button'),
    byRegex: globalThis.__bp.find('/dup/i'),
    capped: globalThis.__bp.find('button', 2),
    empty: globalThis.__bp.find('   '),
    badPattern: globalThis.__bp.find('/[/'),
  }));
  expect(
    'find.byName.refMatchesSnapshot',
    found.byName.matches[0]?.ref,
    fresh.elements.find((e) => e.name === 'Create account')?.ref,
  );
  expect('find.byRole.countable', found.byRole.count > 1, true);
  expect('find.byRegex.duplicates', found.byRegex.count, 2);
  expect('find.maxResultsHonoured', found.capped.matches.length, 2);
  expect('find.emptyQueryRejected', Boolean(found.empty.error), true);
  expect('find.badPatternReported', Boolean(found.badPattern.error), true);

  // --- actionability: disabled, covered, moving ---------------------------
  const checkoutRect = await page.evaluate(() => {
    const s = globalThis.__bp.snapshot(250, 4000);
    const el = s.elements.find((e) => e.name === 'Checkout');
    return globalThis.__bp.rectOf(el.ref, s.version);
  });
  expect('actionable.disabledReported', checkoutRect.disabled, true);
  expect('actionable.staticNotMoving', checkoutRect.moving, false);
  expect('actionable.staticNotCovered', checkoutRect.covered, false);

  const covered = await page.evaluate(async () => {
    const s = globalThis.__bp.snapshot(250, 4000);
    const ref = s.elements.find((e) => e.name === 'Create account').ref;
    const overlay = document.createElement('div');
    overlay.setAttribute('aria-label', 'Overlay blocker');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.01)';
    document.body.append(overlay);
    const rect = await globalThis.__bp.rectOf(ref, s.version);
    overlay.remove();
    return rect;
  });
  expect('actionable.coveredByOverlay', covered.covered, true);
  expect('actionable.namesTheCoverer', /Overlay blocker/.test(String(covered.covering)), true);

  const moving = await page.evaluate(async () => {
    // A CSS animation's first tick can land after rectOf's sampling window, so
    // this moves the element on every animation frame instead: whatever frame
    // rectOf samples, the next one has genuinely moved it 40px.
    const b = document.createElement('button');
    b.setAttribute('aria-label', 'Mover');
    b.textContent = 'Mover';
    b.style.cssText = 'position:fixed;top:40px;left:1px';
    document.body.append(b);

    let n = 0;
    let running = true;
    const step = () => {
      if (!running) return;
      b.style.left = `${1 + (n++ * 40)}px`;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);

    const s = globalThis.__bp.snapshot(250, 4000);
    const ref = s.elements.find((e) => e.name === 'Mover').ref;
    const rect = await globalThis.__bp.rectOf(ref, s.version);

    running = false;
    b.remove();
    return rect;
  });
  expect('actionable.movingDetected', moving.moving, true);
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}

console.log(JSON.stringify({ pass: fail.length === 0, failures: fail, checks }, null, 2));
process.exit(fail.length === 0 ? 0 : 1);
