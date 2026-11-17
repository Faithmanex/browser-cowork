# The SB Fast Bet extension (the HUD)

## What it is

An extension injected into SportyBet pages. It draws a draggable HUD over the
page and turns one deliberate sequence into a complete single bet. It does not
decide anything; it follows the user, or the agent acting for the user.

The HUD is ordinary DOM. Prefer `find_on_page` over memorised selectors, but it
is organised around these fields: Bound, Home, Away, Team, Stake, Win, Bal,
Profit Cap, Min/Max, Market title, Market Key, Pick Market / Pick Home / Pick
Away, the hotkey guide, and a log.

## The three stages

| Stage | Hotkey | Effect |
|---|---|---|
| 1 — Attack | `1` Home / `4` Away | selects that outcome in the bound market, opens the betslip and types the capped stake on the keypad |
| 2 — Place | `2` / `5` | presses Place Bet; the Confirm to Pay sheet opens |
| 3 — Confirm | `3` / `6` | presses Confirm; the bet is placed with real money |
| Reset | `0` / `Esc` | cancels the sheet or keypad and clears the slip |

`n` / `m` run Attack → Place (→ Confirm when one-shot auto-confirm is on).

The agent should not use the hotkeys to place bets. Stage 2 and 3 are the
elevated actions; they happen only when the user asked for a bet.

## Toggles and settings

- **Auto-place on goal** — when a goal signal arrives, run the whole sequence.
  This spends money unattended: never enable or leave it on without being asked.
- **One-shot auto-confirm** — `n`/`m` also confirm.
- **Invert Home/Away** — swaps the sides the hotkeys attack.
- **Profit cap / Min / Max** — stake maths. The stake is capped by these, and a
  rebet steps down, flooring at the SportyBet minimum of 10 NGN.
- **Auto-rebet** — after a win or loss, rebet a set number of times within a
  balance floor.
- **Market binding** — bind by key. `market-8` is the goal market; its title
  changes with the score ("Next Goal" → "1st Goal" → "2nd Goal" → "3rd Goal"),
  so never bind by title.
- **Goal bridge section** — arm a side on an incoming goal from bet365 or
  Betano, choose the side, and optionally focus the target tab.

## The betslip

Stake is entered through the site's keypad (`Clear` → digits → `Done`), and the
result is verified against `[data-op=betslip-single-stake]`. Balance is read from
the open betslip `[data-op=betslip-multi-balance]`, because the match page does
not show it.

Leftover picks from an earlier session make the next selection a multi-bet. The
HUD clears stale picks before an attack; if the agent binds manually, check the
slip is a single first.

## Goal bridges

`bet365-watch.js` / `betano-watch.js` read live match state and relay goal and
clock events to every SportyBet panel, which can arm and confirm within the same
second. "Simulate goal" fires the same path for testing without a real goal.

When the user says "watch the same game", the Betano panel must be on the same
fixture as the SportyBet panel or the relay is meaningless.

## Gotchas

- A market that is not mounted logs "market failed to load — scroll to load".
  Scroll the panel; the market exists.
- Promo popups (for example Sporty Survivor) and the first-run guide cover the
  page. Close them with `[data-op=close_guide_button]` before reading anything.
- The HUD's own state can disagree with the page after a navigation. Re-read the
  HUD after any page load rather than trusting the previous bound/stake.
