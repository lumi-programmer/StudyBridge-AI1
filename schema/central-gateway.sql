-- StudyBridge AI — Central AI Gateway + Bridge Credits economy migration.
--
-- Apply AFTER schema/studybridge.sql. It uses only the supported migration
-- subset used by the base schema: CREATE TABLE app.<t>, plain CREATE INDEX,
-- types boolean/integer/bigint/text/uuid/timestamptz/jsonb and defaults of
-- literals, gen_random_uuid() or now().
--
-- What already exists and is reused rather than duplicated:
--   app.wallets            = student_wallets   (balance, earned, spent)
--   app.transactions       = credit_transactions (append-only ledger)
--   app.streaks            = study_streaks     (server-side day counters)
--   app.achievements       = the achievement ledger
--   app.daily_states       = the per-day claim state
--   app.providers / models = the student's OWN provider keys (BYOK)
--   app.ai_usage           = the per-request usage log
--
-- What this migration adds is the platform side of the same economy:
--   app.user_roles          = who may use the administrator sections
--   app.ai_providers        = platform-owned providers (not a student's own key)
--   app.ai_models           = the approved free-model registry
--   app.ai_requests         = reservation / settlement / refund lifecycle
--   app.ai_usage_limits     = limits adjustable without a redeploy
--   app.provider_health_logs= the health history behind the admin dashboard
--   app.reward_claims       = which reward was claimed, in which period
--   app.economy_settings    = reward amounts, AI prices and enable flags

-- Role-based authorisation. The role lives here instead of on app.profiles so
-- the base schema is never altered; only the Function writes this table.
CREATE TABLE app.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL UNIQUE,
  role text NOT NULL DEFAULT 'student',
  granted_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Platform-owned providers. A student never sees a row here and never holds
-- the key: the Function decrypts it for one outbound request and nothing else.
CREATE TABLE app.ai_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL UNIQUE,
  name text NOT NULL,
  base_url text NOT NULL,
  wire text NOT NULL DEFAULT 'openai',
  key_cipher text NOT NULL,
  key_hint text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  -- free_only is a promise the router keeps: a provider row may only be used
  -- for models whose pricing the registry has verified as zero.
  free_only boolean NOT NULL DEFAULT true,
  daily_quota integer NOT NULL DEFAULT 0,
  last_status text NOT NULL DEFAULT 'untested',
  last_error text NOT NULL DEFAULT '',
  checked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_providers_enabled_idx ON app.ai_providers (enabled);

-- The approved model registry. A model may only be selected when it is free
-- (free_tier), its zero pricing was actually checked (pricing_verified), the
-- provider published it (available) and an administrator enabled it (enabled).
CREATE TABLE app.ai_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL,
  model_id text NOT NULL,
  display_name text NOT NULL DEFAULT '',
  input_micro_per_1k integer NOT NULL DEFAULT 0,
  output_micro_per_1k integer NOT NULL DEFAULT 0,
  free_tier boolean NOT NULL DEFAULT false,
  pricing_verified boolean NOT NULL DEFAULT false,
  pricing_source text NOT NULL DEFAULT '',
  context_window integer NOT NULL DEFAULT 0,
  capabilities jsonb NOT NULL,
  available boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  -- A router (OpenRouter's "openrouter/free") is not priced itself: it picks a
  -- model per request. It may only answer when the model it picked is on the
  -- verified-free list, and that is checked on every answer, not once.
  router boolean NOT NULL DEFAULT false,
  fail_streak integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  cooldown_reason text NOT NULL DEFAULT '',
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_id, model_id)
);
CREATE INDEX ai_models_provider_idx ON app.ai_models (provider_id);
CREATE INDEX ai_models_selectable_idx ON app.ai_models (enabled, available, pricing_verified);

-- One row per AI request. The reservation, the settlement and the refund are
-- all recorded here, and (owner_id, request_key) is unique: a repeated click
-- with the same key replays the first outcome instead of spending twice.
CREATE TABLE app.ai_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  request_key text NOT NULL,
  feature text NOT NULL,
  credits integer NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'reserved',
  provider_key text NOT NULL DEFAULT '',
  model_id text NOT NULL DEFAULT '',
  status_code integer NOT NULL DEFAULT 0,
  detail text NOT NULL DEFAULT '',
  -- Which try this was. A retry of a failed request gets attempt 2, and so its
  -- own debit and its own refund: the ledger reason is "ai:<key>:<attempt>".
  attempt integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  UNIQUE (owner_id, request_key)
);
CREATE INDEX ai_requests_owner_created_idx ON app.ai_requests (owner_id, created_at);
CREATE INDEX ai_requests_state_idx ON app.ai_requests (state, created_at);

-- The daily allowance, one row per question a student has used on a given
-- Pakistan calendar day. The unique constraint on (owner_id, day, slot) is
-- what makes the cap hold under concurrency: two requests that arrive at the
-- same moment both try to take the same slot and only one of them gets it.
-- A slot is released again when the question fails, so a failed request never
-- consumes the allowance.
CREATE TABLE app.ai_daily_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  day text NOT NULL,
  slot integer NOT NULL,
  request_key text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, day, slot)
);
CREATE INDEX ai_daily_slots_owner_day_idx ON app.ai_daily_slots (owner_id, day);

-- Limits an administrator can change without a frontend or backend deploy.
CREATE TABLE app.ai_usage_limits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope text NOT NULL,
  limit_key text NOT NULL,
  limit_value integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope, limit_key)
);

-- The health history behind the AI provider monitoring dashboard.
CREATE TABLE app.provider_health_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_key text NOT NULL DEFAULT '',
  model_id text NOT NULL DEFAULT '',
  ok boolean NOT NULL DEFAULT true,
  status_code integer NOT NULL DEFAULT 0,
  latency_ms integer NOT NULL DEFAULT 0,
  detail text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_health_created_idx ON app.provider_health_logs (created_at);
CREATE INDEX provider_health_provider_idx ON app.provider_health_logs (provider_key, created_at);

-- Which reward a student actually claimed, and in which period. The unique
-- constraint is what makes a second claim of the same reward a no-op.
CREATE TABLE app.reward_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  code text NOT NULL,
  period text NOT NULL,
  amount integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, code, period)
);
CREATE INDEX reward_claims_owner_idx ON app.reward_claims (owner_id, created_at);

-- The economy controls: reward amounts, AI feature prices, enable flags and
-- the shared daily quota. One row per control, so changing a price is a data
-- edit and never a schema change or a redeploy.
CREATE TABLE app.economy_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
