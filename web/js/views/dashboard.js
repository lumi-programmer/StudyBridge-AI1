import { api } from '../api.js';
import { store } from '../store.js';
import { meter } from '../charts.js';
import { colorDot, emptyState, errorCard, h, loadingCard, minutesLabel, num, pageHead, timeAgo } from '../ui.js';
import { current, MODE_LABEL } from '../focus.js';
import { dailyQuestionCard, loginRewardButton } from './shared.js';

export async function render(root, { navigate }) {
  const boot = store.boot;
  const name = boot.profile?.display_name || boot.identity?.name || 'Student';
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  root.appendChild(pageHead(new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }),
    `${greet}, ${name}`, 'Pick up where you left off. Everything here comes from what you have actually studied.',
    [loginRewardButton(boot.daily?.login_claimed, () => { root.replaceChildren(); render(root, { navigate }); })]));

  if (!boot.profile?.onboarded && !boot.spaces.length && !boot.books.length) root.appendChild(onboarding());

  const body = h('div', { class: 'stack' }, loadingCard('Reading today’s progress…'));
  root.appendChild(body);
  let daily; let reminders;
  try {
    [daily, reminders] = await Promise.all([api.get('/api/daily?days=7'), api.get('/api/reminders').catch(() => ({ items: [] }))]);
  } catch (error) {
    body.replaceChildren(errorCard(error, () => { root.replaceChildren(); render(root, { navigate }); }));
    return;
  }

  const timer = current();
  const stats = h('div', { class: 'grid cols-4' },
    stat('Bridge Credits', num(store.boot.wallet?.balance), 'amber', 'Reward points, never money', '#/wallet'),
    stat('Day streak', num(daily.streak?.current || 0), 'rose', `Longest ${daily.streak?.longest || 0} days`, '#/streak'),
    stat('Studied today', minutesLabel(daily.minutesToday), 'teal', `Goal ${daily.goalMinutes} min`, '#/progress'),
    stat('Quizzes taken', num(boot.totals?.quizzes || 0), '', `${num(boot.totals?.sessions || 0)} focus sessions`, '#/progress'));

  const goal = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Today’s goal' }), h('span', { class: 'spacer' }),
      daily.goalDone ? h('span', { class: 'tag green', text: 'Goal reached · +20 BC' }) : h('span', { class: 'tag amber', text: '+20 BC when reached' })),
    meter(daily.minutesToday, daily.goalMinutes, { tone: daily.goalDone ? 'good' : '' }),
    h('p', { class: 'tiny muted', style: { margin: '8px 0 12px' },
      text: `${daily.minutesToday} of ${daily.goalMinutes} focus minutes recorded today. ${daily.sessionsToday}/${daily.sessionRewardCap} credited sessions used.` }),
    timer
      ? h('a', { class: 'btn block', href: '#/focus', text: `${MODE_LABEL[timer.mode]} running — open timer` })
      : h('a', { class: 'btn block', href: '#/focus', text: 'Start a focus session' }));

  const challenge = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Challenges' })),
    h('div', { class: 'challenge' },
      h('div', {}, h('b', { text: 'Daily' }), h('p', { class: 'tiny muted', text: daily.dailyChallenge })),
      daily.dailyChallengeDone ? h('span', { class: 'tag green', text: 'Done · +15' }) : h('span', { class: 'tag amber', text: '+15 BC' })),
    h('div', { class: 'challenge' },
      h('div', {}, h('b', { text: 'This week' }), h('p', { class: 'tiny muted', text: `${daily.weekly.title} — ${Math.min(daily.weekly.progress, daily.weekly.target)}/${daily.weekly.target}` }),
        meter(daily.weekly.progress, daily.weekly.target, { tone: daily.weekly.done ? 'good' : '' })),
      daily.weekly.done ? h('span', { class: 'tag green', text: 'Done · +50' }) : h('span', { class: 'tag amber', text: '+50 BC' })));

  const quick = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Start something' })),
    h('div', { class: 'quick-grid' },
      quickLink('#/scanner', '⌗', 'Scan a page', 'Cover, contents or a chapter'),
      quickLink('#/tutor', '✦', 'Ask the tutor', 'Answers cite your scans'),
      quickLink('#/library', '📚', 'Open library', `${boot.books.length ? `${boot.books.length}+ books` : 'Add your first book'}`),
      quickLink('#/games', '✧', 'Brain break', '8 quick games, always open')));

  const reminderCard = reminders.items?.length ? h('section', { class: 'card card-flat' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Gentle reminders' })),
    h('ul', { class: 'list-plain reminder-list' }, reminders.items.map(item => h('li', { class: `rem rem-${item.tone}`, text: item.text })))) : null;

  const spaces = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Recent spaces' }), h('span', { class: 'spacer' }), h('a', { href: '#/spaces', class: 'tiny', text: 'All spaces' })),
    boot.spaces.length
      ? h('ul', { class: 'list-plain link-list' }, boot.spaces.map(s => h('li', {},
        h('a', { href: `#/spaces/${s.id}` }, colorDot(s.color), h('span', { text: s.name }), h('small', { class: 'muted', text: s.subject || '' }), h('small', { class: 'muted push', text: timeAgo(s.updated_at) })))))
      : emptyState('No spaces yet', 'A space keeps one subject’s notes, books and tutor chat together.', h('a', { class: 'btn sm', href: '#/spaces?new=1', text: 'Create a space' })));

  const books = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Recent books' }), h('span', { class: 'spacer' }), h('a', { href: '#/library', class: 'tiny', text: 'Library' })),
    boot.books.length
      ? h('ul', { class: 'list-plain link-list' }, boot.books.map(b => h('li', {},
        h('a', { href: `#/library/${b.id}` }, h('span', { class: 'book-spine', 'aria-hidden': 'true' }), h('span', { text: b.title }), h('small', { class: 'muted', text: b.author || b.subject || '' })))))
      : emptyState('Your library is empty', 'Scan a cover or add a textbook by hand — nothing is guessed from the artwork.', h('a', { class: 'btn sm', href: '#/scanner', text: 'Scan a book' })));

  body.replaceChildren(
    stats,
    h('div', { class: 'grid side' },
      h('div', { class: 'stack' }, dailyQuestionCard(daily, () => {}), h('div', { class: 'grid cols-2' }, spaces, books)),
      h('div', { class: 'stack' }, goal, challenge, quick, reminderCard)));
}

function stat(label, value, tone, sub, href) {
  return h('a', { class: `stat ${tone} stat-link`, href }, h('span', { class: 'stat-label', text: label }), h('b', { text: value }), h('small', { text: sub }));
}

function quickLink(href, icon, title, sub) {
  return h('a', { class: 'quick', href }, h('i', { 'aria-hidden': 'true', text: icon }), h('b', { text: title }), h('small', { text: sub }));
}

function onboarding() {
  return h('section', { class: 'card onboard' },
    h('div', { class: 'eyebrow', text: 'Three steps to start' }),
    h('ol', { class: 'steps' },
      h('li', {}, h('b', { text: 'Make a space' }), ' for a subject, like “Class 10 Physics”. ', h('a', { href: '#/spaces?new=1', text: 'Create one' })),
      h('li', {}, h('b', { text: 'Scan your book' }), ' — cover, contents, then a chapter. PDFs with text are read exactly. ', h('a', { href: '#/scanner', text: 'Open scanner' })),
      h('li', {}, h('b', { text: 'Connect an AI key (optional)' }), ' to get explanations and notes. Free tools work without one. ', h('a', { href: '#/settings', text: 'Settings' }))));
}
