/**
 * The tool-calling loop, generalised.
 *
 * WHY THIS EXISTS NEXT TO `copilot.ts`
 * ------------------------------------
 * `copilot.ts` is the original loop, written for one tool and one contract. It
 * works, it has 27 assertions behind it, and it is not touched here.
 *
 * The planner needs the same loop against a different tool and a different
 * validator. Copying `runCopilot` and renaming things would produce two
 * implementations of the same idea that drift the first time one of them
 * learns something - and the thing they would drift on is the rejection path,
 * which is the part that matters.
 *
 * So this is the loop with the parts that vary lifted out: the tool, the
 * validator, and the feedback text. `runCopilot` keeps its own copy for now
 * rather than being refactored onto this one, because refactoring tested code
 * for tidiness is how a passing suite stops meaning anything.
 *
 * THE SHAPE, WHICH IS FORCED BY THE MODEL
 * ---------------------------------------
 * Muse Spark Open has no structured-output enforcement (see campaign-plan.ts).
 * So the only trustworthy path is:
 *
 *   the model calls the tool
 *     -> the arguments are validated IN CODE
 *       -> valid   -> returned
 *       -> invalid -> the errors go back and it calls again
 *
 * There is no "parse the prose and hope" branch, and no branch that returns an
 * unvalidated value.
 */

import type { ChatClient } from "./copilot.ts";

/** One turn, as the transcript records it. */
export type LoopTurn = {
  turn: number;
  action: "tool_call" | "tool_rejected" | "tool_accepted";
  /** The raw arguments the model sent. Kept even when rejected. */
  raw?: string;
  /** The validator's verdict. */
  errors?: string[];
};

export type LoopResult<T> =
  | { ok: true; value: T; attempts: number; transcript: LoopTurn[] }
  | { ok: false; attempts: number; transcript: LoopTurn[]; errors: string[] };

export type ToolLoopArgs<T> = {
  client: ChatClient;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  /** The single tool the model may call. */
  tool: unknown;
  /** The tool's `function.name`, used to confirm the right tool was called. */
  toolName: string;
  maxAttempts: number;
  /** The in-code check. This is the only gate. */
  validate: (input: unknown) => { ok: true; value: T } | { ok: false; errors: string[] };
  /** The message fed back after a rejection. */
  feedback: (errors: string[]) => string;
};

/**
 * Run the loop until the validator accepts, or until `maxAttempts`.
 *
 * A model that answers in prose instead of calling the tool is treated as a
 * rejection with a named reason, not as a soft failure: a value delivered as
 * prose cannot be validated, so it cannot be accepted, and saying so is more
 * useful to the model than silence.
 */
export async function runToolLoop<T>(args: ToolLoopArgs<T>): Promise<LoopResult<T>> {
  const transcript: LoopTurn[] = [];
  const messages: {
    role: "system" | "user" | "tool";
    content: string;
    tool_call_id?: string;
  }[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userPrompt },
  ];

  for (let turn = 1; turn <= args.maxAttempts; turn++) {
    const reply = await args.client.complete({
      model: args.model,
      messages,
      tools: [args.tool],
      tool_choice: "required",
    });

    const call = reply.tool_calls?.[0];

    if (!call || call.function.name !== args.toolName) {
      const errors = [
        `you must call ${args.toolName} - a value delivered as prose cannot be validated and will be discarded`,
      ];
      transcript.push({
        turn,
        action: "tool_rejected",
        raw: reply.content ?? "(no content)",
        errors,
      });
      messages.push({
        role: "tool",
        tool_call_id: call?.id ?? `call_${turn}`,
        content: args.feedback(errors),
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
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: args.feedback(errors),
      });
      continue;
    }

    const result = args.validate(parsed);
    if (result.ok) {
      transcript[transcript.length - 1] = {
        ...transcript[transcript.length - 1],
        action: "tool_accepted",
      };
      return { ok: true, value: result.value, attempts: turn, transcript };
    }

    transcript[transcript.length - 1] = {
      ...transcript[transcript.length - 1],
      action: "tool_rejected",
      errors: result.errors,
    };
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: args.feedback(result.errors),
    });
  }

  return {
    ok: false,
    attempts: args.maxAttempts,
    transcript,
    errors: transcript.flatMap((t) => t.errors ?? []),
  };
}
