/**
 * The adversarial test: what happens when the model does not cooperate.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every other test in this repo runs against a model that behaves. The
 * scripted model in `src/web/model.ts` is deliberately cooperative: it makes
 * two specific mistakes and then fixes them, because a demo where everything
 * passes on the first try shows nothing.
 *
 * That is a poor proxy for a real model. A real one ignores instructions it
 * was given, calls the wrong tool, returns prose where a schema was requested,
 * invents row ids that look plausible, and writes numbers into sentences that
 * were never cited. None of that is malicious - it is just what a language
 * model does when it is not the model you tested against.
 *
 * So this file drives the pipeline with clients that misbehave in each of
 * those ways and asserts one property, over and over:
 *
 *   **whatever the model does, the run either returns no plan at all, or
 *   returns a plan that passes every gate.**
 *
 * That is the whole safety claim of the product, stated as something a
 * machine can check. It does not prove the guards are complete - nothing
 * does - but it proves they cannot be *routed around* by a bad reply.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-adversarial.ts
 */

import { runCampaign, type RunResult } from "../src/agent/orchestrator.ts";
import type { ChatClient } from "../src/agent/copilot.ts";
import type { CampaignPlan } from "../src/agent/campaign-plan.ts";
import { validateCampaignPlan } from "../src/agent/campaign-plan.ts";
import { checkNoFakes } from "../src/agent/no-fakes.ts";
import { checkStrategyConformance, type CampaignStrategy } from "../src/agent/strategy.ts";
import { metricIdsOf, rowsToMap, type BrandDataset } from "../src/agent/dataset.ts";
import { scanPlanCopy } from "../src/agent/writer.ts";

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
    // Listed with no rows: shortlisting her is unanswerable, not dishonest.
    { creatorId: "kol_eka", handle: "@eka.baru", niche: "skincare" },
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

const GOOD_PLAN = {
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

// ---------------------------------------------------------------- the fake clients

type Reply =
  | { kind: "args"; value: unknown }
  | { kind: "raw"; value: string }
  | { kind: "prose"; value: string }
  | { kind: "wrongTool"; name: string; value: unknown };

/** A client that answers through a handler, so each case reads as one idea. */
function adversarial(handler: (tool: string, n: number) => Reply): ChatClient {
  const counts: Record<string, number> = {};
  return {
    async complete({ tools }) {
      const name = (tools[0] as { function?: { name?: string } })?.function?.name ?? "";
      counts[name] = (counts[name] ?? 0) + 1;
      const reply = handler(name, counts[name]);

      if (reply.kind === "prose") return { content: reply.value };
      if (reply.kind === "raw") {
        return {
          tool_calls: [{ id: "c", function: { name, arguments: reply.value } }],
        };
      }
      if (reply.kind === "wrongTool") {
        return {
          tool_calls: [
            { id: "c", function: { name: reply.name, arguments: JSON.stringify(reply.value) } },
          ],
        };
      }
      return {
        tool_calls: [{ id: "c", function: { name, arguments: JSON.stringify(reply.value) } }],
      };
    },
  };
}

/** The planner always succeeds; the writer or reviewer is the hostile one. */
function writerIsHostile(plan: unknown): ChatClient {
  return adversarial((tool) => {
    if (tool === "submit_campaign_strategy") return { kind: "args", value: STRATEGY_ARGS };
    if (tool === "submit_campaign_plan") return { kind: "args", value: plan };
    return { kind: "args", value: { findings: [] } };
  });
}

// ---------------------------------------------------------------- the invariant

/**
 * Every gate, run independently of the pipeline that just produced the plan.
 *
 * Deliberately re-derived here rather than trusting `runCampaign` to have
 * checked: the question this answers is not "did the pipeline think it was
 * fine" but "is it actually fine".
 */
function gateFailures(plan: CampaignPlan, strategy: CampaignStrategy): string[] {
  const problems: string[] = [];

  const shape = validateCampaignPlan(plan, metricIdsOf(DATASET));
  if (!shape.ok) problems.push(...shape.errors.map((e) => `shape: ${e}`));

  const noFakes = checkNoFakes(plan, rowsToMap(DATASET));
  if (!noFakes.ok) problems.push(...noFakes.errors.map((e) => `no-fakes: ${e}`));

  problems.push(
    ...checkStrategyConformance(plan, strategy).map((e) => `conformance: ${e}`),
  );

  const claims = scanPlanCopy(plan, strategy.rationale.map((r) => r.value)).filter(
    (f) => f.severity === "block",
  );
  problems.push(...claims.map((f) => `claim: ${f.where} ${f.code}`));

  return problems;
}

/**
 * The one property every case must satisfy.
 *
 * A run that publishes nothing is a valid outcome. A run that publishes
 * something must have published something clean.
 */
function assertSafe(result: RunResult, label: string): void {
  if (result.plan === undefined) {
    check(`${label}: published no plan, which is always allowed`, true);
    return;
  }
  const problems = gateFailures(result.plan, result.strategy!);
  check(
    `${label}: the plan it DID publish passes every gate`,
    problems.length === 0,
    JSON.stringify(problems),
  );
}

console.log("test-adversarial\n");

// ---------------------------------------------------------------- 1. it cannot even start
console.log("# 1. a model that never produces a strategy stops the run");
{
  const cases: { name: string; client: ChatClient }[] = [
    {
      name: "prose only",
      client: adversarial(() => ({ kind: "prose", value: "Sure! Here is a strategy..." })),
    },
    {
      name: "wrong tool",
      client: adversarial(() => ({
        kind: "wrongTool",
        name: "submit_campaign_plan",
        value: GOOD_PLAN,
      })),
    },
    {
      name: "broken JSON",
      client: adversarial(() => ({ kind: "raw", value: "{ weekOf: '2026-11-02', " })),
    },
    {
      name: "empty object",
      client: adversarial(() => ({ kind: "args", value: {} })),
    },
    {
      name: "a creator that does not exist",
      client: adversarial(() => ({
        kind: "args",
        value: { ...STRATEGY_ARGS, creatorIds: ["kol_ghost"], rationale: [
          { creatorId: "kol_ghost", metric: "m", sourceRowId: "kol_aria_saves", value: 610 },
        ] },
      })),
    },
    {
      name: "a creator with no rows",
      client: adversarial(() => ({
        kind: "args",
        value: { ...STRATEGY_ARGS, creatorIds: ["kol_eka"], rationale: [
          { creatorId: "kol_eka", metric: "m", sourceRowId: "kol_aria_saves", value: 610 },
        ] },
      })),
    },
    {
      name: "a justification citing another creator's row",
      client: adversarial(() => ({
        kind: "args",
        value: {
          ...STRATEGY_ARGS,
          creatorIds: ["kol_aria"],
          rationale: [
            { creatorId: "kol_aria", metric: "m", sourceRowId: "kol_bima_views", value: 12900 },
          ],
        },
      })),
    },
  ];

  for (const c of cases) {
    const r = await runCampaign({
      client: c.client,
      dataset: DATASET,
      brief: "x",
      weekOf: "2026-11-02",
    });
    check(`${c.name}: no plan`, r.ok === false && r.plan === undefined, r.reason);
    check(`${c.name}: the reason names the planner`, String(r.reason).includes("planner"), r.reason);
    assertSafe(r, c.name);
  }
}

// ---------------------------------------------------------------- 2. the writer misbehaves
console.log("\n# 2. a writer that ignores the strategy, the data, or the rules");
{
  const mutations: { name: string; plan: unknown }[] = [
    {
      name: "a different week",
      plan: { ...GOOD_PLAN, weekOf: "2026-11-09" },
    },
    {
      name: "a different cadence",
      plan: { ...GOOD_PLAN, cadencePerWeek: 9 },
    },
    {
      name: "an absurd cadence",
      plan: { ...GOOD_PLAN, cadencePerWeek: 9999 },
    },
    {
      name: "a dropped creator",
      plan: {
        ...GOOD_PLAN,
        creatorShortlist: [GOOD_PLAN.creatorShortlist[0]],
        contentBriefs: [GOOD_PLAN.contentBriefs[0]],
      },
    },
    {
      name: "an invented row id",
      plan: {
        ...GOOD_PLAN,
        citedMetrics: [{ metric: "m", sourceRowId: "row_ghost", value: 9999 }],
      },
    },
    {
      name: "a real row with an inflated value",
      plan: {
        ...GOOD_PLAN,
        citedMetrics: [
          { metric: "median_saves_90d", sourceRowId: "kol_aria_saves", value: 48200 },
        ],
      },
    },
    {
      name: "an uncited statistic in a hook",
      plan: {
        ...GOOD_PLAN,
        contentBriefs: [
          { ...GOOD_PLAN.contentBriefs[0], hook: "9.999 orang menyimpan ini" },
          GOOD_PLAN.contentBriefs[1],
        ],
      },
    },
    {
      name: "a guarantee in the copy",
      plan: {
        ...GOOD_PLAN,
        contentBriefs: [
          { ...GOOD_PLAN.contentBriefs[0], cta: "dijamin cocok untuk semua kulit" },
          GOOD_PLAN.contentBriefs[1],
        ],
      },
    },
    {
      name: "a statistic smuggled into the notes",
      plan: { ...GOOD_PLAN, notes: "plan ini menjangkau 45.000 orang" },
    },
    {
      name: "an image count out of range",
      plan: {
        ...GOOD_PLAN,
        contentBriefs: [
          { ...GOOD_PLAN.contentBriefs[0], imageCount: 40 },
          GOOD_PLAN.contentBriefs[1],
        ],
      },
    },
    {
      name: "two briefs for the same creator",
      plan: {
        ...GOOD_PLAN,
        contentBriefs: [GOOD_PLAN.contentBriefs[0], GOOD_PLAN.contentBriefs[0]],
      },
    },
  ];

  for (const m of mutations) {
    const r = await runCampaign({
      client: writerIsHostile(m.plan),
      dataset: DATASET,
      brief: "x",
      weekOf: "2026-11-02",
    });
    check(`${m.name}: no plan`, r.ok === false && r.plan === undefined, r.reason);
    assertSafe(r, m.name);
  }
}

// ---------------------------------------------------------------- 3. the reviewer misbehaves
console.log("\n# 3. a reviewer that is hostile, broken, or absent");
{
  // Blocks everything, forever.
  {
    const client = adversarial((tool) => {
      if (tool === "submit_campaign_strategy") return { kind: "args", value: STRATEGY_ARGS };
      if (tool === "submit_campaign_plan") return { kind: "args", value: GOOD_PLAN };
      return {
        kind: "args",
        value: {
          findings: [
            {
              code: "ANGLE-DRIFT",
              severity: "block",
              where: "contentBriefs[0].hook",
              message: "not the angle",
            },
          ],
        },
      };
    });
    const r = await runCampaign({ client, dataset: DATASET, brief: "x", weekOf: "2026-11-02" });
    check("a reviewer that blocks forever: no plan", r.ok === false && r.plan === undefined, r.reason);
    check("it used its whole revision budget", r.stages.filter((s) => s.stage === "reviewer").length === 3, String(r.stages.filter((s) => s.stage === "reviewer").length));
    assertSafe(r, "blocking reviewer");
  }

  // Returns findings about fields that do not exist. The judgement pass fails
  // its own schema, so it degrades - and a degraded pass is not a veto.
  {
    const client = adversarial((tool) => {
      if (tool === "submit_campaign_strategy") return { kind: "args", value: STRATEGY_ARGS };
      if (tool === "submit_campaign_plan") return { kind: "args", value: GOOD_PLAN };
      return {
        kind: "args",
        value: {
          findings: [
            { code: "TONE", severity: "block", where: "contentBriefs[99].hook", message: "x" },
          ],
        },
      };
    });
    const r = await runCampaign({ client, dataset: DATASET, brief: "x", weekOf: "2026-11-02" });
    check("a reviewer pointing at nothing: the plan still publishes", r.ok === true, r.reason);
    check("it is flagged as degraded", r.degraded === true);
    assertSafe(r, "incoherent reviewer");
  }

  // Invents finding codes.
  {
    const client = adversarial((tool) => {
      if (tool === "submit_campaign_strategy") return { kind: "args", value: STRATEGY_ARGS };
      if (tool === "submit_campaign_plan") return { kind: "args", value: GOOD_PLAN };
      return {
        kind: "args",
        value: { findings: [{ code: "VIBES-OFF", severity: "block", where: "plan", message: "x" }] },
      };
    });
    const r = await runCampaign({ client, dataset: DATASET, brief: "x", weekOf: "2026-11-02" });
    check("a reviewer inventing codes: the plan still publishes", r.ok === true, r.reason);
    check("it is flagged as degraded", r.degraded === true);
    assertSafe(r, "inventive reviewer");
  }

  // THE IMPORTANT ONE: a reviewer that approves everything, on a writer that
  // tries to sneak a fabricated statistic past it. The writer's own gate has to
  // catch it, because the reviewer will not.
  {
    const sneaky = {
      ...GOOD_PLAN,
      contentBriefs: [
        { ...GOOD_PLAN.contentBriefs[0], hook: "9.999 orang menyimpan ini" },
        GOOD_PLAN.contentBriefs[1],
      ],
    };
    const client = adversarial((tool) => {
      if (tool === "submit_campaign_strategy") return { kind: "args", value: STRATEGY_ARGS };
      if (tool === "submit_campaign_plan") return { kind: "args", value: sneaky };
      return { kind: "args", value: { findings: [] } };
    });
    const r = await runCampaign({ client, dataset: DATASET, brief: "x", weekOf: "2026-11-02" });
    check(
      "a yes-man reviewer cannot rescue a fabricated statistic",
      r.ok === false && r.plan === undefined,
      r.reason,
    );
    assertSafe(r, "yes-man reviewer");
  }
}

// ---------------------------------------------------------------- 4. the property, on a good model
console.log("\n# 4. the control: a cooperative model still produces a valid plan");
{
  const client = adversarial((tool) => {
    if (tool === "submit_campaign_strategy") return { kind: "args", value: STRATEGY_ARGS };
    if (tool === "submit_campaign_plan") return { kind: "args", value: GOOD_PLAN };
    return { kind: "args", value: { findings: [] } };
  });
  const r = await runCampaign({ client, dataset: DATASET, brief: "x", weekOf: "2026-11-02" });
  check("a clean model produces a plan", r.ok === true && !!r.plan, r.reason);
  check("and that plan passes every gate", r.plan ? gateFailures(r.plan, r.strategy!).length === 0 : false);
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} test-adversarial — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
