# AGENTS.md

You are working on **CreatorGuard AI** — a campaign copilot for Indonesian small
brands and independent creators. This file is the contract between the code and
whoever (or whatever) is changing it. Read it before you touch anything.

---

## What this project is

A brand's Instagram/Meta performance and a creator's audience signals go into
one prompt. The model returns a weekly campaign plan: a cadence, a creator
shortlist, a content brief per creator, and the metrics the plan rests on.

The model is **Muse Spark Open** (`meta-models/muse-spark-open`, via Baseten's
Model APIs), and the whole design exists because of one fact about it:

> "All except Muse Spark Open support structured outputs and JSON mode."
> "Muse Spark Open accepts `json_object` but doesn't constrain output to JSON.
> Ask for JSON in your prompt and validate the response in your application."

So the plan is produced by **tool calling**, every argument is **validated in
code**, and a rejection carries the exact reason back to the model.

Read [`docs/TECHNIQUE.md`](docs/TECHNIQUE.md) before changing the agent. It is
the design, and it is short.

---

## The invariants — do not break these

These are not style preferences. Each one exists because its absence produces a
specific, silent failure.

1. **Never store an unvalidated plan.** There is no branch in the code that
   writes a plan the validator did not accept. A run that exhausts its attempts
   returns **no plan at all**. Do not add a fallback, a default plan, a
   "best-effort" save, or a try/catch that swallows a validation failure.

2. **Never let a number exist without a row.** Every metric in a plan carries
   `sourceRowId`. The validator rejects a plan citing a row that does not exist;
   `no-fakes.ts` rejects a plan whose cited value **disagrees with the row's own
   value**. Do not add a code path that builds a plan without consulting the
   data layer.

3. **The validator stays pure.** `validateCampaignPlan()` takes the arguments
   and the set of existing row ids, and returns a verdict. No I/O, no model, no
   clock, no randomness. This is what makes it testable by mutating one field
   and asserting on the exact error. If you need data in the validator, pass it
   in.

4. **The rejection message is the API.** It goes back to the model verbatim, so
   it must name the field, the value it got, and the rule it broke. *"invalid
   output"* is a bug — the model cannot act on it.

5. **One exit.** The plan leaves through `submit_campaign_plan` and nothing
   else. A prose answer is rejected and the tool is demanded again.

6. **No secrets, ever.** Everything sensitive is read from the environment at
   runtime. `.env` is gitignored. The CI runs a secret scan on every push.

7. **A number in a sentence is still a number.** `no-fakes.ts` checks
   `citedMetrics`. It cannot see a figure written inside a hook, because it
   never reads the prose. `claims.ts` reads it: a statistic of 100 or more, or
   anything with a percentage, must trace to a cited row. A plan can cite one
   real row and state a different number in the copy, and every other guard
   will pass it — that is the gap this closes.

8. **The model may add a finding, never remove one.** The reviewer's verdict is
   computed as `anyDeterministicBlock || anyModelBlock`. A model that reads a
   plan containing a fabricated statistic and reports nothing wrong cannot
   approve it, because the code finding is already in the list. A third agent
   is only safe to have because of this asymmetry: judgement can make the
   review stricter, never more permissive.

### Not plan exits

Invariant 5 says the plan leaves through `submit_campaign_plan` and nothing
else. Two other tools exist and neither of them produces a plan:

| tool | who calls it | what it produces |
|---|---|---|
| `submit_campaign_strategy` | the planner | the week, cadence, creator shortlist and the justification for each pick |
| `submit_review` | the reviewer | findings about a plan that already exists |

A strategy is not a plan and a review is not a plan. The `CampaignPlan` object
that reaches a brand is produced by exactly one tool call, and then checked by
four gates before anything reads it.

---

## The commands

```bash
npm test             # 343 assertions across 10 files. MUST pass before you commit.
npm run demo         # the original single-agent loop, with the transcript
npm run demo:agents  # the three-agent pipeline: planner, writer, reviewer
npm start            # the web app on http://127.0.0.1:3000
npm run cost         # what one plan costs, from the published rates
```

Node 22.6+. No dependencies, no build step, no API key required. The tests run
on Node's own type-stripping loader — keep it that way; do not add a
toolchain, a bundler, or a `node_modules`.

`npm start` and `npm run demo:agents` both work with no key: without
`BASETEN_API_KEY` they use a scripted model that makes the mistakes a real one
makes, so the guards have something to catch. The app says which mode it is in
on screen. Never let it claim to be live when it is scripted.

---

## How to change something

1. **Read first.** `docs/TECHNIQUE.md` and `docs/ARCHITECTURE.md`. Then the
   relevant source.
2. **Write the failing test first.** The house style here is a *mutation* of a
   known-good plan: take the good plan, break exactly one field, assert the
   exact error. A test that does not fail when the code is wrong is worse than
   no test — it is a false guarantee.
3. **Make it fail. Then make it pass.** Watch the test fail for the right
   reason before you fix the code. A test that passes without the fix is
   testing nothing.
4. **Run the whole suite.** `npm test`. Then `npm run demo` — the demo is the
   thing a reader sees first.
5. **Commit.** Small, one concern, and the message says *why*.

---

## The style of this codebase

- **Comments explain the reason, not the mechanics.** A comment that restates
  the line below it is noise. A comment that explains *why* it is written that
  way is the most valuable thing in the file.
- **The error text is load-bearing.** It is read by a model and by a person.
  Name the field. Give the rule. Give the value that broke it.
- **Pure functions where it matters.** Anything that decides should be
  testable without a network, a clock, or a model.
- **No dependencies.** The whole point is that a stranger can clone it and run
  it in a second.

---

## Things that are easy to get wrong

- **`logprobs` is accepted and ignored** on this model. Confidence is not
  available, so verification must be structural — a row id — not statistical.
- **Neither `seed` nor `temperature: 0` guarantees reproducibility.** The
  output is never trusted for being repeatable; it is trusted only for passing
  the validator. **The guard is deterministic, not the model.**
- **Reasoning is always on** and cannot be turned off, so validation happens
  *after* the thinking, not instead of it.
- **`n > 1` returns HTTP 400.** One plan per request.
- **The model never invents a row id that exists by accident** — but it will
  invent one that does not. That is the entire reason `supportedMetricIds` is
  passed into the validator.

---

## What is here

| | |
|---|---|
| the schema and validator | `src/agent/campaign-plan.ts` |
| the loop | `src/agent/copilot.ts` (single agent), `src/agent/tool-loop.ts` (generalised) |
| the guard | `src/agent/no-fakes.ts` |
| the claim scanner | `src/agent/claims.ts` |
| agent 1 — the planner | `src/agent/planner.ts` + `src/agent/strategy.ts` |
| agent 2 — the writer | `src/agent/writer.ts` |
| agent 3 — the reviewer | `src/agent/reviewer.ts` |
| the single flow | `src/agent/orchestrator.ts` |
| the web app | `src/web/` |

The three agents run in one order, and the order is only written down in
`orchestrator.ts`:

```
planner ──▶ strategy ──▶ writer ──▶ plan ──▶ reviewer
              │                        ▲          │
              │                        └─ revise ─┘
              └─▶ no strategy: stop, no plan
```

## What is NOT here yet

Being precise, so nobody builds the wrong thing:

- the WhatsApp/Messenger delivery adapter
- the Muse Image variant generation (it consumes the validated plan)
- the creator's mirror-image agent (explain your numbers, draft in your voice)
- the wiring into the live marketplace, where the real rows are

The public repository holds the **core** and the **flow**: the schema, the
validator, the loop, the guard, the three agents, the web app, and the tests.
The data the web app runs on is synthetic and labelled as such. The product it
extends is [justnewme.com](https://justnewme.com).

---

## If you are an autonomous agent

You are expected to **verify your own work** before claiming it is done.

- Run the tests. Read the output. Do not trust an exit code you did not see.
- If you change the validator, mutate the good plan in your test and confirm
  the mutation lands on disk before you trust the exit code.
- If you change the schema, re-read `docs/TECHNIQUE.md` — it describes the
  design you are about to change, and it may now be wrong. Update it in the
  same change.
- If a number appears anywhere in your output — a cost, a count, a rate — it
  must come from a measurement you took. Do not estimate, and do not round up
  to look better.
- Never mark something done that you have not seen succeed. "It should work"
  is not a result.
