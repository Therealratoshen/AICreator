/**
 * The no-fakes guard's test.
 *
 * This is the test that proves the project's central claim: **no number
 * reaches a human unless a row in the database says it.**
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-no-fakes.ts
 */

import { checkNoFakes } from "../src/agent/no-fakes.ts";
import type { CampaignPlan } from "../src/agent/campaign-plan.ts";

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

const ROWS = new Map([
  ["row_post_1", { id: "row_post_1", value: 4820, table: "brand_instagram_posts" }],
  ["row_aud_1", { id: "row_aud_1", value: 310, table: "creator_audience_snapshots" }],
]);

const HONEST: CampaignPlan = {
  weekOf: "2026-11-02",
  cadencePerWeek: 2,
  creatorShortlist: [
    { creatorId: "kol_aria", reason: "median views 4,820 over 90 days", justifyingMetric: 4820 },
    { creatorId: "kol_budi", reason: "median saves 310, the highest here", justifyingMetric: 310 },
  ],
  contentBriefs: [
    { creatorId: "kol_aria", objective: "introduce", hook: "3 weeks, one routine", cta: "bio", imageCount: 2 },
    { creatorId: "kol_budi", objective: "texture", hook: "no filter", cta: "bio", imageCount: 1 },
  ],
  citedMetrics: [
    { metric: "median_views_90d", sourceRowId: "row_post_1", value: 4820 },
    { metric: "median_saves_90d", sourceRowId: "row_aud_1", value: 310 },
  ],
  notes: "post twice in week one.",
};

console.log("test-no-fakes\n");

console.log("# 1. an honest plan passes");
{
  const r = checkNoFakes(HONEST, ROWS);
  check("the honest plan passes the guard", r.ok, JSON.stringify((r as any).errors));
}

console.log("\n# 2. a fabricated row is caught");
{
  const liar = structuredClone(HONEST);
  liar.citedMetrics[0].sourceRowId = "row_that_does_not_exist";
  const r = checkNoFakes(liar, ROWS);
  check("the plan with an invented row is rejected", !r.ok);
  check(
    "the error names the invented row",
    (r as any).errors.some((e: string) => e.includes("row_that_does_not_exist")),
    JSON.stringify((r as any).errors),
  );
}

console.log("\n# 3. 🔴 a RIGHT row with the WRONG value is caught");
{
  // This is the subtle case: the row exists, the number is real - but the plan
  // says something different from what the row holds. A model that rounds, or
  // that mixes up two rows, lands here.
  const liar = structuredClone(HONEST);
  liar.citedMetrics[0].value = 9999;
  const r = checkNoFakes(liar, ROWS);
  check("the plan with a wrong value is rejected", !r.ok);
  check(
    "the error names both the claimed and the real value",
    (r as any).errors.some((e: string) => e.includes("9999") && e.includes("4820")),
    JSON.stringify((r as any).errors),
  );
}

console.log("\n# 4. a justifying metric with no real row is caught");
{
  // The shortlist's reason cites a number that no cited metric supports.
  const liar = structuredClone(HONEST);
  liar.creatorShortlist[0].justifyingMetric = 777777;
  const r = checkNoFakes(liar, ROWS);
  check("the plan with an unsupported justification is rejected", !r.ok);
  check(
    "the error names the creator and the number",
    (r as any).errors.some((e: string) => e.includes("kol_aria") && e.includes("777777")),
    JSON.stringify((r as any).errors),
  );
}

console.log("\n# 5. every error is reported at once, not one per round trip");
{
  const liar = structuredClone(HONEST);
  liar.citedMetrics[0].sourceRowId = "row_invented";
  liar.citedMetrics[1].value = 1;
  const r = checkNoFakes(liar, ROWS);
  check("the plan is rejected", !r.ok);
  check("both problems are reported", (r as any).errors.length >= 2, JSON.stringify((r as any).errors));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} test-no-fakes — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
