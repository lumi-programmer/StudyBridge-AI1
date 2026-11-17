# Deployment

StudyBridge AI's production architecture is a split-origin, three-service stack:

| Service | Role | What it runs |
| --- | --- | --- |
| **Cloudflare Pages** | the student-facing site | static files from `web/` (no build step) + `_redirects` proxy rules |
| **Render** | the backend and the central AI gateway | Node 20+, `server/index.mjs` via the root `package.json` (`npm start`) |
| **Supabase** | Postgres, Auth, private file storage | schema `app` (34 tables), email/password auth, one private bucket |

The browser only ever talks to its own Pages origin. `_redirects` forwards
`/functions/v1/app/*` and `/storage/*` to Render, so API and upload URLs are
same-origin, carry no CORS exposure, and the anon key inside `web/js/config.js`
is the only credential that ever reaches a browser. Every other secret lives in
Render's environment, server-side only.

The earlier Qoder Sites path (Deno Edge Function + Sites Postgres) was abandoned:
the workspace's hosting plan reported `backend_sites` entitlement `limit: 0`
(see CHANGELOG.md, 2026-11-06). The application code was ported, not rewritten —
`server/index.mjs` mounts the same `functions/routes.mjs` application factory the
Edge Function used, behind three adapters (PostgREST database, Supabase Auth JWT,
signed-URL storage).

## Current status

| Step | State |
| --- | --- |
| Application code, schema, adapters, security hardening | done — SUITE 697/697, syntax/import/class gates and the migration consistency checker green |
| Supabase migrations (4 files) | written, **not yet applied** — user action |
| SQL Editor verification script | ready (`supabase/verify/verify_migration.sql`) — **not yet run** — user action |
| Private storage bucket | **not yet created** — user action |
| Render service + secrets | **not yet created** — user action |
| Cloudflare Pages project + `_redirects` | **not yet created** — user action |
| `web/js/config.js` anon values | to be filled at Pages deploy time — user action |
| Live AI generation | verified locally 2026-11-06 against the real OpenRouter catalogue; the deployed deployment still owes the same check |

## 1 — Supabase project

1. Create (or open) the Supabase project. Note the **Project URL** and the two
   keys from *Project Settings → API*: the **anon public** key and the
   **service_role** key. The service_role key is a server secret — it must end
   up only in Render's dashboard, never in the browser, the repo or chat.
2. Apply the migrations in order, in the SQL Editor (or with the Supabase CLI):
   1. `supabase/migrations/20261110000001_studybridge_core_schema.sql`
   2. `supabase/migrations/20261110000002_central_gateway_schema.sql`
   3. `supabase/migrations/20261110000003_rls_and_grants.sql`
   4. `supabase/migrations/20261110000004_bridge_credits_rpc.sql`

   They create the 34 tables, 30 indexes, the Row Level Security layer, the
   privilege wall (all tables revoked from `anon`/`authenticated`/`PUBLIC`,
   granted to `service_role` only) and the atomic-credits functions. Nothing is
   destructive; re-running against an existing schema fails rather than partially
   applying.
3. Expose the `app` schema on the Data API: under *Integrations → Data API →
   Settings → Exposed schemas* include `app` alongside `public` and
   `graphql_public`. The backend adapters address every table through PostgREST
   with the `Accept-Profile: app` / `Content-Profile: app` headers; a project
   that leaves the schema unexposed answers every query with `406 PGRST106:
   Invalid schema: app`, which the API edge reports as `database_unavailable`.
   The migration's privilege wall still applies after exposure — `anon` and
   `authenticated` keep no schema or table privileges (probes answer `42501
   permission denied`), and Row Level Security remains the boundary for
   `service_role`.
4. Run `supabase/verify/verify_migration.sql` **afterwards** in the SQL Editor.
   It is read-only except for one transactional smoke test that ends in
   `ROLLBACK`, so it leaves nothing behind. Section 12 simulates an
   authenticated attacker with a single PL/pgSQL `DO` block and expects every
   probe to fail with SQLSTATE 42501. Read its header first: the editor's
   pooler can route consecutive statements to different backends, which is why
   the simulation is one statement rather than many.
5. Storage → **New bucket**: name it `studybridge` — the exact name, lowercase,
   no spaces (or set `SUPABASE_STORAGE_BUCKET` on Render to match) — and leave
   **public access OFF**. Every object is written and read by the Render backend through
   server-issued, short-lived signed capability URLs; a bucket that is public
   defeats that entirely.
6. Authentication: email/password sign-up stays enabled (the default). Under
   *Authentication → URL Configuration* set the **Site URL** to the Pages
   domain once it exists, and add that domain under Redirect URLs — the
   password-reset email link opens the site there with a one-time session
   fragment the app adopts.

## 2 — Render service

1. Push the repository to GitHub and keep the repository **private**.
2. Render dashboard → **New → Web Service** → connect the repo:
   - Runtime: **Node**
   - Build command: `npm install`
   - Start command: `npm start`
   - Health check path: `/functions/v1/app/api/health`
3. Add the environment variables in the Render dashboard (**Environment →
   Environment Variables**). Add secrets there — never in chat, never in the
   repository, never in a PR description.

   | Variable | Required | Notes |
   | --- | --- | --- |
   | `SUPABASE_URL` | yes | project base URL, e.g. `https://xyz.supabase.co` |
   | `SUPABASE_SERVICE_ROLE_KEY` | yes | server-side only; the app's database identity |
   | `CREDENTIAL_KEY` | yes | SHA-256'd into the AES-GCM key that encrypts stored provider keys. Changing it later orphans every stored key |
   | `ADMIN_OWNER_IDS` | yes | comma-separated owner ids granted the `admin` role on first sight; managed in Admin → Roles afterwards |
   | `OPENROUTER_API_KEY` | yes, for StudyBridge Free AI | the platform's own key. Stored server-side, encrypted, never returned to a browser; rotating it takes effect on the next request with no redeploy |
   | `SUPABASE_JWT_SECRET` | optional | legacy HS256 verification; asymmetric (RS/PS/ES256) tokens work without it through the project JWKS |
   | `SUPABASE_ANON_KEY` | optional | used only to read the public JWKS endpoint |
   | `SUPABASE_STORAGE_BUCKET` | optional | defaults to `studybridge` |
   | `ALLOWED_ORIGINS` | optional | leave unset behind the Pages proxy (same-origin needs no CORS); set a comma list only if the API is ever exposed cross-origin directly |
   | `OPENROUTER_PROVIDER_ID`, `OPENROUTER_NAME`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL`, `OPENROUTER_ENABLED`, `OPENROUTER_DAILY_QUOTA` | optional | central provider identity and shared daily cap; defaults in SETUP.md |
   | `FREE_TRIAL_*` | optional | the per-student trial provider; an unset trial is a supported state and Settings names what is missing |
   | `AI_TIMEOUT_MS`, `AI_RETRY_*`, `MODEL_COOLDOWN_*` | optional | routing policy; ranges in SETUP.md |

   A missing required variable stops the process at startup with
   `server: missing required environment variable <NAME>` — it never listens
   half-configured. A database outage at request time answers the API edge with
   `503 database_unavailable`, never a hang or a 500 (both covered by tests N
   36–37).
4. Before the first real deploy, the same start command can be run locally
   against the real project:
   `SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… CREDENTIAL_KEY=… ADMIN_OWNER_IDS=… OPENROUTER_API_KEY=… npm start`
   — the health endpoint and one signed-in request confirm the wiring before
   any cloud step. Keep those values in your shell session only.

## 3 — Cloudflare Pages

1. Pages → **Create a project** → connect the same private repo.
2. Build command: **none**. Output directory: `web`.
3. Copy `web/_redirects.example` to `web/_redirects` and replace
   `YOUR-RENDER-SERVICE` with the Render service hostname. The two rules proxy
   the API prefix and the signed-storage paths to Render, keeping everything
   same-origin. Order matters; keep them before any catch-all.
4. No environment variables or secrets belong in Pages. The deploy-time values
   are the two public-by-design lines in `web/js/config.js` — the Supabase
   project URL and its **anon** key only.

## 4 — Go-live verification

Run on the published origin, not a preview. The suite (sections A–N, 697
checks) proves the code paths; this list proves the deployment.

- [ ] `GET /api/health` answers 200 through the Pages proxy.
- [ ] Register a student with email/password; confirmation email arrives if
      the project enables it; sign-in lands on the dashboard and `GET
      /api/bootstrap` returns profile, wallet, streak and spaces.
- [ ] Reload the page while signed in: the session survives (stored token,
      silent refresh).
- [ ] Sign out; visiting any section redirects to the sign-in view and returns
      to the intended section after signing in again.
- [ ] **Password reset**: "Forgot your password?" sends the email; the link
      opens the site and the set-password form accepts a new password; signing
      in with the new password works. The reset screen never reveals whether
      an address belongs to an account.
- [ ] A request without a token, with a malformed token, an expired token or a
      token signed by another project answers `401 login_required`.
- [ ] Second account: cannot read the first account's space, notes, chat,
      books, documents or wallet (`404`, empty lists).
- [ ] Upload a PDF through the Scanner; the signed PUT lands in the private
      bucket; download returns the exact bytes; a foreign student gets `404`
      for the same document; a tampered capability URL gets `403`.
- [ ] Ask the tutor one question as a student with no BYOK: a real answer from
      the central provider, balance down by exactly the published price, one
      spend row. Then `GET /api/admin/overview` → `central.requests.succeeded`
      at least 1 — the deployed site's own live check, still owed since
      2026-11-06 was local-only.
- [ ] Daily login reward claimed twice concurrently: one `reward_claims` row,
      one +30 BC row.
- [ ] Drain the wallet and ask: `409 insufficient_credits`, no outbound
      provider call, balance unchanged.
- [ ] Administrator: `/api/admin/*` answers `403 admin_required` for a student,
      works for the owner listed in `ADMIN_OWNER_IDS`.
- [ ] No browser response, Render log line or network request ever contains the
      service key, an OpenRouter key, `CREDENTIAL_KEY` or a stored provider
      key; stored keys read back as `key_hint` only.

## Operational notes

- AI spend is real money. `OPENROUTER_DAILY_QUOTA` caps the shared central
  provider; `FREE_TRIAL_DAILY_LIMIT` caps the per-student trial. Watch
  `GET /api/usage` and the `ai_usage` table.
- The gateway is **free-only by construction**: a model is selectable only while
  its verified input and output prices are both zero, and enabling an
  unverified model is refused with `409 pricing_not_verified`. There is no paid
  fallback to switch on.
- Bridge Credits are an internal currency, not a budget. The ledger is
  server-side only; the browser never submits a balance and never sees a
  decrypted key.
- The SSRF guard resolves provider base URLs before calling them and refuses
  private address ranges; that is enforced in code and cannot be configured away.
- Schema changes go through a new migration file, never by editing the deployed
  database by hand. Do not weaken RLS or grants to make a feature work.
- Render free instances sleep after inactivity; the first request after a wake
  pays the cold start. The health check path is what Render pings to decide the
  service is live.
