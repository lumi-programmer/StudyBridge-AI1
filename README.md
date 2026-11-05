# StudyBridge AI

**by [SchoolPlanner.pk](https://schoolplanner.pk) · Powered by Future Innovations**

A full-stack AI study platform for students who cannot pay for an AI subscription.
Scan a textbook, keep notes per subject, ask the tutor questions answered from your
own pages, run focus sessions, play practice games, and earn Bridge Credits — with
an honest answer about what is free, what costs credits, and what needs a model key.

StudyBridge does not hide its dependencies. If no AI provider is connected and the
platform Free Trial is not switched on, every AI screen says so in plain words and
points at the fix, instead of showing a spinner or inventing an answer.

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
and the two-model comparison. Two ways to get them:

1. **Bring your own key (BYOK)** — Settings → AI Providers. Stored AES-GCM
   encrypted server-side, never returned to the browser, unlimited requests billed
   by your provider. Paste the model id exactly as your provider lists it, vendor
   prefix and `:free` suffix included — it is kept byte-for-byte and is the string
   sent on the wire. **Test connection** turns green only when that exact model
   answers a real one-word request; otherwise the card shows the provider's own
   status and words, with your key redacted.
2. **Free Trial Provider** — a platform-owned fallback the operator switches on with
   Site Secrets. Finite by design (default 20 requests/day, 200/account, enforced
   from the server-side usage ledger). It is used *only* while a student has no
   provider of their own; it never overrides or competes with BYOK.

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
./dev-tools/node.sh dev-tools/_run.mjs          # 441 behaviour checks, A–K
```

Last full run: **`SUITE: 441/441 passed`** (A 32, B 26, C 18, D 61, E 42, F 9, G 36, H 24, I 56, J 72, K 65).

## Documentation

| File | Read it for |
| --- | --- |
| [SETUP.md](SETUP.md) | Local run, `.env`, every Secret and what it does |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Qoder Sites publish flow, Site Secrets, schema migration, current blocker |
| [FEATURES.md](FEATURES.md) | Each of the 11 sections, what is wired end-to-end |
| [PROJECT_STRUCTURE.md](PROJECT_STRUCTURE.md) | Every file, the 26 database tables, the 76 endpoints |
| [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) | What is not done, not verified, or deliberately out of scope |
| [CHANGELOG.md](CHANGELOG.md) | What changed, by date |

## Status, stated plainly

The application is complete and verified **locally**. It is **not published**: the
hosting plan backing this workspace reports `sites_quota_exceeded` for backend sites
(limit 0), and shipping a static shell without its Function, database and storage
would be a prototype, not the product. Details and the resume steps are in
[DEPLOYMENT.md](DEPLOYMENT.md).

## Security in one paragraph

Student credentials never leave the server unencrypted and never appear in any
response (`key_hint` shows the last four characters only). The browser holds no API
keys and no secrets in `localStorage` — only UI preferences. Every query is filtered
by `owner_id` in the Function, which is where authorization lives. The Bridge Credit
balance is derived server-side from `app.transactions`; there is no request a client
can make to set it. Custom provider base URLs are validated for scheme, shape and
SSRF before use.
