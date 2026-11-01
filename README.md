# CreatorGuard AI

**A campaign copilot for Indonesian small brands and independent creators.**

> Indonesia's brand–creator economy runs on WhatsApp threads, spreadsheets and gut feel. A small brand with 5,000 followers has no affordable way to know which creator will actually convert, and no way to plan content past the next post.
>
> CreatorGuard reads the numbers both sides already have, and turns them into a campaign plan you can act on this week.

```bash
git clone https://github.com/Therealratoshen/CreatorGuard-AI.git && cd CreatorGuard-AI
npm test             # 343 assertions across 10 files — no install, no API key
npm run demo:agents  # the three-agent flow, in a terminal
npm start            # the web app on http://127.0.0.1:3000
npm run demo         # the core loop, with the transcript
npm run cost         # what one plan costs
```

---

## The problem, and where it comes from

It is not hypothetical. The author ships [justnewme.com](https://justnewme.com), a **live** marketplace where Indonesian brands run creator campaigns — a Brand publishes a brief, a creator claims a slot, posts, and the Brand reviews the result.

Running it surfaced a gap: the marketplace records what happened, but it does not **decide**. A brand with 5,000 followers still cannot answer *"which creator should I brief, and what should I say on Tuesday?"* without asking someone whose gut feeling is worth nothing to measure.

CreatorGuard is that decision, and it is deliberately small: **one weekly plan, grounded in the rows that already exist.**

## What it does

```
 the brand's Meta/Instagram performance  ─┐
 (Meta Graph API + Instagram Platform)   │
                                         ├──▶  Muse Spark Open
 the creator's audience signals          │     (one 262,144-token context)
                                         │            │
                                         │            ▼
                                         │      submit_campaign_plan  ← the only way out
                                         │            │
                                         ▼            ▼
                            a VALIDATED campaign plan
                            weekly cadence · creator shortlist
                            content briefs · posting cadence
                                         │
                                         ▼
                              Muse Image → on-brand variants
                              one per shortlisted creator
                                         │
                                         ▼
                          WhatsApp / Messenger — where Indonesian
                          small businesses actually work
```

The creator gets the mirror image: **an agent that explains their own numbers** and drafts content **in their own voice**.

---

## Three agents, one flow

One agent asked for "a weekly plan" reasons and writes in one breath, so when
the result is rejected the retry re-reasons from scratch — and changes the
cadence while fixing a date. Deciding, writing and checking are three jobs:

```
  PLANNER ──▶ strategy ──▶ WRITER ──▶ plan ──▶ REVIEWER
  decides      week        writes      │        reads
               cadence                 │          │
               creators                │  ◀─ revise ┘
               angle                   │     (at most twice)
               constraints             ▼
                              4 gates, in code
```

- **The planner** decides which creators, how often, what angle, and what the
  writer must avoid. Every pick must cite a row, and that row must be *about
  that creator* — a real number attached to the wrong person is rejected.
- **The writer** turns the strategy into briefs. It cannot change the week, the
  cadence or the shortlist: `checkStrategyConformance` rejects it if it tries.
- **The reviewer** re-runs the code checks and then adds judgement — does the
  copy express the angle, does a brief break a constraint. Its verdict is
  computed as `anyCodeFinding || anyModelFinding`, so **a model can make the
  review stricter and never more permissive**.

When the revision budget runs out the run returns **no plan at all** — the same
rule as the core, one level up.

```bash
npm run demo:agents   # planner, writer, reviewer — 3 rejections, 7 model calls
npm start             # the same flow as a web app
```

The web app runs on **synthetic data, labelled as such on the page**, and needs
no API key: without `BASETEN_API_KEY` it uses a scripted model that makes the
mistakes a real one makes. It says which mode it is in, on screen.

---

## The constraint that shaped this

This is the part worth reading, because it is not a normal LLM app.

> "All except Muse Spark Open support structured outputs and JSON mode."
> — [Baseten, Model APIs](https://docs.baseten.co/inference/model-apis/overview)

> "Muse Spark Open accepts `json_object` but **doesn't constrain output to JSON**. Ask for JSON in your prompt and **validate the response in your application**."
> — Baseten

So **you cannot ask the model for JSON and trust it.** On this model there is no schema enforcement at all. The only reliable shape is:

1. the plan is produced by **tool calling** — a `submit_campaign_plan` tool with a strict schema;
2. **every argument is validated in code** before it is used;
3. a bad plan is **rejected with the reason fed back**, and the loop recovers.

### What that looks like

The committed transcript — the model's own arguments, then the validator's verdict — is in [`demo-transcript.txt`](demo-transcript.txt). The interesting part:

```
  turn 1: tool_rejected
    {"weekOf":"2026-11-03","cadencePerWeek":2,"creatorShortlist":[...],
     "citedMetrics":[...,{"metric":"median_views_90d",
     "sourceRowId":"row_best_view","value":4820}],...}
    ── the validator said ──
    ✗ weekOf must be a Monday, got 2026-11-03 (a Tuesday)
    ✗ citedMetrics[1].sourceRowId "row_best_view" does not exist - do not cite a row you have not read

  turn 2: tool_accepted
    {"weekOf":"2026-11-02",...,"sourceRowId":"row_post_1","value":4820}...
```

Two mistakes in one attempt — a date that is not a Monday, and **a metric row that does not exist**. Both are caught in code, both are named precisely, and the model fixes them on the next call. **Nothing was stored in between**, because there is no code path that stores an unvalidated plan.

---

## The rule this project is built on

> "Never publish a number, a stat, a date, or a promise that isn't backed by data."

That is the rule from justnewme.com's own README, and here it is executable:

- every number in a generated plan carries the id of the row it came from (`sourceRowId`);
- the validator rejects any plan citing a row that does not exist;
- `src/agent/no-fakes.ts` additionally rejects a plan whose cited value **disagrees with the row's own value** — the case a model lands in when it rounds, or mixes up two rows;
- a shortlisted creator's justification must itself trace to a real row.

A model is good at producing a *plausible* number. **Plausible is not the bar.**

---

## The guards

| file | what it proves |
|---|---|
| [`src/agent/campaign-plan.ts`](src/agent/campaign-plan.ts) | the schema, and the validator that enforces it in code |
| [`src/agent/copilot.ts`](src/agent/copilot.ts) | the tool-calling loop: call → validate → reject-with-reason → retry |
| [`src/agent/no-fakes.ts`](src/agent/no-fakes.ts) | every number traces to a row, and the value matches |
| [`src/agent/claims.ts`](src/agent/claims.ts) | a number written *in a sentence*, and the promises no row could back |
| [`src/agent/strategy.ts`](src/agent/strategy.ts) | the planner's contract, and that the writer kept its decisions |
| [`src/agent/orchestrator.ts`](src/agent/orchestrator.ts) | the order, and that a rejected plan is never published |
| [`scripts/test-plan-validator.ts`](scripts/test-plan-validator.ts) | **30 assertions** — every mutation of a good plan is rejected, for the right reason |
| [`scripts/test-copilot-loop.ts`](scripts/test-copilot-loop.ts) | **27 assertions** — rejection, recovery, no-recovery, prose, broken JSON |
| [`scripts/test-no-fakes.ts`](scripts/test-no-fakes.ts) | **9 assertions** — invented rows, wrong values, unsupported justifications |
| [`scripts/test-cost.ts`](scripts/test-cost.ts) | **17 assertions** — the pricing, the arithmetic, and the "under two cents" claim this README makes |
| [`scripts/test-claims.ts`](scripts/test-claims.ts) | **39 assertions** — statistics in prose, promises, and the numbers that must *not* be flagged |
| [`scripts/test-planner.ts`](scripts/test-planner.ts) | **49 assertions** — invented rows, wrong values, another creator's number, and a creator with no data |
| [`scripts/test-writer.ts`](scripts/test-writer.ts) | **42 assertions** — five ways to diverge from the strategy, plus the claim gates |
| [`scripts/test-reviewer.ts`](scripts/test-reviewer.ts) | **40 assertions** — including that a model cannot approve what code rejected |
| [`scripts/test-orchestrator.ts`](scripts/test-orchestrator.ts) | **47 assertions** — the flow, the revision, and that an exhausted run stores nothing |
| [`scripts/test-web.ts`](scripts/test-web.ts) | **43 assertions** — the real server, over real HTTP |

`npm test` runs all ten files, each in its own process, and prints one PASS/FAIL
summary. **343 assertions.**

**CI:** the workflow is committed at [`ci/guards.yml`](ci/guards.yml) — see the note in that file. The guards do not need CI to run: `npm test` is one command.

---

## The models, and what one run costs

| what | which | the detail |
|---|---|---|
| the copilot | **`meta-models/muse-spark-open`** (Baseten Model APIs) | Muse Spark Open — 816B total / 42B active MoE, **262,144-token context**, multimodal. Reasoning always on; `temperature`, `top_p`, `top_k`, `stop`, `presence_penalty`, `frequency_penalty` |
| the creative variants | **Muse Image** (Meta Model API) | text + image in, image out — no per-image fee; images are priced as input tokens |
| the creator's voice | **Muse Voice Transcribe** (Meta Model API) | audio in, text out |
| segmentation | **SAM 3.1** (Meta Model API) | prompt + image → geometry |

**Why this model.** The context window is what decided the choice: a brand's last 90 days of metrics plus a creator's full audience profile fit in **one** prompt — no summarization step, no retrieval, no lossy pipeline. And because Muse Spark Open is the model this is built around, the hard part — **no structured outputs** — is the part worth showing.

**The price** (Baseten's published table, per million tokens):

| | Input | Cached input | Output |
|---|---|---|---|
| Muse Spark Open | **$1.25** | **$0.15** | **$4.25** |

**The measured cost of one plan** (the arithmetic is in [`scripts/cost.ts`](scripts/cost.ts), and it runs):

```
one accepted plan:   12,000 in / 900 out  →  $0.0188   (1.88 cents)   ≈ Rp 307
one plan with a rejection and a retry:                        $0.0376   (3.77 cents)

one month for one brand:  $0.08    one month for 100 brands:  $8.15
```

A small brand can run this every week and still spend less on the copilot than on a single boosted post. That is the whole economic argument for a tool aimed at 5,000-follower businesses.

```bash
npm run cost     # prints the breakdown above
```

The token counts are **estimates** and are labelled as such in the script; the prices are Baseten's published rates.

**Two properties worth knowing:**

- **Zero data retention.** For synchronous Model API requests Baseten does not store inputs or outputs. A brand's real metrics are not kept in someone's inference log.
- **Rate limits** (Baseten's defaults): Basic verified — 120 RPM / 500,000 TPM; Pro — 120 RPM / 1,000,000 TPM. Baseten recommends at most ~60 requests/minute for one session, which is far above what one weekly plan needs.

To run the demo against the live model instead of the scripted one:

```bash
export BASETEN_API_KEY=...        # optionally BASETEN_MODEL=meta-models/muse-spark-open
npm run demo
```

The scripted model mocks the **model**, never the validator: the validator, the rejection messages and the no-fakes guard are the real production code in every run.

---

## What is built, and what is not

Being straight about this, because a reader should not have to guess.

**Built, tested and public in this repo:**

- the plan schema and the validator that enforces it (30 assertions)
- the tool-calling loop with rejection-and-recovery (27 assertions)
- the no-fakes guard — every number traces to a row, and the value matches (9 assertions)
- the claim scanner — a statistic in a sentence, and promises no row could back (39 assertions)
- the three-agent flow: planner, writer, reviewer, and the flow that orders them (178 assertions)
- the web app, driven by real HTTP in its test (43 assertions)
- the cost calculator, with the arithmetic pinned by tests (17 assertions)
- two runnable demos that show a wrong plan being rejected and then fixed
- the committed transcript, so the behaviour can be read without running anything

**Built in the live product, and the reason this project exists:**

- justnewme.com — the marketplace, with a real Instagram Graph API integration
  (`src/lib/instagram.ts`: OAuth via Facebook Login, scopes `instagram_basic`,
  `instagram_manage_insights`, `pages_show_list`, `pages_read_engagement`, and
  media insights with view, like and comment counts)
- its live channel today is **TikTok**, which is exactly why the copilot matters:
  the demand data and the delivery channel are not the same surface yet

**Not built yet — the next steps, in order:**

1. the WhatsApp/Messenger delivery adapter
2. the Muse Image variant generation, consuming the validated plan
3. the creator's mirror-image agent
4. wiring the copilot into the live marketplace, where the real rows already are

---

## The project

| | |
|---|---|
| the product it extends | [justnewme.com](https://justnewme.com) — live, for Indonesian brands and creators |
| the stack | Muse Spark Open (Baseten) · Muse Image, Muse Voice Transcribe, SAM 3.1 (Meta Model API) |
| the runtime | Node 22.6+, no dependencies, no build step |
| for a contributor | [`AGENTS.md`](AGENTS.md) — the invariants, the commands, the house style |

---

## Licence

Apache-2.0. See [LICENSE](LICENSE).
