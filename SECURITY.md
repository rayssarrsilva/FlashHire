# Security · Segurança

FlashHire is local-first: there is no server holding anyone's data. Each person runs it on their own computer.
O FlashHire é local: não existe servidor com dados de ninguém. Cada pessoa roda no próprio computador.

## How data is protected · Como os dados ficam protegidos
- Answers, résumés and API keys are encrypted at rest with AES-256-GCM. The key is derived from a master password with scrypt (N=2^17) and only lives in memory while the vault is unlocked.
- The local server listens on 127.0.0.1 only, checks the Host header (DNS-rebinding protection) and the Origin, and requires a random per-launch token on every API call.
- Strict Content-Security-Policy, `frame-ancestors 'none'`, `nosniff`, `no-referrer`, no telemetry.
- Personal data (email, phone, CPF, CEP, address) is removed before any text is sent to an AI provider; CPF, RG, address and birth date are never sent at all.
- FlashHire never sees site passwords: the candidate signs in once in FlashHire's own Chrome profile.
- Dependabot and CI on every pull request.

## Reporting a vulnerability · Como reportar uma falha
Please do not open a public issue. Use GitHub's "Report a vulnerability" (Security tab) or email rayssarrsilva1@gmail.com.
