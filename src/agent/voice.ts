/**
 * The voice path: a creator's voice memo in, text out.
 *
 * WHY THIS FILE EXISTS:
 *
 * A creator does not want to type "why did my last three posts flop?". They
 * talk. The format they already use is a voice memo, so the agent has to be
 * reachable in that format - Muse Voice Transcribe turns the memo into text,
 * and that text becomes the creator's question.
 *
 * The interesting property of this path is not the transcription. It is that
 * the SAME transcript then goes through the SAME tool-calling contract as the
 * brand's side: the model calls a tool, the application validates the
 * arguments, and a rejected call comes back with the exact reason. A voice
 * memo is not a loophole around the validator.
 *
 * The transcriber is a port with two implementations: one that calls the real
 * model, and one that is scripted for the demo and the tests. The scripted one
 * stands in for the MODEL, exactly as the demo's scripted model stands in for
 * the model - the validator and the guard are the real production code in
 * every run.
 */

export type VoiceMemo = {
  /** The audio bytes. */
  bytes: Uint8Array;
  /** The mime type of the bytes, e.g. "audio/wav". */
  mimeType: string;
  /** The file name sent to the API. */
  filename: string;
};

export type Transcription = {
  /** What the creator said. */
  text: string;
  /** The model that produced it, when the API reports one. */
  model?: string;
};

export type Transcriber = {
  transcribe(memo: VoiceMemo): Promise<Transcription>;
};

/**
 * Muse Voice Transcribe, on the Meta Model API.
 *
 * The base URL and the model id are overridable because the vendor names both
 * in its own model page and those names are the vendor's to change; the
 * default here is the one this project is built against.
 */
export const MUSE_VOICE_MODEL = "muse-voice-transcribe";
export const META_MODEL_API_BASE = "https://api.llama.com/v1";

/**
 * The live transcriber.
 *
 * The audio goes up as multipart form data on the OpenAI-compatible
 * `/audio/transcriptions` route, which is the shape this project already
 * speaks to Baseten with. The key is read from the environment at call time -
 * never from a file, never from an argument, never from a log.
 */
export function museVoiceTranscriber(args?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}): Transcriber {
  const baseUrl = args?.baseUrl ?? process.env.MUSE_VOICE_BASE_URL ?? META_MODEL_API_BASE;
  const model = args?.model ?? process.env.MUSE_VOICE_MODEL ?? MUSE_VOICE_MODEL;
  const doFetch = args?.fetchImpl ?? fetch;

  return {
    async transcribe(memo: VoiceMemo): Promise<Transcription> {
      const apiKey = args?.apiKey ?? process.env.MUSE_VOICE_API_KEY ?? process.env.LLAMA_API_KEY;
      if (!apiKey) {
        throw new Error(
          "no voice API key: set MUSE_VOICE_API_KEY (or LLAMA_API_KEY) to transcribe a memo",
        );
      }

      const form = new FormData();
      form.append(
        "file",
        new Blob([memo.bytes as unknown as BlobPart], { type: memo.mimeType }),
        memo.filename,
      );
      form.append("model", model);

      const res = await doFetch(`${baseUrl.replace(/\/+$/, "")}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });

      if (!res.ok) {
        throw new Error(`the voice model returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      }

      const data: any = await res.json();
      const text = typeof data?.text === "string" ? data.text : "";
      if (!text) {
        throw new Error("the voice model returned no transcript");
      }
      return { text, model: typeof data?.model === "string" ? data.model : model };
    },
  };
}

/**
 * The scripted transcriber: it stands in for the model and returns a fixed
 * memo. Used by the demo and by the tests, so both can exercise the real
 * audio path without a key and without a network.
 */
export function scriptedTranscriber(text: string): Transcriber {
  return {
    async transcribe(): Promise<Transcription> {
      return { text, model: "the scripted transcriber (no API key needed)" };
    },
  };
}

/**
 * Build a valid, silent WAV.
 *
 * The demo and the tests need REAL audio bytes to put through the real
 * upload path, and a repository should not carry a binary fixture for that.
 * A silent PCM WAV is a few lines of header, and it exercises exactly the
 * same code path a recorded memo would.
 */
export function buildSilentWav(seconds = 1, sampleRate = 8000): Uint8Array {
  const samples = Math.max(1, Math.floor(seconds * sampleRate));
  const dataBytes = samples * 2; // 16-bit mono
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // the fmt chunk's size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  return new Uint8Array(buffer);
}
