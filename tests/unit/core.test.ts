import { describe, expect, it } from 'vitest';
import { mapOption, resolveAnswer } from '../../src/core/answers';
import { analyzeJob, detectSalary } from '../../src/core/analyze';
import { decrypt, deriveKey, encrypt, newSalt } from '../../src/core/crypto';
import { letterLooksOk, templateLetter } from '../../src/core/letter';
import { DEFAULT_MATCH_SETTINGS, pickResume, scoreResume } from '../../src/core/match';
import { redact } from '../../src/core/redact';
import { detectSite } from '../../src/core/sites';
import { tailorResume } from '../../src/core/tailor';
import { normalize, tokens } from '../../src/core/text';
import type { BankEntry, FieldQuestion, ResumeData } from '../../src/core/types';

describe('detectSite: the candidate’s real links (A and B)', () => {
  it('Gupy A (job page) gives a stable job key', () => {
    const s = detectSite('https://sidi.gupy.io/job/eyJqb2JJZCI6OTAzODA2LCJzb3VyY2UiOiJndXB5X3BvcnRhbCJ9?jobBoardSource=gupy_portal');
    expect(s.site).toBe('gupy');
    expect(s.jobKey).toBe('gupy:sidi:903806');
    expect(s.openUrl).not.toContain('jobBoardSource');
    expect(s.manualSubmit).toBe(false);
  });
  it('Gupy B (login page) is flagged as not a job', () => {
    const s = detectSite('https://sidi.gupy.io/candidates/auth');
    expect(s.variant).toBe('login');
    expect(s.jobKey).toBeNull();
    expect(s.warning).toBeTruthy();
  });
  it('LinkedIn A (search results) and B (job view) point to the same job', () => {
    const a = detectSite('https://www.linkedin.com/jobs/search-results/?currentJobId=4485360849&keywords=frontend');
    const b = detectSite('https://www.linkedin.com/jobs/view/4485360849/?companyName=AI%2FR');
    expect(a.jobKey).toBe('linkedin:4485360849');
    expect(b.jobKey).toBe(a.jobKey);
    expect(a.openUrl).toBe('https://www.linkedin.com/jobs/view/4485360849/');
    expect(a.variant).toBe('search');
    expect(b.variant).toBe('direct');
    expect(a.manualSubmit).toBe(true);
  });
  it('Glassdoor list without a job and Indeed SmartApply mid-flow are flagged', () => {
    expect(detectSite('https://www.glassdoor.com.br/Job/index.htm').variant).toBe('no-job');
    expect(detectSite('https://www.glassdoor.com.br/Job/index.htm?jl=1009876543').jobKey).toBe('glassdoor:1009876543');
    const indeed = detectSite('https://smartapply.indeed.com/beta/indeedapply/form/review-module');
    expect(indeed.variant).toBe('apply-flow');
    expect(indeed.manualSubmit).toBe(true);
  });
  it('Greenhouse external link drops tracking params', () => {
    const s = detectSite('https://job-boards.greenhouse.io/artefactlinkedin/jobs/7981662002?gh_src=96efae722us');
    expect(s.site).toBe('greenhouse');
    expect(s.openUrl).toBe('https://job-boards.greenhouse.io/artefactlinkedin/jobs/7981662002');
    expect(s.manualSubmit).toBe(false);
  });
  it('remote boards are recognized', () => {
    expect(detectSite('https://www.getonbrd.com/jobs/programacion/frontend-dev-acme-remote').site).toBe('getonboard');
    expect(detectSite('https://remotive.com/remote/jobs/software-development/frontend-123').site).toBe('remotive');
    expect(detectSite('https://remoteok.com/remote-jobs/123').site).toBe('remoteok');
  });
});

const JR_FRONT = {
  title: 'Desenvolvedora Front-end Júnior',
  description:
    'Vaga 100% remoto. CLT. Requisitos: React, TypeScript, HTML, CSS, Git e testes com Jest. Diferencial: Next.js e acessibilidade (WCAG). Salário: R$ 5.000.',
};

describe('analyzeJob', () => {
  it('reads seniority, regime, model, salary and skills', () => {
    const a = analyzeJob(JR_FRONT);
    expect(a.lang).toBe('pt');
    expect(a.seniority).toBe('junior');
    expect(a.regime).toBe('clt');
    expect(a.workModel).toBe('remote');
    expect(a.salaryMonthly).toBe(5000);
    expect(a.role).toBe('frontend');
    expect(a.skills).toEqual(expect.arrayContaining(['React', 'TypeScript', 'Next.js', 'Jest', 'Accessibility']));
  });
  it('English senior job asking 5 years', () => {
    const a = analyzeJob({ title: 'Senior Frontend Engineer', description: 'Remote. 5+ years of experience with React. Fluent English. $6,000 per month.' });
    expect(a.lang).toBe('en');
    expect(a.seniority).toBe('senior');
    expect(a.requiredYears).toBe(5);
    expect(a.needsAdvancedEnglish).toBe(true);
    expect(a.currency).toBe('USD');
  });
  it('salary periods', () => {
    expect(detectSalary('US$ 60,000 per year')).toBe(5000);
    expect(detectSalary('R$ 4.500,00 por mês')).toBe(4500);
    expect(detectSalary('$20/hour')).toBe(3200);
    expect(detectSalary('R$ 6k')).toBe(6000);
  });
});

const RESUME_TEXT =
  'React Next.js TypeScript JavaScript HTML CSS Tailwind CSS Playwright Cypress Jest Vitest Testing Library WCAG Git GitHub Actions Figma Node.js PostgreSQL Docker';

describe('match and blocking rules', () => {
  it('junior React job scores high', () => {
    const m = scoreResume(analyzeJob(JR_FRONT), RESUME_TEXT, DEFAULT_MATCH_SETTINGS);
    expect(m.score).toBeGreaterThanOrEqual(85);
    expect(m.blocked).toBeNull();
  });
  it('on-site outside Uberaba/Uberlândia without salary above R$ 4.500 is blocked', () => {
    const a = analyzeJob({ title: 'Dev Front-end Jr', description: 'Presencial em São Paulo. React. Salário R$ 4.000.' });
    expect(scoreResume(a, RESUME_TEXT, DEFAULT_MATCH_SETTINGS).blocked).toMatch(/presencial/i);
  });
  it('on-site in Uberlândia is allowed', () => {
    const a = analyzeJob({ title: 'Dev Front-end Jr', description: 'Presencial em Uberlândia, MG. React.' });
    expect(scoreResume(a, RESUME_TEXT, DEFAULT_MATCH_SETTINGS).blocked).toBeNull();
  });
  it('on-site elsewhere above R$ 4.500 is allowed', () => {
    const a = analyzeJob({ title: 'Dev Front-end Jr', description: 'Presencial em Curitiba. React. Salário R$ 6.000.' });
    expect(scoreResume(a, RESUME_TEXT, DEFAULT_MATCH_SETTINGS).blocked).toBeNull();
  });
  it('picks the résumé that fits best', () => {
    const a = analyzeJob(JR_FRONT);
    const pick = pickResume(
      a,
      [
        { id: 1, name: 'Geral', lang: 'pt', pdfPath: '', text: 'Python Django Flask Excel', data: null },
        { id: 2, name: 'TI', lang: 'pt', pdfPath: '', text: RESUME_TEXT, data: null },
      ],
      DEFAULT_MATCH_SETTINGS,
    );
    expect(pick?.resume.name).toBe('TI');
  });
});

const bank: BankEntry[] = [
  ['contact.fullName', 'Nome completo', 'Full name', 'Rayssa Roberta Rodrigues Silva'],
  ['contact.email', 'E-mail', 'Email', 'rayssa@example.com'],
  ['links.linkedin', 'LinkedIn', 'LinkedIn profile', 'https://www.linkedin.com/in/x'],
  ['salary.frontend.junior.clt', 'Pretensão – Frontend Júnior, CLT', '', 'R$ 5.000 por mês'],
  ['salary.usd.junior', 'Pretensão – Júnior exterior', '', 'US$ 1.800 por mês'],
  ['years.React', 'Anos com React', 'Years of experience with React', '1'],
  ['triage.relatives', 'Tem parentes ou amigos na empresa?', 'Do you have relatives working here?', 'Não'],
].map(([key, pt, en, answer], i) => ({ id: i + 1, key: key!, questionPt: pt!, questionEn: en!, answer: answer!, answerEn: null, kind: 'Texto', variants: [] }));

const q = (label: string, extra: Partial<FieldQuestion> = {}): FieldQuestion => ({ label, type: 'text', required: true, options: [], ...extra });

describe('resolveAnswer (no AI)', () => {
  const ctx = { bank, job: analyzeJob(JR_FRONT), siteLabel: 'Gupy', company: 'Acme' };
  it('contact rules', () => {
    expect(resolveAnswer(q('First name'), ctx)?.value).toBe('Rayssa');
    expect(resolveAnswer(q('Sobrenome'), ctx)?.value).toBe('Roberta Rodrigues Silva');
    expect(resolveAnswer(q('E-mail *'), ctx)?.value).toBe('rayssa@example.com');
    expect(resolveAnswer(q('LinkedIn Profile URL'), ctx)?.value).toContain('linkedin.com');
  });
  it('salary by role, regime and currency', () => {
    expect(resolveAnswer(q('Qual sua pretensão salarial?'), ctx)?.value).toBe('R$ 5.000 por mês');
    expect(resolveAnswer(q('Pretensão salarial (R$)', { type: 'number' }), ctx)?.value).toBe('5000');
    const en = { ...ctx, job: analyzeJob({ title: 'Junior Frontend Developer', description: 'Remote contractor role, paid in USD. React.' }) };
    expect(resolveAnswer(q('What are your salary expectations (USD per month)?'), en)?.value).toBe('US$ 1,800 per month');
    expect(resolveAnswer(q('Desired annual salary in USD', { type: 'number' }), en)?.value).toBe('21600');
  });
  it('how did you hear → source site', () => {
    expect(resolveAnswer(q('Como você soube da vaga?'), ctx)?.value).toBe('Gupy');
  });
  it('years of experience by skill, never guessed', () => {
    expect(resolveAnswer(q('How many years of experience do you have with React?'), ctx)?.value).toBe('1');
    expect(resolveAnswer(q('Quantos anos de experiência com Angular?'), ctx)).toBeNull();
  });
  it('bank similarity and choice fields', () => {
    const r = resolveAnswer(
      q('Você possui parentes ou amigos trabalhando na empresa?', {
        type: 'radio',
        options: [
          { label: 'Sim', value: 'yes' },
          { label: 'Não', value: 'no' },
        ],
      }),
      ctx,
    );
    expect(r?.value).toBe('no');
  });
  it('unknown questions return null (go to AI or to the candidate)', () => {
    expect(resolveAnswer(q('Qual o nome do seu primeiro animal de estimação?'), ctx)).toBeNull();
  });
});

describe('mapOption', () => {
  const opts = ['Selecione', 'Menos de 1 ano', '1-2 anos', '3-5 anos', 'Mais de 5 anos'].map((l) => ({ label: l, value: l }));
  it('numeric ranges', () => {
    expect(mapOption('0', opts)?.label).toBe('Menos de 1 ano');
    expect(mapOption('2', opts)?.label).toBe('1-2 anos');
    expect(mapOption('7', opts)?.label).toBe('Mais de 5 anos');
  });
  it('yes/no across languages', () => {
    expect(mapOption('Sim', [{ label: 'Yes', value: 'y' }, { label: 'No', value: 'n' }])?.value).toBe('y');
  });
});

describe('security helpers', () => {
  it('AES-256-GCM round trip and tamper detection', () => {
    const key = deriveKey('senha forte 123', newSalt());
    const enc = encrypt(key, 'CPF 123.456.789-00');
    expect(enc).not.toContain('123.456');
    expect(decrypt(key, enc)).toBe('CPF 123.456.789-00');
    const tampered = enc.slice(0, -4) + (enc.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    expect(() => decrypt(key, tampered)).toThrow();
  });
  it('redacts personal data before AI', () => {
    const out = redact('Email rayssa@x.com, tel (34) 99128-2814, CPF 123.456.789-00, CEP 38000-000, Rua das Flores, 120');
    expect(out).not.toMatch(/rayssa@|99128|123\.456|38000|Flores/);
  });
});

const RESUME: ResumeData = {
  name: 'Ana Teste',
  headline: 'Desenvolvedora Frontend',
  contact: ['Uberaba, MG'],
  summary: 'Resumo.',
  skills: [
    { group: 'Back-end', items: ['Python', 'Django'] },
    { group: 'Frontend', items: ['HTML', 'React', 'TypeScript'] },
  ],
  projects: [
    { title: 'Projeto Python', bullets: ['API em Django.'] },
    { title: 'Projeto React', bullets: ['App em React e TypeScript com testes em Playwright.'] },
  ],
  experience: [],
  education: [],
  extras: [],
  labels: { summary: 'Resumo', skills: 'Competências', projects: 'Projetos', experience: 'Experiência', education: 'Formação' },
};

describe('tailoring never adds content', () => {
  it('reorders by relevance and keeps the same words', () => {
    const t = tailorResume(RESUME, ['React', 'TypeScript', 'Playwright']);
    expect(t.skills[0]?.group).toBe('Frontend');
    expect(t.skills[0]?.items.slice(0, 2)).toEqual(['React', 'TypeScript']);
    expect(t.projects[0]?.title).toBe('Projeto React');
    const words = (r: ResumeData) => new Set(tokens(JSON.stringify(r)));
    for (const w of words(t)) expect(words(RESUME).has(w)).toBe(true);
  });
});

describe('cover letter template', () => {
  it('uses the company, real projects and no clichés', () => {
    const job = { url: '', title: 'Desenvolvedora Front-end Júnior', company: 'Acme', description: JR_FRONT.description, site: 'gupy' as const };
    const text = templateLetter({
      job,
      analysis: analyzeJob(JR_FRONT),
      candidateName: 'Ana Teste',
      resume: RESUME,
      resumeText: RESUME_TEXT,
      about: null,
      availability: 'imediata',
    });
    expect(text).toContain('Olá, equipe da Acme');
    expect(text).toContain('Projeto React');
    expect(text).toContain('Atenciosamente,\nAna Teste');
    expect(normalize(text)).not.toMatch(/apaixonad|sinergia/);
    expect(letterLooksOk('curta demais')).toBe(false);
  });
});
