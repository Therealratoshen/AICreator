/**
 * The cost calculator's test.
 *
 * The number "one plan costs under two cents" is a claim a judge will check by
 * multiplying. This test checks the multiplication, so the claim cannot drift
 * away from the arithmetic.
 *
 * It also pins the prices to Baseten's published rates, so a change to them
 * has to be a deliberate edit here too - not a silent drift.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-cost.ts
 */

import { costOfRun, PRICES, ASSUMED_USD_IDR, ESTIMATED_WEEKLY_RUN } from "./cost.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

console.log("test-cost\n");

console.log("# 1. the prices are Baseten's published rates (per million tokens)");
check("the input price is $1.25", PRICES.input === 1.25, String(PRICES.input));
check("the cached input price is $0.15", PRICES.cachedInput === 0.15, String(PRICES.cachedInput));
check("the output price is $4.25", PRICES.output === 4.25, String(PRICES.output));

console.log("\n# 2. the arithmetic");
{
  // 1,000,000 input tokens at $1.25/M = $1.25 exactly
  const c = costOfRun({ inputTokens: 1_000_000, outputTokens: 0 });
  check("1M input tokens cost $1.25", Math.abs(c.usd - 1.25) < 1e-9, String(c.usd));

  // 1,000,000 output tokens at $4.25/M = $4.25 exactly
  const o = costOfRun({ inputTokens: 0, outputTokens: 1_000_000 });
  check("1M output tokens cost $4.25", Math.abs(o.usd - 4.25) < 1e-9, String(o.usd));

  // 1,000,000 cached input tokens at $0.15/M = $0.15 exactly
  const k = costOfRun({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000 });
  check("1M cached input tokens cost $0.15", Math.abs(k.usd - 0.15) < 1e-9, String(k.usd));

  // nothing in, nothing out = free
  const z = costOfRun({ inputTokens: 0, outputTokens: 0 });
  check("an empty run costs nothing", z.usd === 0, String(z.usd));
}

console.log("\n# 3. the caching split is right");
{
  // half cached: 500k uncached at 1.25 + 500k cached at 0.15 = 0.625 + 0.075 = 0.70
  const c = costOfRun({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 500_000 });
  check("a half-cached 1M input costs $0.70", Math.abs(c.usd - 0.70) < 1e-9, String(c.usd));

  // a cached count larger than the input must not produce a negative bill
  const over = costOfRun({ inputTokens: 100, outputTokens: 0, cachedInputTokens: 5_000 });
  check("an over-reported cached count cannot go negative", over.usd >= 0, String(over.usd));
  check("an over-reported cached count bills only the real input", over.usd <= (100 / 1e6) * 1.25 + 1e-12, String(over.usd));
}

console.log("\n# 4. 🔴 the claim in the README, checked");
{
  const c = costOfRun(ESTIMATED_WEEKLY_RUN);
  check(
    "one weekly plan costs LESS THAN TWO CENTS",
    c.usd < 0.02,
    `it costs $${c.usd.toFixed(6)} - the README's "under two cents" claim would be FALSE`,
  );
  check(
    "one weekly plan costs more than a tenth of a cent (the arithmetic is not degenerate)",
    c.usd > 0.001,
    String(c.usd),
  );
  // and the IDR figure is the usd figure at the stated rate
  const expectedIdr = Math.round(c.usd * ASSUMED_USD_IDR);
  check("the IDR figure is the USD figure at the assumed rate", c.idr === expectedIdr, `${c.idr} vs ${expectedIdr}`);
  check("the IDR figure is in the hundreds of rupiah", c.idr > 100 && c.idr < 1000, String(c.idr));
}

console.log("\n# 5. the breakdown can be checked by hand");
{
  const c = costOfRun(ESTIMATED_WEEKLY_RUN);
  const sum = c.breakdown.reduce((a, b) => a + b.usd, 0);
  check("the breakdown sums to the total", Math.abs(sum - c.usd) < 1e-12, `${sum} vs ${c.usd}`);
  check("the breakdown has the uncached input line", c.breakdown.some((b) => b.label.includes("uncached")));
  check("the breakdown has the output line", c.breakdown.some((b) => b.label.includes("output")));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} test-cost — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
