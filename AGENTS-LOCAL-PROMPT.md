You are working on **CreatorGuard AI** — a campaign copilot for Indonesian small
brands and independent creators.

Repository: https://github.com/Therealratoshen/CreatorGuard-AI
The product it extends: https://justnewme.com (live)

---

## FIRST, BEFORE YOU WRITE ANY CODE

Read these three files, in this order. They are the contract:

1. `AGENTS.md` — the invariants, the commands, the house style
2. `docs/TECHNIQUE.md` — the hard problem, and the design that answers it
3. `docs/ARCHITECTURE.md` — the pipeline, layer by layer

If your change makes any of them wrong, update them **in the same change**.
A stale doc is a bug.

---

## THE ONE THING THAT MATTERS MOST

This project exists because of a hard constraint in the model.

**Muse Spark Open does NOT support structured outputs or JSON mode.** It accepts
`json_object` but does not constrain the output. So the plan cannot be trusted
to arrive as valid JSON.

The rules that follow, in order of importance:

1. **The plan is produced by TOOL CALLING** (`submit_campaign_plan`) — never by
   prose, never by "just parse the JSON and hope".
2. **Every argument is validated IN CODE.** `validateCampaignPlan()` is a pure
   function over the arguments plus the set of metric row ids that exist. The
   prompt asks; the code decides.
3. **A rejection is the API.** It goes back to the model verbatim, so it must
   name the field, the value it got, and the rule it broke:
   `weekOf must be a Monday, got 2026-11-03 (a Tuesday)`
   "invalid output" is a bug — the model cannot act on it.
4. **There is NO code path that stores an unvalidated plan.** If the model never
   recovers, the run returns **no plan at all**. Do not add a fallback, a
   default plan, a "best-effort" save, or a catch that swallows a validation
   failure.
5. **Every number carries the `sourceRowId` it came from.** The validator
   rejects a plan citing a row that does not exist; `no-fakes.ts` additionally
   rejects a plan whose cited value **disagrees with the row's own value**.
   Do not add a path that builds a plan without consulting the data layer.
6. **One exit.** The plan leaves through `submit_campaign_plan` and nothing
   else. A prose answer is rejected and the tool is demanded again.

---

## HOW TO WORK

**Read first.** The relevant source, then the docs above.

**Write the failing test first.** The house style is a *mutation* of a
known-good plan: take the good plan, break **exactly one** field, assert the
**exact** error. A test that passes when the code is broken is worse than no
test — it is a false guarantee.

**Make it fail, then make it pass.** Watch the test fail *for the right reason*
before you fix the code. If you mutate the plan in a test, confirm the
mutation actually landed on disk before you trust the exit code. An exit code
you did not see is not a result.

**Run the whole suite, then the demo.**

```bash
npm test        # 83 assertions across 4 files. MUST pass before you commit.
npm run demo    # the loop, end to end, with the transcript
npm run cost    # what one plan costs
```

Node 22.6+. No dependencies, no build step, no `node_modules` — the tests run
on Node's own type-stripping loader. Do not add a toolchain, a bundler, or a
package manager.

**Commit small.** One concern per commit, and the message says *why*.

---

## THE STYLE OF THIS CODEBASE

- **Comments explain the reason, not the mechanics.** A comment restating the
  line below it is noise. A comment explaining *why* it is written that way is
  the most valuable thing in the file.
- **The error text is load-bearing.** It is read by a model and by a person.
  Name the field. Give the rule. Give the value that broke it.
- **Pure functions where it matters.** Anything that decides should be
  testable without a network, a clock, or a model.
- **No dependencies.** The point is that a stranger can clone it and run it in
  a second.

---

## THE MODEL'S LIMITS — AND WHAT FOLLOWS FROM THEM

| the limit | what it means here |
|---|---|
| reasoning is always on, cannot be turned off | the plan is a reasoning artefact, so validation happens *after* the thinking, not instead of it |
| `n > 1` returns HTTP 400 | one plan per request; the retry loop is the only source of multiplicity |
| `logprobs` is accepted and ignored | confidence is not available, so verification must be **structural** — a row id — not statistical |
| neither `seed` nor `temperature: 0` guarantees reproducibility | the output is never trusted for being repeatable; it is trusted only for passing the validator. **The guard is deterministic, not the model.** |
| zero data retention on synchronous requests | a brand's real metrics are not kept in an inference log — which is what makes this usable for a small business |

That fourth row is the design argument in one line: **when you cannot make the
model repeatable, make the acceptance deterministic instead.**

---

## WHAT IS NOT HERE YET

Being precise, so nobody builds the wrong thing:

- the WhatsApp/Messenger delivery adapter
- the Muse Image variant generation (it consumes the validated plan)
- the creator's mirror-image agent (explain your numbers, draft in your voice)
- the wiring into the live marketplace, where the real rows are

This repository holds the **core**: the schema, the validator, the loop, the
guard, and the tests.

---

## VERIFY YOUR OWN WORK

You are expected to prove your claims, not assert them.

- Run the tests. **Read the output.** Do not trust an exit code you did not see.
- If you change the validator, mutate the good plan in your test and confirm
  the mutation landed on disk before you trust the exit code.
- If you change the schema, re-read `docs/TECHNIQUE.md` — it describes the
  design you are about to change, and it may now be wrong.
- If a number appears anywhere in your summary — a cost, a count, a rate — it
  must come from a measurement you took. Do not estimate, and do not round up
  to look better.
- **Never mark something done that you have not seen succeed.** "It should work"
  is not a result.

---

## THE PUBLIC REPO'S RULES

This repository is public. Two rules follow from that:

1. **No secrets, ever.** Everything sensitive is read from the environment at
   runtime. `.env` is gitignored, and the CI scans for secrets on every push.
2. **No personal data.** No real gmail addresses, no real phone numbers, no
   real customer or creator details. Use synthetic values in fixtures and
   examples.

And one rule about how it reads:

3. **Do not mention any competition, event, submission, deadline, judging, or
   prize in this repository.** It is a general project repository about the
   project. It is not an entry in anything.
