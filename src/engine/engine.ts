import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { AiClient, answerPrompt, DEFAULT_MODELS, isUnknown, translatePrompt, type AiProvider } from '../core/ai';
import { analyzeJob } from '../core/analyze';
import { bankGet, mapOption, resolveAnswer } from '../core/answers';
import { isSensitiveKey } from '../core/bank-keys';
import { letterLooksOk, letterPrompt, templateLetter } from '../core/letter';
import { DEFAULT_MATCH_SETTINGS, pickResume, type MatchSettings } from '../core/match';
import { detectSite, MANUAL_SUBMIT_SITES, siteLabel } from '../core/sites';
import { DENSITIES, resumeHtml, tailorResume } from '../core/tailor';
import { normalize } from '../core/text';
import type { JobAnalysis, JobInfo, ResolvedAnswer, ResumeRecord } from '../core/types';
import type { JobRow, Store } from '../db/db';
import { runApplication, type UserReply, type WaitKind } from '../browser/apply';
import type { FoundField } from '../browser/dom';
import { extractJob } from '../browser/extract';
import { NORMAL_PACE, pause, type Pace } from '../browser/human';
import { browserName, htmlToPdf, openContext, resumeToPdf, type BrowserChoice, type BrowserOptions } from '../browser/session';

export interface Settings extends MatchSettings {
  maxParallel: number;
  maxWaiting: number;
  dailyCap: number;
  linkedinDailyCap: number;
  autoSubmit: boolean;
  tailor: boolean;
  geminiModel: string;
  groqModel: string;
  browser: BrowserChoice;
}

export const DEFAULT_SETTINGS: Settings = {
  ...DEFAULT_MATCH_SETTINGS,
  maxParallel: 2,
  maxWaiting: 6,
  dailyCap: 20,
  linkedinDailyCap: 10,
  autoSubmit: true,
  tailor: true,
  geminiModel: DEFAULT_MODELS.gemini,
  groqModel: DEFAULT_MODELS.groq,
  browser: 'auto',
};

export interface PendingQuestion {
  fieldId: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
  suggestion: string | null;
}

export interface Pending {
  id: string;
  jobId: number;
  jobTitle: string;
  company: string;
  kind: WaitKind;
  message: string;
  questions: PendingQuestion[];
  createdAt: string;
}

interface Waiter {
  pending: Pending;
  page: Page;
  fields: FoundField[];
  resolve: (r: UserReply) => void;
}

export interface EngineOptions {
  dataDir: string;
  browser: Omit<BrowserOptions, 'profileDir'>;
  pace?: Pace;
  /** For tests: use an existing context instead of opening a browser. */
  context?: BrowserContext;
}

export class Engine extends EventEmitter {
  private ctx: BrowserContext | null;
  private running = false;
  private active = 0;
  private waiters = new Map<string, Waiter>();
  private pace: Pace;

  constructor(
    private store: Store,
    private opts: EngineOptions,
  ) {
    super();
    this.pace = opts.pace ?? NORMAL_PACE;
    this.ctx = opts.context ?? null;
  }

  get settings(): Settings {
    return this.store.getJson('settings', DEFAULT_SETTINGS);
  }

  get isRunning(): boolean {
    return this.running;
  }

  pendings(): Pending[] {
    return [...this.waiters.values()].map((w) => w.pending);
  }

  // ---------- queue ----------
  addLinks(urls: string[]): { added: number; duplicates: number; warnings: { url: string; warning: string }[] } {
    let added = 0;
    let duplicates = 0;
    const warnings: { url: string; warning: string }[] = [];
    for (const url of urls) {
      const info = detectSite(url);
      if (info.warning && !info.jobKey) {
        this.store.addJob({ url, openUrl: info.openUrl, site: info.site, variant: info.variant, jobKey: null, note: info.warning, status: 'skipped' });
        warnings.push({ url, warning: info.warning });
        continue;
      }
      const r = this.store.addJob({ url, openUrl: info.openUrl, site: info.site, variant: info.variant, jobKey: info.jobKey });
      if (r.duplicate) duplicates++;
      else added++;
    }
    this.emit('change');
    this.pump();
    return { added, duplicates, warnings };
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.store.isUnlocked) throw new Error('Desbloqueie o cofre primeiro.');
    if (this.store.resumes().length === 0) throw new Error('Adicione pelo menos 1 currículo.');
    if (!this.ctx) {
      this.ctx = await openContext({ ...this.opts.browser, channel: this.opts.browser.channel ?? this.settings.browser, profileDir: join(this.opts.dataDir, 'browser-profiles') });
      this.emit('notice', `Abri o ${browserName()} do FlashHire. Na primeira vez, faça login nele no LinkedIn, na Gupy e no Indeed.`);
      this.ctx.on('close', () => {
        this.ctx = null;
        this.running = false;
        this.emit('change');
      });
    }
    this.running = true;
    this.emit('change');
    this.pump();
  }

  stop(): void {
    this.running = false;
    this.emit('change');
  }

  private pump(): void {
    if (!this.running || !this.ctx) return;
    const s = this.settings;
    while (this.active < s.maxParallel && this.waiters.size < s.maxWaiting) {
      if (this.store.appliedToday() >= s.dailyCap) {
        this.emit('notice', `Meta do dia atingida (${s.dailyCap}). Continuo amanhã.`);
        this.running = false;
        this.emit('change');
        return;
      }
      const job = this.store.nextQueued();
      if (!job) return;
      if (job.site === 'linkedin' && this.store.appliedToday('linkedin') >= s.linkedinDailyCap) {
        this.store.updateJob(job.id, { status: 'skipped', note: `Limite diário do LinkedIn (${s.linkedinDailyCap}) atingido. Volte a colocar na fila amanhã.` });
        continue;
      }
      this.store.updateJob(job.id, { status: 'running' });
      this.active++;
      this.emit('change');
      void this.process(job).finally(async () => {
        this.active--;
        this.emit('change');
        await pause(this.pace.betweenJobs);
        this.pump();
      });
    }
  }

  // ---------- inbox ----------
  reply(pendingId: string, reply: UserReply & { save?: boolean }): void {
    const w = this.waiters.get(pendingId);
    if (!w) throw new Error('Esta pendência já foi resolvida.');
    if (reply.answers && reply.save !== false) {
      for (const f of w.fields) {
        const v = reply.answers[f.id];
        if (!v) continue;
        const text = f.options.length ? (f.options.find((o) => o.value === v)?.label ?? v) : v;
        this.store.upsertBank({ key: `user.${hash(f.label)}`, questionPt: f.label, questionEn: f.label, kind: f.type === 'textarea' ? 'Aberta' : 'Texto', answer: text, variants: [f.label] });
      }
    }
    // For choice fields the page needs the option id, not the label.
    if (reply.answers) {
      for (const f of w.fields) {
        const v = reply.answers[f.id];
        if (v && f.options.length && !f.options.some((o) => o.value === v)) {
          const opt = mapOption(v, f.options);
          if (opt) reply.answers[f.id] = opt.value;
        }
      }
    }
    this.waiters.delete(pendingId);
    w.resolve(reply);
    this.emit('change');
  }

  /**
   * Brings the job's tab AND its browser window to the front. bringToFront() alone only
   * switches tabs inside the browser; Windows keeps the window behind the dashboard.
   */
  async focus(pendingId: string): Promise<{ title: string; url: string; browser: string }> {
    const w = this.waiters.get(pendingId);
    if (!w) throw new Error('Esta pendência já foi resolvida.');
    const page = w.page;
    if (page.isClosed()) throw new Error('A aba desta vaga foi fechada. Clique em "Pular vaga" e coloque o link na fila de novo.');
    await page.bringToFront();
    try {
      const cdp = await page.context().newCDPSession(page);
      const { windowId } = (await cdp.send('Browser.getWindowForTarget')) as { windowId: number };
      const { bounds } = (await cdp.send('Browser.getWindowBounds', { windowId })) as { bounds: { windowState?: string } };
      const back = bounds.windowState === 'maximized' || bounds.windowState === 'fullscreen' ? bounds.windowState : 'normal';
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: back } });
      await cdp.detach();
      await page.bringToFront();
    } catch {
      // Window control is not available (e.g. headless): the tab is still active.
    }
    return { title: await page.title().catch(() => ''), url: page.url(), browser: browserName() };
  }

  private waitUser(job: JobRow, kind: WaitKind, message: string, page: Page, fields: FoundField[] = [], suggestions: Record<string, string> = {}): Promise<UserReply> {
    const pending: Pending = {
      id: randomUUID(),
      jobId: job.id,
      jobTitle: this.store.job(job.id)?.title || job.openUrl,
      company: this.store.job(job.id)?.company ?? '',
      kind,
      message,
      questions: fields.map((f) => ({
        fieldId: f.id,
        label: f.label,
        type: f.type,
        required: f.required,
        options: f.options.map((o) => o.label),
        suggestion: suggestions[f.id] ?? null,
      })),
      createdAt: new Date().toISOString(),
    };
    this.store.updateJob(job.id, { status: kind === 'submit' ? 'ready' : 'waiting' });
    this.store.log(job.id, `Sua vez: ${message}`);
    return new Promise<UserReply>((resolve) => {
      this.waiters.set(pending.id, { pending, page, fields, resolve });
      this.active--; // a job waiting for the candidate frees its slot: the next one starts now
      this.emit('pending', pending);
      this.emit('change');
      this.pump();
    }).then((r) => {
      this.active++;
      this.store.updateJob(job.id, { status: 'running' });
      return r;
    });
  }

  // ---------- one job ----------
  private async process(job: JobRow): Promise<void> {
    const s = this.settings;
    const log = (msg: string) => {
      this.store.log(job.id, msg);
      this.emit('change');
    };
    let page: Page | null = null;
    try {
      page = await this.ctx!.newPage();
      log(`Abrindo ${siteLabel(job.site)}`);
      await page.goto(job.openUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await pause(this.pace.afterClick);

      const extracted = await extractJob(page);
      const info: JobInfo = { url: job.openUrl, site: job.site, ...extracted };
      const analysis = analyzeJob(info);
      this.store.updateJob(job.id, { title: info.title, company: info.company });

      const resumes = this.store.resumes();
      const pick = pickResume(analysis, resumes, s)!;
      this.store.updateJob(job.id, { score: pick.match.score, match: pick.match, resumeId: pick.resume.id });
      log(`Compatibilidade ${pick.match.score}% · currículo "${pick.resume.name}"`);
      if (pick.match.blocked) {
        this.store.updateJob(job.id, { status: 'skipped', note: pick.match.blocked });
        return;
      }
      if (pick.match.score < s.threshold) {
        this.store.updateJob(job.id, { status: 'skipped', note: `Compatibilidade ${pick.match.score}% abaixo de ${s.threshold}%` });
        return;
      }

      const outDir = join(this.opts.dataDir, 'out', String(job.id));
      mkdirSync(outDir, { recursive: true });
      const bank = this.store.bank();
      const fullName = bankGet(bank, 'contact.fullName') ?? 'Candidata';
      const fileBase = fullName.trim().split(/\s+/).filter((_, i, a) => i === 0 || i === a.length - 1).join('-');
      const style = this.writingStyle();
      const ai = this.ai();

      let resumeFile: string | null = null;
      const resumePath = async () => {
        if (resumeFile) return resumeFile;
        resumeFile = pick.resume.pdfPath;
        if (s.tailor && pick.resume.data) {
          const out = join(outDir, `${fileBase}-${analysis.lang === 'pt' ? 'Curriculo' : 'Resume'}.pdf`);
          const tailored = tailorResume(pick.resume.data, analysis.skills);
          await resumeToPdf((d) => resumeHtml(tailored, d), DENSITIES.length, out, this.opts.browser);
          this.store.updateJob(job.id, { tailoredPath: out });
          resumeFile = out;
          log('Currículo personalizado gerado');
        }
        return resumeFile;
      };
      let letter: string | null = null;
      const letterText = async () => {
        if (letter) return letter;
        letter = await this.writeLetter(info, analysis, pick.resume, fullName, style, ai);
        this.store.updateJob(job.id, { letter });
        return letter;
      };
      const letterPath = async () => {
        const out = join(outDir, `${fileBase}-${analysis.lang === 'pt' ? 'Carta' : 'Cover-Letter'}.pdf`);
        if (!existsSync(out)) {
          const body = (await letterText()).split('\n').map((l) => `<p>${l.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!) || '&nbsp;'}</p>`).join('');
          await htmlToPdf(`<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:22mm}body{font-family:Arial,sans-serif;font-size:11pt;line-height:1.45}p{margin:0}</style>${body}`, out, this.opts.browser);
        }
        return out;
      };

      const outcome = await runApplication(page, {
        pace: this.pace,
        log,
        waitUser: async (kind, message, p, fields) => {
          const suggestions: Record<string, string> = {};
          for (const f of fields ?? []) {
            const a = resolveAnswer(f, { bank, job: analysis, siteLabel: siteLabel(job.site), company: info.company });
            if (a) suggestions[f.id] = f.options.find((o) => o.value === a.value)?.label ?? a.value;
          }
          return this.waitUser(job, kind, message, p, fields, suggestions);
        },
        answer: (f) => this.answer(f, { bank, analysis, info, job, style, ai, resume: pick.resume }),
        resumePath,
        letterPath,
        letterText,
        manualSubmit: (p) => {
          const site = detectSite(p.url()).site;
          return !s.autoSubmit || MANUAL_SUBMIT_SITES.has(site) || MANUAL_SUBMIT_SITES.has(job.site);
        },
      });
      page = outcome.page;
      this.store.updateJob(job.id, { status: outcome.status, note: outcome.note, ...(outcome.status === 'submitted' ? { applied: true } : {}) });
      log(outcome.note);
    } catch (e) {
      const msg = e instanceof Error ? e.message.split('\n')[0]! : String(e);
      this.store.updateJob(job.id, { status: 'failed', note: msg });
      log(`Erro: ${msg}`);
    } finally {
      const keep = this.store.job(job.id)?.status === 'failed';
      if (page && !keep) await page.close().catch(() => {});
      this.emit('change');
    }
  }

  private async answer(
    f: FoundField,
    c: { bank: ReturnType<Store['bank']>; analysis: JobAnalysis; info: JobInfo; job: JobRow; style: string; ai: AiClient; resume: ResumeRecord },
  ): Promise<ResolvedAnswer | null> {
    const ctx = { bank: c.bank, job: c.analysis, siteLabel: siteLabel(c.job.site), company: c.info.company };
    const local = resolveAnswer(f, ctx);
    if (local && local.note !== 'needs-translation') return local;

    if (local?.note === 'needs-translation' && c.ai.enabled) {
      const t = translatePrompt(local.value, 'en', c.style);
      const out = await c.ai.complete(t.system, t.user);
      if (out) {
        const entry = c.bank.find((b) => b.answer === local.value);
        if (entry) this.store.setAnswerEn(entry.id, out);
        return { value: out, source: 'ai', confidence: 0.7 };
      }
    }
    // AI only for required questions, to save the free quota.
    if (!f.required || !c.ai.enabled) return null;
    const facts = [
      c.resume.text,
      ...c.bank.filter((b) => !isSensitiveKey(b.key) && b.answer).map((b) => `${b.questionPt || b.questionEn}: ${b.answer}`),
    ].join('\n');
    const p = answerPrompt({
      question: f.label,
      options: f.options.map((o) => o.label),
      lang: c.analysis.lang,
      facts,
      style: c.style,
      jobTitle: c.info.title,
      company: c.info.company,
      jobSummary: c.info.description,
      maxWords: f.type === 'textarea' ? 120 : 25,
    });
    const out = await c.ai.complete(p.system, p.user);
    if (isUnknown(out)) return null;
    let value = out!;
    if (f.options.length) {
      const opt = mapOption(value, f.options);
      if (!opt) return null;
      value = opt.value;
    } else {
      this.store.upsertBank({ key: `ai.${hash(f.label)}`, questionPt: f.label, questionEn: f.label, kind: 'IA', answer: value, variants: [f.label] });
    }
    return { value, source: 'ai', confidence: 0.6 };
  }

  private async writeLetter(info: JobInfo, analysis: JobAnalysis, resume: ResumeRecord, name: string, style: string, ai: AiClient): Promise<string> {
    const bank = this.store.bank();
    const input = {
      job: info,
      analysis,
      candidateName: name,
      resume: resume.data,
      resumeText: resume.text,
      about: bankGet(bank, 'sheet.P117', analysis.lang),
      availability: null,
    };
    if (ai.enabled) {
      const p = letterPrompt(input, style);
      const out = await ai.complete(p.system, p.user);
      if (out && letterLooksOk(out)) return out;
    }
    return templateLetter(input);
  }

  private ai(): AiClient {
    const s = this.settings;
    const providers: AiProvider[] = [];
    const gemini = this.store.secret('ai.gemini');
    const groq = this.store.secret('ai.groq');
    if (gemini) providers.push({ kind: 'gemini', apiKey: gemini, model: s.geminiModel });
    if (groq) providers.push({ kind: 'groq', apiKey: groq, model: s.groqModel });
    return new AiClient(providers);
  }

  private writingStyle(): string {
    const file = join(this.opts.dataDir, 'writing-style.md');
    if (existsSync(file)) return readFileSync(file, 'utf8');
    return 'Direct, short sentences, concrete facts, correct grammar, no slang, no clichés.';
  }
}

function hash(s: string): string {
  return createHash('sha256').update(normalize(s)).digest('hex').slice(0, 16);
}
