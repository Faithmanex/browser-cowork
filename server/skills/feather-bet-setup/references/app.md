# The Feather application

## Purpose

Feather (window title "Sportly Multiview") exists so one person can watch and
prepare the same football fixtures across several betting accounts at once,
without switching browsers, logging in and out, or losing a tab. It is a
workspace, not a general-purpose browser: it opens a fixed set of account views,
keeps each login isolated, and puts a betting HUD on every SportyBet panel.

Typical use: four SportyBet accounts plus a Betano view, all pointed at the same
match, so a goal on Betano can be acted on in each SportyBet slip at the same
moment.

## Accounts and panels

- An **account** is a saved profile: label, optional phone/password, and a site
  (`sportybet`, `betano`, `football`). Accounts live in a local SQLite store and
  are listed on the `ACCOUNTS:` line of every full observation.
- A **panel** is one WebView2 view with its own profile directory and therefore
  its own cookies and login. `PANELS:` lists the open ones with their ids.
- Panels are not tabs in the browser sense: they are independent views, all
  visible at once in a grid. There is no active-tab concept to switch, only
  focus.
- Ad-hoc panels (opened from a URL rather than an account) have negative ids and
  their own profile, and do not load the betting extension.

## The control deck

The top strip is a WebView2 page with the shared controls: a URL field with Go
and Apply all, Reload all, Sync scroll (scrolls every panel together), Direct
bet, Staged, Fill all, Place all, Cash out, Max/Min stake, Clear interval, Auto
clear, Auto rebet, Auto login, + Account, and Open all accounts. The balance
readout belongs to the focused SportyBet account.

The left sidebar has three tabs — Panels, Accounts, Live — and a row per panel
with Focus, URL, Fill, Place, Cash out, Reload and Close.

None of this is required to operate panels: the agent has its own tools
(`open_panel`, `focus_panel`, `close_panel`, `reorder_panel`, `reload_panel`,
`navigate`, `set_zoom`) and should use those rather than clicking the deck.

## Arranging views

- `focus_panel` changes the view the user is looking at; it does not change what
  the agent can reach.
- `reorder_panel {panelId, beforePanelId}` moves a view in the strip. Use it when
  the user asks for two panels side by side or in a particular order.
- The grid is automatic (1 → 1x1, 2 → 2x1, 3 → 3x1, 4 → 2x2, 5–6 → 3x2,
  7–8 → 4x2, more → roughly square). Adding a panel re-flows every panel.
- `set_zoom` exists because re-flowing makes panels narrow. A factor of 0.7–0.8
  usually recovers a usable layout; the result reports the CSS width achieved.

## What the agent may change

Open and close views, navigate them, arrange and zoom them, and read them. It
does not manage accounts (no creating, editing or deleting credentials) and does
not change the deck's global settings. Account credentials are the user's.

## Failure modes to expect

- A panel opened for the first time may show `about:blank` briefly, then recover.
- Auto login runs a few seconds after a panel loads; typing into a login form
  before it finishes will fight it.
- Closing a panel and reopening the same account reuses the same profile, so the
  login persists.
- Nothing works if the local backend is not running: the dock will say the
  backend is unreachable rather than silently doing nothing.
