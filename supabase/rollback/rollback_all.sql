-- StudyBridge AI — full rollback of the Supabase migration.
--
-- !!! DESTRUCTIVE: every row in schema "app" is destroyed. !!!
--
-- Use this ONLY if the migration was applied by mistake or must be removed
-- from an empty/abandoned project. If the application already runs against
-- this database, rolling back deletes every student's spaces, notes, books,
-- wallet balances and ledger history — there is no undo. Take a backup first
-- (Supabase dashboard → Database → Backups, or pg_dump) before running.
--
-- Safe to run partially: each statement is guarded by IF EXISTS, so it can be
-- re-run or stopped at any point. The application code is not touched — if it
-- was already switched to this database, it will fail loudly (connection-level
-- "relation does not exist") rather than silently.
--
-- Order does not matter technically (no foreign keys exist between the tables;
-- CASCADE removes the dependency between policies/constraints and their
-- tables), but tables are listed grouped by origin so the report is readable.

-- ---------------------------------------------------------------------------
-- 1. RPC functions (migration 4)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS app.refund_ai(text, text, text, text);
DROP FUNCTION IF EXISTS app.settle_ai(text, text, text, text, integer, text);
DROP FUNCTION IF EXISTS app.reserve_ai(text, text, text, integer, text, integer);
DROP FUNCTION IF EXISTS app.release_daily_slot(text, text, integer);
DROP FUNCTION IF EXISTS app.apply_delta(text, text, text, integer, text, jsonb);
DROP FUNCTION IF EXISTS app.karachi_next_reset();
DROP FUNCTION IF EXISTS app.karachi_day();

-- ---------------------------------------------------------------------------
-- 2. Central gateway tables (migration 2)
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS app.economy_settings     CASCADE;
DROP TABLE IF EXISTS app.reward_claims        CASCADE;
DROP TABLE IF EXISTS app.provider_health_logs CASCADE;
DROP TABLE IF EXISTS app.ai_usage_limits      CASCADE;
DROP TABLE IF EXISTS app.ai_daily_slots       CASCADE;
DROP TABLE IF EXISTS app.ai_requests          CASCADE;
DROP TABLE IF EXISTS app.ai_models            CASCADE;
DROP TABLE IF EXISTS app.ai_providers         CASCADE;
DROP TABLE IF EXISTS app.user_roles           CASCADE;

-- ---------------------------------------------------------------------------
-- 3. Core business tables (migration 1)
-- ---------------------------------------------------------------------------
DROP TABLE IF EXISTS app.history_deletes   CASCADE;
DROP TABLE IF EXISTS app.game_sessions     CASCADE;
DROP TABLE IF EXISTS app.streaks           CASCADE;
DROP TABLE IF EXISTS app.daily_states      CASCADE;
DROP TABLE IF EXISTS app.achievements      CASCADE;
DROP TABLE IF EXISTS app.transactions      CASCADE;
DROP TABLE IF EXISTS app.wallets           CASCADE;
DROP TABLE IF EXISTS app.ai_cache          CASCADE;
DROP TABLE IF EXISTS app.ai_usage          CASCADE;
DROP TABLE IF EXISTS app.models            CASCADE;
DROP TABLE IF EXISTS app.providers         CASCADE;
DROP TABLE IF EXISTS app.learning_history  CASCADE;
DROP TABLE IF EXISTS app.study_sessions    CASCADE;
DROP TABLE IF EXISTS app.quiz_results      CASCADE;
DROP TABLE IF EXISTS app.quizzes           CASCADE;
DROP TABLE IF EXISTS app.documents         CASCADE;
DROP TABLE IF EXISTS app.pages             CASCADE;
DROP TABLE IF EXISTS app.chapters          CASCADE;
DROP TABLE IF EXISTS app.book_links        CASCADE;
DROP TABLE IF EXISTS app.books             CASCADE;
DROP TABLE IF EXISTS app.saved_questions   CASCADE;
DROP TABLE IF EXISTS app.notes             CASCADE;
DROP TABLE IF EXISTS app.messages          CASCADE;
DROP TABLE IF EXISTS app.spaces            CASCADE;
DROP TABLE IF EXISTS app.profiles          CASCADE;

-- ---------------------------------------------------------------------------
-- 4. The schema itself, with the RLS policies and grants attached to it
-- ---------------------------------------------------------------------------
DROP SCHEMA IF EXISTS app CASCADE;

-- Verify: the query below should return 0 tables, 0 functions, 0 policies.
-- SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--         WHERE n.nspname = 'app' AND c.relkind = 'r') AS tables,
--        (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--         WHERE n.nspname = 'app') AS functions;
