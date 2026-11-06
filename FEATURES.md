# Features

Thirteen screens, one hash route each, plus the platform Free Trial Provider and the
central AI gateway that sit behind the tutor and scanner. "Verified" below means how
the claim was established: **browser** = exercised in the live preview against the real
Function handlers, **suite** = one of the 619 checks in `dev-tools/cases.mjs`. A hash
that names no section gets its own honest page instead of being served the Dashboard it
did not ask for.

## 1. Dashboard `#/dashboard`
Today's date, greeting, credit and streak chips, continue-where-you-left-off cards,
the daily question, and the next best action. Reads `/api/bootstrap` (profile, wallet,
streak, daily, spaces, books, providers, totals, trial). No AI required.

## 2. My Spaces `#/spaces`, `#/spaces/:id`
One space per subject or exam. Seven tabs — Overview, Notes, Saved questions, Books,
Quizzes, History, Settings. Notes and questions are yours alone; linking a book scopes
the tutor's answers to your scanned pages. Deep links to a deleted or malformed id land
on a "Space not found → All spaces" card rather than a stuck Retry.

## 3. My Library `#/library`, `#/library/:id`
Book records with subject, author, publisher, edition and year; manual entry is always
available, `/api/lookup` can offer candidates. Per-chapter status (`To scan`, `Scanning`,
`Studying`, `Finished`), extracted page counts, linked spaces, delete with confirmation.

## 4. Smart Scanner `#/scanner` — four stages
1. **Cover** — photograph or PDF page 1, structured title/author/publisher/year guess.
2. **Contents** — chapter table. **PDFs with a text layer are read exactly from that
   layer: no model is called and nothing is charged** (verified in browser: 8 chapters,
   labelled "read exactly from the PDF text"). Photos go through a vision model.
3. **Chapter pages** — page text extraction into `app.pages`.
4. **Review & correct** — edit before saving; corrections are yours, not the model's.

Uploads are validated for type, extension, size and path traversal before storage, and
private documents are never forwarded to a newly connected provider without consent.

## 5. AI Tutor `#/tutor`
Chat scoped to a space, answering from your notes and scanned pages. Actions: explain,
detailed explanation, Urdu explanation, worked example, make a quiz, save as a question.
Answers render as structure through `textContent` — model HTML can never execute.

**Routing order is deliberate:** your own enabled providers first; the platform gateway's
verified free models next; the platform Free Trial only when you have none of those;
otherwise an honest `no_provider_configured` failure with a link to Settings. Repeated
identical questions hit `app.ai_cache` and cost nothing. Prompt-injection guardrails
and "answer only from the material provided, say when you cannot" instructions live in
`ai.buildSystem`.

**The price is shown before you submit.** The tutor header carries the live balance, the
cost of the action you are about to run and the display name of the model that will
answer. The cost comes from the server's catalogue (`functions/lib/economy.mjs`), never
from the browser, and an administrator can change it as a data edit. The request then
runs through the gateway's **reserve → settle** cycle: the credits are held before the
model is contacted and only finalised when a real answer arrives, so a failed
generation costs nothing.

| What the gateway did | What the student reads |
| --- | --- |
| every approved free model is unavailable | "StudyBridge AI is currently experiencing high demand. Your Bridge Credits have not been deducted. Please try again shortly." (`503 free_models_unavailable`) |
| the balance will not cover the price | `409 insufficient_credits` — the request never leaves the server, so the provider is never contacted |
| a router answered with a model that is not on the verified-free list | the answer is refused, the request fails, the reservation is refunded |
| the first free model failed | the second answers, and the tutor shows the **via fallback** tag naming the model that was skipped |
| the provider's own daily quota is spent | the provider is skipped for the rest of the day and no further request is sent to it |

**When a provider misbehaves** (`functions/lib/ai.mjs`):

| What the provider did | What StudyBridge does | What the student reads |
| --- | --- | --- |
| `401` / `407` — key refused | one request, no retry, no cooldown (a retry cannot fix a key) | "Your provider refused the key" + the provider's own words |
| `403` — key accepted, not entitled | one request, filed separately from a key problem | "Your key was accepted, but this account is not entitled…" |
| `404` — model id unknown | one request; the id is kept exactly as typed | the exact model id, never a silent substitute |
| `429` — rate limited | retried within the attempt budget, honouring `Retry-After` up to the cap | "You are sending questions faster than this provider allows" |
| `5xx` / `408` / no answer at all | limited retries with exponential backoff and jitter, then the next eligible model, then a cooldown on the failing one | "The provider is busy right now" with the expected wait |
| everything cooling at once | one recovery probe, then a stop | "…expected to be tried again in about N seconds" |
| the same question pressed again while that probe window is open | **nothing leaves the server** | "Not sent — paused to let the provider recover" + the seconds left (`provider_paused`) |
| one action fired twice, or four Stage-4 tools at once | the browser collapses the identical in-flight request, the Function collapses it again (including a pinned model), and past `AI_MAX_CONCURRENT` a question waits in that student's own queue | one answer per action; the provider sees one request, not a burst |
| a Gemini model id that cannot bind in the path | refused before it leaves, or filed as a model problem when the gateway says so | "That model name cannot be used with this endpoint" — never a suggestion that the key is bad |

Classification reads the HTTP status first and prose second, so a `503` whose body says
"high demand" can never be filed as an invalid key — the bug that made an outage look like
a credential problem. A fallback is always announced: the reply carries `retried`,
`fell_back` and `fell_back_from`, the tutor shows a **via fallback** tag naming the models
that were skipped, and `app.messages.sources` stores the same provenance so it survives a
reload. Failed calls are logged in `ai_usage` with their failure class, and the provider
card in Settings keeps the provider's real words (with anything key-shaped redacted) for
diagnosis.

Every count in that table is measured by the thing being called rather than asserted from
the code: the suite's provider double records each inbound request, and
`dev-tools/outbound-probe.mjs` does the same over a real socket. Five identical presses =
3 requests (one bounded retry chain) with at most one connection held; four different
questions at cap 1 = 4 requests served one at a time, at cap 4 = 12 requests with 4 held at
once; a `429` with `Retry-After: 2` = gaps of 2160 and 2132 ms plus one authenticated
account read, never one read per retry; and after a refusal, five further questions sent
**1** request (the gated probe) and answered four of them without touching the provider.

**The two Gemini wires are different, and both are real.** A Base URL under
`generativelanguage.googleapis.com/v1beta…` (with no `/openai/` in it) is saved as
`wire='gemini'` and spoken natively: the model goes in the URL path as
`/v1beta/models/<id>:generateContent`, the body carries only `contents` /
`systemInstruction` / `generationConfig`, and the key rides in `x-goog-api-key`, never an
`Authorization: Bearer`. Anything else is OpenAI-compatible chat. Because that path binds
exactly one name segment, two things a student can legitimately paste used to break it —
a model id copied from Google's own catalogue as `models/gemini-2.5-flash`, and a Base URL
of `…/v1beta/models` — and each produced the gateway's
`GenerateContentRequest.model: unexpected model name format`. They are normalised on the
way out only, never in the row: what was typed is what is stored, and repeated prefixes
collapse once rather than becoming `models/models/…`. "Fetch Available Models" strips that
prefix on the way in and drops any entry whose own `supportedGenerationMethods` says it
cannot chat, so the catalogue can no longer feed the bug back in, and availability comes only
from what that endpoint actually returned for this key. An id that still cannot bind is refused before it leaves
the server; one the gateway rejects is classified `provider_model_not_found` with Google's
own words, asked once, and never retried. **The catalogue is paged and the walk follows
`nextPageToken`**, because Google's own list answers one page of about 50 entries and
keeps the rest behind a token: reading only the first page is what made a perfectly valid
model look absent ("None of the 1 model id(s) saved here appear in this endpoint's list of
50"). A list that could only be read *partially* may never deny a model — the model is
asked directly instead, and the page says the list is partial rather than implying the
model does not exist. Section K holds 65 checks over these paths (K6 paged discovery,
K7 a partial catalogue, K8 the protocol re-inferred when the Base URL is edited), and
`dev-tools/gemini-config-audit.mjs` re-checks the whole saved configuration end to end
— what is stored, the literal request line, the discovery walk and the answer — against a
stub that enforces Google's binding, and
`dev-tools/gemini-path-probe.mjs` prints the literal request line a stub that enforces
Google's binding accepted.

## 6. Free Trial Provider
Platform-owned, server-side, finite, and honest about being unavailable.

| Secret | Purpose | Default |
| --- | --- | --- |
| `FREE_TRIAL_BASE_URL` | https endpoint, no port/query/credentials | unset → trial off |
| `FREE_TRIAL_API_KEY` | the platform key, never leaves the server | unset → trial off |
| `FREE_TRIAL_MODEL` / `FREE_TRIAL_MODEL_NAME` | text model + display name | unset → trial off |
| `FREE_TRIAL_VISION_MODEL` | optional photo-capable model | unset → photo tasks refuse |
| `FREE_TRIAL_WIRE` | `openai` or `gemini` | auto-detected for googleapis.com |
| `FREE_TRIAL_DAILY_LIMIT` | per student per UTC day | 20 |
| `FREE_TRIAL_TOTAL_LIMIT` | per student, lifetime | 200 |

Enforcement facts worth knowing:
- Counters come from the `ai_usage` ledger with `provider_key = 'free_trial'`, so
  clearing browser state, another tab or another device cannot restore budget.
- **Failed calls are counted** so retries cannot farm requests; cache hits are not.
- Output is capped at 900 tokens on the trial path (1800 for BYOK).
- The trial path never calls `codec.decrypt` and never needs `CREDENTIAL_KEY`.
- No response ever contains the key; the suite asserts this on every trial response.
- Surfaced three ways: Settings card ("Available now" / "Not switched on yet" plus
  remaining counts), the sidebar note ("Free Trial: X of Y AI requests left today"),
  and `GET /api/trial`. When the daily cap hits, the 429 says so and points at BYOK.
- If the Secrets are missing or malformed the card explains that it is the operator's
  setup, names the exact Secret, and a student is never blamed for it.

## The central AI gateway
Every AI request in the product — BYOK, gateway or Free Trial — is routed by one
backend module (`functions/lib/gateway.mjs`). The browser never holds a provider key,
never speaks to a provider, and never chooses a model.

**Free-only, and the check is the gate.** A model is selectable only when its verified
input price **and** output price are both exactly zero, the provider published it, it
is enabled by an administrator, and it is not cooling down. A model whose pricing could
not be read stays unverified and disabled, and `PATCH /api/admin/models/<row>` refuses
to enable it (`409 pricing_not_verified`). "Free" is never inferred from a model's
name — the price is read from the provider's own catalogue.

**What the gateway never does:** select a paid model, auto-upgrade to a paid provider,
generate a fake response, pretend a failed request succeeded, or ignore a provider's
rate limit. There is no switch that turns a paid fallback on.

**OpenRouter's free router is checked per answer.** `openrouter/free` is not priced
itself — it picks a model per request. So the gateway compares **the model the router
actually returned** against the verified-free list on every single answer. If that
model is not on the list, the answer is refused, the request fails with
`free_models_unavailable` and the reserved credits go back. A student is never charged
for a model whose price nobody checked.

**Adding a provider later needs no change to the tutor.** Register it, verify its
pricing, enable its verified free models, and the gateway routes to it when the first
one is unavailable. The provider's own `daily_quota` and the shared
`shared_daily_quota` bound how much it can be used; a model that failed is skipped for
the cooldown window and the next eligible model answers.

## StudyBridge Free AI

The platform's own centrally managed provider. A student needs no OpenRouter account,
no API key, no Gemini key and no provider setup of any kind.

| Secret | Purpose | Default |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | the platform's own OpenRouter key, stored encrypted on the server | unset → the central provider does not exist and the tutor says so |
| `OPENROUTER_PROVIDER_ID` | the provider row it provisions | `openrouter-central` |
| `OPENROUTER_NAME` | the display name in Admin | `OpenRouter` |
| `OPENROUTER_BASE_URL` | the API root, SSRF-checked | `https://openrouter.ai/api/v1` |
| `OPENROUTER_MODEL` | the routing model | `openrouter/free` |
| `OPENROUTER_ENABLED` | take the provider out of service without removing the key | `true` |
| `OPENROUTER_DAILY_QUOTA` | shared requests/day for all students | `0` (no cap) |

**It provisions itself.** The provider row, the routing model and the catalogue
verification are written idempotently on every request, so rotating the key takes
effect immediately and removing it takes the provider out of service again — no admin
step, no redeploy. The catalogue is re-read daily and sooner after a failed check,
because a catalogue is the evidence that a model's price is zero.

**The zero-price rule is the gate, not a preference.** A model is usable only when the
provider published exactly `0` for input **and** output. A model whose price is missing
or unreadable is recorded `pricing_verified: false`, is disabled and is never called; a
paid model is recorded `free_tier: false` and is disabled. No fallback can reach
either.

**Students see one thing in Settings**, not a form:

> **StudyBridge Free AI** — AI access is centrally managed by StudyBridge. You do not
> need to provide your own API key.

Only administrators manage provider credentials. The student's own key remains
available as a BYOK option for anyone who wants it.

**The daily allowance is server-side and race-free.** Each student may ask **10
successful questions per day**. The count lives in `app.ai_daily_slots` — one numbered
slot row per question, unique on `(owner_id, day, slot)` — so eleven simultaneous
clicks yield ten answers and one refusal, never eleven. A failed request releases its
slot, so it never consumes the allowance. A refresh, a logout or a new device changes
nothing.

**The day boundary is midnight in `Asia/Karachi`** (UTC+5, no DST). The backend decides
eligibility from stored UTC timestamps; the device clock is never trusted. Accumulated
credits survive the reset — only the allowance returns. Every screen that mentions the
limit shows the questions used, the questions remaining and the exact instant of the
next reset.

**The provider's own limits are a separate matter.** OpenRouter's quotas and rate
limits are not affected by StudyBridge's midnight reset, and the product never implies
otherwise. A spent shared platform quota shows exactly: *"StudyBridge AI is temporarily
busy. Please try again later."*

**The admin panel distinguishes configured from answering.** `GET /api/admin/overview`
returns the central provider's configuration status, key hint (last four characters),
the catalogue check time, the verified free models with their eligibility and
availability, the totals of successful / failed / rate-limited requests, token usage,
the shared quota status, the last successful request and the last error. No secret is
included, and a provider that is configured but has never answered is shown as exactly
that.

## 7. Focus Mode `#/focus`
Start a session (own length or the daily goal), live countdown with a persistent dock
on other screens, heartbeat writes, finish to bank minutes and credits. Break
suggestions respect `quick_break_suggestions`. Stale sessions are recoverable, and the
engine in `web/js/focus.js` is shared by the view and the dock so the two never disagree.

## 8. Game Center `#/games` — 8 games, always open, 0 BC
Math Rush, Number Puzzle, Equation Challenge, Mental Math Sprint, Pattern Recognition,
Quick Logic, Memory Challenge, Science Quiz — each with easy/normal/hard.
Scores are validated server-side against the challenge set issued at `/start`
(`functions/lib/games.mjs`), so a client cannot report a score it was never asked to
achieve. Repeat submissions are idempotent per `client_key`.

## 9. Daily Streaks `#/streak`
Consecutive-day tracking with `current`/`longest`, a 12-week activity heatmap and the
"broke on" date when a run ends. Gap logic in `rewards.mjs`: same day = no change, +1
day = increment, larger gap = restart at 1. A missed day is never charged back.

## 10. My Progress `#/progress`
Minutes, sessions, quizzes, accuracy, per-space breakdown and 30-day trend charts drawn
as inline SVG (`web/js/charts.js`). Aggregated from real ledger rows, never from
client-carried numbers.

## 11. Bridge Wallet `#/wallet`
Ledger-backed balance in **BC (Bridge Credits)**. Earning: daily login 30 BC, daily
question correct 10 BC, daily goal met 20 BC, daily challenge 15 BC, weekly challenge
50 BC, a seven-day streak 100 BC, a completed study session 15 BC, achievements by
definition. Spending (all optional): basic AI question 2 BC, concept explanation 2 BC,
problem-solving explanation 2 BC, short passage summary 4 BC, chapter summary 8 BC,
revision notes 6 BC, practice quiz generation 5 BC, advanced two-model comparison 10 BC,
plus the two legacy one-time packs (premium note pack 15 BC, deep-check quiz 12 BC).

**The balance is never a client input.** `applyDelta` reads the wallet row, checks
`balance >= amount` for spends, writes a transaction and the new balance together, and
de-duplicates on `(owner_id, reason)`, so a double click cannot earn or spend twice.
The balance change is a compare-and-set on the wallet row with a bounded retry, so two
requests landing at the same instant cannot produce a wrong balance — one wins the row
and the other retries against the new value. A ledger row that outlived a balance change
that never happened is deleted rather than left to contradict the wallet.

**Reserve → settle → refund.** An AI request holds its credits *before* the model is
contacted, settles only when a real answer arrives, and is refunded automatically when
the generation fails. A reservation that never took the credits is marked failed and is
never refunded — a student is not paid for a request that cost nothing. Repeating a
request with the same key replays the first outcome instead of spending again.

**Today's limits.** The Wallet view publishes the daily AI allowance next to the
balance: questions used today, questions remaining, the cap, and the exact instant of
the next reset (midnight `Asia/Karachi`). The daily login reward is 30 BC, claimable
once per Pakistan calendar day — claiming at 9 PM Monday means you can claim again
after 12 AM Tuesday.

## 12. Rewards Center `#/rewards`
Every reward, what it pays, how it is earned and whether it has been claimed today.
Claiming is a server-side action with a unique claim row per `(owner, reward, period)`,
so a repeat claim — including two claims fired at the same instant — pays once and the
second is a no-op that says so. The page reads the published catalogue and the limits
from the server, so an administrator's price or reward change appears without a
redeploy. Wallet and history live in the Bridge Wallet view; this view is about what is
*claimable* and what has been claimed.

## 13. Admin Dashboard `#/admin`
Visible only when the server says the signed-in owner has the `admin` role
(`app.user_roles`, bootstrapped from the `ADMIN_OWNER_IDS` Secret). A student who finds
the URL gets the same `403 admin_required` as one who never found it — the role check is
server-side, and the browser cannot ask for it.

| Section | What it shows and does |
| --- | --- |
| Economy analytics | total registered students, total BC earned, total BC spent, daily AI requests, successful generations, failed generations, credits refunded, average requests per student |
| AI Provider Management | add, edit and remove providers; Base URL and protocol; add and remove models; enable or disable a model; **Verify pricing**; **Test connection** |
| Provider monitoring | provider name, available models, free-pricing verification status, current health, rate-limit status, request count, failure count, last successful request, last error |
| Central AI (`openrouter-central`) | the platform-managed provider: whether a key is configured at all, how many free models passed the zero-price check, whether the router is enabled, the shared daily quota and how much of it is left, and the platform's own counters — successful generations, failed generations, rate-limited requests and tokens used |
| Economy controls | reward amounts, AI feature prices, daily request limits, provider quotas, enable/disable reward types, enable/disable individual free models |
| Roles | grant or revoke the administrator role |

Every figure is read back from recorded rows — nothing is estimated. A model whose zero
pricing was never verified **cannot be enabled**: `PATCH /api/admin/models/<row>`
answers `409 pricing_not_verified`. The platform provider's key is shown only as its
last four characters; the encrypted cipher never leaves the database, and the router
decrypts it for one outbound request and nothing else.

**Configured is not answering.** The central panel reports two different things and
never merges them: whether the provider is *configured* (a key is present, the
catalogue was read, N models verified free) and whether it is *answering* (a real
generation succeeded, when it last succeeded, and what it said when it last failed).
A provider with a valid key and zero successful requests reads "configured, never
answered" — never a green light.

## 14. Settings `#/settings`
Study profile (name, language, explanation level, daily goal, AI daily limit, break
suggestions) saved through an explicit "Save preferences" submit — verified in browser,
including the toast and the value read back from `/api/bootstrap`. Appearance
(light/dark/system). Reminders. Free Trial card.

**StudyBridge Free AI.** The AI section of Settings shows the central provider as a
first-class card, above the student's own providers, reading exactly:

> **StudyBridge Free AI** — AI access is centrally managed by StudyBridge. You do not
> need to provide your own API key.

The card reports what the server knows, never an optimistic guess: whether the central
provider is configured, which free models are available right now, how many of the
student's 10 daily questions remain, the BC balance, and the exact instant of the next
reset at 12:00 AM `Asia/Karachi`. A student needs no OpenRouter account, no API key
and no Gemini key to use the tutor. When the central provider is not configured, the
card says so plainly and points at the administrator — it does not fall back to a
student key, and it never shows a simulated answer.

Bring-your-own-key providers with
connection test, model list import, default selection and billing acknowledgement. A model
id is stored byte-for-byte as typed, including vendor prefixes and suffixes
(`qwen/qwen3.8-omni-flash:free`), and is the exact string put on the wire — never the
display name, never rewritten, never swapped for another model. **Test connection** reads
the endpoint's own model list, then sends a one-word completion to that saved id; it turns
green only when the model answers, and otherwise leaves the provider's real status and
words on the card under "Last error", where they survive a reload. **Check account
limits** sends one authenticated `GET <base>/usage` from the Function and shows the
provider's own figures — remaining tokens, per-minute caps, reset windows — stating
whether an allowance is spent or still there, and saying plainly when the provider
publishes nothing that answers the question — naming the fields its body did carry, so
"nothing published" is a reading rather than a shrug; it is read at most once every 5 minutes per
provider and the key never comes back to the browser. Because some gateways
(xKiro among them) publish their catalogue **without** a key, a 200 list alone never marks
a provider Connected: the probe asks the completion endpoint and reports `auth: accepted`
or `auth: rejected` separately from the model result, so "your key is refused" and "that id
is not here" stay different sentences. A saved key that looks like an environment variable
name, or arrives wrapped in `Bearer `/`x-api-key:`, gets a one-time `key_warning` on save
instead of being silently accepted. Model rows show **cooling ~Ns** while a temporary
failure keeps them out of rotation, with **Try now** (`POST /api/models/:row/wake`) to
shorten that wait; that control never disables, edits or deletes anything. The AI router
card prints the retry and cooldown policy actually in force, since every number is a Site
Secret.
AI router status. Usage and cost for the last 30 days. Data and privacy: clear one
space's history or delete all learning history behind a typed confirmation. About: what
the product is, who makes it (SchoolPlanner.pk, powered by Future Innovations), which
model will answer right now, how credits are earned, and where your data lives.

The `language` preference controls the language the **model answers in** (Urdu prompt in
`ai.buildSystem`); the interface chrome itself is English-only — see
[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## Cross-cutting
- **One gateway, one ledger**: every AI request in the product is priced from the
  server's catalogue, reserved before the model is contacted, settled on a real answer
  and refunded on a failure. No screen keeps its own price list and no request reaches
  a provider without a reservation.
- **Administrator access is server-side**: `app.user_roles` decides who may read
  `/api/admin/*`; the browser cannot grant itself a role, and the admin nav link is
  hidden when the server does not report the role. The role bootstrap is the
  `ADMIN_OWNER_IDS` Secret; after the first role exists it is managed in Admin → Roles.
- **Themes**: light, dark, system; pre-paint script avoids a white flash; persisted to
  the server profile and mirrored in `localStorage` for the first paint only.
- **Dialogs**: viewport-centred, `max-height: calc(100dvh - 32px)`, internal scroll,
  safe-area padding, and a real page-behind scroll lock (`html.modal-open`) that does
  not shift the layout because `scrollbar-gutter: stable` reserves the gutter.
- **Errors**: stable codes plus plain-language hints. A provider failure is additionally
  classified from its status, its machine-readable `error.type`/`error.code` and its own
  error text into `provider_auth_failed`, `provider_model_not_found`,
  `provider_access_denied`, `provider_rate_limited`, `provider_quota_exhausted`,
  `provider_unreachable` or `provider_bad_request`, and the student sees
  `HTTP <status>: <what the provider said>` plus the provider's `error.type`,
  `error.code`, the exact `Retry-After` (or that none was sent) and a request reference,
  so the message is actionable rather than a bare category. **A 429 is two different
  failures**: a per-minute or concurrency window (retried, with a wait of at least
  250 ms and the provider's `Retry-After` honoured) and a spent daily allowance (asked
  *once*, then parked for the whole cooldown ceiling — retrying cannot refill it). When a
  429's own words describe a server fault, the message says so instead of telling the
  student to slow down. The upstream body is never forwarded whole, and the API key —
  literal or in a `Bearer …` form — is redacted to `[redacted]` before it reaches the
  browser, the `last_error` column, or the operator log.
- **Accessibility**: skip link, `aria-current` on the active nav item, labelled
  controls, focus returned to `#main` after route changes, `role`/`aria-selected` tabs.
