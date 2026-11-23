import { extractSkills } from './skills';
import { normalize } from './text';
import type { JobAnalysis, JobInfo, Lang, ResumeData } from './types';

export interface LetterInput {
  job: JobInfo;
  analysis: JobAnalysis;
  candidateName: string;
  resume: ResumeData | null;
  resumeText: string;
  /** "Fale sobre você" from the bank, if answered. */
  about: string | null;
  availability: string | null;
}

/** Projects ranked by how many of the job's skills they mention. */
export function rankProjects(resume: ResumeData, jobSkills: string[]) {
  return resume.projects
    .map((p) => {
      const skills = extractSkills(normalize(`${p.title} ${p.meta ?? ''} ${p.bullets.join(' ')}`));
      return { p, hits: skills.filter((s) => jobSkills.includes(s)).length };
    })
    .sort((a, b) => b.hits - a.hits);
}

function firstSentence(text: string): string {
  const s = text.split(/(?<=[.;])\s/)[0] ?? text;
  return s.replace(/[;:]$/, '.').trim();
}

/** Cover letter without AI, following the writing guide: 3 short paragraphs. */
export function templateLetter(i: LetterInput): string {
  const lang: Lang = i.analysis.lang;
  const company = i.job.company || (lang === 'pt' ? 'empresa' : 'your company');
  const title = i.job.title || (lang === 'pt' ? 'a vaga' : 'the role');
  const proofs = i.resume ? rankProjects(i.resume, i.analysis.skills).slice(0, 2) : [];
  const matched = i.analysis.skills.filter((s) => normalize(i.resumeText).includes(normalize(s).split('/')[0] ?? s)).slice(0, 4);

  if (lang === 'pt') {
    const p1 = `Olá, equipe da ${company},\n\nQuero me candidatar à vaga de ${title}. ${matched.length ? `Ela pede ${list(matched, 'pt')}, que uso no dia a dia dos meus projetos.` : 'Ela combina com o que venho construindo nos meus projetos.'}`;
    const p2 = proofs.length
      ? proofs.map(({ p }) => `No projeto ${p.title.split(',')[0]}, ${lower(firstSentence(p.bullets[0] ?? ''))}`).join(' ')
      : (i.about ?? '');
    const p3 = `${i.availability ? `Tenho disponibilidade ${lower(i.availability)}. ` : ''}Fico à disposição para conversar e mostrar esses projetos em detalhes.\n\nAtenciosamente,\n${i.candidateName}`;
    return [p1, p2, p3].filter(Boolean).join('\n\n');
  }
  const p1 = `Hello ${company} team,\n\nI would like to apply for the ${title} role. ${matched.length ? `It asks for ${list(matched, 'en')}, which I use every day in my projects.` : 'It matches what I have been building in my projects.'}`;
  const p2 = proofs.length ? proofs.map(({ p }) => `In ${p.title.split(',')[0]}, ${lower(firstSentence(p.bullets[0] ?? ''))}`).join(' ') : (i.about ?? '');
  const p3 = `${i.availability ? `I am available ${lower(i.availability)}. ` : ''}I would be glad to talk and walk you through these projects.\n\nBest regards,\n${i.candidateName}`;
  return [p1, p2, p3].filter(Boolean).join('\n\n');
}

export function letterPrompt(i: LetterInput, style: string): { system: string; user: string } {
  const lang = i.analysis.lang === 'pt' ? 'Brazilian Portuguese' : 'American English';
  return {
    system: [
      `Write a cover letter in ${lang}, in the first person, for the candidate below.`,
      'Use ONLY facts from the résumé. Never invent experience, numbers or skills. Three short paragraphs, 150 to 250 words.',
      'Paragraph 1: the role and one real detail from the job post. Paragraph 2: two concrete proofs from the résumé tied to the job requirements. Paragraph 3: availability and a simple, warm closing.',
      `Sign with: ${i.candidateName}. Plain text only.`,
      'Writing style guide:',
      style,
    ].join('\n'),
    user: `Job title: ${i.job.title}\nCompany: ${i.job.company}\nJob post:\n${i.job.description.slice(0, 4000)}\n\nRésumé:\n${i.resumeText.slice(0, 6000)}`,
  };
}

/** Rejects AI letters that break the rules (too short/long, clichés), so the template is used instead. */
export function letterLooksOk(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 110 || words > 320) return false;
  return !/apaixonad|sinergia|alavancar|no cenário atual|em suma|passionate|leverage|thrilled|fast-paced|delve|I am excited to/i.test(text);
}

function list(items: string[], lang: Lang): string {
  if (items.length <= 1) return items.join('');
  const last = items[items.length - 1];
  return `${items.slice(0, -1).join(', ')} ${lang === 'pt' ? 'e' : 'and'} ${last}`;
}

function lower(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}
