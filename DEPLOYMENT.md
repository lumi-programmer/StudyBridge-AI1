# Deployment

StudyBridge AI ships as a **Qoder Site**: static files from `web/` plus one Edge
Function named `app` (from `functions/`), backed by the site's Postgres and object
storage. There is no build step and no dependency install.

## Current status — read this first

| Step | State |
| --- | --- |
| Application code, schema, validation | done, 441/441 checks green locally |
| Cloud project and site record | created (see identities below) |
| Backend capabilities (database + functions + storage) | **blocked** — `sites_quota_exceeded` on `backend_sites`, used 0 / limit 0 |
| Schema migration | not applied (needs the backend) |
| Draft preparation | not run |
| Publication | not run |

The site is **not live**. This is deliberate: a static upload without its Function,
database and storage would be a clickable shell that fakes the product, and the brief
forwards from SchoolPlanner.pk says plainly that a request was never fabricated.
Resolve the plan limit first — the hosting plan backing this workspace reports a limit of
zero backend sites (see https://qoder.com/pricing).

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
2. **Schema applied**: `schema/studybridge.sql` — 25 tables in schema `app` plus 21
   indexes, using only the supported migration subset (`CREATE TABLE app.<t>`, plain
   `CREATE INDEX`, the allowed column types and literal/`gen_random_uuid()`/`now()`
   defaults). Statements are **not** wrapped in `IF NOT EXISTS`, so the migration runs
   once; a re-run against an existing schema fails rather than partially applying. Access
   policies are platform-generated, so the file contains none.
3. **Secrets set** (values are write-only through the Sites tooling; never commit them):

   | Secret | Required | Notes |
   | --- | --- | --- |
   | `CREDENTIAL_KEY` | yes, to store BYOK keys | SHA-256'd into the AES-GCM key. Changing it orphans every stored provider key |
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

4. **`functions/_qoder` must not exist** in the source tree. It is supplied by the
   runtime; the packager rejects a hand-made copy. Local checks go through
   `dev-tools/function-smoke.mjs`, which injects fakes instead.

## Publish sequence

1. Validate the source unchanged since the last green run:
   `js-syntax`, `js-imports`, `css-classes`, `sync-flat.sh`, `_run.mjs` → `SUITE: 441/441 passed`.
   Three probes back the outbound claims: `dev-tools/outbound-probe.mjs` (request counts,
   concurrency and retry gaps over a socket), `dev-tools/gemini-path-probe.mjs` (the
   literal Gemini request line against an endpoint that enforces Google's URL binding) and
   `dev-tools/gemini-config-audit.mjs` (the whole saved Gemini configuration end to end —
   stored row, literal URL, redacted headers, sanitized body, paged discovery, answer).
   A real provider answer needs the student's own key and nothing else changes:
   `GEMINI_API_KEY=<key> ./dev-tools/node.sh dev-tools/gemini-live-check.mjs`.
2. `ensure_backend` with the three capabilities; wait for the operation to settle.
3. Apply `schema/studybridge.sql` as a migration and read it back to confirm the tables.
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

## Updates

Reuse the project and site identities. Changed content needs a new `prepare_site` action
for the same project; drafts are immutable once built, so an update is a new action rather
than an edit of the old one. Schema changes go through a migration, never by editing the
deployed database by hand.

## Operational notes

- AI spend is real money. The trial limits are the budget control; `FREE_TRIAL_DAILY_LIMIT`
  is the dial. Watch `GET /api/usage` totals and the `ai_usage` table.
- Trial counters read the ledger, so they cannot be reset from a client.
- The SSRF guard resolves provider base URLs before calling them and refuses private
  address ranges; that is enforced in code and cannot be configured away.
- If the plan drops backend support again, the published site stops answering Function
  routes; the data stays in the database.
