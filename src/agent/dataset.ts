/**
 * The dataset the agents read.
 *
 * WHY A ROW LIST RATHER THAN NESTED OBJECTS
 * -----------------------------------------
 * The no-fakes rule says every number cites a row. That is only checkable if
 * the numbers are addressable by id, so the dataset is a flat list of rows
 * with ids - the same shape `checkNoFakes` already takes, and the same shape
 * `supportedMetricIds` already expects.
 *
 * Nesting a creator's metrics inside the creator object would read more
 * naturally and would make every consumer flatten it again before it could
 * check anything. One flat list, one id space, one check.
 *
 * WHY `table` IS ON THE ROW
 * -------------------------
 * `KNOWN_TABLES` was exported by `campaign-plan.ts` and used by nothing. A
 * citation could name any row id in the set and never be asked which table it
 * came from. Carrying the table on the row lets the reviewer ask the question
 * the constant was written for.
 */

import type { MetricRow } from "./no-fakes.ts";
import type { StrategyContext } from "./strategy.ts";

/** One row of brand or creator data. */
export type DataRow = {
  /** Stable id. This is what a plan cites in `sourceRowId`. */
  rowId: string;
  /** One of `KNOWN_TABLES`. */
  table: string;
  /** The metric name, e.g. "median_views_90d". */
  metric: string;
  /** The value the row holds. A plan must cite exactly this. */
  value: number;
  /** Who the row is about: the brand name, or a creatorId. */
  subject: string;
  /** A sentence a human reads, so the number is not bare. */
  label: string;
};

export type CreatorRecord = {
  creatorId: string;
  handle: string;
  niche: string;
};

export type BrandDataset = {
  brandName: string;
  niche: string;
  /** How far back the data goes, in days. Stated because the metrics say "90d". */
  windowDays: number;
  rows: DataRow[];
  creators: CreatorRecord[];
};

/** The ids the validators accept. Derived, never hand-maintained. */
export function metricIdsOf(dataset: BrandDataset): ReadonlySet<string> {
  return new Set(dataset.rows.map((r) => r.rowId));
}

/** The creators that exist. */
export function creatorIdsOf(dataset: BrandDataset): ReadonlySet<string> {
  return new Set(dataset.creators.map((c) => c.creatorId));
}

/**
 * The dataset as the map `checkNoFakes` takes.
 *
 * Built from the same rows, so the guard cannot disagree with the validator
 * about which rows exist - a second hand-written fixture is how those two
 * drift apart.
 */
export function rowsToMap(dataset: BrandDataset): Map<string, MetricRow> {
  return new Map(
    dataset.rows.map((r) => [r.rowId, { id: r.rowId, value: r.value, table: r.table }]),
  );
}

/** The table a row came from, when it exists. */
export function tableOf(dataset: BrandDataset, rowId: string): string | null {
  return dataset.rows.find((r) => r.rowId === rowId)?.table ?? null;
}

/**
 * Which subject each row is about, by row id.
 *
 * Separate from `rowsToMap` because `MetricRow` is a foreign type owned by
 * `no-fakes.ts` and widening it would change what that guard means. The
 * subject is a strategy-level fact, so it is passed alongside rather than
 * smuggled in.
 */
export function subjectOf(dataset: BrandDataset): ReadonlyMap<string, string> {
  return new Map(dataset.rows.map((r) => [r.rowId, r.subject]));
}

/**
 * Everything `validateCampaignStrategy` needs, derived from one dataset.
 *
 * Built here rather than at the call site so there is exactly one place that
 * knows how to turn a dataset into validation context. Two hand-assembled
 * contexts is how a test ends up passing against a fixture production never
 * builds.
 */
export function strategyContextOf(dataset: BrandDataset): StrategyContext {
  return {
    rows: rowsToMap(dataset),
    creatorIds: creatorIdsOf(dataset),
    subjectOf: subjectOf(dataset),
  };
}

/**
 * The dataset as prompt text.
 *
 * Grouped by subject rather than dumped, because the model has to attribute a
 * number to a creator and a flat list of sixteen lines is where it starts
 * attaching the wrong number to the wrong person.
 */
export function renderDataset(dataset: BrandDataset): string {
  const lines: string[] = [];

  lines.push(`BRAND: ${dataset.brandName} (${dataset.niche})`);
  lines.push(`WINDOW: the last ${dataset.windowDays} days`);
  lines.push("");
  lines.push("BRAND ROWS (these are the only brand numbers that exist):");
  for (const row of dataset.rows.filter((r) => r.subject === dataset.brandName)) {
    lines.push(`  ${row.rowId}  ${row.metric} = ${row.value}   (${row.table})  ${row.label}`);
  }

  lines.push("");
  lines.push("CREATORS (these are the only creators that exist):");
  for (const creator of dataset.creators) {
    lines.push(`  ${creator.creatorId}  ${creator.handle}  niche: ${creator.niche}`);
    const rows = dataset.rows.filter((r) => r.subject === creator.creatorId);
    if (rows.length === 0) {
      lines.push("    (no audience rows - do not cite a number for this creator)");
      continue;
    }
    for (const row of rows) {
      lines.push(`    ${row.rowId}  ${row.metric} = ${row.value}   (${row.table})  ${row.label}`);
    }
  }

  return lines.join("\n");
}
