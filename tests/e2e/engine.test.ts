import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../../src/db/db';
import { DEFAULT_SETTINGS, Engine, type Pending } from '../../src/engine/engine';
import { TEST_PACE } from '../../src/browser/human';
import { EVALUATE_SHIM } from '../../src/browser/session';

const CHROME = process.env.CHROME_PATH ?? '/usr/bin/google-chrome';
let server: Server;
let base = '';
let browser: Browser;
let ctx: BrowserContext;
const dataDir = mkdtempSync(join(tmpdir(), 'flashhire-'));

beforeAll(async () => {
  server = createServer((req, res) => {
    const file = join(__dirname, '../fixtures', (req.url ?? '/').split('?')[0]!.replace(/^\//, ''));
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ executablePath: CHROME, headless: true });
  ctx = await browser.newContext();
  await ctx.addInitScript({ content: EVALUATE_SHIM });
});

afterAll(async () => {
  await browser?.close();
  server?.close();
});

function makeEngine(settings: Partial<typeof DEFAULT_SETTINGS> = {}) {
  const store = new Store(':memory:');
  store.setup('senha-de-teste-123');
  store.setJson('settings', { ...DEFAULT_SETTINGS, ...settings });
  const pdf = join(dataDir, 'cv.pdf');
  writeFileSync(pdf, '%PDF-1.4 test');
  store.addResume({
    name: 'TI',
    lang: 'pt',
    pdfPath: pdf,
    text: 'React Next.js TypeScript JavaScript HTML CSS Jest Playwright Git Figma WCAG Node.js',
    data: null,
  });
  const entries: [string, string, string, string?][] = [
    ['contact.fullName', 'Nome completo', 'Rayssa Roberta Rodrigues Silva'],
    ['contact.email', 'E-mail', 'rayssa@example.com'],
    ['contact.phone', 'Telefone', '+55 34 99999-0000'],
    ['links.linkedin', 'LinkedIn', 'https://www.linkedin.com/in/rayssa'],
    ['salary.frontend.junior.clt', 'Pretensão – Frontend Júnior, CLT', 'R$ 5.000 por mês'],
    ['salary.usd.junior', 'Pretensão – Júnior, exterior', 'US$ 1.800 por mês'],
    ['years.React', 'Anos com React', '1'],
    ['sheet.P092', 'Tem autorização para trabalhar no Brasil?', 'Sim', 'Are you authorized to work in Brazil?'],
    ['sheet.P106', 'Tem parentes ou amigos na empresa?', 'Não', 'Do you have relatives working here?'],
    ['sheet.P111', 'Concorda com a política de privacidade / LGPD?', 'Sim', 'Do you agree to the privacy policy?'],
  ];
  for (const [key, q, a, en] of entries) store.upsertBank({ key, questionPt: q, questionEn: en ?? '', kind: 'Texto', answer: a });
  const engine = new Engine(store, { dataDir, browser: { executablePath: CHROME }, pace: TEST_PACE, context: ctx });
  return { store, engine };
}

async function until<T>(fn: () => T | null | undefined | false, ms = 60_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
}

const done = (s: string) => ['submitted', 'skipped', 'failed'].includes(s);

describe('FlashHire engine on local pages', () => {
  it('fills and submits a one-page ATS form (Greenhouse-like) with no help', async () => {
    const { store, engine } = makeEngine();
    engine.addLinks([`${base}/ats-single.html`]);
    await engine.start();
    const job = await until(() => {
      const j = store.jobs()[0]!;
      return done(j.status) && j;
    });
    expect(job.note).toMatch(/Confirmação/);
    expect(job.status).toBe('submitted');
    expect(job.title).toBe('Junior Frontend Developer');
    expect(job.score).toBeGreaterThanOrEqual(45);
    expect(job.letter).toContain('Hello Acme Labs team');
    const log = job.log.map((l) => l.msg).join('\n');
    expect(log).toContain('Currículo anexado');
    expect(log).toMatch(/salary expectations.*rule/);
  });

  it('goes through a multi-step Gupy-like flow', async () => {
    const { store, engine } = makeEngine();
    engine.addLinks([`${base}/gupy-steps.html`]);
    await engine.start();
    const job = await until(() => {
      const j = store.jobs()[0]!;
      return done(j.status) && j;
    });
    expect(job.status).toBe('submitted');
    expect(job.company).toBe('Empresa X');
  });

  it('asks the candidate what it does not know, keeps working, and waits for her to click Send on manual sites', async () => {
    const { store, engine } = makeEngine({ autoSubmit: false });
    const pendings: Pending[] = [];
    engine.on('pending', (p: Pending) => pendings.push(p));
    engine.addLinks([`${base}/easy-apply.html`, `${base}/gupy-steps.html?second`]);
    await engine.start();

    const q = await until(() => pendings.find((p) => p.kind === 'questions'));
    expect(q.questions.map((x) => x.label)).toEqual(['Qual o nome do seu primeiro animal de estimação? *']);
    // While she has not answered, the second job keeps going on its own.
    await until(() => pendings.some((p) => p.jobId !== q.jobId));

    engine.reply(q.id, { done: 'continue', answers: { [q.questions[0]!.fieldId]: 'Pipoca' } });
    const submit = await until(() => pendings.find((p) => p.kind === 'submit' && p.jobId === q.jobId));
    engine.reply(submit.id, { done: 'submitted' });
    for (const p of engine.pendings()) engine.reply(p.id, { done: 'submitted' });

    await until(() => store.jobs().every((j) => done(j.status)));
    expect(store.jobs().filter((j) => j.status === 'submitted')).toHaveLength(2);
    // The new answer was saved for next time.
    expect(store.bank().some((b) => b.answer === 'Pipoca')).toBe(true);
  });

  it('skips jobs below the threshold or blocked by the on-site rule, and never applies twice', async () => {
    const { store, engine } = makeEngine({ threshold: 101 });
    const r = engine.addLinks([`${base}/ats-single.html`, `${base}/ats-single.html`]);
    expect(r.duplicates).toBe(1);
    await engine.start();
    const job = await until(() => {
      const j = store.jobs()[0]!;
      return done(j.status) && j;
    });
    expect(job.status).toBe('skipped');
    expect(job.note).toMatch(/abaixo de 101%/);
  });
});
