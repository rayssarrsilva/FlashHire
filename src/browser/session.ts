import { readFileSync } from 'node:fs';
import { chromium, type BrowserContext, type Browser } from 'playwright';

/**
 * esbuild (used by tsx) can wrap functions with __name(); functions passed to
 * page.evaluate then fail in the page. This shim makes them safe in every frame.
 */
export const EVALUATE_SHIM = 'globalThis.__name = globalThis.__name || ((f) => f);';

export interface BrowserOptions {
  profileDir: string;
  /** 'chrome' uses the Chrome installed on the computer. */
  channel?: 'chrome' | 'msedge' | undefined;
  executablePath?: string | undefined;
  headless?: boolean;
}

/**
 * Opens FlashHire's own Chrome profile (kept between runs), where the candidate
 * signs in to LinkedIn, Gupy and Indeed once. Passwords never reach FlashHire.
 */
export async function openContext(o: BrowserOptions): Promise<BrowserContext> {
  const ctx = await chromium.launchPersistentContext(o.profileDir, {
    channel: o.executablePath ? undefined : (o.channel ?? 'chrome'),
    executablePath: o.executablePath,
    headless: o.headless ?? false,
    viewport: null,
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    args: ['--start-maximized'],
  });
  await ctx.addInitScript({ content: EVALUATE_SHIM });
  return ctx;
}

let pdfBrowser: Browser | null = null;

/** Renders HTML to a PDF with a separate headless browser (PDF printing needs headless). */
export async function htmlToPdf(html: string, outPath: string, o: Pick<BrowserOptions, 'channel' | 'executablePath'>): Promise<void> {
  if (!pdfBrowser) {
    pdfBrowser = await chromium.launch({ channel: o.executablePath ? undefined : (o.channel ?? 'chrome'), executablePath: o.executablePath, headless: true });
  }
  const page = await pdfBrowser.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: outPath, format: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    await page.close();
  }
}

/** Renders a résumé at decreasing densities until it fits one page (keeps the last try otherwise). */
export async function resumeToPdf(render: (density: number) => string, levels: number, outPath: string, o: Pick<BrowserOptions, 'channel' | 'executablePath'>): Promise<number> {
  let pages = 0;
  for (let d = 0; d < levels; d++) {
    await htmlToPdf(render(d), outPath, o);
    pages = (readFileSync(outPath, 'latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    if (pages <= 1) break;
  }
  return pages;
}

export async function closePdfBrowser(): Promise<void> {
  await pdfBrowser?.close();
  pdfBrowser = null;
}
