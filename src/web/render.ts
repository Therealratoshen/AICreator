/**
 * The HTML.
 *
 * Server-rendered, from template strings, with no build step and no client
 * framework - the same constraint as the rest of the repo. The only JavaScript
 * on the page is the progress stream, and it does exactly one thing: append a
 * line, then reload when the run is done. The result itself is rendered here,
 * on the server, so what a reader sees is the object the guards approved and
 * not a re-derivation of it in a browser.
 *
 * TWO THINGS THE PAGE MUST NEVER DO
 * ---------------------------------
 * 1. Present the synthetic data as real. `SYNTHETIC_NOTICE` is rendered above
 *    the numbers, in the same visual weight as the plan.
 * 2. Present a failed run as a quiet empty state. A run that produced no plan
 *    gets a full-width statement of that fact and the reasons - because the
 *    reasons are the product, and a blank page would read as a bug.
 */

import type { CampaignPlan } from "../agent/campaign-plan.ts";
import type { CampaignStrategy } from "../agent/strategy.ts";
import type { RunEvent, RunResult, StageRecord } from "../agent/orchestrator.ts";
import type { ModelMode } from "./model.ts";
import { SYNTHETIC_NOTICE } from "./data.ts";

/** Everything the page needs to know about one run. */
export type RunView = {
  id: string;
  brief: string;
  weekOf: string;
  status: "running" | "done";
  mode: ModelMode;
  modelLabel: string;
  events: RunEvent[];
  result?: RunResult;
  startedAt: number;
  finishedAt?: number;
};

const STYLE = `
  :root {
    --bg: #fbfaf8; --panel: #ffffff; --ink: #1c1b19; --muted: #6b6862;
    --line: #e3e0da; --accent: #1f5f4f; --block: #a3341f; --warn: #8a5a12;
    --ok: #1f5f4f; --code: #f2efea;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16171a; --panel: #1d1f23; --ink: #ecece8; --muted: #9a9a94;
      --line: #2c2f35; --accent: #6fbfa4; --block: #e0846c; --warn: #d9ab5c;
      --ok: #6fbfa4; --code: #24262b;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 16px/1.6 ui-sans-serif, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  main { max-width: 60rem; margin: 0 auto; padding: 3rem 1.25rem 6rem; }
  h1 { font-size: 1.5rem; margin: 0 0 .25rem; letter-spacing: -.01em; }
  h2 { font-size: 1.05rem; margin: 2.5rem 0 .75rem; letter-spacing: -.005em; }
  h3 { font-size: .95rem; margin: 1.5rem 0 .5rem; color: var(--muted); font-weight: 600;
       text-transform: uppercase; letter-spacing: .06em; }
  p { margin: .6rem 0; }
  .sub { color: var(--muted); margin: 0 0 2rem; }
  .notice {
    border: 1px solid var(--line); border-left: 3px solid var(--warn);
    background: var(--panel); padding: .85rem 1rem; border-radius: 4px;
    font-size: .9rem; color: var(--muted); margin: 0 0 2rem;
  }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px;
           padding: 1.25rem; }
  .panel + .panel { margin-top: 1rem; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .86em; }
  code { background: var(--code); padding: .1rem .3rem; border-radius: 3px; }
  table { width: 100%; border-collapse: collapse; font-size: .9rem; }
  th, td { text-align: left; padding: .5rem .6rem; border-bottom: 1px solid var(--line);
           vertical-align: top; }
  th { color: var(--muted); font-weight: 600; font-size: .78rem; text-transform: uppercase;
       letter-spacing: .05em; }
  tr:last-child td { border-bottom: 0; }
  .pill { display: inline-block; font-size: .75rem; padding: .1rem .45rem; border-radius: 999px;
          border: 1px solid var(--line); color: var(--muted); }
  .ok { color: var(--ok); } .block { color: var(--block); } .warn { color: var(--warn); }
  .err { font-size: .85rem; color: var(--block); margin: .25rem 0 0; }
  .wrn { font-size: .85rem; color: var(--warn); margin: .25rem 0 0; }
  .rej { font-size: .85rem; color: var(--muted); margin: .25rem 0 0; }
  form { display: flex; gap: .75rem; flex-wrap: wrap; align-items: flex-end; }
  label { display: block; font-size: .8rem; color: var(--muted); margin-bottom: .3rem; }
  input, textarea, select {
    font: inherit; font-size: .95rem; padding: .55rem .7rem; border-radius: 4px;
    border: 1px solid var(--line); background: var(--panel); color: var(--ink); width: 100%;
  }
  textarea { min-height: 5rem; resize: vertical; }
  .field { flex: 1 1 14rem; }
  button {
    font: inherit; font-size: .95rem; padding: .6rem 1.1rem; border-radius: 4px; cursor: pointer;
    border: 1px solid var(--accent); background: var(--accent); color: #fff; font-weight: 600;
  }
  button:disabled { opacity: .55; cursor: default; }
  .brief { border-top: 1px solid var(--line); padding: 1rem 0; }
  .brief:first-of-type { border-top: 0; padding-top: 0; }
  .hook { font-size: 1.02rem; margin: .4rem 0; }
  .meta { color: var(--muted); font-size: .85rem; }
  .log { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .84rem;
         background: var(--code); border-radius: 4px; padding: .85rem 1rem; white-space: pre-wrap;
         max-height: 24rem; overflow: auto; margin: 0; }
  .fail { border-left: 3px solid var(--block); }
  a { color: var(--accent); }
  .runs li { margin: .3rem 0; font-size: .9rem; }
  .runs ul { padding-left: 1.1rem; margin: .4rem 0 0; }
`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function shell(title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
${head}
</head>
<body><main>
${body}
</main></body></html>`;
}

function modeBadge(mode: ModelMode, label: string): string {
  const cls = mode === "live" ? "ok" : "warn";
  return `<span class="pill ${cls}">${escapeHtml(mode)} model</span> <span class="meta">${escapeHtml(label)}</span>`;
}

/** The index: the form, and the runs already made in this process. */
export function renderIndex(runs: RunView[]): string {
  const list =
    runs.length === 0
      ? `<p class="meta">No runs yet in this process. Runs are kept in memory and disappear on restart.</p>`
      : `<ul>${runs
          .map(
            (r) =>
              `<li><a href="/runs/${escapeHtml(r.id)}">${escapeHtml(r.brief.slice(0, 60) || "(no brief)")}</a>
               <span class="meta"> — week of ${escapeHtml(r.weekOf)}, ${
                 r.status === "done"
                   ? r.result?.ok
                     ? `<span class="ok">approved</span>`
                     : `<span class="block">not published</span>`
                   : "running"
               }</span></li>`,
          )
          .join("")}</ul>`;

  return shell(
    "CreatorGuard AI",
    `
<h1>CreatorGuard AI</h1>
<p class="sub">A weekly campaign plan from the numbers both sides already have. Three agents, and a
guard that will not let a number through without a row behind it.</p>

<div class="notice">${escapeHtml(SYNTHETIC_NOTICE)}</div>

<div class="panel">
  <form id="f">
    <div class="field" style="flex:1 1 100%">
      <label for="brief">What does the brand want this week?</label>
      <textarea id="brief" name="brief">launch the serum, and show it fitting into a routine people already have</textarea>
    </div>
    <div class="field">
      <label for="weekOf">The Monday the plan starts</label>
      <input id="weekOf" name="weekOf" value="2026-11-02">
    </div>
    <div class="field" style="flex:0 0 auto">
      <button id="go" type="submit">Run the three agents</button>
    </div>
  </form>
  <p class="meta" id="hint" style="margin-bottom:0">
    No API key needed. Without <code>BASETEN_API_KEY</code> the agents run against a scripted
    model that makes the mistakes a real one makes, so the guards have something to catch.
  </p>
</div>

<h2>Runs</h2>
<div class="panel runs">${list}</div>
`,
    `<script>
      const f = document.getElementById('f');
      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        const go = document.getElementById('go');
        go.disabled = true;
        go.textContent = 'Starting…';
        try {
          const res = await fetch('/api/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              brief: document.getElementById('brief').value,
              weekOf: document.getElementById('weekOf').value,
            }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'could not start the run');
          location.href = '/runs/' + data.id;
        } catch (err) {
          go.disabled = false;
          go.textContent = 'Run the three agents';
          document.getElementById('hint').textContent = String(err.message || err);
        }
      });
    </script>`,
  );
}

function stageRows(stages: StageRecord[]): string {
  return stages
    .map((s) => {
      const status = s.ok
        ? `<span class="ok">passed</span>`
        : `<span class="block">rejected</span>`;
      const errors = s.errors.map((e) => `<div class="err">✗ ${escapeHtml(e)}</div>`).join("");
      /**
       * The rejections this stage absorbed before it succeeded. Shown because
       * "passed in 2 calls" and "passed in 1 call" are very different runs, and
       * only one of them demonstrates the guard doing its job.
       */
      const rej = (s.rejections ?? [])
        .map((e) => `<div class="rej">↺ rejected, then corrected: ${escapeHtml(e)}</div>`)
        .join("");
      const warns = s.warnings.map((w) => `<div class="wrn">! ${escapeHtml(w)}</div>`).join("");
      return `<tr>
        <td class="mono">${escapeHtml(s.stage)}</td>
        <td>${s.attempt}</td>
        <td>${status}</td>
        <td>${s.modelCalls}</td>
        <td>${errors}${rej}${warns}${
          !s.ok && s.errors.length === 0 ? `<div class="err">no reason recorded</div>` : ""
        }</td>
      </tr>`;
    })
    .join("");
}

function planHtml(plan: CampaignPlan, strategy?: CampaignStrategy): string {
  const briefs = plan.contentBriefs
    .map(
      (b) => `<div class="brief">
        <div class="meta">${escapeHtml(b.creatorId)} · ${b.imageCount} image(s)</div>
        <div class="hook">“${escapeHtml(b.hook)}”</div>
        <p class="meta" style="margin:.2rem 0"><strong>Objective</strong> ${escapeHtml(b.objective)}</p>
        <p class="meta" style="margin:.2rem 0"><strong>Call to action</strong> ${escapeHtml(b.cta)}</p>
      </div>`,
    )
    .join("");

  const shortlist = plan.creatorShortlist
    .map(
      (c) => `<tr>
        <td class="mono">${escapeHtml(c.creatorId)}</td>
        <td>${escapeHtml(c.reason)}</td>
        <td class="mono">${c.justifyingMetric}</td>
      </tr>`,
    )
    .join("");

  const cited = plan.citedMetrics
    .map(
      (m) => `<tr>
        <td class="mono">${escapeHtml(m.metric)}</td>
        <td class="mono">${m.value}</td>
        <td class="mono">${escapeHtml(m.sourceRowId)}</td>
      </tr>`,
    )
    .join("");

  const constraints =
    strategy && strategy.constraints.length > 0
      ? `<h3>What the writer was told not to do</h3>
         <ul class="meta">${strategy.constraints.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`
      : "";

  return `
<div class="panel">
  <h3 style="margin-top:0">The week</h3>
  <p><strong>${escapeHtml(plan.weekOf)}</strong> · ${plan.cadencePerWeek} post(s) per creator
     ${strategy ? `· angle: ${escapeHtml(strategy.angle)}` : ""}</p>
  ${constraints}
</div>

<div class="panel">
  <h3 style="margin-top:0">The briefs</h3>
  ${briefs}
</div>

<div class="panel">
  <h3 style="margin-top:0">The shortlist, and the number behind each pick</h3>
  <table><thead><tr><th>creator</th><th>why</th><th>number</th></tr></thead>
  <tbody>${shortlist}</tbody></table>
</div>

<div class="panel">
  <h3 style="margin-top:0">Every number, and the row it came from</h3>
  <table><thead><tr><th>metric</th><th>value</th><th>source row</th></tr></thead>
  <tbody>${cited}</tbody></table>
  <p class="meta" style="margin-bottom:0">A plan that cites a row which does not exist, or a value
  that disagrees with the row, is rejected before it reaches this page.</p>
</div>

<div class="panel">
  <h3 style="margin-top:0">The note to the brand</h3>
  <p style="margin-bottom:0">${escapeHtml(plan.notes)}</p>
</div>`;
}

/** The finished run: the plan, or a full statement of why there isn't one. */
export function renderRun(run: RunView): string {
  const r = run.result;
  const header = `
<h1>${r?.ok ? "A campaign plan" : "No plan was published"}</h1>
<p class="sub">week of ${escapeHtml(run.weekOf)} · ${modeBadge(run.mode, run.modelLabel)}</p>
<div class="notice">${escapeHtml(SYNTHETIC_NOTICE)}</div>`;

  if (!r) {
    return shell("CreatorGuard AI — running", header + `<div class="panel">The run has no result yet.</div>`);
  }

  const outcome = r.ok
    ? `<div class="panel"><p style="margin:0"><span class="ok"><strong>Approved.</strong></span>
         ${escapeHtml(r.reason ?? "")}</p>
         ${
           r.degraded
             ? `<p class="wrn" style="margin-bottom:0">The judgement pass did not complete, so no
                model read this plan. Every code check passed.</p>`
             : ""
         }</div>`
    : `<div class="panel fail">
         <p style="margin:0 0 .5rem"><span class="block"><strong>Not published.</strong></span>
         ${escapeHtml(r.reason ?? "")}</p>
         <p class="meta" style="margin:0">No partial plan is stored. There is no fallback and no
         last-good attempt - if it could not be made right, it does not ship.</p>
       </div>`;

  const warnings =
    r.warnings.length > 0
      ? `<h2>Shown to the brand, but not blocking</h2>
         <div class="panel">${r.warnings.map((w) => `<div class="wrn">! ${escapeHtml(w)}</div>`).join("")}</div>`
      : "";

  const strategyBlock = r.strategy
    ? `<div class="panel">
         <h3 style="margin-top:0">The planner's strategy</h3>
         <p class="meta" style="margin:0">${escapeHtml(r.strategy.angle)}</p>
       </div>`
    : "";

  return shell(
    r.ok ? "CreatorGuard AI — the plan" : "CreatorGuard AI — not published",
    `${header}
     ${outcome}
     <h2>What each agent did</h2>
     <div class="panel">
       <table>
         <thead><tr><th>agent</th><th>attempt</th><th>outcome</th><th>model calls</th><th>why</th></tr></thead>
         <tbody>${stageRows(r.stages)}</tbody>
       </table>
     </div>
     ${r.plan ? `<h2>The plan</h2>${planHtml(r.plan, r.strategy)}` : ""}
     ${warnings}
     ${strategyBlock}
     <p class="meta" style="margin-top:2.5rem"><a href="/">Run another week</a></p>`,
  );
}

/**
 * The page shown while the agents are working.
 *
 * The stream appends one line per event and reloads on `done`. Rendering the
 * result in the browser would mean a second implementation of the plan view
 * that could disagree with the server's - and the server's is the one the
 * guards approved.
 */
export function renderRunning(run: RunView): string {
  return shell(
    "CreatorGuard AI — working",
    `
<h1>Working…</h1>
<p class="sub">week of ${escapeHtml(run.weekOf)} · ${modeBadge(run.mode, run.modelLabel)}</p>
<div class="notice">${escapeHtml(SYNTHETIC_NOTICE)}</div>
<div class="panel">
  <h3 style="margin-top:0">The agents</h3>
  <pre class="log" id="log"></pre>
</div>
<p class="meta" id="note">The page reloads when the run finishes.</p>
`,
    `<script>
      const log = document.getElementById('log');
      const note = document.getElementById('note');
      const add = (line) => { log.textContent += line + "\\n"; log.scrollTop = log.scrollHeight; };
      const es = new EventSource('/api/runs/${encodeURIComponent(run.id)}/events');
      es.onmessage = (e) => {
        let ev;
        try { ev = JSON.parse(e.data); } catch { return; }
        if (ev.type === 'stage_start') add('  ' + ev.stage + ' — starting (attempt ' + ev.attempt + ')');
        else if (ev.type === 'stage_ok') add('  ' + ev.stage + ' — ok: ' + ev.detail);
        else if (ev.type === 'stage_failed') {
          add('  ' + ev.stage + ' — rejected');
          for (const err of (ev.errors || [])) add('      ✗ ' + err);
        } else if (ev.type === 'revision') {
          add('  → sending the plan back to the writer');
        } else if (ev.type === 'done') {
          add('  ' + (ev.ok ? 'done — approved' : 'done — not published'));
          es.close();
          note.textContent = 'Reloading…';
          setTimeout(() => location.reload(), 350);
        }
      };
      es.onerror = () => { note.textContent = 'The stream dropped. Reload to see the result.'; };
    </script>`,
  );
}

export { escapeHtml };
