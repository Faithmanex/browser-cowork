# The Feather application

## Purpose

"Sportly Multiview" exists so one person can watch and prepare the same fixtures
across several betting accounts at once without switching browsers or logging in
and out. It is a workspace, not a general browser: a fixed set of account views,
each with its own profile, plus a HUD on every SportyBet panel.

Canonical use: four SportyBet accounts and a Betano view on the same match, so a
goal seen on Betano can be acted on in each slip within a second.

## Accounts

An account is a row in the local SQLite store: label, optional phone and
password (DPAPI-encrypted), site (`sportybet`, `betano`, `football`), optional
start URL, enabled flag. They appear on the `ACCOUNTS:` line.

- One account can have one panel at a time; reopening an account reuses its
  profile and therefore its login.
- Profiles live under `feather_profile/sportly/profiles/acct_<id>`, so cookies,
  localStorage and logins are isolated per account.
- The agent can list accounts and open one by id. It cannot create, edit or
  delete accounts, and must never handle credentials.

## Panels

A panel is one WebView2 view. Ids are integers, ascending; ad-hoc panels opened
from a URL use negative ids and have no account and no extension.

- `PANELS:` lists open panels with label, site and focus mark.
- Panels are not tabs: all are visible in a grid and only one has focus.
- Adding or removing a panel re-flows the layout of every panel.

## The control deck (top strip)

A WebView2 page across the top, and a sidebar on the left. The agent does not
need to click it — every action has a tool — but it should understand what the
user means when they name a control.

**Top strip**

| Control | Meaning |
|---|---|
| URL field + **Go** | navigate the focused panel to that URL (Enter also works) |
| **Apply all** | open that URL in every panel |
| **Reload all** | reload every panel |
| **Sync scroll** | when on, scrolling one panel scrolls all of them |
| **Direct bet** / **Staged** | placing mode: one-click direct, or place-then-confirm |
| **Fill all** / **Place all** | fill the slip on every panel / place on every panel (money) |
| **Cash out** | cash out the focused panel's open bet (money) |
| **Max stake / Min stake** | caps pushed to every HUD (0 = the HUD's own value wins) |
| **Clear interval** | delay used by the reset/clear sequence (ms) |
| **Auto clear / Auto rebet / Auto login** | automatic behaviours (auto-rebet moves money) |
| **+ Account** | open the account editor |
| **Open all accounts** | open a panel for every enabled account |
| Balance readout | the focused SportyBet account's balance |

**Sidebar (Panels / Accounts / Live)**

Panels tab lists every panel with Focus, URL, Fill, Place, Cash out, Reload,
Close, and up/down reordering. Accounts tab edits accounts. Live tab shows the
shared live feed.

## App commands (what the deck sends)

`apply_url`, `apply_url_all`, `navigate_panel`, `reload_all`, `reload_panel`,
`open_all`, `open_panel` (account or URL), `close_panel`, `close_all`,
`focus_panel`, `move_panel`, `reorder_panel`, `fill_all`, `fill_panel`,
`fill_login`, `fill_slip`, `place_all`, `place_bet`, `cashout`, `reset_slip`,
`save_account`, `delete_account`, `set_setting`, `focus_accounts`, `toggle_agent`.

The agent's equivalents are in `references/tools.md`. The money-moving ones
(`place_*`, `cashout`) are elevated and are not part of the agent's vocabulary.

## Arranging views

- Grid: 1 → 1×1, 2 → 2×1, 3 → 3×1, 4 → 2×2, 5–6 → 3×2, 7–8 → 4×2, more →
  roughly square.
- `focus_panel` changes what the user sees, not what the agent can reach.
- `reorder_panel {panelId, beforePanelId}` moves a view; use it to put two
  related panels side by side.
- `set_zoom` shrinks or grows a page inside its cell. Fit is clamped 0.5–1.5 and
  reports the CSS width it achieved; prefer an explicit factor on a busy layout.

## Deck settings

`set_setting {key, value}` persists to the same store and re-applies to every
panel immediately. Keys: `syncScroll`, `directBet`, `autoLogin`, `autoRebet`,
`maxStake`, `minStake`, `rebetEnabled`, `resetIntervalMs`.

Sync scroll is the one that bites: with it on, `scroll_page` on one panel moves
all nine.

## Failure modes

- A new panel may show `about:blank` briefly, then recover.
- Auto login fires a few seconds after load; typing into the login form before
  that fights it.
- Closing and reopening an account keeps the login (same profile).
- Nothing works if the backend is down; the dock reports it rather than hanging.
- A panel whose view is `about:blank` or an error page has no page agent;
  `navigate` it somewhere real first.
