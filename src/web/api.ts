const token = document.querySelector<HTMLMetaElement>('meta[name="fh-token"]')?.content ?? '';

export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'x-flashhire-token': token, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Erro ${res.status}`);
  return data;
}

export function events(onChange: () => void, onPending: (p: Pending) => void, onNotice: (m: string) => void): () => void {
  const es = new EventSource(`/api/events?token=${token}`);
  es.addEventListener('change', onChange);
  es.addEventListener('pending', (e) => onPending(JSON.parse((e as MessageEvent).data) as Pending));
  es.addEventListener('notice', (e) => onNotice(JSON.parse((e as MessageEvent).data) as string));
  return () => es.close();
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export interface PendingQuestion { fieldId: string; label: string; type: string; required: boolean; options: string[]; suggestion: string | null }
export interface Pending { id: string; jobId: number; jobTitle: string; company: string; kind: 'login' | 'captcha' | 'questions' | 'submit' | 'manual'; message: string; questions: PendingQuestion[]; createdAt: string }
export interface Settings {
  threshold: number; maxParallel: number; maxWaiting: number; dailyCap: number; linkedinDailyCap: number;
  autoSubmit: boolean; tailor: boolean; englishLevel: 'basic' | 'intermediate' | 'advanced' | 'fluent';
  experienceYears: number; minSalaryBRL: number; onsiteMinSalaryBRL: number; geminiModel: string; groqModel: string; browser: 'auto' | 'msedge' | 'chrome'; learn: boolean;
}
export interface State { setUp: boolean; unlocked: boolean; running: boolean; settings: Settings; appliedToday: number; pendings: Pending[]; ai: { gemini: boolean; groq: boolean }; resumes: number; bank: number }
export interface Job {
  id: number; url: string; site: string; status: string; title: string; company: string; score: number | null; note: string | null;
  match: { matched: string[]; missing: string[]; reasons: string[] } | null; tailoredPath: string | null; letter: string | null;
  appliedAt: string | null; interview: boolean; log: { at: string; msg: string }[];
}
export interface BankEntry { id: number; key: string; questionPt: string; questionEn: string; answer: string; answerEn: string | null; kind: string }
export interface ResumeItem { id: number; name: string; lang: 'pt' | 'en'; tailorable: boolean; chars: number }
