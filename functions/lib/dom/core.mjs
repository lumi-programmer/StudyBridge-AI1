// Identity, preferences, daily engagement, wallet, achievements and analytics.
// Every number shown here is read back from recorded rows.
import { ACHIEVEMENTS, GAME_CATALOG, QUESTION_BANK, WEEKLY_CHALLENGES } from '../content.mjs';
import { ACTION_FEATURES, REWARD_CATALOGUE } from '../economy.mjs';
import { addDays, dayOf, dayOfIso, daysBetween, hashInt, monthKey, nextResetIso, nowIso, uuid as asUuid, weekKey } from '../util.mjs';

export function createCore({ add, db, fail, rows, rewards, ai, ensureProfile, limit, economy, roles, gateway }) {
  const publicQuestion = item => ({ id: null, subject: item.s, question: item.q, options: item.o });

  add('GET', '/api/health', async () => Response.json({ ok: true, service: 'studybridge', time: nowIso() }), { auth: false });

  add('GET', '/api/bootstrap', async ({ user }) => {
    const profile = await ensureProfile(user);
    const wallet = await rewards.ensureWallet(user.id);
    const streakRow = rows(await db.from('streaks').select('current,longest,last_day').eq('owner_id', user.id).limit(1))?.[0]
      || { current: 0, longest: 0, last_day: '' };
    const day = dayOf();
    const daily = await rewards.touchDay(user.id, day);
    const spaces = rows(await db.from('spaces')
      .select('id,name,subject,color,archived,updated_at').eq('owner_id', user.id).eq('archived', false)
      .order('updated_at', { ascending: false }).limit(6)) || [];
    const books = rows(await db.from('books')
      .select('id,title,author,subject,cover_object_path,updated_at').eq('owner_id', user.id)
      .order('updated_at', { ascending: false }).limit(6)) || [];
    const providers = rows(await db.from('providers').select('id,api_name,enabled,is_default,last_status')
      .eq('owner_id', user.id).limit(10)) || [];
    const models = rows(await db.from('models').select('id,provider_id,model_id,model_name,tier,is_default')
      .eq('owner_id', user.id).limit(40)) || [];
    const sessions = rows(await db.from('study_sessions').select('id,minutes,started_at,space_id')
      .eq('owner_id', user.id).order('started_at', { ascending: false }).limit(200)) || [];
    const todayMinutes = sessions.filter(s => dayOfIso(s.started_at) === day).reduce((a, s) => a + (s.minutes || 0), 0);
    const quizzesTaken = rows(await db.from('quiz_results').select('id').eq('owner_id', user.id).limit(300)) || [];
    // Compact so the shell can say what AI is actually reachable right now.
    const trial = await ai.trialStatus(user.id);
    // The prices and the daily limits are read here so the browser can show a
    // student what a request costs before they send it.
    const pricing = await economy.pricing();
    const limits = await economy.limits();
    const role = await roles.roleOf(user.id);
    return Response.json({
      identity: { id: user.id, name: user.name || profile.display_name || 'Student', picture: user.picture || '' },
      profile,
      wallet,
      streak: { ...streakRow, brokeOn: streakRow.last_day && daysBetween(streakRow.last_day, day) > 1 ? streakRow.last_day : null },
      daily: { ...daily, today: day, minutesToday: todayMinutes, question: publicQuestion(QUESTION_BANK[daily.question_id] || QUESTION_BANK[0]) },
      spaces,
      books,
      providers: { count: providers.length, default: providers.find(p => p.is_default) || null, models: models.length },
      trial: {
        configured: trial.configured,
        byok_connected: providers.length > 0,
        daily_limit: trial.daily_limit,
        remaining_today: trial.remaining_today,
        remaining_total: trial.remaining_total,
      },
      // What the student pays for each kind of AI request, and how many priced
      // requests are left today.
      economy: {
        pricing,
        limits,
        rewards: await economy.rewards(),
        // Which priced feature each study tool belongs to, so the button in the
        // browser shows the same price the ledger will charge.
        actions: ACTION_FEATURES,
        used_today: (await rewards.chargedToday(user.id)).length,
      },
      // The platform's own verified free models. A student does not need a key
      // of their own to use them, and no key is ever included here.
      free_models: gateway ? await gateway.status() : null,
      // The daily allowance: questions used, questions left and the moment the
      // counter returns to zero. All of it decided on the server.
      daily_ai: await rewards.dailyUsage(user.id),
      admin: { is_admin: role === 'admin', role },
      totals: { sessions: sessions.length, quizzes: quizzesTaken.length },
      games: GAME_CATALOG,
      server_day: day,
      next_reset: nextResetIso(),
      time_zone: 'Asia/Karachi',
    });
  });

  add('POST', '/api/profile', async ({ user, body }) => {
    const profile = await ensureProfile(user);
    const patch = {};
    const input = await body();
    if (input.display_name !== undefined) patch.display_name = String(input.display_name).trim().slice(0, 40);
    if (input.language !== undefined) patch.language = ['en', 'ur'].includes(input.language) ? input.language : 'en';
    if (input.theme !== undefined) patch.theme = ['light', 'dark', 'system'].includes(input.theme) ? input.theme : 'system';
    if (input.explanation_level !== undefined
      && ['beginner', 'simple', 'school', 'detailed', 'advanced', 'example'].includes(input.explanation_level)) {
      patch.explanation_level = input.explanation_level;
    }
    if (input.daily_goal_minutes !== undefined) {
      const minutes = Number(input.daily_goal_minutes);
      if (!Number.isSafeInteger(minutes) || minutes < 5 || minutes > 480) fail('invalid_input', 400);
      patch.daily_goal_minutes = minutes;
    }
    if (input.ai_limit_per_day !== undefined) {
      const cap = Number(input.ai_limit_per_day);
      if (!Number.isSafeInteger(cap) || cap < 10 || cap > 2000) fail('invalid_input', 400);
      patch.ai_limit_per_day = cap;
    }
    if (input.quick_break_suggestions !== undefined) patch.quick_break_suggestions = input.quick_break_suggestions === true;
    if (input.notifications !== undefined) {
      const wanted = ['daily_goal', 'daily_question', 'breaks', 'challenges', 'streak'];
      const clean = {};
      for (const key of wanted) clean[key] = Boolean(input.notifications?.[key]);
      patch.notification_prefs = clean;
    }
    if (input.onboarded !== undefined) patch.onboarded = input.onboarded === true;
    if (!Object.keys(patch).length) return Response.json(profile);
    patch.updated_at = nowIso();
    const updated = rows(await db.from('profiles').update(patch).eq('id', profile.id).eq('owner_id', user.id)
      .select('id,display_name,language,explanation_level,daily_goal_minutes,quick_break_suggestions,theme,notification_prefs,ai_limit_per_day,onboarded'));
    if (!updated?.length) fail('write_conflict', 409);
    return Response.json(updated[0]);
  });

  add('GET', '/api/daily', async ({ user, query }) => {
    const day = dayOf();
    const days = limit(query.get('days'), 21, 42);
    const profile = await ensureProfile(user);
    const daily = await rewards.touchDay(user.id, day);
    const streak = rows(await db.from('streaks').select('current,longest,last_day').eq('owner_id', user.id).limit(1))?.[0]
      || { current: 0, longest: 0, last_day: '' };
    const question = QUESTION_BANK[daily.question_id] || QUESTION_BANK[0];
    const challenge = WEEKLY_CHALLENGES.find(c => c.code === daily.challenge_code) || WEEKLY_CHALLENGES[0];
    const counters = await rewards.weekCounters(user.id, day);
    const sessions = rows(await db.from('study_sessions').select('id,minutes,started_at')
      .eq('owner_id', user.id).eq('completed', true).order('started_at', { ascending: false }).limit(60)) || [];
    const qualifying = sessions.filter(s => dayOfIso(s.started_at) === day);
    return Response.json({
      day,
      question: publicQuestion(question),
      answered: daily.answered,
      correct: daily.correct,
      explanation: daily.answered ? question.e : null,
      loginClaimed: daily.login_claimed,
      sessionsToday: qualifying.length,
      sessionRewardCap: 2,
      minutesToday: daily.goal_minutes,
      goalMinutes: profile.daily_goal_minutes,
      goalDone: daily.goal_done,
      dailyChallengeDone: daily.challenge_done,
      dailyChallenge: 'Answer today’s question and finish one focus session.',
      streak,
      weekly: { ...challenge, progress: counters[challenge.metric] || 0, done: Boolean(rows(await db.from('transactions').select('id')
        .eq('owner_id', user.id).eq('reason', `weekly:${weekKey(day)}`).limit(1))?.[0]) },
      calendar: await rewards.calendar(user.id, days, day),
      // The Pakistan day ends at midnight there, and that is the moment the
      // daily login reward and the question allowance come back.
      next_reset: nextResetIso(),
      time_zone: 'Asia/Karachi',
      daily_ai: await rewards.dailyUsage(user.id),
    });
  });

  add('POST', '/api/daily/login', async ({ user }) => {
    const day = dayOf();
    const daily = await rewards.touchDay(user.id, day);
    if (daily.login_claimed) return Response.json({ claimed: false, reason: 'already_claimed', balance: (await rewards.ensureWallet(user.id)).balance });
    const amount = await rewards.rewardFor('daily_login', 30);
    // The claim row is the record of the claim. Its unique constraint is what
    // makes a second claim of the same day a no-op, even from two tabs.
    const claim = await rewards.claimReward(user.id, 'daily_login', day, amount);
    if (!claim.claimed) return Response.json({ claimed: false, reason: 'already_claimed', balance: (await rewards.ensureWallet(user.id)).balance });
    let result = null;
    if (amount > 0) {
      result = await rewards.applyDelta(user.id, { reason: `login:${day}`, label: 'Daily login', amount, meta: { day, type: 'daily_reward' } });
    }
    await db.from('daily_states').update({ login_claimed: true, updated_at: nowIso() })
      .eq('id', daily.id).eq('owner_id', user.id).eq('day', day).select('id');
    const refreshed = await rewards.touchDay(user.id, day);
    const challenge = await rewards.maybeDailyChallenge(user.id, refreshed);
    const balance = (await rewards.ensureWallet(user.id)).balance;
    if (amount <= 0) {
      return Response.json({
        claimed: false, reason: 'reward_disabled', credits: 0, daily: challenge, balance,
        note: 'The daily login reward is switched off at the moment, so nothing was paid today.',
      });
    }
    return Response.json({
      claimed: true,
      credits: amount,
      tx: result?.tx || null,
      cap_note: result?.cap_note || null,
      daily: challenge,
      balance,
    });
  });

  add('POST', '/api/daily/answer', async ({ user, body }) => {
    const day = dayOf();
    const daily = await rewards.touchDay(user.id, day);
    if (daily.answered) return Response.json({ already: true, correct: daily.correct, explanation: (QUESTION_BANK[daily.question_id] || {}).e });
    const input = await body();
    const choice = Number(input.choice);
    const question = QUESTION_BANK[daily.question_id] || QUESTION_BANK[0];
    if (!Number.isInteger(choice) || choice < 0 || choice >= question.o.length) fail('invalid_input', 400);
    const correct = choice === question.a;
    let tx = null;
    let credits = 0;
    if (correct) {
      credits = await rewards.rewardFor('daily_question', 10);
      const claim = await rewards.claimReward(user.id, 'daily_question', day, credits);
      if (claim.claimed && credits > 0) {
        const awarded = await rewards.applyDelta(user.id, { reason: `dq:${day}`, label: 'Daily learning question', amount: credits, meta: { day, type: 'learning_reward' } });
        tx = awarded.tx;
      }
    }
    await db.from('daily_states').update({ answered: true, correct, updated_at: nowIso() })
      .eq('id', daily.id).eq('owner_id', user.id).eq('day', day).select('id');
    const refreshed = await rewards.touchDay(user.id, day);
    if (correct) await rewards.bumpStreak(user.id, day);
    const challenge = await rewards.maybeDailyChallenge(user.id, refreshed);
    return Response.json({
      correct,
      explanation: question.e,
      answer_index: question.a,
      tx,
      credits,
      daily: challenge,
      balance: (await rewards.ensureWallet(user.id)).balance,
    });
  });

  add('GET', '/api/achievements', async ({ user }) => {
    const earned = rows(await db.from('achievements').select('code,title,reward,created_at')
      .eq('owner_id', user.id).order('created_at', { ascending: false }).limit(60)) || [];
    const earnedCodes = new Set(earned.map(e => e.code));
    return Response.json({
      earned,
      catalogue: ACHIEVEMENTS.map(a => ({ code: a.code, title: a.title, reward: a.reward, earned: earnedCodes.has(a.code) })),
    });
  });

  // The Rewards Center: what each reward pays, whether an administrator has
  // switched it on, and whether this student has already claimed it in the
  // current period. Nothing here is claimable twice: the claim rows are the
  // same rows the ledger used.
  add('GET', '/api/rewards', async ({ user }) => {
    const day = dayOf();
    const week = weekKey(day);
    const claims = await rewards.claimPeriods(user.id);
    const claimedFor = (code, prefix) => claims.some(claim => claim.code === code && String(claim.period).startsWith(prefix));
    const rewardTable = await economy.rewards();
    const flags = await economy.rewardFlags();
    const streak = rows(await db.from('streaks').select('current,longest,last_day').eq('owner_id', user.id).limit(1))?.[0]
      || { current: 0, longest: 0, last_day: '' };
    const state = rows(await db.from('daily_states')
      .select('day,answered,correct,sessions,goal_minutes,goal_done,challenge_done,login_claimed')
      .eq('owner_id', user.id).eq('day', day).limit(1))?.[0] || {};
    const profile = await ensureProfile(user);
    const goalTarget = Number(profile.daily_goal_minutes) > 0 ? Number(profile.daily_goal_minutes) : 30;
    const counters = await rewards.weekCounters(user.id, day);
    const weekly = WEEKLY_CHALLENGES[hashInt(`weekly:${week}`) % WEEKLY_CHALLENGES.length];
    const achievements = new Set((rows(await db.from('achievements').select('code').eq('owner_id', user.id).limit(120)) || []).map(a => a.code));
    const wallet = await rewards.ensureWallet(user.id);

    const catalogue = REWARD_CATALOGUE.map(reward => {
      const enabled = flags[reward.code] !== false;
      const amount = enabled && Number.isSafeInteger(rewardTable[reward.code]) ? rewardTable[reward.code] : (enabled ? reward.amount : 0);
      let claimed = false;
      let progress = '';
      if (reward.code === 'daily_login') { claimed = claimedFor('daily_login', day); progress = claimed ? 'Claimed today' : 'Ready to claim'; }
      else if (reward.code === 'daily_question') { claimed = claimedFor('daily_question', day); progress = state.correct ? 'Answered correctly today' : (state.answered ? 'Answered today — not correct' : 'Not answered yet'); }
      else if (reward.code === 'study_session') { claimed = claimedFor('study_session', day); progress = `${Number(state.sessions || 0)} of 2 credited sessions`; }
      else if (reward.code === 'daily_goal') { claimed = claimedFor('daily_goal', day); progress = `${Number(state.goal_minutes || 0)} of ${goalTarget} minutes`; }
      else if (reward.code === 'daily_challenge') { claimed = claimedFor('daily_challenge', day); progress = state.challenge_done ? 'Done today' : (state.answered && Number(state.sessions || 0) > 0 ? 'Answered — finish a session to complete it' : 'Answer the question and finish a session'); }
      else if (reward.code === 'weekly_goal') { claimed = claimedFor('weekly_goal', week); progress = `${Number(counters[weekly.metric] || 0)} of ${weekly.target} ${weekly.metric}`; }
      else if (reward.code === 'streak_7') { claimed = achievements.has('streak_7'); progress = `${streak.current} day streak — needs 7`; }
      return {
        code: reward.code, label: reward.label, period: reward.period, how: reward.how,
        amount, enabled, claimed, progress,
      };
    });

    return Response.json({
      day,
      week,
      catalogue,
      balance: wallet.balance,
      earned_today: (await rewards.calendar(user.id, 1, day))[0]?.earned || 0,
      spent_today: 0,
      weekly_challenge: { title: weekly.title, metric: weekly.metric, target: weekly.target, current: Number(counters[weekly.metric] || 0) },
      streak: { current: streak.current, longest: streak.longest },
      daily_regular_cap: rewardTable.daily_regular_cap ?? 90,
      // The daily login reward and the daily question allowance both belong to
      // the Pakistan calendar day, and both become claimable again at midnight
      // there — not after a rolling 24 hours.
      next_reset: nextResetIso(),
      time_zone: 'Asia/Karachi',
      daily_ai: await rewards.dailyUsage(user.id),
      note: 'Rewards are granted by the server from recorded activity. A reward can only be earned once per period, and the ledger keeps the proof.',
    });
  });

  add('GET', '/api/wallet', async ({ user, query }) => {
    const wallet = await rewards.ensureWallet(user.id);
    const day = dayOf();
    const history = await rewards.history(user.id, limit(query.get('limit'), 30, 100));
    const streak = rows(await db.from('streaks').select('current,longest').eq('owner_id', user.id).limit(1))?.[0] || { current: 0, longest: 0 };
    const achievements = rows(await db.from('achievements').select('code,title,reward,created_at')
      .eq('owner_id', user.id).order('created_at', { ascending: false }).limit(30)) || [];
    // The prices, the reward amounts and the limits all come from the economy,
    // so the numbers on this page are the numbers the ledger charges.
    const pricing = await economy.pricing();
    const rewardTable = await economy.rewards();
    const rewardFlags = await economy.rewardFlags();
    const limits = await economy.limits();
    const claims = await rewards.claimPeriods(user.id);
    const todaysClaims = claims.filter(claim => dayOfIso(claim.created_at) === day);
    const ledgerRows = rows(await db.from('transactions')
      .select('amount,direction,created_at').eq('owner_id', user.id).order('created_at', { ascending: false }).limit(200)) || [];
    const todayEarned = ledgerRows
      .filter(row => dayOfIso(row.created_at) === day && row.direction === 'earn')
      .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    const todaySpent = ledgerRows
      .filter(row => dayOfIso(row.created_at) === day && row.direction === 'spend')
      .reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
    return Response.json({
      balance: wallet.balance,
      earned: wallet.earned,
      spent: wallet.spent,
      streak,
      calendar: await rewards.calendar(user.id, 35, day),
      history: history.items,
      hasMore: history.hasMore,
      achievements,
      rates: {
        earn: {
          login: rewardFlags.daily_login === false ? 0 : rewardTable.daily_login,
          daily_question: rewardFlags.daily_question === false ? 0 : rewardTable.daily_question,
          study_session: rewardFlags.study_session === false ? 0 : rewardTable.study_session,
          daily_goal: rewardFlags.daily_goal === false ? 0 : rewardTable.daily_goal,
          daily_challenge: rewardFlags.daily_challenge === false ? 0 : rewardTable.daily_challenge,
          streak_7: rewardFlags.streak_7 === false ? 0 : rewardTable.streak_7,
          weekly_goal: rewardFlags.weekly_goal === false ? 0 : rewardTable.weekly_goal,
        },
        // What each AI request costs, by feature.
        spend: pricing,
        features: economy.catalogue,
        daily_regular_cap: rewardTable.daily_regular_cap,
        reward_flags: rewardFlags,
        note: 'Bridge Credits are in-app reward points, not money or API billing credits.',
      },
      limits: {
        ...limits,
        priced_requests_today: (await rewards.chargedToday(user.id)).length,
      },
      // What the student may still ask today, and when the allowance returns.
      daily_ai: await rewards.dailyUsage(user.id),
      today: {
        day,
        earned: todayEarned,
        spent: todaySpent,
        claimed: todaysClaims.map(claim => ({ code: claim.code, period: claim.period, amount: claim.amount })),
      },
      basic_tools_free: true,
    });
  });

  add('POST', '/api/wallet/spend', async ({ user, body }) => {
    const input = await body();
    // The price comes from the economy table, never from the request body.
    const feature = String(input.feature || '');
    const price = await economy.price(feature);
    if (price === null) fail('invalid_input', 400, 'This feature has no configured price.');
    const key = asUuid(input.client_key);
    if (!key) fail('invalid_input', 400);
    const result = await rewards.applyDelta(user.id, {
      reason: `spend:${key}`, label: `Premium feature: ${feature.replace(/_/g, ' ')}`,
      amount: price, direction: 'spend', meta: { feature, key, type: 'ai_usage' },
    });
    return Response.json({ tx: result.tx, balance: result.wallet?.balance ?? (await rewards.ensureWallet(user.id)).balance, replayed: result.replayed });
  });

  add('GET', '/api/usage', async ({ user }) => {
    const totals = await ai.usageTotals(user.id);
    const recent = rows(await db.from('ai_usage').select('created_at,provider_key,model_id,purpose,input_tokens,output_tokens,cost_micro,ok,failure,cached,space_id')
      .eq('owner_id', user.id).order('created_at', { ascending: false }).limit(60)) || [];
    const cache = rows(await db.from('ai_cache').select('hits,fingerprint').eq('owner_id', user.id).order('hits', { ascending: false }).limit(5)) || [];
    return Response.json({
      ...totals,
      cacheHits: cache.reduce((sum, row) => sum + (row.hits || 0), 0),
      recent,
      pricing_note: 'Costs are estimates in micro-currency units from the per-1k prices you configure per model.',
    });
  });

  add('GET', '/api/progress', async ({ user }) => {
    const day = dayOf();
    const profile = await ensureProfile(user);
    const sessions = rows(await db.from('study_sessions').select('id,space_id,minutes,completed,started_at,mode')
      .eq('owner_id', user.id).order('started_at', { ascending: false }).limit(400)) || [];
    const quizzes = rows(await db.from('quiz_results').select('id,quiz_id,score,total,answers,created_at')
      .eq('owner_id', user.id).order('created_at', { ascending: false }).limit(200)) || [];
    const quizMeta = rows(await db.from('quizzes').select('id,title,space_id,chapter_id,book_id')
      .eq('owner_id', user.id).limit(200)) || [];
    const metaById = new Map(quizMeta.map(q => [q.id, q]));
    const pages = rows(await db.from('pages').select('id,book_id,chapter_id,page_number,created_at')
      .eq('owner_id', user.id).order('created_at', { ascending: false }).limit(400)) || [];
    const games = rows(await db.from('game_sessions').select('game,difficulty,score,best_score,started_at,finished')
      .eq('owner_id', user.id).order('started_at', { ascending: false }).limit(200)) || [];
    const spaces = rows(await db.from('spaces').select('id,name,subject,archived').eq('owner_id', user.id).limit(80)) || [];
    const chapters = rows(await db.from('chapters').select('id,status,title,book_id').eq('owner_id', user.id).limit(200)) || [];
    const achievements = rows(await db.from('achievements').select('code,title,reward,created_at')
      .eq('owner_id', user.id).order('created_at', { ascending: false }).limit(40)) || [];
    const tx = rows(await db.from('transactions').select('amount,reason,created_at,direction')
      .eq('owner_id', user.id).order('created_at', { ascending: false }).limit(300)) || [];

    const spaceName = new Map(spaces.map(s => [s.id, s.name]));
    const dateOf = value => dayOfIso(value) || '';
    const completed = sessions.filter(s => s.completed !== false);
    const byDay = new Map();
    for (const session of sessions) {
      const key = dateOf(session.started_at);
      byDay.set(key, (byDay.get(key) || 0) + (session.minutes || 0));
    }
    const weekStart = weekKey(day);
    const monthStart = `${monthKey(day)}-01`;
    const weekly = [...byDay.entries()].filter(([k]) => k >= weekStart).reduce((a, [, v]) => a + v, 0);
    const monthly = [...byDay.entries()].filter(([k]) => k >= monthStart).reduce((a, [, v]) => a + v, 0);
    const total = [...byDay.values()].reduce((a, v) => a + v, 0);

    const subjectBuckets = new Map();
    for (const session of sessions) {
      const name = spaceName.get(session.space_id) || 'General study';
      const bucket = subjectBuckets.get(name) || { name, minutes: 0, sessions: 0, accuracy: null };
      bucket.minutes += session.minutes || 0;
      bucket.sessions += 1;
      subjectBuckets.set(name, bucket);
    }
    const topicStats = new Map();
    for (const result of quizzes) {
      const meta = metaById.get(result.quiz_id);
      const label = meta ? (spaceName.get(meta.space_id) || quizTitle(meta) || 'Quizzes') : 'Quizzes';
      const bucket = topicStats.get(label) || { label, score: 0, total: 0, runs: 0 };
      bucket.score += result.score || 0;
      bucket.total += result.total || 0;
      bucket.runs += 1;
      topicStats.set(label, bucket);
    }
    const weakAreas = [...topicStats.values()]
      .filter(b => b.total >= 4 && b.score / b.total < 0.7)
      .map(b => ({ label: b.label, accuracy: Math.round((b.score / b.total) * 100), runs: b.runs }))
      .sort((a, b) => a.accuracy - b.accuracy)
      .slice(0, 6);

    const dailyMinutes = [];
    for (let i = 13; i >= 0; i -= 1) {
      const key = addDays(day, -i);
      dailyMinutes.push({ day: key, minutes: byDay.get(key) || 0 });
    }
    const gameBest = new Map();
    for (const g of games) gameBest.set(g.game, Math.max(gameBest.get(g.game) || 0, g.best_score || g.score || 0));
    const streak = rows(await db.from('streaks').select('current,longest').eq('owner_id', user.id).limit(1))?.[0] || { current: 0, longest: 0 };

    return Response.json({
      day,
      minutes: { total, weekly, monthly, today: byDay.get(day) || 0 },
      sessions: { completed: completed.length, all: sessions.length, byDay: [...byDay.entries()].sort().slice(-30) },
      goal: { target: profile.daily_goal_minutes, today: byDay.get(day) || 0 },
      quizzes: {
        taken: quizzes.length,
        accuracy: quizzes.reduce((a, q) => a + (q.total || 0), 0)
          ? Math.round((quizzes.reduce((a, q) => a + (q.score || 0), 0) / quizzes.reduce((a, q) => a + (q.total || 0), 0)) * 100)
          : null,
        recent: quizzes.slice(0, 12).map(q => ({
          ...q, title: metaById.get(q.quiz_id)?.title || 'Quiz', subject: spaceName.get(metaById.get(q.quiz_id)?.space_id) || null,
        })),
      },
      chapters: { total: chapters.length, finished: chapters.filter(c => c.status === 'done').length },
      pages: { extracted: pages.length, books: new Set(pages.map(p => p.book_id)).size },
      topics: [...new Set(pages.map(p => p.chapter_id).filter(Boolean))].length,
      subjects: [...subjectBuckets.values()].sort((a, b) => b.minutes - a.minutes).slice(0, 12),
      topicStats: [...topicStats.values()].sort((a, b) => b.total - a.total).slice(0, 12)
        .map(b => ({ ...b, accuracy: b.total ? Math.round((b.score / b.total) * 100) : 0 })),
      weakAreas,
      games: { rounds: games.filter(g => g.finished).length, best: [...gameBest.entries()].map(([game, score]) => ({ game, score })) },
      streak,
      achievements,
      earned: tx.filter(t => t.direction === 'earn').reduce((a, t) => a + (t.amount || 0), 0),
      calendar: await rewards.calendar(user.id, 35, day),
      series: { minutes: dailyMinutes },
    });
  });

  function quizTitle(meta) {
    return meta?.title || null;
  }

  add('GET', '/api/reminders', async ({ user }) => {
    const profile = await ensureProfile(user);
    const day = dayOf();
    const daily = await rewards.touchDay(user.id, day);
    const prefs = profile.notification_prefs || {};
    const items = [];
    if (!daily.login_claimed) items.push({ kind: 'login', text: 'Claim today’s +30 BC daily login reward.', tone: 'soft' });
    if (!daily.answered && prefs.daily_question !== false) items.push({ kind: 'question', text: 'Today’s question is waiting — 1 minute, +10 BC.', tone: 'soft' });
    if (daily.goal_minutes < profile.daily_goal_minutes) {
      items.push({
        kind: 'goal',
        text: `${profile.daily_goal_minutes - daily.goal_minutes} minutes left to hit your daily goal.`,
        tone: 'study',
      });
    }
    if (prefs.challenges && !daily.challenge_done) items.push({ kind: 'challenge', text: 'Daily challenge: answer the question and finish one session.', tone: 'study' });
    const streak = rows(await db.from('streaks').select('current,last_day').eq('owner_id', user.id).limit(1))?.[0] || { current: 0, last_day: '' };
    if (streak.current >= 2 && streak.last_day !== day) {
      items.push({ kind: 'streak', text: `Keep your ${streak.current}-day streak alive with one short session.`, tone: 'streak' });
    }
    return Response.json({ day, prefs, items });
  });

  add('DELETE', '/api/history/:space_id', async ({ user, params, body }) => {
    const spaceId = asUuid(params.space_id);
    if (!spaceId) fail('invalid_input', 400);
    const input = await body().catch(() => ({}));
    if (input.confirm !== true) fail('invalid_input', 400);
    await db.from('messages').delete().eq('owner_id', user.id).eq('space_id', spaceId);
    await db.from('learning_history').delete().eq('owner_id', user.id).eq('space_id', spaceId);
    const remaining = rows(await db.from('messages').select('id').eq('owner_id', user.id).eq('space_id', spaceId).limit(1)) || [];
    rows(await db.from('history_deletes').insert({
      id: crypto.randomUUID(), owner_id: user.id, scope: `space:${spaceId}`,
      removed: remaining.length ? 0 : 1, created_at: nowIso(),
    }));
    return Response.json({ ok: true, space_id: spaceId, cleared: ['messages', 'learning_history'] });
  });

  add('DELETE', '/api/history', async ({ user, body }) => {
    const input = await body().catch(() => ({}));
    if (input.confirm !== true) fail('invalid_input', 400);
    await db.from('messages').delete().eq('owner_id', user.id);
    await db.from('learning_history').delete().eq('owner_id', user.id);
    rows(await db.from('history_deletes').insert({
      id: crypto.randomUUID(), owner_id: user.id, scope: 'all', removed: 1, created_at: nowIso(),
    }));
    return Response.json({ ok: true, cleared: ['messages', 'learning_history'] });
  });

  return { registryLength: 0 };
}
