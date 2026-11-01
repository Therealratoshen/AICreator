/**
 * The validator's test. This file is the technical-skill evidence.
 *
 * It proves three things:
 *   1. a GOOD plan is accepted;
 *   2. every BAD plan is rejected, for the right reason, with the right message;
 *   3. the rejections are the ones that matter in practice - and each one is
 *      a mutation of the good plan, so a passing test cannot be a coincidence.
 *
 * The no-fakes rule gets its own test: a plan that cites a metric row nobody
 * has must be rejected even though every other field is perfect.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-plan-validator.ts
 */

import {
  validateCampaignPlan,
  rejectionFeedback,
  type CampaignPlan,
} from "../src/agent/campaign-plan.ts";

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

const METRIC_IDS = new Set(["row_post_1", "row_post_2", "row_aud_1"]);

const GOOD: CampaignPlan = {
  weekOf: "2026-11-02",
  cadencePerWeek: 3,
  creatorShortlist: [
    { creatorId: "kol_aria", reason: "median views 4,820 over the last 90 days", justifyingMetric: 4820 },
    { creatorId: "kol_budi", reason: "median saves 310, the highest in the beauty niche here", justifyingMetric: 310 },
  ],
  contentBriefs: [
    { creatorId: "kol_aria", objective: "introduce the serum", hook: "3 weeks of acne, one routine", cta: "link in bio", imageCount: 2 },
    { creatorId: "kol_budi", objective: "show the texture", hook: "this is the texture, no filter", cta: "link in bio", imageCount: 1 },
  ],
  citedMetrics: [
    { metric: "median_views_90d", sourceRowId: "row_post_1", value: 4820 },
    { metric: "median_saves_90d", sourceRowId: "row_aud_1", value: 310 },
  ],
  notes: "post twice in the first week to read the response before adding the third.",
};

console.log("test-plan-validator\n");

// ---------------------------------------------------------------- 1. the good plan
console.log("# 1. the good plan");
{
  const r = validateCampaignPlan(GOOD, METRIC_IDS);
  check("a good plan is accepted", r.ok, r.ok ? undefined : JSON.stringify((r as any).errors));
  if (r.ok) {
    check("the accepted plan keeps its creators", r.plan.creatorShortlist.length === 2);
    check("the accepted plan keeps its weekOf", r.plan.weekOf === "2026-11-02");
  }
}

// ---------------------------------------------------------------- 2. every mutation
console.log("\n# 2. every mutation of the good plan is rejected, for the right reason");

interface Mutation {
  name: string;
  mutate: (p: CampaignPlan) => unknown;
  expect: string;
}

const mutations: Mutation[] = [
  {
    name: "weekOf is not a Monday",
    mutate: (p) => ({ ...p, weekOf: "2026-11-03" }),
    expect: "must be a Monday",
  },
  {
    name: "weekOf is malformed",
    mutate: (p) => ({ ...p, weekOf: "02/11/2026" }),
    expect: "must be the format YYYY-MM-DD",
  },
  {
    name: "cadencePerWeek is zero",
    mutate: (p) => ({ ...p, cadencePerWeek: 0 }),
    expect: "between 1 and 14",
  },
  {
    name: "cadencePerWeek is a fraction",
    mutate: (p) => ({ ...p, cadencePerWeek: 2.5 }),
    expect: "whole number",
  },
  {
    name: "the shortlist is empty",
    mutate: (p) => ({ ...p, creatorShortlist: [] }),
    expect: "at least one creator",
  },
  {
    name: "a creator is shortlisted twice",
    mutate: (p) => ({
      ...p,
      creatorShortlist: [p.creatorShortlist[0], { ...p.creatorShortlist[0] }],
    }),
    expect: "already in the shortlist",
  },
  {
    name: "a reason has no number",
    mutate: (p) => ({
      ...p,
      creatorShortlist: [{ ...p.creatorShortlist[0], justifyingMetric: undefined }, p.creatorShortlist[1]],
    }),
    expect: "a reason without a number is not a reason",
  },
  {
    name: "a reason is missing",
    mutate: (p) => ({
      ...p,
      creatorShortlist: [{ ...p.creatorShortlist[0], reason: "" }, p.creatorShortlist[1]],
    }),
    expect: "reason is required",
  },
  {
    name: "a brief is for a creator who is not shortlisted",
    mutate: (p) => ({
      ...p,
      contentBriefs: [p.contentBriefs[0], { ...p.contentBriefs[1], creatorId: "kol_ghost" }],
    }),
    expect: "is not in the shortlist",
  },
  {
    name: "a shortlisted creator has no brief",
    mutate: (p) => ({ ...p, contentBriefs: [p.contentBriefs[0]] }),
    expect: "contentBriefs has no brief for it",
  },
  {
    name: "a brief has no hook",
    mutate: (p) => ({
      ...p,
      contentBriefs: [{ ...p.contentBriefs[0], hook: "" }, p.contentBriefs[1]],
    }),
    expect: "hook is required",
  },
  {
    name: "imageCount is out of range",
    mutate: (p) => ({
      ...p,
      contentBriefs: [{ ...p.contentBriefs[0], imageCount: 9 }, p.contentBriefs[1]],
    }),
    expect: "between 1 and 4",
  },
  {
    name: "🔴 a metric cites a row that does not exist",
    mutate: (p) => ({
      ...p,
      citedMetrics: [{ ...p.citedMetrics[0], sourceRowId: "row_that_does_not_exist" }],
    }),
    expect: "does not exist",
  },
  {
    name: "🔴 the plan cites no metric at all",
    mutate: (p) => ({ ...p, citedMetrics: [] }),
    expect: "a plan that cites no metric is not grounded",
  },
  {
    name: "🔴 a metric has no value",
    mutate: (p) => ({
      ...p,
      citedMetrics: [{ metric: "median_views_90d", sourceRowId: "row_post_1" }],
    }),
    expect: "value is required",
  },
  {
    name: "the notes are missing",
    mutate: (p) => ({ ...p, notes: "" }),
    expect: "notes is required",
  },
  {
    name: "the whole thing is prose, not a plan",
    mutate: () => "Here is your campaign plan. I think you should post on Tuesday...",
    expect: "must be an object",
  },
  {
    name: "the plan is an array",
    mutate: () => [GOOD],
    expect: "must be an object",
  },
  {
    name: "the plan is null",
    mutate: () => null,
    expect: "must be an object",
  },
];

for (const m of mutations) {
  const r = validateCampaignPlan(m.mutate(structuredClone(GOOD)), METRIC_IDS);
  if (r.ok) {
    check(m.name, false, "IT WAS ACCEPTED - the validator missed it");
    continue;
  }
  const all = r.errors.join(" | ");
  check(m.name, all.includes(m.expect), `the error did not mention "${m.expect}"; it said: ${all}`);
}

// ---------------------------------------------------------------- 3. the no-fakes rule
console.log("\n# 3. the no-fakes rule");
{
  // A plan whose every field is perfect, but which cites a row nobody has.
  const perfectButFake = { ...structuredClone(GOOD) };
  perfectButFake.citedMetrics = [
    { metric: "median_views_90d", sourceRowId: "row_invented_by_the_model", value: 999999 },
  ];
  const r = validateCampaignPlan(perfectButFake, METRIC_IDS);
  check("a perfect-looking plan with an invented row is rejected", !r.ok);
  if (!r.ok) {
    check(
      "the rejection names the invented row",
      r.errors.some((e) => e.includes("row_invented_by_the_model")),
      JSON.stringify(r.errors),
    );
  }

  // The same plan, with a row that DOES exist, is accepted.
  const sameButReal = { ...structuredClone(GOOD) };
  sameButReal.citedMetrics = [
    { metric: "median_views_90d", sourceRowId: "row_post_1", value: 4820 },
  ];
  const r2 = validateCampaignPlan(sameButReal, METRIC_IDS);
  check("the same plan with a real row is accepted", r2.ok);
}

// ---------------------------------------------------------------- 4. the rejection message
console.log("\n# 4. the rejection message is actionable");
{
  const r = validateCampaignPlan({ ...GOOD, weekOf: "2026-11-03", cadencePerWeek: 0 }, METRIC_IDS);
  check("the plan is rejected", !r.ok);
  if (!r.ok) {
    const msg = rejectionFeedback(r.errors);
    check("the message names the Monday rule", msg.includes("must be a Monday"), msg);
    check("the message names the cadence rule", msg.includes("between 1 and 14"), msg);
    check("the message asks for the tool to be called again", msg.includes("call submit_campaign_plan again"), msg);
    // NOTE: the message TELLS the model not to apologise, so the assertion is
    // "the message forbids an apology", not "the message has no apology word".
    check("the message forbids apologising instead of fixing", /do not apologise/i.test(msg), msg);
  }
}

// ---------------------------------------------------------------- the summary
console.log(`\n${failed === 0 ? "PASS" : "FAIL"} test-plan-validator — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
