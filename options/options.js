// The settings page. It never writes storage directly — every change is a
// SET_CONFIG message and the background hands back the authoritative state,
// so a second options tab, the popup and the block page can never disagree
// about what the config is.
(function () {
  const NS = self.XrnFocus;
  const { MSG } = NS;
  const R = NS.rules;
  const ui = NS.ui;
  const $ = (id) => document.getElementById(id);

  const DAY_SHORT = ["S", "M", "T", "W", "T", "F", "S"];
  const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

  let state = null;
  let config = null;
  let saveTimer = null;

  function msg(type, extra) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...(extra || {}) }, (reply) => {
        void chrome.runtime.lastError;
        resolve(reply || {});
      });
    });
  }

  // ---------- path binding for the static fields ----------

  function getPath(obj, path) {
    return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
  }

  function setPath(obj, path, value) {
    const keys = path.split(".");
    const last = keys.pop();
    const target = keys.reduce((o, k) => (o[k] = o[k] || {}), obj);
    target[last] = value;
  }

  function readField(el) {
    switch (el.dataset.type) {
      case "number": return Number(el.value) || 0;
      case "bool": return el.checked;
      case "minutes":
        return el.value.split(",").map((s) => Number(s.trim())).filter((n) => n > 0).sort((a, b) => b - a);
      default: return el.value;
    }
  }

  function writeField(el, value) {
    switch (el.dataset.type) {
      case "bool": el.checked = !!value; break;
      case "minutes": el.value = (value || []).join(", "); break;
      default: el.value = value == null ? "" : value;
    }
  }

  function bindStatic() {
    for (const el of document.querySelectorAll("[data-path]")) {
      el.addEventListener("change", () => {
        setPath(config, el.dataset.path, readField(el));
        save();
      });
      if (el.type === "text" || el.type === "number") {
        el.addEventListener("input", () => {
          setPath(config, el.dataset.path, readField(el));
          save();
        });
      }
    }
  }

  function fillStatic() {
    for (const el of document.querySelectorAll("[data-path]")) {
      writeField(el, getPath(config, el.dataset.path));
    }
  }

  // ---------- sites ----------

  function csv(list) { return (list || []).join(", "); }
  function parseCsv(s) {
    return String(s || "").split(",").map((x) => R.normalizeHost(x)).filter(Boolean);
  }

  function renderWindow(win, onChange, onRemove) {
    const node = $("window-tpl").content.firstElementChild.cloneNode(true);
    const days = node.querySelector(".days");

    for (let d = 0; d < 7; d++) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "day" + ((win.days || []).includes(d) ? " on" : "");
      b.textContent = DAY_SHORT[d];
      b.title = DAY_FULL[d];
      b.addEventListener("click", () => {
        const set = new Set(win.days || []);
        if (set.has(d)) set.delete(d); else set.add(d);
        win.days = [...set].sort();
        b.classList.toggle("on");
        onChange();
      });
      days.appendChild(b);
    }

    const start = node.querySelector(".w-start");
    const end = node.querySelector(".w-end");
    start.value = win.start || "09:00";
    end.value = win.end || "17:00";
    start.addEventListener("change", () => { win.start = start.value; onChange(); });
    end.addEventListener("change", () => { win.end = end.value; onChange(); });
    node.querySelector(".w-remove").addEventListener("click", onRemove);

    return node;
  }

  function renderSite(site) {
    const node = $("site-tpl").content.firstElementChild.cloneNode(true);
    const q = (sel) => node.querySelector(sel);

    node.classList.toggle("off", !site.enabled);
    q(".s-label").textContent = site.label || site.id;
    q(".s-enabled").checked = !!site.enabled;
    q(".s-domains").value = csv(site.domains);
    q(".s-exclude").value = csv(site.exclude);
    q(".s-limit").value = Number(site.limitMinutes) || 0;
    q(".s-inpool").checked = !!site.inPool;
    q(".s-seson").checked = !!(site.session && site.session.enabled);
    q(".s-seswork").value = (site.session && site.session.workMinutes) || 25;
    q(".s-sesbreak").value = (site.session && site.session.breakMinutes) || 5;
    q(".s-schedmode").value = (site.schedule && site.schedule.mode) || "off";

    q(".s-enabled").addEventListener("change", (e) => {
      site.enabled = e.target.checked;
      node.classList.toggle("off", !site.enabled);
      save();
    });
    q(".s-domains").addEventListener("input", (e) => { site.domains = parseCsv(e.target.value); save(); });
    q(".s-exclude").addEventListener("input", (e) => { site.exclude = parseCsv(e.target.value); save(); });
    q(".s-limit").addEventListener("input", (e) => { site.limitMinutes = Number(e.target.value) || 0; save(); });
    q(".s-inpool").addEventListener("change", (e) => { site.inPool = e.target.checked; save(); });

    const sess = (patch) => {
      site.session = { enabled: false, workMinutes: 25, breakMinutes: 5, ...(site.session || {}), ...patch };
      save();
    };
    q(".s-seson").addEventListener("change", (e) => sess({ enabled: e.target.checked }));
    q(".s-seswork").addEventListener("input", (e) => sess({ workMinutes: Number(e.target.value) || 0 }));
    q(".s-sesbreak").addEventListener("input", (e) => sess({ breakMinutes: Number(e.target.value) || 0 }));

    const winWrap = q(".windows");
    const addBtn = q(".s-addwin");

    function paintWindows() {
      site.schedule = site.schedule || { mode: "off", windows: [] };
      const on = site.schedule.mode !== "off";
      addBtn.hidden = !on;
      ui.clear(winWrap);
      if (!on) return;
      site.schedule.windows = site.schedule.windows || [];
      site.schedule.windows.forEach((w, i) => {
        winWrap.appendChild(renderWindow(w, save, () => {
          site.schedule.windows.splice(i, 1);
          paintWindows();
          save();
        }));
      });
      if (!site.schedule.windows.length) {
        const p = document.createElement("p");
        p.className = "hint tight";
        p.textContent = site.schedule.mode === "allowOnly"
          ? "No windows yet — with none, this site stays blocked all day."
          : "No windows yet — add one to block a stretch of the day.";
        winWrap.appendChild(p);
      }
    }

    q(".s-schedmode").addEventListener("change", (e) => {
      site.schedule = site.schedule || { windows: [] };
      site.schedule.mode = e.target.value;
      if (site.schedule.mode !== "off" && !(site.schedule.windows || []).length) {
        site.schedule.windows = [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" }];
      }
      paintWindows();
      save();
    });

    addBtn.addEventListener("click", () => {
      site.schedule.windows.push({ days: [0, 1, 2, 3, 4, 5, 6], start: "22:00", end: "23:00" });
      paintWindows();
      save();
    });

    if (!site.builtin) {
      const rm = q(".s-remove");
      rm.hidden = false;
      rm.addEventListener("click", async () => {
        if (!confirm(`Remove ${site.label}?`)) return;
        config.sites = config.sites.filter((s) => s.id !== site.id);
        const origins = [];
        for (const d of site.domains || []) origins.push(`*://${d}/*`, `*://*.${d}/*`);
        try { await chrome.permissions.remove({ origins }); } catch (_) { /* fine if it fails */ }
        await save({ immediate: true, adopt: true });
      });
    }

    paintWindows();
    return node;
  }

  function paintSites() {
    const wrap = $("sites");
    ui.clear(wrap);
    for (const site of config.sites || []) wrap.appendChild(renderSite(site));
  }

  // ---------- adding a custom site ----------

  async function addSite() {
    $("addErr").textContent = "";
    const raw = $("newSite").value.trim();
    // Accept a pasted URL as readily as a bare domain — typing the full thing
    // is the natural move and rejecting it would just be pedantry.
    const host = R.normalizeHost(raw.replace(/^[a-z]+:\/\//i, "").split("/")[0]);
    if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) {
      $("addErr").textContent = "That doesn't look like a domain.";
      return;
    }
    if ((config.sites || []).some((s) => (s.domains || []).includes(host))) {
      $("addErr").textContent = "Already on the list.";
      return;
    }

    const origins = [`*://${host}/*`, `*://*.${host}/*`];
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins });
    } catch (e) {
      $("addErr").textContent = String((e && e.message) || e);
      return;
    }
    if (!granted) {
      $("addErr").textContent = "Without permission for that domain the extension can't see or block it.";
      return;
    }

    config.sites.push({
      id: "custom-" + host.replace(/[^a-z0-9]+/g, "-"),
      label: host,
      enabled: true,
      domains: [host],
      exclude: [],
      limitMinutes: 15,
      inPool: true,
      session: { enabled: true, workMinutes: 25, breakMinutes: 5 },
      schedule: { mode: "off", windows: [] },
      builtin: false
    });
    $("newSite").value = "";
    await save({ immediate: true, adopt: true });
  }

  // ---------- today ----------

  function paintToday() {
    const wrap = $("today");
    const rows = [];
    const pool = config.pool || {};

    function bar(label, used, capMin, cls) {
      return ui.el("div", { class: "t-row" }, [
        ui.el("div", { class: "t-head" }, [
          ui.el("span", { text: label }),
          ui.el("span", {}, [ui.el("b", { text: R.fmtDuration(used) }), capMin ? ` / ${capMin}m` : ""])
        ]),
        ui.track(ui.pctOf(used, capMin), cls)
      ]);
    }

    if (pool.enabled && Number(pool.minutes) > 0) {
      const used = state.usage.poolMs || 0;
      rows.push(bar("Shared pool", used, Number(pool.minutes), used >= pool.minutes * 60000 ? "full" : ""));
    }
    for (const site of config.sites || []) {
      const v = (state.verdicts || {})[site.id] || {};
      const used = R.siteUsage(state.usage, site.id).ms;
      const cls = v.overrideUntil > state.now ? "grant" : v.blocked ? "full" : "";
      rows.push(bar(site.label, used, Number(site.limitMinutes) || 0, cls));
    }
    ui.replace(wrap, rows);
  }

  // ---------- saving ----------

  function flashSaved() {
    $("saved").classList.add("on");
    setTimeout(() => $("saved").classList.remove("on"), 1100);
  }

  // opts.immediate skips the debounce; opts.adopt replaces the local config
  // with the background's merged copy and repaints everything.
  //
  // Adopt is OFF for an ordinary edit, and that is load-bearing. Every site
  // card closes over the site objects inside `config`; swapping in the
  // response's fresh copies orphans all of them, so the next keystroke would
  // mutate an object that is no longer part of what gets posted back and the
  // edit would vanish silently. Only adopt where a full repaint follows
  // anyway — import, restore, adding or removing a site.
  function save(opts) {
    const immediate = !!(opts && opts.immediate);
    const adopt = !!(opts && opts.adopt);
    clearTimeout(saveTimer);
    if (immediate) return commit(adopt);
    return new Promise((resolve) => {
      // Debounced, because every keystroke in a domain field fires a change
      // and each one would otherwise be a storage.sync write — straight into
      // Chrome's write-rate quota.
      saveTimer = setTimeout(() => commit(adopt).then(resolve), 400);
    });
  }

  async function commit(adopt) {
    const next = await msg(MSG.SET_CONFIG, { config });
    if (!next || !next.config) return;
    state = next;
    if (adopt) {
      config = next.config;
      render();
    } else {
      paintToday();
    }
    flashSaved();
  }

  // ---------- data buttons ----------

  function wireData() {
    $("clearUsage").addEventListener("click", async () => {
      if (!confirm("Reset today's counters to zero?")) return;
      // Counters only — `config` deliberately keeps its identity here, for the
      // same reason commit() does not adopt.
      state = await msg(MSG.CLEAR_USAGE, {});
      paintToday();
      flashSaved();
    });

    $("export").addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `xrnfocus-settings-${R.dayKeyFor(Date.now(), 0)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });

    $("import").addEventListener("click", () => $("importFile").click());
    $("importFile").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        if (!parsed || typeof parsed !== "object") throw new Error("not a settings file");
        config = parsed;
        await save({ immediate: true, adopt: true });
      } catch (err) {
        alert("Could not read that file: " + ((err && err.message) || err));
      }
      e.target.value = "";
    });

    $("restore").addEventListener("click", async () => {
      if (!confirm("Put every setting back to its default? Your counters are not touched.")) return;
      state = await msg(MSG.RESET_CONFIG, {});
      config = state.config;
      render();
      flashSaved();
    });

    $("addSite").addEventListener("click", addSite);
    $("newSite").addEventListener("keydown", (e) => { if (e.key === "Enter") addSite(); });
  }

  // ---------- boot ----------

  function fillResetHours() {
    const sel = $("resetHour");
    for (let h = 0; h < 24; h++) {
      const o = document.createElement("option");
      o.value = String(h);
      o.textContent = `${R.pad2(h)}:00`;
      sel.appendChild(o);
    }
  }

  function render() {
    fillStatic();
    paintSites();
    paintToday();
  }

  async function load() {
    state = await msg(MSG.GET_STATE, {});
    if (!state || !state.config) return;
    config = state.config;
    render();
  }

  fillResetHours();
  bindStatic();
  wireData();
  load();
})();
