# Reading observations

Every step returns an observation. The first of a task is the whole page; later
ones are a diff against the same panel's previous observation.

## Header lines

```
PANEL: 10 "Vector" (sportybet)
ACCOUNTS: 3 "Vector" sportybet | 4 "Betano" betano      (full observations only)
SETTINGS: sync_scroll=on auto_login=on auto_rebet=off …  (full observations only)
PANELS: 10 "Vector" sportybet (focused) | 5 "Betano" betano

URL: https://www.sportybet.com/ng/m/sport/football/live/…
TITLE: SportyBet
SCROLL: y=0 of 1200 (top, viewport 800)
VIEWPORT: 1000x800 CSS @1.5x
INTERACTIVE:
e12 button "Place Bet"
e14 slider "Zoom" value="50" min="0" max="100"
e20 frame "editor.example/timeline" 900x400
PAGE TEXT:
…
```

- `PANEL` is the view this observation describes. Other panels are reachable by
  passing `panelId`, or by loading them with `read_panel`.
- `VIEWPORT` is CSS pixels. The `@1.5x` is the device ratio: a screenshot pixel
  is that many CSS pixels. `click_at` with `from_image` converts for you.
- Frames are listed with their size; coordinate tools reach inside them.

## Diffs

After the first step you get only changes:

```
INTERACTIVE: 41 elements total; 1 added, 2 changed, 1 removed since the last observation.
+ e31 button "Apply promo code"
~ e4 button "Checkout" [disabled]
- e2 textbox "Search"
PAGE TEXT changed at line 12:
  Total $43.20
+ Shipping is calculated at checkout.
```

- Everything not mentioned is unchanged and still present.
- `No change since the last observation.` means exactly that; do not re-read.
- A removal means the ref is dead. Do not click it.
- A navigation or reload sends the full page again.

## Refs

Refs are stable while an element stays on the page: `e12` is the same element in
every observation. They are per panel — `e12` in panel 3 is unrelated to `e12`
in panel 7. A removed ref is never given to a different element.

## Staleness

If a ref is from an older observation the tool says so. Look again rather than
guessing. `observationVersion` is handled for you.

## Screenshots

`capture_screenshot` returns an image attached to the next observation, plus the
viewport and DPR. When the observation already carries an image,
`capture_screenshot` is not offered for that step — use what you can see.
