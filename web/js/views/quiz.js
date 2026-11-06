// Quiz player. Questions arrive without answer keys; grading, explanations and
// any reward come back from the server after submit.
import { api } from '../api.js';
import { clientKey, refresh, store } from '../store.js';
import { errorToast, h, num, openSheet, sheetTitle, toast } from '../ui.js';
import { originBanner } from './shared.js';

export async function openQuiz(quizId, { onDone } = {}) {
  let data;
  try { data = await api.get(`/api/quizzes/${quizId}`); } catch (error) { errorToast(error); return; }
  playQuiz({ quiz_id: quizId, title: data.quiz.title, origin: data.quiz.origin, questions: data.questions, model: data.quiz.model }, { onDone });
}

export function playQuiz(payload, { onDone } = {}) {
  const { quiz_id: quizId, title, origin, questions, note } = payload;
  const started = Date.now();
  const answers = new Array(questions.length).fill(null);
  const key = clientKey();
  const body = h('div', { class: 'quiz' });
  const submit = h('button', { class: 'btn', type: 'button', text: 'Submit answers', onClick: send });
  const progress = h('span', { class: 'tiny muted', text: `0 / ${questions.length} answered` });

  const cards = questions.map((q, index) => {
    const opts = h('div', { class: 'options' }, q.options.map((option, choice) => h('button', {
      class: 'option', type: 'button', onClick: event => {
        answers[index] = choice;
        for (const b of event.currentTarget.parentElement.children) b.classList.remove('chosen');
        event.currentTarget.classList.add('chosen');
        progress.textContent = `${answers.filter(a => a !== null).length} / ${questions.length} answered`;
      },
    }, h('span', { class: 'opt-key', text: String.fromCharCode(65 + choice) }), h('span', { text: option }))));
    return h('article', { class: 'quiz-q' },
      h('div', { class: 'row between' }, h('b', { text: `Q${index + 1}` }), sourceTag(q.source)),
      h('p', { class: 'dq-q', text: q.q }), opts, h('div', { class: 'quiz-fb' }));
  });
  body.append(...cards);

  const close = openSheet(h('div', {},
    sheetTitle(title || 'Quiz', `${questions.length} questions · scored on the server`),
    originBanner(origin, note),
    body,
    h('div', { class: 'row between sticky-foot' }, progress, h('div', { class: 'row' },
      h('button', { class: 'btn secondary', type: 'button', text: 'Close', onClick: () => close() }), submit))));

  async function send() {
    if (answers.some(a => a === null) && !submit.dataset.confirmed) {
      submit.dataset.confirmed = '1';
      toast('Some questions are unanswered — press Submit again to score anyway.');
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Scoring…';
    try {
      const res = await api.post(`/api/quizzes/${quizId}/submit`, {
        answers: answers.map(a => (a === null ? -1 : a)), client_key: key,
        duration_seconds: Math.round((Date.now() - started) / 1000),
      });
      res.feedback.forEach(item => {
        const card = cards[item.index];
        if (!card) return;
        const buttons = card.querySelectorAll('.option');
        buttons.forEach(b => { b.disabled = true; });
        buttons[item.answer]?.classList.add('right');
        if (!item.ok && item.chosen !== null && item.chosen >= 0) buttons[item.chosen]?.classList.add('wrong');
        const fb = card.querySelector('.quiz-fb');
        fb.replaceChildren(h('p', { class: `tiny ${item.ok ? 'ok-text' : 'bad-text'}`, text: `${item.ok ? 'Correct.' : 'Not this time.'} ${item.explain || ''}` }));
      });
      const credit = (res.awarded || []).reduce((a, x) => a + (x?.reward || 0), 0);
      body.prepend(h('div', { class: `banner ${res.percent >= 70 ? 'good' : 'info'}` },
        h('div', {}, h('b', { text: `${res.score} / ${res.total} · ${res.percent}%` }),
          h('span', { text: `${credit ? `Achievement unlocked: +${credit} BC. ` : ''}${res.replayed ? 'This attempt was already saved.' : 'Saved to your progress.'}` }))));
      body.parentElement?.scrollTo?.({ top: 0, behavior: 'smooth' });
      submit.textContent = 'Scored';
      refresh();
      onDone?.(res);
    } catch (error) {
      submit.disabled = false;
      submit.textContent = 'Submit answers';
      errorToast(error);
    }
  }
}

function sourceTag(source) {
  if (!source) return null;
  if (source.kind === 'bank') return h('span', { class: 'tag grey', text: `Practice bank · ${source.subject}` });
  if (source.page) return h('span', { class: 'tag teal', text: `${source.chapter ? `${source.chapter} · ` : ''}p. ${source.page}` });
  return null;
}

export function quizCreator({ spaceId, bookId, chapterId, subject, onCreated }) {
  const count = h('select', {}, [5, 8, 10, 12, 15].map(n => h('option', { value: n, selected: n === 8 }, `${n} questions`)));
  const aiPrice = store.boot?.economy?.pricing?.practice_quiz;
  const run = mode => async event => {
    const btn = event.currentTarget;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Building…';
    try {
      // A key on every request means a double click cannot be charged twice.
      const res = await api.post('/api/quizzes', {
        mode, count: Number(count.value), space_id: spaceId, book_id: bookId, chapter_id: chapterId, subject,
        client_key: clientKey(),
      });
      playQuiz(res, { onDone: onCreated });
      if (mode === 'ai' && res.credits_spent !== undefined) {
        toast(res.credits_spent
          ? `AI quiz built · ${num(res.credits_spent)} BC used · balance ${num(res.balance)} BC.`
          : 'Built from your own scanned text — no credits were deducted.');
      }
      onCreated?.();
    } catch (error) {
      errorToast(error);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
    }
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'row' }, count),
    h('div', { class: 'quiz-modes' },
      h('button', { class: 'mode-card', type: 'button', onClick: run('local') }, h('b', { text: 'From my scans' }), h('small', { text: 'Free · fill-in and definition questions built from your own pages' })),
      h('button', { class: 'mode-card', type: 'button', onClick: run('bank') }, h('b', { text: 'Practice bank' }), h('small', { text: 'Free · checked questions, no scan needed' })),
      h('button', { class: 'mode-card', type: 'button', onClick: run('ai') }, h('b', { text: 'AI questions' }),
        h('small', { text: Number.isFinite(aiPrice) ? `${aiPrice} BC · written from your scans · refunded if it fails` : 'Written from your scans · falls back to free scan questions if none' }))));
}
