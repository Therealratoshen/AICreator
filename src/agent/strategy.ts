/**
 * The campaign strategy - the contract between the planner and the writer.
 *
 * WHY A SECOND CONTRACT AT ALL
 * ----------------------------
 * The repo already has one contract (`CampaignPlan`) and one validator for it.
 * Adding a second looks like duplication until you look at what goes wrong
 * without it.
 *
 * A single agent asked for "a weekly plan" does the reasoning and the writing
 * in one breath. When the reviewer rejects the result, the retry has nothing
 * to hold on to except the error list: it re-reasons from scratch, and the
 * second attempt can contradict the first on decisions nobody complained
 * about. In practice the model changes the cadence while fixing a date.
 *
 * Splitting the decision from the writing gives the reviewer something to
 * check the plan *against*. The strategy is approved before a single sentence
 * of the plan exists, so a revision can be told "keep the strategy, fix these
 * fields" - and a plan that silently changes the cadence is now detectable in
 * code instead of being a judgement call.
 *
 * WHAT THIS FILE OWNS
 * -------------------
 *   the `CampaignStrategy` shape
 *   `validateCampaignStrategy` - the same standard as `CampaignPlan`: every
 *   number cites a row, and every row cited must exist.
 *
 * The rule is not relaxed for the planner. It is the agent that picks the
 * creators, so it is the one most likely to justify a pick with a number it
 * made up. `rationale` is therefore required per creator, not optional.
 */

import { KNOWN_TABLES } from "./campaign-plan.ts";
import type { MetricRow } from "./no-fakes.ts";

/** One creator the planner has decided to shortlist, and the number behind it. */
export type StrategyRationale = {
  /** Must be one of `creatorIds`. */
  creatorId: string;
  /** The metric name, in words, e.g. "median_saves_90d". */
  metric: string;
  /** The row this number came from. Must exist. */
  sourceRowId: string;
  /** The number. Must equal the row's own value, and the row must be about this creator. */
  value: number;
};

export type CampaignStrategy = {
  /** The Monday the plan starts, YYYY-MM-DD. */
  weekOf: string;
  /** Posts per week, per creator. 1-14. */
  cadencePerWeek: number;
  /** The creators to use, best first. 1-12. */
  creatorIds: string[];
  /** The content angle in one sentence - what every brief should express. */
  angle: string;
  /** One entry per creator in `creatorIds`. This is the justification. */
  rationale: StrategyRationale[];
  /**
   * What the writer must not do. Free-form, but it is carried into the
   * writer's prompt and shown to the brand, so it is a commitment.
   */
  constraints: string[];
};

export type StrategyValidation =
  | { ok: true; strategy: CampaignStrategy }
  | { ok: false; errors: string[] };

/** The facts the validator needs, which only the caller knows. */
export type StrategyContext = {
  /** Every metric row that exists, by id. Carries the value, so the value is checkable. */
  rows: ReadonlyMap<string, MetricRow>;
  /** Creator ids that exist. */
  creatorIds: ReadonlySet<string>;
  /**
   * Which creator (or brand) each row is about, by row id.
   *
   * This exists because "the row exists and the value matches" is not enough.
   * A planner can cite creator B's real row, with B's real number, to justify
   * picking creator A. Every other check passes and the shortlist is still a
   * lie - it just happens to be a well-formatted one.
   */
  subjectOf: ReadonlyMap<string, string>;
};

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** The day name, for the Monday error message. */
const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * Validate a strategy. Every failure is collected, for the same reason
 * `validateCampaignPlan` collects: the model gets one list, not one problem
 * per round trip.
 *
 * The three checks that carry the repo's promise:
 *
 *   - a creator the planner has not heard of is rejected, so the shortlist
 *     cannot contain a plausible-sounding name that does not exist;
 *   - a rationale citing a row that does not exist is rejected, so the
 *     justification cannot be a number the model invented;
 *   - a rationale citing a real row about somebody else is rejected, and so is
 *     a real row paired with the wrong value. This is the case the plan-level
 *     `checkNoFakes` cannot see: `checkNoFakes` takes a `CampaignPlan`, and a
 *     strategy is not one, so the check has to live here or nowhere.
 */
export function validateCampaignStrategy(
  input: unknown,
  ctx: StrategyContext,
): StrategyValidation {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["the strategy must be an object"] };
  }
  const s = input as Record<string, unknown>;

  // --- weekOf: an ISO date, and it must be a real Monday
  if (!isNonEmptyString(s.weekOf)) {
    errors.push("weekOf is required and must be an ISO date string (YYYY-MM-DD)");
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(s.weekOf)) {
    errors.push(`weekOf must be the format YYYY-MM-DD, got "${s.weekOf}"`);
  } else {
    const d = new Date(`${s.weekOf}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) {
      errors.push(`weekOf is not a real date: "${s.weekOf}"`);
    } else if (d.getUTCDay() !== 1) {
      errors.push(
        `weekOf must be a Monday, got ${s.weekOf} (a ${DAY_NAMES[d.getUTCDay()]})`,
      );
    }
  }

  // --- cadencePerWeek
  if (!isFiniteNumber(s.cadencePerWeek)) {
    errors.push("cadencePerWeek is required and must be a number");
  } else if (!Number.isInteger(s.cadencePerWeek)) {
    errors.push(
      `cadencePerWeek must be a whole number of posts, got ${s.cadencePerWeek}`,
    );
  } else if (s.cadencePerWeek < 1 || s.cadencePerWeek > 14) {
    errors.push(
      `cadencePerWeek must be between 1 and 14 posts per week, got ${s.cadencePerWeek}`,
    );
  }

  // --- creatorIds: non-empty, unique, every one real
  const ids = s.creatorIds;
  if (!Array.isArray(ids)) {
    errors.push("creatorIds is required and must be an array");
  } else if (ids.length === 0) {
    errors.push("creatorIds must have at least one creator");
  } else if (ids.length > 12) {
    errors.push(`creatorIds must have at most 12 creators, got ${ids.length}`);
  } else {
    const seen = new Set<string>();
    /**
     * A creator with no rows cannot be justified, and `rationale` is mandatory
     * per creator - so shortlisting one is an instruction that cannot be
     * carried out. Caught here rather than left to the model, which would
     * otherwise spend all three attempts trying to invent a number for a
     * creator the data says nothing about.
     */
    const withRows = new Set(ctx.subjectOf.values());
    ids.forEach((id, i) => {
      if (!isNonEmptyString(id)) {
        errors.push(`creatorIds[${i}] must be a non-empty string`);
        return;
      }
      if (seen.has(id)) {
        errors.push(`creatorIds[${i}] "${id}" is listed twice`);
        return;
      }
      seen.add(id);
      if (!ctx.creatorIds.has(id)) {
        errors.push(
          `creatorIds[${i}] "${id}" does not exist in the creator data - do not shortlist a creator you have not read`,
        );
        return;
      }
      if (!withRows.has(id)) {
        errors.push(
          `creatorIds[${i}] "${id}" has no rows in the data - every pick needs a number behind it, ` +
            `so this creator cannot be shortlisted. Drop it and shortlist someone the data covers.`,
        );
      }
    });
  }

  // --- angle
  if (!isNonEmptyString(s.angle)) {
    errors.push("angle is required - one sentence on what every brief should express");
  }

  // --- rationale: one per creator, each citing a real row
  const rationale = s.rationale;
  const listed = Array.isArray(ids)
    ? ids.filter((id): id is string => isNonEmptyString(id))
    : [];

  if (!Array.isArray(rationale)) {
    errors.push(
      "rationale is required and must be an array - every creator needs a number behind the pick",
    );
  } else if (rationale.length === 0) {
    errors.push("rationale is empty - a shortlist with no numbers is a guess");
  } else {
    const covered = new Set<string>();
    rationale.forEach((r, i) => {
      const at = `rationale[${i}]`;
      if (typeof r !== "object" || r === null) {
        errors.push(`${at} must be an object`);
        return;
      }
      const entry = r as Record<string, unknown>;

      if (!isNonEmptyString(entry.creatorId)) {
        errors.push(`${at}.creatorId is required`);
      } else if (!listed.includes(entry.creatorId)) {
        errors.push(
          `${at}.creatorId "${entry.creatorId}" is not in creatorIds - do not justify a creator you did not shortlist`,
        );
      } else {
        covered.add(entry.creatorId);
      }

      if (!isNonEmptyString(entry.metric)) {
        errors.push(`${at}.metric is required - name the number you are citing`);
      }

      if (!isNonEmptyString(entry.sourceRowId)) {
        errors.push(`${at}.sourceRowId is required - say which row the number came from`);
      } else {
        const row = ctx.rows.get(entry.sourceRowId);
        if (!row) {
          errors.push(
            `${at}.sourceRowId "${entry.sourceRowId}" does not exist - do not cite a row you have not read`,
          );
        } else {
          // Attribution is checked before the value, and reported instead of
          // it when both are wrong: "you used someone else's number" is the
          // correction the model needs, and naming both problems at once in
          // one sentence buries it.
          const subject = ctx.subjectOf.get(entry.sourceRowId);
          if (isNonEmptyString(entry.creatorId) && subject !== entry.creatorId) {
            errors.push(
              `${at}.sourceRowId "${entry.sourceRowId}" is about "${subject ?? "an unknown subject"}", not ` +
                `"${entry.creatorId}" - do not attribute another subject's number to this creator`,
            );
          } else if (isFiniteNumber(entry.value) && entry.value !== row.value) {
            errors.push(
              `${at}.value is ${entry.value} but row "${entry.sourceRowId}" holds ${row.value} - ` +
                `cite the row's value, or cite a different row`,
            );
          }
        }
      }

      if (!isFiniteNumber(entry.value)) {
        errors.push(`${at}.value is required and must be a number`);
      }
    });

    for (const id of listed) {
      if (!covered.has(id)) {
        errors.push(
          `creatorIds has "${id}" but rationale has no entry for it - every pick needs a number`,
        );
      }
    }
  }

  // --- constraints
  const constraints = s.constraints;
  if (!Array.isArray(constraints)) {
    errors.push("constraints is required and must be an array (may be empty)");
  } else {
    constraints.forEach((c, i) => {
      if (!isNonEmptyString(c)) {
        errors.push(`constraints[${i}] must be a non-empty string`);
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, strategy: s as unknown as CampaignStrategy };
}

/** The message that goes back to the planner after a rejection. */
export function strategyFeedback(errors: string[]): string {
  return [
    `The strategy was rejected by the validator. ${errors.length} problem(s) must be fixed.`,
    `Fix ONLY these fields and call submit_campaign_strategy again:`,
    ...errors.map((e, i) => `  ${i + 1}. ${e}`),
    `Do not explain. Do not apologise. Call the tool with the corrected arguments.`,
  ].join("\n");
}

/**
 * Which table a metric row came from, when the caller can say.
 *
 * Exported because the reviewer uses it to check a cited row belongs to a
 * table the plan is allowed to read. `KNOWN_TABLES` existed but nothing used
 * it; this is the check it was written for.
 */
export function isKnownTable(table: string): boolean {
  return (KNOWN_TABLES as readonly string[]).includes(table);
}

/**
 * The strategy as text, for the writer's prompt and for the brand's screen.
 *
 * The rationale is inlined against each creator rather than listed separately,
 * because the writer needs to know which number belongs to which creator and a
 * second list is one more thing to cross-reference - which is where the
 * wrong-creator mistake happens.
 */
export function renderStrategy(s: CampaignStrategy): string {
  const lines: string[] = [
    `WEEK: ${s.weekOf}`,
    `CADENCE: ${s.cadencePerWeek} post(s) per creator`,
    `ANGLE: ${s.angle}`,
    `CREATORS (in the planner's order):`,
  ];

  for (const id of s.creatorIds) {
    const r = s.rationale.find((x) => x.creatorId === id);
    lines.push(
      r
        ? `  ${id}  — ${r.metric} = ${r.value}  (row ${r.sourceRowId})`
        : `  ${id}  — (no rationale)`,
    );
  }

  lines.push(`CONSTRAINTS:`);
  if (s.constraints.length === 0) {
    lines.push(`  (none given)`);
  } else {
    for (const c of s.constraints) lines.push(`  - ${c}`);
  }

  return lines.join("\n");
}

/**
 * Did the writer keep the planner's decisions?
 *
 * WHY THIS IS A CHECK AND NOT A STRUCTURAL IMPOSSIBILITY
 * ------------------------------------------------------
 * `AGENTS.md` invariant 5 says the plan leaves through `submit_campaign_plan`
 * and nothing else. That means the writer emits a whole `CampaignPlan`,
 * including the three fields the planner decided. So the writer *can* disagree
 * with the planner, and something has to notice.
 *
 * This is that something. It is deliberately the only place that compares the
 * two, so "the writer changed the cadence" has exactly one answer and it is
 * not a judgement call.
 *
 * Only the decisions are compared. The writer's own `reason` text and its
 * cited metrics are checked by `checkNoFakes`, not here - this function is
 * about who decides what, not about whether a number is real.
 */
export function checkStrategyConformance(
  plan: { weekOf: string; cadencePerWeek: number; creatorShortlist: { creatorId: string }[] },
  strategy: CampaignStrategy,
): string[] {
  const errors: string[] = [];

  if (plan.weekOf !== strategy.weekOf) {
    errors.push(
      `weekOf is "${plan.weekOf}" but the approved strategy is for the week of ` +
        `"${strategy.weekOf}" - the week was decided before you were called. Do not change it.`,
    );
  }

  if (plan.cadencePerWeek !== strategy.cadencePerWeek) {
    errors.push(
      `cadencePerWeek is ${plan.cadencePerWeek} but the approved strategy set ` +
        `${strategy.cadencePerWeek} - the cadence was decided from the data. Do not change it.`,
    );
  }

  const planned = plan.creatorShortlist.map((c) => c.creatorId);
  const expected = strategy.creatorIds;

  const missing = expected.filter((id) => !planned.includes(id));
  const extra = planned.filter((id) => !expected.includes(id));

  if (missing.length > 0) {
    errors.push(
      `creatorShortlist is missing ${missing.map((m) => `"${m}"`).join(", ")} - the strategy ` +
        `shortlisted ${expected.map((e) => `"${e}"`).join(", ")}. Dropping a creator is a ` +
        `decision, and it was already made.`,
    );
  }

  if (extra.length > 0) {
    errors.push(
      `creatorShortlist adds ${extra.map((e) => `"${e}"`).join(", ")} - you cannot shortlist a ` +
        `creator the planner did not choose.`,
    );
  }

  if (missing.length === 0 && extra.length === 0 && planned.join("|") !== expected.join("|")) {
    errors.push(
      `creatorShortlist is ordered ${planned.join(", ")} but the strategy ordered them ` +
        `${expected.join(", ")}. Keep the planner's order: it is best first, by strength of ` +
        `evidence, and re-ordering silently reprioritises the campaign.`,
    );
  }

  return errors;
}
