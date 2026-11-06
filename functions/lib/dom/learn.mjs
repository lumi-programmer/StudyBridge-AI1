// Quizzes, Focus Mode sessions and the Game Center. Scores, minutes and rewards
// are computed here from server-held answer keys and the server clock, so a
// client cannot claim a result it did not earn.
import { GAME_CATALOG, GAME_RULES } from '../content.mjs';
import { bankQuiz, buildLocalQuiz, gradeAnswers, publicQuestions, sanitizeQuestions } from '../quiz.mjs';
import { clamp, dayOf, dayOfIso, nowIso, text as asText, truncate, uuid as asUuid } from '../util.mjs';

const MODES = ['deep', 'custom', 'normal'];
const DIFFICULTIES = ['easy', 'normal', 'hard'];
const QUIZ_COLUMNS = 'id,space_id,book_id,chapter_id,title,origin,provider,model,created_at';
const SESSION_COLUMNS = 'id,space_id,mode,planned_minutes,minutes,completed,break_shown,client_key,started_at,ended_at';
const GAME_REWARD_ROUNDS = 5;
const GAME_REWARD_DAILY_CAP = 40;
const SESSION_REWARD_MINUTES = 10;
const SESSION_REWARD_PER_DAY = 2;

const CATALOG = new Map(GAME_CATALOG.map(item => [item.game, item]));

function catalogName(game) {
  return CATALOG.get(game)?.name || String(game).replace(/-/g, ' ');
}

function gameRules(game) {
  const entry = CATALOG.get(game);
  const rules = GAME_RULES[game];
  if (!entry || !rules) return null;
  return {
    game,
    name: entry.name,
    blurb: entry.blurb,
    how_to_play: entry.how,
    icon: entry.icon,
    difficulties: entry.difficulties,
    rounds: rules.rounds,
    points_per_correct: rules.perCorrect,
    perfect_bonus: rules.bonusCap,
    time_limit_seconds: rules.timed || null,
    scoring: `score = correct × ${rules.perCorrect}${rules.bonusCap ? ` (+${rules.bonusCap} bonus for a perfect round)` : ''}`,
  };
}

function percent(score, total) {
  return total ? Math.round((score / total) * 100) : 0;
}

export function createLearning({ add, ai, db, fail, generateGame, gradeGame, rows, rewards, economy }) {
  async function quizRow(user, id, columns) {
    const key = asUuid(id) || fail('invalid_input', 400);
    const found = rows(await db.from('quizzes').select(columns).eq('id', key).eq('owner_id', user.id).limit(1));
    if (!found?.length) fail('quiz_not_found', 404);
    return found[0];
  }

  async function saveQuiz(user, made, { spaceId, bookId, chapterId, provider, model, extra = {}, onSaved = null }) {
    const quizId = crypto.randomUUID();
    rows(await db.from('quizzes').insert({
      id: quizId, owner_id: user.id, space_id: spaceId, book_id: bookId, chapter_id: chapterId,
      title: truncate(made.title, 120), questions: made.questions, origin: made.origin,
      provider: provider || '', model: model || '', created_at: nowIso(),
    }));
    if (typeof onSaved === 'function') onSaved(quizId);
    return Response.json({
      quiz_id: quizId,
      title: made.title,
      origin: made.origin,
      note: made.note || null,
      questions: publicQuestions(made.questions),
      ...extra,
    }, { status: 201 });
  }

  async function profileOf(scoped, user) {
    const profile = await scoped.ensureProfile(user);
    return {
      quick_break_suggestions: profile.quick_break_suggestions !== false,
      daily_goal_minutes: profile.daily_goal_minutes || 30,
    };
  }

  async function sessionRow(user, key) {
    const found = rows(await db.from('study_sessions').select(SESSION_COLUMNS).eq('id', key).eq('owner_id', user.id).limit(1));
    if (!found?.length) fail('session_not_found', 404);
    return found[0];
  }

  async function sessionByClientKey(user, clientKey) {
    const found = rows(await db.from('study_sessions').select(SESSION_COLUMNS)
      .eq('client_key', clientKey).eq('owner_id', user.id).limit(1));
    if (!found?.length) fail('write_conflict', 409, 'That session could not be read back. Start again.');
    return found[0];
  }

  async function totalStudyMinutes(user) {
    const items = rows(await db.from('study_sessions').select('minutes').eq('owner_id', user.id).limit(500)) || [];
    return items.reduce((acc, item) => acc + (item.minutes || 0), 0);
  }

  // ---- quizzes --------------------------------------------------------------
  add('GET', '/api/quizzes', async ({ user, query }) => {
    const spaceId = asUuid(query.get('space_id'));
    const bookId = asUuid(query.get('book_id'));
    let builder = db.from('quizzes').select(`${QUIZ_COLUMNS},questions`).eq('owner_id', user.id);
    if (spaceId) builder = builder.eq('space_id', spaceId);
    if (bookId) builder = builder.eq('book_id', bookId);
    const stored = rows(await builder.order('created_at', { ascending: false }).limit(60)) || [];
    const results = rows(await db.from('quiz_results')
      .select('quiz_id,score,total,created_at').eq('owner_id', user.id)
      .order('created_at', { ascending: false }).limit(200)) || [];
    const attempts = new Map();
    const best = new Map();
    const last = new Map();
    for (const result of results) {
      attempts.set(result.quiz_id, (attempts.get(result.quiz_id) || 0) + 1);
      if (!best.has(result.quiz_id) || result.score > best.get(result.quiz_id).score) best.set(result.quiz_id, result);
      if (!last.has(result.quiz_id)) last.set(result.quiz_id, result);
    }
    return Response.json({
      items: stored.map(quiz => ({
        id: quiz.id, space_id: quiz.space_id, book_id: quiz.book_id, chapter_id: quiz.chapter_id,
        title: quiz.title, origin: quiz.origin, provider: quiz.provider, model: quiz.model,
        created_at: quiz.created_at,
        questions: Array.isArray(quiz.questions) ? quiz.questions.length : 0,
        attempts: attempts.get(quiz.id) || 0,
        best_score: best.get(quiz.id)?.score ?? null,
        best_total: best.get(quiz.id)?.total ?? null,
        last_taken_at: last.get(quiz.id)?.created_at ?? null,
      })),
    });
  });

  add('POST', '/api/quizzes', async (scoped) => {
    const { user } = scoped;
    const input = await scoped.body();
    const spaceId = asUuid(input.space_id);
    const bookId = asUuid(input.book_id);
    const chapterId = asUuid(input.chapter_id);
    const count = clamp(Number(input.count) || 8, 3, 15);
    const mode = ['local', 'bank', 'ai'].includes(input.mode) ? input.mode : 'local';
    const customTitle = asText(input.title, { max: 120 });
    const space = spaceId ? await scoped.space(user, spaceId) : null;

    if (mode === 'bank') {
      const subject = asText(input.subject, { max: 60 }) || space?.subject || '';
      const made = bankQuiz({ subject, count, title: customTitle || undefined });
      if (!made.questions.length) fail('invalid_input', 400, 'The question bank has nothing for that subject yet. Try Mixed practice.');
      return saveQuiz(user, made, { spaceId, bookId, chapterId });
    }

    const pages = await scoped.pagesFor(user, {
      bookId,
      chapterId,
      bookIds: space ? (await scoped.contextFor(user, spaceId)).bookIds : null,
      limit: 14,
    });
    if (mode === 'local') {
      if (!pages.length) fail('no_material', 409, 'A text quiz is built from your own scans. Scan a chapter or connect a book to this space first.');
      const made = buildLocalQuiz(pages, { count, title: customTitle || pages[0]?.chapter_title || 'Quiz from your scanned material' });
      if (made.questions.length < 3) fail('no_material', 409, 'Your scans do not contain enough definable sentences yet. Scan more pages, or use the free practice bank.');
      return saveQuiz(user, made, { spaceId, bookId, chapterId });
    }

    if (!pages.length) fail('no_material', 409, 'AI questions need scanned text. Scan a chapter first.');
    const price = await economy.price('practice_quiz');
    if (price === null) fail('invalid_input', 400, 'Practice quizzes have no configured price right now.');
    // A client key makes the debit replay-safe. A client that sends none still
    // gets a quiz; the server makes the key, so it is charged exactly once.
    const requestKey = asUuid(input.client_key) || crypto.randomUUID();
    const reservation = await rewards.reserveAi(user.id, {
      feature: 'practice_quiz', requestKey, credits: price, label: 'Practice quiz',
    });
    if (reservation.replayed) {
      if (reservation.state === 'settled') {
        const earlier = await rewards.aiRequest(user.id, reservation.key);
        const savedId = asUuid(earlier?.detail);
        if (savedId) {
          const saved = await quizRow(user, savedId, `${QUIZ_COLUMNS},questions`);
          return Response.json({
            quiz_id: saved.id, title: saved.title, origin: saved.origin,
            questions: publicQuestions(saved.questions), credits_spent: 0, replayed: true,
            note: 'This quiz was already generated and paid for. The same quiz is shown again — no credits were taken a second time.',
          });
        }
      }
      fail('idempotency_conflict', 409, 'This quiz request is already running. Wait for it to finish instead of sending it again.');
    }
    const material = pages.map(page =>
      `[page ${page.page_number}${page.chapter_title ? `, ${page.chapter_title}` : ''}] ${truncate(page.text, 1200)}`).join('\n\n').slice(0, 7000);
    try {
      const generated = await ai.modelOutputToJson(user.id, {
        prompt: `Write ${count} multiple-choice questions using ONLY this material. Return ONLY a JSON array of {"question":"","options":["","",""],"answer":0,"explain":"","page":0}. answer is the zero-based index of the correct option and page is the printed page number you can see. Do not add facts that are not in the material.\n\nMaterial:\n${material}`,
        system: 'You write exam-ready questions for students from supplied textbook text only.',
        spaceId, purpose: 'quiz_create',
      });
      const list = Array.isArray(generated.json) ? generated.json : generated.json?.questions;
      const cleaned = sanitizeQuestions(list, pages);
      if (!cleaned.length) fail('extraction_failed', 502, 'The model returned no usable questions. Try again, or use the free practice bank.');
      let quizId = '';
      const saved = await saveQuiz(user, {
        title: customTitle || (pages[0]?.chapter_title ? `${pages[0].chapter_title} quiz` : 'Quiz from your scans'),
        origin: 'ai',
        note: 'Generated from your scanned text by the model shown. Check it against your book.',
        questions: cleaned,
      }, {
        spaceId, bookId, chapterId,
        provider: generated.result.provider?.provider_key || '', model: generated.result.model?.model_id || '',
        onSaved: id => { quizId = id; },
      });
      await rewards.settleAi(user.id, reservation.key, {
        providerKey: generated.result.provider?.provider_key || '',
        modelId: generated.result.model?.model_id || '',
        statusCode: 200,
        detail: quizId,
      });
      const payload = await saved.json();
      return Response.json({ ...payload, credits_spent: price, balance: (await rewards.ensureWallet(user.id)).balance }, { status: 201 });
    } catch (error) {
      // Free fallback only for the configuration/limit failures students cannot fix.
      if (['no_provider_configured', 'credentials_not_configured', 'rate_limited', 'daily_limit_reached'].includes(error?.code)) {
        await rewards.refundAi(user.id, reservation.key, { reason: error?.code || 'provider_unavailable', feature: 'practice_quiz' });
        const made = buildLocalQuiz(pages, { count, title: customTitle || 'Quiz from your scanned material' });
        if (made.questions.length >= 3) {
          return saveQuiz(user, made, {
            spaceId, bookId, chapterId,
            extra: {
              credits_spent: 0,
              note: 'No credits were deducted: this quiz was built from your own scanned text, not by a model.',
            },
          });
        }
      }
      await rewards.refundAi(user.id, reservation.key, { reason: error?.code || 'generation_failed', feature: 'practice_quiz' });
      throw error;
    }
  });

  add('GET', '/api/quizzes/:quiz_id', async ({ user, params }) => {
    const stored = await quizRow(user, params.quiz_id, `${QUIZ_COLUMNS},questions`);
    return Response.json({
      quiz: {
        id: stored.id, space_id: stored.space_id, book_id: stored.book_id, chapter_id: stored.chapter_id,
        title: stored.title, origin: stored.origin, provider: stored.provider, model: stored.model, created_at: stored.created_at,
      },
      questions: publicQuestions(stored.questions),
      note: 'Answer the questions, then submit — scoring and any Bridge Credit award happen on the server.',
    });
  });

  add('GET', '/api/quizzes/:quiz_id/results', async ({ user, params }) => {
    const stored = await quizRow(user, params.quiz_id, 'id');
    const items = rows(await db.from('quiz_results')
      .select('id,score,total,duration_seconds,created_at').eq('owner_id', user.id).eq('quiz_id', stored.id)
      .order('created_at', { ascending: false }).limit(30)) || [];
    return Response.json({ quiz_id: stored.id, items });
  });

  add('DELETE', '/api/quizzes/:quiz_id', async ({ user, params }) => {
    const stored = await quizRow(user, params.quiz_id, 'id');
    await db.from('quiz_results').delete().eq('owner_id', user.id).eq('quiz_id', stored.id);
    const deleted = rows(await db.from('quizzes').delete().eq('id', stored.id).eq('owner_id', user.id).select('id'));
    if (!deleted?.length) fail('quiz_not_found', 404);
    return Response.json({ ok: true, id: stored.id });
  });

  add('POST', '/api/quizzes/:quiz_id/submit', async (scoped) => {
    const { user, params } = scoped;
    const stored = await quizRow(user, params.quiz_id, 'id,questions,space_id,title');
    const input = await scoped.body();
    const clientKey = asUuid(input.client_key)
      || fail('invalid_input', 400, 'A quiz attempt needs a client_key so a retry cannot be counted twice.');
    const graded = gradeAnswers(stored.questions, input.answers);
    if (!graded.total) fail('invalid_input', 400, 'That quiz has no questions.');
    const duration = clamp(Number(input.duration_seconds) || 0, 0, 21600);

    const inserted = rows(await db.from('quiz_results').insertIfAbsent({
      id: crypto.randomUUID(), owner_id: user.id, quiz_id: stored.id, score: graded.score, total: graded.total,
      answers: graded.feedback, duration_seconds: duration, client_key: clientKey, created_at: nowIso(),
    }, { onConflict: 'client_key' }).select('id,score,total,created_at'));

    if (!inserted?.length) {
      const existing = rows(await db.from('quiz_results').select('id,score,total,answers,created_at')
        .eq('owner_id', user.id).eq('client_key', clientKey).limit(1));
      if (!existing?.length) fail('write_conflict', 409);
      return Response.json({
        result_id: existing[0].id,
        score: existing[0].score,
        total: existing[0].total,
        percent: percent(existing[0].score, existing[0].total),
        feedback: existing[0].answers,
        replayed: true,
        note: 'This attempt was already recorded.',
      });
    }

    const day = dayOf();
    await rewards.touchDay(user.id, day);
    const attempts = rows(await db.from('quiz_results').select('id').eq('owner_id', user.id).limit(60)) || [];
    const awarded = [];
    const first = await rewards.grantAchievement(user.id, 'first_quiz');
    if (first) awarded.push(first.awarded);
    if (attempts.length >= 5) {
      const five = await rewards.grantAchievement(user.id, 'five_quizzes');
      if (five) awarded.push(five.awarded);
    }
    const counters = await rewards.weekCounters(user.id, day);
    const weekly = await rewards.maybeWeeklyChallenge(user.id, counters, day);
    const wallet = await rewards.ensureWallet(user.id);
    await scoped.log({ spaceId: stored.space_id, kind: 'quiz', topic: stored.title, detail: `${graded.score}/${graded.total}` });

    return Response.json({
      result_id: inserted[0].id,
      score: graded.score,
      total: graded.total,
      percent: percent(graded.score, graded.total),
      attempts: attempts.length,
      feedback: graded.feedback,
      duration_seconds: duration,
      awarded,
      weekly,
      balance: wallet.balance,
      note: 'Saved on the server with the correct answer and explanation for every question.',
    });
  });

  // ---- focus sessions -------------------------------------------------------
  add('POST', '/api/sessions/start', async (scoped) => {
    const { user } = scoped;
    const input = await scoped.body();
    const mode = MODES.includes(input.mode) ? input.mode : 'deep';
    const planned = clamp(Number(input.planned_minutes) || 25, 1, 240);
    const clientKey = asUuid(input.client_key) || fail('invalid_input', 400, 'Starting a session needs a client_key.');
    const spaceId = asUuid(input.space_id);
    if (spaceId) await scoped.space(user, spaceId);

    const inserted = rows(await db.from('study_sessions').insertIfAbsent({
      id: crypto.randomUUID(), owner_id: user.id, space_id: spaceId, mode, planned_minutes: planned,
      minutes: 0, completed: false, break_shown: false, client_key: clientKey, started_at: nowIso(), ended_at: null,
    }, { onConflict: 'client_key' }).select(SESSION_COLUMNS));
    if (inserted?.length) {
      return Response.json({ session: inserted[0], resumed: false, profile: await profileOf(scoped, user) }, { status: 201 });
    }
    const existing = await sessionByClientKey(user, clientKey);
    return Response.json({ session: existing, resumed: true, profile: await profileOf(scoped, user) });
  });

  add('GET', '/api/sessions', async (scoped) => {
    const { user, query } = scoped;
    const limit = scoped.limit(query.get('limit'), 30, 100);
    const items = rows(await db.from('study_sessions').select(SESSION_COLUMNS).eq('owner_id', user.id)
      .order('started_at', { ascending: false }).limit(limit)) || [];
    const active = items.find(item => item.completed === false);
    return Response.json({
      items,
      active: active
        ? { ...active, elapsed_minutes: Math.max(0, Math.round((Date.now() - Date.parse(active.started_at)) / 60000)) }
        : null,
      recorded_minutes: items.reduce((acc, item) => acc + (item.minutes || 0), 0),
      profile: await profileOf(scoped, user),
      rules: {
        credited_minutes: SESSION_REWARD_MINUTES,
        credited_per_day: SESSION_REWARD_PER_DAY,
        credit_per_session: 15,
        note: 'Every finished session is recorded as study time. Sessions of 10 minutes or more earn 15 Bridge Credits, up to two a day.',
      },
    });
  });

  add('POST', '/api/sessions/:session_id/heartbeat', async (scoped) => {
    const { user, params } = scoped;
    const key = asUuid(params.session_id) || fail('invalid_input', 400);
    const session = await sessionRow(user, key);
    if (session.completed) fail('session_active', 409, 'That session is already finished.');
    const input = await scoped.body().catch(() => ({}));
    const elapsed = Math.max(0, Math.round((Date.now() - Date.parse(session.started_at)) / 60000));
    const profile = await profileOf(scoped, user);
    const breakShown = session.break_shown === true || input.break_shown === true;
    if (input.break_shown === true && session.break_shown !== true) {
      rows(await db.from('study_sessions').update({ break_shown: true }).eq('id', key).eq('owner_id', user.id).select('id'));
    }
    return Response.json({
      session_id: session.id,
      elapsed_minutes: elapsed,
      planned_minutes: session.planned_minutes,
      mode: session.mode,
      finished: Boolean(session.completed),
      suggest_break: profile.quick_break_suggestions === true && elapsed >= 10 && !breakShown,
      break_shown: breakShown,
    });
  });

  add('POST', '/api/sessions/:session_id/finish', async (scoped) => {
    const { user, params } = scoped;
    const key = asUuid(params.session_id) || fail('invalid_input', 400);
    const session = await sessionRow(user, key);
    if (session.completed) {
      return Response.json({ session, replayed: true, note: 'This session was already finished.' });
    }
    const input = await scoped.body().catch(() => ({}));
    const endedAt = nowIso();
    // Minutes come from the server clock, capped by the plan plus a short grace
    // window, so an abandoned timer cannot inflate study time.
    const elapsedMinutes = Math.round((Date.parse(endedAt) - Date.parse(session.started_at)) / 60000);
    const ceiling = session.planned_minutes + 15;
    const selfReported = Number.isFinite(Number(input.minutes)) ? clamp(Number(input.minutes), 0, ceiling) : elapsedMinutes;
    const minutes = clamp(Math.min(elapsedMinutes, selfReported), 0, ceiling);

    const updated = rows(await db.from('study_sessions')
      .update({ minutes, completed: true, ended_at: endedAt })
      .eq('id', key).eq('owner_id', user.id).eq('completed', false)
      .select(SESSION_COLUMNS));
    if (!updated?.length) {
      const again = await sessionRow(user, key);
      return Response.json({ session: again, replayed: true, note: 'This session was already finished.' });
    }

    const day = dayOf();
    let state = await rewards.touchDay(user.id, day);
    const awarded = [];
    if (minutes > 0) state = await rewards.addDayMinutes(user.id, state, minutes);

    const qualifying = minutes >= SESSION_REWARD_MINUTES;
    let capNote = null;
    if (qualifying && state.sessions < SESSION_REWARD_PER_DAY) {
      const amount = await rewards.rewardFor('study_session', 15);
      const claim = await rewards.claimReward(user.id, 'study_session', `${day}#${state.sessions + 1}`, amount);
      if (claim.claimed && amount > 0) {
        const reward = await rewards.applyDelta(user.id, {
          reason: `session:${key}`, label: `Focus session · ${minutes} min`, amount,
          meta: { minutes, mode: session.mode, type: 'learning_reward' },
        });
        state = await rewards.patchDay(user.id, state, { sessions: state.sessions + 1 });
        if (!reward.replayed && reward.tx) {
          awarded.push({ kind: 'session', amount: reward.tx.amount, label: 'Study session' });
          if (reward.cap_note) capNote = reward.cap_note;
        }
      } else {
        capNote = amount === 0
          ? 'Study session rewards are switched off right now, so no credits were added.'
          : 'This session reward was already claimed today.';
      }
    } else if (qualifying) {
      capNote = `Two credited sessions is the daily maximum (${SESSION_REWARD_PER_DAY}). Extra sessions still count as study time.`;
    }
    const first = await rewards.grantAchievement(user.id, 'first_session');
    if (first) awarded.push({ kind: 'achievement', ...first });
    if (minutes > 0 && (await totalStudyMinutes(user)) >= 300) {
      const milestone = await rewards.grantAchievement(user.id, 'milestone_300min');
      if (milestone) awarded.push({ kind: 'achievement', ...milestone });
    }
    const streak = await rewards.bumpStreak(user.id, day);
    const daily = await rewards.maybeDailyChallenge(user.id, state);
    const counters = await rewards.weekCounters(user.id, day);
    const weekly = await rewards.maybeWeeklyChallenge(user.id, counters, day);
    const wallet = await rewards.ensureWallet(user.id);
    await scoped.log({ spaceId: session.space_id, kind: 'session', topic: session.mode, detail: `${minutes} min` });

    return Response.json({
      session: updated[0],
      minutes,
      qualifying,
      reward_note: qualifying ? null : `Sessions under ${SESSION_REWARD_MINUTES} minutes are recorded but earn no Bridge Credits.`,
      cap_note: capNote,
      awarded,
      streak,
      day: daily,
      weekly,
      balance: wallet.balance,
      goal: { minutes_today: state.goal_minutes, done: state.goal_done === true },
    });
  });

  add('DELETE', '/api/sessions/:session_id', async ({ user, params }) => {
    const key = asUuid(params.session_id) || fail('invalid_input', 400);
    const deleted = rows(await db.from('study_sessions').delete().eq('id', key).eq('owner_id', user.id).select('id'));
    if (!deleted?.length) fail('session_not_found', 404);
    return Response.json({ ok: true, id: key, note: 'Removed from your history. Bridge Credits already earned are not reversed.' });
  });

  // ---- game center ----------------------------------------------------------
  add('GET', '/api/games', async ({ user }) => {
    const day = dayOf();
    const sessions = rows(await db.from('game_sessions')
      .select('game,difficulty,score,best_score,reward,started_at').eq('owner_id', user.id)
      .order('started_at', { ascending: false }).limit(300)) || [];
    const best = new Map();
    const played = new Map();
    for (const row of sessions) {
      best.set(row.game, Math.max(best.get(row.game) || 0, row.best_score || 0, row.score || 0));
      played.set(row.game, (played.get(row.game) || 0) + 1);
    }
    const today = sessions.filter(row => dayOfIso(row.started_at) === day);
    const rewarded = today.filter(row => (row.reward || 0) > 0);
    return Response.json({
      games: GAME_CATALOG.map(item => ({
        game: item.game, name: item.name, blurb: item.blurb, icon: item.icon,
        difficulties: item.difficulties,
        best_score: best.get(item.game) || 0,
        rounds_played: played.get(item.game) || 0,
      })),
      rules: GAME_CATALOG.map(item => gameRules(item.game)).filter(Boolean),
      today: {
        rounds: today.length,
        rewarded_rounds: rewarded.length,
        credits_earned: rewarded.reduce((acc, row) => acc + (row.reward || 0), 0),
        reward_rounds_left: Math.max(0, GAME_REWARD_ROUNDS - rewarded.length),
        daily_cap: GAME_REWARD_DAILY_CAP,
      },
      note: 'The Game Center is always open — no study session is required first. Rewards are capped daily so they cannot be farmed.',
    });
  });

  add('GET', '/api/games/:game/history', async ({ user, params }) => {
    const game = CATALOG.get(params.game) ? params.game : fail('game_unknown', 404);
    const items = rows(await db.from('game_sessions')
      .select('id,difficulty,score,best_score,reward,finished,duration_ms,started_at,ended_at')
      .eq('owner_id', user.id).eq('game', game).order('started_at', { ascending: false }).limit(40)) || [];
    return Response.json({ game, name: catalogName(game), rules: gameRules(game), items });
  });

  add('POST', '/api/games/:game/start', async (scoped) => {
    const { user, params } = scoped;
    const game = CATALOG.get(params.game) ? params.game : fail('game_unknown', 404);
    const input = await scoped.body();
    const difficulty = DIFFICULTIES.includes(input.difficulty) ? input.difficulty : 'normal';
    const challenge = generateGame(game, difficulty);
    const sessionId = crypto.randomUUID();
    rows(await db.from('game_sessions').insert({
      id: sessionId, owner_id: user.id, game, difficulty, state: challenge, score: 0, best_score: 0,
      rounds: 0, duration_ms: 0, reward: 0, finished: false, started_at: nowIso(), ended_at: null,
    }));
    const items = Array.isArray(challenge.items) ? challenge.items : [];
    return Response.json({
      session_id: sessionId,
      game,
      name: catalogName(game),
      difficulty,
      kind: challenge.kind,
      timed: challenge.timed || null,
      points_per_correct: challenge.perCorrect,
      perfect_bonus: challenge.bonusCap,
      rounds: challenge.kind === 'memory' ? challenge.rounds.length : items.length,
      // Only the puzzle leaves the server; the answer key stays in the row.
      items: items.map((item, index) => ({
        index,
        mode: item.kind === 'input' ? 'input' : 'choice',
        prompt: item.prompt,
        options: Array.isArray(item.options) ? item.options : null,
        hint: item.hint || null,
      })),
      memory: challenge.kind === 'memory' ? { tiles: challenge.tiles, rounds: challenge.rounds } : null,
    }, { status: 201 });
  });

  add('POST', '/api/games/:game/finish', async (scoped) => {
    const { user, params } = scoped;
    const game = CATALOG.get(params.game) ? params.game : fail('game_unknown', 404);
    const input = await scoped.body();
    const sessionId = asUuid(input.session_id) || fail('invalid_input', 400);
    const found = rows(await db.from('game_sessions')
      .select('id,game,difficulty,state,score,rounds,best_score,reward,finished,started_at')
      .eq('id', sessionId).eq('owner_id', user.id).limit(1));
    if (!found?.length) fail('game_not_active', 409, 'That game round was not found for you. Start a new round.');
    const row = found[0];
    if (row.finished) {
      return Response.json({ session_id: row.id, game, score: row.score, credits_earned: row.reward, already: true, note: 'This round was already scored.' });
    }
    // Timing uses the stored start and the server clock, never client claims.
    const graded = gradeGame(game, row.state, { ...input, started_at: row.started_at, ended_at: nowIso() });
    const day = dayOf();
    const perGame = rows(await db.from('game_sessions')
      .select('id,score,best_score').eq('owner_id', user.id).eq('game', game).limit(200)) || [];
    const bestScore = Math.max(graded.score, row.best_score || 0, ...perGame.map(item => item.best_score || item.score || 0), 0);

    const today = rows(await db.from('game_sessions')
      .select('id,reward,started_at').eq('owner_id', user.id).order('started_at', { ascending: false }).limit(200)) || [];
    const todayRewarded = today.filter(item => dayOfIso(item.started_at) === day && (item.reward || 0) > 0 && item.id !== sessionId);
    const earnedToday = todayRewarded.reduce((acc, item) => acc + (item.reward || 0), 0);
    let grantable = graded.reward;
    let capNote = null;
    if (todayRewarded.length >= GAME_REWARD_ROUNDS) {
      grantable = 0;
      capNote = `Daily rewarded rounds reached (${GAME_REWARD_ROUNDS}). Keep playing for practice — it still counts as a game.`;
    } else if (earnedToday + grantable > GAME_REWARD_DAILY_CAP) {
      grantable = Math.max(0, GAME_REWARD_DAILY_CAP - earnedToday);
      capNote = `Game rewards stop at ${GAME_REWARD_DAILY_CAP} Bridge Credits a day.`;
    }
    if (!graded.plausible) {
      grantable = 0;
      capNote = null;
    }

    rows(await db.from('game_sessions')
      .update({
        score: graded.score, best_score: bestScore, rounds: (row.rounds || 0) + 1, reward: grantable,
        finished: true, duration_ms: graded.durationMs, ended_at: nowIso(),
      })
      .eq('id', sessionId).eq('owner_id', user.id).eq('finished', false).select('id'));

    if (grantable > 0) {
      await rewards.applyDelta(user.id, {
        reason: `game:${sessionId}`, label: `${catalogName(game)} · ${graded.score} points`, amount: grantable,
        meta: { game, difficulty: row.difficulty, score: graded.score, type: 'learning_reward' },
      });
    }
    const achievement = await rewards.grantAchievement(user.id, 'first_game');
    const counters = await rewards.weekCounters(user.id, day);
    const weekly = await rewards.maybeWeeklyChallenge(user.id, counters, day);
    const wallet = await rewards.ensureWallet(user.id);
    await scoped.log({ spaceId: null, kind: 'game', topic: catalogName(game), detail: `${graded.correct}/${graded.total} · ${graded.score}` });

    return Response.json({
      session_id: sessionId,
      game,
      difficulty: row.difficulty,
      correct: graded.correct,
      total: graded.total,
      score: graded.score,
      best_score: bestScore,
      duration_ms: graded.durationMs,
      plausible: graded.plausible,
      credits_earned: grantable,
      cap_note: capNote,
      balance: wallet.balance,
      achievement: achievement ? achievement.awarded : null,
      weekly,
      feedback: graded.feedback,
      note: graded.plausible
        ? null
        : 'That round finished faster than the questions allow, so no points were added. Play it again at a normal pace.',
    });
  });
}
