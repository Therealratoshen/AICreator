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
import type { BrandDataset } from "../agent/dataset.ts";
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
  /**
   * A table wider than the phone it is on.
   *
   * width:100% does not stop a cell from being wider than its share: with five
   * columns and a paragraph in the last one, the cells push past the table box
   * and the whole document scrolls sideways. On a 500px viewport that put 19
   * elements past the right edge and cut the rejection reasons - the reason
   * this page exists - off the screen.
   *
   * So every table gets a scroll container. The page stops scrolling sideways
   * and the table scrolls inside its own panel instead.
   */
  .scroll { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  .scroll table { min-width: 26rem; }
  /**
   * Below a phone's width, the five-column agents table stops being a table.
   *
   * Scrolling it sideways technically keeps the text reachable, but the "why"
   * column is where the rejection reasons live - the whole point of the page -
   * and asking someone to swipe a panel to read the sentence they came for is
   * not good enough. Each row becomes a labelled block instead.
   */
  @media (max-width: 34rem) {
    .stack thead { display: none; }
    .stack, .stack tbody, .stack tr, .stack td { display: block; width: auto; }
    .stack tr { border-bottom: 1px solid var(--line); padding: .6rem 0; }
    .stack tr:last-child { border-bottom: 0; }
    .stack td { border: 0; padding: .12rem .1rem; }
    .stack td[data-label]::before {
      content: attr(data-label) ": "; color: var(--muted); font-size: .7rem;
      text-transform: uppercase; letter-spacing: .06em;
      display: inline-block; min-width: 7rem;
    }
    .stack td[data-label="why"]::before { display: block; margin-top: .35rem; min-width: 0; }
    /* A stage that passed with nothing to explain should not print an empty
       "why" heading over blank space. */
    .stack td[data-label="why"]:empty { display: none; }
    .scroll .stack { min-width: 0; }
  }
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

/**
 * The document shell.
 *
 * The script goes at the END of the body, not in the head.
 *
 * It used to be interpolated into `<head>`, which meant it ran before the form
 * existed: `document.getElementById('f')` returned null, `addEventListener`
 * threw, and the submit handler was never attached. The button then fell back
 * to a native form submission - a GET to the same URL with the fields in the
 * query string - which reloads the page and starts nothing.
 *
 * No test caught it because every test drove `/api/runs` with `fetch` and never
 * clicked the button. The journey a person actually takes was the one path
 * nothing exercised.
 */
function shell(title: string, body: string, script = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>
${body}
</main>
${script}
</body></html>`;
}

/**
 * The model mode, as a badge plus the detail behind it.
 *
 * The pill already says "scripted model", and the label from `chooseModel` is
 * "scripted model (no BASETEN_API_KEY set)" - printing both read
 * "scripted model scripted model (no BASETEN_API_KEY set)". The label's job is
 * the *reason*, so the part the pill already said is dropped.
 */
function modeBadge(mode: ModelMode, label: string): string {
  const cls = mode === "live" ? "ok" : "warn";
  const detail = label.replace(/^(scripted|live)\s+model\s*/i, "").trim();
  return `<span class="pill ${cls}">${escapeHtml(mode)} model</span>${
    detail ? ` <span class="meta">${escapeHtml(detail)}</span>` : ""
  }`;
}

/**
 * The next Monday, as YYYY-MM-DD.
 *
 * The form used to ship a hardcoded `2026-11-02`. A default date that is right
 * only during one week is a bug that waits: open the app later and it asks the
 * planner for a week that has already happened.
 */
function nextMonday(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() + (day === 1 ? 0 : (8 - day) % 7));
  return d.toISOString().slice(0, 10);
}

/** The index: the form, and the runs already made in this process. */
export function renderIndex(runs: RunView[]): string {
  const list =
    runs.length === 0
      ? `<p class="meta">No runs yet in this process. Runs are kept in memory and disappear on restart.</p>`
      : `<ul>${runs
          .map((r) => {
            // Truncated without an ellipsis, a long brief looks like it ends
            // mid-word rather than like it was cut.
            const short = r.brief.length > 60 ? `${r.brief.slice(0, 60).trimEnd()}…` : r.brief;
            return `<li><a href="/runs/${escapeHtml(r.id)}">${escapeHtml(short || "(no brief)")}</a>
               <span class="meta"> — week of ${escapeHtml(r.weekOf)}, ${
                 r.status === "done"
                   ? r.result?.ok
                     ? `<span class="ok">approved</span>`
                     : `<span class="block">not published</span>`
                   : "running"
               }</span></li>`;
          })
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
      <textarea id="brief" name="brief" required maxlength="2000">launch the serum, and show it fitting into a routine people already have</textarea>
    </div>
    <div class="field">
      <label for="weekOf">The Monday the plan starts</label>
      <input id="weekOf" name="weekOf" type="date" value="${nextMonday()}" required>
    </div>
    <div class="field" style="flex:0 0 auto">
      <button id="go" type="submit">Run the three agents</button>
    </div>
  </form>
  <p class="meta" id="hint" style="margin-bottom:0">
    No API key needed. Without <code>BASETEN_API_KEY</code> the agents run against a scripted
    model that makes the mistakes a real one makes, so the guards have something to catch.
  </p>
  <p class="meta err" id="formError" role="alert" hidden style="margin-bottom:0"></p>
</div>

<h2>Runs</h2>
<div class="panel runs">${list}</div>
`,
    `<script>
      const f = document.getElementById('f');
      const box = document.getElementById('formError');
      const fail = (msg) => { box.textContent = msg; box.hidden = false; };

      f.addEventListener('submit', async (e) => {
        e.preventDefault();
        box.hidden = true;
        const go = document.getElementById('go');
        const weekOf = document.getElementById('weekOf').value;
        const brief = document.getElementById('brief').value;

        // The server owns this rule; checking it here too just means the brand
        // finds out before the round trip instead of after it.
        if (!brief.trim()) return fail('Say what the brand wants this week - the plan is built from it.');
        if (weekOf && new Date(weekOf + 'T00:00:00Z').getUTCDay() !== 1) {
          return fail('Pick a Monday. The week the plan covers starts on one.');
        }

        go.disabled = true;
        go.textContent = 'Starting…';
        try {
          const res = await fetch('/api/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ brief, weekOf }),
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'could not start the run');
          location.href = '/runs/' + data.id;
        } catch (err) {
          go.disabled = false;
          go.textContent = 'Run the three agents';
          fail(String(err.message || err));
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
      /**
       * `data-label` is the column heading, repeated on the cell.
       *
       * On a narrow screen this table stops being a table and becomes one block
       * per stage (see the `.stack` rules). The heading has to travel with the
       * value, or a stacked cell reads as an unlabelled paragraph. It also
       * keeps the label available to a screen reader once the `thead` is
       * hidden.
       */
      return `<tr>
        <td class="mono" data-label="agent">${escapeHtml(s.stage)}</td>
        <td data-label="attempt">${s.attempt}</td>
        <td data-label="outcome">${status}</td>
        <td data-label="model calls">${s.modelCalls}</td>
        <td data-label="why">${errors}${rej}${warns}${
          !s.ok && s.errors.length === 0 ? `<div class="err">no reason recorded</div>` : ""
        }</td>
      </tr>`;
    })
    .join("");
}

/**
 * How a creator is named on the page.
 *
 * `kol_citra` is a database key. The brand knows the person as `@citra.kulit`,
 * and the handle was in the dataset the whole time. Both are shown - the handle
 * because that is who it is, the id because that is what the plan validated
 * against - but the handle leads.
 */
function creatorCell(creatorId: string, dataset?: BrandDataset): string {
  const c = dataset?.creators.find((x) => x.creatorId === creatorId);
  if (!c) return `<span class="mono">${escapeHtml(creatorId)}</span>`;
  return `<span>${escapeHtml(c.handle)}</span><div class="meta mono">${escapeHtml(creatorId)}</div>`;
}

/** The human name for a metric, from the row that holds it. */
function metricCell(metric: string, sourceRowId: string, dataset?: BrandDataset): string {
  const row = dataset?.rows.find((r) => r.rowId === sourceRowId);
  if (!row?.label) return `<span class="mono">${escapeHtml(metric)}</span>`;
  return `<span>${escapeHtml(row.label)}</span><div class="meta mono">${escapeHtml(metric)}</div>`;
}

function planHtml(plan: CampaignPlan, strategy?: CampaignStrategy, dataset?: BrandDataset): string {
  const briefs = plan.contentBriefs
    .map(
      (b) => `<div class="brief">
        <div class="meta">${creatorCell(b.creatorId, dataset)} · ${b.imageCount} image(s)</div>
        <div class="hook">“${escapeHtml(b.hook)}”</div>
        <p class="meta" style="margin:.2rem 0"><strong>Objective</strong> ${escapeHtml(b.objective)}</p>
        <p class="meta" style="margin:.2rem 0"><strong>Call to action</strong> ${escapeHtml(b.cta)}</p>
      </div>`,
    )
    .join("");

  const shortlist = plan.creatorShortlist
    .map(
      (c) => `<tr>
        <td>${creatorCell(c.creatorId, dataset)}</td>
        <td>${escapeHtml(c.reason)}</td>
        <td class="mono">${c.justifyingMetric}</td>
      </tr>`,
    )
    .join("");

  const cited = plan.citedMetrics
    .map(
      (m) => `<tr>
        <td>${metricCell(m.metric, m.sourceRowId, dataset)}</td>
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
  <div class="scroll"><table><thead><tr><th>creator</th><th>why</th><th>number</th></tr></thead>
  <tbody>${shortlist}</tbody></table></div>
</div>

<div class="panel">
  <h3 style="margin-top:0">Every number, and the row it came from</h3>
  <div class="scroll"><table><thead><tr><th>metric</th><th>value</th><th>source row</th></tr></thead>
  <tbody>${cited}</tbody></table></div>
  <p class="meta" style="margin-bottom:0">A plan that cites a row which does not exist, or a value
  that disagrees with the row, is rejected before it reaches this page.</p>
</div>

<div class="panel">
  <h3 style="margin-top:0">The note to the brand</h3>
  <p style="margin-bottom:0">${escapeHtml(plan.notes)}</p>
</div>`;
}

/** The finished run: the plan, or a full statement of why there isn't one. */
export function renderRun(run: RunView, dataset?: BrandDataset): string {
  const r = run.result;
  const header = `
<h1>${r?.ok ? "A campaign plan" : "No plan was published"}</h1>
<p class="sub">week of ${escapeHtml(run.weekOf)} · ${modeBadge(run.mode, run.modelLabel)}</p>
<div class="notice">${escapeHtml(SYNTHETIC_NOTICE)}</div>
<div class="panel">
  <h3 style="margin-top:0">What the brand asked for</h3>
  <p style="margin-bottom:0">${
    run.brief ? escapeHtml(run.brief) : `<span class="meta">No brief was given.</span>`
  }</p>
</div>`;

  if (!r) {
    return shell("CreatorGuard AI — running", header + `<div class="panel">The run has no result yet.</div>`);
  }

  /**
   * The reason, minus the part the heading already says.
   *
   * A successful run's reason is the literal string "approved", so the panel
   * read "Approved. approved". A failed run's reason is a full sentence and is
   * the most useful thing on the page, so it is kept.
   */
  const reason = /^approved$/i.test(r.reason ?? "") ? "" : escapeHtml(r.reason ?? "");

  const outcome = r.ok
    ? `<div class="panel"><p style="margin:0"><span class="ok"><strong>Approved.</strong></span>
         ${reason}</p>
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

  /**
   * The strategy, shown on its own only when there is no plan to carry it.
   *
   * `planHtml` already prints the angle and the constraints, so rendering this
   * underneath a successful plan repeated both. After a failure it is the only
   * record of what the planner decided, and it stays.
   */
  const strategyBlock =
    r.strategy && !r.plan
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
       <div class="scroll"><table class="stack">
         <thead><tr><th>agent</th><th>attempt</th><th>outcome</th><th>model calls</th><th>why</th></tr></thead>
         <tbody>${stageRows(r.stages)}</tbody>
       </table></div>
     </div>
     ${r.plan ? `<h2>The plan</h2>${planHtml(r.plan, r.strategy, dataset)}` : ""}
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
  <pre class="log" id="log" aria-live="polite">  connecting to the run…</pre>
</div>
<p class="meta" id="note">The page reloads when the run finishes.</p>
`,
    `<script>
      const log = document.getElementById('log');
      const note = document.getElementById('note');
      /**
       * The log is never empty.
       *
       * It used to render as a blank dark bar until the first event arrived -
       * indistinguishable from a broken page, and the run can take a while to
       * produce that first event. The placeholder is cleared by the first real
       * line, so it cannot be mistaken for output.
       */
      let placeholder = true;
      const add = (line) => {
        if (placeholder) { log.textContent = ''; placeholder = false; }
        log.textContent += line + "\\n";
        log.scrollTop = log.scrollHeight;
      };
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
