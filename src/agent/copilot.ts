/**
 * The copilot loop: one turn with Muse Spark Open.
 *
 * The shape is forced by the model (see src/agent/campaign-plan.ts for why):
 *
 *   the model calls submit_campaign_plan
 *        -> the arguments are validated IN CODE
 *             -> valid   -> the plan is stored and returned
 *             -> invalid -> the validator's errors go back to the model
 *                            and it calls the tool again (up to MAX_ATTEMPTS)
 *
 * There is no "parse the JSON and hope" anywhere in this file, and there is
 * no branch that stores an unvalidated plan.
 *
 * The agent is built on the OpenAI-compatible shape that Baseten's Model APIs
 * expose, so the same code runs against `meta-models/muse-spark-open`.
 */

import {
  validateCampaignPlan,
  rejectionFeedback,
  type CampaignPlan,
} from "./campaign-plan.ts";

export const MODEL = "meta-models/muse-spark-open";
export const MAX_ATTEMPTS = 3;

/** The tool the model is allowed to call. Note: there is exactly one. */
export const SUBMIT_CAMPAIGN_PLAN_TOOL = {
  type: "function" as const,
  function: {
    name: "submit_campaign_plan",
    description:
      "Submit the campaign plan. This is the ONLY way to deliver a plan. Every argument " +
      "is validated against the real data before it is accepted; a rejected call comes " +
      "back with the exact list of what to fix. Cite a sourceRowId for every number - " +
      "only rows you have actually read are accepted.",
    parameters: {
      type: "object",
      properties: {
        weekOf: {
          type: "string",
          description: "The Monday the plan starts, YYYY-MM-DD.",
        },
        cadencePerWeek: {
          type: "integer",
          minimum: 1,
          maximum: 14,
          description: "How many posts per week, per creator.",
        },
        creatorShortlist: {
          type: "array",
          minItems: 1,
          maxItems: 12,
          description: "The creators, best first.",
          items: {
            type: "object",
            properties: {
              creatorId: { type: "string" },
              reason: {
                type: "string",
                description: "Why this creator, in one sentence, citing the number that justifies it.",
              },
              justifyingMetric: { type: "number", description: "The number the reason rests on." },
            },
            required: ["creatorId", "reason", "justifyingMetric"],
          },
        },
        contentBriefs: {
          type: "array",
          description: "One brief per shortlisted creator.",
          items: {
            type: "object",
            properties: {
              creatorId: { type: "string" },
              objective: { type: "string" },
              hook: { type: "string" },
              cta: { type: "string" },
              imageCount: { type: "integer", minimum: 1, maximum: 4 },
            },
            required: ["creatorId", "objective", "hook", "cta", "imageCount"],
          },
        },
        citedMetrics: {
          type: "array",
          description: "Every metric the plan uses, with the row it came from.",
          items: {
            type: "object",
            properties: {
              metric: { type: "string" },
              sourceRowId: { type: "string" },
              value: { type: "number" },
            },
            required: ["metric", "sourceRowId", "value"],
          },
        },
        notes: { type: "string", description: "One note to the brand." },
      },
      required: ["weekOf", "cadencePerWeek", "creatorShortlist", "contentBriefs", "citedMetrics", "notes"],
    },
  },
};

/** The minimum a chat client has to provide. */
export type ChatClient = {
  /** One turn. Messages are OpenAI-shaped. Returns the assistant message. */
  complete(args: {
    model: string;
    messages: { role: "system" | "user" | "tool"; content: string; tool_call_id?: string }[];
    tools: unknown[];
    tool_choice?: unknown;
  }): Promise<{ tool_calls?: { id: string; function: { name: string; arguments: string } }[]; content?: string }>;
};

export type TurnResult = {
  ok: boolean;
  plan?: CampaignPlan;
  /** The validator's errors, when the plan was rejected. */
  errors?: string[];
  /** How many times the model called the tool. */
  attempts: number;
  /** The whole transcript, for the demo. */
  transcript: TranscriptEntry[];
  /** The input tokens and output tokens the run cost, when the client reports them. */
  usage?: { inputTokens: number; outputTokens: number };
};

export type TranscriptEntry = {
  turn: number;
  /**
   * What happened on this turn.
   *   tool_call      - the model called submit_campaign_plan
   *   tool_rejected  - the call was rejected by the validator
   *   tool_accepted  - the call passed the validator
   * A rejected call still happened: the raw arguments are always kept, so the
   * transcript shows what the model DID, not only what survived.
   */
  action: "tool_call" | "tool_rejected" | "tool_accepted";
  /** The raw arguments the model sent, as text. */
  raw?: string;
  /** The validator's verdict. */
  errors?: string[];
};

/**
 * Run the copilot until it produces a plan that passes validation, or until
 * MAX_ATTEMPTS is reached.
 *
 * `supportedMetricIds` is the set of metric row ids that actually exist in the
 * database. It is the mechanism behind the no-fakes rule: a plan that cites a
 * row nobody has is rejected, however good it looks.
 */
export async function runCopilot(args: {
  client: ChatClient;
  systemPrompt: string;
  userPrompt: string;
  supportedMetricIds: ReadonlySet<string>;
  maxAttempts?: number;
}): Promise<TurnResult> {
  const maxAttempts = args.maxAttempts ?? MAX_ATTEMPTS;
  const transcript: TranscriptEntry[] = [];

  const messages: { role: "system" | "user" | "tool"; content: string; tool_call_id?: string }[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userPrompt },
  ];

  for (let turn = 1; turn <= maxAttempts; turn++) {
    const reply = await args.client.complete({
      model: MODEL,
      messages,
      tools: [SUBMIT_CAMPAIGN_PLAN_TOOL],
      tool_choice: "required",
    });

    const call = reply.tool_calls?.[0];

    // The model did not call the tool. Say so plainly and try again.
    if (!call || call.function.name !== "submit_campaign_plan") {
      transcript.push({
        turn,
        action: "tool_rejected",
        raw: reply.content ?? "(no content)",
        errors: [
          "you must call submit_campaign_plan - a plan delivered as prose cannot be validated and will be discarded",
        ],
      });
      messages.push({
        role: "tool",
        tool_call_id: call?.id ?? `call_${turn}`,
        content: rejectionFeedback([
          "you must call submit_campaign_plan - a plan delivered as prose cannot be validated and will be discarded",
        ]),
      });
      continue;
    }

    const raw = call.function.arguments;
    transcript.push({ turn, action: "tool_call", raw });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const errors = [`the tool arguments are not valid JSON: ${raw.slice(0, 200)}`];
      transcript[transcript.length - 1] = {
        ...transcript[transcript.length - 1],
        action: "tool_rejected",
        errors,
      };
      messages.push({ role: "tool", tool_call_id: call.id, content: rejectionFeedback(errors) });
      continue;
    }

    const result = validateCampaignPlan(parsed, args.supportedMetricIds);
    if (result.ok) {
      // 🔴 THE FIX: keep BOTH facts. The turn recorded the tool CALL; now it
      // also records that the call was ACCEPTED. Overwriting it lost the fact
      // that the model actually called the tool - which is the whole point of
      // the transcript as evidence.
      transcript[transcript.length - 1] = {
        ...transcript[transcript.length - 1],
        action: "tool_accepted",
      };
      return { ok: true, plan: result.plan, attempts: turn, transcript };
    }

    // Rejected. The validator's errors go straight back to the model.
    transcript[transcript.length - 1] = {
      ...transcript[transcript.length - 1],
      action: "tool_rejected",
      errors: result.errors,
    };
    messages.push({ role: "tool", tool_call_id: call.id, content: rejectionFeedback(result.errors) });
  }

  return {
    ok: false,
    attempts: maxAttempts,
    transcript,
    errors: transcript.flatMap((t) => t.errors ?? []),
  };
}
