import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Browser } from 'playwright';

/**
 * esbuild (used by tsx) can wrap functions with __name(); functions passed to
 * page.evaluate then fail in the page. This shim makes them safe in every frame.
 */
export const EVALUATE_SHIM = 'globalThis.__name = globalThis.__name || ((f) => f);';

export type BrowserChoice = 'auto' | 'msedge' | 'chrome';

export interface BrowserOptions {
  /** Folder that keeps FlashHire's own browser profiles (one per browser). */
  profileDir: string;
  /** Installed browser to use. 'auto' tries Edge first on Windows (it always comes with it), then Chrome. */
  channel?: BrowserChoice | undefined;
  executablePath?: string | undefined;
  headless?: boolean;
}

export function channelsToTry(choice: BrowserChoice = 'auto', platform = process.platform): ('msedge' | 'chrome')[] {
  if (choice !== 'auto') return [choice];
  return platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge'];
}

let resolved: 'msedge' | 'chrome' | null = null;

/** Name shown to the candidate ("Edge" / "Chrome"). */
export function browserName(): string {
  return resolved === 'msedge' ? 'Edge' : resolved === 'chrome' ? 'Chrome' : 'navegador';
}

/**
 * Opens FlashHire's own browser profile (kept between runs, separate from the candidate's
 * everyday profile), where she signs in to LinkedIn, Gupy and Indeed once. Passwords never reach FlashHire.
 */
export async function openContext(o: BrowserOptions): Promise<BrowserContext> {
  const errors: string[] = [];
  const candidates = o.executablePath ? [null] : channelsToTry(o.channel);
  for (const channel of candidates) {
    try {
      const ctx = await chromium.launchPersistentContext(channel ? join(o.profileDir, channel) : o.profileDir, {
        channel: channel ?? undefined,
        executablePath: o.executablePath,
        headless: o.headless ?? false,
        viewport: null,
        locale: 'pt-BR',
        timezoneId: 'America/Sao_Paulo',
        args: ['--start-maximized'],
      });
      resolved = channel ?? 'chrome';
      await ctx.addInitScript({ content: EVALUATE_SHIM });
      return ctx;
    } catch (e) {
      errors.push(`${channel}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(`Não consegui abrir o navegador (${errors.join(' | ')}). Escolha Edge ou Chrome em Ajustes.`);
}

let pdfBrowser: Browser | null = null;

/** Renders HTML to a PDF with a separate headless browser (PDF printing needs headless). */
export async function htmlToPdf(html: string, outPath: string, o: Pick<BrowserOptions, 'channel' | 'executablePath'>): Promise<void> {
  if (!pdfBrowser) {
    pdfBrowser = await chromium.launch({ channel: o.executablePath ? undefined : (resolved ?? channelsToTry(o.channel)[0]), executablePath: o.executablePath, headless: true });
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
