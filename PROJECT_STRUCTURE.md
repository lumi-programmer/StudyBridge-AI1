# Project structure

No build step, no bundler, no framework. `web/` is served as written; `functions/`
is deployed as one Deno Edge Function.

```
.
├── web/                      static app (served as-is)
│   ├── index.html            app shell: topbar, sidebar, #view, pre-paint theme script
│   ├── styles/app.css        design tokens, themes, layout, dialog geometry (524 lines)
│   ├── styles/views.css      per-screen rules
│   ├── assets/favicon.svg
│   └── js/
│       ├── api.js            same-origin fetch wrapper, ApiError, 401 redirect
│       ├── app.js            hash router, nav highlighting, chips, focus dock, boot
│       ├── store.js          bootstrap cache, prefs, refresh(), subscribe()
│       ├── theme.js          light/dark/system resolution and persistence
│       ├── ui.js             h(), sheets, confirm, toast, errorCard, richText, charts helpers
│       ├── charts.js         inline SVG progress and activity charts
│       ├── focus.js          focus session engine shared by the view and the dock
│       └── views/            one module per route, each exporting async render()
│           ├── dashboard.js  spaces.js  library.js  scanner.js  tutor.js
│           ├── focus.js  games.js  streak.js  progress.js  wallet.js  settings.js
│           ├── quiz.js       quiz creation + take/grade flow, reused by spaces and library
│           └── shared.js     cards and helpers used by more than one view
│
├── functions/                the Edge Function (Deno)
│   ├── index.ts              entry: wires platform adapters into application()
│   ├── routes.mjs            router, owner scoping, error → {error, hint}, safe code list
│   ├── storage-validation.mjs upload MIME/extension/path checks
│   └── lib/
│       ├── ai.mjs            provider router (status-first error classes, 429 split into
│       │                     throttle vs spent allowance, bounded retry with a 250ms floor,
│       │                     model cooldown + recovery probe, cheapest-capable fallback),
│       │                     BYOK + Free Trial, AES-GCM credential vault
│       │                     (createCrypto/aesKey), adapters, usage ledger, response cache,
│       │                     connection test, failure classification and key redaction
│       ├── content.mjs       static catalogs: question bank, games, achievements, prompts
│       ├── games.mjs         server-side game rules and score validation
│       ├── pdf.mjs           PDF page/text extraction for the free text layer
│       ├── quiz.mjs          buildLocalQuiz / bankQuiz / gradeAnswers / sanitise
│       ├── rewards.mjs       wallet + ledger: ensureWallet, applyDelta, achievements, streaks
│       ├── toc.mjs           contents-page parsing into chapter rows
│       ├── util.mjs          validators (asText/asUuid/toInt/identifier/modelIdentifier),
│       │                     SSRF guard, idempotency helpers
│       └── dom/              HTTP route modules
│           ├── core.mjs      bootstrap, profile, wallet, usage, daily, history deletion
│           ├── library.mjs   books, chapters, pages, uploads, lookup
│           ├── learn.mjs     quizzes, sessions, progress, games, achievements
│           ├── providers.mjs BYOK providers/models/test + /api/trial + /api/ai/settings
│           └── spaces.mjs    spaces, notes, chat, saved questions, AI actions, scan
│
├── schema/studybridge.sql    25 tables in the app schema + 21 indexes
├── dev-tools/                local runtime and verification (never deployed)
│   ├── cases.mjs + run-all.mjs   the 441 behaviour checks, sections A–K (K = the Gemini
│   │                             native wire: path binding, body shape, auth header,
│   │                             catalogue handling, paged discovery, partial-list
│   │                             rule, protocol re-inference on Base URL edit)
│   ├── outbound-probe.mjs   request counts, concurrency and retry gaps over a real socket
│   ├── gemini-path-probe.mjs  the literal Gemini request line, against a server that
│   │                          enforces Google's /models/{model}:generateContent binding
│   ├── gemini-config-audit.mjs  the saved Gemini configuration end to end: stored row,
│   │                          literal URL, redacted headers, sanitized body, paged
│   │                          discovery, answer — 30 checks
│   └── gemini-live-check.mjs  no stub: real /v1beta/models list + one real question
│                              through the app's own adapter, using GEMINI_API_KEY
└── .env / .env.example       local secrets template; the deployed site uses Site Secrets
```

## Backend layout logic

`routes.mjs` owns the boundary: it parses the request, resolves the platform user,
builds a per-request `ctx` (db, storage, fail, validators, ai, rewards), and dispatches
to a `dom/` module. Each `dom/` module registers routes with
`add(METHOD, '/api/path', handler)` and only ever queries with `.eq('owner_id', user.id)`.
Errors thrown as `AppError`/`BackendError` become `{ error: code, hint }` using the
`SAFE_CODES` list and `messages` map, so a student sees a sentence rather than a stack
trace or an upstream body.

## Frontend layout logic

`app.js` maps 11 route names to dynamic `import()` calls. Unknown names fall back to
`dashboard`, so a bad URL never blanks the screen. Views never touch `innerHTML`;
`ui.js:h()` assigns `textContent`, which is what keeps model output inert.

## The `dev-tools/flat` copy

`dev-tools/sync-flat.sh` rewrites `functions/**.mjs` into `dev-tools/flat/` with
single-level imports, because the Node kernel available on this machine resolves
relative specifiers only one directory deep. The harness imports from `flat/`.
**Any edit under `functions/` must be followed by `./dev-tools/sync-flat.sh`** or the
test suite keeps running the previous code. `flat/` is generated and gitignored.

## Database (schema `app`, 25 tables)

| Group | Tables |
| --- | --- |
| Identity & prefs | `profiles` |
| Study structure | `spaces`, `book_links`, `learning_history`, `history_deletes` |
| Content | `books`, `chapters`, `pages`, `documents`, `notes`, `saved_questions`, `messages` |
| Assessment | `quizzes`, `quiz_results` |
| Practice & habit | `study_sessions`, `game_sessions`, `daily_states`, `streaks`, `achievements` |
| AI plumbing | `providers`, `models`, `ai_usage`, `ai_cache` |
| Economy | `wallets`, `transactions` |

Ownership is enforced in the Function rather than by RLS policies, because the
`function_backend` capability gives the Edge Function a service-level client: every
query carries an explicit `owner_id` predicate, and no route accepts another user's
identifier without verifying it belongs to the caller first.

## API surface (76 registered endpoints)

| Prefix | Module | Notable routes |
| --- | --- | --- |
| `/api/bootstrap`, `/api/profile`, `/api/wallet*`, `/api/daily*`, `/api/usage`, `/api/history*`, `/api/achievements`, `/api/health` | `dom/core.mjs` | bootstrap carries the compact trial summary |
| `/api/spaces*` incl. `/chat`, `/notes`, `/questions`, `/books` | `dom/spaces.mjs` | tutor chat, AI actions, local quiz fallback |
| `/api/books*`, `/api/chapters*`, `/api/uploads*`, `/api/lookup`, `/api/scan*`, `/api/documents*` | `dom/library.mjs` | PDF text layer, cover and contents |
| `/api/quizzes*`, `/api/sessions*`, `/api/games*`, `/api/progress` | `dom/learn.mjs` | server-validated scores |
| `/api/providers*`, `/api/models*` (incl. `POST /api/models/:row/wake`, `POST /api/providers/:row/usage`), `/api/trial`, `/api/ai/settings` | `dom/providers.mjs` | BYOK CRUD, auth-only connection test, authenticated account-limit read, cooldown state + policy, trial status |
