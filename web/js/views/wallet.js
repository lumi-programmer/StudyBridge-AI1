// Bridge Wallet — the ledger is written by the server. This page only reads it.
import { api } from '../api.js';
import { store } from '../store.js';
import { emptyState, errorCard, errorToast, h, num, pageHead, timeAgo } from '../ui.js';
import { loginRewardButton } from './shared.js';

export async function render(root, { navigate }) {
  root.appendChild(pageHead('Bridge Wallet', 'Bridge Credits', 'BC are in-app reward points earned from real study — never money, never API quota, and never editable from the browser. Basic study tools always stay free at zero credits.',
    [h('a', { class: 'btn secondary', href: '#/progress', text: 'My progress' })]));
  const body = h('div', { class: 'stack' });
  root.appendChild(body);
  let wallet;
  try { wallet = await api.get('/api/wallet?limit=30'); } catch (error) { body.replaceChildren(errorCard(error, () => { root.replaceChildren(); render(root, { navigate }); })); return; }

  body.appendChild(h('div', { class: 'grid cols-4' },
    h('div', { class: 'stat amber' }, h('span', { class: 'stat-label', text: 'Balance' }), h('b', { text: num(wallet.balance) }), h('small', { text: 'Bridge Credits' })),
    h('div', { class: 'stat teal' }, h('span', { class: 'stat-label', text: 'Earned all-time' }), h('b', { text: num(wallet.earned) }), h('small', { text: 'server-signed entries' })),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Spent' }), h('b', { text: num(wallet.spent) }), h('small', { text: 'premium packs only' })),
    h('div', { class: 'stat rose' }, h('span', { class: 'stat-label', text: 'Streak' }), h('b', { text: `${num(wallet.streak.current)} d` }), h('small', { text: `longest ${num(wallet.streak.longest)} d` }))));

  const rates = wallet.rates || {};
  body.appendChild(h('div', { class: 'grid cols-2' },
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'How BC are earned' }), h('span', { class: 'spacer' }), h('span', { class: 'tag grey', text: `cap ${rates.daily_regular_cap} BC/day` }),
        h('span', { class: 'tag green', text: wallet.basic_tools_free ? 'basics free' : '' })),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Action' }), h('th', { text: 'BC' }))),
        h('tbody', {}, Object.entries(rates.earn || {}).map(([key, value]) => h('tr', {},
          h('td', { text: { login: 'Daily login', daily_question: 'Daily question answered correctly', study_session: 'Focus session of 10+ minutes (max 2/day)', daily_goal: 'Daily study goal reached', daily_challenge: 'Daily challenge completed' }[key] || key.replace(/_/g, ' ') }),
          h('td', { class: 'num', text: String(value) })))))),
      h('p', { class: 'tiny muted', text: rates.note })),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'What costs BC' })),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Premium feature' }), h('th', { text: 'BC' }))),
        h('tbody', {}, Object.entries(rates.spend || {}).map(([key, value]) => h('tr', {},
          h('td', { text: { advanced_comparison: 'Two-model advanced check (tutor)', premium_note_pack: 'Long notes or revision sheet', deep_check_quiz: 'Deep-check quiz' }[key] || key.replace(/_/g, ' ') }),
          h('td', { class: 'num', text: String(value) })))))),
      h('p', { class: 'tiny muted', text: 'Premium items are optional enhancements. Scanning, notes, quizzes from your own text, focus sessions, games and analytics never cost anything.' }));

  body.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Ledger history' }), h('span', { class: 'spacer' }),
      h('span', { class: 'tag grey', text: 'newest first' })),
    wallet.history.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'When' }), h('th', { text: 'Reason' }), h('th', { text: 'BC' }), h('th', { text: 'Balance after' }))),
      h('tbody', {}, wallet.history.map(row => h('tr', {},
        h('td', { class: 'tiny muted', text: timeAgo(row.created_at) }),
        h('td', {}, h('div', { text: row.label || row.reason }), h('small', { class: 'muted tiny', text: row.reason || '' })),
        h('td', { class: `num ${row.direction === 'earn' ? 'ok-text' : 'bad-text'}`, text: `${row.direction === 'earn' ? '+' : '−'}${num(row.amount)}` }),
        h('td', { class: 'num', text: num(row.balance_after) })))))
      : emptyState('No entries yet', 'Claim your daily login and the first row appears here.'),
    wallet.hasMore ? h('div', { class: 'row end' }, loadMoreButton(wallet, body, root, navigate)) : h('p', { class: 'tiny muted', text: 'That is the full recorded history shown here.' })));

  const ach = await api.get('/api/achievements').catch(() => null);
  if (ach) {
    body.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'Achievements' }), h('span', { class: 'spacer' }),
        h('span', { class: 'tag green', text: `${ach.earned.length} earned` })),
      h('div', { class: 'ach-grid' }, ach.catalogue.map(a => h('div', { class: `ach${a.earned ? ' on' : ''}` },
        h('b', { text: a.title }), h('span', { class: 'tag amber', text: `+${a.reward} BC` }),
        h('small', { class: 'muted tiny', text: a.earned ? 'unlocked once' : 'not yet reached' }))),
        h('p', { class: 'tiny muted', style: { flexBasis: '100%' }, text: 'Achievements are granted by the server when the underlying record exists — they cannot be claimed from the page.' }))));
  }

  body.appendChild(h('section', { class: 'card row' },
    h('div', { style: { flex: 1 } }, h('b', { text: 'Today’s quick wins' }), h('p', { class: 'tiny muted', text: 'Login +30 BC, daily question +10 BC, first session +15 BC, goal +20 BC, challenge +15 BC.' })),
    loginRewardButton(store.boot?.daily?.login_claimed === true, () => { root.replaceChildren(); render(root, { navigate }); })));
}

function loadMoreButton(wallet, body, root, navigate) {
  return h('button', { class: 'btn sm secondary', type: 'button', text: 'Show more entries', onClick: async event => {
    // currentTarget is gone once the await resumes, so hold the button itself.
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const more = await api.get('/api/wallet?limit=100');
      wallet.history = more.history;
      wallet.hasMore = more.hasMore;
      root.replaceChildren();
      render(root, { navigate });
    } catch (error) { button.disabled = false; errorToast(error); }
  } });
}
