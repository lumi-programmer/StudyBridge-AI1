// Bridge Credits ledger. Every balance change is a server-side transaction:
// one append-only ledger row keyed by a deterministic reason, then a
// compare-and-set on the wallet row. The browser never submits a balance.
import { ACHIEVEMENTS, QUESTION_BANK, WEEKLY_CHALLENGES } from './content.mjs';
import { addDays, dayOf, dayOfIso, daysBetween, hashInt, nextResetIso, nowIso, weekKey } from './util.mjs';

const ACH_BY_CODE = new Map(ACHIEVEMENTS.map(a => [a.code, a]));

// The published "regular daily earnings" ceiling: login, daily question, the two
// qualifying sessions, the daily goal and the daily challenge add up to more than
// 90 if every one is claimed, so the ledger enforces the cap rather than only
// advertising it. Achievements, games and weekly challenges are separate pools.
const DAILY_REGULAR_CAP = 90;
const REGULAR_DAILY_REASON = /^(login|dq|session|goal|dchallenge):/;

// A reservation that was never settled is treated as abandoned after this long.
// The window is long enough for a slow provider and short enough that a
// crashed request does not freeze a student's key for a whole day.
const RESERVATION_STALE_MS = 10 * 60 * 1000;

// The transaction type a ledger row carries, derived from its reason. The
// browser is shown this instead of a raw reason string.
export function txType(reason, meta) {
  const code = String(meta?.type || '');
  if (code) return code;
  const r = String(reason || '');
  if (r.startsWith('ai:')) return 'ai_usage';
  if (r.startsWith('refund:')) return 'refund';
  if (r.startsWith('login:')) return 'daily_reward';
  if (r.startsWith('dq:')) return 'learning_reward';
  if (r.startsWith('session:')) return 'learning_reward';
  if (r.startsWith('goal:')) return 'learning_reward';
  if (r.startsWith('dchallenge:')) return 'learning_reward';
  if (r.startsWith('weekly:')) return 'learning_reward';
  if (r.startsWith('ach:')) return r.includes('streak') ? 'streak_reward' : 'learning_reward';
  if (r.startsWith('spend:')) return 'ai_usage';
  return 'adjustment';
}

export function createRewards(ctx) {
  const { db, fail, rows } = ctx;
  // The economy holds the reward amounts and the on/off switches. It is
  // optional, so the ledger still works when no economy is configured.
  const economy = ctx.economy || null;

  async function regularToday(ownerId) {
    const day = dayOf();
    const recent = rows(await db.from('transactions')
      .select('id,reason,amount,created_at').eq('owner_id', ownerId).eq('direction', 'earn')
      .order('created_at', { ascending: false }).limit(300)) || [];
    return recent.filter(tx => dayOfIso(tx.created_at) === day && REGULAR_DAILY_REASON.test(String(tx.reason)))
      .reduce((sum, tx) => sum + (tx.amount || 0), 0);
  }

  async function ensureWallet(ownerId) {
    const created = rows(await db.from('wallets').insertIfAbsent(
      { id: crypto.randomUUID(), owner_id: ownerId, balance: 0, earned: 0, spent: 0, updated_at: nowIso() },
      { onConflict: 'owner_id' },
    ).select('id,balance,earned,spent'));
    if (created?.length) return created[0];
    const found = rows(await db.from('wallets').select('id,balance,earned,spent').eq('owner_id', ownerId).limit(1));
    if (!found?.length) fail('ledger_unavailable', 503);
    return found[0];
  }

  async function readTx(ownerId, reason) {
    const found = rows(await db.from('transactions')
      .select('id,direction,amount,balance_after,reason,label,created_at')
      .eq('owner_id', ownerId).eq('reason', reason).limit(1));
    return found?.[0] || null;
  }

  async function applyDelta(ownerId, { reason, label, amount, direction = 'earn', meta = {} }) {
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 100000) fail('invalid_reward', 400);
    if (!/^[a-z0-9_:.-]{1,120}$/.test(reason)) fail('invalid_reward', 400);
    await ensureWallet(ownerId);
    const duplicate = await readTx(ownerId, reason);
    if (duplicate) return { tx: duplicate, replayed: true };

    let credit = amount;
    let capNote = null;
    if (direction === 'earn' && REGULAR_DAILY_REASON.test(reason)) {
      const headroom = DAILY_REGULAR_CAP - await regularToday(ownerId);
      if (headroom <= 0) {
        return { tx: null, capped: true, cap_note: 'You have reached the 90 Bridge Credit limit for regular daily activity. Achievements, games and challenges still count.' };
      }
      if (credit > headroom) {
        credit = headroom;
        capNote = `Reduced to ${headroom} so the 90 Bridge Credit daily limit for regular activity is respected.`;
      }
    }

    const sign = direction === 'spend' ? -credit : credit;
    let wallet = await ensureWallet(ownerId);
    if (direction === 'spend' && wallet.balance < credit) fail('insufficient_credits', 409);

    const txId = crypto.randomUUID();
    const inserted = rows(await db.from('transactions').insertIfAbsent({
      id: txId, owner_id: ownerId, direction, amount: credit, balance_after: wallet.balance + sign,
      reason, label: String(label || '').slice(0, 120), meta, created_at: nowIso(),
    }, { onConflict: 'owner_id,reason' }).select('id,direction,amount,balance_after,reason,label,created_at'));

    if (!inserted?.length) {
      const winner = await readTx(ownerId, reason);
      if (winner) return { tx: winner, replayed: true };
      fail('ledger_unavailable', 503);
    }

    for (let attempt = 0; attempt < 25; attempt += 1) {
      const base = wallet.balance;
      const next = base + sign;
      if (next < 0) {
        await db.from('transactions').delete().eq('id', txId).eq('owner_id', ownerId);
        fail('insufficient_credits', 409);
      }
      const payload = {
        balance: next, updated_at: nowIso(),
        earned: direction === 'earn' ? wallet.earned + credit : wallet.earned,
        spent: direction === 'spend' ? wallet.spent + credit : wallet.spent,
      };
      const updated = rows(await db.from('wallets')
        .update(payload).eq('id', wallet.id).eq('balance', base)
        .select('id,balance,earned,spent'));
      if (updated?.length) {
        await db.from('transactions').update({ balance_after: next }).eq('id', txId).eq('owner_id', ownerId);
        return { tx: { ...inserted[0], balance_after: next }, wallet: updated[0], replayed: false, cap_note: capNote };
      }
      wallet = await ensureWallet(ownerId);
      // Several requests can land on the same wallet row at the same moment.
      // A short random pause breaks the lockstep, so one of them wins the row
      // instead of all of them retrying in step and never converging.
      await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 5)));
    }
    // A ledger row must not outlive a balance change that never happened: a
    // spend that did not move the balance would make the history contradict
    // the wallet, and the sum would no longer be the balance.
    await db.from('transactions').delete().eq('id', txId).eq('owner_id', ownerId);
    fail('ledger_conflict', 409);
  }

  // ---- AI credit lifecycle: reserve, settle, refund ------------------------
  //
  // A priced AI request is three steps: reserve the credits, do the work, then
  // settle (the answer was delivered) or refund (it was not). The reservation
  // row is unique per (student, key), so a double click, a retry or two tabs
  // open at once can never spend the same credits twice.

  // A key that is safe to use inside a ledger reason and inside the request
  // table's unique constraint. Anything else becomes a fresh random key, which
  // means "no idempotency" rather than "a wrong key".
  function requestKeyOf(value) {
    const raw = String(value || '').trim().toLowerCase();
    const clean = raw.replace(/[^a-z0-9-]/g, '').slice(0, 60);
    if (clean.length >= 8) return clean;
    return crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  }

  async function aiRequestRow(ownerId, key) {
    const found = rows(await db.from('ai_requests')
      .select('id,request_key,feature,credits,state,attempt,provider_key,model_id,status_code,detail,created_at,settled_at')
      .eq('owner_id', ownerId).eq('request_key', key).limit(1));
    return found?.[0] || null;
  }

  // ---- the daily allowance -------------------------------------------------
  //
  // The cap on questions per Pakistan calendar day is a set of numbered slots.
  // The slot row is what makes the cap race-free: two requests that arrive in
  // the same moment both try to take slot 7, and the unique constraint on
  // (owner_id, day, slot) lets exactly one of them have it. Counting rows and
  // then inserting one cannot work, because both callers would read the same
  // count before either wrote anything.
  //
  // A slot is held only while the question is live: it is released when the
  // request fails, because a failed question must not consume the allowance.

  async function daySlots(ownerId, day) {
    return rows(await db.from('ai_daily_slots')
      .select('id,day,slot,request_key,created_at')
      .eq('owner_id', ownerId).eq('day', day).limit(64)) || [];
  }

  // Drop slots whose request is no longer live, so a request that died without
  // a refund does not keep a place in today's allowance for ever.
  async function pruneSlots(ownerId, day, slots, liveKeys) {
    const stale = slots.filter(slot => slot.request_key && !liveKeys.has(slot.request_key));
    for (const slot of stale) {
      await db.from('ai_daily_slots').delete().eq('id', slot.id).eq('owner_id', ownerId).eq('day', day);
    }
    return slots.filter(slot => !stale.includes(slot));
  }

  async function claimDailySlot(ownerId, max, requestKey) {
    const day = dayOf();
    const slots = await daySlots(ownerId, day);
    // A retry of a request that already holds a slot keeps that slot rather
    // than taking a second one.
    const held = slots.find(slot => slot.request_key && slot.request_key === requestKey);
    if (held) return { day, slot: held.slot, reused: true };
    for (let slot = 1; slot <= max; slot += 1) {
      const inserted = rows(await db.from('ai_daily_slots').insertIfAbsent({
        id: crypto.randomUUID(), owner_id: ownerId, day, slot, request_key: requestKey, created_at: nowIso(),
      }, { onConflict: 'owner_id,day,slot' }).select('id,slot'));
      if (inserted?.length) return { day, slot, reused: false };
    }
    return null;
  }

  async function releaseDailySlot(ownerId, requestKey) {
    if (!requestKey) return;
    const day = dayOf();
    await db.from('ai_daily_slots').delete().eq('owner_id', ownerId).eq('day', day).eq('request_key', requestKey);
  }

  // What the student has used today and what is left, in the words the
  // interface uses: questions used, questions remaining and the next reset.
  async function dailyUsage(ownerId) {
    const day = dayOf();
    const limits = economy ? await economy.limits() : null;
    const max = Number(limits?.daily_questions_per_student) || 0;
    const slots = await daySlots(ownerId, day);
    const used = slots.length;
    return {
      day,
      used,
      limit: max,
      remaining: max > 0 ? Math.max(0, max - used) : null,
      resets_at: nextResetIso(),
      time_zone: 'Asia/Karachi',
    };
  }

  // Reserve the credits for one AI request. The balance check and the debit
  // happen here, before the provider is contacted: a request that cannot be
  // paid for never reaches a model.
  async function reserveAi(ownerId, { feature = 'ai', requestKey = '', credits = 0, label = '' } = {}) {
    const key = requestKeyOf(requestKey);
    const amount = Number.isSafeInteger(credits) && credits > 0 ? credits : 0;
    const featureKey = String(feature || 'ai').slice(0, 40);

    // What the student has used today is read first, so a request that is
    // already over the allowance leaves no rows behind at all.
    let max = 0;
    if (economy && amount > 0) {
      const limits = await economy.limits();
      max = Number(limits.daily_questions_per_student) || 0;
    }

    // The slot is the authoritative count. It is claimed before the request
    // row is written, so the cap holds even when several requests arrive at
    // the same instant, and it is released again if the request fails.
    let slot = null;
    if (max > 0) {
      const day = dayOf();
      const slots = await daySlots(ownerId, day);
      const live = new Set((rows(await db.from('ai_requests')
        .select('request_key,state,created_at').eq('owner_id', ownerId).limit(200)) || [])
        .filter(row => dayOfIso(row.created_at) === day && (row.state === 'settled' || row.state === 'reserved'))
        .map(row => row.request_key));
      await pruneSlots(ownerId, day, slots, live);
      slot = await claimDailySlot(ownerId, max, key);
      if (!slot) {
        fail('daily_limit_reached', 429, `You have used all ${max} AI questions for today. The allowance returns at midnight Pakistan time. Free study tools, notes, quizzes from your own text, focus and games are unaffected.`);
      }
    }

    const inserted = rows(await db.from('ai_requests').insertIfAbsent({
      id: crypto.randomUUID(), owner_id: ownerId, request_key: key, feature: featureKey,
      credits: amount, state: 'reserved', provider_key: '', model_id: '', status_code: 0,
      detail: '', attempt: 1, created_at: nowIso(), settled_at: null,
    }, { onConflict: 'owner_id,request_key' })
      .select('id,request_key,feature,credits,state,attempt,created_at'));

    let record = inserted?.[0] || null;
    if (!record) {
      record = await aiRequestRow(ownerId, key);
      if (!record) fail('ledger_unavailable', 503);
      if (record.state === 'settled') {
        // Already answered and already paid for: replay, never charge again.
        if (slot) await releaseDailySlot(ownerId, key);
        return { key, credits: record.credits, state: 'settled', replayed: true, attempt: record.attempt, charged: false };
      }
      const age = Date.now() - Date.parse(String(record.created_at || ''));
      if (record.state === 'reserved' && age < RESERVATION_STALE_MS) {
        // The same request is already running. The second submit waits for the
        // first one's answer instead of paying for a second one.
        if (slot) await releaseDailySlot(ownerId, key);
        return { key, credits: record.credits, state: 'reserved', replayed: true, inFlight: true, attempt: record.attempt, charged: false };
      }
      // Refunded, failed or abandoned: this is a retry of the same request, so
      // it gets its own attempt number and its own debit.
      const attempt = (Number(record.attempt) || 1) + 1;
      const updated = rows(await db.from('ai_requests')
        .update({ state: 'reserved', attempt, credits: amount, detail: '', created_at: nowIso(), settled_at: null })
        .eq('id', record.id).eq('owner_id', ownerId).select('id'));
      if (!updated?.length) {
        if (slot) await releaseDailySlot(ownerId, key);
        fail('ledger_conflict', 409);
      }
      record = { ...record, attempt, credits: amount, state: 'reserved' };
    }

    if (amount > 0) {
      const reason = `ai:${key}:${record.attempt}`;
      let charged;
      try {
        charged = await applyDelta(ownerId, {
          reason,
          label: label || `AI: ${featureKey.replace(/_/g, ' ')}`,
          amount,
          direction: 'spend',
          meta: { type: 'ai_usage', feature: featureKey, request_key: key, attempt: record.attempt },
        });
      } catch (error) {
        // The debit did not happen, so nothing is owed and nothing may be
        // refunded later. The reservation is closed as failed, which frees the
        // key for a genuine retry instead of leaving it pending for the whole
        // stale window. The day's allowance is handed back with it.
        rows(await db.from('ai_requests')
          .update({ state: 'failed', detail: String(error?.code || 'charge_failed').slice(0, 300), settled_at: nowIso() })
          .eq('id', record.id).eq('owner_id', ownerId).select('id'));
        if (slot) await releaseDailySlot(ownerId, key);
        throw error;
      }
      if (charged.replayed) {
        // This attempt was already paid for. Nothing is taken a second time.
        return { key, credits: amount, state: 'reserved', replayed: true, attempt: record.attempt, charged: false };
      }
    }
    return { key, credits: amount, state: 'reserved', replayed: false, attempt: record.attempt, charged: amount > 0, slot: slot?.slot ?? null };
  }

  // The answer was delivered: the reservation becomes a settled charge. The
  // detail carries what was produced (a saved message id, a saved quiz id), so
  // a repeated request can show the same result instead of paying again.
  async function settleAi(ownerId, key, { providerKey = '', modelId = '', statusCode = 0, detail = '' } = {}) {
    const record = await aiRequestRow(ownerId, key);
    if (!record) return null;
    if (record.state === 'settled') return record;
    const updated = rows(await db.from('ai_requests').update({
      state: 'settled',
      provider_key: String(providerKey || '').slice(0, 64),
      model_id: String(modelId || '').slice(0, 128),
      status_code: Number(statusCode) || 0,
      detail: String(detail || '').slice(0, 300),
      settled_at: nowIso(),
    }).eq('id', record.id).eq('owner_id', ownerId).select('id,state,credits,attempt,detail'));
    return updated?.[0] || null;
  }

  // The work did not happen: the reserved credits go back. The refund is a
  // ledger row of its own, so the history still shows what happened. The day's
  // allowance is handed back too, because a failed question is not a used
  // question.
  async function refundAi(ownerId, key, { reason = '', feature = '' } = {}) {
    const record = await aiRequestRow(ownerId, key);
    if (!record) return { refunded: false, reason: 'no_request' };
    if (record.state === 'refunded') return { refunded: true, replayed: true, credits: record.credits };
    if (record.state === 'settled') return { refunded: false, settled: true, credits: record.credits };
    // A reservation that never took the credits is not refunded: giving the
    // money back would pay the student for a request that cost nothing. The
    // allowance it was holding is still released.
    if (record.state === 'failed') {
      await releaseDailySlot(ownerId, key);
      return { refunded: false, reason: 'not_charged', credits: record.credits };
    }
    const amount = Number(record.credits) || 0;
    if (amount > 0) {
      await applyDelta(ownerId, {
        reason: `refund:${key}:${record.attempt}`,
        label: `Refund: ${String(feature || record.feature || 'AI request').replace(/_/g, ' ')}`,
        amount,
        direction: 'earn',
        meta: { type: 'refund', feature: record.feature || feature, request_key: key, attempt: record.attempt, cause: String(reason || '').slice(0, 120) },
      });
    }
    rows(await db.from('ai_requests').update({
      state: 'refunded', detail: String(reason || '').slice(0, 300), settled_at: nowIso(),
    }).eq('id', record.id).eq('owner_id', ownerId).select('id'));
    await releaseDailySlot(ownerId, key);
    return { refunded: true, credits: amount };
  }

  // How many priced AI requests this student has already made today. Refunded
  // requests do not count: the student never paid for them. Neither do the
  // ones that were refused before the debit.
  async function chargedToday(ownerId) {
    const day = dayOf();
    const found = rows(await db.from('ai_requests')
      .select('id,feature,credits,state,created_at')
      .eq('owner_id', ownerId).order('created_at', { ascending: false }).limit(500)) || [];
    return found.filter(row => dayOfIso(row.created_at) === day
      && (Number(row.credits) || 0) > 0
      && row.state !== 'refunded'
      && row.state !== 'failed');
  }

  // One claim per reward per period, enforced by a unique constraint rather
  // than by a check that two tabs could race.
  async function claimReward(ownerId, code, period, amount) {
    const inserted = rows(await db.from('reward_claims').insertIfAbsent({
      id: crypto.randomUUID(), owner_id: ownerId,
      code: String(code || '').slice(0, 40), period: String(period || '').slice(0, 40),
      amount: Number(amount) || 0, created_at: nowIso(),
    }, { onConflict: 'owner_id,code,period' }).select('id,code,period,amount'));
    return { claimed: Boolean(inserted?.length), claim: inserted?.[0] || null };
  }

  async function claimPeriods(ownerId) {
    const found = rows(await db.from('reward_claims')
      .select('code,period,amount,created_at')
      .eq('owner_id', ownerId).order('created_at', { ascending: false }).limit(200)) || [];
    return found;
  }

  async function grantAchievement(ownerId, code) {
    const def = ACH_BY_CODE.get(code);
    if (!def) return null;
    const inserted = rows(await db.from('achievements').insertIfAbsent({
      id: crypto.randomUUID(), owner_id: ownerId, code, title: def.title, reward: def.reward, created_at: nowIso(),
    }, { onConflict: 'owner_id,code' }).select('id,code,title,reward,created_at'));
    if (!inserted?.length) return null;
    const result = await applyDelta(ownerId, {
      reason: `ach:${code}`, label: `Achievement: ${def.title}`, amount: def.reward, meta: { code },
    });
    return { awarded: inserted[0], tx: result.tx };
  }

  async function getOrCreateStreak(ownerId) {
    const inserted = rows(await db.from('streaks').insertIfAbsent({
      id: crypto.randomUUID(), owner_id: ownerId, current: 0, longest: 0, last_day: '', updated_at: nowIso(),
    }, { onConflict: 'owner_id' }).select('id,current,longest,last_day'));
    if (inserted?.length) return inserted[0];
    const found = rows(await db.from('streaks').select('id,current,longest,last_day').eq('owner_id', ownerId).limit(1));
    if (!found?.length) fail('streak_unavailable', 503);
    return found[0];
  }

  async function bumpStreak(ownerId, day) {
    let streak = await getOrCreateStreak(ownerId);
    if (streak.last_day === day) return streak;
    const gap = streak.last_day ? daysBetween(streak.last_day, day) : null;
    let current = streak.current;
    if (!streak.last_day) current = 1;
    else if (gap === 1) current = streak.current + 1;
    else if (gap === 0) current = streak.current;
    else current = 1;
    const longest = Math.max(streak.longest, current);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const updated = rows(await db.from('streaks')
        .update({ current, longest, last_day: day, updated_at: nowIso() })
        .eq('id', streak.id).eq('current', streak.current).eq('last_day', streak.last_day)
        .select('id,current,longest,last_day'));
      if (updated?.length) {
        for (const threshold of [3, 7, 14, 30]) {
          if (current >= threshold) await grantAchievement(ownerId, `streak_${threshold}`);
        }
        return updated[0];
      }
      streak = await getOrCreateStreak(ownerId);
      if (streak.last_day === day) return streak;
    }
    return streak;
  }

  async function touchDay(ownerId, day = dayOf()) {
    const questionId = hashInt(`question:${ownerId}:${day}`) % QUESTION_BANK.length;
    const challenge = WEEKLY_CHALLENGES[hashInt(`weekly:${weekKey(day)}`) % WEEKLY_CHALLENGES.length];
    const inserted = rows(await db.from('daily_states').insertIfAbsent({
      id: crypto.randomUUID(), owner_id: ownerId, day, question_id: questionId,
      login_claimed: false, answered: false, correct: false, sessions: 0, goal_minutes: 0,
      goal_done: false, challenge_done: false, challenge_code: challenge.code,
      created_at: nowIso(), updated_at: nowIso(),
    }, { onConflict: 'owner_id,day' })
      .select('id,day,question_id,login_claimed,answered,correct,sessions,goal_minutes,goal_done,challenge_done,challenge_code'));
    if (inserted?.length) return inserted[0];
    const found = rows(await db.from('daily_states')
      .select('id,day,question_id,login_claimed,answered,correct,sessions,goal_minutes,goal_done,challenge_done,challenge_code')
      .eq('owner_id', ownerId).eq('day', day).limit(1));
    if (!found?.length) fail('daily_unavailable', 503);
    return found[0];
  }

  async function patchDay(ownerId, state, patch) {
    const updated = rows(await db.from('daily_states').update({ ...patch, updated_at: nowIso() })
      .eq('id', state.id).eq('owner_id', ownerId).eq('day', state.day)
      .select('id,day,question_id,login_claimed,answered,correct,sessions,goal_minutes,goal_done,challenge_done,challenge_code'));
    if (!updated?.length) fail('daily_conflict', 409);
    return updated[0];
  }

  // Daily challenge: one answered question plus one finished session on the
  // same calendar day. Derived from recorded activity, never self-declared.
  async function maybeDailyChallenge(ownerId, state) {
    if (state.challenge_done) return state;
    if (!state.answered || state.sessions < 1) return state;
    const amount = await rewardFor('daily_challenge', 15);
    if (amount > 0) {
      await applyDelta(ownerId, { reason: `dchallenge:${state.day}`, label: 'Daily challenge complete', amount, meta: { day: state.day, type: 'learning_reward' } });
    }
    return patchDay(ownerId, state, { challenge_done: true });
  }

  async function addDayMinutes(ownerId, state, minutes) {
    const goal = await goalTarget(ownerId);
    const total = state.goal_minutes + minutes;
    let next = await patchDay(ownerId, state, { goal_minutes: total });
    if (!next.goal_done && total >= goal) {
      const amount = await rewardFor('daily_goal', 20);
      if (amount > 0) {
        await applyDelta(ownerId, { reason: `goal:${state.day}`, label: 'Daily learning goal met', amount, meta: { goal, day: state.day, type: 'learning_reward' } });
      }
      next = await patchDay(ownerId, next, { goal_done: true });
    }
    if (total >= 60) await grantAchievement(ownerId, 'milestone_60min');
    return next;
  }

  async function goalTarget(ownerId) {
    const found = rows(await db.from('profiles').select('daily_goal_minutes').eq('owner_id', ownerId).limit(1));
    const v = found?.[0]?.daily_goal_minutes;
    return Number.isSafeInteger(v) && v > 0 ? v : 30;
  }

  // Weekly challenge evaluation, called after real activity is recorded.
  async function maybeWeeklyChallenge(ownerId, counters, day = dayOf()) {
    const challenge = WEEKLY_CHALLENGES[hashInt(`weekly:${weekKey(day)}`) % WEEKLY_CHALLENGES.length];
    const achieved = (counters[challenge.metric] || 0) >= challenge.target;
    if (!achieved) return { challenge, done: false };
    const existing = await readTx(ownerId, `weekly:${weekKey(day)}`);
    if (!existing) {
      const amount = await rewardFor('weekly_goal', 50);
      if (amount > 0) {
        await applyDelta(ownerId, {
          reason: `weekly:${weekKey(day)}`, label: `Weekly challenge: ${challenge.title}`,
          amount, meta: { code: challenge.code, week: weekKey(day), type: 'learning_reward' },
        });
      }
      await grantAchievement(ownerId, 'weekly_challenge');
    }
    return { challenge, done: true };
  }

  async function weekCounters(ownerId, day = dayOf()) {
    const start = weekKey(day);
    const sessions = rows(await db.from('study_sessions')
      .select('id,space_id,minutes,started_at').eq('owner_id', ownerId)
      .order('started_at', { ascending: false }).limit(500)) || [];
    const inWeek = sessions.filter(s => (dayOfIso(s.started_at) || '') >= start);
    const quizzes = rows(await db.from('quiz_results').select('id,created_at').eq('owner_id', ownerId)
      .order('created_at', { ascending: false }).limit(300)) || [];
    const pages = rows(await db.from('pages').select('id,created_at').eq('owner_id', ownerId)
      .order('created_at', { ascending: false }).limit(400)) || [];
    const games = rows(await db.from('game_sessions').select('id,started_at').eq('owner_id', ownerId)
      .order('started_at', { ascending: false }).limit(300)) || [];
    const cut = iso => (dayOfIso(iso) || '') >= start;
    return {
      minutes: inWeek.reduce((sum, s) => sum + (s.minutes || 0), 0),
      quizzes: quizzes.filter(q => cut(q.created_at)).length,
      pages: pages.filter(p => cut(p.created_at)).length,
      spaces: new Set(inWeek.filter(s => s.space_id).map(s => s.space_id)).size,
      games: games.filter(g => cut(g.started_at)).length,
    };
  }

  async function calendar(ownerId, days = 35, today = dayOf()) {
    const from = addDays(today, -(days - 1));
    const states = rows(await db.from('daily_states')
      .select('day,login_claimed,answered,correct,sessions,goal_minutes,goal_done,challenge_done')
      .eq('owner_id', ownerId).order('day', { ascending: false }).limit(120)) || [];
    const txRows = rows(await db.from('transactions').select('created_at,amount,reason,direction')
      .eq('owner_id', ownerId).order('created_at', { ascending: false }).limit(200)) || [];
    const earnedByDay = new Map();
    for (const t of txRows) {
      if (t.direction !== 'earn') continue;
      const d = dayOfIso(t.created_at);
      earnedByDay.set(d, (earnedByDay.get(d) || 0) + t.amount);
    }
    const byDay = new Map(states.filter(s => s.day >= from).map(s => [s.day, s]));
    const out = [];
    for (let i = 0; i < days; i += 1) {
      const day = addDays(from, i);
      const s = byDay.get(day);
      out.push({
        day,
        minutes: s?.goal_minutes || 0,
        sessions: s?.sessions || 0,
        answered: Boolean(s?.answered),
        correct: Boolean(s?.correct),
        login: Boolean(s?.login_claimed),
        goalDone: Boolean(s?.goal_done),
        challengeDone: Boolean(s?.challenge_done),
        earned: earnedByDay.get(day) || 0,
      });
    }
    return out;
  }

  async function history(ownerId, limit = 40) {
    const size = Math.min(Math.max(limit, 1), 100);
    // Read one extra row to answer "is there more" without an unbounded count.
    const found = rows(await db.from('transactions')
      .select('id,direction,amount,balance_after,reason,label,meta,created_at')
      .eq('owner_id', ownerId).order('created_at', { ascending: false }).limit(size + 1)) || [];
    return {
      items: found.slice(0, size).map(row => ({ ...row, type: txType(row.reason, row.meta) })),
      hasMore: found.length > size,
    };
  }

  // The amount a reward pays today. An administrator can change it, or switch
  // the reward off entirely, without a redeploy; zero means "not paid".
  async function rewardFor(code, fallback) {
    if (!economy) return fallback;
    const flags = await economy.rewardFlags();
    if (flags[code] === false) return 0;
    const table = await economy.rewards();
    const amount = table[code];
    return Number.isSafeInteger(amount) && amount >= 0 ? amount : fallback;
  }

  return {
    applyDelta, ensureWallet, readTx, grantAchievement, bumpStreak, touchDay, patchDay,
    addDayMinutes, maybeDailyChallenge, maybeWeeklyChallenge, weekCounters, calendar, history, goalTarget,
    reserveAi, settleAi, refundAi, chargedToday, claimReward, claimPeriods, rewardFor,
    dailyUsage, releaseDailySlot,
    aiRequest: aiRequestRow,
  };
}
