// Shared across background, content script, block page, popup and options.
// Loaded as a plain classic script everywhere, so it just hangs things off
// `self` — there is no bundler and no import graph in this extension.
self.XrnFocus = self.XrnFocus || {};

self.XrnFocus.MSG = {
  // Content script -> background, every HEARTBEAT_MS while the page is
  // visible AND focused. This is the extension's clock: it is what keeps the
  // MV3 service worker alive during a browsing session, and the reply carries
  // the verdict back, so the page learns it has run out without polling.
  TICK: "TICK",
  // Content script -> background on load, to find out whether this page should
  // already be showing the block screen before it has ticked even once.
  HELLO: "HELLO",

  // Popup / options / block page -> background. The background is the ONLY
  // writer to storage; every UI change is a message, never a direct write.
  GET_STATE: "GET_STATE",
  SET_CONFIG: "SET_CONFIG",
  RESET_CONFIG: "RESET_CONFIG",

  // The override handshake is deliberately two messages with the background
  // holding the clock in between. If the page owned the countdown you could
  // skip it by editing the DOM; if the page owned the daily cap you could skip
  // it by reloading. See docs/overrides.md.
  OVERRIDE_BEGIN: "OVERRIDE_BEGIN",
  OVERRIDE_CLAIM: "OVERRIDE_CLAIM",
  OVERRIDE_CANCEL: "OVERRIDE_CANCEL",

  // Manual "I'm done here" — ends an active override grant early and re-blocks.
  END_OVERRIDE: "END_OVERRIDE",

  // Wipe today's counters (the options page confirms first).
  CLEAR_USAGE: "CLEAR_USAGE",

  // The browsing tracker: a local record of where the time went, across
  // every site, not just the ones under a limit. Off until you turn it on,
  // because it needs permission to see every tab's URL.
  GET_HISTORY: "GET_HISTORY",
  CLEAR_HISTORY: "CLEAR_HISTORY",
  TRACKING_STATUS: "TRACKING_STATUS"
};

self.XrnFocus.STORAGE = {
  // chrome.storage.sync: the configuration you author. Small, and worth having
  // on every browser you sign into.
  CONFIG: "bs_config",
  // chrome.storage.local: today's counters. Deliberately NOT synced — two
  // browsers would race on every tick, and "minutes spent" is a property of
  // this machine, not of the account.
  USAGE: "bs_usage",
  // chrome.storage.local: the in-flight override handshake (see MSG above).
  PENDING: "bs_pending_override",
  // chrome.storage.local: the open accrual session, persisted so a service
  // worker that gets killed mid-session can still bill the time on wake.
  SESSION: "bs_session",
  // chrome.storage.local: one key per day, `bs_day_2026-09-21`. Per-day keys
  // rather than one big object so a tick rewrites only today — the archive
  // is never touched, however long it grows.
  DAY_PREFIX: "bs_day_",
  // chrome.storage.local: the list of day keys that exist, so the dashboard
  // and the pruner do not have to scan all of storage.
  DAY_INDEX: "bs_day_index"
};

// The origins the tracker needs in order to see a tab's URL at all. Requested
// at the moment you switch tracking on, never at install.
self.XrnFocus.TRACK_ORIGINS = ["*://*/*"];

// How often a visible, focused page reports in. Small enough that a killed
// service worker is revived long before a limit could be overshot, large
// enough that it is not a wakeup storm: 15s is ~4 wakeups/minute while you
// are actually looking at a tracked site, and zero when you are not.
self.XrnFocus.HEARTBEAT_MS = 15000;

// The ceiling on a single accrual. Every countable stretch is billed as
// "now minus when the stretch started", which is exact — except when the
// machine suspends, where that subtraction would silently bill an eight-hour
// sleep as eight hours of Reddit. A stretch can only legitimately run to
// HEARTBEAT_MS (plus scheduling slop), so anything past this is a clock jump
// and gets truncated rather than trusted.
self.XrnFocus.MAX_ACCRUAL_MS = 90000;

// chrome.alarms cannot fire faster than once a minute, so this is the
// resolution of everything that is NOT driven by a heartbeat: schedule
// windows opening and closing, the daily reset, and override grants expiring
// while no tracked tab is open.
self.XrnFocus.ALARM_NAME = "bs-tick";
self.XrnFocus.ALARM_PERIOD_MINUTES = 1;

// DNR session rules live in this id range; the background clears the whole
// range before rewriting, so nothing else may use it.
self.XrnFocus.DNR_RULE_BASE = 9000;

self.XrnFocus.BLOCK_PAGE = "block/block.html";

// Reasons a site can be blocked. Ordered by precedence in verdictFor().
self.XrnFocus.REASON = {
  SCHEDULE: "schedule",   // a time-of-day window says no
  SITE: "site",           // this site's own daily allowance is spent
  POOL: "pool",           // the shared allowance is spent
  BREAK: "break"          // you've been here a while; sit one out
};

// Sensible starting point, tuned to the five sites this was built for.
// YouTube sits OUTSIDE the shared pool with a larger allowance of its own,
// because an hour of YouTube is a different kind of hour from an hour of
// doomscrolling; the four feed sites share one pool so they trade off against
// each other. All of it is editable on the options page.
self.XrnFocus.DEFAULT_CONFIG = {
  version: 1,

  // The daily counters roll over at this local hour, not at midnight, so
  // browsing at 01:00 still counts against the day you are actually living.
  resetHour: 4,

  // The shared allowance. Only sites with `inPool: true` draw from it.
  pool: { enabled: true, minutes: 60 },

  override: {
    enabled: true,
    phrase: "I choose to keep scrolling",
    delaySeconds: 45,
    grantMinutes: 10,
    maxPerDay: 2,
    // true: each site gets its own `maxPerDay`. false: one budget of
    // overrides across every site.
    perSite: true,
    // Which kinds of block an override can lift. Time-of-day windows are
    // usually the more deliberate commitment, so you may well want the second
    // of these off.
    forLimits: true,
    forSchedule: true,
    // A forced break is the shortest of the three — usually minutes — so
    // being able to buy your way out of it defeats most of the point.
    forBreaks: false
  },

  // The browsing tracker. Records how long you spend on every site, in this
  // browser, to local storage only — it is never synced and never leaves the
  // machine. Off by default: it is a different bargain from blocking five
  // named sites, and it should be one you opt into deliberately.
  tracking: {
    enabled: false,
    // Days of history to keep. Older days are deleted, not archived.
    retentionDays: 90,
    // Hosts to leave out of the record entirely. Matched like a site's
    // domains, so "bank.com" also covers its subdomains.
    exclude: []
  },

  // Minutes-remaining marks at which the page shows a quiet corner warning.
  // Empty array turns warnings off.
  warnAtMinutes: [5, 1],

  // A small always-there readout in the corner of a tracked page. It counts
  // down locally between heartbeats so it ticks every second without costing
  // a message, and it freezes whenever the page is not in front of you —
  // which is also exactly when the clock it is showing has stopped.
  clock: {
    enabled: true,
    position: "bottom-right"   // bottom-right | bottom-left | top-right | top-left
  },

  // No input for this long means you are not really here, and the clock stops
  // — unless the tab is playing audio and countWhileAudible is on, which is
  // what stops a 40-minute video from being billed as 60 seconds.
  idleSeconds: 60,
  countWhileAudible: true,

  sites: [
    {
      id: "youtube",
      label: "YouTube",
      enabled: true,
      domains: ["youtube.com"],
      // An exclusion is invisible to this extension: never counted, never
      // blocked, not even when the rest of the site is. music.youtube.com is
      // a genuinely separate host, which is what makes "YouTube except music"
      // a clean rule rather than a guess about what a video is.
      exclude: ["music.youtube.com"],
      limitMinutes: 60,
      inPool: false,
      // Sit out `breakMinutes` after `workMinutes` of use in one stretch.
      // The counter resets on its own once you have been away for a whole
      // break, so taking one voluntarily costs you nothing.
      session: { enabled: true, workMinutes: 25, breakMinutes: 5 },
      schedule: { mode: "off", windows: [] },
      builtin: true
    },
    {
      id: "reddit",
      label: "Reddit",
      enabled: true,
      domains: ["reddit.com", "redd.it"],
      exclude: [],
      limitMinutes: 30,
      inPool: true,
      // Sit out `breakMinutes` after `workMinutes` of use in one stretch.
      // The counter resets on its own once you have been away for a whole
      // break, so taking one voluntarily costs you nothing.
      session: { enabled: true, workMinutes: 25, breakMinutes: 5 },
      schedule: { mode: "off", windows: [] },
      builtin: true
    },
    {
      id: "x",
      label: "X / Twitter",
      enabled: true,
      domains: ["x.com", "twitter.com"],
      exclude: [],
      limitMinutes: 15,
      inPool: true,
      // Sit out `breakMinutes` after `workMinutes` of use in one stretch.
      // The counter resets on its own once you have been away for a whole
      // break, so taking one voluntarily costs you nothing.
      session: { enabled: true, workMinutes: 25, breakMinutes: 5 },
      schedule: { mode: "off", windows: [] },
      builtin: true
    },
    {
      id: "instagram",
      label: "Instagram",
      enabled: true,
      domains: ["instagram.com"],
      exclude: [],
      limitMinutes: 15,
      inPool: true,
      // Sit out `breakMinutes` after `workMinutes` of use in one stretch.
      // The counter resets on its own once you have been away for a whole
      // break, so taking one voluntarily costs you nothing.
      session: { enabled: true, workMinutes: 25, breakMinutes: 5 },
      schedule: { mode: "off", windows: [] },
      builtin: true
    },
    {
      id: "facebook",
      label: "Facebook",
      enabled: true,
      domains: ["facebook.com", "fb.com"],
      exclude: [],
      limitMinutes: 15,
      inPool: true,
      // Sit out `breakMinutes` after `workMinutes` of use in one stretch.
      // The counter resets on its own once you have been away for a whole
      // break, so taking one voluntarily costs you nothing.
      session: { enabled: true, workMinutes: 25, breakMinutes: 5 },
      schedule: { mode: "off", windows: [] },
      builtin: true
    }
  ]
};

// The host patterns the manifest declares statically. A site whose domains all
// fall inside these needs no extra permission; anything else is a custom site
// and goes through the optional-permission path in options.js.
self.XrnFocus.BUILTIN_DOMAINS = [
  "youtube.com", "reddit.com", "redd.it",
  "x.com", "twitter.com", "instagram.com",
  "facebook.com", "fb.com"
];
