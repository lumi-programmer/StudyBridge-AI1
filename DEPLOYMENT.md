# Deployment

StudyBridge AI ships as a **Qoder Site**: static files from `web/` plus one Edge
Function named `app` (from `functions/`), backed by the site's Postgres and object
storage. There is no build step and no dependency install.

## Current status — read this first

| Step | State |
| --- | --- |
| Application code, schema, validation | done, 619/619 checks green locally |
| Cloud project and site record | created (see identities below) |
| Backend capabilities (database + functions + storage) | **blocked** — `sites_quota_exceeded` on `backend_sites`, used 0 / limit 0 |
| Schema migration | not applied (needs the backend) |
| Site Secrets | `CREDENTIAL_KEY`, `ADMIN_OWNER_IDS` and `OPENROUTER_API_KEY` still to be set |
| Draft preparation | not run |
| Publication | not run |
| Live AI generation | **not performed** — no `OPENROUTER_API_KEY` exists in this workspace, so no request has ever reached OpenRouter |

The site is **not live**. This is deliberate: a static upload without its Function,
database and storage would be a clickable shell that fakes the product, and the brief
forwards from SchoolPlanner.pk says plainly that a request was never fabricated.
Resolve the plan limit first — the hosting plan backing this workspace reports a limit of
zero backend sites (see https://qoder.com/pricing).

**Re-verified 2026-11-06.** The allocation was retried against the live service and
answered:

```json
{"error":"sites_quota_exceeded","resource":"backend_sites","used":0,"limit":0,
 "pricingUrl":"https://qoder.com/pricing","hint":"Backend site quota exceeded: used 0, limit 0."}
```

`used: 0, limit: 0` is the important part: the entitlement is **absent**, not
exhausted — nothing has been allocated and nothing is over a positive limit. No
parameter, retry or migration can change it; it has to be granted on the account's
plan. The request is idempotent, so the same call can be reissued with the same
`requestId` once the plan carries the quota.

Cloud identities in this workspace, reused rather than recreated:

| | Value |
| --- | --- |
| projectId | `01a19c4e-57c9-76dc-8993-c72f3c9a62fe` |
| siteId | `01a19c4e-57ca-7805-a755-e14c5434d2c3` |
| host | `studybridge-ai-361kzl5nawn.qoder.website` |

Never create a second site for the same source directory; reuse these IDs and the
existing descriptor.

## Not Vercel

`vercel.json` is deliberately absent. This project's server side is a **Deno Edge
Function** that imports the platform-injected `./_qoder/backend.mjs` and `./_qoder/storage.mjs`
adapters, reads **Site Secrets**, and expects a Postgres `app` schema created by the Sites
migration tooling. A Vercel config would advertise a runtime that cannot serve this code,
and the repository would then contain a deploy instruction that does not deploy. If a
Vercel (or any other) target is genuinely wanted, the Function's data layer must be
rewritten against that provider's database and blob store first — that is a port, not a
config file.

## Before the first publish

1. **Backend enabled** on the site: database, functions and storage capabilities, with
   the Function owning authorization (`function_backend`).
2. **Schema applied**, in this order:
   - `schema/studybridge.sql` — 25 tables in schema `app` plus 21 indexes, using only
     the supported migration subset (`CREATE TABLE app.<t>`, plain `CREATE INDEX`, the
     allowed column types and literal/`gen_random_uuid()`/`now()` defaults). Statements
     are **not** wrapped in `IF NOT EXISTS`, so the migration runs once; a re-run against
     an existing schema fails rather than partially applying. Access policies are
     platform-generated, so the file contains none.
   - `schema/central-gateway.sql` — **after** the first one: the 9 platform-side tables
     for the central AI gateway and the credits economy (`user_roles`, `ai_providers`,
     `ai_models`, `ai_requests`, `ai_daily_slots`, `ai_usage_limits`,
     `provider_health_logs`, `reward_claims`, `economy_settings`) plus 10 indexes. It
     adds nothing to an existing table — no `ALTER TABLE` — so it can be applied to a
     schema that already carries the base migration without touching it. Apply it in
     the same migration set, after `studybridge.sql`.
3. **Secrets set** (values are write-only through the Sites tooling; never commit them):

   | Secret | Required | Notes |
   | --- | --- | --- |
   | `CREDENTIAL_KEY` | yes, to store BYOK keys and platform provider keys | SHA-256'd into the AES-GCM key. Changing it orphans every stored provider key |
   | `ADMIN_OWNER_IDS` | yes, for the administrator sections | comma-separated owner ids granted the `admin` role on first sight. Bootstrap only — after the first role exists it is managed in Admin → Roles |
   | `OPENROUTER_API_KEY` | yes, for StudyBridge Free AI | the platform's own OpenRouter key. Students never supply one. Stored encrypted on the server and never returned to a browser |
   | `FREE_TRIAL_BASE_URL` | only for the trial | must be `https://`, no port, query or userinfo |
   | `FREE_TRIAL_API_KEY` | only for the trial | never returned to a browser |
   | `FREE_TRIAL_MODEL`, `FREE_TRIAL_MODEL_NAME` | only for the trial | name defaults to the model id |
   | `FREE_TRIAL_VISION_MODEL` | optional | without it, photo tasks say no vision model is available |
   | `FREE_TRIAL_WIRE` | optional | `openai` (default) or `gemini` |
   | `FREE_TRIAL_DAILY_LIMIT` | optional | default 20, max 500 |
   | `FREE_TRIAL_TOTAL_LIMIT` | optional | default 200, max 100000 |
   | `AI_TIMEOUT_MS` | optional | one call's cutoff; default 45000, clamped 1000–120000 |
   | `AI_RETRY_ATTEMPTS` | optional | tries per model before moving on; default 3, max 5 |
   | `AI_RETRY_BASE_MS`, `AI_RETRY_MAX_MS`, `AI_RETRY_BUDGET_MS` | optional | backoff floor, ceiling and the total wait inside one question |
   | `AI_RETRY_AFTER_CAP_MS` | optional | longest `Retry-After` a provider may impose; default 10000 |
   | `MODEL_COOLDOWN_MS`, `MODEL_COOLDOWN_MAX_MS` | optional | how long a failing model is skipped, and the ceiling for repeated failures |
   | `OPENROUTER_PROVIDER_ID`, `OPENROUTER_NAME`, `OPENROUTER_BASE_URL`, `OPENROUTER_MODEL` | optional | override the central provider's identity; defaults are `openrouter-central`, `OpenRouter`, `https://openrouter.ai/api/v1`, `openrouter/free` |
   | `OPENROUTER_ENABLED` | optional | `false` takes the central provider out of service without removing the key |
   | `OPENROUTER_DAILY_QUOTA` | optional | shared requests/day for all students; `0` = no cap. A spent cap shows "StudyBridge AI is temporarily busy. Please try again later." |

   All eight are routing policy, not credentials: unset means the documented default, and
   Settings → AI router prints the values actually in force. Widen them during a provider
   outage; narrow them if a provider starts answering slowly. Ranges and effects are in
   [SETUP.md](SETUP.md#tuning-retries-cooldown-and-fallback).

   Two behaviours are **not** configurable, on purpose: no retry is ever sent less than
   250 ms after the previous attempt (so zeroing the backoff secrets cannot make the site
   hammer a provider), and a 429 that means a spent daily allowance is requested once and
   then parked rather than retried. The authenticated account-limit read is likewise capped
   at one request per provider every 5 minutes.

   An unset trial is a supported state: Settings reports "Not switched on yet" and names
   the missing Secret. Do not set a placeholder value to make the card look friendly —
   `trialConfig()` rejects a non-HTTPS base URL and keeps the trial off.

   An unset `OPENROUTER_API_KEY` is a supported state too: the central provider does not
   exist, the tutor says "No model is connected yet" and names the missing Secret, and
   nothing is simulated. The key is read from the environment on every request, so
   rotating it takes effect immediately with no redeploy, and removing it takes the
   provider out of service again.

   The central provider provisions itself: provider `openrouter-central`, the
   `openrouter/free` routing model, and a catalogue read from the provider's own
   `/models` endpoint. A model is usable only when the provider published exactly zero
   for input **and** output. Nothing has to be enabled by hand, and no paid model is ever
   reachable — not as a first choice, not as a fallback.

4. **`functions/_qoder` must not exist** in the source tree. It is supplied by the
   runtime; the packager rejects a hand-made copy. Local checks go through
   `dev-tools/function-smoke.mjs`, which injects fakes instead.

## Publish sequence

1. Validate the source unchanged since the last green run:
   `js-syntax`, `js-imports`, `css-classes`, `sync-flat.sh`, `_run.mjs` → `SUITE: 619/619 passed`.
   Three probes back the outbound claims: `dev-tools/outbound-probe.mjs` (request counts,
   concurrency and retry gaps over a socket), `dev-tools/gemini-path-probe.mjs` (the
   literal Gemini request line against an endpoint that enforces Google's URL binding) and
   `dev-tools/gemini-config-audit.mjs` (the whole saved Gemini configuration end to end —
   stored row, literal URL, redacted headers, sanitized body, paged discovery, answer).
   A real provider answer needs the student's own key and nothing else changes:
   `GEMINI_API_KEY=<key> ./dev-tools/node.sh dev-tools/gemini-live-check.mjs`.
   The one live check still outstanding for the central provider is a real question
   through `OPENROUTER_API_KEY` — see the note at the end of this file.
2. `ensure_backend` with the three capabilities; wait for the operation to settle.
3. Apply `schema/studybridge.sql` and then `schema/central-gateway.sql` as migrations,
   and read them back to confirm the tables.
4. `prepare_site` with the static output directory (`web/`) — this generates the
   `<site>.qoder.site` descriptor. Do not handwrite or edit that file.
5. Read the draft status. Resolve only reported blockers; `canPublish: true` is an
   intermediate state, not the result.
6. `publish_site` once for that exact action, then poll the returned action until
   `published: true`. Keep the site **private** until the checks below pass.
7. Set the Secrets, then run the live verification list.

A timed-out publish is not a failed release — re-read the same action rather than
starting a new one.

## Live verification after publication

The published origin, not a preview:

- [ ] Sign in through the site's own Qoder login, then `GET /api/bootstrap` returns
      profile, wallet, streak, spaces, providers and the compact `trial` object;
      `GET /api/health` answers.
- [ ] Create a space, add a note, reload the page — still there (real Postgres, not the fake).
- [ ] Upload a PDF through the Scanner; `app.pages` rows appear; contents extraction on a
      text-layer PDF answers with **no** `ai_usage` row and no charge.
- [ ] Add a BYOK provider. Confirm the response carries `key_hint` only, that
      `app.providers.key_cipher` is ciphertext, and that no browser request or response
      ever contains the key.
- [ ] Paste a namespaced model id (`qwen/qwen3.8-omni-flash:free`) and confirm it saves and
      is listed verbatim. Press **Test connection** with a real key: green only when that
      exact model answers; with a wrong key it must show the provider's own status and words
      (`HTTP 401: …`) on the card, the button must re-enable, and the server log line must
      read `[redacted]` rather than the key.
- [ ] Ask the tutor a question. Confirm one `ai_usage` row with real token counts.
- [ ] Hit the daily AI limit and confirm the 429 wording, and that free tools keep working.
- [ ] Second account: cannot read the first account's space, notes, chat, books or wallet
      (the suite's F section proves the code path; the deployed check proves the database).
- [ ] Focus session start → heartbeat → finish, and the credit ledger entry.
- [ ] Game finish twice with the same `client_key` → one credit.
- [ ] With `FREE_TRIAL_*` set and no BYOK: the trial answers, decrements, and stops at the
      daily cap. Without them: every AI screen says what is missing.
- [ ] Administrator: `GET /api/admin/access` returns `role: 'admin'` for the owner in
      `ADMIN_OWNER_IDS`, and `403 admin_required` for an ordinary student on every
      `/api/admin/*` route — including `/api/admin/overview` and `/api/admin/providers`.
- [ ] Platform provider: save one in Admin → AI Providers. The response carries `key_hint`
      only; `app.ai_providers.key_cipher` is ciphertext; no browser response, log line or
      network request contains the key.
- [ ] **Verify pricing** against a real provider catalogue. A model published at exactly
      zero on both sides comes back `free_tier: true, pricing_verified: true`; a paid
      model comes back `free_tier: false` and cannot be enabled —
      `PATCH /api/admin/models/<row> {enabled:true}` must answer `409 pricing_not_verified`.
- [ ] Ask the tutor a question as a student with no BYOK. The balance falls by exactly the
      published price (2 BC for a basic question), one `ai_usage`-priced spend row appears
      in `app.transactions`, and the answer names the model that answered.
- [ ] Claim the daily login reward twice (and twice concurrently). Exactly one
      `app.reward_claims` row and exactly one +30 BC earn row.
- [ ] Make a request fail (stop the provider, or point it at a bad key). The balance must
      return to its previous value, one refund row appears, and `app.ai_requests.state`
      reads `refunded`.
- [ ] Drain a wallet to 0 and ask a question: `409 insufficient_credits`, **no** outbound
      provider call, and no refund row for a request that was never charged.
- [ ] With every approved free model unavailable: `503 free_models_unavailable`, the
      balance unchanged, and the response contains no invented answer.

## The central provider — the one live check still outstanding

With `OPENROUTER_API_KEY` set, the whole product runs without a student key. The
following has **not** been performed in this workspace, because the workspace holds no
such key. It is the first thing to run once the backend is provisioned:

1. Set `OPENROUTER_API_KEY` as a Site Secret.
2. `GET /api/bootstrap` → `free_models.central.configured` is `true` and
   `free_models.central.free_models` is at least 1.
3. Ask the tutor one question as a student with no BYOK. Confirm a real answer, a
   balance that fell by exactly 2 BC, one spend row, and a named model whose id is on the
   verified-free list.
4. `GET /api/admin/overview` → `central.requests.succeeded` is at least 1 and
   `central.last_success` is a real timestamp. This is the difference between "a
   provider is configured" and "a provider is answering".
5. Confirm no browser response, log line or network request contains the key, and that
   the key is stored as ciphertext with only the last four characters readable.

## Updates

Reuse the project and site identities. Changed content needs a new `prepare_site` action
for the same project; drafts are immutable once built, so an update is a new action rather
than an edit of the old one. Schema changes go through a migration, never by editing the
deployed database by hand.

## Operational notes

- AI spend is real money. The trial limits are the budget control; `FREE_TRIAL_DAILY_LIMIT`
  is the dial. Watch `GET /api/usage` totals and the `ai_usage` table.
- The platform gateway is **free-only by construction**, not by convention: a model is
  selectable only while its verified input and output prices are both zero, and
  `PATCH /api/admin/models/<row>` refuses to enable an unverified model. There is no
  paid fallback to switch on, and no setting that turns one on.
- Bridge Credits are an internal currency, not a budget. A credit does not buy provider
  capacity: raising the daily limit or the price changes who may use the tutor and what
  it costs, while the provider's own quota is the `daily_quota` on the provider row and
  the shared `shared_daily_quota` in Admin → Economy.
- Trial counters read the ledger, so they cannot be reset from a client.
- The SSRF guard resolves provider base URLs before calling them and refuses private
  address ranges; that is enforced in code and cannot be configured away.
- If the plan drops backend support again, the published site stops answering Function
  routes; the data stays in the database.
