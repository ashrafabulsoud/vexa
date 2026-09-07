/** POST /api/stt[?prompt=…] — speech-to-text proxy for composer dictation.
 *
 *  Body: audio/wav (16 kHz mono PCM from ui-kit/micDictation). Forwards to the same
 *  transcription service the meeting pipeline uses (`TRANSCRIPTION_SERVICE_URL`).
 *  OpenAI-compatible `/v1/audio/transcriptions` by default; ElevenLabs Scribe
 *  `/v1/speech-to-text` when the host (or TRANSCRIPTION_BACKEND) selects it —
 *  see @vexa/transcribe-whisper. `prompt` carries already-confirmed text for
 *  streaming continuity (same as the meeting pipeline). Returns `{ text, words }`
 *  — word timestamps drive the client's LocalAgreement confirm/trim. The STT
 *  token stays server-side.
 */
import { NextResponse } from "next/server";
import { resolveApiKey } from "../proxyAuth";
import { isElevenLabsStt, sttEndpoint } from "./endpoint";

export const runtime = "nodejs";

const MAX_BYTES = 25 * 1024 * 1024; // ~13 min of 16 kHz WAV — far beyond any dictation window

interface UpstreamWord { word?: string; start?: number; end?: number }
interface UpstreamSegment { text?: string; words?: UpstreamWord[] }

export async function POST(req: Request): Promise<NextResponse> {
  // Auth gate: this forwards to the shared transcription service with a server-side
  // bearer token. Without a check it's an open, credentialed Whisper proxy (cost/abuse
  // vector) — require the same per-user key every other proxy route resolves.
  if (!(await resolveApiKey())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const base = (process.env.TRANSCRIPTION_SERVICE_URL ?? "").replace(/\/+$/, "");
  if (!base) return NextResponse.json({ error: "Transcription is not configured (TRANSCRIPTION_SERVICE_URL)" }, { status: 503 });
  const endpoint = sttEndpoint(base);

  const wav = await req.arrayBuffer();
  if (wav.byteLength < 100) return NextResponse.json({ error: "Empty recording" }, { status: 400 });
  if (wav.byteLength > MAX_BYTES) return NextResponse.json({ error: "Recording too long" }, { status: 413 });

  const prompt = new URL(req.url).searchParams.get("prompt") ?? "";

  const form = new FormData();
  form.append("file", new Blob([wav], { type: "audio/wav" }), "dictation.wav");
  const elevenlabs = isElevenLabsStt(base);
  const headers: Record<string, string> = {};
  const token = process.env.TRANSCRIPTION_SERVICE_TOKEN;
  if (elevenlabs) {
    form.append("model_id", process.env.TRANSCRIPTION_MODEL || "scribe_v2");
    form.append("timestamps_granularity", "word");
    form.append("tag_audio_events", "false");
    if (token) headers["xi-api-key"] = token;
  } else {
    form.append("model", process.env.TRANSCRIPTION_MODEL || "whisper-1");
    form.append("response_format", "verbose_json");
    form.append("timestamp_granularities", "word");
    if (prompt) form.append("prompt", prompt.slice(0, 800));
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  try {
    const r = await fetch(endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(30000) });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      return NextResponse.json({ error: `Transcription failed (${r.status})`, detail: detail.slice(0, 300) }, { status: 502 });
    }
    const data = (await r.json()) as {
      text?: string;
      segments?: UpstreamSegment[];
      words?: Array<{ text?: string; type?: string; start?: number; end?: number }>;
    };
    const words = elevenlabs
      ? (data.words ?? [])
          .filter((w) => (w.type ?? "word") === "word" && typeof w.text === "string")
          .map((w) => ({ word: (w.text as string).trim(), start: w.start ?? 0, end: w.end ?? 0 }))
      : (data.segments ?? []).flatMap((s) => s.words ?? [])
          .filter((w) => typeof w.word === "string")
          .map((w) => ({ word: w.word as string, start: w.start ?? 0, end: w.end ?? 0 }));
    return NextResponse.json({ text: (data.text ?? "").trim(), words });
  } catch (err) {
    const timeout = err instanceof Error && err.name === "TimeoutError";
    return NextResponse.json({ error: timeout ? "Transcription timed out" : "Transcription unreachable" }, { status: 502 });
  }
}
