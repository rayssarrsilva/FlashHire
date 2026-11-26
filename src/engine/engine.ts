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
import { isIgnorableButton, isKnownButton, setLearnedButtons, type FoundField } from '../browser/dom';
import { lessonsFrom, startRecording, stopRecording } from '../browser/recorder';
import { extractJob } from '../browser/extract';
import { NORMAL_PACE, pause, type Pace } from '../browser/human';
import { browserName, channelsToTry, htmlToPdf, openContext, profilePath, resumeToPdf, type BrowserChoice, type BrowserOptions } from '../browser/session';
import { findExecutable, LOGIN_PLATFORMS, openLoginWindow, platformsFor } from '../browser/login-window';
import type { ChildProcess } from 'node:child_process';
import type { SiteId } from '../core/types';

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
  /** Learn from what the candidate does in the tabs that wait for her. */
  learn: boolean;
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
  learn: true,
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

/** Thrown when a job lands on a login page of a platform whose session is missing or expired. */
class LoginNeeded extends Error {
  constructor(readonly sites: SiteId[]) {
    super('login');
  }
}

export interface LoginStatus {
  site: SiteId;
  label: string;
  queued: number;
  ok: boolean;
}

export class Engine extends EventEmitter {
  private ctx: BrowserContext | null;
  private loginWindow: ChildProcess | null = null;
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
    setLearnedButtons(this.store.getJson('learned.buttons', {} as Record<string, { submit: string[]; next: string[] }>));
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

  // ---------- logins (before the run) ----------
  private loggedIn(): Set<SiteId> {
    return new Set(this.store.getJson('logins.ok', { sites: [] as SiteId[] }).sites);
  }

  setLoggedIn(sites: SiteId[], ok: boolean): void {
    const set = this.loggedIn();
    for (const s of sites) ok ? set.add(s) : set.delete(s);
    this.store.setJson('logins.ok', { sites: [...set] });
    this.emit('change');
    this.pump();
  }

  /** Platforms with jobs in the queue that need a login, and whether she already signed in. */
  loginStatus(): LoginStatus[] {
    const queued = this.store.queuedBySite();
    const ok = this.loggedIn();
    const out = new Map<SiteId, LoginStatus>();
    for (const [site, n] of Object.entries(queued) as [SiteId, number][]) {
      for (const p of platformsFor(site)) {
        const cur = out.get(p) ?? { site: p, label: LOGIN_PLATFORMS[p]!.label, queued: 0, ok: ok.has(p) };
        cur.queued += n;
        out.set(p, cur);
      }
    }
    return [...out.values()];
  }

  get loginWindowOpen(): boolean {
    return this.loginWindow !== null;
  }

  /** Opens a normal (not automated) browser window on FlashHire's profile with the login pages. */
  async openLogins(sites?: SiteId[]): Promise<{ browser: string }> {
    if (this.active > 0 || this.waiters.size > 0) throw new Error('Pause e espere as vagas em andamento terminarem antes de abrir os logins.');
    this.stop();
    if (this.ctx) {
      await this.ctx.close().catch(() => {});
      this.ctx = null;
    }
    const wanted = sites?.length ? sites : this.loginStatus().map((l) => l.site);
    const list = wanted.length ? wanted : (Object.keys(LOGIN_PLATFORMS) as SiteId[]);
    const urls = list.flatMap((s) => LOGIN_PLATFORMS[s]?.urls ?? []);
    for (const s of list) if (s === 'gupy') urls.push(...this.gupyCompanyLogins());
    const exe = findExecutable(channelsToTry(this.opts.browser.channel ?? this.settings.browser), this.opts.browser.executablePath);
    if (!exe) throw new Error('Não encontrei o Edge nem o Chrome instalados.');
    const child = openLoginWindow(exe.path, profilePath(join(this.opts.dataDir, 'browser-profiles'), exe.channel), urls);
    this.loginWindow = child;
    child.on('exit', () => {
      if (this.loginWindow === child) this.loginWindow = null;
      this.emit('notice', 'Janela de login fechada. Marque as plataformas em que você entrou e clique em Iniciar.');
      this.emit('change');
    });
    this.emit('change');
    return { browser: exe.channel === 'msedge' ? 'Edge' : 'Chrome' };
  }

  /** Gupy keeps one login per company portal: open the auth page of the companies in the queue (up to 5). */
  private gupyCompanyLogins(): string[] {
    const hosts = new Set<string>();
    for (const j of this.store.jobs(1000)) {
      if (j.site !== 'gupy' || j.status !== 'queued') continue;
      try {
        hosts.add(new URL(j.openUrl).host);
      } catch {
        /* ignore */
      }
    }
    return [...hosts].slice(0, 5).map((h) => `https://${h}/candidates/auth`);
  }

  async start(): Promise<void> {
    if (this.running) return;
    if (!this.store.isUnlocked) throw new Error('Desbloqueie o cofre primeiro.');
    if (this.store.resumes().length === 0) throw new Error('Adicione pelo menos 1 currículo.');
    if (this.loginWindow) throw new Error('A janela de login ainda está aberta. Feche essa janela do navegador e clique em Iniciar de novo.');
    if (!this.ctx) {
      this.ctx = await openContext({ ...this.opts.browser, channel: this.opts.browser.channel ?? this.settings.browser, profileDir: join(this.opts.dataDir, 'browser-profiles') });
      await this.checkSessions();
      const missing = this.loginStatus().filter((l) => !l.ok);
      this.emit(
        'notice',
        missing.length
          ? `Abri o ${browserName()} do FlashHire. Vagas de ${missing.map((m) => m.label).join(', ')} esperam você entrar nessas plataformas (botão "Abrir janela de login"); sigo com as outras.`
          : `Abri o ${browserName()} do FlashHire.`,
      );
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

  /** LinkedIn's session cookie is easy to check: if it is gone, ask for the login again. */
  private async checkSessions(): Promise<void> {
    if (!this.ctx || !this.loggedIn().has('linkedin')) return;
    const cookies = await this.ctx.cookies('https://www.linkedin.com').catch(() => []);
    if (!cookies.some((c) => c.name === 'li_at')) this.setLoggedIn(['linkedin'], false);
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
      const ok = this.loggedIn();
      const waitingLogin = (Object.keys(this.store.queuedBySite()) as SiteId[]).filter((site) => platformsFor(site).some((p) => !ok.has(p)));
      const job = this.store.nextQueued(waitingLogin);
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
    const learned = this.learnFrom(w, reply);
    if (learned) this.store.log(w.pending.jobId, learned);
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
  /** Saves what the candidate answered and clicked in the tab, so the next job needs her less. */
  private learnFrom(w: Waiter, reply: UserReply): string | null {
    const events = stopRecording(w.page);
    if (!this.settings.learn || events.length === 0) return null;
    const lessons = lessonsFrom(events, reply.done === 'submitted', isKnownButton, isIgnorableButton);
    const bank = this.store.bank();
    const viaInbox = new Set(w.fields.filter((f) => reply.answers?.[f.id]).map((f) => normalize(f.label)));
    let answers = 0;
    for (const a of lessons.answers) {
      if (a.label.length < 2 || viaInbox.has(normalize(a.label))) continue;
      const known = bank.find((b) => normalize(b.questionPt) === normalize(a.label) || b.variants.some((v) => normalize(v) === normalize(a.label)));
      if (known && normalize(known.answer) === normalize(a.value)) continue;
      const sensitive = SENSITIVE_LABEL.test(normalize(a.label));
      this.store.upsertBank({ key: `learned.${hash(a.label)}`, questionPt: a.label, questionEn: a.label, kind: sensitive ? 'Sensível' : 'Aprendida', answer: a.value, variants: [a.label] });
      answers++;
    }
    const all = this.store.getJson('learned.buttons', {} as Record<string, { submit: string[]; next: string[] }>);
    let buttons = 0;
    for (const b of lessons.buttons) {
      const entry = (all[b.host] ??= { submit: [], next: [] });
      const t = normalize(b.text);
      if (!entry[b.kind].includes(t)) {
        entry[b.kind].push(t);
        buttons++;
      }
    }
    if (buttons) {
      this.store.setJson('learned.buttons', all);
      setLearnedButtons(all);
    }
    if (!answers && !buttons) return null;
    return `Aprendi com você: ${answers} resposta(s) e ${buttons} botão(ões). Da próxima vez faço sozinho.`;
  }

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
    this.store.log(job.id, `Sua vez (${kind}): ${message}`);
    const recording = this.settings.learn ? startRecording(page).catch(() => {}) : Promise.resolve();
    return recording.then(() => new Promise<UserReply>((resolve) => {
      this.waiters.set(pending.id, { pending, page, fields, resolve });
      this.active--; // a job waiting for the candidate frees its slot: the next one starts now
      this.emit('pending', pending);
      this.emit('change');
      this.pump();
    })).then((r) => {
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
          if (kind === 'login') {
            const site = detectSite(p.url()).site;
            const lost = [...new Set([...platformsFor(site), ...platformsFor(job.site)])];
            if (lost.length) throw new LoginNeeded(lost);
          }
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
      if (e instanceof LoginNeeded) {
        const labels = e.sites.map((x) => LOGIN_PLATFORMS[x]?.label ?? x).join(' e ');
        this.setLoggedIn(e.sites, false);
        this.store.updateJob(job.id, { status: 'queued', note: `Esperando você entrar no ${labels}` });
        log(`Pediu login no ${labels}: a vaga volta para a fila até você entrar`);
        this.emit('notice', `A sessão no ${labels} não está ativa. Pause, clique em "Abrir janela de login" e entre de novo. Sigo com as vagas de outros sites.`);
        return;
      }
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
      ...c.bank.filter((b) => !isSensitiveKey(b.key) && b.kind !== 'Sensível' && b.answer).map((b) => `${b.questionPt || b.questionEn}: ${b.answer}`),
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

const SENSITIVE_LABEL = /\b(cpf|rg|identidade|nascimento|birth|endereco|address|rua|cep|zip|passaporte|passport|ssn|social security|banco|bank|agencia|conta corrente|account number|pis|ctps|titulo de eleitor)\b/;

function hash(s: string): string {
  return createHash('sha256').update(normalize(s)).digest('hex').slice(0, 16);
}
