// Daily Streaks — every day shown is a day with recorded activity, and a missed
// day is explained rather than punished.
import { api } from '../api.js';
import { emptyState, errorCard, h, num, pageHead, timeAgo, toast } from '../ui.js';
import { heatmap, meter } from '../charts.js';
import { dailyQuestionCard, loginRewardButton } from './shared.js';

const MILESTONES = [
  { days: 3, reward: 30 }, { days: 7, reward: 100 }, { days: 14, reward: 150 }, { days: 30, reward: 300 },
];

export async function render(root, { navigate }) {
  root.appendChild(pageHead('🔥 Daily Streaks', 'Keep the chain alive', 'A streak counts any day you studied, answered the daily question or claimed your login. Skip a day and the count restarts — but nothing is taken away and no day is marked as a failure.',
    [h('a', { class: 'btn secondary', href: '#/focus', text: 'Start a session' })]));
  const body = h('div', { class: 'stack' });
  root.appendChild(body);
  let daily;
  try { daily = await api.get('/api/daily?days=35'); } catch (error) { body.replaceChildren(errorCard(error, () => { root.replaceChildren(); render(root, { navigate }); })); return; }

  const current = daily.streak?.current || 0;
  const next = MILESTONES.find(m => current < m.days);
  const earned = MILESTONES.filter(m => current >= m.days);
  body.appendChild(h('div', { class: 'grid cols-3' },
    h('div', { class: 'stat rose' }, h('span', { class: 'stat-label', text: 'Current streak' }), h('b', { text: `${num(current)} day${current === 1 ? '' : 's'}` }),
      h('small', { text: daily.streak?.brokeOn ? `Broke after ${daily.streak.brokeOn}. Start again today — nothing is lost.` : 'Running today.' })),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Longest ever' }), h('b', { text: `${num(daily.streak?.longest || 0)} days` }), h('small', { text: 'kept in your record' })),
    h('div', { class: 'stat amber' }, h('span', { class: 'stat-label', text: 'Next milestone' }),
      h('b', { text: next ? `+${next.reward} BC` : 'All claimed' }),
      h('small', { text: next ? `${next.days - current} more day${next.days - current === 1 ? '' : 's'} to day ${next.days}` : `Reached ${earned.map(e => e.days).join(', ')} days` }))));

  if (next) {
    body.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: `Day ${next.days} milestone` }), h('span', { class: 'spacer' }), h('span', { class: 'tag amber', text: `+${next.reward} BC` })),
      meter(current, next.days, {}),
      h('p', { class: 'tiny muted', style: { marginTop: '8px' }, text: `${current} of ${next.days} consecutive days. Milestones are paid once when you reach them.` })));
  }

  const calendar = daily.calendar || [];
  body.appendChild(h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Last 35 days' }), h('span', { class: 'spacer' }),
      h('span', { class: 'row wrap-gap' },
        h('span', { class: 'tag teal', text: 'study minutes' }), h('span', { class: 'tag grey', text: 'touched' }), h('span', { class: 'tag green', text: 'goal met' }))),
    calendar.length ? heatmap(calendar, {
      title: d => `${d.day} · ${d.minutes} min · ${d.sessions} session(s)${d.login ? ' · login' : ''}${d.answered ? ` · question ${d.correct ? 'right' : 'done'}` : ''}${d.goalDone ? ' · goal met' : ''} · +${d.earned} BC`,
    }) : emptyState('No days recorded yet', 'Your first focus session or daily answer starts the picture.'),
    h('p', { class: 'tiny muted', text: `Today is ${daily.day}. ${calendar.filter(d => d.minutes > 0).length} day(s) in this window have study minutes.` })));

  const today = calendar.find(d => d.day === daily.day) || {};
  body.appendChild(h('div', { class: 'grid cols-2' },
    h('section', { class: 'card stack' },
      h('div', { class: 'card-head' }, h('h3', { text: 'Today' }), h('span', { class: 'spacer' }), loginRewardButton(daily.loginClaimed, () => { root.replaceChildren(); render(root, { navigate }); })),
      h('ul', { class: 'list-plain tick-list' },
        tick(daily.loginClaimed, 'Daily login · +30 BC'),
        tick(daily.answered, `Daily question · ${daily.correct ? 'answered correctly' : 'answered'} (+10 BC if correct)`),
        tick(daily.minutesToday >= 10, `Focus session · +15 BC at 10+ minutes (${daily.sessionsToday}/${daily.sessionRewardCap} credited today)`),
        tick(daily.goalDone, `Daily goal · +20 BC at ${daily.goalMinutes} minutes`),
        tick(daily.dailyChallengeDone, `Daily challenge · +15 BC — ${daily.dailyChallenge}`))),
    h('section', { class: 'card stack' },
      h('div', { class: 'card-head' }, h('h3', { text: 'This week' }), h('span', { class: 'spacer' }),
        daily.weekly?.done ? h('span', { class: 'tag green', text: 'Done · +50 BC' }) : h('span', { class: 'tag amber', text: '+50 BC' })),
      daily.weekly ? h('div', {}, h('b', { text: daily.weekly.title }),
        h('p', { class: 'tiny muted', text: `${Math.min(daily.weekly.progress, daily.weekly.target)} of ${daily.weekly.target} ${daily.weekly.metric}` }),
        meter(daily.weekly.progress, daily.weekly.target, { tone: daily.weekly.done ? 'good' : '' })) : h('p', { class: 'muted tiny', text: 'No weekly challenge loaded.' }),
      h('p', { class: 'tiny muted', text: `Minutes today: ${today.minutes || 0}. Sessions: ${today.sessions || 0}. Credits earned today: ${today.earned || 0}.` }))));

  body.appendChild(dailyQuestionCard(daily, () => { root.replaceChildren(); render(root, { navigate }); }));

  try {
    const ach = await api.get('/api/achievements');
    const streakAch = ach.catalogue.filter(a => /streak|week|milestone|challenge/i.test(a.code + a.title));
    if (streakAch.length) body.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Consistency achievements' })),
      h('div', { class: 'row wrap-gap' }, streakAch.map(a => h('span', { class: `tag ${a.earned ? 'green' : 'grey'}`, text: `${a.title} · ${a.reward} BC${a.earned ? ' ✓' : ''}` }))),
      h('p', { class: 'tiny muted', text: 'Each achievement is paid once, by the server, from recorded data.' })));
  } catch { /* achievements are a bonus on this page */ }
}

function tick(done, label) {
  return h('li', { class: `tick${done ? ' on' : ''}` }, h('span', { class: 'tick-mark', 'aria-hidden': 'true', text: done ? '✓' : '○' }), h('span', { text: label }));
}
