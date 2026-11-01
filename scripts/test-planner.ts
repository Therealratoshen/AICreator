/**
 * The planner's test.
 *
 * The planner is agent 1 of 3, and it is the agent with the strongest
 * incentive to invent a number: it picks the creators, so a plausible figure
 * that supports the pick it already wanted is exactly what a language model
 * will produce if nothing stops it.
 *
 * There are four ways to fabricate a justification, and this file tests all
 * four, because three of them look fine in a diff:
 *
 *   1. cite a row that does not exist          - obvious, and already covered
 *                                                by the plan-level tests;
 *   2. cite a real row with the wrong value    - LOOKS grounded. The row id is
 *                                                real, so a reviewer skimming
 *                                                the output sees a citation;
 *   3. cite a real row about another creator   - LOOKS grounded AND the value
 *                                                is right. This is the one that
 *                                                survives every check that only
 *                                                compares numbers;
 *   4. shortlist a creator with no rows at all - not a lie, just unanswerable.
 *
 * Plus the loop behaviour it inherits: a rejection must come back as feedback
 * the model can act on, and a run that never validates must return a failure
 * rather than a strategy.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-planner.ts
 */

import { runPlanner, buildPlannerSystemPrompt, PLANNER_MAX_ATTEMPTS } from "../src/agent/planner.ts";
import type { ChatClient } from "../src/agent/copilot.ts";
import { strategyContextOf, metricIdsOf, type BrandDataset } from "../src/agent/dataset.ts";

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
  ],
  creators: [
    { creatorId: "kol_aria", handle: "@aria.rawat", niche: "skincare" },
    { creatorId: "kol_bima", handle: "@bima.gerak", niche: "fitness" },
    // Listed as a creator, but the data has no row about her. Shortlisting her
    // is not a lie, it is an instruction that cannot be carried out.
    { creatorId: "kol_citra", handle: "@citra.kulit", niche: "skincare" },
  ],
};

/** 2026-11-02 is a Monday; 2026-11-03 is a Tuesday. */
const VALID = {
  weekOf: "2026-11-02",
  cadencePerWeek: 2,
  creatorIds: ["kol_aria"],
  angle: "show a two-step evening routine on a normal weeknight",
  rationale: [
    { creatorId: "kol_aria", metric: "median_saves_90d", sourceRowId: "kol_aria_saves", value: 610 },
  ],
  constraints: ["no before-and-after skin claims", "no price claims"],
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
          { id: `call_${i}`, function: { name: "submit_campaign_strategy", arguments: raw } },
        ],
      };
    },
  };
  return { client, seen };
}

function plannerRun(replies: { args?: unknown; raw?: string; prose?: string }[], maxAttempts = 2) {
  const { client, seen } = scriptedClient(replies);
  return {
    seen,
    run: runPlanner({ client, dataset: DATASET, brief: "plan the week", weekOf: "2026-11-02", maxAttempts }),
  };
}

console.log("test-planner\n");

// ---------------------------------------------------------------- 0. the context
console.log("# 0. the validation context is derived from the dataset, not hand-built");
{
  const ctx = strategyContextOf(DATASET);
  check("every row is addressable", ctx.rows.size === DATASET.rows.length, String(ctx.rows.size));
  check("every creator is known", ctx.creatorIds.size === 3, String(ctx.creatorIds.size));
  check(
    "a row carries its value, so the value is checkable",
    ctx.rows.get("kol_aria_saves")?.value === 610,
    String(ctx.rows.get("kol_aria_saves")?.value),
  );
  check(
    "a row carries its subject, so attribution is checkable",
    ctx.subjectOf.get("kol_aria_saves") === "kol_aria",
    String(ctx.subjectOf.get("kol_aria_saves")),
  );
  check("metricIdsOf still works off the same rows", metricIdsOf(DATASET).size === 4);
}

// ---------------------------------------------------------------- 1. happy path
console.log("\n# 1. a correct first call is accepted");
{
  const { run } = plannerRun([{ args: VALID }]);
  const r = await run;
  check("the run succeeded", r.ok, JSON.stringify(r.errors));
  check("a strategy came back", !!r.strategy);
  check("it took one attempt", r.attempts === 1, String(r.attempts));
  check("the transcript records the acceptance", r.transcript[0]?.action === "tool_accepted");
  check(
    "the transcript preserves the raw arguments",
    String(r.transcript[0]?.raw ?? "").includes("creatorIds"),
  );
  check(
    "the strategy is the one that was submitted",
    r.strategy?.creatorIds[0] === "kol_aria" && r.strategy?.rationale[0]?.value === 610,
  );
}

// ---------------------------------------------------------------- 2. invented row
console.log("\n# 2. a rationale citing a row that does not exist is rejected");
{
  const { run } = plannerRun([
    {
      args: {
        ...VALID,
        rationale: [
          { creatorId: "kol_aria", metric: "median_views_90d", sourceRowId: "kol_aria_views_2025", value: 9900 },
        ],
      },
    },
  ]);
  const r = await run;
  check("the run failed", !r.ok);
  check("NO strategy was returned", r.strategy === undefined);
  check(
    "the rejection names the invented row",
    (r.transcript[0]?.errors ?? []).some((e) => e.includes("kol_aria_views_2025")),
    JSON.stringify(r.transcript[0]?.errors),
  );
}

// ---------------------------------------------------------------- 3. wrong value
console.log("\n# 3. a REAL row with the wrong value is rejected");
{
  // The row exists. The metric name is right. Only the number is inflated.
  const { run } = plannerRun([
    {
      args: {
        ...VALID,
        rationale: [
          { creatorId: "kol_aria", metric: "median_views_90d", sourceRowId: "kol_aria_views", value: 48000 },
        ],
      },
    },
  ]);
  const r = await run;
  check("the run failed", !r.ok);
  check(
    "the rejection says the value does not match the row",
    (r.transcript[0]?.errors ?? []).some((e) => e.includes("holds 4820")),
    JSON.stringify(r.transcript[0]?.errors),
  );
  check(
    "the rejection quotes both numbers so the fix is obvious",
    (r.transcript[0]?.errors ?? []).some((e) => e.includes("48000")),
    JSON.stringify(r.transcript[0]?.errors),
  );
}

// ---------------------------------------------------------------- 4. wrong creator
console.log("\n# 4. a REAL row about a DIFFERENT creator is rejected");
{
  // kol_bima's views are real (12,900) and the value is quoted correctly. Every
  // check that only compares numbers passes. The claim is still false.
  const { run } = plannerRun([
    {
      args: {
        ...VALID,
        rationale: [
          { creatorId: "kol_aria", metric: "median_views_90d", sourceRowId: "kol_bima_views", value: 12900 },
        ],
      },
    },
  ]);
  const r = await run;
  check("the run failed", !r.ok);
  check(
    "the rejection names the subject mismatch",
    (r.transcript[0]?.errors ?? []).some((e) => e.includes('is about "kol_bima"')),
    JSON.stringify(r.transcript[0]?.errors),
  );
  check(
    "the rejection does not also complain about the value",
    !(r.transcript[0]?.errors ?? []).some((e) => e.includes("holds")),
    JSON.stringify(r.transcript[0]?.errors),
  );
}

// ---------------------------------------------------------------- 5. no rows
console.log("\n# 5. a creator with no rows cannot be shortlisted");
{
  const { run } = plannerRun([
    {
      args: {
        ...VALID,
        creatorIds: ["kol_citra"],
        rationale: [
          { creatorId: "kol_citra", metric: "median_views_90d", sourceRowId: "kol_aria_views", value: 4820 },
        ],
      },
    },
  ]);
  const r = await run;
  check("the run failed", !r.ok);
  check(
    "the rejection says the creator has no rows",
    (r.transcript[0]?.errors ?? []).some((e) => e.includes("has no rows")),
    JSON.stringify(r.transcript[0]?.errors),
  );
}

// ---------------------------------------------------------------- 6. missing rationale
console.log("\n# 6. a shortlist with no justification per creator is rejected");
{
  const { run } = plannerRun([
    { args: { ...VALID, creatorIds: ["kol_aria", "kol_bima"], rationale: [VALID.rationale[0]] } },
  ]);
  const r = await run;
  check("the run failed", !r.ok);
  check(
    "the rejection says kol_bima has no rationale",
    (r.transcript[0]?.errors ?? []).some((e) => e.includes('"kol_bima"') && e.includes("no entry")),
    JSON.stringify(r.transcript[0]?.errors),
  );
}

// ---------------------------------------------------------------- 7. recovery
console.log("\n# 7. a planner told what is wrong recovers without re-planning");
{
  const { client, seen } = scriptedClient([
    {
      args: {
        ...VALID,
        rationale: [
          { creatorId: "kol_aria", metric: "median_saves_90d", sourceRowId: "kol_aria_saves", value: 999 },
        ],
      },
    },
    { args: VALID },
  ]);
  const r = await runPlanner({
    client,
    dataset: DATASET,
    brief: "plan the week",
    weekOf: "2026-11-02",
    maxAttempts: 3,
  });
  check("the run succeeded after the correction", r.ok, JSON.stringify(r.errors));
  check("it took two attempts", r.attempts === 2, String(r.attempts));
  check("the first attempt was rejected", r.transcript[0]?.action === "tool_rejected");
  check("the second attempt was accepted", r.transcript[1]?.action === "tool_accepted");

  const feedback = (seen[1] ?? []).find((m: any) => m.role === "tool");
  check("the errors were fed back to the model", !!feedback);
  check(
    "the feedback asks for submit_campaign_strategy again",
    String(feedback?.content ?? "").includes("call submit_campaign_strategy again"),
    String(feedback?.content ?? "").slice(0, 160),
  );
  check(
    "the feedback tells it to fix only the rejected fields",
    String(feedback?.content ?? "").includes("Fix ONLY these fields"),
  );
}

// ---------------------------------------------------------------- 8. no recovery
console.log("\n# 8. a planner that never validates fails, and never yields a strategy");
{
  const { run } = plannerRun([{ args: { ...VALID, weekOf: "2026-11-03" } }], 3);
  const r = await run;
  check("the run failed", !r.ok);
  check("NO strategy was returned", r.strategy === undefined);
  check("it used every attempt", r.attempts === PLANNER_MAX_ATTEMPTS, String(r.attempts));
  check("every attempt was rejected", r.transcript.every((t) => t.action === "tool_rejected"));
}

// ---------------------------------------------------------------- 9. prose
console.log("\n# 9. a prose answer is never stored as a strategy");
{
  const { run } = plannerRun([
    { prose: "Great question! I'd start with @aria.rawat, who averages about 4.8k views..." },
  ]);
  const r = await run;
  check("the run failed", !r.ok);
  check("NO strategy was returned", r.strategy === undefined);
  check(
    "the rejection says prose cannot be validated",
    (r.transcript[0]?.errors ?? []).some((e) => e.includes("prose")),
    JSON.stringify(r.transcript[0]?.errors),
  );
}

// ---------------------------------------------------------------- 10. caller bug
console.log("\n# 10. a weekOf that is not a Monday throws before the model is called");
{
  const { client, seen } = scriptedClient([{ args: VALID }]);
  let threw = "";
  try {
    await runPlanner({
      client,
      dataset: DATASET,
      brief: "plan the week",
      weekOf: "2026-11-03",
    });
  } catch (e) {
    threw = (e as Error).message;
  }
  check("it threw", threw.length > 0, threw);
  check("the message names the weekday", threw.includes("Tue"), threw);
  check(
    "no model call was made - the model cannot fix the caller's argument",
    seen.length === 0,
    String(seen.length),
  );
}

// ---------------------------------------------------------------- 11. the prompt
console.log("\n# 11. the prompt carries the data, so a row can actually be cited");
{
  const prompt = buildPlannerSystemPrompt(DATASET);
  check("the brand is named", prompt.includes("Sereh"));
  check("the rows are listed with ids", prompt.includes("kol_aria_saves"));
  check("the values are listed", prompt.includes("610"));
  check("the creators are listed", prompt.includes("@bima.gerak"));
  check("the house rule is stated", prompt.includes("THE HOUSE RULE"));
  check(
    "the prompt states what the validator checks",
    prompt.includes("WHAT IS CHECKED IN CODE AFTER YOU SUBMIT"),
  );
  check(
    "the prompt says the planner does not write posts",
    prompt.includes("You do not write posts"),
  );
  check(
    "a creator with no rows is flagged as uncitable",
    prompt.includes("no audience rows"),
  );
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} test-planner — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
