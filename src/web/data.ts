/**
 * The dataset the web app runs on.
 *
 * THIS DATA IS SYNTHETIC, AND THE UI SAYS SO
 * ------------------------------------------
 * The public repo's rules forbid real creator or customer data, so every row
 * here is invented. That creates an honesty problem specific to this project:
 * a tool whose entire thesis is "never publish a number that isn't backed by
 * data" cannot quietly ship a demo full of made-up numbers presented as real.
 *
 * So the dataset carries its own label, `SYNTHETIC_NOTICE`, and the UI renders
 * it above the results. The numbers are internally consistent - the app is
 * checking real relationships between rows - but they are not anybody's
 * audience, and the page says so in the same size type as the plan.
 *
 * WHY THE ROWS ARE SHAPED LIKE THIS
 * ---------------------------------
 * `table` comes from `KNOWN_TABLES`, so the citations are checkable against
 * the tables the schema allows. `subject` is the creator id or the brand name,
 * which is what lets the validator catch a rationale that cites the right
 * number for the wrong person - the failure mode that survives every check
 * that only compares values.
 */

import type { BrandDataset } from "../agent/dataset.ts";

/** Rendered in the UI, next to the numbers. Not a footnote. */
export const SYNTHETIC_NOTICE =
  "Synthetic data. Every row below was invented for this demo - no real brand, " +
  "creator or audience. The numbers are consistent with each other, which is " +
  "what lets the guards do real work, but they describe nobody.";

export const SEREH: BrandDataset = {
  brandName: "Sereh",
  niche: "skincare",
  windowDays: 90,
  rows: [
    {
      rowId: "brand_reach_90d",
      table: "brand_instagram_accounts",
      metric: "reach_90d",
      value: 41200,
      subject: "Sereh",
      label: "accounts reached in the last 90 days",
    },
    {
      rowId: "brand_saves_90d",
      table: "brand_instagram_accounts",
      metric: "saves_90d",
      value: 1180,
      subject: "Sereh",
      label: "saves across all posts, 90 days",
    },
    {
      rowId: "brand_views_90d",
      table: "brand_instagram_posts",
      metric: "median_views_90d",
      value: 3890,
      subject: "Sereh",
      label: "median views per post, 90 days",
    },

    {
      rowId: "kol_citra_views",
      table: "creator_audience_snapshots",
      metric: "median_views_90d",
      value: 7300,
      subject: "kol_citra",
      label: "median views per post, 90 days",
    },
    {
      rowId: "kol_citra_saves",
      table: "creator_audience_snapshots",
      metric: "median_saves_90d",
      value: 890,
      subject: "kol_citra",
      label: "median saves per post, 90 days",
    },
    {
      rowId: "kol_citra_engagement",
      table: "creator_audience_snapshots",
      metric: "engagement_rate_pct",
      value: 5.1,
      subject: "kol_citra",
      label: "engagement rate, percent",
    },

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
      rowId: "kol_aria_engagement",
      table: "creator_audience_snapshots",
      metric: "engagement_rate_pct",
      value: 4.2,
      subject: "kol_aria",
      label: "engagement rate, percent",
    },

    {
      rowId: "kol_bima_views",
      table: "creator_audience_snapshots",
      metric: "median_views_90d",
      value: 12900,
      subject: "kol_bima",
      label: "median views per post, 90 days",
    },
    {
      rowId: "kol_bima_saves",
      table: "creator_audience_snapshots",
      metric: "median_saves_90d",
      value: 240,
      subject: "kol_bima",
      label: "median saves per post, 90 days",
    },

    {
      rowId: "kol_dewi_views",
      table: "creator_audience_snapshots",
      metric: "median_views_90d",
      value: 2100,
      subject: "kol_dewi",
      label: "median views per post, 90 days",
    },
    {
      rowId: "kol_dewi_saves",
      table: "creator_audience_snapshots",
      metric: "median_saves_90d",
      value: 120,
      subject: "kol_dewi",
      label: "median saves per post, 90 days",
    },
  ],
  creators: [
    { creatorId: "kol_citra", handle: "@citra.kulit", niche: "skincare" },
    { creatorId: "kol_aria", handle: "@aria.rawat", niche: "skincare" },
    { creatorId: "kol_bima", handle: "@bima.gerak", niche: "fitness" },
    { creatorId: "kol_dewi", handle: "@dewi.putih", niche: "skincare" },
    /**
     * Listed, and deliberately given no rows.
     *
     * A real marketplace lists creators it has not measured yet. Keeping one
     * here means the app has to handle that honestly: the planner is told not
     * to shortlist her, and `validateCampaignStrategy` rejects it if a model
     * tries anyway. Removing her would hide a case that actually happens.
     */
    { creatorId: "kol_eka", handle: "@eka.baru", niche: "skincare" },
  ],
};

/** The rows a plan may cite, as a set, for the validator. */
export function rowsOf(dataset: BrandDataset): { rowId: string; value: number; subject: string }[] {
  return dataset.rows.map((r) => ({ rowId: r.rowId, value: r.value, subject: r.subject }));
}
