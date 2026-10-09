// Everything the extension decides, decided without a browser.
import { loadShared, ok, eq, done, at } from "./harness.mjs";

const NS = loadShared();
const R = NS.rules;
const CFG = () => JSON.parse(JSON.stringify(NS.DEFAULT_CONFIG));
const MIN = 60000;

// ---------- host matching ----------

ok(R.hostMatches("www.reddit.com", "reddit.com"), "www subdomain matches");
ok(R.hostMatches("reddit.com", "reddit.com"), "bare domain matches itself");
ok(R.hostMatches("old.reddit.com", "reddit.com"), "deep subdomain matches");
ok(!R.hostMatches("notreddit.com", "reddit.com"), "suffix-but-not-subdomain must not match");
ok(!R.hostMatches("reddit.com.evil.net", "reddit.com"), "domain used as a prefix must not match");
ok(R.hostMatches("WWW.Reddit.COM", "reddit.com"), "matching is case-insensitive");

// ---------- the YouTube-except-music rule ----------

const cfg = CFG();
eq(R.siteForUrl(cfg, "https://www.youtube.com/watch?v=abc").id, "youtube", "watch page is YouTube");
eq(R.siteForUrl(cfg, "https://m.youtube.com/").id, "youtube", "mobile is YouTube");
eq(R.siteForUrl(cfg, "https://music.youtube.com/"), null, "music.youtube.com is exempt");
eq(R.siteForUrl(cfg, "https://music.youtube.com/watch?v=abc"), null, "music watch page is exempt");
eq(R.siteForUrl(cfg, "https://x.com/home").id, "x", "x.com");
eq(R.siteForUrl(cfg, "https://twitter.com/home").id, "x", "twitter.com folds into x");
eq(R.siteForUrl(cfg, "https://old.reddit.com/r/linux").id, "reddit", "old.reddit");
eq(R.siteForUrl(cfg, "https://example.com/"), null, "untracked site");
eq(R.siteForUrl(cfg, "chrome-extension://abc/block/block.html"), null, "the block page itself is never tracked");
eq(R.siteForUrl(cfg, "about:blank"), null, "non-http is never tracked");

// A disabled site is invisible.
const off = CFG();
off.sites.find((s) => s.id === "reddit").enabled = false;
eq(R.siteForUrl(off, "https://reddit.com/"), null, "disabled site is not tracked");

// ---------- the day boundary ----------

eq(R.dayKeyFor(at(2026, 9, 21, 2, 0), 4), "2026-09-20", "02:00 belongs to the previous day");
eq(R.dayKeyFor(at(2026, 9, 21, 5, 0), 4), "2026-09-21", "05:00 belongs to today");
eq(R.dayKeyFor(at(2026, 9, 21, 2, 0), 0), "2026-09-21", "resetHour 0 is plain midnight");
eq(R.nextResetAt(at(2026, 9, 21, 2, 0), 4), at(2026, 9, 21, 4, 0), "next reset is later today");
eq(R.nextResetAt(at(2026, 9, 21, 5, 0), 4), at(2026, 9, 22, 4, 0), "past the hour, next reset is tomorrow");

// ---------- schedule windows ----------
// 2026-09-21 is a Monday.

const work = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
ok(R.windowActive(work, new Date(at(2026, 9, 21, 10, 0))), "Monday 10:00 is inside work hours");
ok(!R.windowActive(work, new Date(at(2026, 9, 21, 18, 0))), "Monday 18:00 is outside");
ok(!R.windowActive(work, new Date(at(2026, 9, 21, 8, 59))), "08:59 is outside");
ok(R.windowActive(work, new Date(at(2026, 9, 21, 9, 0))), "the start minute is inside");
ok(!R.windowActive(work, new Date(at(2026, 9, 21, 17, 0))), "the end minute is already outside");
ok(!R.windowActive(work, new Date(at(2026, 9, 26, 10, 0))), "Saturday is not a work day");

// Overnight: belongs to the day it starts on.
const night = { days: [5], start: "22:00", end: "06:00" };
ok(R.windowActive(night, new Date(at(2026, 9, 25, 23, 0))), "Friday 23:00 is in the Friday-night window");
ok(R.windowActive(night, new Date(at(2026, 9, 26, 2, 0))), "Saturday 02:00 still belongs to Friday night");
ok(!R.windowActive(night, new Date(at(2026, 9, 26, 7, 0))), "Saturday 07:00 is past it");
ok(!R.windowActive(night, new Date(at(2026, 9, 25, 21, 0))), "Friday 21:00 is before it");
ok(!R.windowActive(night, new Date(at(2026, 9, 27, 2, 0))), "Sunday 02:00 is a different night");

// blockDuring / allowOnly
const during = { mode: "blockDuring", windows: [work] };
eq(R.scheduleVerdict(during, at(2026, 9, 21, 10, 0)).blocked, true, "blockDuring blocks inside the window");
eq(R.scheduleVerdict(during, at(2026, 9, 21, 10, 0)).resumesAt, at(2026, 9, 21, 17, 0), "resumes when the window ends");
eq(R.scheduleVerdict(during, at(2026, 9, 21, 20, 0)).blocked, false, "blockDuring allows outside the window");

const only = { mode: "allowOnly", windows: [{ days: [], start: "20:00", end: "22:00" }] };
eq(R.scheduleVerdict(only, at(2026, 9, 21, 21, 0)).blocked, false, "allowOnly permits inside the window");
eq(R.scheduleVerdict(only, at(2026, 9, 21, 19, 0)).blocked, true, "allowOnly blocks outside the window");
eq(R.scheduleVerdict(only, at(2026, 9, 21, 19, 0)).resumesAt, at(2026, 9, 21, 20, 0), "allowOnly resumes at the next start");
eq(R.scheduleVerdict(only, at(2026, 9, 21, 23, 0)).resumesAt, at(2026, 9, 22, 20, 0), "after the window, the next start is tomorrow");
eq(R.scheduleVerdict({ mode: "off", windows: [work] }, at(2026, 9, 21, 10, 0)).blocked, false, "mode off ignores its windows");
eq(R.scheduleVerdict({ mode: "allowOnly", windows: [] }, at(2026, 9, 21, 10, 0)).blocked, false,
   "allowOnly with no windows is treated as off, not as a total lockout");

// ---------- usage + rollover ----------

const now = at(2026, 9, 21, 12, 0);
let usage = R.emptyUsage(now, 4);
eq(usage.dayKey, "2026-09-21", "fresh usage is stamped with today");
usage.sites.reddit = { ms: 5 * MIN, overrides: 0, overrideUntil: 0 };
eq(R.rolledOver(usage, now, 4).sites.reddit.ms, 5 * MIN, "same day keeps its counters");
eq(R.rolledOver(usage, at(2026, 9, 22, 12, 0), 4).sites.reddit, undefined, "a new day wipes them");
eq(R.rolledOver(usage, at(2026, 9, 22, 3, 0), 4).sites.reddit.ms, 5 * MIN,
   "03:00 the next morning is still the same day at resetHour 4");

// ---------- verdicts ----------

function fresh() {
  return { config: CFG(), usage: R.emptyUsage(now, 4) };
}

{
  const { config, usage } = fresh();
  const reddit = R.siteById(config, "reddit");   // 30m own cap, in pool
  let v = R.verdictFor(config, usage, reddit, now);
  eq(v.blocked, false, "nothing used, nothing blocked");
  eq(v.remainingMs, 30 * MIN, "remaining is the tighter of cap (30m) and pool (60m)");

  usage.sites.reddit = { ms: 30 * MIN, overrides: 0, overrideUntil: 0 };
  usage.poolMs = 30 * MIN;
  v = R.verdictFor(config, usage, reddit, now);
  eq(v.blocked, true, "own cap reached blocks");
  eq(v.reason, NS.REASON.SITE, "reason is the site's own cap");
  eq(v.resumesAt, R.nextResetAt(now, 4), "a spent budget resumes at the daily reset");
}

{
  // Pool exhausted by OTHER sites: a site under its own cap still blocks.
  const { config, usage } = fresh();
  const x = R.siteById(config, "x");            // 15m own cap, in pool
  usage.sites.x = { ms: 1 * MIN, overrides: 0, overrideUntil: 0 };
  usage.poolMs = 60 * MIN;
  const v = R.verdictFor(config, usage, x, now);
  eq(v.blocked, true, "the shared pool blocks a site that still has its own budget");
  eq(v.reason, NS.REASON.POOL, "reason is the pool");
}

{
  // YouTube is out of the pool by default, so a drained pool must not touch it.
  const { config, usage } = fresh();
  const yt = R.siteById(config, "youtube");
  usage.poolMs = 999 * MIN;
  eq(R.verdictFor(config, usage, yt, now).blocked, false, "a site outside the pool ignores the pool");
  eq(R.verdictFor(config, usage, yt, now).remainingMs, 60 * MIN, "…and counts only against its own cap");
}

{
  // No own cap + out of the pool = genuinely unmetered.
  const { config, usage } = fresh();
  const yt = R.siteById(config, "youtube");
  yt.limitMinutes = 0;
  usage.sites.youtube = { ms: 500 * MIN, overrides: 0, overrideUntil: 0 };
  const v = R.verdictFor(config, usage, yt, now);
  eq(v.blocked, false, "an uncapped, pool-free site never runs out");
  eq(v.remainingMs, null, "…and reports no countdown at all");
}

{
  // Schedule outranks a spent budget when both apply.
  const { config, usage } = fresh();
  const reddit = R.siteById(config, "reddit");
  reddit.schedule = { mode: "blockDuring", windows: [work] };
  usage.sites.reddit = { ms: 99 * MIN, overrides: 0, overrideUntil: 0 };
  const v = R.verdictFor(config, usage, reddit, at(2026, 9, 21, 10, 0));
  eq(v.reason, NS.REASON.SCHEDULE, "schedule wins over a spent budget");
  eq(v.resumesAt, at(2026, 9, 21, 17, 0), "…and reports the window's end, not the daily reset");
}

// ---------- overrides ----------

{
  const { config, usage } = fresh();
  const reddit = R.siteById(config, "reddit");
  usage.sites.reddit = { ms: 40 * MIN, overrides: 0, overrideUntil: 0 };

  let v = R.verdictFor(config, usage, reddit, now);
  eq(v.blocked, true, "blocked before any override");
  eq(v.canOverride, true, "an override is offered");
  eq(v.overridesLeft, 2, "two left on a fresh day");

  // A live grant suppresses the block but keeps the reason.
  usage.sites.reddit.overrideUntil = now + 10 * MIN;
  v = R.verdictFor(config, usage, reddit, now);
  eq(v.blocked, false, "a live grant lets you through");
  eq(v.reason, NS.REASON.SITE, "…without pretending the limit was never hit");
  eq(v.resumesAt, now + 10 * MIN, "…and the next thing to happen is the grant lapsing");

  // And it really does lapse.
  v = R.verdictFor(config, usage, reddit, now + 11 * MIN);
  eq(v.blocked, true, "the block returns when the grant expires");
}

{
  // The per-day cap, counted per site.
  const { config, usage } = fresh();
  const reddit = R.siteById(config, "reddit");
  usage.sites.reddit = { ms: 40 * MIN, overrides: 2, overrideUntil: 0 };
  const v = R.verdictFor(config, usage, reddit, now);
  eq(v.overridesLeft, 0, "both overrides spent");
  eq(v.canOverride, false, "…so none is offered");
}

{
  // Counted globally instead: spending them on X uses up Reddit's too.
  const { config, usage } = fresh();
  config.override.perSite = false;
  usage.overridesUsed = 2;
  const reddit = R.siteById(config, "reddit");
  usage.sites.reddit = { ms: 40 * MIN, overrides: 0, overrideUntil: 0 };
  eq(R.verdictFor(config, usage, reddit, now).overridesLeft, 0, "a global override budget is shared across sites");
}

{
  // forSchedule off: a time-of-day block is not negotiable.
  const { config, usage } = fresh();
  config.override.forSchedule = false;
  const reddit = R.siteById(config, "reddit");
  reddit.schedule = { mode: "blockDuring", windows: [work] };
  const v = R.verdictFor(config, usage, reddit, at(2026, 9, 21, 10, 0));
  eq(v.blocked, true, "scheduled block stands");
  eq(v.canOverride, false, "…and cannot be overridden when forSchedule is off");

  // …while a budget block still can be.
  config.override.forLimits = true;
  usage.sites.reddit = { ms: 99 * MIN, overrides: 0, overrideUntil: 0 };
  eq(R.verdictFor(config, usage, reddit, at(2026, 9, 21, 20, 0)).canOverride, true,
     "a budget block is still overridable");
}

{
  // Overrides switched off entirely.
  const { config, usage } = fresh();
  config.override.enabled = false;
  const reddit = R.siteById(config, "reddit");
  usage.sites.reddit = { ms: 99 * MIN, overrides: 0, overrideUntil: 0 };
  const v = R.verdictFor(config, usage, reddit, now);
  eq(v.canOverride, false, "no overrides when disabled");
  eq(v.overridesLeft, 0, "…and none reported as left");
}


// ---------- sessions and forced breaks ----------

{
  const config = CFG();
  const reddit = R.siteById(config, "reddit");
  eq(R.sessionRule(reddit), { workMs: 25 * MIN, breakMs: 5 * MIN }, "the shipped session rule is 25/5");

  reddit.session.enabled = false;
  eq(R.sessionRule(reddit), null, "a disabled session is no rule");
  reddit.session.enabled = true;
  reddit.session.workMinutes = 0;
  eq(R.sessionRule(reddit), null, "a zero-length stretch is no rule");
  reddit.session.workMinutes = 25;
  reddit.session.breakMinutes = 0;
  eq(R.sessionRule(reddit), null, "a zero-length break is no rule either");
}

function withSession(patch) {
  const config = CFG();
  const usage = R.emptyUsage(now, 4);
  usage.sites.reddit = {
    ms: 0, overrides: 0, overrideUntil: 0,
    sessionMs: 0, lastSeenAt: 0, breakUntil: 0, ...patch
  };
  return { config, usage, reddit: R.siteById(config, "reddit") };
}

{
  const { usage, reddit } = withSession({ sessionMs: 20 * MIN, lastSeenAt: now });
  eq(R.sessionRemainingMs(usage, reddit, now), 5 * MIN, "the stretch counts down");

  const fresh = withSession({});
  eq(R.sessionRemainingMs(fresh.usage, fresh.reddit, now), 25 * MIN, "a new stretch has the whole length");

  const onBreak = withSession({ sessionMs: 25 * MIN, breakUntil: now + 3 * MIN });
  eq(R.sessionRemainingMs(onBreak.usage, onBreak.reddit, now), 0, "zero while a break is being served");
  eq(R.sessionRemainingMs(onBreak.usage, onBreak.reddit, now + 4 * MIN), 25 * MIN,
     "a lapsed break reports a whole fresh stretch, before anything writes the reset back");

  const noRule = withSession({ sessionMs: 20 * MIN });
  noRule.reddit.session.enabled = false;
  eq(R.sessionRemainingMs(noRule.usage, noRule.reddit, now), null, "no rule, no countdown");
}

{
  // Taking the break yourself counts: the gap before the next stretch is
  // measured against the break length.
  const { usage, reddit } = withSession({ sessionMs: 20 * MIN, lastSeenAt: now });
  ok(!R.breakServedBy(usage, reddit, now + 4 * MIN), "four minutes away is not a five-minute break");
  ok(R.breakServedBy(usage, reddit, now + 5 * MIN), "five minutes away is");
  ok(R.breakServedBy(usage, reddit, now + 50 * MIN), "and so is an hour");

  const never = withSession({ sessionMs: 0, lastSeenAt: 0 });
  ok(!R.breakServedBy(never.usage, never.reddit, now), "a site never visited has served nothing");
}

{
  const { config, usage, reddit } = withSession({ ms: 5 * MIN, sessionMs: 25 * MIN, breakUntil: now + 5 * MIN });
  let v = R.verdictFor(config, usage, reddit, now);
  eq(v.blocked, true, "a stamped break blocks");
  eq(v.reason, NS.REASON.BREAK, "…for the break reason");
  eq(v.resumesAt, now + 5 * MIN, "…and resumes when the break is over, not at the daily reset");
  eq(v.breakUntil, now + 5 * MIN, "…and reports when that is");
  eq(v.canOverride, false, "forBreaks ships off, so a break cannot be bought out of");

  config.override.forBreaks = true;
  eq(R.verdictFor(config, usage, reddit, now).canOverride, true, "…unless you turn forBreaks on");

  v = R.verdictFor(config, usage, reddit, now + 6 * MIN);
  eq(v.blocked, false, "an elapsed break stops blocking on its own, with nothing clearing it");
}

{
  // Precedence: being out of minutes for the day is the longer wait and the
  // more useful thing to say, so it outranks a break.
  const { config, usage, reddit } = withSession({ ms: 99 * MIN, sessionMs: 25 * MIN, breakUntil: now + 5 * MIN });
  eq(R.verdictFor(config, usage, reddit, now).reason, NS.REASON.SITE, "a spent day outranks a break");

  const sched = withSession({ sessionMs: 25 * MIN, breakUntil: now + 5 * MIN });
  sched.reddit.schedule = { mode: "blockDuring", windows: [work] };
  eq(R.verdictFor(sched.config, sched.usage, sched.reddit, at(2026, 9, 21, 10, 0)).reason,
     NS.REASON.SCHEDULE, "a schedule outranks a break too");
}


// ---------- what an override does to the shared pool ----------
//
// Override minutes are real time on the site, so the site's own counter takes
// them. The pool must not, or overriding one site silently spends everyone
// else's budget.

{
  const u = (overrideUntil) => ({ sites: { reddit: { ms: 0, overrides: 0, overrideUntil } }, poolMs: 0 });

  eq(R.poolBillableMs(u(0), "reddit", 15000, now), 15000, "no grant: the pool takes the whole stretch");
  eq(R.poolBillableMs(u(now + 5 * MIN), "reddit", 15000, now), 0, "a live grant spares the pool entirely");
  eq(R.poolBillableMs(u(now - 5 * MIN), "reddit", 15000, now), 15000, "a long-expired grant spares nothing");

  // The grant lapsed 20s into a 60s stretch: the first 40s were covered, the
  // last 20s were not, and only those 20s reach the pool.
  eq(R.poolBillableMs(u(now - 20000), "reddit", 60000, now), 20000, "a grant lapsing mid-stretch is split correctly");

  // A grant that ends exactly as the stretch does covers all of it.
  eq(R.poolBillableMs(u(now), "reddit", 60000, now), 0, "a grant ending on the boundary still covers the stretch");

  eq(R.poolBillableMs(u(0), "instagram", 15000, now), 15000, "a grant on one site does not spare another");
}

// ---------- formatting ----------

eq(R.fmtDuration(0), "0s", "zero");
eq(R.fmtDuration(45 * 1000), "45s", "seconds");
eq(R.fmtDuration(5 * MIN + 7000), "5m 07s", "minutes and seconds");
eq(R.fmtDuration(65 * MIN), "1h 05m", "hours and minutes");

done("rules-test");
