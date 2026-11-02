/**
 * The creator's mirror image: the agent that explains their own numbers and
 * drafts in their own voice.
 *
 * WHY THIS FILE EXISTS:
 *
 * A marketplace is two-sided. The brand's side is in
 * [`./copilot.ts`](./copilot.ts). This is the creator's side, and it is the
 * same machine:
 *
 *   a voice memo (or a typed question)
 *        -> Muse Voice Transcribe            (the format the creator used)
 *        -> the creator's question
 *        -> the model calls submit_creator_response
 *        -> the arguments are validated IN CODE
 *        -> the no-fakes guard checks the PROSE for invented numbers
 *        -> the answer reaches the creator
 *
 * The one place the two halves differ is worth stating plainly: the brand's
 * answer is a structured plan, and the creator's answer is PROSE. That is why
 * the creator's guard reads numbers out of sentences rather than out of a
 * `citedMetrics` array. The tool-call contract is identical.
 */

import {
  runToolLoop,
  MUSE_SPARK_OPEN,
  type ChatClient,
  type ToolLoopResult,
  type ToolSpec,
} from "./creator-tool-loop.ts";
import {
  validateCreatorResponse,
  creatorRejectionFeedback,
  type CreatorFacts,
  type CreatorResponse,
} from "./creator-answer.ts";
import { checkCreatorNoFakes, type CreatorGuardResult } from "./creator-no-fakes.ts";
import { type Transcriber } from "./voice.ts";

export const SUBMIT_CREATOR_RESPONSE_TOOL = {
  type: "function" as const,
  function: {
    name: "submit_creator_response",
    description:
      "Submit the creator's answer. This is the ONLY way to deliver it. Either an " +
      "explanation of their own numbers (kind: \"explain\") or a draft caption in their " +
      "own voice (kind: \"draft\"). Every number you state must trace to a row: give the " +
      "row id in sourceRowId. A metric with no data goes in absentMetrics and never " +
      "carries a value - report it as absent, not as zero.",
    parameters: {
      type: "object",
      properties: {
        kind: {
          type: "string",
          enum: ["explain", "draft"],
          description: "An explanation of the creator's numbers, or a draft caption.",
        },
        question: {
          type: "string",
          description: "The creator's question, restated. For kind: \"explain\".",
        },
        answer: {
          type: "string",
          description: "The explanation, in the creator's own language. For kind: \"explain\".",
        },
        citedMetrics: {
          type: "array",
          description: "The metrics that HAVE data, with the row each came from.",
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
        absentMetrics: {
          type: "array",
          description:
            "The metrics that have NO data. Report the absence; never put a value, and never write zero for these.",
          items: {
            type: "object",
            properties: {
              metric: { type: "string" },
              reason: { type: "string", description: "Why there is no data." },
            },
            required: ["metric", "reason"],
          },
        },
        caption: {
          type: "string",
          description: "The draft caption, in the creator's own voice. For kind: \"draft\".",
        },
        wordCount: {
          type: "integer",
          description: "How many words the caption has. Count words separated by spaces.",
        },
        comparedAgainst: {
          type: "array",
          description: "The creator's own past captions the draft was compared against.",
          items: {
            type: "object",
            properties: { captionRowId: { type: "string" } },
            required: ["captionRowId"],
          },
        },
        matchedMarkers: {
          type: "array",
          description: "The words of the creator's own register that this draft reused.",
          items: { type: "string" },
        },
        briefObjective: {
          type: "string",
          description: "The brief this caption answers. For kind: \"draft\".",
        },
      },
      required: ["kind"],
    },
  },
};

/** The system prompt both creator tasks share. */
export const CREATOR_SYSTEM_PROMPT = `You are CreatorGuard, the creator's side of a campaign
platform for Indonesian small brands and independent creators.

You are talking to a CREATOR, not a brand. They know their own numbers better
than you do, and they do not want a lecture.

You MUST deliver your answer by calling submit_creator_response. There is no
other way to deliver it. A spoken or written answer that is not a tool call
cannot be validated and will be discarded.

Two rules you cannot bend:

1. Every number you state must come from a row you have read. Give the row id
   in sourceRowId. If a metric has no data, put it in absentMetrics and say
   there is no data - NEVER write zero for a metric you have not read.
2. A draft caption must be in the creator's own voice: it reuses the words
   they use, at the length the brief asks for, and it is compared against
   their own past captions.`;

export type CreatorRunResult = {
  ok: boolean;
  response?: CreatorResponse;
  /** The validator's errors, when the answer was rejected. */
  errors?: string[];
  /** The guard's errors, when the answer passed the validator but failed the guard. */
  guardErrors?: string[];
  /** How many times the model called the tool. */
  attempts: number;
  /** The transcript, for the demo. */
  transcript: ToolLoopResult<CreatorResponse>["transcript"];
  /** What the creator said, once transcribed. */
  question: string;
  /** The model that transcribed it. */
  transcriptionModel?: string;
  /** The guard's verdict on the finished answer. */
  guard?: CreatorGuardResult;
};

/**
 * Answer a creator.
 *
 * `question` is what the creator said. If it came from a voice memo, the
 * caller transccribes it first and passes the text here - so the loop, the
 * validator and the guard are identical whether the creator spoke or typed.
 */
export async function runCreatorAgent(args: {
  client: ChatClient;
  facts: CreatorFacts;
  /** The creator's question. */
  question: string;
  /** "explain" or "draft". */
  kind: "explain" | "draft";
  /** The model's transcript of the question, when it came from a voice memo. */
  transcriptionModel?: string;
  systemPrompt?: string;
  userPrompt?: string;
  model?: string;
  maxAttempts?: number;
}): Promise<CreatorRunResult> {
  const tool: ToolSpec<CreatorResponse> = {
    name: "submit_creator_response",
    definition: SUBMIT_CREATOR_RESPONSE_TOOL,
    proseRejection:
      "you must call submit_creator_response - an answer delivered as prose cannot be validated and will be discarded",
    rejectionFeedback: creatorRejectionFeedback,
    validate: (input) => {
      const result = validateCreatorResponse(input, args.facts, args.kind);
      return result.ok
        ? { ok: true as const, value: result.response }
        : { ok: false as const, errors: result.errors };
    },
  };

  const userPrompt =
    args.userPrompt ??
    (args.kind === "explain"
      ? `${args.question}\n\nExplain these numbers to the creator, in Indonesian. Use only the rows given to you. If a metric has no data, say so.`
      : `${args.question}\n\nWrite the next caption for this creator. The brief is: ${args.facts.brief.objective}. The caption must be ${args.facts.brief.lengthWords} words, in the creator's own voice, compared against their own past captions.`);

  const run = await runToolLoop<CreatorResponse>({
    client: args.client,
    systemPrompt: args.systemPrompt ?? CREATOR_SYSTEM_PROMPT,
    userPrompt,
    tool,
    model: args.model ?? MUSE_SPARK_OPEN,
    maxAttempts: args.maxAttempts,
  });

  if (!run.ok || !run.value) {
    return {
      ok: false,
      errors: run.errors,
      attempts: run.attempts,
      transcript: run.transcript,
      question: args.question,
      transcriptionModel: args.transcriptionModel,
    };
  }

  // The guard is the last thing the answer passes through, and it is the
  // thing that can reject an answer the validator accepted: the validator
  // checks the CITED numbers, the guard checks the PROSE.
  const guard = checkCreatorNoFakes(run.value, args.facts, args.question);
  if (!guard.ok) {
    return {
      ok: false,
      guardErrors: guard.errors,
      errors: guard.errors,
      attempts: run.attempts,
      transcript: run.transcript,
      question: args.question,
      transcriptionModel: args.transcriptionModel,
      guard,
    };
  }

  return {
    ok: true,
    response: run.value,
    attempts: run.attempts,
    transcript: run.transcript,
    question: args.question,
    transcriptionModel: args.transcriptionModel,
    guard,
  };
}

/**
 * Answer a creator who spoke instead of typed.
 *
 * The memo goes up to the voice model, the transcript comes back, and the
 * transcript is the question. From there it is the same run.
 */
export async function runCreatorAgentFromVoice(args: {
  client: ChatClient;
  transcriber: Transcriber;
  facts: CreatorFacts;
  memo: Parameters<Transcriber["transcribe"]>[0];
  kind: "explain" | "draft";
  systemPrompt?: string;
  userPrompt?: string;
  model?: string;
  maxAttempts?: number;
}): Promise<CreatorRunResult> {
  const transcription = await args.transcriber.transcribe(args.memo);
  const run = await runCreatorAgent({
    client: args.client,
    facts: args.facts,
    question: transcription.text,
    kind: args.kind,
    transcriptionModel: transcription.model,
    systemPrompt: args.systemPrompt,
    userPrompt: args.userPrompt,
    model: args.model,
    maxAttempts: args.maxAttempts,
  });
  return { ...run, question: transcription.text, transcriptionModel: transcription.model };
}
