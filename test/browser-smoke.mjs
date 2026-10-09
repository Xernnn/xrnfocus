// A real browser, driven over CDP. NOT part of `npm test` — it needs a
// Chromium binary and takes half a minute — but it is the only thing that
// catches what the stub cannot:
//
//   * Chrome REJECTS a malformed declarativeNetRequest rule silently. The
//     stub accepts any shape.
//   * Whether a navigation to a blocked host is actually redirected.
//   * Whether the content script injects, and whether the corner clock
//     renders and counts down.
//   * Whether an extension page throws once it is actually running.
//
// Run:  npm run smoke          (or: BROWSER=/path/to/chrome npm run smoke)
//
// Read test/README.md before changing the launch flags — the host mapping
// and the TLS server are both working around browser behaviour that fails
// in ways that give you no clue what went wrong.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:https";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 9421, WEB = 9422;

const CANDIDATES = [
  process.env.BROWSER,
  "/opt/helium-browser-bin/helium",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/brave"
].filter(Boolean);
const BROWSER = CANDIDATES.find((p) => existsSync(p));

if (!BROWSER) {
  console.log("SKIP browser-smoke — no Chromium binary found (set BROWSER=/path/to/chrome)");
  process.exit(0);
}
if (!spawnSync("openssl", ["version"]).status === 0) {
  console.log("SKIP browser-smoke — openssl not available");
  process.exit(0);
}

// ---------- assertions ----------
let passed = 0;
const failures = [];
const ok = (c, label) => (c ? passed++ : failures.push(label));
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

// ---------- CDP ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, label, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try { const v = await fn(); if (v) return v; } catch (_) {}
    await sleep(500);
  }
  throw new Error("timed out waiting for " + label);
}
function cdp(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else events.push(m);
  });
  const ready = new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  const send = (method, params = {}) =>
    new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
  return {
    ready, events, send,
    close: () => ws.close(),
    errors: () => events
      .filter((e) => e.method === "Runtime.exceptionThrown" ||
                     (e.method === "Log.entryAdded" && e.params.entry.level === "error"))
      .map((e) => (e.params.exceptionDetails?.exception?.description || e.params.entry?.text || "").slice(0, 200)),
    async eval(expression, opts = {}) {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, ...opts });
      if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 400));
      return r.result.result.value;
    }
  };
}

// ---------- a stand-in for a tracked site ----------
const profile = mkdtempSync(join(tmpdir(), "xrnfocus-smoke-"));
spawnSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-keyout", join(profile, "key.pem"),
  "-out", join(profile, "cert.pem"), "-days", "1", "-nodes", "-subj", "/CN=www.reddit.com"
], { stdio: "ignore" });

const PAGE = `<!doctype html><meta charset=utf-8><title>r/test</title>
<body style="font:16px system-ui;background:#dae0e6"><h1>feed</h1><p>stand-in page</p>`;
const web = createServer(
  { key: readFileSync(join(profile, "key.pem")), cert: readFileSync(join(profile, "cert.pem")) },
  (_, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(PAGE); }
);
await new Promise((r) => web.listen(WEB, "127.0.0.1", r));

const proc = spawn(BROWSER, [
  "--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${join(profile, "prof")}`,
  `--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`,
  // No space after the comma, or the whole rule is discarded silently.
  `--host-resolver-rules=MAP *.reddit.com 127.0.0.1:${WEB},MAP reddit.com 127.0.0.1:${WEB}`,
  "--ignore-certificate-errors",
  "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--disable-gpu",
  "--window-size=900,680", "about:blank"
], { stdio: ["ignore", "ignore", "ignore"] });

const shots = process.env.SHOTS || null;

try {
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok, "the devtools endpoint");

  // ---- 1. the service worker boots clean ----
  const swTarget = await waitFor(async () => {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    return list.find((t) => t.type === "service_worker" && t.url.includes("background/background.js"));
  }, "the service worker");
  const extId = new URL(swTarget.url).host;

  const sw = cdp(swTarget.webSocketDebuggerUrl);
  await sw.ready;
  await sw.send("Runtime.enable");
  await sw.send("Log.enable");
  await sleep(1500);
  eq(sw.errors(), [], "the service worker starts with no errors");
  ok(await sw.eval("!!self.XrnFocus && !!self.XrnFocus.rules"), "the shared layer loaded in the worker");
  eq(await sw.eval("(async () => (await chrome.alarms.getAll()).map(a => a.name))()"), ["bs-tick"], "the tick alarm is registered");

  // ---- 2. every extension page renders without throwing ----
  async function openPage(path) {
    const t = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
    const c = cdp(t.webSocketDebuggerUrl);
    await c.ready;
    await c.send("Runtime.enable");
    await c.send("Log.enable");
    await c.send("Page.enable");
    await c.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await c.send("Page.bringToFront");
    // Created blank then navigated: /json/new?<url> is unreliable here.
    await c.send("Page.navigate", { url: path });
    await sleep(2000);
    return { target: t, c };
  }

  for (const [name, path] of [
    ["options", `chrome-extension://${extId}/options/options.html`],
    ["popup", `chrome-extension://${extId}/popup/popup.html`]
  ]) {
    const { target, c } = await openPage(path);
    eq(c.errors(), [], `the ${name} page renders with no console error`);
    ok((await c.eval("document.body.innerText")).length > 40, `the ${name} page has content`);
    c.close();
    await fetch(`http://127.0.0.1:${PORT}/json/close/${target.id}`);
  }

  // ---- 3. the content script, the corner clock ----
  const { target: siteTab, c: page } = await openPage("https://www.reddit.com/r/test");
  const readClock = () => page.eval(`(() => {
    const h = document.getElementById('xrnfocus-host');
    if (!h || !h.shadowRoot) return { present: false };
    const n = h.shadowRoot.querySelector('.clock');
    return { present: true, cls: n.className, time: n.querySelector('.t')?.textContent,
             label: n.querySelector('.lbl')?.textContent, title: n.title,
             visible: getComputedStyle(n).display !== 'none' };
  })()`);

  const first = await readClock();
  ok(first.present && first.visible, "the corner clock appears on a tracked page");
  ok(/pos-bottom-right/.test(first.cls || ""), "…in the configured corner");
  await sleep(4000);
  const second = await readClock();
  ok(first.time !== second.time, "…and counts down");
  ok((second.title || "").includes("left today"), "…with the full picture in its tooltip");
  eq(page.errors(), [], "the content script throws nothing");
  if (shots) {
    const s = await page.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(shots, "clock.png"), Buffer.from(s.result.data, "base64"));
  }

  // ---- 4. a forced break, and the DNR rule behind it ----
  // A one-minute stretch parked 5s short of its end.
  await sw.eval(`(async () => {
    const S = self.XrnFocus.STORAGE, R = self.XrnFocus.rules;
    const cfg = await getConfig();
    for (const s of cfg.sites) { s.limitMinutes = 0; s.session = { enabled: true, workMinutes: 1, breakMinutes: 1 }; }
    cfg.pool.enabled = false;
    await setConfig(cfg);
    const now = Date.now();
    await chrome.storage.local.set({ [S.USAGE]: {
      dayKey: R.dayKeyFor(now, cfg.resetHour),
      sites: { reddit: { ms: 0, overrides: 0, overrideUntil: 0, sessionMs: 55000, lastSeenAt: now, breakUntil: 0 } },
      poolMs: 0, overridesUsed: 0
    }});
    await reconcile({ force: true });
  })()`);

  await page.send("Page.navigate", { url: "https://www.reddit.com/r/test" });
  const landedUrl = await waitFor(async () => {
    const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = l.find((x) => x.id === siteTab.id);
    return t && t.url.includes("block/block.html") ? t.url : null;
  }, "the forced break", 40);
  ok(/reason=break/.test(landedUrl), "a long stretch forces a break");

  const rules = await sw.eval("(async () => (await chrome.declarativeNetRequest.getSessionRules()).map(r => ({ d: r.condition.requestDomains, x: r.condition.excludedRequestDomains || null, t: r.condition.resourceTypes })))()");
  ok(rules.length > 0, "Chrome accepted the DNR rules (it rejects malformed ones silently)");
  const ytRule = rules.find((r) => (r.d || []).includes("youtube.com"));
  if (ytRule) eq(ytRule.x, ["music.youtube.com"], "the YouTube rule still exempts music at the network layer");
  ok(rules.every((r) => JSON.stringify(r.t) === JSON.stringify(["main_frame"])), "…and only touches top-level navigations");

  // ---- 5. the block page in its break state ----
  const bpTarget = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((x) => x.id === siteTab.id);
  const bp = cdp(bpTarget.webSocketDebuggerUrl);
  await bp.ready;
  await bp.send("Runtime.enable");
  await bp.send("Log.enable");
  await bp.send("Page.enable");
  await sleep(2000);
  const view = await bp.eval(`({
    headline: document.getElementById('headline').textContent,
    lede: document.getElementById('lede').textContent,
    resumes: document.getElementById('resumes').textContent,
    overrideShown: !document.getElementById('override').hidden
  })`);
  eq(bp.errors(), [], "the block page renders with no console error");
  ok(/Take a break/.test(view.headline), "the break has its own headline");
  ok(/1 minute off/.test(view.lede), "…and says how long, in English");
  ok(/Back in/.test(view.resumes), "…with a countdown rather than a clock time");
  eq(view.overrideShown, false, "a break offers no override, since forBreaks ships off");
  await sleep(2200);
  ok((await bp.eval("document.getElementById('resumes').textContent")) !== view.resumes, "…and that countdown is live");
  if (shots) {
    const s = await bp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(shots, "break.png"), Buffer.from(s.result.data, "base64"));
  }
  bp.close();

  // ---- 6. options edits survive consecutive saves ----
  // Regression: the page used to swap its config object after the first
  // save, orphaning every site-card closure, and drop the second edit.
  const { target: optTab, c: opt } = await openPage(`chrome-extension://${extId}/options/options.html`);
  const setCap = (v) => opt.eval(`(() => {
    const card = [...document.querySelectorAll('.site')].find(s => s.querySelector('.s-label').textContent === 'Reddit');
    const i = card.querySelector('.s-limit');
    i.value = '${v}'; i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const storedCap = () => opt.eval(`(async () => {
    const c = (await chrome.storage.sync.get('bs_config')).bs_config;
    return c.sites.find(s => s.id === 'reddit').limitMinutes;
  })()`);

  await setCap(7); await sleep(1400);
  eq(await storedCap(), 7, "the first options edit is saved");
  await setCap(9); await sleep(1400);
  eq(await storedCap(), 9, "the second edit to the same field is saved too");
  await setCap(11); await sleep(1400);
  eq(await storedCap(), 11, "and the third");
  eq(opt.errors(), [], "the options page throws nothing while editing");
  opt.close();
  await fetch(`http://127.0.0.1:${PORT}/json/close/${optTab.id}`);

  page.close();
  sw.close();
} catch (e) {
  failures.push("fatal: " + String((e && e.stack) || e));
} finally {
  proc.kill("SIGKILL");
  web.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
}

if (failures.length) {
  console.log(`FAIL browser-smoke — ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`PASS browser-smoke — ${passed} assertions`);
