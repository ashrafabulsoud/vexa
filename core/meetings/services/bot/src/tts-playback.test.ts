/**
 * TTS request builder (OpenAI-compatible vs ElevenLabs) — offline, no paplay.
 * Run: npx tsx src/tts-playback.test.ts
 */
import { buildTtsRequest, resolveTtsBackend } from './tts-playback.js';

let failed = 0;
const check = (name: string, cond: boolean, detail = '') => {
  console.log(`  ${cond ? '✅' : '❌'} ${name}${cond ? '' : '  — ' + detail}`);
  if (!cond) failed++;
};

function run() {
  check('elevenlabs.io host → elevenlabs dialect',
    resolveTtsBackend('https://api.elevenlabs.io') === 'elevenlabs');
  check('explicit backend on a private host → elevenlabs',
    resolveTtsBackend('https://tts.internal', 'elevenlabs') === 'elevenlabs');
  check('openai host stays openai',
    resolveTtsBackend('https://api.openai.com') === 'openai');

  {
    const built = buildTtsRequest({ serviceUrl: '', text: 'hi' });
    check('missing URL is a skip, not a throw', 'skip' in built);
  }

  {
    const built = buildTtsRequest({
      serviceUrl: 'https://api.elevenlabs.io',
      token: 'xi-test',
      text: 'hello from the bot',
      voice: 'auto',
      voiceId: '21m00Tcm4TlvDq8ikWAM',
    });
    if ('skip' in built) {
      check('ElevenLabs request built', false, built.skip);
    } else {
      check('ElevenLabs path is /v1/text-to-speech/{id}/stream',
        built.url.pathname === '/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM/stream',
        built.url.pathname);
      check('PCM 24 kHz matches paplay', built.url.searchParams.get('output_format') === 'pcm_24000');
      check('auth is xi-api-key', built.headers['xi-api-key'] === 'xi-test');
      const body = JSON.parse(built.body);
      check('default model is flash (meeting-latency)', body.model_id === 'eleven_flash_v2_5', body.model_id);
      check('text rides the JSON body', body.text === 'hello from the bot');
    }
  }

  {
    const built = buildTtsRequest({
      serviceUrl: 'https://api.elevenlabs.io',
      text: 'hi',
      voice: 'auto',
    });
    check('ElevenLabs without a voice id is a loud no-op',
      'skip' in built && /TTS_VOICE_ID/.test(built.skip), JSON.stringify(built));
  }

  {
    const built = buildTtsRequest({
      serviceUrl: 'https://api.elevenlabs.io',
      text: 'hi',
      voice: 'JBFqnCBsd6RMkjVDRZzb',
    });
    check('acts.v1 voice wins over TTS_VOICE_ID',
      !('skip' in built) && built.url.pathname.includes('JBFqnCBsd6RMkjVDRZzb'));
  }

  {
    const built = buildTtsRequest({
      serviceUrl: 'http://tts.test',
      token: 'k',
      text: 'hello',
      voice: 'alloy',
    });
    if ('skip' in built) {
      check('OpenAI request built', false, built.skip);
    } else {
      check('OpenAI path is still /v1/audio/speech', built.url.pathname === '/v1/audio/speech');
      check('OpenAI auth is still X-API-Key', built.headers['X-API-Key'] === 'k');
      const body = JSON.parse(built.body);
      check('OpenAI body keeps pcm + tts-1', body.model === 'tts-1' && body.response_format === 'pcm' && body.voice === 'alloy');
    }
  }

  if (failed) { console.error(`\n❌ tts-playback: ${failed} check(s) FAILED.`); process.exit(1); }
  console.log('\n✅ tts-playback: ElevenLabs stream request is pcm_24000; OpenAI-compatible speech path is unchanged.');
}
run();
