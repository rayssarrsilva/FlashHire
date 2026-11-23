import type { Page } from 'playwright';

export interface ExtractedJob {
  title: string;
  company: string;
  description: string;
}

/** Reads title, company and description from any job page (site selectors first, then generic). */
export async function extractJob(page: Page): Promise<ExtractedJob> {
  return page.evaluate(() => {
    const clean = (s: string | null | undefined) => (s ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    const pick = (sels: string[]) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        const t = clean((el as HTMLElement | null)?.innerText ?? el?.getAttribute('content'));
        if (t) return t;
      }
      return '';
    };
    const title = pick([
      '.job-details-jobs-unified-top-card__job-title h1',
      '.jobs-unified-top-card__job-title',
      '[data-testid="job-title"]',
      '[data-test="job-title"]',
      '.posting-headline h2',
      'h1',
      'meta[property="og:title"]',
    ]);
    const company = pick([
      '.job-details-jobs-unified-top-card__company-name',
      '.jobs-unified-top-card__company-name',
      '[data-testid="company-name"]',
      '[data-test="employer-name"]',
      '[data-company-name]',
      '.company-name',
      '.main-header-logo img[alt]',
      'meta[property="og:site_name"]',
    ]);
    // Description: the largest text block that looks like one.
    const candidates = Array.from(
      document.querySelectorAll('#job-details, .jobs-description__content, [class*="description" i], [data-testid*="description" i], article, main, section'),
    ) as HTMLElement[];
    let description = '';
    for (const c of candidates) {
      const t = clean(c.innerText);
      if (t.length > description.length && t.length < 30_000) description = t;
    }
    if (description.length < 200) description = clean(document.body.innerText).slice(0, 15_000);
    return { title: title.slice(0, 200), company: company.replace(/\s*[|·-].*$/, '').slice(0, 120), description: description.slice(0, 15_000) };
  });
}
