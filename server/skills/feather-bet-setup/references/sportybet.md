# SportyBet mobile

Feather opens `https://www.sportybet.com/ng/m` — the mobile site. It is a
single-page app: navigation does not reload the document, so a URL change and a
DOM change are separate events.

## Getting to a fixture

**Search, then Enter as a second action.** `/ng/m/search?keyword=<team>` works,
but `type_text` with `submit:true` does not fire this site's search — type, then
send `Enter` on its own. Tap the live result row.

Do not navigate to a match URL you assembled or remember: the ids are per match
and a wrong one lands in the footer with no error. The only reliable way in is
the list, the league page, or search.

Home → Football → Live (or a league) → a match row. Match pages list markets as
cards. Only a few cards are mounted at a time; the rest mount as the page
scrolls, which is why a market can look missing until you scroll that panel.

**Check the clock.** The live list gives minutes and a period. A fixture at 85'
has dropped most markets, and a 4-0 game has no 1st Goal card at all — the Goals
tab simply will not contain one. Prefer fixtures under about 60 minutes, and
confirm the card exists before binding. `list_live_fixtures` returns clock,
score, the row's markets and `nextGoal`, so this is a read, not a guess.

Live headers, scores and market titles change while you watch. Identify a market
by its key attribute, never by its text.

## Page anatomy

| Thing | Selector |
|---|---|
| market card | `.m-market` (carries the market key) |
| market title | `.m-market-title .text` |
| outcome row | `.m-outcome` |
| odds | `.m-odds-value` |
| betslip open / count | `button.beticon-inner`, `[data-op=betslip-icon]`, counts under `.betslip-theme-icon__count` |
| betslip rows | `.m-betslips .m-outcomes-row`, `.m-item` |
| single stake | `[data-op=betslip-single-stake]` |
| slip total / win | `[data-op=betslip-stake-amount]`, `[data-op=betslip-win-amount]` |
| balance (slip open) | `[data-op=betslip-multi-balance]` |
| confirm sheet | `[data-op=betslip-confirm-wrap]` → `[data-op=betslip-confirm]` / `[data-op=betslip-confirm-cancel]` |
| first-run guide | `[data-op=close_guide_button]` |

Selectors drift. Treat this table as a starting point and confirm with
`find_on_page`.

## Markets

Cards carry a `market-key`. `market-8` is the usual goal key **on a live list**;
on a match page the keys are per fixture and per tab — a real page offered
`market-19` for the goal market, with `market-11`, `market-450005` around it. So
the key is something you read, not something you know. `bind_market` answers
with the keys it found when the one you asked for is not there.

Markets mount in two steps, and both are silent when missed:

1. **The market tab.** The match page has All / Main / **Goals** / Corners tabs.
   A card that belongs to another tab is not in the DOM at all. Click the tab
   with a real pointer click — a scripted `.click()` on the tab mounts nothing
   (the nav listens on pointer events), which is why `click_element`/`click_at`
   work and pasted JS does not.
2. **The scroll.** Within a tab, cards mount as the page scrolls.
   `bind_market` walks the page itself before deciding a key is absent, so this
   is usually invisible — but a `find_on_page` that returns nothing for a market
   title means "not mounted yet", not "not offered".

`bind_market {panelId, marketKey}` binds through the HUD's key field and reads
the BOUND title back. It also refuses a key that is not on the page, because the
HUD's own binder falls back to the first card it can see — a mistyped key used
to bind a completely different market and report success. Use Pick Market only
if the HUD is missing entirely.

## Live list rows

`.m-event-live` is one fixture:

| Part | Selector |
|---|---|
| clock | `.m-event-time` (`45:00`) |
| period | `.match-status` (`HT`, `H1`) |
| teams | `.m-info-cell .team` (×2) |
| score | `.m-table-cell.score .set-score` (×2) |
| extra markets on the row | `.m-additional-market-wrapper .m-info-cell` |

`list_live_fixtures` reads exactly this.

## The betslip

One selection is a single; two make a multi-bet, which is almost never intended
here. Clear stale picks before binding.

- Stake goes in on the site's keypad: `Clear`, digits, `Done`. Typing into an
  input with `type_text` often fails to update the app's state.
- Minimum stake is 10 NGN; a smaller request is rejected or silently raised.
- Balance is not shown on the match page — read it from the open slip.

## Placing, confirming, cashing out

- **Place Bet** submits and opens Confirm to Pay.
- Confirm is `[data-op=betslip-confirm]`; cancel is
  `[data-op=betslip-confirm-cancel]`.
- A success sheet naming the bet is the evidence a bet exists. A click on Place
  Bet is not evidence.
- **Cash out** is a separate control on an open bet; it is money-moving too.

Both buttons are ordinary DOM, so labelled `click_element` reaches them, and the
panel asks the user first.

## Popups

First-run guide: `[data-op=close_guide_button]`. Promo sheets (Sporty Survivor
and similar) cover the page and block reading; close them before surveying.

## Reading state

Balances, scores and odds render asynchronously. After any action take a fresh
observation instead of trusting the previous values — that is what the diff
format is for.

## Other features

The engine extension also hides booking banners (`booking-hide.js`) and can poll
SportyBet's own score (`.m-score`) as a goal signal. Neither changes how you
operate the page.
