/**
 * THE DEMO - run it with:
 *
 *   npm run demo
 *
 * It runs the copilot loop against a SCRIPTED model that makes the mistakes a
 * real model makes, so the demo shows the interesting part: a wrong plan being
 * REJECTED, the exact reasons going back to the model, and the model recovering.
 *
 * No API key is needed to run the demo. To run it against the real model, set
 *   BASETEN_API_KEY   (and optionally BASETEN_MODEL)
 * and the demo will use the live model instead of the scripted one.
 *
 * The scripted model is NOT a mock of the validator - it is a mock of the
 * MODEL. The validator, the rejection messages and the no-fakes guard are the
 * real production code.
 */

import { runCopilot, MODEL, type ChatClient } from "../src/agent/copilot.ts";
import { checkNoFakes, type MetricRow } from "../src/agent/no-fakes.ts";
import type { CampaignPlan } from "../src/agent/campaign-plan.ts";

// ---------------------------------------------------------------- the data
// A small, real-looking slice: a brand's last 90 days and two creators.
const ROWS = new Map<string, MetricRow>([
  ["row_post_1", { id: "row_post_1", value: 4820, table: "brand_instagram_posts" }],
  ["row_post_2", { id: "row_post_2", value: 5310, table: "brand_instagram_posts" }],
  ["row_aud_1", { id: "row_aud_1", value: 310, table: "creator_audience_snapshots" }],
  ["row_aud_2", { id: "row_aud_2", value: 268, table: "creator_audience_snapshots" }],
]);

const METRIC_IDS = new Set(ROWS.keys());

const SYSTEM_PROMPT = `You are CreatorGuard, a campaign copilot for Indonesian small brands and
independent creators. You build a weekly campaign plan from the brand's real
performance and the creators' real audience data.

You MUST deliver the plan by calling submit_campaign_plan. There is no other
way to deliver it. Every number you cite must come from a row you have read:
give the row id in sourceRowId. If you are not sure a number is real, leave it
out rather than estimating.`;

const USER_PROMPT = `Brand: "Sari Beauty" (a small Jakarta skincare brand, 5,000 followers on
Instagram, 90 days of data in the tables above).

Goal for the week of 2026-11-02: launch a serum. The brand's median views over
the last 90 days are 4,820 (row_post_1) and 5,310 (row_post_2).

Creators available, with their real audience data:
  kol_aria  - median saves 310 (row_aud_1)
  kol_budi  - median saves 268 (row_aud_2)

Give me a weekly plan: a creator shortlist, a content brief per creator, and
the cadence.`;

// ---------------------------------------------------------------- the scripted model
// A model that behaves the way a real one does on a model with no structured
// output: the first attempt is close but wrong, and it fixes itself when it
// is told exactly what is wrong.
const FIRST_ATTEMPT = {
  weekOf: "2026-11-03", // 🔴 a Tuesday
  cadencePerWeek: 2,
  creatorShortlist: [
    { creatorId: "kol_aria", reason: "median saves 310, the highest here", justifyingMetric: 310 },
  ],
  contentBriefs: [
    { creatorId: "kol_aria", objective: "introduce the serum", hook: "3 weeks of acne, one routine", cta: "link in bio", imageCount: 2 },
  ],
  citedMetrics: [
    { metric: "median_saves_90d", sourceRowId: "row_aud_1", value: 310 },
    { metric: "median_views_90d", sourceRowId: "row_best_view", value: 4820 }, // 🔴 a row that does not exist
  ],
  notes: "post twice in week one.",
};

const SECOND_ATTEMPT = {
  ...FIRST_ATTEMPT,
  weekOf: "2026-11-02", // ✅ the Monday
  citedMetrics: [
    { metric: "median_saves_90d", sourceRowId: "row_aud_1", value: 310 },
    { metric: "median_views_90d", sourceRowId: "row_post_1", value: 4820 }, // ✅ a real row
  ],
};

function scriptedModel(): ChatClient {
  let turn = 0;
  return {
    async complete() {
      turn++;
      const args = turn === 1 ? FIRST_ATTEMPT : SECOND_ATTEMPT;
      return {
        tool_calls: [
          { id: `call_${turn}`, function: { name: "submit_campaign_plan", arguments: JSON.stringify(args) } },
        ],
      };
    },
  };
}

// ---------------------------------------------------------------- the live model
function liveModel(): ChatClient | null {
  const key = process.env.BASETEN_API_KEY;
  if (!key) return null;
  const model = process.env.BASETEN_MODEL ?? MODEL;
  const base = process.env.BASETEN_BASE_URL ?? "https://inference.baseten.co/v1";
  return {
    async complete({ messages, tools, tool_choice }) {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, tools, tool_choice }),
      });
      if (!res.ok) throw new Error(`the model returned ${res.status}: ${await res.text()}`);
      const data: any = await res.json();
      const msg = data.choices?.[0]?.message ?? {};
      // 🔴 The reasoning model puts its thinking in `reasoning_content`; the
      // content can be EMPTY on a turn the model spent thinking. That is not a
      // failure - it means the model is reasoning, and the tool call is what
      // matters. The loop handles it.
      return {
        tool_calls: msg.tool_calls?.map((c: any) => ({
          id: c.id,
          function: { name: c.function.name, arguments: c.function.arguments },
        })),
        content: msg.content ?? msg.reasoning_content ?? "",
      };
    },
  };
}

// ---------------------------------------------------------------- the run
async function main() {
  const live = liveModel();
  const client = live ?? scriptedModel();

  console.log("");
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  CreatorGuard AI - the copilot loop");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  the model: ${live ? (process.env.BASETEN_MODEL ?? MODEL) : "the scripted model (no API key needed)"}`);
  console.log("");

  const result = await runCopilot({
    client,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: USER_PROMPT,
    supportedMetricIds: METRIC_IDS,
    maxAttempts: 3,
  });

  console.log("── the transcript ──────────────────────────────────────────────");
  for (const turn of result.transcript) {
    console.log("");
    console.log(`  turn ${turn.turn}: ${turn.action}`);
    if (turn.raw) {
      const lines = turn.raw.split("\n");
      for (const l of lines.slice(0, 14)) console.log(`    ${l}`);
      if (lines.length > 14) console.log(`    ... (${lines.length - 14} more lines)`);
    }
    if (turn.errors?.length) {
      console.log("    ── the validator said ──");
      for (const e of turn.errors) console.log(`    ✗ ${e}`);
    }
  }
  console.log("");

  if (!result.ok) {
    console.log("  ✗ the run FAILED - no plan was produced, and none was stored.");
    console.log("");
    process.exit(1);
  }

  console.log("── the plan ───────────────────────────────────────────────────");
  const plan = result.plan as CampaignPlan;
  console.log(`  the week of:    ${plan.weekOf}`);
  console.log(`  the cadence:    ${plan.cadencePerWeek} posts per week per creator`);
  console.log("  the shortlist:");
  for (const c of plan.creatorShortlist) {
    console.log(`    · ${c.creatorId} - ${c.reason} (${c.justifyingMetric})`);
  }
  console.log("  the briefs:");
  for (const b of plan.contentBriefs) {
    console.log(`    · ${b.creatorId} - ${b.hook}  [${b.imageCount} image(s)]`);
  }
  console.log("  the cited metrics:");
  for (const m of plan.citedMetrics) {
    console.log(`    · ${m.metric} = ${m.value}  (${m.sourceRowId})`);
  }
  console.log(`  the note:       ${plan.notes}`);
  console.log("");

  // ---- the no-fakes guard, on the finished plan
  console.log("── the no-fakes guard ─────────────────────────────────────────");
  const guard = checkNoFakes(plan, ROWS);
  if (guard.ok) {
    console.log("  ✓ every number in this plan traces to a row that exists.");
  } else {
    console.log("  ✗ the guard found a problem:");
    for (const e of guard.errors) console.log(`    · ${e}`);
  }
  console.log("");
  console.log(`  the run took ${result.attempts} attempt(s).`);
  console.log("");
}

main().catch((e) => {
  console.error("  the demo failed:", e?.message ?? e);
  process.exit(1);
});
