# StudyBridge AI

**by [SchoolPlanner.pk](https://schoolplanner.pk) · Powered by Future Innovations**

A full-stack AI study platform for students who cannot pay for an AI subscription.
Scan a textbook, keep notes per subject, ask the tutor questions answered from your
own pages, run focus sessions, play practice games, and earn Bridge Credits — with
an honest answer about what is free, what costs credits, and what needs a model key.

StudyBridge does not hide its dependencies. If no AI provider is connected, no
platform provider is registered, and the platform Free Trial is not switched on,
every AI screen says so in plain words and points at the fix, instead of showing
a spinner or inventing an answer.

Every AI request in the product goes through one backend gateway
(`functions/lib/gateway.mjs`). The browser never holds a provider key, never
talks to a provider, and never chooses a model. The gateway answers only with a
model whose **verified** input and output pricing is exactly zero — a model is
disabled until somebody checked what it costs.

## StudyBridge Free AI

Students do not need an OpenRouter account, an API key, a Gemini key, or any
provider setup at all. The platform holds one key of its own
(`OPENROUTER_API_KEY`, server-side only) and provisions a central provider from
it — `openrouter-central`, base `https://openrouter.ai/api/v1`, routing through
`openrouter/free`. Settings shows this to students as **StudyBridge Free AI**
with one sentence: *"AI access is centrally managed by StudyBridge. You do not
need to provide your own API key."*

Before anything is routed, the central provider's own catalogue is read and each
model's published input **and** output price must be exactly `$0`. A model whose
price is unknown or unverified is recorded as unusable and is never called, and a
paid model is never selected — not as a first choice, and not as a fallback. The
model a router actually picked is checked against that verified list on every
answer, so a router that names an unverified model has its answer refused and
the student is not charged.

Only administrators manage provider credentials.

---

## What works with no AI provider at all

Nothing here needs a key, and nothing charges credits (0 BC):

- Spaces, notes, saved questions, book library, chapter status
- Scanner contents extraction read straight from a PDF text layer (no model, 0 BC)
- Manual book entry and chapter status editing
- Quizzes built locally from text you already scanned (`functions/lib/quiz.mjs`)
- Focus Mode sessions, heartbeat, streaks, daily question, achievements
- All 8 Game Center practice games, server-validated scores
- Progress analytics, Bridge Wallet ledger, Settings, theme, deletion tools

## What needs a model

Tutor chat, photo-based extraction, advanced explanations, AI quiz generation,
and the two-model comparison. Three ways to get them:

1. **StudyBridge Free AI (central, default)** — the platform's own key, used
   automatically for every student who has not set up a key of their own. No
   account, no key, no model choice for the student. See above.
2. **Bring your own key (BYOK)** — Settings → AI Providers. Stored AES-GCM
   encrypted server-side, never returned to the browser, unlimited requests billed
   by your provider. Paste the model id exactly as your provider lists it, vendor
   prefix and `:free` suffix included — it is kept byte-for-byte and is the string
   sent on the wire. **Test connection** turns green only when that exact model
   answers a real one-word request; otherwise the card shows the provider's own
   status and words, with your key redacted.
3. **The platform gateway (administrator-registered providers)** — an administrator
   registers a provider in Admin → AI Providers, runs **Verify pricing** against
   the provider's own catalogue, and enables only the models the check confirmed at
   zero on both input and output. Those models then answer for every student who has
   no key of their own. A model whose pricing could not be verified stays disabled
   and cannot be switched on.
4. **Free Trial Provider** — a platform-owned fallback the operator switches on with
   Site Secrets. Finite by design (default 20 requests/day, 200/account, enforced
   from the server-side usage ledger). It is used *only* while a student has no
   provider of their own; it never overrides or competes with BYOK.

There is no paid fallback. The gateway cannot select a model it has not verified
as free, cannot auto-upgrade to a paid provider, and cannot fabricate an answer:
if every approved free model is unavailable the student is told so plainly and
the reserved credits are returned.

## Daily limits and the midnight reset

- **10 successful AI questions per student per day.** The count is enforced
  server-side against numbered slot rows, so a refresh, a logout, a new device or
  eleven simultaneous clicks cannot raise it. A failed request releases its slot
  and keeps the allowance; a request refused for insufficient credits never
  consumes one.
- **The day boundary is midnight in `Asia/Karachi` (UTC+5), not a rolling
  24-hour window.** The backend decides eligibility from stored UTC timestamps;
  the device clock is never trusted. Accumulated credits survive the reset — only
  the daily allowance returns.
- Every screen that mentions the limit shows the questions used, the questions
  remaining and the exact instant of the next reset.

The central provider's own quotas and rate limits are **independent** of this
reset. A midnight reset on StudyBridge does not restore the provider's allowance,
and the product never says that it does.

## The Bridge Credits economy

**BC (Bridge Credits)** are the product's own currency, and they are a server-side
ledger — never a number the browser can change.

- **Earning:** daily login 30 BC, daily learning question 10 BC, completing a
  study session 15 BC, reaching the daily goal 20 BC, the daily challenge 15 BC,
  a seven-day streak 100 BC, the weekly learning goal 50 BC. Each reward is
  claimed once per period; a repeat claim is a no-op, and two simultaneous
  claims still pay once (the claim row is unique). The daily login pays **30 BC
  once per Pakistan calendar day**.
- **Spending:** basic AI question 2 BC, concept explanation 2 BC, problem-solving
  explanation 2 BC, short passage summary 4 BC, chapter summary 8 BC, revision
  notes 6 BC, practice quiz generation 5 BC, two-model advanced check 10 BC. The
  price is shown **before** the student submits.
- **Never a double charge:** the price is reserved first, the request runs, and
  the reservation is settled only on a real answer. A failed generation is
  refunded automatically. A repeat of the same request key replays the first
  outcome instead of spending again.

The Rewards Center (`#/rewards`) shows what is claimable and what was claimed today;
the Bridge Wallet (`#/wallet`) shows the balance and the full ledger; the Admin
dashboard (`#/admin`) shows the economy totals, the provider health and the controls.

## Run it locally

```sh
PORT=4317 ./dev-tools/node.sh dev-tools/serve.mjs
```

That serves `web/` and routes `/functions/v1/app/*` into the real Edge Function code
against an in-memory database, so the browser exercises actual handlers. See
[SETUP.md](SETUP.md).

## Verify it

```sh
./dev-tools/node.sh dev-tools/js-syntax.mjs     # every source file parses
./dev-tools/node.sh dev-tools/js-imports.mjs    # every import resolves
./dev-tools/node.sh dev-tools/css-classes.mjs   # no class used without a rule
./dev-tools/sync-flat.sh                        # refresh the harness copy of functions/
./dev-tools/node.sh dev-tools/_run.mjs          # 619 behaviour checks, A–M
```

Last full run: **`SUITE: 619/619 passed`** (A 32, B 26, C 18, D 61, E 42, F 9, G 36, H 24, I 56, J 72, K 65, L 114, M 64).

Section **L** is the acceptance suite for the gateway and the credits economy:
it drives a real administrator through the admin API, verifies a provider's own
catalogue, and then asks real questions as a student — asserting the wallet rows,
the ledger rows and the outbound requests themselves, never a mock response.

Section **M** is the acceptance suite for the central AI system: the central
provider comes up from the environment alone, a real question is answered and
charged exactly 2 BC, a failed request costs 0 BC and keeps the allowance, the
daily login pays 30 BC once per Pakistan day, the tenth question is allowed and
the eleventh is refused, midnight `Asia/Karachi` resets the allowance while
credits survive, the balance cannot be moved from the browser, one student cannot
see another's wallet, no paid model is ever called, an unknown-price model is
refused, a rate limit is handled without charging, the provider key never reaches
the browser, and eleven concurrent requests cannot pass the cap or double-charge.

## Documentation

| File | Read it for |
| --- | --- |
| [SETUP.md](SETUP.md) | Local run, `.env`, every Secret and what it does |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Qoder Sites publish flow, Site Secrets, schema migration, current blocker |
| [FEATURES.md](FEATURES.md) | Each of the 13 sections, what is wired end-to-end |
| [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) | Every file, the 33 database tables, the 97 endpoints |
| [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) | What is not done, not verified, or deliberately out of scope |
| [CHANGELOG.md](CHANGELOG.md) | What changed, by date |

## Status, stated plainly

The application is complete and verified **locally**. It is **not published**: the
hosting plan backing this workspace reports `sites_quota_exceeded` for backend sites
(limit 0), and shipping a static shell without its Function, database and storage
would be a prototype, not the product. Details and the resume steps are in
[DEPLOYMENT.md](DEPLOYMENT.md).

**No live AI generation has been performed.** The central provider is fully
implemented and every path in it is exercised by the test suite against a
provider double, but this workspace has no `OPENROUTER_API_KEY`, so no request
has ever reached OpenRouter and no real answer has been produced. The integration
is complete and ready; it needs one Secret and one live question to confirm
end-to-end. See [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## Security in one paragraph

Student credentials never leave the server unencrypted and never appear in any
response (`key_hint` shows the last four characters only). The browser holds no API
keys and no secrets in `localStorage` — only UI preferences. Every query is filtered
by `owner_id` in the Function, which is where authorization lives. The Bridge Credit
balance is derived server-side from `app.transactions`; there is no request a client
can make to set it. Custom provider base URLs are validated for scheme, shape and
SSRF before use. The administrator sections are behind a server-side role check
(`app.user_roles`), so a student who finds the URL gets the same 403 as one who never
found it, and the platform provider's encrypted key is decrypted for one outbound
request and is never serialized into a response.
