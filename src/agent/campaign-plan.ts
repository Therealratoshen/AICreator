/**
 * The campaign plan schema, and the validator that enforces it.
 *
 * WHY THIS FILE EXISTS (the constraint that shaped the build):
 *
 *   "All except Muse Spark Open support structured outputs and JSON mode."
 *   "Muse Spark Open accepts `json_object` but doesn't constrain output to JSON.
 *    Ask for JSON in your prompt and validate the response in your application."
 *                                                    — Baseten, Model APIs overview
 *
 * On Muse Spark Open there is NO schema enforcement. The model can emit
 * `json_object` and still produce prose, a partial object, a string where a
 * number belongs, or a plan that cites a metric no row supports.
 *
 * So the ONLY trustworthy shape is:
 *   1. the plan arrives as a TOOL CALL (submit_campaign_plan), not as prose;
 *   2. every argument is validated HERE, in code, before it is used;
 *   3. a rejection is fed back to the model so it can recover.
 *
 * The validation below is deliberately strict and deliberately loud: every
 * failure names the exact field and the exact reason, because that string is
 * what goes back into the model.
 */

export type CreatorCandidate = {
  /** The creator's stable id. Must exist in the audience table. */
  creatorId: string;
  /** Why this creator was chosen, in one sentence, with the number that justifies it. */
  reason: string;
  /** The number the reason rests on, e.g. the median view count over the window. */
  justifyingMetric: number;
};

export type ContentBrief = {
  /** The creator this brief is for. */
  creatorId: string;
  /** What the post must achieve. */
  objective: string;
  /** The hook, in the creator's own register. */
  hook: string;
  /** The call to action. */
  cta: string;
  /** 1-4 images. Muse Image produces one variant per creator. */
  imageCount: number;
};

export type CampaignPlan = {
  /** ISO date of the Monday the plan starts. */
  weekOf: string;
  /** How many posts per week, per creator. 1-14. */
  cadencePerWeek: number;
  /** The creators, best first. At least one, at most 12. */
  creatorShortlist: CreatorCandidate[];
  /** One brief per shortlisted creator. */
  contentBriefs: ContentBrief[];
  /** Every metric the plan cites, with the row it came from. */
  citedMetrics: { metric: string; sourceRowId: string; value: number }[];
  /** A note from the agent for the brand. */
  notes: string;
};

/** The names of the tables the plan's numbers must come from. */
export const KNOWN_TABLES = [
  "brand_instagram_accounts",
  "brand_instagram_posts",
  "creator_profiles",
  "creator_audience_snapshots",
] as const;

export type ValidationResult =
  | { ok: true; plan: CampaignPlan }
  | { ok: false; errors: string[] };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Validate a campaign plan. Every failure is collected so the model gets the
 * whole list at once, not one problem per round trip.
 *
 * `supportedMetricIds` is the set of metric row ids that actually exist. A
 * plan that cites a metric nobody has is not a plan — it is a guess with
 * numbers in it, and that is exactly what this project refuses to publish.
 */
export function validateCampaignPlan(
  input: unknown,
  supportedMetricIds: ReadonlySet<string>,
): ValidationResult {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["the plan must be an object"] };
  }
  const p = input as Record<string, unknown>;

  // --- weekOf: an ISO date, and it must be a real Monday
  if (!isNonEmptyString(p.weekOf)) {
    errors.push("weekOf is required and must be an ISO date string (YYYY-MM-DD)");
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(p.weekOf)) {
    errors.push(`weekOf must be the format YYYY-MM-DD, got "${p.weekOf}"`);
  } else {
    const d = new Date(`${p.weekOf}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) {
      errors.push(`weekOf is not a real date: "${p.weekOf}"`);
    } else if (d.getUTCDay() !== 1) {
      errors.push(`weekOf must be a Monday, got ${p.weekOf} (a ${["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][d.getUTCDay()]})`);
    }
  }

  // --- cadencePerWeek: an integer in range
  if (!isFiniteNumber(p.cadencePerWeek)) {
    errors.push("cadencePerWeek is required and must be a number");
  } else if (!Number.isInteger(p.cadencePerWeek)) {
    errors.push(`cadencePerWeek must be a whole number of posts, got ${p.cadencePerWeek}`);
  } else if (p.cadencePerWeek < 1 || p.cadencePerWeek > 14) {
    errors.push(`cadencePerWeek must be between 1 and 14 posts per week, got ${p.cadencePerWeek}`);
  }

  // --- creatorShortlist: non-empty, unique, each with a real metric
  const shortlist = p.creatorShortlist;
  if (!Array.isArray(shortlist)) {
    errors.push("creatorShortlist is required and must be an array");
  } else if (shortlist.length === 0) {
    errors.push("creatorShortlist must have at least one creator");
  } else if (shortlist.length > 12) {
    errors.push(`creatorShortlist must have at most 12 creators, got ${shortlist.length}`);
  } else {
    const seen = new Set<string>();
    shortlist.forEach((c, i) => {
      const at = `creatorShortlist[${i}]`;
      if (typeof c !== "object" || c === null) {
        errors.push(`${at} must be an object`);
        return;
      }
      const cand = c as Record<string, unknown>;
      if (!isNonEmptyString(cand.creatorId)) {
        errors.push(`${at}.creatorId is required`);
      } else if (seen.has(cand.creatorId)) {
        errors.push(`${at}.creatorId "${cand.creatorId}" is already in the shortlist`);
      } else {
        seen.add(cand.creatorId);
      }
      if (!isNonEmptyString(cand.reason)) {
        errors.push(`${at}.reason is required - say why this creator, and with which number`);
      }
      if (!isFiniteNumber(cand.justifyingMetric)) {
        errors.push(`${at}.justifyingMetric is required and must be a number - a reason without a number is not a reason`);
      } else if (cand.justifyingMetric < 0) {
        errors.push(`${at}.justifyingMetric cannot be negative, got ${cand.justifyingMetric}`);
      }
    });
  }

  // --- contentBriefs: one per shortlisted creator
  const briefs = p.contentBriefs;
  if (!Array.isArray(briefs)) {
    errors.push("contentBriefs is required and must be an array");
  } else if (Array.isArray(shortlist) && shortlist.length > 0) {
    const shortlisted = new Set(
      shortlist
        .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
        .map((c) => String(c.creatorId)),
    );
    briefs.forEach((b, i) => {
      const at = `contentBriefs[${i}]`;
      if (typeof b !== "object" || b === null) {
        errors.push(`${at} must be an object`);
        return;
      }
      const brief = b as Record<string, unknown>;
      if (!isNonEmptyString(brief.creatorId)) {
        errors.push(`${at}.creatorId is required`);
      } else if (!shortlisted.has(String(brief.creatorId))) {
        errors.push(`${at}.creatorId "${brief.creatorId}" is not in the shortlist - every brief must be for a shortlisted creator`);
      }
      for (const field of ["objective", "hook", "cta"] as const) {
        if (!isNonEmptyString(brief[field])) {
          errors.push(`${at}.${field} is required`);
        }
      }
      if (!isFiniteNumber(brief.imageCount)) {
        errors.push(`${at}.imageCount is required and must be a number`);
      } else if (!Number.isInteger(brief.imageCount) || brief.imageCount < 1 || brief.imageCount > 4) {
        errors.push(`${at}.imageCount must be a whole number between 1 and 4, got ${brief.imageCount}`);
      }
    });
    // and every shortlisted creator needs a brief
    for (const cid of shortlisted) {
      const covered = briefs.some(
        (b) => typeof b === "object" && b !== null && (b as Record<string, unknown>).creatorId === cid,
      );
      if (!covered) {
        errors.push(`creatorShortlist has "${cid}" but contentBriefs has no brief for it`);
      }
    }
  }

  // --- citedMetrics: this is the no-fakes rule
  const cited = p.citedMetrics;
  if (!Array.isArray(cited)) {
    errors.push("citedMetrics is required and must be an array - every number in this plan must trace to a row");
  } else if (cited.length === 0) {
    errors.push("citedMetrics is empty - a plan that cites no metric is not grounded");
  } else {
    cited.forEach((m, i) => {
      const at = `citedMetrics[${i}]`;
      if (typeof m !== "object" || m === null) {
        errors.push(`${at} must be an object`);
        return;
      }
      const metric = m as Record<string, unknown>;
      if (!isNonEmptyString(metric.metric)) {
        errors.push(`${at}.metric is required`);
      }
      if (!isNonEmptyString(metric.sourceRowId)) {
        errors.push(`${at}.sourceRowId is required - say which row the number came from`);
      } else if (!supportedMetricIds.has(String(metric.sourceRowId))) {
        errors.push(`${at}.sourceRowId "${metric.sourceRowId}" does not exist - do not cite a row you have not read`);
      }
      if (!isFiniteNumber(metric.value)) {
        errors.push(`${at}.value is required and must be a number`);
      }
    });
  }

  if (!isNonEmptyString(p.notes)) {
    errors.push("notes is required - one note to the brand");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, plan: p as unknown as CampaignPlan };
}

/**
 * The message that goes back to the model after a rejection.
 *
 * It is deliberately specific: "fix these exact fields and call the tool
 * again" is recoverable; "invalid output" is not.
 */
export function rejectionFeedback(errors: string[]): string {
  return [
    `The plan was rejected by the validator. ${errors.length} problem(s) must be fixed.`,
    `Fix ONLY these fields and call submit_campaign_plan again:`,
    ...errors.map((e, i) => `  ${i + 1}. ${e}`),
    `Do not explain. Do not apologise. Call the tool with the corrected arguments.`,
  ].join("\n");
}
