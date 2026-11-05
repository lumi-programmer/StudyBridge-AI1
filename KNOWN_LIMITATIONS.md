# Known limitations

Written so nobody has to guess what is real. "Unverified" is not "working".

## Delivery

1. **The site is not published.** The hosting plan behind this workspace reports
   `sites_quota_exceeded` for backend sites (used 0, limit 0), so the database, Edge
   Function and storage capabilities cannot be provisioned. Everything is verified
   against the real handlers running locally on an in-memory data layer. Uploading only
   `web/` would produce an app whose every button reaches for a Function that is not
   there — that is a prototype, and it was not shipped.
2. **No deployed end-to-end run exists yet.** The checklist in
   [DEPLOYMENT.md](DEPLOYMENT.md#live-verification-after-publication) is the work that
   remains after the quota is resolved.

## AI

3. **No live provider has ever returned a successful completion to this build.** The local
   preview now makes real outbound calls (`dev-tools/serve.mjs`, unless `LOCAL_AI_FAKE=1`),
   and the xKiro path has been exercised for real: its `GET /v1/models` list was read, the
   namespaced id `qwen/qwen3.8-omni-flash:free` was put on the wire verbatim to
   `POST /v1/chat/completions` with `Authorization: Bearer …`, and the provider's own
   rejection came back and was surfaced — `auth_failed · HTTP 401: Invalid or disabled
   ClientApiKey.` That 401 is now known to come from **xKiro's gateway**, not from this
   app: the string appears nowhere in the StudyBridge source, and the same endpoint answers
   `GET /v1/models` with a 200 catalogue **without any credentials**, which is exactly why
   a public model list is no longer accepted as proof that a key works. What remains
   unobserved is a **green** connection, because no valid key
   for any provider exists in this workspace, and live Gemini/Anthropic-format responses.
   Everything else — request shapes, headers, the six failure classes, token accounting and
   ledger writes — is covered by the harness's mocked fetch, which asserts the exact body
   and URL rather than trusting the transport.
4. **The Free Trial is unproven against a live model.** Its configuration, limits,
   metering, refusal modes and key secrecy are covered by 24 checks with a mock upstream.
   Turning it on needs operator Site Secrets; until then Settings honestly says "Not
   switched on yet" and names the missing Secret.
5. **BYOK keys are only as safe as `CREDENTIAL_KEY`.** It is SHA-256'd into an AES-GCM
   key, so a short or shared secret is a weak secret. There is no envelope encryption and
   no key rotation tool: changing it makes stored provider keys undecryptable and each
   student must re-enter theirs.
6. **Trial metering counts failures.** A provider outage consumes the student's daily
   trial requests. That is the anti-farming trade-off, chosen deliberately; a BYOK user is
   unaffected.
7. **Photo work needs a vision model.** Without `FREE_TRIAL_VISION_MODEL` (or a BYOK model
   flagged `vision`), Scanner stages that need a photo answer with an explicit
   `no_vision_model` message. It never claims to have read an image it could not.

## Text extraction

8. **There is no OCR engine.** Text comes from two sources: a PDF's existing text layer
   (exact, no model, 0 BC — this is what `probe-toc.pdf` exercises) and a vision model for
   photographs. A scanned-image PDF therefore yields no text and the Scanner says so.
9. **Vision output is unverified by design.** Cover and contents results are always shown
   for review and correction before saving, and the model is instructed not to guess a
   book from artwork. StudyBridge cannot confirm a chapter list against a real syllabus.

## Scope and data

10. **Interface language is English only.** The `language` profile setting changes the
    language the **model replies in** (Urdu instructions in `ai.buildSystem`); menu labels,
    buttons and help text are not translated.
11. **No data export.** You can clear one space's history or delete all learning history,
    but there is no "download everything as JSON" path.
12. **History deletion is scoped by design.** `/api/history` removes the topic log only;
    notes, questions, chats, books, scans, quizzes, sessions and credits remain, and
    credits already earned are never taken back.
13. **Reminders are in-app only.** `/api/reminders` derives lines like "claim today's
    +30 BC" from your own state. There is no push notification, e-mail or SMS delivery, and
    no background job of any kind — nothing runs when the tab is closed.
14. **No offline support.** No service worker, no manifest install path, no queue. Every
    action needs the network; the client does not fake a cached success.
15. **Ownership lives in the Function, not in Postgres RLS.** The `function_backend`
    model gives the Edge Function one database client, so every query carries an explicit
    `.eq('owner_id', user.id)` predicate and section F of the suite proves cross-owner reads
    and writes fail. The residual risk is real and worth naming: a single missed predicate
    in a future route is a data leak with no second enforcement layer underneath it.
16. **No content licensing.** StudyBridge works on what the student scans or types. It
    ships no textbook content and cannot fetch a publisher's chapter list.

## Games, quizzes, numbers

17. **Eight games, all logic/numeracy plus a general-science MCQ bank.** No curriculum
    mapping, no language or history games, and difficulty comes from parameterised
    templates in `functions/lib/games.mjs`, not from a syllabus.
18. **Local quiz builder is mechanical.** `buildLocalQuiz` derives questions from your
    scanned text (definitions, term/definition pairs, blanks) with no model. Coverage is
    what the text supports; it will not write an inference question a human tutor would.
19. **Cost figures are estimates.** `GET /api/usage` multiplies the per-model
    `input_micro_per_1k` / `output_micro_per_1k` values that a student (or the operator,
    for the trial) entered. Change a provider's price and the display follows; it is not a
    billing statement.
20. **Streaks and credits assume one account per student.** There is no device or family
    grouping, and multi-account farming of the daily rewards is not detected.

## Verification depth

21. **Responsive behaviour was measured, not device-tested.** The preview browser ran at
    roughly 510–598 × 538–553 CSS px with computed-style and geometry probes across all 11
    routes plus deep links. No real phone, tablet or desktop Chrome/Safari/Firefox run has
    been done, so platform-specific rendering (iOS safe areas in a real notch, Android
    back gesture, Safari's `dvh` handling) is unverified.
22. **Accessibility is structural.** Skip link, `aria-current` on the active nav, labelled
    controls, focus returned to `#main`, dialog roles and keyboard dismissal are in place
    and readable in the DOM, but no screen reader or keyboard-only pass has been run, and
    contrast pairs were chosen from tokens rather than measured against WCAG.
23. **Icons mix glyph characters and SVG.** Sidebar and card icons are Unicode glyphs, so
    their rendering depends on the font stack and platform; the one SVG asset is the
    favicon.
24. **The suite is a bespoke harness.** 441 assertions across 11 sections, run through a
    generated `dev-tools/flat/` copy of `functions/` because the local Node kernel resolves
    relative imports only one directory deep. It is thorough for this codebase but is not
    a standard test runner, has no coverage measurement, and forgetting
    `./dev-tools/sync-flat.sh` makes it test stale code.
25. **Section I counts real outbound requests, not intentions.** The retry/cooldown/
    fallback checks assert how many times each model id was called (`attempts`, the call
    log per model) and what the model row looked like afterwards, so "limited retries" and
    "no retry loop on a 401" are measurements rather than code reading. The cooldown in
    section G expires on wall-clock time (the harness pins `MODEL_COOLDOWN_MS=2000`), so
    automatic recovery is proven by waiting it out, not by rewriting the database.
26. **A *successful* live chat answer is still not on record.** The suite's provider
    doubles cover every routing decision, and a student's own key has now been seen working
    against `https://api.xkiro.com/v1` — the authenticated model catalogue returned 103 ids
    and `auth: accepted` — but the completion it asked for was refused (see 27), so no
    transcript of a real answer from a live endpoint is stored as proof. A genuine
    `401 · Invalid or disabled ClientApiKey` has been reproduced for real and classified as
    `provider_auth_failed`, one request, no cooldown, with the tutor refusing to invent an
    answer. Whether xKiro returns `503` under load can only be observed during an actual
    outage.
27. **The 429 is reproduced and localized, but the account's remaining allowance was never
    read.** Measured against `https://api.xkiro.com/v1` with the student's own stored key,
    through the app's one-request paths: the key is accepted, `qwen/qwen3.8-max:free` is
    published as `access_tier: free` with pricing 0/0, and a single minimal completion is
    refused in ~250 ms with `HTTP 429 · A server error occurred. Please try again.` and **no
    `Retry-After` and no `x-ratelimit-*` header** — while an identical attempt 80 s earlier
    hung instead of answering. Five completions across 35 minutes, each refused on the first
    attempt, so the volume that would explain a per-minute throttle was never sent. Whether
    that 429 is a busy free pool, a per-minute window, or today's tokens is *not* knowable
    from what the gateway will say: `GET /v1/usage` needs the working key, and the preview
    keeps providers in memory, so the process that holds this key predates the code that
    reads that endpoint. Section J proves the router handles every case correctly against a
    double that plays each one, and the read path itself was verified live (real endpoint,
    real diagnostics envelope, real cf-ray reference, key redacted, 401 stated honestly). The
    real figures are one press of **Check account limits** away, on a preview that runs the
    current code with the key pasted into it once.

28. **The browser side has no automated test runner.** Cases A–K drive the Function; the
    router, the eleven views and every toast are checked by driving the real page in a
    browser and reading back both the DOM and the server's ledger. That found the stale
    wallet chip after a graded game round, a literal `null` line in the account panel and a
    "0" where 250 ms was promised — and it means a view fix is evidence from one observed
    run, not a regression suite that will re-check it on the next change.

29. **The repeated-failure storm is stopped; the provider itself is still not proven
    working.** What is measured and green: five identical presses produce one retry chain
    (3 requests, peak 1 connection), the pinned-model path is deduped too, four different
    questions at `AI_MAX_CONCURRENT=1` are served one at a time, a `429` with
    `Retry-After: 2` is honoured with 2.1 s gaps plus at most one account read, and after a
    refusal the following questions cost exactly one gated probe and then **zero** requests
    while the window is open — with `provider_paused` rendered in the live browser as
    "StudyBridge is sending nothing to … for about 45 more seconds". All of that was
    counted by the endpoint at the far end of a socket (a local `node:http` stub) or by a
    host that does not resolve, never by the caller. What is **not** on record: a real
    completion from xKiro. The gateway is reachable and the stored key was accepted by
    `/v1/models`, but no `chat/completions` call through StudyBridge has returned a model's
    text, so the integration is not claimed fixed. Reading the account's own figures still
    needs the key pasted once into a preview that runs this code and one press of **Check
    account limits**, and whether the refusals are per-model or account-wide cannot be
    settled from outside that account. Publishing to check any of this on the deployed site
    is still blocked by the backend quota in item 1.

30. **The Gemini 400 is fixed against a server that enforces Google's binding, not
    against Google.** The root cause was reproduced and the fix was measured: a local
    `node:http` endpoint that rejects any path other than
    `/v1beta/models/{model}:generateContent`, any body carrying a `model` field, or a
    request without `x-goog-api-key` now answers the Class 10 Newton question with HTTP
    200 and `usageMetadata` for five different saved shapes (bare id, `models/` id, base
    ending in `/models`, trailing slash, all at once), and section K keeps it as 65
    regression checks. What is **not** on record is a real HTTP 200 from
    `generativelanguage.googleapis.com`: this environment holds no Gemini key, so nothing
    was sent to Google and no live answer is claimed. `dev-tools/gemini-live-check.mjs` is
    the no-mock script for that — run it with the student's own key, and it prints what
    Google's own `/v1beta/models` lists, the literal outbound path, the body fields, the
    status, the reply and the token counts.

31. **The saved Gemini configuration was audited, not re-typed.** The provider row is
    stored exactly as the Setup screen records it — API Name `Google Gemini`, Provider ID
    `google-gemini`, Base URL `https://generativelanguage.googleapis.com/v1beta`, Model ID
    `gemini-3.8-flash`, display name `Gemini 3.8 Flash` — and `dev-tools/gemini-config-audit.mjs`
    re-checks all 30 of those facts against the running Function. Three findings came out of
    it. The Provider ID is free text (`provider_key`, unique per owner; only `free_trial` is
    special) and there is no id-to-protocol registry, so `google-gemini` must **not** be
    renamed; the protocol is inferred from the Base URL, and it is now re-inferred when the
    Base URL is edited, because the stored protocol used to be a snapshot of the address at
    save time. And the discovery complaint ("None of the 1 model id(s) saved here appear in
    this endpoint's list of 50") was not a wrong model id at all: Google's catalogue is
    paged, one page of ~50 entries per `nextPageToken`, and the app read only the first
    page. Discovery now follows the token, and a catalogue that could only be read *partly*
    may never deny a model — the model is asked directly instead. Still not on record: the
    student's live row and key live in a database this environment cannot reach
    (`sites_database_not_ready`), so the audit ran against a freshly saved provider with
    the same values, not against the deployed one.

## Deliberate non-goals

- No fake or demo data presented as real; nothing is seeded into a student's account.
- No "coming soon" buttons: if a capability needs a key the platform does not have, the
  control either is not shown or explains itself.
- No unlimited-free-AI promise. The trial is finite, metered server-side, and says so.
