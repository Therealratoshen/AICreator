/**
 * Agent 2 of 3: the writer.
 *
 * WHY IT CALLS `submit_campaign_plan` AND NOT A TOOL OF ITS OWN
 * -------------------------------------------------------------
 * `AGENTS.md` invariant 5: "The plan leaves through `submit_campaign_plan` and
 * nothing else." The tempting alternative is to give the writer a narrower
 * tool that emits only the briefs, and assemble the plan in code - then the
 * writer *cannot* disagree with the planner about the cadence, because the
 * field is not in its contract.
 *
 * That is a genuinely stronger guarantee, and it is not the one this repo
 * makes. The single exit is load-bearing for a different reason: it is what
 * guarantees the thing a human eventually reads was validated as a whole, by
 * one function, in one place. A plan assembled from two tool calls has two
 * halves that were each validated against their own contract, and nothing that
 * ever looked at the finished object.
 *
 * So the writer emits a complete plan, and the divergence risk that buys is
 * paid for with `checkStrategyConformance` - an explicit check with an
 * actionable error, instead of a field that is silently absent.
 *
 * THE FOUR GATES, IN ORDER
 * ------------------------
 *   1. `validateCampaignPlan`   - shape, the Monday rule, rows that exist.
 *   2. `checkNoFakes`           - cited values equal the rows' own values.
 *   3. `checkStrategyConformance` - week, cadence and shortlist unchanged.
 *   4. the claim scan           - statistics in prose with no row behind them,
 *                                 and promises no row could ever back.
 *
 * All four run inside the retry loop, so a failure comes back to the model as
 * a list of exact fields while it can still act on it. The reviewer is a
 * *second opinion*, not the first check.
 */

import { MODEL, SUBMIT_CAMPAIGN_PLAN_TOOL, type ChatClient } from "./copilot.ts";
import { validateCampaignPlan, type CampaignPlan } from "./campaign-plan.ts";
import { checkNoFakes } from "./no-fakes.ts";
import { runToolLoop, type LoopTurn } from "./tool-loop.ts";
import {
  checkStrategyConformance,
  renderStrategy,
  validateCampaignStrategy,
  type CampaignStrategy,
} from "./strategy.ts";
import {
  renderDataset,
  metricIdsOf,
  rowsToMap,
  strategyContextOf,
  type BrandDataset,
} from "./dataset.ts";
import {
  allowedValues,
  scanBareStatistics,
  scanClaims,
  type Finding,
} from "./claims.ts";

export const WRITER_MODEL = MODEL;
export const WRITER_MAX_ATTEMPTS = 3;

/** A finding, phrased so the model can act on it and a person can read it. */
function findingLine(f: Finding): string {
  return `${f.where}: [${f.code}] ${f.message}`;
}

/**
 * The claim scan over everything a human will read.
 *
 * Only `block` findings become errors. Warnings are deliberately excluded:
 * a superlative is worth showing the brand, but it is not worth spending one
 * of three attempts on, and a gate that rejects a good draft over an adjective
 * is a gate that makes the system worse at its job.
 */
export function scanPlanCopy(
  plan: Pick<CampaignPlan, "contentBriefs" | "citedMetrics" | "notes">,
  extraAllowed: readonly number[] = [],
): Finding[] {
  const allowed = allowedValues(plan.citedMetrics, extraAllowed);
  const findings: Finding[] = [];

  for (const [i, brief] of plan.contentBriefs.entries()) {
    for (const field of ["objective", "hook", "cta"] as const) {
      const where = `contentBriefs[${i}].${field}`;
      const text = brief[field];
      if (typeof text !== "string") continue;
      findings.push(...scanClaims(text, where));
      findings.push(...scanBareStatistics(text, where, allowed));
    }
  }

  // The note to the brand is prose too, and it is the part a brand is most
  // likely to quote. It gets the same treatment.
  if (typeof plan.notes === "string") {
    findings.push(...scanClaims(plan.notes, "notes"));
    findings.push(...scanBareStatistics(plan.notes, "notes", allowed));
  }

  return findings;
}

/**
 * The writer's system prompt.
 *
 * The compliance section states what will be checked rather than offering
 * advice, for the same reason as the planner: a model that knows the rules
 * spends its three attempts recovering rather than re-guessing. The checks
 * themselves still run afterwards, and they are the gate.
 */
export function buildWriterSystemPrompt(strategy: CampaignStrategy, dataset: BrandDataset): string {
  return [
    "You are the WRITER, the second of three agents in a creator-marketing engine.",
    "The PLANNER has already decided the week, the cadence, the creators and the angle, and has",
    "justified each creator with a row from the data. A REVIEWER will read your plan afterwards.",
    "",
    "YOUR JOB",
    "Turn the approved strategy into a campaign plan: one content brief per shortlisted creator,",
    "the metrics the copy rests on, and one note to the brand. Write in the register the creator",
    "actually uses - the brand's audience reads these as posts, not as advertising copy.",
    "",
    "THE STRATEGY IS FIXED",
    "You emit the whole plan, including weekOf, cadencePerWeek and creatorShortlist. Those three",
    "were decided before you were called. Copy them from the strategy exactly: same week, same",
    "cadence, same creators, in the same order. Changing any of them is rejected in code.",
    "",
    "THE HOUSE RULE",
    "Every number that appears in your copy must come from a row listed below, must be listed in",
    "citedMetrics with that row's id, and must be quoted at exactly the row's value. This applies",
    "to the hook, the objective and the call to action alike - a number written inside a sentence",
    "is still a number. There is no exception for rounded figures, estimates, or totals you",
    "computed yourself.",
    "",
    "WHAT IS CHECKED IN CODE, ALL OF IT BLOCKING",
    "  1. The shape, the Monday rule, and every sourceRowId must exist.",
    "  2. Every cited value must equal the row's own value, and every creator's justification must",
    "     trace to a real row.",
    "  3. weekOf, cadencePerWeek and the creator list must match the strategy exactly.",
    "  4. Any statistic in the copy that no cited row supports. A statistic is a number of 100 or",
    "     more, or anything with a percentage.",
    "  5. These claims, because no row could ever support them:",
    "       - guarantees (dijamin, garansi, guaranteed)",
    "       - cure or treatment claims (menyembuhkan, mengobati, cures)",
    "       - proof claims (terbukti, teruji klinis, clinically proven)",
    "       - absolutes (100%, selamanya, permanen)",
    "",
    "These are only warnings and will not send the plan back, but the brand sees them: superlatives",
    "(terbaik, nomor satu, #1) and outcome promises (pasti viral, guaranteed reach). Avoid them",
    "anyway - a superlative is a comparison the data does not contain.",
    "",
    "If the data does not support a claim you want to make, make a smaller claim. A plan that says",
    "less and can be defended is the product; a plan that says more and cannot be is the thing",
    "this engine exists to stop.",
    "",
    "=== THE APPROVED STRATEGY (fixed - do not revise it) ===",
    renderStrategy(strategy),
    "",
    "=== DATA (the only numbers that exist) ===",
    renderDataset(dataset),
    "=== END DATA ===",
  ].join("\n");
}

export function buildWriterUserPrompt(
  strategy: CampaignStrategy,
  brief: string,
  revision: readonly string[] = [],
): string {
  const lines = [
    `Write the campaign plan for the week of ${strategy.weekOf}.`,
    "",
    "WHAT THE BRAND ASKED FOR, IN THEIR OWN WORDS:",
    brief.trim() || "(no specific ask - follow the strategy)",
  ];

  /**
   * A revision is not a fresh start. The reviewer approved the structure and
   * objected to specific fields, so the instruction says which - otherwise the
   * second attempt re-decides choices nobody complained about, and the plan
   * that comes back is different everywhere instead of fixed where it was
   * wrong.
   */
  if (revision.length > 0) {
    lines.push(
      "",
      "THE REVIEWER REJECTED YOUR PREVIOUS PLAN. These are the only problems:",
      ...revision.map((r, i) => `  ${i + 1}. ${r}`),
      "",
      "Rewrite the plan so these are fixed. Keep everything the reviewer did not object to -",
      "the week, the cadence and the creators are still fixed by the strategy.",
    );
  }

  lines.push("", "Call submit_campaign_plan.");
  return lines.join("\n");
}

export type WriterResult = {
  ok: boolean;
  plan?: CampaignPlan;
  /** Every blocking reason, flattened, when the loop ran out of attempts. */
  errors?: string[];
  /**
   * Non-blocking findings from the last attempt. Carried forward so the
   * reviewer and the brand's screen can show them - a warning that is dropped
   * is a warning that was never raised.
   */
  warnings: Finding[];
  attempts: number;
  transcript: LoopTurn[];
};

/**
 * Run the writer until a plan passes all four gates, or until `maxAttempts`.
 *
 * The strategy is re-validated before the model is called. A strategy that
 * names a creator with no rows is unsatisfiable - the writer would be asked to
 * justify a creator the data says nothing about - so that is a caller bug and
 * throws, rather than burning three attempts on an impossible instruction.
 */
export async function runWriter(args: {
  client: ChatClient;
  strategy: CampaignStrategy;
  dataset: BrandDataset;
  /** The brand's original ask, carried through for context. */
  brief: string;
  /** Blocking findings from a previous review, when this is a revision. */
  revision?: readonly string[];
  maxAttempts?: number;
}): Promise<WriterResult> {
  const check = validateCampaignStrategy(args.strategy, strategyContextOf(args.dataset));
  if (!check.ok) {
    throw new Error(
      `runWriter: the strategy is not valid, so no plan can be written from it:\n` +
        check.errors.map((e) => `  - ${e}`).join("\n"),
    );
  }

  const metricIds = metricIdsOf(args.dataset);
  const rows = rowsToMap(args.dataset);
  const extraAllowed = args.strategy.rationale.map((r) => r.value);

  /** Findings from the most recent attempt, so warnings survive a rejection. */
  let lastWarnings: Finding[] = [];

  const loop = await runToolLoop<CampaignPlan>({
    client: args.client,
    model: WRITER_MODEL,
    systemPrompt: buildWriterSystemPrompt(args.strategy, args.dataset),
    userPrompt: buildWriterUserPrompt(args.strategy, args.brief, args.revision),
    tool: SUBMIT_CAMPAIGN_PLAN_TOOL,
    toolName: "submit_campaign_plan",
    maxAttempts: args.maxAttempts ?? WRITER_MAX_ATTEMPTS,
    validate: (input) => {
      // 1. the existing gate, unchanged
      const shape = validateCampaignPlan(input, metricIds);
      if (!shape.ok) return { ok: false, errors: shape.errors };
      const plan = shape.plan;

      const errors: string[] = [];

      // 2. the existing second opinion on the numbers
      const noFakes = checkNoFakes(plan, rows);
      if (!noFakes.ok) errors.push(...noFakes.errors);

      // 3. did it keep the planner's decisions
      errors.push(...checkStrategyConformance(plan, args.strategy));

      // 4. the claims no other guard can see
      const findings = scanPlanCopy(plan, extraAllowed);
      lastWarnings = findings.filter((f) => f.severity === "warn");
      errors.push(...findings.filter((f) => f.severity === "block").map(findingLine));

      if (errors.length > 0) return { ok: false, errors };
      return { ok: true, value: plan };
    },
    feedback: writerFeedback,
  });

  if (loop.ok) {
    return {
      ok: true,
      plan: loop.value,
      warnings: lastWarnings,
      attempts: loop.attempts,
      transcript: loop.transcript,
    };
  }

  return {
    ok: false,
    errors: loop.errors,
    warnings: lastWarnings,
    attempts: loop.attempts,
    transcript: loop.transcript,
  };
}

/**
 * The message that goes back to the writer after a rejection.
 *
 * Its own function rather than `rejectionFeedback` from `campaign-plan.ts`
 * because this loop can reject for reasons that file has never heard of - a
 * conformance failure, an uncited statistic - and the instruction to fix "only
 * these fields" is what stops the model rewriting a plan that was 90% right.
 */
export function writerFeedback(errors: string[]): string {
  return [
    `The plan was rejected. ${errors.length} problem(s) must be fixed.`,
    `Fix ONLY these problems and call submit_campaign_plan again:`,
    ...errors.map((e, i) => `  ${i + 1}. ${e}`),
    `Do not explain. Do not apologise. Call the tool with the corrected arguments.`,
  ].join("\n");
}
