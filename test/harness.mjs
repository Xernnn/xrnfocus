// Minimal assert harness + a loader for the shared/ classic scripts.
//
// shared/constants.js and shared/rules.js are plain scripts that hang
// everything off `self`, which is exactly what makes them loadable here: a vm
// context with a `self` object is a complete stand-in for a browser, with no
// chrome.* stub needed, because rules.js is pure by construction.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export function loadShared() {
  // URL is a host global, not an ECMAScript intrinsic, so a fresh vm context
  // does not have one — and rules.js parses every URL through it.
  const ctx = { self: {}, console, URL, URLSearchParams };
  vm.createContext(ctx);
  for (const f of ["shared/constants.js", "shared/rules.js"]) {
    vm.runInContext(readFileSync(join(root, f), "utf8"), ctx, { filename: f });
  }
  return ctx.self.XrnFocus;
}

export const ROOT = root;

let passed = 0;
const failures = [];

export function ok(cond, label) {
  if (cond) passed++;
  else failures.push(label);
}

export function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) passed++;
  else failures.push(`${label}\n      expected ${b}\n      got      ${a}`);
}

export function done(name) {
  if (failures.length) {
    console.log(`FAIL ${name} — ${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(`PASS ${name} — ${passed} assertions`);
}

// A local Date built from parts, so every time-of-day assertion means the same
// thing regardless of the machine's timezone.
export function at(y, m, d, hh, mm) {
  return new Date(y, m - 1, d, hh, mm, 0, 0).getTime();
}
