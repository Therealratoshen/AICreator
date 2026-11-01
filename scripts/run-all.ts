/**
 * Run every test. This is the ONE command you need.
 *
 *   npm test
 *
 * It runs each test in its own process, so a crash in one cannot hide the
 * others' results, and it prints a single PASS/FAIL line at the end.
 */

import { spawnSync } from "node:child_process";

const TESTS = [
  "scripts/test-plan-validator.ts",
  "scripts/test-copilot-loop.ts",
  "scripts/test-no-fakes.ts",
  "scripts/test-cost.ts",
  "scripts/test-planner.ts",
  "scripts/test-writer.ts",
  "scripts/test-claims.ts",
  "scripts/test-reviewer.ts",
  "scripts/test-orchestrator.ts",
  "scripts/test-web.ts",
];

let failed = 0;
let total = 0;
const summary: string[] = [];

for (const t of TESTS) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", t],
    { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const m = out.match(/^(PASS|FAIL)\s+(\S+)\s+—\s+(\d+) passed, (\d+) failed/m);
  const n = m ? Number(m[3]) : 0;
  if (r.status === 0) {
    total += n;
    console.log(`  PASS  ${t}${m ? `  (${n} assertions)` : ""}`);
    summary.push(`${t}: PASS — ${n} passed, ${m ? m[4] : 0} failed`);
  } else {
    failed++;
    console.log(`  FAIL  ${t}`);
    console.log(out.split("\n").filter((l) => l.includes("FAIL")).slice(0, 10).map((l) => `        ${l}`).join("\n"));
    summary.push(`${t}: FAIL`);
  }
}

console.log("");
if (failed === 0) {
  console.log(`PASS — every guard holds. ${total} assertions.`);
  for (const s of summary) console.log(`  ${s}`);
  process.exit(0);
}
console.log(`FAIL — ${failed} test file(s) failed.`);
for (const s of summary) console.log(`  ${s}`);
process.exit(1);
