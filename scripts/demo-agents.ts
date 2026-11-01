/**
 * THE THREE-AGENT DEMO - run it with:
 *
 *   npm run demo:agents
 *
 * `npm run demo` shows the original single-agent loop. This shows the pipeline
 * built on top of it: a planner decides, a writer writes, a reviewer reads -
 * and every stage is allowed to reject.
 *
 * No API key is needed. Without BASETEN_API_KEY the agents run against the
 * scripted model, which makes the mistakes a real model makes so the guards
 * have something to catch. With a key, the same pipeline runs against Muse
 * Spark Open and this script prints what actually happened instead.
 *
 * The scripted model is a mock of the MODEL. The validator, the claim scanner,
 * the conformance check and the reviewer's verdict logic are the real
 * production code in every run.
 */

import { runCampaign, type RunEvent } from "../src/agent/orchestrator.ts";
import { checkNoFakes } from "../src/agent/no-fakes.ts";
import { rowsToMap } from "../src/agent/dataset.ts";
import { SEREH } from "../src/web/data.ts";
import { chooseModel } from "../src/web/model.ts";

const WEEK = "2026-11-02";
const BRIEF = "launch the serum, and show it fitting into a routine people already have";

function line(char = "─", width = 64): string {
  return char.repeat(width);
}

async function main() {
  const choice = chooseModel(SEREH);

  console.log("");
  console.log(line("═"));
  console.log("  CreatorGuard AI - three agents, one flow");
  console.log(line("═"));
  console.log(`  the model:  ${choice.label}`);
  console.log(`  the week:   ${WEEK}`);
  console.log(`  the brief:  ${BRIEF}`);
  console.log(`  the data:   synthetic - Sereh, a skincare brand, ${SEREH.rows.length} rows`);
  console.log("");

  // Print progress as it happens, so the rejections are visible in order
  // rather than reconstructed afterwards.
  let indent = "";
  const onEvent = (e: RunEvent) => {
    if (e.type === "stage_start") {
      console.log(`${indent}▶ ${e.stage} (attempt ${e.attempt})`);
    } else if (e.type === "stage_ok") {
      console.log(`${indent}  ✓ ${e.detail}`);
    } else if (e.type === "stage_failed") {
      console.log(`${indent}  ✗ rejected`);
      for (const err of e.errors) console.log(`${indent}      ${err}`);
    } else if (e.type === "revision") {
      console.log(`${indent}  ↺ sending the plan back to the writer`);
    }
  };

  const result = await runCampaign({
    client: choice.client,
    dataset: SEREH,
    brief: BRIEF,
    weekOf: WEEK,
    onEvent,
  });

  console.log("");
  console.log(line());

  if (!result.ok) {
    console.log("  ✗ the run FAILED - no plan was produced, and none was stored.");
    console.log("");
    console.log(`  why: ${result.reason}`);
    console.log("");
    process.exit(1);
  }

  const plan = result.plan!;
  const strategy = result.strategy!;

  /**
   * The rejections the stream could not show.
   *
   * A stage that retries internally looks like one clean success from the
   * outside: `runPlanner` calls the tool twice and only reports the second
   * call. Printing the count without printing the reasons would be worse than
   * printing neither - it would advertise a rejection the reader cannot see.
   */
  const absorbed = result.stages.filter((s) => s.ok && s.rejections.length > 0);
  if (absorbed.length > 0) {
    console.log("  rejected before it passed (inside a stage's own retry loop)");
    for (const s of absorbed) {
      console.log(`    ${s.stage}, attempt ${s.attempt}:`);
      for (const r of s.rejections) console.log(`      ✗ ${r}`);
    }
    console.log("");
  }

  console.log("  the strategy (from the planner)");
  console.log(`    angle:     ${strategy.angle}`);
  console.log(`    cadence:   ${strategy.cadencePerWeek} post(s) per creator`);
  console.log("    constraints:");
  for (const c of strategy.constraints) console.log(`      - ${c}`);
  console.log("");

  console.log("  the plan (from the writer)");
  console.log(`    week of:   ${plan.weekOf}`);
  for (const b of plan.contentBriefs) {
    console.log(`    · ${b.creatorId}  [${b.imageCount} image(s)]`);
    console.log(`        “${b.hook}”`);
    console.log(`        cta: ${b.cta}`);
  }
  console.log("");

  console.log("  the shortlist, and the number behind each pick");
  for (const c of plan.creatorShortlist) {
    console.log(`    · ${c.creatorId}  ${c.justifyingMetric}  - ${c.reason}`);
  }
  console.log("");

  console.log("  every number, and the row it came from");
  for (const m of plan.citedMetrics) {
    console.log(`    · ${m.metric} = ${m.value}   (row ${m.sourceRowId})`);
  }
  console.log("");

  // The independent guard, run one more time on the finished plan. It has
  // already run inside the writer's loop; running it here is the point - a
  // guard that only runs where it is convenient is a guard you can route
  // around.
  console.log("  the no-fakes guard, on the finished plan");
  const guard = checkNoFakes(plan, rowsToMap(SEREH));
  if (guard.ok) {
    console.log("    ✓ every number traces to a row that exists, and agrees with it.");
  } else {
    console.log("    ✗ the guard found a problem:");
    for (const e of guard.errors) console.log(`      · ${e}`);
  }
  console.log("");

  if (result.warnings.length > 0) {
    console.log("  warnings - shown to the brand, not blocking");
    for (const w of result.warnings) console.log(`    ! ${w}`);
    console.log("");
  }

  if (result.degraded) {
    console.log("  note: the judgement pass did not complete, so no model read this plan.");
    console.log("");
  }

  const calls = result.stages.reduce((n, s) => n + s.modelCalls, 0);
  const rejected = result.stages.reduce((n, s) => n + s.rejections.length, 0);
  console.log(line());
  console.log(`  ${calls} model call(s), ${rejected} rejection(s), ${result.stages.length} stage(s).`);
  console.log("");
}

main().catch((e) => {
  console.error("  the demo failed:", e?.message ?? e);
  process.exit(1);
});
