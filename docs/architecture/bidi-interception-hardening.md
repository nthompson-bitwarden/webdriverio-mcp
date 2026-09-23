# BiDi interception hardening — follow-ups from browser mocks

Deferred items from the `mockType: 'browser'` work (PR #153, branch `feature/browser-mocks`).
Each was deliberately left out of that change; none block it. Verified facts are dated —
re-check against the installed `webdriverio` before acting.

## 1. Upstream bug: `respond(undefined)` sends an invalid BiDi `network.provideResponse`

**What:** calling `mock.respond(undefined)` (or `null`) on a real BiDi session makes webdriverio
emit `network.provideResponse` with body `{"type":"string"}` and no value. The BiDi endpoint
rejects it (`invalid argument - Invalid input in "body"`), and because
`#handleResponseStarted` invokes the command synchronously inside the network event handler
(mitt emitter, `webdriverio/build/index.js` ~:4349), the rejected promise throws through the
handler into the host process — an uncaught exception that kills it. Reproduced standalone
against plain `webdriverio@9.31.6` on 2026-09-22; the same crash killed the MCP dev server
during live verification of the mock tools.

**Why upstream:** the failure class is webdriverio's — an invalid overwrite payload should be
rejected at `respond()` time (argument validation), not surface as a process-killing throw at
request-interception time. A fix there deletes the class for every consumer.

**Action:** file a webdriverio issue with the standalone repro
(mock `'**/*'` → `respond(undefined)` → `browser.url(...)` → process dies). Meanwhile the
guard at the tool boundary (`respond behaviors require value` in `src/tools/mock.tool.ts`)
keeps MCP clients away from it.

**Adjacent, same guard class:** `WebDriverInterception` also exposes `request`/`requestOnce`
overwrites (deliberately unexposed by the MCP tools today). If they are ever added to the
behavior enum, they need the same validate-at-configure-time treatment — any invalid
overwrite payload reaches the same synchronous-throw path.

## 2. Process-level containment for throws inside BiDi event handlers

**What:** any uncaught throw inside a BiDi event handler (the class above is one instance)
terminates the MCP server process. There is no containment at the server level today. The
respond-value guard closes the one known reachable path; unknown webdriverio bugs in
interception, or any other BiDi subsystem emitting through the same handler chain, remain
process-fatal.

**Why deferred:** cross-cutting — a guard would cover every BiDi-backed feature
(navigation, elements, screenshots), not mocks, so it is its own change and review. The
containment semantics are also a real design decision, not a one-liner: continuing after an
uncaught throw risks a corrupted BiDi socket and zombie sessions that look alive; "log and
exit" forfeits the session but keeps state honest; swallowing server-wide can mask exactly
the class of upstream bug item 1 describes.

**Action:** design pass on where containment belongs (per-handler try/catch in the
wdio event subscription vs. a top-level handler in `src/server.ts` with session-invalidation
semantics), then implement behind that decision.

## Related, lower priority

- **Replay gap (accepted limitation):** a `mock` step that fails at configure time is
  retained by the runtime registry (retry-friendly) but emitted by the generator only as an
  error comment; a later successful `get_mock_calls` for the same key then replays against a
  key the generated script never set — a `TypeError` at replay. Emitted code is best-effort
  and the error comment flags the gap; making `get_mock_calls` emit a creation line would
  trade a loud failure for a silently-empty one.
- **Behavior-taxonomy table:** the generator dispatches browser behaviors by string prefix
  (`startsWith('respond')` etc. in `src/recording/code-generator.ts`) instead of a table
  shared with the tool's zod enum. Pinned by generator tests; revisit only when the behavior
  enum grows — nothing structural forces a new behavior to update both sides today.
