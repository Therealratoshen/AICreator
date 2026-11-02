/**
 * Agent 3 of 3: the reviewer.
 *
 * WHAT A THIRD AGENT IS FOR, GIVEN THE WRITER ALREADY VALIDATES
 * -------------------------------------------------------------
 * The writer runs four gates inside its own loop, so by the time a plan
 * reaches this file it is already structurally valid, number-clean,
 * strategy-conformant and claim-scanned. A reviewer that re-ran those would
 * add nothing.
 *
 * So this file does two different things, and the split is the whole design:
 *
 *   1. RE-RUNS the code checks. Not because they might have been skipped, but
 *      because this is the last place before a human sees the plan, and the
 *      plan that arrives here was not necessarily produced by `runWriter` - it
 *      could have been assembled, cached, or passed in from the web layer.
 *      A guard that trusts its caller is not a guard.
 *
 *   2. ADDS a judgement pass on the things no regex can decide: does the copy
 *      actually express the angle, does a brief quietly break a constraint,
 *      does it read like an ad instead of a post.
 *
 * THE RULE THAT MAKES THE SPLIT SAFE
 * ----------------------------------
 * The model may ADD findings. It may never REMOVE one.
 *
 * The verdict is computed in code as `anyDeterministicBlock || anyModelBlock`.
 * A model that reads a plan containing a fabricated statistic and reports
 * "looks good" cannot approve it, because the code finding is already in the
 * list and the verdict never consults the model for permission. The model's
 * judgement can only make the review stricter.
 *
 * That asymmetry is deliberate. A model is good at noticing that something
 * reads wrong, and bad at being trusted not to miss something.
 */

import { MODEL, type ChatClient } from "./copilot.ts";
import {
  validateCampaignPlan,
  type CampaignPlan,
} from "./campaign-plan.ts";
import { checkNoFakes } from "./no-fakes.ts";
import { runToolLoop, type LoopTurn } from "./tool-loop.ts";
import {
  checkStrategyConformance,
  renderStrategy,
  type CampaignStrategy,
} from "./strategy.ts";
import { metricIdsOf, renderDataset, rowsToMap, type BrandDataset } from "./dataset.ts";
import {
  allowedValues,
  scanBareStatistics,
  scanClaims,
  type Finding,
} from "./claims.ts";

export const REVIEWER_MODEL = MODEL;
export const REVIEWER_MAX_ATTEMPTS = 2;

/**
 * The vocabulary a review finding may use.
 *
 * Closed on purpose. A model allowed to invent codes produces findings the
 * orchestrator cannot route, the UI cannot colour, and nobody can count - so
 * an unknown code is a rejection, not a new category.
 */
export const REVIEW_CODES = {
  "ANGLE-DRIFT": "the copy does not express the angle the strategy set",
  "CONSTRAINT-BREACH": "a brief does something the strategy's constraints forbid",
  MISLEADING: "the copy implies something the data does not support",
  TONE: "the register reads like an advertisement rather than the creator's own post",
  DUPLICATE: "two briefs are the same idea, so the week repeats itself",
  "WEAK-CTA": "the call to action does not ask the reader to do anything",
  UNSUPPORTED: "a claim about the product that no row backs",
} as const;

export type ReviewCode = keyof typeof REVIEW_CODES;

/** A finding from the judgement pass, as the model reports it. */
export type ReviewFinding = {
  code: ReviewCode;
  severity: "block" | "warn";
  /** A field of the plan: "contentBriefs[0].hook", "notes", or "plan". */
  where: string;
  message: string;
};

export type ReviewReport = {
  /**
   * "approve" is the only verdict that lets a plan through. Anything else
   * costs a revision, and a revision that never converges escalates.
   */
  verdict: "approve" | "revise";
  /** Findings from code. These cannot be argued with. */
  deterministic: Finding[];
  /** Findings from the model's reading. */
  judgement: ReviewFinding[];
  /**
   * True when the judgement pass could not complete. The plan is still
   * code-valid; it has simply not been read by a model. Surfaced rather than
   * hidden, because "no findings" and "no review happened" are different
   * things and only one of them is reassuring.
   */
  degraded: boolean;
  attempts: number;
  transcript: LoopTurn[];
};

/** Where a finding is allowed to point. Derived from the plan, never guessed. */
export function allowedLocations(plan: CampaignPlan): Set<string> {
  const where = new Set<string>(["plan", "notes"]);
  plan.contentBriefs.forEach((_, i) => {
    for (const field of ["objective", "hook", "cta"] as const) {
      where.add(`contentBriefs[${i}].${field}`);
    }
  });
  return where;
}

/**
 * Validate the model's review.
 *
 * This is the same standard the plan itself is held to: a claim about the
 * world must be anchored to something that exists. Here the anchor is a field
 * of the plan, so "contentBriefs[7].hook" in a plan with two briefs is
 * rejected rather than reported - a finding pointing at nothing is noise the
 * writer cannot act on.
 */
export function validateReview(
  input: unknown,
  allowed: ReadonlySet<string>,
): { ok: true; value: ReviewFinding[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["the review must be an object"] };
  }
  const r = input as Record<string, unknown>;
  const findings = r.findings;

  if (!Array.isArray(findings)) {
    errors.push("findings is required and must be an array (it may be empty)");
    return { ok: false, errors };
  }

  const codes = Object.keys(REVIEW_CODES) as string[];

  findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (typeof f !== "object" || f === null) {
      errors.push(`${at} must be an object`);
      return;
    }
    const finding = f as Record<string, unknown>;

    if (typeof finding.code !== "string" || !codes.includes(finding.code)) {
      errors.push(
        `${at}.code must be one of ${codes.join(", ")} - got ${JSON.stringify(finding.code)}`,
      );
    }

    if (finding.severity !== "block" && finding.severity !== "warn") {
      errors.push(`${at}.severity must be "block" or "warn"`);
    }

    if (typeof finding.where !== "string" || !allowed.has(finding.where)) {
      errors.push(
        `${at}.where must be a field of this plan (${[...allowed].slice(0, 6).join(", ")}, …) - ` +
          `got ${JSON.stringify(finding.where)}`,
      );
    }

    if (typeof finding.message !== "string" || finding.message.trim().length === 0) {
      errors.push(`${at}.message is required - say what is wrong, in one sentence`);
    }
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: findings as ReviewFinding[] };
}

export const SUBMIT_REVIEW_TOOL = {
  type: "function" as const,
  function: {
    name: "submit_review",
    description:
      "Submit the review. This is the ONLY way to deliver a review. Report findings, or an empty " +
      "array if the plan is sound. You cannot approve or reject - the verdict is computed from the " +
      "findings and from checks that already ran in code.",
    parameters: {
      type: "object",
      properties: {
        findings: {
          type: "array",
          description:
            "Every problem you can see. Empty if there are none. Do not report a problem you are " +
            "not confident about - each blocking finding costs the writer a full revision.",
          items: {
            type: "object",
            properties: {
              code: {
                type: "string",
                enum: Object.keys(REVIEW_CODES),
                description: "Which kind of problem this is.",
              },
              severity: {
                type: "string",
                enum: ["block", "warn"],
                description:
                  "'block' means the plan must be rewritten. 'warn' means a human should see it " +
                  "but the plan can ship.",
              },
              where: {
                type: "string",
                description:
                  'The field: "contentBriefs[0].hook", "contentBriefs[0].objective", ' +
                  '"contentBriefs[0].cta", "notes", or "plan" for a whole-plan finding.',
              },
              message: {
                type: "string",
                description: "What is wrong and what to do instead, in one sentence.",
              },
            },
            required: ["code", "severity", "where", "message"],
          },
        },
      },
      required: ["findings"],
    },
  },
};

/** The plan as text, for the reviewer's prompt and for the transcript. */
export function renderPlan(plan: CampaignPlan): string {
  const lines: string[] = [
    `WEEK: ${plan.weekOf}   CADENCE: ${plan.cadencePerWeek} post(s) per creator`,
    "",
    "SHORTLIST (best first):",
  ];

  for (const c of plan.creatorShortlist) {
    lines.push(`  ${c.creatorId}  justified by ${c.justifyingMetric}  — ${c.reason}`);
  }

  lines.push("", "BRIEFS:");
  plan.contentBriefs.forEach((b, i) => {
    lines.push(`  [${i}] ${b.creatorId}   (${b.imageCount} image(s))`);
    lines.push(`      objective: ${b.objective}`);
    lines.push(`      hook     : ${b.hook}`);
    lines.push(`      cta      : ${b.cta}`);
  });

  lines.push("", "CITED METRICS:");
  for (const m of plan.citedMetrics) {
    lines.push(`  ${m.metric} = ${m.value}   (row ${m.sourceRowId})`);
  }

  lines.push("", `NOTES: ${plan.notes}`);
  return lines.join("\n");
}

export function buildReviewerSystemPrompt(
  strategy: CampaignStrategy,
  dataset: BrandDataset,
): string {
  return [
    "You are the REVIEWER, the third and last agent in a creator-marketing engine.",
    "A PLANNER decided the week and justified each creator with a row of data. A WRITER turned",
    "that into content briefs. Your job is to read the result the way a careful brand manager",
    "would, and report what is wrong with it.",
    "",
    "YOU DO NOT REWRITE. You report findings. The writer revises.",
    "",
    "WHAT HAS ALREADY BEEN CHECKED IN CODE, AND WILL NOT BE CHECKED AGAIN BY YOU",
    "  - the shape of the plan, and that the week is a Monday",
    "  - that every cited row exists, and that every cited value equals the row's value",
    "  - that the week, cadence and creator list match the approved strategy",
    "  - that no statistic in the copy lacks a cited row",
    "  - that no guarantee, cure claim, proof claim or absolute appears in the copy",
    "Do not report any of those. They are already decided, and repeating them wastes a revision.",
    "",
    "WHAT ONLY YOU CAN SEE",
    "  ANGLE-DRIFT        - the briefs do not actually express the angle below",
    "  CONSTRAINT-BREACH  - a brief does something a constraint forbids",
    "  MISLEADING         - the copy implies something the data does not support, in a way a",
    "                       regex cannot catch (e.g. a before/after that the numbers do not show)",
    "  TONE               - it reads like an advertisement rather than the creator's own post",
    "  DUPLICATE          - two briefs are the same idea, so the week repeats itself",
    "  WEAK-CTA           - the call to action does not ask the reader to do anything",
    "  UNSUPPORTED        - a claim about the product that no row backs",
    "",
    "HOW TO REPORT",
    "Use `block` only when the plan must be rewritten before a brand sees it. Use `warn` when a",
    "human should decide. Every blocking finding costs the writer a full revision, so a false",
    "block is expensive and a missed block is worse. If the plan is sound, submit an empty array -",
    "that is a real answer, not a failure to find something.",
    "",
    "Point `where` at the field you mean. A finding that points at nothing cannot be fixed.",
    "",
    "=== THE APPROVED STRATEGY (what the plan must express) ===",
    renderStrategy(strategy),
    "",
    "=== DATA ===",
    renderDataset(dataset),
    "=== END DATA ===",
  ].join("\n");
}

export function buildReviewerUserPrompt(plan: CampaignPlan): string {
  return [
    "Here is the plan the writer produced. Review it.",
    "",
    renderPlan(plan),
    "",
    "Call submit_review.",
  ].join("\n");
}

/**
 * The code half of the review.
 *
 * Returns blocking findings only. The claim scan's warnings are returned
 * separately by `runReviewer`, because they have already been raised by the
 * writer and raising them twice makes the report look worse than the plan is.
 */
function deterministicReview(
  plan: CampaignPlan,
  strategy: CampaignStrategy,
  dataset: BrandDataset,
): Finding[] {
  const findings: Finding[] = [];

  // The shape gate, re-run. If the plan arriving here is invalid, nothing
  // below it is meaningful and the caller needs to know before a model is
  // asked for an opinion on it.
  const shape = validateCampaignPlan(plan, metricIdsOf(dataset));
  if (!shape.ok) {
    for (const e of shape.errors) {
      findings.push({
        code: "PLAN-INVALID",
        severity: "block",
        where: "plan",
        excerpt: e,
        message: e,
      });
    }
  }

  const noFakes = checkNoFakes(plan, rowsToMap(dataset));
  if (!noFakes.ok) {
    for (const e of noFakes.errors) {
      findings.push({ code: "NO-FAKES", severity: "block", where: "plan", excerpt: e, message: e });
    }
  }

  for (const e of checkStrategyConformance(plan, strategy)) {
    findings.push({
      code: "CONFORMANCE",
      severity: "block",
      where: "plan",
      excerpt: e,
      message: e,
    });
  }

  const allowed = allowedValues(plan.citedMetrics, strategy.rationale.map((r) => r.value));
  plan.contentBriefs.forEach((brief, i) => {
    for (const field of ["objective", "hook", "cta"] as const) {
      const where = `contentBriefs[${i}].${field}`;
      const text = brief[field];
      if (typeof text !== "string") continue;
      for (const f of scanClaims(text, where)) {
        if (f.severity === "block") findings.push(f);
      }
      findings.push(...scanBareStatistics(text, where, allowed));
    }
  });

  for (const f of scanClaims(plan.notes, "notes")) {
    if (f.severity === "block") findings.push(f);
  }
  findings.push(...scanBareStatistics(plan.notes, "notes", allowed));

  return findings;
}

/**
 * Review a plan.
 *
 * Order matters and is deliberate: the code runs first. If it finds a blocker,
 * the model is never called - there is nothing a judgement pass can add to a
 * plan that has already failed a deterministic check, and spending a model
 * call to ask "what do you think of this invalid plan" is how a review loop
 * gets slow and confusing.
 */
export async function runReviewer(args: {
  client: ChatClient;
  plan: CampaignPlan;
  strategy: CampaignStrategy;
  dataset: BrandDataset;
  maxAttempts?: number;
}): Promise<ReviewReport> {
  const deterministic = deterministicReview(args.plan, args.strategy, args.dataset);

  if (deterministic.length > 0) {
    return {
      verdict: "revise",
      deterministic,
      judgement: [],
      degraded: false,
      attempts: 0,
      transcript: [],
    };
  }

  const allowed = allowedLocations(args.plan);

  const loop = await runToolLoop<ReviewFinding[]>({
    client: args.client,
    model: REVIEWER_MODEL,
    systemPrompt: buildReviewerSystemPrompt(args.strategy, args.dataset),
    userPrompt: buildReviewerUserPrompt(args.plan),
    tool: SUBMIT_REVIEW_TOOL,
    toolName: "submit_review",
    maxAttempts: args.maxAttempts ?? REVIEWER_MAX_ATTEMPTS,
    validate: (input) => validateReview(input, allowed),
    feedback: (errors) =>
      [
        `The review was rejected. ${errors.length} problem(s) must be fixed.`,
        `Fix ONLY these and call submit_review again:`,
        ...errors.map((e, i) => `  ${i + 1}. ${e}`),
      ].join("\n"),
  });

  if (!loop.ok) {
    /**
     * The judgement pass could not produce a well-formed review.
     *
     * This is NOT a veto. The plan passed every deterministic check, and
     * failing to audit something is not the same as finding it wrong -
     * escalating here would make the whole pipeline hostage to the reviewer's
     * ability to fill in a schema. So the plan is approved on the evidence
     * that exists, and `degraded` says plainly that no model read it.
     */
    return {
      verdict: "approve",
      deterministic: [],
      judgement: [],
      degraded: true,
      attempts: loop.attempts,
      transcript: loop.transcript,
    };
  }

  const judgement = loop.value;
  const modelBlocked = judgement.some((f) => f.severity === "block");

  return {
    verdict: modelBlocked ? "revise" : "approve",
    deterministic: [],
    judgement,
    degraded: false,
    attempts: loop.attempts,
    transcript: loop.transcript,
  };
}

/**
 * The findings that must be fixed before the plan can ship.
 *
 * Both sources are included, and the model's verdict is not consulted - this
 * function is what enforces "the model may add, never remove".
 */
export function blockersOf(report: ReviewReport): string[] {
  const fromCode = report.deterministic
    .filter((f) => f.severity === "block")
    .map((f) => `${f.where}: [${f.code}] ${f.message}`);

  const fromModel = report.judgement
    .filter((f) => f.severity === "block")
    .map((f) => `${f.where}: [${f.code}] ${f.message}`);

  return [...fromCode, ...fromModel];
}

/** Everything a human should see but that does not stop the plan. */
export function warningsOf(report: ReviewReport): string[] {
  return [
    ...report.deterministic
      .filter((f) => f.severity === "warn")
      .map((f) => `${f.where}: [${f.code}] ${f.message}`),
    ...report.judgement
      .filter((f) => f.severity === "warn")
      .map((f) => `${f.where}: [${f.code}] ${f.message}`),
  ];
}
