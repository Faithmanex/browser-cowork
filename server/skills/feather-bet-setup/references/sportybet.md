# SportyBet mobile

Feather opens `https://www.sportybet.com/ng/m` — the mobile site. It is a
single-page app: navigation does not reload the document, so a URL change and a
DOM change are separate events.

## Getting to a fixture

From the home page: Football → Live (or a specific league) → a match row. The
match page lists markets as cards. Only a handful of cards are mounted at a
time; the rest mount as the page scrolls, which is why a market can appear
missing until you scroll that panel.

Match headers and market titles are live and change while you watch: a score
update rewrites the goal market's title. Identify a market by its key attribute,
not its text.

## Markets

Each market is a card with class `m-market` and a data attribute holding its
key. The goal market is `market-8`. Outcomes inside a card are clickable rows
with the selection and its odds; clicking one adds it to the betslip.

## The betslip

A single bet has one selection and one stake. Two selections make it a
multi-bet, which is almost never intended here — clear stale picks first.

- Stake input: `[data-op=betslip-single-stake]`.
- Balance when a slip is open: `[data-op=betslip-multi-balance]`.
- Stake is entered on the site's own keypad: `Clear`, digits, `Done`. Typing
  into an input with `type_text` often does not update the app's state; use the
  keypad, or `set_range`/`type_text` only after checking the field accepts it.
- Minimum stake is 10 NGN. A request below that is rejected or silently raised.

## Placing and confirming

- **Place Bet** submits the slip and opens the Confirm to Pay sheet.
- The sheet is `[data-op=betslip-confirm-wrap]`; confirm is
  `[data-op=betslip-confirm]`, cancel is `[data-op=betslip-confirm-cancel]`.
- Confirmation returns a success sheet naming the bet; that is the evidence a
  bet was actually placed. A click on Place Bet is not evidence.

Both buttons live on the same page as ordinary DOM, so a labelled
`click_element` reaches them; the panel will ask the user before such a click.

## Popups

- First-run guide: `[data-op=close_guide_button]`.
- Promo sheets (Sporty Survivor and similar) appear over the page and block
  reading. Close them before surveying.

## Reading state reliably

The site renders balances, scores and odds asynchronously. After any action,
take a fresh observation rather than assuming the previous values; the
observation's diff is designed for exactly this.

If the page says a market failed to load, that is a mounting problem, not a
missing market: scroll, then look again.
