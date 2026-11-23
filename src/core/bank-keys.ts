/**
 * Semantic keys for answers that rules use directly.
 * The answer-bank spreadsheet uses ids P001…; this maps them to keys.
 */
export const SHEET_KEYS: Record<string, string> = {
  P001: 'contact.fullName',
  P002: 'contact.preferredName',
  P003: 'contact.email',
  P004: 'contact.phone',
  P005: 'personal.birthDate',
  P006: 'personal.cpf',
  P007: 'personal.rg',
  P008: 'personal.nationality',
  P009: 'address.zip',
  P010: 'address.street',
  P011: 'address.neighborhood',
  P012: 'address.cityState',
  P013: 'address.country',
  P014: 'address.timezone',
  P015: 'links.linkedin',
  P016: 'links.github',
  P017: 'links.portfolio',
  P018: 'links.other',
  P027: 'lang.english',
  P032: 'years.total',
  P033: 'years.frontend',
  P034: 'years.JavaScript',
  P035: 'years.TypeScript',
  P036: 'years.React',
  P037: 'years.Next.js',
  P038: 'years.Angular',
  P039: 'years.Vue',
  P040: 'years.HTML',
  P041: 'years.Tailwind CSS',
  P042: 'years.Automated testing',
  P043: 'years.QA',
  P044: 'years.Git',
  P045: 'years.Figma',
  P046: 'years.Node.js',
  P047: 'years.SQL',
  P048: 'years.Docker',
  P049: 'years.Scrum/Agile',
  P050: 'years.REST APIs',
  P051: 'years.Python',
  P067: 'work.model',
  P076: 'salary.frontend.junior.clt',
  P077: 'salary.frontend.junior.pj',
  P078: 'salary.frontend.mid.clt',
  P079: 'salary.frontend.mid.pj',
  P080: 'salary.qa.junior.clt',
  P081: 'salary.qa.junior.pj',
  P082: 'salary.qa.mid.clt',
  P083: 'salary.usd.junior',
  P084: 'salary.usd.mid',
  P085: 'salary.eur.junior',
  P086: 'salary.eur.mid',
  P089: 'salary.minimum',
  P140: 'style.sample',
};

/** Keys whose answers never leave the computer (not even to the AI). */
export const SENSITIVE_PREFIXES = ['personal.', 'address.street', 'address.zip', 'contact.phone'];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_PREFIXES.some((p) => key.startsWith(p));
}

/** Skills whose "years of experience" question reuses another key. */
export const YEARS_ALIASES: Record<string, string> = {
  CSS: 'HTML',
  Sass: 'HTML',
  Jest: 'Automated testing',
  Vitest: 'Automated testing',
  'Testing Library': 'Automated testing',
  Playwright: 'Automated testing',
  Cypress: 'Automated testing',
  Selenium: 'Automated testing',
  'Manual testing': 'QA',
  'Test cases/plans': 'QA',
  'Bug reporting': 'QA',
  PostgreSQL: 'SQL',
  MySQL: 'SQL',
  'UI/UX': 'Figma',
  'CI/CD': 'Git',
};
