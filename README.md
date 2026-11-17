# Browser Cowork

A Chrome side-panel agent that operates **the tab you explicitly connect** — reading it, clicking,
typing, scrolling and navigating inside your real, logged-in session.

Two pieces:

```
extension/  (this folder)      side panel, page adapter, execution authority
server/                        model calls, conversation state, credentials
```

The extension never talks to a model provider. The backend never touches the browser. The panel asks
for one action at a time, runs it, and reports back what the page actually became.

## Why it is split this way

| Concern | Where it lives | Why |
|---|---|---|
| API key | `server/.env` | Never enters the extension or the page |
| Action execution | extension background worker | Only code with tab access can act, and it is the last gate |
| Confirmations, Stop | side panel | The user must be able to veto before anything runs |
| Conversation state | server, in memory | The extension holds no long-lived agent state |

The loop is request/response because an extension cannot accept inbound connections: panel → backend
("what next?") → panel executes → panel → backend ("here's what happened"). One action per round trip,
which is also what makes failures easy to read.

## What the model sees, and why it is a diff

The first observation of a task is the whole page. Every observation after that is only what changed:

```
URL: https://shop.example/cart          ← only if it changed
TITLE: Your cart                        ← only if it changed
SCROLL: y=300 of 900 (33%, viewport 900)
INTERACTIVE: 41 elements total; 1 added, 2 changed, 1 removed since the last observation.
+ e31 button "Apply promo code"
~ e4 button "Checkout" [disabled]
- e2 textbox "Search"
PAGE TEXT changed at line 12:
  Total $43.20
+ Shipping is calculated at checkout.
```

Three conditions have to hold for that to be safe, and all three are enforced in code rather than
asked for in the prompt:

1. **Refs are stable.** `lib/page-agent.js` keeps an element → ref `WeakMap` for the life of the
   document, so `e4` is the same button in every observation. Without this, "e4 changed" would be a
   coincidence, not a fact.
2. **Removals are explicit.** A ref that leaves the page is announced as removed and is never handed
   to a different element, so the model cannot click a ref that is quietly pointing somewhere new.
3. **There is a fallback.** A new document, a navigation, a reload (detected by an injected `instance`
   id, not just the URL) or a diff that would be more than 70% of the full text all send the full page
   instead. A diff that is not cheaper is worse than the full snapshot.

The 70% rule is why small pages keep getting full observations: on a five-element page the header is
most of the payload.

Ideas borrowed, one from each project that solves part of this:

| From | Idea |
|---|---|
| browser-use | A stable index per element (`selector_map`), so refs survive re-observation |
| Playwright MCP | `find_on_page`: search the existing snapshot instead of re-reading the page |
| Nanobrowser | Pre-click actionability: enabled, not moving, not covered by another element |
| Stagehand | Replaying a known action should not require re-reading the page |
| OpenAI computer-use | A drag is a path of moves, `move` is its own action, and mouse actions can hold modifiers |

## Pointer, canvas and frames

Refs only exist for DOM controls. Video editors, maps and design tools are canvases, so this build adds
the coordinate-level tools those need:

| Tool | Use |
|---|---|
| `drag` | press → interpolated moves → release, between a ref or a coordinate at each end |
| `hover` | one pointer move, for tooltips, hover menus and reveal-on-hover controls |
| `click_at` | click a viewport coordinate; `from_image: true` takes a screenshot pixel and divides by the device pixel ratio |
| `set_range` | set a native range input (scrubber, zoom, volume) |
| `scroll_page` | optional `x, y, dx`: the wheel goes to the container under the cursor, so inner panels scroll |

`press_key` now sends chords (`ctrl+z`, `ctrl+shift+z`, `space`) with a real key table, and the
observation carries a `VIEWPORT: WxH CSS @Nx` line so screenshot pixels and CSS pixels can be related.

Approvals are label-based, so they only interrupt when they can say something useful. A click or drag on
an element whose name or href looks consequential ("Send", "Delete", "Buy", "Checkout") pauses; working
on a canvas does not, because there is no label to read and a prompt that says "I cannot see what is
under this point" every time is a prompt you learn to dismiss unread. Settings → *Ask before
consequential actions* turns the whole thing off.

The event sequences live in `lib/input.js` as pure functions, and `test/verify-pointer.mjs` replays them
through a real Chromium CDP session. That is deliberate: the tests exercise exactly the events the
service worker sends, rather than a Playwright re-implementation of them.

Known limits, stated rather than implied:

- **Frames.** Elements inside an iframe are not listed as refs (the observation only reports the frame,
  its size and its URL). Coordinate tools still work inside it, because the browser delivers input by
  hit-testing — verified by clicking a button inside a frame in the test. Dragging *out of* a frame into
  the parent page is not supported.
- **Drag path.** A drag is a straight line between two points, sampled 12 times. Canvas apps that need
  a specific curved path, or a hold before moving, are not covered.
- **No touch, pen or multi-pointer gestures** — pinch-zoom and two-finger pan are not implemented.

## Setup

**1. Backend**

```powershell
cd browser-cowork\server
copy .env.example .env
# put DEEPSEEK_API_KEY=sk-... in .env
node index.js
```

It prints the URL and a pairing token:

```
  listening   http://127.0.0.1:8787
  provider    DeepSeek - deepseek / deepseek-flash
  api key     loaded (DEEPSEEK_API_KEY)
  token       v0fg-RosN2L2taLfwKWDxTrKRtZuDPX6
  thinking    disabled
```

**Providers.** DeepSeek is the default. Set `PROVIDER` to `deepseek`, `gemini` or `openai`; the server
picks the adapter, default model and key variable from a table in `server/index.js`, and returns them
from `/api/health` so the panel has nothing to configure.

Model ids were checked against the live API, not from memory:

| Provider | `MODEL` | Notes |
| --- | --- | --- |
| `deepseek` | `deepseek-flash` | DeepSeek-V4.1-Flash. Text + image. ~1.1 s per step. |
| `deepseek` | `deepseek-v4-pro` | Text only — `capture_screenshot` will be skipped. |
| `gemini` | `gemini-2.5-flash` | Text + image. |
| `openai` | `gpt-4.1-mini` | Text + image. |

The old `deepseek-chat` / `deepseek-reasoner` names are retired; requests using them fail.

DeepSeek's thinking mode is on by default at effort `high`. This agent picks one small action per step,
so that latency buys little: `THINKING=disabled` is the default here. Set `THINKING=enabled` and tune
`REASONING_EFFORT=low|high|max` to trade speed for deliberation.

**2. Extension**

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick this folder.

The extension ID is derived from the folder's absolute path (there is no `key` in the manifest), so
**moving the folder changes the ID** and the extension must be removed and re-added. A pinned
`ALLOW_ORIGIN` in `.env` has to be updated when that happens; with it unset, the server accepts any
unpacked-extension origin on loopback.

**3. Pair**

Click the toolbar icon to open the side panel → gear icon → paste the backend URL (already default) and
the token → **Test connection**. Then **Connect this tab**.

Optional: pin the extension's ID in `.env` as `ALLOW_ORIGIN=chrome-extension://<id>` once Chrome assigns
it. Without it the server accepts any unpacked-extension origin on loopback.

## What it does and does not do

**Does**

- Reads a structured observation of the page: URL, scroll, interactive elements with temporary refs,
  accessible names, roles and states, plus visible text.
- Acts with **real input events** via `chrome.debugger` (CDP), not synthetic `click()`. Synthetic events
  are ignored by most React/Vue apps, so this matters more than it sounds.
- Falls back to DOM events when the debugger is unavailable, and says which path it used.
- Rejects refs from a stale observation, so an action can never land on an element that has moved.
- Pauses for approval on consequential actions (send, buy, delete, submit, log out…).
- Redacts password and card fields from observations and refuses to type into them.
- Stops immediately, aborting the in-flight model request and dropping server state.

**Does not**

- Follow the active tab. The connection is explicit and stays put while you switch tabs.
- Execute arbitrary JavaScript. There is no `eval`-style tool; the vocabulary is ten fixed actions.
- Handle captchas, file pickers, or authentication challenges. Those stay with you.
- Persist conversations. Restarting the server ends them.
- Guarantee frames, shadow DOM or virtualised lists work first try. See below.

## Tool vocabulary

`inspect_page`, `click_element`, `type_text`, `select_option`, `scroll_page`, `navigate`, `go_back`,
`press_key`, `capture_screenshot`, `finish_task`.

Validation happens twice: the server rejects malformed proposals before they reach the browser, and the
extension re-checks the target, the scheme and the field type before executing.

## Known limits

- **`chrome.debugger` shows a yellow "being debugged" banner** and conflicts with an open DevTools
  panel. Close DevTools for the connected tab.
- **Iframes, shadow DOM and canvas** are not traversed. The agent reports the exact step it cannot reach
  instead of flailing.
- **Screenshots** capture the visible viewport only, and require the tab to be focused.
- **`select_option`** sets the value directly; native `<select>` popups cannot be driven by CDP.
- **Loop detection** stops after three identical actions in a row. It is a guard, not a planner.

## Verification status

Honest split, because these are not the same kind of "works".

**Verified — real Chromium, real DOM**

```powershell
node test/verify-page-agent.mjs      # 67 assertions, exit 0
```

Runs `lib/page-agent.js` against `test/pages/lab.html` and checks: versioned observations, element
refs, duplicate accessible names getting distinct refs *and* distinct coordinates, password and card
fields redacted with no value leak, disabled state, hidden elements excluded, late-appearing elements
included, planted instructions captured as text, stale-version refs rejected, `select_option` driving
the real DOM node, writes to password fields refused, and the DOM click fallback hitting the correct
one of two identically-labelled buttons.

It also checks the three properties the diff depends on: refs are identical across two observations of
an unchanged page, inserting a new element at the top of the body does not shift any existing ref, and
a removed element's ref is neither recycled nor clickable afterwards. Plus `find()` (name, role, regex,
result cap, bad pattern) and the actionability readings — disabled, covered with the coverer named, and
moving, using an element that is genuinely translated 40px per animation frame.

The strongest of those is the hit test: a ref's centre coordinate is resolved and passed through
`document.elementFromPoint`, then compared to the element's own label. If that mismatched, CDP clicking
would land on the wrong thing — it is the check that makes the coordinate maths trustworthy.

```powershell
node test/verify-observe.mjs         # 14 checks, no browser, no API key
```

Feeds `lib/observe.js` synthetic snapshots: full on the first observation, nothing-announced when a
page is untouched, scroll-only changes staying quiet, added/changed/removed all reported, page text
diffed by line rather than resent, and the three full-resend triggers (reload, navigation, diff above
70% of the page). On a 40-element page with body text, one changed element costs **19.3× fewer
characters** than the full snapshot.

```powershell
node test/verify-input.mjs           # 15 checks, pure
node test/verify-pointer.mjs         # 16 checks, real Chromium + CDP
```

`verify-input` covers the planners: key table (letters, digits, F-keys, aliases), chord parsing with
no text on Ctrl-shortcuts, shift uppercasing, the press/move/release shape of a drag, monotonic
waypoints that land exactly on the target, a zero-distance drag collapsing to a short sequence, and
modifier bits held for the whole drag.

`verify-pointer` is the one that proves drag actually works, by replaying those same event arrays into
a real browser page:

```
canvas drag          pointerdown at start, 10 interpolated moves with buttons=1, pointerup at target
HTML5 drag and drop  real dragstart and drop, carrying dataTransfer "clip-42"
hover                mouseenter fires
click at a point     lands on the exact pixel
shift+click          event.shiftKey is true
double click         a real dblclick fires (two press/release pairs, clickCount 1 then 2)
ctrl+z / shift+space modifiers arrive, ctrl+space does not insert text
click inside frame   a coordinate click reaches a button inside a same-origin iframe
```

**Verified — live model, no browser**

```
node test/deepseek-probe.mjs       model ids, base URL, tools, reasoning, vision
node test/verify-loop.mjs          /api/turn + /api/step, the panel's own loop
node test/verify-diff-loop.mjs     the loop with diff observations after step 1
node test/verify-editor-loop.mjs   a canvas timeline task, answered with drag + coordinates
node test/verify-image-turn.mjs    a real screenshot through the HTTP path
```

Latest run against the live DeepSeek API:

```
base https://api.deepseek.com       200
base https://api.deepseek.com/v1    200
tools + thinking disabled           200, finish_reason "tool_calls", ~1.0 s
vision (real screenshot)            200, described the image correctly
loop  turn 1 → type_text e1          803 ms
loop  turn 2 → finish_task          1360 ms, stopped without submitting
image through /api/turn            1721 ms, finish_task with a correct description
```

`verify-diff-loop.mjs` is the one that matters for this change. It builds each observation with
`lib/observe.js` — the same code the panel runs — so steps 2 and 3 are genuine diffs, and the model is
asked to fill a field and tick a checkbox:

```
step 1  type_text e1          observation: full, 283 chars
step 2  click_element e3      observation: diff, 170 chars (of 307)
step 3  finish_task           observation: diff, 163 chars (of 305)
        "Email field now contains "ada@example.com" and "Remember me" is checked.
         Sign in was not clicked."
```

Three deliberate actions off a 163-character diff, correct refs, nothing submitted, and no `inspect_page`
calls — the model used refs it had only seen in the first observation, which is exactly the behaviour
the stable index exists to make possible.

`verify-editor-loop.mjs` checks the canvas path. The page text describes a clip on a timeline and
there are no elements to click; the harness changes the page's state **only if a drag actually
happened**, so a model that talks its way out of the task fails instead of being congratulated:

```
step 1  capture_screenshot          refused: this harness has no screen to capture
step 2  drag from (120,300) to (420,300)
        "The clip now spans x=420..580 ... it stayed on Track 1 and kept its duration."
```

Two behaviours worth noting, both from watching it run: it reaches for a screenshot before acting even
when coordinates are already in the text, and on another run it grabbed the clip's middle (x=200, the
centre of 120–280) and moved it +300 — also correct, since translating a clip is not the same as
trimming it. The test accepts any grab point inside the clip and asserts the displacement.

Gemini still works as an alternative (2.3 s per step, so roughly 2× slower than DeepSeek here).

These tests caught three real bugs, which is the point of running them:

1. `deepseek-chat` no longer exists. The model ids are now `deepseek-flash` and `deepseek-v4-pro`.
2. `/api/turn` and `/api/step` silently dropped `image` from the request body, so a screenshot never
   reached the model — it kept calling `capture_screenshot` because it genuinely could not see.
3. Thinking mode is on by default in DeepSeek, and with `tools` present the API expects prior
   `reasoning_content` echoed back. That is now persisted per assistant turn.

Earlier, the same loop was verified against Gemini across three round trips.

**Not verified — needs a browser you drive by hand**

- The side panel UI: connection flow, approval cards, Stop, settings persistence.
- `background.js` as a whole, including the `chrome.debugger` CDP path. The DOM fallback is tested; CDP
  input is not. Expect to close DevTools on the connected tab or the attach fails.
- The new refusal path in `background.js` for disabled, moving and covered elements. The page-side
  detection is tested (the rect carries the flag and names the coverer); the branch that turns it into
  an error has never run, because it needs the service worker.
- The new worker RPCs: `hover`, `drag`, `click_at`, `set_range`, and the point-based `scroll_page`.
  Their event sequences are tested against a real browser (`verify-pointer`), and the page-side helpers
  are tested (`verify-page-agent`), but the code that resolves a ref to a point, attaches the debugger
  and sends those events end-to-end has not run outside the service worker.
- `chrome.scripting.executeScript` injection specifically. The test injects through Playwright
  (`injectedVia: evaluate`), which proves the page-side logic but not Chrome's isolated-world entry
  point.
- The full extension → backend → extension loop.

Load it unpacked and try one form-filling task; that is the first thing that will actually exercise the
untested third.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest: `sidePanel`, `debugger`, `scripting`, `tabs`, `storage` |
| `background.js` | Service worker: guards, actionability checks, CDP input, all tab operations |
| `lib/page-agent.js` | Injected: stable element refs, versioned observations, `find`, DOM fallbacks |
| `lib/input.js` | Pure planners: drag path, hover, click, double-click, chords, wheel |
| `lib/observe.js` | Full-vs-diff observation text, page text delta, resend triggers |
| `sidepanel.html/.css/.js` | Chat, connection control, approvals, the loop |
| `server/index.js` | HTTP server, provider table, loopback + token + origin checks |
| `server/agent.js` | Turn/step state machine, loop and repeat detection |
| `server/providers.js` | Gemini and OpenAI-compatible adapters |
| `server/tools.js` | The action schema and its validator |
| `test/deepseek-probe.mjs` | Live API probe: model ids, base URL, tools, reasoning, vision |
| `test/verify-observe.mjs` | Full/diff formatting and the resend triggers, pure Node |
| `test/verify-input.mjs` | Drag path, keys and wheel planning, pure Node |
| `test/verify-pointer.mjs` | Drag, drop, hover, chords and frame clicks in real Chromium |
| `test/verify-loop.mjs` | Live end-to-end turn/step against the running server |
| `test/verify-diff-loop.mjs` | Live loop where steps 2+ are diff observations |
| `test/verify-editor-loop.mjs` | Live canvas task answered with drag and coordinates |
| `test/verify-image-turn.mjs` | Live screenshot path through `/api/turn` |
