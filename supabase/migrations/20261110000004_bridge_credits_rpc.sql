-- StudyBridge AI — Supabase migration 4 of 4: transactional Bridge Credits RPCs.
--
-- Applies after migrations 1-3. These functions reproduce, one-for-one, the
-- ledger semantics of functions/lib/rewards.mjs (applyDelta, reserveAi,
-- settleAi, refundAi and the daily-slot helpers) so Phase 2 can call them
-- from the server via supabase-js `.rpc()` and keep the same observable
-- behaviour the 660-test contract pins down.
--
-- Contract
--   * Every function returns jsonb and NEVER raises a business error. The
--     failure is a value: {"ok": false, "error": "<code>"}. This is deliberate:
--     a raised exception would abort the whole surrounding transaction, while
--     reserve_ai must persist a "failed" request row and release the daily slot
--     when the debit refuses — exactly what the JavaScript does when
--     applyDelta throws inside its own catch block.
--   * Each call is a single transaction. Wallet balance changes and their
--     ledger rows are written atomically: a ledger row can never exist without
--     its balance change, and a spend can never move the balance without its
--     ledger row. This strengthens the JavaScript flow, which reached the same
--     guarantee across several statements with compare-and-set retries.
--   * Concurrency: apply_delta locks the wallet row (SELECT ... FOR UPDATE),
--     serialising concurrent deltas on one wallet. That is the same guarantee
--     the JavaScript compare-and-set loop with 25 retries and jitter produced,
--     without the retry storm. reserve_ai/refund_ai lock the request row the
--     same way, so reserve and refund for one key cannot deadlock.
--   * Replay safety: UNIQUE (owner_id, reason) on the ledger is the backstop.
--     apply_delta checks for an existing row first and returns it as a replay
--     (nothing is charged twice); a lost race on the insert returns the
--     winner's row.
--   * Slot release scope (audit finding H-1): a replay of a settled or
--     in-flight request never releases the original request's consumed daily
--     slot. release_daily_slot takes an optional slot number and reserve_ai
--     only ever releases a slot it claimed itself; a failed charge releases
--     the exact held slot by number, and refund_ai still releases every slot
--     the key holds because the whole request is being undone.
--   * Asia/Karachi: every "day" is a Pakistan calendar day (UTC+5, no daylight
--     saving), computed with AT TIME ZONE 'Asia/Karachi'. For current dates
--     this is identical to the fixed +300-minute offset in util.mjs; stored
--     day strings are "YYYY-MM-DD" either way, so rows written by the
--     JavaScript and by these functions agree.
--   * SECURITY INVOKER (the default) with a fully qualified search_path: the
--     server calls with the service_role key, which holds EXECUTE below and
--     bypasses RLS. The functions are revoked from every browser role — a
--     student can never call apply_delta directly to award themselves credits.

-- ---------------------------------------------------------------------------
-- Time zone helpers (mirrors dayOf() / nextResetIso() in functions/lib/util.mjs)
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.karachi_day() RETURNS text
LANGUAGE sql STABLE SET search_path = ''
AS $fn$
  SELECT to_char(now() AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD');
$fn$;

-- The next Pakistan midnight as a UTC instant: when the daily allowance and
-- the daily login reward become available again.
CREATE FUNCTION app.karachi_next_reset() RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = ''
AS $fn$
  SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Karachi') + interval '1 day')
    AT TIME ZONE 'Asia/Karachi';
$fn$;

-- ---------------------------------------------------------------------------
-- apply_delta — the only door into the wallet. (rewards.mjs: applyDelta)
--
-- p_owner      wallet owner
-- p_reason     deterministic ledger key, ^[a-z0-9_:.-]{1,120}$; a repeated
--              reason replays the first outcome instead of charging again
-- p_label      history label, truncated to 120
-- p_amount     positive integer, 1..100000
-- p_direction  'earn' or 'spend'
-- p_meta       jsonb payload stored on the ledger row
--
-- Regular daily earn reasons (login:/dq:/session:/goal:/dchallenge:) are
-- capped at 90 per Pakistan day. When the cap is exhausted the reward becomes
-- {"ok": true, "capped": true} with no transaction; when partially exhausted
-- the credit is reduced and a cap_note explains it — never an error, because
-- a capped reward is not a failure of the request.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.apply_delta(
  p_owner text,
  p_reason text,
  p_label text DEFAULT '',
  p_amount integer DEFAULT NULL,
  p_direction text DEFAULT 'earn',
  p_meta jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = ''
AS $fn$
DECLARE
  v_wallet app.wallets%ROWTYPE;
  v_tx app.transactions%ROWTYPE;
  v_regular integer;
  v_headroom integer;
  v_credit integer;
  v_cap_note text := NULL;
  v_sign integer;
  v_next integer;
  v_earned integer;
  v_spent integer;
BEGIN
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount > 100000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_reward');
  END IF;
  IF p_direction IS NULL OR p_direction NOT IN ('earn', 'spend') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_reward');
  END IF;
  IF p_reason IS NULL OR p_reason !~ '^[a-z0-9_:.-]{1,120}$' THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_reward');
  END IF;

  -- ensureWallet: create the row if this is the student's first credit.
  INSERT INTO app.wallets (id, owner_id, balance, earned, spent, updated_at)
  VALUES (gen_random_uuid(), p_owner, 0, 0, 0, now())
  ON CONFLICT (owner_id) DO NOTHING;

  -- The row lock serialises concurrent ledger writes for this wallet.
  SELECT * INTO v_wallet FROM app.wallets WHERE owner_id = p_owner FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'ledger_unavailable');
  END IF;

  -- Replay: this exact reason was already paid once. Return what happened.
  SELECT * INTO v_tx FROM app.transactions
  WHERE owner_id = p_owner AND reason = p_reason
  LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true,
      'credits', v_tx.amount, 'balance', v_wallet.balance, 'transaction', to_jsonb(v_tx));
  END IF;

  v_credit := p_amount;
  IF p_direction = 'earn' AND p_reason ~ '^(login|dq|session|goal|dchallenge):' THEN
    -- Same window as regularToday(): the 300 most recent earn rows, filtered
    -- to today in Pakistan time.
    SELECT COALESCE(sum(t.amount), 0) INTO v_regular
    FROM (
      SELECT amount, reason, created_at FROM app.transactions
      WHERE owner_id = p_owner AND direction = 'earn'
      ORDER BY created_at DESC LIMIT 300
    ) t
    WHERE t.reason ~ '^(login|dq|session|goal|dchallenge):'
      AND to_char(t.created_at AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD') = app.karachi_day();
    v_headroom := 90 - v_regular;
    IF v_headroom <= 0 THEN
      RETURN jsonb_build_object('ok', true, 'capped', true, 'credits', 0,
        'cap_note', 'You have reached the 90 Bridge Credit limit for regular daily activity. Achievements, games and challenges still count.');
    END IF;
    IF v_credit > v_headroom THEN
      v_credit := v_headroom;
      v_cap_note := format('Reduced to %s so the 90 Bridge Credit daily limit for regular activity is respected.', v_headroom);
    END IF;
  END IF;

  v_sign := CASE WHEN p_direction = 'spend' THEN -v_credit ELSE v_credit END;
  v_next := v_wallet.balance + v_sign;
  IF p_direction = 'spend' AND v_wallet.balance < v_credit THEN
    RETURN jsonb_build_object('ok', false, 'error', 'insufficient_credits',
      'balance', v_wallet.balance, 'credits', v_credit);
  END IF;

  -- The ledger row and the wallet update live or die together: this function
  -- is one transaction, so an error anywhere removes both. The unique
  -- (owner_id, reason) constraint is the last word against double charges.
  INSERT INTO app.transactions
    (id, owner_id, direction, amount, balance_after, reason, label, meta, created_at)
  VALUES
    (gen_random_uuid(), p_owner, p_direction, v_credit, v_next, p_reason,
     left(COALESCE(p_label, ''), 120), COALESCE(p_meta, '{}'::jsonb), now())
  ON CONFLICT (owner_id, reason) DO NOTHING
  RETURNING * INTO v_tx;

  IF NOT FOUND THEN
    -- Another writer won the race for this reason; its outcome stands.
    SELECT * INTO v_tx FROM app.transactions
    WHERE owner_id = p_owner AND reason = p_reason LIMIT 1;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'error', 'ledger_unavailable');
    END IF;
    RETURN jsonb_build_object('ok', true, 'replayed', true,
      'credits', v_tx.amount, 'balance', v_wallet.balance, 'transaction', to_jsonb(v_tx));
  END IF;

  v_earned := CASE WHEN p_direction = 'earn' THEN v_wallet.earned + v_credit ELSE v_wallet.earned END;
  v_spent := CASE WHEN p_direction = 'spend' THEN v_wallet.spent + v_credit ELSE v_wallet.spent END;

  UPDATE app.wallets
  SET balance = v_next, earned = v_earned, spent = v_spent, updated_at = now()
  WHERE id = v_wallet.id;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'capped', false,
    'cap_note', v_cap_note, 'credits', v_credit,
    'balance', v_next, 'earned', v_earned, 'spent', v_spent,
    'transaction', to_jsonb(v_tx));
END
$fn$;

-- ---------------------------------------------------------------------------
-- Daily-slot helper (rewards.mjs: releaseDailySlot). The slot for a released
-- question is deleted, so a failed or refunded question never consumes the
-- day's allowance. Shared by reserve_ai and refund_ai.
--
-- With p_slot, exactly one row goes: a replay or a failure hands back only the
-- place that very call claimed, and cannot wipe the slot another concurrent
-- operation holds for the same key (audit finding H-1). Without p_slot (a
-- refund), every slot the key still holds goes, because the whole request is
-- being undone.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.release_daily_slot(p_owner text, p_request_key text, p_slot integer DEFAULT NULL) RETURNS void
LANGUAGE sql SET search_path = ''
AS $fn$
  DELETE FROM app.ai_daily_slots
  WHERE p_request_key <> ''
    AND owner_id = p_owner
    AND day = app.karachi_day()
    AND request_key = p_request_key
    AND (p_slot IS NULL OR slot = p_slot);
$fn$;

-- ---------------------------------------------------------------------------
-- reserve_ai — reserve the credits for one AI request. (rewards.mjs: reserveAi)
--
-- p_owner        student
-- p_feature      feature key, truncated to 40 ("chat", "quiz_gen", ...)
-- p_request_key  client idempotency key; normalised like requestKeyOf():
--                lowercased, [^a-z0-9-] stripped, max 60; anything shorter
--                than 8 characters becomes a fresh random key, which means
--                "no idempotency" rather than "a wrong key"
-- p_credits      price in Bridge Credits (0 = free request)
-- p_label        optional ledger label; default "AI: <feature with spaces>"
-- p_daily_max    the student's AI questions per Pakistan day, as the route
--                computes it (economy limit); 0 disables the daily cap
--
-- Outcomes (mirroring the JavaScript exactly):
--   request already settled            -> {"ok":true,"state":"settled","replayed":true,"charged":false}
--      (the settled request's daily slot stays consumed)
--   same request already in flight     -> {"ok":true,"replayed":true,"in_flight":true,"charged":false}
--      (reservation younger than 10 minutes; the second submit waits instead
--       of paying for a second answer, and the in-flight request keeps its
--       daily slot)
--   refunded/failed/stale reservation  -> attempt + 1, own debit, own refund
--   daily allowance exhausted          -> {"ok":false,"error":"daily_limit_reached"} and
--                                          no rows written at all
--   cannot pay                         -> request row marked "failed", the slot
--                                          this call held released by number,
--                                          {"ok":false,"error":"insufficient_credits"}
--   success                            -> {"ok":true,"state":"reserved","charged":true,"slot":n}
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.reserve_ai(
  p_owner text,
  p_feature text DEFAULT 'ai',
  p_request_key text DEFAULT '',
  p_credits integer DEFAULT 0,
  p_label text DEFAULT '',
  p_daily_max integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = ''
AS $fn$
DECLARE
  v_raw text;
  v_key text;
  v_feature text;
  v_amount integer := 0;
  v_max integer := COALESCE(p_daily_max, 0);
  v_day text;
  v_slot integer := NULL;
  -- True when this call claimed the slot itself. A slot that already existed —
  -- a retry or replay of a request that holds one — belongs to the original
  -- request and must never be released here (audit finding H-1).
  v_slot_fresh boolean := false;
  v_record app.ai_requests%ROWTYPE;
  v_attempt integer;
  v_reason text;
  v_charge jsonb;
  v_charged_ok boolean;
  v_replayed boolean;
BEGIN
  -- requestKeyOf: a key safe for a ledger reason and the unique constraint.
  v_raw := lower(COALESCE(p_request_key, ''));
  v_key := left(regexp_replace(v_raw, '[^a-z0-9-]', '', 'g'), 60);
  IF char_length(v_key) < 8 THEN
    v_key := replace(gen_random_uuid()::text, '-', '');
  END IF;
  IF p_credits IS NOT NULL AND p_credits > 0 THEN v_amount := p_credits; END IF;
  v_feature := left(COALESCE(NULLIF(COALESCE(p_feature, ''), ''), 'ai'), 40);

  -- The slot is the authoritative count of used questions. It is claimed
  -- before the request row is written, and the (owner_id, day, slot) unique
  -- constraint decides who wins when two requests arrive together.
  IF v_max > 0 AND v_amount > 0 THEN
    v_day := app.karachi_day();

    -- Drop slots whose request is no longer live, so a request that died
    -- without a refund does not keep a place in today's allowance for ever.
    DELETE FROM app.ai_daily_slots s
    WHERE s.owner_id = p_owner
      AND s.day = v_day
      AND s.request_key <> ''
      AND NOT EXISTS (
        SELECT 1 FROM app.ai_requests r
        WHERE r.owner_id = p_owner
          AND r.request_key = s.request_key
          AND r.state IN ('settled', 'reserved')
          AND to_char(r.created_at AT TIME ZONE 'Asia/Karachi', 'YYYY-MM-DD') = v_day
      );

    -- A retry of a request that already holds a slot keeps that slot.
    SELECT slot INTO v_slot FROM app.ai_daily_slots
    WHERE owner_id = p_owner AND day = v_day AND request_key = v_key
    LIMIT 1;

    IF v_slot IS NULL THEN
      FOR i IN 1..v_max LOOP
        BEGIN
          INSERT INTO app.ai_daily_slots (id, owner_id, day, slot, request_key, created_at)
          VALUES (gen_random_uuid(), p_owner, v_day, i, v_key, now());
          v_slot := i;
          v_slot_fresh := true;
          EXIT;
        EXCEPTION WHEN unique_violation THEN
          -- Another request took this slot; try the next number.
          NULL;
        END;
      END LOOP;
    END IF;

    IF v_slot IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'daily_limit_reached',
        'status', 429,
        'detail', format('You have used all %s AI questions for today. The allowance returns at midnight Pakistan time. Free study tools, notes, quizzes from your own text, focus and games are unaffected.', v_max),
        'limit', v_max, 'day', v_day);
    END IF;
  END IF;

  INSERT INTO app.ai_requests
    (id, owner_id, request_key, feature, credits, state, provider_key, model_id,
     status_code, detail, attempt, created_at, settled_at)
  VALUES
    (gen_random_uuid(), p_owner, v_key, v_feature, v_amount, 'reserved', '', '',
     0, '', 1, now(), NULL)
  ON CONFLICT (owner_id, request_key) DO NOTHING
  RETURNING * INTO v_record;

  IF NOT FOUND THEN
    -- The key already exists: replay or retry, decided by the stored state.
    SELECT * INTO v_record FROM app.ai_requests
    WHERE owner_id = p_owner AND request_key = v_key
    LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      IF v_slot_fresh THEN PERFORM app.release_daily_slot(p_owner, v_key, v_slot); END IF;
      RETURN jsonb_build_object('ok', false, 'error', 'ledger_unavailable');
    END IF;

    IF v_record.state = 'settled' THEN
      -- Already answered and already paid for: replay, never charge again.
      -- Only a slot this call claimed itself goes back; the settled request's
      -- own slot stays consumed, or repeating the key would bypass the cap.
      IF v_slot_fresh THEN PERFORM app.release_daily_slot(p_owner, v_key, v_slot); END IF;
      RETURN jsonb_build_object('ok', true, 'key', v_key,
        'credits', v_record.credits, 'state', 'settled', 'replayed', true,
        'attempt', v_record.attempt, 'charged', false, 'slot', NULL);
    END IF;

    IF v_record.state = 'reserved' AND v_record.created_at > now() - interval '10 minutes' THEN
      -- The same request is already running; the second submit waits for the
      -- first one's answer instead of paying for a second one. Only a slot
      -- this call claimed itself goes back, so the in-flight request keeps
      -- its place in the day's allowance.
      IF v_slot_fresh THEN PERFORM app.release_daily_slot(p_owner, v_key, v_slot); END IF;
      RETURN jsonb_build_object('ok', true, 'key', v_key,
        'credits', v_record.credits, 'state', 'reserved', 'replayed', true,
        'in_flight', true, 'attempt', v_record.attempt, 'charged', false, 'slot', NULL);
    END IF;

    -- Refunded, failed or abandoned: a retry of the same request, with its
    -- own attempt number and its own debit.
    v_attempt := COALESCE(v_record.attempt, 1) + 1;
    UPDATE app.ai_requests
    SET state = 'reserved', attempt = v_attempt, credits = v_amount,
        detail = '', created_at = now(), settled_at = NULL
    WHERE id = v_record.id AND owner_id = p_owner;
    IF NOT FOUND THEN
      IF v_slot_fresh THEN PERFORM app.release_daily_slot(p_owner, v_key, v_slot); END IF;
      RETURN jsonb_build_object('ok', false, 'error', 'ledger_conflict');
    END IF;
  ELSE
    v_attempt := 1;
  END IF;

  IF v_amount > 0 THEN
    v_reason := 'ai:' || v_key || ':' || v_attempt;
    v_charge := app.apply_delta(
      p_owner, v_reason,
      COALESCE(NULLIF(COALESCE(p_label, ''), ''), 'AI: ' || replace(v_feature, '_', ' ')),
      v_amount, 'spend',
      jsonb_build_object('type', 'ai_usage', 'feature', v_feature,
        'request_key', v_key, 'attempt', v_attempt));
    v_charged_ok := COALESCE((v_charge ->> 'ok')::boolean, false);
    v_replayed := COALESCE((v_charge ->> 'replayed')::boolean, false);

    IF NOT v_charged_ok THEN
      -- The debit did not happen, so nothing is owed and nothing may be
      -- refunded later. The reservation is closed as failed, which frees the
      -- key for a genuine retry instead of leaving it pending for the whole
      -- stale window. The day's allowance is handed back with it — by slot
      -- number, so a concurrent duplicate for the same key keeps its own.
      UPDATE app.ai_requests
      SET state = 'failed',
          detail = left(COALESCE(v_charge ->> 'error', 'charge_failed'), 300),
          settled_at = now()
      WHERE id = v_record.id AND owner_id = p_owner;
      IF v_slot IS NOT NULL THEN PERFORM app.release_daily_slot(p_owner, v_key, v_slot); END IF;
      RETURN jsonb_build_object('ok', false,
        'error', COALESCE(v_charge ->> 'error', 'charge_failed'),
        'key', v_key, 'attempt', v_attempt, 'credits', v_amount);
    END IF;

    IF v_replayed THEN
      -- This attempt was already paid for. Nothing is taken a second time.
      RETURN jsonb_build_object('ok', true, 'key', v_key, 'credits', v_amount,
        'state', 'reserved', 'replayed', true, 'attempt', v_attempt,
        'charged', false, 'slot', v_slot);
    END IF;
  END IF;

  RETURN jsonb_build_object('ok', true, 'key', v_key, 'credits', v_amount,
    'state', 'reserved', 'replayed', false, 'attempt', v_attempt,
    'charged', v_amount > 0, 'slot', v_slot);
END
$fn$;

-- ---------------------------------------------------------------------------
-- settle_ai — the answer was delivered. (rewards.mjs: settleAi)
-- The reservation becomes a settled charge; detail carries what was produced
-- (a saved message id, a saved quiz id) so a repeated request can show the
-- same result instead of paying again. Settling twice replays the record.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.settle_ai(
  p_owner text,
  p_request_key text,
  p_provider_key text DEFAULT '',
  p_model_id text DEFAULT '',
  p_status_code integer DEFAULT 0,
  p_detail text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = ''
AS $fn$
DECLARE
  v_record app.ai_requests%ROWTYPE;
  v_updated app.ai_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_record FROM app.ai_requests
  WHERE owner_id = p_owner AND request_key = p_request_key
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_request');
  END IF;
  IF v_record.state = 'settled' THEN
    RETURN jsonb_build_object('ok', true, 'replayed', true, 'request', to_jsonb(v_record));
  END IF;

  UPDATE app.ai_requests
  SET state = 'settled',
      provider_key = left(COALESCE(p_provider_key, ''), 64),
      model_id = left(COALESCE(p_model_id, ''), 128),
      status_code = COALESCE(p_status_code, 0),
      detail = left(COALESCE(p_detail, ''), 300),
      settled_at = now()
  WHERE id = v_record.id AND owner_id = p_owner
  RETURNING * INTO v_updated;

  RETURN jsonb_build_object('ok', true, 'replayed', false, 'request', to_jsonb(v_updated));
END
$fn$;

-- ---------------------------------------------------------------------------
-- refund_ai — the work did not happen. (rewards.mjs: refundAi)
-- The reserved credits go back as a ledger row of their own
-- (refund:<key>:<attempt>), the request row is marked refunded and the day's
-- allowance is handed back. A settled request is never refunded; a failed one
-- was never charged, so only its slot is released.
-- ---------------------------------------------------------------------------
CREATE FUNCTION app.refund_ai(
  p_owner text,
  p_request_key text,
  p_reason text DEFAULT '',
  p_feature text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = ''
AS $fn$
DECLARE
  v_record app.ai_requests%ROWTYPE;
  v_result jsonb;
  v_amount integer;
  v_feature text;
BEGIN
  SELECT * INTO v_record FROM app.ai_requests
  WHERE owner_id = p_owner AND request_key = p_request_key
  LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'reason', 'no_request');
  END IF;
  IF v_record.state = 'refunded' THEN
    RETURN jsonb_build_object('ok', true, 'refunded', true, 'replayed', true, 'credits', v_record.credits);
  END IF;
  IF v_record.state = 'settled' THEN
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'settled', true, 'credits', v_record.credits);
  END IF;
  IF v_record.state = 'failed' THEN
    -- A reservation that never took the credits is not refunded: giving the
    -- money back would pay the student for a request that cost nothing. The
    -- allowance it was holding is still released.
    PERFORM app.release_daily_slot(p_owner, v_record.request_key);
    RETURN jsonb_build_object('ok', true, 'refunded', false, 'reason', 'not_charged', 'credits', v_record.credits);
  END IF;

  v_feature := COALESCE(NULLIF(COALESCE(p_feature, ''), ''), v_record.feature, 'AI request');
  v_amount := COALESCE(v_record.credits, 0);
  IF v_amount > 0 THEN
    v_result := app.apply_delta(
      p_owner,
      'refund:' || v_record.request_key || ':' || v_record.attempt,
      'Refund: ' || replace(v_feature, '_', ' '),
      v_amount, 'earn',
      jsonb_build_object('type', 'refund', 'feature', v_record.feature,
        'request_key', v_record.request_key, 'attempt', v_record.attempt,
        'cause', left(COALESCE(p_reason, ''), 120)));
    IF NOT COALESCE((v_result ->> 'ok')::boolean, false) THEN
      RETURN jsonb_build_object('ok', false, 'error', COALESCE(v_result ->> 'error', 'refund_failed'));
    END IF;
  END IF;

  UPDATE app.ai_requests
  SET state = 'refunded', detail = left(COALESCE(p_reason, ''), 300), settled_at = now()
  WHERE id = v_record.id AND owner_id = p_owner;

  PERFORM app.release_daily_slot(p_owner, v_record.request_key);
  RETURN jsonb_build_object('ok', true, 'refunded', true,
    'replayed', COALESCE((v_result ->> 'replayed')::boolean, false),
    'credits', v_amount);
END
$fn$;

-- ---------------------------------------------------------------------------
-- The economy belongs to the server. No browser role may call any of these.
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION app.karachi_day() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.karachi_next_reset() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.apply_delta(text, text, text, integer, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.release_daily_slot(text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.reserve_ai(text, text, text, integer, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.settle_ai(text, text, text, text, integer, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION app.refund_ai(text, text, text, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION app.karachi_day() TO service_role;
GRANT EXECUTE ON FUNCTION app.karachi_next_reset() TO service_role;
GRANT EXECUTE ON FUNCTION app.apply_delta(text, text, text, integer, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION app.release_daily_slot(text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION app.reserve_ai(text, text, text, integer, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION app.settle_ai(text, text, text, text, integer, text) TO service_role;
GRANT EXECUTE ON FUNCTION app.refund_ai(text, text, text, text) TO service_role;
