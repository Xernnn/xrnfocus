// The block screen. Renders why you are here, and runs the override
// handshake — but only the UI half of it: the phrase check, the wait and the
// daily cap are all re-checked in the background, which is the only copy that
// a devtools console cannot reach.
(function () {
  const NS = self.XrnFocus;
  const { MSG } = NS;
  const R = NS.rules;
  const ui = NS.ui;
  const el = ui.el;

  const params = new URLSearchParams(location.search);
  const siteId = params.get("site");
  // The URL you were on when you got bounced, when the content script had a
  // chance to pass it along. A DNR redirect happens before any script runs and
  // cannot carry it, so this is often absent and we fall back to the site root.
  const from = params.get("from");

  const $ = (id) => document.getElementById(id);
  let state = null;
  let site = null;
  let verdict = null;
  let readyAt = 0;
  let ticker = null;

  function msg(type, extra) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type, ...(extra || {}) }, (reply) => {
        void chrome.runtime.lastError;
        resolve(reply || {});
      });
    });
  }

  function returnUrl() {
    if (from && /^https?:/i.test(from)) return from;
    const d = site && site.domains && site.domains[0];
    return d ? `https://${d}/` : null;
  }

  // ---------- rendering ----------

  const REASON_TEXT = {
    [NS.REASON.SCHEDULE]: (s) => `${s.label} is off-limits at this hour.`,
    [NS.REASON.SITE]: (s) => `You've used all of today's ${s.label} time.`,
    [NS.REASON.POOL]: () => `Your shared social-media time for today is gone.`,
    [NS.REASON.BREAK]: (s) => {
      const rule = R.sessionRule(s);
      const mins = rule ? Math.round(rule.breakMs / 60000) : 0;
      return `You've been on ${s.label} for a solid stretch. ${mins} minute${mins === 1 ? "" : "s"} off, then it's yours again.`;
    }
  };

  const HEADLINE = {
    [NS.REASON.SCHEDULE]: (s) => `Not right now — ${s.label}`,
    [NS.REASON.BREAK]: (s) => `Take a break — ${s.label}`
  };

  function bar(label, usedMs, capMinutes, opts) {
    const capMs = capMinutes * 60000;
    const full = capMs > 0 && usedMs >= capMs;
    const cls = (opts && opts.grant) ? "grant" : (full ? "full" : "");
    return el("div", { class: "bar-row" }, [
      el("div", { class: "bar-head" }, [
        el("span", { text: label }),
        el("span", {}, [el("b", { text: R.fmtDuration(usedMs) }), ` / ${capMinutes}m`])
      ]),
      ui.track(ui.pctOf(usedMs, capMinutes), cls)
    ]);
  }

  function render() {
    if (!site) {
      $("headline").textContent = "Blocked";
      $("lede").textContent = "This site is no longer being tracked. You can close this tab.";
      return;
    }

    const reason = verdict.reason || params.get("reason");
    $("headline").textContent = (HEADLINE[reason] || ((x) => `Time's up — ${x.label}`))(site);
    $("lede").textContent = (REASON_TEXT[reason] || (() => "This site is blocked right now."))(site);

    const rows = [];
    const own = Number(site.limitMinutes) || 0;
    if (own > 0) rows.push(bar(site.label, R.siteUsage(state.usage, site.id).ms, own));
    const pool = state.config.pool || {};
    if (pool.enabled && site.inPool && Number(pool.minutes) > 0) {
      rows.push(bar("Shared pool", state.usage.poolMs || 0, Number(pool.minutes)));
    }
    // The stretch behind a forced break is its own quantity — showing only
    // the day's total would make a break look like a daily limit.
    const rule = R.sessionRule(site);
    if (rule) {
      const su = R.siteUsage(state.usage, site.id);
      rows.push(bar("This stretch", Math.min(su.sessionMs, rule.workMs), rule.workMs / 60000,
                    { grant: reason === NS.REASON.BREAK }));
    }
    ui.replace($("bars"), rows);

    renderResumes(reason);
    renderOverride();
  }

  // A five-minute break deserves a countdown, not a clock time you have to
  // subtract from. Anything further out reads better as "at 04:00".
  let resumeTicker = null;

  function renderResumes(reason) {
    clearInterval(resumeTicker);
    if (!verdict.resumesAt) { $("resumes").textContent = ""; return; }

    if (verdict.resumesAt - Date.now() > 60 * 60000) {
      const when = new Date(verdict.resumesAt);
      const sameDay = when.toDateString() === new Date().toDateString();
      $("resumes").textContent = reason === NS.REASON.SCHEDULE
        ? `Available again at ${R.fmtClock(verdict.resumesAt)}.`
        : `Resets at ${R.fmtClock(verdict.resumesAt)}${sameDay ? "" : " tomorrow"}.`;
      return;
    }

    const paint = () => {
      const left = verdict.resumesAt - Date.now();
      if (left <= 0) { clearInterval(resumeTicker); load(); return; }
      $("resumes").textContent = `Back in ${R.fmtDuration(left)}.`;
    };
    paint();
    resumeTicker = setInterval(paint, 1000);
  }

  function renderOverride() {
    const o = state.config.override || {};
    // Asked of the usage directly rather than read off the verdict: a verdict
    // for a site that is not currently blocked carries overridesLeft: 0,
    // which would otherwise be reported as "none left today".
    const left = R.overridesLeft(state.config, state.usage, site.id);

    if (!verdict.blocked) {
      $("override").hidden = true;
      $("tally").textContent = "";
      return;
    }

    if (!verdict.canOverride) {
      $("override").hidden = true;
      $("tally").textContent = !o.enabled
        ? "Overrides are switched off."
        : (left > 0 ? "No override for this kind of block." : "No overrides left today.");
      return;
    }

    $("override").hidden = false;
    $("ov-lede").textContent =
      `${o.grantMinutes} more minutes, after typing a sentence and waiting ${o.delaySeconds} seconds.`;
    $("phrase-target").textContent = o.phrase;
    $("tally").textContent = `${left} override${left === 1 ? "" : "s"} left today`;
  }

  // ---------- the override handshake ----------

  function phraseOk() {
    const want = String((state.config.override || {}).phrase || "").trim().toLowerCase().replace(/\s+/g, " ");
    const got = $("phrase").value.trim().toLowerCase().replace(/\s+/g, " ");
    return !want || want === got;
  }

  function refreshClaimButton() {
    const waited = Date.now() >= readyAt;
    $("ov-claim").disabled = !(waited && phraseOk());
    if (!waited) {
      const s = Math.ceil((readyAt - Date.now()) / 1000);
      ui.replace($("wait"), [el("span", { class: "ring" }), `${s}s — sit with it.`]);
    } else if (!phraseOk()) {
      $("wait").textContent = "Waited. Now type the sentence above.";
    } else {
      $("wait").textContent = "Ready.";
    }
  }

  async function begin() {
    const res = await msg(MSG.OVERRIDE_BEGIN, { siteId });
    if (!res.ok) { $("ov-err").textContent = res.error || "Not available."; return; }
    readyAt = res.readyAt;
    $("ov-start").hidden = true;
    $("ov-form").hidden = false;
    $("phrase").focus();
    clearInterval(ticker);
    ticker = setInterval(refreshClaimButton, 250);
    refreshClaimButton();
  }

  async function claim() {
    $("ov-err").textContent = "";
    const res = await msg(MSG.OVERRIDE_CLAIM, { siteId, phrase: $("phrase").value });
    if (!res.ok) { $("ov-err").textContent = res.error || "Could not unlock."; return; }
    clearInterval(ticker);
    const back = returnUrl();
    if (back) location.replace(back);
    else location.reload();
  }

  async function cancel() {
    await msg(MSG.OVERRIDE_CANCEL, {});
    clearInterval(ticker);
    readyAt = 0;
    $("ov-form").hidden = true;
    $("ov-start").hidden = false;
    $("phrase").value = "";
    $("ov-err").textContent = "";
  }

  // ---------- wiring ----------

  $("close").addEventListener("click", async () => {
    try {
      const tab = await chrome.tabs.getCurrent();
      if (tab) { await chrome.tabs.remove(tab.id); return; }
    } catch (_) { /* fall through */ }
    window.close();
  });

  $("settings").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  $("ov-begin").addEventListener("click", begin);
  $("ov-claim").addEventListener("click", claim);
  $("ov-cancel").addEventListener("click", cancel);
  $("phrase").addEventListener("input", refreshClaimButton);
  $("phrase").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !$("ov-claim").disabled) claim();
  });

  async function load() {
    state = await msg(MSG.GET_STATE, {});
    if (!state || !state.config) return;
    site = R.siteById(state.config, siteId);
    verdict = (state.verdicts && state.verdicts[siteId]) || { blocked: true, reason: params.get("reason") };
    render();

    // If the reason evaporates while you sit here — the clock passed the end
    // of a schedule window, or midnight rolled the counters over — say so
    // rather than leaving a stale wall up.
    if (!verdict.blocked && site) {
      clearInterval(resumeTicker);
      const back = returnUrl();
      $("headline").textContent = `${site.label} is available again`;
      $("lede").textContent = "The block that sent you here has lifted.";
      $("resumes").textContent = "";
      $("override").hidden = true;
      if (back) {
        $("close").textContent = "Go back";
        $("close").onclick = () => location.replace(back);
      }
    }
  }

  load();
  // Cheap re-check so the page notices a reset or a schedule edge on its own.
  setInterval(load, 30000);
})();
