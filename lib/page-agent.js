// Injected into the page's isolated world.
// Produces versioned observations of the page and exposes the primitives the
// background worker drives. Re-injection is a no-op.
(() => {
  if (globalThis.__bp) return;

  const SELECTOR = [
    'a[href]',
    'button',
    'input:not([type=hidden])',
    'select',
    'textarea',
    'summary',
    '[role=button]',
    '[role=link]',
    '[role=checkbox]',
    '[role=radio]',
    '[role=tab]',
    '[role=menuitem]',
    '[role=menuitemcheckbox]',
    '[role=switch]',
    '[role=combobox]',
    '[role=option]',
    '[role=slider]',
    '[role=searchbox]',
    '[role=textbox]',
    '[contenteditable=true]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  // Fields whose contents must never enter an observation or a log.
  const SENSITIVE =
    /(pass(word|phrase)?|pwd|card.?number|card.?num|cc.?num|cvv|cvc|csc|ssn|social.?security|tax.?id|pin\b|iban|account.?(number|no)|routing|sort.?code|secret|otp|one.?time.?code|security.?answer)/i;

  /** @type {Map<string, Element>} ref -> element for the latest observation only */
  let refs = new Map();

  /**
   * element -> ref, kept for the lifetime of this document.
   *
   * An element keeps the same ref across observations, which is what makes a
   * diff meaningful: "e7 changed" can only be true if e7 is the same element.
   * An element that leaves the page keeps its entry here but drops out of
   * `refs`, so an old ref fails cleanly instead of silently pointing at
   * whatever now occupies that position.
   */
  const index = new WeakMap();

  let counter = 0;
  let version = 0;

  // Identifies this injected script instance. A reload or navigation produces a
  // new one, which tells the panel its cached refs are from another document
  // even when the URL looks the same.
  const INSTANCE = Math.random().toString(36).slice(2, 10);

  const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const frames = () => new Promise((r) => requestAnimationFrame(() => r()));

  function isVisible(el) {
    if (!el.isConnected) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    if (r.bottom < -3000 || r.top > window.innerHeight + 6000) return false;
    return true;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (el.isContentEditable) return 'textbox';
    if (tag === 'input') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'password') return 'password';
      if (type === 'checkbox' || type === 'radio') return type;
      // A range input is a slider, not a text field. Reporting it as a textbox
      // made the model try to type a value into a scrubber.
      if (type === 'range') return 'slider';
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    // Frames are reported so the model knows the page continues inside one, and
    // where. Coordinate actions (click_at, drag, hover) reach into them because
    // the browser delivers events by hit-testing, not per document.
    if (tag === 'iframe' || tag === 'frame') return 'frame';
    return tag;
  }

  function nameOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent)
        .filter(Boolean)
        .join(' ');
      if (norm(text)) return norm(text);
    }

    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return norm(label.textContent);
    }

    for (const attr of ['placeholder', 'alt', 'title', 'name']) {
      const v = el.getAttribute(attr);
      if (v && norm(v)) return norm(v);
    }

    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes((el.type || '').toLowerCase())) {
      if (norm(el.value)) return norm(el.value);
    }

    return norm(el.innerText || el.textContent || '').slice(0, 160);
  }

  /** True when this field holds a secret the model must never see or fill. */
  function isSensitive(el) {
    if ((el.type || '').toLowerCase() === 'password') return true;
    const hints = [
      el.getAttribute('name'),
      el.id,
      el.getAttribute('placeholder'),
      el.getAttribute('aria-label'),
      el.getAttribute('autocomplete'),
      el.getAttribute('data-testid'),
    ]
      .filter(Boolean)
      .join(' ');
    return SENSITIVE.test(hints);
  }

  function pageText(limit) {
    const root = document.body || document.documentElement;
    let text = '';
    try {
      text = root.innerText || '';
    } catch {
      text = root.textContent || '';
    }
    text = text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    if (limit && text.length > limit) return `${text.slice(0, limit)}\n…[truncated]`;
    return text;
  }

  /** Stable ref for an element. Never reused, so a diff can trust it. */
  function refFor(el) {
    let ref = index.get(el);
    if (!ref) {
      ref = `e${++counter}`;
      index.set(el, ref);
    }
    refs.set(ref, el);
    return ref;
  }

  /** A frame has no text content, so name it from its attributes or its src. */
  function frameName(el) {
    const label = el.getAttribute('title') || el.getAttribute('aria-label') || el.getAttribute('name');
    if (label && norm(label)) return norm(label).slice(0, 80);
    const src = el.getAttribute('src') || '';
    if (!src) return 'inline frame';
    try {
      const u = new URL(src, location.href);
      return `${u.host}${u.pathname}`.slice(0, 80);
    } catch {
      return src.slice(0, 80);
    }
  }

  /**
   * Which match this page is about.
   *
   * "Set up 4 live games" is unanswerable if every panel reports the same
   * title: the agent cannot tell a fixture list from a match page, or one
   * panel's game from another's, and has to fall back to reading page text for
   * each view. SportyBet and Betano both print the two team names in a header
   * under different class names, so read those and fall back to the page's most
   * prominent heading.
   */
  function fixture() {
    const names = [];
    const add = (value) => {
      let text = norm(value || '').replace(/\s+/g, ' ').trim();
      // SportyBet renders the score inside the team element: "Qatar 0".
      text = text.replace(/\s+\d{1,2}$/, '').trim();
      if (!text || text.length > 48) return;
      if (names.some((n) => n.toLowerCase() === text.toLowerCase())) return;
      names.push(text);
    };
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width >= 4 || r.height >= 4;
    };

    // The URL is the one source that cannot be ambiguous: an event path is
    // /.../Home_vs_Away/sr:match:123. A listing or search page has no such
    // segment and correctly reports nothing.
    const fromUrl = () => {
      const m = /[/_]([A-Za-z0-9.'’%()-]+)_vs_([A-Za-z0-9.'’%()-]+)(?:[/?_]|$)/.exec(
        decodeURIComponent(location.pathname || ''),
      );
      if (!m) return '';
      const clean = (s) => s.replace(/_/g, ' ').trim();
      return `${clean(m[1])} vs ${clean(m[2])}`;
    };

    // Explicit sides first: this is what a Betano event page exposes.
    const home = document.querySelector(
      '[data-qa*="home-team"], [data-qa*="participant-home"], [class*="home-team"], [class*="homeTeam"]',
    );
    const away = document.querySelector(
      '[data-qa*="away-team"], [data-qa*="participant-away"], [class*="away-team"], [class*="awayTeam"]',
    );
    if (home && away && visible(home) && visible(away)) {
      add(home.textContent);
      add(away.textContent);
      if (names.length === 2) return `${names[0]} vs ${names[1]}`;
    }

    // Two elements, one per team, and the page had better contain exactly two:
    // a listing page has dozens, and naming its first match would be a lie.
    const pair = (selector) => {
      const els = [...document.querySelectorAll(selector)].filter(visible);
      if (els.length !== 2) return null;
      names.length = 0;
      for (const el of els) add(el.textContent);
      return names.length === 2 ? `${names[0]} vs ${names[1]}` : null;
    };

    // SportyBet mobile: two team-name elements carrying the score.
    const sporty = pair('[class*="team-name"]');
    if (sporty) return sporty;

    // A single event page that exposes exactly two participants.
    const participants = pair('[data-qa*="participant"], [class*="participant-name"]');
    if (participants) return participants;

    // "A vs B" in one heading.
    const heading = document.querySelector('h1, [class*="match-title"], [class*="event-title"]');
    const text = heading ? norm(heading.textContent) : '';
    const parts = text.split(/\s+(?:vs\.?|v|-|–|—)\s+/i).map((p) => p.trim());
    if (parts.length === 2) {
      names.length = 0;
      add(parts[0]);
      add(parts[1]);
      if (names.length === 2) return `${names[0]} vs ${names[1]}`;
    }

    // Last resort, and the most reliable one on a match page whose header is
    // off-screen or re-rendered: the fixture is in the URL.
    return fromUrl();
  }

  /* ------------------------------------------------- the SportyBet HUD ---- */

  // The HUD's own state lives in the extension's isolated world, so
  // window.SportlySB is undefined here even while the HUD is on screen. What is
  // shared is the DOM: the HUD renders every readout into an element with an
  // sbfb- id. Reading those is what makes "is this panel bound?" one short call
  // instead of a full observation per panel.
  const hudEl = () => document.getElementById('sbfb-hud') || document.querySelector('[id^="sbfb-hud"]');

  const hudText = (id) => {
    const el = document.getElementById(id);
    const raw = el ? (el.value !== undefined && el.value !== '' ? el.value : el.textContent) : '';
    return norm(raw || '');
  };

  // The HUD writes an em dash or a hyphen when a field is empty.
  const emptyReadout = (v) => !v || v === '—' || v === '–' || v === '-';

  function hudState() {
    if (!hudEl()) return { present: false };

    const bound = hudText('sbfb-bound');
    return {
      present: true,
      stage: (hudText('sbfb-state') || 'idle').toLowerCase(),
      fixture: fixture(),
      bound: emptyReadout(bound) ? '' : bound.replace(/^"|"$/g, ''),
      marketKey: hudText('sbfb-marketkey'),
      marketTitle: hudText('sbfb-market'),
      oddsHome: emptyReadout(hudText('sbfb-ho')) ? null : hudText('sbfb-ho'),
      oddsAway: emptyReadout(hudText('sbfb-ao')) ? null : hudText('sbfb-ao'),
      team: emptyReadout(hudText('sbfb-team')) ? null : hudText('sbfb-team'),
      stake: emptyReadout(hudText('sbfb-stake')) ? null : hudText('sbfb-stake'),
      win: emptyReadout(hudText('sbfb-win')) ? null : hudText('sbfb-win'),
      balance: emptyReadout(hudText('sbfb-bal')) ? null : hudText('sbfb-bal'),
      confirmSheet: !!document.querySelector('[data-op=betslip-confirm-wrap]'),
    };
  }

  /** The market cards the page has mounted right now, keyed. */
  function marketCards() {
    return [...document.querySelectorAll('.m-market[market-key]')]
      .map((el) => ({
        key: el.getAttribute('market-key') || '',
        title: norm((el.querySelector('.m-market-title .text') || el.querySelector('.m-market-title') || {}).textContent || ''),
      }))
      .filter((m) => m.key);
  }

  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Bring a lazily-mounted market card into the DOM.
   *
   * SportyBet mounts markets as the page scrolls, and a card that is not mounted
   * looks exactly like a market that does not exist. The HUD scrolls for this
   * reason; without the same walk, "not mounted" and "not offered" are the same
   * answer, and only one of them is worth reporting.
   */
  async function mountMarket(key) {
    if (!key) return null;
    const find = () => document.querySelector(`.m-market[market-key="${key}"]`);
    const found = find();
    if (found) return found;

    const y0 = window.scrollY;
    try {
      for (let i = 0; i < 8; i += 1) {
        const atBottom =
          window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 60;
        if (atBottom && i > 0) break;
        window.scrollBy(0, 400);
        await sleepMs(200);
        const card = find();
        if (card) {
          card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          return card;
        }
      }
    } finally {
      if (!find()) window.scrollTo(0, y0);
    }
    return null;
  }

  /** The same walk, but satisfied by the first keyed market of any kind. */
  async function mountAnyMarket() {
    if (document.querySelector('.m-market[market-key]')) return;
    for (let i = 0; i < 8; i += 1) {
      window.scrollBy(0, 400);
      await sleepMs(180);
      if (document.querySelector('.m-market[market-key]')) return;
    }
  }

  /**
   * Bind a market by key, through the HUD's own key field.
   *
   * The failure this replaces: Pick Market binds whatever card is nearest the
   * click, and in a narrow panel that was routinely the wrong market — the
   * first honest signal was the BOUND readout afterwards. Typing the key into
   * the field the HUD already trusts leaves nothing to mis-hit.
   *
   * Sites dispatch real change events, which is why the value is set through
   * the native setter: React's inputs ignore a plain assignment.
   */
  async function bindMarket(marketKey, title) {
    if (!hudEl()) {
      return {
        ok: false,
        missingHud: true,
        error:
          'The SB Fast Bet HUD is not on this page, so there is no market to bind. ' +
          'Reload the panel first — the extension injects the HUD on load and a ' +
          'reload is usually all it takes. If it is still missing, this is not a ' +
          'SportyBet match page.',
      };
    }

    const key = norm(marketKey);
    const wanted = norm(title);
    if (!key && !wanted) return { ok: false, error: 'marketKey is required, e.g. "market-8".' };

    const keyInput = document.getElementById('sbfb-marketkey');
    const titleInput = document.getElementById('sbfb-market');
    if (!keyInput || !titleInput) {
      return {
        ok: false,
        error: 'The HUD is on the page but its market fields are not, so it cannot be driven from here.',
      };
    }

    const setField = (el, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    // The HUD keeps one of the two: a title clears the key and vice versa. So
    // clear both first, then set the one that was asked for.
    setField(titleInput, '');
    setField(keyInput, '');

    /**
     * The HUD's own binder falls back to the *first card on the page* when a
     * key matches nothing and no title is set. So a typo in the key does not
     * fail — it silently binds a different market, which is exactly the bug this
     * tool exists to remove. Prove the card is there before letting the HUD
     * anywhere near it.
     */
    if (!wanted && key && !(await mountMarket(key))) {
      await mountAnyMarket();
      const available = marketCards();
      return {
        ok: false,
        marketKey: key,
        error:
          `No market with key "${key}" is on this page, so nothing was bound (the HUD would otherwise ` +
          'fall back to the first market it can see). Markets mount as the page scrolls, and a late-stage ' +
          'match drops them as it progresses. ' +
          (available.length
            ? 'This page offers the keys in available — choose the goal market from there.'
            : 'Nothing is mounted: open a market tab (All, Goals) on the match page first.'),
        available,
      };
    }

    // One or the other, never both: the HUD's title field clears its key field,
    // so setting both would leave whichever ran second in charge.
    if (wanted) setField(titleInput, wanted);
    else setField(keyInput, key);

    // renderHud is synchronous, but the page's own market listener may not have
    // run yet; a few frames is cheaper than a wrong answer.
    let state = hudState();
    for (let i = 0; i < 6 && !state.bound; i += 1) {
      await sleepMs(120);
      state = hudState();
    }

    const available = marketCards();

    if (!state.bound) {
      // "Not found" is only useful if it says what *is* there. Markets mount on
      // scroll, so before declaring absence, mount whatever this page does have
      // and name it — the goal key is not always market-8 (on a match page it
      // was market-19), and the model needs that list to choose from.
      if (!available.length) {
        await mountAnyMarket();
        available.push(...marketCards());
      }

      const hasKey = available.some((m) => m.key === key);
      return {
        ok: false,
        marketKey: state.marketKey || key,
        error: hasKey
          ? `"${key}" is mounted but the HUD would not bind it: the card must offer two sides.`
          : `No market with key "${key}" is mounted on this page. Markets mount as the page scrolls, and a ` +
            'late-stage match drops them as it progresses (a 4-0 game has no 1st Goal card at all). ' +
            (available.length
              ? 'This page currently offers the keys in available — pick the goal market from there.'
              : 'Nothing is mounted: open a market tab (All, Goals) on the match page first.'),
        available,
      };
    }

    return {
      ok: true,
      marketKey: state.marketKey || key,
      bound: state.bound,
      home: state.oddsHome,
      away: state.oddsAway,
      stage: state.stage,
      fixture: state.fixture,
    };
  }


  /**
   * The live list as rows, not text: fixture, clock, period, score, and which
   * extra markets the row offers.
   *
   * Picking a fixture by eye from a screenshot is how you end up staging a game
   * that kicked off ninety minutes ago. `nextGoal` is the honest answer to
   * "can this fixture carry a goal market at all?".
   */
  function liveRows() {
    const rows = [];
    const seen = new Set();

    const add = (row, status) => {
      if (!row || seen.has(row) || !isVisible(row)) return;
      seen.add(row);

      const teams = [...row.querySelectorAll('.m-info-cell .team, .team')]
        .map((el) => norm(el.textContent))
        .filter(Boolean);
      if (teams.length < 2) return;

      const score = [...row.querySelectorAll('.m-table-cell.score .set-score, .set-score')].map((el) =>
        norm(el.textContent),
      );
      const chips = [...row.querySelectorAll('.m-additional-market-wrapper .m-info-cell')].map((el) =>
        norm(el.textContent),
      );
      const rect = row.getBoundingClientRect();

      rows.push({
        status,
        home: teams[0],
        away: teams[1],
        score: score.length >= 2 ? `${score[0]}-${score[1]}` : '',
        // A live row has a running clock and a period; an upcoming one has a
        // kickoff time. Reporting kickoff as "clock" would be the lie that made
        // a finished match look playable.
        clock: norm(row.querySelector('.m-event-time')?.textContent || ''),
        period: norm(row.querySelector('.match-status')?.textContent || ''),
        kickoff: norm(row.querySelector('.m-time')?.textContent || ''),
        league: norm(row.querySelector('.m-league-name')?.textContent || ''),
        gameId: norm(row.querySelector('.m-game-id')?.textContent || '').replace(/^ID\s*/i, ''),
        markets: chips,
        // Unknown on an upcoming row: the chips are only rendered for live.
        nextGoal: chips.length ? chips.some((c) => /goal/i.test(c)) : null,
        // No href on these rows — the click is what routes. These are viewport
        // coordinates for click_at, and inViewport says whether it can be hit.
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        inViewport: rect.bottom > 0 && rect.top < window.innerHeight,
      });
    };

    // data-op is the semantic hook; the classes are what changed between two
    // builds of the same page.
    for (const row of document.querySelectorAll('[data-op="label-event-live"], .m-event-live, .m-live-row')) {
      add(row, 'live');
    }
    for (const row of document.querySelectorAll('[data-op="label-prematch"], .m-event-sport, .m-sports-row')) {
      add(row, 'upcoming');
    }

    return rows;
  }

  function snapshot(maxElements, maxText) {
    version += 1;
    refs = new Map();

    const elements = [];
    const seen = new Set();

    for (const el of document.querySelectorAll(SELECTOR)) {
      if (elements.length >= maxElements) break;
      if (seen.has(el)) continue;
      seen.add(el);
      if (!isVisible(el)) continue;

      const rect = el.getBoundingClientRect();
      const ref = refFor(el);
      const role = roleOf(el);
      const item = {
        ref,
        role,
        name: nameOf(el),
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };

      if (el.disabled) item.disabled = true;
      if (role === 'checkbox' || role === 'radio') item.checked = Boolean(el.checked);
      if (role === 'password' || isSensitive(el)) {
        item.sensitive = true;
      } else if (role === 'slider') {
        // A slider's position is the thing you want; min/max say what the
        // number means, and where the handle sits on the track.
        const native = el.tagName === 'INPUT';
        const value = native ? el.value : el.getAttribute('aria-valuenow');
        if (value != null && value !== '') item.value = String(value);
        const min = native ? el.min : el.getAttribute('aria-valuemin');
        const max = native ? el.max : el.getAttribute('aria-valuemax');
        if (min != null && min !== '') item.min = String(min);
        if (max != null && max !== '') item.max = String(max);
      } else if (['textbox', 'searchbox', 'combobox'].includes(role) && 'value' in el && el.value) {
        item.value = String(el.value).slice(0, 120);
      }
      if (el.tagName === 'A' && el.href) item.href = el.href;
      const expanded = el.getAttribute('aria-expanded');
      if (expanded) item.expanded = expanded === 'true';

      elements.push(item);
    }

    // Frames are appended last so they cannot renumber the controls above.
    // The size is included because the model needs to know the region it can
    // click into, and because a canvas editor inside a frame is otherwise
    // invisible to this observation.
    for (const el of document.querySelectorAll('iframe, frame')) {
      if (elements.length >= maxElements + 8) break;
      if (!isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      const item = {
        ref: refFor(el),
        role: 'frame',
        name: frameName(el),
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
      if (el.src) item.href = el.src;
      elements.push(item);
    }

    return {
      version,
      instance: INSTANCE,
      url: location.href,
      title: document.title,
      match: fixture(),
      scrollY: Math.round(window.scrollY),
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      docH: document.documentElement.scrollHeight,
      elements,
      text: pageText(maxText),
    };
  }

  /** Viewport and pixel ratio, for mapping screenshots back to click points. */
  const viewport = () => ({
    w: window.innerWidth,
    h: window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  });

  /** What is actually at a point? Lets click_at report what it hit. */
  function hitTest(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return null;
    return { tag: el.tagName.toLowerCase(), label: describeNode(el).slice(0, 80) };
  }

  const currentVersion = () => version;

  function describeNode(el) {
    if (!el) return '';
    const label = nameOf(el).slice(0, 40);
    return label ? `${el.tagName.toLowerCase()} "${label}"` : el.tagName.toLowerCase();
  }

  /**
   * Scroll a ref into view and return viewport-relative centre coordinates,
   * plus the checks the caller needs before sending a real mouse event:
   * is it enabled, is it still moving, and is something else on top of it.
   * Returns `{ stale: true }` when the ref belongs to an older observation.
   */
  async function rectOf(ref, expectedVersion) {
    if (typeof expectedVersion === 'number' && expectedVersion !== version) {
      return { stale: true, expectedVersion, currentVersion: version };
    }

    const el = refs.get(ref);
    if (!el || !el.isConnected) return { missing: true };

    el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    await frames();

    // A moving target is a mis-click waiting to happen. Most transitions have
    // settled by the next frame; report honestly if this one never does.
    let r = el.getBoundingClientRect();
    let moving = false;
    for (let i = 0; i < 4; i++) {
      const before = r;
      await frames();
      r = el.getBoundingClientRect();
      moving = Math.abs(r.left - before.left) > 1 || Math.abs(r.top - before.top) > 1;
      if (!moving) break;
    }

    if (r.width < 1 || r.height < 1) return { missing: true };

    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);

    // What is actually at that point? If it is neither this element nor a
    // descendant, a real mouse click would land on whatever is covering it.
    const hit = document.elementFromPoint(x, y);
    const covered = Boolean(hit) && hit !== el && !el.contains(hit);

    return {
      x,
      y,
      w: Math.round(r.width),
      h: Math.round(r.height),
      label: nameOf(el).slice(0, 80),
      sensitive: isSensitive(el),
      role: roleOf(el),
      disabled: Boolean(el.disabled),
      moving,
      covered,
      covering: covered ? describeNode(hit) : undefined,
    };
  }

  /**
   * Search the latest observation instead of re-reading the whole page.
   * Plain text matches case-insensitively against role and accessible name;
   * `/pattern/flags` is treated as a regular expression.
   */
  function find(query, maxResults = 20) {
    const q = String(query || '').trim();
    if (!q) return { matches: [], error: 'Empty query.' };

    let test;
    try {
      if (/^\/.*\/[a-z]*$/.test(q)) {
        const end = q.lastIndexOf('/');
        const re = new RegExp(q.slice(1, end), q.slice(end + 1) || 'i');
        test = (s) => re.test(s);
      } else {
        const needle = q.toLowerCase();
        test = (s) => s.toLowerCase().includes(needle);
      }
    } catch (err) {
      return { matches: [], error: `Bad pattern: ${err.message}` };
    }

    const matches = [];
    for (const [ref, el] of refs) {
      if (matches.length >= maxResults) break;
      if (!el.isConnected) continue;

      const role = roleOf(el);
      const name = nameOf(el);
      if (!test(name) && !test(role)) continue;

      const r = el.getBoundingClientRect();
      matches.push({
        ref,
        role,
        name: name.slice(0, 120),
        // Viewport-relative, like every coordinate the click tools take. The
        // scroll offset rides along so a match that is off-screen reads as
        // off-screen instead of as a click target at a plausible number.
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + r.height / 2),
        scrollY: Math.round(window.scrollY),
        inViewport: r.bottom > 0 && r.top < window.innerHeight,
        disabled: Boolean(el.disabled) || undefined,
        sensitive: isSensitive(el) || undefined,
      });
    }

    return { count: matches.length, matches };
  }

  function describe(ref) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) return null;
    return {
      role: roleOf(el),
      name: nameOf(el).slice(0, 120),
      href: el.tagName === 'A' ? el.href : undefined,
      sensitive: isSensitive(el),
    };
  }

  // --- fallbacks used only when the debugger API is unavailable -------------

  function clickDom(ref) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) return false;
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: Math.round(r.left + r.width / 2),
      clientY: Math.round(r.top + r.height / 2),
    };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...opts, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', { ...opts, isPrimary: true }));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
    return true;
  }

  function setValue(ref, text) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) return false;
    if (isSensitive(el)) return false;
    el.focus({ preventScroll: true });
    const proto =
      el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter && 'value' in el) setter.call(el, text);
    else if (el.isContentEditable) el.textContent = text;
    else if ('value' in el) el.value = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function selectOption(ref, wanted) {
    const el = refs.get(ref);
    if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'That element is not a <select>.' };

    const want = String(wanted).trim().toLowerCase();
    const options = [...el.options];
    const match =
      options.find((o) => o.value.toLowerCase() === want) ||
      options.find((o) => norm(o.textContent).toLowerCase() === want) ||
      options.find((o) => norm(o.textContent).toLowerCase().includes(want));

    if (!match) {
      return { ok: false, error: `No option matching "${wanted}".`, options: options.map((o) => norm(o.textContent)).slice(0, 40) };
    }

    el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: norm(match.textContent) };
  }

  /**
   * Set a native range input's value. Dragging the handle is the other way, but
   * for a scrubber a numeric set is more precise and does not depend on the
   * thumb's pixel position. ARIA sliders are refused: writing aria-valuenow
   * would change nothing on the page's own model.
   */
  function setRange(ref, value) {
    const el = refs.get(ref);
    if (!el || !el.isConnected) return { ok: false, error: 'That ref is no longer on the page.' };
    if (el.tagName !== 'INPUT' || (el.type || '').toLowerCase() !== 'range') {
      return { ok: false, error: 'Not a native range input. Click or drag its handle instead.' };
    }

    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, error: 'value must be a number.' };

    const min = Number(el.min || 0);
    const max = Number(el.max || 100);
    const target = Math.min(max, Math.max(min, n));

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (setter) setter.call(el, String(target));
    else el.value = String(target);

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: Number(el.value), min, max };
  }

  function scrollByPage(dy) {
    window.scrollBy({ top: dy, left: 0, behavior: 'instant' });
    return Math.round(window.scrollY);
  }

  globalThis.__bp = {
    instance: () => INSTANCE,
    snapshot,
    viewport,
    hitTest,
    currentVersion,
    rectOf,
    find,
    describe,
    clickDom,
    setValue,
    setRange,
    selectOption,
    scrollByPage,
    hudState,
    bindMarket,
    liveRows,
  };
})();
