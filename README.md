# XrnFocus

A browser extension that gives **YouTube, Reddit, X, Instagram and Facebook**
a daily time budget and, if you want, hours they're simply not available.

Each site has its own allowance. Any of them can *also* share one pool, so
they trade off against each other — and whichever runs out first, the site
closes. YouTube ships outside that pool with an hour of its own, because an
hour of YouTube isn't the same kind of hour as an hour of doomscrolling.
All of that is editable.

On top of the daily budget there are **sessions**: after a stretch of
unbroken use, the site closes for a few minutes whether or not you have
time left. And a small **corner clock** on the page tells you where you
stand without having to go looking.

**YouTube Music is exempt.** `music.youtube.com` is never counted and never
blocked, even when the rest of YouTube is done for the day.

When a block lands you're not locked out — but getting past it costs you a
typed sentence, a wait, and one of a small number of daily overrides.

No account, no server, no telemetry. Nothing leaves your browser.

---

## Contents

- [Install](#install)
- [How the budget works](#how-the-budget-works)
- [Hours of the day](#hours-of-the-day)
- [Sessions and forced breaks](#sessions-and-forced-breaks)
- [When you hit a limit](#when-you-hit-a-limit)
- [What counts as time spent](#what-counts-as-time-spent)
- [The five sites (and adding your own)](#the-five-sites-and-adding-your-own)
- [The corner clock](#the-corner-clock)
- [The popup and the badge](#the-popup-and-the-badge)
- [Every setting](#every-setting)
- [Permissions and privacy](#permissions-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [For developers](#for-developers)

---

## Install

There is no build step — the extension runs from this folder exactly as it is.

**Chrome, Edge, Brave, Helium**

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick this folder

The browser loads the extension *from that folder*, so don't move or delete
it afterwards.

**Firefox**

1. Go to `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → pick `manifest.json`

Firefox 128+. Note that the Firefox path is untested — see
[Known limitations](#known-limitations).

---

## How the budget works

Two kinds of allowance, and a site can be under either, both, or neither.

**A site's own cap** — "30 minutes of Reddit a day". Only Reddit spends it.

**The shared pool** — one allowance that every site marked *draws from the
shared pool* spends together. An hour on X leaves nothing for Instagram.

A site is blocked as soon as **either** runs out. That means you can say
"no more than 15 minutes of Instagram, and no more than an hour of
everything put together", and both hold.

The defaults:

| Site | Own cap | In the pool? | Session |
|---|---|---|---|
| YouTube | 60 min | **no** | 25 on, 5 off |
| Reddit | 30 min | yes | 25 on, 5 off |
| X / Twitter | 15 min | yes | 25 on, 5 off |
| Instagram | 15 min | yes | 25 on, 5 off |
| Facebook | 15 min | yes | 25 on, 5 off |
| *the pool itself* | 60 min | — | — |

So YouTube gets its own hour that nothing else can eat, while the four feed
sites share a second hour between them.

Set a site's own cap to **0** to remove it — then only the pool constrains
it. Untick *draws from the shared pool* and only its own cap does. Do both
and the site is tracked but never blocked by a budget.

**The day rolls over at 04:00**, not midnight, so a session at 01:00 counts
against the day you're actually living. Change it under *The day*.

---

## Hours of the day

Separately from any budget, each site can have hours.

- **blocked during these windows** — "no Reddit 09:00–17:00, Mon–Fri"
- **allowed only during these windows** — "Instagram only between 20:00
  and 21:00"

Add as many windows as you like, each with its own days. A window whose end
is earlier than its start runs overnight and **belongs to the day it starts
on** — so a Friday window of 22:00→06:00 still covers 02:00 on Saturday,
which is how anyone would describe a Friday night.

A time-of-day block outranks a spent budget: if both apply, the block screen
tells you about the hours, because that's the one with the later "back at".

---

## Sessions and forced breaks

A daily budget says how much. A session says *how long in one go*.

Out of the box every site is set to **25 minutes, then a 5-minute break**.
When a stretch runs out the site closes, exactly as if you were out of
minutes for the day — except it comes back in five minutes rather than
tomorrow.

Two things make this livable rather than annoying:

- **The break costs you nothing.** Time spent sitting out a break is not
  billed against your daily budget. Only time on the site is.
- **Taking the break yourself counts.** The stretch resets on its own once
  you have been away from the site for a whole break's length. Wander off
  for five minutes and you come back to a fresh 25 — you are never punished
  for doing voluntarily what the rule was going to make you do anyway.

A stretch is *continuous use*, not a share of the day. Twenty minutes on
Reddit, a two-minute detour to your email, then five more minutes on Reddit
adds up to one 25-minute stretch, because two minutes is not a break.

You can change the two numbers per site, or untick the rule entirely:

> ☑ Break after `25` min of use, for `5` min

Forced breaks are deliberately **not overridable by default** — a break is
the shortest of all the blocks, usually minutes, so being able to buy your
way out defeats most of the point. There is a switch for it under
*Overrides* if you disagree.

If your daily budget runs out at the same moment, that's what you'll be
told: "out of minutes for today" is a longer wait than "take five", and it
is the more useful thing to know.

---

## The corner clock

A small pill in the corner of every tracked page, showing the number that
matters right now:

```
  ● 12:34  left        ← time left today
  ● 4:12   to break    ← time left in this stretch
  ● 8:05   override    ← time left on an override
```

It always shows whichever runs out **first**, so it never tells you a
comfortable number while a tighter one is about to bite. Hover it for the
full picture. The dot turns amber under five minutes and red under one.

It ticks every second, but only while the page is actually in front of you
— which is exactly when the clock it is showing is running. Look away and
it freezes, because nothing is being spent.

On a site with no cap and no session rule there is nothing to count down
to, so it shows how long you have been there instead. It hides itself in
fullscreen, and you can move it to any corner or switch it off entirely
under *Counting & warnings*.

---

## When you hit a limit

You get the block screen: what you used, against what, and when it comes
back.

Then, if overrides are on, you can buy time back:

1. Press **Override anyway**
2. Type the sentence — by default *"I choose to keep scrolling"*
3. Wait out the delay — 45 seconds by default
4. **Unlock**

That gives you 10 more minutes, and you get 2 overrides per site per day.
Every one of those numbers is configurable, including down to nothing:
empty the phrase to skip the typing, set the wait to 0 to skip the pause,
or turn overrides off entirely for a hard wall.

Two things worth knowing:

- **Override minutes count against the site, but not against the pool.**
  They were real time on the site, so the site's own total records them and
  you go further over. The *shared* pool is held for the length of the
  grant — overriding Reddit must not quietly spend your Instagram time.
  When the grant lapses you're blocked again immediately.
- **The phrase and the wait are enforced by the extension's background, not
  by the page.** Reloading the block screen doesn't restart your wait in
  your favour, and editing the page in devtools doesn't unlock anything.

You can also end an override early from the popup if you change your mind.

---

## What counts as time spent

Time is only counted when **all** of these are true:

- the tab is the active tab
- in the focused browser window
- and you're not idle

"Idle" means no keyboard or mouse for 60 seconds (configurable). But **a tab
playing audio keeps counting even while you're idle** — otherwise a
40-minute video you never touch would be billed as one minute. That's the
*Keep counting while the tab is playing audio* switch; leave it on.

Nothing accrues when the browser is in the background, when the tab is in
another window you're not looking at, or when your machine is asleep. A
suspend is explicitly guarded against: no single stretch can ever bill more
than 90 seconds, so closing the lid on an open Reddit tab costs you nothing.

**A blocked site's timer is frozen.** Once you're over a limit, in an
off-limits hour, or sitting out a break, the counter stops dead and stays
there. Time on the block screen is not billed, and neither is a tab left
open on a site you can no longer use. The only thing that moves a counter
is time you actually spend on a site you're actually allowed on.

---

## The five sites (and adding your own)

Each site is a set of domains plus a set of exceptions. Both are editable.

- **Domains** — each covers its subdomains, so `reddit.com` already includes
  `old.reddit.com` and `www.reddit.com`. `x.com` and `twitter.com` are one
  site. `facebook.com` and `fb.com` likewise.
- **Never block** — exceptions, which beat everything. `music.youtube.com`
  is the one that ships. An exception isn't just unblocked, it's *invisible*:
  never counted, never blocked, not even when its parent site is done.

**Adding a site** — type a domain into the box at the bottom of *Sites* and
press **Add site**. Your browser will ask for permission to access that
domain; the extension can't see or block it otherwise. Custom sites behave
exactly like the built-in five, and can be removed again (which hands the
permission back).

---

## The popup and the badge

The toolbar icon shows **minutes left** on whatever you're currently looking
at — blue normally, red under five minutes, amber while an override is
running. Nothing when you're not on a tracked site.

Click it for today: the pool, then every site, with what's been spent and
what's left. A site that's currently blocked says why — *limit hit*,
*pool spent* or *scheduled*.

You'll also get a quiet corner toast on the page itself at 5 minutes and
1 minute left. Change the marks, or empty the field to switch them off,
under *Counting & warnings*.

---

## Every setting

**The day** — the hour your counters reset.

**Shared pool** — on/off, and its size.

**Sites** — per site: on/off, domains, exceptions, own cap, whether it draws
from the pool, its session rule (break after N minutes, for M), and its
hours.

**Overrides** — on/off, the phrase, the wait, how many minutes a grant
buys, how many per day, whether that daily number is per site or one budget
across all sites, and separately whether an override can lift a *budget*
block, a *time-of-day* block, and a *forced break*. Turning off the second
one makes your scheduled hours non-negotiable while leaving budgets
flexible; the third ships off already.

**Counting & warnings** — the warning marks, the idle threshold, whether
audio keeps the clock running, and the corner clock (on/off and which
corner).

**Today** — live counters, plus reset today's counters, export settings,
import settings, and restore defaults. Export gives you a JSON file; import
takes one back.

Settings sync across browsers you're signed into. **Counters don't** — the
minutes you've spent are a fact about one machine, and syncing them would
have two browsers racing on every tick.

---

## Permissions and privacy

| permission | what it's for |
|---|---|
| the five sites' domains | see which of them a tab is on, and redirect it when it's over |
| `storage` | your settings and today's counters |
| `alarms` | the once-a-minute check that catches schedule edges and the daily reset |
| `idle` | stop the clock when you walk away |
| `declarativeNetRequest` | redirect a blocked site before the page loads |
| `scripting` | only for sites *you* add later |

There is deliberately **no `tabs` permission**, which is the one that reads
as "read your browsing history". The extension only ever sees URLs for the
handful of domains you've configured.

Nothing is sent anywhere. There is no server, no analytics, and no network
request of any kind.

---

## Troubleshooting

**A site isn't being counted.** Check it's ticked in *Sites*, and that the
page isn't matched by one of its *Never block* exceptions. Then reload the
tab — a content script only attaches on load, so a tab that was already open
when you installed or reloaded the extension isn't reporting.

**A site isn't being blocked, even though the popup says 0 left.** Reload
the extension at `chrome://extensions`, then reload the tab.

**I got blocked while watching a video I wasn't touching.** That's the
audible rule working as intended — playback counts. If you'd rather it
didn't, turn off *Keep counting while the tab is playing audio*.

**Time is accruing when I'm not looking at the page.** It shouldn't. Check
whether the tab is playing audio, which is the one case that counts while
you're idle.

**My counters vanished.** They reset at 04:00 by default. If it's later than
that, this is the new day.

**The override button isn't there.** Either you've used all of today's, or
the block is one your settings say overrides can't lift — a time-of-day
block with *Can override a time-of-day block* switched off. The line at the
bottom of the block screen says which.

**I got sent away after 25 minutes even though I had time left.** That's
the session rule. Change the numbers, or untick *Break after…*, on the
site's card in settings.

**The corner clock isn't there.** It's off, or you're in fullscreen, or the
page isn't tracked (it won't appear on `music.youtube.com`). A tab that was
already open when you installed or reloaded the extension needs a refresh.

**I want out.** Disable or remove the extension from `chrome://extensions`
like anything else. This is a speed bump you've chosen to put in your own
way, not a lock — see below.

---

## Known limitations

- **This is friction, not enforcement.** Anyone who can reach
  `chrome://extensions` can turn it off in three clicks. It's built to
  interrupt an impulse, not to defeat a determined you.
- **Firefox is untested.** The manifest carries the Gecko keys and
  `web-ext lint` reports no errors, but no one has actually run it there.
  Chromium (Chrome, Edge, Brave, Helium) is the tested path.
- **One minute of resolution for schedules.** A window that opens at 09:00
  takes effect within a minute of 09:00, because that's the fastest an MV3
  alarm can fire. Time budgets are exact to the second.
- **"YouTube except music" means the music domain.** A music video watched
  on `youtube.com` proper counts as YouTube, because the only reliable
  signal for "this is music" arrives after the page has already loaded.
  `music.youtube.com` is exempt completely.
- **Counters are per browser profile.** Two browsers, two budgets — and
  two independent session stretches.
- **A break is enforced per site, not across them.** Being sent off Reddit
  for five minutes does not stop you opening X. The shared pool is the tool
  for that.

---

## For developers

See [`docs/architecture.md`](docs/architecture.md) for how the extension fits
together, and [`docs/overrides.md`](docs/overrides.md) for why the escape hatch
is shaped the way it is.

```bash
npm install        # web-ext, for the Firefox lint/build only
npm run check      # syntax + manifest parse
npm test           # the whole suite — offline, about a second
```

The test suite needs no browser and no network:
[`shared/rules.js`](shared/rules.js) is pure and gets unit-tested in a `vm`
context, and [`test/chrome-stub.mjs`](test/chrome-stub.mjs) fakes enough of
`chrome.*` — plus a clock you can fast-forward — to run the real service
worker through accrual, blocking and the whole override handshake.

## License

[MIT](LICENSE)
