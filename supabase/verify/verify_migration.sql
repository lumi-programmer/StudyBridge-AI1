-- StudyBridge AI — migration verification.
--
-- Run this in the Supabase SQL editor AFTER applying the four migrations and
-- BEFORE the app is pointed at the project. Sections 1-10 are read-only and
-- assert the migrated shape mechanically. Section 11 is a transactional smoke
-- test of the Bridge Credits RPCs: it is wrapped in BEGIN ... ROLLBACK, so it
-- changes nothing and leaves no rows behind. Section 12 simulates an
-- authenticated attacker through a PL/pgSQL DO block that CATCHES the
-- expected permission-denied exception (SQLSTATE 42501) and reports each
-- probe and the summary as NOTICE messages — a bare unauthorised query aborts
-- the editor batch with the very error it expects. If any check reports a
-- mismatch, do not proceed: see supabase/rollback/rollback_all.sql.
--
-- Expected results are stated in comments beside each statement.

-- ---------------------------------------------------------------------------
-- 1. All 34 tables exist in schema "app"
-- ---------------------------------------------------------------------------
SELECT count(*) AS tables_in_app          -- expect 34
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'app' AND c.relkind = 'r';

SELECT to_regclass('app.profiles')          IS NOT NULL AS profiles,
       to_regclass('app.spaces')            IS NOT NULL AS spaces,
       to_regclass('app.messages')          IS NOT NULL AS messages,
       to_regclass('app.notes')             IS NOT NULL AS notes,
       to_regclass('app.saved_questions')   IS NOT NULL AS saved_questions,
       to_regclass('app.books')             IS NOT NULL AS books,
       to_regclass('app.book_links')        IS NOT NULL AS book_links,
       to_regclass('app.chapters')          IS NOT NULL AS chapters,
       to_regclass('app.pages')             IS NOT NULL AS pages,
       to_regclass('app.documents')         IS NOT NULL AS documents,
       to_regclass('app.quizzes')           IS NOT NULL AS quizzes,
       to_regclass('app.quiz_results')      IS NOT NULL AS quiz_results,
       to_regclass('app.study_sessions')    IS NOT NULL AS study_sessions,
       to_regclass('app.learning_history')  IS NOT NULL AS learning_history,
       to_regclass('app.providers')         IS NOT NULL AS providers,
       to_regclass('app.models')            IS NOT NULL AS models,
       to_regclass('app.ai_usage')          IS NOT NULL AS ai_usage,
       to_regclass('app.ai_cache')          IS NOT NULL AS ai_cache,
       to_regclass('app.wallets')           IS NOT NULL AS wallets,
       to_regclass('app.transactions')      IS NOT NULL AS transactions,
       to_regclass('app.achievements')      IS NOT NULL AS achievements,
       to_regclass('app.daily_states')      IS NOT NULL AS daily_states,
       to_regclass('app.streaks')           IS NOT NULL AS streaks,
       to_regclass('app.game_sessions')     IS NOT NULL AS game_sessions,
       to_regclass('app.history_deletes')   IS NOT NULL AS history_deletes,
       to_regclass('app.user_roles')           IS NOT NULL AS user_roles,
       to_regclass('app.ai_providers')         IS NOT NULL AS ai_providers,
       to_regclass('app.ai_models')            IS NOT NULL AS ai_models,
       to_regclass('app.ai_requests')          IS NOT NULL AS ai_requests,
       to_regclass('app.ai_daily_slots')       IS NOT NULL AS ai_daily_slots,
       to_regclass('app.ai_usage_limits')      IS NOT NULL AS ai_usage_limits,
       to_regclass('app.provider_health_logs') IS NOT NULL AS provider_health_logs,
       to_regclass('app.reward_claims')        IS NOT NULL AS reward_claims,
       to_regclass('app.economy_settings')     IS NOT NULL AS economy_settings;
-- expect every column true

-- ---------------------------------------------------------------------------
-- 2. Column counts match the source schema exactly
-- ---------------------------------------------------------------------------
WITH expected(table_name, expected_columns) AS (
  VALUES
    ('profiles',          13), ('spaces',             9), ('messages',          12),
    ('notes',              8), ('saved_questions',    8), ('books',             15),
    ('book_links',         5), ('chapters',          11), ('pages',             10),
    ('documents',         15), ('quizzes',           11), ('quiz_results',       9),
    ('study_sessions',    11), ('learning_history',   7), ('providers',         16),
    ('models',            15), ('ai_usage',          14), ('ai_cache',           6),
    ('wallets',            6), ('transactions',       9), ('achievements',       6),
    ('daily_states',      14), ('streaks',            6), ('game_sessions',     14),
    ('history_deletes',    5),
    ('user_roles',         6), ('ai_providers',      15), ('ai_models',         20),
    ('ai_requests',       13), ('ai_daily_slots',     6), ('ai_usage_limits',    5),
    ('provider_health_logs', 8), ('reward_claims',     6), ('economy_settings',   4)
),
actual AS (
  SELECT c.relname AS table_name, count(a.attname) AS columns
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
  WHERE n.nspname = 'app' AND c.relkind = 'r'
  GROUP BY c.relname
)
SELECT e.table_name, e.expected_columns, COALESCE(a.columns, 0) AS actual_columns,
       COALESCE(a.columns, 0) = e.expected_columns AS ok   -- expect ok = true on all 34 rows
FROM expected e
LEFT JOIN actual a USING (table_name)
ORDER BY e.table_name;

-- ---------------------------------------------------------------------------
-- 3. Constraints: primary keys and unique constraints
-- ---------------------------------------------------------------------------
SELECT count(*) FILTER (WHERE contype = 'p') AS primary_keys,   -- expect 34
       count(*) FILTER (WHERE contype = 'u') AS unique_checks   -- expect 22
FROM pg_constraint con
JOIN pg_namespace n ON n.oid = con.connamespace
WHERE n.nspname = 'app';

SELECT conname, conrelid::regclass AS table_name
FROM pg_constraint con
JOIN pg_namespace n ON n.oid = con.connamespace
WHERE n.nspname = 'app' AND contype = 'u'
ORDER BY conrelid::regclass::text, conname;
-- expect the 22 unique constraints below, nothing more:
--   profiles_owner_id_key, book_links_owner_id_book_id_space_id_key,
--   chapters_owner_id_book_id_number_title_key, documents_object_path_key,
--   providers_owner_id_provider_key_key, models_owner_id_provider_id_model_id_key,
--   ai_cache_fingerprint_key, quiz_results_client_key_key,
--   study_sessions_client_key_key, transactions_owner_id_reason_key,
--   achievements_owner_id_code_key, daily_states_owner_id_day_key,
--   streaks_owner_id_key, game_sessions_client_key_key,
--   user_roles_owner_id_key, ai_providers_provider_key_key,
--   ai_models_provider_id_model_id_key, ai_requests_owner_id_request_key_key,
--   ai_daily_slots_owner_id_day_slot_key, ai_usage_limits_scope_limit_key_key,
--   reward_claims_owner_id_code_period_key, economy_settings_key_key

-- ---------------------------------------------------------------------------
-- 4. Named indexes (the 30 CREATE INDEX statements)
-- ---------------------------------------------------------------------------
WITH expected(idx) AS (
  VALUES
    ('spaces_owner_created_idx'), ('spaces_owner_archived_idx'),
    ('messages_owner_space_idx'), ('notes_owner_space_idx'),
    ('saved_questions_owner_space_idx'), ('books_owner_created_idx'),
    ('book_links_owner_space_idx'), ('chapters_owner_book_idx'),
    ('pages_owner_book_idx'), ('pages_owner_chapter_idx'),
    ('documents_owner_book_idx'), ('quizzes_owner_space_idx'),
    ('quiz_results_owner_quiz_idx'), ('study_sessions_owner_started_idx'),
    ('learning_history_owner_space_idx'), ('providers_owner_idx'),
    ('models_owner_provider_idx'), ('ai_usage_owner_created_idx'),
    ('transactions_owner_created_idx'), ('achievements_owner_idx'),
    ('game_sessions_owner_game_idx'),
    ('ai_providers_enabled_idx'), ('ai_models_provider_idx'),
    ('ai_models_selectable_idx'), ('ai_requests_owner_created_idx'),
    ('ai_requests_state_idx'), ('ai_daily_slots_owner_day_idx'),
    ('provider_health_created_idx'), ('provider_health_provider_idx'),
    ('reward_claims_owner_idx')
)
SELECT count(i.indexname) AS found, (SELECT count(*) FROM expected) AS expected,
       count(i.indexname) = (SELECT count(*) FROM expected) AS ok  -- expect ok = true, 30
FROM expected e
LEFT JOIN pg_indexes i ON i.schemaname = 'app' AND i.indexname = e.idx;

-- ---------------------------------------------------------------------------
-- 5. RLS is enabled on every table
-- ---------------------------------------------------------------------------
SELECT count(*) AS tables_with_rls,                                  -- expect 34
       count(*) FILTER (WHERE NOT c.relrowsecurity) AS missing_rls   -- expect 0
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'app' AND c.relkind = 'r';

-- ---------------------------------------------------------------------------
-- 6. Policies: 25 owner policies, none on the 9 service-only tables
-- ---------------------------------------------------------------------------
SELECT pol.polname AS policy_name, c.relname AS table_name,
       CASE pol.polcmd WHEN 'a' THEN 'ALL' WHEN 'r' THEN 'SELECT' ELSE pol.polcmd::text END AS command
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'app'
ORDER BY c.relname, pol.polname;
-- expect 25 rows: 17 *_owner_all (FOR ALL) on profiles, spaces, messages,
-- notes, saved_questions, books, book_links, chapters, pages, documents,
-- quizzes, quiz_results, study_sessions, learning_history, ai_cache,
-- providers, models; and 8 *_owner_select (SELECT) on wallets, transactions,
-- achievements, daily_states, streaks, game_sessions, ai_usage,
-- history_deletes.

SELECT c.relname AS service_only_table, count(pol.oid) AS policies  -- expect 0 everywhere
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_policy pol ON pol.polrelid = c.oid
WHERE n.nspname = 'app' AND c.relkind = 'r'
  AND c.relname IN ('user_roles', 'ai_providers', 'ai_models', 'ai_requests',
                    'ai_daily_slots', 'ai_usage_limits', 'provider_health_logs',
                    'reward_claims', 'economy_settings')
GROUP BY c.relname
ORDER BY c.relname;

-- ---------------------------------------------------------------------------
-- 7. Privileges: browser roles hold nothing; the server role holds everything
-- ---------------------------------------------------------------------------
SELECT
  has_schema_privilege('anon',          'app', 'USAGE') AS anon_schema,          -- expect false
  has_schema_privilege('authenticated', 'app', 'USAGE') AS auth_schema,         -- expect false
  has_schema_privilege('service_role',  'app', 'USAGE') AS service_schema,      -- expect true
  has_table_privilege('anon',          'app.wallets',      'SELECT') AS anon_wallets,      -- expect false
  has_table_privilege('authenticated', 'app.wallets',      'SELECT') AS auth_wallets,      -- expect false
  has_table_privilege('authenticated', 'app.wallets',      'UPDATE') AS auth_wallet_upd,   -- expect false
  has_table_privilege('authenticated', 'app.transactions', 'INSERT') AS auth_tx_insert,    -- expect false
  has_table_privilege('authenticated', 'app.ai_providers', 'SELECT') AS auth_providers,   -- expect false
  has_table_privilege('authenticated', 'app.economy_settings', 'SELECT') AS auth_economy, -- expect false
  has_schema_privilege('public',       'app', 'USAGE') AS public_schema,       -- expect false
  has_table_privilege('service_role',  'app.wallets',      'SELECT') AS svc_wallets,       -- expect true
  has_table_privilege('service_role',  'app.transactions', 'INSERT') AS svc_tx_insert,    -- expect true
  has_table_privilege('service_role',  'app.ai_providers', 'UPDATE') AS svc_providers    -- expect true
;

-- Every table locked down: count tables with ANY privilege for anon,
-- authenticated or PUBLIC. A grant to PUBLIC is stored with grantee oid 0,
-- which matches no pg_roles row, so the join must be a LEFT JOIN and the NULL
-- rolname (the PUBLIC placeholder) counted too (audit finding M-3). Expect 0.
SELECT count(*) AS tables_reachable_by_browser_roles
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_namespace nr ON nr.oid = c.relowner
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) acl
LEFT JOIN pg_roles r ON r.oid = acl.grantee
WHERE n.nspname = 'app' AND c.relkind = 'r'
  AND (r.rolname IN ('anon', 'authenticated') OR r.rolname IS NULL);

-- ---------------------------------------------------------------------------
-- 8. RPC functions exist and are executable only by the server
-- ---------------------------------------------------------------------------
SELECT to_regprocedure('app.karachi_day()')                                            IS NOT NULL AS karachi_day,
       to_regprocedure('app.karachi_next_reset()')                                     IS NOT NULL AS karachi_next_reset,
       to_regprocedure('app.apply_delta(text,text,text,integer,text,jsonb)')           IS NOT NULL AS apply_delta,
       to_regprocedure('app.release_daily_slot(text,text,integer)')                    IS NOT NULL AS release_daily_slot,
       to_regprocedure('app.reserve_ai(text,text,text,integer,text,integer)')          IS NOT NULL AS reserve_ai,
       to_regprocedure('app.settle_ai(text,text,text,text,integer,text)')              IS NOT NULL AS settle_ai,
       to_regprocedure('app.refund_ai(text,text,text,text)')                           IS NOT NULL AS refund_ai;
-- expect every column true

SELECT
  has_function_privilege('anon',          'app.apply_delta(text,text,text,integer,text,jsonb)',  'EXECUTE') AS anon_apply_delta,     -- expect false
  has_function_privilege('authenticated', 'app.apply_delta(text,text,text,integer,text,jsonb)',  'EXECUTE') AS auth_apply_delta,     -- expect false
  has_function_privilege('authenticated', 'app.reserve_ai(text,text,text,integer,text,integer)','EXECUTE') AS auth_reserve_ai,    -- expect false
  has_function_privilege('authenticated', 'app.refund_ai(text,text,text,text)',                  'EXECUTE') AS auth_refund_ai,     -- expect false
  has_function_privilege('service_role',  'app.apply_delta(text,text,text,integer,text,jsonb)',  'EXECUTE') AS svc_apply_delta,     -- expect true
  has_function_privilege('service_role',  'app.reserve_ai(text,text,text,integer,text,integer)','EXECUTE') AS svc_reserve_ai,     -- expect true
  has_function_privilege('service_role',  'app.settle_ai(text,text,text,text,integer,text)',     'EXECUTE') AS svc_settle_ai,       -- expect true
  has_function_privilege('service_role',  'app.refund_ai(text,text,text,text)',                  'EXECUTE') AS svc_refund_ai       -- expect true
;

-- No EXECUTE for PUBLIC either: a function grant to PUBLIC is stored with
-- grantee oid 0 and needs the same LEFT JOIN treatment as the table sweep
-- above (audit finding M-3). Expect 0.
SELECT count(*) AS functions_executable_by_browser_or_public
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
LEFT JOIN pg_roles r ON r.oid = acl.grantee
WHERE n.nspname = 'app'
  AND (r.rolname IN ('anon', 'authenticated') OR r.rolname IS NULL);

-- ---------------------------------------------------------------------------
-- 9. Time zone: the Pakistan day and the next reset
-- ---------------------------------------------------------------------------
SELECT app.karachi_day() AS today_pakistan,                 -- expect the current YYYY-MM-DD in Asia/Karachi
       app.karachi_next_reset() AS resets_at,               -- expect the next midnight Pakistan time, as a UTC instant
       to_char(now() AT TIME ZONE 'Asia/Karachi', 'HH24:MI') AS pakistan_time_now;
-- Cross-check by hand: (resets_at - now()) must be less than 24 hours and, at
-- any moment, equal to the time left before 00:00 in Karachi.

-- ---------------------------------------------------------------------------
-- 10. Free-only registry invariants (data checks, once the gateway is seeded)
-- ---------------------------------------------------------------------------
-- Every enabled model must be verified free: zero micro-price on both sides.
-- Expect zero violations. (Runs clean on a fresh project; meaningful once the
-- Function has provisioned the central provider.)
-- provider_id is a uuid foreign key into ai_providers, not an oid, so the
-- provider name comes from a plain join — `uuid::regclass` is an invalid cast
-- (audit finding M-1).
SELECT p.provider_key AS provider, m.model_id
FROM app.ai_models m
JOIN app.ai_providers p ON p.id = m.provider_id
WHERE m.enabled = true
  AND (m.free_tier = false OR m.pricing_verified = false
       OR m.input_micro_per_1k <> 0 OR m.output_micro_per_1k <> 0);

-- ---------------------------------------------------------------------------
-- 11. Transactional smoke test of the Bridge Credits RPCs (nothing persists)
-- ---------------------------------------------------------------------------
BEGIN;

-- 11a. First earn: 30 BC for the daily login.
SELECT app.apply_delta('smoke-student', 'login:2026-11-10', 'Daily login', 30, 'earn',
                       '{"type":"daily_reward"}'::jsonb);
-- expect: {"ok": true, "replayed": false, "balance": 30, "credits": 30, ...}

-- 11b. Same reason again: a replay. Nothing is paid twice.
SELECT app.apply_delta('smoke-student', 'login:2026-11-10', 'Daily login', 30, 'earn',
                       '{"type":"daily_reward"}'::jsonb);
-- expect: {"ok": true, "replayed": true, "credits": 30, ...} and still one ledger row

-- 11c. A priced AI request: reserve 2 BC against a 3-question daily allowance.
SELECT app.reserve_ai('smoke-student', 'chat', 'smoke-key-12345678', 2, '', 3);
-- expect: {"ok": true, "state": "reserved", "charged": true, "slot": 1, "attempt": 1, ...}

-- 11d. Wallet after the debit: 28 BC.
SELECT balance, earned, spent FROM app.wallets WHERE owner_id = 'smoke-student';
-- expect: balance 28, earned 30, spent 2

-- 11e. A spend the balance cannot cover.
SELECT app.apply_delta('smoke-student', 'ai:smoke-key-12345678:2', 'AI: chat', 5000, 'spend', '{}');
-- expect: {"ok": false, "error": "insufficient_credits"} and NO new ledger row

-- 11f. The answer was delivered: settle.
SELECT app.settle_ai('smoke-student', 'smoke-key-12345678', 'openrouter', 'test/free-model', 200, 'msg_smoke_1');
-- expect: {"ok": true, "request": {"state": "settled", ...}}

-- 11g. The same key again: replay, no second charge.
SELECT app.reserve_ai('smoke-student', 'chat', 'smoke-key-12345678', 2, '', 3);
-- expect: {"ok": true, "state": "settled", "replayed": true, "charged": false, ...}

-- 11g-check. The replay must NOT have freed the settled request's daily slot:
-- the allowance is returned only when the question is refunded, never because
-- the same key was submitted twice (audit findings H-1 / M-2).
SELECT count(*) AS slots_after_replay FROM app.ai_daily_slots
WHERE owner_id = 'smoke-student';                                   -- expect 1

-- 11h. A settled request is never refunded.
SELECT app.refund_ai('smoke-student', 'smoke-key-12345678', 'late click', 'chat');
-- expect: {"ok": true, "refunded": false, "settled": true, ...}

-- 11i. A refund of a live reservation: credits return as their own ledger row.
SELECT app.reserve_ai('smoke-student', 'chat', 'smoke-refund-987654', 2, '', 3);
-- expect: {"ok": true, "charged": true, "slot": 2, "attempt": 1, ...} — slot 2
-- because the settled request from 11c still holds slot 1; under the pre-H-1
-- bug the replay freed it and this call would have claimed slot 1 again.
SELECT app.refund_ai('smoke-student', 'smoke-refund-987654', 'provider timeout', 'chat');
-- expect: {"ok": true, "refunded": true, "credits": 2, ...}
SELECT balance FROM app.wallets WHERE owner_id = 'smoke-student';   -- expect 28 again
SELECT direction, amount, reason FROM app.transactions
WHERE owner_id = 'smoke-student' AND reason LIKE 'refund:%';
-- expect exactly one row: earn / 2 / refund:smoke-refund-987654:1
SELECT count(*) AS slots_left FROM app.ai_daily_slots
WHERE owner_id = 'smoke-student';                                   -- expect 1 (the settled one;
                                                                    -- the pre-H-1 bug read 0 here)

-- 11j. The daily cap: a reward that overflows the cap is reduced, not paid in full.
SELECT app.apply_delta('smoke-student', 'session:2026-11-10', 'Deep session', 61, 'earn',
                       '{"type":"learning_reward"}'::jsonb);
-- expect: {"ok": true, "credits": 60, "cap_note": "Reduced to 60 ..."} because
-- only 60 of the 90 regular daily BC remain (30 went to the login)

-- 11k. Past the cap, a regular daily reward is {"capped": true}, not an error.
SELECT app.apply_delta('smoke-student', 'goal:2026-11-10', 'Daily goal met', 20, 'earn',
                       '{"type":"learning_reward"}'::jsonb);
-- expect: {"ok": true, "capped": true, "credits": 0, "cap_note": "..."} and no ledger row

-- 11l. The AI daily cap (audit finding M-5): with p_daily_max = 1 exactly one
-- priced question fits into today; a second distinct key is refused and
-- writes nothing at all.
SELECT app.apply_delta('smoke-capped', 'seed:cap', 'Seed credits', 10, 'earn', '{}');
-- expect: {"ok": true, "balance": 10, ...} ("seed:" is not a capped daily reason)
SELECT app.reserve_ai('smoke-capped', 'chat', 'cap-key-11111111', 2, '', 1);
-- expect: {"ok": true, "charged": true, "slot": 1, ...}
SELECT app.reserve_ai('smoke-capped', 'chat', 'cap-key-22222222', 2, '', 1);
-- expect: {"ok": false, "error": "daily_limit_reached", "status": 429, ...}
SELECT count(*) AS capped_requests FROM app.ai_requests
WHERE owner_id = 'smoke-capped';                                    -- expect 1 (the first only)
SELECT balance FROM app.wallets WHERE owner_id = 'smoke-capped';    -- expect 8 (10 minus 2)

-- 11m. In-flight replay (audit finding M-5): a second reserve with the same
-- key while the first is still reserved waits instead of paying again, and
-- the in-flight request keeps its daily slot (audit finding H-1).
SELECT app.apply_delta('smoke-inflight', 'seed:inflight', 'Seed credits', 10, 'earn', '{}');
-- expect: {"ok": true, "balance": 10, ...}
SELECT app.reserve_ai('smoke-inflight', 'chat', 'flight-key-123456', 2, '', 3);
-- expect: {"ok": true, "charged": true, "slot": 1, "attempt": 1, ...}
SELECT app.reserve_ai('smoke-inflight', 'chat', 'flight-key-123456', 2, '', 3);
-- expect: {"ok": true, "replayed": true, "in_flight": true, "charged": false, ...}
SELECT count(*) AS inflight_requests FROM app.ai_requests
WHERE owner_id = 'smoke-inflight';                                  -- expect 1
SELECT count(*) AS inflight_slots FROM app.ai_daily_slots
WHERE owner_id = 'smoke-inflight';                                  -- expect 1 (the in-flight
                                                                    -- request keeps its slot;
                                                                    -- the pre-H-1 bug read 0)
SELECT balance FROM app.wallets WHERE owner_id = 'smoke-inflight';  -- expect 8 (charged once)

-- 11n. Retry after a failed charge (audit finding M-5): the refused attempt
-- leaves the request "failed" and the ledger untouched; a retry of the same
-- key gets attempt 2 with its own debit.
SELECT app.reserve_ai('smoke-retry', 'chat', 'try-key-11111111', 2, '', 0);
-- expect: {"ok": false, "error": "insufficient_credits", "attempt": 1, ...}
SELECT state, attempt FROM app.ai_requests WHERE owner_id = 'smoke-retry';
-- expect: failed / 1
SELECT app.apply_delta('smoke-retry', 'seed:retry', 'Seed credits', 10, 'earn', '{}');
-- expect: {"ok": true, "balance": 10, ...}
SELECT app.reserve_ai('smoke-retry', 'chat', 'try-key-11111111', 2, '', 0);
-- expect: {"ok": true, "charged": true, "attempt": 2, "replayed": false, ...}
SELECT state, attempt FROM app.ai_requests WHERE owner_id = 'smoke-retry';
-- expect: reserved / 2
SELECT reason FROM app.transactions
WHERE owner_id = 'smoke-retry' AND direction = 'spend';
-- expect exactly one row: ai:try-key-11111111:2 (no :1 — the failed attempt
-- charged nothing)
SELECT balance FROM app.wallets WHERE owner_id = 'smoke-retry';     -- expect 8

ROLLBACK;
-- After the ROLLBACK, all smoke rows are gone:
SELECT count(*) AS smoke_rows FROM app.transactions WHERE owner_id = 'smoke-student';  -- expect 0
SELECT count(*) AS smoke_requests FROM app.ai_requests WHERE owner_id = 'smoke-student'; -- expect 0

-- ---------------------------------------------------------------------------
-- 12. Attacker simulation: a normal authenticated student gets nothing
--     (audit finding M-4).
--
--     The SQL editor executes as the project's postgres role, which owns
--     schema "app", so the editor itself can never be denied. The original
--     form — SET LOCAL ROLE authenticated followed by bare unauthorised
--     queries — exercised the wall for real, but every probe then raised
--     exactly the error it expected and, in the editor, that error aborts
--     the whole batch.
--
--     The first rewrite created a pg_temp function and a pg_temp table,
--     but the SQL Editor's connection pooler can route consecutive
--     statements to different backend connections; a temporary object
--     created in one hop is not visible in the next, so the table lookup
--     failed with 42P01.
--
--     This version runs the whole simulation in ONE statement: a PL/pgSQL
--     DO block. It assumes authenticated, attempts each probe, catches
--     insufficient_privilege (SQLSTATE 42501), emits a NOTICE per probe and
--     a summary NOTICE, and RAISEs an EXCEPTION only if a probe actually
--     executed as authenticated (a real security failure). The DO block
--     lives inside an explicit transaction that is rolled back, so even a
--     successful probe would leave nothing behind.
--
--     Reading the NOTICEs:
--       * every probe must read denied = true, err_state = 42501 — typically
--         "permission denied for schema app" — verdict = denied_as_expected;
--       * denied = false is a real security failure and raises EXCEPTION;
--       * verdict = cannot_verify means the editor role may not assume
--         authenticated (pg_has_role MEMBER false) — section 7 remains the
--         evidence.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
  v_probe text;
  v_expected text;
  v_sql text;
  v_prev_role text := current_user::text;
  v_can_assume boolean;
  v_denied boolean;
  v_state text;
  v_msg text;
  v_verdict text;
  v_probes integer := 0;
  v_denied_expected integer := 0;
  v_security_failures integer := 0;
  v_cannot_verify integer := 0;
BEGIN
  v_can_assume := pg_has_role(current_user, 'authenticated', 'MEMBER');

  FOR v_probe, v_expected, v_sql IN
    SELECT t.probe, t.expected, t.probe_sql FROM (VALUES
      ('app.wallets SELECT',      'permission denied',
       $p$SELECT count(*) FROM app.wallets$p$),
      ('app.transactions SELECT', 'permission denied',
       $p$SELECT count(*) FROM app.transactions$p$),
      ('app.ai_providers SELECT', 'permission denied (key_cipher lives here)',
       $p$SELECT count(*) FROM app.ai_providers$p$),
      ('app.ai_models SELECT',    'permission denied',
       $p$SELECT count(*) FROM app.ai_models$p$),
      ('app.ai_requests SELECT',  'permission denied',
       $p$SELECT count(*) FROM app.ai_requests$p$),
      ('app.spaces SELECT',       'permission denied (owner-only content)',
       $p$SELECT count(*) FROM app.spaces$p$),
      ('app.apply_delta EXECUTE', 'permission denied (EXECUTE revoked)',
       $p$SELECT app.apply_delta('victim-student', 'theft:1', 'Theft', 9999,
                                 'spend', '{}')$p$),
      ('app.reserve_ai EXECUTE',  'permission denied',
       $p$SELECT app.reserve_ai('victim-student', 'chat', 'steal-key-123456',
                                0, '', 0)$p$)
    ) AS t(probe, expected, probe_sql)
  LOOP
    v_probes := v_probes + 1;

    IF NOT v_can_assume THEN
      v_cannot_verify := v_cannot_verify + 1;
      v_verdict := 'cannot_verify';
      RAISE NOTICE 'probe=% | expected=% | denied=NULL | err_state=NULL | verdict=% | msg=%',
        v_probe, v_expected, v_verdict,
        'editor role cannot assume authenticated; section 7 holds the static proof';
      CONTINUE;
    END IF;

    v_denied := NULL; v_state := NULL; v_msg := NULL;
    BEGIN
      PERFORM set_config('role', 'authenticated', true);
      EXECUTE v_sql;
      v_denied := false;             -- the probe ran: the wall is down
    EXCEPTION
      WHEN insufficient_privilege THEN
        v_denied := true; v_state := SQLSTATE; v_msg := SQLERRM;
      WHEN OTHERS THEN
        v_denied := NULL; v_state := SQLSTATE; v_msg := SQLERRM;
    END;
    PERFORM set_config('role', v_prev_role, false);

    IF v_denied IS TRUE AND v_state = '42501' THEN
      v_verdict := 'denied_as_expected';
      v_denied_expected := v_denied_expected + 1;
    ELSIF v_denied IS TRUE THEN
      v_verdict := 'denied_with_unexpected_error';
    ELSIF v_denied IS FALSE THEN
      v_verdict := 'SECURITY_FAILURE';
      v_security_failures := v_security_failures + 1;
    ELSE
      v_verdict := 'unexpected_error';
    END IF;

    RAISE NOTICE 'probe=% | expected=% | denied=% | err_state=% | verdict=% | msg=%',
      v_probe, v_expected, v_denied, v_state, v_verdict, v_msg;
  END LOOP;

  RAISE NOTICE 'Attacker simulation summary: probes=% | denied_as_expected=% | security_failures=% | cannot_verify=%',
    v_probes, v_denied_expected, v_security_failures, v_cannot_verify;

  IF v_security_failures > 0 THEN
    RAISE EXCEPTION 'Security failure: % probe(s) executed as authenticated', v_security_failures;
  END IF;
END $$;

ROLLBACK;
