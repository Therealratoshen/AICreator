# The technique

This note explains the one hard thing in this project, and the parts of it
that are easy to get wrong. It is written for whoever reads the code next.

---

## The problem: a structured artefact from a model that does not enforce structure

The copilot's output is a **campaign plan** — a weekly cadence, a creator
shortlist, a content brief per creator, and the metrics it rests on. That is a
structured artefact, and the obvious way to get one out of a language model is
to ask for JSON.

On most models that works, because the model supports **structured outputs**: you
hand the server a JSON Schema and it will not return anything that does not
conform.

**Muse Spark Open does not.** Its own documentation says so plainly:

> "All except Muse Spark Open support structured outputs and JSON mode."

and, more usefully:

> "Muse Spark Open accepts `json_object` but **doesn't constrain output to JSON**.
> Ask for JSON in your prompt and validate the response in your application."

So on this model a JSON request is a *request*, not a guarantee. The response
arrives as well-formed JSON of the right *type* and the wrong *shape*: a string
where a number belongs, a missing field, a brief for a creator who was never
shortlisted, a metric citing a row that does not exist.

That is the constraint the whole design is built around, and the rest of this
note is how it is answered.

---

## The approach, in four moves

### 1. Never accept prose

The plan has exactly one exit: a `submit_campaign_plan` tool call. If the model
answers in prose, the answer is rejected and the tool is demanded again — the
demo's transcript shows a prose answer being refused.

This matters more than it looks. A prose plan is not just unvalidated, it is
*unparseable in a principled way*: there is no way to say "the brief for
kol_aria is missing" when the answer is a paragraph.

### 2. Validate in code, not in the prompt

The prompt asks; the code decides.

`validateCampaignPlan()` in [`../src/agent/campaign-plan.ts`](../src/agent/campaign-plan.ts)
is a **pure function** — no I/O, no model, no clock, no randomness. It takes the
tool arguments and the set of metric row ids that actually exist, and returns
either the plan or a list of errors.

Being pure is what makes it testable in the way that matters: every rule can be
proven by **mutating one field of a known-good plan** and asserting on the exact
error. The 30 assertions in `test-plan-validator.ts` are all of that shape.

### 3. Make the rejection actionable

The rejection string goes straight back to the model, so it has to be precise:

```
weekOf must be a Monday, got 2026-11-03 (a Tuesday)
citedMetrics[1].sourceRowId "row_best_view" does not exist - do not cite a row you have not read
```

Note what it is *not*: "invalid output" or "the JSON was malformed". A message
like that gives the model nothing to act on, and the run fails. A message that
names the field, the value it got, and the rule it broke gives the model
everything it needs — and in the demo, one such message is enough for the model
to fix both of its mistakes in the next call.

### 4. Refuse to store what was not validated

There is no branch anywhere in the codebase that writes an unvalidated plan.
A run that exhausts its three attempts returns **no plan at all**, and
`test-copilot-loop.ts` asserts exactly that — that a model which never recovers
yields `plan === undefined`, not a half-valid plan.

---

## The second hard thing: a plausible number is not a number

The hardest problem in a campaign tool is not making the model say something
sensible. It is making sure it does not say something **confidently wrong** — a
median view count of 4,820 that no row supports, for a creator who does not
exist, in a plan that looks entirely reasonable.

A model is very good at producing *plausible* numbers. Plausible is not the bar.

So every number in a generated plan carries the id of the row it came from:

```ts
citedMetrics: { metric: string; sourceRowId: string; value: number }[]
```

and two separate checks apply:

1. **the validator** rejects any plan citing a `sourceRowId` that is not in the
   set of rows that exist;
2. **the no-fakes guard** ([`../src/agent/no-fakes.ts`](../src/agent/no-fakes.ts))
   rejects a plan whose cited value **disagrees with the row's own value**.

The second check is the subtle one. The row exists and the number is real — but
the plan says something different from what that row holds. A model that rounds,
or that mixes up two similar rows, lands exactly here. "The row exists" and "the
plan says what the row says" are two different questions, and both are asked.

The guard also checks that each shortlisted creator's justification traces to a
real row, so a creator cannot be recommended on a number nobody can produce.

---

## The third hard thing: a number in a sentence

`no-fakes.ts` checks `citedMetrics` — the list a plan declares. It cannot see a
number written inside a sentence, because it never reads the sentences. So this
passes every guard the core has:

```ts
citedMetrics: [ { metric: "median_saves_90d", sourceRowId: "kol_aria_saves", value: 610 } ]
contentBriefs[0].hook: "4.900 orang menyimpan ini minggu lalu"
```

One real row is cited, a different number is stated, and nothing complains. The
same hole exists for promises: "dijamin glowing dalam 7 hari" is a claim no row
could ever support, because there is no row to look up.

[`../src/agent/claims.ts`](../src/agent/claims.ts) reads the prose. Two rules:

- **statistics** — a number of 100 or more, or anything with a `%`, must equal
  a cited value. `4.820` and `4,820` are both tried, because the copy is
  Indonesian and the same number has two notations;
- **claims** — guarantees, cure claims, proof claims and absolutes are blocking,
  because their form is what makes them unbackable. Superlatives and outcome
  promises only warn, because a human should decide those.

The severity split is load-bearing. If every finding blocked, a plan with one
overenthusiastic adjective would burn all three writer attempts and escalate —
a system that looks strict and is actually brittle.

---

## The fourth hard thing: a guard that a model can argue with

Once a model is in the review path, the obvious risk is that it becomes a way to
talk the guard down. A model asked "is this plan good?" is agreeable by
training, and the plan is right there looking reasonable.

So the reviewer's verdict is not the model's to give:

```ts
blocked = anyDeterministicBlock || anyModelBlock
```

Code findings are computed first, and the model's opinion is only ever added to
them. The model can make the review stricter and can never make it more
permissive. That asymmetry is what makes a third agent safe to have at all.

---

## Why the layers are three files and not one

| layer | file | the job | how it fails |
|---|---|---|---|
| the schema | `campaign-plan.ts` | what a plan is, and whether one is valid | a rule is wrong |
| the loop | `copilot.ts` | the conversation: call, validate, reject, retry | the model does not recover |
| the guard | `no-fakes.ts` | the last check before a number reaches a human | a number is wrong |

They have different failure modes, so they are tested differently. The schema is
pure, so it is tested by mutating fields and asserting on the error text. The
loop is the only part that talks to a model, so it is the only part that needs a
fake client — which is what makes it deterministic and free to run. The guard
is a second opinion on the numbers, because "the row exists" and "the plan says
what the row says" are different questions and a second pass catches the
difference.

---

## What the model can and cannot do, and what follows from it

| the model's limit | what it means here |
|---|---|
| **reasoning is always on and cannot be turned off** | the plan is a reasoning artefact, so validation has to happen *after* the thinking, not instead of it |
| **`n > 1` returns HTTP 400** | one plan per request; the retry loop is the only source of multiplicity |
| **`logprobs` is accepted and ignored** | confidence is not available, so verification must be *structural* — a row id — not statistical |
| **neither `seed` nor `temperature: 0` guarantees reproducibility** | the output is never trusted for being repeatable; it is trusted only for passing the validator. **The guard is deterministic, not the model** |
| **zero data retention on synchronous requests** | a brand's real metrics are not kept in an inference log, which is what makes this usable for a small business |

That fourth row is the design argument in one line: **when you cannot make the
model repeatable, make the acceptance deterministic instead.**

---

## The cost, computed rather than asserted

Baseten's published Model API rates for Muse Spark Open, per million tokens:

| | Input | Cached input | Output |
|---|---|---|---|
| Muse Spark Open | $1.25 | $0.15 | $4.25 |

[`../scripts/cost.ts`](../scripts/cost.ts) does the arithmetic and
[`../scripts/test-cost.ts`](../scripts/test-cost.ts) pins it:

```
one accepted plan:   12,000 in / 900 out  →  $0.0188   (1.88 cents)   ≈ Rp 307
one plan with a rejection and a retry:                        $0.0376   (3.77 cents)

one month for one brand:  $0.08    one month for 100 brands:  $8.15
```

The token counts are estimates and are labelled as such in the script; the
prices are the published rates. The test asserts the "under two cents" claim
that the README makes, so the two cannot drift apart.

---

## The data path

The public demo passes synthetic brand and creator rows to the model. A future
Instagram integration would read authorized performance and audience data and
pass the resulting rows through the same validation flow. The live product
currently supports TikTok campaigns; Instagram campaign support is planned.

- **Zero data retention.** Baseten does not store inputs or outputs for
  synchronous Model API requests, so a small brand's real metrics are not left
  in an inference log.
- **Every number is traceable.** Nothing reaches a human that a database row
  does not support.

---

## Where the project stands

**Built, tested and in this repository:** the plan schema and validator, the
tool-calling loop with rejection-and-recovery, the no-fakes guard, the claim
scanner, the three-agent flow (planner, writer, reviewer), the creator-side
agent and guards, the brand-flow web app, the cost calculator, 506 assertions across twelve test files, two runnable demos, and the
committed transcript.

**In the live product** ([justnewme.com](https://justnewme.com)): the
marketplace currently supports **TikTok** as its live campaign channel.
Instagram campaign support is on the roadmap. This public repository does not
connect to either platform.

**Next:** Instagram campaign support, the WhatsApp/Messenger adapter, image and
video assets, and wiring this AI module into the live marketplace.

---

## Reproduce everything

```bash
git clone https://github.com/Therealratoshen/AICreator.git
cd AICreator
npm test             # 506 assertions
npm run demo         # the core loop: the rejection, the recovery, the guard
npm run demo:agents  # the three-agent flow: planner, writer, reviewer
npm start            # the web app, no API key needed
npm run cost         # what one plan costs
```

Node 22.6+. No dependencies, no build step, no API key required.
