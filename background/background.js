// Chrome runs this file as an MV3 service worker, where importScripts() exists.
// Firefox runs it as a classic background script listed in manifest
// background.scripts, where importScripts() is undefined and constants.js +
// rules.js are loaded as earlier entries in that same list instead.
if (typeof importScripts === "function") {
  importScripts("../shared/constants.js", "../shared/rules.js");
}

const NS = self.XrnFocus;
const { MSG, STORAGE, REASON, DEFAULT_CONFIG, HEARTBEAT_MS, MAX_ACCRUAL_MS, ALARM_NAME, ALARM_PERIOD_MINUTES, DNR_RULE_BASE, BLOCK_PAGE } = NS;
const R = NS.rules;

// ---------- storage ----------
//
// This file is the only writer. Every other context asks for a change by
// message and gets the resulting state back, which is what keeps two popups
// and three tabs from clobbering each other's counters.

async function getConfig() {
  const got = await chrome.storage.sync.get(STORAGE.CONFIG);
  return mergeConfig(got[STORAGE.CONFIG]);
}

// A stored config is merged onto the defaults rather than used as-is, so a
// config written by an older version keeps working when a new field appears.
// Sites are merged per-id: your edited limits survive, and a built-in site
// added in a later version shows up instead of being silently missing.
function mergeConfig(stored) {
  const base = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  if (!stored || typeof stored !== "object") return base;

  const out = {
    ...base,
    ...stored,
    pool: { ...base.pool, ...(stored.pool || {}) },
    override: { ...base.override, ...(stored.override || {}) },
    clock: { ...base.clock, ...(stored.clock || {}) },
    tracking: { ...base.tracking, ...(stored.tracking || {}) },
    warnAtMinutes: Array.isArray(stored.warnAtMinutes) ? stored.warnAtMinutes : base.warnAtMinutes,
    sites: []
  };

  const storedSites = Array.isArray(stored.sites) ? stored.sites : [];
  const seen = new Set();
  for (const s of storedSites) {
    if (!s || !s.id || seen.has(s.id)) continue;
    seen.add(s.id);
    const builtin = base.sites.find((b) => b.id === s.id);
    // `schedule` and `session` are merged a level deeper than the rest: a
    // spread would let a stored `{ enabled: false }` wipe workMinutes and
    // breakMinutes, silently turning the rule off rather than pausing it.
    out.sites.push({
      ...(builtin || {}),
      ...s,
      schedule: { mode: "off", windows: [], ...(s.schedule || {}) },
      session: {
        enabled: false, workMinutes: 25, breakMinutes: 5,
        ...((builtin || {}).session || {}),
        ...(s.session || {})
      }
    });
  }
  for (const b of base.sites) if (!seen.has(b.id)) out.sites.push(b);
  return out;
}

async function setConfig(config) {
  await chrome.storage.sync.set({ [STORAGE.CONFIG]: config });
  return config;
}

async function getUsageRaw() {
  const got = await chrome.storage.local.get(STORAGE.USAGE);
  return got[STORAGE.USAGE] || null;
}

async function setUsage(usage) {
  await chrome.storage.local.set({ [STORAGE.USAGE]: usage });
}

async function getSession() {
  const got = await chrome.storage.local.get(STORAGE.SESSION);
  return got[STORAGE.SESSION] || null;
}

async function setSession(session) {
  if (session) await chrome.storage.local.set({ [STORAGE.SESSION]: session });
  else await chrome.storage.local.remove(STORAGE.SESSION);
}

// ---------- the browsing record ----------
//
// A local log of where the time went, across every site. Stored one key per
// day (`bs_day_2026-09-21`) so a tick rewrites only today and the archive is
// never touched however long it grows. chrome.storage.local, never sync:
// this is the most sensitive thing the extension holds and it has no business
// leaving the machine.
//
// It is off until you turn it on, and it cannot work without permission to
// read every tab's URL — which is asked for at that moment, not at install.

let trackingGranted = null;   // null = not checked yet
let dayIndexCache = null;

async function refreshTrackingGrant() {
  try {
    trackingGranted = await chrome.permissions.contains({ origins: NS.TRACK_ORIGINS });
  } catch (_) {
    trackingGranted = false;
  }
  return trackingGranted;
}

function trackingOn(config) {
  return !!(config.tracking && config.tracking.enabled) && trackingGranted === true;
}

async function getDayIndex() {
  if (dayIndexCache) return dayIndexCache;
  const got = await chrome.storage.local.get(STORAGE.DAY_INDEX);
  dayIndexCache = Array.isArray(got[STORAGE.DAY_INDEX]) ? got[STORAGE.DAY_INDEX] : [];
  return dayIndexCache;
}

function emptyDay() {
  return { hosts: {}, hours: new Array(24).fill(0), total: 0 };
}

async function addHistory(config, host, billed, now) {
  const dayKey = R.dayKeyFor(now, config.resetHour);
  const key = STORAGE.DAY_PREFIX + dayKey;
  const got = await chrome.storage.local.get(key);
  const rec = got[key] || emptyDay();
  if (!Array.isArray(rec.hours) || rec.hours.length !== 24) rec.hours = new Array(24).fill(0);

  rec.hosts[host] = (rec.hosts[host] || 0) + billed;
  // The wall-clock hour, not the shifted day — "when do you browse" means the
  // hour on the clock, even when the day it is filed under started at 04:00.
  rec.hours[new Date(now).getHours()] += billed;
  rec.total += billed;
  await chrome.storage.local.set({ [key]: rec });

  const index = await getDayIndex();
  if (!index.includes(dayKey)) {
    dayIndexCache = index.concat(dayKey).sort();
    await chrome.storage.local.set({ [STORAGE.DAY_INDEX]: dayIndexCache });
  }
}

// Days older than the retention window are deleted outright. Runs only on a
// force reconcile, which is often enough for a daily boundary.
async function pruneHistory(config) {
  const keep = Math.max(1, Number((config.tracking || {}).retentionDays) || 90);
  const index = await getDayIndex();
  if (!index.length) return;
  // YYYY-MM-DD sorts lexicographically, so a string compare is a date compare.
  const cutoff = R.dayKeyFor(Date.now() - (keep - 1) * 86400000, config.resetHour);
  const drop = index.filter((k) => k < cutoff);
  if (!drop.length) return;
  await chrome.storage.local.remove(drop.map((k) => STORAGE.DAY_PREFIX + k));
  dayIndexCache = index.filter((k) => k >= cutoff);
  await chrome.storage.local.set({ [STORAGE.DAY_INDEX]: dayIndexCache });
}

async function readHistory(config, back) {
  const keys = R.dayKeyRange(Date.now(), config.resetHour, Math.max(1, Number(back) || 1));
  const got = await chrome.storage.local.get(keys.map((k) => STORAGE.DAY_PREFIX + k));
  const records = {};
  for (const k of keys) {
    const rec = got[STORAGE.DAY_PREFIX + k];
    if (rec) records[k] = rec;
  }
  return { keys, records };
}

async function clearHistory() {
  const index = await getDayIndex();
  await chrome.storage.local.remove(index.map((k) => STORAGE.DAY_PREFIX + k).concat(STORAGE.DAY_INDEX));
  dayIndexCache = [];
}

// ---------- the accrual core ----------
//
// Time is billed as "now minus when this stretch started", never by counting
// ticks. Ticks can be missed — the service worker is killed constantly under
// MV3 — but a start timestamp survives in storage, so a stretch interrupted
// by a worker death is still billed correctly on the next wake. MAX_ACCRUAL_MS
// is the guard that keeps a suspended laptop from being billed as browsing.

let reconciling = null;

// Serialised: two events arriving in the same millisecond (a tab activating
// and a window focusing) would otherwise both read the same usage, both add
// their slice, and the second write would lose the first.
function reconcile(opts) {
  const run = () => reconcileInner(opts || {});
  reconciling = reconciling ? reconciling.then(run, run) : run();
  return reconciling;
}

// Which site, if any, the user is actually looking at right now.
// Everything that decides "is the clock running" lives here and nowhere else.
async function countableNow(config) {
  let win;
  try {
    win = await chrome.windows.getLastFocused({ populate: false });
  } catch (_) {
    return null;
  }
  // No focused browser window means the browser is in the background. Nothing
  // counts, no matter what is loaded in it.
  if (!win || !win.focused) return null;

  let tabs;
  try {
    tabs = await chrome.tabs.query({ active: true, windowId: win.id });
  } catch (_) {
    return null;
  }
  const tab = tabs && tabs[0];
  // Without the "tabs" permission, tab.url is only populated for hosts the
  // manifest already grants — which is exactly the set we track, so an empty
  // url reliably means "not one of ours".
  if (!tab || !tab.url) return null;

  const site = R.siteForUrl(config, tab.url);

  // The browsing record wants every site, not just the five under a limit.
  // Without the all-origins grant `tab.url` is only populated for hosts the
  // manifest already holds, so this is empty anyway — the permission check is
  // belt and braces, not the only gate.
  let host = "";
  if (config.tracking && config.tracking.enabled) {
    if (trackingGranted === null) await refreshTrackingGrant();
    if (trackingOn(config)) {
      const h = R.trackingKeyFor(tab.url);
      if (h && !R.hostMatchesAny(h, config.tracking.exclude)) host = h;
    }
  }

  if (!site && !host) return null;

  // Idle handling. A long video is the case that breaks naive idle detection:
  // you have not touched the keyboard in 40 minutes and you are absolutely
  // still watching, so audible playback keeps the clock running.
  if (idleState !== "active" && !(config.countWhileAudible && tab.audible)) return null;

  return { siteId: site ? site.id : null, host, tabId: tab.id, windowId: win.id };
}

async function reconcileInner({ force } = {}) {
  const now = Date.now();
  const config = await getConfig();

  let usage = R.rolledOver(await getUsageRaw(), now, config.resetHour);
  const session = await getSession();
  const current = await countableNow(config);

  // 1. Bill the stretch that just ended (or is still running).
  if (session && session.since) {
    const raw = now - session.since;
    const billed = Math.max(0, Math.min(raw, MAX_ACCRUAL_MS));

    // The browsing record takes every countable second, on any site. It is a
    // record of where the time went, so it is deliberately NOT subject to the
    // freeze — a tab left sitting on a site you can no longer use still cost
    // you that time.
    if (billed > 0 && session.host && trackingOn(config)) {
      await addHistory(config, session.host, billed, now);
    }

    if (billed > 0 && session.siteId && usage.dayKey === R.dayKeyFor(session.since, config.resetHour)) {
      const site = R.siteById(config, session.siteId);
      const prev = R.siteUsage(usage, session.siteId);
      const next = { ...prev, ms: prev.ms + billed };

      if (site && site.inPool && config.pool && config.pool.enabled) {
        // Not `billed`: minutes bought with an override belong to this site
        // alone and must not come out of everyone else's shared budget.
        usage.poolMs = (usage.poolMs || 0) + R.poolBillableMs(usage, session.siteId, billed, now);
      }

      // Session accounting. This is the only place a break is ever stamped;
      // `verdictFor` just reads `breakUntil`, which keeps the verdict pure.
      const rule = site ? R.sessionRule(site) : null;
      if (rule) {
        // Two ways the counter clears, and they are the same thing: a break
        // that has run its course, and a gap before this stretch that was
        // already long enough. The second is what makes stepping away of
        // your own accord count, instead of being punished for it.
        if ((next.breakUntil && next.breakUntil <= now) || R.breakServedBy(usage, site, session.since)) {
          next.sessionMs = 0;
          next.breakUntil = 0;
        }
        next.sessionMs += billed;
        next.lastSeenAt = now;
        if (!next.breakUntil && next.sessionMs >= rule.workMs) {
          next.breakUntil = now + rule.breakMs;
        }
      }

      usage.sites[session.siteId] = next;
    }
  }

  // 2. Open or continue the current stretch — unless the site just became
  // blocked. A blocked site is not accruing: you are about to be redirected
  // off it, and leaving the stretch open bills every second you then spend
  // on the block page against the site's daily budget. That is most obvious
  // with a forced break, where the whole break would come out of your day.
  let open = current;
  if (open && open.siteId) {
    const openSite = R.siteById(config, open.siteId);
    if (openSite && R.verdictFor(config, usage, openSite, now).blocked) {
      // Frozen for blocking purposes — but keep the host so the browsing
      // record carries on. Drop the stretch entirely only if there is no
      // record to keep, which is the behaviour with tracking off.
      open = open.host ? { ...open, siteId: null } : null;
    }
  }
  if (open) await setSession({ siteId: open.siteId, host: open.host, tabId: open.tabId, since: now });
  else if (session) await setSession(null);

  await setUsage(usage);

  // 3. Re-derive every verdict and push the consequences outward.
  await applyVerdicts(config, usage, now, { force, current });
  // Only on an explicit force (boot, a config write, a sync push) — this is a
  // registration round-trip and has no business running on every heartbeat.
  if (force) {
    await syncDynamicScripts(config);
    await pruneHistory(config);
  }

  return { config, usage, now, current };
}

// ---------- enforcement ----------
//
// Two layers, because neither covers the other's case:
//
//   DNR session rules stop a NEW navigation before a single byte is fetched,
//   which is the only way to get no flash of the feed. But a DNR rule cannot
//   see a tab that is already open and already rendered.
//
//   Redirecting matching tabs handles exactly that: the three Reddit tabs
//   sitting in the background when the pool ran dry.

let lastRuleSignature = "";

async function applyVerdicts(config, usage, now, { force, current } = {}) {
  const blocked = [];
  for (const site of config.sites || []) {
    if (!site.enabled) continue;
    const v = R.verdictFor(config, usage, site, now);
    if (v.blocked) blocked.push({ site, verdict: v });
  }

  const signature = blocked.map((b) => b.site.id + ":" + b.verdict.reason).sort().join("|");
  if (signature !== lastRuleSignature || force) {
    lastRuleSignature = signature;
    await syncDnrRules(blocked);
    await bounceOpenTabs(blocked);
  }

  await updateBadge(config, usage, now, current);
}

function blockUrlFor(siteId, reason) {
  return chrome.runtime.getURL(BLOCK_PAGE) + `?site=${encodeURIComponent(siteId)}&reason=${encodeURIComponent(reason || "")}`;
}

async function syncDnrRules(blocked) {
  if (!chrome.declarativeNetRequest || !chrome.declarativeNetRequest.updateSessionRules) return;
  let existing = [];
  try {
    existing = await chrome.declarativeNetRequest.getSessionRules();
  } catch (_) {
    return;
  }
  const removeRuleIds = existing.map((r) => r.id).filter((id) => id >= DNR_RULE_BASE && id < DNR_RULE_BASE + 1000);

  const addRules = blocked.map(({ site, verdict }, i) => ({
    id: DNR_RULE_BASE + i,
    priority: 1,
    action: { type: "redirect", redirect: { url: blockUrlFor(site.id, verdict.reason) } },
    condition: {
      requestDomains: (site.domains || []).map((d) => R.normalizeHost(d)),
      // The exclusion has to be repeated at the network layer too, or the DNR
      // rule would swallow music.youtube.com while the rest of the extension
      // carefully lets it through.
      ...((site.exclude || []).length ? { excludedRequestDomains: site.exclude.map((d) => R.normalizeHost(d)) } : {}),
      resourceTypes: ["main_frame"]
    }
  }));

  try {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
  } catch (e) {
    console.warn("[XrnFocus] DNR update failed", e);
  }
}

async function bounceOpenTabs(blocked) {
  for (const { site, verdict } of blocked) {
    const patterns = [];
    for (const d of site.domains || []) {
      patterns.push(`*://${R.normalizeHost(d)}/*`, `*://*.${R.normalizeHost(d)}/*`);
    }
    let tabs = [];
    try {
      tabs = await chrome.tabs.query({ url: patterns });
    } catch (_) {
      continue;
    }
    for (const tab of tabs) {
      if (!tab.url) continue;
      // siteForUrl re-checks the exclusion list, so an open music.youtube.com
      // tab is not collateral damage of youtube.com running out.
      const owner = R.siteForUrl({ sites: [site] }, tab.url);
      if (!owner) continue;
      try {
        await chrome.tabs.update(tab.id, { url: blockUrlFor(site.id, verdict.reason) + "&from=" + encodeURIComponent(tab.url) });
      } catch (_) { /* tab closed under us */ }
    }
  }
}

// ---------- custom sites ----------
//
// The five built-ins are declared statically in the manifest. Anything you add
// yourself cannot be, so its content script is registered at runtime — and
// only for origins you actually granted, because registering for an origin the
// extension does not hold makes the whole call fail and takes the valid
// matches down with it.

const DYNAMIC_SCRIPT_ID = "bs-custom-sites";

async function syncDynamicScripts(config) {
  if (!chrome.scripting || !chrome.scripting.registerContentScripts) return;

  const builtin = new Set(NS.BUILTIN_DOMAINS.map((d) => R.normalizeHost(d)));
  const wanted = [];
  for (const site of config.sites || []) {
    if (!site.enabled) continue;
    for (const d of site.domains || []) {
      const host = R.normalizeHost(d);
      if (!host || builtin.has(host)) continue;
      wanted.push(`*://${host}/*`, `*://*.${host}/*`);
    }
  }

  let existing = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
  } catch (_) { /* nothing registered yet */ }

  const granted = [];
  for (const m of wanted) {
    try {
      if (await chrome.permissions.contains({ origins: [m] })) granted.push(m);
    } catch (_) { /* malformed pattern; skip it rather than fail the batch */ }
  }

  if (!granted.length) {
    if (existing.length) {
      try { await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] }); } catch (_) {}
    }
    return;
  }

  const spec = {
    id: DYNAMIC_SCRIPT_ID,
    matches: granted,
    js: ["shared/constants.js", "content/content.js"],
    runAt: "document_start",
    allFrames: false
  };
  try {
    if (existing.length) await chrome.scripting.updateContentScripts([spec]);
    else await chrome.scripting.registerContentScripts([spec]);
  } catch (e) {
    console.warn("[XrnFocus] could not register custom-site scripts", e);
  }
}

// The toolbar icon carries the number that matters most right now: minutes
// left on whatever you are looking at, or on the shared pool when you are not.
async function updateBadge(config, usage, now, current) {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  let text = "";
  let color = "#3f6fd1";

  const site = current ? R.siteById(config, current.siteId) : null;
  if (site) {
    const v = R.verdictFor(config, usage, site, now);
    if (v.overrideUntil > now) {
      text = String(Math.max(1, Math.round((v.overrideUntil - now) / 60000)));
      color = "#b8791f";
    } else if (v.remainingMs !== null) {
      const mins = Math.floor(v.remainingMs / 60000);
      text = mins > 0 ? String(mins) : "0";
      color = mins <= 5 ? "#c1442e" : "#3f6fd1";
    }
  }

  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch (_) { /* action API unavailable on some Firefox builds */ }
}

// ---------- overrides ----------
//
// The whole point of an override is that it costs something. That cost is a
// phrase you have to type and a delay you have to sit through, and both are
// checked HERE rather than in the block page, because a page can be edited
// from devtools and a reload would reset a countdown the page owned.

async function overrideBegin(siteId) {
  const now = Date.now();
  const config = await getConfig();
  const usage = R.rolledOver(await getUsageRaw(), now, config.resetHour);
  const site = R.siteById(config, siteId);
  if (!site) return { ok: false, error: "unknown site" };

  const v = R.verdictFor(config, usage, site, now);
  if (!v.canOverride) return { ok: false, error: "overrides are not available for this block" };

  await chrome.storage.local.set({ [STORAGE.PENDING]: { siteId, since: now } });
  return { ok: true, readyAt: now + (Number(config.override.delaySeconds) || 0) * 1000 };
}

async function overrideClaim(siteId, phrase) {
  const now = Date.now();
  const config = await getConfig();
  const o = config.override || {};
  let usage = R.rolledOver(await getUsageRaw(), now, config.resetHour);
  const site = R.siteById(config, siteId);
  if (!site) return { ok: false, error: "unknown site" };

  const v = R.verdictFor(config, usage, site, now);
  if (!v.canOverride) return { ok: false, error: "no overrides left today" };

  // Compared case- and whitespace-insensitively: the friction is meant to be
  // deliberation, not a typing test.
  const want = String(o.phrase || "").trim().toLowerCase().replace(/\s+/g, " ");
  const got = String(phrase || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (want && want !== got) return { ok: false, error: "that is not the phrase" };

  const pendingGot = await chrome.storage.local.get(STORAGE.PENDING);
  const pending = pendingGot[STORAGE.PENDING];
  const needMs = (Number(o.delaySeconds) || 0) * 1000;
  if (needMs > 0) {
    if (!pending || pending.siteId !== siteId) return { ok: false, error: "start the wait first" };
    const waited = now - pending.since;
    if (waited < needMs) return { ok: false, error: `${Math.ceil((needMs - waited) / 1000)}s left to wait` };
  }

  const prev = R.siteUsage(usage, siteId);
  usage.sites[siteId] = {
    ...prev,
    overrides: prev.overrides + 1,
    overrideUntil: now + (Number(o.grantMinutes) || 0) * 60000
  };
  usage.overridesUsed = (usage.overridesUsed || 0) + 1;

  await setUsage(usage);
  await chrome.storage.local.remove(STORAGE.PENDING);
  await applyVerdicts(config, usage, now, { force: true });

  return { ok: true, until: usage.sites[siteId].overrideUntil };
}

async function endOverride(siteId) {
  const now = Date.now();
  const config = await getConfig();
  const usage = R.rolledOver(await getUsageRaw(), now, config.resetHour);
  const prev = R.siteUsage(usage, siteId);
  usage.sites[siteId] = { ...prev, overrideUntil: 0 };
  await setUsage(usage);
  await applyVerdicts(config, usage, now, { force: true });
  return { ok: true };
}

// ---------- state for the UIs ----------

async function buildState(url) {
  const now = Date.now();
  const config = await getConfig();
  const usage = R.rolledOver(await getUsageRaw(), now, config.resetHour);
  const session = await getSession();

  // The stored counters are only current as of the last reconcile. A popup
  // opened mid-session would otherwise show a number up to 15 seconds stale,
  // so the open stretch is added in for display without being written back.
  const live = JSON.parse(JSON.stringify(usage));
  if (session && session.siteId) {
    const billed = Math.max(0, Math.min(Date.now() - session.since, MAX_ACCRUAL_MS));
    const prev = R.siteUsage(live, session.siteId);
    const s = R.siteById(config, session.siteId);
    const bump = { ...prev, ms: prev.ms + billed };
    if (s && R.sessionRule(s) && !(prev.breakUntil > now)) bump.sessionMs = prev.sessionMs + billed;
    live.sites[session.siteId] = bump;
    if (s && s.inPool && config.pool && config.pool.enabled) {
      // Same rule as the real accrual, or the popup's pool figure would
      // creep ahead of the stored one for the length of an override.
      live.poolMs = (live.poolMs || 0) + R.poolBillableMs(live, session.siteId, billed, now);
    }
  }

  const verdicts = {};
  for (const site of config.sites || []) verdicts[site.id] = R.verdictFor(config, live, site, now);

  const activeSite = url ? R.siteForUrl(config, url) : null;

  return {
    now,
    config,
    usage: live,
    verdicts,
    activeSiteId: activeSite ? activeSite.id : null,
    trackingSiteId: session ? session.siteId : null,
    nextResetAt: R.nextResetAt(now, config.resetHour)
  };
}

// ---------- messages ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg && msg.type) {
        case MSG.HELLO:
        case MSG.TICK: {
          // A tick is both a report and a question: it proves the page is in
          // the foreground (the content script only sends while visible and
          // focused) and it collects the verdict in the same round trip.
          const { config, usage, now } = await reconcile({});
          const site = R.siteForUrl(config, sender.tab ? sender.tab.url : msg.url);
          if (!site) { sendResponse({ tracked: false }); return; }
          const v = R.verdictFor(config, usage, site, now);
          sendResponse({
            tracked: true,
            siteId: site.id,
            label: site.label,
            blocked: v.blocked,
            reason: v.reason,
            remainingMs: v.remainingMs,
            sessionRemainingMs: v.sessionRemainingMs,
            usedMs: v.usedMs,
            overrideUntil: v.overrideUntil,
            blockUrl: v.blocked ? blockUrlFor(site.id, v.reason) : null,
            warnAtMinutes: config.warnAtMinutes || [],
            clock: config.clock || {},
            heartbeatMs: HEARTBEAT_MS
          });
          return;
        }

        case MSG.GET_STATE:
          sendResponse(await buildState(msg && msg.url));
          return;

        case MSG.SET_CONFIG: {
          const config = mergeConfig(msg.config);
          await setConfig(config);
          await reconcile({ force: true });
          sendResponse(await buildState());
          return;
        }

        case MSG.RESET_CONFIG: {
          await setConfig(JSON.parse(JSON.stringify(DEFAULT_CONFIG)));
          await reconcile({ force: true });
          sendResponse(await buildState());
          return;
        }

        case MSG.OVERRIDE_BEGIN:
          sendResponse(await overrideBegin(msg.siteId));
          return;

        case MSG.OVERRIDE_CLAIM:
          sendResponse(await overrideClaim(msg.siteId, msg.phrase));
          return;

        case MSG.OVERRIDE_CANCEL:
          await chrome.storage.local.remove(STORAGE.PENDING);
          sendResponse({ ok: true });
          return;

        case MSG.END_OVERRIDE:
          sendResponse(await endOverride(msg.siteId));
          return;

        case MSG.GET_HISTORY: {
          // Reconcile first, so the stretch that is open right now is already
          // on the books — otherwise "today" reads up to a heartbeat short
          // every time you open the dashboard.
          const { config } = await reconcile({});
          const back = Math.max(1, Math.min(366, Number(msg.days) || 30));
          const { keys, records } = await readHistory(config, back);
          sendResponse({
            keys,
            records,
            tracking: config.tracking,
            granted: trackingGranted === true,
            resetHour: config.resetHour,
            // So the dashboard can mark which of these sites carry a limit.
            managed: (config.sites || [])
              .filter((s) => s.enabled)
              .map((s) => ({ id: s.id, label: s.label, domains: s.domains || [] }))
          });
          return;
        }

        case MSG.CLEAR_HISTORY:
          await clearHistory();
          sendResponse({ ok: true });
          return;

        case MSG.TRACKING_STATUS: {
          await refreshTrackingGrant();
          const config = await getConfig();
          sendResponse({
            enabled: !!(config.tracking && config.tracking.enabled),
            granted: trackingGranted === true,
            origins: NS.TRACK_ORIGINS
          });
          return;
        }

        case MSG.CLEAR_USAGE: {
          const now = Date.now();
          const config = await getConfig();
          await setUsage(R.emptyUsage(now, config.resetHour));
          await setSession(null);
          await reconcile({ force: true });
          sendResponse(await buildState());
          return;
        }

        default:
          sendResponse({ error: "unknown message" });
      }
    } catch (e) {
      console.error("[XrnFocus]", e);
      sendResponse({ error: String((e && e.message) || e) });
    }
  })();
  return true; // async sendResponse
});

// ---------- events that can change the answer ----------

let idleState = "active";

function wire() {
  chrome.tabs.onActivated.addListener(() => reconcile({}));
  chrome.tabs.onUpdated.addListener((_id, info) => {
    if (info.url || info.status === "complete" || "audible" in info) reconcile({});
  });
  chrome.tabs.onRemoved.addListener(() => reconcile({}));
  chrome.windows.onFocusChanged.addListener(() => reconcile({}));

  if (chrome.idle) {
    chrome.idle.onStateChanged.addListener((state) => {
      idleState = state;
      reconcile({});
    });
  }

  chrome.alarms.onAlarm.addListener((alarm) => {
    // The once-a-minute floor is what catches everything no tab can report:
    // a schedule window opening while you sit on the page, the daily reset,
    // and an override grant lapsing with nothing focused.
    if (alarm.name === ALARM_NAME) reconcile({});
  });

  // Granting or revoking the all-origins permission changes whether the
  // tracker can see anything at all, and neither event goes through storage.
  if (chrome.permissions && chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener(() => { trackingGranted = null; reconcile({ force: true }); });
    chrome.permissions.onRemoved.addListener(() => { trackingGranted = null; reconcile({ force: true }); });
  }

  // Config can also change from another signed-in browser.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[STORAGE.CONFIG]) reconcile({ force: true });
  });
}

async function boot() {
  try {
    if (chrome.idle) {
      const config = await getConfig();
      chrome.idle.setDetectionInterval(Math.max(15, Number(config.idleSeconds) || 60));
      idleState = await chrome.idle.queryState(Math.max(15, Number(config.idleSeconds) || 60));
    }
  } catch (_) { /* idle unavailable */ }

  await refreshTrackingGrant();
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: ALARM_PERIOD_MINUTES });
  await reconcile({ force: true });
}

wire();
chrome.runtime.onInstalled.addListener(boot);
chrome.runtime.onStartup.addListener(boot);
boot();
