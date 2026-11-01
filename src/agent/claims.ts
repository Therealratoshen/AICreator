/**
 * The claim scanner: the part of the review that is code, not judgement.
 *
 * WHY THIS IS SEPARATE FROM `no-fakes.ts`
 * ---------------------------------------
 * `checkNoFakes` checks `citedMetrics` - the list a plan declares. It cannot
 * see a number written inside a sentence, because it never reads the
 * sentences. So this passes today:
 *
 *     citedMetrics: [ { metric: "median_saves_90d", sourceRowId: "kol_aria_saves", value: 610 } ]
 *     contentBriefs[0].hook: "4.820 orang menyimpan ini minggu lalu"
 *
 * The plan cites one real row and states a different number in prose. Every
 * existing guard says OK. That is the hole this file closes.
 *
 * THE SAME HOLE, FOR PROMISES
 * ---------------------------
 * The house rule covers "a promise that isn't backed by data", not only a
 * number. "Dijamin glowing dalam 7 hari" is a promise with no row behind it
 * and no row that could exist. No amount of metric-checking catches it,
 * because there is nothing to check - so it needs its own scan.
 *
 * TWO SEVERITIES, AND WHY THE DISTINCTION IS LOAD-BEARING
 * -------------------------------------------------------
 * `block` means the draft must be rewritten: the claim is unbackable by
 * construction, or the number is simply wrong.
 *
 * `warn` means a human should see it: a superlative is usually fluff, but
 * "terbaik" in an ad is a real legal exposure in Indonesia and the brand
 * should decide, not a regex.
 *
 * The difference matters because a warning must never cost a rewrite. If
 * every finding blocked, a plan with one overenthusiastic adjective would burn
 * all three writer attempts and escalate - the failure mode where the system
 * looks strict and is actually just brittle.
 */

export type Severity = "block" | "warn";

/** One thing wrong with a draft, located precisely enough to fix. */
export type Finding = {
  /** Stable id, e.g. "CLAIM-GUARANTEE". Cited in the transcript. */
  code: string;
  severity: Severity;
  /** Where it is: "contentBriefs[0].hook", "notes". */
  where: string;
  /** The offending excerpt, so the reader does not have to go looking. */
  excerpt: string;
  /** What to do about it. */
  message: string;
};

type ClaimRule = {
  code: string;
  severity: Severity;
  pattern: RegExp;
  message: string;
};

/**
 * The rules.
 *
 * Deliberately short. Each one is a claim that cannot be true *because of its
 * form*, not because of what the data happens to say - that is what makes it
 * safe to enforce with a regex. A rule that needs the data to decide belongs
 * in the reviewer's judgement pass, not here.
 *
 * The Indonesian and English patterns are written side by side because the
 * output is bilingual: briefs are written in Bahasa Indonesia, notes to the
 * brand are often English.
 */
const CLAIM_RULES: ClaimRule[] = [
  {
    code: "CLAIM-GUARANTEE",
    severity: "block",
    pattern: /\b(dijamin|jaminan|menjamin|garansi|guaranteed?|guarantee)\b/i,
    message:
      "a guarantee is a promise the data cannot back - no row says a result is certain. State what the post will show, not what it will achieve.",
  },
  {
    code: "CLAIM-CURE",
    severity: "block",
    pattern:
      /\b(menyembuhkan|mengobati|obat\s+\w+|cures?|heals?|treats?\s+(?:acne|jerawat|eczema))\b/i,
    message:
      "a cosmetic or content post cannot claim to cure or treat a condition. Describe the experience, not a medical outcome.",
  },
  {
    code: "CLAIM-PROVEN",
    severity: "block",
    pattern: /\b(terbukti|teruji\s+klinis|clinically\s+proven|proven\s+to|scientifically\s+proven)\b/i,
    message:
      "'proven' implies a study. If no row holds a study result, say what was observed instead.",
  },
  {
    code: "CLAIM-ABSOLUTE",
    severity: "block",
    // No trailing \b: "%" is not a word character, so a trailing boundary can
    // never match at the end of a string, which is exactly where "aman 100%"
    // puts it. The other alternatives carry their own boundaries.
    pattern: /\b100\s?(?:%|persen)|\bselamanya\b|\bpermanen(?:tly)?\b|\bforever\b/i,
    message:
      "an absolute has no counterexample, so it cannot be supported by data. Replace it with the specific, checkable version.",
  },
  {
    code: "CLAIM-SUPERLATIVE",
    severity: "warn",
    pattern: /\b(terbaik|terhebat|nomor\s+satu|no\.?\s?1|#1|best\s+in|the\s+best)\b/i,
    message:
      "a superlative is a comparative claim that needs a comparison the data does not contain. It is also restricted advertising language in Indonesia - the brand should decide.",
  },
  {
    code: "CLAIM-OUTCOME",
    severity: "warn",
    pattern:
      /\b(?:pasti|bakal|dijamin|guaranteed)\s+(?:viral|laris|naik|reach|results)|will\s+go\s+viral/i,
    message:
      "promising reach is promising an outcome nobody controls. Describe the content, not the result.",
  },
];

/** Scan one piece of text. Exported for tests and for reuse on other fields. */
export function scanClaims(text: string, where: string): Finding[] {
  const findings: Finding[] = [];
  for (const rule of CLAIM_RULES) {
    const m = rule.pattern.exec(text);
    if (!m) continue;
    findings.push({
      code: rule.code,
      severity: rule.severity,
      where,
      excerpt: excerptAround(text, m.index, m[0].length),
      message: rule.message,
    });
  }
  return findings;
}

/** A window of text around the match, so the excerpt is readable in a report. */
function excerptAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 24);
  const end = Math.min(text.length, index + length + 24);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}

/**
 * Unit multipliers, Indonesian and English.
 *
 * "rb"/"ribu" is thousand, "jt"/"juta" is million. Both are how the number is
 * actually written in the briefs this tool produces.
 */
const MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  rb: 1e3,
  ribu: 1e3,
  jt: 1e6,
  juta: 1e6,
};

/**
 * A number token, with its optional unit.
 *
 * The trailing guard stops "4.8 kg" being read as 4,800, and the leading guard
 * stops it matching inside a word.
 */
const STAT_RE = /(?<![\w.])(\d[\d.,]*)(\s*(?:%|k|rb|ribu|jt|juta)(?![\w]))?/gi;

/**
 * Every plausible reading of a number token.
 *
 * "4.820" is 4,820 in Indonesian and 4.82 in English. There is no way to tell
 * from the token alone, and guessing wrong would either miss a real
 * fabrication or block a correct draft. So every reading is tried, and a token
 * is accepted if ANY reading matches a cited value.
 *
 * This is the honest trade: it means a plan could in principle slip a number
 * past the scanner by writing it in the one notation that coincides with a
 * real value. That is a much narrower hole than "any number in prose", and
 * closing it completely would mean rejecting correct drafts.
 */
function readingsOf(digits: string, unit: string | undefined): number[] {
  const clean = digits.replace(/[.,]+$/, "");
  const mult = unit ? (MULTIPLIERS[unit.trim().toLowerCase()] ?? 1) : 1;
  const out = new Set<number>();

  // "4.820" -> 4820 (separators are thousands separators)
  const a = Number(clean.replace(/[.,]/g, ""));
  if (Number.isFinite(a)) out.add(a * mult);

  // "4,820" -> 4820 (comma is the thousands separator)
  const b = Number(clean.replace(/,/g, ""));
  if (Number.isFinite(b)) out.add(b * mult);

  // "4,8" -> 4.8 (comma is the decimal separator)
  const c = Number(clean.replace(/\./g, "").replace(/,/g, "."));
  if (Number.isFinite(c)) out.add(c * mult);

  return [...out];
}

function isAllowed(value: number, allowed: ReadonlySet<number>): boolean {
  for (const a of allowed) {
    if (Math.abs(a - value) < 1e-6) return true;
  }
  return false;
}

/**
 * Find statistics in prose that no cited row supports.
 *
 * What counts as a statistic: any number of 100 or more, or anything carrying
 * a `%`. Below 100 the sentence is almost always counting posts, steps or
 * images - "3 ideas", "2 posts" - and flagging those would make the scanner
 * unusable. Years are excluded for the same reason.
 *
 * The threshold is a judgement call, and it is stated here rather than hidden:
 * a fabricated "12 orang" would get through, a fabricated "12.000 orang" would
 * not. The alternative - flagging every digit - trades a real hole for a
 * scanner that cries wolf on correct drafts.
 */
export function scanBareStatistics(
  text: string,
  where: string,
  allowed: ReadonlySet<number>,
): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();

  for (const m of text.matchAll(STAT_RE)) {
    const digits = m[1] ?? "";
    const unit = m[2]?.trim() || undefined;
    const readings = readingsOf(digits, unit);
    if (readings.length === 0) continue;

    const isPercent = unit === "%";
    const isStatistic = isPercent || readings.some((v) => v >= 100);
    if (!isStatistic) continue;

    // A year is not a statistic. 2026 is a date the brand chose, not a claim.
    if (!isPercent && readings.every((v) => v >= 1900 && v <= 2100 && Number.isInteger(v))) {
      continue;
    }

    if (readings.some((v) => isAllowed(v, allowed))) continue;

    const token = m[0].trim();
    if (seen.has(token)) continue;
    seen.add(token);

    findings.push({
      code: "STAT-UNCITED",
      severity: "block",
      where,
      excerpt: excerptAround(text, m.index ?? 0, m[0].length),
      message:
        `"${token}" is a statistic in the copy that no cited row supports. Either cite the row that ` +
        `holds it, or take the number out - the brand cannot publish a figure the data does not have.`,
    });
  }

  return findings;
}

/** The values a draft is allowed to state: everything it cited, plus what the strategy justified. */
export function allowedValues(
  cited: readonly { value: number }[],
  extra: readonly number[] = [],
): ReadonlySet<number> {
  return new Set([...cited.map((c) => c.value), ...extra]);
}

/** True when any finding must block publication. */
export function hasBlocking(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.severity === "block");
}

/** One line per finding, for the writer's feedback and the transcript. */
export function formatFindings(findings: readonly Finding[]): string {
  return findings
    .map((f) => `${f.severity === "block" ? "✗" : "!"} [${f.code}] ${f.where}: ${f.message}`)
    .join("\n");
}
