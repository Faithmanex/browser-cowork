---
name: feather-bet-setup
description: Operates Feather (Sportly Multiview): the workspace, its panels and accounts, the SB Fast Bet HUD on SportyBet, and the SportyBet/Betano sites. Covers setting up games, arranging views, reading observations, every agent tool, and troubleshooting. Use for any request to set up, stage, prepare, arrange, inspect or debug games, matches, tabs, slips or accounts in Feather.
---

# Feather: operating manual

Feather is a Windows browser for preparing football bets across several
logged-in accounts at once. One WebView2 panel per account, all visible, with a
betting HUD injected into every SportyBet panel. The agent works the panels and
the app itself; the user keeps the final say on money.

**Act first.** The four steps below are the whole procedure for setting up a
game. Do not read reference files before acting — everything needed to start is
on this page. If a step fails, or you need a specific detail (hotkeys, config
defaults, site selectors), load at most one reference, then continue.

## The job: set up a game

1. **Find the fixture** — `survey_panels`, then `read_panel` on the panel you
   will use. Never assume what a panel is showing.
2. **Bind the market** — scroll the market card fully into view, then use the
   HUD's Pick Market. `market-8` is the goal market; verify the Bound/Key readout
   says `market-8` before going further. If it shows anything else, reset and
   retry rather than betting the wrong market.
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
  with many panels open.
- Panels are separate profiles with separate logins. One panel's click never
  affects another.
- The SB Fast Bet HUD floats over the page and can cover a page control. When a
  click is refused as covered, use `dom:true` (a DOM click ignores the overlay)
  or `set_zoom` to make room — never click the HUD's own buttons to get it out of
  the way.
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
