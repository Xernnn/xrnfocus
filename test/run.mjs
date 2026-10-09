// Runs every test/*-test.mjs in its own process and prints one summary.
// Each file is standalone — `node test/rules-test.mjs` works on its own — so
// this only exists to run them all and set a single exit code.
//
// Optional substring filters: `node test/run.mjs rules` runs only the files
// whose name contains "rules".
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const filters = process.argv.slice(2);

const files = readdirSync(here)
  .filter((f) => f.endsWith("-test.mjs"))
  .filter((f) => !filters.length || filters.some((s) => f.includes(s)))
  .sort();

if (!files.length) {
  console.log("no test files matched");
  process.exit(1);
}

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(here, file)], { stdio: "inherit" });
    p.on("close", (code) => resolve(code === 0));
  });
}

let failed = 0;
for (const f of files) if (!(await run(f))) failed++;

console.log("");
console.log(failed ? `${failed} of ${files.length} test file(s) FAILED` : `all ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
