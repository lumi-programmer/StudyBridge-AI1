// Game Center: the server generates every puzzle and grades every submission.
// The browser cannot claim a score it did not earn, because the answer key
// lives in the session row created at start.
import { GAME_RULES, QUESTION_BANK } from './content.mjs';
import { clamp } from './util.mjs';

const NAMES = ['Ayesha', 'Bilal', 'Hina', 'Imran', 'Junaid', 'Kiran', 'Nadia', 'Omar', 'Sara', 'Zain'];
const COLORS = ['🔴', '🔵', '🟢', '🟡', '🟣', '🟠'];

function rnd(min, max) {
  const span = max - min + 1;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return min + (buf[0] % span);
}

function pick(list) { return list[rnd(0, list.length - 1)]; }

function shuffled(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = rnd(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function numericAlternates(correct, spread) {
  const set = new Set();
  let guard = 0;
  while (set.size < 3 && guard < 40) {
    guard += 1;
    const delta = rnd(1, spread) * (rnd(0, 1) ? 1 : -1);
    const alt = Math.max(0, correct + delta);
    if (alt !== correct) set.add(alt);
  }
  return [...set];
}

function choiceFields(correct, spread = 6) {
  const distractors = numericAlternates(correct, spread);
  const options = shuffled([correct, ...distractors]).slice(0, 4);
  while (options.length < 4) options.push(correct + options.length + spread);
  return { options, answer: options.indexOf(correct) };
}

function stringChoices(correct, pool) {
  const options = shuffled([...new Set([correct, ...pool])]).slice(0, 4);
  return { options, answer: options.indexOf(correct) };
}

function mathProblem(difficulty) {
  if (difficulty === 'easy') {
    const a = rnd(2, 20); const b = rnd(2, 20);
    const op = pick(['+', '-', '×']);
    if (op === '+') return { prompt: `${a} + ${b}`, answer: a + b };
    if (op === '-') { const big = Math.max(a, b); const small = Math.min(a, b); return { prompt: `${big} - ${small}`, answer: big - small }; }
    const k = rnd(2, 5);
    return { prompt: `${k} × ${b}`, answer: k * b };
  }
  if (difficulty === 'normal') {
    const kind = rnd(0, 3);
    if (kind === 0) { const a = rnd(4, 25); const b = rnd(3, 19); return { prompt: `${a} × ${b}`, answer: a * b }; }
    if (kind === 1) { const b = rnd(3, 14); const q = rnd(3, 14); return { prompt: `${b * q} ÷ ${b}`, answer: q }; }
    if (kind === 2) { const a = rnd(30, 120); const b = rnd(12, 45); return { prompt: `${a} - ${b}`, answer: a - b }; }
    const a = rnd(2, 9); const b = rnd(2, 9); const c = rnd(2, 9);
    return { prompt: `${a} × ${b} + ${c}`, answer: a * b + c };
  }
  const kind = rnd(0, 3);
  if (kind === 0) { const a = rnd(12, 29); const b = rnd(6, 19); return { prompt: `${a} × ${b}`, answer: a * b }; }
  if (kind === 1) { const a = rnd(3, 12); return { prompt: `${a}²`, answer: a * a }; }
  if (kind === 2) { const a = rnd(4, 15); const b = rnd(3, 12); const c = rnd(2, 9); return { prompt: `${a} × ${b} - ${c}`, answer: a * b - c }; }
  const b = rnd(4, 16); const q = rnd(6, 24); return { prompt: `${b * q} ÷ ${b}`, answer: q };
}

function equationProblem(difficulty) {
  const x = rnd(2, difficulty === 'hard' ? 19 : 12);
  const a = rnd(2, difficulty === 'easy' ? 6 : 12);
  if (difficulty === 'hard' && rnd(0, 1) === 0) {
    const k = rnd(1, 8); const c = rnd(1, 9);
    return { prompt: `${a}(x - ${c}) = ${a * k}`, answer: k + c, hint: 'x' };
  }
  const b = rnd(1, 20);
  const sign = rnd(0, 1) ? '+' : '-';
  const rhs = sign === '+' ? a * x + b : a * x - b;
  return { prompt: `${a}x ${sign} ${b} = ${rhs}`, answer: x, hint: 'x' };
}

function numberPuzzle(difficulty) {
  const width = 3;
  const rule = pick(difficulty === 'easy' ? ['sum', 'diff'] : ['sum', 'diff', 'product', 'scale']);
  const rows = [];
  let answer = 0;
  for (let r = 0; r < width; r += 1) {
    const a = rnd(2, difficulty === 'hard' ? 18 : 12);
    const b = rnd(2, difficulty === 'hard' ? 18 : 12);
    let c;
    if (rule === 'sum') c = a + b;
    else if (rule === 'diff') c = Math.abs(a - b) + 2;
    else if (rule === 'product') c = a * 2 + b;
    else c = a * b;
    rows.push([a, b, c]);
    if (r === width - 1) answer = c;
  }
  const shown = rows.map((row, i) => (i === rows.length - 1 ? `${row[0]}, ${row[1]}, ?` : row.join(', '))).join('   |   ');
  return {
    prompt: `Every row follows one rule. Find the missing number.\n${shown}`,
    ...choiceFields(answer, difficulty === 'hard' ? 12 : 6),
    rule,
  };
}

function patternProblem(difficulty) {
  const kind = pick(difficulty === 'easy' ? ['arith', 'geo'] : ['arith', 'geo', 'square', 'fib', 'alt']);
  let seq = [];
  let next = 0;
  if (kind === 'arith') { const start = rnd(1, 12); const d = rnd(2, difficulty === 'hard' ? 13 : 7); seq = [start, start + d, start + 2 * d, start + 3 * d]; next = start + 4 * d; }
  else if (kind === 'geo') { const start = rnd(1, 4); const r = rnd(2, 3); seq = [start, start * r, start * r * r, start * r ** 3]; next = start * r ** 4; }
  else if (kind === 'square') { const start = rnd(2, 5); seq = [start ** 2, (start + 1) ** 2, (start + 2) ** 2, (start + 3) ** 2]; next = (start + 4) ** 2; }
  else if (kind === 'fib') { const a = rnd(1, 5); const b = rnd(2, 6); seq = [a, b, a + b, a + 2 * b]; next = 2 * a + 3 * b; }
  else { const start = rnd(20, 60); const d1 = rnd(2, 9); const d2 = rnd(2, 9); seq = [start, start - d1, start - d1 + d2, start - 2 * d1 + d2]; next = start - 2 * d1 + 2 * d2; }
  return { prompt: `${seq.join(', ')}, ?`, ...choiceFields(next, 10), kind };
}

function logicProblem() {
  const kind = rnd(0, 3);
  if (kind === 0) {
    const [first, second, third] = shuffled(NAMES).slice(0, 3);
    const prompt = `${first} is taller than ${second}. ${second} is taller than ${third}. Who is the shortest?`;
    const outsider = NAMES.find(name => ![first, second, third].includes(name));
    return { prompt, ...stringChoices(third, [first, second, outsider]), reason: `${third} is below ${second}, which is below ${first}.` };
  }
  if (kind === 1) {
    const sets = [['Bloops', 'Razzies', 'Lazzies'], ['Wuggs', 'Zizzes', 'Tittes'], ['Frams', 'Gloims', 'Snooks']];
    const [A, B, C] = pick(sets);
    const correct = `All ${A} are ${C}`;
    return {
      prompt: `All ${A} are ${B}. All ${B} are ${C}. What must be true?`,
      ...stringChoices(correct, [`All ${C} are ${A}`, `No ${A} is ${B}`, `Some ${B} are not ${A}`]),
      reason: 'If every A is a B and every B is a C, then every A is a C.',
    };
  }
  if (kind === 2) {
    const groups = [
      { items: ['Rose', 'Lily', 'Tulip', 'Oak'], odd: 'Oak', why: 'it is a tree, the rest are flowers' },
      { items: ['Copper', 'Iron', 'Zinc', 'Sulphur'], odd: 'Sulphur', why: 'it is a non-metal' },
      { items: ['Dog', 'Cat', 'Cow', 'Eagle'], odd: 'Eagle', why: 'it is a bird' },
      { items: ['Triangle', 'Square', 'Circle', 'Rectangle'], odd: 'Circle', why: 'it has no straight sides' },
    ];
    const g = pick(groups);
    return { prompt: `Which one does not belong?`, ...stringChoices(g.odd, g.items.filter(i => i !== g.odd)), reason: g.why };
  }
  const dirs = ['north', 'east', 'south', 'west'];
  let facing = 'north';
  const steps = [];
  for (let i = 0; i < 2; i += 1) {
    const turn = rnd(0, 1) ? 'right' : 'left';
    steps.push(turn);
    facing = dirs[(dirs.indexOf(facing) + (turn === 'right' ? 1 : 3)) % 4];
  }
  return {
    prompt: `A student starts facing north, then turns ${steps.join(' and then ')}. Which direction are they facing now?`,
    ...stringChoices(facing, dirs.filter(d => d !== facing)),
    reason: `Two quarter turns: north → ${steps.join(' → ')}.`,
  };
}

function scienceProblem(difficulty) {
  const pool = QUESTION_BANK.filter(q => ['Physics', 'Chemistry', 'Biology', 'General'].includes(q.s));
  const wanted = difficulty === 'easy' ? ['General', 'Biology'] : difficulty === 'normal' ? ['Physics', 'Chemistry', 'Biology'] : pool.map(q => q.s);
  const scoped = pool.filter(q => wanted.includes(q.s));
  const item = pick(scoped.length ? scoped : pool);
  return { prompt: `${item.q} (${item.s})`, options: [...item.o], answer: item.a, explain: item.e, subject: item.s };
}

function memoryRounds(difficulty) {
  const count = difficulty === 'easy' ? 4 : difficulty === 'normal' ? 5 : 6;
  const tiles = difficulty === 'hard' ? 6 : 5;
  const rounds = [];
  for (let i = 0; i < count; i += 1) {
    const length = 3 + i;
    rounds.push({ tiles, sequence: Array.from({ length }, () => rnd(0, tiles - 1)) });
  }
  return { rounds, tiles };
}

export function generate(game, difficulty) {
  const rules = GAME_RULES[game];
  const rounds = rules?.rounds?.[difficulty] || 5;
  if (game === 'memory-challenge') {
    const memory = memoryRounds(difficulty);
    return { kind: 'memory', rounds: memory.rounds, tiles: memory.tiles, perCorrect: rules.perCorrect, bonusCap: rules.bonusCap, difficulty };
  }
  let items = [];
  for (let i = 0; i < rounds; i += 1) {
    if (game === 'math-rush' || game === 'mental-sprint') items.push({ ...mathProblem(difficulty), kind: 'input' });
    else if (game === 'equation-challenge') items.push({ ...equationProblem(difficulty), kind: 'input' });
    else if (game === 'number-puzzle') items.push({ ...numberPuzzle(difficulty), kind: 'choice' });
    else if (game === 'pattern-recognition') items.push({ ...patternProblem(difficulty), kind: 'choice' });
    else if (game === 'quick-logic') items.push({ ...logicProblem(), kind: 'choice' });
    else if (game === 'science-quiz') items.push({ ...scienceProblem(difficulty), kind: 'choice' });
  }
  const timed = rules?.timed || null;
  if (timed) items = items.slice(0, 30);
  return { kind: timed ? 'timed' : 'sequential', items, timed, perCorrect: rules.perCorrect, bonusCap: rules.bonusCap, difficulty };
}

// Reproducible answer keys for the loose ends of math generators.
function correctValue(item) {
  if (typeof item.answer === 'number') return item.answer;
  return null;
}

export function grade(game, state, submission) {
  const answers = Array.isArray(submission?.answers) ? submission.answers.slice(0, 60) : [];
  let correct = 0;
  let total = 0;
  const feedback = [];
  if (state?.kind === 'memory') {
    const rounds = Array.isArray(state.rounds) ? state.rounds : [];
    const played = Array.isArray(submission?.rounds) ? submission.rounds.slice(0, rounds.length) : [];
    rounds.forEach((round, index) => {
      total += 1;
      const attempt = played[index]?.sequence || [];
      const ok = Array.isArray(attempt) && attempt.length === round.sequence.length
        && round.sequence.every((tile, position) => Number(attempt[position]) === tile);
      if (ok) { correct += 1; feedback.push({ round: index + 1, ok: true }); } else {
        feedback.push({ round: index + 1, ok: false, expected: round.sequence });
      }
    });
  } else {
    const items = Array.isArray(state.items) ? state.items : [];
    items.forEach((item, index) => {
      total += 1;
      const given = answers[index];
      const expected = item.kind === 'choice' ? item.answer : correctValue(item);
      let ok = false;
      if (item.kind === 'choice') ok = Number(given) === expected;
      else {
        const numeric = Number(String(given ?? '').trim());
        ok = Number.isFinite(numeric) && expected !== null && numeric === expected;
      }
      if (ok) correct += 1;
      feedback.push({ index, ok, expected, prompt: item.prompt, explain: item.explain || item.reason || null });
    });
  }
  const rules = GAME_RULES[game] || { perCorrect: 2, bonusCap: 10 };
  const started = Date.parse(submission?.started_at || 0);
  const ended = Date.parse(submission?.ended_at || 0);
  const durationMs = Number.isFinite(started) && Number.isFinite(ended) ? Math.max(0, ended - started) : 0;
  // Plausibility bounds stop trivially impossible "perfect" claims. A round with
  // no usable server timestamps earns nothing rather than defaulting to trusted.
  const minimumMs = total * (state?.kind === 'memory' ? 350 : 250);
  const timed = Number.isFinite(started) && Number.isFinite(ended);
  const plausible = timed && durationMs >= minimumMs;
  const score = plausible ? correct * (rules.perCorrect || 2) : 0;
  const bonus = plausible && total > 0 && correct === total ? (rules.bonusCap || 10) : 0;
  return {
    correct,
    total,
    score: score + bonus,
    durationMs,
    plausible,
    reward: clamp(Math.round((score + bonus) / 4), 0, 25),
    feedback: feedback.slice(0, 20),
  };
}
