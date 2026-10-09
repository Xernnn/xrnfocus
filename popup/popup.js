// Read-only glance at today. Every number here comes from GET_STATE, which
// folds the in-flight session into the stored counters — otherwise opening
// the popup mid-scroll would show a figure up to one heartbeat out of date.
(function () {
  const NS = self.XrnFocus;
  const { MSG } = NS;
  const R = NS.rules;
  const $ = (id) => document.getElementById(id);

  const ui = NS.ui;

  function chipFor(site, v, now) {
    if (!site.enabled) return ui.el("span", { class: "chip off", text: "off" });
    if (v.overrideUntil > now) {
      return ui.el("span", { class: "chip grant", text: "override " + R.fmtDuration(v.overrideUntil - now) });
    }
    if (v.blocked) {
      const why = v.reason === NS.REASON.SCHEDULE ? "scheduled"
        : v.reason === NS.REASON.POOL ? "pool spent"
        : v.reason === NS.REASON.BREAK ? "on a break" : "limit hit";
      return ui.el("span", { class: v.reason === NS.REASON.BREAK ? "chip grant" : "chip blocked", text: why });
    }
    return null;
  }

  // Only for sites with a session rule: how much of this stretch is left, or
  // how long until the break is over.
  function sessionSub(site, v, now) {
    if (typeof v.sessionRemainingMs !== "number") return null;
    if (v.breakUntil > now) return `break ends in ${R.fmtDuration(v.breakUntil - now)}`;
    return `${R.fmtDuration(v.sessionRemainingMs)} until a break`;
  }

  function row(o) {
    return ui.el("div", { class: ("row " + (o.cls || "")).trim() }, [
      ui.el("div", { class: "head" }, [
        ui.el("span", { class: "name" }, [o.name, o.chip ? " " : null, o.chip]),
        ui.el("span", { class: "num" }, o.right)
      ]),
      ui.track(o.pct, o.fill),
      o.sub ? ui.el("span", { class: "sub", text: o.sub }) : null
    ]);
  }

  function render(state) {
    const { config, usage, verdicts, now } = state;

    $("reset").textContent = `resets ${R.fmtClock(state.nextResetAt)}`;

    const pool = config.pool || {};
    if (pool.enabled && Number(pool.minutes) > 0) {
      const used = usage.poolMs || 0;
      const cap = Number(pool.minutes);
      const members = (config.sites || []).filter((s) => s.inPool && s.enabled).map((s) => s.label).join(", ");
      $("pool").hidden = false;
      ui.replace($("pool"), [row({
        name: "Shared pool",
        right: [ui.el("b", { text: R.fmtDuration(used) }), ` / ${cap}m`],
        pct: ui.pctOf(used, cap),
        fill: used >= cap * 60000 ? "full" : "",
        sub: members || "no sites in the pool"
      })]);
    } else {
      $("pool").hidden = true;
      ui.clear($("pool"));
    }

    ui.replace($("list"), (config.sites || []).map((site) => {
      const v = verdicts[site.id] || {};
      const used = R.siteUsage(usage, site.id).ms;
      const cap = Number(site.limitMinutes) || 0;

      let fill = "";
      if (v.overrideUntil > now) fill = "grant";
      else if (v.blocked) fill = "full";
      else if (!cap) fill = "none";

      return row({
        cls: state.activeSiteId === site.id ? "here" : "",
        name: site.label,
        chip: chipFor(site, v, now),
        right: [ui.el("b", { text: R.fmtDuration(used) }), cap ? ` / ${cap}m` : " · no cap"],
        sub: sessionSub(site, v, now),
        // An uncapped site has no meaningful percentage, so it gets a full
        // muted bar rather than an empty one that looks like "nothing used".
        pct: cap ? ui.pctOf(used, cap) : 100,
        fill
      });
    }));

    $("tracking").textContent = state.trackingSiteId
      ? `counting ${(R.siteById(config, state.trackingSiteId) || {}).label || ""}`
      : "idle";
  }

  $("options").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  async function load() {
    let url = null;
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      url = tabs && tabs[0] ? tabs[0].url : null;
    } catch (_) { /* no url access; activeSiteId just stays null */ }

    chrome.runtime.sendMessage({ type: MSG.GET_STATE, url }, (state) => {
      void chrome.runtime.lastError;
      if (state && state.config) render(state);
    });
  }

  load();
  setInterval(load, 2000);
})();
