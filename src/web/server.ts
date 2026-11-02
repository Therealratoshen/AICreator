/**
 * The web app.
 *
 * `node:http`, no framework, no bundler, no dependencies - the same rule the
 * rest of the repo follows. The whole thing is four routes and an in-memory
 * map.
 *
 * WHY SERVER-SENT EVENTS AND NOT A POLL
 * -------------------------------------
 * A three-agent run spends most of its time waiting on a model, so the honest
 * UI is a progress log. SSE costs one `res.write` per event and needs no
 * dependency; polling would need a timer, a cursor, and a decision about how
 * often is often enough. The stream carries progress only - the finished plan
 * is rendered on the server and the page reloads to fetch it, so the plan a
 * reader sees is never reassembled in a browser.
 *
 * RUNS LIVE IN MEMORY AND DISAPPEAR ON RESTART
 * --------------------------------------------
 * That is deliberate for a demo and is stated on the page. Persisting them
 * would mean a database, which would mean a dependency, which would break the
 * one-command promise this repo is built on.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

import { runCampaign, type RunEvent } from "../agent/orchestrator.ts";
import { SEREH } from "./data.ts";
import { chooseModel } from "./model.ts";
import { renderIndex, renderRun, renderRunning, type RunView } from "./render.ts";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";

/** A cap on the brief, so a paste of a novel cannot exhaust memory. */
const MAX_BRIEF = 2000;
const MAX_BODY = 64 * 1024;

const runs = new Map<string, RunView>();
const subscribers = new Map<string, Set<ServerResponse>>();

function broadcast(id: string, event: RunEvent): void {
  const listeners = subscribers.get(id);
  if (!listeners) return;
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of listeners) {
    try {
      res.write(frame);
    } catch {
      listeners.delete(res);
    }
  }
}

function send(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function json(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

/** A 404 that looks like the rest of the app instead of like a crash. */
function notFoundPage(
  message: string,
  hint = "Runs are kept in memory, so restarting the server forgets them.",
): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not found</title>
<style>
  body{font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;
       max-width:36rem;margin:4rem auto;padding:0 1.25rem;color:#1c1b19;background:#fbfaf8}
  a{color:#1f5f4f}p{color:#6b6862}
  /* The rest of the app follows the system theme; this page used to stay
     white, so a dark-mode reader got a flash of light on every 404. */
  @media (prefers-color-scheme: dark){
    body{color:#ecece8;background:#16171a}
    a{color:#6fbfa4}p{color:#9a9a94}
  }
</style></head><body>
<h1 style="font-size:1.3rem">${message.replace(/[<>&"]/g, "")}</h1>
<p>${hint.replace(/[<>&"]/g, "")}</p>
<p><a href="/">Start a run</a></p></body></html>`;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error("the request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 2026-11-02 is a Monday; 2026-11-03 is not. Rejected before a model is asked. */
function isMonday(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`);
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) && !Number.isNaN(d.getTime()) && d.getUTCDay() === 1;
}

/**
 * Run the pipeline in the background.
 *
 * Deliberately not awaited by the request handler: the POST returns an id
 * immediately so the browser can open the event stream, and the work continues
 * after the response has closed.
 */
async function execute(run: RunView): Promise<void> {
  // The client is chosen here, not passed in, so there is one place that reads
  // the environment. The run's own `mode`/`modelLabel` were fixed at creation
  // and are what the page shows.
  const { client } = chooseModel(SEREH);

  try {
    const result = await runCampaign({
      client,
      dataset: SEREH,
      brief: run.brief,
      weekOf: run.weekOf,
      onEvent: (event) => {
        run.events.push(event);
        broadcast(run.id, event);
      },
    });
    run.result = result;
  } catch (e) {
    /**
     * A thrown error is not a plan. It is reported as a failed run with the
     * reason, which is the same shape as a run that exhausted its attempts -
     * so the page has one failure path, not two.
     */
    const message = e instanceof Error ? e.message : String(e);
    const event: RunEvent = { type: "done", ok: false, reason: `the run failed: ${message}` };
    run.events.push(event);
    broadcast(run.id, event);
    run.result = {
      ok: false,
      stages: [],
      warnings: [],
      degraded: false,
      reason: `the run failed before it could produce a plan: ${message}`,
    };
  } finally {
    run.status = "done";
    run.finishedAt = Date.now();
    const listeners = subscribers.get(run.id);
    if (listeners) {
      for (const res of listeners) {
        try {
          res.end();
        } catch {
          // the client is already gone
        }
      }
      subscribers.delete(run.id);
    }
  }
}

const server = createServer(async (req, res) => {  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  try {
    // ---------------------------------------------------------------- index
    if (req.method === "GET" && path === "/") {
      const all = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
      return send(res, 200, "text/html; charset=utf-8", renderIndex(all));
    }

    // ---------------------------------------------------------------- start a run
    if (req.method === "POST" && path === "/api/runs") {
      let body: unknown;
      try {
        body = await readJson(req);
      } catch (e) {
        return json(res, 400, { error: e instanceof Error ? e.message : "invalid JSON body" });
      }

      const { brief, weekOf } = (body ?? {}) as { brief?: unknown; weekOf?: unknown };

      if (typeof weekOf !== "string" || !isMonday(weekOf)) {
        return json(res, 400, {
          error: `weekOf must be a Monday in YYYY-MM-DD form - got ${JSON.stringify(weekOf)}`,
        });
      }
      if (brief !== undefined && typeof brief !== "string") {
        return json(res, 400, { error: "brief must be a string" });
      }
      if (typeof brief === "string" && brief.length > MAX_BRIEF) {
        return json(res, 400, { error: `brief must be under ${MAX_BRIEF} characters` });
      }
      /**
       * A brief is the input, not an optional extra.
       *
       * This used to accept an empty one and run anyway, which produced a
       * confident "Approved." plan for a brand who had asked for nothing - and
       * a row in the index reading "(no brief)" that could not be told apart
       * from the next one. If there is no ask, there is nothing to plan.
       */
      if (typeof brief !== "string" || brief.trim().length === 0) {
        return json(res, 400, {
          error: "brief is required - the plan is built from what the brand asks for",
        });
      }

      const choice = chooseModel(SEREH);
      const run: RunView = {
        id: randomUUID(),
        brief: (brief as string | undefined)?.trim() ?? "",
        weekOf,
        status: "running",
        mode: choice.mode,
        modelLabel: choice.label,
        events: [],
        startedAt: Date.now(),
      };
      runs.set(run.id, run);

      // Fire and forget: the response must return before the agents finish.
      void execute(run);

      return json(res, 202, { id: run.id });
    }

    // ---------------------------------------------------------------- the page for one run
    const pageMatch = path.match(/^\/runs\/([0-9a-f-]{36})$/);
    if (req.method === "GET" && pageMatch) {
      const run = runs.get(pageMatch[1]!);
      if (!run) return send(res, 404, "text/html; charset=utf-8", notFoundPage("No such run"));
      const html = run.status === "done" ? renderRun(run, SEREH) : renderRunning(run);
      return send(res, 200, "text/html; charset=utf-8", html);
    }

    // ---------------------------------------------------------------- the run as JSON
    const apiMatch = path.match(/^\/api\/runs\/([0-9a-f-]{36})$/);
    if (req.method === "GET" && apiMatch) {
      const run = runs.get(apiMatch[1]!);
      if (!run) return json(res, 404, { error: "no such run" });
      return json(res, 200, {
        id: run.id,
        status: run.status,
        mode: run.mode,
        model: run.modelLabel,
        weekOf: run.weekOf,
        brief: run.brief,
        ok: run.result?.ok ?? null,
        reason: run.result?.reason ?? null,
        degraded: run.result?.degraded ?? null,
        stages: run.result?.stages ?? [],
        warnings: run.result?.warnings ?? [],
        strategy: run.result?.strategy ?? null,
        plan: run.result?.plan ?? null,
        events: run.events,
        syntheticData: true,
      });
    }

    // ---------------------------------------------------------------- the stream
    const sseMatch = path.match(/^\/api\/runs\/([0-9a-f-]{36})\/events$/);
    if (req.method === "GET" && sseMatch) {
      const run = runs.get(sseMatch[1]!);
      if (!run) return json(res, 404, { error: "no such run" });

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      // Replay, so a client that connects late still sees the whole run.
      for (const event of run.events) res.write(`data: ${JSON.stringify(event)}\n\n`);

      if (run.status === "done") {
        res.end();
        return;
      }

      const set = subscribers.get(run.id) ?? new Set<ServerResponse>();
      set.add(res);
      subscribers.set(run.id, set);

      req.on("close", () => {
        set.delete(res);
        if (set.size === 0) subscribers.delete(run.id);
      });
      return;
    }

    // ---------------------------------------------------------------- 404
    return send(
      res,
      404,
      "text/html; charset=utf-8",
      notFoundPage(`No route for ${path}`, "That address is not one of this app's routes."),
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!res.headersSent) return json(res, 500, { error: message });
    res.end();
    return;
  }
});

/**
 * Exported so a test can drive the real routes.
 *
 * The server only listens when this file is the entry point. That is what lets
 * `test-web.ts` start it on an ephemeral port and make real HTTP requests,
 * instead of testing a second, simplified copy of the routing table that could
 * drift from this one.
 */
export { server };

const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  server.listen(PORT, HOST, () => {
    const choice = chooseModel(SEREH);
    console.log("");
    console.log(`  CreatorGuard AI  →  http://${HOST}:${PORT}`);
    console.log(`  the model:       ${choice.label}`);
    console.log(`  the data:        synthetic (Sereh, a skincare brand, ${SEREH.rows.length} rows)`);
    console.log("");
  });
}
