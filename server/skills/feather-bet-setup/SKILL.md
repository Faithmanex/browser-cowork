---
name: feather-bet-setup
description: Operates Feather (Sportly Multiview): the workspace, its panels and accounts, the SB Fast Bet HUD on SportyBet, and the SportyBet/Betano sites. Covers setting up games, arranging views, reading observations, every agent tool, and troubleshooting. Use for any request to set up, stage, prepare, arrange, inspect or debug games, matches, tabs, slips or accounts in Feather.
---

# Feather: operating manual

Feather is a Windows browser for preparing football bets across several
logged-in accounts at once. One WebView2 panel per account, all visible, with a
betting HUD injected into every SportyBet panel. The agent works the panels and
the app itself; the user keeps the final say on money.

## Load the reference you need

`read_skill` takes one file name and returns its text. Load it before working in
that area rather than guessing:

| File | Covers |
|---|---|
| `references/app.md` | panels, accounts, the control deck, every app command, arranging, zoom, deck settings |
| `references/hud.md` | SB Fast Bet: fields, three stages, hotkeys, toggles, config defaults, bridges |
| `references/sportybet.md` | the mobile site: navigation, markets, betslip, keypad, confirm, cashout |
| `references/betano.md` | the watching side and the goal relay |
| `references/tools.md` | every tool, its arguments and returns, and when to use it |
| `references/observations.md` | how to read an observation: PANEL/ACCOUNTS/SETTINGS lines, refs, diffs, coordinates |
| `references/troubleshooting.md` | symptoms and fixes: backend down, provider timeout, blank panel, market not loading |

## The job: set up a game

1. **Find the fixture** — `survey_panels`, then `read_panel`. Never assume.
2. **Bind the market** — by key (`market-8` is the goal market; its title moves
   with the score). Scroll the card into view first and verify the Bound readout.
3. **Pick the side** — Home or Away for the bound market.
4. **Enter the stake** — through the site keypad, verify against
   `[data-op=betslip-single-stake]`.

The slip is then set up. Do not press Place Bet or confirm the sheet unless the
user asked for a bet in this or an earlier message.

## Elevated actions

Place Bet, the Confirm to Pay sheet, and the auto-place / auto-rebet toggles.
Everything else — navigating, opening panels, binding, choosing sides, typing a
stake, arranging, zooming, changing deck settings — is ordinary work.

## Standing rules

- A stake is never invented. Use the HUD's current stake if none was given;
  otherwise ask once, briefly.
- Prefer acting and stating your assumption in one line over asking what the
  instruction means.
- Sync scroll moves every panel. Turn it off (`set_setting syncScroll false`)
  before scrolling one panel, and say that you did.
- A narrow panel needs `set_zoom` with a factor (0.7–0.8); `fit` goes unreadable
  with many panels open.
- Panels are separate profiles with separate logins. One panel's click never
  affects another.
