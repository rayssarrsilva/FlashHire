import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { api, events, fileToBase64, type BankEntry, type Job, type Pending, type ResumeItem, type Settings, type State } from './api';

type Tab = 'inbox' | 'queue' | 'bank' | 'resumes' | 'results' | 'settings';

const STATUS: Record<string, string> = {
  queued: 'Na fila',
  running: 'Em andamento',
  waiting: 'Sua vez',
  ready: 'Pronta p/ enviar',
  submitted: 'Enviada',
  skipped: 'Pulada',
  failed: 'Falhou',
  duplicate: 'Repetida',
};
const KIND: Record<Pending['kind'], string> = {
  login: 'Login',
  captcha: 'Captcha',
  questions: 'Perguntas',
  submit: 'Revisar e enviar',
  manual: 'Etapa desconhecida',
};

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [tab, setTab] = useState<Tab>('inbox');
  const [toast, setToast] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    setState(await api<State>('/state'));
    setTick((t) => t + 1);
  }, []);

  useEffect(() => {
    void refresh();
    return events(
      () => void refresh(),
      (p) => {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('FlashHire: sua vez', { body: `${p.jobTitle} · ${KIND[p.kind]}` });
        }
      },
      (m) => setToast(m),
    );
  }, [refresh]);

  useEffect(() => {
    const n = state?.pendings.length ?? 0;
    document.title = n ? `(${n}) FlashHire` : 'FlashHire';
  }, [state?.pendings.length]);

  const notify = (e: unknown) => setToast(e instanceof Error ? e.message : String(e));

  if (!state) return <main className="center">Carregando…</main>;
  if (!state.unlocked) return <Lock setUp={state.setUp} onDone={refresh} />;

  const toggle = async () => {
    try {
      if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
      await api(state.running ? '/engine/stop' : '/engine/start', 'POST');
      await refresh();
    } catch (e) {
      notify(e);
    }
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden>
            ⚡
          </span>
          FlashHire
        </div>
        <div className="top-info">
          <span className={`pill ${state.running ? 'on' : ''}`}>{state.running ? 'Rodando' : 'Parado'}</span>
          <span>
            Hoje: <strong>{state.appliedToday}</strong> / {state.settings.dailyCap}
          </span>
          <button className="primary" onClick={toggle}>
            {state.running ? 'Pausar' : 'Iniciar'}
          </button>
          <button className="ghost" onClick={() => api('/vault/lock', 'POST').then(refresh)} title="Bloquear o cofre">
            Bloquear
          </button>
        </div>
      </header>
      <Logins tick={tick} onError={notify} onInfo={setToast} running={state.running} />
      <nav className="tabs" role="tablist">
        {(
          [
            ['inbox', `Sua vez${state.pendings.length ? ` (${state.pendings.length})` : ''}`],
            ['queue', 'Fila'],
            ['bank', `Respostas (${state.bank})`],
            ['resumes', `Currículos (${state.resumes}/5)`],
            ['results', 'Resultados'],
            ['settings', 'Ajustes'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </nav>
      <main className="content">
        {tab === 'inbox' && <Inbox pendings={state.pendings} onError={notify} onInfo={setToast} />}
        {tab === 'queue' && <Queue tick={tick} onError={notify} onInfo={setToast} />}
        {tab === 'bank' && <Bank tick={tick} onError={notify} onInfo={setToast} />}
        {tab === 'resumes' && <Resumes onError={notify} onChange={refresh} />}
        {tab === 'results' && <Results tick={tick} />}
        {tab === 'settings' && <SettingsView state={state} onError={notify} onSaved={() => (setToast('Ajustes salvos'), refresh())} />}
      </main>
      {toast && (
        <div className="toast" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
    </div>
  );
}

type LoginRow = { site: 'linkedin' | 'gupy' | 'indeed' | 'glassdoor'; label: string; queued: number; ok: boolean };

function Logins({ tick, onError, onInfo, running }: { tick: number; onError: (e: unknown) => void; onInfo: (m: string) => void; running: boolean }) {
  const [data, setData] = useState<{ platforms: LoginRow[]; windowOpen: boolean }>({ platforms: [], windowOpen: false });
  const [open, setOpen] = useState(false);
  const load = useCallback(() => api<typeof data>('/logins').then(setData).catch(() => {}), []);
  useEffect(() => {
    void load();
  }, [tick, load]);
  const missing = data.platforms.filter((p) => !p.ok);
  if (data.platforms.length === 0) return null;
  const mark = (sites: LoginRow['site'][], ok: boolean) => api('/logins/mark', 'POST', { sites, ok }).then(load).catch(onError);
  const openWindow = (sites: LoginRow['site'][]) =>
    api<{ browser: string }>('/logins/open', 'POST', { sites })
      .then((r) => {
        onInfo(`Abri uma janela normal do ${r.browser} com as páginas de login. Entre em cada uma (pode usar "Entrar com o Google"), feche a janela e marque aqui.`);
        void load();
      })
      .catch(onError);

  if (missing.length === 0 && !open && !data.windowOpen) {
    return (
      <p className="logins-ok small">
        ✓ Logins prontos: {data.platforms.map((p) => p.label).join(', ')} ·{' '}
        <button className="link" onClick={() => setOpen(true)}>
          refazer um login
        </button>
      </p>
    );
  }
  return (
    <section className="card logins" aria-labelledby="logins-title">
      <div className="row">
        <h2 id="logins-title">{missing.length ? 'Antes de iniciar: entre nas plataformas' : 'Logins'}</h2>
        {missing.length === 0 && (
          <button className="ghost small" onClick={() => setOpen(false)}>
            Fechar
          </button>
        )}
      </div>
      <p className="muted small">
        O Google bloqueia "Entrar com o Google" em navegador controlado por programa. Por isso o login é feito antes, numa janela normal do navegador que eu só abro. As sessões ficam salvas e eu
        envio pelas contas já logadas. Vagas de plataformas sem login esperam na fila; as outras seguem.
      </p>
      {data.windowOpen && <p className="pill">Janela de login aberta: quando terminar, feche-a e marque abaixo</p>}
      <ul className="plain">
        {data.platforms.map((p) => (
          <li key={p.site} className="row">
            <span>
              <strong>{p.label}</strong> · {p.queued} vaga(s) · <span className={`pill ${p.ok ? 'on' : 'st-waiting'}`}>{p.ok ? 'Pronto' : 'Falta entrar'}</span>
            </span>
            <span className="nowrap">
              <button className="ghost small" disabled={running} onClick={() => openWindow([p.site])}>
                Abrir login
              </button>
              <label className="check small">
                <input type="checkbox" checked={p.ok} onChange={(e) => mark([p.site], e.target.checked)} /> Já entrei
              </label>
            </span>
          </li>
        ))}
      </ul>
      <div className="actions">
        <button className="primary" disabled={running || missing.length === 0} onClick={() => openWindow(missing.map((m) => m.site))}>
          Abrir janela de login ({missing.length})
        </button>
        <button disabled={missing.length === 0} onClick={() => mark(missing.map((m) => m.site), true)}>
          Já entrei em todas
        </button>
      </div>
      {running && <p className="muted small">Para abrir a janela de login, pause primeiro.</p>}
    </section>
  );
}

function Lock({ setUp, onDone }: { setUp: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!setUp && password !== confirm) return setError('As senhas não são iguais.');
    try {
      await api(setUp ? '/vault/unlock' : '/vault/setup', 'POST', { password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <main className="center">
      <form className="card lock" onSubmit={submit}>
        <h1>⚡ FlashHire</h1>
        <p className="muted">
          {setUp
            ? 'Digite sua senha mestra para abrir o cofre.'
            : 'Crie uma senha mestra. Ela criptografa suas respostas, currículos e chaves neste computador. Não tem como recuperar: guarde bem.'}
        </p>
        <label>
          Senha mestra
          <input type="password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} minLength={setUp ? 1 : 10} required />
        </label>
        {!setUp && (
          <label>
            Repita a senha
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button className="primary">{setUp ? 'Abrir' : 'Criar cofre'}</button>
      </form>
    </main>
  );
}

function Inbox({ pendings, onError, onInfo }: { pendings: Pending[]; onError: (e: unknown) => void; onInfo: (m: string) => void }) {
  if (pendings.length === 0)
    return (
      <Empty title="Nada esperando por você">Quando uma vaga precisar de você (login, captcha, pergunta nova ou o clique final), ela aparece aqui e eu sigo com as outras.</Empty>
    );
  return (
    <div className="stack">
      {pendings.map((p) => (
        <PendingCard key={p.id} p={p} onError={onError} onInfo={onInfo} />
      ))}
    </div>
  );
}

function PendingCard({ p, onError, onInfo }: { p: Pending; onError: (e: unknown) => void; onInfo: (m: string) => void }) {
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(p.questions.map((q) => [q.fieldId, q.suggestion ?? ''])));
  const [save, setSave] = useState(true);
  const reply = (done: 'continue' | 'submitted' | 'skip') =>
    api(`/pendings/${p.id}/reply`, 'POST', { done, answers: Object.fromEntries(Object.entries(answers).filter(([, v]) => v.trim())), save }).catch(onError);
  return (
    <article className="card pending">
      <div className="row">
        <div>
          <span className={`pill kind-${p.kind}`}>{KIND[p.kind]}</span>
          <h3>{p.jobTitle}</h3>
          {p.company && <p className="muted">{p.company}</p>}
        </div>
        <button
          className="ghost"
          onClick={() =>
            api<{ title: string; url: string; browser: string }>(`/pendings/${p.id}/focus`, 'POST')
              .then((t) => onInfo(`Trouxe para a frente a janela do ${t.browser} do FlashHire: "${t.title || t.url}". Se não apareceu, procure o ícone do ${t.browser} na barra de tarefas.`))
              .catch(onError)
          }
        >
          Mostrar a aba
        </button>
      </div>
      <p>{p.message}</p>
      {p.questions.length > 0 && (
        <div className="questions">
          {p.questions.map((q) => (
            <label key={q.fieldId}>
              {q.label}
              {q.options.length > 0 ? (
                <select value={answers[q.fieldId] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.fieldId]: e.target.value })}>
                  <option value="">Escolha…</option>
                  {q.options
                    .filter((o) => !/^(selec|select|escolha|choose)/i.test(o))
                    .map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                </select>
              ) : q.type === 'textarea' ? (
                <textarea rows={4} value={answers[q.fieldId] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.fieldId]: e.target.value })} />
              ) : (
                <input value={answers[q.fieldId] ?? ''} onChange={(e) => setAnswers({ ...answers, [q.fieldId]: e.target.value })} />
              )}
            </label>
          ))}
          <label className="check">
            <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} /> Guardar estas respostas para as próximas vagas
          </label>
        </div>
      )}
      <div className="actions">
        <button className="primary" onClick={() => reply('continue')}>
          {p.questions.length ? 'Preencher e continuar' : 'Continuar'}
        </button>
        <button onClick={() => reply('submitted')}>Já enviei</button>
        <button className="ghost" onClick={() => reply('skip')}>
          Pular vaga
        </button>
      </div>
    </article>
  );
}

function Queue({ tick, onError, onInfo }: { tick: number; onError: (e: unknown) => void; onInfo: (m: string) => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [links, setLinks] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  useEffect(() => {
    api<Job[]>('/jobs').then(setJobs).catch(onError);
  }, [tick, onError]);

  const report = (r: { added: number; duplicates: number; warnings: { url: string; warning: string }[] }) =>
    onInfo(`${r.added} vaga(s) na fila${r.duplicates ? `, ${r.duplicates} repetida(s)` : ''}${r.warnings.length ? `, ${r.warnings.length} link(s) com problema (veja a fila)` : ''}.`);

  return (
    <div className="stack">
      <section className="card">
        <h2>Adicionar vagas</h2>
        <div className="grid3">
          <label>
            Planilha (.xlsx ou .csv, um link por linha)
            <input
              type="file"
              accept=".xlsx,.csv"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  report(await api('/jobs/import', 'POST', { fileName: f.name, base64: await fileToBase64(f) }));
                } catch (err) {
                  onError(err);
                }
                e.target.value = '';
              }}
            />
          </label>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                report(await api('/jobs/import', 'POST', { sheetUrl }));
                setSheetUrl('');
              } catch (err) {
                onError(err);
              }
            }}
          >
            <label>
              Link do Google Sheets
              <input type="url" placeholder="https://docs.google.com/spreadsheets/…" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} />
            </label>
            <button disabled={!sheetUrl}>Importar</button>
          </form>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                report(await api('/jobs/links', 'POST', { text: links }));
                setLinks('');
              } catch (err) {
                onError(err);
              }
            }}
          >
            <label>
              Ou cole os links
              <textarea rows={2} value={links} onChange={(e) => setLinks(e.target.value)} placeholder="Um link por linha" />
            </label>
            <button>Adicionar</button>
          </form>
        </div>
      </section>
      {jobs.length === 0 ? (
        <Empty title="Fila vazia">Adicione os links das vagas (Gupy, LinkedIn, Glassdoor, Indeed, sites remotos ou de empresas).</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Status</th>
                <th>Vaga</th>
                <th>Site</th>
                <th>Nota</th>
                <th>Observação</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <JobRowView key={j.id} j={j} open={open === j.id} onToggle={() => setOpen(open === j.id ? null : j.id)} onError={onError} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function JobRowView({ j, open, onToggle, onError }: { j: Job; open: boolean; onToggle: () => void; onError: (e: unknown) => void }) {
  return (
    <>
      <tr>
        <td>
          <span className={`pill st-${j.status}`}>{STATUS[j.status] ?? j.status}</span>
        </td>
        <td>
          <a href={j.url} target="_blank" rel="noreferrer noopener">
            {j.title || j.url.slice(0, 60)}
          </a>
          {j.company && <div className="muted small">{j.company}</div>}
        </td>
        <td>{j.site}</td>
        <td>{j.score !== null ? `${j.score}%` : '—'}</td>
        <td className="small">{j.note}</td>
        <td className="nowrap">
          {['skipped', 'failed'].includes(j.status) && (
            <button className="ghost small" onClick={() => api(`/jobs/${j.id}/requeue`, 'POST').catch(onError)}>
              Tentar de novo
            </button>
          )}
          {j.status === 'submitted' && (
            <label className="check small">
              <input type="checkbox" checked={j.interview} onChange={(e) => api(`/jobs/${j.id}/interview`, 'POST', { value: e.target.checked }).catch(onError)} /> Entrevista
            </label>
          )}
          <button className="ghost small" onClick={onToggle} aria-expanded={open}>
            {open ? 'Fechar' : 'Detalhes'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="details">
          <td colSpan={6}>
            {j.match && (
              <p className="small">
                <strong>Tem:</strong> {j.match.matched.join(', ') || '—'} · <strong>Falta:</strong> {j.match.missing.join(', ') || '—'}
                {j.match.reasons.length > 0 && <> · {j.match.reasons.join(' · ')}</>}
              </p>
            )}
            {j.tailoredPath && <p className="small">Currículo personalizado: {j.tailoredPath}</p>}
            {j.letter && (
              <details>
                <summary>Carta de apresentação</summary>
                <pre>{j.letter}</pre>
              </details>
            )}
            <ol className="log small">
              {j.log.map((l, i) => (
                <li key={i}>
                  <time>{new Date(l.at).toLocaleTimeString('pt-BR')}</time> {l.msg}
                </li>
              ))}
            </ol>
          </td>
        </tr>
      )}
    </>
  );
}

function Bank({ tick, onError, onInfo }: { tick: number; onError: (e: unknown) => void; onInfo: (m: string) => void }) {
  const [entries, setEntries] = useState<BankEntry[]>([]);
  const [q, setQ] = useState('');
  const [sheetUrl, setSheetUrl] = useState('');
  const load = useCallback(() => api<BankEntry[]>('/bank').then(setEntries).catch(onError), [onError]);
  useEffect(() => {
    void load();
  }, [tick, load]);
  const shown = useMemo(() => {
    const t = q.toLowerCase();
    const list = t ? entries.filter((e) => `${e.questionPt} ${e.questionEn} ${e.answer}`.toLowerCase().includes(t)) : entries;
    const review = (e: BankEntry) => Number(e.kind === 'IA' || e.kind === 'Aprendida' || e.kind === 'Sensível');
    return [...list].sort((a, b) => review(b) - review(a));
  }, [entries, q]);
  const imported = (r: { imported: number; needsWrittenAnswer: string[]; empty: number }) => {
    onInfo(`${r.imported} resposta(s) importada(s).${r.needsWrittenAnswer.length ? ` Precisam de resposta escrita: ${r.needsWrittenAnswer.join('; ')}` : ''}`);
    void load();
  };

  return (
    <div className="stack">
      <section className="card">
        <h2>Importar o banco de respostas</h2>
        <p className="muted small">Planilha com as colunas ID, Pergunta (PT), Sua resposta, Sugestão, Question (EN), Tipo. "ok" aceita a sugestão.</p>
        <div className="grid3">
          <label>
            Arquivo .xlsx ou .csv
            <input
              type="file"
              accept=".xlsx,.csv"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  imported(await api('/bank/import', 'POST', { fileName: f.name, base64: await fileToBase64(f) }));
                } catch (err) {
                  onError(err);
                }
                e.target.value = '';
              }}
            />
          </label>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                imported(await api('/bank/import', 'POST', { sheetUrl }));
              } catch (err) {
                onError(err);
              }
            }}
          >
            <label>
              Link do Google Sheets
              <input type="url" value={sheetUrl} onChange={(e) => setSheetUrl(e.target.value)} />
            </label>
            <button disabled={!sheetUrl}>Importar</button>
          </form>
          <label>
            Buscar
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="pergunta ou resposta" />
          </label>
        </div>
      </section>
      {shown.length === 0 ? (
        <Empty title="Nenhuma resposta ainda">Importe a planilha de respostas. Cada pergunta nova que você responder na aba "Sua vez" também entra aqui.</Empty>
      ) : (
        <div className="stack">
          {shown.map((e) => (
            <BankItem key={e.id} e={e} onError={onError} onChange={load} />
          ))}
        </div>
      )}
    </div>
  );
}

function BankItem({ e, onError, onChange }: { e: BankEntry; onError: (e: unknown) => void; onChange: () => void }) {
  const [answer, setAnswer] = useState(e.answer);
  const [answerEn, setAnswerEn] = useState(e.answerEn ?? '');
  const dirty = answer !== e.answer || answerEn !== (e.answerEn ?? '');
  return (
    <article className={`card bank ${['IA', 'Aprendida', 'Sensível'].includes(e.kind) ? 'review' : ''}`}>
      <div className="row">
        <strong>{e.questionPt || e.questionEn}</strong>
        {e.kind === 'IA' && <span className="pill">Escrita pela IA: revise</span>}
        {e.kind === 'Aprendida' && <span className="pill">Aprendida com você: confira</span>}
        {e.kind === 'Sensível' && <span className="pill">Aprendida · dado pessoal (nunca vai para a IA)</span>}
      </div>
      <div className="grid2">
        <label>
          Resposta
          <textarea rows={2} value={answer} onChange={(x) => setAnswer(x.target.value)} />
        </label>
        <label>
          Em inglês (opcional)
          <textarea rows={2} value={answerEn} onChange={(x) => setAnswerEn(x.target.value)} />
        </label>
      </div>
      <div className="actions">
        <button
          disabled={!dirty && !['IA', 'Aprendida'].includes(e.kind)}
          onClick={() => api(`/bank/${e.id}`, 'PUT', { answer, answerEn: answerEn || null }).then(onChange).catch(onError)}
        >
          {['IA', 'Aprendida'].includes(e.kind) && !dirty ? 'Aprovar' : 'Salvar'}
        </button>
        <button className="ghost" onClick={() => api(`/bank/${e.id}`, 'DELETE').then(onChange).catch(onError)}>
          Excluir
        </button>
      </div>
    </article>
  );
}

function Resumes({ onError, onChange }: { onError: (e: unknown) => void; onChange: () => void }) {
  const [list, setList] = useState<ResumeItem[]>([]);
  const [name, setName] = useState('');
  const [lang, setLang] = useState<'pt' | 'en'>('pt');
  const [pdf, setPdf] = useState<File | null>(null);
  const [json, setJson] = useState<File | null>(null);
  const load = useCallback(() => api<ResumeItem[]>('/resumes').then(setList).catch(onError), [onError]);
  useEffect(() => {
    void load();
  }, [load]);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!pdf) return;
    try {
      await api('/resumes', 'POST', { name, lang, fileName: pdf.name, base64: await fileToBase64(pdf), dataJson: json ? await json.text() : undefined });
      setName('');
      setPdf(null);
      setJson(null);
      (e.target as HTMLFormElement).reset();
      await load();
      onChange();
    } catch (err) {
      onError(err);
    }
  };
  return (
    <div className="stack">
      <section className="card">
        <h2>Seus currículos ({list.length}/5)</h2>
        <p className="muted small">Para cada vaga eu calculo a compatibilidade com todos e uso o melhor. Com o arquivo de dados (.json), também personalizo o currículo para a vaga, só reordenando o que já está nele.</p>
        {list.length === 0 ? (
          <p>Nenhum currículo ainda.</p>
        ) : (
          <ul className="plain">
            {list.map((r) => (
              <li key={r.id} className="row">
                <span>
                  <strong>{r.name}</strong> · {r.lang.toUpperCase()} · {r.tailorable ? 'personalizável' : 'só PDF'}
                </span>
                <button className="ghost small" onClick={() => api(`/resumes/${r.id}`, 'DELETE').then(load).then(onChange).catch(onError)}>
                  Remover
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {list.length < 5 && (
        <form className="card" onSubmit={add}>
          <h2>Adicionar currículo</h2>
          <div className="grid2">
            <label>
              Nome (para você reconhecer)
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: TI 1 página PT" required />
            </label>
            <label>
              Idioma
              <select value={lang} onChange={(e) => setLang(e.target.value as 'pt' | 'en')}>
                <option value="pt">Português</option>
                <option value="en">Inglês</option>
              </select>
            </label>
            <label>
              PDF
              <input type="file" accept="application/pdf" onChange={(e) => setPdf(e.target.files?.[0] ?? null)} required />
            </label>
            <label>
              Dados para personalizar (.json, opcional)
              <input type="file" accept="application/json" onChange={(e) => setJson(e.target.files?.[0] ?? null)} />
            </label>
          </div>
          <button className="primary">Adicionar</button>
        </form>
      )}
    </div>
  );
}

function Results({ tick }: { tick: number }) {
  type Site = { site: string; total: number; submitted: number; interviews: number; autonomous: number };
  type Week = { week: string; submitted: number; autonomous: number };
  const [data, setData] = useState<{ bySite: Site[]; byWeek: Week[] }>({ bySite: [], byWeek: [] });
  useEffect(() => {
    api<typeof data>('/stats').then(setData).catch(() => {});
  }, [tick]);
  const rows = data.bySite;
  const sent = rows.reduce((a, r) => a + r.submitted, 0);
  const iv = rows.reduce((a, r) => a + r.interviews, 0);
  const auto = rows.reduce((a, r) => a + r.autonomous, 0);
  const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
  return (
    <div className="stack">
      <section className="kpis">
        <div className="card kpi">
          <span>Enviadas</span>
          <strong>{sent}</strong>
        </div>
        <div className="card kpi">
          <span>Sem precisar de você</span>
          <strong>{pct(auto, sent)}</strong>
        </div>
        <div className="card kpi">
          <span>Entrevistas</span>
          <strong>{iv}</strong>
        </div>
        <div className="card kpi">
          <span>Taxa de entrevista</span>
          <strong>{pct(iv, sent)}</strong>
        </div>
      </section>
      <p className="muted small">
        "Sem precisar de você" conta as candidaturas que não pediram login, captcha, pergunta nem etapa desconhecida (o clique final do LinkedIn, Glassdoor e Indeed não conta). Cada vez que você
        resolve algo numa aba, eu aprendo, e esse número sobe. Marque "Entrevista" na fila quando uma empresa chamar.
      </p>
      {data.byWeek.length > 0 && (
        <div className="table-wrap">
          <table>
            <caption className="small muted">Evolução por semana</caption>
            <thead>
              <tr>
                <th>Semana</th>
                <th>Enviadas</th>
                <th>Sem precisar de você</th>
              </tr>
            </thead>
            <tbody>
              {data.byWeek.map((w) => (
                <tr key={w.week}>
                  <td>{w.week}</td>
                  <td>{w.submitted}</td>
                  <td>{pct(w.autonomous, w.submitted)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Site</th>
              <th>Vagas</th>
              <th>Enviadas</th>
              <th>Sem ajuda</th>
              <th>Entrevistas</th>
              <th>Taxa de entrevista</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.site}>
                <td>{r.site}</td>
                <td>{r.total}</td>
                <td>{r.submitted}</td>
                <td>{pct(r.autonomous, r.submitted)}</td>
                <td>{r.interviews}</td>
                <td>{pct(r.interviews, r.submitted)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SettingsView({ state, onError, onSaved }: { state: State; onError: (e: unknown) => void; onSaved: () => void }) {
  const [s, setS] = useState<Settings>(state.settings);
  const [gemini, setGemini] = useState('');
  const [groq, setGroq] = useState('');
  const num = (k: keyof Settings) => (e: { target: { value: string } }) => setS({ ...s, [k]: Number(e.target.value) });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api('/settings', 'PUT', s);
      const keys: Record<string, string | null> = {};
      if (gemini) keys.gemini = gemini === '-' ? null : gemini;
      if (groq) keys.groq = groq === '-' ? null : groq;
      if (Object.keys(keys).length) await api('/ai', 'PUT', keys);
      setGemini('');
      setGroq('');
      onSaved();
    } catch (err) {
      onError(err);
    }
  };
  return (
    <form className="stack" onSubmit={save}>
      <section className="card">
        <h2>Candidaturas</h2>
        <div className="grid3">
          <Field label="Compatibilidade mínima (%)">
            <input type="number" min={0} max={100} value={s.threshold} onChange={num('threshold')} />
          </Field>
          <Field label="Meta por dia">
            <input type="number" min={1} max={60} value={s.dailyCap} onChange={num('dailyCap')} />
          </Field>
          <Field label="Limite diário no LinkedIn">
            <input type="number" min={0} max={40} value={s.linkedinDailyCap} onChange={num('linkedinDailyCap')} />
          </Field>
          <Field label="Vagas ao mesmo tempo">
            <input type="number" min={1} max={4} value={s.maxParallel} onChange={num('maxParallel')} />
          </Field>
          <Field label="Máximo de vagas esperando você">
            <input type="number" min={1} max={12} value={s.maxWaiting} onChange={num('maxWaiting')} />
          </Field>
          <Field label="Anos de experiência (para a nota)">
            <input type="number" min={0} max={40} step={0.5} value={s.experienceYears} onChange={num('experienceYears')} />
          </Field>
          <Field label="Salário mínimo aceito (R$/mês)">
            <input type="number" min={0} value={s.minSalaryBRL} onChange={num('minSalaryBRL')} />
          </Field>
          <Field label="Presencial fora de Uberaba/Uberlândia só acima de (R$)">
            <input type="number" min={0} value={s.onsiteMinSalaryBRL} onChange={num('onsiteMinSalaryBRL')} />
          </Field>
          <Field label="Navegador que o FlashHire usa">
            <select value={s.browser} onChange={(e) => setS({ ...s, browser: e.target.value as Settings['browser'] })}>
              <option value="auto">Automático (Edge no Windows)</option>
              <option value="msedge">Microsoft Edge</option>
              <option value="chrome">Google Chrome</option>
            </select>
          </Field>
          <Field label="Seu nível de inglês">
            <select value={s.englishLevel} onChange={(e) => setS({ ...s, englishLevel: e.target.value as Settings['englishLevel'] })}>
              <option value="basic">Básico</option>
              <option value="intermediate">Intermediário</option>
              <option value="advanced">Avançado</option>
              <option value="fluent">Fluente</option>
            </select>
          </Field>
        </div>
        <label className="check">
          <input type="checkbox" checked={s.autoSubmit} onChange={(e) => setS({ ...s, autoSubmit: e.target.checked })} /> Enviar sozinho na Gupy e em sites de empresas (LinkedIn, Glassdoor e Indeed sempre esperam o seu clique)
        </label>
        <label className="check">
          <input type="checkbox" checked={s.tailor} onChange={(e) => setS({ ...s, tailor: e.target.checked })} /> Personalizar o currículo para cada vaga
        </label>
        <label className="check">
          <input type="checkbox" checked={s.learn} onChange={(e) => setS({ ...s, learn: e.target.checked })} /> Aprender com o que eu faço nas abas que esperam por mim (respostas e botões; senhas nunca)
        </label>
      </section>
      <section className="card">
        <h2>IA (opcional e grátis)</h2>
        <p className="muted small">
          Uso a IA só quando o banco de respostas e as regras não resolvem. Seus dados pessoais são removidos antes. Sem chave, a pergunta vai para "Sua vez". Para apagar uma chave, digite um hífen (-).
        </p>
        <div className="grid2">
          <Field label={`Chave do Google AI Studio (Gemini) ${state.ai.gemini ? '· salva' : ''}`}>
            <input type="password" value={gemini} onChange={(e) => setGemini(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Modelo Gemini">
            <input value={s.geminiModel} onChange={(e) => setS({ ...s, geminiModel: e.target.value })} />
          </Field>
          <Field label={`Chave do Groq ${state.ai.groq ? '· salva' : ''}`}>
            <input type="password" value={groq} onChange={(e) => setGroq(e.target.value)} autoComplete="off" />
          </Field>
          <Field label="Modelo Groq">
            <input value={s.groqModel} onChange={(e) => setS({ ...s, groqModel: e.target.value })} />
          </Field>
        </div>
      </section>
      <div>
        <button className="primary">Salvar ajustes</button>
      </div>
    </form>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
    </label>
  );
}

function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card empty">
      <h2>{title}</h2>
      <p className="muted">{children}</p>
    </section>
  );
}
