/**
 * Anti-corruption map: ElevenLabs Scribe JSON → TranscriptionResult (P5).
 * Their vocabulary (language_code, word types, logprob) never leaves this file.
 */
import type { TranscriptionResult, TranscriptionSegment, TranscriptionWord } from './transcription-client.js';

/** Common ISO 639-3 → 639-1 so downstream language pins stay two-letter. */
const ISO3_TO_1: Record<string, string> = {
  eng: 'en', spa: 'es', fra: 'fr', deu: 'de', ita: 'it', por: 'pt', nld: 'nl',
  rus: 'ru', zho: 'zh', jpn: 'ja', kor: 'ko', ara: 'ar', hin: 'hi', tur: 'tr',
  pol: 'pl', ukr: 'uk', vie: 'vi', tha: 'th', swe: 'sv', dan: 'da', fin: 'fi',
  nor: 'no', ces: 'cs', hun: 'hu', ron: 'ro', ell: 'el', heb: 'he', ind: 'id',
};

export interface ElevenLabsWord {
  text?: string;
  type?: string;
  start?: number;
  end?: number;
  logprob?: number;
}

export interface ElevenLabsTranscript {
  text?: string;
  language_code?: string;
  language_probability?: number;
  audio_duration_secs?: number;
  words?: ElevenLabsWord[];
}

export function mapElevenLabsTranscript(
  data: ElevenLabsTranscript,
  fallbackLanguage?: string,
): TranscriptionResult {
  const spoken = (data.words ?? []).filter((w) => (w.type ?? 'word') === 'word' && (w.text ?? '').trim());
  const words: TranscriptionWord[] = spoken.map((w) => ({
    word: (w.text ?? '').trim(),
    start: w.start ?? 0,
    end: w.end ?? 0,
    probability: logprobToProbability(w.logprob),
  }));
  const logprobs = spoken.map((w) => w.logprob).filter((n): n is number => typeof n === 'number');
  const avgLogprob = logprobs.length
    ? logprobs.reduce((a, b) => a + b, 0) / logprobs.length
    : undefined;
  const start = words.length ? words[0].start : 0;
  const end = words.length ? words[words.length - 1].end : (data.audio_duration_secs ?? 0);
  const text = (data.text || words.map((w) => w.word).join(' ')).trim();
  const segment: TranscriptionSegment = {
    start,
    end,
    text,
    avg_logprob: avgLogprob,
    words,
  };
  return {
    text,
    language: normalizeLanguage(data.language_code, fallbackLanguage),
    language_probability: data.language_probability ?? 0,
    duration: data.audio_duration_secs ?? end,
    segments: text ? [segment] : [],
  };
}

function logprobToProbability(logprob: number | undefined): number {
  if (typeof logprob !== 'number' || !Number.isFinite(logprob)) return 1;
  return Math.min(1, Math.max(0, Math.exp(logprob)));
}

function normalizeLanguage(code: string | undefined, fallback?: string): string {
  const raw = (code || fallback || 'unknown').toLowerCase();
  if (raw.length === 2) return raw;
  return ISO3_TO_1[raw] ?? raw;
}
