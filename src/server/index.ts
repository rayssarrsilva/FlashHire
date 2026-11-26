import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { extractText, getDocumentProxy } from 'unpdf';
import { z } from 'zod';
import { detectLang } from '../core/text';
import type { ResumeData } from '../core/types';
import { Store } from '../db/db';
import { DEFAULT_SETTINGS, Engine } from '../engine/engine';
import { bankFromRows, googleSheetCsvUrl, linksFromRows, parseCsv, readRows } from '../import/sheet';

const ROOT = resolve(import.meta.dirname, '../..');
const DATA = resolve(process.env.FLASHHIRE_DATA ?? join(ROOT, 'data'));
const PORT = Number(process.env.PORT ?? 4173);
const HOST = '127.0.0.1';
const TOKEN = randomBytes(32).toString('hex');

mkdirSync(join(DATA, 'resumes'), { recursive: true });
const store = new Store(join(DATA, 'flashhire.db'));
store.requeueInterrupted();
const engine = new Engine(store, {
  dataDir: DATA,
  browser: { channel: process.env.FLASHHIRE_BROWSER as 'chrome' | 'msedge' | undefined, executablePath: process.env.CHROME_PATH },
});

const app = Fastify({ bodyLimit: 12 * 1024 * 1024, logger: false });

// ---------- security ----------
const allowedHosts = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const allowedOrigins = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);

app.addHook('onRequest', async (req, reply) => {
  // Blocks DNS-rebinding: only requests addressed to this computer.
  if (!allowedHosts.has(req.headers.host ?? '')) return reply.code(421).send({ error: 'Host não permitido' });
  if (req.url.startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin)) return reply.code(403).send({ error: 'Origem não permitida' });
    const given = (req.headers['x-flashhire-token'] as string | undefined) ?? (req.query as { token?: string }).token ?? '';
    const a = Buffer.from(given);
    const b = Buffer.from(TOKEN);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return reply.code(401).send({ error: 'Sessão inválida. Recarregue a página.' });
  }
});

app.addHook('onSend', async (_req, reply, payload) => {
  reply.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  reply.header('Cross-Origin-Resource-Policy', 'same-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  reply.header('Cache-Control', 'no-store');
  return payload;
});

app.setErrorHandler((err, _req, reply) => {
  const status = err instanceof z.ZodError ? 400 : ((err as { statusCode?: number }).statusCode ?? 400);
  reply.code(status).send({ error: err instanceof z.ZodError ? 'Dados inválidos' : err instanceof Error ? err.message : String(err) });
});

const needUnlocked = async (_req: FastifyRequest, reply: FastifyReply) => {
  if (!store.isUnlocked) return reply.code(423).send({ error: 'Cofre bloqueado. Digite a senha mestra.' });
};

// ---------- vault ----------
const Password = z.object({ password: z.string().min(1).max(256) });
let failedUnlocks = 0;

app.post('/api/vault/setup', async (req) => {
  store.setup(Password.parse(req.body).password);
  seedFromDataDir();
  return { ok: true };
});
app.post('/api/vault/unlock', async (req, reply) => {
  if (failedUnlocks >= 5) await new Promise((r) => setTimeout(r, 2000 * (failedUnlocks - 4)));
  if (!store.unlock(Password.parse(req.body).password)) {
    failedUnlocks++;
    return reply.code(401).send({ error: 'Senha incorreta.' });
  }
  failedUnlocks = 0;
  return { ok: true };
});
app.post('/api/vault/lock', async () => {
  engine.stop();
  store.lock();
  return { ok: true };
});

// ---------- state ----------
app.get('/api/state', async () => ({
  setUp: store.isSetUp,
  unlocked: store.isUnlocked,
  running: engine.isRunning,
  settings: engine.settings,
  appliedToday: store.appliedToday(),
  pendings: store.isUnlocked ? engine.pendings() : [],
  ai: store.isUnlocked ? { gemini: !!store.secret('ai.gemini'), groq: !!store.secret('ai.groq') } : { gemini: false, groq: false },
  resumes: store.isUnlocked ? store.resumes().length : 0,
  bank: store.isUnlocked ? store.bank().length : 0,
}));

app.get('/api/events', async (req, reply) => {
  reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
  const send = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const onChange = () => send('change', {});
  const onPending = (p: unknown) => send('pending', p);
  const onNotice = (m: string) => send('notice', m);
  engine.on('change', onChange);
  engine.on('pending', onPending);
  engine.on('notice', onNotice);
  const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
  req.raw.on('close', () => {
    clearInterval(ping);
    engine.off('change', onChange);
    engine.off('pending', onPending);
    engine.off('notice', onNotice);
  });
  return reply;
});

// ---------- jobs ----------
app.get('/api/jobs', { preHandler: needUnlocked }, async () => store.jobs());
app.get('/api/stats', { preHandler: needUnlocked }, async () => ({ bySite: store.statsBySite(), byWeek: store.statsByWeek() }));

app.post('/api/jobs/links', { preHandler: needUnlocked }, async (req) => {
  const { text } = z.object({ text: z.string().max(200_000) }).parse(req.body);
  return engine.addLinks(linksFromRows(parseCsv(text)));
});

const FileUpload = z.object({ fileName: z.string().max(200), base64: z.string().max(16_000_000) });
const SheetUrl = z.object({ sheetUrl: z.string().url().max(2000) });

app.post('/api/jobs/import', { preHandler: needUnlocked }, async (req) => {
  const rows = await rowsFromUpload(req.body);
  return engine.addLinks(linksFromRows(rows));
});

app.post('/api/jobs/:id/requeue', { preHandler: needUnlocked }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  store.updateJob(id, { status: 'queued', note: null });
  engine.emit('change');
  return { ok: true };
});
app.post('/api/jobs/:id/interview', { preHandler: needUnlocked }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  store.updateJob(id, { interview: z.object({ value: z.boolean() }).parse(req.body).value });
  return { ok: true };
});

// ---------- logins (before the run) ----------
const Sites = z.array(z.enum(['linkedin', 'gupy', 'indeed', 'glassdoor']));
app.get('/api/logins', { preHandler: needUnlocked }, async () => ({ platforms: engine.loginStatus(), windowOpen: engine.loginWindowOpen }));
app.post('/api/logins/open', { preHandler: needUnlocked }, async (req) => engine.openLogins(Sites.optional().parse((req.body as { sites?: unknown } | undefined)?.sites)));
app.post('/api/logins/mark', { preHandler: needUnlocked }, async (req) => {
  const b = z.object({ sites: Sites, ok: z.boolean() }).parse(req.body);
  engine.setLoggedIn(b.sites, b.ok);
  return { ok: true };
});

app.post('/api/engine/start', { preHandler: needUnlocked }, async () => {
  await engine.start();
  return { ok: true };
});
app.post('/api/engine/stop', async () => {
  engine.stop();
  return { ok: true };
});

// ---------- inbox ----------
app.post('/api/pendings/:id/reply', { preHandler: needUnlocked }, async (req) => {
  const body = z
    .object({ done: z.enum(['continue', 'submitted', 'skip']), answers: z.record(z.string(), z.string().max(5000)).optional(), save: z.boolean().optional() })
    .parse(req.body);
  engine.reply((req.params as { id: string }).id, body);
  return { ok: true };
});
app.post('/api/pendings/:id/focus', { preHandler: needUnlocked }, async (req) => {
  return engine.focus((req.params as { id: string }).id);
});

// ---------- answer bank ----------
app.get('/api/bank', { preHandler: needUnlocked }, async () => store.bank());
app.post('/api/bank', { preHandler: needUnlocked }, async (req) => {
  const b = z.object({ question: z.string().min(1).max(500), answer: z.string().min(1).max(5000), answerEn: z.string().max(5000).optional() }).parse(req.body);
  return { id: store.upsertBank({ key: null, questionPt: b.question, questionEn: b.question, kind: 'Texto', answer: b.answer, answerEn: b.answerEn ?? null }) };
});
app.put('/api/bank/:id', { preHandler: needUnlocked }, async (req) => {
  const id = Number((req.params as { id: string }).id);
  const b = z.object({ answer: z.string().min(1).max(5000), answerEn: z.string().max(5000).nullable().optional() }).parse(req.body);
  const e = store.bank().find((x) => x.id === id);
  if (!e) throw new Error('Resposta não encontrada');
  const kind = e.kind === 'IA' || e.kind === 'Aprendida' ? 'Texto' : e.kind;
  store.upsertBank({ key: e.key, questionPt: e.questionPt, questionEn: e.questionEn, kind, answer: b.answer, answerEn: b.answerEn ?? null });
  return { ok: true };
});
app.delete('/api/bank/:id', { preHandler: needUnlocked }, async (req) => {
  store.deleteBank(Number((req.params as { id: string }).id));
  return { ok: true };
});
app.post('/api/bank/import', { preHandler: needUnlocked }, async (req) => {
  const result = bankFromRows(await rowsFromUpload(req.body));
  for (const r of result.rows) store.upsertBank(r);
  return { imported: result.rows.length, needsWrittenAnswer: result.needsWrittenAnswer, empty: result.skippedEmpty };
});

// ---------- résumés ----------
app.get('/api/resumes', { preHandler: needUnlocked }, async () =>
  store.resumes().map((r) => ({ id: r.id, name: r.name, lang: r.lang, tailorable: !!r.data, chars: r.text.length })),
);
app.post('/api/resumes', { preHandler: needUnlocked }, async (req) => {
  const b = z
    .object({ name: z.string().min(1).max(80), lang: z.enum(['pt', 'en']).optional(), fileName: z.string().max(200), base64: z.string().max(16_000_000), dataJson: z.string().max(500_000).optional() })
    .parse(req.body);
  if (!/\.pdf$/i.test(b.fileName)) throw new Error('Envie o currículo em PDF.');
  const buf = Buffer.from(b.base64, 'base64');
  if (buf.subarray(0, 5).toString() !== '%PDF-') throw new Error('O arquivo não é um PDF válido.');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  const safeName = b.fileName.replace(/[^\w.-]+/g, '-').slice(0, 80);
  const path = join(DATA, 'resumes', `${Date.now()}-${safeName}`);
  writeFileSync(path, buf);
  let data: ResumeData | null = null;
  if (b.dataJson) data = JSON.parse(b.dataJson) as ResumeData;
  return { id: store.addResume({ name: b.name, lang: b.lang ?? detectLang(text), pdfPath: path, text, data }) };
});
app.delete('/api/resumes/:id', { preHandler: needUnlocked }, async (req) => {
  store.deleteResume(Number((req.params as { id: string }).id));
  return { ok: true };
});

// ---------- settings & AI keys ----------
const SettingsBody = z.object({
  threshold: z.number().int().min(0).max(100),
  maxParallel: z.number().int().min(1).max(4),
  maxWaiting: z.number().int().min(1).max(12),
  dailyCap: z.number().int().min(1).max(60),
  linkedinDailyCap: z.number().int().min(0).max(40),
  autoSubmit: z.boolean(),
  tailor: z.boolean(),
  englishLevel: z.enum(['basic', 'intermediate', 'advanced', 'fluent']),
  experienceYears: z.number().min(0).max(40),
  minSalaryBRL: z.number().min(0),
  onsiteMinSalaryBRL: z.number().min(0),
  geminiModel: z.string().min(1).max(80),
  groqModel: z.string().min(1).max(80),
  browser: z.enum(['auto', 'msedge', 'chrome']),
  learn: z.boolean(),
});
app.put('/api/settings', { preHandler: needUnlocked }, async (req) => {
  store.setJson('settings', { ...DEFAULT_SETTINGS, ...SettingsBody.partial().parse(req.body) });
  engine.emit('change');
  return { ok: true };
});
app.put('/api/ai', { preHandler: needUnlocked }, async (req) => {
  const b = z.object({ gemini: z.string().max(200).nullable().optional(), groq: z.string().max(200).nullable().optional() }).parse(req.body);
  if (b.gemini !== undefined) store.setSecret('ai.gemini', b.gemini);
  if (b.groq !== undefined) store.setSecret('ai.groq', b.groq);
  return { ok: true };
});

// ---------- UI ----------
const WEB = join(ROOT, 'dist/web');
if (existsSync(WEB)) {
  const indexHtml = readFileSync(join(WEB, 'index.html'), 'utf8').replace('<!--FH_TOKEN-->', `<meta name="fh-token" content="${TOKEN}">`);
  app.register(fastifyStatic, { root: WEB, index: false, wildcard: false });
  app.get('/', async (_req, reply) => reply.type('text/html').send(indexHtml));
}

async function rowsFromUpload(body: unknown): Promise<string[][]> {
  const asUrl = SheetUrl.safeParse(body);
  if (asUrl.success) {
    const csvUrl = googleSheetCsvUrl(asUrl.data.sheetUrl);
    if (!csvUrl) throw new Error('Cole o link de uma planilha do Google Sheets.');
    const res = await fetch(csvUrl, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error('Não consegui ler a planilha. Compartilhe como "Qualquer pessoa com o link".');
    return parseCsv(await res.text());
  }
  const f = FileUpload.parse(body);
  if (!/\.(xlsx|csv)$/i.test(f.fileName)) throw new Error('Envie .xlsx ou .csv.');
  return readRows(Buffer.from(f.base64, 'base64'), f.fileName);
}

/** On first setup, imports the files the installer placed in data/seed (style guide, résumé data). */
function seedFromDataDir(): void {
  const seed = join(DATA, 'seed', 'bank.csv');
  if (existsSync(seed)) {
    const result = bankFromRows(parseCsv(readFileSync(seed, 'utf8')));
    for (const r of result.rows) store.upsertBank(r);
  }
}

await app.listen({ host: HOST, port: PORT });
const url = `http://${HOST}:${PORT}`;
console.log(`\n  FlashHire rodando em ${url}\n  (só este computador acessa; feche esta janela para encerrar)\n`);
if (!process.argv.includes('--no-open')) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd[0] as string, cmd[1] as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
}
