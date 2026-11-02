/**
 * The tool-calling loop, with nothing brand-specific in it.
 *
 * WHY THIS FILE EXISTS:
 *
 * The brand's half of the marketplace and the creator's half must be the SAME
 * machine, not two machines that look alike. The vendor's constraint - the
 * model does not enforce a schema, so the application does - applies to both
 * halves, so the loop that enforces it is written once and used twice:
 *
 *   the model calls the tool
 *        -> the arguments are validated IN CODE
 *             -> valid   -> the value is returned
 *             -> invalid -> the validator's errors go back to the model
 *                            and it calls the tool again (up to maxAttempts)
 *
 * There is no "parse the JSON and hope" here, and there is no branch that
 * returns an unvalidated value.
 *
 * Everything this loop needs is passed in: the tool, the validator, and the
 * text that goes back to the model after a rejection. The brand's plan and the
 * creator's answer therefore travel the same road, which is the point.
 */

export type ToolLoopMessage = {
  role: "system" | "user" | "tool";
  content: string;
  tool_call_id?: string;
};

/** The minimum a chat client has to provide. */
export type ChatClient = {
  /** One turn. Messages are OpenAI-shaped. Returns the assistant message. */
  complete(args: {
    model: string;
    messages: ToolLoopMessage[];
    tools: unknown[];
    tool_choice?: unknown;
  }): Promise<{
    tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    content?: string;
  }>;
};

export type ToolTranscriptEntry = {
  turn: number;
  /**
   * What happened on this turn.
   *   tool_call      - the model called the tool
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

export type ToolLoopResult<T> = {
  ok: boolean;
  /** The validated value, when the run succeeded. */
  value?: T;
  /** The validator's errors, when the value was rejected. */
  errors?: string[];
  /** How many times the model called the tool. */
  attempts: number;
  /** The whole transcript, for the demo. */
  transcript: ToolTranscriptEntry[];
};

/**
 * One tool, and the rules that decide whether its arguments are acceptable.
 *
 * `validate` must be PURE: no I/O, no model, no clock, no randomness. That is
 * what makes every rule testable by mutating one field and asserting on the
 * exact error.
 */
export type ToolSpec<T> = {
  /** The tool's name. The model must call exactly this. */
  name: string;
  /** The tool definition handed to the model. */
  definition: unknown;
  /** The rejection used when the model answered in prose instead of calling it. */
  proseRejection: string;
  /** The message that goes back to the model after a rejection. */
  rejectionFeedback: (errors: string[]) => string;
  /** The pure validator. */
  validate: (input: unknown) => { ok: true; value: T } | { ok: false; errors: string[] };
};

/** The model both halves run on. */
export const MUSE_SPARK_OPEN = "meta-models/muse-spark-open";

export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Run the loop until the model produces a value that passes validation, or
 * until maxAttempts is reached.
 */
export async function runToolLoop<T>(args: {
  client: ChatClient;
  systemPrompt: string;
  userPrompt: string;
  tool: ToolSpec<T>;
  model?: string;
  maxAttempts?: number;
}): Promise<ToolLoopResult<T>> {
  const maxAttempts = args.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const transcript: ToolTranscriptEntry[] = [];

  const messages: ToolLoopMessage[] = [
    { role: "system", content: args.systemPrompt },
    { role: "user", content: args.userPrompt },
  ];

  for (let turn = 1; turn <= maxAttempts; turn++) {
    const reply = await args.client.complete({
      model: args.model ?? MUSE_SPARK_OPEN,
      messages,
      tools: [args.tool.definition],
      tool_choice: "required",
    });

    const call = reply.tool_calls?.[0];

    // The model did not call the tool. Say so plainly and try again.
    if (!call || call.function.name !== args.tool.name) {
      const errors = [args.tool.proseRejection];
      transcript.push({
        turn,
        action: "tool_rejected",
        raw: reply.content ?? "(no content)",
        errors,
      });
      messages.push({
        role: "tool",
        tool_call_id: call?.id ?? `call_${turn}`,
        content: args.tool.rejectionFeedback(errors),
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
      messages.push({ role: "tool", tool_call_id: call.id, content: args.tool.rejectionFeedback(errors) });
      continue;
    }

    const result = args.tool.validate(parsed);
    if (result.ok) {
      // The turn recorded the tool CALL; now it also records that the call was
      // ACCEPTED. Keeping both facts is what makes the transcript evidence.
      transcript[transcript.length - 1] = {
        ...transcript[transcript.length - 1],
        action: "tool_accepted",
      };
      return { ok: true, value: result.value, attempts: turn, transcript };
    }

    // Rejected. The validator's errors go straight back to the model.
    transcript[transcript.length - 1] = {
      ...transcript[transcript.length - 1],
      action: "tool_rejected",
      errors: result.errors,
    };
    messages.push({ role: "tool", tool_call_id: call.id, content: args.tool.rejectionFeedback(result.errors) });
  }

  return {
    ok: false,
    attempts: maxAttempts,
    transcript,
    errors: transcript.flatMap((t) => t.errors ?? []),
  };
}
