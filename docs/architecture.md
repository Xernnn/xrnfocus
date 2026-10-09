# Architecture

Read this before changing accrual, enforcement, storage or the config merge.

## Contexts

Five, with no shared module system. Everything is a classic script hanging
things off `self`, and `shared/constants.js` must load first in every list.

| context | can it decide anything? |
|---|---|
| `background/background.js` | yes — it owns the clock, the storage and the verdict |
| `content/content.js` | no — it reports and it obeys |
| `block/block.js` | no — it renders a verdict and relays the override handshake |
| `popup/popup.js` | no — read-only |
| `options/options.js` | no — it edits a config object and posts it |

The asymmetry is the point. A content script runs inside a page that can
rewrite its own globals, and the block page is one devtools console away
from anyone who wants to skip a countdown. Neither is a place to keep the
number of minutes you have left.

## The verdict

`shared/rules.js` is pure — no DOM, no `chrome.*`, and `now` is always an
argument rather than a call to `Date.now()`. That is what lets five contexts
and a test suite ask the same question and get the same answer, and it is
why the whole file is unit-testable in plain Node.

`verdictFor(config, usage, site, now)` returns:

```js
{ siteId, blocked, reason, resumesAt, overrideUntil, breakUntil,
  usedMs, remainingMs, sessionRemainingMs, canOverride, overridesLeft }
```

Precedence, in order:

1. **A disabled site** is never blocked and never tracked.
2. **A schedule window** beats a spent budget. Both can be true at once, and
   the schedule is both the more useful thing to say and the one with the
   later `resumesAt`.
3. **The site's own cap.**
4. **The shared pool**, but only for a site with `inPool: true`.
5. **A forced break** — last, because it is the shortest wait of the four.
   If the day's budget is also gone, saying "take five" would be actively
   misleading.
6. **A live override grant** suppresses the block *after* a reason has been
   established — `blocked` goes false but `reason` stays, so the UI can say
   "10 minutes, on override" instead of pretending the limit was never hit,
   and so the block returns the instant the grant lapses.

`remainingMs` is the minimum of the site's own remaining budget and the
pool's, or `null` when neither meters the site — an uncapped site outside
the pool has no countdown at all, and callers must handle that rather than
treating it as zero.

## Accrual

**Time is billed as "now minus when this stretch started", never by counting
ticks.** Under MV3 the service worker is killed constantly; a tick that
never fires is lost forever, but a start timestamp persisted in
`chrome.storage.local` survives and is billed correctly on the next wake.

`reconcile()` is the whole of it:

1. Bill the open stretch, if there is one.
2. Work out what is countable *now*, and open a stretch for it.
3. Re-derive every verdict and push the consequences outward.

It is **serialised onto a single promise chain**. A tab activation and a
window focus change arriving in the same millisecond would otherwise both
read the same usage, both add their slice, and the second write would
silently discard the first.

### What makes a stretch countable

All of, from `countableNow()`:

- a focused browser window (`chrome.windows.getLastFocused().focused`)
- whose active tab has a `url` — and without the `tabs` permission `url` is
  only populated for hosts we hold, which is exactly the tracked set, so an
  empty url reliably means "not ours"
- that `siteForUrl()` maps to an enabled site and *not* to one of its
  exceptions
- and either `idleState === "active"` or (`countWhileAudible` and
  `tab.audible`)

The audible clause exists for one case: a long video. You have not touched
the keyboard in forty minutes and you are absolutely still watching.

### Sessions

A session is *continuous use*, not a slice of the day, and it lives in two
extra counters per site: `sessionMs` and `lastSeenAt`.

The accrual step adds the same `billed` figure to both `ms` and
`sessionMs`, then:

- clears the stretch if a stamped break has elapsed, **or** if the gap
  between `lastSeenAt` and the start of this stretch was already at least
  one break long — `breakServedBy()`. Those are the same event from two
  directions: the break you were made to take, and the one you took anyway.
- stamps `breakUntil = now + breakMs` the moment `sessionMs` crosses
  `workMs`.

**Stamping happens here and nowhere else.** `verdictFor()` reads
`breakUntil` and never writes it, which is the only reason the verdict can
stay a pure function of (config, usage, now).

The counterpart is in step 2 of `reconcileInner()`: a site whose verdict is
blocked does **not** get a new stretch opened. Otherwise the minutes spent
staring at the block page are billed to the site, and a five-minute forced
break would quietly eat five minutes of the day's budget. This is the whole
of "freeze the timer when blocked" — there is no separate frozen flag, just
the absence of an open stretch.

### The pool during an override

The site's counter and the pool's do not always move together. Time bought
with an override is real time on the site, so `usage.sites[id].ms` takes all
of it — but `usage.poolMs` takes none, because draining the shared budget
would make overriding one site a silent cost to every other site in the
pool.

`rules.poolBillableMs(usage, siteId, billedMs, now)` is the one place that
decides this, and it handles a grant lapsing mid-stretch by sparing only the
covered part. Both the accrual and `buildState()`'s live fold call it; if
only one did, the popup's pool figure would drift for the length of every
override.

### The clamp

`MAX_ACCRUAL_MS` (90s) is not a tuning knob, it is a correctness guard.
Billing by subtraction is exact right up until the machine suspends, where
the same subtraction bills an eight-hour sleep as eight hours of Reddit. A
legitimate stretch can only run to one heartbeat plus scheduling slop, so
anything longer is a clock jump and gets truncated.

### Who drives it

| trigger | what it catches |
|---|---|
| a `TICK` from the content script, every 15s | the normal case; also what keeps the worker alive and what makes the counters fresh |
| `tabs.onActivated` / `onUpdated` / `onRemoved` | switching away, navigating, closing |
| `windows.onFocusChanged` | alt-tabbing out of the browser |
| `idle.onStateChanged` | walking away and coming back |
| the `bs-tick` alarm, every minute | everything no tab can report: a schedule window opening while you sit on the page, the daily reset, a grant lapsing with nothing focused |

One minute is the floor `chrome.alarms` allows. Do not try to beat it with a
timer inside the worker — the worker gets killed.

## Enforcement

Two layers, because neither covers the other's case.

**`declarativeNetRequest` session rules** stop a *new* navigation before a
byte is fetched, which is the only way to get no flash of the feed. Rules
live in the id range from `DNR_RULE_BASE`, and the whole range is cleared and
rewritten whenever the set of blocked sites changes, so nothing else may use
those ids. A rule's `excludedRequestDomains` carries the site's exceptions —
miss that and the network layer blocks `music.youtube.com` while every other
layer carefully lets it through.

Chrome **rejects a malformed DNR rule silently**. The only way to know a rule
shape is accepted is to load the extension and read `getSessionRules()` back;
the test stub cannot tell you.

**Bouncing open tabs** handles what DNR cannot see: the three Reddit tabs
already open and already rendered when the pool ran dry. `bounceOpenTabs()`
queries by URL pattern and re-checks `siteForUrl()` on each hit, so an open
`music.youtube.com` tab is not collateral damage of `youtube.com` running
out.

Both only run when the *signature* of blocked sites changes, or on an
explicit `force`. Rewriting DNR rules on every heartbeat would be absurd.

**The content script's one-shot timer** is not a third enforcement layer, it
is precision: every tick reply carries `remainingMs` and
`sessionRemainingMs`, and the page sets a `setTimeout` for whichever is
smaller, so the block lands on the second rather than up to a heartbeat
late.

### The corner clock

Drawn by the content script into the same shadow root as the warning toast.
It holds no authority: every heartbeat hands it a fresh set of figures and
it interpolates between them, advancing its local counter **only while the
page is in front of you** — which is precisely when the background is
billing. That is what stops the pill and the real total drifting apart
while you look away, without a message per second.

It renders whichever of the day's budget and the current stretch is
smaller, falling back to elapsed time when nothing meters the site at all.
`position` is a config string that becomes a `.clock.pos-*` CSS class, and
the settings dropdown has to offer exactly that set — `static-test` checks
all three agree.

## Storage

| key | area | why there |
|---|---|---|
| `bs_config` | `sync` | small, and worth having on every browser you sign into |
| `bs_usage` | `local` | minutes spent are a fact about *this machine*; syncing them would have two browsers racing on every tick |
| `bs_session` | `local` | the open stretch, so a killed worker can still bill it |
| `bs_pending_override` | `local` | the in-flight handshake |

**The background is the only writer.** Every UI change is a message that
returns the resulting state.

### Rollover

Counters are **stamped with a `dayKey`, not cleared by a timer**.
`rolledOver()` compares the stored key against `dayKeyFor(now, resetHour)`
and hands back a fresh object when they differ. A browser asleep across the
reset hour therefore starts clean on wake, which a scheduled clear could
never guarantee.

`dayKeyFor` shifts the clock back by `resetHour` before reading the date,
which is what makes the day run 04:00→04:00 instead of midnight→midnight.

### The config merge

`mergeConfig()` merges a stored config *onto* the defaults rather than using
it as-is, and merges sites **per id**. Two things depend on this:

- a config written by an older version keeps working when a new field
  appears, instead of reading `undefined` for it
- a built-in site added in a later version shows up for existing users,
  instead of being silently absent because their stored `sites` array
  predates it

Your edited values always win; only the gaps are filled.

## Built-in vs custom sites

The five built-ins are declared statically in the manifest —
`host_permissions` *and* `content_scripts.matches` — and listed in
`BUILTIN_DOMAINS`. Adding one is **four edits** and `test/static-test.mjs`
fails on every one of them.

Anything you add yourself cannot be static. `syncDynamicScripts()` registers
a content script at runtime, but **only for origins `chrome.permissions`
confirms are granted**: registering for an origin the extension does not
hold fails the whole call and takes the valid matches down with it. It runs
only on a `force` reconcile, since it is a registration round-trip.

A custom site without a granted origin still gets DNR and tab-bounce
enforcement via the once-a-minute alarm; it just loses the 15-second
precision a content script gives.
