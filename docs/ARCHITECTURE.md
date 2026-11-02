# Architecture

## The pipeline

```
  ┌─────────────────────────┐
  │  the brand's account    │
  │  Meta Graph API v18.0   │   instagram_basic
  │  + Instagram Platform   │   instagram_manage_insights
  │                         │   pages_show_list
  │                         │   pages_read_engagement
  └───────────┬─────────────┘
              │  media insights: view_count, like_count, comments_count
              │
  ┌───────────┴─────────────┐
  │  the creator's profile  │   follower/engagement snapshots
  │  + audience snapshots   │   per-window medians
  └───────────┬─────────────┘
              │
              ▼
  ┌────────────────────────────────────────────────────┐
  │  Muse Spark Open  (meta-models/muse-spark-open)    │
  │  1,048,576-token context (1M) · multimodal            │
  │  reasoning always on · vision · temperature, top_p, │
  │  top_k, stop, presence_penalty, frequency_penalty   │
  │                                                    │
  │  ⚠ NO structured outputs. NO JSON mode enforcement. │
  └───────────┬────────────────────────────────────────┘
              │  the ONLY exit: a submit_campaign_plan tool call
              ▼
  ┌────────────────────────────────────────────────────┐
  │  validateCampaignPlan()   ← pure, deterministic     │
  │  · the shape                                              │
  │  · the Monday rule                                       │
  │  · every sourceRowId must exist                        │
  └───────────┬────────────────────────────────────────┘
              │
      ok ─────┴───── not ok
       │                │
       │                └──▶ rejectionFeedback() ──▶ back to the model
       │                     (the exact field, the exact reason)
       ▼
  ┌────────────────────────────────────────────────────┐
  │  checkNoFakes()                                    │
  │  · every cited value equals the row's own value    │
  │  · every justification traces to a real row         │
  └───────────┬────────────────────────────────────────┘
              ▼
        the plan → Muse Image variants → WhatsApp / Messenger
```

## The three agents

The pipeline above is the *core*. On top of it sits one orchestrated flow with
three agents, because deciding, writing and checking are three different jobs
with three different failure modes — and one agent asked to do all three has no
way to be told "the strategy is fine, the wording is not".

```
  ┌──────────────┐   CampaignStrategy   ┌──────────────┐
  │   PLANNER    │ ───────────────────▶ │    WRITER    │
  │              │  week · cadence ·    │              │
  │ decides only │  creators · angle ·  │ writes only  │
  │              │  constraints         │              │
  └──────────────┘                      └──────┬───────┘
                                               │ submit_campaign_plan
                                               │ (the only plan exit)
                                               ▼
                                    ┌─────────────────────┐
                                    │  4 gates, in code   │
                                    │  validateCampaignPlan│
                                    │  checkNoFakes        │
                                    │  conformance         │
                                    │  claim scan          │
                                    └──────────┬──────────┘
                                               │
                                               ▼
  ┌──────────────┐   findings          ┌──────────────┐
  │   REVIEWER   │ ◀───────────────────│    PLAN      │
  │ re-runs the  │                     └──────────────┘
  │ code checks, │ ──── revise ───▶ WRITER   (at most 2 times)
  │ then judges  │
  └──────────────┘ ──── approve ───▶ a brand sees it
```

`src/agent/orchestrator.ts` is the only file that knows that order. When the
revision budget runs out, the run returns `ok: false` and **no plan** — the
same rule as the core, applied one level up.

### Why the strategy exists

A single agent asked for "a weekly plan" reasons and writes in one breath. When
the result is rejected, the retry has nothing to hold on to except the error
list, so it re-reasons from scratch — and the second attempt can contradict the
first on decisions nobody complained about. In practice the model changes the
cadence while fixing a date.

Splitting the decision from the writing gives the reviewer something to check
the plan *against*. A revision can then be told "keep the strategy, fix these
fields", and a plan that silently changes the cadence is caught by
`checkStrategyConformance` instead of being a judgement call.

### Why the reviewer cannot talk the guard down

The reviewer's verdict is computed in code:

```ts
blocked = anyDeterministicBlock || anyModelBlock
```

The model may **add** a finding. It may never **remove** one. So a model that
reads a plan containing a fabricated statistic and reports "looks good" cannot
approve it — the code finding is already in the list, and the verdict never
consults the model for permission.

### The four gates the writer passes

| gate | question | what it catches |
|---|---|---|
| `validateCampaignPlan` | is this a plan at all? | shape, the Monday rule, rows that do not exist |
| `checkNoFakes` | does each cited value match its row? | rounding, mixing up two similar rows |
| `checkStrategyConformance` | did it keep the planner's decisions? | a changed week, cadence, shortlist or order |
| `claims.ts` | is anything in the prose unbacked? | a statistic in a hook, a guarantee, a cure claim |

The fourth one is the one that was missing from the core, and it is the
subtle one: `checkNoFakes` reads `citedMetrics` and never the sentences, so a
plan could cite one real row and state a different number in the copy.

---

## The three layers of the core, and why they are separate

| layer | file | the job |
|---|---|---|
| the schema | `src/agent/campaign-plan.ts` | what a plan is, and the pure function that decides whether one is valid |
| the loop | `src/agent/copilot.ts` | the conversation with the model: call, validate, reject-with-reason, retry |
| the guard | `src/agent/no-fakes.ts` | the last check before a number is allowed to reach a human |

The split matters because the layers have different failure modes. The schema
is **pure** — no I/O, no model, no clock — so every rule in it can be tested by
mutating one field of a known-good plan and asserting on the exact error. The
loop is the only part that talks to a model, so it is the only part that needs
a fake client in tests. The guard is a second opinion on the numbers, because
"the row exists" and "the plan says what the row says" are different questions.

## Why a tool call and not a JSON mode

The vendor is explicit:

> "All except Muse Spark Open support structured outputs and JSON mode."
> "Muse Spark Open accepts `json_object` but doesn't constrain output to JSON."

A JSON mode request on this model is a **request**, not a guarantee: the
response is well-formed JSON of the right *type* and the wrong *shape* — a
string where a number belongs, a missing field, a list of briefs for creators
who were never shortlisted.

Tool calling moves the guarantee somewhere it can be enforced. The arguments
still arrive as JSON, but they arrive **against a schema the application
defines**, and the application is free to reject them. So:

- the plan is produced by a tool call, not by prose;
- the arguments are validated by `validateCampaignPlan`, a pure function;
- a rejection carries the exact reason back to the model;
- and there is no code path that stores an unvalidated plan.

The demo transcript shows all of it in two turns.

## The other limits this design respects

| the limit | what it means here |
|---|---|
| reasoning is always on and cannot be turned off | the plan is a reasoning artefact, so the validation happens after the thinking, not instead of it |
| `n > 1` returns HTTP 400 | one plan per request; the retry loop is the only source of multiplicity |
| `logprobs` is accepted and ignored | confidence is not available, so **verification** must be structural — a row id — rather than statistical |
| neither `seed` nor `temperature: 0` guarantees reproducibility | the output is never trusted for being repeatable; it is trusted only for passing the validator. The guard is deterministic, not the model |
| zero data retention on synchronous requests | a brand's real metrics are not kept in an inference log, which is what makes the plan usable for a small business |

That fourth row is the design argument in one line: **when you cannot make the
model repeatable, make the acceptance deterministic instead.**
