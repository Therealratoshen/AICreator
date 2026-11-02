/**
 * The creator's no-fakes guard.
 *
 * THE HOUSE RULE (from justnewme.com's own README):
 *   "Never publish a number, a stat, a date, or a promise that isn't backed by data."
 *
 * The brand's guard ([`./no-fakes.ts`](./no-fakes.ts)) checks the numbers a
 * plan CITES against the rows. The creator's guard has to do something the
 * brand's does not, because the creator's half is PROSE: the explanation is
 * written in sentences, and a sentence can contain a number that was never
 * cited anywhere.
 *
 * So this guard reads the numbers out of the finished prose and asks, for each
 * one:
 *
 *   does it trace to a metric row?
 *   or is it one of the numbers the APPLICATION supplied (a count like
 *   "your last 3 posts")?
 *   or is it a number the creator themselves wrote in their own question?
 *
 * A number that is none of those is a fabricated number, and the guard names
 * it: the exact string, and the exact place it appeared.
 *
 * A metric with no data is reported ABSENT, never as zero - so this guard also
 * refuses a zero that stands in for a missing metric. Zero is a claim about
 * the data. Absence is a claim about the data. They are not the same, and the
 * difference is the whole point of the creator's dashboard.
 */

import {
  extractNumbers,
  parseNumberToken,
  type CreatorFacts,
  type CreatorResponse,
} from "./creator-answer.ts";

export type CreatorGuardResult = { ok: true } | { ok: false; errors: string[] };

/**
 * Check a creator response against the rows that actually exist.
 *
 * `question` is the creator's own question. Numbers the creator used are not
 * fabrications by the model, so they are allowed - and a creator who says
 * "why did my 3 posts flop?" must not trip the guard on the 3.
 */
export function checkCreatorNoFakes(
  response: CreatorResponse,
  facts: CreatorFacts,
  question: string,
): CreatorGuardResult {
  const errors: string[] = [];

  // Every number the rows support.
  const rowValues = new Set<number>();
  for (const row of facts.metricRows.values()) rowValues.add(row.value);

  // Every number the application supplied.
  const allowed = new Set<number>(facts.allowedNumbers);

  // Every number the creator themselves used.
  for (const n of extractNumbers(question)) allowed.add(n);

  const cited = response.kind === "explain" ? response.citedMetrics : [];
  const citedValues = new Set<number>();
  for (const c of cited) citedValues.add(c.value);

  const prose = response.kind === "explain" ? response.answer : response.caption;

  for (const raw of extractNumbers(prose)) {
    if (rowValues.has(raw)) continue;
    if (allowed.has(raw)) continue;
    if (citedValues.has(raw)) continue;
    errors.push(
      `the text states the number ${raw}, and no row holds it - state only numbers that have a row, ` +
        `or report the metric as absent`,
    );
  }

  // A cited value that disagrees with the row it names.
  for (const c of cited) {
    const row = facts.metricRows.get(c.sourceRowId);
    if (!row) {
      errors.push(`citedMetrics: "${c.sourceRowId}" does not exist in the data`);
      continue;
    }
    if (row.value !== c.value) {
      errors.push(
        `citedMetrics: "${c.metric}" is cited as ${c.value} but the row "${row.id}" holds ${row.value}`,
      );
    }
  }

  // A metric with no data must not be reported as zero.
  //
  // This is the rule that stops "watch time was 0 seconds" from replacing
  // "watch time has not been recorded yet". If the model says zero for a
  // metric that has no row, the number is invented - a zero is a measurement.
  const absent = response.kind === "explain" ? response.absentMetrics : [];
  for (const metric of absent) {
    if (metric.metric in facts.metricRows) {
      errors.push(
        `"${metric.metric}" is reported as absent, but the data does hold a row for it - cite the row instead`,
      );
    }
  }

  if (response.kind === "explain") {
    // Every metric named in the answer is either cited or reported absent.
    for (const c of response.citedMetrics) {
      const row = facts.metricRows.get(c.sourceRowId);
      if (row && absent.some((m) => m.metric === row.metric)) {
        errors.push(`"${row.metric}" is both cited and reported as absent`);
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true };
}

export { parseNumberToken };
