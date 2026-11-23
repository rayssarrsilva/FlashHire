import ExcelJS from 'exceljs';
import { SHEET_KEYS } from '../core/bank-keys';

/** Reads rows (array of cell strings) from an .xlsx or .csv buffer. */
export async function readRows(buf: Buffer, fileName: string): Promise<string[][]> {
  if (/\.xlsx$/i.test(fileName)) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) return [];
    const rows: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, col) => {
        const v = cell.value as unknown;
        let text = '';
        if (v && typeof v === 'object') {
          const o = v as { hyperlink?: string; text?: unknown; result?: unknown; richText?: { text: string }[] };
          text = o.hyperlink ?? (o.richText ? o.richText.map((r) => r.text).join('') : String(o.text ?? o.result ?? ''));
        } else text = v === null || v === undefined ? '' : String(v);
        cells[col - 1] = text;
      });
      rows.push(Array.from(cells, (c) => c ?? ''));
    });
    return rows;
  }
  return parseCsv(buf.toString('utf8').replace(/^﻿/, ''));
}

export function parseCsv(text: string): string[][] {
  const delimiter = (text.split('\n')[0] ?? '').split(';').length > (text.split('\n')[0] ?? '').split(',').length ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim()));
}

/** One link per row: the first cell of each row that looks like a URL. */
export function linksFromRows(rows: string[][]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const cell = r.find((c) => /https?:\/\/\S+/.test(c));
    const m = cell?.match(/https?:\/\/\S+/);
    if (m) out.push(m[0].replace(/[)\],;]+$/, ''));
  }
  return out;
}

/** Turns a Google Sheets link into its CSV export link (the sheet must be shared "anyone with the link"). */
export function googleSheetCsvUrl(url: string): string | null {
  const m = url.match(/docs\.google\.com\/spreadsheets\/d\/([\w-]+)/);
  if (!m) return null;
  const gid = url.match(/[#&?]gid=(\d+)/)?.[1] ?? '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}

export interface BankImportRow {
  key: string;
  questionPt: string;
  questionEn: string;
  kind: string;
  answer: string;
}

export interface BankImportResult {
  rows: BankImportRow[];
  needsWrittenAnswer: string[];
  skippedEmpty: number;
}

/**
 * Reads the answer-bank sheet (columns: ID, Categoria, Pergunta (PT), Sua resposta,
 * Sugestão, Question (EN), Tipo, …). "ok" accepts the suggestion, unless the suggestion
 * is itself a question for the candidate.
 */
export function bankFromRows(rows: string[][]): BankImportResult {
  const header = rows[0]?.map((h) => h.toLowerCase()) ?? [];
  const col = (re: RegExp, fallback: number) => {
    const i = header.findIndex((h) => re.test(h));
    return i >= 0 ? i : fallback;
  };
  const cId = col(/^id$/, 0);
  const cPt = col(/pergunta/, 2);
  const cAns = col(/sua resposta|resposta|answer/, 3);
  const cSug = col(/sugest/, 4);
  const cEn = col(/question/, 5);
  const cKind = col(/tipo|type/, 6);

  const out: BankImportResult = { rows: [], needsWrittenAnswer: [], skippedEmpty: 0 };
  for (const r of rows.slice(1)) {
    const id = (r[cId] ?? '').trim();
    const pt = (r[cPt] ?? '').trim();
    if (!pt) continue;
    let answer = (r[cAns] ?? '').trim();
    const suggestion = (r[cSug] ?? '').trim();
    if (!answer) {
      out.skippedEmpty++;
      continue;
    }
    if (/^ok\.?$/i.test(answer)) {
      if (!suggestion || /\?|confirme|diga |faltam/i.test(suggestion)) {
        out.needsWrittenAnswer.push(`${id} ${pt}`);
        continue;
      }
      answer = suggestion;
    }
    answer = answer.replace(/\s*\((padrão|o sistema)[^)]*\)/gi, '').replace(/^'/, '').trim();
    out.rows.push({ key: SHEET_KEYS[id] ?? `sheet.${id || pt.slice(0, 40)}`, questionPt: pt, questionEn: (r[cEn] ?? '').trim(), kind: (r[cKind] ?? 'Texto').trim(), answer });
  }
  return out;
}
