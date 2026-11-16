// Bridge Wallet — the ledger is written by the server. This page only reads it.
import { api } from '../api.js';
import { store } from '../store.js';
import { emptyState, errorCard, errorToast, h, num, pageHead, timeAgo, untilLabel } from '../ui.js';
import { loginRewardButton } from './shared.js';

const REWARD_LABEL = {
  daily_login: 'Daily login',
  daily_question: 'Daily learning question (answered correctly)',
  study_session: 'Focus session of 10+ minutes (max 2 a day)',
  daily_goal: 'Daily study goal reached',
  daily_challenge: 'Daily challenge completed',
  streak_7: 'Seven-day streak',
  weekly_goal: 'Weekly learning goal completed',
};

const TYPE_LABEL = {
  daily_reward: 'Daily reward',
  learning_reward: 'Learning reward',
  streak_reward: 'Streak reward',
  ai_usage: 'AI usage',
  refund: 'Refund',
  adjustment: 'Adjustment',
};

export async function render(root, { navigate }) {
  root.appendChild(pageHead('💎 Bridge Wallet', 'Bridge Credits', 'BC are in-app reward points earned from real study — never money, never API quota, and never editable from the browser. Basic study tools always stay free at zero credits.',
    [h('a', { class: 'btn secondary', href: '#/rewards', text: 'Rewards Center' })]));
  const body = h('div', { class: 'stack' });
  root.appendChild(body);
  let wallet;
  try { wallet = await api.get('/api/wallet?limit=30'); } catch (error) { body.replaceChildren(errorCard(error, () => { root.replaceChildren(); render(root, { navigate }); })); return; }

  body.appendChild(h('div', { class: 'grid cols-4' },
    h('div', { class: 'stat amber' }, h('span', { class: 'stat-label', text: 'Balance' }), h('b', { text: num(wallet.balance) }), h('small', { text: 'Bridge Credits' })),
    h('div', { class: 'stat teal' }, h('span', { class: 'stat-label', text: 'Earned all-time' }), h('b', { text: num(wallet.earned) }), h('small', { text: 'server-signed entries' })),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Spent' }), h('b', { text: num(wallet.spent) }), h('small', { text: 'on AI requests' })),
    h('div', { class: 'stat rose' }, h('span', { class: 'stat-label', text: 'Streak' }), h('b', { text: `${num(wallet.streak.current)} d` }), h('small', { text: `longest ${num(wallet.streak.longest)} d` }))));

  const rates = wallet.rates || {};
  const features = rates.features || [];
  const spend = rates.spend || {};
  const earn = rates.earn || {};
  const flags = rates.reward_flags || {};

  body.appendChild(h('div', { class: 'grid cols-2' },
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'How BC are earned' }), h('span', { class: 'spacer' }), h('span', { class: 'tag grey', text: `cap ${rates.daily_regular_cap} BC/day` }),
        h('span', { class: 'tag green', text: wallet.basic_tools_free ? 'basics free' : '' })),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Action' }), h('th', { text: 'BC' }))),
        h('tbody', {}, Object.entries(earn).map(([key, value]) => h('tr', {},
          h('td', { text: REWARD_LABEL[key] || key.replace(/_/g, ' ') }),
          h('td', { class: 'num', text: flags[key] === false ? 'off' : String(value) }))))),
      h('p', { class: 'tiny muted', text: rates.note })),
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'What costs BC' })),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'AI feature' }), h('th', { text: 'Where it is used' }), h('th', { text: 'BC' }))),
        h('tbody', {}, features.map(feature => h('tr', {},
          h('td', { text: feature.label }),
          h('td', { class: 'tiny muted', text: feature.where }),
          h('td', { class: 'num', text: String(spend[feature.key] ?? '—') }))))),
      h('p', { class: 'tiny muted', text: 'The price is shown before you send the request. If the request cannot be accepted, nothing is taken; if the generation fails afterwards, the credits are refunded automatically.' }))));

  const limits = wallet.limits || {};
  const daily = wallet.daily_ai || {};
  body.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Today’s limits' }), h('span', { class: 'spacer' }),
      h('span', { class: 'tag grey', text: wallet.today?.day || '' })),
    h('div', { class: 'grid cols-4' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Priced AI requests' }), h('b', { text: `${num(limits.priced_requests_today)}/${num(limits.daily_questions_per_student)}` }), h('small', { text: 'used today' })),
      h('div', { class: 'stat teal' }, h('span', { class: 'stat-label', text: 'Questions left today' }), h('b', { text: daily.limit ? num(daily.remaining ?? 0) : '—' }), h('small', { text: daily.limit ? `of ${num(daily.limit)} allowed today` : 'no daily cap set' })),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Earned today' }), h('b', { text: num(wallet.today?.earned) }), h('small', { text: 'BC' })),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Spent today' }), h('b', { text: num(wallet.today?.spent) }), h('small', { text: 'BC' }))),
    h('p', { class: 'tiny muted', text: `The daily question allowance resets at midnight Pakistan time (${untilLabel(daily.resets_at)}), the same moment the daily login reward becomes claimable again. Accumulated credits never expire. Only ${num(limits.concurrent_requests_per_student)} AI request${Number(limits.concurrent_requests_per_student) === 1 ? '' : 's'} per student may run at a time. Free study tools — scanning, notes, quizzes from your own text, focus sessions, games and progress — never count against these limits and never cost credits.` })));

  if ((wallet.today?.claimed || []).length) {
    body.appendChild(h('section', { class: 'card row wrap-gap' },
      h('div', { style: { flex: '1 1 240px' } }, h('b', { text: 'Claimed today' }),
        h('p', { class: 'tiny muted', style: { margin: '4px 0 0' }, text: wallet.today.claimed.map(c => `${c.code.replace(/_/g, ' ')} (${c.period})`).join(' · ') })),
      loginRewardButton(store.boot?.daily?.login_claimed === true, () => { root.replaceChildren(); render(root, { navigate }); })));
  }

  body.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Ledger history' }), h('span', { class: 'spacer' }),
      h('span', { class: 'tag grey', text: 'newest first' })),
    wallet.history.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'When' }), h('th', { text: 'Type' }), h('th', { text: 'Reason' }), h('th', { text: 'BC' }), h('th', { text: 'Balance after' }))),
      h('tbody', {}, wallet.history.map(row => h('tr', {},
        h('td', { class: 'tiny muted', text: timeAgo(row.created_at) }),
        h('td', {}, h('span', { class: `tag ${row.direction === 'earn' ? 'green' : 'grey'}`, text: TYPE_LABEL[row.type] || row.type || 'entry' })),
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
