# ADR 001 — Deployment shape: hosted Baseten Model API

**Status:** decided
**Decision taken:** 2026-11-04, in JUS-3718. **Landed on the default branch:** 2026-11-17.
**Extends:** [`../ARCHITECTURE.md`](../ARCHITECTURE.md) (the pipeline and the model box) and
[`../TECHNIQUE.md`](../TECHNIQUE.md) (the cost and the data path).
**Supersedes:** nothing. No document is retired by this record.

## Context

JUS-3718 asked one question: does CreatorGuard call the hosted Baseten Model API,
self-host the open weights, or run both — and why.

This ADR answers it. It does not restate the pipeline or the guard design; those
live in [`../ARCHITECTURE.md`](../ARCHITECTURE.md) and
[`../TECHNIQUE.md`](../TECHNIQUE.md). It adds the one thing neither of them
states: **where the weights run in production.**

Partner-credit amounts (Baseten, Modal, Fireworks) are deliberately not
reproduced here. They came from an event page that cannot be re-verified from a
public source, and no part of this decision depends on them.

### The model, as the vendor publishes it

Measured on 2026-11-17 from the vendor's own pages:

| fact | value | source |
|---|---|---|
| slug | `meta-models/muse-spark-open` | [baseten.co/library/muse-spark-open](https://www.baseten.co/library/muse-spark-open) (fetched 2026-11-17) |
| developed by / family | Meta AI / Muse Spark | same page |
| size | 816B-A42B, an MoE | same page |
| context length | 1M; the docs table gives 1048k context and 1048k max output | [docs.baseten.co/inference/model-apis/overview](https://docs.baseten.co/inference/model-apis/overview) (fetched 2026-11-17) |
| input modalities | Text, Image, Video, Audio | [library page](https://www.baseten.co/library/muse-spark-open) (fetched 2026-11-17) |
| output modalities | Text | same page |
| price per 1M tokens | input $1.25, cached input $0.15, output $4.25 | [baseten.co/pricing](https://www.baseten.co/pricing) (fetched 2026-11-17); the same three numbers are pinned by [`scripts/test-cost.ts:34-36`](../../scripts/test-cost.ts) |

The repository already points at this slug in code:
[`src/agent/copilot.ts:25`](../../src/agent/copilot.ts) sets
`MODEL = "meta-models/muse-spark-open"` and line 26 sets `MAX_ATTEMPTS = 3`.
The default endpoint is `https://inference.baseten.co/v1`
([`src/web/model.ts:39`](../../src/web/model.ts)), the base URL the vendor's own
example pairs with this slug.

### The two properties that decide the shape

**1. This model does not enforce structured output.** The vendor's documentation
says so in two places, and the documentation is the authority for API behaviour:

> "All except Muse Spark Open support structured outputs and JSON mode."
> — [model APIs overview](https://docs.baseten.co/inference/model-apis/overview) (fetched 2026-11-17)

> "Model APIs support structured outputs except for Muse Spark Open, which accepts
> `json_schema` but doesn't enforce the schema."
> — [structured outputs](https://docs.baseten.co/inference/structured-outputs) (fetched 2026-11-17)

The vendor's pages are not self-consistent: the library page for this model
lists "Structured Outputs" among its supported features (fetched 2026-11-17),
while the two documentation pages above say the opposite. A schema that is
accepted but not enforced is not a guarantee, so the code must not depend on the
badge — and it does not. The plan arrives through one tool call and is
validated in application code; see "Why a tool call and not a JSON mode" in
[`../ARCHITECTURE.md`](../ARCHITECTURE.md).

**2. Synchronous Model API requests are not retained.**

> "Model APIs: Requests run under a zero data retention (ZDR) policy. Baseten
> doesn't store model inputs or outputs."
> — [docs.baseten.co/security](https://docs.baseten.co/security) (fetched 2026-11-17)

The repository already relies on this at
[`../ARCHITECTURE.md`](../ARCHITECTURE.md) ("The other limits this design
respects") and [`../TECHNIQUE.md`](../TECHNIQUE.md) ("The data path").

### What the app sends, and what it costs

One prompt carries the brand's 90-day metrics and the creator profiles, inlined —
[`src/agent/planner.ts:249`](../../src/agent/planner.ts) builds the planner's
system prompt from the dataset. The repository contains no retrieval stage.

[`scripts/cost.ts:89-99`](../../scripts/cost.ts) states the sizes and labels them
as estimates: 12,000 input tokens, 900 output tokens for one accepted plan.
[`scripts/cost.ts`](../../scripts/cost.ts) then does the arithmetic, and
[`scripts/test-cost.ts:73`](../../scripts/test-cost.ts) pins the claim that one
weekly plan costs less than two cents:

| figure | value |
|---|---|
| one accepted plan (12,000 in / 900 out) | $0.0188 — 1.88 cents |
| one plan with a rejection and a retry (24,000 in / 1,800 out) | $0.0376 — 3.77 cents |
| one month for one brand | $0.0815 |
| one month for 100 brands | $8.1512 |

[`scripts/test-cost.ts`](../../scripts/test-cost.ts) is 17/17 PASS, including
"one weekly plan costs LESS THAN TWO CENTS". The prices are the published
rates; the token counts are the labelled estimates.

### The limits that apply

Measured on 2026-11-17 from
[docs.baseten.co/inference/model-apis/pricing-and-limits](https://docs.baseten.co/inference/model-apis/pricing-and-limits)
(fetched 2026-11-17). These are **account-tier defaults**, not a promise for a
particular model or workspace — the same page says a model, service tier, or
organization configuration can set different limits, and that the workspace's
real limits are read from the model details request.

| account tier | RPM | TPM |
|---|---|---|
| Basic (unverified) | 15 | 100,000 |
| Basic (verified) | 120 | 500,000 |
| Pro | 120 | 1,000,000 |
| Enterprise | custom | custom |

The same page gives a separate, session-level recommendation: "Baseten
recommends at most about 60 requests per minute for one session." That is a
routing recommendation for one session's traffic, not a workspace limit, and it
does not contradict the table above — the two numbers describe different things.

At pilot volume neither applies. One plan per brand per week is one request
against a 120 RPM limit, carrying 12,000 tokens against a 500,000 TPM window.

## Decision

**Hosted Baseten Model API as the only production path. Self-hosting is not a
production path. There is no dual path in production.**

Stated plainly:

> CreatorGuard calls Muse Spark Open through Baseten's hosted Model APIs
> (`meta-models/muse-spark-open`). It does not self-host the weights in production.

One inference path, one set of gates:
[`validateCampaignPlan`](../../src/agent/campaign-plan.ts),
[`checkNoFakes`](../../src/agent/no-fakes.ts),
[`checkStrategyConformance`](../../src/agent/strategy.ts), and
[`src/agent/claims.ts`](../../src/agent/claims.ts).

## Why this, not the alternatives

### Why not self-host as primary

- **Self-hosting does not fix the thing that actually breaks.** The hard
  problem is that this model does not enforce structured output, and the
  vendor's own documentation frames that as a property of the model, not of
  the hosting. Serving the same weights from our own GPU adds no schema
  enforcement. It leaves the validator, the retry loop, and the no-fakes guard
  exactly where they are: in application code.
- **It trades a per-token price for a fixed idle-capacity cost.** The hosted
  path costs $0.0188 per accepted plan. A self-hosted 816B-A42B deployment
  would replace that with GPU orchestration, warm-up, and a capacity plan whose
  cost does not scale down with usage. The published token price does scale
  down, and the numbers above show how far down.
- **It moves the data-retention obligation onto the team.** The hosted path
  already runs under zero data retention, so a small brand's real metrics are
  not left in an inference log. Self-hosting would mean the team owns the log,
  the snapshot, and the deletion — more surface, not less, for the exact
  property that makes the product usable for a small business.

### Why not both

- **Two paths through four gates is two ways to be wrong.** Every gate listed
  above would have to hold on both paths, and a gate that is only enforced on
  one of them is not a gate. The three-agent flow already assumes one model and
  one retry shape; a second path multiplies the cases that must be reasoned
  about without adding a capability the product needs.
- **Two paths is two sets of keys, monitors, and cost calculators,** plus a
  demo that has to explain which path produced the plan on screen. The
  repository already has a model-mode badge for exactly this reason — the
  scripted model is labelled in the UI so a run never claims to be live.

### Self-hosting as a lab, not a path

If self-hosting is ever evaluated, it runs as an experiment outside production
and plugs into the same seam, without touching
[`src/agent/`](../../src/agent). [`src/web/model.ts`](../../src/web/model.ts)
keeps the provider swappable behind `ChatClient`
([`src/agent/copilot.ts:105`](../../src/agent/copilot.ts)):
`liveClient()` reads `BASETEN_API_KEY`, `BASETEN_MODEL`, and
`BASETEN_BASE_URL` ([`src/web/model.ts:49-87`](../../src/web/model.ts)), and with
no key it falls back to the scripted model, labelled as such in the UI
([`src/web/model.ts:277-291`](../../src/web/model.ts)). A self-host experiment
is one more `ChatClient` implementation. It is never a second production path.

## Consequences

- **The provider seam stays open.** `src/web/model.ts` remains swappable at the
  `ChatClient` boundary. `liveClient()` reads `BASETEN_API_KEY`,
  `BASETEN_MODEL`, and `BASETEN_BASE_URL`; without a key the app runs the
  scripted model and labels the mode on screen, so a run never claims to be
  live.
- **No key ever reaches the repository.** `.gitignore` covers `.env` and
  `.env.*` ([`.gitignore:2-4`](../../.gitignore)), and CI scans every push for
  secret-shaped strings
  ([`.github/workflows/guards.yml:42-49`](../../.github/workflows/guards.yml)).
- **The four gates are the contract, and they do not move.** A hosted model, a
  self-hosted model, and the scripted model must all pass them, and a second
  production path would mean a second set of proofs that they do.
- **Validation cost does not scale with inference cost.** The validator is
  pure and deterministic; it is the reason the design can accept a model that
  cannot be trusted to be repeatable.

## Verification

Every claim above is either a `file:line` that resolves on this branch's head, a
live external source with its fetch date, or an explicitly labelled estimate.

| claim | where it is checked |
|---|---|
| the slug and the retry count in code | [`src/agent/copilot.ts:25-26`](../../src/agent/copilot.ts) |
| the hosted `fetch`, the env vars, the endpoint | [`src/web/model.ts:38-39`](../../src/web/model.ts), [`src/agent/copilot.ts:25-26`](../../src/agent/copilot.ts), [`src/web/model.ts:49-87`](../../src/web/model.ts) |
| the scripted fallback and its UI label | [`src/web/model.ts:277-291`](../../src/web/model.ts) |
| the four gates | [`src/agent/campaign-plan.ts`](../../src/agent/campaign-plan.ts), [`src/agent/no-fakes.ts`](../../src/agent/no-fakes.ts), [`src/agent/strategy.ts`](../../src/agent/strategy.ts), [`src/agent/claims.ts`](../../src/agent/claims.ts) |
| the dataset is inlined into one prompt | [`src/agent/planner.ts:249`](../../src/agent/planner.ts) |
| the price arithmetic and its estimates | [`scripts/cost.ts:89-99`](../../scripts/cost.ts), [`scripts/test-cost.ts:34-36`](../../scripts/test-cost.ts), [`scripts/test-cost.ts:73`](../../scripts/test-cost.ts) |
| the repository's own guard suite is green on this head | `npm test` — 506 assertions across 12 test files; the file list is [`scripts/run-all.ts:12-24`](../../scripts/run-all.ts) and the total is printed at [`scripts/run-all.ts:54`](../../scripts/run-all.ts) |
| the vendor's model facts | [library page](https://www.baseten.co/library/muse-spark-open), [overview](https://docs.baseten.co/inference/model-apis/overview), [structured outputs](https://docs.baseten.co/inference/structured-outputs) — all fetched 2026-11-17 |
| the price | [baseten.co/pricing](https://www.baseten.co/pricing) — fetched 2026-11-17 |
| the rate limits | [pricing and limits](https://docs.baseten.co/inference/model-apis/pricing-and-limits) — fetched 2026-11-17 |
| zero data retention | [docs.baseten.co/security](https://docs.baseten.co/security) — fetched 2026-11-17 |

## Revisit when

- A brand needs on-premises data residency that hosted zero retention does not
  satisfy.
- Baseten's published prices, retention terms, or rate limits change, or
  sustained throttling appears at pilot volume.
- The vendor's two pages stop disagreeing about structured output, and the
  documented behaviour of `json_schema` on this model changes from "accepted,
  not enforced" to enforced.
- A use case needs a capability the hosted model does not have — one that would
  justify a dedicated deployment for a specific creator voice rather than a
  second production path.
