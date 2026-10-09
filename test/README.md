# Tests

```bash
npm test                      # everything
node test/run.mjs rules       # only files matching a substring
node test/rules-test.mjs      # one file, directly
```

**The whole suite runs offline, with no browser, in about a second.** That
is a property worth defending: if a change can only be verified against live
Reddit, the logic is in the wrong file.

## The contract

- Every `test/*-test.mjs` is standalone and runnable on its own.
- A file prints exactly one `PASS <name> — N assertions` line, or a `FAIL`
  line followed by each failure, and exits non-zero.
- `test/run.mjs` only runs them all and sets one exit code.
- No network, no real browser, no sleeping. Time is always fast-forwarded.

## The files

| file | what it covers |
|---|---|
| `harness.mjs` | `ok`/`eq`/`done`, and `loadShared()` — a `vm` loader for the `shared/` classic scripts |
| `chrome-stub.mjs` | a fake `chrome` and a fake clock, enough to run the **real** `background/background.js` |
| `rules-test.mjs` | host matching, the music exemption, the day boundary, schedule windows, verdict precedence, override arithmetic, formatting |
| `static-test.mjs` | manifest ↔ code consistency: referenced files exist, script load order, and the four-edit rule for adding a site |
| `browser-smoke.mjs` | **not run by `npm test`** — a real browser over CDP; see below |
| `background-test.mjs` | accrual, the suspend clamp, pool vs own cap, focus/idle/audible, DNR rules, tab bouncing, the override handshake, forced breaks, rollover, config merge |

## How the loaders work

`shared/constants.js` and `shared/rules.js` are plain scripts that hang
everything off `self`. A `vm` context with a `self` object is a complete
stand-in for a browser — no `chrome.*` stub is needed, because `rules.js` is
pure by construction.

`URL` and `URLSearchParams` **do** have to be injected: they are host
globals, not ECMAScript intrinsics, so a fresh `vm` context has neither, and
`rules.js` parses every URL through `URL`.

`chrome-stub.mjs` goes further and loads the background worker for real,
against:

- an in-memory `chrome.storage` (with `onChanged` firing)
- a mutable `world` — window focus, the tab list, idle state — that the
  tabs/windows/idle APIs read from
- a `FakeDate` whose `now()` a test controls, so an hour passes instantly
- recording stubs for `tabs.update`, the badge, DNR and `scripting`

`send(type, extra, sender)` invokes the worker's real `onMessage` handler
and resolves with its reply.

## Gotchas when writing a test

- **Firing an event is not the same as setting state.** The worker caches
  idle state in a module variable it only updates from
  `chrome.idle.onStateChanged`, so `world.idle = "idle"` alone changes
  nothing — use `bg.setIdle()`, which fires the listener. A test that gets
  this wrong passes while asserting the opposite of what it claims; that
  already happened once here.
- **The first `TICK` bills nothing.** There is no earlier stretch to close.
  Expect zero, then advance the clock and tick again.
- **`GET_STATE` folds the open stretch into the counters** for display
  without writing it back, so it can create a `{ ms: 0 }` entry for a site
  that has no stored counter yet. Assert on `.ms`, not on the entry's
  existence.
- **The once-a-minute alarm needs firing too.** Anything that happens with
  no tab reporting — a break expiring while you sit on the block page — only
  moves when `bg.fireAlarm()` is called. Same trap as `setIdle()`.
- **`reconcile()` is serialised**, so awaiting any message guarantees every
  earlier reconcile — including the one `boot()` kicks off — has settled.
  That is why the fixtures open with a throwaway `GET_STATE`.

## What the offline suite cannot tell you

Chrome **rejects a malformed `declarativeNetRequest` rule silently**, the
stub happily accepts any shape, and nothing here injects a content script
into a real page. That is what `browser-smoke.mjs` is for:

```bash
npm run smoke                      # finds a Chromium itself
BROWSER=/usr/bin/chromium npm run smoke
SHOTS=/tmp/shots npm run smoke     # also writes screenshots
```

It skips cleanly (exit 0) when there is no browser or no openssl, which is
why it is safe to wire into CI and why it is kept out of `npm test` — the
offline suite must stay a hard signal.

It checks the worker boots clean, every extension page renders without
throwing, Chrome accepts the DNR rules, a real navigation to a blocked host
is redirected, the content script injects and the corner clock counts down,
a forced break fires with the right block screen, and consecutive options
edits all persist.

### Browser traps worth knowing

These each cost an hour once, and they all fail without telling you why:

- **`--host-resolver-rules` is ignored** when the browser resolves over
  DoH, which Helium does by default. You get
  `chrome-error://chromewebdata/` and no explanation. Working around it is
  why the smoke test runs its own **HTTPS** server with a self-signed cert
  and `--ignore-certificate-errors`.
- **Helium upgrades `http://` to `https://`.** A plain HTTP stand-in server
  receives a `CONNECT` it does not answer, and the navigation dies with
  `ERR_EMPTY_RESPONSE`.
- **The resolver rule takes no space after the comma.** With one, the whole
  rule is discarded.
- **`/json/new?<url>` is unreliable** with a mapped host. Create the tab on
  `about:blank` and drive it with `Page.navigate`.
- **Headless has no focus**, and the content script will not tick without
  it. Send `Emulation.setFocusEmulationEnabled {enabled:true}` first, or
  you will conclude the content script is broken when it is only idle.
