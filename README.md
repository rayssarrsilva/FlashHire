# ⚡ FlashHire

**EN** · [PT](#pt)

FlashHire is a local-first assistant that applies to jobs for you. You give it a spreadsheet of job links (Gupy, LinkedIn, Glassdoor, Indeed, Greenhouse, Lever, remote job boards or any company site). It reads each job, scores how well you fit, picks the best of your résumés, tailors it, fills the application at a human pace, answers the extra questions and writes the cover letter when one is asked. When it needs you (a login, a captcha, a question it has never seen, or the final click on sites that require it), it puts the job in your "Your turn" inbox and moves on to the next one.

## Features
- **Any link, A or B:** search-result links and direct job links are normalized to the same job, so you never apply twice. Broken links (a Glassdoor list with no job selected, an expired Indeed form, a Gupy login page) are flagged with a fix.
- **Fit score without AI:** skills, seniority, required years, English level, salary and on-site rules. Jobs below your threshold are skipped with the reason.
- **Best résumé for each job:** up to 5 résumés; the best match is used. With a structured version, the résumé is tailored per job by reordering only what is already in it, auto-fitted to one page.
- **Answer bank first, AI last:** contact data, salary expectations by role/regime/currency/period, "how did you hear about us", years per skill, yes/no screening questions. The AI (free Gemini or Groq tier) is only used for required questions the bank cannot answer, and never receives personal data. Every new answer you give is saved for next time.
- **Cover letters** in the candidate's own writing style, with no invented facts.
- **Asynchronous by design:** jobs that wait for you free their slot, so the queue never stops.
- **Results by source:** applications, interviews and interview rate per site.

## How it works
```
spreadsheet → link detection → open job (your Chrome profile) → read job → fit score
→ pick + tailor résumé → reach the form → fill step by step → submit (or wait for your click)
                                   └─ unknown question / captcha / login → "Your turn" inbox → continue
```

## Tech stack
TypeScript (strict) · Node.js · Playwright (Edge or Chrome, own persistent profile) · Fastify · SQLite (node:sqlite, built into Node) · React 19 + Vite · Zod · AES-256-GCM + scrypt · Vitest · GitHub Actions · Dependabot

## Run it
Requirements: Node.js 22.13+ and Microsoft Edge or Google Chrome.
```bash
git clone https://github.com/rayssarrsilva/FlashHire.git
cd FlashHire
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
npm start
```
On Windows you can double-click `INICIAR-FlashHire.bat`. The app opens at http://127.0.0.1:4173 and only your computer can reach it.

First run: create a master password → add your résumés → import your answer bank → (optional) paste free AI keys in Settings → add job links → **Start**. A browser window (Edge or Chrome) opens: sign in to LinkedIn, Gupy and Indeed once, when asked.

## Tests
```bash
npm test            # unit tests: links, fit score, answers, salary, tailoring, letters, crypto
npm run test:e2e    # the real engine filling local pages that imitate an ATS, a Gupy flow and an Easy Apply dialog
```

## Responsible use
FlashHire fills forms at a human pace and respects daily limits. On LinkedIn, Glassdoor and Indeed, whose terms forbid automated submission, it prepares everything and **you** click "Send". It does not bypass captchas or bot detection.

---

<a id="pt"></a>

# ⚡ FlashHire (PT)

O FlashHire é um assistente local que se candidata às vagas por você. Você entrega uma planilha com os links das vagas (Gupy, LinkedIn, Glassdoor, Indeed, Greenhouse, Lever, sites de vagas remotas ou qualquer site de empresa). Ele lê cada vaga, calcula a compatibilidade, escolhe o melhor dos seus currículos, personaliza, preenche a candidatura em ritmo humano, responde as perguntas extras e escreve a carta de apresentação quando pedem. Quando precisa de você (login, captcha, pergunta nova ou o clique final nos sites que exigem), coloca a vaga na caixa "Sua vez" e segue para a próxima.

## Funcionalidades
- **Qualquer link, A ou B:** link da busca e link direto viram a mesma vaga, então você nunca se candidata duas vezes. Links com problema são marcados com a correção.
- **Nota de compatibilidade sem IA:** habilidades, senioridade, anos pedidos, inglês, salário e regras de vaga presencial.
- **O melhor currículo para cada vaga:** até 5 currículos. Com a versão em dados, o currículo é personalizado reordenando só o que já está nele, em uma página.
- **Banco de respostas primeiro, IA por último:** a IA (plano grátis do Gemini ou do Groq) só entra em perguntas obrigatórias que o banco não resolve, e nunca recebe dados pessoais. Toda resposta nova sua fica guardada.
- **Carta de apresentação** no seu jeito de escrever, sem inventar nada.
- **Assíncrono:** vaga que espera por você libera a vez, e a fila não para.
- **Resultados por site:** candidaturas, entrevistas e taxa de entrevista.

## Como rodar
Precisa de Node.js 22.13+ e do Microsoft Edge ou do Google Chrome. Veja os comandos acima ou dê dois cliques em `INICIAR-FlashHire.bat` no Windows.

## Uso responsável
Ritmo humano e limites diários. No LinkedIn, Glassdoor e Indeed, cujos termos proíbem envio automático, o FlashHire prepara tudo e **você** clica em "Enviar". Ele não burla captcha nem detecção de robôs.

## License · Licença
MIT © Rayssa Roberta Rodrigues Silva
