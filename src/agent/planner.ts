/**
 * Agent 1 of 3: the planner.
 *
 * WHAT IT DECIDES, AND WHAT IT REFUSES TO DECIDE
 * ----------------------------------------------
 * The planner answers four questions and stops: which creators, how often,
 * what angle, and what the writer must avoid. It does not write a hook, a
 * caption, or a call to action. Those belong to the writer, and a planner that
 * drafts them produces text the writer then discards - so the only effect of
 * letting it try is that the strategy gets less attention.
 *
 * The split is not tidiness. It is what makes the reviewer able to say
 * "the strategy is fine, the wording is not" - which is a correction the
 * system can act on. Given one agent doing both, every rejection is a
 * rejection of everything, and the retry re-decides choices nobody objected
 * to.
 *
 * WHY THIS AGENT IS THE ONE TO WATCH
 * ----------------------------------
 * It picks the creators, so it is the agent with the strongest incentive to
 * produce a number that supports the pick it already wanted. `strategy.ts`
 * checks that in code: the row must exist, its value must match, and it must
 * be about the creator being justified. None of that is left to the prompt.
 *
 * The prompt below still states the rule, because a model told the rule makes
 * fewer rejected calls than one discovering it by rejection. But the prompt is
 * not the gate. The validator is.
 */

import { MODEL, type ChatClient } from "./copilot.ts";
import { runToolLoop, type LoopTurn } from "./tool-loop.ts";
import {
  validateCampaignStrategy,
  strategyFeedback,
  type CampaignStrategy,
} from "./strategy.ts";
import { renderDataset, strategyContextOf, type BrandDataset } from "./dataset.ts";

/** One model, named once, in `copilot.ts`. */
export const PLANNER_MODEL = MODEL;

/** Same budget as the copilot loop: three calls, then report the failure. */
export const PLANNER_MAX_ATTEMPTS = 3;

export const SUBMIT_CAMPAIGN_STRATEGY_TOOL = {
  type: "function" as const,
  function: {
    name: "submit_campaign_strategy",
    description:
      "Submit the campaign strategy. This is the ONLY way to deliver a strategy - a strategy " +
      "written as prose is discarded. Every argument is validated in code before it is accepted: " +
      "the creators must exist, and every rationale must cite a real row whose value it quotes " +
      "exactly and which is about that creator. A rejected call returns the exact list of fields " +
      "to fix.",
    parameters: {
      type: "object",
      properties: {
        weekOf: {
          type: "string",
          description: "The Monday the plan starts, YYYY-MM-DD. Must be a real Monday.",
        },
        cadencePerWeek: {
          type: "integer",
          minimum: 1,
          maximum: 14,
          description: "Posts per week, per creator.",
        },
        creatorIds: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          description:
            "The creators to use, best first. Every id must appear in the CREATORS list in the data.",
          items: { type: "string" },
        },
        angle: {
          type: "string",
          description:
            "One sentence: what every brief this week should express. Must be specific enough " +
            "that a reviewer can check a draft against it.",
        },
        rationale: {
          type: "array",
          description:
            "Exactly one entry per creator in creatorIds. This is the justification, and it is " +
            "checked: the row must exist, the value must be that row's value, and the row must " +
            "be about that creator.",
          items: {
            type: "object",
            properties: {
              creatorId: { type: "string", description: "Must be one of creatorIds." },
              metric: {
                type: "string",
                description: 'The metric name in words, e.g. "median_saves_90d".',
              },
              sourceRowId: {
                type: "string",
                description: "The row id from the data that holds this number.",
              },
              value: {
                type: "number",
                description: "The number, exactly as the row holds it.",
              },
            },
            required: ["creatorId", "metric", "sourceRowId", "value"],
          },
        },
        constraints: {
          type: "array",
          description:
            "What the writer must not do. Carried into the writer's prompt verbatim and shown " +
            "to the brand, so write commitments, not suggestions. May be empty.",
          items: { type: "string" },
        },
      },
      required: ["weekOf", "cadencePerWeek", "creatorIds", "angle", "rationale", "constraints"],
    },
  },
};

export type PlannerResult = {
  ok: boolean;
  strategy?: CampaignStrategy;
  /** Every rejection reason, flattened, when the loop ran out of attempts. */
  errors?: string[];
  attempts: number;
  transcript: LoopTurn[];
};

/**
 * The planner's system prompt.
 *
 * Two things are deliberate. The rule is stated *and* the consequence is
 * stated, because a model that knows what the validator checks spends its
 * three calls recovering rather than re-guessing. And the data is rendered
 * grouped by subject, because the failure this prompt is trying to prevent is
 * attaching the right number to the wrong creator, and a flat list is where
 * that starts happening.
 */
export function buildPlannerSystemPrompt(dataset: BrandDataset): string {
  return [
    "You are the PLANNER, the first of three agents in a creator-marketing engine.",
    "You decide the strategy. A WRITER turns it into briefs. A REVIEWER checks the result",
    "against the data and the compliance rules.",
    "",
    "You do not write posts, hooks or captions. If you write them here they are discarded",
    "and the writer writes different ones, so any effort spent on wording is wasted effort.",
    "",
    "THE HOUSE RULE",
    "Every number you use must be the value of a row listed below, cited by its row id.",
    "There is no exception for estimates, ranges, rounded figures, totals you added up,",
    "averages you computed, or numbers you remember from somewhere else. A row's value is",
    "the only number you are allowed to state.",
    "",
    "WHAT IS CHECKED IN CODE AFTER YOU SUBMIT",
    "  1. weekOf must be a real Monday.",
    "  2. cadencePerWeek must be a whole number from 1 to 14.",
    "  3. creatorIds must hold 1 to 12 ids, with no duplicates, and every id must appear in",
    "     the CREATORS list below. A creator you have heard of but that is not in this list",
    "     does not exist.",
    "  4. rationale must hold exactly one entry per creator in creatorIds. Each entry must",
    "     name a row that exists, quote that row's exact value, and cite a row that is about",
    "     that same creator. Another creator's number is not evidence about this one, however",
    "     impressive it is.",
    "  5. constraints must be an array of strings. It may be empty.",
    "",
    "A rejection returns a numbered list of exact fields. Fix those fields, leave the rest",
    "alone, and call the tool again. Do not re-plan from scratch: the fields that were not",
    "rejected were not rejected for a reason.",
    "",
    "HOW TO CHOOSE",
    "Choose on the numbers, not on how a handle reads. Prefer creators in the brand's niche,",
    "and prefer the metric that matters for the goal - reach is not saves, and a view count",
    "on a post nobody saved is a number rather than a result.",
    "",
    "If the data does not support a pick, shortlist fewer creators. One creator you can",
    "justify with a real row is worth more than three held up by numbers that do not exist.",
    "Shortlisting nobody is not an option; shortlisting one is.",
    "",
    "`angle` is one sentence describing what every brief this week should express. It is what",
    "the reviewer holds the writer to, so make it checkable. \"Show the product being used on",
    "a normal morning\" is checkable. \"Be authentic\" is not.",
    "",
    "`constraints` is where you put what the writer must not do. These go into the writer's",
    "prompt verbatim and are shown to the brand, so write them as commitments, not as wishes.",
    "",
    "=== DATA ===",
    renderDataset(dataset),
    "=== END DATA ===",
  ].join("\n");
}

/** What the operator asked for, framed for the model. */
export function buildPlannerUserPrompt(args: { brief: string; weekOf: string }): string {
  return [
    `WEEK: ${args.weekOf} (a Monday - the plan starts here)`,
    "",
    "WHAT THE BRAND ASKED FOR:",
    args.brief.trim() || "(no specific ask - plan a defensible week from the data)",
    "",
    "Decide the strategy and call submit_campaign_strategy.",
  ].join("\n");
}

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A `weekOf` that is not a Monday is a caller bug, not a model mistake.
 *
 * The validator would catch it too, but only after spending one of three
 * attempts asking the model to fix something the model cannot fix - the value
 * is in the caller's argument, not in the model's output. So this throws.
 */
function assertMonday(weekOf: string): void {
  const d = new Date(`${weekOf}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekOf) || Number.isNaN(d.getTime())) {
    throw new Error(`runPlanner: weekOf "${weekOf}" is not a YYYY-MM-DD date`);
  }
  if (d.getUTCDay() !== 1) {
    throw new Error(
      `runPlanner: weekOf "${weekOf}" is a ${SHORT_DAYS[d.getUTCDay()]}, not a Monday`,
    );
  }
}

/**
 * Run the planner until the validator accepts, or until `maxAttempts`.
 *
 * Returns the failure rather than throwing it: a model that cannot produce a
 * valid strategy in three calls is a result the orchestrator has to report,
 * and the transcript is the evidence for the report.
 */
export async function runPlanner(args: {
  client: ChatClient;
  dataset: BrandDataset;
  /** What the brand or operator asked for, in their own words. */
  brief: string;
  /** The Monday the plan starts. */
  weekOf: string;
  maxAttempts?: number;
}): Promise<PlannerResult> {
  assertMonday(args.weekOf);

  const ctx = strategyContextOf(args.dataset);

  const loop = await runToolLoop<CampaignStrategy>({
    client: args.client,
    model: PLANNER_MODEL,
    systemPrompt: buildPlannerSystemPrompt(args.dataset),
    userPrompt: buildPlannerUserPrompt({ brief: args.brief, weekOf: args.weekOf }),
    tool: SUBMIT_CAMPAIGN_STRATEGY_TOOL,
    toolName: "submit_campaign_strategy",
    maxAttempts: args.maxAttempts ?? PLANNER_MAX_ATTEMPTS,
    validate: (input) => {
      const result = validateCampaignStrategy(input, ctx);
      return result.ok
        ? { ok: true, value: result.strategy }
        : { ok: false, errors: result.errors };
    },
    feedback: strategyFeedback,
  });

  if (loop.ok) {
    return {
      ok: true,
      strategy: loop.value,
      attempts: loop.attempts,
      transcript: loop.transcript,
    };
  }

  return {
    ok: false,
    errors: loop.errors,
    attempts: loop.attempts,
    transcript: loop.transcript,
  };
}
