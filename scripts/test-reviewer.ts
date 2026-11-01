/**
 * The reviewer's test.
 *
 * The claim this file exists to prove is one sentence long:
 *
 *   **a model cannot approve a plan that code has rejected.**
 *
 * That is the whole reason a third agent is safe to have. Every other property
 * of the reviewer is a convenience; this one is the difference between "a
 * second opinion" and "a way to talk the guard down". So test 3 is the
 * important one: a plan with a fabricated statistic, and a model that reads it
 * and reports nothing wrong.
 *
 * The rest covers the edges that decide whether the loop converges or spins:
 * warnings must not cost a revision, and a reviewer that cannot fill in its
 * own schema must not be able to veto a plan that already passed every
 * deterministic check.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-reviewer.ts
 */

import {
  allowedLocations,
  blockersOf,
  renderPlan,
  runReviewer,
  validateReview,
  warningsOf,
  REVIEW_CODES,
} from "../src/agent/reviewer.ts";
import type { ChatClient } from "../src/agent/copilot.ts";
import type { CampaignPlan } from "../src/agent/campaign-plan.ts";
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
  constraints: ["no before-and-after skin claims"],
};

const PLAN: CampaignPlan = {
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

/** A plan with a fabricated statistic inside a hook. Shape is otherwise fine. */
const PLAN_WITH_FAKE_STAT: CampaignPlan = {
  ...PLAN,
  contentBriefs: [
    { ...PLAN.contentBriefs[0], hook: "4.900 orang menyimpan ini minggu lalu" },
    PLAN.contentBriefs[1],
  ],
};

function scriptedClient(replies: { findings?: unknown; prose?: string }[]) {
  const seen: any[] = [];
  let i = 0;
  const client: ChatClient = {
    async complete({ messages }) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      const r = replies[Math.min(i, replies.length - 1)];
      i++;
      if (r.prose !== undefined) return { content: r.prose };
      return {
        tool_calls: [
          {
            id: `call_${i}`,
            function: { name: "submit_review", arguments: JSON.stringify({ findings: r.findings }) },
          },
        ],
      };
    },
  };
  return { client, seen };
}

function review(replies: { findings?: unknown; prose?: string }[], plan = PLAN, maxAttempts = 2) {
  const { client, seen } = scriptedClient(replies);
  return {
    seen,
    run: runReviewer({ client, plan, strategy: STRATEGY, dataset: DATASET, maxAttempts }),
  };
}

console.log("test-reviewer\n");

// ---------------------------------------------------------------- 1. a clean approval
console.log("# 1. a sound plan with no findings is approved");
{
  const r = await review([{ findings: [] }]).run;
  check("the verdict is approve", r.verdict === "approve", r.verdict);
  check("nothing is blocking", blockersOf(r).length === 0, JSON.stringify(blockersOf(r)));
  check("nothing is degraded", r.degraded === false);
  check("the model was actually called", r.attempts === 1, String(r.attempts));
}

// ---------------------------------------------------------------- 2. the model can block
console.log("\n# 2. the model can make the review stricter");
{
  const r = await review([
    {
      findings: [
        {
          code: "ANGLE-DRIFT",
          severity: "block",
          where: "contentBriefs[1].hook",
          message: "this reads as a gym post, not the evening routine the angle asked for",
        },
      ],
    },
  ]).run;
  check("the verdict is revise", r.verdict === "revise", r.verdict);
  check("the finding is a blocker", blockersOf(r).length === 1, JSON.stringify(blockersOf(r)));
  check("the blocker names the field", blockersOf(r)[0]?.includes("contentBriefs[1].hook"));
}

// ---------------------------------------------------------------- 3. THE INVARIANT
console.log("\n# 3. a model CANNOT approve a plan that code has rejected");
{
  // The plan contains a statistic no row supports. The model, reading it,
  // reports nothing wrong. The plan must still be rejected - and the model
  // must not even be asked, because there is nothing to ask.
  const { seen, run } = review([{ findings: [] }], PLAN_WITH_FAKE_STAT);
  const r = await run;
  check("the verdict is revise", r.verdict === "revise", r.verdict);
  check(
    "the code finding survived",
    blockersOf(r).some((b) => b.includes("STAT-UNCITED")),
    JSON.stringify(blockersOf(r)),
  );
  check(
    "the finding points at the hook",
    blockersOf(r).some((b) => b.includes("contentBriefs[0].hook")),
    JSON.stringify(blockersOf(r)),
  );
  check("the model was never consulted", seen.length === 0, String(seen.length));
  check("no attempts were spent", r.attempts === 0, String(r.attempts));
  check("the judgement pass is empty", r.judgement.length === 0);
}

// ---------------------------------------------------------------- 4. warnings
console.log("\n# 4. a warning does not cost a revision");
{
  const r = await review([
    {
      findings: [
        {
          code: "TONE",
          severity: "warn",
          where: "contentBriefs[0].cta",
          message: "reads a little formal for this creator",
        },
      ],
    },
  ]).run;
  check("the verdict is still approve", r.verdict === "approve", r.verdict);
  check("nothing is blocking", blockersOf(r).length === 0);
  check("the warning is carried", warningsOf(r).length === 1, JSON.stringify(warningsOf(r)));
  check("the warning names the field", warningsOf(r)[0]?.includes("contentBriefs[0].cta"));
}

// ---------------------------------------------------------------- 5. bad codes
console.log("\n# 5. the model cannot invent a finding code");
{
  const r = await review([
    {
      findings: [
        { code: "VIBES-OFF", severity: "block", where: "plan", message: "something feels wrong" },
      ],
    },
  ]).run;
  check("an unknown code is rejected, not accepted", r.judgement.length === 0);
  check(
    "the run degraded rather than reporting a finding it could not route",
    r.degraded === true,
    String(r.degraded),
  );
}

// ---------------------------------------------------------------- 6. bad locations
console.log("\n# 6. the model cannot point a finding at a field that does not exist");
{
  const r = await review([
    {
      findings: [
        { code: "TONE", severity: "warn", where: "contentBriefs[7].hook", message: "off register" },
      ],
    },
  ]).run;
  check("the finding is not accepted", r.judgement.length === 0);
  check("the run degraded", r.degraded === true);

  const allowed = allowedLocations(PLAN);
  check("a real location is allowed", allowed.has("contentBriefs[1].cta"));
  check("a nonexistent brief is not", !allowed.has("contentBriefs[7].hook"));
  check("notes is allowed", allowed.has("notes"));
  check("plan-wide findings are allowed", allowed.has("plan"));
}

// ---------------------------------------------------------------- 7. degraded
console.log("\n# 7. a reviewer that cannot fill in its schema does not veto a valid plan");
{
  // Every reply is prose. The judgement pass never completes.
  const r = await review([{ prose: "Looks fine to me!" }], PLAN, 2).run;
  check("the verdict is approve", r.verdict === "approve", r.verdict);
  check("it is flagged as degraded", r.degraded === true);
  check("no blocker was invented", blockersOf(r).length === 0);
  check("it used every attempt", r.attempts === 2, String(r.attempts));
}

// ---------------------------------------------------------------- 8. validateReview
console.log("\n# 8. the review is validated like any other model output");
{
  const allowed = allowedLocations(PLAN);

  const ok = validateReview({ findings: [] }, allowed);
  check("an empty findings array is valid", ok.ok);

  const badSeverity = validateReview(
    { findings: [{ code: "TONE", severity: "fatal", where: "notes", message: "x" }] },
    allowed,
  );
  check("an unknown severity is rejected", !badSeverity.ok);
  check(
    "the error names the severity field",
    !badSeverity.ok && badSeverity.errors.some((e) => e.includes("severity")),
    !badSeverity.ok ? JSON.stringify(badSeverity.errors) : "",
  );

  const noMessage = validateReview(
    { findings: [{ code: "TONE", severity: "warn", where: "notes", message: "  " }] },
    allowed,
  );
  check("an empty message is rejected", !noMessage.ok);

  const notArray = validateReview({ findings: "none" }, allowed);
  check("findings must be an array", !notArray.ok);

  check(
    "the code vocabulary is closed and documented",
    Object.keys(REVIEW_CODES).length === 7,
    String(Object.keys(REVIEW_CODES).length),
  );
}

// ---------------------------------------------------------------- 9. renderPlan
console.log("\n# 9. the plan is rendered for the reviewer with every field it may cite");
{
  const text = renderPlan(PLAN);
  check("the week is shown", text.includes("2026-11-02"));
  check("each brief is indexed", text.includes("[0] kol_aria") && text.includes("[1] kol_bima"));
  check("the hook is shown", text.includes("rutinitas dua langkah sebelum tidur"));
  check("the cited rows are shown", text.includes("kol_aria_saves"));
  check("the notes are shown", text.includes("dua posting per kreator"));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} test-reviewer — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
