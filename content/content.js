// Runs on every tracked site. It does four things and deliberately decides
// nothing: it reports that the page is in front of you, it acts on the
// verdict the background sends back, it shows the "5 minutes left" warning,
// and it draws the corner clock.
//
// All the arithmetic lives in the background. A content script runs inside a
// page that can rewrite its own globals, so it is the last place that should
// be trusted to know how many minutes you have left. The clock counts down
// locally between heartbeats, but only ever from a figure the background
// gave it, and every heartbeat resets it to the truth.
(function () {
  const NS = self.XrnFocus;
  const { MSG, HEARTBEAT_MS } = NS;

  let timer = null;        // the regular heartbeat
  let deadline = null;     // a one-shot timer that fires exactly when time runs out
  let warnedAt = new Set();
  let stopped = false;

  // The clock only runs when the page is BOTH visible and focused. Two
  // separate conditions: a tab can be visible in an unfocused window (a second
  // monitor you are not looking at), and the background double-checks the same
  // thing from the tabs API. Agreeing on both sides is what keeps a
  // backgrounded autoplaying tab from quietly eating the budget.
  function inFront() {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  function send(type) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type, url: location.href }, (reply) => {
          // Reading lastError is what suppresses the "unchecked runtime
          // lastError" noise when the worker is mid-restart.
          void chrome.runtime.lastError;
          resolve(reply || null);
        });
      } catch (_) {
        // Extension reloaded or updated under a live page: stop cleanly
        // rather than throwing on every tick for the rest of the session.
        stopped = true;
        teardown();
        resolve(null);
      }
    });
  }

  function bounce(url) {
    stopped = true;
    clearTimeout(deadline);
    clearInterval(timer);
    // replace(), not assign(): the blocked URL must not stay in history, or
    // Back walks straight back into it.
    location.replace(url);
  }

  function handle(reply) {
    if (!reply || !reply.tracked) {
      // An excluded page (music.youtube.com) or a site that was just turned
      // off: take the widget away rather than leaving a stale number up.
      setClock(null);
      return;
    }

    if (reply.blocked && reply.blockUrl) {
      // Carry where we were, so an override can drop you back exactly there.
      bounce(reply.blockUrl + "&from=" + encodeURIComponent(location.href));
      return;
    }

    // Schedule a wake-up for the exact millisecond the allowance runs out.
    // Without this the block would land on the next heartbeat instead, which
    // is up to 15 seconds of overtime every single day. Whichever of the
    // day's budget and the session runs out first is the one that matters.
    clearTimeout(deadline);
    const ends = [reply.remainingMs, reply.sessionRemainingMs].filter((v) => typeof v === "number" && v > 0);
    if (ends.length) {
      deadline = setTimeout(tick, Math.min(...ends) + 250);
    } else if (reply.overrideUntil > Date.now()) {
      deadline = setTimeout(tick, reply.overrideUntil - Date.now() + 250);
    }

    setClock(reply);
    maybeWarn(reply);
  }

  function maybeWarn(reply) {
    const marks = reply.warnAtMinutes || [];
    if (!marks.length || typeof reply.remainingMs !== "number" || reply.remainingMs <= 0) return;
    const minsLeft = reply.remainingMs / 60000;
    for (const m of marks) {
      // Fire once per threshold per page, as the countdown crosses it.
      if (minsLeft <= m && !warnedAt.has(m)) {
        warnedAt.add(m);
        toast(`${m} minute${m === 1 ? "" : "s"} left on ${reply.label}`);
      }
    }
  }

  // ---------- the shadow root ----------
  //
  // One host for both the toast and the clock, at an absurd z-index, because
  // they have to survive five very opinionated stylesheets none of which
  // expect a guest.

  let host = null;
  let shadow = null;

  const CSS = `
    :host { all: initial; }
    .toast, .clock {
      position: fixed; z-index: 2147483647;
      font: 500 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
      color: #fff; background: #1d2433; border: 1px solid #38415a;
      border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.4);
    }
    .toast {
      right: 16px; bottom: 16px; padding: 12px 14px;
      max-width: min(320px, calc(100vw - 32px));
      opacity: 0; transform: translateY(8px);
      transition: opacity .18s ease, transform .18s ease;
      pointer-events: none;
    }
    .toast.in { opacity: 1; transform: none; }

    .clock {
      display: none; align-items: center; gap: 7px;
      padding: 5px 10px 5px 8px; border-radius: 999px;
      font-variant-numeric: tabular-nums;
      opacity: .55; transition: opacity .15s ease;
      pointer-events: auto; cursor: default; user-select: none;
    }
    .clock:hover { opacity: 1; }
    .clock.on { display: inline-flex; }
    .clock .dot {
      width: 7px; height: 7px; border-radius: 50%; background: #6f9bf0;
      flex: none;
    }
    .clock.warn .dot { background: #e0a44a; }
    .clock.crit .dot { background: #e2705a; }
    .clock.grant .dot { background: #e0a44a; }
    .clock .t { font-weight: 600; font-size: 12.5px; letter-spacing: .01em; }
    .clock .lbl { font-size: 10.5px; opacity: .62; letter-spacing: .02em; }

    .clock.pos-bottom-right { right: 16px; bottom: 16px; }
    .clock.pos-bottom-left  { left: 16px;  bottom: 16px; }
    .clock.pos-top-right    { right: 16px; top: 16px; }
    .clock.pos-top-left     { left: 16px;  top: 16px; }
  `;

  function ensureShadow() {
    // Re-created if the page tore the host out from under us (SPAs rewriting
    // documentElement children do this), so the widget survives navigation.
    if (host && host.isConnected) return shadow;
    const root = document.documentElement || document.body;
    if (!root) return null;
    host = document.createElement("div");
    host.id = "xrnfocus-host";
    shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);
    shadow.appendChild(el("div", "toast"));
    shadow.appendChild(el("div", "clock"));
    root.appendChild(host);
    return shadow;
  }

  function el(tag, cls) {
    const n = document.createElement(tag);
    n.className = cls;
    return n;
  }

  function teardown() {
    clearInterval(timer);
    clearInterval(painter);
    clearTimeout(deadline);
    if (host && host.isConnected) host.remove();
    host = null;
    shadow = null;
  }

  function toast(text) {
    try {
      const sh = ensureShadow();
      if (!sh) return;
      const t = sh.querySelector(".toast");
      t.textContent = text;
      requestAnimationFrame(() => t.classList.add("in"));
      setTimeout(() => t.classList.remove("in"), 5000);
    } catch (_) { /* a toast is never worth an exception */ }
  }

  // ---------- the corner clock ----------

  let base = null;       // the last figures the background gave us
  let localMs = 0;       // time accrued locally since `base`, in-front only
  let lastFrame = 0;
  let painter = null;

  function setClock(reply) {
    base = reply;
    localMs = 0;
    lastFrame = Date.now();
    paint();
  }

  function mmss(ms) {
    const t = Math.max(0, Math.ceil(ms / 1000));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const s = t % 60;
    return h ? `${h}:${String(m).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  }

  function paint() {
    let sh;
    try { sh = ensureShadow(); } catch (_) { return; }
    if (!sh) return;
    const node = sh.querySelector(".clock");

    const cfg = (base && base.clock) || {};
    // Fullscreen is the one place a corner pill is genuinely in the way.
    const hidden = !base || !base.tracked || cfg.enabled === false || document.fullscreenElement;
    if (hidden) { node.className = "clock"; return; }

    const now = Date.now();
    const over = base.overrideUntil && base.overrideUntil > now;

    let value, label, tone = "";
    if (over) {
      value = base.overrideUntil - now;
      label = "override";
      tone = "grant";
    } else {
      // The binding constraint: whichever of the day's budget and this
      // stretch runs out first is the number worth showing.
      const daily = typeof base.remainingMs === "number" ? base.remainingMs - localMs : null;
      const sess = typeof base.sessionRemainingMs === "number" ? base.sessionRemainingMs - localMs : null;
      if (daily === null && sess === null) {
        // Nothing meters this site, so show what it has cost so far instead.
        value = (base.usedMs || 0) + localMs;
        label = "on site";
      } else if (sess !== null && (daily === null || sess < daily)) {
        value = sess;
        label = "to break";
      } else {
        value = daily;
        label = "left";
      }
      if (label !== "on site") {
        if (value <= 60000) tone = "crit";
        else if (value <= 5 * 60000) tone = "warn";
      }
    }

    node.className = `clock on pos-${cfg.position || "bottom-right"} ${tone}`.trim();
    node.replaceChildren(
      el("span", "dot"),
      Object.assign(el("span", "t"), { textContent: mmss(value) }),
      Object.assign(el("span", "lbl"), { textContent: label })
    );
    node.title = tooltip();
  }

  function tooltip() {
    if (!base) return "";
    const bits = [base.label];
    if (typeof base.remainingMs === "number") bits.push(`${mmss(base.remainingMs - localMs)} left today`);
    if (typeof base.sessionRemainingMs === "number") bits.push(`${mmss(base.sessionRemainingMs - localMs)} until a break`);
    if (base.overrideUntil > Date.now()) bits.push(`override ends in ${mmss(base.overrideUntil - Date.now())}`);
    return bits.join(" · ");
  }

  // One repaint a second. It only advances the local counter while the page
  // is in front, which is precisely when the background is billing it — so
  // the pill and the real total never drift apart while you look away.
  painter = setInterval(() => {
    if (stopped) return;
    const now = Date.now();
    if (inFront() && lastFrame) {
      // Clamped: a throttled background timer can hand back a huge delta.
      localMs += Math.min(Math.max(0, now - lastFrame), 2000);
    }
    lastFrame = now;
    if (base) paint();
  }, 1000);

  // ---------- the loop ----------

  async function tick() {
    if (stopped) return;
    if (!inFront()) return;
    handle(await send(MSG.TICK));
  }

  async function hello() {
    if (stopped) return;
    handle(await send(MSG.HELLO));
  }

  document.addEventListener("visibilitychange", () => { if (inFront()) tick(); });
  document.addEventListener("fullscreenchange", paint);
  window.addEventListener("focus", tick);
  window.addEventListener("pageshow", hello);

  timer = setInterval(tick, HEARTBEAT_MS);

  // Ask before the page has painted, so an already-spent budget shows the
  // block screen instead of a feed you then get yanked away from.
  hello();
})();
