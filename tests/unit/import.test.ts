import { describe, expect, it } from 'vitest';
import { bankFromRows, googleSheetCsvUrl, linksFromRows, parseCsv } from '../../src/import/sheet';

describe('spreadsheet import', () => {
  it('one link per row, any column, csv with ; or ,', () => {
    expect(linksFromRows(parseCsv('vaga;link\nFront;https://a.gupy.io/job/1\n;\nQA;"https://www.linkedin.com/jobs/view/9/"\n'))).toEqual([
      'https://a.gupy.io/job/1',
      'https://www.linkedin.com/jobs/view/9/',
    ]);
  });
  it('Google Sheets link becomes its CSV export', () => {
    expect(googleSheetCsvUrl('https://docs.google.com/spreadsheets/d/abc_123/edit#gid=42')).toBe('https://docs.google.com/spreadsheets/d/abc_123/export?format=csv&gid=42');
  });
  it('answer bank: "ok" accepts a plain suggestion, never one that is a question', () => {
    const r = bankFromRows([
      ['ID', 'Categoria', 'Pergunta (PT)', 'Sua resposta', 'Sugestão', 'Question (EN)', 'Tipo'],
      ['P003', 'Dados', 'E-mail', 'ok', 'a@b.com', 'Email', 'Texto'],
      ['P008', 'Dados', 'Nacionalidade', 'ok', 'Brasileira?', 'Nationality', 'Texto'],
      ['P106', 'Triagem', 'Tem parentes?', 'Não (padrão)', '', '', 'Sim/Não'],
      ['P030', 'Idiomas', 'Espanhol', '', '', '', 'Escolha'],
      ['P076', 'Remuneração', 'Pretensão', 'R$ 4.800 por mês', 'R$ 5.000 por mês', '', 'Número'],
    ]);
    expect(r.rows.map((x) => [x.key, x.answer])).toEqual([
      ['contact.email', 'a@b.com'],
      ['sheet.P106', 'Não'],
      ['salary.frontend.junior.clt', 'R$ 4.800 por mês'],
    ]);
    expect(r.needsWrittenAnswer).toEqual(['P008 Nacionalidade']);
    expect(r.skippedEmpty).toBe(1);
  });
});
