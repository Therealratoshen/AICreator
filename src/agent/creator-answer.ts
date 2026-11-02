/**
 * The creator's answer: the schema, and the validator that enforces it.
 *
 * WHY THIS FILE EXISTS:
 *
 * The brand's half of the marketplace produces a campaign plan
 * ([`./campaign-plan.ts`](./campaign-plan.ts)). The creator's half produces an
 * explanation of their own numbers, or a draft caption in their own voice.
 * Both halves must go through the SAME tool-calling contract - the model calls
 * a tool, the application validates the arguments - because the vendor's
 * constraint (the model does not enforce a schema, so the application does)
 * applies to both.
 *
 * So this file is the creator's twin of the plan schema: a pure validator, no
 * I/O, no model, no clock, no randomness. Every rule is testable by mutating
 * one field of a known-good answer and asserting on the exact error.
 *
 * THE TWO RULES THAT MATTER MOST:
 *
 * 1. **A metric with no data is absent, not zero.** A creator whose posts have
 *    no watch-time recorded must be told "not recorded yet", not "0 seconds".
 *    Zero is a claim about the data; absence is a claim about the data. The
 *    schema therefore has two separate lists - `citedMetrics` for the metrics
 *    that have a row, and `absentMetrics` for the ones that do not - and a
 *    metric may not appear in both. An absent metric carries no value at all,
 *    so there is no way to report absence as a number.
 *
 * 2. **The draft is compared against the creator's own past captions.** Not
 *    against a style guide, and not against the brand's voice. The measurable
 *    properties of a creator's register are computed from their own captions:
 *    the tokens they habitually use, and the length they habitually write at.
 */

/** A metric row the creator's numbers come from. */
export type CreatorMetricRow = {
  id: string;
  /** The row's own name for the metric, e.g. "reach". */
  metric: string;
  /** The value the row holds. */
  value: number;
};

/** One of the creator's past captions. */
export type CreatorCaptionRow = {
  id: string;
  /** The caption as the creator wrote it. */
  text: string;
};

/**
 * Everything the validator needs to know about the creator, passed in.
 *
 * The validator asks no questions and reads no files: if a rule needs a fact,
 * the fact is here. That is what keeps it pure, and pure is what makes it
 * testable.
 */
export type CreatorFacts = {
  /** The creator's id. */
  creatorId: string;
  /** The metric rows that exist, by row id. */
  metricRows: ReadonlyMap<string, CreatorMetricRow>;
  /** The creator's past captions, by row id. */
  captions: ReadonlyMap<string, CreatorCaptionRow>;
  /** The brief a draft must answer. */
  brief: { objective: string; lengthWords: number };
  /**
   * Numbers the APPLICATION put into the request, and which therefore need no
   * row of their own - e.g. "your last 3 posts". The model may use these
   * numbers and only these; any other number has to trace to a row.
   */
  allowedNumbers: readonly number[];
};

export type CreatorExplanation = {
  kind: "explain";
  /** The creator's question, restated. */
  question: string;
  /** The explanation, in the creator's own language. */
  answer: string;
  /** The metrics that HAVE data, with the row each came from. */
  citedMetrics: { metric: string; sourceRowId: string; value: number }[];
  /** The metrics that have NO data. Reported as absent, never as zero. */
  absentMetrics: { metric: string; reason: string }[];
};

export type CreatorDraft = {
  kind: "draft";
  /** The draft caption. */
  caption: string;
  /** How many words the caption has. The validator recomputes this. */
  wordCount: number;
  /** The past captions the draft was compared against. */
  comparedAgainst: { captionRowId: string }[];
  /** The register markers the draft reused, from the creator's own captions. */
  matchedMarkers: string[];
  /** The brief the draft answers. */
  briefObjective: string;
};

export type CreatorResponse = CreatorExplanation | CreatorDraft;

export type CreatorValidationResult =
  | { ok: true; response: CreatorResponse }
  | { ok: false; errors: string[] };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

// ---------------------------------------------------------------- register

/**
 * Words that say nothing about a creator's register. Without this list,
 * "the" and "yang" would become register markers and the check would be
 * theatre.
 */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "so", "to", "of", "in", "on", "for", "with", "is",
  "it", "this", "that", "my", "your", "i", "me", "we", "us", "you", "they", "he", "she",
  "yang", "dan", "di", "ke", "dari", "untuk", "dengan", "ini", "itu", "saya", "aku", "kamu",
  "ada", "sudah", "belum", "juga", "atau", "tapi", "kalau", "nya", "ya", "sih", "dong", "kok",
]);

/**
 * Split text into the tokens that can carry a creator's register: words and
 * emoji, lowercased, punctuation stripped.
 *
 * Emoji are kept because they are the loudest part of a creator's voice on
 * Instagram, and they are the first thing a draft that is "in their voice"
 * has to get right.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/u)
    .map((t) => t.replace(/^[^\p{L}\p{N}\p{Emoji_Presentation}]+/u, "").replace(/[^\p{L}\p{N}\p{Emoji_Presentation}]+$/u, ""))
    .filter((t) => t.length > 0);
}

/**
 * The tokens that characterise this creator's register: the ones that appear
 * in at least half of their past captions.
 *
 * A creator needs at least two past captions before a register can be
 * measured at all. With fewer, this returns an empty list and the rules that
 * depend on it do not apply - which is the honest answer, not a guess.
 */
export function registerMarkers(captions: ReadonlyMap<string, CreatorCaptionRow>): string[] {
  const texts = [...captions.values()].map((c) => c.text);
  if (texts.length < 2) return [];

  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const token of new Set(tokenize(text))) {
      if (STOP_WORDS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  const threshold = Math.ceil(texts.length / 2);
  return [...counts.entries()]
    .filter(([, n]) => n >= threshold)
    .map(([token]) => token)
    .sort();
}

/**
 * Count words the way this product counts them: separated by spaces.
 *
 * The convention is stated in the rejection message, so a model that counts
 * differently can be told exactly how to count.
 */
export function countWords(text: string): number {
  return text.trim().split(/\s+/u).filter((t) => t.length > 0).length;
}

/**
 * How far a caption may sit from the length the brief asked for.
 *
 * A caption of exactly the target length is not the goal - a caption that
 * reads like the creator is. The band exists so the draft is the length the
 * brief asked for, with room for the two extra words a human uses.
 */
export function lengthBand(target: number): number {
  return Math.max(2, Math.round(target * 0.2));
}

// ---------------------------------------------------------------- numbers

/**
 * Read a number out of the text the creator (or the model) wrote.
 *
 * Indonesian writes thousands with a dot ("4.820") and decimals with a comma
 * ("4,82"), and this product is Indonesian-first, so a dot followed by exactly
 * three digits is read as a thousands separator. A dot followed by one or two
 * digits is a decimal.
 */
export function parseNumberToken(token: string): number | null {
  const cleaned = token.replace(/[^\d.,]/gu, "");
  if (cleaned.length === 0) return null;

  const commas = (cleaned.match(/,/g) ?? []).length;
  const dots = (cleaned.match(/\./g) ?? []).length;

  let normalised: string;
  if (commas > 0 && dots > 0) {
    // English convention: commas group thousands, the last dot is the decimal.
    const lastComma = cleaned.lastIndexOf(",");
    const lastDot = cleaned.lastIndexOf(".");
    normalised =
      lastComma > lastDot
        ? cleaned.replace(/,/g, "")
        : cleaned.slice(0, lastDot).replace(/,/g, "") + cleaned.slice(lastDot).replace(/,/g, "");
  } else if (commas > 0) {
    // Indonesian writes a decimal with a COMMA ("4,82") and groups thousands
    // with a DOT ("4.820"). So a single comma between digits is a decimal
    // point; a comma followed by exactly three digits is a thousands
    // separator, exactly like the dot rule below.
    const parts = cleaned.split(",");
    const tail = parts[parts.length - 1];
    normalised =
      parts.length === 2 && tail.length === 3 ? parts[0] + tail : parts.join(".");
  } else if (dots > 1) {
    normalised = cleaned.replace(/\./g, "");
  } else if (dots === 1) {
    const [whole, frac = ""] = cleaned.split(".");
    normalised = frac.length === 3 ? `${whole}${frac}` : cleaned;
  } else {
    normalised = cleaned;
  }

  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

/**
 * Every number that appears in a piece of text.
 *
 * This is the function that makes "no fabricated numbers" enforceable on
 * PROSE: the model can only say a number if the application can point at the
 * row behind it.
 */
export function extractNumbers(text: string): number[] {
  const found: number[] = [];
  // A number is a digit, and then digits, dots and commas. A lone digit inside
  // a word ("3d", "v2") is not a number anybody reads as one.
  const matches = text.match(/\d[\d.,]*\d|\d/gu) ?? [];
  for (const m of matches) {
    const value = parseNumberToken(m);
    if (value !== null) found.push(value);
  }
  return found;
}

// ---------------------------------------------------------------- the validator

/**
 * Validate a creator response.
 *
 * `facts` carries every row, caption and rule the answer has to respect.
 * Every failure is collected, so the model gets the whole list at once.
 */
export function validateCreatorResponse(
  input: unknown,
  facts: CreatorFacts,
  expectedKind?: "explain" | "draft",
): CreatorValidationResult {
  const errors: string[] = [];

  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, errors: ["the answer must be an object"] };
  }
  const a = input as Record<string, unknown>;

  if (a.kind !== "explain" && a.kind !== "draft") {
    errors.push(
      `kind must be "explain" or "draft", got ${JSON.stringify(a.kind)} - an explanation reads the creator's numbers, a draft writes the next caption`,
    );
    return { ok: false, errors };
  }
  if (expectedKind && a.kind !== expectedKind) {
    errors.push(
      `kind is "${a.kind}" but the creator asked for a ${expectedKind} - call the tool again with kind: "${expectedKind}"`,
    );
  }

  if (a.kind === "explain") return validateExplanation(a, facts, errors);
  return validateDraft(a, facts, errors);
}

function validateExplanation(
  a: Record<string, unknown>,
  facts: CreatorFacts,
  errors: string[],
): CreatorValidationResult {
  if (!isNonEmptyString(a.question)) {
    errors.push("question is required - restate what the creator asked");
  }
  if (!isNonEmptyString(a.answer)) {
    errors.push("answer is required - the creator asked a question");
  }

  // --- citedMetrics: the numbers that HAVE a row
  const cited = a.citedMetrics;
  const citedNames = new Set<string>();
  if (!Array.isArray(cited)) {
    errors.push("citedMetrics is required and must be an array - every number you state must trace to a row");
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
      } else {
        const row = facts.metricRows.get(String(metric.sourceRowId));
        if (!row) {
          errors.push(
            `${at}.sourceRowId "${metric.sourceRowId}" does not exist - do not cite a row you have not read`,
          );
        } else {
          if (isNonEmptyString(metric.metric) && metric.metric !== row.metric) {
            errors.push(
              `${at}.metric is "${metric.metric}" but the row "${row.id}" is the "${row.metric}" metric - use the row's own name`,
            );
          }
          citedNames.add(row.metric);
        }
      }
      if (!isFiniteNumber(metric.value)) {
        errors.push(`${at}.value is required and must be a number`);
      }
    });
  }

  // --- absentMetrics: the numbers that have NO row
  const absent = a.absentMetrics;
  const absentNames = new Set<string>();
  if (!Array.isArray(absent)) {
    errors.push("absentMetrics is required and must be an array - a metric with no data is reported as absent, not as zero");
  } else {
    absent.forEach((m, i) => {
      const at = `absentMetrics[${i}]`;
      if (typeof m !== "object" || m === null) {
        errors.push(`${at} must be an object`);
        return;
      }
      const metric = m as Record<string, unknown>;
      if (!isNonEmptyString(metric.metric)) {
        errors.push(`${at}.metric is required`);
      } else {
        absentNames.add(String(metric.metric));
      }
      if (!isNonEmptyString(metric.reason)) {
        errors.push(`${at}.reason is required - say that there is no data, and why`);
      }
      // An absent metric must NOT have a value: that is how absence turns
      // back into a zero.
      if ("value" in metric) {
        errors.push(
          `${at} must not carry a value - a metric with no data is absent, not zero. Report it in absentMetrics and say there is no data.`,
        );
      }
    });
  }

  // A metric cannot be both cited and absent.
  for (const name of citedNames) {
    if (absentNames.has(name)) {
      errors.push(
        `"${name}" is in citedMetrics and in absentMetrics - a metric either has a row or it does not`,
      );
    }
  }

  // The answer must be grounded: it says something about the data.
  if (Array.isArray(cited) && Array.isArray(absent) && cited.length === 0 && absent.length === 0) {
    errors.push(
      "the answer cites no metric and reports no absent metric - say what the data holds, and what it does not",
    );
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, response: a as unknown as CreatorExplanation };
}

function validateDraft(
  a: Record<string, unknown>,
  facts: CreatorFacts,
  errors: string[],
): CreatorValidationResult {
  if (!isNonEmptyString(a.caption)) {
    errors.push("caption is required - the draft itself");
    return { ok: false, errors };
  }
  const caption = String(a.caption);

  // --- the length the brief asked for
  const actual = countWords(caption);
  if (!isFiniteNumber(a.wordCount)) {
    errors.push("wordCount is required and must be a number");
  } else if (a.wordCount !== actual) {
    errors.push(
      `wordCount is ${a.wordCount} but the caption has ${actual} words - count the words separated by spaces`,
    );
  }
  const band = lengthBand(facts.brief.lengthWords);
  if (Math.abs(actual - facts.brief.lengthWords) > band) {
    errors.push(
      `the caption is ${actual} words, and the brief asks for ${facts.brief.lengthWords} (allowed ${facts.brief.lengthWords - band} to ${facts.brief.lengthWords + band}) - write it to that length`,
    );
  }

  // --- the brief itself
  if (!isNonEmptyString(a.briefObjective)) {
    errors.push("briefObjective is required - the brief this caption answers");
  } else if (a.briefObjective.trim() !== facts.brief.objective.trim()) {
    errors.push(
      `briefObjective is "${a.briefObjective}" but the brief is "${facts.brief.objective}" - answer the brief you were given`,
    );
  }

  // --- compared against the creator's OWN captions
  const compared = a.comparedAgainst;
  if (!Array.isArray(compared)) {
    errors.push("comparedAgainst is required and must be an array - the draft is compared against the creator's own captions");
  } else if (compared.length === 0) {
    errors.push("comparedAgainst is empty - a draft that was compared with nothing was not compared");
  } else {
    compared.forEach((c, i) => {
      const at = `comparedAgainst[${i}]`;
      if (typeof c !== "object" || c === null) {
        errors.push(`${at} must be an object`);
        return;
      }
      const ref = c as Record<string, unknown>;
      if (!isNonEmptyString(ref.captionRowId)) {
        errors.push(`${at}.captionRowId is required`);
      } else if (!facts.captions.has(String(ref.captionRowId))) {
        errors.push(
          `${at}.captionRowId "${ref.captionRowId}" does not exist - compare against a caption the creator actually wrote`,
        );
      }
    });
  }

  // --- and it reuses their register
  const markers = registerMarkers(facts.captions);
  const matched = a.matchedMarkers;
  if (!Array.isArray(matched)) {
    errors.push("matchedMarkers is required and must be an array - the words of theirs your draft reused");
  } else if (markers.length > 0 && matched.length === 0) {
    errors.push(
      "matchedMarkers is empty - the draft must reuse the words this creator uses, not a generic voice",
    );
  }
  if (Array.isArray(matched)) {
    const captionTokens = new Set(tokenize(caption));
    matched.forEach((m, i) => {
      const at = `matchedMarkers[${i}]`;
      if (!isNonEmptyString(m)) {
        errors.push(`${at} must be a non-empty string`);
        return;
      }
      const marker = String(m).toLowerCase();
      if (markers.length > 0 && !markers.includes(marker)) {
        errors.push(
          `${at} "${m}" is not a word this creator uses - use one of: ${markers.slice(0, 8).join(", ")}`,
        );
      }
      if (!captionTokens.has(marker)) {
        errors.push(`${at} "${m}" is not in the caption - name only the words the caption actually uses`);
      }
    });
  }

  // --- and it is not one of their captions back
  for (const row of facts.captions.values()) {
    if (row.text.trim() === caption.trim()) {
      errors.push(
        `the caption is a copy of the creator's own caption "${row.id}" - write the next one, not the last one`,
      );
      break;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, response: a as unknown as CreatorDraft };
}

/**
 * The message that goes back to the model after a rejection.
 *
 * Same contract as the brand's side: name the field, the value it got, and
 * the rule it broke. "invalid output" is a bug.
 */
export function creatorRejectionFeedback(errors: string[]): string {
  return [
    `The answer was rejected by the validator. ${errors.length} problem(s) must be fixed.`,
    `Fix ONLY these fields and call submit_creator_response again:`,
    ...errors.map((e, i) => `  ${i + 1}. ${e}`),
    `Do not explain. Do not apologise. Call the tool with the corrected arguments.`,
  ].join("\n");
}
