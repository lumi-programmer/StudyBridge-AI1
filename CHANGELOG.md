# Changelog

Dates follow the work sessions that produced each change; the project folder was created
2026-10-31 and the latest session is 2026-11-06.

## 2026-11-06 — The catalogue read, verified against the live provider

The brief was to connect the central OpenRouter provider and test the app locally. The
first attempt exposed a defect that had been hiding behind a green suite: **the live
catalogue was never actually being read.**

### Fixed — a catalogue that was cut in half still reported success

- **The reader's limit was below the real catalogue.** `fetchCatalogue()` read the
  provider's `/models` body with a 600 KB ceiling. OpenRouter publishes one page of
  453 models — **813 KB**. `readBody()` returns `''` when the limit is passed, so the
  body parsed to `null`, **zero** models were read, and `verifyPricing()` still set
  `last_status: 'ok'` and returned `checked: 0`. The admin screen showed a successful
  price check over an empty catalogue.
- **The reader now says when it was cut short.** `readBodyResult(response, limit)`
  returns `{ text, truncated }`; `readBody()` is expressed on top of it and keeps its
  old empty-string-on-overflow behaviour for every other caller. The catalogue limit
  is 8 MB — far above anything a provider publishes.
- **An unreadable catalogue is a failure, not an empty list.** A body that runs past
  the limit, is not JSON, or is not a list of models now fails with the new code
  `catalogue_unreadable` (502), registered in `SAFE_CODES` and given a plain-language
  message. A cut-short read can no longer be reported as a successful check.
- **A model is only marked unavailable when the whole catalogue was read.** The sweep
  that disables models the provider no longer publishes is skipped when the read was
  cut short, so a partial read cannot disable a model that is still published.
- **Nineteen published models are no longer thrown away.** OpenRouter's rolling
  aliases (`~openai/gpt-latest`, `~anthropic/claude-opus-latest`) begin with `~`, which
  the model-id rule rejected. `~` is an unreserved URL character and cannot form a path
  segment, so the rule now accepts it; the aliases are listed and priced, and being
  paid models they stay disabled. The model-id hint text was updated to match.

### Verified — against the live provider

`dev-tools/central-live-check.mjs` boots the app's own routes and asks
`GET /api/ai/settings`, which is what makes the central provider provision itself.
Against the real `https://openrouter.ai/api/v1/models`:

| | |
| --- | --- |
| HTTP | 200, one page, no pagination token |
| Size | 813,109 bytes |
| Models published | 453 |
| Models the gateway recorded | 453 — every one |
| Priced from the provider's own numbers | 452 |
| Published at exactly $0 | 14, plus the `openrouter/free` router |
| Models enabled | only the free ones and the router |

The key is stored encrypted (AES-GCM, 96 characters) and the ciphertext does not
contain the plaintext.

### Added — regression cases and the local check

- **Section M, cases M15–M18.** A catalogue larger than the old 600 KB ceiling is read
  whole; an unreadable catalogue fails with `catalogue_unreadable` and disables
  nothing that was verified earlier; a body cut short by the limit is reported as
  truncated rather than silently dropped; a published id that begins with `~` is
  recorded and priced.
- **`dev-tools/central-live-check.mjs`.** The live check described above. With no
  `OPENROUTER_API_KEY` it stops after the catalogue read and prints *"no generation
  was attempted and no answer is claimed"*; with a key it asks one real question
  through the router, the adapter and the ledger, and prints the reply, the model
  that answered, the tokens and the credits charged.

### Tests

`SUITE: 633/633 passed` — 619 before, plus the 14 new checks.

## 2026-11-06 — Phase 2: the central AI system, free models, Bridge Credits and the daily reset

The brief was a second attachment: one centrally managed server-side provider
(OpenRouter, `openrouter-central`), strict free-model routing, Bridge Credits with a
daily login reward and a 2 BC question price, a 10-questions-per-day allowance, and a
reset at midnight `Asia/Karachi`. The rule that shaped every change: **no second wallet
and no second router** — the existing gateway, the existing ledger and the existing
screens were extended, not duplicated.

### Added — StudyBridge Free AI

- **The platform's own provider, provisioned from a Secret.** `OPENROUTER_API_KEY`
  (server-side only) makes `ensureCentral()` idempotently create the provider
  `openrouter-central` at `https://openrouter.ai/api/v1` with the router model
  `openrouter/free`, encrypted with the same AES-GCM vault that protects BYOK keys.
  The key never reaches the browser, never enters `localStorage`, and is decrypted for
  one outbound request and nothing else. Four optional `OPENROUTER_*` overrides let an
  operator change the provider id, name, base URL, model, enablement or shared daily
  quota without a redeploy.
- **Free only when the price was actually checked.** `syncCentralCatalogue()` reads the
  provider's own catalogue and records a model free only when the provider published
  exactly zero for input *and* output. A model with an unknown price is recorded
  `pricing_verified: false` and stays disabled; a paid model is recorded
  `free_tier: false` and stays disabled. There is no path from "unknown" to "free".
- **The router's answer is re-checked.** `openrouter/free` picks a model per request,
  so the model the router *actually returned* is compared against the verified-free
  list before it is allowed to answer — refused, refunded, nothing charged.
- **Students need no key.** Settings shows a **StudyBridge Free AI** card reading
  exactly: *"AI access is centrally managed by StudyBridge. You do not need to provide
  your own API key."* plus what the server actually knows: configured or not, how many
  free models are verified, questions remaining today, the BC balance and the exact
  next reset. With no central provider configured the card says so plainly.
- **Configured is not answering.** The admin panel reports the two separately: a
  provider with a valid key and zero successful generations reads "configured, never
  answered", never a green light.

### Added — the daily AI allowance and the midnight reset

- **`app.ai_daily_slots`** — a new table, `UNIQUE (owner_id, day, slot)`, one row per
  question, numbered `1..10`. A request takes the next free slot for the Pakistan
  calendar day; a failure releases it. Two requests arriving at the same instant cannot
  take the same slot, so the cap holds under concurrency and a failed request never
  consumes the allowance.
- **The server decides, not the device.** `day` is computed on the server from
  `Asia/Karachi`; the reset is 12:00 AM Pakistan Standard Time (19:00Z the day
  before). No rolling 24-hour timer, no client-supplied day.
- **Credits survive the reset.** Only the allowance resets; the wallet does not.
- **The provider's own quotas are separate.** The admin panel and the docs say so
  plainly: StudyBridge's midnight reset does not restore OpenRouter's quota, and the
  product never implies that it does.

### Changed

- **Every day comparison moved off UTC.** The app-wide day/period helpers in
  `functions/lib/util.mjs` (`dayOf`, `dayOfIso`, `nextResetIso`) now compute the
  Pakistan calendar day, and every caller was migrated — daily login, the daily
  question, the daily goal, the daily challenge, the weekly goal, streaks and the AI
  allowance.
- **`/api/ai/settings`** now carries the `central` block; **`/api/admin/overview`**
  now carries `central` monitoring. No route was added and no route was removed — the
  API surface is still 97 endpoints over 34 tables.

### Testing

- **Section M — 64 new checks** covering the 17 Phase 2 acceptance criteria against a
  provider double: a real question is answered by the free model and charged 2 BC; a
  failed request costs 0 and keeps the allowance; the daily login pays 30 BC exactly
  once per Pakistan day; the 10-question cap holds, including under concurrency; the
  reset lands on the `Asia/Karachi` boundary; credits survive it; no frontend
  balance can be changed; one student cannot read another's wallet; no paid model is
  ever called under any fallback; an unknown-price model is never called; a rate limit
  is reported in the provider's own words and is not charged; no key appears in any
  browser-facing payload; the tutor works through the central provider with no student
  key; and two simultaneous requests cannot bypass the limit or double-charge.
- **`SUITE: 619/619 passed`** (A 32, B 26, C 18, D 61, E 42, F 9, G 36, H 24, I 56,
  J 72, K 65, L 114, M 64).

### Not done, and stated plainly

**No live AI generation has been performed.** This workspace holds no
`OPENROUTER_API_KEY`, so no request has ever reached OpenRouter and no real answer has
been produced. The integration is implemented and covered against a provider double;
it needs one Secret and one live question to confirm end to end.

## 2026-11-06 — the central AI gateway and the Bridge Credits economy

The brief was one attachment in seven parts: a wallet that students cannot edit, a
single gateway behind every AI request, an administrator who can see and change the
economy, a Free Model Policy that cannot be talked around, and sixteen acceptance
criteria to be proved before anything is called done. Nothing existing was rewritten:
the router, the wallet, the ledger and the eleven screens stayed where they were, and
the new parts sit in front of them.

### Added — the gateway

- **`functions/lib/gateway.mjs`.** One place every AI request goes through. It holds the
  platform-side providers (`app.ai_providers`), the approved model registry
  (`app.ai_models`), the health history and the analytics. A model is selectable only
  while its **verified** input and output prices are both exactly zero, the provider
  published it, an administrator enabled it and it is not cooling down.
- **Pricing verification.** `POST /api/admin/providers/:id/verify` reads the provider's
  own catalogue and marks a model free only when the provider published exactly zero on
  both sides. `PATCH /api/admin/models/:row` refuses to enable an unverified model
  (`409 pricing_not_verified`) — there is no switch that turns a paid fallback on.
- **The OpenRouter free router is checked on every answer.** `openrouter/free` is not
  priced itself; it picks a model per request. So the gateway compares the model the
  router *actually returned* against the verified-free list, and refuses the answer if
  that model is not on it — refused, refunded, nothing charged.
- **Provider management** (admin only): add, edit and remove providers; Base URL and
  protocol (`openai` / `openrouter` / `gemini`); add and remove models; enable and
  disable; **Test connection** (one real request — a catalogue is not proof a key
  works); **Verify pricing**.
- **Monitoring**: provider health, rate-limit status, request and failure counts, last
  successful request, last error, and the request history behind them.

### Added — the credits economy

- **`functions/lib/economy.mjs`.** The published price of every AI feature and the
  published value of every reward, plus the limits. An administrator changes a price or
  a limit as a **data edit** — it applies to the next request, with no redeploy.
- **Reserve → settle → refund** in `functions/lib/rewards.mjs`. The credits are held
  *before* the model is contacted, settled only on a real answer, and refunded
  automatically when the generation fails. A reservation that never took the credits is
  marked failed and never refunded, so a student is not paid for a request that cost
  nothing. A repeated request key replays the first outcome instead of spending again.
- **A ledger that cannot contradict the wallet.** The balance change is a
  compare-and-set on the wallet row with a bounded retry and jitter, so simultaneous
  requests converge instead of conflicting; a ledger row that outlived a balance change
  that never happened is deleted rather than left behind.
- **Rewards** with a unique claim row per `(owner, reward, period)`: daily login 30 BC,
  daily learning question 10 BC, study session 15 BC, daily goal 20 BC, daily challenge
  15 BC, seven-day streak 100 BC, weekly goal 50 BC. A repeat claim — including two
  fired at the same instant — pays once.
- **Pricing**: basic question 2, concept explanation 2, problem-solving explanation 2,
  short passage summary 4, chapter summary 8, revision notes 6, practice quiz 5,
  two-model advanced check 10 BC. The price is shown **before** the student submits.

### Added — the screens

- **Rewards Center `#/rewards`**: every reward, what it pays, how it is earned, whether
  it has been claimed today.
- **Admin Dashboard `#/admin`**: economy analytics, provider management, provider
  monitoring, economy controls and roles. The nav link appears only when the **server**
  reports the role; the role itself lives in `app.user_roles` and is bootstrapped from
  the `ADMIN_OWNER_IDS` Secret. A student who finds the URL gets the same
  `403 admin_required` as one who never found it.
- **The tutor** now shows the live balance, the cost of the action about to run and the
  display name of the model that will answer.

### Added — the schema

`schema/central-gateway.sql`, applied **after** `schema/studybridge.sql`: 8 platform-side
tables (`user_roles`, `ai_providers`, `ai_models`, `ai_requests`, `ai_usage_limits`,
`provider_health_logs`, `reward_claims`, `economy_settings`) and 9 indexes. It adds no
column to an existing table, so it applies cleanly to a schema that already carries the
base migration. `app.wallets`, `app.transactions`, `app.streaks`, `app.achievements`
and `app.daily_states` are reused, not duplicated. *(A ninth table,
`app.ai_daily_slots`, was added to this same file in the Phase 2 session above — apply
the current file, not this description of it.)*

### Fixed

- **The gateway could never answer.** `providerRows()` did not select `key_cipher`, so
  the router was handed a provider with no cipher, `codec.decrypt(undefined)` threw and
  every platform answer died as `transport error` — indistinguishable from "the
  provider is down". The cipher is now loaded for the router only; the public admin
  response still carries `key_hint` and no cipher.
- **A ledger row could outlive its balance change.** `applyDelta` inserted the
  transaction, then failed to move the balance, leaving a spend in the history that the
  balance never reflected. The row is now deleted before the failure is raised, the CAS
  bound went from 6 to 25, and a 0–4 ms jittered pause breaks the lockstep so
  concurrent requests converge instead of retrying in step.
- **A refused debit left the reservation pending.** It now closes as `failed`, and
  `refundAi` refuses to refund a request that was never charged.

### Verified

`SUITE: 554/554 passed` (A 32, B 26, C 18, D 61, E 42, F 9, G 36, H 24, I 56, J 72,
K 65, **L 113**). Section **L** is the acceptance suite for all sixteen criteria: an
administrator configures a provider through the admin API, the provider's own catalogue
is verified, and a student then asks real questions — each assertion reads a
server-written wallet row, a ledger row or a recorded outbound request, never a mock
answer. `js-syntax`, `js-imports` and `css-classes` clean.

### Still blocked

Publication. `ensure_backend` returns `sites_quota_exceeded` (`backend_sites` used 0 /
limit 0) and the schema cannot be applied without it, so the gateway and the economy
have been proven against the real handlers on an in-memory data layer and not against
the deployed Postgres.

## 2026-11-05 — the Gemini configuration was audited end to end, and the model list turned out to be paged

The report was still `HTTP 400: GenerateContentRequest.model: unexpected model name format`
on a Gemini provider whose key *is* accepted, plus a second symptom: Test Connection saying
"None of the 1 model id(s) saved here appear in this endpoint's list of 50". The instruction
was explicit — no speculative fix, inspect the complete provider configuration and the
request-building flow first — so the saved row, the outgoing request, the protocol choice,
the discovery path and the parser were each read and measured before a line changed.

**The saved configuration was audited, not corrected.** API Name `Google Gemini`, Provider ID
`google-gemini`, Base URL `https://generativelanguage.googleapis.com/v1beta`, Model ID
`gemini-3.8-flash`, display name `Gemini 3.8 Flash` are all stored exactly as typed and all
are correct as saved. The Provider ID is free text (`provider_key`, unique per owner, with
`free_trial` as the only reserved value) — there is no id-to-protocol registry, so
`google-gemini` must **not** be renamed. There is no stale cached provider settings either:
`getProvider()` re-reads the row on every call.

Three real defects came out of the audit:

- **The protocol was a snapshot of the address at save time.** `createProvider()` inferred
  the wire from the Base URL, but `patchProvider()` left the stored wire alone when the
  Base URL changed — so a provider switched from the OpenAI-compatible base to the native
  one kept speaking chat to Google's native endpoint. `inferWire()` is now applied on edit
  with the same rule the save path uses, so an edited address can never keep talking the
  old language (section K8).
- **Discovery read only the first page of Google's catalogue.** `ListModels` is paged: one
  page of ~50 entries, the rest behind `nextPageToken`. The app read page one, so a model
  living on a later page was reported missing — which is exactly the "list of 50" message.
  A bounded walk now follows `nextPageToken` (8 pages, 400 entries) in both `remoteModels()`
  and `checkProvider()` (section K6).
- **A partly-read list could deny a real model.** If the catalogue could only be read in
  part, the answer is unknown, not negative. A partial list may now never reject a model:
  the model is asked directly instead, and the card says the list is partial rather than
  implying the model does not exist (section K7).

**The outgoing request was verified at the socket, not inferred.** The tap shows
`POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent`,
headers `{"content-type":"application/json","x-goog-api-key":"[redacted]"}` with no
`Authorization` header, and a body of `contents` / `systemInstruction` / `generationConfig`
only — no `model` field, `:generateContent` exactly once, one path segment, never
`models/models`. The parser reads `candidates[].content.parts[].text` and reads token usage
from `usageMetadata`. The key never appears in a response body.

Two field hints in `functions/lib/dom/providers.mjs` now name the two real Gemini bases
(`…/v1beta` native, `…/v1beta/openai/` chat) instead of only the chat one, and the model
hint asks for the id exactly as the provider lists it.

New instrument: **`dev-tools/gemini-config-audit.mjs`** saves the provider exactly as the
Setup screen records it, then checks 30 facts — the stored row, the protocol, the literal
URL, the headers, the body, the paged discovery, the parsed answer, the key's absence from
every response — and exits non-zero on any failure. It ends with a second phase that saves
the model the way Google's catalogue spells it (`models/gemini-3.8-flash`) and proves it
still binds exactly one segment and answers. Suite: **441/441**, section **K** now 65 checks
(K6 paged discovery, K7 a partial catalogue, K8 the protocol re-inferred on edit).

**What is deliberately not claimed:** this environment holds no Gemini key — no `AIza*` in
the workspace, `.env` has zero uncommented assignments — and the deployed site's database
answers `sites_database_not_ready`, so the student's own row and key were not reachable
from here. **No real HTTP 200 from `generativelanguage.googleapis.com` is on record**, and
the audit's 200 came from a local endpoint that enforces Google's binding. The one command
that settles it uses no stub anywhere:
`GEMINI_API_KEY=<key> ./dev-tools/node.sh dev-tools/gemini-live-check.mjs`.

## 2026-11-05 — the Gemini native request was built wrong, and our own model list fed it back

The report was an authenticated Gemini provider answering every generation with
`HTTP 400: GenerateContentRequest.model: unexpected model name format`. The whole request
path was read before any code changed, and the cause was not the key, the model's
existence or the message shape — it was the URL.

Google binds the model in the path (`/v1beta/models/{model}:generateContent`) and
`{model}` is one bare name, because `*` in a Google REST binding does not cross `/`. Two
values a student can legitimately paste break that binding, and StudyBridge produced both:

- **`functions/lib/ai.mjs` → `remoteModels()`** read Google's catalogue with
  `item.id || item.name`, and Google's `ListModels` publishes no `id` — every entry's
  *name* is the resource name `models/gemini-…`. "Fetch Available Models" therefore offered
  the prefixed string, `modelIdentifier()` accepts `/`, and the row saved it verbatim. The
  adapter then percent-encoded the slash: `/v1beta/models/models%2Fgemini-3.8-flash:…`.
- **A Base URL ending in `/v1beta/models` is one we accept.** `createProvider()` recognises
  that path as a native Gemini endpoint (ai.mjs:794) — it is Google's own list endpoint, and
  the natural thing to paste from the discovery docs — and the saved value keeps its path,
  so the old `` `${base}/models/${model}:generateContent` `` emitted
  `/v1beta/models/models/gemini-…:generateContent`.

So both routes into the malformed request were ours: the id our own fetch published made the
report's error, and an accepted Base URL made it again — then the model-format 400 landed in
`mapFailure(400)` as `provider_request_failed`, surfaced as a generic 502 and retried,
telling the student nothing about the actual problem.

- **One normalisation, on the way out only.** New `geminiRoot()` drops a trailing
  `/models` from the base and `geminiModelSegment()` collapses repeated `models/` prefixes
  and a leading slash. Five saved shapes — bare id, `models/` id, base ending in `/models`,
  trailing slash, and the last two together — now all put exactly one segment in the path,
  while `models.model_id` still holds the string exactly as it was typed. Nothing in the
  row is rewritten to hide a bug.
- **Discovery tells the truth about this key.** `ListModels` is read as `name`/`id`, the
  `models/` prefix is stripped once, and an entry is offered only when the endpoint itself
  says it supports `generateContent` (an entry that publishes no methods list is still
  passed through, because that is what the endpoint claimed) — so a model can no longer be
  offered, saved and then fail on the wire. `checkProvider()` compares the same stripped
  form. No availability is invented or hardcoded.
- **Classified as what it is.** `unexpected model name format` joins
  `provider_model_not_found`: asked once, never retried, shown on the provider card in
  Google's own words and never as a key problem.
- **Body and auth confirmed against the contract, not assumed**: the generation body
  carries only `contents`, `systemInstruction` and `generationConfig` — an unknown `model`
  field is its own 400 in `GenerateContentRequest` — and the key travels in
  `x-goog-api-key`, never a bearer header.

Measured, not asserted: `dev-tools/gemini-path-probe.mjs` puts the app's own adapter behind
a local `node:http` endpoint that *enforces Google's binding* — any other path shape, any
body containing `model`, and any request without `x-goog-api-key` is rejected — and for all
five shapes the far end logged `/v1beta/models/gemini-3.8-flash:generateContent`,
`x-goog-api-key=true Authorization=false`, body fields
`["contents","systemInstruction","generationConfig"]`, HTTP 200, the Newton answer, and
`usageMetadata` totals of 115 tokens. Path traversal ids (`../../v1beta/models/…`) are
refused by `modelIdentifier` before anything leaves the server, and a legal slashed id stays
one path element because it is percent-encoded. Suite: **420/420** in that session (now
**441/441**), new section **K** contributing 44 checks over construction, discovery,
classification and refusal (now 65).

**What is deliberately not claimed:** this environment has no Gemini key — `.env` carries
none and no `GEMINI_*` is set — so **no real HTTP 200 from
`generativelanguage.googleapis.com` is on record for this fix**. Step 4 of the report is
answered by `GEMINI_API_KEY=<key> ./dev-tools/node.sh dev-tools/gemini-live-check.mjs`,
which uses no stub anywhere: it lists what Google publishes for that key, sends the Class 10
Newton question through the app's own save/router/adapter with the real endpoint behind it,
and prints the outbound path, body fields, status, reply, returned model and token counts —
or states plainly that the endpoint refused. `GEMINI_PROVE_BUG=1` additionally asks the old
malformed shape once, so the 400 can be seen rather than remembered.

## 2026-11-05 — one provider outage stopped looking like a stream of failures from StudyBridge

The report was "repeated HTTP 503 and 429 from xKiro across multiple Qwen models". No key
and no model id was changed to answer it. The whole outbound path was measured instead —
browser, router, provider double and the live gateway — and five separate ways of
multiplying one failure were found and closed:

- **Every question spent a live request on a refusing endpoint.** Once all models cooled,
  routing handed each new question a recovery probe and the banner even told students to
  send the question once more. Probes are now on a timer (`AI_RECOVERY_PROBE_MS`, default
  60 s per cooling model): the first question after a refusal gets one single-attempt
  probe, and anything inside that window sends **nothing** and returns the new
  `provider_paused` with the seconds left. The gate is stamped when the probe actually
  leaves, not when it is offered.
- **The pinned-model path skipped in-flight deduplication**, so a double click on a named
  model paid for the prompt twice. One key now covers both auto and pinned routing.
- **Nothing limited one student to one call at a time.** `AI_MAX_CONCURRENT` (default 1)
  queues a student's further questions instead of delivering them as a burst, and routing
  is re-read when the queued call goes out — so a question that waited behind another no
  longer spends three attempts on a model that refused during the wait.
- **`web/js/api.js` had no dedup at all**: an identical in-flight request is now one
  request, with `noDedupe` for the calls that genuinely must repeat.
- **The scanner's stage buttons could be pressed during their own upload**, which started a
  second upload and a second model call for one action. Cover, contents and chapter buttons
  now lock before the upload begins.

Every count below was taken by the server at the far end of the socket
(`dev-tools/outbound-probe.mjs`), not by the caller: one 503 question = **3** requests with
gaps of 438 and 739 ms; five identical presses = **3** requests, peak **1**; four different
questions at cap 1 = **4** requests peak 1 (it was 12 before the queue and the re-derivation
fix), at cap 4 = 12 requests peak 4; a 429 with `Retry-After: 2` = 3 completions spaced
**2156 and 2149 ms** plus **1** account-usage read, not one per retry; a refusal followed by
five more questions = **1** request total, four of those questions answered locally with
`provider_paused`. Recovery was proven the same way: after the window the model answered
HTTP 200 with real text, `fail_streak` returned to 0, `enabled` stayed true and no paid
model was ever introduced. Independently of the app, xKiro itself is reachable —
`/v1/models` 200 in 455 ms (reference `a55bc1aa3a117eb3-KHI`) listing both Qwen free ids,
and unauthenticated completions 401 in 176–650 ms with no `Retry-After` and no
`x-ratelimit-*` header to obey.

Verified in the live browser, not only in the suite: the tutor's three states in order —
"the endpoint did not answer (tried 3 times)… cooling for about 30s", then "expected to be
tried again in about 15 seconds… you do not need to keep sending the question", then
**"Not sent — paused to let the provider recover — StudyBridge is sending nothing to Stub
Qwen for about 45 more seconds"**. Three identical `api.post` presses from the loaded page
produced **1** network request; with `noDedupe` the same three produced 3. The temporary
stub provider was deleted afterwards, the preview is back to zero providers, and the key
appeared in no response body or DOM text.

Suite: **376/376** (section J 42 → 72 with J12–J15), `js-syntax` / `js-imports` /
`css-classes` clean, flat bundle resynced.

**What is deliberately not claimed:** no real `chat/completions` response has been received
from xKiro, so this is reported as *the repeated-failure storm is stopped*, not *the
integration is fixed*. The remaining unknowns — whether the allowance or the minute window
was exhausted, and whether the refusals are per-model or account-wide — need the student's
working key in a preview running this code, plus one press of **Check account limits**; and
deployment to check it live is still blocked by `sites_quota_exceeded`.

## 2026-11-04 — every section driven in a real browser, and the three defects that caught

All eleven sections plus the detail routes (`#/spaces/<id>`, `#/library/<id>`, the scanner's
four stages and the space's Settings tab) were opened in a browser against the running
preview, and each page's rendered text was scanned for `null` / `undefined` / `NaN` /
`[object Object]` and for links whose href carried an undefined id. **Zero** such strings
reached the screen, and no in-page link was dead. Three defects survived that pass and are
fixed:

- **The Game Center left the wallet stale.** After a graded round the ledger had already
  written, but the header chip and the board's `best / played / BC earned today` row kept
  the numbers from before the round until a manual reload. Every other reward flow in the
  app calls `refresh()`; this was the one that didn't. The board is now rebuilt from the
  server after each finish. Verified live: one 6/8 Math Rush round moved the chip
  **88 → 191 BC** and the caps line `8 → 11 BC earned today · 3 → 5 rounds played · 3 → 2
  rewarded rounds left` with no reload, and `/api/wallet` explains the whole jump as three
  rows from that one call — `game:… +3 → 91`, `weekly:2026-11-02 +50 → 141`,
  `ach:weekly_challenge +50 → 191`. No fourth row, no double credit.
- **An unknown section folded itself into the Dashboard.** `#/space/<id>` (singular) or a
  mistyped `#/spacess` rendered the dashboard with the Dashboard nav item marked active, so
  a typo or a stale bookmark looked like a real page. The router now has a `notfound` state
  that names the URL it could not match and offers the way back. Verified live:
  `data-route=notfound`, title `Page not found · StudyBridge AI`, no nav item falsely
  active, wallet chip still populated, and `#/`, `#/focus`, `#/spaces/<id>?tab=settings`,
  `#/library/<id>` and `#/games` all still route to their own sections.
- **Two reading errors in my own sweep, corrected rather than "fixed":** the detail views
  first appeared broken because I probed `#/space/…` and `#/book/…`, which this app never
  links; and an abandoned game round showing as `played 4` is the designed behaviour —
  `game_sessions` rows are created when a round starts, while `credits_earned` and
  `reward_rounds_left` count only rounds that actually earned, so opening and leaving a
  round cannot consume the daily reward cap.

Also re-checked live, with the ledger read back after each: the 30 BC daily login claim, a
wrong daily answer earning nothing, the wallet's own rows, and a focus session taken from
start to finish. The 47-second session recorded as `0 min`, paid **no** study credit, and
said so (`Sessions under 10 minutes are recorded but earn no Bridge Credits`), while the
+15 BC that did arrive came from `ach:first_session` — the only row for it — and My Progress
showed `sessions: 1, minutes: 0`. Nothing in these flows invented time or credit.

Suite re-run after the changes: **346/346** (no function code changed; the router and view
fixes are browser-side and verified by driving the page, since the suite has no DOM runner).

## 2026-11-04 — the HTTP 429, diagnosed and split into the two things it was hiding

Reported: the key is now accepted, but requests come back `HTTP 429: A server error
occurred. Please try again.` Reproduced live against the real provider:

```text
12:33:05.665Z → 12:33:06.590Z   POST /api/spaces/<uuid>/chat → 429
qwen/qwen3.8-max:free at xKiro Qwen Max: A server error occurred. Please try again
(tried 3 times, last was HTTP 429) — that model is cooling for about 2s
```

Measured facts, all from real requests:

- The model id is **not** the problem. `GET https://api.xkiro.com/v1/models` answered 200
  and contains `qwen/qwen3.8-max:free` with `access_tier: "free"` and `pricing 0/0` — the
  exact id saved is the exact id sent, and no paid model was substituted.
- The 429 is **account-scoped, not IP-scoped**: 15 rapid requests to the public catalogue
  all returned 200, and 12 rapid chat posts with an invalid key all returned 401. The
  gateway never emitted a 429 or a `Retry-After` on those paths.
- The provider's error envelope always carries `error.type` and `error.code` (proven:
  `authentication_error`, `not_found_error`/`not_found`). The build in use parsed them for
  classification and then **threw them away**, and status-first classification mapped every
  429 to "rate limited" — so a reply whose own words said *server error* was displayed as
  though the student had asked too often.
- `GET /v1/usage` **exists** and requires the key (`401 Missing ClientApiKey`, while
  `/v1/account`, `/v1/plan`, `/v1/subscription`, `/v1/rate_limits` are `404`) — so the
  daily allowance is readable, but only from the Function.
- The three attempts landed inside **0.8 s** — effectively instantaneous — because the
  local preview inherited the test harness's zeroed backoff, and the zeroed
  `AI_RETRY_AFTER_CAP_MS` capped any provider `Retry-After` to nothing.
- The student-facing text was truncated at 200 characters, cutting the sentence that
  explains the cause.

### Re-tested 35 minutes later, against the live provider

Two requests only, both through the app's own one-request paths, spaced 80 s apart:

```text
13:06:27.860Z → 13:06:33.153Z  POST /api/providers/<uuid>/test  → status "unreachable"
                               (the catalogue read succeeded; the single completion
                               probe was cut off by that process's 5s timeout)
13:07:48.655Z → 13:07:48.972Z  POST /api/providers/<uuid>/test  → status
                               "provider_rate_limited", auth "accepted"
                               "HTTP 429: A server error occurred. Please try again.
                                Your API key was accepted, so this is not a key problem."
13:13:47.721Z                  GET https://api.xkiro.com/v1/usage (through the new
                               account check, deliberately invalid key) → HTTP 401 in
                               154 ms, [error.type=authentication_error,
                               error.code=authentication_error, no Retry-After,
                               ref=a553e0cb4b5c727e-KHI]
```

What that settles:

- The **key is accepted** (`auth: accepted`, and the authenticated catalogue read
  returned 103 ids) and the **model id is valid and free**, so neither the credential nor
  the identifier is the cause, and no paid model was substituted.
- The refusal is at the **completion** step, and it arrives in ~250 ms — a fast gate, not
  a queue timeout. It therefore cannot have been caused by StudyBridge's volume: five
  completions across 35 minutes, and the very first attempt of each test was the one
  refused.
- One of the two attempts hung past that process's 5 s deadline instead of answering 429.
  The same question in production has `AI_TIMEOUT_MS=45000`, so a slow free pool answers
  there and timed out only in the preview — which is why the preview now starts with the
  production 45 s deadline rather than the suite's 5 s.
- Because the model list saved here has exactly **one** free model, Auto has no other
  eligible row to fall back to while that pool refuses; a second `:free` model is the
  student's own choice to add, not something the router substitutes.
- The remaining question — *is this minute's window or today's allowance* — is answerable
  only from `GET /v1/usage` **with the working key**. The path is now verified live (it
  reaches the endpoint, authenticates, captures the diagnostics, redacts the key), the
  gateway simply has nothing to say to a key it refuses.
- Nothing measured here was reported as passing that did not run: an earlier instance
  started with `LOCAL_AI_FAKE=1` answered `/usage` in 2 ms with `{}` and the chat with an
  empty 200. Those are stub artifacts of the in-process double (`makeFetch` returns
  `Response('{}', {status: 200})`), not provider behaviour, so they are excluded from the
  findings above and that instance was stopped.

### Added
- **429 is now two classes.** `provider_quota_exhausted` (codes such as
  `insufficient_quota`/`usage_limit_reached`, allowance prose, or a `Retry-After` of an
  hour or more) versus `provider_rate_limited` (a per-minute or concurrency window).
  Classification reads `error.type`/`error.code` first, then the provider's words, then the
  length of the wait it asked for.
- **A spent allowance is asked exactly once** — no retry chain against a provider that has
  already said no for the day — and the model is parked for the full
  `MODEL_COOLDOWN_MAX_MS`, so the next question sends one recovery probe instead of three
  more requests.
- **`Check account limits`** on each provider card (`POST /api/providers/<uuid>/usage`)
  reads the provider's own authenticated usage endpoint from the Function, flattens the
  limit fields it actually publishes, states whether the allowance is spent or still
  available, and says plainly when the provider publishes nothing that answers the
  question. The key never leaves the server; the read is throttled to one per provider
  per 5 minutes and cached in between. A 429 triggers the same read once, and its numbers
  are quoted into the student's message.
- **The provider's own diagnostics are kept and shown**: `error.type`, `error.code`, the
  exact `Retry-After` or the fact that there was none, and the request reference
  (`cf-ray`/`x-request-id`) — in the tutor banner and in the card's *Last error*.
- **`MIN_RETRY_PAUSE_MS` = 250 ms**: a hard floor under the pause, so no Secret
  combination can make StudyBridge re-send instantly. Published to Settings as
  `retry_policy.min_retry_pause_ms`.
- **Status and prose that disagree are reported as disagreeing**: a 429 quoting a
  server-side fault now says the fault is on the provider's side and waiting is the only
  fix, instead of telling the student to slow down.
- **A 200 account body that names no limit says what it contained** (key names and array
  markers only, e.g. `object, data[], updated_at`, or "a non-JSON body of 13 characters"),
  so "the provider published nothing" is evidence rather than an assumption.
- Suite section **J limits** — 42 checks (throttle retried with a measured ≥1 s gap,
  quota asked once then parked, `error.code` beating vague prose, the server-fault 429 not
  blamed on the student, all four diagnostic fields reaching the student and the card, the
  authenticated account read cached and key-free, 404 stated as not published, and a 200
  account body that names no limit reporting the keys it did carry).
  Total: **346/346**.

### Fixed
- The local preview no longer runs on the suite's zeroed retry timings; it starts with
  production-like pacing (base 700 ms, budget 12 s, cooldown 30 s, and the same **45 s**
  per-call deadline the deployed Function uses, so a slow free pool is not reported as a
  timeout the student would never see) so a preview against a real API cannot hammer it,
  and the harness budget was raised to keep the retry cases retrying.
- Provider failure hints are no longer cut off mid-reason (200 → 400 characters, with the
  cause ordered before the mechanical tail).
- Found by driving the real page in a browser rather than by reading it: the router card
  promised “no retry faster than **0**” (250 ms rounded away) and the account panel printed
  a bare line reading `null` whenever the provider’s answer had no canned verdict text. The
  card now says **250 ms**, minute-scale waits read as `5 min` / `10 min` instead of `300s`
  / `600s`, and the optional line is dropped from the panel instead of passed as a null
  child.

### Not verified
- The provider's real `/v1/usage` **numbers** for this key. The endpoint is reached,
  authenticated and reported by the new code path — verified live, including the
  diagnostics envelope and the key never returning to the browser — but the working key is
  held only in the memory of the preview process that saved it, and that process predates
  this code. Pasting the key once into the rebuilt preview and pressing
  **Check account limits** produces the figures; nothing here substitutes a guess for them.
- The `error.type` / `error.code` **of this account's 429** specifically. The capture
  itself is proven against the live gateway (a real 401 came back as
  `[error.type=authentication_error, error.code=authentication_error, no Retry-After,
  ref=…-KHI]`), and a 429 was observed and classified, but the two observations need the
  same key at the same moment, which is the one press above.

## 2026-11-04 — provider authentication, error classification and automatic fallback

Two failures were reported for the same provider and had completely different causes.
Neither was a UI problem:

- `qwen/qwen3.8-omni-flash:free → Invalid or disabled ClientApiKey` — **xKiro's gateway**
  refusing the stored value with `401`. The string exists nowhere in this repository, and
  the value most often saved for this provider (`XKIRO_API_KEY`) is the *name* of a secret,
  not a key.
- `HTTP 503: The model is temporarily unavailable due to high demand` — a **transient
  overload** at the provider, which this build previously filed as a generic failure, never
  persisted to the provider row, and displayed as an authentication problem. That mismatch
  is why the tutor showed "ClientApiKey" while the usage log recorded a 503.

### Fixed
- **Status-first classification** (`classifyFailure`) — 401/407 authentication, 403 access,
  404 model-not-found, 429 rate limit, 408/5xx unavailability; prose patterns are consulted
  only for a bare 400, never over a status that already speaks. A 503 can no longer be
  labelled an invalid key, and a 403 is no longer lumped in with 401.
- **Every failure class is now persisted** to `providers.last_status` / `last_error` and
  cleared to `ok` on the next good answer, so the Settings card shows the newest real
  outcome instead of an old key complaint outliving the outage that replaced it.
- **Bounded retries with backoff, jitter, timeouts and `Retry-After`** (`callWithRetry`) —
  permanent failures (bad key, unknown model, forbidden) stop after one request; only
  transient ones retry, within `AI_RETRY_ATTEMPTS` and `AI_RETRY_BUDGET_MS`, honouring the
  provider's suggested wait up to `AI_RETRY_AFTER_CAP_MS`.
- **Automatic model cooldown with recovery** — a transient failure writes
  `fail_streak` / `cooldown_until` / `cooldown_reason` on the model row; the window doubles
  per consecutive failure up to `MODEL_COOLDOWN_MAX_MS`, honours `Retry-After`, and is
  cleared by the first success. Nothing is disabled and no configuration is touched. When
  every model is cooling, one **recovery probe** (a single request, not three) decides
  between an answer and `models_temporarily_unavailable` with an ETA.
- **Auto now means cheapest-capable again** (`candidates`) — cost orders the pool and the
  student's default model only breaks a tie, so an outage cannot quietly move a student to
  a dearer model, and recovery returns to the cheapest one by itself.
- **`Test connection` no longer confuses a public catalogue with a working key.** xKiro
  answers `GET /v1/models` with 200 *without credentials*; the test now probes the
  completion endpoint with a sentinel message and reports `auth: accepted | rejected`
  independently of the model result, so "the key is refused" and "that id is not listed"
  stay separate sentences. A provider is only marked Connected when a real request answers.
- **Key capture is validated on save** (`normaliseApiKey`): `Bearer `/`x-api-key:`/`api_key=`
  wrappers and inner whitespace are stripped, and a value that is shaped like an
  environment variable name (`XKIRO_API_KEY`) is refused with a `key_warning` explaining
  that the secret *value* is what belongs in the field — instead of being encrypted, sent as
  a bearer token and producing this exact 401.
- **Fallback and retry are visible, not silent**: `/api/spaces/:id/chat` returns `retried`,
  `fell_back`, `fell_back_from` and `waited_ms`; the tutor tags the answering model with a
  **via fallback** chip listing what was skipped, and the same provenance is stored in
  `messages.sources` so it survives a reload (this also fixed a pre-existing bug where
  citations and the cache tag vanished on refresh).
- **A security leak found while wiring the warning**: `PATCH /api/providers/:id` returned
  the raw row, so an update could put `key_cipher` on the wire. Both the no-op and the write
  paths now return the same masked projection as the list endpoint (`key_hint` last four).
- **Uniform terminal codes**: when every model in the pool failed the same way, the router
  reports that class with its real HTTP status (429 for rate limits, 503 for unavailability,
  502 otherwise) instead of the catch-all `all_providers_failed`.

### Added
- `MODEL_COOLDOWN_MS` / `MODEL_COOLDOWN_MAX_MS` plus `AI_TIMEOUT_MS`, `AI_RETRY_ATTEMPTS`,
  `AI_RETRY_BASE_MS`, `AI_RETRY_MAX_MS`, `AI_RETRY_BUDGET_MS`, `AI_RETRY_AFTER_CAP_MS` —
  every routing number is an operator-tunable Secret with a clamped range, and
  `ai.policy()` publishes them.
- `GET /api/ai/settings` → `cooling_models`, `cooling_note`, `retry_policy`;
  `POST /api/models/:row/wake` to shorten one model's wait without changing its settings.
- Settings: retry/cooldown policy sentence on the AI router card, a cooling banner, per-model
  **cooling ~Ns** / **recovered** tags with an explanation and a **Try now** button; the key
  field explains that a variable name is not a key.
- Tutor: failure headlines per error class ("Your provider refused the key", "The provider is
  busy right now", …), each with the provider's own words and a route to the fix.
- Suite section **I resilience** — 56 checks counting real outbound calls per model id:
  a 401 makes exactly one request; 403 ≠ 401; a 404 keeps `qwen/qwen3.8-omni-flash:free`
  verbatim; a 429 `Retry-After` is honoured within the cap and then answers; a 503 retries
  exactly three times, cools the model, falls back to the next eligible model, records the
  outage as `provider_unavailable` (never as a key problem) and hands the answer's
  provenance back; the window expiring by itself returns the cheapest model; with nothing
  left to try, one probe produces `models_temporarily_unavailable` with an ETA instead of an
  invented reply; `MODEL_COOLDOWN_MS` demonstrably sets the window. Total: **304/304**.

### Not verified
- A successful auth against a real provider (test A) and a live chat answer from the
  selected or fallback model (test I) need a valid key; none exists in this workspace. The
  failure half ran for real against `https://api.xkiro.com/v1`; the success half is covered
  only by the provider double. See
  [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md#verification-depth).

## 2026-11-03

### Added
- **Free Trial Provider** (`functions/lib/ai.mjs`, `dom/providers.mjs`, `dom/core.mjs`) —
  a platform-owned fallback configured entirely by Site Secrets, used only when a student
  has no usable BYOK model. Metered from the `ai_usage` ledger per day and per account,
  output-capped at 900 tokens, failures counted so retries cannot farm budget, vision
  refused without a vision model, and never needing or leaking `CREDENTIAL_KEY`.
- `GET /api/trial`; `trial` block on `/api/bootstrap` and `/api/ai/settings`.
- Settings → **Free Trial Provider** card: "Available now" / "Not switched on yet",
  requests left today, left on the account, which model answers, and a "How to get more
  AI" path. When unavailable it names the exact missing Secret and says plainly that this
  is the operator's setup, not the student's.
- Sidebar note is now three-way: BYOK summary → "Free Trial: X of Y AI requests left
  today" → "No AI provider connected yet".
- **Branding**: SchoolPlanner.pk in the document title, meta description, top bar pill,
  sidebar company block (with link) and boot state; "Powered by Future Innovations" in the
  sidebar footer. The StudyBridge AI product name is kept.
- **Local `.env` support** in `dev-tools/serve.mjs`, with `.env.example` documenting every
  Secret and a local-only `.env`; `.gitignore` keeps `.env` and generated `flat/` out.
- Suite section **H free trial** — 24 checks (unconfigured reporting, non-HTTPS rejection,
  trial answers with no BYOK, no key in any response, meter decrement, daily cap 429
  wording, BYOK priority, vision honesty, settings payload). Total: **212/212**.
- Settings → **About** card: what the product is, SchoolPlanner.pk and "Powered by
  Future Innovations" with the company link, which model will answer right now, how
  credits are earned, and where your data lives.
- `.gitignore` covering `.env`, generated `dev-tools/flat/` and OS noise.
- Seven documentation files: README, PROJECT_STRUCTURE, FEATURES, SETUP, DEPLOYMENT,
  KNOWN_LIMITATIONS, CHANGELOG.
- **Provider failure taxonomy** (`functions/lib/ai.mjs`): a provider reply is now classified
  from its HTTP status *and* its own error prose into `provider_auth_failed`,
  `provider_model_not_found`, `provider_access_denied`, `provider_rate_limited`,
  `provider_unreachable` or `provider_bad_request` / `provider_request_failed`, each with a
  plain-language message in `routes.mjs` telling the student what to do about it.
- **The provider's own words now reach the student**, redacted: `errorDetail` reads up to
  4000 bytes of the failure body, `redactDetail` replaces the literal key and any
  key-shaped token with `[redacted]`, and `describeFailure` renders
  `HTTP <status>: <detail>` in the Settings card, the tutor banner and the `last_error`
  column instead of a bare category code.
- **Model ids are stored byte-for-byte**: new `modelIdentifier()` in
  `functions/lib/util.mjs` accepts vendor-namespaced ids and suffixes
  (`qwen/qwen3.8-omni-flash:free`, `google/gemini-2.5-pro`) while `identifier()` stays
  strict for `provider_id`, which is used in paths. Rejects a `.`/`..` path segment, and no
  adapter interpolates an id into a URL unencoded.
- Settings → provider card keeps a **persistent "Last error" banner** with the reason and
  its timestamp, so the failure is still readable after the toast has faded or the page has
  reloaded.
- `testConnection` now means what it says: it reads the endpoint's `GET /models` list,
  compares the ids saved here against the provider's own catalogue, and then sends a
  **minimal completion to the exact saved model id** — `ok_with_models`, `ok`, `ok_empty`,
  `no_model`, `unreachable`, `auth_failed`, `model_not_found` or the classified
  `provider_*` code. It never probes a substitute model.
- Operator trace: `console.warn('studybridge provider failure [code] …')` for every
  non-`ok` provider status, with the status code and the redacted detail.
- `dev-tools/serve.mjs` makes **real outbound provider calls** by default, so a local
  "Connected" is the provider's answer and not a stub's; `LOCAL_AI_FAKE=1` restores the
  in-machine fake for offline work.
- Suite sections D and G gained 36 checks (namespaced id round-trip, exact wire format,
  catalogue membership, and the six failure classes with their redaction):
  **248/248 passed**.

### Fixed
- **Two copy claims that promised a fallback which does not exist.** The tutor header and
  its inline note said answers fall back to "a plain extract of your own scanned text"
  when no provider is connected — chat actually fails. Both now state the real routing
  (your providers → the platform trial with its live remaining count → no model, and the
  request stops with that message). The scanner's guidance was already accurate.
- The tutor's trial counter line went stale after a send: it is now repainted when the
  bootstrap refresh resolves, on success **and** on failure, because a failed trial call
  still spends budget. Verified live: 19 → 18 matching `GET /api/trial`.
- The failure banner's Settings call-to-action now also covers `trial_unavailable`,
  `trial_daily_limit`, `trial_total_limit`, `no_model_available` and `no_vision_model`.
- **Removed the only `innerHTML` sink in the app** (`h()`'s unused `html:` option), so the
  "no innerHTML surface" claim is now structurally true rather than a convention. No call
  site used it.
- `invalid_input` and `not_found` gained plain-language hints, so no route hands the
  student a raw snake_case code.
- **Page behind an open dialog still scrolled.** `overflow: hidden` on `body` does not
  stop the viewport, so the lock is now on the root element
  (`html.modal-open, html.modal-open body`), overscroll is blocked, and
  `html { scrollbar-gutter: stable }` stops the layout jumping when the scrollbar
  disappears. Verified in the browser: document scroll stays 0 while a dialog is open, the
  panel still scrolls internally, and teardown removes the class from both elements.
- **Dead-end deep links.** `#/spaces/does-not-exist` and `#/library/<malformed>` rendered
  a raw `invalid_input` code with a Retry that could never succeed. They now land on the
  "not found → All spaces / Back to library" card, and `invalid_input` / `not_found`
  gained plain-language hints server-side.
- **Test harness could make a broken trial look configured**: the default `envProvider`
  answered every Secret name with the same string. It now stubs `CREDENTIAL_KEY` only, and
  `trialConfig()` independently rejects a base URL that is not plain https.
- `dev-tools/_run.mjs` printed a misleading summary (`runAll()` returns the report, not a
  boolean). It now prints `SUITE: 212/212 passed`, excluding the doubled
  "(library within)" echoes.
- **`invalid_model` rejected every namespaced model id.** Connecting
  `qwen/qwen3.8-omni-flash:free` to a custom endpoint failed with a bare
  `{"error":"invalid_model"}` before the key was ever used: the shared `IDENT_RE` did not
  allow `/`, so a valid provider id was refused at validation and the student was told
  nothing. Model ids now go through `modelIdentifier()`, both failing paths return the
  grammar rule and an example, and the id reaches the wire unchanged — verified live with
  the exact reported model id, not a substitute. The displayed `Model Name` was never the
  outbound `model` field, and the request shape (URL, `Authorization: Bearer`, OpenAI chat
  body) was already correct.
- **Buttons stayed disabled forever after any failed request.** In an `async` click
  handler `event.currentTarget` is `null` once the `await` resumes, so every
  `catch (…) { event.currentTarget.disabled = false }` threw a second, invisible error:
  `Test connection`, `Fetch models`, `Add selected`, manual "Add model", provider
  "Save / rename", "Delete book" and Wallet "Show more entries" could each be killed by one
  failure and the real error toast was swallowed with it. Each now captures
  `const button = event.currentTarget` before the first await; the wallet button also
  reports its failure instead of mutely deadening. `event.target` reads in synchronous
  handlers are unaffected and were checked.

### Verified
- All 11 routes plus deep links render in the live preview with exactly one nav item
  highlighted, correct `document.title`, no error card and no console messages.
- Settings save round-trip through the real UI: language and explanation level persisted
  server-side, confirmation toast shown, button re-enabled.
- Scanner contents extraction from a PDF text layer: 8 chapter rows, tagged
  "read exactly from the PDF text", no provider configured and no charge.
- Dark and light dialogs are geometrically identical and correctly coloured.
- **No dead controls**: a static scan of every `h('button')` in `web/js` found three
  apparently handler-less buttons in `games.js`, all of which are wired by
  `addEventListener` further down; a DOM sweep of all 11 routes found no anchor without an
  `href` and no unlabelled button.
- **No secrets client-side**: `localStorage` holds only `studybridge.prefs` and
  `studybridge.theme`; `sessionStorage` is empty; no key-shaped string appears anywhere in
  `web/`, and the only outbound asset links in `index.html` are local files plus the
  SchoolPlanner.pk page link.
- Wallet claim path live: +30 BC written to the ledger, toast shown, button disabled so the
  same day cannot be claimed twice.
- The Free Trial with a working configuration but an unreachable upstream fails as
  `trial_unavailable` with the honest message, **and still consumes one request** —
  confirmed against `GET /api/trial` (used 2, remaining 18).
- **xKiro namespaced model id, live against the real endpoint**: `POST /api/providers` with
  `qwen/qwen3.8-omni-flash:free` now returns 201 and the row stores the id verbatim; the
  provider card shows it unchanged with only `key 0000` visible.
- **The exact configured model is the one put on the wire**: a recording spy on the outbound
  call captured `POST https://api.xkiro.com/v1/chat/completions` with
  `Authorization: Bearer <key>`, `content-type: application/json`, `model` equal to the
  saved id (not the display name), an array of `messages` and a numeric `max_tokens`.
- **"Connected" is only shown when the provider actually answers.** With the local
  placeholder key the button reports `auth_failed` and the card shows xKiro's own reply —
  `HTTP 401: Invalid or disabled ClientApiKey.` — which is also written to `last_error` and
  the operator log. No green state was fabricated.
- **Nothing sensitive leaves the backend**: the live page after a failed test has
  `keyLeak:false` (no `sk-` or `Bearer` string in the DOM), `localStorage` holds only
  `studybridge.theme` and `sessionStorage` is empty; the harness additionally asserts the
  literal key is absent from every provider failure response and that the log line shows
  `[redacted]`.
- **Re-enabled controls live**: after the failed test, `Test connection` is clickable again
  (previously dead until reload), the "Last error" banner is visible with a timestamp, and
  a manual "Add model" with a malformed id (`qwen qwen3.8-omni-flash:free`) shows the
  grammar hint and leaves the dialog open with the button usable.
- **Tutor end-to-end with the real endpoint**: one minimal chat request through the router
  failed as `all_providers_failed` and the banner read *"No configured provider answered:
  qwen/qwen3.8-omni-flash:free → Invalid or disabled ClientApiKey."* with an **Open Settings**
  link — the provider's own sentence, not a bare code. `Ask` re-enabled, no key-shaped
  string in the DOM.
- `SUITE: 248/248 passed` after the change (A 32, B 26, C 18, D 61, E 42, F 9, G 36, H 24);
  `js-syntax`, `js-imports` and `css-classes` clean.

## 2026-11-02

### Added
- Dark / light / **system** themes: token sets under `:root[data-theme]`, `color-scheme`,
  pre-paint script in `index.html` so there is no white flash, `matchMedia` listener for
  system changes, `meta[name=theme-color]` update, top-bar toggle, Settings segmented
  selector, and the choice stored on the server profile with a debounced local mirror.
  `dvh` units with `vh` fallbacks.
### Fixed
- Modal positioning: an author-level `display` rule was beating the UA
  `[hidden] { display: none }`, so hidden sheets stayed in the layout, and the bottom-sheet
  geometry let tall dialogs overflow. Dialogs are now viewport-centred grids with
  `max-height: calc(100dvh - 32px)`, internal scrolling, safe-area padding and
  `[hidden] { display: none !important }`.

## 2026-10-31 → 2026-11-01

### Added
- Full application: 11 screens, 76 endpoints, 25-table `app` schema, 8 server-validated
  games, ledger-backed Bridge Wallet with idempotent transactions, BYOK providers with
  AES-GCM encrypted keys (`key_hint` only in responses), SSRF-guarded base URLs, four-stage
  Smart Scanner with a free PDF text-layer path and a vision path, locally-built quizzes,
  focus sessions with a cross-route dock, streaks, daily question, achievements, progress
  charts, history deletion, and the validation harness (`js-syntax`, `js-imports`,
  `css-classes`, `sync-flat.sh`, sections A–G).
### Blocked
- `ensure_backend` returns `sites_quota_exceeded` (`backend_sites` used 0 / limit 0). The
  site remains unpublished by choice: a static shell without its Function is not the
  product.
