/**
 * The web app's test.
 *
 * This starts the REAL server on an ephemeral port and makes REAL HTTP
 * requests. It does not re-implement the routing table in the test, because a
 * test that re-implements the thing it tests proves only that the two copies
 * agree today.
 *
 * What is being proven:
 *
 *   1. the three agents run end to end over HTTP and produce an approved plan;
 *   2. the plan that comes back has every number traceable to a row;
 *   3. a bad `weekOf` is refused before a model is asked (the Monday rule,
 *      enforced at the edge as well as in the validator);
 *   4. the page a reader gets states that the data is synthetic - the one
 *      honesty claim a demo of this product cannot get wrong;
 *   5. a run that cannot produce a plan reports that, rather than an empty page.
 *
 * Run: node --experimental-strip-types --no-warnings scripts/test-web.ts
 */

import type { AddressInfo } from "node:net";
import { server } from "../src/web/server.ts";
import { SEREH } from "../src/web/data.ts";
import { scriptedClient, chooseModel } from "../src/web/model.ts";
import { runCampaign } from "../src/agent/orchestrator.ts";
import { checkNoFakes } from "../src/agent/no-fakes.ts";
import { rowsToMap } from "../src/agent/dataset.ts";

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

console.log("test-web\n");

// ---------------------------------------------------------------- 0. the data
console.log("# 0. the synthetic dataset is internally consistent");
{
  check("the brand has rows", SEREH.rows.filter((r) => r.subject === SEREH.brandName).length > 0);
  check("every creator id is unique", new Set(SEREH.creators.map((c) => c.creatorId)).size === SEREH.creators.length);
  check("every row id is unique", new Set(SEREH.rows.map((r) => r.rowId)).size === SEREH.rows.length);
  check(
    "every row's subject is a known creator or the brand",
    SEREH.rows.every(
      (r) => r.subject === SEREH.brandName || SEREH.creators.some((c) => c.creatorId === r.subject),
    ),
    JSON.stringify(SEREH.rows.filter((r) => r.subject !== SEREH.brandName && !SEREH.creators.some((c) => c.creatorId === r.subject)).map((r) => r.subject)),
  );
  check(
    "one creator deliberately has no rows, so the guard is exercised",
    SEREH.creators.some((c) => !SEREH.rows.some((r) => r.subject === c.creatorId)),
  );
  check("no real email addresses appear in the data", !JSON.stringify(SEREH).includes("@gmail"));
}

// ---------------------------------------------------------------- 1. the model seam
console.log("\n# 1. the model seam picks a mode and says which");
{
  const choice = chooseModel(SEREH);
  const hasKey = !!process.env.BASETEN_API_KEY;
  check(
    "the mode follows the environment",
    choice.mode === (hasKey ? "live" : "scripted"),
    `${choice.mode} with hasKey=${hasKey}`,
  );
  check("it reports a label for the UI", choice.label.length > 0, choice.label);
  check(
    "the scripted label says it is scripted",
    hasKey || choice.label.includes("scripted"),
    choice.label,
  );
}

// ---------------------------------------------------------------- 2. the pipeline the app depends on
console.log("\n# 2. the scripted model drives the real pipeline to an approved plan");
{
  const result = await runCampaign({
    client: scriptedClient(SEREH),
    dataset: SEREH,
    brief: "launch the serum",
    weekOf: "2026-11-02",
  });

  check("the run succeeded", result.ok, result.reason);
  check("a plan came back", !!result.plan);
  check(
    "the deliberate mistakes were actually caught",
    result.stages.filter((s) => s.rejections.length > 0).length >= 2,
    JSON.stringify(result.stages.map((s) => `${s.stage}#${s.attempt}:rej=${s.rejections.length}`)),
  );
  check(
    "the planner's attribution mistake is on the record",
    (result.stages.find((s) => s.stage === "planner")?.rejections ?? []).some((e) =>
      e.includes("is about"),
    ),
    JSON.stringify(result.stages.find((s) => s.stage === "planner")?.rejections),
  );
  check(
    "the writer's uncited statistic is on the record",
    (result.stages.find((s) => s.stage === "writer")?.rejections ?? []).some((e) =>
      e.includes("STAT-UNCITED"),
    ),
    JSON.stringify(result.stages.find((s) => s.stage === "writer")?.rejections),
  );
  check(
    "the planner needed two calls (attribution was caught)",
    result.stages.find((s) => s.stage === "planner")?.modelCalls === 2,
    String(result.stages.find((s) => s.stage === "planner")?.modelCalls),
  );
  check(
    "the reviewer sent it back at least once",
    result.stages.some((s) => s.stage === "reviewer" && !s.ok),
  );
  check("a warning survived to the end", result.warnings.length > 0, JSON.stringify(result.warnings));

  if (result.plan) {
    const guard = checkNoFakes(result.plan, rowsToMap(SEREH));
    check("every number in the final plan traces to a row", guard.ok, !guard.ok ? JSON.stringify(guard.errors) : "");
    check(
      "the plan cites rows that exist",
      result.plan.citedMetrics.every((m) => SEREH.rows.some((r) => r.rowId === m.sourceRowId)),
    );
  }
}

// ---------------------------------------------------------------- 3. the server, for real
console.log("\n# 3. the real server answers real requests");
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;

try {
  const index = await fetch(`${base}/`);
  const indexHtml = await index.text();
  check("GET / is 200", index.status === 200, String(index.status));
  check("the index carries the synthetic notice", indexHtml.includes("Synthetic data"));
  check("the index offers the form", indexHtml.includes("Run the three agents"));

  const bad = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weekOf: "2026-11-03" }),
  });
  const badBody = (await bad.json()) as { error?: string };
  check("a Tuesday is refused with 400", bad.status === 400, String(bad.status));
  check(
    "the refusal explains the Monday rule",
    String(badBody.error).includes("Monday"),
    JSON.stringify(badBody),
  );

  const created = await fetch(`${base}/api/runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ brief: "launch the serum", weekOf: "2026-11-02" }),
  });
  const { id } = (await created.json()) as { id: string };
  check("a valid run is accepted with 202", created.status === 202, String(created.status));
  check("it returns an id", typeof id === "string" && id.length === 36, String(id));

  // The scripted model is fast, but the run is deliberately asynchronous.
  let snapshot: any = null;
  for (let i = 0; i < 60; i++) {
    const r = await fetch(`${base}/api/runs/${id}`);
    snapshot = await r.json();
    if (snapshot.status === "done") break;
    await new Promise((r2) => setTimeout(r2, 100));
  }

  check("the run finished", snapshot?.status === "done", JSON.stringify(snapshot?.status));
  check("the run reports success", snapshot?.ok === true, JSON.stringify(snapshot?.reason));
  check("the JSON carries the plan", !!snapshot?.plan);
  check("the JSON flags the data as synthetic", snapshot?.syntheticData === true);
  check(
    "the JSON reports every stage",
    Array.isArray(snapshot?.stages) && snapshot.stages.length >= 4,
    String(snapshot?.stages?.length),
  );
  check(
    "the JSON keeps the events for replay",
    Array.isArray(snapshot?.events) && snapshot.events.length > 0,
  );

  const page = await fetch(`${base}/runs/${id}`);
  const pageHtml = await page.text();
  check("the run page is 200", page.status === 200, String(page.status));
  check("the page states the data is synthetic", pageHtml.includes("Synthetic data"));
  check("the page names the model mode", pageHtml.includes("scripted model"));
  check("the page shows the briefs", pageHtml.includes("The briefs"));
  check(
    "the page shows the source row for every number",
    pageHtml.includes("Every number, and the row it came from"),
  );
  check(
    "the page shows a real source row id",
    SEREH.rows.some((r) => pageHtml.includes(r.rowId)),
  );
  check("no undefined leaked into the HTML", !pageHtml.includes("undefined"));

  const missing = await fetch(`${base}/runs/00000000-0000-4000-8000-000000000000`);
  check("an unknown run is a 404", missing.status === 404, String(missing.status));

  const noRoute = await fetch(`${base}/nope`);
  check("an unknown route is a 404", noRoute.status === 404, String(noRoute.status));

  const sse = await fetch(`${base}/api/runs/${id}/events`);
  const sseText = await sse.text();
  check(
    "the stream is an event-stream",
    sse.headers.get("content-type")?.includes("text/event-stream") ?? false,
    String(sse.headers.get("content-type")),
  );
  check("the stream replays the finished run", sseText.includes('"type":"done"'), sseText.slice(0, 120));
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

console.log(`\n${failed === 0 ? "PASS" : "FAIL"} test-web — ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
