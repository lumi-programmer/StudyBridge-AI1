-- StudyBridge AI — Supabase migration 3 of 4: Row Level Security and grants.
--
-- Applies after migrations 1 and 2 (all 34 tables exist by then).
--
-- Security model, in two layers:
--
--   Layer 1 — privileges (hard wall). Every table in "app" is revoked from
--   anon, authenticated and PUBLIC, and only service_role (the server's key)
--   receives privileges. A student's browser token cannot read or write any
--   table directly, so no balance, ledger row, provider key cipher or other
--   student's data can ever be touched from the client. This is what preserves
--   the existing invariants: the browser never submits a balance and never
--   sees a decrypted key.
--
--   Layer 2 — RLS policies (defence in depth). RLS is ENABLED on all 34
--   tables. If privileges are ever (re-)granted to authenticated for a table,
--   the policies below constrain access to the row owner. Wallets and the
--   other server-written tables only ever get SELECT policies — a future grant
--   can allow reading a balance, never forging one. The 9 service-only tables
--   get NO policy at all: with RLS enabled and no policy, every non-bypassing
--   role sees zero rows even if it holds privileges.
--
-- auth.uid() returns uuid; every owner_id column is text, hence ::text.
-- `(select auth.uid())` is wrapped in a subquery so PostgreSQL evaluates it
-- once per statement instead of per row.

-- ---------------------------------------------------------------------------
-- Enable RLS on all 34 tables
-- ---------------------------------------------------------------------------

ALTER TABLE app.profiles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.spaces            ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.messages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.notes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.saved_questions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.books             ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.book_links        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chapters          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.pages             ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.documents         ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.quizzes           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.quiz_results      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.study_sessions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.learning_history  ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.providers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.models            ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_usage          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_cache          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.wallets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.transactions      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.achievements      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.daily_states      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.streaks           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.game_sessions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.history_deletes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.user_roles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_providers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_models            ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_requests          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_daily_slots       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ai_usage_limits      ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.provider_health_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.reward_claims        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.economy_settings     ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Tier A — student-owned content: full owner policies.
--
-- These are the tables whose rows the student creates and manages through the
-- app. The USING clause filters reads to the owner; WITH CHECK rejects a row
-- whose owner_id does not match the authenticated student, so a client can
-- never write into someone else's data even if it ever holds privileges.
-- ---------------------------------------------------------------------------

CREATE POLICY profiles_owner_all ON app.profiles
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY spaces_owner_all ON app.spaces
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY messages_owner_all ON app.messages
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY notes_owner_all ON app.notes
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY saved_questions_owner_all ON app.saved_questions
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY books_owner_all ON app.books
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY book_links_owner_all ON app.book_links
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY chapters_owner_all ON app.chapters
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY pages_owner_all ON app.pages
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY documents_owner_all ON app.documents
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY quizzes_owner_all ON app.quizzes
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY quiz_results_owner_all ON app.quiz_results
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY study_sessions_owner_all ON app.study_sessions
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY learning_history_owner_all ON app.learning_history
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY ai_cache_owner_all ON app.ai_cache
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY providers_owner_all ON app.providers
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY models_owner_all ON app.models
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- Tier B — server-written, student-readable: SELECT-only policies.
--
-- Rows in these tables decide money and progress (balances, the ledger,
-- achievements, daily state, streaks, game outcomes, usage accounting, delete
-- records). They are written exclusively by the Function. A SELECT-only
-- policy means even a future privilege grant to authenticated could never let
-- a browser forge a balance, an achievement or a game score — the same
-- guarantee the server-side ledger gives today.
-- ---------------------------------------------------------------------------

CREATE POLICY wallets_owner_select ON app.wallets
  FOR SELECT TO authenticated
  USING (owner_id = (select auth.uid())::text);

CREATE POLICY transactions_owner_select ON app.transactions
  FOR SELECT TO authenticated
  USING (owner_id = (select auth.uid())::text);

CREATE POLICY achievements_owner_select ON app.achievements
  FOR SELECT TO authenticated
  USING (owner_id = (select auth.uid())::text);

CREATE POLICY daily_states_owner_select ON app.daily_states
  FOR SELECT TO authenticated
  USING (owner_id = (select auth.uid())::text);

CREATE POLICY streaks_owner_select ON app.streaks
  FOR SELECT TO authenticated
  USING (owner_id = (select auth.uid())::text);

CREATE POLICY game_sessions_owner_select ON app.game_sessions
  FOR SELECT TO authenticated
  USING (owner_id = (select auth.uid())::text);

CREATE POLICY ai_usage_owner_select ON app.ai_usage
  FOR SELECT TO authenticated
  USING (owner_id = (select auth.uid())::text);

CREATE POLICY history_deletes_owner_select ON app.history_deletes
  FOR SELECT TO authenticated
  USING (owner_id = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- Service-only tables — RLS enabled, zero policies: deny-all.
--
-- user_roles           who may administer; only the Function may grant a role,
--                      so no client policy exists for any operation.
-- ai_providers         platform provider rows carry key_cipher; the browser
--                      never reads or writes them.
-- ai_models            the approved free-model registry; maintained by the
--                      Function's catalogue sync and administrators.
-- ai_requests          reservation/settlement/refund lifecycle; a client-
--                      writable row would let a student fake "already paid".
-- ai_daily_slots       the daily allowance; a client-writable slot would break
--                      the question cap.
-- ai_usage_limits      administrator-controlled limits.
-- provider_health_logs gateway monitoring history.
-- reward_claims        which rewards were claimed; a client-writable row would
--                      let a student self-award Bridge Credits.
-- economy_settings     reward amounts, AI prices, enable flags.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Privileges: the hard wall. No direct table access from browser roles.
-- ---------------------------------------------------------------------------

REVOKE ALL ON ALL TABLES IN SCHEMA app FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA app FROM PUBLIC;

REVOKE ALL ON SCHEMA app FROM anon;
REVOKE ALL ON SCHEMA app FROM authenticated;
REVOKE ALL ON SCHEMA app FROM PUBLIC;

GRANT USAGE ON SCHEMA app TO service_role;
GRANT ALL ON ALL TABLES IN SCHEMA app TO service_role;

-- Anything created in "app" later (by migrations running as the project's
-- postgres role) starts with the same locked-down posture.
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON TABLES FROM anon, authenticated, PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA app REVOKE ALL ON FUNCTIONS FROM anon, authenticated, PUBLIC;
