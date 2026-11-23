import { rankProjects } from './letter';
import { extractSkills } from './skills';
import { normalize } from './text';
import type { ResumeData } from './types';

/**
 * Tailors a résumé to a job WITHOUT adding anything:
 * skills the job asks for move to the front of each group, groups and projects
 * are reordered by relevance. Every word comes from the original résumé.
 */
export function tailorResume(resume: ResumeData, jobSkills: string[]): ResumeData {
  const wanted = new Set(jobSkills);
  const isWanted = (item: string) => extractSkills(normalize(item)).some((s) => wanted.has(s));

  const skills = resume.skills
    .map((g) => {
      const hits = g.items.filter(isWanted);
      const rest = g.items.filter((i) => !isWanted(i));
      return { group: g.group, items: [...hits, ...rest], hits: hits.length };
    })
    .sort((a, b) => b.hits - a.hits)
    .map(({ group, items }) => ({ group, items }));

  const projects = rankProjects(resume, jobSkills).map(({ p }) => p);
  return { ...resume, skills, projects };
}

/** density 0 = roomy … 3 = tight. The PDF step lowers it until the résumé fits one page (never below 9 pt). */
export const DENSITIES = [
  { font: 9.6, line: 1.32, margin: 12, gap: 9 },
  { font: 9.4, line: 1.27, margin: 11, gap: 7 },
  { font: 9.2, line: 1.24, margin: 10, gap: 6 },
  { font: 9.0, line: 1.2, margin: 9, gap: 5 },
] as const;

export function resumeHtml(r: ResumeData, density = 0): string {
  const d = DENSITIES[Math.min(Math.max(density, 0), DENSITIES.length - 1)]!;
  const e = escapeHtml;
  const section = (title: string, body: string) => (body ? `<section><h2>${e(title)}</h2>${body}</section>` : '');
  const entries = (list: ResumeData['projects']) =>
    list
      .map(
        (x) =>
          `<div class="entry"><div class="row"><strong>${e(x.title)}</strong>${x.meta ? `<span>${e(x.meta)}</span>` : ''}</div>${
            x.bullets.length ? `<ul>${x.bullets.map((b) => `<li>${e(b)}</li>`).join('')}</ul>` : ''
          }</div>`,
      )
      .join('');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${e(r.name)}</title><style>
@page { size: A4; margin: ${d.margin}mm ${d.margin + 2}mm; }
* { box-sizing: border-box; }
body { font-family: Arial, Helvetica, sans-serif; font-size: ${d.font}pt; line-height: ${d.line}; color: #111; margin: 0; }
h1 { font-size: 17pt; margin: 0 0 2px; }
.headline { font-size: 10.5pt; margin: 0 0 4px; }
.contact { margin: 0 0 2px; }
h2 { font-size: 10pt; letter-spacing: .04em; text-transform: uppercase; border-bottom: 1px solid #111; margin: ${d.gap}px 0 3px; padding-bottom: 1px; }
p { margin: 0 0 3px; }
ul { margin: 2px 0 4px 16px; padding: 0; }
li { margin: 0 0 1px; }
.row { display: flex; justify-content: space-between; gap: 12px; }
.row span { white-space: nowrap; }
.entry { margin-bottom: 4px; }
</style></head><body>
<h1>${e(r.name)}</h1>
<p class="headline">${e(r.headline)}</p>
${r.contact.map((c) => `<p class="contact">${e(c)}</p>`).join('')}
${section(r.labels.summary, r.summary ? `<p>${e(r.summary)}</p>` : '')}
${section(r.labels.skills, r.skills.map((g) => `<p><strong>${e(g.group)}:</strong> ${e(g.items.join(', '))}</p>`).join(''))}
${section(r.labels.projects, entries(r.projects))}
${section(r.labels.experience, entries(r.experience))}
${section(r.labels.education, entries(r.education))}
${r.extras.map((x) => section(x.title, x.items.map((i) => `<p>${e(i)}</p>`).join(''))).join('')}
</body></html>`;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
