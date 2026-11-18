# Tools

Every tool takes a JSON argument object. There is no active tab: page tools take
a `panelId`, and omitting it means the view you last worked on (or the only one
open). Money-moving app commands (`place_*`, `cashout`) are deliberately absent.

## Reading

| Tool | Args | Returns |
|---|---|---|
| `inspect_page` | `{panelId?, full?}` | snapshot: url, title, elements with refs, page text |
| `find_on_page` | `{query, max_results?, panelId?}` | matches from the current snapshot (`/regex/i` allowed); each carries `scrollY` and `inViewport` |
| `survey_panels` | `{}` | one row per panel: id, label, url, title, fixture, first elements |
| `read_panel` | `{panelId, full?}` | that panel's observation without switching to it |
| `panel_summary` | `{panelId}` | SportyBet state in one call: fixture, stage, bound market + key, odds, stake, selections, confirm sheet |
| `list_live_fixtures` | `{panelId}` | rows: home, away, score, clock, period, markets offered, `nextGoal` |
| `list_accounts` | `{}` | configured accounts: id, label, site, url, enabled |
| `read_skill` | `{file}` | the text of a skill reference file |

`panel_summary` exists because checking "is this bound?" by reading a whole
observation per panel was most of a session's token cost. `list_live_fixtures`
exists because a collapsed live list cannot be read reliably from a screenshot,
and choosing from it that way staged matches that had already finished.

## Betting

| Tool | Args | Notes |
|---|---|---|
| `bind_market` | `{panelId, marketKey, title?}` | binds through the HUD; returns the market actually bound, or the keys the page does have |

`bind_market` is the HUD's own binding path with the click removed, so it cannot
land on the card nearest the pointer. Always check the returned `marketKey`: an
`ok:false` reply includes an `available` list, which is the honest answer to
"what can I bind here instead?".


## Pointing and typing

| Tool | Args | Notes |
|---|---|---|
| `click_element` | `{ref, double?, dom?, panelId?}` | refuses disabled, moving or covered targets; `dom:true` bypasses the cover |
| `type_text` | `{ref, text, submit?, clear?, panelId?}` | never on password/secret fields |
| `select_option` | `{ref, value}` | native `<select>` only |
| `set_range` | `{ref, value}` | native range input (slider) |
| `hover` | `{ref?, x?, y?}` | one pointer move, opens hover menus |
| `click_at` | `{x, y, from_image?, double?, keys?}` | canvas/frames; `from_image` divides by DPR |
| `drag` | `{from_ref?/from_x,from_y?, to_ref?/to_x,to_y?, steps?, keys?}` | press → interpolated moves → release |
| `scroll_page` | `{dy?, dx?, x?, y?}` | wheel at a point; sync scroll affects all panels |
| `press_key` | `{keys}` | chords: `ctrl+z`, `shift+Tab`, `space` |
| `capture_screenshot` | `{panelId?}` | image + viewport, attached to the next observation |

## App

| Tool | Args | Notes |
|---|---|---|
| `navigate` | `{url, panelId?}` | http(s) only |
| `go_back` | `{panelId?}` | panel history |
| `open_panel` | `{url?, accountId?, label?}` | account panel, or an ad-hoc panel |
| `focus_panel` | `{panelId}` | what the user sees |
| `close_panel` | `{panelId}` | |
| `reorder_panel` | `{panelId, beforePanelId}` | move in the strip |
| `reload_panel` | `{panelId}` | |
| `set_zoom` | `{panelId?, factor?, fit?, target?}` | fit clamped 0.5–1.5 |
| `set_setting` | `{key, value}` | returns the settings after the change |

## Finishing

| Tool | Args | Notes |
|---|---|---|
| `finish_task` | `{summary, outcome}` | `outcome`: done / blocked / failed. Only when the page shows the result |

## Conventions

- Refs come from the latest observation of that panel. A ref that was removed
  fails cleanly; it is never reused for another element.
- `panelId` on any page tool lets one agent work several views in one task.
- Read-only tools never need approval; labelled consequential clicks and the
  elevated actions do.
