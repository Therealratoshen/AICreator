/**
 * The orchestrator's test.
 *
 * This is the only test that exercises all three agents together, so it is the
 * only place where the pipeline's actual claim can be checked: that a campaign
 * reaches a brand only when a plan was validated in code AND read by a
 * reviewer, and that when that cannot be achieved the run produces **no plan
 * at all**.
 *
 * Test 5 is the one that matters. A valid plan exists - every code check
 * passed - and the reviewer keeps rejecting it. The temptation in that
 * situation is enormous: the plan is right there, it is valid, ship it. The
 * answer has to be no, and it has to be no in a way a test can see.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-orchestrator.ts
 */

import { runCampaign, MAX_REVISIONS, type RunEvent } from "../src/agent/orchestrator.ts";
import type { ChatClient } from "../src/agent/copilot.ts";
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
  ],
};

const STRATEGY_ARGS = {
  weekOf: "2026-11-02",
  cadencePerWeek: 2,
  creatorIds: ["kol_aria", "kol_bima"],
  angle: "show the routine being used on a normal weeknight, not in a studio",
  rationale: [
    { creatorId: "kol_aria", metric: "median_saves_90d", sourceRowId: "kol_aria_saves", value: 610 },
    { creatorId: "kol_bima", metric: "median_views_90d", sourceRowId: "kol_bima_views", value: 12900 },
  ],
  constraints: ["no before-and-after skin claims"],
};

const PLAN_ARGS = {
  weekOf: "2026-11-02",
  cadencePerWeek: 2,
  creatorShortlist: [
    { creatorId: "kol_aria", reason: "median 610 saves per post", justifyingMetric: 610 },
    { creatorId: "kol_bima", reason: "median 12900 views per post", justifyingMetric: 12900 },
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

const BLOCK_FINDING = {
  code: "ANGLE-DRIFT",
  severity: "block",
  where: "contentBriefs[1].hook",
  message: "this reads as a gym post, not the evening routine the angle asked for",
};

/**
 * A client that answers by which tool was offered.
 *
 * The tool name is the only thing that distinguishes one agent from another at
 * this level, and using it keeps the fake honest: if the orchestrator ever
 * called the reviewer with the writer's tool, this fake would answer with the
 * wrong script and the test would fail loudly instead of quietly passing.
 */
function makeClient(script: {
  strategy: unknown[];
  plan: unknown[];
  review: unknown[];
}) {
  const at = { submit_campaign_strategy: 0, submit_campaign_plan: 0, submit_review: 0 };
  const calls = { planner: 0, writer: 0, reviewer: 0 };

  const client: ChatClient = {
    async complete({ tools }) {
      const name = (tools[0] as { function?: { name?: string } })?.function?.name ?? "";
      let payload: unknown;

      if (name === "submit_campaign_strategy") {
        calls.planner++;
        const seq = script.strategy;
        payload = seq[Math.min(at.submit_campaign_strategy++, seq.length - 1)];
      } else if (name === "submit_campaign_plan") {
        calls.writer++;
        const seq = script.plan;
        payload = seq[Math.min(at.submit_campaign_plan++, seq.length - 1)];
      } else if (name === "submit_review") {
        calls.reviewer++;
        const seq = script.review;
        payload = { findings: seq[Math.min(at.submit_review++, seq.length - 1)] };
      } else {
        return { content: "I do not know that tool." };
      }

      return {
        tool_calls: [{ id: `call_${name}`, function: { name, arguments: JSON.stringify(payload) } }],
      };
    },
  };

  return { client, calls };
}

function base(overrides: Partial<{ strategy: unknown[]; plan: unknown[]; review: unknown[] }> = {}) {
  return {
    strategy: [STRATEGY_ARGS],
    plan: [PLAN_ARGS],
    review: [[]],
    ...overrides,
  };
}

console.log("test-orchestrator\n");

// ---------------------------------------------------------------- 1. the happy path
console.log("# 1. planner, writer and reviewer all succeed");
{
  const { client, calls } = makeClient(base());
  const events: RunEvent[] = [];
  const r = await runCampaign({
    client,
    dataset: DATASET,
    brief: "plan the week",
    weekOf: "2026-11-02",
    onEvent: (e) => events.push(e),
  });

  check("the run succeeded", r.ok, r.reason);
  check("a plan came back", !!r.plan);
  check("the strategy came back too", !!r.strategy);
  check("three stages ran", r.stages.length === 3, String(r.stages.length));
  check(
    "the stages are in order",
    r.stages.map((s) => s.stage).join(",") === "planner,writer,reviewer",
    r.stages.map((s) => s.stage).join(","),
  );
  check("each agent was called once", calls.planner === 1 && calls.writer === 1 && calls.reviewer === 1,
    JSON.stringify(calls));
  check("nothing is degraded", r.degraded === false);
  check("no warnings on a clean run", r.warnings.length === 0, JSON.stringify(r.warnings));
  check(
    "the run ends with a done event",
    events.at(-1)?.type === "done" && (events.at(-1) as { ok: boolean }).ok === true,
    JSON.stringify(events.at(-1)),
  );
  check(
    "the plan is the one the writer produced",
    r.plan?.contentBriefs.length === 2 && r.plan?.weekOf === "2026-11-02",
  );
}

// ---------------------------------------------------------------- 2. the planner fails
console.log("\n# 2. a planner that cannot decide stops the run with no plan");
{
  const { client, calls } = makeClient(base({ strategy: [{ ...STRATEGY_ARGS, weekOf: "2026-11-03" }] }));
  const r = await runCampaign({ client, dataset: DATASET, brief: "x", weekOf: "2026-11-02" });

  check("the run failed", !r.ok);
  check("NO plan was returned", r.plan === undefined);
  check("no strategy either", r.strategy === undefined);
  check("the writer was never called", calls.writer === 0, String(calls.writer));
  check("the reviewer was never called", calls.reviewer === 0, String(calls.reviewer));
  check("the reason names the planner", String(r.reason).includes("planner"), r.reason);
  check("only the planner stage is recorded", r.stages.length === 1, String(r.stages.length));
}

// ---------------------------------------------------------------- 3. the writer fails
console.log("\n# 3. a writer that cannot produce a valid plan stores nothing");
{
  const { client, calls } = makeClient(
    base({ plan: [{ ...PLAN_ARGS, cadencePerWeek: 9 }] }),
  );
  const r = await runCampaign({ client, dataset: DATASET, brief: "x", weekOf: "2026-11-02" });

  check("the run failed", !r.ok);
  check("NO plan was returned", r.plan === undefined);
  check("the strategy is still reported", !!r.strategy);
  check("the reviewer was never called", calls.reviewer === 0, String(calls.reviewer));
  check("the reason names the writer", String(r.reason).includes("writer"), r.reason);
  check(
    "the writer's errors are recorded",
    (r.stages.find((s) => s.stage === "writer")?.errors ?? []).some((e) => e.includes("cadencePerWeek")),
    JSON.stringify(r.stages.find((s) => s.stage === "writer")?.errors),
  );
}

// ---------------------------------------------------------------- 4. a revision
console.log("\n# 4. a rejected plan is revised, then approved");
{
  const { client, calls } = makeClient(
    base({ review: [[BLOCK_FINDING], []] }),
  );
  const events: RunEvent[] = [];
  const r = await runCampaign({
    client,
    dataset: DATASET,
    brief: "plan the week",
    weekOf: "2026-11-02",
    onEvent: (e) => events.push(e),
  });

  check("the run succeeded on the revision", r.ok, r.reason);
  check("the writer ran twice", calls.writer === 2, String(calls.writer));
  check("the reviewer ran twice", calls.reviewer === 2, String(calls.reviewer));
  check("five stages were recorded", r.stages.length === 5, String(r.stages.length));
  check(
    "the first review is recorded as failed",
    r.stages.find((s) => s.stage === "reviewer" && s.attempt === 1)?.ok === false,
  );
  check(
    "the second review is recorded as passed",
    r.stages.find((s) => s.stage === "reviewer" && s.attempt === 2)?.ok === true,
  );
  check(
    "a revision event was emitted with the blocker",
    events.some((e) => e.type === "revision" && JSON.stringify(e).includes("ANGLE-DRIFT")),
  );
  check("a plan was returned", !!r.plan);
}

// ---------------------------------------------------------------- 5. THE INVARIANT
console.log("\n# 5. a plan the reviewer keeps rejecting is NEVER published");
{
  // Every code check passes. The reviewer objects, twice. The plan is valid and
  // is deliberately not returned.
  const { client, calls } = makeClient(base({ review: [[BLOCK_FINDING]] }));
  const r = await runCampaign({
    client,
    dataset: DATASET,
    brief: "x",
    weekOf: "2026-11-02",
    maxRevisions: 1,
  });

  check("the run failed", !r.ok);
  check("NO plan was returned", r.plan === undefined);
  check("the writer ran twice (one plan, one revision)", calls.writer === 2, String(calls.writer));
  check("the reviewer ran twice", calls.reviewer === 2, String(calls.reviewer));
  check("the reason says it was not published", String(r.reason).includes("not published"), r.reason);
  check("the reason carries the last objection", String(r.reason).includes("ANGLE-DRIFT"), r.reason);
  check("the strategy is still reported for diagnosis", !!r.strategy);
}

// ---------------------------------------------------------------- 6. the default budget
console.log("\n# 6. the default revision budget is what the constant says");
{
  const { client, calls } = makeClient(base({ review: [[BLOCK_FINDING]] }));
  const r = await runCampaign({ client, dataset: DATASET, brief: "x", weekOf: "2026-11-02" });

  check("the run failed", !r.ok);
  check("no plan", r.plan === undefined);
  check(
    `the writer ran ${MAX_REVISIONS + 1} times`,
    calls.writer === MAX_REVISIONS + 1,
    String(calls.writer),
  );
  check("the reviewer ran as often", calls.reviewer === MAX_REVISIONS + 1, String(calls.reviewer));
}

// ---------------------------------------------------------------- 7. event ordering
console.log("\n# 7. progress events are emitted in the order the work happens");
{
  const { client } = makeClient(base());
  const events: RunEvent[] = [];
  await runCampaign({
    client,
    dataset: DATASET,
    brief: "x",
    weekOf: "2026-11-02",
    onEvent: (e) => events.push(e),
  });

  const shape = events.map((e) => `${e.type}:${"stage" in e ? e.stage : "-"}`).join(" ");
  check(
    "planner starts and ends before the writer starts",
    shape.startsWith("stage_start:planner stage_ok:planner stage_start:writer"),
    shape,
  );
  check("the reviewer runs last", shape.includes("stage_start:reviewer"));
  check("it finishes with done", shape.endsWith("done:-"), shape);
}

// ---------------------------------------------------------------- 8. a broken listener
console.log("\n# 8. a broken progress listener cannot break the run");
{
  const { client } = makeClient(base());
  const r = await runCampaign({
    client,
    dataset: DATASET,
    brief: "x",
    weekOf: "2026-11-02",
    onEvent: () => {
      throw new Error("the subscriber is broken");
    },
  });
  check("the run still succeeded", r.ok, r.reason);
  check("a plan still came back", !!r.plan);
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} test-orchestrator — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
