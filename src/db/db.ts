import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHECK_VALUE, decrypt, deriveKey, encrypt, newSalt, verifyKey } from '../core/crypto';
import type { BankEntry, Lang, MatchResult, ResumeData, ResumeRecord, SiteId } from '../core/types';

export type JobStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'ready'
  | 'submitted'
  | 'skipped'
  | 'failed'
  | 'duplicate';

export interface JobRow {
  id: number;
  url: string;
  openUrl: string;
  site: SiteId;
  variant: string;
  jobKey: string | null;
  status: JobStatus;
  title: string;
  company: string;
  score: number | null;
  match: MatchResult | null;
  resumeId: number | null;
  tailoredPath: string | null;
  letter: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  interview: boolean;
  log: { at: string; msg: string }[];
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, enc TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bank (
  id INTEGER PRIMARY KEY,
  key TEXT UNIQUE,
  question_pt TEXT NOT NULL DEFAULT '',
  question_en TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'Texto',
  variants TEXT NOT NULL DEFAULT '[]',
  answer_enc TEXT NOT NULL,
  answer_en_enc TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS resumes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  lang TEXT NOT NULL,
  pdf_path TEXT NOT NULL,
  text_enc TEXT NOT NULL,
  data_enc TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  url TEXT NOT NULL,
  open_url TEXT NOT NULL,
  site TEXT NOT NULL,
  variant TEXT NOT NULL,
  job_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  score INTEGER,
  match_json TEXT,
  resume_id INTEGER REFERENCES resumes(id) ON DELETE SET NULL,
  tailored_path TEXT,
  letter TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  applied_at TEXT,
  interview INTEGER NOT NULL DEFAULT 0,
  log TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_job_key ON jobs(job_key) WHERE job_key IS NOT NULL AND status <> 'duplicate';
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status);
`;

export class Store {
  readonly db: DatabaseSync;
  private key: Buffer | null = null;

  constructor(file: string) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
  }

  // ---------- vault ----------
  get isSetUp(): boolean {
    return !!this.meta('vault.check');
  }
  get isUnlocked(): boolean {
    return this.key !== null;
  }

  setup(password: string): void {
    if (this.isSetUp) throw new Error('O cofre já foi criado.');
    if (password.length < 10) throw new Error('Use uma senha mestra com pelo menos 10 caracteres.');
    const salt = newSalt();
    const key = deriveKey(password, salt);
    this.setMeta('vault.salt', salt.toString('base64'));
    this.setMeta('vault.check', encrypt(key, CHECK_VALUE));
    this.key = key;
  }

  unlock(password: string): boolean {
    const salt = this.meta('vault.salt');
    const check = this.meta('vault.check');
    if (!salt || !check) return false;
    const key = deriveKey(password, Buffer.from(salt, 'base64'));
    if (!verifyKey(key, check)) return false;
    this.key = key;
    return true;
  }

  lock(): void {
    this.key?.fill(0);
    this.key = null;
  }

  private k(): Buffer {
    if (!this.key) throw new Error('Cofre bloqueado. Digite a senha mestra.');
    return this.key;
  }
  private enc(v: string): string {
    return encrypt(this.k(), v);
  }
  private dec(v: string): string {
    return decrypt(this.k(), v);
  }

  // ---------- meta / settings ----------
  meta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r?.value ?? null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  getJson<T>(key: string, fallback: T): T {
    const v = this.meta(key);
    return v ? ({ ...fallback, ...(JSON.parse(v) as object) } as T) : fallback;
  }
  setJson(key: string, value: unknown): void {
    this.setMeta(key, JSON.stringify(value));
  }

  secret(key: string): string | null {
    const r = this.db.prepare('SELECT enc FROM secrets WHERE key = ?').get(key) as { enc: string } | undefined;
    return r ? this.dec(r.enc) : null;
  }
  setSecret(key: string, value: string | null): void {
    if (!value) this.db.prepare('DELETE FROM secrets WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO secrets(key, enc) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET enc = excluded.enc').run(key, this.enc(value));
  }

  // ---------- answer bank ----------
  bank(): BankEntry[] {
    const rows = this.db.prepare('SELECT * FROM bank ORDER BY id').all() as {
      id: number;
      key: string | null;
      question_pt: string;
      question_en: string;
      kind: string;
      variants: string;
      answer_enc: string;
      answer_en_enc: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      key: r.key ?? `custom.${r.id}`,
      questionPt: r.question_pt,
      questionEn: r.question_en,
      kind: r.kind,
      variants: JSON.parse(r.variants) as string[],
      answer: this.dec(r.answer_enc),
      answerEn: r.answer_en_enc ? this.dec(r.answer_en_enc) : null,
    }));
  }

  upsertBank(e: { key: string | null; questionPt: string; questionEn: string; kind: string; answer: string; answerEn?: string | null; variants?: string[] }): number {
    const existing = e.key
      ? (this.db.prepare('SELECT id, variants FROM bank WHERE key = ?').get(e.key) as { id: number; variants: string } | undefined)
      : undefined;
    const variants = JSON.stringify([...new Set([...(existing ? (JSON.parse(existing.variants) as string[]) : []), ...(e.variants ?? [])])]);
    if (existing) {
      this.db
        .prepare(
          "UPDATE bank SET question_pt = ?, question_en = ?, kind = ?, variants = ?, answer_enc = ?, answer_en_enc = COALESCE(?, answer_en_enc), updated_at = datetime('now') WHERE id = ?",
        )
        .run(e.questionPt, e.questionEn, e.kind, variants, this.enc(e.answer), e.answerEn ? this.enc(e.answerEn) : null, existing.id);
      return existing.id;
    }
    const r = this.db
      .prepare('INSERT INTO bank(key, question_pt, question_en, kind, variants, answer_enc, answer_en_enc) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(e.key, e.questionPt, e.questionEn, e.kind, variants, this.enc(e.answer), e.answerEn ? this.enc(e.answerEn) : null);
    return Number(r.lastInsertRowid);
  }

  setAnswerEn(id: number, answerEn: string): void {
    this.db.prepare('UPDATE bank SET answer_en_enc = ? WHERE id = ?').run(this.enc(answerEn), id);
  }

  deleteBank(id: number): void {
    this.db.prepare('DELETE FROM bank WHERE id = ?').run(id);
  }

  // ---------- résumés ----------
  resumes(): ResumeRecord[] {
    const rows = this.db.prepare('SELECT * FROM resumes ORDER BY id').all() as {
      id: number;
      name: string;
      lang: Lang;
      pdf_path: string;
      text_enc: string;
      data_enc: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      lang: r.lang,
      pdfPath: r.pdf_path,
      text: this.dec(r.text_enc),
      data: r.data_enc ? (JSON.parse(this.dec(r.data_enc)) as ResumeData) : null,
    }));
  }

  addResume(r: { name: string; lang: Lang; pdfPath: string; text: string; data: ResumeData | null }): number {
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM resumes').get() as { n: number }).n;
    if (count >= 5) throw new Error('Limite de 5 currículos. Remova um antes de adicionar outro.');
    const res = this.db
      .prepare('INSERT INTO resumes(name, lang, pdf_path, text_enc, data_enc) VALUES(?, ?, ?, ?, ?)')
      .run(r.name, r.lang, r.pdfPath, this.enc(r.text), r.data ? this.enc(JSON.stringify(r.data)) : null);
    return Number(res.lastInsertRowid);
  }

  deleteResume(id: number): void {
    this.db.prepare('DELETE FROM resumes WHERE id = ?').run(id);
  }

  // ---------- jobs ----------
  addJob(j: { url: string; openUrl: string; site: SiteId; variant: string; jobKey: string | null; note?: string | null; status?: JobStatus }): { id: number; duplicate: boolean } {
    if (j.jobKey) {
      const dup = this.db.prepare("SELECT id FROM jobs WHERE job_key = ? AND status <> 'duplicate'").get(j.jobKey) as { id: number } | undefined;
      if (dup) return { id: dup.id, duplicate: true };
    }
    const r = this.db
      .prepare('INSERT INTO jobs(url, open_url, site, variant, job_key, status, note) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(j.url, j.openUrl, j.site, j.variant, j.jobKey, j.status ?? 'queued', j.note ?? null);
    return { id: Number(r.lastInsertRowid), duplicate: false };
  }

  job(id: number): JobRow | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r ? toJob(r) : null;
  }

  jobs(limit = 500): JobRow[] {
    return (this.db.prepare('SELECT * FROM jobs ORDER BY id DESC LIMIT ?').all(limit) as Record<string, unknown>[]).map(toJob);
  }

  nextQueued(): JobRow | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY id LIMIT 1").get() as Record<string, unknown> | undefined;
    return r ? toJob(r) : null;
  }

  updateJob(id: number, patch: Partial<Pick<JobRow, 'status' | 'title' | 'company' | 'score' | 'match' | 'resumeId' | 'tailoredPath' | 'letter' | 'note' | 'interview'>> & { applied?: boolean }): void {
    const cols: string[] = [];
    const vals: unknown[] = [];
    const map: Record<string, string> = { status: 'status', title: 'title', company: 'company', score: 'score', resumeId: 'resume_id', tailoredPath: 'tailored_path', letter: 'letter', note: 'note' };
    for (const [k, col] of Object.entries(map)) {
      if (k in patch) {
        cols.push(`${col} = ?`);
        vals.push((patch as Record<string, unknown>)[k] ?? null);
      }
    }
    if ('match' in patch) {
      cols.push('match_json = ?');
      vals.push(patch.match ? JSON.stringify(patch.match) : null);
    }
    if ('interview' in patch) {
      cols.push('interview = ?');
      vals.push(patch.interview ? 1 : 0);
    }
    if (patch.applied) cols.push("applied_at = datetime('now')");
    cols.push("updated_at = datetime('now')");
    this.db.prepare(`UPDATE jobs SET ${cols.join(', ')} WHERE id = ?`).run(...(vals as SQLInputValue[]), id);
  }

  log(id: number, msg: string): void {
    const row = this.db.prepare('SELECT log FROM jobs WHERE id = ?').get(id) as { log: string } | undefined;
    if (!row) return;
    const log = JSON.parse(row.log) as { at: string; msg: string }[];
    log.push({ at: new Date().toISOString(), msg });
    this.db.prepare('UPDATE jobs SET log = ? WHERE id = ?').run(JSON.stringify(log.slice(-80)), id);
  }

  /** Recovers jobs left "running" by a crash or a closed app. */
  requeueInterrupted(): void {
    this.db.prepare("UPDATE jobs SET status = 'queued' WHERE status IN ('running', 'waiting', 'ready')").run();
  }

  appliedToday(site?: SiteId): number {
    const sql = "SELECT COUNT(*) AS n FROM jobs WHERE status = 'submitted' AND date(applied_at, 'localtime') = date('now', 'localtime')" + (site ? ' AND site = ?' : '');
    return (this.db.prepare(sql).get(...(site ? [site] : [])) as { n: number }).n;
  }

  statsBySite(): { site: string; total: number; submitted: number; interviews: number }[] {
    return this.db
      .prepare(
        "SELECT site, COUNT(*) AS total, SUM(status = 'submitted') AS submitted, SUM(interview) AS interviews FROM jobs WHERE status <> 'duplicate' GROUP BY site ORDER BY submitted DESC",
      )
      .all() as { site: string; total: number; submitted: number; interviews: number }[];
  }
}

function toJob(r: Record<string, unknown>): JobRow {
  return {
    id: r.id as number,
    url: r.url as string,
    openUrl: r.open_url as string,
    site: r.site as SiteId,
    variant: r.variant as string,
    jobKey: (r.job_key as string | null) ?? null,
    status: r.status as JobStatus,
    title: r.title as string,
    company: r.company as string,
    score: (r.score as number | null) ?? null,
    match: r.match_json ? (JSON.parse(r.match_json as string) as MatchResult) : null,
    resumeId: (r.resume_id as number | null) ?? null,
    tailoredPath: (r.tailored_path as string | null) ?? null,
    letter: (r.letter as string | null) ?? null,
    note: (r.note as string | null) ?? null,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    appliedAt: (r.applied_at as string | null) ?? null,
    interview: r.interview === 1,
    log: JSON.parse(r.log as string) as { at: string; msg: string }[],
  };
}
