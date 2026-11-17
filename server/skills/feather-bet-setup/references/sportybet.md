# SportyBet mobile

Feather opens `https://www.sportybet.com/ng/m` — the mobile site. It is a
single-page app: navigation does not reload the document, so a URL change and a
DOM change are separate events.

## Getting to a fixture

Home → Football → Live (or a league) → a match row. Match pages list markets as
cards. Only a few cards are mounted at a time; the rest mount as the page
scrolls, which is why a market can look missing until you scroll that panel.

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

Each card has a key attribute. The goal market is `market-8`; its title moves
through "Next Goal" → "1st Goal" → "2nd Goal" as the score changes. A market
that has not mounted yet logs "market failed to load — scroll to load" — that is
a mounting problem, not a missing market.

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
