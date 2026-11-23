import { YEARS_ALIASES } from './bank-keys';
import { salaryAnswer } from './salary';
import { extractSkills } from './skills';
import { normalize, similarity } from './text';
import type { BankEntry, FieldOption, FieldQuestion, JobAnalysis, ResolvedAnswer } from './types';

export interface AnswerContext {
  bank: BankEntry[];
  job: JobAnalysis;
  siteLabel: string;
  /** Company name, used in a few rules. */
  company: string;
}

const BANK_THRESHOLD = 0.58;

export function bankGet(bank: BankEntry[], key: string, lang: 'pt' | 'en' = 'pt'): string | null {
  const e = bank.find((b) => b.key === key);
  if (!e || !e.answer.trim()) return null;
  return lang === 'en' && e.answerEn ? e.answerEn : e.answer;
}

type Rule = { test: RegExp; answer: (q: FieldQuestion, ctx: AnswerContext) => string | string[] | null };

const RULES: Rule[] = [
  { test: /\be ?mail\b/, answer: (_q, c) => bankGet(c.bank, 'contact.email') },
  {
    test: /\b(primeiro nome|first name|given name|nome \(primeiro\))\b/,
    answer: (_q, c) => bankGet(c.bank, 'contact.fullName')?.split(/\s+/)[0] ?? null,
  },
  {
    test: /\b(sobrenome|ultimo nome|last name|surname|family name)\b/,
    answer: (_q, c) => bankGet(c.bank, 'contact.fullName')?.split(/\s+/).slice(1).join(' ') || null,
  },
  { test: /^(nome|nome completo|full name|name|seu nome|your name|legal name)\s?\*?$/, answer: (_q, c) => bankGet(c.bank, 'contact.fullName') },
  { test: /\b(telefone|celular|phone|mobile|whatsapp)\b/, answer: (_q, c) => bankGet(c.bank, 'contact.phone') },
  { test: /\blinkedin\b/, answer: (_q, c) => bankGet(c.bank, 'links.linkedin') },
  { test: /\bgithub\b/, answer: (_q, c) => bankGet(c.bank, 'links.github') },
  { test: /\b(portfolio|website|site pessoal|personal site|web site)\b/, answer: (_q, c) => bankGet(c.bank, 'links.portfolio') },
  { test: /^(cep|zip|zip code|postal code|codigo postal)\b/, answer: (_q, c) => bankGet(c.bank, 'address.zip') },
  { test: /^(bairro|neighborhood)\b/, answer: (_q, c) => bankGet(c.bank, 'address.neighborhood') },
  { test: /^(cidade|city)\b/, answer: (_q, c) => bankGet(c.bank, 'address.cityState')?.split(',')[0]?.trim() ?? null },
  { test: /^(estado|state|uf)\b/, answer: (_q, c) => bankGet(c.bank, 'address.cityState')?.split(',')[1]?.trim() ?? null },
  { test: /^(pais|country)\b/, answer: (_q, c) => (c.job.lang === 'en' ? 'Brazil' : bankGet(c.bank, 'address.country')) },
  {
    test: /\b(localizacao|location|onde voce mora|where are you (located|based)|current location)\b/,
    answer: (_q, c) => {
      const cs = bankGet(c.bank, 'address.cityState');
      return cs ? `${cs}, ${c.job.lang === 'en' ? 'Brazil' : 'Brasil'}` : null;
    },
  },
  {
    test: /\b(pretensao|salari|remunera|compensation|salary|expected pay|desired pay|pay expectation|rate expectation|hourly rate)\b/,
    answer: (q, c) => {
      const s = salaryAnswer({ question: q.label, job: c.job, lookup: (k) => bankGet(c.bank, k) });
      if (!s) return null;
      return q.type === 'number' ? String(s.amount) : s.text;
    },
  },
  {
    test: /\b(como (voce )?(soube|conheceu|ficou sabendo|encontrou)|onde (voce )?(viu|encontrou)|how did you (hear|find|learn)|where did you (hear|find|see)|referral source|source of application)\b/,
    answer: (_q, c) => [c.siteLabel, 'Job board', 'Company website', 'Site da empresa', 'Other', 'Outro', 'Outros', 'Internet'],
  },
];

/** Deterministic answer: rules, then years-of-experience, then the bank. No AI. */
export function resolveAnswer(q: FieldQuestion, ctx: AnswerContext): ResolvedAnswer | null {
  const label = normalize(q.label);
  if (!label) return null;

  for (const rule of RULES) {
    if (rule.test.test(label)) {
      const v = rule.answer(q, ctx);
      for (const candidate of Array.isArray(v) ? v : v ? [v] : []) {
        const done = finish(q, { value: candidate, source: 'rule', confidence: 0.95 });
        if (done) return done;
      }
    }
  }

  if (/(anos|years|yrs).{0,40}experien|experien.{0,50}(anos|years)|how (many|long).{0,40}(experience|worked|used)|quantos anos|tempo de experiencia|tempo de atuacao/.test(label)) {
    const skill = extractSkills(label)[0];
    const key = skill ? `years.${YEARS_ALIASES[skill] ?? skill}` : 'years.total';
    const v = bankGet(ctx.bank, key) ?? (skill ? null : bankGet(ctx.bank, 'years.frontend'));
    if (v) return finish(q, { value: v, source: 'rule', confidence: 0.9 });
    if (skill) return null; // unknown years for this skill → ask the candidate, never guess
  }

  let best: { e: BankEntry; s: number } | null = null;
  for (const e of ctx.bank) {
    if (!e.answer.trim()) continue;
    const s = Math.max(similarity(q.label, e.questionPt), similarity(q.label, e.questionEn), ...e.variants.map((v) => similarity(q.label, v)));
    if (!best || s > best.s) best = { e, s };
  }
  if (best && best.s >= BANK_THRESHOLD) {
    const value = ctx.job.lang === 'en' && best.e.answerEn ? best.e.answerEn : best.e.answer;
    const open = best.e.kind === 'Aberta';
    if (open && ctx.job.lang === 'en' && !best.e.answerEn) {
      return { value, source: 'bank', confidence: 0.4, note: 'needs-translation' };
    }
    return finish(q, { value, source: 'bank', confidence: best.s });
  }
  return null;
}

/** For choice fields, turns an answer into one of the options, or null if none fits. */
function finish(q: FieldQuestion, a: ResolvedAnswer): ResolvedAnswer | null {
  if (q.type !== 'select' && q.type !== 'radio' && !(q.type === 'checkbox' && q.options.length > 1)) return a;
  const opt = mapOption(a.value, q.options);
  return opt ? { ...a, value: opt.value } : null;
}

const YES = /^(sim|yes|y|true|claro|concordo|i agree|agree|aceito|accept)\b/;
const NO = /^(nao|no|n|false|discordo|decline)\b/;

export function mapOption(answer: string, options: FieldOption[]): FieldOption | null {
  const usable = options.filter((o) => normalize(o.label) && !/^(selecione|select|choose|escolha|--)/.test(normalize(o.label)));
  if (usable.length === 0) return null;
  const a = normalize(answer);

  const exact = usable.find((o) => normalize(o.label) === a || normalize(o.value) === a);
  if (exact) return exact;

  if (YES.test(a)) return usable.find((o) => YES.test(normalize(o.label))) ?? null;
  if (NO.test(a)) return usable.find((o) => NO.test(normalize(o.label))) ?? null;

  const n = Number(a.replace(',', '.').match(/^\d+(\.\d+)?/)?.[0]);
  if (Number.isFinite(n)) {
    for (const o of usable) {
      const l = normalize(o.label);
      const range = l.match(/(\d+)\s*(?:-|a|to|ate)\s*(\d+)/);
      if (range && n >= Number(range[1]) && n <= Number(range[2])) return o;
      const plus = l.match(/(\d+)\s*\+|mais de (\d+)|more than (\d+)|over (\d+)/);
      const p = plus ? Number(plus[1] ?? plus[2] ?? plus[3] ?? plus[4]) : NaN;
      if (Number.isFinite(p) && n >= p) return o;
      const less = l.match(/menos de (\d+)|less than (\d+)|under (\d+)|< ?(\d+)/);
      const m = less ? Number(less[1] ?? less[2] ?? less[3] ?? less[4]) : NaN;
      if (Number.isFinite(m) && n < m) return o;
    }
  }

  let best: { o: FieldOption; s: number } | null = null;
  for (const o of usable) {
    const s = Math.max(similarity(answer, o.label), normalize(o.label).includes(a) || a.includes(normalize(o.label)) ? 0.8 : 0);
    if (!best || s > best.s) best = { o, s };
  }
  return best && best.s >= 0.34 ? best.o : null;
}
