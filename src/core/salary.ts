import { normalize } from './text';
import type { Currency, JobAnalysis, Lang } from './types';

export type Period = 'month' | 'year' | 'hour';

/** Reads a money answer like "R$ 5.000 por mês" or "US$ 1,800" → 5000 / 1800. */
export function parseMoney(text: string): number | null {
  const m = text.match(/(\d{1,3}(?:[.,]\d{3})+|\d+(?:[.,]\d+)?)\s?(k|mil)?/i);
  if (!m) return null;
  let digits = m[1] ?? '';
  if (/[.,]\d{3}$/.test(digits)) digits = digits.replace(/[.,]/g, '');
  else digits = digits.replace(',', '.');
  let v = Number(digits);
  if (m[2]) v *= 1000;
  return Number.isFinite(v) ? v : null;
}

export interface SalaryContext {
  question: string;
  job: JobAnalysis;
  /** Looks up a salary key in the answer bank and returns the raw answer. */
  lookup: (key: string) => string | null;
}

export interface SalaryAnswer {
  amount: number;
  currency: Currency;
  period: Period;
  text: string;
}

export function salaryAnswer(ctx: SalaryContext): SalaryAnswer | null {
  const q = normalize(ctx.question);
  const raw = ctx.question;
  const period: Period = /\bhora|hour|hourly|\/h\b/.test(q) ? 'hour' : /\banual|\bano\b|annual|yearly|per year|per annum|\byear\b/.test(q) ? 'year' : 'month';
  const currency: Currency = /€|\beur\b|euro/i.test(raw)
    ? 'EUR'
    : /US\$|\busd\b|d[oó]lar|dollar/i.test(raw)
      ? 'USD'
      : /R\$|\bbrl\b|reais/i.test(raw)
        ? 'BRL'
        : ctx.job.currency;
  const level = ctx.job.seniority === 'mid' || ctx.job.seniority === 'senior' ? 'mid' : 'junior';

  let monthly: number | null = null;
  if (currency === 'USD') monthly = num(ctx.lookup(`salary.usd.${level}`));
  else if (currency === 'EUR') monthly = num(ctx.lookup(`salary.eur.${level}`));
  else {
    const role = ctx.job.role === 'qa' ? 'qa' : 'frontend';
    const regime = ctx.job.regime === 'pj' || ctx.job.regime === 'contractor' ? 'pj' : 'clt';
    monthly = num(ctx.lookup(`salary.${role}.${level}.${regime}`));
    if (monthly === null && regime === 'pj') {
      const clt = num(ctx.lookup(`salary.${role}.${level}.clt`));
      monthly = clt === null ? null : Math.round((clt * 1.3) / 100) * 100;
    }
  }
  if (monthly === null) return null;

  const amount = period === 'year' ? monthly * 12 : period === 'hour' ? Math.round(monthly / 160) : monthly;
  return { amount, currency, period, text: formatMoney(amount, currency, period, ctx.job.lang) };
}

export function formatMoney(amount: number, currency: Currency, period: Period, lang: Lang): string {
  const symbol = currency === 'BRL' ? 'R$' : currency === 'USD' ? 'US$' : '€';
  const n = amount.toLocaleString(lang === 'pt' ? 'pt-BR' : 'en-US');
  const per =
    lang === 'pt'
      ? { month: 'por mês', year: 'por ano', hour: 'por hora' }[period]
      : { month: 'per month', year: 'per year', hour: 'per hour' }[period];
  return `${symbol} ${n} ${per}`;
}

function num(v: string | null): number | null {
  return v ? parseMoney(v) : null;
}
