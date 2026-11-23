import type { Page } from 'playwright';
import { normalize } from '../core/text';
import type { ResolvedAnswer } from '../core/types';
import { clickTagged, fillField, findButton, findFields, hasCaptcha, invalidFieldLabels, looksSubmitted, needsLogin, type FoundField } from './dom';
import { pause, type Pace } from './human';

export type WaitKind = 'login' | 'captcha' | 'questions' | 'submit' | 'manual';

/** What the candidate chose in the "Sua vez" inbox. */
export interface UserReply {
  done: 'continue' | 'submitted' | 'skip';
  answers?: Record<string, string>;
}

export interface ApplyHooks {
  pace: Pace;
  log: (msg: string) => void;
  waitUser: (kind: WaitKind, message: string, page: Page, questions?: FoundField[]) => Promise<UserReply>;
  answer: (field: FoundField) => Promise<ResolvedAnswer | null>;
  resumePath: () => Promise<string>;
  letterPath: () => Promise<string>;
  letterText: () => Promise<string>;
  /** True when the candidate must click "Send" herself on this page (site rules) or auto-submit is off. */
  manualSubmit: (page: Page) => boolean;
}

export interface ApplyOutcome {
  status: 'submitted' | 'skipped' | 'failed';
  note: string;
  page: Page;
}

const LETTER_FIELD = /cover letter|carta de apresenta|carta de motiva|motivation letter|covering letter/;

export async function runApplication(start: Page, h: ApplyHooks): Promise<ApplyOutcome> {
  let page = start;
  let root: string | null = null;

  const checkGates = async () => {
    if (await needsLogin(page)) {
      h.log('Página pede login');
      const r = await h.waitUser('login', 'Entre na sua conta nesta aba (só na primeira vez). Depois clique em "Continuar".', page);
      if (r.done !== 'continue') return r;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
    }
    if (await hasCaptcha(page)) {
      h.log('Captcha encontrado');
      const r = await h.waitUser('captcha', 'Resolva o captcha nesta aba e clique em "Continuar".', page);
      if (r.done !== 'continue') return r;
    }
    return null;
  };

  // 1) Reach the form: click "Apply" / "Easy Apply" until fields appear (it may open a new tab or a dialog).
  for (let attempt = 0; attempt < 4; attempt++) {
    const gate = await checkGates();
    if (gate) return finishFromReply(gate, page);
    root = (await page.locator('[role="dialog"]:visible').count().catch(() => 0)) > 0 ? '[role="dialog"]' : null;
    const fields = (await findFields(page, root)).filter((f) => !/pesquis|search|buscar/.test(normalize(f.label)));
    if (fields.length > 0 || (await findButton(page, ['submit', 'next'], root))) break;
    const apply = await findButton(page, ['apply'], root);
    if (!apply) break;
    h.log(`Clicando em "${apply.text}"`);
    const popup = page.context().waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await clickTagged(apply.frame, apply.id);
    const newPage = await popup;
    if (newPage) {
      page = newPage;
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      h.log(`Abriu ${new URL(page.url()).host}`);
    }
    await pause(h.pace.afterClick);
  }

  // 2) Fill step by step.
  let stuck = 0;
  for (let step = 0; step < 25; step++) {
    const gate = await checkGates();
    if (gate) return finishFromReply(gate, page);
    if (await looksSubmitted(page)) return { status: 'submitted', note: 'Confirmação do site detectada', page };

    root = (await page.locator('[role="dialog"]:visible').count().catch(() => 0)) > 0 ? '[role="dialog"]' : null;
    const fields = await findFields(page, root);
    const unresolved: FoundField[] = [];

    for (const f of fields) {
      if (f.type === 'file') {
        const isLetter = /cover|carta|motivation/.test(normalize(f.label));
        if (isLetter && !f.required) continue;
        const path = isLetter ? await h.letterPath() : await h.resumePath();
        await fillField(f, path, h.pace, { resume: path, letter: path });
        h.log(`${isLetter ? 'Carta' : 'Currículo'} anexado`);
        continue;
      }
      if (f.type === 'textarea' && LETTER_FIELD.test(normalize(f.label))) {
        await fillField(f, await h.letterText(), h.pace, { resume: '' });
        h.log('Carta de apresentação escrita');
        continue;
      }
      const a = await h.answer(f);
      if (a) {
        const ok = await fillField(f, a.value, h.pace, { resume: '' });
        if (ok) {
          h.log(`"${short(f.label)}" ← ${a.source}`);
          continue;
        }
      }
      if (f.required || f.invalid) unresolved.push(f);
    }

    if (unresolved.length > 0) {
      h.log(`${unresolved.length} pergunta(s) para você`);
      const r = await h.waitUser('questions', 'Responda aqui (eu preencho e guardo para as próximas) ou preencha direto na aba.', page, unresolved);
      if (r.done !== 'continue') return finishFromReply(r, page);
      for (const f of unresolved) {
        const v = r.answers?.[f.id];
        if (v) await fillField(f, v, h.pace, { resume: '' });
      }
    }

    const button = await findButton(page, ['submit', 'next'], root);
    if (!button) {
      if (++stuck > 1 || fields.length === 0) {
        const r = await h.waitUser('manual', 'Não reconheci esta etapa (teste, vídeo ou formato novo). Faça-a nesta aba e me diga como ficou.', page);
        if (r.done !== 'continue') return finishFromReply(r, page);
        stuck = 0;
      }
      await pause(h.pace.afterClick);
      continue;
    }
    stuck = 0;

    if (button.kind === 'submit') {
      if (h.manualSubmit(page)) {
        h.log('Pronta: aguardando você clicar em Enviar');
        const r = await h.waitUser('submit', `Está tudo preenchido. Revise e clique em "${button.text}" nesta aba.`, page);
        if (r.done === 'continue') continue;
        return finishFromReply(r, page);
      }
      const urlBefore = page.url();
      h.log(`Clicando em "${button.text}"`);
      await clickTagged(button.frame, button.id);
      await pause([h.pace.afterClick[0] * 1.5, h.pace.afterClick[1] * 1.5]);
      if (await looksSubmitted(page)) return { status: 'submitted', note: 'Confirmação do site detectada', page };
      const invalid = await invalidFieldLabels(page);
      if (invalid.length) {
        h.log(`O site recusou: ${invalid.slice(0, 3).join(', ')}`);
        continue;
      }
      if (page.url() !== urlBefore && !(await findButton(page, ['submit'], root))) {
        return { status: 'submitted', note: 'Enviada (o site mudou de página, sem mensagem de confirmação)', page };
      }
      const r = await h.waitUser('manual', 'Cliquei em enviar, mas não vi confirmação. Confira a aba e me diga como ficou.', page);
      if (r.done === 'continue') continue;
      return finishFromReply(r, page);
    }

    h.log(`Clicando em "${button.text}"`);
    await clickTagged(button.frame, button.id);
    await pause(h.pace.afterClick);
  }
  const r = await h.waitUser('manual', 'Esta candidatura tem etapas demais para mim. Termine nesta aba e me diga como ficou.', page);
  return finishFromReply(r, page);
}

function finishFromReply(r: UserReply, page: Page): ApplyOutcome {
  if (r.done === 'submitted') return { status: 'submitted', note: 'Enviada (confirmado por você)', page };
  return { status: 'skipped', note: 'Pulada por você', page };
}

function short(s: string): string {
  return s.length > 50 ? `${s.slice(0, 47)}…` : s;
}
