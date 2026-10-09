# Overrides

The escape hatch, and why it is shaped the way it is.

## The idea

A hard lock is either useless or infuriating: either you can turn the
extension off in three clicks (you can — see below), or you genuinely can't
and it ruins the one evening you needed the thing it blocks.

So the block is not a lock, it is a **price**. Getting past it costs a typed
sentence, a wait, and one of a small daily number. None of that stops you.
All of it interrupts the reflex, which is the only thing that was ever
actually in the way.

Every part of the price is configurable, down to zero. Empty the phrase,
set the wait to 0 and raise the daily cap and you have a one-click snooze.
Turn overrides off and you have a hard wall. The defaults sit in between:
*"I choose to keep scrolling"*, 45 seconds, 10 minutes, twice a day.

## The handshake

Three messages, with the background holding the clock in between.

```
block page                        background
    |                                  |
    |-- OVERRIDE_BEGIN(siteId) ------->|  checks the block is overridable at all
    |<-- { ok, readyAt } --------------|  stores { siteId, since: now }
    |                                  |
    |   (the page counts down; this    |
    |    display is cosmetic)          |
    |                                  |
    |-- OVERRIDE_CLAIM(siteId, phrase)>|  re-checks: overridable? phrase? waited?
    |<-- { ok, until } ----------------|  writes overrideUntil, bumps the counters
```

**Why two messages instead of one.** If the page owned the countdown you
could skip it by editing the DOM, and a reload would restart it in your
favour. If the page owned the daily cap you could skip it by reloading. So
`OVERRIDE_BEGIN` records a timestamp in `chrome.storage.local` and
`OVERRIDE_CLAIM` re-derives everything from scratch:

- `verdictFor(...).canOverride` — is this kind of block overridable, and are
  there any left today?
- the phrase, compared case- and whitespace-insensitively (the friction is
  meant to be deliberation, not a typing test)
- `now - pending.since >= delaySeconds` — did you actually wait?

The block page renders the handshake. It does not adjudicate it.

## What a grant does

`usage.sites[id].overrideUntil = now + grantMinutes * 60000`, plus an
increment to both the per-site and the global override counters.

In `verdictFor`, a live grant is applied **after** a reason has been
established. `blocked` goes false, but `reason` stays, and `resumesAt`
becomes the moment the grant lapses. Three consequences worth keeping:

- the UI can say "10 more minutes, on override" instead of pretending the
  limit was never reached
- **the site's own clock keeps running.** The grant is on top of a budget
  you have already spent, so you go further over, and nothing is refunded.
  The day's total stays an honest record of time on the site
- **the shared pool does not move**, for the length of the grant. See below
- when it lapses, the block is back immediately — no second grace period,
  and the DNR rules come straight back on the next reconcile

## Why the pool is spared

An override is a deal you make with yourself about *one site*. If those
minutes also drained the shared pool, overriding Reddit would silently
shorten Instagram, X and Facebook — a cost you never agreed to, cannot see
coming, and would only discover later when an unrelated site closed early.

So `rules.poolBillableMs()` subtracts the part of each billed stretch that
a live grant covered, and only the remainder reaches `usage.poolMs`. It
splits correctly when a grant lapses mid-stretch: the covered seconds are
spared and the rest are charged as normal.

Both the real accrual and `buildState()`'s live display go through that one
function, or the popup's pool figure would creep ahead of the stored one
for exactly the length of every override.

The site's own counter is deliberately *not* spared. It is the record of
where your time went, and a record that quietly omits the minutes you
argued your way into would be worth very little.

`END_OVERRIDE` zeroes `overrideUntil` for a site. It does **not** refund the
override you spent; changing your mind early is free, but it does not buy
you a fresh one.

## The knobs

| setting | default | what it changes |
|---|---|---|
| `enabled` | true | off = a hard wall, no override UI at all |
| `phrase` | "I choose to keep scrolling" | empty skips the typing step |
| `delaySeconds` | 45 | 0 skips the wait |
| `grantMinutes` | 10 | how long a grant buys |
| `maxPerDay` | 2 | how many you get |
| `perSite` | true | true = that many *per site*; false = one budget across all sites |
| `forLimits` | true | can an override lift a spent budget? |
| `forSchedule` | true | can an override lift a time-of-day block? |
| `forBreaks` | **false** | can an override lift a forced break? |

`forLimits` and `forSchedule` are separate on purpose. A budget is a
guess you made this morning about how much is reasonable, and being wrong
about it should be cheap. Hours are usually a harder commitment — "not
during work" is a different kind of promise — so turning `forSchedule` off
makes the schedule non-negotiable while leaving budgets flexible. That
combination is the one most people actually want, and it is not the default
only because locking yourself out with no visible way back is a bad first
experience.

`forBreaks` ships **off**, and that is the one default here that leans
strict. A forced break is the shortest block the extension has — usually
five minutes — so an escape hatch costing 45 seconds of typing and waiting
would be most of the break anyway, and buying out of a five-minute pause is
close to admitting the pause was never real. Turn it on if you disagree;
nothing else changes.

When a block isn't overridable, `OVERRIDE_BEGIN` refuses outright — you
cannot even start the wait — and the block page says which case it is at the
bottom of the screen.

## What this is not

It is not security. Anyone who can reach `chrome://extensions` can disable
the extension in three clicks, and no browser extension can prevent that.

Enforcing the phrase and the wait in the background isn't an attempt to stop
that. It is there so the friction you *chose* still exists in the moment you
least want it to — so that the easy path is typing a sentence and waiting
45 seconds, rather than opening devtools. If you're willing to go round the
back, the extension has already done its job: you're not acting on reflex
any more.
