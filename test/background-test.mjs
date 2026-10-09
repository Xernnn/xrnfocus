// Drives the real background service worker against a stubbed chrome.
// Everything here is behaviour you would otherwise only find out about by
// living with the extension for a day.
import { bootBackground } from "./chrome-stub.mjs";
import { ok, eq, done, at } from "./harness.mjs";

const MIN = 60000;
const T0 = at(2026, 9, 21, 12, 0);   // Monday noon

async function fixture(configPatch) {
  const bg = bootBackground({ now: T0 });
  // First message also guarantees boot()'s reconcile has settled, because
  // reconcile() serialises onto a single promise chain.
  await bg.send(bg.NS.MSG.GET_STATE, {});
  if (configPatch) {
    const st = await bg.send(bg.NS.MSG.GET_STATE, {});
    const config = st.config;
    configPatch(config);
    await bg.send(bg.NS.MSG.SET_CONFIG, { config });
  }
  return bg;
}

const MSGOF = (bg) => bg.NS.MSG;

// ---------- accrual ----------

{
  const bg = await fixture();
  const MSG = MSGOF(bg);
  bg.setTab("https://www.reddit.com/r/linux");

  let r = await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/r/linux" } });
  eq(r.tracked, true, "a reddit tab is tracked");
  eq(r.siteId, "reddit", "…as the reddit site");

  // Nothing is billed on the first tick — there is no earlier stretch yet.
  let st = await bg.send(MSG.GET_STATE, {});
  eq(st.usage.sites.reddit.ms, 0, "the opening tick bills nothing");

  bg.advance(15000);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/r/linux" } });
  st = await bg.send(MSG.GET_STATE, {});
  eq(st.usage.sites.reddit.ms, 15000, "15s of foreground reddit is billed as 15s");
  eq(st.usage.poolMs, 15000, "…and reddit is in the pool, so the pool moves too");

  // The suspend guard: a huge gap is truncated, not trusted.
  bg.advance(8 * 3600 * 1000);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/r/linux" } });
  st = await bg.send(MSG.GET_STATE, {});
  eq(st.usage.sites.reddit.ms, 15000 + bg.NS.MAX_ACCRUAL_MS,
     "an 8-hour clock jump is clamped to MAX_ACCRUAL_MS, not billed in full");
}

{
  // Out of the pool: YouTube must not spend anyone else's budget.
  const bg = await fixture();
  const MSG = MSGOF(bg);
  bg.setTab("https://www.youtube.com/watch?v=x");
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.youtube.com/watch?v=x" } });
  bg.advance(20000);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.youtube.com/watch?v=x" } });

  const st = await bg.send(MSG.GET_STATE, {});
  eq(st.usage.sites.youtube.ms, 20000, "youtube time is counted");
  eq(st.usage.poolMs, 0, "…but never lands in the shared pool");
}

{
  // The headline exemption.
  const bg = await fixture();
  const MSG = MSGOF(bg);
  bg.setTab("https://music.youtube.com/watch?v=x");
  const r = await bg.send(MSG.TICK, {}, { tab: { url: "https://music.youtube.com/watch?v=x" } });
  eq(r.tracked, false, "music.youtube.com is not tracked");
  bg.advance(60000);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://music.youtube.com/watch?v=x" } });
  const st = await bg.send(MSG.GET_STATE, {});
  eq(st.usage.sites.youtube, undefined, "…and a minute of it costs nothing (no counter is even created)");
}

{
  // Focus and idle both have to agree before the clock runs.
  const bg = await fixture();
  const MSG = MSGOF(bg);
  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/" } });

  bg.world.windowFocused = false;
  bg.advance(30000);
  await bg.send(MSG.GET_STATE, {});           // GET_STATE does not reconcile…
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/" } });
  let st = await bg.send(MSG.GET_STATE, {});
  eq(st.usage.sites.reddit.ms, 30000,
     "the stretch that ended when the window lost focus is still billed");

  bg.advance(30000);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/" } });
  st = await bg.send(MSG.GET_STATE, {});
  eq(st.usage.sites.reddit.ms, 30000, "…but an unfocused window accrues nothing further");
}

{
  // A long video: idle, but audible, so the clock keeps running.
  const bg = await fixture();
  const MSG = MSGOF(bg);
  bg.setTab("https://www.youtube.com/watch?v=long", { audible: true });
  await bg.setIdle("idle");
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.youtube.com/watch?v=long" } });
  bg.advance(60000);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.youtube.com/watch?v=long" } });
  let st = await bg.send(MSG.GET_STATE, {});
  eq(st.usage.sites.youtube.ms, 60000, "an idle but audible tab keeps counting");

  // Silence it and the same idle state now stops the clock.
  bg.world.tabs[0].audible = false;
  bg.advance(60000);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.youtube.com/watch?v=long" } });
  bg.advance(60000);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.youtube.com/watch?v=long" } });
  st = await bg.send(MSG.GET_STATE, {});
  eq(st.usage.sites.youtube.ms, 120000,
     "going silent while idle bills the stretch that just ended, then stops");
}

// ---------- blocking ----------

{
  const bg = await fixture((c) => {
    c.sites.find((s) => s.id === "reddit").limitMinutes = 1;
    c.pool.enabled = false;
  });
  const MSG = MSGOF(bg);
  bg.setTab("https://www.reddit.com/");

  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/" } });
  bg.advance(59000);
  let r = await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/" } });
  eq(r.blocked, false, "still inside a 1-minute cap at 59s");
  eq(r.remainingMs, 1000, "…with one second left");

  bg.advance(2000);
  r = await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/" } });
  eq(r.blocked, true, "past the cap, blocked");
  eq(r.reason, bg.NS.REASON.SITE, "…because of the site's own cap");
  ok(/block\/block\.html\?site=reddit/.test(r.blockUrl || ""), "…and pointed at the block page");

  const rules = bg.chrome.declarativeNetRequest.rules;
  eq(rules.length, 1, "one DNR rule is in place");
  eq(rules[0].condition.requestDomains, ["reddit.com", "redd.it"], "…covering reddit's domains");
  eq(rules[0].condition.resourceTypes, ["main_frame"], "…on top-level navigations only");

  ok(bg.calls.tabUpdates.some((u) => /block\.html/.test(u.url)),
     "the already-open reddit tab is bounced to the block page");
}

{
  // The DNR rule for YouTube must not swallow music.youtube.com with it.
  const bg = await fixture((c) => { c.sites.find((s) => s.id === "youtube").limitMinutes = 1; });
  const MSG = MSGOF(bg);
  bg.setTab("https://www.youtube.com/");
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.youtube.com/" } });
  bg.advance(61000);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.youtube.com/" } });

  const rule = bg.chrome.declarativeNetRequest.rules.find((r) =>
    (r.condition.requestDomains || []).includes("youtube.com"));
  ok(rule, "youtube has a DNR rule once it is blocked");
  eq(rule.condition.excludedRequestDomains, ["music.youtube.com"],
     "…and the rule carries the music exclusion at the network layer too");
}

{
  // A pool drained by one site blocks the others in it.
  const bg = await fixture((c) => {
    c.pool.minutes = 1;
    for (const s of c.sites) s.limitMinutes = 0;
  });
  const MSG = MSGOF(bg);
  bg.setTab("https://x.com/home");
  await bg.send(MSG.TICK, {}, { tab: { url: "https://x.com/home" } });
  bg.advance(61000);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://x.com/home" } });

  const st = await bg.send(MSG.GET_STATE, {});
  eq(st.verdicts.reddit.blocked, true, "reddit is blocked by a pool it never touched");
  eq(st.verdicts.reddit.reason, bg.NS.REASON.POOL, "…for the pool reason");
  eq(st.verdicts.youtube.blocked, false, "…while youtube, outside the pool, is untouched");
}

// ---------- schedules ----------

{
  const bg = await fixture((c) => {
    const r = c.sites.find((s) => s.id === "reddit");
    r.schedule = { mode: "blockDuring", windows: [{ days: [1], start: "09:00", end: "17:00" }] };
  });
  const MSG = MSGOF(bg);
  bg.setTab("https://www.reddit.com/");
  const r = await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/" } });
  eq(r.blocked, true, "Monday noon falls inside the blocked window");
  eq(r.reason, bg.NS.REASON.SCHEDULE, "…for the schedule reason");
}

// ---------- the override handshake ----------

async function blockedReddit(patch) {
  const bg = await fixture((c) => {
    c.sites.find((s) => s.id === "reddit").limitMinutes = 1;
    c.pool.enabled = false;
    if (patch) patch(c);
  });
  const MSG = MSGOF(bg);
  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/" } });
  bg.advance(61000);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/" } });
  return bg;
}

{
  const bg = await blockedReddit();
  const MSG = MSGOF(bg);

  let res = await bg.send(MSG.OVERRIDE_CLAIM, { siteId: "reddit", phrase: "I choose to keep scrolling" });
  eq(res.ok, false, "claiming without starting the wait fails");
  ok(/start the wait/.test(res.error), "…and says so");

  res = await bg.send(MSG.OVERRIDE_BEGIN, { siteId: "reddit" });
  eq(res.ok, true, "the wait starts");
  eq(res.readyAt, bg.clock.now + 45000, "…and is 45s long by default");

  res = await bg.send(MSG.OVERRIDE_CLAIM, { siteId: "reddit", phrase: "I choose to keep scrolling" });
  eq(res.ok, false, "claiming early fails even with the right phrase");

  bg.advance(46000);
  res = await bg.send(MSG.OVERRIDE_CLAIM, { siteId: "reddit", phrase: "nope" });
  eq(res.ok, false, "the wrong phrase fails after the wait");
  ok(/not the phrase/.test(res.error), "…and says which part was wrong");

  res = await bg.send(MSG.OVERRIDE_CLAIM, { siteId: "reddit", phrase: "  i CHOOSE to keep   scrolling " });
  eq(res.ok, true, "case and spacing are forgiven");
  eq(res.until, bg.clock.now + 10 * MIN, "…and the grant is 10 minutes");

  let st = await bg.send(MSG.GET_STATE, {});
  eq(st.verdicts.reddit.blocked, false, "the site is open again");
  eq(st.verdicts.reddit.reason, bg.NS.REASON.SITE, "…without forgetting why it was closed");
  eq(bg.chrome.declarativeNetRequest.rules.length, 0, "…and the DNR rule is withdrawn");

  bg.advance(11 * MIN);
  st = await bg.send(MSG.GET_STATE, {});
  eq(st.verdicts.reddit.blocked, true, "the grant lapses and the block returns");
}

{
  // The daily cap is enforced in the background, not in the page.
  const bg = await blockedReddit((c) => { c.override.maxPerDay = 1; c.override.delaySeconds = 0; });
  const MSG = MSGOF(bg);

  let res = await bg.send(MSG.OVERRIDE_CLAIM, { siteId: "reddit", phrase: "I choose to keep scrolling" });
  eq(res.ok, true, "the one allowed override is granted");

  await bg.send(MSG.END_OVERRIDE, { siteId: "reddit" });
  res = await bg.send(MSG.OVERRIDE_CLAIM, { siteId: "reddit", phrase: "I choose to keep scrolling" });
  eq(res.ok, false, "a second override the same day is refused");

  const st = await bg.send(MSG.GET_STATE, {});
  eq(st.verdicts.reddit.overridesLeft, 0, "…and the UI is told there are none left");
}

{
  // Ending an override early really does re-block.
  const bg = await blockedReddit((c) => { c.override.delaySeconds = 0; });
  const MSG = MSGOF(bg);
  await bg.send(MSG.OVERRIDE_CLAIM, { siteId: "reddit", phrase: "I choose to keep scrolling" });
  eq((await bg.send(MSG.GET_STATE, {})).verdicts.reddit.blocked, false, "open during the grant");
  await bg.send(MSG.END_OVERRIDE, { siteId: "reddit" });
  eq((await bg.send(MSG.GET_STATE, {})).verdicts.reddit.blocked, true, "closed again on demand");
}

{
  // forSchedule off makes a time-of-day block non-negotiable end to end.
  const bg = await fixture((c) => {
    c.override.forSchedule = false;
    c.sites.find((s) => s.id === "reddit").schedule =
      { mode: "blockDuring", windows: [{ days: [1], start: "09:00", end: "17:00" }] };
  });
  const MSG = MSGOF(bg);
  const res = await bg.send(MSG.OVERRIDE_BEGIN, { siteId: "reddit" });
  eq(res.ok, false, "you cannot even start the wait for a block that is not overridable");
}

{
  // An override is billed to the site, so the day's record stays honest —
  // but it must not drain the shared pool, or overriding Reddit quietly
  // costs you your Instagram time.
  const bg = await fixture((c) => {
    c.sites.find((s) => s.id === "reddit").limitMinutes = 1;
    c.pool.enabled = true;
    c.pool.minutes = 10;
    c.override.delaySeconds = 0;
    c.override.grantMinutes = 5;
    for (const s of c.sites) s.session.enabled = false;
  });
  const MSG = MSGOF(bg);
  const REDDIT = { tab: { url: "https://www.reddit.com/" } };

  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, REDDIT);
  bg.advance(61000);
  await bg.send(MSG.TICK, {}, REDDIT);
  const atBlock = await bg.send(MSG.GET_STATE, {});
  eq(atBlock.usage.poolMs, 61000, "up to the block, the pool tracks the site");

  await bg.send(MSG.OVERRIDE_CLAIM, { siteId: "reddit", phrase: "I choose to keep scrolling" });
  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, REDDIT);          // opens the stretch
  for (let i = 0; i < 3; i++) { bg.advance(60000); await bg.send(MSG.TICK, {}, REDDIT); }

  const during = await bg.send(MSG.GET_STATE, {});
  eq(during.usage.sites.reddit.ms, 61000 + 180000, "the site's own counter keeps an honest record");
  eq(during.usage.poolMs, 61000, "…while the shared pool is held for the whole grant");
  eq(during.verdicts.instagram.blocked, false, "…so another pooled site is untouched by the override");

  // The grant runs out at +5min, and the limit that was there all along
  // takes over again immediately.
  bg.advance(60000); await bg.send(MSG.TICK, {}, REDDIT);   // +4min
  bg.advance(60000); await bg.send(MSG.TICK, {}, REDDIT);   // +5min, grant lapses
  const after = await bg.send(MSG.GET_STATE, {});
  eq(after.verdicts.reddit.blocked, true, "when the grant lapses the block comes straight back");
  eq(after.usage.poolMs, 61000, "…and the pool never moved for the whole override");
  ok(after.usage.sites.reddit.ms > after.usage.poolMs,
     "…so the site's record is ahead of the pool by exactly the time it was spared");

  // …and from there everything freezes again.
  const frozen = after.usage.sites.reddit.ms;
  bg.setTab("https://www.reddit.com/");
  for (let i = 0; i < 3; i++) { bg.advance(60000); await bg.send(MSG.TICK, {}, REDDIT); }
  const later = await bg.send(MSG.GET_STATE, {});
  eq(later.usage.sites.reddit.ms, frozen, "…the site counter freezes once the override is spent");
  eq(later.usage.poolMs, 61000, "…and so does the pool");
}

{
  // The other half of "freeze when blocked": once a site IS blocked, nothing
  // accrues, even if a tab somehow stays on it.
  const bg = await fixture((c) => {
    c.sites.find((s) => s.id === "reddit").limitMinutes = 1;
    c.pool.enabled = false;
    for (const s of c.sites) s.session.enabled = false;
  });
  const MSG = MSGOF(bg);
  const REDDIT = { tab: { url: "https://www.reddit.com/" } };
  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, REDDIT);
  bg.advance(61000);
  await bg.send(MSG.TICK, {}, REDDIT);
  const frozenAt = (await bg.send(MSG.GET_STATE, {})).usage.sites.reddit.ms;

  // Force the tab back onto the blocked site and keep ticking at it.
  bg.setTab("https://www.reddit.com/");
  for (let i = 0; i < 4; i++) { bg.advance(30000); await bg.send(MSG.TICK, {}, REDDIT); }
  eq((await bg.send(MSG.GET_STATE, {})).usage.sites.reddit.ms, frozenAt,
     "a blocked site accrues nothing, even with a tab still sitting on it");

  // And nothing accrues while the block page is what's open.
  bg.setTab("chrome-extension://x/block/block.html?site=reddit");
  for (let i = 0; i < 3; i++) { bg.advance(60000); await bg.fireAlarm(); }
  eq((await bg.send(MSG.GET_STATE, {})).usage.sites.reddit.ms, frozenAt,
     "…nor while you sit on the block page");
}

// ---------- the day rolls over ----------

{
  const bg = await fixture();
  const MSG = MSGOF(bg);
  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/" } });
  bg.advance(30000);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/" } });
  eq((await bg.send(MSG.GET_STATE, {})).usage.sites.reddit.ms, 30000, "time on the books");

  // Past 04:00 the next morning.
  bg.clock.now = at(2026, 9, 22, 4, 30);
  await bg.send(MSG.TICK, {}, { tab: { url: "https://www.reddit.com/" } });
  const st = await bg.send(MSG.GET_STATE, {});
  eq(st.usage.sites.reddit.ms, 0, "the new day starts clean");
  eq(st.usage.poolMs, 0, "…pool included");
}

// ---------- forced breaks, end to end ----------

// One-minute stretches and one-minute breaks, with the daily budgets taken
// out of the way so a break is the only thing that can block.
async function breakFixture(patch) {
  return fixture((c) => {
    for (const s of c.sites) {
      s.session = { enabled: true, workMinutes: 1, breakMinutes: 1 };
      s.limitMinutes = 0;
    }
    c.pool.enabled = false;
    if (patch) patch(c);
  });
}

{
  const bg = await breakFixture();
  const MSG = MSGOF(bg);
  const REDDIT = { tab: { url: "https://www.reddit.com/" } };
  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, REDDIT);

  bg.advance(30000);
  let r = await bg.send(MSG.TICK, {}, REDDIT);
  eq(r.blocked, false, "half way through a one-minute stretch");
  eq(r.sessionRemainingMs, 30000, "…with 30s of it left");

  bg.advance(31000);
  r = await bg.send(MSG.TICK, {}, REDDIT);
  eq(r.blocked, true, "the stretch runs out and a break is forced");
  eq(r.reason, bg.NS.REASON.BREAK, "…for the break reason");
  eq(bg.chrome.declarativeNetRequest.rules.length, 1, "…with a network rule behind it");
  ok(bg.calls.tabUpdates.some((u) => /block\.html/.test(u.url)), "…and the open tab is bounced");

  const spentAtBreak = (await bg.send(MSG.GET_STATE, {})).usage.sites.reddit.ms;

  // The tab now sits on the block page. Nothing should accrue while it does,
  // and the alarm is the only thing reconciling with no content script left.
  bg.advance(61000);
  await bg.fireAlarm();
  let st = await bg.send(MSG.GET_STATE, {});
  eq(st.usage.sites.reddit.ms, spentAtBreak, "serving the break costs no daily time");
  eq(st.verdicts.reddit.blocked, false, "the break ends on its own");
  eq(bg.chrome.declarativeNetRequest.rules.length, 0, "…and the network rule is withdrawn");

  // Back on the site, the stretch starts from scratch.
  bg.setTab("https://www.reddit.com/");
  r = await bg.send(MSG.TICK, {}, REDDIT);
  eq(r.sessionRemainingMs, 60000, "the next stretch is a whole one");
  bg.advance(10000);
  r = await bg.send(MSG.TICK, {}, REDDIT);
  eq(r.sessionRemainingMs, 50000, "…and counts down from there");
  st = await bg.send(MSG.GET_STATE, {});
  eq(st.usage.sites.reddit.sessionMs, 10000, "the session counter really did reset");
}

{
  // Walking away for a whole break clears the stretch without ever being
  // blocked — taking the break yourself has to count, or the rule punishes
  // exactly the behaviour it is asking for.
  const bg = await breakFixture();
  const MSG = MSGOF(bg);
  const REDDIT = { tab: { url: "https://www.reddit.com/" } };
  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, REDDIT);
  bg.advance(40000);
  await bg.send(MSG.TICK, {}, REDDIT);
  eq((await bg.send(MSG.GET_STATE, {})).usage.sites.reddit.sessionMs, 40000, "40s into the stretch");

  // Away: another tab, for longer than the break.
  bg.setTab("https://example.com/");
  await bg.send(MSG.TICK, {}, { tab: { url: "https://example.com/" } });
  bg.advance(70000);
  await bg.fireAlarm();

  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, REDDIT);
  bg.advance(5000);
  const r = await bg.send(MSG.TICK, {}, REDDIT);
  eq(r.blocked, false, "never blocked — the break was taken voluntarily");
  eq((await bg.send(MSG.GET_STATE, {})).usage.sites.reddit.sessionMs, 5000,
     "the stretch restarted rather than resuming at 40s");
}

{
  // A gap SHORTER than the break does not reset anything.
  const bg = await breakFixture();
  const MSG = MSGOF(bg);
  const REDDIT = { tab: { url: "https://www.reddit.com/" } };
  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, REDDIT);
  bg.advance(40000);
  await bg.send(MSG.TICK, {}, REDDIT);

  bg.setTab("https://example.com/");
  await bg.send(MSG.TICK, {}, { tab: { url: "https://example.com/" } });
  bg.advance(20000);                       // only 20s away, break is 60s
  await bg.fireAlarm();

  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, REDDIT);
  bg.advance(25000);
  const r = await bg.send(MSG.TICK, {}, REDDIT);
  eq(r.blocked, true, "40s + 25s crosses the one-minute stretch; a short gap did not reset it");
  eq(r.reason, bg.NS.REASON.BREAK, "…for the break reason");
}

{
  // Session off: a long sitting is fine.
  const bg = await breakFixture((c) => {
    c.sites.find((s) => s.id === "reddit").session.enabled = false;
  });
  const MSG = MSGOF(bg);
  const REDDIT = { tab: { url: "https://www.reddit.com/" } };
  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, REDDIT);
  for (let i = 0; i < 5; i++) { bg.advance(60000); await bg.send(MSG.TICK, {}, REDDIT); }
  const r = await bg.send(MSG.TICK, {}, REDDIT);
  eq(r.blocked, false, "five minutes straight, with the session rule off");
  eq(r.sessionRemainingMs, null, "…and no stretch countdown is reported");
}

{
  // A break cannot be bought out of by default; turning forBreaks on changes it.
  const bg = await breakFixture();
  const MSG = MSGOF(bg);
  const REDDIT = { tab: { url: "https://www.reddit.com/" } };
  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, REDDIT);
  bg.advance(61000);
  await bg.send(MSG.TICK, {}, REDDIT);

  let res = await bg.send(MSG.OVERRIDE_BEGIN, { siteId: "reddit" });
  eq(res.ok, false, "a forced break is not overridable out of the box");

  const st = await bg.send(MSG.GET_STATE, {});
  const config = st.config;
  config.override.forBreaks = true;
  config.override.delaySeconds = 0;
  await bg.send(MSG.SET_CONFIG, { config });

  res = await bg.send(MSG.OVERRIDE_CLAIM, { siteId: "reddit", phrase: "I choose to keep scrolling" });
  eq(res.ok, true, "…but it is once forBreaks is on");
  eq((await bg.send(MSG.GET_STATE, {})).verdicts.reddit.blocked, false, "and the break is lifted");
}

{
  // The daily budget still wins: out of minutes reads better than "take five".
  const bg = await breakFixture((c) => {
    c.sites.find((s) => s.id === "reddit").limitMinutes = 1;
  });
  const MSG = MSGOF(bg);
  const REDDIT = { tab: { url: "https://www.reddit.com/" } };
  bg.setTab("https://www.reddit.com/");
  await bg.send(MSG.TICK, {}, REDDIT);
  bg.advance(61000);
  const r = await bg.send(MSG.TICK, {}, REDDIT);
  eq(r.blocked, true, "both the stretch and the day ran out at once");
  eq(r.reason, bg.NS.REASON.SITE, "…and the day is what gets reported");
}

// ---------- config merge ----------

{
  // An edited config must survive a version that adds a field, and a config
  // missing a whole site must gain it rather than lose the site.
  const bg = await fixture();
  const MSG = MSGOF(bg);
  await bg.send(MSG.SET_CONFIG, {
    config: { version: 1, sites: [{ id: "reddit", limitMinutes: 7, enabled: true, domains: ["reddit.com"] }] }
  });
  const st = await bg.send(MSG.GET_STATE, {});
  const reddit = st.config.sites.find((s) => s.id === "reddit");
  eq(reddit.limitMinutes, 7, "an edited value is kept");
  eq(reddit.inPool, true, "…and missing fields are filled from the built-in");
  ok(st.config.sites.some((s) => s.id === "youtube"), "a site absent from the stored config is restored");
  eq(st.config.override.phrase, bg.NS.DEFAULT_CONFIG.override.phrase, "a missing section falls back to defaults");
}

done("background-test");
