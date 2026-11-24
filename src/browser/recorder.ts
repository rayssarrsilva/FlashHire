import type { Page } from 'playwright';

/**
 * While a job waits for the candidate, FlashHire watches what she does in that tab
 * (what she answers and which buttons she clicks) so it can do it alone next time.
 * Passwords and file pickers are never recorded. Nothing is recorded while FlashHire itself is filling.
 */
export interface Recorded {
  kind: 'field' | 'click';
  label: string;
  value: string;
  host: string;
  type: string;
  at: number;
}

const BINDING = '__flashhireRecord';

/** Runs in the page: reports changes and clicks through the exposed binding. */
const RECORDER_SCRIPT = `(() => {
  if (window.__fhRecorderOn) return; window.__fhRecorderOn = true;
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const labelFor = (el) => {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) { const t = clean(ids.split(/\\s+/).map((i) => document.getElementById(i)?.textContent || '').join(' ')); if (t) return t; }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && clean(l.textContent)) return clean(l.textContent); }
    const fs = el.closest('fieldset'); if ((el.type === 'radio' || el.type === 'checkbox') && fs?.querySelector('legend')) return clean(fs.querySelector('legend').textContent);
    const wrap = el.closest('label'); if (wrap && el.type !== 'radio' && el.type !== 'checkbox' && clean(wrap.textContent)) return clean(wrap.textContent);
    if (el.getAttribute('aria-label')) return clean(el.getAttribute('aria-label'));
    let n = el.parentElement;
    for (let d = 0; n && d < 5; d++, n = n.parentElement) { const lab = n.querySelector('label, legend, [class*="label" i], [class*="question" i], h3, h4, p'); if (lab && !lab.contains(el) && clean(lab.textContent)) return clean(lab.textContent).slice(0, 300); }
    return clean(el.getAttribute('placeholder') || el.getAttribute('name') || '');
  };
  const send = (r) => { try { window.${BINDING}({ ...r, host: location.host, at: Date.now() }); } catch {} };
  document.addEventListener('change', (e) => {
    const el = e.target; if (!el || !el.tagName) return;
    const type = (el.type || el.tagName).toLowerCase();
    if (['password', 'file', 'hidden'].includes(type)) return;
    let value = '';
    if (el.tagName === 'SELECT') value = clean(el.options[el.selectedIndex]?.text);
    else if (type === 'radio') { if (!el.checked) return; value = clean(el.closest('label')?.textContent) || clean(document.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.textContent) || el.value; }
    else if (type === 'checkbox') value = el.checked ? 'Sim' : 'Não';
    else value = el.value;
    send({ kind: 'field', label: labelFor(el), value: String(value).slice(0, 5000), type });
  }, true);
  document.addEventListener('click', (e) => {
    const b = e.target?.closest?.('button, [role="button"], input[type="submit"], a');
    if (!b) return;
    send({ kind: 'click', label: clean(b.value || b.getAttribute('aria-label') || b.textContent).slice(0, 80), value: '', type: 'button' });
  }, true);
})();`;

const installed = new WeakSet<Page>();
const sessions = new WeakMap<Page, Recorded[] | null>();

export async function startRecording(page: Page): Promise<void> {
  if (!installed.has(page)) {
    installed.add(page);
    await page.exposeBinding(BINDING, (_src, r: Recorded) => {
      const list = sessions.get(page);
      if (list) list.push(r);
    });
    await page.addInitScript({ content: RECORDER_SCRIPT });
  }
  sessions.set(page, []);
  for (const f of page.frames()) await f.evaluate(RECORDER_SCRIPT).catch(() => {});
}

/** Stops recording and returns what the candidate did, last value per question. */
export function stopRecording(page: Page): Recorded[] {
  const list = sessions.get(page) ?? [];
  sessions.set(page, null);
  return list;
}

export interface Lessons {
  answers: { label: string; value: string; type: string }[];
  buttons: { host: string; text: string; kind: 'next' | 'submit' }[];
}

/** Turns raw events into lessons: final answer per question, and the buttons used to advance. */
export function lessonsFrom(events: Recorded[], finished: boolean, isKnown: (text: string, host: string) => boolean, isIgnorable: (text: string) => boolean): Lessons {
  const byLabel = new Map<string, { label: string; value: string; type: string }>();
  for (const e of events) {
    if (e.kind !== 'field' || !e.label || !e.value.trim()) continue;
    byLabel.set(e.label, { label: e.label, value: e.value.trim(), type: e.type });
  }
  const clicks = events.filter((e) => e.kind === 'click' && e.label && !isIgnorable(e.label) && !isKnown(e.label, e.host));
  const buttons = clicks.map((c, i) => ({ host: c.host, text: c.label, kind: (finished && i === clicks.length - 1 ? 'submit' : 'next') as 'next' | 'submit' }));
  return { answers: [...byLabel.values()], buttons };
}
