import { isAllowedCity } from './analyze';
import { extractSkills } from './skills';
import { normalize } from './text';
import type { JobAnalysis, MatchResult, ResumeRecord } from './types';

export interface MatchSettings {
  /** Minimum score (0–100) to apply. */
  threshold: number;
  englishLevel: 'basic' | 'intermediate' | 'advanced' | 'fluent';
  experienceYears: number;
  /** Monthly BRL. Jobs that state a lower salary are skipped. */
  minSalaryBRL: number;
  /** On-site / hybrid outside the allowed cities only above this monthly BRL salary. */
  onsiteMinSalaryBRL: number;
}

export const DEFAULT_MATCH_SETTINGS: MatchSettings = {
  threshold: 45,
  englishLevel: 'advanced',
  experienceYears: 0,
  minSalaryBRL: 3000,
  onsiteMinSalaryBRL: 4500,
};

const SENIORITY_FIT = { intern: 0.6, junior: 1, unknown: 0.9, mid: 0.75, senior: 0.3 } as const;

export function scoreResume(job: JobAnalysis, resumeText: string, s: MatchSettings): MatchResult {
  const resumeSkills = new Set(extractSkills(normalize(resumeText)));
  const matched = job.skills.filter((k) => resumeSkills.has(k));
  const missing = job.skills.filter((k) => !resumeSkills.has(k));
  const coverage = job.skills.length ? matched.length / job.skills.length : 0.6;

  const reasons: string[] = [];
  const seniorityFit = SENIORITY_FIT[job.seniority];
  if (job.seniority === 'senior') reasons.push('Vaga sênior');
  if (job.seniority === 'mid') reasons.push('Vaga pleno');

  let yearsFit = 1;
  if (job.requiredYears !== null) {
    const gap = job.requiredYears - s.experienceYears;
    yearsFit = gap <= 0 ? 1 : gap === 1 ? 0.8 : gap === 2 ? 0.55 : 0.3;
    if (gap > 0) reasons.push(`Pede ${job.requiredYears} ano(s) de experiência`);
  }

  const weakEnglish = s.englishLevel === 'basic' || s.englishLevel === 'intermediate';
  const langFit = job.needsAdvancedEnglish && weakEnglish ? 0.5 : 1;
  if (langFit < 1) reasons.push('Pede inglês avançado');

  const score = Math.round(100 * (0.6 * coverage + 0.15 * seniorityFit + 0.1 * yearsFit + 0.15 * langFit));
  return { score, coverage, matched, missing, blocked: blockReason(job, s), reasons };
}

export function blockReason(job: JobAnalysis, s: MatchSettings): string | null {
  const brl = job.currency === 'BRL' ? job.salaryMonthly : null;
  if ((job.workModel === 'onsite' || job.workModel === 'hybrid') && !isAllowedCity(job.city)) {
    if (brl === null || brl <= s.onsiteMinSalaryBRL) {
      return `Vaga ${job.workModel === 'onsite' ? 'presencial' : 'híbrida'} fora de Uberaba e Uberlândia sem salário acima de R$ ${s.onsiteMinSalaryBRL.toLocaleString('pt-BR')}`;
    }
  }
  if (brl !== null && brl < s.minSalaryBRL) {
    return `Salário de R$ ${brl.toLocaleString('pt-BR')} abaixo do mínimo de R$ ${s.minSalaryBRL.toLocaleString('pt-BR')}`;
  }
  return null;
}

export interface ResumePick {
  resume: ResumeRecord;
  match: MatchResult;
  ranking: { id: number; name: string; score: number }[];
}

/** Picks the résumé with the best score; ties go to the one in the job's language. */
export function pickResume(job: JobAnalysis, resumes: ResumeRecord[], s: MatchSettings): ResumePick | null {
  if (resumes.length === 0) return null;
  const scored = resumes.map((resume) => {
    const match = scoreResume(job, resume.text, s);
    const langBonus = resume.lang === job.lang ? 3 : 0;
    return { resume, match, rank: match.score + langBonus };
  });
  scored.sort((a, b) => b.rank - a.rank);
  const best = scored[0]!;
  return {
    resume: best.resume,
    match: best.match,
    ranking: scored.map((x) => ({ id: x.resume.id, name: x.resume.name, score: x.match.score })),
  };
}
