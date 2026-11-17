---
name: feather-bet-setup
description: Sets up football bets in Feather (Sportly Multiview): opens fixtures across logged-in accounts, binds a market on the SportyBet HUD, picks a side and enters a stake, stopping before Place Bet. Use when the user asks to set up, stage, prepare or arrange games, matches, tabs, slips or accounts in Feather.
---

# Setting up games in Feather

Feather is a Windows browser built for preparing football bets across several
logged-in accounts at once: one WebView2 panel per account, side by side, with a
betting HUD injected into each SportyBet panel. "Setting up a game" means making
its slip ready without placing it.

Read the reference that matches the question:

- `references/app.md` — the application: panels, accounts, the control deck,
  arranging views, zoom, and what the agent can do to the app itself.
- `references/hud.md` — the SB Fast Bet extension: the HUD, its three stages,
  hotkeys, toggles, auto-rebet, and the goal bridges.
- `references/sportybet.md` — the SportyBet mobile site: match pages, market
  cards, the betslip, the stake keypad and the Confirm to Pay sheet.
- `references/betano.md` — Betano and the goal relay into SportyBet.

## The four steps

1. **Find the fixture.** `survey_panels` for an overview, `read_panel` for detail.
   Never assume what a panel is showing.
2. **Bind the market.** In the HUD, bind by key. The goal market is `market-8`;
   its title changes with the score, so a title is not an identifier.
3. **Pick the side.** Home or Away in the HUD, for the bound market.
4. **Enter the stake.** Through the HUD keypad, then verify against
   `[data-op=betslip-single-stake]`.

Stop there. The slip is set up. Do not press Place Bet or confirm the sheet
unless the user asked for a bet in this or an earlier message.

## Elevated actions

Only when the user asked: pressing Place Bet, confirming in the Confirm to Pay
sheet, or changing a panel's auto-place / auto-rebet toggles. Everything else —
navigating, opening panels, binding markets, choosing sides, typing a stake,
arranging and zooming panels — is ordinary work.

## Rules

- A stake is never invented. If none was given, use the stake already in the HUD;
  otherwise ask once, briefly.
- Prefer acting and stating the assumption in one line over asking what the
  instruction means.
- "The same game on both sites" means pointing the Betano panel at the same
  fixture the SportyBet panel is showing, so the goal relay lines up.
- A narrow panel needs `set_zoom` with a factor (0.7–0.8). `fit` asks for an
  unreadably small zoom when many panels are open.
- Panels are separate profiles with separate logins. A click in one panel has no
  effect on another.
