/**
 * The model adapter.
 *
 * WHY THIS IS A SEAM AND NOT A CLIENT
 * -----------------------------------
 * Nothing in `src/agent/` knows which model it is talking to. Every agent takes
 * a `ChatClient`, which is one method and a message list. That is what lets the
 * whole pipeline be tested against a fake for free, and it is what makes the
 * provider a deployment decision rather than a code decision - the same reason
 * `copilot.ts` already took a `ChatClient` and named the model in one constant.
 *
 * TWO MODES, AND THE DIFFERENCE IS VISIBLE IN THE UI
 * --------------------------------------------------
 *   live      - BASETEN_API_KEY is set, so the agents talk to Muse Spark Open.
 *   scripted  - no key, so a scripted model answers. It makes the mistakes a
 *               real model makes, so the guards have something to catch.
 *
 * The scripted model is a mock of the MODEL. It is not a mock of the validator,
 * the claim scanner, the conformance check or the reviewer's verdict logic -
 * those are the real functions, running for real, on whatever the scripted
 * model says. The app labels the mode on screen, because a demo that quietly
 * pretends to be a live model is the same class of dishonesty this product
 * exists to prevent.
 */

import type { ChatClient } from "../agent/copilot.ts";
import type { BrandDataset } from "../agent/dataset.ts";

export type ModelMode = "live" | "scripted";

export type ModelChoice = {
  client: ChatClient;
  mode: ModelMode;
  /** What to print in the UI. */
  label: string;
};

const DEFAULT_MODEL = "meta-models/muse-spark-open";
const DEFAULT_BASE_URL = "https://inference.baseten.co/v1";

/**
 * The real model, over `fetch`.
 *
 * No SDK, because the repo has no dependencies. The response is the
 * OpenAI-compatible shape Baseten's Model APIs expose, so the only thing this
 * function has to get right is passing `tools` through untouched - the agents
 * depend on the model seeing the schema they defined.
 */
export function liveClient(): ChatClient | null {
  const key = process.env.BASETEN_API_KEY;
  if (!key) return null;

  const model = process.env.BASETEN_MODEL ?? DEFAULT_MODEL;
  const base = process.env.BASETEN_BASE_URL ?? DEFAULT_BASE_URL;

  return {
    async complete({ messages, tools, tool_choice }) {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, tools, tool_choice }),
      });

      if (!res.ok) {
        throw new Error(`the model returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }

      const data = (await res.json()) as {
        choices?: {
          message?: {
            content?: string;
            tool_calls?: { id: string; function: { name: string; arguments: string } }[];
          };
        }[];
      };

      const msg = data.choices?.[0]?.message ?? {};
      return {
        tool_calls: msg.tool_calls?.map((c) => ({
          id: c.id,
          function: { name: c.function.name, arguments: c.function.arguments },
        })),
        content: msg.content,
      };
    },
  };
}

/**
 * The scripted model.
 *
 * It reads the dataset rather than hard-coding an answer, so the demo cannot
 * drift out of sync with the data: if a row changes, the script's citations
 * change with it, and if the script cites a row that does not exist the guards
 * reject it exactly as they would reject a real model.
 *
 * It makes one deliberate mistake at each of the first two stages, because a
 * demo where everything passes on the first try shows nothing. Both mistakes
 * are real failure modes:
 *
 *   strategy - justifies a creator with a number that belongs to a different
 *              creator. The value is real, the row is real, and the claim is
 *              false. Only the attribution check catches this.
 *   plan     - states a statistic in a hook that no cited row supports. Every
 *              guard that reads `citedMetrics` alone lets this through.
 *
 * The reviewer then blocks once on angle drift, so the revision path is
 * visible too. Seven calls in total, and every one of them is checked by the
 * same code that would check a live model.
 */
export function scriptedClient(dataset: BrandDataset): ChatClient {
  const calls = { strategy: 0, plan: 0, review: 0 };

  /** The two creators with the most saves, which is the decision the demo makes. */
  const bySaves = dataset.rows
    .filter(
      (r) =>
        r.metric === "median_saves_90d" &&
        dataset.creators.some((c) => c.creatorId === r.subject),
    )
    .sort((a, b) => b.value - a.value)
    .slice(0, 2);

  const creators = bySaves.map((r) => r.subject);
  const savesRow = (id: string) => bySaves.find((r) => r.subject === id)!;
  const viewsRow = (id: string) =>
    dataset.rows.find((r) => r.subject === id && r.metric === "median_views_90d");

  const strategyArgs = (deliberateMistake: boolean) => {
    const [first, second] = creators;

    /**
     * The mistake: the FIRST creator is justified with the SECOND creator's
     * row. The number is real and the row exists, so a validator that only
     * checked existence and value would accept it. The attribution check is
     * the only thing standing between this and a shortlist built on somebody
     * else's audience.
     */
    const firstRationale = deliberateMistake
      ? {
          creatorId: first,
          metric: "median_saves_90d",
          sourceRowId: savesRow(second).rowId,
          value: savesRow(second).value,
        }
      : {
          creatorId: first,
          metric: "median_saves_90d",
          sourceRowId: savesRow(first).rowId,
          value: savesRow(first).value,
        };

    return {
      weekOf: "2026-11-02",
      cadencePerWeek: 2,
      creatorIds: creators,
      angle:
        "show the serum being used inside an existing routine on a normal weeknight, not in a studio",
      rationale: [
        firstRationale,
        {
          creatorId: second,
          metric: "median_saves_90d",
          sourceRowId: savesRow(second).rowId,
          value: savesRow(second).value,
        },
      ],
      constraints: [
        "no before-and-after skin photographs",
        "no claims about curing or treating acne",
      ],
    };
  };

  const planArgs = (deliberateMistake: boolean, revised: boolean) => {
    const hookFor = (index: number) => {
      if (deliberateMistake && index === 0) {
        // 4,900 appears in no row. Every other guard is satisfied: the plan
        // cites real rows, the shape is right, the strategy is kept.
        return "4.900 orang menyimpan rutinitas ini minggu lalu";
      }
      // Two distinct hooks, because a demo whose two briefs share a sentence
      // looks like the duplicate-brief failure the reviewer is meant to catch.
      const plain = [
        "rutinitas malamku cuma dua langkah, dan ini yang aku tambahkan",
        "aku nggak ganti rutinitas, cuma nambah satu langkah sebelum tidur",
      ];
      const afterReview = [
        "serum ini masuk ke rutinitas malamku yang cuma dua langkah",
        "aku taruh serum ini setelah pelembap, dan sisanya tetap sama",
      ];
      return (revised ? afterReview : plain)[index % 2];
    };

    return {
      weekOf: "2026-11-02",
      cadencePerWeek: 2,
      creatorShortlist: creators.map((id) => ({
        creatorId: id,
        reason: `median ${savesRow(id).value} saves per post over the last 90 days`,
        justifyingMetric: savesRow(id).value,
      })),
      contentBriefs: creators.map((id, index) => ({
        creatorId: id,
        objective: "show the serum slotting into a routine that already exists",
        hook: hookFor(index),
        cta: "simpan kalau rutinitasmu juga cuma sebentar",
        imageCount: 2,
      })),
      citedMetrics: creators.flatMap((id) => {
        const saves = savesRow(id);
        const views = viewsRow(id);
        const cited = [
          { metric: saves.metric, sourceRowId: saves.rowId, value: saves.value },
        ];
        if (views) {
          cited.push({ metric: views.metric, sourceRowId: views.rowId, value: views.value });
        }
        return cited;
      }),
      notes:
        "dua posting per kreator. Angkanya dari data 90 hari terakhir, bukan perkiraan.",
    };
  };

  const reviewArgs = (block: boolean) =>
    block
      ? [
          {
            code: "ANGLE-DRIFT",
            severity: "block",
            where: "contentBriefs[1].hook",
            message:
              "this hook is about the creator's own routine in general, not about the serum " +
              "fitting into it, which is what the angle asked for",
          },
        ]
      : [
          {
            code: "TONE",
            severity: "warn",
            where: "contentBriefs[0].cta",
            message:
              "the call to action is slightly long for this creator's usual register - the brand " +
              "may want to shorten it before publishing",
          },
        ];

  return {
    async complete({ tools }) {
      const name = (tools[0] as { function?: { name?: string } })?.function?.name ?? "";

      let payload: unknown;
      if (name === "submit_campaign_strategy") {
        calls.strategy++;
        payload = strategyArgs(calls.strategy === 1);
      } else if (name === "submit_campaign_plan") {
        calls.plan++;
        // The first plan states an uncited number; the second is the plan the
        // writer produces after being told, and after the reviewer objected.
        payload = planArgs(calls.plan === 1, calls.plan > 2);
      } else if (name === "submit_review") {
        calls.review++;
        payload = { findings: reviewArgs(calls.review === 1) };
      } else {
        return { content: "I do not know that tool." };
      }

      return {
        tool_calls: [{ id: `call_${name}_${Date.now()}`, function: { name, arguments: JSON.stringify(payload) } }],
      };
    },
  };
}

/** Pick the live model when there is a key, and say which one was picked. */
export function chooseModel(dataset: BrandDataset): ModelChoice {
  const live = liveClient();
  if (live) {
    return {
      client: live,
      mode: "live",
      label: process.env.BASETEN_MODEL ?? DEFAULT_MODEL,
    };
  }
  return {
    client: scriptedClient(dataset),
    mode: "scripted",
    label: "scripted model (no BASETEN_API_KEY set)",
  };
}
