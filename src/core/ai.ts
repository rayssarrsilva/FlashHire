import { redact } from './redact';
import type { Lang } from './types';

export type AiProvider =
  | { kind: 'gemini'; apiKey: string; model: string }
  | { kind: 'groq'; apiKey: string; model: string }
  | { kind: 'openai-compatible'; baseUrl: string; apiKey: string; model: string };

export const DEFAULT_MODELS = { gemini: 'gemini-flash-lite-latest', groq: 'llama-3.3-70b-versatile' } as const;

export class AiClient {
  private calls = 0;
  constructor(
    private providers: AiProvider[],
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get enabled(): boolean {
    return this.providers.length > 0;
  }

  get usedToday(): number {
    return this.calls;
  }

  /** Tries each provider in order; returns null when none answers (quota, offline, no key). */
  async complete(system: string, user: string): Promise<string | null> {
    const safeUser = redact(user);
    for (const p of this.providers) {
      try {
        const text = await this.call(p, system, safeUser);
        if (text) {
          this.calls++;
          return text.trim();
        }
      } catch {
        // quota (429), network or model error → next provider
      }
    }
    return null;
  }

  private async call(p: AiProvider, system: string, user: string): Promise<string | null> {
    const signal = AbortSignal.timeout(30_000);
    if (p.kind === 'gemini') {
      const res = await this.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': p.apiKey },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 700 },
        }),
        signal,
      });
      if (!res.ok) throw new Error(`gemini ${res.status}`);
      const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return data.candidates?.[0]?.content?.parts?.map((x) => x.text ?? '').join('') ?? null;
    }
    const baseUrl = p.kind === 'groq' ? 'https://api.groq.com/openai/v1' : p.baseUrl.replace(/\/$/, '');
    const res = await this.fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${p.apiKey}` },
      body: JSON.stringify({
        model: p.model,
        temperature: 0.4,
        max_tokens: 700,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal,
    });
    if (!res.ok) throw new Error(`${p.kind} ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? null;
  }
}

export interface AiAnswerInput {
  question: string;
  options: string[];
  lang: Lang;
  facts: string;
  style: string;
  jobTitle: string;
  company: string;
  jobSummary: string;
  maxWords: number;
}

const UNKNOWN = 'UNKNOWN';

export function answerPrompt(i: AiAnswerInput): { system: string; user: string } {
  const language = i.lang === 'pt' ? 'Brazilian Portuguese' : 'American English';
  const system = [
    `You fill job application forms on behalf of the candidate, writing in ${language}, in the first person.`,
    'Use ONLY the facts provided. Never invent, inflate or assume experience, numbers, dates or skills.',
    `If the facts do not answer the question, reply with exactly ${UNKNOWN}.`,
    'If options are listed, reply with exactly one option, copied as written.',
    `Keep it under ${i.maxWords} words. No greetings, no markdown, no emojis.`,
    'Follow this writing style guide:',
    i.style,
  ].join('\n');
  const user = [
    `Job: ${i.jobTitle} at ${i.company}`,
    `Job summary: ${i.jobSummary.slice(0, 1500)}`,
    `Candidate facts:\n${i.facts.slice(0, 6000)}`,
    `Question: ${i.question}`,
    i.options.length ? `Options: ${i.options.join(' | ')}` : '',
  ].join('\n\n');
  return { system, user };
}

export function isUnknown(text: string | null): boolean {
  return !text || text.trim().toUpperCase().startsWith(UNKNOWN);
}

export function translatePrompt(text: string, to: Lang, style: string): { system: string; user: string } {
  return {
    system: `Translate the candidate's answer to ${to === 'en' ? 'American English' : 'Brazilian Portuguese'}. Keep every fact, add nothing. Plain text only.\nStyle guide:\n${style}`,
    user: text,
  };
}
