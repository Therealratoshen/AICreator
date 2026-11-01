/**
 * The writer's test.
 *
 * The writer is agent 2, and it is the agent that can undo the planner.
 *
 * `AGENTS.md` invariant 5 keeps `submit_campaign_plan` as the single exit, so
 * the writer emits a whole plan - which means it re-states the week, the
 * cadence and the creator list that the planner already decided. Every one of
 * those is a way to silently reprioritise a campaign that was agreed on the
 * evidence.
 *
 * So the first half of this file is conformance: five mutations of a
 * known-good plan, each breaking exactly one decision, each asserting the
 * exact error.
 *
 * The second half is the claim scan, because the writer is also the agent that
 * puts sentences in front of a customer. A number written inside a hook is
 * invisible to `checkNoFakes`, which only reads `citedMetrics` - so it is
 * tested here, where it can actually be caught.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-writer.ts
 */

import { runWriter, scanPlanCopy } from "../src/agent/writer.ts";
import type { ChatClient } from "../src/agent/copilot.ts";
import type { CampaignStrategy } from "../src/agent/strategy.ts";
import type { BrandDataset } from "../src/agent/dataset.ts";

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

const DATASET: BrandDataset = {
  brandName: "Sereh",
  niche: "skincare",
  windowDays: 90,
  rows: [
    {
      rowId: "brand_reach_90d",
      table: "brand_instagram_accounts",
      metric: "reach_90d",
      value: 41200,
      subject: "Sereh",
      label: "accounts reached in the last 90 days",
    },
    {
      rowId: "kol_aria_views",
      table: "creator_audience_snapshots",
      metric: "median_views_90d",
      value: 4820,
      subject: "kol_aria",
      label: "median views per post, 90 days",
    },
    {
      rowId: "kol_aria_saves",
      table: "creator_audience_snapshots",
      metric: "median_saves_90d",
      value: 610,
      subject: "kol_aria",
      label: "median saves per post, 90 days",
    },
    {
      rowId: "kol_bima_views",
      table: "creator_audience_snapshots",
      metric: "median_views_90d",
      value: 12900,
      subject: "kol_bima",
      label: "median views per post, 90 days",
    },
    {
      rowId: "kol_citra_views",
      table: "creator_audience_snapshots",
      metric: "median_views_90d",
      value: 7300,
      subject: "kol_citra",
      label: "median views per post, 90 days",
    },
  ],
  creators: [
    { creatorId: "kol_aria", handle: "@aria.rawat", niche: "skincare" },
    { creatorId: "kol_bima", handle: "@bima.gerak", niche: "fitness" },
    // Exists in the data but is NOT in the strategy - so shortlisting it is a
    // decision the writer is not allowed to make.
    { creatorId: "kol_citra", handle: "@citra.kulit", niche: "skincare" },
    // Exists as a creator, has no rows. Nothing can be written for her.
    { creatorId: "kol_dewi", handle: "@dewi.putih", niche: "skincare" },
  ],
};

const STRATEGY: CampaignStrategy = {
  weekOf: "2026-11-02",
  cadencePerWeek: 2,
  creatorIds: ["kol_aria", "kol_bima"],
  angle: "show the routine being used on a normal weeknight, not in a studio",
  rationale: [
    { creatorId: "kol_aria", metric: "median_saves_90d", sourceRowId: "kol_aria_saves", value: 610 },
    { creatorId: "kol_bima", metric: "median_views_90d", sourceRowId: "kol_bima_views", value: 12900 },
  ],
  constraints: ["no before-and-after skin claims", "no price claims"],
};

const GOOD_PLAN = {
  weekOf: "2026-11-02",
  cadencePerWeek: 2,
  creatorShortlist: [
    { creatorId: "kol_aria", reason: "median 610 saves per post over 90 days", justifyingMetric: 610 },
    { creatorId: "kol_bima", reason: "median 12900 views per post over 90 days", justifyingMetric: 12900 },
  ],
  contentBriefs: [
    {
      creatorId: "kol_aria",
      objective: "show the two-step evening routine",
      hook: "rutinitas dua langkah sebelum tidur",
      cta: "simpan untuk nanti",
      imageCount: 2,
    },
    {
      creatorId: "kol_bima",
      objective: "show the same routine after training",
      hook: "pagi yang sederhana sebelum latihan",
      cta: "coba minggu ini",
      imageCount: 3,
    },
  ],
  citedMetrics: [
    { metric: "median_saves_90d", sourceRowId: "kol_aria_saves", value: 610 },
    { metric: "median_views_90d", sourceRowId: "kol_bima_views", value: 12900 },
  ],
  notes: "dua posting per kreator minggu ini.",
};

function scriptedClient(replies: { args?: unknown; raw?: string; prose?: string }[]) {
  const seen: any[] = [];
  let i = 0;
  const client: ChatClient = {
    async complete({ messages }) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      const r = replies[Math.min(i, replies.length - 1)];
      i++;
      if (r.prose !== undefined) return { content: r.prose };
      const raw = r.raw ?? JSON.stringify(r.args);
      return {
        tool_calls: [
          { id: `call_${i}`, function: { name: "submit_campaign_plan", arguments: raw } },
        ],
      };
    },
  };
  return { client, seen };
}

function writerRun(
  replies: { args?: unknown; raw?: string; prose?: string }[],
  strategy: CampaignStrategy = STRATEGY,
  maxAttempts = 2,
) {
  const { client, seen } = scriptedClient(replies);
  return {
    seen,
    run: runWriter({
      client,
      strategy,
      dataset: DATASET,
      brief: "plan the week",
      maxAttempts,
    }),
  };
}

const errorsOf = (r: { transcript: { errors?: string[] }[] }, i = 0) => r.transcript[i]?.errors ?? [];

console.log("test-writer\n");

// ---------------------------------------------------------------- 1. happy path
console.log("# 1. a plan that keeps the strategy is accepted");
{
  const r = await writerRun([{ args: GOOD_PLAN }]).run;
  check("the run succeeded", r.ok, JSON.stringify(r.errors));
  check("a plan came back", !!r.plan);
  check("it took one attempt", r.attempts === 1, String(r.attempts));
  check("no warnings on clean copy", r.warnings.length === 0, JSON.stringify(r.warnings));
  check("the transcript records the acceptance", r.transcript[0]?.action === "tool_accepted");
}

// ---------------------------------------------------------------- 2. the week
console.log("\n# 2. a different week is rejected - the week was already decided");
{
  const r = await writerRun([{ args: { ...GOOD_PLAN, weekOf: "2026-11-09" } }]).run;
  check("the run failed", !r.ok);
  check("NO plan was returned", r.plan === undefined);
  check(
    "the error names both weeks",
    errorsOf(r).some((e) => e.includes("2026-11-09") && e.includes("2026-11-02")),
    JSON.stringify(errorsOf(r)),
  );
  check(
    "the error says the week is fixed",
    errorsOf(r).some((e) => e.includes("Do not change it")),
  );
}

// ---------------------------------------------------------------- 3. the cadence
console.log("\n# 3. a different cadence is rejected");
{
  const r = await writerRun([{ args: { ...GOOD_PLAN, cadencePerWeek: 5 } }]).run;
  check("the run failed", !r.ok);
  check(
    "the error names both cadences",
    errorsOf(r).some((e) => e.includes("5") && e.includes("2") && e.includes("cadencePerWeek")),
    JSON.stringify(errorsOf(r)),
  );
}

// ---------------------------------------------------------------- 4. dropped creator
console.log("\n# 4. dropping a shortlisted creator is rejected");
{
  const dropped = {
    ...GOOD_PLAN,
    creatorShortlist: [GOOD_PLAN.creatorShortlist[0]],
    contentBriefs: [GOOD_PLAN.contentBriefs[0]],
  };
  const r = await writerRun([{ args: dropped }]).run;
  check("the run failed", !r.ok);
  check(
    "the error names the dropped creator",
    errorsOf(r).some((e) => e.includes("kol_bima") && e.includes("missing")),
    JSON.stringify(errorsOf(r)),
  );
}

// ---------------------------------------------------------------- 5. added creator
console.log("\n# 5. shortlisting a creator the planner did not choose is rejected");
{
  const added = {
    ...GOOD_PLAN,
    creatorShortlist: [
      ...GOOD_PLAN.creatorShortlist,
      { creatorId: "kol_citra", reason: "median 7300 views", justifyingMetric: 7300 },
    ],
    contentBriefs: [
      ...GOOD_PLAN.contentBriefs,
      {
        creatorId: "kol_citra",
        objective: "show the routine",
        hook: "kulit yang lembap",
        cta: "coba sekarang",
        imageCount: 2,
      },
    ],
    citedMetrics: [
      ...GOOD_PLAN.citedMetrics,
      { metric: "median_views_90d", sourceRowId: "kol_citra_views", value: 7300 },
    ],
  };
  const r = await writerRun([{ args: added }]).run;
  check("the run failed", !r.ok);
  check(
    "the error says the writer cannot shortlist",
    errorsOf(r).some((e) => e.includes("kol_citra") && e.includes("cannot shortlist")),
    JSON.stringify(errorsOf(r)),
  );
}

// ---------------------------------------------------------------- 6. reordered
console.log("\n# 6. reordering the shortlist is rejected - order is a decision");
{
  const reordered = {
    ...GOOD_PLAN,
    creatorShortlist: [GOOD_PLAN.creatorShortlist[1], GOOD_PLAN.creatorShortlist[0]],
    contentBriefs: [GOOD_PLAN.contentBriefs[1], GOOD_PLAN.contentBriefs[0]],
  };
  const r = await writerRun([{ args: reordered }]).run;
  check("the run failed", !r.ok);
  check(
    "the error says keep the planner's order",
    errorsOf(r).some((e) => e.includes("Keep the planner's order")),
    JSON.stringify(errorsOf(r)),
  );
}

// ---------------------------------------------------------------- 7. bare statistic
console.log("\n# 7. a statistic in the copy with no row behind it is blocked");
{
  const withStat = {
    ...GOOD_PLAN,
    contentBriefs: [
      { ...GOOD_PLAN.contentBriefs[0], hook: "4.900 orang menyimpan ini minggu lalu" },
      GOOD_PLAN.contentBriefs[1],
    ],
  };
  const r = await writerRun([{ args: withStat }]).run;
  check("the run failed", !r.ok);
  check(
    "the error names the field and the token",
    errorsOf(r).some((e) => e.includes("contentBriefs[0].hook") && e.includes("4.900")),
    JSON.stringify(errorsOf(r)),
  );
  check(
    "the error carries the stable code",
    errorsOf(r).some((e) => e.includes("STAT-UNCITED")),
    JSON.stringify(errorsOf(r)),
  );
}

// ---------------------------------------------------------------- 8. cited statistic
console.log("\n# 8. the same statistic IS accepted when a cited row holds it");
{
  const withStat = {
    ...GOOD_PLAN,
    contentBriefs: [
      { ...GOOD_PLAN.contentBriefs[0], hook: "610 orang menyimpan ini minggu lalu" },
      GOOD_PLAN.contentBriefs[1],
    ],
  };
  const r = await writerRun([{ args: withStat }]).run;
  check("the run succeeded", r.ok, JSON.stringify(r.errors));
}

// ---------------------------------------------------------------- 9. a promise
console.log("\n# 9. a promise no row could back is blocked");
{
  const promised = {
    ...GOOD_PLAN,
    contentBriefs: [
      { ...GOOD_PLAN.contentBriefs[0], hook: "dijamin glowing dalam tujuh hari" },
      GOOD_PLAN.contentBriefs[1],
    ],
  };
  const r = await writerRun([{ args: promised }]).run;
  check("the run failed", !r.ok);
  check(
    "the error names the guarantee rule",
    errorsOf(r).some((e) => e.includes("CLAIM-GUARANTEE")),
    JSON.stringify(errorsOf(r)),
  );
}

// ---------------------------------------------------------------- 10. a warning
console.log("\n# 10. a superlative warns, and does NOT cost a rewrite");
{
  const warned = {
    ...GOOD_PLAN,
    contentBriefs: [
      { ...GOOD_PLAN.contentBriefs[0], cta: "coba produk terbaik ini" },
      GOOD_PLAN.contentBriefs[1],
    ],
  };
  const r = await writerRun([{ args: warned }]).run;
  check("the run still succeeded", r.ok, JSON.stringify(r.errors));
  check("it took one attempt", r.attempts === 1, String(r.attempts));
  check("the warning was carried forward", r.warnings.length > 0, JSON.stringify(r.warnings));
  check(
    "the warning names the superlative rule",
    r.warnings.some((w) => w.code === "CLAIM-SUPERLATIVE"),
    JSON.stringify(r.warnings.map((w) => w.code)),
  );
  check(
    "the warning knows where it is",
    r.warnings[0]?.where === "contentBriefs[0].cta",
    r.warnings[0]?.where,
  );
}

// ---------------------------------------------------------------- 11. recovery
console.log("\n# 11. a writer told what is wrong recovers without rewriting the plan");
{
  const { seen, run } = writerRun([
    { args: { ...GOOD_PLAN, cadencePerWeek: 7 } },
    { args: GOOD_PLAN },
  ]);
  const r = await run;
  check("the run succeeded after the correction", r.ok, JSON.stringify(r.errors));
  check("it took two attempts", r.attempts === 2, String(r.attempts));
  check("the first attempt was rejected", r.transcript[0]?.action === "tool_rejected");
  check("the second was accepted", r.transcript[1]?.action === "tool_accepted");

  const feedback = (seen[1] ?? []).find((m: any) => m.role === "tool");
  check("the errors went back to the model", !!feedback);
  check(
    "the feedback asks for submit_campaign_plan again",
    String(feedback?.content ?? "").includes("call submit_campaign_plan again"),
    String(feedback?.content ?? "").slice(0, 160),
  );
  check(
    "the feedback says fix only these problems",
    String(feedback?.content ?? "").includes("Fix ONLY these problems"),
  );
}

// ---------------------------------------------------------------- 12. prose
console.log("\n# 12. a prose answer is never stored as a plan");
{
  const r = await writerRun([{ prose: "Here are your briefs: aria should post twice..." }]).run;
  check("the run failed", !r.ok);
  check("NO plan was returned", r.plan === undefined);
  check(
    "the rejection says prose cannot be validated",
    errorsOf(r).some((e) => e.includes("prose")),
    JSON.stringify(errorsOf(r)),
  );
}

// ---------------------------------------------------------------- 13. bad strategy
console.log("\n# 13. a strategy that cannot be satisfied throws before the model is called");
{
  const impossible: CampaignStrategy = {
    ...STRATEGY,
    creatorIds: ["kol_dewi"],
    rationale: [
      { creatorId: "kol_dewi", metric: "median_views_90d", sourceRowId: "kol_aria_views", value: 4820 },
    ],
  };
  const { client, seen } = scriptedClient([{ args: GOOD_PLAN }]);
  let threw = "";
  try {
    await runWriter({ client, strategy: impossible, dataset: DATASET, brief: "x" });
  } catch (e) {
    threw = (e as Error).message;
  }
  check("it threw", threw.length > 0, threw);
  check("the message says the strategy is not valid", threw.includes("the strategy is not valid"), threw);
  check("no model call was made", seen.length === 0, String(seen.length));
}

// ---------------------------------------------------------------- 14. scanPlanCopy
console.log("\n# 14. the copy scan reads the note to the brand too");
{
  const findings = scanPlanCopy({
    contentBriefs: GOOD_PLAN.contentBriefs,
    citedMetrics: GOOD_PLAN.citedMetrics,
    notes: "plan ini dijamin menghasilkan penjualan",
  });
  check(
    "a claim in `notes` is caught",
    findings.some((f) => f.where === "notes" && f.code === "CLAIM-GUARANTEE"),
    JSON.stringify(findings.map((f) => `${f.where}/${f.code}`)),
  );
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} test-writer — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
