// The single source of truth for "is this site blocked right now, and why".
//
// Pure: no DOM, no chrome.*, no clock of its own — every entry point takes
// `now` as a number. That is what lets the background, the content script, the
// popup, the block page and the test suite all ask the same question and get
// the same answer, and it is why the whole file can be unit-tested in plain
// Node with no browser at all.
self.XrnFocus = self.XrnFocus || {};

(function (NS) {
  const MINUTE = 60000;

  // ---------- host matching ----------

  function normalizeHost(host) {
    if (!host) return "";
    return String(host).trim().toLowerCase().replace(/^\.+/, "").replace(/\.+$/, "");
  }

  // A pattern matches its own host and any subdomain of it, and nothing else.
  // "reddit.com" covers old.reddit.com and www.reddit.com but must not cover
  // notreddit.com — hence the explicit dot rather than a bare endsWith.
  function hostMatches(host, pattern) {
    const h = normalizeHost(host);
    const p = normalizeHost(pattern);
    if (!h || !p) return false;
    return h === p || h.endsWith("." + p);
  }

  function hostMatchesAny(host, patterns) {
    return (patterns || []).some((p) => hostMatches(host, p));
  }

  function hostOf(url) {
    try {
      const u = new URL(url);
      // Only ever track real web pages. Skipping this lets the extension's own
      // block page — which is served from chrome-extension:// — be mistaken
      // for the site it is blocking, and bill time for sitting on it.
      if (u.protocol !== "http:" && u.protocol !== "https:") return "";
      return normalizeHost(u.hostname);
    } catch (_) {
      return "";
    }
  }

  // The site this URL belongs to, or null. An exclusion always wins: a site
  // whose exclude list matches is treated as if the extension had never heard
  // of it, which is exactly what "YouTube except music" needs.
  function siteForUrl(config, url) {
    const host = hostOf(url);
    if (!host) return null;
    for (const site of config.sites || []) {
      if (!site.enabled) continue;
      if (!hostMatchesAny(host, site.domains)) continue;
      if (hostMatchesAny(host, site.exclude)) return null;
      return site;
    }
    return null;
  }

  function siteById(config, id) {
    return (config.sites || []).find((s) => s.id === id) || null;
  }

  // ---------- the day boundary ----------

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  // The key today's counters are filed under. Shifting the clock back by
  // resetHour before reading the date is what makes "the day" run 04:00->04:00
  // instead of midnight->midnight, so a 01:00 session lands on the day it
  // feels like rather than the day the calendar says.
  function dayKeyFor(now, resetHour) {
    const d = new Date(now);
    d.setHours(d.getHours() - (resetHour || 0));
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function nextResetAt(now, resetHour) {
    const d = new Date(now);
    d.setHours(resetHour || 0, 0, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // ---------- schedules ----------

  function parseHM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function minutesOfDay(date) {
    return date.getHours() * 60 + date.getMinutes();
  }

  // Is `date` inside this window? A window whose end is at or before its start
  // wraps past midnight (22:00->06:00), and in that case it belongs to the day
  // it STARTS on — so a Friday-night window still covers 02:00 on Saturday,
  // which is the only reading that matches how anyone describes their evening.
  function windowActive(win, date) {
    const start = parseHM(win.start);
    const end = parseHM(win.end);
    if (start === null || end === null) return false;
    const days = win.days && win.days.length ? win.days : [0, 1, 2, 3, 4, 5, 6];
    const dow = date.getDay();
    const mins = minutesOfDay(date);

    if (start === end) return false;
    if (start < end) return days.includes(dow) && mins >= start && mins < end;

    // Overnight.
    if (mins >= start) return days.includes(dow);
    return days.includes((dow + 6) % 7) && mins < end;
  }

  // When the currently-active window lets go. Only meaningful if
  // windowActive() is true for the same inputs.
  function windowEndsAt(win, date) {
    const end = parseHM(win.end);
    if (end === null) return null;
    const d = new Date(date.getTime());
    d.setHours(Math.floor(end / 60), end % 60, 0, 0);
    if (d.getTime() <= date.getTime()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  // The next moment this window starts, searched over the coming week.
  function windowStartsAt(win, date) {
    const start = parseHM(win.start);
    if (start === null) return null;
    const days = win.days && win.days.length ? win.days : [0, 1, 2, 3, 4, 5, 6];
    for (let i = 0; i <= 7; i++) {
      const d = new Date(date.getTime());
      d.setDate(d.getDate() + i);
      d.setHours(Math.floor(start / 60), start % 60, 0, 0);
      if (d.getTime() > date.getTime() && days.includes(d.getDay())) return d.getTime();
    }
    return null;
  }

  // "blockDuring": the windows are the forbidden hours.
  // "allowOnly":   the windows are the ONLY permitted hours, so the site is
  //                blocked whenever none of them is active.
  // Returns { blocked, resumesAt } where resumesAt is when it next opens up.
  function scheduleVerdict(schedule, now) {
    const s = schedule || { mode: "off", windows: [] };
    const windows = s.windows || [];
    if (s.mode === "off" || !windows.length) return { blocked: false, resumesAt: null };
    const date = new Date(now);

    if (s.mode === "blockDuring") {
      const active = windows.filter((w) => windowActive(w, date));
      if (!active.length) return { blocked: false, resumesAt: null };
      // Overlapping windows: you are free at the LAST of their ends.
      const ends = active.map((w) => windowEndsAt(w, date)).filter((t) => t !== null);
      return { blocked: true, resumesAt: ends.length ? Math.max(...ends) : null };
    }

    if (s.mode === "allowOnly") {
      if (windows.some((w) => windowActive(w, date))) return { blocked: false, resumesAt: null };
      const starts = windows.map((w) => windowStartsAt(w, date)).filter((t) => t !== null);
      return { blocked: true, resumesAt: starts.length ? Math.min(...starts) : null };
    }

    return { blocked: false, resumesAt: null };
  }

  // ---------- usage ----------

  function emptyUsage(now, resetHour) {
    return { dayKey: dayKeyFor(now, resetHour), sites: {}, poolMs: 0, overridesUsed: 0 };
  }

  function siteUsage(usage, siteId) {
    const u = (usage && usage.sites && usage.sites[siteId]) || null;
    return {
      ms: (u && u.ms) || 0,
      overrides: (u && u.overrides) || 0,
      overrideUntil: (u && u.overrideUntil) || 0,
      // Session state. sessionMs is time in the CURRENT stretch, not the day:
      // it resets after a break, taken or served. lastSeenAt is the last
      // moment time was billed here, which is how "you have already been
      // away long enough" gets decided without a timer.
      sessionMs: (u && u.sessionMs) || 0,
      lastSeenAt: (u && u.lastSeenAt) || 0,
      breakUntil: (u && u.breakUntil) || 0
    };
  }

  // The per-site session rule, or null when the site has none.
  function sessionRule(site) {
    const r = site && site.session;
    if (!r || !r.enabled) return null;
    const work = Number(r.workMinutes) || 0;
    const rest = Number(r.breakMinutes) || 0;
    if (work <= 0 || rest <= 0) return null;
    return { workMs: work * MINUTE, breakMs: rest * MINUTE };
  }

  // Milliseconds of this stretch left before a break is forced. `null` when
  // the site has no session rule; 0 while a break is actually being served.
  function sessionRemainingMs(usage, site, now) {
    const rule = sessionRule(site);
    if (!rule) return null;
    const su = siteUsage(usage, site.id);
    if (su.breakUntil > now) return 0;
    // A break that has already elapsed has cleared the stretch even though
    // nothing has written that back yet — the reset happens on the next
    // accrual. Until then this must not report a stretch that is still spent,
    // or the corner clock reads "0:00 to break" on a site you just got back.
    if (su.breakUntil) return rule.workMs;
    return Math.max(0, rule.workMs - su.sessionMs);
  }

  // Has enough time passed since this site was last used to count as having
  // taken the break voluntarily? Used by the background when it opens a new
  // stretch, so stepping away of your own accord clears the counter.
  function breakServedBy(usage, site, at) {
    const rule = sessionRule(site);
    if (!rule) return false;
    const su = siteUsage(usage, site.id);
    if (!su.lastSeenAt) return false;
    return at - su.lastSeenAt >= rule.breakMs;
  }

  // Counters are stamped with the day they belong to rather than cleared by a
  // timer, so a browser that was asleep across the reset hour still starts
  // clean on wake instead of resuming yesterday's total.
  function rolledOver(usage, now, resetHour) {
    if (!usage || usage.dayKey !== dayKeyFor(now, resetHour)) return emptyUsage(now, resetHour);
    return usage;
  }

  // ---------- the verdict ----------

  function overrideActive(usage, siteId, now) {
    return siteUsage(usage, siteId).overrideUntil > now;
  }

  // How much of a billed stretch may be charged to the SHARED pool.
  //
  // Time bought with an override is real time on the site, so the site's own
  // counter takes all of it — the day's record stays honest. The pool does
  // not, because draining it would mean overriding Reddit quietly spends the
  // budget of every other site in the pool, which is a cost you never agreed
  // to and cannot see coming.
  //
  // Handles a grant that lapses mid-stretch: only the covered part is spared.
  function poolBillableMs(usage, siteId, billedMs, now) {
    const grantEnd = siteUsage(usage, siteId).overrideUntil || 0;
    if (!grantEnd) return billedMs;
    const windowStart = now - billedMs;
    const covered = Math.max(0, Math.min(now, grantEnd) - windowStart);
    return Math.max(0, billedMs - covered);
  }

  function overridesLeft(config, usage, siteId) {
    const o = config.override || {};
    if (!o.enabled) return 0;
    const max = Number(o.maxPerDay) || 0;
    const used = o.perSite ? siteUsage(usage, siteId).overrides : (usage.overridesUsed || 0);
    return Math.max(0, max - used);
  }

  function overrideCovers(config, reason) {
    const o = config.override || {};
    if (!o.enabled) return false;
    if (reason === NS.REASON.SCHEDULE) return !!o.forSchedule;
    if (reason === NS.REASON.BREAK) return !!o.forBreaks;
    return !!o.forLimits;
  }

  // Milliseconds of allowance left, as the minimum of this site's own budget
  // and the shared pool. `null` means "nothing is metering this" — an
  // uncapped site that is out of the pool has no countdown at all.
  function remainingMs(config, usage, site, now) {
    const limits = [];
    const own = Number(site.limitMinutes) || 0;
    if (own > 0) limits.push(own * MINUTE - siteUsage(usage, site.id).ms);
    const pool = config.pool || {};
    if (pool.enabled && site.inPool && Number(pool.minutes) > 0) {
      limits.push(Number(pool.minutes) * MINUTE - (usage.poolMs || 0));
    }
    if (!limits.length) return null;
    return Math.min(...limits);
  }

  // THE verdict. Everything that blocks anything comes through here.
  //
  // Precedence matters and is deliberate: an active override grant beats every
  // reason, and among reasons a schedule beats a spent budget — being told
  // "you're in work hours" is more useful than "you're out of minutes" when
  // both are true, and it has the later resumesAt anyway.
  function verdictFor(config, usage, site, now) {
    const base = {
      siteId: site ? site.id : null,
      blocked: false,
      reason: null,
      resumesAt: null,
      overrideUntil: 0,
      usedMs: 0,
      remainingMs: null,
      sessionRemainingMs: null,
      breakUntil: 0,
      canOverride: false,
      overridesLeft: 0
    };
    if (!site || !site.enabled) return base;

    const su = siteUsage(usage, site.id);
    base.usedMs = su.ms;
    base.remainingMs = remainingMs(config, usage, site, now);
    base.sessionRemainingMs = sessionRemainingMs(usage, site, now);
    base.breakUntil = su.breakUntil;

    let reason = null;
    let resumesAt = null;

    const sched = scheduleVerdict(site.schedule, now);
    if (sched.blocked) {
      reason = NS.REASON.SCHEDULE;
      resumesAt = sched.resumesAt;
    } else {
      const own = Number(site.limitMinutes) || 0;
      const pool = config.pool || {};
      const poolCap = Number(pool.minutes) || 0;
      if (own > 0 && su.ms >= own * MINUTE) {
        reason = NS.REASON.SITE;
        resumesAt = nextResetAt(now, config.resetHour);
      } else if (pool.enabled && site.inPool && poolCap > 0 && (usage.poolMs || 0) >= poolCap * MINUTE) {
        reason = NS.REASON.POOL;
        resumesAt = nextResetAt(now, config.resetHour);
      } else if (su.breakUntil > now) {
        reason = NS.REASON.BREAK;
        resumesAt = su.breakUntil;
      }
    }

    if (!reason) return base;

    base.reason = reason;
    base.resumesAt = resumesAt;
    base.overridesLeft = overridesLeft(config, usage, site.id);
    base.canOverride = overrideCovers(config, reason) && base.overridesLeft > 0;

    // A live grant suppresses the block but leaves `reason` in place, so the
    // UI can say "10 minutes, on override" rather than pretending the limit
    // was never reached — and so the block returns the instant it lapses.
    if (su.overrideUntil > now) {
      base.overrideUntil = su.overrideUntil;
      base.blocked = false;
      // The soonest thing that will matter is the grant running out.
      base.resumesAt = su.overrideUntil;
      return base;
    }

    base.blocked = true;
    return base;
  }

  // ---------- the browsing record ----------
  //
  // Storage keeps the full hostname (minus a leading "www."), because that is
  // the one thing we know for certain. Grouping subdomains together is a
  // guess, so it happens at DISPLAY time only — a wrong guess then misreads a
  // chart, where a wrong guess at write time would corrupt the record for
  // good.

  // Second-level labels that are really part of the suffix, so the
  // registrable name is three labels deep: bbc.co.uk, not co.uk.
  const SECOND_LEVEL = new Set(["co", "com", "net", "org", "ac", "gov", "edu", "or", "ne", "gouv", "mil"]);
  // Hosting suffixes where each subdomain is a different owner, so grouping
  // them all under one name would be actively wrong.
  const MULTI_TENANT = new Set([
    "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app",
    "netlify.app", "herokuapp.com", "web.app", "firebaseapp.com",
    "blogspot.com", "wordpress.com", "tumblr.com", "myshopify.com",
    "s3.amazonaws.com", "notion.site", "substack.com"
  ]);

  // A hostname reduced to the name a person would recognise. A heuristic, not
  // a public-suffix lookup: it handles the common shapes and errs toward
  // showing MORE detail rather than merging two unrelated sites.
  function registrableDomain(host) {
    const h = normalizeHost(host).replace(/^www\./, "");
    if (!h || !h.includes(".")) return h;

    const parts = h.split(".");
    for (let take = 2; take <= 3 && take < parts.length; take++) {
      if (MULTI_TENANT.has(parts.slice(-take).join("."))) return parts.slice(-(take + 1)).join(".");
    }
    if (parts.length <= 2) return h;

    const tld = parts[parts.length - 1];
    const sld = parts[parts.length - 2];
    if (tld.length <= 3 && SECOND_LEVEL.has(sld) && parts.length >= 3) {
      return parts.slice(-3).join(".");
    }
    return parts.slice(-2).join(".");
  }

  // The hostname as it is stored: lower-cased, no leading "www.", so
  // www.example.com and example.com are one row rather than two.
  function trackingKeyFor(url) {
    const host = hostOf(url);
    return host ? host.replace(/^www\./, "") : "";
  }

  function dateFromDayKey(key) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key || ""));
    if (!m) return null;
    // Built from parts, not parsed: `new Date("2026-09-21")` is UTC midnight,
    // which lands on the wrong weekday for anyone west of Greenwich.
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  // Every day key from `back` days ago up to today, oldest first, including
  // the days with nothing on them — a trend chart needs its gaps.
  function dayKeyRange(now, resetHour, back) {
    const keys = [];
    for (let i = back - 1; i >= 0; i--) keys.push(dayKeyFor(now - i * 86400000, resetHour));
    return keys;
  }

  // Fold a set of per-day records into everything the dashboard draws.
  // `records` is { dayKey: { hosts, hours, total } }; `keys` is the ordered
  // range to report over, so absent days show as zero rather than vanishing.
  function summarizeHistory(records, keys, opts) {
    const group = (opts && opts.group) === "host" ? (h) => h : registrableDomain;
    const byHostMap = new Map();
    const byDay = [];
    const hours = new Array(24).fill(0);
    const weekHours = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let totalMs = 0;
    let activeDays = 0;

    for (const key of keys) {
      const rec = records[key];
      const dayMs = (rec && rec.total) || 0;
      byDay.push({ dayKey: key, ms: dayMs });
      if (!rec) continue;
      totalMs += dayMs;
      if (dayMs > 0) activeDays++;

      for (const [host, ms] of Object.entries(rec.hosts || {})) {
        const k = group(host);
        byHostMap.set(k, (byHostMap.get(k) || 0) + ms);
      }
      const dow = (dateFromDayKey(key) || new Date()).getDay();
      (rec.hours || []).forEach((ms, h) => {
        if (!ms) return;
        hours[h] += ms;
        weekHours[dow][h] += ms;
      });
    }

    const byHost = [...byHostMap.entries()]
      .map(([host, ms]) => ({ host, ms }))
      .sort((a, b) => b.ms - a.ms || a.host.localeCompare(b.host));

    const busiest = byDay.reduce((best, d) => (d.ms > (best ? best.ms : 0) ? d : best), null);

    return {
      totalMs, byHost, byDay, hours, weekHours,
      siteCount: byHost.length,
      activeDays,
      dailyAverageMs: activeDays ? Math.round(totalMs / activeDays) : 0,
      busiest: busiest && busiest.ms > 0 ? busiest : null
    };
  }

  // Fold everything past the top `n` into a single "other" row, because a
  // chart with forty bars is a table wearing a costume.
  function topWithOther(byHost, n) {
    if (byHost.length <= n) return { rows: byHost.slice(), other: null };
    const rows = byHost.slice(0, n);
    const restMs = byHost.slice(n).reduce((a, x) => a + x.ms, 0);
    return { rows, other: { host: "other", ms: restMs, count: byHost.length - n } };
  }

  // ---------- formatting (shared by popup, options and the block page) ----------

  function fmtDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h) return `${h}h ${pad2(m)}m`;
    if (m) return `${m}m ${pad2(s)}s`;
    return `${s}s`;
  }

  function fmtClock(ts) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  NS.rules = {
    MINUTE,
    normalizeHost, hostMatches, hostMatchesAny, hostOf,
    siteForUrl, siteById,
    dayKeyFor, nextResetAt,
    parseHM, minutesOfDay, windowActive, windowEndsAt, windowStartsAt, scheduleVerdict,
    emptyUsage, siteUsage, rolledOver,
    sessionRule, sessionRemainingMs, breakServedBy,
    overrideActive, overridesLeft, overrideCovers, poolBillableMs, remainingMs, verdictFor,
    registrableDomain, trackingKeyFor, dateFromDayKey, dayKeyRange, summarizeHistory, topWithOther,
    fmtDuration, fmtClock, pad2
  };
})(self.XrnFocus);
