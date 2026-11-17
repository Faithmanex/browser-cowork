# Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| `fetch failed`, or `Could not reach deepseek's API (UND_ERR_CONNECT_TIMEOUT)` | the backend could not reach the model provider — a network problem, not the browser | say so plainly and retry the instruction; the conversation is intact |
| `Cannot reach the backend at http://127.0.0.1:8787` | the local server is not running | tell the user to start it; nothing can work without it |
| `The backend rejected the pairing token` | token mismatch after a restart | ask the user to paste the token the server printed into Settings |
| `The page agent is not installed in this panel` | the panel is on `about:blank` or an error page | `navigate` it to a real URL, then look again |
| `market failed to load — scroll to load` | the market card is not mounted | turn sync scroll off, scroll that panel, re-read |
| Scrolling one panel moves all of them | sync scroll is on | `set_setting {"key":"syncScroll","value":false}`, and say you did |
| `That ref is from an older observation` | the page changed, or another panel's ref was used | take a fresh observation of that panel |
| `Ref eN is no longer on the page` | the element was removed | re-read; do not guess a new ref |
| A click is refused as covered | an overlay (consent, promo, guide) is on top | close the overlay, or click it if that is the intent |
| A click is refused as disabled / moving | the control is not actionable yet | wait or re-read; `moving` means an animation has not settled |
| `No panel is focused` | no panel selected | `open_panel` or pass `panelId` |
| A panel is blank or stuck | the load failed | `reload_panel`, then `navigate` if it persists |
| Text in a field did not take | the site uses a custom keypad or a controlled input | use the keypad clicks, or `set_range` for sliders |
| The bet became a multi-bet | stale picks from an earlier session | clear the slip (`0`/Esc in the HUD, or its clear control) and bind one selection |
| The Confirm sheet is still open | a cancelled or interrupted place | press cancel (`[data-op=betslip-confirm-cancel]`) before doing anything else |
| Zoom made a page unreadable | `fit` asked for too small a factor on a busy layout | `set_zoom` with an explicit factor, 0.7–0.8 |
| A run stopped mid-task | the user stopped it, or the same action repeated three times | the run ended; the next instruction continues the same conversation |
| Approval card says "This looks consequential" | the target's label or href matches a risky word | the user must approve; do not retry a declined action |

## Rules of thumb

- When something is refused, read the reason — it names the element or the
  overlay. Do not retry the same call unchanged.
- When a page looks wrong, a fresh observation is cheaper than guessing.
- The log in the HUD is the fastest way to see what the engine believes.
- If two panels disagree, they are separate profiles: fix each one.
