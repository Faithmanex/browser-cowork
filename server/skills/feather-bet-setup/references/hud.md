# The SB Fast Bet extension (the HUD)

Injected into SportyBet pages by the engine extension. It draws a draggable HUD
and turns a deliberate sequence into a complete single bet. It decides nothing;
it obeys the user, or the agent acting for them. It is ordinary DOM — prefer
`find_on_page` over memorised selectors.

## What the HUD shows

Bound (team/selection), Home, Away, Team, Stake, Win, Bal, Profit Cap, Min/Max,
Market title, Market Key, Pick Market / Pick Home / Pick Away, the hotkey guide,
and a log. The log is the fastest way to see what the engine thinks happened.

## The three stages

| Stage | Hotkey | Effect |
|---|---|---|
| 1 — Attack | `1` Home / `4` Away | selects that outcome in the bound market, opens the betslip, types the capped stake on the keypad |
| 2 — Place | `2` / `5` | presses Place Bet; the Confirm to Pay sheet opens |
| 3 — Confirm | `3` / `6` | presses Confirm; **money moves** |
| Reset | `0` / `Esc` | cancels the sheet or keypad and clears the slip |

`n` / `m` run Attack → Place (→ Confirm when one-shot auto-confirm is on).

Stages 2 and 3 are the elevated actions. Do not use the hotkeys to place a bet
that the user did not ask for.

## Config defaults (sb-config.js)

| Key | Default | Meaning |
|---|---|---|
| `targetProfit` | 10 | net-profit cap in NGN used to compute the stake |
| `minStake` / `maxStake` | 10 / 500 | stake bounds; the site's own minimum is 10 |
| `marketKey` | `market-8` | the goal market on a live list; a match page re-keys its markets, so read the key instead of trusting this |
| `confirmAuto` | true | after Place, confirm without a second hotkey |
| `armOnGoal` | true | arm a side when a goal signal arrives |
| `armAutoConfirm` | false | confirm automatically on an armed goal (money) |
| `armTeam` | `scorer` | which side a goal arms |
| `focusTab` | true | bring the target panel forward on a goal |
| `invertTeams` | false | swap Home/Away for the hotkeys |
| `pickMode` | `double` | separate Home/Away picks; `single` uses one option for both |
| `busyMode` | `ignore` | drop a keypress while busy, or `wait` briefly |
| `sbFeed` | false | also watch SportyBet's own score (`.m-score`) as a signal, polled every `sbFeedMs` (700 ms) |
| `rebetEnabled` | false | rebet loop, max `maxRebets`, floored at `floorBalance` (10) |
| `activityEnabled` | true | harmless select+reset every 2 minutes so the page never goes stale |
| `apiDirect` | false | submit through `/api/ng/orders/order` instead of DOM clicks — skips the confirm sheet, so never enable it for agent work |

## How a stake is computed

The stake is derived from the target profit and the odds, then clamped by
min/max. A rebet steps the stake down and floors at the site minimum. Beyond the
computed stake, the HUD also verifies what the site actually holds against
`[data-op=betslip-single-stake]`.

## The betslip

- Stake is typed on the site's keypad (`Clear` → digits → `Done`), not into an
  input.
- Balance is read from the open slip: `[data-op=betslip-multi-balance]`.
- Leftover picks from an earlier session turn the next selection into a
  multi-bet. The HUD clears stale picks before an attack; if you bind manually,
  confirm the slip holds one selection.

## Goal bridges

`bet365-watch.js` / `betano-watch.js` read live match state and relay
`BETANO_GOAL` / `BETANO_CLOCK` / `BETANO_ODDS_LOCK` to every SportyBet panel.
"Simulate goal" fires the same path without a real goal. The relay is only
meaningful when both panels are on the same fixture.

## Auth and sync

The HUD has its own auth gate and optional sync client. Those are the user's
settings; the agent should not enter credentials or change them.

## Gotchas

- **Prefer `bind_market` to Pick Market.** Pick Market binds the nearest visible
  card, and the Key field can snap back. `bind_market {panelId, marketKey}`
  drives the same HUD code without the click, and returns the title it bound —
  verify that with Bound/Key before attacking.
- **Reset before binding if the stage is not IDLE.** A keep-alive ATTACK keeps
  the HUD busy and its refresh clears `bound`; press `0`, confirm IDLE, then bind.
- **Pick mode swallows the next click.** While it is active, clicking a market
  tab binds whatever card is under the pointer instead of switching tabs. Enter
  pick mode only after the right tab is showing.
- A market that is not mounted logs "market failed to load — scroll to load".
  Scroll that panel; the market exists. Absent altogether is different: a
  late-stage match really has no 1st Goal card.
- Promo popups and the first-run guide cover the page; close with
  `[data-op=close_guide_button]` before reading anything.
- HUD state can disagree with the page after navigation. Re-read the HUD after
  every page load — or ask `panel_summary`, which reads the HUD's own state.
- The extension injects the HUD on load. If it is missing, reload the panel
  before concluding anything.
- Keep-alive activity makes the page select and reset periodically. A stray
  selection appearing without you is that, not the user.
- "Betano sync connected: <fixture>" in the log is not a bound market.
