// My Progress — every figure is read back from recorded rows, never estimated.
import { api } from '../api.js';
import { emptyState, errorCard, h, minutesLabel, num, pct, pageHead, timeAgo } from '../ui.js';
import { barChart, heatmap, meter, ring } from '../charts.js';

export async function render(root, { navigate }) {
  root.appendChild(pageHead('My Progress', 'What you have actually done', 'Study minutes come from finished focus sessions, accuracy from graded quiz answers, chapters from your own status marks. Nothing here is a projection.'));
  const body = h('div', { class: 'stack' });
  root.appendChild(body);
  let p;
  try { p = await api.get('/api/progress'); } catch (error) { body.replaceChildren(errorCard(error, () => { root.replaceChildren(); render(root, { navigate }); })); return; }

  body.appendChild(h('div', { class: 'grid cols-4' },
    h('div', { class: 'stat teal' }, h('span', { class: 'stat-label', text: 'Total study' }), h('b', { text: minutesLabel(p.minutes.total) }),
      h('small', { text: `${minutesLabel(p.minutes.weekly)} this week · ${minutesLabel(p.minutes.monthly)} this month` })),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Sessions' }), h('b', { text: num(p.sessions.completed) }), h('small', { text: `${num(p.sessions.all)} started` })),
    h('div', { class: 'stat amber' }, h('span', { class: 'stat-label', text: 'Quiz accuracy' }), h('b', { text: p.quizzes.accuracy === null ? '—' : pct(p.quizzes.accuracy) }),
      h('small', { text: `${num(p.quizzes.taken)} graded attempt(s)` })),
    h('div', { class: 'stat rose' }, h('span', { class: 'stat-label', text: 'Streak' }), h('b', { text: `${num(p.streak.current)} d` }), h('small', { text: `longest ${num(p.streak.longest)} d` }))));

  const series = (p.series?.minutes || []).map(row => ({ label: row.day, short: row.day.slice(8), value: row.minutes }));
  body.appendChild(h('div', { class: 'grid side' },
    h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'Focus minutes · last 14 days' }), h('span', { class: 'spacer' }), h('span', { class: 'tag grey', text: 'from finished sessions' })),
      p.minutes.total ? barChart(series, { unit: 'min', label: 'Study minutes per day' }) : emptyState('No minutes yet', 'Finish a focus session and this chart fills in.') ),
    h('div', { class: 'stack' },
      h('section', { class: 'card row center' },
        ring(p.goal.today, p.goal.target, { size: 132, label: `${p.goal.today}m`, sub: `of ${p.goal.target}m today` }),
        h('div', { style: { marginLeft: '14px' } }, h('b', { text: 'Daily goal' }), h('p', { class: 'tiny muted', text: p.goal.today >= p.goal.target ? 'Reached today.' : `${p.goal.target - p.goal.today} minutes to go.` }))),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Material you have scanned' })),
        h('div', { class: 'grid cols-2' },
          h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Chapters' }), h('b', { text: `${p.chapters.finished}/${p.chapters.total}` }), h('small', { text: 'marked finished by you' })),
          h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Pages' }), h('b', { text: num(p.pages.extracted) }), h('small', { text: `${p.pages.books} book(s) · ${p.topics} topic(s)` })))))));

  body.appendChild(h('div', { class: 'grid cols-2' },
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Where your time goes' })),
      p.subjects.length ? barChart(p.subjects.map(s => ({ label: s.name, short: s.name.slice(0, 8), value: s.minutes })), { unit: 'min', color: 'var(--teal)', label: 'Minutes by space' })
        : emptyState('No subject data', 'Link sessions to a space to split your time by subject.')),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Quiz accuracy by subject' })),
      p.topicStats.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Area' }), h('th', { text: 'Scored' }), h('th', { text: 'Accuracy' }))),
        h('tbody', {}, p.topicStats.map(t => h('tr', {}, h('td', { text: t.label }), h('td', { class: 'num', text: `${t.score}/${t.total}` }),
          h('td', {}, h('div', { class: 'row' }, meter(t.accuracy, 100, { tone: t.accuracy >= 70 ? 'good' : '' }), h('span', { class: 'tiny', text: pct(t.accuracy) })))))))
        : emptyState('No graded quizzes yet', 'Take one from a space or a book — accuracy needs a server-graded attempt.'))));

  if (p.weakAreas?.length) {
    body.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Weakest areas to revisit' }), h('span', { class: 'spacer' }),
      h('span', { class: 'tag grey', text: '4+ questions answered' })),
      h('div', { class: 'row wrap-gap' }, p.weakAreas.map(w => h('a', { class: 'tag rose', href: `#/spaces?focus=${encodeURIComponent(w.label)}`, text: `${w.label} · ${w.accuracy}%` }))),
      h('p', { class: 'tiny muted', text: 'These come only from quizzes you actually submitted.' })));
  }

  body.appendChild(h('div', { class: 'grid cols-2' },
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Recent graded quizzes' })),
      p.quizzes.recent.length ? h('ul', { class: 'list-plain link-list' }, p.quizzes.recent.map(q => h('li', {},
        h('span', { class: 'row between' }, h('span', { text: q.title }), h('span', { class: 'row wrap-gap' },
          h('span', { class: `tag ${q.total && q.score / q.total >= 0.7 ? 'green' : 'grey'}`, text: `${q.score}/${q.total}` }),
          h('small', { class: 'muted', text: timeAgo(q.created_at) }))))))
        : emptyState('Nothing graded yet', 'A quiz you take appears here with its real score.')),
    h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Games' }), h('span', { class: 'spacer' }), h('span', { class: 'tag grey', text: `${p.games.rounds} finished rounds` })),
      p.games.best.length ? h('ul', { class: 'list-plain link-list' }, p.games.best.map(g => h('li', {},
        h('a', { href: '#/games' }, h('span', { text: g.game.replace(/-/g, ' ') }), h('small', { class: 'muted push', text: `best ${g.score}` })))))
        : h('p', { class: 'muted tiny', text: 'Play a round in the Game Center to start a record.' }))));

  body.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Activity calendar' })),
    p.calendar.length ? heatmap(p.calendar, { title: d => `${d.day} · ${d.minutes} min · +${d.earned} BC` }) : emptyState('No activity yet', 'The calendar fills from your first recorded day.')),
    h('p', { class: 'tiny muted', text: `Credits earned from recorded activity: ${num(p.earned)} BC.` }));}
