/**
 * The copilot loop's test.
 *
 * The loop is the interesting part of this codebase: on a model with NO
 * structured-output support, a plan can still be made reliable - by producing
 * it through tool calling and validating every argument in code, then feeding
 * the exact errors back.
 *
 * This test proves the loop with a FAKE client, so it is deterministic and
 * costs nothing to run:
 *
 *   1. a model that calls the tool correctly on the first try is accepted;
 *   2. a model that calls it with bad arguments is REJECTED, and the validator's
 *      exact errors are fed back to it;
 *   3. a model that recovers after being told what is wrong is accepted;
 *   4. a model that never recovers is reported as a failure - never as a plan;
 *   5. a model that answers in prose is rejected - a prose plan is never stored;
 *   6. a model that emits broken JSON is rejected, and the loop continues.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-copilot-loop.ts
 */

import { runCopilot, type ChatClient } from "../src/agent/copilot.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` - ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

const METRIC_IDS = new Set(["row_post_1"]);

const VALID_ARGS = {
  weekOf: "2026-11-02",
  cadencePerWeek: 2,
  creatorShortlist: [
    { creatorId: "kol_aria", reason: "median views 4,820 over 90 days", justifyingMetric: 4820 },
  ],
  contentBriefs: [
    { creatorId: "kol_aria", objective: "introduce", hook: "3 weeks, one routine", cta: "link in bio", imageCount: 2 },
  ],
  citedMetrics: [{ metric: "median_views_90d", sourceRowId: "row_post_1", value: 4820 }],
  notes: "post twice in week one.",
};

/** A client that returns a scripted sequence of replies. */
function scriptedClient(replies: { args?: unknown; raw?: string; prose?: string }[]) {
  const seen: any[] = [];
  let i = 0;
  const client: ChatClient = {
    async complete({ messages }) {
      seen.push(JSON.parse(JSON.stringify(messages)));
      const r = replies[Math.min(i, replies.length - 1)];
      i++;
      if (r.prose !== undefined) return { content: r.prose };
      const raw = r.raw ?? JSON.stringify(r.args);
      return { tool_calls: [{ id: `call_${i}`, function: { name: "submit_campaign_plan", arguments: raw } }] };
    },
  };
  return { client, seen };
}

console.log("test-copilot-loop\n");

// ---------------------------------------------------------------- 1. the happy path
console.log("# 1. a correct first call is accepted");
{
  const { client } = scriptedClient([{ args: VALID_ARGS }]);
  const r = await runCopilot({
    client,
    systemPrompt: "you are the copilot",
    userPrompt: "plan the week",
    supportedMetricIds: METRIC_IDS,
  });
  check("the run succeeded", r.ok, JSON.stringify(r.errors));
  check("the plan came back", !!r.plan);
  check("it took one attempt", r.attempts === 1, String(r.attempts));
  // 🔴 THE FIX: the transcript keeps BOTH facts - the model called the tool
  // (the raw arguments are preserved) AND the call was accepted. The earlier
  // code overwrote one with the other and lost the evidence.
  check("the transcript records the acceptance", r.transcript[0]?.action === "tool_accepted");
  check(
    "the transcript preserves the raw tool arguments",
    String(r.transcript[0]?.raw ?? "").includes("weekOf"),
    String(r.transcript[0]?.raw ?? "").slice(0, 120),
  );
}

// ---------------------------------------------------------------- 2. the rejection
console.log("\n# 2. a bad call is rejected and the errors are fed back");
{
  const { client, seen } = scriptedClient([
    { args: { ...VALID_ARGS, weekOf: "2026-11-03" } }, // a Tuesday
  ]);
  const r = await runCopilot({
    client,
    systemPrompt: "you are the copilot",
    userPrompt: "plan the week",
    supportedMetricIds: METRIC_IDS,
    maxAttempts: 2,
  });
  check("the run did NOT succeed", !r.ok);
  check("the transcript shows the rejection", r.transcript[0]?.action === "tool_rejected");
  check(
    "the rejected turn still preserves the raw arguments",
    String(r.transcript[0]?.raw ?? "").includes("weekOf"),
    String(r.transcript[0]?.raw ?? "").slice(0, 120),
  );
  check(
    "the rejection names the Monday rule",
    (r.transcript[0]?.errors ?? []).some((e) => e.includes("must be a Monday")),
    JSON.stringify(r.transcript[0]?.errors),
  );
  // the feedback went back to the model as a tool message
  const secondTurn = seen[1] ?? [];
  const feedback = secondTurn.find((m: any) => m.role === "tool");
  check("the errors were fed back to the model", !!feedback, JSON.stringify(secondTurn.slice(-1)));
  check(
    "the feedback names the Monday rule",
    String(feedback?.content ?? "").includes("must be a Monday"),
    String(feedback?.content ?? "").slice(0, 160),
  );
  check(
    "the feedback asks for the tool to be called again",
    String(feedback?.content ?? "").includes("call submit_campaign_plan again"),
  );
}

// ---------------------------------------------------------------- 3. the recovery
console.log("\n# 3. a model that is told what is wrong can recover");
{
  const { client } = scriptedClient([
    { args: { ...VALID_ARGS, citedMetrics: [{ metric: "m", sourceRowId: "row_invented", value: 1 }] } },
    { args: VALID_ARGS },
  ]);
  const r = await runCopilot({
    client,
    systemPrompt: "you are the copilot",
    userPrompt: "plan the week",
    supportedMetricIds: METRIC_IDS,
    maxAttempts: 3,
  });
  check("the run succeeded after the correction", r.ok, JSON.stringify(r.errors));
  check("it took two attempts", r.attempts === 2, String(r.attempts));
  check("the first attempt was rejected", r.transcript[0]?.action === "tool_rejected");
  check("the second attempt was accepted", r.transcript[1]?.action === "tool_accepted");
  check(
    "the rejection named the invented row",
    (r.transcript[0]?.errors ?? []).some((e) => e.includes("row_invented")),
    JSON.stringify(r.transcript[0]?.errors),
  );
}

// ---------------------------------------------------------------- 4. no recovery
console.log("\n# 4. a model that never recovers fails - and never yields a plan");
{
  const { client } = scriptedClient([{ args: { ...VALID_ARGS, weekOf: "nope" } }]);
  const r = await runCopilot({
    client,
    systemPrompt: "you are the copilot",
    userPrompt: "plan the week",
    supportedMetricIds: METRIC_IDS,
    maxAttempts: 3,
  });
  check("the run failed", !r.ok);
  check("NO plan was returned", r.plan === undefined);
  check("it used every attempt", r.attempts === 3, String(r.attempts));
  check("every attempt was rejected", r.transcript.every((t) => t.action === "tool_rejected"));
}

// ---------------------------------------------------------------- 5. prose is never a plan
console.log("\n# 5. a prose answer is never stored as a plan");
{
  const { client } = scriptedClient([{ prose: "Here is your plan: post on Tuesday and reach out to 3 creators..." }]);
  const r = await runCopilot({
    client,
    systemPrompt: "you are the copilot",
    userPrompt: "plan the week",
    supportedMetricIds: METRIC_IDS,
    maxAttempts: 2,
  });
  check("the run failed", !r.ok);
  check("NO plan was returned", r.plan === undefined);
  check(
    "the rejection says a prose plan is discarded",
    (r.transcript[0]?.errors ?? []).some((e) => e.includes("prose")),
    JSON.stringify(r.transcript[0]?.errors),
  );
}

// ---------------------------------------------------------------- 6. broken JSON
console.log("\n# 6. broken JSON is rejected and the loop continues");
{
  const { client } = scriptedClient([
    { raw: "{ weekOf: '2026-11-02', " }, // not JSON
    { args: VALID_ARGS },
  ]);
  const r = await runCopilot({
    client,
    systemPrompt: "you are the copilot",
    userPrompt: "plan the week",
    supportedMetricIds: METRIC_IDS,
    maxAttempts: 3,
  });
  check("the run succeeded on the second attempt", r.ok, JSON.stringify(r.errors));
  check("it took two attempts", r.attempts === 2, String(r.attempts));
  check(
    "the rejection named the JSON problem",
    (r.transcript[0]?.errors ?? []).some((e) => e.includes("not valid JSON")),
    JSON.stringify(r.transcript[0]?.errors),
  );
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} test-copilot-loop — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
