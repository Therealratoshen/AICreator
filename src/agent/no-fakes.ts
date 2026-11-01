/**
 * The no-fakes guard.
 *
 * THE HOUSE RULE (from justnewme.com's own README):
 *   "Never publish a number, a stat, a date, or a promise that isn't backed by data."
 *
 * This is that rule, as executable code. It is the check that runs over a
 * finished plan before anything is shown to a brand or a creator:
 *
 *   every number in the plan must correspond to a row that exists;
 *   the value in the plan must equal the value in the row.
 *
 * A model is good at producing a plausible number. Plausible is not the bar.
 * The bar is: the number is in the database, and it says what the plan says
 * it says.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-no-fakes.ts
 */

import { validateCampaignPlan, type CampaignPlan } from "./campaign-plan.ts";

export type MetricRow = {
  id: string;
  /** The value the row holds. */
  value: number;
  /** Which table the row lives in. */
  table: string;
};

/**
 * Check a plan against the rows that actually exist.
 *
 * Returns every discrepancy, so the caller can show all of them at once.
 */
export function checkNoFakes(
  plan: CampaignPlan,
  rows: ReadonlyMap<string, MetricRow>,
): { ok: true } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  for (const cited of plan.citedMetrics) {
    const row = rows.get(cited.sourceRowId);
    if (!row) {
      errors.push(`citedMetrics: "${cited.sourceRowId}" does not exist in the data`);
      continue;
    }
    if (row.value !== cited.value) {
      errors.push(
        `citedMetrics: "${cited.metric}" is cited as ${cited.value} but the row ` +
          `"${cited.sourceRowId}" holds ${row.value}`,
      );
    }
  }

  // The justifying metric on each creator must also be a real row's value.
  for (const cand of plan.creatorShortlist) {
    const matching = plan.citedMetrics.find(
      (m) => m.value === cand.justifyingMetric && rows.has(m.sourceRowId),
    );
    if (!matching) {
      errors.push(
        `creatorShortlist: "${cand.creatorId}" justifies the pick with ${cand.justifyingMetric}, ` +
          `but no cited metric with that value traces to a real row`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

export { validateCampaignPlan };
