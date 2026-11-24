import type { Frame, Page } from 'playwright';
import type { FieldOption, FieldQuestion } from '../core/types';
import { normalize } from '../core/text';
import { pause, rand, type Pace } from './human';

export interface FoundField extends FieldQuestion {
  id: string;
  frame: Frame;
  multiple: boolean;
  combobox: boolean;
  invalid: boolean;
}

interface RawField {
  id: string;
  type: FieldQuestion['type'];
  label: string;
  required: boolean;
  options: FieldOption[];
  multiple: boolean;
  combobox: boolean;
  invalid: boolean;
}

/**
 * Runs inside the page. Finds every visible, empty, editable field in `root`
 * and tags it with data-fh-id so it can be filled later.
 */
function scanFields(rootSelector: string | null): RawField[] {
  const w = window as unknown as { __fh?: number };
  w.__fh = w.__fh ?? 0;
  const root: ParentNode = (rootSelector && document.querySelector(rootSelector)) || document;
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const visible = (el: Element) => {
    const r = (el as HTMLElement).getBoundingClientRect();
    const st = getComputedStyle(el as HTMLElement);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none';
  };
  const textOf = (ids: string | null) =>
    clean(
      (ids ?? '')
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' '),
    );
  const labelFor = (el: HTMLElement): string => {
    const byAria = textOf(el.getAttribute('aria-labelledby'));
    if (byAria) return byAria;
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l && clean(l.textContent)) return clean(l.textContent);
    }
    const wrap = el.closest('label');
    if (wrap && clean(wrap.textContent)) return clean(wrap.textContent);
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    // nearest container text that is not the field itself
    let node: HTMLElement | null = el.parentElement;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const lab = node.querySelector('label, legend, [class*="label" i], [class*="question" i], h3, h4, p');
      if (lab && !lab.contains(el) && clean(lab.textContent)) return clean(lab.textContent).slice(0, 300);
    }
    return clean(el.getAttribute('placeholder') || el.getAttribute('name') || '');
  };
  const isRequired = (el: HTMLElement, label: string) =>
    (el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true' || /\*\s*$|\(obrigat|\brequired\b/i.test(label);
  const tag = (el: Element) => {
    let id = el.getAttribute('data-fh-id');
    if (!id) {
      id = `f${++w.__fh!}`;
      el.setAttribute('data-fh-id', id);
    }
    return id;
  };

  const out: RawField[] = [];
  const groups = new Map<string, HTMLInputElement[]>();
  const els = Array.from(root.querySelectorAll('input, textarea, select, [role="combobox"]'));
  for (const el of els) {
    const h = el as HTMLInputElement;
    const t = (h.getAttribute('type') || h.tagName).toLowerCase();
    if (['hidden', 'submit', 'button', 'image', 'reset', 'search'].includes(t)) continue;
    if (h.disabled || h.readOnly) continue;
    // Site search bars (job boards' "what / where" boxes) are not part of the application.
    if (h.closest('header, nav, [role="search"], [role="banner"]')) continue;
    if (/^(q|what|where|keywords?|location|l|text-input-what|text-input-where|search)$/i.test(h.name || h.id || '') && !h.required && !h.closest('[role="dialog"]')) continue;
    if (t === 'radio' || t === 'checkbox') {
      const key = `${t}:${h.name || labelFor(h)}`;
      const g = groups.get(key) ?? [];
      g.push(h);
      groups.set(key, g);
      continue;
    }
    if (t === 'file') {
      if (h.files && h.files.length > 0) continue;
      const label = labelFor(h);
      out.push({ id: tag(h), type: 'file', label, required: isRequired(h, label), options: [], multiple: false, combobox: false, invalid: false });
      continue;
    }
    if (!visible(h)) continue;
    const isCombo = h.getAttribute('role') === 'combobox' && h.tagName !== 'SELECT';
    if (h.tagName === 'SELECT') {
      const s = h as unknown as HTMLSelectElement;
      const first = s.options[0];
      const placeholderSelected = s.selectedIndex <= 0 && (!first || !first.value || /selec|select|escolha|choose/i.test(first.text));
      if (!placeholderSelected) continue;
      const label = labelFor(s);
      out.push({
        id: tag(s),
        type: 'select',
        label,
        required: isRequired(s, label),
        options: Array.from(s.options).map((o) => ({ label: clean(o.text), value: o.value })),
        multiple: s.multiple,
        combobox: false,
        invalid: s.getAttribute('aria-invalid') === 'true',
      });
      continue;
    }
    if (isCombo) {
      const shown = clean((h as HTMLInputElement).value || h.textContent);
      const container = h.closest('[class*="select" i]');
      const chosen = container?.querySelector('[class*="single-value" i], [class*="singleValue" i]');
      if (chosen && clean(chosen.textContent)) continue;
      if (shown && h.tagName !== 'INPUT') continue;
      const label = labelFor(h);
      out.push({ id: tag(h), type: 'select', label, required: isRequired(h, label), options: [], multiple: false, combobox: true, invalid: h.getAttribute('aria-invalid') === 'true' });
      continue;
    }
    if ((h.value ?? '').trim()) continue;
    const label = labelFor(h);
    const type = (h.tagName === 'TEXTAREA' ? 'textarea' : ['email', 'tel', 'url', 'number', 'date'].includes(t) ? t : 'text') as FieldQuestion['type'];
    out.push({ id: tag(h), type, label, required: isRequired(h, label), options: [], multiple: false, combobox: false, invalid: h.getAttribute('aria-invalid') === 'true' });
  }

  for (const [key, inputs] of groups) {
    const type = key.startsWith('radio') ? 'radio' : 'checkbox';
    if (!inputs.some((i) => visible(i) || visible(i.closest('label') ?? i))) continue;
    if (type === 'radio' && inputs.some((i) => i.checked)) continue;
    const first = inputs[0]!;
    const fs = first.closest('fieldset');
    const legend = fs ? clean(fs.querySelector('legend')?.textContent) : '';
    const groupLabel =
      legend ||
      textOf(first.closest('[role="radiogroup"], [role="group"]')?.getAttribute('aria-labelledby') ?? null) ||
      (() => {
        let node: HTMLElement | null = first.parentElement;
        for (let d = 0; node && d < 5; d++, node = node.parentElement) {
          if (inputs.every((i) => node!.contains(i))) {
            const lab = node.querySelector('legend, label:not(:has(input)), [class*="label" i], [class*="question" i], h3, h4, p');
            if (lab && clean(lab.textContent)) return clean(lab.textContent);
          }
        }
        return '';
      })();
    const options = inputs.map((i) => ({ label: labelFor(i), value: tag(i) }));
    if (type === 'checkbox' && inputs.length === 1) {
      if (first.checked) continue;
      const label = options[0]!.label || groupLabel;
      out.push({ id: tag(first), type: 'checkbox', label, required: isRequired(first, label), options: [], multiple: false, combobox: false, invalid: false });
      continue;
    }
    if (type === 'checkbox' && inputs.some((i) => i.checked)) continue;
    out.push({
      id: `g${tag(first)}`,
      type,
      label: groupLabel || options.map((o) => o.label).join(' / '),
      required: inputs.some((i) => isRequired(i, groupLabel)) || /\*/.test(groupLabel),
      options,
      multiple: type === 'checkbox',
      combobox: false,
      invalid: inputs.some((i) => i.getAttribute('aria-invalid') === 'true'),
    });
  }
  return out;
}

export async function findFields(page: Page, rootSelector: string | null = null): Promise<FoundField[]> {
  const all: FoundField[] = [];
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame() && /recaptcha|hcaptcha|turnstile|challenges\.cloudflare/.test(frame.url())) continue;
    try {
      const raw = await frame.evaluate(scanFields, frame === page.mainFrame() ? rootSelector : null);
      for (const r of raw) all.push({ ...r, frame });
    } catch {
      // detached or cross-process frame mid-navigation → ignore this round
    }
  }
  return applyOptionalConvention(all);
}

const OPTIONAL = /\((opcional|optional|facultativo)\)|\bopcional\s*$|\boptional\s*$/i;

/**
 * Many forms (Indeed, LinkedIn, Lever) mark only the OPTIONAL questions and leave the
 * required ones unmarked, without the `required` attribute. When a page uses that
 * convention, every unmarked question is required.
 */
export function applyOptionalConvention<T extends { label: string; required: boolean }>(fields: T[]): T[] {
  if (!fields.some((f) => OPTIONAL.test(f.label))) return fields;
  return fields.map((f) => ({ ...f, required: !OPTIONAL.test(f.label) }));
}

/** Fills one field with a human pace. Returns false if the page refused the value. */
export async function fillField(f: FoundField, value: string, pace: Pace, files: { resume: string; letter?: string }): Promise<boolean> {
  const loc = f.frame.locator(`[data-fh-id="${f.id.replace(/^g/, '')}"]`).first();
  try {
    switch (f.type) {
      case 'file': {
        const isLetter = /cover|carta|motivation/i.test(normalize(f.label));
        const path = isLetter ? files.letter : files.resume;
        if (!path) return false;
        await loc.setInputFiles(path);
        break;
      }
      case 'select': {
        if (f.combobox) return await fillCombobox(f, value, pace);
        await loc.selectOption(value).catch(async () => loc.selectOption({ label: value }));
        break;
      }
      case 'radio': {
        await f.frame.locator(`[data-fh-id="${value}"]`).check({ force: true });
        break;
      }
      case 'checkbox': {
        if (f.options.length > 1) {
          for (const v of value.split('|')) await f.frame.locator(`[data-fh-id="${v}"]`).check({ force: true });
        } else if (/^(sim|yes|true|aceito|concordo|agree|accept)/i.test(normalize(value))) {
          await loc.check({ force: true });
        }
        break;
      }
      case 'date': {
        const br = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
        await loc.fill(br ? `${br[3]}-${br[2]}-${br[1]}` : value);
        break;
      }
      default: {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 5000 }).catch(() => {});
        if (value.length > 160) await loc.fill(value);
        else {
          await loc.fill('');
          await loc.pressSequentially(value, { delay: rand(pace.typingDelay[0], pace.typingDelay[1]) });
        }
      }
    }
    await pause(pace.betweenFields);
    return true;
  } catch {
    return false;
  }
}

async function fillCombobox(f: FoundField, value: string, pace: Pace): Promise<boolean> {
  const loc = f.frame.locator(`[data-fh-id="${f.id}"]`).first();
  await loc.click();
  await loc.pressSequentially(value.slice(0, 24), { delay: rand(pace.typingDelay[0], pace.typingDelay[1]) }).catch(() => {});
  await pause([400, 900]);
  const options = f.frame.locator('[role="option"]');
  const count = await options.count();
  if (count === 0) {
    await loc.press('Enter').catch(() => {});
    return true;
  }
  const texts = await options.allInnerTexts();
  const want = normalize(value);
  let idx = texts.findIndex((t) => normalize(t) === want);
  if (idx < 0) idx = texts.findIndex((t) => normalize(t).includes(want) || want.includes(normalize(t)));
  if (idx < 0) idx = 0;
  await options.nth(idx).click();
  await pause(pace.betweenFields);
  return true;
}

export type ButtonKind = 'submit' | 'next' | 'apply';

/** Buttons the candidate clicked to get past steps FlashHire did not know, per site. */
const LEARNED = new Map<string, { submit: Set<string>; next: Set<string> }>();

export function setLearnedButtons(data: Record<string, { submit: string[]; next: string[] }>): void {
  LEARNED.clear();
  for (const [host, v] of Object.entries(data)) LEARNED.set(host, { submit: new Set(v.submit), next: new Set(v.next) });
}

/** True when FlashHire already knows what this button does (built-in rules or learned). */
export function isKnownButton(text: string, host: string): boolean {
  const t = normalize(text);
  if (SUBMIT.test(t) || NEXT.test(t) || APPLY.test(t)) return true;
  const l = LEARNED.get(host);
  return !!l && (l.next.has(t) || l.submit.has(t));
}

export function isIgnorableButton(text: string): boolean {
  const t = normalize(text);
  return t.length < 2 || t.length > 40 || NEVER.test(t) || /cookie|aceitar todos|accept all|fechar|close|menu|ajuda|help|idioma|language|sair|logout|perfil|profile/.test(t);
}

const SUBMIT = /^(enviar|enviar candidatura|enviar inscricao|submit|submit application|send application|send|finalizar|finalizar candidatura|concluir|concluir candidatura|confirmar candidatura|apply now and submit)\b/;
const NEXT = /^(proximo|proxima|proxima etapa|next|continuar|continue|avancar|review|revisar|revisar candidatura|review your application|salvar e continuar|save and continue|seguir|ir para)\b/;
const APPLY =
  /^(candidatura simplificada|easy apply|candidatar se|candidatar|candidate se|quero me candidatar|aplicar|apply|apply now|apply for this job|apply for this position|apply on company site|candidatar se no site da empresa|i m interested|tenho interesse)\b/;
const NEVER = /voltar|back|cancel|cancelar|descartar|discard|salvar rascunho|save draft|fechar|close|sign in with|entrar com/;

export async function findButton(page: Page, kinds: ButtonKind[], rootSelector: string | null = null): Promise<{ kind: ButtonKind; frame: Frame; id: string; text: string } | null> {
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame() && /recaptcha|hcaptcha|turnstile/.test(frame.url())) continue;
    let found: { id: string; text: string }[] = [];
    try {
      found = await frame.evaluate((root) => {
        const w = window as unknown as { __fh?: number };
        w.__fh = w.__fh ?? 0;
        const scope: ParentNode = (root && document.querySelector(root)) || document;
        const els = Array.from(scope.querySelectorAll('button, input[type="submit"], [role="button"], a[href]'));
        return els
          .filter((el) => {
            const r = (el as HTMLElement).getBoundingClientRect();
            return r.width > 0 && r.height > 0 && !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true';
          })
          .map((el) => {
            let id = el.getAttribute('data-fh-id');
            if (!id) {
              id = `b${++w.__fh!}`;
              el.setAttribute('data-fh-id', id);
            }
            const text = ((el as HTMLInputElement).value || el.getAttribute('aria-label') || el.textContent || '').replace(/\s+/g, ' ').trim();
            return { id, text };
          });
      }, frame === page.mainFrame() ? rootSelector : null);
    } catch {
      continue;
    }
    let host = '';
    try {
      host = new URL(frame.url()).host;
    } catch {
      /* about:blank */
    }
    const learned = LEARNED.get(host);
    for (const kind of kinds) {
      const re = kind === 'submit' ? SUBMIT : kind === 'next' ? NEXT : APPLY;
      const known = kind === 'apply' ? undefined : learned?.[kind];
      const hit = found.find((b) => {
        const t = normalize(b.text);
        return t.length < 60 && !NEVER.test(t) && (re.test(t) || !!known?.has(t));
      });
      if (hit) return { kind, frame, id: hit.id, text: hit.text };
    }
  }
  return null;
}

export async function clickTagged(frame: Frame, id: string): Promise<void> {
  const loc = frame.locator(`[data-fh-id="${id}"]`).first();
  await loc.scrollIntoViewIfNeeded().catch(() => {});
  await loc.click({ timeout: 10_000 });
}

export async function hasCaptcha(page: Page): Promise<boolean> {
  for (const f of page.frames()) {
    if (/recaptcha\/api2\/bframe|hcaptcha\.com\/captcha|challenges\.cloudflare\.com/.test(f.url())) {
      const el = await f.frameElement().catch(() => null);
      if (el && (await el.isVisible().catch(() => false))) return true;
    }
  }
  return page
    .locator('iframe[title*="captcha" i]:visible, iframe[src*="recaptcha/api2/anchor"]:visible, iframe[src*="hcaptcha"]:visible, #challenge-form')
    .count()
    .then((n) => n > 0)
    .catch(() => false);
}

export async function needsLogin(page: Page): Promise<boolean> {
  const url = page.url();
  if (/linkedin\.com\/(login|authwall|checkpoint|uas\/login|signup)/.test(url)) return true;
  if (/gupy\.io\/(candidates\/)?(auth|signin|login)/.test(url) || /login\.gupy\.io/.test(url)) return true;
  if (/secure\.indeed\.com\/auth|glassdoor\.[^/]+\/profile\/login/.test(url)) return true;
  return page
    .locator('input[type="password"]:visible')
    .count()
    .then((n) => n > 0)
    .catch(() => false);
}

const CONFIRM =
  /candidatura (foi )?(enviada|recebida|realizada|concluida|registrada)|inscricao (realizada|concluida|enviada)|obrigad[oa] (por|pela) (se candidatar|sua candidatura|candidatura)|application (was )?(submitted|received|sent|complete)|thank(s| you) for (applying|your application|your interest)|we ve received your application|your application has been/;

export async function looksSubmitted(page: Page): Promise<boolean> {
  const text = await page
    .locator('body')
    .innerText({ timeout: 5000 })
    .catch(() => '');
  return CONFIRM.test(normalize(text.slice(0, 20_000)));
}

export async function invalidFieldLabels(page: Page): Promise<string[]> {
  const labels: string[] = [];
  for (const frame of page.frames()) {
    try {
      const l = await frame.evaluate(() => {
        const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
        const out: string[] = [];
        for (const el of Array.from(document.querySelectorAll('[aria-invalid="true"]'))) {
          const id = el.id;
          const lab = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent) || el.getAttribute('aria-label') || el.closest('label')?.textContent;
          out.push(clean(lab) || clean(el.getAttribute('name')));
        }
        return out.filter(Boolean);
      });
      labels.push(...l);
    } catch {
      /* ignore */
    }
  }
  return labels;
}
