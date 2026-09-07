/** The one URL rule for `TRANSCRIPTION_SERVICE_URL`, shared by every consumer.
 *
 *  The env var is accepted in BOTH shapes an operator naturally writes: a bare base
 *  (`https://api.openai.com`) and the full endpoint (`https://api.openai.com/v1/audio/transcriptions`).
 *  The path is appended only when it is not already there — appending blindly double-paths the full
 *  shape into a 404, so the same URL that transcribes a meeting would fail dictation.
 *
 *  ElevenLabs Scribe is selected when the hostname is under elevenlabs.io or
 *  `TRANSCRIPTION_BACKEND=elevenlabs`. Same rule as `@vexa/transcribe-whisper` and the
 *  config.v1 boot probe.
 */
export const STT_PATH = "/v1/audio/transcriptions";
export const ELEVENLABS_STT_PATH = "/v1/speech-to-text";

export function isElevenLabsStt(configuredUrl: string, backend?: string): boolean {
  const explicit = (backend ?? process.env.TRANSCRIPTION_BACKEND ?? "").trim().toLowerCase();
  if (explicit === "elevenlabs") return true;
  try {
    const raw = (configuredUrl ?? "").trim();
    const host = new URL(/:\/\//.test(raw) ? raw : `https://${raw}`).hostname.toLowerCase();
    return host === "elevenlabs.io" || host.endsWith(".elevenlabs.io");
  } catch {
    return false;
  }
}

export function sttEndpoint(configuredUrl: string, backend?: string): string {
  const base = (configuredUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return "";
  const elevenlabs = isElevenLabsStt(base, backend);
  const path = elevenlabs ? ELEVENLABS_STT_PATH : STT_PATH;
  let stripped = base;
  for (const suffix of [STT_PATH, ELEVENLABS_STT_PATH]) {
    if (stripped.endsWith(suffix)) {
      stripped = stripped.slice(0, -suffix.length);
      break;
    }
  }
  return `${stripped}${path}`;
}
