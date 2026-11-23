-- StudyBridge AI — Supabase migration 5: AI Chat conversations and messages.
--
-- Applies after migrations 1-4. The dedicated AI Chat section persists whole
-- conversations (a sidebar of titled threads, each with its own message
-- history) separately from the space-scoped tutor transcript in app.messages,
-- so neither feature reshapes the other.
--
-- Security model, identical to the existing tables:
--   * Layer 1 (hard wall): the ALTER DEFAULT PRIVILEGES from migration 3 and
--     the explicit REVOKEs below keep anon/authenticated at zero privileges;
--     only service_role (the server's key) reads and writes. The browser
--     never supplies an owner id and never touches these tables directly.
--   * Layer 2 (defence in depth): RLS is ENABLED with owner-only policies, so
--     even a future privilege grant could only ever expose a student's own
--     rows. Both tables are user-content tables, so unlike wallets or the
--     ledger they get full FOR ALL owner policies, like app.spaces.
--
-- Charging stays where it always was: credits are reserved/settled/refunded
-- in app.ai_requests + app.transactions by functions/lib/rewards.mjs. These
-- tables hold conversation content only — nothing here can move a balance.

CREATE TABLE app.chat_conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  title text NOT NULL DEFAULT '',
  message_count integer NOT NULL DEFAULT 0,
  model text NOT NULL DEFAULT '',
  provider text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- The sidebar lists a student's conversations newest-first.
CREATE INDEX chat_conversations_owner_updated_idx ON app.chat_conversations (owner_id, updated_at DESC);

CREATE TABLE app.chat_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES app.chat_conversations (id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  tokens integer NOT NULL DEFAULT 0,
  cost_micro bigint NOT NULL DEFAULT 0,
  -- Provenance block, same shape as app.messages.sources: cached/attempt/
  -- retried/fell_back flags and the idempotency request_key of the send.
  sources jsonb NOT NULL DEFAULT '{}',
  -- The client_key of the chat send that produced this message. The credit
  -- ledger (owner_id, request_key in app.ai_requests) stays the single source
  -- of truth for charging; this column aligns message rows with that ledger
  -- so a replay or a retry shows the same rows it was answered by.
  request_key text NOT NULL DEFAULT '',
  -- '' while the message stands, 'failed' when its generation was refunded.
  state text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_messages_conversation_created_idx ON app.chat_messages (conversation_id, created_at);
CREATE INDEX chat_messages_owner_created_idx ON app.chat_messages (owner_id, created_at);

ALTER TABLE app.chat_conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.chat_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY chat_conversations_owner_all ON app.chat_conversations
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

CREATE POLICY chat_messages_owner_all ON app.chat_messages
  FOR ALL TO authenticated
  USING (owner_id = (select auth.uid())::text)
  WITH CHECK (owner_id = (select auth.uid())::text);

REVOKE ALL ON app.chat_conversations, app.chat_messages FROM anon, authenticated, PUBLIC;
GRANT ALL ON app.chat_conversations, app.chat_messages TO service_role;
