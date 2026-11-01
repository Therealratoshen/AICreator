/**
 * The single orchestrated flow.
 *
 * Three agents, one path, one exit. This file is the only place that knows the
 * order, and the only place that decides a run has failed.
 *
 *     planner  ──▶  strategy  ──▶  writer  ──▶  plan  ──▶  reviewer
 *         │                            ▲                      │
 *         │                            └────── revise ────────┘
 *         │                                     (at most MAX_REVISIONS)
 *         └──▶ no strategy: stop, no plan
 *
 * WHY A REVISION LOOP AND NOT A RETRY
 * -----------------------------------
 * A writer retry (inside `runWriter`) fixes a plan that failed a *code* check -
 * the model was told what field was wrong and calls the tool again. A revision
 * is different: the plan is valid, and a reader objected to what it says. That
 * goes back as a new prompt with the reviewer's specific findings, not as a
 * validator error, because "rewrite this hook" and "this field is not a
 * Monday" need different instructions.
 *
 * WHY IT CAN END WITH NO PLAN
 * ---------------------------
 * `AGENTS.md` invariant 1. When the loop is exhausted the run returns
 * `ok: false` and `plan` is undefined. There is no partial plan, no last-good
 * attempt, and no fallback. A campaign that could not be made right is not
 * published at 80% - it is reported as not published, with the reasons.
 */

import type { ChatClient } from "./copilot.ts";
import type { CampaignPlan } from "./campaign-plan.ts";
import type { CampaignStrategy } from "./strategy.ts";
import type { BrandDataset } from "./dataset.ts";
import { runPlanner } from "./planner.ts";
import { runWriter } from "./writer.ts";
import { runReviewer, blockersOf, warningsOf, type ReviewReport } from "./reviewer.ts";

/** How many times the reviewer may send a plan back. Two revisions, three plans. */
export const MAX_REVISIONS = 2;

export type StageName = "planner" | "writer" | "reviewer";

/** What happened at one stage, kept whether it succeeded or not. */
export type StageRecord = {
  stage: StageName;
  /** 1-based. The writer and reviewer run once per revision. */
  attempt: number;
  ok: boolean;
  /** Blocking reasons, when it failed. */
  errors: string[];
  /**
   * Rejections the stage's OWN loop absorbed before it succeeded.
   *
   * Without this a stage reads "passed, 2 model calls" and the rejection that
   * happened in between is invisible - which hides exactly the thing this
   * project exists to show. A run where the model was wrong and recovered is
   * the interesting run, and it must not look identical to one where it was
   * right first time.
   */
  rejections: string[];
  /** Non-blocking findings, when it succeeded. */
  warnings: string[];
  /** Model calls this stage spent, so the cost of a run is visible. */
  modelCalls: number;
};

/** The errors from every tool call a stage's loop had to reject. */
function rejectionsIn(transcript: readonly { action: string; errors?: string[] }[]): string[] {
  return transcript.flatMap((t) => (t.action === "tool_rejected" ? (t.errors ?? []) : []));
}

/**
 * How many times something was rejected across a run.
 *
 * Two kinds, and they are counted differently on purpose:
 *
 *  - a stage's own loop rejected a tool call and retried — one entry in
 *    `rejections` per rejected call;
 *  - a stage returned a failing verdict and the run went round again — a stage
 *    record that is not `ok` is exactly one rejection, on top of whatever its
 *    loop absorbed internally.
 *
 * Summing `rejections` alone under-reports. The demo scenario shows three
 * rejections on screen — two absorbed, one from the reviewer — and the first
 * version of its summary line claimed two, because the reviewer's rejection is
 * a verdict rather than a tool call. A count that disagrees with the output
 * above it is worse than no count.
 */
export function rejectionCount(stages: readonly StageRecord[]): number {
  return stages.reduce((n, s) => n + s.rejections.length + (s.ok ? 0 : 1), 0);
}

/**
 * Progress, for streaming.
 *
 * The web layer subscribes to this rather than polling the result, because a
 * three-agent run takes long enough that a blank screen is indistinguishable
 * from a broken one.
 */
export type RunEvent =
  | { type: "stage_start"; stage: StageName; attempt: number }
  | { type: "stage_ok"; stage: StageName; attempt: number; detail: string }
  | { type: "stage_failed"; stage: StageName; attempt: number; errors: string[] }
  | { type: "revision"; attempt: number; blockers: string[] }
  | { type: "done"; ok: boolean; reason: string };

export type RunResult = {
  ok: boolean;
  /** Present when the planner succeeded, even if the run later failed. */
  strategy?: CampaignStrategy;
  /** Present ONLY when the plan passed every gate and the reviewer approved. */
  plan?: CampaignPlan;
  stages: StageRecord[];
  /** Non-blocking findings from the last review. Shown to the brand. */
  warnings: string[];
  /** True when the judgement pass could not run. See `reviewer.ts`. */
  degraded: boolean;
  /** Why the run stopped, in one sentence. Always set when `ok` is false. */
  reason?: string;
};

export type OrchestratorArgs = {
  client: ChatClient;
  dataset: BrandDataset;
  /** The brand's ask, in their own words. */
  brief: string;
  /** The Monday the plan starts. */
  weekOf: string;
  /** Called as the run progresses. Never awaited, never allowed to fail the run. */
  onEvent?: (event: RunEvent) => void;
  maxRevisions?: number;
};

/** Fire-and-forget: a broken listener must not break the run. */
function emit(onEvent: ((e: RunEvent) => void) | undefined, event: RunEvent): void {
  if (!onEvent) return;
  try {
    onEvent(event);
  } catch {
    // A streaming subscriber that throws is a bug in the subscriber. The run
    // is the thing that matters, so it continues.
  }
}

/**
 * Run planner → writer → reviewer, with revisions, until a plan is approved.
 *
 * The only success is a plan the reviewer approved. Everything else is a
 * failure with a reason, and no plan.
 */
export async function runCampaign(args: OrchestratorArgs): Promise<RunResult> {
  const stages: StageRecord[] = [];
  const maxRevisions = Math.max(0, args.maxRevisions ?? MAX_REVISIONS);

  // ---------------------------------------------------------------- planner
  emit(args.onEvent, { type: "stage_start", stage: "planner", attempt: 1 });
  const planned = await runPlanner({
    client: args.client,
    dataset: args.dataset,
    brief: args.brief,
    weekOf: args.weekOf,
  });

  stages.push({
    stage: "planner",
    attempt: 1,
    ok: planned.ok,
    errors: planned.ok ? [] : (planned.errors ?? []),
    rejections: rejectionsIn(planned.transcript),
    warnings: [],
    modelCalls: planned.attempts,
  });

  if (!planned.ok || !planned.strategy) {
    const errors = planned.errors ?? ["the planner produced no strategy"];
    emit(args.onEvent, { type: "stage_failed", stage: "planner", attempt: 1, errors });
    const reason =
      `the planner could not produce a valid strategy in ${planned.attempts} call(s), ` +
      `so no plan was written`;
    emit(args.onEvent, { type: "done", ok: false, reason });
    return { ok: false, stages, warnings: [], degraded: false, reason };
  }

  const strategy = planned.strategy;
  emit(args.onEvent, {
    type: "stage_ok",
    stage: "planner",
    attempt: 1,
    detail: `${strategy.creatorIds.length} creator(s), ${strategy.cadencePerWeek}/week`,
  });

  // ---------------------------------------------------------------- writer ⇄ reviewer
  let revision: string[] = [];
  let lastReport: ReviewReport | undefined;

  for (let attempt = 1; attempt <= maxRevisions + 1; attempt++) {
    emit(args.onEvent, { type: "stage_start", stage: "writer", attempt });
    const written = await runWriter({
      client: args.client,
      strategy,
      dataset: args.dataset,
      brief: args.brief,
      revision,
    });

    stages.push({
      stage: "writer",
      attempt,
      ok: written.ok,
      errors: written.ok ? [] : (written.errors ?? []),
      rejections: rejectionsIn(written.transcript),
      warnings: written.warnings.map((w) => `${w.where}: [${w.code}] ${w.message}`),
      modelCalls: written.attempts,
    });

    if (!written.ok || !written.plan) {
      const errors = written.errors ?? ["the writer produced no plan"];
      emit(args.onEvent, { type: "stage_failed", stage: "writer", attempt, errors });
      const reason =
        `the writer could not produce a valid plan in ${written.attempts} call(s); ` +
        `no plan was stored`;
      emit(args.onEvent, { type: "done", ok: false, reason });
      return { ok: false, strategy, stages, warnings: [], degraded: false, reason };
    }

    emit(args.onEvent, {
      type: "stage_ok",
      stage: "writer",
      attempt,
      detail: `${written.plan.contentBriefs.length} brief(s)`,
    });

    // ---------------------------------------------------------------- reviewer
    emit(args.onEvent, { type: "stage_start", stage: "reviewer", attempt });
    const report = await runReviewer({
      client: args.client,
      plan: written.plan,
      strategy,
      dataset: args.dataset,
    });
    lastReport = report;

    const blockers = blockersOf(report);
    stages.push({
      stage: "reviewer",
      attempt,
      ok: report.verdict === "approve",
      errors: blockers,
      rejections: rejectionsIn(report.transcript),
      warnings: warningsOf(report),
      modelCalls: report.attempts,
    });

    if (report.verdict === "approve") {
      emit(args.onEvent, {
        type: "stage_ok",
        stage: "reviewer",
        attempt,
        detail: report.degraded
          ? "approved on the code checks; the judgement pass did not complete"
          : "approved",
      });
      const reason = report.degraded
        ? "approved - but the judgement pass did not complete, so no model read this plan"
        : "approved";
      emit(args.onEvent, { type: "done", ok: true, reason });

      return {
        ok: true,
        strategy,
        plan: written.plan,
        stages,
        warnings: [...written.warnings.map((w) => `${w.where}: [${w.code}] ${w.message}`), ...warningsOf(report)],
        degraded: report.degraded,
        reason,
      };
    }

    emit(args.onEvent, { type: "stage_failed", stage: "reviewer", attempt, errors: blockers });
    revision = blockers;
    emit(args.onEvent, { type: "revision", attempt, blockers });
  }

  // ---------------------------------------------------------------- exhausted
  // A valid plan was produced and is deliberately NOT returned: the reviewer
  // rejected it. Invariant 1 has no exception for "nearly right".
  const reason =
    `the plan was rejected by the reviewer ${maxRevisions + 1} time(s) and was not published. ` +
    `Last objections: ${(lastReport ? blockersOf(lastReport) : []).slice(0, 3).join("; ") || "none recorded"}`;

  emit(args.onEvent, { type: "done", ok: false, reason });

  return {
    ok: false,
    strategy,
    stages,
    warnings: lastReport ? warningsOf(lastReport) : [],
    degraded: lastReport?.degraded ?? false,
    reason,
  };
}
