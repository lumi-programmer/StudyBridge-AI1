// Game Center — the server generates every puzzle and grades every answer.
// The browser only sends what the student typed, clicked or tapped.
import { api } from '../api.js';
import { refresh } from '../store.js';
import { clock, errorToast, h, num, openSheet, pageHead, sheetTitle, spinner, toast } from '../ui.js';

const BLANK = 'unanswered';

export async function render(root, { navigate }) {
  let active = null;
  root.appendChild(pageHead('🎮 Game Center', 'Brain games', 'Always open — no study session required first. Rewards are capped daily so they cannot be farmed, and each score is checked against the puzzle the server issued.',
    [h('a', { class: 'btn secondary', href: '#/wallet', text: 'My wallet' })]));
  const board = h('div', { class: 'stack' });
  root.appendChild(board);

  // Every number on this board is the server’s counter, so it is re-read after a
  // graded round instead of leaving “0 BC earned today” beside a reward that landed.
  async function paint() {
    let data;
    try { data = await api.get('/api/games'); } catch (error) {
      board.replaceChildren(h('div', { class: 'banner bad' }, h('div', {}, h('b', { text: 'Games unavailable' }), h('span', { text: error.hint || error.message }))));
      return;
    }
    const ruleOf = game => (data.rules || []).find(r => r.game === game) || null;
    board.replaceChildren(
      h('section', { class: 'card row wrap-gap caps' },
        h('span', { class: 'tag amber', text: `💎 ${data.today.credits_earned} BC earned today` }),
        h('span', { class: 'tag grey', text: `🎮 ${data.today.rounds} round${data.today.rounds === 1 ? '' : 's'} played` }),
        h('span', { class: 'tag teal', text: `${data.today.reward_rounds_left} rewarded round${data.today.reward_rounds_left === 1 ? '' : 's'} left (cap ${data.today.daily_cap} BC/day)` }),
        h('small', { class: 'muted tiny', text: data.note })),
      h('div', { class: 'grid cols-4' }, data.games.map(game => h('article', { class: 'card game-card' },
        h('div', { class: 'row' }, h('span', { class: 'game-icon', 'aria-hidden': 'true', text: game.icon }), h('h3', { text: game.name, style: { margin: 0 } })),
        h('p', { class: 'tiny muted', text: game.blurb }),
        h('div', { class: 'row wrap-gap' },
          h('span', { class: 'tag grey', text: `best ${num(game.best_score)}` }),
          h('span', { class: 'tag grey', text: `played ${game.rounds_played}` })),
        h('div', { class: 'row' }, (game.difficulties || []).map(d => h('button', {
          class: `btn sm secondary`, type: 'button', text: d, onClick: () => { active = play(game, d, ruleOf(game.game), navigate, active, paint); },
        }))),
        ruleOf(game.game) ? h('button', { class: 'link-btn', type: 'button', text: 'How to play', onClick: () => showRules(ruleOf(game.game)) }) : null))));
  }

  await paint();
  return () => { active?.(); active = null; };
}

function showRules(rules) {
  const close = openSheet(h('div', { class: 'stack' }, sheetTitle(rules.name, rules.blurb),
    h('p', { text: rules.how_to_play || '' }),
    h('div', { class: 'grid cols-3' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Rounds' }), h('b', { text: Object.entries(rules.rounds || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—' })),
      h('div', { class: 'stat amber' }, h('span', { class: 'stat-label', text: 'Points per correct' }), h('b', { text: String(rules.points_per_correct ?? '—') })),
      h('div', { class: 'stat teal' }, h('span', { class: 'stat-label', text: 'Perfect bonus' }), h('b', { text: String(rules.perfect_bonus ?? '—') }))),
    h('div', { class: 'row end' }, h('button', { class: 'btn', type: 'button', text: 'Close', onClick: () => close() }))));
}

function play(game, difficulty, rules, navigate, previousClose, reload) {
  previousClose?.();
  const dismiss = openSheet(h('div', { class: 'stack' }, sheetTitle(game.name, 'Starting the round…'), spinner('The server is generating your puzzle…')));
  let cleanup = null;
  let close = dismiss;
  api.post(`/api/games/${game.game}/start`, { difficulty }).then(start => {
    close();
    const view = (start.kind === 'memory' ? memoryRunner : start.kind === 'timed' ? timedRunner : sequentialRunner)(start);
    let finished = false;
    view.onFinish(payload => {
      if (finished) return;
      finished = true;
      const btn = view.finishBtn;
      if (btn) { btn.disabled = true; btn.textContent = 'Scoring…'; }
      api.post(`/api/games/${game.game}/finish`, payload).then(res => {
        finished = 'done';
        // The ledger wrote while the round was open, so the header chip and this
        // board are both re-read from the server rather than left showing the old totals.
        refresh().catch(() => { /* the result sheet already carries the server’s numbers */ });
        reload?.();
        view.showResult(res, game, navigate);
        toast(`${res.score} points${res.credits_earned ? ` · +${res.credits_earned} BC 💎` : ''}.`, res.credits_earned ? 'good' : '');
      }).catch(error => {
        finished = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Submit answers'; }
        errorToast(error);
      });
    });
    cleanup = view.cleanup;
    close = openSheet(h('div', { class: 'game-sheet' },
      sheetTitle(game.name, `${start.rounds} ${start.kind === 'memory' ? 'rounds' : 'questions'} · ${difficulty} · graded on the server`),
      view.node));
  }).catch(error => { close(); errorToast(error); });
  return () => { try { cleanup?.(); } catch { /* timer already stopped */ } close(); };
}

function resultBanner(res, game) {
  return h('div', { class: 'stack' },
    h('div', { class: `banner ${res.score > 0 ? 'good' : 'info'}` }, h('div', {},
      h('b', { text: `${res.correct} / ${res.total} correct · ${num(res.score)} points` }),
      h('span', { text: `${res.credits_earned ? `+${res.credits_earned} BC. ` : ''}Best at ${game.name}: ${num(res.best_score)} · wallet ${num(res.balance)} BC.` }))),
    res.note ? h('div', { class: 'banner warn' }, h('div', {}, h('b', { text: 'No credits this round' }), h('span', { text: res.note }))) : null,
    res.cap_note ? h('div', { class: 'banner info' }, h('div', {}, h('b', { text: 'Daily limit' }), h('span', { text: res.cap_note }))) : null,
    res.achievement ? h('div', { class: 'banner good' }, h('div', {}, h('b', { text: `🏆 Achievement: ${res.achievement.title}` }), h('span', { text: `+${res.achievement.reward} BC 💎 — once only.` }))) : null,
    h('details', {}, h('summary', { class: 'tiny', text: 'Review the answers' }),
      (res.feedback || []).map(fb => h('div', { class: `fb ${fb.ok ? 'ok' : 'no'}` },
        h('b', { class: 'tiny', text: fb.prompt ? `Q${(fb.index ?? 0) + 1}` : `Round ${fb.round}` }),
        h('div', { style: { flex: 1 } },
          fb.prompt ? h('div', { class: 'tiny', text: fb.prompt }) : null,
          h('div', { class: 'tiny muted', text: `Answer: ${Array.isArray(fb.expected) ? fb.expected.join(' → ') : fb.expected}` }),
          fb.explain ? h('div', { class: 'tiny muted', text: fb.explain }) : null)))));
}

function renderIn(view, res, game, navigate) {
  view.stage.replaceChildren(resultBanner(res, game));
  if (navigate) view.node.querySelectorAll('button').forEach(b => { if (b !== view.finishBtn) b.disabled = true; });
}

// ---------- one question at a time ----------
function sequentialRunner(start) {
  const items = start.items || [];
  const answers = new Array(items.length).fill(BLANK);
  let index = 0;
  const stage = h('div', { class: 'game-stage' });
  const finishBtn = h('button', { class: 'btn', type: 'button', text: 'Submit answers' });
  const progress = h('span', { class: 'tiny muted' });
  let onFinish = () => {};
  const node = h('div', { class: 'stack' }, stage, h('div', { class: 'row between sticky-foot' }, progress, finishBtn));
  const view = {
    node, stage, finishBtn,
    onFinish: fn => { onFinish = fn; },
    showResult: (res, game, navigate) => renderIn(view, res, game, navigate),
  };

  function commit() {
    const input = stage.querySelector('input');
    if (input) answers[index] = input.value.trim() || BLANK;
  }
  function submit() {
    commit();
    onFinish({ session_id: start.session_id, answers });
  }
  function next() {
    commit();
    if (index >= items.length - 1) { paint(); return; }
    index += 1;
    paint();
  }
  function paint() {
    const item = items[index];
    progress.textContent = `Question ${index + 1} of ${items.length} · ${answers.filter(a => a !== BLANK).length} answered`;
    const body = h('div', { class: 'stack' }, h('p', { class: 'game-prompt', text: item.prompt }));
    if (item.mode === 'choice' && Array.isArray(item.options)) {
      body.appendChild(h('div', { class: 'options' }, item.options.map((option, choice) => h('button', {
        class: `option${answers[index] === choice ? ' chosen' : ''}`, type: 'button',
        onClick: () => { answers[index] = choice; paint(); },
      }, h('span', { class: 'opt-key', text: String.fromCharCode(65 + choice) }), h('span', { text: option })))));
      body.appendChild(h('div', { class: 'row' },
        index > 0 ? h('button', { class: 'btn secondary sm', type: 'button', text: 'Back', onClick: () => { index -= 1; paint(); } }) : null,
        index < items.length - 1 ? h('button', { class: 'btn sm', type: 'button', text: 'Next question', onClick: next }) : null));
    } else {
      const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Your answer',
        value: answers[index] === BLANK ? '' : String(answers[index]),
        onInput: () => { answers[index] = input.value.trim() || BLANK; },
        onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); if (index < items.length - 1) next(); else submit(); } } });
      body.append(h('div', { class: 'row' }, input, item.hint ? h('span', { class: 'tag grey', text: `solve for ${item.hint}` }) : null),
        h('div', { class: 'row' },
          index > 0 ? h('button', { class: 'btn secondary sm', type: 'button', text: 'Back', onClick: () => { index -= 1; paint(); } }) : null,
          index < items.length - 1 ? h('button', { class: 'btn sm', type: 'button', text: 'Next question', onClick: next }) : null));
      setTimeout(() => input.focus(), 40);
    }
    stage.replaceChildren(body);
  }
  finishBtn.addEventListener('click', submit);
  paint();
  return view;
}

// ---------- 60 second sprint ----------
function timedRunner(start) {
  const items = start.items || [];
  const answers = new Array(items.length).fill(BLANK);
  let index = 0;
  let ended = false;
  const total = start.timed || 60;
  const startedAt = Date.now();
  const input = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off', 'aria-label': 'Answer' });
  const prompt = h('p', { class: 'game-prompt sprint-prompt', text: items[0]?.prompt || '—' });
  const clockNode = h('b', { class: 'sprint-clock', text: clock(total) });
  const tally = h('span', { class: 'tiny muted', text: 'answered 0' });
  const finishBtn = h('button', { class: 'btn secondary', type: 'button', text: 'Stop & score' });
  const stage = h('div', { class: 'game-stage' }, prompt);
  let onFinish = () => {};
  const node = h('div', { class: 'stack' }, h('div', { class: 'row between' }, tally, clockNode), stage, h('div', { class: 'row' }, input, finishBtn));
  const view = {
    node, stage, finishBtn,
    onFinish: fn => { onFinish = fn; },
    showResult: (res, game, navigate) => renderIn(view, res, game, navigate),
    cleanup: () => clearInterval(timer),
  };
  function store() {
    const value = input.value.trim();
    if (value !== '' && Number.isFinite(Number(value))) answers[index] = Number(value);
  }
  function advance() {
    store();
    tally.textContent = `answered ${answers.filter(a => a !== BLANK).length}`;
    if (index < items.length - 1) index += 1;
    prompt.textContent = items[index]?.prompt || '—';
    input.value = '';
    input.focus();
  }
  function end() {
    if (ended) return;
    ended = true;
    clearInterval(timer);
    input.disabled = true;
    store();
    onFinish({ session_id: start.session_id, answers });
  }
  const timer = setInterval(() => {
    const left = total - (Date.now() - startedAt) / 1000;
    clockNode.textContent = clock(Math.max(0, left));
    if (left <= 0) end();
  }, 250);
  input.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); advance(); } });
  finishBtn.addEventListener('click', end);
  setTimeout(() => input.focus(), 40);
  return view;
}

// ---------- memory ----------
function memoryRunner(start) {
  const rounds = start.memory?.rounds || [];
  const tiles = start.memory?.tiles || 5;
  const played = [];
  let round = 0;
  let cursor = 0;
  let phase = 'watch';
  let flash = null;
  const status = h('p', { class: 'tiny muted' });
  const stage = h('div', { class: 'game-stage' });
  const grid = h('div', { class: 'memory-grid', style: { gridTemplateColumns: `repeat(${tiles}, 1fr)` } });
  const finishBtn = h('button', { class: 'btn', type: 'button', text: 'Submit for grading' });
  let onFinish = () => {};
  const node = h('div', { class: 'stack' }, status, stage, grid, finishBtn);
  const view = {
    node, stage, finishBtn, grid,
    onFinish: fn => { onFinish = fn; },
    showResult: (res, game, navigate) => renderIn(view, res, game, navigate),
    cleanup: () => clearInterval(flash),
  };
  const cells = [];
  for (let i = 0; i < tiles; i += 1) {
    const cell = h('button', { class: 'memory-tile', type: 'button', 'aria-label': `Tile ${i + 1}`, onClick: () => tap(i) }, h('span', { 'aria-hidden': 'true', text: String(i + 1) }));
    cells.push(cell);
    grid.appendChild(cell);
  }
  function paintStatus() {
    status.textContent = `Round ${round + 1} of ${rounds.length} · ${phase === 'watch' ? 'watch the sequence' : phase === 'repeat' ? 'now repeat it' : 'finished'} · ${played.filter(p => p.ok).length} correct`;
  }
  function showSequence() {
    phase = 'watch';
    cursor = 0;
    for (const cell of cells) cell.disabled = true;
    paintStatus();
    const sequence = rounds[round].sequence;
    let step = 0;
    flash = setInterval(() => {
      for (const cell of cells) cell.classList.remove('lit');
      if (step >= sequence.length) {
        clearInterval(flash);
        phase = 'repeat';
        cursor = 0;
        for (const cell of cells) cell.disabled = false;
        paintStatus();
        return;
      }
      cells[sequence[step]]?.classList.add('lit');
      step += 1;
    }, 560);
  }
  function tap(tile) {
    if (phase !== 'repeat') return;
    const sequence = rounds[round].sequence;
    cells[tile].classList.add('lit');
    setTimeout(() => cells[tile].classList.remove('lit'), 200);
    const attempt = rounds[round].attempt || (rounds[round].attempt = []);
    attempt.push(tile);
    if (tile !== sequence[cursor]) {
      played.push({ ok: false, sequence: attempt.slice() });
      rounds[round].attempt = [];
      toast(`Round ${round + 1} broke at step ${cursor + 1}.`, 'bad', 3200);
      advance();
      return;
    }
    cursor += 1;
    if (cursor >= sequence.length) {
      played.push({ ok: true, sequence: attempt.slice() });
      rounds[round].attempt = [];
      advance();
    }
  }
  function advance() {
    if (round < rounds.length - 1) { round += 1; showSequence(); return; }
    phase = 'done';
    for (const cell of cells) cell.disabled = true;
    paintStatus();
    status.textContent = `All ${rounds.length} rounds played · ${played.filter(p => p.ok).length} repeated correctly. Submit to get your score.`;
  }
  finishBtn.addEventListener('click', () => {
    finishBtn.disabled = true;
    finishBtn.textContent = 'Sending…';
    onFinish({ session_id: start.session_id, rounds: played.map(p => ({ sequence: p.sequence })) });
  });
  if (!rounds.length) stage.replaceChildren(h('p', { class: 'muted', text: 'This round had no sequence data. Start again.' }));
  else showSequence();
  return view;
}
