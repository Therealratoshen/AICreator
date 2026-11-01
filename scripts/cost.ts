/**
 * WHAT DOES ONE PLAN COST?
 *
 * The cost of the copilot is the first question a small brand asks, so it is
 * computed here rather than asserted.
 *
 * THE PRICES are Baseten's published Model API rates for Muse Spark Open, per
 * million tokens, as fetched from https://www.baseten.co/pricing on 2026-11-01:
 *
 *     Input        $1.25 / M tokens
 *     Cached input $0.15 / M tokens
 *     Output       $4.25 / M tokens
 *
 * Run: node --experimental-strip-types --no-warnings scripts/cost.ts
 */

export const PRICES = {
  /** per million input tokens */
  input: 1.25,
  /** per million cached input tokens */
  cachedInput: 0.15,
  /** per million output tokens */
  output: 4.25,
} as const;

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  /** How many of the input tokens came from the KV cache. */
  cachedInputTokens?: number;
};

export type Cost = {
  /** The cost in US dollars. */
  usd: number;
  /** The cost in US cents, rounded to 4 places — readable at a glance. */
  cents: number;
  /** The cost in Indonesian rupiah, at the rate below. */
  idr: number;
  /** The breakdown, so the number can be checked by hand. */
  breakdown: { label: string; tokens: number; usd: number }[];
};

/**
 * The rupiah rate used for the IDR figure.
 *
 * ⇒ THIS IS AN ASSUMPTION, NOT A QUOTE. It is stated here so a reader can
 *   see it and disagree with it. A live plan should fetch the rate.
 */
export const ASSUMED_USD_IDR = 16_300;

/** The cost of one run, from the token counts. */
export function costOfRun(usage: Usage): Cost {
  // 🔴 THE FIX: a cached count can never exceed the input count. A client
  // that reports 5,000 cached tokens for a 100-token prompt would otherwise
  // be billed the CACHED rate ($0.15/M) for 4,900 tokens that do not exist -
  // and at 100x the uncached rate, that is a real overcharge. The cached count
  // is clamped to the input count, and the cached rate is only ever applied
  // to tokens that are actually inside the input.
  const inputTokens = Math.max(0, usage.inputTokens);
  const cached = Math.min(Math.max(0, usage.cachedInputTokens ?? 0), inputTokens);
  const uncached = inputTokens - cached;

  const outputTokens = Math.max(0, usage.outputTokens);

  const uncachedUsd = (uncached / 1_000_000) * PRICES.input;
  const cachedUsd = (cached / 1_000_000) * PRICES.cachedInput;
  const outputUsd = (outputTokens / 1_000_000) * PRICES.output;

  const usd = uncachedUsd + cachedUsd + outputUsd;

  const breakdown = [
    { label: "input (uncached)", tokens: uncached, usd: uncachedUsd },
    { label: "input (cached)", tokens: cached, usd: cachedUsd },
    { label: "output", tokens: outputTokens, usd: outputUsd },
  ].filter((b) => b.tokens > 0);

  return {
    usd,
    cents: Number((usd * 100).toFixed(4)),
    idr: Math.round(usd * ASSUMED_USD_IDR),
    breakdown,
  };
}

/**
 * What a week's plan actually costs, for a realistic run.
 *
 * ⇒ THE SIZES ARE ESTIMATES, and they are labelled as such: a brand's 90 days
 *   of Instagram insights plus a creator profile, inlined into one prompt.
 *   The point of the number is the ORDER OF MAGNITUDE: it is cents, not
 *   dollars, so a small brand can run this every week.
 */
export const ESTIMATED_WEEKLY_RUN: Usage = {
  // 90 days of posts + insights, plus the creator profiles, inlined
  inputTokens: 12_000,
  // the system prompt, the schema, the data, and the plan
  outputTokens: 900,
};

export const ESTIMATED_RUN_WITH_REJECTION: Usage = {
  // a rejected attempt + a corrected one: the input is re-sent, the output doubles
  inputTokens: 24_000,
  outputTokens: 1_800,
};

function money(usd: number): string {
  if (usd === 0) return "$0.000000";
  if (usd < 0.001) return `$${usd.toFixed(6)}`;
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(4)}`;
}

function main() {
  console.log("");
  console.log("  the cost of one CreatorGuard plan");
  console.log("  ────────────────────────────────────────────────────────────");
  console.log("  the prices (Baseten's published rates, per million tokens):");
  console.log(`    input         $${PRICES.input}`);
  console.log(`    cached input  $${PRICES.cachedInput}`);
  console.log(`    output        $${PRICES.output}`);
  console.log("");

  const runs: [string, Usage][] = [
    ["one accepted plan", ESTIMATED_WEEKLY_RUN],
    ["one plan with a rejection and a retry", ESTIMATED_RUN_WITH_REJECTION],
  ];

  for (const [label, usage] of runs) {
    const c = costOfRun(usage);
    console.log(`  ${label}:`);
    console.log(`    the tokens:  ${usage.inputTokens} in, ${usage.outputTokens} out`);
    for (const b of c.breakdown) {
      console.log(`      ${b.label.padEnd(16)} ${String(b.tokens).padStart(8)}  ${money(b.usd)}`);
    }
    console.log(`    the cost:    ${money(c.usd)}  (${c.cents} cents)  ≈ Rp ${c.idr.toLocaleString("en-US")}`);
    console.log("");
  }

  const weekly = costOfRun(ESTIMATED_WEEKLY_RUN);
  const monthly = weekly.usd * 4.33;

  console.log("  what that means for the business this is for:");
  console.log(`    one week of plans for one brand:  ${money(weekly.usd)}`);
  console.log(`    one month of plans for one brand:  ${money(monthly)}  (≈ Rp ${Math.round(monthly * ASSUMED_USD_IDR).toLocaleString("en-US")})`);
  console.log(`    one month for 100 brands:         ${money(monthly * 100)}`);
  console.log("");
  console.log("    ⇒ a brand with 5,000 followers can run this every week and still");
  console.log("      spend less on the copilot than on a single boosted post.");
  console.log("");
  console.log("  the IDR figures use an assumed rate of Rp " + ASSUMED_USD_IDR.toLocaleString("en-US") + "/USD.");
  console.log("");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
