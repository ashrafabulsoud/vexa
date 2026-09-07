/**
 * ElevenLabs Scribe adapter (P5): the wire carries xi-api-key + model_id against
 * /v1/speech-to-text, and their JSON maps onto TranscriptionResult without leaking
 * Scribe vocabulary into the pipeline. Stubs global fetch.
 * Run: npx tsx src/elevenlabs.test.ts
 */
import { TranscriptionClient, TranscriptionError, mapElevenLabsTranscript, sttEndpoint, resolveTranscriptionBackend } from './index.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

const realFetch = globalThis.fetch;
const pcm = new Float32Array(1600).fill(0.05);

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function captureFetch(status: number, json: unknown): () => Captured {
  let captured: Captured = { url: '', headers: {}, body: '' };
  (globalThis as any).fetch = async (url: unknown, init: { headers?: Record<string, string>; body: Buffer }) => {
    captured = {
      url: String(url),
      headers: init.headers ?? {},
      body: Buffer.from(init.body).toString('latin1'),
    };
    return new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json' } });
  };
  return () => captured;
}

function formPart(body: string, name: string): string | null {
  const m = body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`));
  return m ? m[1] : null;
}

async function run() {
  check('hostname api.elevenlabs.io → elevenlabs',
    resolveTranscriptionBackend('https://api.elevenlabs.io') === 'elevenlabs');
  check('residency host → elevenlabs',
    resolveTranscriptionBackend('https://api.eu.residency.elevenlabs.io') === 'elevenlabs');
  check('explicit elevenlabs wins over openai host',
    resolveTranscriptionBackend('https://stt.internal', 'elevenlabs') === 'elevenlabs');
  check('openai host stays openai',
    resolveTranscriptionBackend('https://api.openai.com') === 'openai');
  check('endpoint for elevenlabs is /v1/speech-to-text',
    sttEndpoint('https://api.elevenlabs.io') === 'https://api.elevenlabs.io/v1/speech-to-text');
  check('full Scribe path is not double-appended',
    sttEndpoint('https://api.elevenlabs.io/v1/speech-to-text') === 'https://api.elevenlabs.io/v1/speech-to-text');
  check('mistaken OpenAI path on an ElevenLabs host is rewritten',
    sttEndpoint('https://api.elevenlabs.io/v1/audio/transcriptions') === 'https://api.elevenlabs.io/v1/speech-to-text');

  const scribe = {
    text: 'Hello world',
    language_code: 'eng',
    language_probability: 0.98,
    audio_duration_secs: 1.2,
    words: [
      { text: 'Hello', type: 'word', start: 0, end: 0.4, logprob: -0.1 },
      { text: ' ', type: 'spacing', start: 0.4, end: 0.41 },
      { text: 'world', type: 'word', start: 0.41, end: 0.9, logprob: -0.2 },
      { text: '(laughter)', type: 'audio_event', start: 0.9, end: 1.1 },
    ],
  };

  {
    const mapped = mapElevenLabsTranscript(scribe, 'en');
    check('Scribe text is preserved', mapped.text === 'Hello world');
    check('eng normalizes to en', mapped.language === 'en');
    check('spacing + audio_event words are dropped', mapped.segments[0].words?.length === 2,
      JSON.stringify(mapped.segments[0].words));
    check('duration comes from audio_duration_secs', mapped.duration === 1.2);
    check('avg_logprob is the mean of spoken-word logprobs',
      Math.abs((mapped.segments[0].avg_logprob ?? 0) - (-0.15)) < 1e-9,
      String(mapped.segments[0].avg_logprob));
  }

  {
    const cap = captureFetch(200, scribe);
    const client = new TranscriptionClient({
      serviceUrl: 'https://api.elevenlabs.io',
      apiToken: 'xi-test',
    });
    const result = await client.transcribe(pcm, 'en');
    const seen = cap();
    check('POST targets /v1/speech-to-text', seen.url === 'https://api.elevenlabs.io/v1/speech-to-text', seen.url);
    check('auth is xi-api-key, not Bearer',
      seen.headers['xi-api-key'] === 'xi-test' && !seen.headers.Authorization,
      JSON.stringify(seen.headers));
    check('unconfigured model defaults to scribe_v2', formPart(seen.body, 'model_id') === 'scribe_v2',
      String(formPart(seen.body, 'model_id')));
    check('OpenAI model form part is absent', formPart(seen.body, 'model') === null);
    check('language rides language_code', formPart(seen.body, 'language_code') === 'en');
    check('audio events are not tagged', formPart(seen.body, 'tag_audio_events') === 'false');
    check('transcribe() returns mapped text', result.text === 'Hello world', result.text);
    check('transcribe() returns two-letter language', result.language === 'en', result.language);
  }

  {
    const cap = captureFetch(200, { text: 'ok', words: [] });
    const client = new TranscriptionClient({
      serviceUrl: 'http://stt.proxy.internal',
      backend: 'elevenlabs',
      model: 'scribe_v1',
      apiToken: 'k',
    });
    await client.transcribe(pcm);
    const seen = cap();
    check('explicit backend on a private host still uses Scribe path',
      seen.url === 'http://stt.proxy.internal/v1/speech-to-text', seen.url);
    check('configured model_id rides the wire', formPart(seen.body, 'model_id') === 'scribe_v1');
  }

  {
    (globalThis as any).fetch = async () => new Response('quota', { status: 401 });
    const client = new TranscriptionClient({
      serviceUrl: 'https://api.elevenlabs.io',
      apiToken: 'bad',
      maxRetries: 0,
    });
    let err: unknown;
    try { await client.transcribe(pcm); } catch (e) { err = e; }
    check('401 becomes typed unauthorized',
      err instanceof TranscriptionError && err.kind === 'unauthorized' && err.retryable === false);
  }

  {
    // OpenAI path is unchanged when the host is not ElevenLabs.
    const cap = captureFetch(200, { text: 'ok', language: 'en', duration: 0.1, segments: [] });
    const client = new TranscriptionClient({ serviceUrl: 'http://stt.test', apiToken: 'tok' });
    await client.transcribe(pcm);
    const seen = cap();
    check('default backend still posts /v1/audio/transcriptions',
      seen.url === 'http://stt.test/v1/audio/transcriptions', seen.url);
    check('default auth remains Bearer', seen.headers.Authorization === 'Bearer tok');
    check('default model remains whisper-1', formPart(seen.body, 'model') === 'whisper-1');
  }

  (globalThis as any).fetch = realFetch;
  if (failed) { console.error(`\n❌ elevenlabs stt: ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\n✅ elevenlabs stt (P5): Scribe dialect is adapted at the egress; OpenAI-compatible wire is unchanged.');
}
run().catch((e) => { console.error(e); process.exit(1); });
