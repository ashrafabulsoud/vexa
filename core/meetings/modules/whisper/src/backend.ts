/**
 * STT backend selection at the egress (P5): ElevenLabs Scribe is adapted here, never leaked
 * into the meeting pipeline. OpenAI-compatible remains the default.
 *
 * Selection: an explicit `elevenlabs` backend wins; otherwise a hostname under elevenlabs.io
 * (api.elevenlabs.io, residency hosts) selects Scribe. Everything else stays OpenAI-compatible.
 */

export type TranscriptionBackend = 'openai' | 'elevenlabs';

export const OPENAI_STT_PATH = '/v1/audio/transcriptions';
export const ELEVENLABS_STT_PATH = '/v1/speech-to-text';
export const ELEVENLABS_DEFAULT_MODEL = 'scribe_v2';
export const OPENAI_DEFAULT_MODEL = 'whisper-1';

const STT_SUFFIXES = [OPENAI_STT_PATH, ELEVENLABS_STT_PATH] as const;

export function resolveTranscriptionBackend(
  serviceUrl: string,
  backend?: string,
): TranscriptionBackend {
  const explicit = (backend ?? '').trim().toLowerCase();
  if (explicit === 'elevenlabs') return 'elevenlabs';
  if (explicit === 'openai' || explicit === 'openai-compat') return 'openai';
  const host = hostnameOf(serviceUrl);
  if (host === 'elevenlabs.io' || host.endsWith('.elevenlabs.io')) return 'elevenlabs';
  return 'openai';
}

/** Join a configured URL to the backend's transcriptions path without double-pathing. */
export function sttEndpoint(configuredUrl: string, backend?: string): string {
  const trimmed = (configuredUrl ?? '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  const resolved = resolveTranscriptionBackend(trimmed, backend);
  const path = resolved === 'elevenlabs' ? ELEVENLABS_STT_PATH : OPENAI_STT_PATH;
  return `${stripSttSuffix(trimmed)}${path}`;
}

export function defaultSttModel(backend: TranscriptionBackend, configured?: string): string {
  const model = (configured ?? '').trim();
  if (model) return model;
  return backend === 'elevenlabs' ? ELEVENLABS_DEFAULT_MODEL : OPENAI_DEFAULT_MODEL;
}

function stripSttSuffix(url: string): string {
  for (const suffix of STT_SUFFIXES) {
    if (url.endsWith(suffix)) return url.slice(0, -suffix.length);
  }
  return url;
}

function hostnameOf(url: string): string {
  try {
    const withScheme = /:\/\//.test(url) ? url : `https://${url}`;
    return new URL(withScheme).hostname.toLowerCase();
  } catch {
    return '';
  }
}
