// Focus Mode — the timer is the server's, the browser only displays it.
import { api } from '../api.js';
import { clock, confirmSheet, emptyState, errorToast, field, h, num, openSheet, pageHead, select, sheetTitle, spinner, timeAgo, toast } from '../ui.js';
import { meter, ring } from '../charts.js';
import { MODE_LABEL, current, discardSession, elapsedSeconds, finishSession, onFocus, remainingSeconds, run, startSession } from '../focus.js';

const MODES = [
  ['deep', 'Deep Study', 'Notifications off, full-screen timer. 25 or 50 minutes.'],
  ['normal', 'Normal Study', 'The rest of the app stays usable while the timer runs.'],
  ['custom', 'Custom Study', 'Any length you choose, from 1 to 240 minutes.'],
];
const PRESETS = [25, 50];

export async function render(root, { navigate }) {
  root.appendChild(pageHead('Focus Mode', 'Study with a real timer', 'Minutes are measured on the server clock, so a refresh or a closed tab cannot invent study time. Sessions of 10 minutes or more earn 15 BC, up to two a day — shorter ones still count as progress.',
    [h('a', { class: 'btn secondary', href: '#/progress', text: 'See my progress' })]));

  const left = h('div', { class: 'stack' });
  const right = h('div', { class: 'stack' });
  root.appendChild(h('div', { class: 'grid side' }, left, right));

  let mode = 'deep';
  const planWrap = h('div', { class: 'row wrap-gap' });
  const customInput = h('input', { type: 'number', min: '1', max: '240', value: '45', 'aria-label': 'Custom minutes', style: { maxWidth: '110px' } });
  let planned = 25;
  const spaceSel = h('select', { 'aria-label': 'Space' });
  api.get('/api/spaces').then(spaces => {
    spaceSel.replaceChildren(h('option', { value: '' }, 'No space (general study)'),
      ...spaces.map(s => h('option', { value: s.id }, s.name)));
  }).catch(() => spaceSel.replaceChildren(h('option', { value: '' }, 'Spaces unavailable')));

  function paintPlan() {
    const buttons = mode === 'custom'
      ? [h('div', { class: 'row' }, customInput, h('span', { class: 'tiny muted', text: 'minutes (1–240)' }))]
      : PRESETS.map(m => h('button', { class: `chip preset${planned === m ? ' on' : ''}`, type: 'button', onClick: () => { planned = m; paintPlan(); } }, `${m} min`));
    if (mode !== 'custom') planned = PRESETS.includes(planned) ? planned : 25;
    else planned = Math.min(240, Math.max(1, Number(customInput.value) || 45));
    planWrap.replaceChildren(...buttons);
    if (mode !== 'custom') {
      for (const b of planWrap.querySelectorAll('.preset')) b.classList.toggle('on', b.textContent === `${planned} min`);
    }
    customInput.addEventListener('input', () => { planned = Math.min(240, Math.max(1, Number(customInput.value) || 45)); });
  }

  const modeCards = h('div', { class: 'mode-grid' }, MODES.map(([key, title, blurb]) => h('button', {
    class: `mode-card${key === mode ? ' on' : ''}`, type: 'button', 'aria-pressed': String(key === mode),
    onClick: event => { mode = key; paintPlan(); for (const c of modeCards.children) { c.classList.remove('on'); c.setAttribute('aria-pressed', 'false'); } event.currentTarget.classList.add('on'); event.currentTarget.setAttribute('aria-pressed', 'true'); },
  }, h('b', { text: title }), h('small', { text: blurb }))));

  const startBtn = h('button', { class: 'btn block', type: 'button', text: 'Start session', onClick: async () => {
    startBtn.disabled = true;
    try {
      const res = await startSession({ mode, planned_minutes: planned, space_id: spaceSel.value || undefined });
      toast(res.resumed ? 'Resumed your running session.' : `${MODE_LABEL[mode]} started — ${planned} minutes.`, 'good');
      paintState(current());
      refreshList();
    } catch (error) { errorToast(error); }
    startBtn.disabled = false;
  } });

  left.appendChild(h('section', { class: 'card stack' }, h('h3', { text: 'Set up a session' }), modeCards, paintPlan(), planWrap,
    field('Space (optional)', spaceSel, 'Links this session to one space so its progress and history line up.'), startBtn));

  const timerBox = h('section', { class: 'card stack timer-box' });
  left.appendChild(timerBox);

  function paintState(state) {
    document.body.classList.toggle('deep-focus', Boolean(state && state.mode === 'deep'));
    if (!state) {
      timerBox.classList.remove('running');
      timerBox.replaceChildren(h('h3', { text: 'No session running' }),
        h('p', { class: 'tiny muted', text: 'Start one above. You can leave this page — the dock keeps the countdown and the server keeps counting.' }));
      startBtn.disabled = false;
      startBtn.textContent = 'Start session';
      return;
    }
    const remaining = remainingSeconds(state);
    const elapsed = elapsedSeconds(state);
    timerBox.classList.add('running');
    timerBox.replaceChildren(
      h('div', { class: 'card-head' }, h('h3', { text: MODE_LABEL[state.mode] || 'Focus' }), h('span', { class: 'spacer' }),
        h('span', { class: 'tag teal', text: `planned ${state.planned_minutes} min` })),
      h('div', { class: 'row center timer-row' }, ring(Math.max(0, state.planned_minutes * 60 - remaining), state.planned_minutes * 60, { size: 168, label: clock(remaining), sub: 'left' })),
      h('p', { class: 'tiny muted center', text: `${Math.floor(elapsed / 60)} min elapsed. Minutes below 10 earn no credits but still record as study.` }),
      meter(elapsed / 60, state.planned_minutes, {}),
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', text: 'Finish & save', onClick: () => finish() }),
        h('button', { class: 'btn secondary', type: 'button', text: 'Discard', onClick: () => confirmSheet({
          title: 'Discard this session?', body: 'The session row is deleted and records no study time. Credits already earned today are not reversed.',
          confirmLabel: 'Discard session', tone: 'danger', onConfirm: async () => { await discardSession(); paintState(null); refreshList(); toast('Session discarded.'); },
        }) })));
    startBtn.disabled = true;
    startBtn.textContent = 'A session is already running';
  }

  async function finish() {
    const btn = timerBox.querySelector('.btn');
    if (btn) btn.disabled = true;
    try {
      const result = await finishSession();
      if (result) showResult(result, navigate);
      paintState(null);
      refreshList();
    } catch (error) {
      errorToast(error);
      if (btn) btn.disabled = false;
    }
  }

  const stop = onFocus(paintState);
  run();
  paintState(current());

  const list = h('section', { class: 'card stack' }, h('div', { class: 'card-head' }, h('h3', { text: 'Recent sessions' })), spinner('Loading…'));
  right.appendChild(list);
  async function refreshList() {
    try {
      const res = await api.get('/api/sessions');
      list.replaceChildren(h('div', { class: 'card-head' }, h('h3', { text: 'Recent sessions' }), h('span', { class: 'spacer' }),
          h('span', { class: 'tag grey', text: `${num(res.recorded_minutes)} min recorded` })),
        h('p', { class: 'tiny muted', text: res.rules.note }),
        res.items.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Started' }), h('th', { text: 'Mode' }), h('th', { text: 'Minutes' }), h('th', { text: 'Status' }))),
          h('tbody', {}, res.items.slice(0, 15).map(s => h('tr', {},
            h('td', { class: 'tiny', text: timeAgo(s.started_at) }),
            h('td', { text: MODE_LABEL[s.mode] || s.mode }),
            h('td', { class: 'num', text: s.completed ? String(s.minutes) : `${s.minutes || 0}+` }),
            h('td', {}, s.completed ? h('span', { class: 'tag green', text: 'saved' }) : h('span', { class: 'tag amber', text: 'running' })) ))))
          : emptyState('No sessions yet', 'Your first finished session shows up here.'));
    } catch (error) { list.replaceChildren(h('div', { class: 'card-head' }, h('h3', { text: 'Recent sessions' })), h('div', { class: 'banner bad' }, h('div', {}, h('b', { text: 'Could not load sessions' }), h('span', { text: error.hint || error.message })))); }
  }
  refreshList();

  return () => {
    stop();
    document.body.classList.remove('deep-focus');
  };
}

function showResult(result, navigate) {
  const credits = (result.awarded || []).reduce((acc, a) => acc + (a.amount || a.awarded?.reward || a.reward || 0), 0);
  const close = openSheet(h('div', { class: 'stack' },
    sheetTitle('Session saved', `${result.minutes} minutes of real study recorded`),
    result.reward_note ? h('div', { class: 'banner info' }, h('div', {}, h('b', { text: 'No credits this time' }), h('span', { text: result.reward_note }))) : null,
    result.cap_note ? h('div', { class: 'banner info' }, h('div', {}, h('b', { text: 'Daily cap' }), h('span', { text: result.cap_note }))) : null,
    h('div', { class: 'grid cols-3' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Minutes' }), h('b', { text: String(result.minutes) })),
      h('div', { class: 'stat amber' }, h('span', { class: 'stat-label', text: 'Credits' }), h('b', { text: `+${credits}` }), h('small', { text: credits ? 'added to your wallet' : 'nothing earned this round' })),
      h('div', { class: 'stat teal' }, h('span', { class: 'stat-label', text: 'Streak' }), h('b', { text: String(result.streak?.current ?? 0) }), h('small', { text: 'days in a row' }))),
    result.goal ? h('p', { class: 'tiny muted', text: `Today’s goal: ${result.goal.minutes_today} of ${result.goal.done ? 'reached' : 'on the way'} minutes.` }) : null,
    h('div', { class: 'row end' },
      h('button', { class: 'btn secondary', type: 'button', text: 'Close', onClick: () => close() }),
      h('a', { class: 'btn', href: '#/progress', text: 'See progress', onClick: () => close() }))));
}
