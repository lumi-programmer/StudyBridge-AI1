// Rewards Center — every reward, what it pays and whether it has been claimed.
// The server decides what is claimable; this page only shows the answer.
import { api } from '../api.js';
import { refresh } from '../store.js';
import { emptyState, errorCard, h, num, pageHead, untilLabel } from '../ui.js';
import { loginRewardButton } from './shared.js';

export async function render(root, { navigate }) {
  root.appendChild(pageHead('🌟 Rewards Center', 'Earn Bridge Credits',
    'Bridge Credits are earned from real study activity and spent on AI requests. The server checks the underlying record before it pays anything, so a reward can only be earned once per period.',
    [h('a', { class: 'btn secondary', href: '#/wallet', text: 'Bridge Wallet' })]));
  const body = h('div', { class: 'stack' });
  root.appendChild(body);

  const reload = async () => {
    root.replaceChildren();
    await render(root, { navigate });
  };

  let data;
  try { data = await api.get('/api/rewards'); }
  catch (error) { body.replaceChildren(errorCard(error, reload)); return; }

  const weekly = data.weekly_challenge || {};
  const daily = data.daily_ai || {};
  body.appendChild(h('div', { class: 'grid cols-4' },
    h('div', { class: 'stat amber' }, h('span', { class: 'stat-label', text: 'Balance' }), h('b', { text: num(data.balance) }), h('small', { text: 'Bridge Credits' })),
    h('div', { class: 'stat teal' }, h('span', { class: 'stat-label', text: 'Earned today' }), h('b', { text: num(data.earned_today) }), h('small', { text: 'from recorded activity' })),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Questions left today' }), h('b', { text: daily.limit ? num(daily.remaining ?? 0) : '—' }), h('small', { text: daily.limit ? `of ${num(daily.limit)} allowed today` : 'no daily cap set' })),
    h('div', { class: 'stat rose' }, h('span', { class: 'stat-label', text: 'Streak' }), h('b', { text: `${num(data.streak?.current)} d` }), h('small', { text: `longest ${num(data.streak?.longest)} d` }))));

  body.appendChild(h('p', { class: 'tiny muted', style: { margin: '0 0 8px' }, text: `The day runs on Pakistan time: rewards and the daily question allowance both come back at midnight there — ${untilLabel(data.next_reset)}. Claiming at 9 PM Monday means you can claim again after 12 AM Tuesday.` }));

  body.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Today’s rewards' }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'tag grey', text: `regular daily cap ${num(data.daily_regular_cap)} BC` })),
    h('div', { class: 'grid cols-2' },
      data.catalogue.map(reward => h('article', { class: 'card card-flat' },
        h('div', { class: 'card-head' },
          h('b', { text: reward.label }),
          h('span', { class: 'spacer' }),
          h('span', { class: `tag ${reward.claimed ? 'green' : reward.enabled ? 'amber' : 'grey'}`,
            text: reward.enabled ? `${num(reward.amount)} BC` : 'switched off' })),
        h('p', { class: 'tiny muted', style: { margin: '0 0 6px' }, text: reward.how }),
        h('p', { class: 'tiny', style: { margin: '0' } },
          h('span', { class: reward.claimed ? 'ok-text' : 'muted', text: reward.claimed ? 'Claimed' : reward.progress })),
        reward.code === 'daily_login' && !reward.claimed
          ? h('div', { style: { marginTop: '10px' } }, loginRewardButton(false, reload))
          : null))),
    h('p', { class: 'tiny muted', style: { marginTop: '10px' }, text: data.note })));

  body.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'This week’s challenge' }),
      h('span', { class: 'spacer' }),
      h('span', { class: 'tag teal', text: weekly.title || 'Weekly goal' })),
    h('p', { class: 'muted', style: { margin: '0 0 8px' }, text: `Reach ${num(weekly.target)} ${weekly.metric || 'steps'} this week to earn the weekly reward.` }),
    h('div', { class: 'meter' }, h('span', { style: { width: `${Math.min(100, weekly.target ? Math.round((weekly.current / weekly.target) * 100) : 0)}%` } })),
    h('p', { class: 'tiny muted', style: { marginTop: '8px' }, text: 'Weekly progress is counted from recorded sessions, quizzes, pages, spaces and games — not from what the page says.' })));

  body.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'How to earn more' })),
    h('div', { class: 'quick-grid' },
      h('a', { class: 'quick', href: '#/dashboard' }, h('i', { 'aria-hidden': 'true', text: '◧' }), h('div', {}, h('b', { text: 'Dashboard' }), h('small', { text: 'Answer the daily question for +10 BC' }))),
      h('a', { class: 'quick', href: '#/focus' }, h('i', { 'aria-hidden': 'true', text: '◐' }), h('div', {}, h('b', { text: 'Focus Mode' }), h('small', { text: 'A 10-minute session is worth +15 BC' }))),
      h('a', { class: 'quick', href: '#/games' }, h('i', { 'aria-hidden': 'true', text: '✧' }), h('div', {}, h('b', { text: 'Game Center' }), h('small', { text: 'Games pay out of their own daily pool' }))),
      h('a', { class: 'quick', href: '#/streak' }, h('i', { 'aria-hidden': 'true', text: '▲' }), h('div', {}, h('b', { text: 'Daily Streak' }), h('small', { text: 'Seven days in a row is worth +100 BC' }))))));

  const failures = [];
  for (const reward of data.catalogue) {
    if (reward.claimed || !reward.enabled) continue;
    if (reward.code === 'daily_login' || reward.code === 'daily_question') continue;
    failures.push(reward);
  }
  if (!data.catalogue.length) {
    body.appendChild(emptyState('No rewards configured', 'An administrator has not published any rewards yet.'));
  }
  if (failures.length) {
    body.appendChild(h('p', { class: 'tiny muted', text: `Still open: ${failures.map(r => r.label).join(', ')}. Each one turns green the moment the server records it.` }));
  }

  // The balance chip in the shell reads from the same store, so a refresh keeps
  // the top bar honest after a claim.
  refresh().catch(() => {});
}
