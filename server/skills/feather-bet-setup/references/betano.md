# Betano (and the goal relay)

Betano is used in Feather as the **watching** side: its live pages carry faster
score and game-state updates than SportyBet's match page, and the extension
relays those to the SportyBet panels.

## What to do with it

- Open `https://www.betano.ng/live/` or a specific live match URL.
- Match the fixture to the SportyBet panel: same teams, same competition, same
  kickoff. If they differ, the relay will fire on the wrong game.
- Do not place bets on Betano through the agent unless the user explicitly asks;
  the staged flow in this skill is for SportyBet.

## The badge

On a Betano live page the extension draws a **BETANO GOAL WATCHER** badge with
the live score, the clock, an auto-bound match (from the URL) and *Sim Home
Goal* / *Sim Odds Lock* / *Pick match* controls. Simulate goal exists so the
whole path can be tested without waiting for a real goal.

## What it sends

`BETANO_GOAL`, `BETANO_CLOCK` and `BETANO_ODDS_LOCK` are relayed to every
SportyBet panel. A goal can arm the chosen side and, when auto-place is enabled,
run the full sequence there. That is why auto-place is an elevated toggle.

## bet365

`bet365-watch.js` / `bet365-hook.js` do the same job for bet365 with a
websocket-level hook. Same rule: it is a signal source, not a place to bet
through the agent.

## Gotchas

- The relay works per fixture. Two panels on different matches will not line up
  however many goals arrive.
- Betano pages are heavy; give them a moment after navigation before concluding
  the badge is missing.
- A panel showing Betano does not need the SportyBet HUD, and vice versa. Do not
  look for HUD controls on the Betano side.
