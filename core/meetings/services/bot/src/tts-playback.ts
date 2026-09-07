/**
 * TTS playback adapter — the OS-level half of the SPEAK path.
 *
 * Synthesize `text` via the configured TTS backend and play the returned PCM through
 * the container's PulseAudio `tts_sink` (→ `virtual_mic`, which Chromium captures as its mic).
 * Two dialects at this egress (P5): OpenAI-compatible `/v1/audio/speech` (default) and
 * ElevenLabs `/v1/text-to-speech/{voice_id}/stream` with `pcm_24000`. Config is infrastructure
 * (TTS_SERVICE_URL / TTS_API_TOKEN / TTS_BACKEND / TTS_VOICE_ID / TTS_MODEL), read from env,
 * NOT the sealed invocation.v1. Gated by the SpeakController on inv.voiceAgentEnabled.
 *
 * Node-only (child_process + http/https) — no DOM, no workspace imports → gate:isolation-clean.
 */
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import https from 'node:https';
import http from 'node:http';

const PAPLAY_ARGS = ['--raw', '--format=s16le', '--rate=24000', '--channels=1', '--device=tts_sink'];
const ELEVENLABS_DEFAULT_MODEL = 'eleven_flash_v2_5';

function setTtsMute(muted: boolean, log: (m: string) => void): void {
  const v = muted ? '1' : '0';
  try {
    execSync(`pactl set-sink-mute tts_sink ${v}`, { stdio: 'pipe' });
    execSync(`pactl set-source-mute virtual_mic ${v}`, { stdio: 'pipe' });
  } catch (err) {
    log(`[tts] pactl ${muted ? 'mute' : 'unmute'} failed: ${(err as Error).message}`);
  }
}

export interface TtsPlayback {
  /** Synthesize `text` (voice optional) and play it into the meeting via tts_sink. Resolves when
   *  playback finishes. Best-effort: a synthesis/playback failure logs + resolves (never throws out
   *  — the voice handler must not break the orchestrator). */
  speak(text: string, voice?: string): Promise<void>;
  /** Interrupt any in-flight playback (barge-in) + re-mute. */
  stop(): void;
}

export type TtsBackend = 'openai' | 'elevenlabs';

export function resolveTtsBackend(serviceUrl: string, backend?: string): TtsBackend {
  const explicit = (backend ?? '').trim().toLowerCase();
  if (explicit === 'elevenlabs') return 'elevenlabs';
  if (explicit === 'openai' || explicit === 'openai-compat') return 'openai';
  try {
    const host = new URL(/:\/\//.test(serviceUrl) ? serviceUrl : `https://${serviceUrl}`).hostname.toLowerCase();
    if (host === 'elevenlabs.io' || host.endsWith('.elevenlabs.io')) return 'elevenlabs';
  } catch { /* */ }
  return 'openai';
}

export interface TtsRequest {
  url: URL;
  headers: Record<string, string>;
  body: string;
}

/** Build the HTTP request for one speak call. Returns a reason string when the call must no-op. */
export function buildTtsRequest(opts: {
  serviceUrl: string;
  token?: string;
  text: string;
  voice?: string;
  backend?: string;
  voiceId?: string;
  model?: string;
}): TtsRequest | { skip: string } {
  const base = opts.serviceUrl.trim().replace(/\/+$/, '');
  if (!base) return { skip: 'TTS_SERVICE_URL not set — speak is a no-op' };
  const dialect = resolveTtsBackend(base, opts.backend);
  if (dialect === 'elevenlabs') {
    const voiceId = elevenLabsVoiceId(opts.voice, opts.voiceId);
    if (!voiceId) {
      return { skip: 'TTS_VOICE_ID not set — ElevenLabs speak is a no-op' };
    }
    let url: URL;
    try {
      url = new URL(`${stripKnownTtsSuffix(base)}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`);
    } catch {
      return { skip: `bad TTS_SERVICE_URL: ${base}` };
    }
    url.searchParams.set('output_format', 'pcm_24000');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (opts.token) headers['xi-api-key'] = opts.token;
    const body = JSON.stringify({
      text: opts.text,
      model_id: (opts.model || '').trim() || ELEVENLABS_DEFAULT_MODEL,
    });
    return { url, headers, body };
  }
  let url: URL;
  try { url = new URL(`${stripKnownTtsSuffix(base)}/v1/audio/speech`); }
  catch { return { skip: `bad TTS_SERVICE_URL: ${base}` }; }
  const voice = opts.voice && opts.voice !== 'auto' ? opts.voice : (opts.voiceId || 'auto');
  const postData = JSON.stringify({
    model: (opts.model || '').trim() || 'tts-1',
    input: opts.text,
    voice,
    response_format: 'pcm',
  });
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(postData)),
  };
  if (opts.token) headers['X-API-Key'] = opts.token;
  return { url, headers, body: postData };
}

function elevenLabsVoiceId(voice: string | undefined, configured: string | undefined): string {
  const fromAct = (voice ?? '').trim();
  if (fromAct && fromAct !== 'auto') return fromAct;
  return (configured ?? '').trim();
}

function stripKnownTtsSuffix(url: string): string {
  for (const suffix of ['/v1/audio/speech', '/v1/text-to-speech']) {
    if (url.endsWith(suffix)) return url.slice(0, -suffix.length);
  }
  return url;
}

/** Build a TtsPlayback that streams the TTS service's PCM straight to paplay. */
export function createTtsPlayback(log: (m: string) => void = () => { /* */ }): TtsPlayback {
  let proc: ChildProcess | null = null;

  const stop = (): void => {
    if (proc) {
      try { proc.stdin?.destroy(); proc.kill('SIGKILL'); } catch { /* */ }
      proc = null;
    }
    setTtsMute(true, log);
  };

  const speak = async (text: string, voice = 'auto'): Promise<void> => {
    const built = buildTtsRequest({
      serviceUrl: process.env.TTS_SERVICE_URL ?? '',
      token: process.env.TTS_API_TOKEN,
      text,
      voice,
      backend: process.env.TTS_BACKEND,
      voiceId: process.env.TTS_VOICE_ID,
      model: process.env.TTS_MODEL,
    });
    if ('skip' in built) { log(`[tts] ${built.skip}`); return; }
    const { url, headers, body } = built;
    if (!headers['Content-Length']) headers['Content-Length'] = String(Buffer.byteLength(body));

    await new Promise<void>((resolve) => {
      const req = (url.protocol === 'https:' ? https : http).request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = ''; res.on('data', (c) => (errBody += c));
          res.on('end', () => { log(`[tts] service ${res.statusCode}: ${errBody.slice(0, 120)}`); resolve(); });
          return;
        }
        setTtsMute(false, log);
        const p = spawn('paplay', PAPLAY_ARGS, { stdio: ['pipe', 'pipe', 'pipe'] });
        proc = p;
        p.stderr?.on('data', (d: Buffer) => log(`[tts] paplay: ${d.toString().trim()}`));
        const done = () => { if (proc === p) proc = null; setTtsMute(true, log); resolve(); };
        p.on('exit', done);
        p.on('error', (e) => { log(`[tts] paplay error: ${String(e)}`); done(); });
        res.pipe(p.stdin!);
      });
      req.on('error', (e) => { log(`[tts] request error: ${String(e)}`); resolve(); });
      req.write(body); req.end();
    });
  };

  return { speak, stop };
}
