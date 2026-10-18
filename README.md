# PL-300 Prep – Prepare the data

Study guide + gated practice exams for the **Prepare the data** skills area of the
Microsoft Power BI Data Analyst (PL-300) certification.

**Live:** https://pl300-prep.omarmagdy99860.workers.dev

## Features
- Register / sign in (email + password, PBKDF2-hashed, HttpOnly session cookie)
- 6 study parts; **part N+1 unlocks only after passing the part N exam (70%)**, enforced on the server
- Final 25-question timed exam after all six parts
- User dashboard (progress, scores, attempt history)
- Admin dashboard (users, funnel, hardest questions, unlock overrides, password reset)

## Stack
Cloudflare Workers (static assets + API) · D1 (SQLite) · no framework, no build step.

## Layout
| Path | What |
|---|---|
| `src/worker.js` | API, auth, grading, gating |
| `src/content.js` | Study material served per part (after the lock check) |
| `src/questions.example.js` | Template for the question bank |
| `src/questions.js` | **Private, git-ignored** – questions *with answers* |
| `public/index.html` | The whole front end (SPA) |
| `migrations/` | D1 schema |
| `tools/e2e.mjs` | API end-to-end test (needs the real `src/questions.js`) |

## Why `src/questions.js` is not in the repo
The correct answers live only on the server so students can't read them. The file is
git-ignored; copy `src/questions.example.js` to `src/questions.js` and add your own questions.

## Run locally
```bash
npm install
cp src/questions.example.js src/questions.js   # or use your private bank
npm run db:local
npm run dev                                    # http://localhost:8787
node tools/e2e.mjs                             # optional API tests (local only)
```

## Deploy
```bash
npx wrangler d1 create pl300-db                # put the id in wrangler.jsonc
npm run db:remote
npm run deploy
```
Set `ADMIN_EMAILS` in `wrangler.jsonc`; that email becomes admin when it registers
(register it right after the first deploy).

Unofficial study material, not affiliated with or endorsed by Microsoft.
