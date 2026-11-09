# Setup

Two different runtimes exist in this repository, and they are not interchangeable:

| | Where code runs | Data lives in | Secrets come from |
| --- | --- | --- | --- |
| **Local preview** | Node, via `dev-tools/serve.mjs` | an in-memory fake of the database and storage adapters | your shell or `.env` |
| **Deployment** | Deno Edge Function, `functions/index.ts` | the site's Postgres (`app` schema) and object storage | **Site Secrets** |

The local preview exercises the *real* route handlers, validators, ledger maths, quiz
builder and error paths, and it **does make real outbound calls to AI providers** — so a
"Connected" you see locally is the provider's own answer. Set `LOCAL_AI_FAKE=1` to keep
every request inside the machine when working offline, and treat that state as unverified.
It still cannot exercise real Postgres constraints or real object storage. Do not treat a
green local run as proof of those two.

---

## 1. Prerequisites

Node.js 20+ (`node --version`). The project has **no dependencies** — nothing to
install, no `package.json`, no lockfile, no build step.

This workspace has no `node` on `PATH`, so `dev-tools/node.sh` runs the Qoder Electron
binary in Node mode instead:

```sh
ELECTRON_RUN_AS_NODE=1 exec "C:/Users/ITZ_V/AppData/Local/Programs/Qoder/Qoder.exe" "$@"
```

On any other machine, replace `./dev-tools/node.sh` with `node`. Every command below is
plain `node <file>`.

## 2. Environment

```sh
cp .env.example .env
```

`.env` is read **only** by `dev-tools/serve.mjs` (variables already exported in your
shell take precedence). The deployed Function never reads a file.

| Variable | Needed for | If unset |
| --- | --- | --- |
| `CREDENTIAL_KEY` | saving a BYOK provider key and a platform provider key | saving fails `credentials_not_configured` |
| `ADMIN_OWNER_IDS` | naming the first administrator | no admin exists; the admin pages answer `admin_required` |
| `OPENROUTER_API_KEY` | StudyBridge Free AI (the central provider every student uses) | the central provider does not exist; the tutor says so plainly and nothing is faked |
| `FREE_TRIAL_*` | the platform Free Trial | the trial reports "Not switched on yet", honestly |
| `AI_*` and `MODEL_COOLDOWN_*` | tuning retries and cooldown | the built-in defaults in [tuning retries](#tuning-retries-cooldown-and-fallback) apply |

The local `.env` contains `CREDENTIAL_KEY=dev-credential-key-local-only`. That value
is deliberately not a secret: it exists so local provider saving works out of the box,
and `.env` is gitignored. **Never put a real provider key in it.**

In the preview the browser always resolves to the first stub user, `student-a`, so
`ADMIN_OWNER_IDS=student-a` in `.env` is what makes the local admin console answer
instead of `admin_required`. It is a local-only convenience — the deployed Secret takes
real owner ids.

Note that `CREDENTIAL_KEY` is the AES-GCM key (SHA-256 of the string). Changing it makes
previously stored provider keys undecryptable — set it once per environment.

`ADMIN_OWNER_IDS` is a comma-separated list of owner ids that are administrators from
the first request. It is a **bootstrap** secret: the Function reads it only to grant
the `admin` role when `app.user_roles` has no row for that owner. After the first
administrator exists, roles are managed in Admin → Roles, and the Secret can be
removed. It is not a way to keep a role alive — deleting the row revokes it.

```sh
# the owner id is the platform user id — read it from GET /api/bootstrap
ADMIN_OWNER_IDS=<owner-id> PORT=4317 ./dev-tools/node.sh dev-tools/serve.mjs
```

### StudyBridge Free AI — the central provider

This is the one key the platform holds. Students never need one.

```sh
OPENROUTER_API_KEY=sk-or-v1-... PORT=4317 ./dev-tools/node.sh dev-tools/serve.mjs
```

With the key set, the Function provisions the central provider itself:

| Setting | Default | Meaning |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | — | the platform's OpenRouter key. Absent ⇒ no central provider |
| `OPENROUTER_PROVIDER_ID` | `openrouter-central` | the provider row it provisions |
| `OPENROUTER_NAME` | `OpenRouter` | the display name in Admin |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | the API root, SSRF-checked |
| `OPENROUTER_MODEL` | `openrouter/free` | the routing model |
| `OPENROUTER_ENABLED` | `true` | `false` takes the provider out of service |
| `OPENROUTER_DAILY_QUOTA` | `0` | shared requests/day for all students; `0` = no cap |

The provisioning is idempotent and runs on every request, so rotating the key
takes effect immediately and removing it takes the provider out of service again
— no admin step, no restart.

**The free-only rule.** Before anything is routed, the provider's own `/models`
catalogue is read and a model is usable only when the published input price **and**
the output price are exactly zero. A model whose price is missing or unreadable is
recorded as `pricing_verified: false` and is never called. A paid model is recorded
as `free_tier: false` and is disabled. The catalogue is re-read daily, and sooner
after a failed check, so a price change cannot quietly make a model billable.

A catalogue that cannot be read is a failure, not an empty list: the reader allows 8 MB
per page, and a body that runs past that, is not JSON, or is not a list of models stops
the check with `catalogue_unreadable` instead of verifying nothing and reporting
success. OpenRouter's own catalogue is one page of roughly 800 KB, so it is read whole;
a model that was not seen is never marked unavailable unless the whole catalogue was
read.

**The daily allowance.** Each student may ask 10 successful questions per
`Asia/Karachi` calendar day (midnight Pakistan time, UTC+5). The count lives in
`app.ai_daily_slots` — one numbered slot row per question, unique on
`(owner_id, day, slot)` — so concurrent clicks cannot race past the cap, and a
failed request releases its slot. Refresh, logout or a new device changes nothing:
the backend decides eligibility from stored UTC timestamps.

**The shared quota is separate.** `OPENROUTER_DAILY_QUOTA` is the platform's own
budget for all students together. When it is spent, students see exactly
*"StudyBridge AI is temporarily busy. Please try again later."* The provider's own
rate limits and quotas are separate again, and StudyBridge's midnight reset never
restores them.

### Configuring the platform gateway

The gateway answers with models an administrator has **verified as free**. The order
is deliberate and the price check is the gate:

1. Save the provider in **Admin → AI Providers**. Name, provider key, Base URL,
   protocol (`openai` / `openrouter` / `gemini`) and the API key. The key is stored
   AES-GCM encrypted on the server and is never displayed again — only the last four
   characters (`key_hint`) are ever returned.
2. Press **Verify pricing**. The Function reads the provider's own catalogue and
   checks each model. A model counts as free only when the provider published
   **exactly zero for input and for output**. A model whose price cannot be read is
   left unverified and disabled.
3. Enable only the verified free models. `PATCH /api/admin/models/<row>` refuses
   (`pricing_not_verified`) to enable a model whose zero pricing was never confirmed.
4. Press **Test connection** to make one real request through the provider's own
   protocol. A catalogue is not proof that a key works — the answer has to come back.

For OpenRouter, the Base URL is `https://openrouter.ai/api/v1` and the free router
model id is `openrouter/free`. The router is not priced itself: it picks a model per
request, so the gateway checks **the model the router actually returned** against the
verified-free list on every answer. If that model is not on the list, the response is
refused, the request fails with `free_models_unavailable` and the reserved credits are
returned — the student is never charged for a paid model.

Adding a second free provider later needs no change to the tutor: register it, verify
it, enable its models, and the gateway routes to it when the first is unavailable.

### Running the Free Trial locally

Point it at anything OpenAI-compatible, or skip it entirely — the UI is designed to look
correct in both states:

```sh
FREE_TRIAL_BASE_URL=https://api.openai.com/v1 \
FREE_TRIAL_API_KEY=sk-... \
FREE_TRIAL_MODEL=gpt-4o-mini \
FREE_TRIAL_MODEL_NAME="Free Trial model" \
FREE_TRIAL_DAILY_LIMIT=20 FREE_TRIAL_TOTAL_LIMIT=200 \
PORT=4317 ./dev-tools/node.sh dev-tools/serve.mjs
```

Settings then shows "Available now" with live remaining counts, and the sidebar note
switches to the trial line. The outbound call goes to the real endpoint — with a
placeholder key you get the provider's own auth failure surfaced as `provider_auth_failed`
or `trial_unavailable`, which is the honest result, not a bug.

### Tuning retries, cooldown and fallback

Every routing number is a Site Secret (or a locally exported variable) with a hard-coded
range, so an operator can widen the patience during a provider outage without a redeploy.
Values outside the range fall back to the default. Settings → AI router prints the values
actually in force.

| Secret | Range | Default | What it controls |
| --- | --- | --- | --- |
| `AI_TIMEOUT_MS` | 1000–120000 | 45000 | when one call to the provider is cut off |
| `AI_RETRY_ATTEMPTS` | 1–5 | 3 | attempts per model before the router moves on |
| `AI_RETRY_BASE_MS` | 0–5000 | 500 | first backoff; it doubles each attempt |
| `AI_RETRY_MAX_MS` | 0–30000 | 4000 | ceiling on one backoff pause |
| `AI_RETRY_BUDGET_MS` | 0–60000 | 12000 | total wait inside one question; the router stops trying rather than keep a student waiting |
| `AI_RETRY_AFTER_CAP_MS` | 0–60000 | 10000 | longest `Retry-After` the provider is allowed to impose |
| `MODEL_COOLDOWN_MS` | 1000–600000 | 30000 | how long a failing model is skipped; doubles with each consecutive failure |
| `MODEL_COOLDOWN_MAX_MS` | 5000–3600000 | 600000 | ceiling on that skip window |
| `AI_RECOVERY_PROBE_MS` | 5000–900000 | 60000 | how often one cooling model may be re-tested with a live request, however many questions the student asks in between |
| `AI_MAX_CONCURRENT` | 1–4 | 1 | provider calls one student may have in flight at the same moment; the rest wait their turn |

```sh
# a provider is melting down and you would rather wait it out than fail fast
MODEL_COOLDOWN_MS=120000 AI_RETRY_BUDGET_MS=30000 \
PORT=4317 ./dev-tools/node.sh dev-tools/serve.mjs
```

Two things these knobs never do: they cannot make a refused key into a success, and a
cooldown cannot disable or delete a model. The window is routing state on the model row
(`fail_streak`, `cooldown_until`, `cooldown_reason`), cleared by the next good answer or
by `POST /api/models/<row uuid>/wake` when the student presses **Try now**.

Not a knob: **no retry is ever sent faster than 250 ms after the previous attempt**
(`MIN_RETRY_PAUSE_MS` in `functions/lib/ai.mjs`, published as
`retry_policy.min_retry_pause_ms`). Settings can slow the router down to zero patience,
but it cannot make StudyBridge re-send a request in the same instant — a same-millisecond
re-send is what turns one provider failure into a burst against someone's API.

Two other things the router now refuses to do:

- A 429 whose own code or words mean *allowance spent* (`insufficient_quota`,
  `usage_limit_reached`, "daily", "exhausted", a `Retry-After` of an hour or more) is
  classified `provider_quota_exhausted`, asked **once**, and parked for the whole
  `MODEL_COOLDOWN_MAX_MS`. Retrying cannot un-spend a daily quota.
- The provider's machine-readable answer is kept and shown: `error.type`, `error.code`,
  the exact `Retry-After` (or that there was none) and the request reference
  (`cf-ray`/`x-request-id`) reach both the tutor banner and the provider card's
  **Last error**, so a status and a message that disagree are visible as disagreeing.
- A cooling model is re-tested on a timer, **not once per question**. Every question used
  to spend a live request on an endpoint that had just refused, which is what made one
  provider outage look like a stream of 429s and 503s from StudyBridge. Now the first
  question after a refusal sends one single-attempt probe, and any question inside
  `AI_RECOVERY_PROBE_MS` of it sends **nothing**: the student gets `provider_paused`
  with the seconds left. No provider setting is changed by that pause and no paid model is
  substituted to fill the gap.
- One action is one provider call. The browser collapses an identical in-flight request
  (`web/js/api.js`, opt out per call with `noDedupe`), the Function collapses it again for
  every student including the tutor's pinned-model path, and past `AI_MAX_CONCURRENT` a
  question waits in that student's own queue instead of arriving as a burst. Routing is
  re-read when the queued call actually goes out, so a question that waited behind another
  does not spend three attempts on a model that refused during the wait.

**Check account limits** (Settings → provider card) sends one authenticated
`GET <base>/usage` from the Function and shows the provider's own numbers — remaining
tokens, requests-per-minute caps, reset windows — with the key never leaving the server.
It is read at most once every 5 minutes per provider and cached between, because a limit
check that polled would itself be traffic.

> The suite harness (`dev-tools/function-smoke.mjs`) pins `AI_RETRY_BASE_MS=0`,
> `MODEL_COOLDOWN_MS=2000` and a small budget so a run stays fast; the 250 ms floor still
> applies there, which is what section J measures. `dev-tools/serve.mjs` no longer uses
> those zeroes: the preview talks to real providers, so it starts with production-like
> pacing (`AI_RETRY_BASE_MS=700`, budget 12s, cooldown 30s, `AI_TIMEOUT_MS=45000`) unless
> `.env` says otherwise. The timeout matters: a busy free-tier pool can sit on a completion
> for longer than the harness's 5 s, and a preview with a shorter deadline than the deployed
> Function reports a timeout the student would never have seen.

## 3. Start the preview

```sh
PORT=4317 ./dev-tools/node.sh dev-tools/serve.mjs
```

- Serves `web/` at `http://127.0.0.1:4317/`.
- Forwards `/functions/v1/app/*` into `application()` — the same router the Edge Function
  uses.
- Seeds one space ("Class 10 Physics") and one book so views are populated; the in-memory
  database resets on restart.
- The harness creates two stub users, but the browser always resolves to the first one, so
  owner-isolation and 401 paths are proven by the suite (section F), not by clicking.
- `POST /fake-put/{path}` and `GET /fake-get/{path}` exist only so the browser upload flow
  can be driven end to end against the storage fake.
- `dev-tools/` is **not** served over HTTP; to test a file upload in the browser, use the
  file picker, not a fetched URL.

Ports: `4317` is the default inside `serve.mjs`; the preview used for verification runs on
`4327` (`PORT=4327 ./dev-tools/node.sh dev-tools/serve.mjs`), which is the one that carries
the current code.
`EADDRINUSE` in a log means another instance is already serving — check with
`curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:<port>/` before restarting. A
server started before your edits keeps the old `functions/` code in memory: restart it,
while `web/` files are read per request but the browser may need a reload.

## 4. Validate

```sh
./dev-tools/node.sh dev-tools/js-syntax.mjs    # every .js/.mjs parses
./dev-tools/node.sh dev-tools/js-imports.mjs   # imports resolve; helpers called are imported
./dev-tools/node.sh dev-tools/css-classes.mjs  # no class used without a rule
./dev-tools/sync-flat.sh                       # regenerate dev-tools/flat from functions/
./dev-tools/node.sh dev-tools/_run.mjs         # the behaviour suite
```

Expected last line: `SUITE: 636/636 passed`. Sections: **A** core (bootstrap, profile,
wallet, daily, deletion), **B** library and books, **C** scanner, **D** providers and BYOK
(including namespaced model ids and the exact wire format), **E** learning (quizzes,
sessions, games, progress), **F** owner isolation, **G** failure paths with the provider
down (the six classified failures and key redaction), **H** Free Trial, **I** resilience
(retry counts per model, `Retry-After`, cooldown and automatic recovery, fallback
provenance — the provider double records every outbound call it receives), **J** the two
faces of HTTP 429 (per-minute throttle retried with a wait, spent daily allowance asked
once and parked, `error.type`/`error.code`/`Retry-After`/request-reference captured, the
authenticated account check read once and cached) and the burst rules (five identical
presses = one retry chain, the pinned-model path deduped too, the concurrency cap measured
as requests served at the same instant, and the recovery probe gated on a timer so the
question after it sends nothing), **K** the Gemini native wire (the model id in the URL
path and nowhere in the body, `x-goog-api-key` rather than a bearer header, a `models/`
prefix normalised exactly once for a request while the row keeps the id as it was typed, a
Base URL pasted from the catalogue page still producing one binding, discovery that reads
`supportedGenerationMethods` and publishes only bare `generateContent` ids, discovery that
follows `nextPageToken` to the page holding the model, a catalogue that could only be read
partly never denying a model, the protocol re-inferred when the Base URL is edited, and the
gateway's `unexpected model name format` 400 classified as a model problem rather than a key
problem), **L** the acceptance suite for the central gateway and the credits economy —
the sixteen published criteria, each asserted against a real wallet row, a real ledger row
or a real outbound request rather than a mock answer — and **M** the acceptance suite for
the central AI system: the central provider coming up from the environment alone, a real
question answered and charged exactly 2 BC, a failed request costing 0 BC and keeping the
allowance, the daily login paying 30 BC once per Pakistan day, the tenth question allowed
and the eleventh refused, the midnight `Asia/Karachi` reset with credits surviving it, a
balance that cannot be moved from the browser, no cross-student wallet access, no paid
model ever called, an unknown-price model refused, a rate limit handled without a charge,
the provider key never reaching the browser, and eleven concurrent requests unable to pass
the cap or double-charge — plus a catalogue larger than the old 600 KB ceiling being read
whole, an unreadable catalogue failing as `catalogue_unreadable` instead of reporting a
successful check over an empty list, a body cut short by the limit being reported rather
than silently dropped, a published id that begins with `~` being listed and priced
instead of thrown away, and a cold-start admin overview counting the platform provider
in the same response whose health table lists it.

`./dev-tools/node.sh dev-tools/central-live-check.mjs` is the central provider's live
check. It boots the app's own routes, asks `GET /api/ai/settings` — which is what makes
the central provider provision itself — and prints whether it is configured, whether the
catalogue verified, how many models the provider published and how many of them are
published at exactly $0, the key hint (last four characters only) and whether the stored
cipher contains the plaintext. With no `OPENROUTER_API_KEY` it stops after the catalogue
read and says **"no generation was attempted and no answer is claimed"**; with a key it
runs one real question through the router, the adapter and the ledger, and prints the
reply, the model that answered, the tokens and the credits charged.

`./dev-tools/node.sh dev-tools/central-browser-path-check.mjs` is the same check made
against a **running** preview rather than an in-process one. It talks to the port the
browser is already using (`PREVIEW_BASE`, `127.0.0.1:4317` by default), asks one question
through the tutor route the UI calls, and then reads every browser-facing response it
touched and reports how many of them contain the plaintext key — which must be zero. The
key is read from `.env` and never printed. Use it after pasting a key into `.env` to prove
two things at once: the browser path answers, and the key does not travel to the client.

`./dev-tools/node.sh dev-tools/gemini-config-audit.mjs` audits the whole saved Gemini
configuration end to end: it saves a provider exactly as the Setup screen records it
(API Name `Google Gemini`, Provider ID `google-gemini`, Base URL
`https://generativelanguage.googleapis.com/v1beta`, Model `gemini-3.8-flash`), prints the
stored row, the literal outgoing URL, the redacted headers and the sanitized body, walks
the paged catalogue, and reports a PASS/FAIL line for each of 30 checks — including a second
phase that saves the model the way Google's catalogue spells it (`models/gemini-3.8-flash`)
and proves it still binds exactly one path segment.

`./dev-tools/node.sh dev-tools/gemini-path-probe.mjs` asks the app's own Gemini path of a
local `node:http` endpoint that enforces Google's REST binding — it rejects any other path
shape, any body that carries a `model` field, and any request without `x-goog-api-key` — and
prints the literal request line, body fields, status and token counts for five saved shapes.

`GEMINI_API_KEY=<key> ./dev-tools/node.sh dev-tools/gemini-live-check.mjs` is the no-mock
version: it reads what `GET /v1beta/models` publishes for that key, asks the app the Class 10
Newton question through the real router and adapter with the real endpoint behind it, and
prints the outbound path, the body fields, the HTTP status, the reply, the model reported and
the token usage. It follows `nextPageToken` across the catalogue pages, exactly as the app
now does, so a model that lives on a later page is found rather than reported missing. With
no key in the environment it sends nothing and says so.

`./dev-tools/node.sh dev-tools/outbound-probe.mjs` is the same measurements against a real
`node:http` endpoint on a socket rather than an in-process double: it counts its own
requests, tracks how many it was serving at once, and prints the gaps between attempts.
Use it when a number in this file needs re-deriving rather than trusting.

> `dev-tools/_run.mjs` imports `run-all.mjs`, which imports `cases.mjs`. The harness
> resolves `functions/` through the generated `dev-tools/flat/` copy, so **every** change
> under `functions/` needs `./dev-tools/sync-flat.sh` first. Skipping it makes new routes
> answer `not_found` and looks exactly like a real bug.

`dev-tools/probe-toc.pdf` and `dev-tools/probe-cover.png` are small fixtures for manual
scanner testing. `dev-tools/make-probe-pdf.mjs` regenerates the PDF only
(`./dev-tools/node.sh dev-tools/make-probe-pdf.mjs [output-path]`); the cover PNG is a plain
image fixture with no generator.

## 5. What to click first

1. `#/settings` — the Free Trial card, provider list, usage, deletion tools.
2. `#/scanner` — upload `dev-tools/probe-toc.pdf`, "Read the contents page", and confirm
   the chapter rows come with the "read exactly from the PDF text" tag and no charge.
3. `#/games` — any game, finish it, then `#/wallet` to see the ledger entry.
4. `#/focus` — start a short session and watch the dock persist across routes.
5. `#/tutor` — with no provider configured it states the requirement plainly; that
   message is the intended behaviour, not a failure.
6. `#/settings` → connect a provider and press **Test connection**. Paste the model id
   exactly as the provider lists it — a vendor prefix and a `:free` suffix are part of it
   (`qwen/qwen3.8-omni-flash:free`, `google/gemini-2.5-pro`). The button only turns green
   when that exact model answers a one-word completion; anything else shows the provider's
   own status and words on the card. With a placeholder key you should see
   `auth_failed · HTTP 401: …` — that is the real result, not a broken build.
7. A **Gemini** provider is the one case where the Base URL decides the wire:
   `https://generativelanguage.googleapis.com/v1beta` speaks native `generateContent`,
   `…/v1beta/openai/` speaks OpenAI style. Native requests put the model in the URL path,
   so a Base URL ending in `/models` and an id copied from the catalogue as
   `models/gemini-2.5-flash` both still reach one binding — and "Fetch Available Models"
   offers only the bare ids that actually support `generateContent`. The catalogue is
   **paged**: Google's list answers one page of about 50 entries and keeps the rest behind
   a `nextPageToken`, and the app follows that token, so a model that lives on a later page
   is found instead of being reported missing.
8. `#/rewards` — the Rewards Center: claim the daily login reward, see what each reward
   pays, and read the ledger. A second claim on the same day must pay nothing.
9. `#/admin` — only with `ADMIN_OWNER_IDS` set (or a role granted in Admin → Roles).
   Save a platform provider, run **Verify pricing**, enable a model whose zero pricing was
   confirmed, then ask a question in the tutor and watch the wallet fall by the published
   price. With no administrator configured the route answers `admin_required` — that is the
   intended behaviour, not a failure.

## 6. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| New API route returns `not_found` | You changed `functions/` without `./dev-tools/sync-flat.sh` |
| Browser shows old styling or behaviour after edits | The page parsed the stylesheet already; reload |
| `ELECTRON_RUN_AS_NODE` errors | Use `node` directly, or fix the path in `dev-tools/node.sh` |
| Provider save says `credentials_not_configured` | `CREDENTIAL_KEY` is unset in the environment actually running the server |
| Save rejects a model id containing `/` | You are on a build before `modelIdentifier()`; namespaced ids are legal and must reach the provider untouched |
| Test says `model_not_found` and names the endpoint's list | That id is not in the provider's own `GET /models`; fetch the list and pick one instead of editing the id. If the list was only partly read, the app asks the model directly instead of denying it |
| Gemini answers `HTTP 400: GenerateContentRequest.model: unexpected model name format` | The model must sit in the URL path, not in the body. A Base URL ending in `/models` or an id pasted as `models/<id>` used to build `models/models/<id>`; both are normalised now — update the code and ask once |
| Test is `auth_failed` locally | The stored key is a placeholder. The provider's 401 text is shown on purpose |
| Every request succeeds instantly with an empty answer locally | `LOCAL_AI_FAKE=1` is set — you are talking to the in-machine fake, not a provider |
| Trial card says "Not switched on yet" | Expected until `FREE_TRIAL_*` are set — and a non-https `FREE_TRIAL_BASE_URL` also counts as not set |
| Upload fails with 422 | You fed the browser a fetched URL instead of a real file, or the type/size check rejected it |
