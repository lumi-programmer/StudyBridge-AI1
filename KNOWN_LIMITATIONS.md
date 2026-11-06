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
4. **StudyBridge Free AI has never made a real request.** The central provider
   (`openrouter-central`, OpenRouter, `openrouter/free`) is fully implemented and every
   part of it is exercised — provisioning from the environment, the catalogue read, the
   zero-price gate, the free-only routing, the refund, the daily cap, the key's absence
   from every response — but **this workspace holds no `OPENROUTER_API_KEY`**, so no
   request has ever left the machine and no real answer has been produced. The integration
   is complete and ready; it needs one Secret and one live question. Until then the
   product says "StudyBridge Free AI is not connected on this server yet" and names the
   missing Secret rather than showing a fabricated answer. This is the single outstanding
   item on the Phase 2 acceptance list, and it is stated here rather than glossed over.
5. **The Free Trial is unproven against a live model.** Its configuration, limits,
   metering, refusal modes and key secrecy are covered by 24 checks with a mock upstream.
   Turning it on needs operator Site Secrets; until then Settings honestly says "Not
   switched on yet" and names the missing Secret.
6. **BYOK keys are only as safe as `CREDENTIAL_KEY`.** It is SHA-256'd into an AES-GCM
   key, so a short or shared secret is a weak secret. There is no envelope encryption and
   no key rotation tool: changing it makes stored provider keys undecryptable and each
   student must re-enter theirs.
7. **Trial metering counts failures.** A provider outage consumes the student's daily
   trial requests. That is the anti-farming trade-off, chosen deliberately; a BYOK user is
   unaffected.
8. **Photo work needs a vision model.** Without `FREE_TRIAL_VISION_MODEL` (or a BYOK model
   flagged `vision`), Scanner stages that need a photo answer with an explicit
   `no_vision_model` message. It never claims to have read an image it could not.
9. **The provider's own limits are outside our reset.** The 10-questions-per-day allowance
   and the midnight `Asia/Karachi` reset belong to StudyBridge. OpenRouter's quotas and
   rate limits are the provider's own and are not affected by them. StudyBridge never
   implies that a midnight reset restored the provider's allowance; the two are reported
   separately, and the shared platform quota shows "StudyBridge AI is temporarily busy.
   Please try again later." when it is spent.

## Text extraction

10. **There is no OCR engine.** Text comes from two sources: a PDF's existing text layer
   (exact, no model, 0 BC — this is what `probe-toc.pdf` exercises) and a vision model for
   photographs. A scanned-image PDF therefore yields no text and the Scanner says so.
11. **Vision output is unverified by design.** Cover and contents results are always shown
   for review and correction before saving, and the model is instructed not to guess a
   book from artwork. StudyBridge cannot confirm a chapter list against a real syllabus.

## Scope and data

12. **Interface language is English only.** The `language` profile setting changes the
    language the **model replies in** (Urdu instructions in `ai.buildSystem`); menu labels,
    buttons and help text are not translated.
13. **No data export.** You can clear one space's history or delete all learning history,
    but there is no "download everything as JSON" path.
14. **History deletion is scoped by design.** `/api/history` removes the topic log only;
    notes, questions, chats, books, scans, quizzes, sessions and credits remain, and
    credits already earned are never taken back.
15. **Reminders are in-app only.** `/api/reminders` derives lines like "claim today's
    +30 BC" from your own state. There is no push notification, e-mail or SMS delivery, and
    no background job of any kind — nothing runs when the tab is closed.
16. **No offline support.** No service worker, no manifest install path, no queue. Every
    action needs the network; the client does not fake a cached success.
17. **Ownership lives in the Function, not in Postgres RLS.** The `function_backend`
    model gives the Edge Function one database client, so every query carries an explicit
    `.eq('owner_id', user.id)` predicate and section F of the suite proves cross-owner reads
    and writes fail. The residual risk is real and worth naming: a single missed predicate
    in a future route is a data leak with no second enforcement layer underneath it.
18. **No content licensing.** StudyBridge works on what the student scans or types. It
    ships no textbook content and cannot fetch a publisher's chapter list.

## Games, quizzes, numbers

19. **Eight games, all logic/numeracy plus a general-science MCQ bank.** No curriculum
    mapping, no language or history games, and difficulty comes from parameterised
    templates in `functions/lib/games.mjs`, not from a syllabus.
20. **Local quiz builder is mechanical.** `buildLocalQuiz` derives questions from your
    scanned text (definitions, term/definition pairs, blanks) with no model. Coverage is
    what the text supports; it will not write an inference question a human tutor would.
21. **Cost figures are estimates.** `GET /api/usage` multiplies the per-model
    `input_micro_per_1k` / `output_micro_per_1k` values that a student (or the operator,
    for the trial) entered. Change a provider's price and the display follows; it is not a
    billing statement.
22. **Streaks and credits assume one account per student.** There is no device or family
    grouping, and multi-account farming of the daily rewards is not detected.

## Verification depth

23. **Responsive behaviour was measured, not device-tested.** The preview browser ran at
    roughly 510–598 × 538–553 CSS px with computed-style and geometry probes across all 11
    routes plus deep links. No real phone, tablet or desktop Chrome/Safari/Firefox run has
    been done, so platform-specific rendering (iOS safe areas in a real notch, Android
    back gesture, Safari's `dvh` handling) is unverified.
24. **Accessibility is structural.** Skip link, `aria-current` on the active nav, labelled
    controls, focus returned to `#main`, dialog roles and keyboard dismissal are in place
    and readable in the DOM, but no screen reader or keyboard-only pass has been run, and
    contrast pairs were chosen from tokens rather than measured against WCAG.
25. **Icons mix glyph characters and SVG.** Sidebar and card icons are Unicode glyphs, so
    their rendering depends on the font stack and platform; the one SVG asset is the
    favicon.
26. **The suite is a bespoke harness.** 619 assertions across 13 sections, run through a
    generated `dev-tools/flat/` copy of `functions/` because the local Node kernel resolves
    relative imports only one directory deep. It is thorough for this codebase but is not
    a standard test runner, has no coverage measurement, and forgetting
    `./dev-tools/sync-flat.sh` makes it test stale code.
27. **Section I counts real outbound requests, not intentions.** The retry/cooldown/
    fallback checks assert how many times each model id was called (`attempts`, the call
    log per model) and what the model row looked like afterwards, so "limited retries" and
    "no retry loop on a 401" are measurements rather than code reading. The cooldown in
    section G expires on wall-clock time (the harness pins `MODEL_COOLDOWN_MS=2000`), so
    automatic recovery is proven by waiting it out, not by rewriting the database.
28. **A *successful* live chat answer is still not on record.** The suite's provider
    doubles cover every routing decision, and a student's own key has now been seen working
    against `https://api.xkiro.com/v1` — the authenticated model catalogue returned 103 ids
    and `auth: accepted` — but the completion it asked for was refused (see 29), so no
    transcript of a real answer from a live endpoint is stored as proof. A genuine
    `401 · Invalid or disabled ClientApiKey` has been reproduced for real and classified as
    `provider_auth_failed`, one request, no cooldown, with the tutor refusing to invent an
    answer. Whether xKiro returns `503` under load can only be observed during an actual
    outage.
29. **The 429 is reproduced and localized, but the account's remaining allowance was never
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

30. **The browser side has no automated test runner.** Cases A–M drive the Function; the
    router, the thirteen views and every toast are checked by driving the real page in a
    browser and reading back both the DOM and the server's ledger. That found the stale
    wallet chip after a graded game round, a literal `null` line in the account panel and a
    "0" where 250 ms was promised — and it means a view fix is evidence from one observed
    run, not a regression suite that will re-check it on the next change.

31. **The repeated-failure storm is stopped; the provider itself is still not proven
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

32. **The Gemini 400 is fixed against a server that enforces Google's binding, not
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

33. **The saved Gemini configuration was audited, not re-typed.** The provider row is
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

## Central AI gateway and the credits economy

34. **The gateway's free-model policy has never met a live provider catalogue.** The
    rule — free only when the provider published exactly zero for input *and* output —
    is proven against a double that serves a catalogue in OpenRouter's shape, including
    the case where a router answers with a model that is not on the verified-free list
    (refused, refunded, nothing charged). What is **not** on record is a real
    `GET https://openrouter.ai/api/v1/models` read through the administrator's
    **Verify pricing** button: this workspace holds no OpenRouter key, so no catalogue
    was fetched and no live answer is claimed. The pricing reader accepts
    `pricing.prompt` / `pricing.completion` (or `pricing.input` / `pricing.output`) as
    strings or numbers and treats anything else as unverified — it does not parse a
    provider that publishes its prices in a different shape, and such a model stays
    disabled rather than being guessed free.

35. **The gateway answered its first real request only after a fix, and the fix is
    covered but the outage was real.** The platform provider's encrypted key was not
    being loaded into the routing candidate, so every platform answer died as
    `transport error` and the platform could never actually answer. The key is now
    loaded for the router only, and the public admin response still carries no cipher.
    The regression that caught it is section L; the lesson is that the failure mode was
    indistinguishable from "the provider is down".

36. **Administrator access rests on one Secret and one table.** `ADMIN_OWNER_IDS` grants
    the `admin` role the first time an owner is seen; after that, roles live in
    `app.user_roles` and are managed in Admin → Roles. There is no second factor, no
    audit trail of who granted a role, and no way to see the operator log — the grant
    records `granted_by`, but nothing reads it yet. A student cannot grant themselves a
    role (the suite proves `403 admin_required` on every admin route), and the browser
    cannot ask for one.

37. **The credit ledger has no explicit database transaction.** The platform's database
    client exposes no transaction API, so atomicity comes from unique constraints and
    compare-and-set updates on the wallet row with a bounded retry and jitter. It is
    correct against the constraints it has, but it is not the same guarantee a
    `BEGIN`/`COMMIT` pair would give: the balance change and the ledger row are two
    writes, and a crash between them would leave one without the other. The code
    repairs the direction that matters — a ledger row that outlived a balance change is
    deleted — but the other direction (a balance change without its row) is repaired
    only by the next read of the wallet.

38. **The economy controls are per-deployment data, not per-plan.** Prices, reward
    amounts and limits live in `app.economy_settings` and `app.ai_usage_limits` and take
    effect on the next request. There is no versioning: an administrator changing a
    price mid-flight changes it for the request that has not started yet, and there is
    no record of the previous price beyond the ledger rows that already carry it.

## StudyBridge Free AI

39. **The central provider has never answered a real question.** This is the honest
    headline of the Phase 2 work. The provider, the zero-price gate, the free-only
    routing, the daily cap, the midnight reset, the refund and the key's absence from
    every response are all implemented and all exercised — but the suite drives them
    against a provider double, and this workspace holds no `OPENROUTER_API_KEY`, so no
    request has ever left the machine. Nothing here claims a live generation succeeded.
40. **Free models on OpenRouter are a moving target.** The catalogue is re-read daily
    (and sooner after a failed check) precisely because a model's price can change
    between one day and the next. A model that was free yesterday and is priced today
    is re-verified before it is used — but a catalogue that OpenRouter itself reports
    incorrectly would be believed, because the platform publishes it. There is no second
    price source to cross-check against.
41. **The daily cap counts successful questions, and the server decides what a
    "successful question" is.** A request that returns a valid, non-empty answer
    consumes one of the ten. A request that fails does not — but the student still paid
    nothing for it and got no answer, so the cost of the failure is StudyBridge's, not
    the provider's. The concurrency limit (one in-flight AI request per student) means a
    student with two tabs open waits for the first answer rather than running both.
42. **The allowance is a per-account cap, not an identity cap.** A student who creates
    a second account gets a second allowance and a second daily login reward. The
    platform cannot verify that two accounts are the same person without an identity
    provider, and adding one was outside this scope.

## Deliberate non-goals

- No fake or demo data presented as real; nothing is seeded into a student's account.
- No "coming soon" buttons: if a capability needs a key the platform does not have, the
  control either is not shown or explains itself.
- No unlimited-free-AI promise. The trial is finite, metered server-side, and says so.
