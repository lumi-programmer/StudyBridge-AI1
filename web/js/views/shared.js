// Pieces shared by several views.
import { api } from '../api.js';
import { refresh, store } from '../store.js';
import { colorDot, errorToast, h, toast } from '../ui.js';

export function dailyQuestionCard(daily, onDone) {
  const card = h('section', { class: 'card dq' });
  const q = daily.question;
  card.appendChild(h('div', { class: 'card-head' },
    h('h3', { text: 'Daily question' }), h('span', { class: 'tag amber', text: '+10 BC if correct' }),
    h('span', { class: 'spacer' }), h('span', { class: 'tag grey', text: q.subject })));
  card.appendChild(h('p', { class: 'dq-q', text: q.question }));
  const list = h('div', { class: 'options' });
  card.appendChild(list);
  const feedback = h('div', { class: 'dq-feedback' });
  card.appendChild(feedback);
  const answered = daily.answered;
  q.options.forEach((option, index) => {
    const btn = h('button', { class: 'option', type: 'button', disabled: answered, onClick: async () => {
      for (const b of list.querySelectorAll('button')) b.disabled = true;
      btn.classList.add('chosen');
      try {
        const res = await api.post('/api/daily/answer', { choice: index });
        if (res.already) {
          feedback.replaceChildren(h('p', { class: 'muted', text: 'Already answered today.' }));
        } else {
          list.children[res.answer_index]?.classList.add('right');
          if (!res.correct) btn.classList.add('wrong');
          feedback.replaceChildren(
            h('div', { class: `banner ${res.correct ? 'good' : 'warn'}` },
              h('div', {}, h('b', { text: res.correct ? `Correct${res.tx ? ` · +${res.tx.amount} BC` : ''}` : 'Not quite' }),
                h('span', { text: res.explanation || '' }))));
          if (res.correct && !res.tx) toast('Correct! Today’s regular credit cap was already reached, so no BC this time.', '');
        }
        await refresh();
        onDone?.();
      } catch (error) {
        for (const b of list.querySelectorAll('button')) b.disabled = false;
        btn.classList.remove('chosen');
        errorToast(error);
      }
    } }, h('span', { class: 'opt-key', text: String.fromCharCode(65 + index) }), h('span', { text: option }));
    list.appendChild(btn);
  });
  if (answered) {
    feedback.appendChild(h('div', { class: `banner ${daily.correct ? 'good' : 'info'}` },
      h('div', {}, h('b', { text: daily.correct ? 'You got today’s question right.' : 'Answered for today.' }),
        daily.explanation ? h('span', { text: daily.explanation }) : h('span', { text: 'A new question arrives tomorrow.' }))));
  }
  return card;
}

export function loginRewardButton(claimed, onDone) {
  if (claimed) return h('span', { class: 'tag green', text: 'Daily login claimed' });
  const btn = h('button', { class: 'btn amber sm', type: 'button', onClick: async () => {
    btn.disabled = true;
    try {
      const res = await api.post('/api/daily/login');
      if (res.claimed && res.tx) toast(`Daily login: +${res.tx.amount} BC`, 'good');
      else if (res.claimed) toast(res.cap_note || 'Login recorded. Today’s regular credit cap is already reached.');
      else toast('Already claimed today.');
      await refresh();
      onDone?.();
    } catch (error) { btn.disabled = false; errorToast(error); }
  } }, 'Claim +30 BC daily login');
  return btn;
}

export function spaceOptions(includeNone = true) {
  const spaces = store.boot?.spaces || [];
  return [...(includeNone ? [['', 'No space (general)']] : []), ...spaces.map(s => [s.id, s.name])];
}

export async function allSpaces() {
  return api.get('/api/spaces');
}

export function spaceChip(space) {
  return h('span', { class: 'row', style: { gap: '6px' } }, colorDot(space.color), space.name);
}

export function originBanner(origin, note) {
  if (origin === 'local_text') {
    return h('div', { class: 'banner info' }, h('div', {}, h('b', { text: 'Made from your own scanned text — no AI used' }),
      h('span', { text: note || 'These come straight from sentences in your scans, so they are exactly what your book says.' })));
  }
  if (origin === 'bank') {
    return h('div', { class: 'banner info' }, h('div', {}, h('b', { text: 'From the free practice bank' }),
      h('span', { text: note || 'Hand-checked questions that need no scan and no AI.' })));
  }
  if (origin === 'ai') {
    return h('div', { class: 'banner warn' }, h('div', {}, h('b', { text: 'AI interpretation' }),
      h('span', { text: note || 'Written by a model from your scanned pages. Check it against your book.' })));
  }
  return null;
}

export const ACTION_LIST = [
  { action: 'explain_simple', label: 'Simple explanation' },
  { action: 'explain_detailed', label: 'Detailed explanation' },
  { action: 'urdu_explain', label: 'Urdu explanation' },
  { action: 'definitions', label: 'Important definitions' },
  { action: 'summary', label: 'Chapter summary' },
  { action: 'short_notes', label: 'Short notes' },
  { action: 'long_notes', label: 'Long notes', premium: 15 },
  { action: 'mcqs', label: 'MCQs' },
  { action: 'practice', label: 'Practice questions' },
  { action: 'numericals', label: 'Solve numericals' },
  { action: 'examples', label: 'Worked examples' },
  { action: 'concepts', label: 'Key concepts' },
  { action: 'revision', label: 'Revision sheet', premium: 15 },
];
