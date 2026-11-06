// The economy: what each AI feature costs, what each reward pays, and which
// limits apply. Every number the browser shows about Bridge Credits comes from
// here, and the browser never supplies one.
//
// An administrator can change a price or a limit without a redeploy: the
// overrides live in app.economy_settings and app.ai_usage_limits. The defaults
// below are what the product ships with.

export const FEATURE_CATALOGUE = [
  { key: 'basic_question', label: 'Basic AI question', where: 'AI Tutor chat' },
  { key: 'concept_explanation', label: 'Concept explanation', where: 'Explain simply, definitions, key concepts' },
  { key: 'problem_explanation', label: 'Problem-solving explanation', where: 'Detailed explanation, worked examples, numericals' },
  { key: 'passage_summary', label: 'Short passage summary', where: 'Short exam notes from a scanned page' },
  { key: 'chapter_summary', label: 'Chapter summary', where: 'Chapter summary from scanned pages' },
  { key: 'revision_notes', label: 'Revision notes', where: 'Long notes and revision sheets' },
  { key: 'practice_quiz', label: 'Practice quiz generation', where: 'MCQ and practice question sets' },
  { key: 'advanced_comparison', label: 'Two-model advanced check', where: 'Optional tutor comparison' },
];

export const DEFAULT_PRICING = {
  basic_question: 2,
  concept_explanation: 2,
  problem_explanation: 2,
  passage_summary: 4,
  chapter_summary: 8,
  revision_notes: 6,
  practice_quiz: 5,
  advanced_comparison: 10,
  // The two names the spend endpoint accepted before the catalogue existed.
  // They keep their old prices so that endpoint behaves exactly as it did.
  premium_note_pack: 15,
  deep_check_quiz: 12,
};

export const DEFAULT_REWARDS = {
  daily_login: 30,
  daily_question: 10,
  study_session: 15,
  daily_goal: 20,
  daily_challenge: 15,
  streak_7: 100,
  weekly_goal: 50,
  daily_regular_cap: 90,
};

export const DEFAULT_LIMITS = {
  daily_questions_per_student: 10,
  concurrent_requests_per_student: 1,
  max_output_tokens: 1800,
  shared_daily_quota: 0,
};

// Which priced feature each AI action belongs to. The tutor chat is the basic
// question; every tool in the scanner maps onto one of the catalogue rows, so
// the price a student is shown is the price the ledger charges.
export const ACTION_FEATURES = {
  explain_simple: 'concept_explanation',
  explain_detailed: 'problem_explanation',
  urdu_explain: 'concept_explanation',
  definitions: 'concept_explanation',
  concepts: 'concept_explanation',
  examples: 'problem_explanation',
  numericals: 'problem_explanation',
  short_notes: 'passage_summary',
  summary: 'chapter_summary',
  long_notes: 'revision_notes',
  revision: 'revision_notes',
  mcqs: 'practice_quiz',
  practice: 'practice_quiz',
};

export const REWARD_CATALOGUE = [
  { code: 'daily_login', label: 'Daily login', period: 'day', amount: DEFAULT_REWARDS.daily_login, how: 'Sign in once a day. Once per calendar day.' },
  { code: 'daily_question', label: 'Daily learning question', period: 'day', amount: DEFAULT_REWARDS.daily_question, how: 'Answer the daily question correctly. Once per day.' },
  { code: 'study_session', label: 'Complete a study session', period: 'day', amount: DEFAULT_REWARDS.study_session, how: 'Finish a focus session of ten minutes or more. Up to two a day.' },
  { code: 'streak_7', label: 'Seven-day streak', period: 'streak', amount: DEFAULT_REWARDS.streak_7, how: 'Learn on seven consecutive days.' },
  { code: 'weekly_goal', label: 'Complete a weekly learning goal', period: 'week', amount: DEFAULT_REWARDS.weekly_goal, how: 'Reach the weekly challenge target.' },
  { code: 'daily_goal', label: 'Daily study goal reached', period: 'day', amount: DEFAULT_REWARDS.daily_goal, how: 'Study for your daily goal in minutes.' },
  { code: 'daily_challenge', label: 'Daily challenge completed', period: 'day', amount: DEFAULT_REWARDS.daily_challenge, how: 'Answer the question and finish a session on the same day.' },
];

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Only the keys the catalogue knows may be overridden, and only within a sane
// range: a price of 0 would make an AI request free, and a price of 100000
// would lock a student out of the tutor.
function sanitisePricing(raw) {
  const out = { ...DEFAULT_PRICING };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULT_PRICING)) {
    if (raw[key] === undefined) continue;
    out[key] = clampInt(raw[key], 0, 500, DEFAULT_PRICING[key]);
  }
  return out;
}

function sanitiseRewards(raw) {
  const out = { ...DEFAULT_REWARDS };
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(DEFAULT_REWARDS)) {
    if (raw[key] === undefined) continue;
    out[key] = clampInt(raw[key], 0, 10000, DEFAULT_REWARDS[key]);
  }
  return out;
}

function sanitiseLimits(raw) {
  const out = { ...DEFAULT_LIMITS };
  if (!raw || typeof raw !== 'object') return out;
  if (raw.daily_questions_per_student !== undefined) {
    out.daily_questions_per_student = clampInt(raw.daily_questions_per_student, 0, 5000, DEFAULT_LIMITS.daily_questions_per_student);
  }
  if (raw.concurrent_requests_per_student !== undefined) {
    out.concurrent_requests_per_student = clampInt(raw.concurrent_requests_per_student, 1, 16, DEFAULT_LIMITS.concurrent_requests_per_student);
  }
  if (raw.max_output_tokens !== undefined) {
    out.max_output_tokens = clampInt(raw.max_output_tokens, 128, 32000, DEFAULT_LIMITS.max_output_tokens);
  }
  if (raw.shared_daily_quota !== undefined) {
    out.shared_daily_quota = clampInt(raw.shared_daily_quota, 0, 1000000, DEFAULT_LIMITS.shared_daily_quota);
  }
  return out;
}

// Which rewards are switched on. Only a known reward code may be named, and
// every flag is a plain boolean: an unknown code never reaches the ledger.
function sanitiseRewardFlags(raw) {
  const out = {};
  for (const reward of REWARD_CATALOGUE) out[reward.code] = true;
  if (!raw || typeof raw !== 'object') return out;
  for (const key of Object.keys(out)) {
    if (raw[key] !== undefined) out[key] = raw[key] === true;
  }
  return out;
}

export function createEconomy({ db, fail, rows }) {
  // The economy changes rarely and is read on every request, so it is cached for
  // a few seconds. An administrator's write drops the cache immediately.
  let cache = null;
  let cachedAt = 0;
  const TTL_MS = 5000;

  async function load() {
    const now = Date.now();
    if (cache && now - cachedAt < TTL_MS) return cache;
    const stored = rows(await db.from('economy_settings').select('key,value').limit(40)) || [];
    const byKey = new Map(stored.map(row => [String(row.key || ''), row.value]));
    cache = {
      pricing: sanitisePricing(byKey.get('pricing')),
      rewards: sanitiseRewards(byKey.get('rewards')),
      limits: sanitiseLimits(byKey.get('limits')),
      // Which reward types are switched on. A switched-off reward is never
      // paid, whatever the amount says.
      reward_flags: (() => {
        const flags = {};
        for (const reward of REWARD_CATALOGUE) flags[reward.code] = true;
        const raw = byKey.get('reward_flags');
        if (raw && typeof raw === 'object') {
          for (const key of Object.keys(flags)) if (raw[key] !== undefined) flags[key] = raw[key] === true;
        }
        return flags;
      })(),
    };
    cachedAt = now;
    return cache;
  }

  function invalidate() { cache = null; cachedAt = 0; }

  async function pricing() { return (await load()).pricing; }
  async function rewards() { return (await load()).rewards; }
  async function limits() { return (await load()).limits; }
  async function rewardFlags() { return (await load()).reward_flags; }

  // The price of one feature. An unknown feature is never free: it is refused
  // by the caller, because "charge nothing" must never be the answer to a name
  // the server does not recognise.
  async function price(feature) {
    const table = await pricing();
    const value = table[feature];
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  async function rewardAmount(code) {
    const table = await rewards();
    const flags = await rewardFlags();
    if (flags[code] === false) return null;
    const value = table[code];
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  async function write(section, value) {
    const key = ['pricing', 'rewards', 'limits', 'reward_flags'].includes(section) ? section : null;
    if (!key) fail('invalid_input', 400);
    const clean = key === 'pricing' ? sanitisePricing(value)
      : key === 'rewards' ? sanitiseRewards(value)
        : key === 'limits' ? sanitiseLimits(value) : sanitiseRewardFlags(value);
    const inserted = rows(await db.from('economy_settings').insertIfAbsent({
      id: crypto.randomUUID(), key, value: clean, updated_at: new Date().toISOString(),
    }, { onConflict: 'key' }).select('key,value'));
    if (!inserted?.length) {
      const updated = rows(await db.from('economy_settings').update({ value: clean, updated_at: new Date().toISOString() })
        .eq('key', key).select('key,value'));
      if (!updated?.length) fail('write_conflict', 409);
    }
    invalidate();
    return (await load())[key];
  }

  return { pricing, rewards, limits, rewardFlags, price, rewardAmount, write, invalidate, catalogue: FEATURE_CATALOGUE };
}
