/**
 * The creator's half: the validator, the guard and the loop.
 *
 * The house style here is a MUTATION of a known-good answer: take the good
 * answer, break exactly one field, assert the exact error. A test that does
 * not fail when the code is wrong is worse than no test - it is a false
 * guarantee.
 *
 * The rules that are proved here are the ones that make this half honest:
 *
 *   1. a metric with no data is ABSENT, never zero;
 *   2. a number that has no row is refused, in the prose and in the citations;
 *   3. a draft is compared against the creator's OWN captions, in their own
 *      register, at the length the brief asked for;
 *   4. the voice path runs end to end: a memo in, an answer out;
 *   5. the creator's half goes through the SAME tool-calling contract as the
 *      brand's - a prose answer is discarded, not stored.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-creator.ts
 */

import {
  validateCreatorResponse,
  registerMarkers,
  countWords,
  extractNumbers,
  parseNumberToken,
  lengthBand,
  type CreatorFacts,
} from "../src/agent/creator-answer.ts";
import { checkCreatorNoFakes } from "../src/agent/creator-no-fakes.ts";
import { runCreatorAgent, runCreatorAgentFromVoice } from "../src/agent/creator-agent.ts";
import { runToolLoop, type ChatClient } from "../src/agent/creator-tool-loop.ts";
import { scriptedTranscriber, buildSilentWav } from "../src/agent/voice.ts";

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

// ---------------------------------------------------------------- the data

const METRIC_ROWS = new Map([
  ["row_reach_1", { id: "row_reach_1", metric: "reach", value: 4820 }],
  ["row_reach_2", { id: "row_reach_2", metric: "reach", value: 5310 }],
  ["row_saves_1", { id: "row_saves_1", metric: "saves", value: 310 }],
]);

const CAPTIONS = new Map([
  ["cap_1", { id: "cap_1", text: "rutinitas pagi, glowinggggg ✨ 实测 3 minggu" }],
  ["cap_2", { id: "cap_2", text: "3 minggurutinitas, glowinggggg ✨ 实测 3 minggu" }],
  ["cap_3", { id: "cap_3", text: "rutinitas glowinggggg ✨ 3 minggu, real" }],
]);

const FACTS: CreatorFacts = {
  creatorId: "kol_aria",
  metricRows: METRIC_ROWS,
  captions: CAPTIONS,
  brief: { objective: "introduce the serum", lengthWords: 12 },
  allowedNumbers: [3],
};

const GOOD_EXPLANATION = {
  kind: "explain",
  question: "kenapa 3 posting terakhir saya kurang perform?",
  answer:
    "3 posting terakhirmu reach-nya 4.820 dan 5.310, saves 310. Watch time belum tercatat.",
  citedMetrics: [
    { metric: "reach", sourceRowId: "row_reach_1", value: 4820 },
    { metric: "saves", sourceRowId: "row_saves_1", value: 310 },
  ],
  absentMetrics: [{ metric: "watch_time", reason: "tidak ada baris watch_time untuk 3 posting ini" }],
};

const GOOD_DRAFT = {
  kind: "draft",
  caption: "rutinitas 3 minggu, glowinggggg ✨ 实测 mornings skin barrier check",
  wordCount: 10,
  comparedAgainst: [{ captionRowId: "cap_1" }, { captionRowId: "cap_2" }],
  // Every marker is a standalone word in one of the compared rows:
  // "rutinitas" is a word in cap_1, and cap_2 deliberately glues it
  // ("minggurutinitas") to prove the tokenizer does not invent it there.
  // Every marker is a habit: it appears in at least two of the three
  // captions, so the draft really does follow the creator's register.
  matchedMarkers: ["rutinitas", "glowinggggg", "✨", "实测"],
  briefObjective: "introduce the serum",
};

// ---------------------------------------------------------------- helpers

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
      return { tool_calls: [{ id: `call_${i}`, function: { name: "submit_creator_response", arguments: raw } }] };
    },
  };
  return { client, seen };
}

console.log("test-creator\n");

// ---------------------------------------------------------------- 1. the good answers pass
console.log("# 1. a good answer is accepted");
{
  const r = validateCreatorResponse(GOOD_EXPLANATION, FACTS, "explain");
  check("the explanation is valid", r.ok, JSON.stringify(r.ok ? [] : r.errors));

  const d = validateCreatorResponse(GOOD_DRAFT, FACTS, "draft");
  check("the draft is valid", d.ok, JSON.stringify(d.ok ? [] : d.errors));
}

// ---------------------------------------------------------------- 2. absence is not zero
console.log("\n# 2. a metric with no data is absent, never zero");
{
  const zeroed = {
    ...GOOD_EXPLANATION,
    absentMetrics: [{ metric: "watch_time", reason: "no data", value: 0 }],
  };
  const r = validateCreatorResponse(zeroed, FACTS, "explain");
  check("an absent metric with a value is rejected", !r.ok);
  check(
    "the rejection says absence is not zero",
    !r.ok && r.errors.some((e) => e.includes("not zero")),
    JSON.stringify(r.ok ? [] : r.errors),
  );

  // And the guard refuses a zero written in the prose for a metric that has
  // no row - the prose is where a zero sneaks in.
  const zeroInProse = {
    ...GOOD_EXPLANATION,
    answer: "3 posting terakhirmu reach-nya 4.820, watch time 0 detik.",
    absentMetrics: [],
  };
  const g = checkCreatorNoFakes(zeroInProse as any, FACTS, GOOD_EXPLANATION.question);
  check("a zero in the prose for a metric with no row is refused", !g.ok);
  check(
    "the guard names the invented zero",
    !g.ok && g.errors.some((e) => e.includes("0")),
    JSON.stringify(g.ok ? [] : g.errors),
  );
}

// ---------------------------------------------------------------- 3. the no-fakes rule on prose
console.log("\n# 3. a number with no row is refused");
{
  const invented = {
    ...GOOD_EXPLANATION,
    answer: "3 posting terakhirmu reach-nya 4.820, engagement rate 4,2%.",
  };
  const g = checkCreatorNoFakes(invented as any, FACTS, GOOD_EXPLANATION.question);
  check("an invented number in the prose is refused", !g.ok);
  check(
    "the guard names the invented number",
    !g.ok && g.errors.some((e) => e.includes("4.2")),
    JSON.stringify(g.ok ? [] : g.errors),
  );

  // A number that DOES have a row is fine.
  const g2 = checkCreatorNoFakes(GOOD_EXPLANATION as any, FACTS, GOOD_EXPLANATION.question);
  check("an answer whose numbers all have rows passes the guard", g2.ok, JSON.stringify(g2.ok ? [] : g2.errors));

  // A number the CREATOR used is not a fabrication.
  const creatorNumber = {
    ...GOOD_EXPLANATION,
    answer: "3 posting terakhirmu reach-nya 4.820.",
  };
  const g3 = checkCreatorNoFakes(creatorNumber as any, FACTS, "kenapa 3 posting terakhir saya kurang perform?");
  check("a number the creator used is allowed", g3.ok, JSON.stringify(g3.ok ? [] : g3.errors));

  // A cited value that disagrees with its row is refused.
  const wrongValue = {
    ...GOOD_EXPLANATION,
    citedMetrics: [{ metric: "reach", sourceRowId: "row_reach_1", value: 9999 }],
  };
  const g4 = checkCreatorNoFakes(wrongValue as any, FACTS, GOOD_EXPLANATION.question);
  check("a cited value that disagrees with its row is refused", !g4.ok);
  check(
    "the guard names the row and the value",
    !g4.ok && g4.errors.some((e) => e.includes("row_reach_1") && e.includes("9999")),
    JSON.stringify(g4.ok ? [] : g4.errors),
  );
}

// ---------------------------------------------------------------- 4. the validator's mutations
console.log("\n# 4. every mutation of a good answer is rejected, for the right reason");
{
  const mutations: { name: string; input: unknown; expect: string }[] = [
    {
      name: "a cited row that does not exist",
      input: {
        ...GOOD_EXPLANATION,
        citedMetrics: [{ metric: "reach", sourceRowId: "row_invented", value: 4820 }],
      },
      expect: "does not exist",
    },
    {
      name: "a metric name that is not the row's name",
      input: {
        ...GOOD_EXPLANATION,
        citedMetrics: [{ metric: "views", sourceRowId: "row_reach_1", value: 4820 }],
      },
      expect: "use the row's own name",
    },
    {
      name: "a metric that is both cited and absent",
      input: {
        ...GOOD_EXPLANATION,
        absentMetrics: [{ metric: "reach", reason: "no data" }],
      },
      expect: "either has a row or it does not",
    },
    {
      name: "an answer that cites nothing at all",
      input: { ...GOOD_EXPLANATION, citedMetrics: [], absentMetrics: [] },
      expect: "cites no metric",
    },
    {
      name: "the wrong kind for the question",
      input: { ...GOOD_DRAFT },
      expectedKind: "explain",
      expect: "the creator asked for a",
    },
    {
      name: "a word count that does not match the caption",
      input: { ...GOOD_DRAFT, wordCount: 99 },
      expect: "count the words separated by spaces",
    },
    {
      name: "a caption that is far from the brief's length",
      input: { ...GOOD_DRAFT, caption: "pendek banget", wordCount: 2 },
      expect: "the brief asks for",
    },
    {
      name: "a brief objective that is not the brief",
      input: { ...GOOD_DRAFT, briefObjective: "sell a serum" },
      expect: "answer the brief you were given",
    },
    {
      name: "a caption compared against a caption that does not exist",
      input: { ...GOOD_DRAFT, comparedAgainst: [{ captionRowId: "cap_invented" }] },
      expect: "does not exist",
    },
    {
      name: "a draft compared against nothing",
      input: { ...GOOD_DRAFT, comparedAgainst: [] },
      expect: "was not compared",
    },
    {
      name: "a draft that reuses no register marker",
      input: { ...GOOD_DRAFT, matchedMarkers: [] },
      expect: "must reuse the words this creator uses",
    },
    {
      name: "a register marker that is not the creator's",
      input: { ...GOOD_DRAFT, matchedMarkers: ["serumne"] },
      expect: "is not a word this creator uses",
    },
    {
      name: "a register marker that is not in the caption",
      input: { ...GOOD_DRAFT, matchedMarkers: ["rutinitas", "notinthecaption"] },
      expect: "is not in the caption",
    },
    {
      name: "the creator's own caption, copied back",
      input: { ...GOOD_DRAFT, caption: CAPTIONS.get("cap_1")!.text, wordCount: 7 },
      expect: "write the next one, not the last one",
    },
  ];

  for (const m of mutations) {
    // The mutation must be judged in the CONTEXT it would arrive in. A
    // draft offered where the creator asked for an explanation is
    // exactly the failure the expectedKind check exists to catch, so
    // the harness has to pass it.
    const r = validateCreatorResponse(m.input, FACTS, m.expectedKind);
    check(`${m.name} is rejected`, !r.ok);
    check(
      `${m.name} - the reason is the right one`,
      !r.ok && r.errors.some((e) => e.includes(m.expect)),
      JSON.stringify(r.ok ? [] : r.errors),
    );
  }
}

// ---------------------------------------------------------------- 5. the register
console.log("\n# 5. the register is measured from the creator's own captions");
{
  const markers = registerMarkers(CAPTIONS);
  check("the register markers were found", markers.length > 0, JSON.stringify(markers));
  check("the marker is a word the creator uses", markers.includes("rutinitas"), JSON.stringify(markers));
  check("a stop word is not a marker", !markers.includes("yang"), JSON.stringify(markers));

  // Fewer than two captions: no register can be measured, and the code says
  // so rather than guessing.
  const one = new Map([["cap_1", CAPTIONS.get("cap_1")!]]);
  check("one caption is not enough to measure a register", registerMarkers(one).length === 0);

  // A creator with no captions at all.
  check("no captions means no markers", registerMarkers(new Map()).length === 0);
}

// ---------------------------------------------------------------- 6. the numbers
console.log("\n# 6. the numbers are read the Indonesian way");
{
  check("a dot groups thousands", parseNumberToken("4.820") === 4820, String(parseNumberToken("4.820")));
  check("a comma is a decimal point", parseNumberToken("4,82") === 4.82, String(parseNumberToken("4,82")));
  check("plain digits are plain", parseNumberToken("310") === 310);
  check("a number with a percent sign still parses", parseNumberToken("4,2%") === 4.2);

  const nums = extractNumbers("reach 4.820, saves 310, 3 posting, 4,2%");
  check("every number in a sentence is found", nums.length === 4, JSON.stringify(nums));
  check("the thousands figure is read as one number", nums.includes(4820), JSON.stringify(nums));

  check("words are counted the way the brief means", countWords("one two three") === 3);
  check("the length band is a fifth of the target", lengthBand(12) === 2, String(lengthBand(12)));
  check("a tiny target still allows two words", lengthBand(3) === 2, String(lengthBand(3)));
}

// ---------------------------------------------------------------- 7. the tool-calling contract
console.log("\n# 7. the creator's half goes through the same tool-calling contract");
{
  // A prose answer is discarded, exactly as a prose plan is.
  const { client } = scriptedClient([{ prose: "Reach kamu 4.820, kok naik ya?" }]);
  const r = await runCreatorAgent({
    client,
    facts: FACTS,
    question: GOOD_EXPLANATION.question,
    kind: "explain",
    maxAttempts: 2,
  });
  check("a prose answer fails the run", !r.ok);
  check("NO answer was returned", r.response === undefined);
  check(
    "the rejection says a prose answer is discarded",
    (r.transcript[0]?.errors ?? []).some((e) => e.includes("prose")),
    JSON.stringify(r.transcript[0]?.errors),
  );

  // A rejected call comes back with the exact reason, and the model recovers.
  const { client: c2, seen } = scriptedClient([
    { args: { ...GOOD_EXPLANATION, citedMetrics: [{ metric: "reach", sourceRowId: "row_invented", value: 4820 }] } },
    { args: GOOD_EXPLANATION },
  ]);
  const r2 = await runCreatorAgent({
    client: c2,
    facts: FACTS,
    question: GOOD_EXPLANATION.question,
    kind: "explain",
    maxAttempts: 3,
  });
  check("the run succeeded after the correction", r2.ok, JSON.stringify(r2.errors));
  check("it took two attempts", r2.attempts === 2, String(r2.attempts));
  check(
    "the rejection named the invented row",
    (r2.transcript[0]?.errors ?? []).some((e) => e.includes("row_invented")),
    JSON.stringify(r2.transcript[0]?.errors),
  );
  const feedback = (seen[1] ?? []).find((m: any) => m.role === "tool");
  check("the errors were fed back to the model", !!feedback);
  check(
    "the feedback asks for the tool to be called again",
    String(feedback?.content ?? "").includes("call submit_creator_response again"),
  );

  // Broken JSON is rejected and the loop continues.
  const { client: c3 } = scriptedClient([{ raw: "{ kind: 'explain', " }, { args: GOOD_EXPLANATION }]);
  const r3 = await runCreatorAgent({
    client: c3,
    facts: FACTS,
    question: GOOD_EXPLANATION.question,
    kind: "explain",
    maxAttempts: 3,
  });
  check("broken JSON is rejected and the loop continues", r3.ok, JSON.stringify(r3.errors));
  check(
    "the rejection named the JSON problem",
    (r3.transcript[0]?.errors ?? []).some((e) => e.includes("not valid JSON")),
    JSON.stringify(r3.transcript[0]?.errors),
  );

  // A model that never recovers yields NO answer, exactly like a plan.
  const { client: c4 } = scriptedClient([{ args: { ...GOOD_EXPLANATION, question: "" } }]);
  const r4 = await runCreatorAgent({
    client: c4,
    facts: FACTS,
    question: GOOD_EXPLANATION.question,
    kind: "explain",
    maxAttempts: 2,
  });
  check("a model that never recovers fails", !r4.ok);
  check("NO answer was returned", r4.response === undefined);
}

// ---------------------------------------------------------------- 8. the guard rejects what the validator accepted
console.log("\n# 8. the guard is a second opinion, and it can reject");
{
  // The validator accepts this: every cited row exists, every rule holds.
  // The prose says a number no row holds. Only the guard catches it.
  const sneaky = {
    kind: "explain",
    question: GOOD_EXPLANATION.question,
    answer: "3 posting terakhirmu reach-nya 4.820, saves 310, cuman 12% yang fired.",
    citedMetrics: [
      { metric: "reach", sourceRowId: "row_reach_1", value: 4820 },
      { metric: "saves", sourceRowId: "row_saves_1", value: 310 },
    ],
    absentMetrics: [{ metric: "watch_time", reason: "no row" }],
  };
  const v = validateCreatorResponse(sneaky, FACTS, "explain");
  check("the validator alone does NOT catch it", v.ok, JSON.stringify(v.ok ? [] : v.errors));

  const { client } = scriptedClient([{ args: sneaky }]);
  const r = await runCreatorAgent({
    client,
    facts: FACTS,
    question: GOOD_EXPLANATION.question,
    kind: "explain",
    maxAttempts: 2,
  });
  check("the guard rejects the run", !r.ok);
  check("NO answer was returned", r.response === undefined);
  check(
    "the guard named the invented percentage",
    (r.guardErrors ?? []).some((e) => e.includes("12")),
    JSON.stringify(r.guardErrors),
  );
}

// ---------------------------------------------------------------- 9. the voice path
console.log("\n# 9. the voice path works end to end");
{
  const memo = { bytes: buildSilentWav(1), mimeType: "audio/wav", filename: "memo.wav" };
  check("the memo has real WAV bytes", memo.bytes.length > 44, String(memo.bytes.length));
  check(
    "the memo starts with the RIFF header",
    String.fromCharCode(...memo.bytes.slice(0, 4)) === "RIFF",
  );

  const { client } = scriptedClient([{ args: GOOD_EXPLANATION }]);
  const r = await runCreatorAgentFromVoice({
    client,
    transcriber: scriptedTranscriber(GOOD_EXPLANATION.question),
    facts: FACTS,
    memo,
    kind: "explain",
    maxAttempts: 3,
  });
  check("the voice run succeeded", r.ok, JSON.stringify(r.errors));
  check("the answer came back", !!r.response);
  check("the question is what the creator said", r.question === GOOD_EXPLANATION.question, r.question);
  check("the transcription model is recorded", !!r.transcriptionModel, String(r.transcriptionModel));
  check("the answer is an explanation", r.response?.kind === "explain");
  check(
    "the explanation cites the creator's real rows",
    (r.response as any)?.citedMetrics?.some((m: any) => m.sourceRowId === "row_reach_1"),
  );
  check(
    "the absent metric is reported as absent, without a value",
    (r.response as any)?.absentMetrics?.[0]?.metric === "watch_time" &&
      !("value" in ((r.response as any)?.absentMetrics?.[0] ?? {})),
  );
}

// ---------------------------------------------------------------- 10. both halves share one loop
console.log("\n# 10. both halves of the marketplace use the same loop");
{
  const { client } = scriptedClient([{ args: GOOD_EXPLANATION }]);
  const r = await runToolLoop({
    client,
    systemPrompt: "you are the creator's side",
    userPrompt: "explain",
    tool: {
      name: "submit_creator_response",
      definition: { type: "function" },
      proseRejection: "call the tool",
      rejectionFeedback: () => "call the tool again",
      validate: (input) => {
        const v = validateCreatorResponse(input, FACTS, "explain");
        return v.ok ? { ok: true as const, value: v.response } : { ok: false as const, errors: v.errors };
      },
    },
  });
  check("the shared loop ran", r.ok, JSON.stringify(r.errors));
  check("the shared loop returned the value", !!r.value);
  check("the shared loop kept the transcript", r.transcript.length === 1);
  check("the transcript records the acceptance", r.transcript[0]?.action === "tool_accepted");
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} test-creator — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
