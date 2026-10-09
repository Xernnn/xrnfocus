// A `chrome` good enough to run background/background.js for real, plus a
// clock we control. The point is to exercise the actual accrual, DNR and
// override code rather than a reimplementation of it in the test.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { ROOT } from "./harness.mjs";

export function bootBackground({ now }) {
  const clock = { now };
  const calls = { tabUpdates: [], badge: [], dnr: [], registered: [] };

  const store = { sync: {}, local: {} };
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

  const changeListeners = [];

  function area(name) {
    return {
      async get(keys) {
        const out = {};
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys || {});
        for (const k of list) if (k in store[name]) out[k] = clone(store[name][k]);
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          changes[k] = { oldValue: clone(store[name][k]), newValue: clone(v) };
          store[name][k] = clone(v);
        }
        for (const fn of changeListeners) fn(changes, name);
      },
      async remove(key) {
        const keys = Array.isArray(key) ? key : [key];
        for (const k of keys) delete store[name][k];
      }
    };
  }

  // Mutable world the background reads through the tabs/windows/idle APIs.
  const world = {
    windowFocused: true,
    windowId: 1,
    tabs: [],          // { id, windowId, active, url, audible }
    idle: "active"
  };

  let messageHandler = null;
  const idleListeners = [];
  const alarmListeners = [];

  const chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => "chrome-extension://test/" + p,
      onMessage: { addListener: (fn) => { messageHandler = fn; } },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      openOptionsPage: () => {}
    },
    storage: {
      sync: area("sync"),
      local: area("local"),
      onChanged: { addListener: (fn) => changeListeners.push(fn) }
    },
    tabs: {
      async query(q) {
        let list = world.tabs.slice();
        if (q.active) list = list.filter((t) => t.active);
        if (q.windowId != null) list = list.filter((t) => t.windowId === q.windowId);
        if (q.currentWindow) list = list.filter((t) => t.windowId === world.windowId);
        if (q.url) {
          const pats = (Array.isArray(q.url) ? q.url : [q.url]).map(patternToRe);
          list = list.filter((t) => t.url && pats.some((re) => re.test(t.url)));
        }
        return clone(list);
      },
      async update(id, props) {
        calls.tabUpdates.push({ id, ...props });
        const t = world.tabs.find((x) => x.id === id);
        if (t) t.url = props.url;
      },
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} }
    },
    windows: {
      async getLastFocused() {
        return { id: world.windowId, focused: world.windowFocused };
      },
      onFocusChanged: { addListener: () => {} }
    },
    idle: {
      setDetectionInterval: () => {},
      async queryState() { return world.idle; },
      onStateChanged: { addListener: (fn) => { idleListeners.push(fn); } }
    },
    alarms: {
      async create() {},
      onAlarm: { addListener: (fn) => { alarmListeners.push(fn); } }
    },
    action: {
      async setBadgeText(o) { calls.badge.push(o.text); },
      async setBadgeBackgroundColor() {}
    },
    declarativeNetRequest: {
      rules: [],
      async getSessionRules() { return clone(chrome.declarativeNetRequest.rules); },
      async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
        const keep = chrome.declarativeNetRequest.rules.filter((r) => !removeRuleIds.includes(r.id));
        chrome.declarativeNetRequest.rules = keep.concat(clone(addRules));
        calls.dnr.push(clone(addRules));
      }
    },
    scripting: {
      async getRegisteredContentScripts() { return clone(calls.registered); },
      async registerContentScripts(s) { calls.registered = clone(s); },
      async updateContentScripts(s) { calls.registered = clone(s); },
      async unregisterContentScripts() { calls.registered = []; }
    },
    permissions: {
      async contains() { return false; }
    }
  };

  function patternToRe(p) {
    // "*://*.reddit.com/*" -> a regex over the whole URL.
    const esc = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "§");
    return new RegExp("^" + esc.replace(/§/g, ".*") + "$");
  }

  // A Date whose "now" we own, so a test can jump forward an hour without
  // sleeping for one.
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now);
      else super(...args);
    }
    static now() { return clock.now; }
  }

  const ctx = {
    self: {}, console, chrome, URL, URLSearchParams,
    Date: FakeDate,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  vm.createContext(ctx);
  for (const f of ["shared/constants.js", "shared/rules.js", "background/background.js"]) {
    vm.runInContext(readFileSync(join(ROOT, f), "utf8"), ctx, { filename: f });
  }

  function send(type, extra = {}, sender = {}) {
    return new Promise((resolve) => {
      messageHandler({ type, ...extra }, sender, resolve);
    });
  }

  return {
    NS: ctx.self.XrnFocus,
    chrome, world, store, calls, clock, send,
    advance(ms) { clock.now += ms; },
    // The background caches idle state in a module variable it only updates
    // from the event, so a test that just sets world.idle changes nothing.
    // The once-a-minute alarm is the only thing that reconciles when no tab
    // is reporting — a break expiring while you sit on the block page, for
    // instance. A test that needs that has to fire it.
    async fireAlarm(name = "bs-tick") {
      for (const fn of alarmListeners) fn({ name });
      await new Promise((r) => setTimeout(r, 0));
    },
    async setIdle(state) {
      world.idle = state;
      for (const fn of idleListeners) fn(state);
      await new Promise((r) => setTimeout(r, 0));
    },
    setTab(url, opts = {}) {
      world.tabs = url ? [{ id: 7, windowId: 1, active: true, url, audible: false, ...opts }] : [];
    },
    async settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
  };
}
