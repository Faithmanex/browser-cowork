---
name: feather-bet-setup
description: Operates Feather (Sportly Multiview): the workspace, its panels and accounts, the SB Fast Bet HUD on SportyBet, and the SportyBet/Betano sites. Covers setting up games, arranging views, reading observations, every agent tool, and troubleshooting. Use for any request to set up, stage, prepare, arrange, inspect or debug games, matches, tabs, slips or accounts in Feather.
---

# Feather: operating manual

Feather is a Windows browser for preparing football bets across several
logged-in accounts at once. One WebView2 panel per account, all visible, with a
betting HUD injected into every SportyBet panel. The agent works the panels and
the app itself; the user keeps the final say on money.

**You work the whole workspace.** There is no selected tab and nothing to switch
to: a task opens with a `WORKSPACE` observation listing every view, and every
page tool takes a `panelId`. Name the view you mean, and work several of them in
one task.

**Act first.** The four steps below are the whole procedure for setting up a
game. Do not read reference files before acting — everything needed to start is
on this page. If a step fails, or you need a specific detail (hotkeys, config
defaults, site selectors), load at most one reference, then continue.

## Fast path, learned the slow way

Do these before the first click on any SportyBet panel. Each one cost a session
to discover, and skipping them costs the same again:

- **Zoom 0.4, hide the HUD, or drag it aside.** At 1:1 in a narrow panel the HUD
  covers the fixture list and every market row, so every real click is refused as
  covered. Three ways out, cheapest first: drag the HUD by its header
  (`#sbfb-drag`) to a corner of the panel, `set_zoom {factor: 0.4}`, or hide it
  (`ctrl+shift+f`). Dragging keeps the readouts visible, which is usually what
  you want while working; hiding is for when it is only in the way.
- **Navigate by search, never by URL you remember.** SportyBet match URLs carry
  per-match ids and a guessed one 404s into the footer. Open `/ng/m/search`,
  type the team, **then send Enter as its own action** — `type_text` with
  `submit:true` does not fire this site's search.
- **Look at the clock before committing.** Pick fixtures under about 60 minutes.
  A 4-0 game has no 1st Goal card at all, and at 89' no live category loads.
- **Bind with `bind_market`, not Pick Market.** Pick Market binds whichever card
  is nearest the click, which in a narrow panel was often the wrong market. Ask
  for the key and read back what was bound.
- **Reset the HUD first if it is in ATTACK.** Press `0` (or the HUD's cancel)
  and confirm IDLE; a busy HUD drops a bind.
- **Betano is one navigate.** `/live/<home-away-slug>/<eventId>/`, both from the
  live-list row's link. No searching, no scrolling, no staking.

## The job: set up a game

1. **Find the fixture** — `survey_panels` gives every view with its `MATCH`.
   Pick the view you will use; `read_panel` it if you need more than the summary.
   Never assume what a panel is showing. On a live list, `list_live_fixtures`
   gives rows with clock, score and `nextGoal` — choose from those, not from a
   screenshot of a collapsed list.
2. **Bind the market** — `bind_market {panelId, marketKey}` (add `title` when you
   only know the market's name). `market-8` is the usual goal key on a live list,
   but a match page re-keys its markets: `market-19`, `market-450006` and friends
   appear, and the goal card is whichever one carries a "Nth Goal" title. Read
   the returned `bound` title — and when the key you tried is not there, the
   reply lists the keys the page does have. Start from that list, not from a key
   you remember.
3. **Pick the side** — Home or Away for the bound market.
4. **Enter the stake** — on the site keypad (Clear → digits → Done), then verify
   the slip shows that stake against `[data-op=betslip-single-stake]`.

The slip is then set up. Do not press Place Bet or confirm the sheet unless the
user asked for a bet in this or an earlier message.

**Several games** ("set up 4 games", "one per account"): each panel is one
account, one login, one slip. Do the four steps per panel, passing `panelId` to
every page tool, and survey once at the start rather than re-surveying each
time. Do not open extra panels unless the user asked for more accounts.

## Elevated actions

Place Bet, the Confirm to Pay sheet, and the auto-place / auto-rebet toggles.
Everything else — navigating, opening panels, binding, choosing sides, typing a
stake, arranging, zooming, changing deck settings — is ordinary work.

## Standing rules

- A stake is never invented. Use the HUD's current stake if none was given;
  otherwise ask once, briefly.
- Prefer acting and stating your assumption in one line over asking what the
  instruction means. The app's purpose is on this page; you never need to ask.
- Sync scroll moves every panel. Turn it off (`set_setting syncScroll false`)
  before scrolling one panel, and say that you did.
- A narrow panel needs `set_zoom` with a factor (0.7–0.8); `fit` goes unreadable
  with many panels open. On SportyBet, 0.4 is the working default — see the fast
  path above.
- The extension injects the HUD on load. If `panel_summary` says the HUD is
  missing, **reload the panel first**; only if it is still missing is the page
  the problem.
- Panels are separate profiles with separate logins. One panel's click never
  affects another.
- A fixture is only worth staging if its market is still open. Late-stage
  matches drop markets silently: the card is simply absent, so bind first and
  read the answer rather than assuming.
- "Betano sync connected: <fixture>" in the HUD log is not a bound market. The
  bound state is the `Bound` readout, or `panel_summary`.
- The SB Fast Bet HUD floats over the page and can cover a page control. When a
  click is refused as covered: drag the HUD by its header (`#sbfb-drag`) out of
  the way, `set_zoom` to 0.4, or use `dom:true`. Never click the HUD's own
  buttons to get it out of the way.
- Each observation and survey row carries `MATCH` when the site names the
  fixture. Use it instead of guessing which game a panel is on, and check that
  the Betano view and the SportyBet view agree before trusting a goal signal.
- Report the slip you left behind — panel, fixture, market, side, stake — so the
  user can check it before paying.

## When you need more detail

Load one file, only when its subject is blocking you:

| File | Covers |
|---|---|
| `references/app.md` | panels, accounts, the control deck, every app command, arranging, zoom, deck settings |
| `references/hud.md` | SB Fast Bet: fields, three stages, hotkeys, toggles, config defaults, bridges |
| `references/sportybet.md` | the mobile site: navigation, markets, betslip, keypad, confirm, cashout |
| `references/betano.md` | the watching side and the goal relay |
| `references/tools.md` | every tool, its arguments and returns, and when to use it |
| `references/observations.md` | how to read an observation: PANEL/ACCOUNTS/SETTINGS lines, refs, diffs, coordinates |
| `references/troubleshooting.md` | symptoms and fixes: backend down, provider timeout, blank panel, market not loading |
