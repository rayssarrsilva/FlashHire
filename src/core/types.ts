export type SiteId =
  | 'linkedin'
  | 'gupy'
  | 'glassdoor'
  | 'indeed'
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'workable'
  | 'getonboard'
  | 'remotive'
  | 'weworkremotely'
  | 'remoteok'
  | 'wellfound'
  | 'other';

export type LinkVariant = 'search' | 'direct' | 'apply-flow' | 'login' | 'no-job';

export interface SiteInfo {
  site: SiteId;
  label: string;
  variant: LinkVariant;
  /** URL the browser should open (normalized). */
  openUrl: string;
  /** Stable id used to avoid applying twice to the same job. */
  jobKey: string | null;
  /** True when the final click must be made by the candidate (site rules). */
  manualSubmit: boolean;
  /** Human-readable problem with the link, if any. */
  warning?: string;
}

export type Lang = 'pt' | 'en';

export type Seniority = 'intern' | 'junior' | 'mid' | 'senior' | 'unknown';

export type Regime = 'clt' | 'pj' | 'contractor' | 'unknown';

export type Currency = 'BRL' | 'USD' | 'EUR';

export interface JobInfo {
  url: string;
  title: string;
  company: string;
  description: string;
  site: SiteId;
}

export interface JobAnalysis {
  lang: Lang;
  seniority: Seniority;
  regime: Regime;
  currency: Currency;
  role: 'frontend' | 'qa' | 'fullstack' | 'backend' | 'design' | 'other';
  workModel: 'remote' | 'hybrid' | 'onsite' | 'unknown';
  city: string | null;
  salaryMonthly: number | null;
  requiredYears: number | null;
  skills: string[];
  needsAdvancedEnglish: boolean;
}

export interface ResumeRecord {
  id: number;
  name: string;
  lang: Lang;
  pdfPath: string;
  text: string;
  /** Structured version, when present, enables tailoring. */
  data: ResumeData | null;
}

export interface ResumeData {
  name: string;
  headline: string;
  contact: string[];
  summary: string;
  skills: { group: string; items: string[] }[];
  projects: { title: string; meta?: string; bullets: string[] }[];
  experience: { title: string; meta?: string; bullets: string[] }[];
  education: { title: string; meta?: string; bullets: string[] }[];
  extras: { title: string; items: string[] }[];
  labels: {
    summary: string;
    skills: string;
    projects: string;
    experience: string;
    education: string;
  };
}

export interface MatchResult {
  score: number;
  coverage: number;
  matched: string[];
  missing: string[];
  blocked: string | null;
  reasons: string[];
}

export interface BankEntry {
  id: number;
  key: string;
  questionPt: string;
  questionEn: string;
  answer: string;
  answerEn: string | null;
  kind: string;
  variants: string[];
}

export type AnswerSource = 'bank' | 'rule' | 'ai' | 'user';

export interface ResolvedAnswer {
  value: string;
  source: AnswerSource;
  confidence: number;
  note?: string;
}

export interface FieldOption {
  label: string;
  value: string;
}

export interface FieldQuestion {
  label: string;
  type: 'text' | 'textarea' | 'number' | 'email' | 'tel' | 'url' | 'date' | 'select' | 'radio' | 'checkbox' | 'file';
  required: boolean;
  options: FieldOption[];
}
