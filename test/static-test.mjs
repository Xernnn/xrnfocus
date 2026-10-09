// Structural checks that need no browser and no network.
//
// The bug this exists to catch: adding a site to DEFAULT_CONFIG is FOUR edits
// — the sites array, host_permissions, content_scripts.matches and
// BUILTIN_DOMAINS — and missing any one of them produces an extension that
// looks configured and silently never sees the site.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { loadShared, ok, eq, done, ROOT } from "./harness.mjs";

const NS = loadShared();
const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

// ---------- every referenced file exists ----------

const referenced = [
  manifest.background.service_worker,
  ...manifest.background.scripts,
  ...manifest.content_scripts.flatMap((c) => [...(c.js || []), ...(c.css || [])]),
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...manifest.web_accessible_resources.flatMap((w) => w.resources)
];

for (const rel of referenced) {
  ok(existsSync(join(ROOT, rel)), `manifest references a file that exists: ${rel}`);
}

// ---------- every <script src> / <link href> resolves ----------

for (const page of [manifest.action.default_popup, manifest.options_ui.page, NS.BLOCK_PAGE]) {
  const html = readFileSync(join(ROOT, page), "utf8");
  const base = dirname(join(ROOT, page));
  const refs = [
    ...html.matchAll(/<script[^>]+src="([^"]+)"/g),
    ...html.matchAll(/<link[^>]+href="([^"]+)"/g)
  ].map((m) => m[1]);
  ok(refs.length > 0, `${page} references at least one asset`);
  for (const r of refs) {
    ok(existsSync(join(base, r)), `${page} → ${r} exists`);
  }
}

// ---------- shared/constants.js must load first everywhere ----------
// Every other script reads self.XrnFocus at top level, so a list that puts
// them first throws on startup and takes the whole context down with it.

for (const entry of manifest.content_scripts) {
  eq(entry.js[0], "shared/constants.js", "content_scripts loads constants.js first");
}
eq(manifest.background.scripts[0], "shared/constants.js", "background scripts load constants.js first");

for (const page of [manifest.action.default_popup, manifest.options_ui.page, NS.BLOCK_PAGE]) {
  const html = readFileSync(join(ROOT, page), "utf8");
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
  ok(/constants\.js$/.test(scripts[0] || ""), `${page} loads constants.js first`);
}

// ---------- the four-edit rule ----------

const builtinSites = NS.DEFAULT_CONFIG.sites.filter((s) => s.builtin);
const builtinDomains = builtinSites.flatMap((s) => s.domains);

// Pull the bare domain out of each "*://*.domain/*" pattern.
function domainsOf(patterns) {
  return new Set(
    patterns
      .map((p) => /^\*:\/\/\*\.([^/]+)\/\*$/.exec(p))
      .filter(Boolean)
      .map((m) => m[1])
  );
}

const permitted = domainsOf(manifest.host_permissions);
const scripted = domainsOf(manifest.content_scripts.flatMap((c) => c.matches));

for (const d of builtinDomains) {
  ok(permitted.has(d), `host_permissions covers ${d}`);
  ok(scripted.has(d), `a content script runs on ${d}`);
  ok(NS.BUILTIN_DOMAINS.includes(d), `BUILTIN_DOMAINS lists ${d}`);
}

// …and nothing declared that no site actually uses, which would be an
// unnecessary permission prompt at install time.
for (const d of permitted) {
  ok(builtinDomains.includes(d), `host_permissions has no orphan: ${d}`);
}
eq(
  [...NS.BUILTIN_DOMAINS].sort(),
  [...new Set(builtinDomains)].sort(),
  "BUILTIN_DOMAINS is exactly the built-in sites' domains"
);

// ---------- default config sanity ----------

const ids = NS.DEFAULT_CONFIG.sites.map((s) => s.id);
eq(ids.length, new Set(ids).size, "site ids are unique");

for (const s of NS.DEFAULT_CONFIG.sites) {
  ok(s.label && s.id, `${s.id} has an id and a label`);
  ok(Array.isArray(s.domains) && s.domains.length, `${s.id} names at least one domain`);
  ok(s.schedule && typeof s.schedule.mode === "string", `${s.id} has a schedule object`);
  // An exclusion that is not under one of the site's own domains can never
  // fire, so it is always a typo.
  for (const ex of s.exclude || []) {
    ok(s.domains.some((d) => NS.rules.hostMatches(ex, d)), `${s.id} exclusion "${ex}" is under one of its domains`);
  }
}

const yt = NS.DEFAULT_CONFIG.sites.find((s) => s.id === "youtube");
ok(yt.exclude.includes("music.youtube.com"), "YouTube ships with music excluded");
eq(yt.inPool, false, "YouTube ships outside the shared pool");
ok(NS.DEFAULT_CONFIG.sites.filter((s) => s.inPool).length >= 2, "the pool ships with sites in it");


// ---------- sessions and the corner clock ----------

for (const site of NS.DEFAULT_CONFIG.sites) {
  const ses = site.session;
  ok(ses && typeof ses.enabled === "boolean", `${site.id} has a session rule`);
  ok(Number(ses.workMinutes) > 0, `${site.id} session has a positive work length`);
  ok(Number(ses.breakMinutes) > 0, `${site.id} session has a positive break length`);
}

ok(NS.DEFAULT_CONFIG.clock && typeof NS.DEFAULT_CONFIG.clock.enabled === "boolean", "there is a clock setting");
ok(typeof NS.DEFAULT_CONFIG.override.forBreaks === "boolean", "overrides say whether they cover a break");

// The clock's position is a config string that becomes a CSS class in the
// content script AND a dropdown option on the settings page. Three places
// that must agree, and nothing else would notice if they stopped.
const contentSrc = readFileSync(join(ROOT, "content/content.js"), "utf8");
const cssPositions = new Set(
  [...contentSrc.matchAll(/\.clock\.pos-([a-z-]+)\s*\{/g)].map((m) => m[1])
);
const optionsSrc = readFileSync(join(ROOT, "options/options.html"), "utf8");
const selectBlock = /id="clockPosition"[\s\S]*?<\/select>/.exec(optionsSrc);
ok(selectBlock, "the settings page has a clock-position dropdown");
const uiPositions = new Set(
  [...selectBlock[0].matchAll(/value="([a-z-]+)"/g)].map((m) => m[1])
);

eq([...cssPositions].sort(), [...uiPositions].sort(),
   "every clock position offered in settings has a CSS rule, and vice versa");
ok(cssPositions.has(NS.DEFAULT_CONFIG.clock.position),
   `the default clock position (${NS.DEFAULT_CONFIG.clock.position}) is one the CSS knows`);

// Every reason the rules can produce needs wording on the block page, or it
// falls through to a generic "this site is blocked right now".
const blockSrc = readFileSync(join(ROOT, "block/block.js"), "utf8");
for (const reason of Object.keys(NS.REASON)) {
  ok(blockSrc.includes(`NS.REASON.${reason}`), `the block page has wording for REASON.${reason}`);
}
const popupSrc = readFileSync(join(ROOT, "popup/popup.js"), "utf8");
for (const reason of ["SCHEDULE", "POOL", "BREAK"]) {
  ok(popupSrc.includes(`NS.REASON.${reason}`), `the popup labels REASON.${reason}`);
}

// ---------- block page reachability ----------

const war = manifest.web_accessible_resources.flatMap((w) => w.resources);
ok(war.includes(NS.BLOCK_PAGE), "the block page is web-accessible (a DNR redirect needs it to be)");

// ---------- permissions actually used ----------

for (const p of ["storage", "alarms", "idle", "scripting", "declarativeNetRequest"]) {
  ok(manifest.permissions.includes(p), `declares the ${p} permission`);
}
ok(!manifest.permissions.includes("tabs"),
   "does NOT ask for the broad tabs permission — host permissions already cover the tracked sites");

done("static-test");
