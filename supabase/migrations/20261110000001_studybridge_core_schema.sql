-- StudyBridge AI — Supabase migration 1 of 4: core business schema.
--
-- Faithful conversion of schema/studybridge.sql (25 tables). The source file is
-- the system of record and was NOT modified; this migration carries the same
-- table names, columns, defaults, constraints and indexes byte-for-byte, inside
-- the dedicated "app" schema.
--
-- Conversion notes:
--   * gen_random_uuid() is core PostgreSQL since 13; Supabase projects run
--     PostgreSQL 15+, so no extension is required. The source schemas use no
--     extensions and none are added here.
--   * No foreign keys exist in the source schema and none are added: ownership
--     and relationships (owner_id, space_id, book_id, ...) are enforced by the
--     Function, and adding FKs now would change behaviour, not preserve it.
--   * jsonb columns declared NOT NULL without a default stay exactly that way:
--     the Function always supplies their value (insertIfAbsent payloads).
--   * Timestamps stay timestamptz with now() defaults; day arithmetic (the
--     Asia/Karachi reset) is implemented in migration 4, not in the DDL.

CREATE SCHEMA IF NOT EXISTS app;

CREATE TABLE app.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL UNIQUE,
  display_name text NOT NULL DEFAULT '',
  language text NOT NULL DEFAULT 'en',
  explanation_level text NOT NULL DEFAULT 'simple',
  daily_goal_minutes integer NOT NULL DEFAULT 30,
  quick_break_suggestions boolean NOT NULL DEFAULT true,
  theme text NOT NULL DEFAULT 'system',
  notification_prefs jsonb NOT NULL,
  ai_limit_per_day integer NOT NULL DEFAULT 120,
  onboarded boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.spaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  name text NOT NULL,
  subject text NOT NULL DEFAULT '',
  color text NOT NULL DEFAULT 'indigo',
  instructions text NOT NULL DEFAULT '',
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX spaces_owner_created_idx ON app.spaces (owner_id, created_at);
CREATE INDEX spaces_owner_archived_idx ON app.spaces (owner_id, archived);

CREATE TABLE app.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  space_id uuid NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  style text NOT NULL DEFAULT '',
  tokens integer NOT NULL DEFAULT 0,
  cost_micro bigint NOT NULL DEFAULT 0,
  sources jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_owner_space_idx ON app.messages (owner_id, space_id);

CREATE TABLE app.notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  space_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_owner_space_idx ON app.notes (owner_id, space_id);

CREATE TABLE app.saved_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  space_id uuid NOT NULL,
  question text NOT NULL,
  answer text NOT NULL DEFAULT '',
  topic text NOT NULL DEFAULT '',
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX saved_questions_owner_space_idx ON app.saved_questions (owner_id, space_id);

CREATE TABLE app.books (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  title text NOT NULL,
  author text NOT NULL DEFAULT '',
  subject text NOT NULL DEFAULT '',
  publisher text NOT NULL DEFAULT '',
  edition text NOT NULL DEFAULT '',
  publication_year integer NOT NULL DEFAULT 0,
  cover_object_path text NOT NULL DEFAULT '',
  external_url text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'manual',
  verified jsonb NOT NULL,
  chapters_ready boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX books_owner_created_idx ON app.books (owner_id, created_at);

CREATE TABLE app.book_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  book_id uuid NOT NULL,
  space_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, book_id, space_id)
);
CREATE INDEX book_links_owner_space_idx ON app.book_links (owner_id, space_id);

CREATE TABLE app.chapters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  book_id uuid NOT NULL,
  number integer NOT NULL DEFAULT 0,
  title text NOT NULL,
  summary text NOT NULL DEFAULT '',
  position integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'todo',
  pages_extracted integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, book_id, number, title)
);
CREATE INDEX chapters_owner_book_idx ON app.chapters (owner_id, book_id);

CREATE TABLE app.pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  book_id uuid NOT NULL,
  chapter_id uuid,
  document_id uuid,
  page_number integer NOT NULL DEFAULT 0,
  text text NOT NULL DEFAULT '',
  extraction text NOT NULL DEFAULT 'text_layer',
  confidence integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pages_owner_book_idx ON app.pages (owner_id, book_id);
CREATE INDEX pages_owner_chapter_idx ON app.pages (owner_id, chapter_id);

CREATE TABLE app.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  book_id uuid,
  space_id uuid,
  object_path text NOT NULL UNIQUE,
  file_name text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'image',
  mime text NOT NULL DEFAULT '',
  size bigint NOT NULL DEFAULT 0,
  stage text NOT NULL DEFAULT 'cover',
  status text NOT NULL DEFAULT 'pending',
  extraction jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_owner_book_idx ON app.documents (owner_id, book_id);

CREATE TABLE app.quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  space_id uuid,
  book_id uuid,
  chapter_id uuid,
  title text NOT NULL,
  questions jsonb NOT NULL,
  origin text NOT NULL DEFAULT 'ai',
  provider text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quizzes_owner_space_idx ON app.quizzes (owner_id, space_id);

CREATE TABLE app.quiz_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  quiz_id uuid NOT NULL,
  score integer NOT NULL DEFAULT 0,
  total integer NOT NULL DEFAULT 0,
  answers jsonb NOT NULL,
  duration_seconds integer NOT NULL DEFAULT 0,
  client_key uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX quiz_results_owner_quiz_idx ON app.quiz_results (owner_id, quiz_id);

CREATE TABLE app.study_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  space_id uuid,
  mode text NOT NULL DEFAULT 'deep',
  planned_minutes integer NOT NULL DEFAULT 25,
  minutes integer NOT NULL DEFAULT 0,
  completed boolean NOT NULL DEFAULT false,
  break_shown boolean NOT NULL DEFAULT false,
  client_key uuid UNIQUE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX study_sessions_owner_started_idx ON app.study_sessions (owner_id, started_at);

CREATE TABLE app.learning_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  space_id uuid,
  kind text NOT NULL,
  topic text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX learning_history_owner_space_idx ON app.learning_history (owner_id, space_id);

CREATE TABLE app.providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  api_name text NOT NULL,
  provider_key text NOT NULL,
  base_url text NOT NULL,
  wire text NOT NULL DEFAULT 'openai',
  key_cipher text NOT NULL,
  key_hint text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  billing_ack boolean NOT NULL DEFAULT false,
  last_status text NOT NULL DEFAULT 'untested',
  last_error text NOT NULL DEFAULT '',
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, provider_key)
);
CREATE INDEX providers_owner_idx ON app.providers (owner_id);

CREATE TABLE app.models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  provider_id uuid NOT NULL,
  model_id text NOT NULL,
  model_name text NOT NULL DEFAULT '',
  tier text NOT NULL DEFAULT 'economy',
  vision boolean NOT NULL DEFAULT false,
  input_micro_per_1k integer NOT NULL DEFAULT 0,
  output_micro_per_1k integer NOT NULL DEFAULT 0,
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  fail_streak integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  cooldown_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, provider_id, model_id)
);
CREATE INDEX models_owner_provider_idx ON app.models (owner_id, provider_id);

CREATE TABLE app.ai_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  space_id uuid,
  provider_key text NOT NULL DEFAULT '',
  model_id text NOT NULL DEFAULT '',
  purpose text NOT NULL DEFAULT 'chat',
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_micro bigint NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  ok boolean NOT NULL DEFAULT true,
  cached boolean NOT NULL DEFAULT false,
  failure text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_owner_created_idx ON app.ai_usage (owner_id, created_at);

CREATE TABLE app.ai_cache (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  fingerprint text NOT NULL UNIQUE,
  response text NOT NULL,
  hits integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL UNIQUE,
  balance integer NOT NULL DEFAULT 0,
  earned integer NOT NULL DEFAULT 0,
  spent integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  direction text NOT NULL,
  amount integer NOT NULL,
  balance_after integer NOT NULL DEFAULT 0,
  reason text NOT NULL,
  label text NOT NULL DEFAULT '',
  meta jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, reason)
);
CREATE INDEX transactions_owner_created_idx ON app.transactions (owner_id, created_at);

CREATE TABLE app.achievements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  code text NOT NULL,
  title text NOT NULL,
  reward integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, code)
);
CREATE INDEX achievements_owner_idx ON app.achievements (owner_id);

CREATE TABLE app.daily_states (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  day text NOT NULL,
  question_id integer NOT NULL DEFAULT 0,
  login_claimed boolean NOT NULL DEFAULT false,
  answered boolean NOT NULL DEFAULT false,
  correct boolean NOT NULL DEFAULT false,
  sessions integer NOT NULL DEFAULT 0,
  goal_minutes integer NOT NULL DEFAULT 0,
  goal_done boolean NOT NULL DEFAULT false,
  challenge_done boolean NOT NULL DEFAULT false,
  challenge_code text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, day)
);

CREATE TABLE app.streaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL UNIQUE,
  current integer NOT NULL DEFAULT 0,
  longest integer NOT NULL DEFAULT 0,
  last_day text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.game_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  game text NOT NULL,
  difficulty text NOT NULL DEFAULT 'easy',
  state jsonb NOT NULL,
  score integer NOT NULL DEFAULT 0,
  best_score integer NOT NULL DEFAULT 0,
  rounds integer NOT NULL DEFAULT 0,
  duration_ms integer NOT NULL DEFAULT 0,
  reward integer NOT NULL DEFAULT 0,
  finished boolean NOT NULL DEFAULT false,
  client_key uuid UNIQUE,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX game_sessions_owner_game_idx ON app.game_sessions (owner_id, game);

CREATE TABLE app.history_deletes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  scope text NOT NULL,
  removed integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
