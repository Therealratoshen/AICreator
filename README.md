# AI Creator: public functionality from justnewme.com

This repository shares the **AI Creator and campaign planning functionality** developed as part of the [justnewme.com](https://justnewme.com) project. It is a standalone reference implementation and demo of the AI decision and validation layer. It is not the justnewme.com application, a deployment of its marketplace, or a connection to its production data.

The public code contains two related flows:

| Flow | What it does | Entry points |
| --- | --- | --- |
| Brand campaign copilot | Plans a week of creator campaigns, checks cited metric rows, and reviews briefs before returning a plan. | `src/agent/orchestrator.ts`, `scripts/demo-agents.ts`, `src/web/` |
| AI Creator | Explains a creator's own metrics or drafts a caption against their previous captions. It validates responses and rejects unsupported numbers. A voice memo can be transcribed before the same validation flow. | `src/agent/creator-agent.ts`, `src/agent/creator-answer.ts`, `src/agent/creator-no-fakes.ts`, `src/agent/voice.ts` |

The web app currently demonstrates the brand campaign flow. The creator flow is available as source and tests; it is not a separate web screen. The included brand and creator records are synthetic. No justnewme.com customer, creator, or production database records are required to run this repository.

## Run locally

Node.js 22.6 or newer is required. There are no package dependencies or install step.

```bash
git clone https://github.com/Therealratoshen/AICreator.git
cd AICreator
npm test
npm run demo:agents
npm start
```

Open <http://127.0.0.1:3000> after `npm start`. Without `BASETEN_API_KEY`, the demos and web app use a scripted model and label that mode. The validation code still runs. To call the live model, set `BASETEN_API_KEY` in your environment before running a demo or the server. Keep the key out of files and commits.

`npm run demo` exercises the single agent campaign loop. `npm run cost` prints an illustrative estimate from the rates and token counts in `scripts/cost.ts`; it is not a measured bill or a pricing promise.

## How the functionality works

The model must call a submission tool. Application code validates the tool arguments, checks cited values against their source rows, and returns specific rejection reasons for a retry. A run that exhausts its attempts returns no accepted plan or creator response. The brand flow uses planner, writer, and reviewer stages; the creator flow handles metric explanations and caption drafts. See [Technique](docs/TECHNIQUE.md) and [Architecture](docs/ARCHITECTURE.md) for implementation details.

## Public sharing boundary

**Included:** the agent logic, validators, demo server, synthetic fixtures, tests, documentation, and example transcripts.

**Excluded:** the justnewme.com marketplace source, production integrations and credentials, private prompts or configuration, and real brand or creator data. The public demo does not read from justnewme.com's database or Instagram account. An application integrating these modules must supply its own authorized data and deployment controls.

Image variant generation, WhatsApp/Messenger delivery, and wiring into the live marketplace are outside this repository. The voice transcription adapter is present, but a live call requires a separate API key and is not part of the default demo.

Before contributing, read [AGENTS.md](AGENTS.md) for the code invariants and [SECURITY.md](SECURITY.md) for safe reporting. Do not commit credentials, personal data, or production exports. Code is licensed under [Apache-2.0](LICENSE).
