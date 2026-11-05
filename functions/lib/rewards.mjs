// Bridge Credits ledger. Every balance change is a server-side transaction:
// one append-only ledger row keyed by a deterministic reason, then a
// compare-and-set on the wallet row. The browser never submits a balance.
import { ACHIEVEMENTS, QUESTION_BANK, WEEKLY_CHALLENGES } from './content.mjs';
import { addDays, dayOf, daysBetween, hashInt, nowIso, weekKey } from './util.mjs';

const ACH_BY_CODE = new Map(ACHIEVEMENTS.map(a => [a.code, a]));

// The published "regular daily earnings" ceiling: login, daily question, the two
// qualifying sessions, the daily goal and the daily challenge add up to more than
// 90 if every one is claimed, so the ledger enforces the cap rather than only
// advertising it. Achievements, games and weekly challenges are separate pools.
const DAILY_REGULAR_CAP = 90;
const REGULAR_DAILY_REASON = /^(login|dq|session|goal|dchallenge):/;

export function createRewards(ctx) {
  const { db, fail, rows } = ctx;

  async function regularToday(ownerId) {
    const day = dayOf();
    const recent = rows(await db.from('transactions')
      .select('id,reason,amount,created_at').eq('owner_id', ownerId).eq('direction', 'earn')
      .order('created_at', { ascending: false }).limit(300)) || [];
    return recent.filter(tx => String(tx.created_at).slice(0, 10) === day && REGULAR_DAILY_REASON.test(String(tx.reason)))
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

    for (let attempt = 0; attempt < 6; attempt += 1) {
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
    }
    fail('ledger_conflict', 409);
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
    await applyDelta(ownerId, { reason: `dchallenge:${state.day}`, label: 'Daily challenge complete', amount: 15, meta: { day: state.day } });
    return patchDay(ownerId, state, { challenge_done: true });
  }

  async function addDayMinutes(ownerId, state, minutes) {
    const goal = await goalTarget(ownerId);
    const total = state.goal_minutes + minutes;
    let next = await patchDay(ownerId, state, { goal_minutes: total });
    if (!next.goal_done && total >= goal) {
      await applyDelta(ownerId, { reason: `goal:${state.day}`, label: 'Daily learning goal met', amount: 20, meta: { goal, day: state.day } });
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
      await applyDelta(ownerId, {
        reason: `weekly:${weekKey(day)}`, label: `Weekly challenge: ${challenge.title}`,
        amount: 50, meta: { code: challenge.code, week: weekKey(day) },
      });
      await grantAchievement(ownerId, 'weekly_challenge');
    }
    return { challenge, done: true };
  }

  async function weekCounters(ownerId, day = dayOf()) {
    const start = weekKey(day);
    const sessions = rows(await db.from('study_sessions')
      .select('id,space_id,minutes,started_at').eq('owner_id', ownerId)
      .order('started_at', { ascending: false }).limit(500)) || [];
    const inWeek = sessions.filter(s => String(s.started_at).slice(0, 10) >= start);
    const quizzes = rows(await db.from('quiz_results').select('id,created_at').eq('owner_id', ownerId)
      .order('created_at', { ascending: false }).limit(300)) || [];
    const pages = rows(await db.from('pages').select('id,created_at').eq('owner_id', ownerId)
      .order('created_at', { ascending: false }).limit(400)) || [];
    const games = rows(await db.from('game_sessions').select('id,started_at').eq('owner_id', ownerId)
      .order('started_at', { ascending: false }).limit(300)) || [];
    const cut = iso => String(iso).slice(0, 10) >= start;
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
      const d = String(t.created_at).slice(0, 10);
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
      .select('id,direction,amount,balance_after,reason,label,created_at')
      .eq('owner_id', ownerId).order('created_at', { ascending: false }).limit(size + 1)) || [];
    return { items: found.slice(0, size), hasMore: found.length > size };
  }

  return {
    applyDelta, ensureWallet, readTx, grantAchievement, bumpStreak, touchDay, patchDay,
    addDayMinutes, maybeDailyChallenge, maybeWeeklyChallenge, weekCounters, calendar, history, goalTarget,
  };
}
