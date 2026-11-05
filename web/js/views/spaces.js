import { api } from '../api.js';
import { refresh, savePrefs } from '../store.js';
import {
  COLORS, colorDot, confirmSheet, emptyState, errorCard, errorToast, field, h, loadingCard, openSheet,
  pageHead, richText, select, sheetTitle, timeAgo, toast,
} from '../ui.js';
import { openQuiz, quizCreator } from './quiz.js';

export async function render(root, { args, query, navigate }) {
  if (args[0]) return detail(root, args[0], { query, navigate });
  return list(root, { query, navigate });
}

async function list(root, { query, navigate }) {
  let archived = query.get('archived') === 'true';
  const newBtn = h('button', { class: 'btn', type: 'button', text: 'New space', onClick: () => spaceForm(null, created => navigate(`#/spaces/${created.id}`)) });
  root.appendChild(pageHead('My Spaces', 'Spaces', 'One space per subject or exam. Each keeps its own notes, saved questions, books and tutor chat — nothing leaks between spaces.', [newBtn]));
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const body = h('div', {});
  root.append(tabs, body);

  async function load() {
    tabs.replaceChildren(
      h('button', { class: `tab${archived ? '' : ' active'}`, type: 'button', role: 'tab', 'aria-selected': String(!archived), onClick: () => { archived = false; load(); } }, 'Active'),
      h('button', { class: `tab${archived ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(archived), onClick: () => { archived = true; load(); } }, 'Archived'));
    body.replaceChildren(loadingCard('Loading spaces…'));
    let spaces;
    try { spaces = await api.get(`/api/spaces?archived=${archived}`); } catch (error) { body.replaceChildren(errorCard(error, load)); return; }
    if (!spaces.length) {
      body.replaceChildren(archived
        ? emptyState('Nothing archived', 'Archived spaces keep their notes and chat but leave your main list.')
        : emptyState('Create your first space', 'For example “Class 10 Physics” or “MDCAT Biology”. You can link scanned books to it so the tutor answers from your pages.',
          h('button', { class: 'btn', type: 'button', text: 'New space', onClick: () => spaceForm(null, created => navigate(`#/spaces/${created.id}`)) })));
      return;
    }
    body.replaceChildren(h('div', { class: 'grid cols-3' }, spaces.map(space => h('a', { class: `card space-card accent-${space.color}`, href: `#/spaces/${space.id}` },
      h('div', { class: 'row' }, colorDot(space.color), h('h3', { text: space.name, style: { margin: 0 } })),
      h('p', { class: 'muted tiny', text: space.subject || 'No subject set' }),
      h('div', { class: 'row wrap-gap' },
        h('span', { class: 'tag grey', text: `${space.stats.messages} messages` }),
        h('span', { class: 'tag grey', text: `${space.stats.notes} notes` }),
        h('span', { class: 'tag grey', text: `${space.stats.questions} saved questions` })),
      h('small', { class: 'muted', text: `Updated ${timeAgo(space.updated_at)}` })))));
  }
  await load();
  if (query.get('new') === '1') spaceForm(null, created => navigate(`#/spaces/${created.id}`));
}

function spaceForm(space, onSaved) {
  const name = h('input', { type: 'text', maxlength: '60', value: space?.name || '', placeholder: 'Class 10 Physics', dataset: { autofocus: '1' } });
  const subject = h('input', { type: 'text', maxlength: '60', value: space?.subject || '', placeholder: 'Physics' });
  const instructions = h('textarea', { maxlength: '1500', placeholder: 'Optional: how the tutor should help in this space, e.g. “Punjab board syllabus, explain numericals step by step.”' }, space?.instructions || '');
  let color = space?.color || 'indigo';
  const swatches = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Colour' }, COLORS.map(c => h('button', {
    type: 'button', class: `swatch dot-${c}${c === color ? ' on' : ''}`, role: 'radio', 'aria-checked': String(c === color), 'aria-label': c,
    onClick: event => {
      color = c;
      for (const b of swatches.children) { b.classList.remove('on'); b.setAttribute('aria-checked', 'false'); }
      event.currentTarget.classList.add('on');
      event.currentTarget.setAttribute('aria-checked', 'true');
    },
  })));
  const save = h('button', { class: 'btn', type: 'submit', text: space ? 'Save changes' : 'Create space' });
  const form = h('form', { class: 'stack', onSubmit: async event => {
    event.preventDefault();
    if (name.value.trim().length < 2) { toast('Give the space a name of at least 2 characters.', 'bad'); name.focus(); return; }
    save.disabled = true;
    try {
      const payload = { name: name.value.trim(), subject: subject.value.trim(), color, instructions: instructions.value.trim() };
      const saved = space ? await api.patch(`/api/spaces/${space.id}`, payload) : await api.post('/api/spaces', payload);
      close();
      toast(space ? 'Space updated.' : 'Space created.', 'good');
      refresh();
      onSaved?.(saved);
    } catch (error) { save.disabled = false; errorToast(error); }
  } },
  sheetTitle(space ? 'Edit space' : 'New space', 'Private to you.'),
  h('div', { class: 'field-row' }, field('Name', name), field('Subject', subject)),
  field('Tutor instructions', instructions, 'Only the tutor in this space sees these.'),
  h('div', { class: 'field' }, h('label', { text: 'Colour' }), swatches),
  h('div', { class: 'row end' }, h('button', { class: 'btn secondary', type: 'button', text: 'Cancel', onClick: () => close() }), save));
  const close = openSheet(form);
}

async function detail(root, spaceId, { query, navigate }) {
  root.appendChild(loadingCard('Opening space…'));
  let data;
  try { data = await api.get(`/api/spaces/${spaceId}`); } catch (error) {
    // A malformed id in a hand-edited or stale link can never succeed on retry,
    // so send the student back to the list instead of offering a doomed Retry.
    const deadLink = error.status === 404 || error.code === 'invalid_input';
    root.replaceChildren(deadLink ? emptyState('Space not found', 'It may have been deleted.', h('a', { class: 'btn sm', href: '#/spaces', text: 'All spaces' }))
      : errorCard(error, () => { root.replaceChildren(); detail(root, spaceId, { query, navigate }); }));
    return;
  }
  savePrefs({ lastSpace: spaceId });
  const { space } = data;
  const reload = () => { root.replaceChildren(); detail(root, spaceId, { query: new URLSearchParams(`tab=${current}`), navigate }); };
  let current = query.get('tab') || 'overview';

  root.replaceChildren(pageHead(space.subject || 'Space', space.name, space.archived ? 'Archived space — still readable and editable.' : `${data.books.length} linked book${data.books.length === 1 ? '' : 's'} · ${data.notes.length} notes · ${data.messages.length} recent messages`, [
    h('a', { class: 'btn', href: `#/tutor?space=${space.id}`, text: 'Open tutor' }),
    h('a', { class: 'btn secondary', href: '#/spaces', text: 'All spaces' }),
  ]));
  const tabNames = [['overview', 'Overview'], ['notes', `Notes (${data.notes.length})`], ['questions', `Saved questions (${data.questions.length})`], ['books', `Books (${data.books.length})`], ['quizzes', `Quizzes (${data.quizzes.length})`], ['history', 'History'], ['settings', 'Settings']];
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { class: 'tab-panel' });
  root.append(tabs, panel);
  const show = name => {
    current = name;
    tabs.replaceChildren(...tabNames.map(([key, label]) => h('button', { class: `tab${key === name ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(key === name), onClick: () => show(key) }, label)));
    panel.replaceChildren(PANELS[name](data, { reload, navigate }));
  };
  show(PANELS[current] ? current : 'overview');
}

const PANELS = {
  overview(data) {
    const last = data.messages.filter(m => m.role === 'assistant').slice(-1)[0];
    return h('div', { class: 'grid side' },
      h('div', { class: 'stack' },
        h('section', { class: 'card' },
          h('div', { class: 'card-head' }, h('h3', { text: 'Latest tutor answer' }), h('span', { class: 'spacer' }), h('a', { class: 'tiny', href: `#/tutor?space=${data.space.id}`, text: 'Continue chat' })),
          last ? h('div', {}, richText(last.content), h('small', { class: 'muted', text: timeAgo(last.created_at) }))
            : emptyState('No chat yet', 'Ask the tutor anything about this subject. If you link a scanned book, answers cite its pages.')),
        data.space.instructions ? h('section', { class: 'card card-flat' }, h('div', { class: 'stat-label', text: 'Tutor instructions' }), h('p', { text: data.space.instructions })) : null),
      h('div', { class: 'stack' },
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Practice from this space' })),
          quizCreator({ spaceId: data.space.id, bookId: data.books[0]?.id, subject: data.space.subject })),
        h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Recent topics' })),
          data.topics.length ? h('ul', { class: 'list-plain link-list' }, data.topics.slice(0, 8).map(t => h('li', {}, h('span', { class: 'row' }, h('span', { class: 'tag grey', text: t.kind }), h('span', { text: t.topic }), h('small', { class: 'muted push', text: timeAgo(t.created_at) })))))
            : h('p', { class: 'muted tiny', text: 'Topics appear here as you chat, scan and practise.' }))));
  },

  notes(data, { reload }) {
    const wrap = h('div', { class: 'stack' });
    const add = h('button', { class: 'btn sm', type: 'button', text: 'New note', onClick: () => noteEditor(data.space.id, null, reload) });
    wrap.appendChild(h('div', { class: 'row between' }, h('p', { class: 'muted tiny', style: { margin: 0 }, text: 'Notes you write, plus notes the AI tools save here. Saves are version-checked so two tabs cannot overwrite each other.' }), add));
    if (!data.notes.length) wrap.appendChild(emptyState('No notes yet', 'Write one, or run “Short notes” on a scanned chapter.'));
    for (const note of data.notes) {
      wrap.appendChild(h('article', { class: 'card note' },
        h('div', { class: 'card-head' }, h('h3', { text: note.title }), h('span', { class: 'spacer' }), h('small', { class: 'muted', text: `v${note.version} · ${timeAgo(note.updated_at)}` })),
        richText(note.body.length > 1200 ? `${note.body.slice(0, 1200)}…` : note.body),
        h('div', { class: 'row end' },
          h('button', { class: 'btn ghost sm', type: 'button', text: 'Edit', onClick: () => noteEditor(data.space.id, note, reload) }),
          h('button', { class: 'btn ghost sm', type: 'button', text: 'Delete', onClick: () => confirmSheet({
            title: 'Delete this note?', body: `“${note.title}” will be removed permanently.`, confirmLabel: 'Delete', tone: 'danger',
            onConfirm: async () => { await api.del(`/api/notes/${note.id}`); toast('Note deleted.'); reload(); },
          }) }))));
    }
    return wrap;
  },

  questions(data, { reload }) {
    const question = h('textarea', { maxlength: '1200', placeholder: 'A question you want to come back to…', style: { minHeight: '64px' } });
    const topic = h('input', { type: 'text', maxlength: '80', placeholder: 'Topic (optional)' });
    const save = h('button', { class: 'btn sm', type: 'submit', text: 'Save question' });
    const form = h('form', { class: 'card stack', onSubmit: async event => {
      event.preventDefault();
      if (!question.value.trim()) return;
      save.disabled = true;
      try { await api.post(`/api/spaces/${data.space.id}/questions`, { question: question.value.trim(), topic: topic.value.trim() }); reload(); }
      catch (error) { save.disabled = false; errorToast(error); }
    } }, field('Question', question), h('div', { class: 'row' }, topic, save));
    const items = data.questions.map(q => h('article', { class: `card tight saved-q${q.resolved ? ' resolved' : ''}` },
      h('div', { class: 'row between' }, h('b', { text: q.question }), q.topic ? h('span', { class: 'tag grey', text: q.topic }) : null),
      q.answer ? richText(q.answer) : null,
      h('div', { class: 'row end' },
        h('a', { class: 'btn ghost sm', href: `#/tutor?space=${data.space.id}&ask=${encodeURIComponent(q.question.slice(0, 500))}`, text: 'Ask tutor' }),
        h('button', { class: 'btn ghost sm', type: 'button', text: q.resolved ? 'Mark open' : 'Mark resolved', onClick: async () => {
          try { await api.patch(`/api/questions/${q.id}`, { resolved: !q.resolved }); reload(); } catch (error) { errorToast(error); }
        } }),
        h('button', { class: 'btn ghost sm', type: 'button', text: 'Delete', onClick: async () => {
          try { await api.del(`/api/questions/${q.id}`); reload(); } catch (error) { errorToast(error); }
        } }))));
    return h('div', { class: 'stack' }, form, items.length ? items : emptyState('No saved questions', 'Save tricky questions from chat or class, then ask the tutor later.'));
  },

  books(data, { reload }) {
    const wrap = h('div', { class: 'stack' });
    const picker = h('select', {}, h('option', { value: '' }, 'Loading your library…'));
    const link = h('button', { class: 'btn sm', type: 'button', text: 'Link book', disabled: true, onClick: async () => {
      if (!picker.value) return;
      link.disabled = true;
      try { await api.post(`/api/spaces/${data.space.id}/books`, { book_id: picker.value }); toast('Book linked — the tutor in this space can now cite it.', 'good'); reload(); }
      catch (error) { link.disabled = false; errorToast(error); }
    } });
    api.get('/api/books').then(res => {
      const linked = new Set(data.books.map(b => b.id));
      const free = res.items.filter(b => !linked.has(b.id));
      picker.replaceChildren(...(free.length ? free.map(b => h('option', { value: b.id }, b.title)) : [h('option', { value: '' }, res.items.length ? 'All your books are linked' : 'Your library is empty')]));
      link.disabled = !free.length;
    }).catch(() => picker.replaceChildren(h('option', { value: '' }, 'Library unavailable')));
    wrap.appendChild(h('div', { class: 'card row' }, h('span', { class: 'muted tiny', text: 'Link a book so this space’s tutor reads its scanned pages:' }), h('div', { style: { flex: '1 1 220px' } }, picker), link,
      h('a', { class: 'btn ghost sm', href: '#/scanner', text: 'Scan a new book' })));
    if (!data.books.length) wrap.appendChild(emptyState('No books linked', 'Without a linked book the tutor answers from general knowledge and says so.'));
    wrap.appendChild(h('div', { class: 'grid cols-2' }, data.books.map(b => h('div', { class: 'card tight row' },
      h('span', { class: 'book-spine', 'aria-hidden': 'true' }),
      h('div', { style: { flex: 1 } }, h('a', { href: `#/library/${b.id}`, text: b.title }), h('div', { class: 'tiny muted', text: [b.author, b.subject].filter(Boolean).join(' · ') })),
      h('button', { class: 'btn ghost sm', type: 'button', text: 'Unlink', onClick: async () => {
        try { await api.del(`/api/spaces/${data.space.id}/books/${b.id}`); reload(); } catch (error) { errorToast(error); }
      } })))));
    return wrap;
  },

  quizzes(data, { reload }) {
    return h('div', { class: 'grid side' },
      h('div', { class: 'stack' }, data.quizzes.length
        ? data.quizzes.map(q => h('div', { class: 'card tight row' },
          h('div', { style: { flex: 1 } }, h('b', { text: q.title }), h('div', { class: 'tiny muted', text: `${q.count} questions · ${q.origin === 'ai' ? 'AI written' : q.origin === 'bank' ? 'practice bank' : 'from your scans'} · ${timeAgo(q.created_at)}` })),
          h('button', { class: 'btn sm secondary', type: 'button', text: 'Take', onClick: () => openQuiz(q.id, { onDone: () => {} }) })))
        : emptyState('No quizzes yet', 'Build one on the right. Scores are checked by the server.')),
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'New quiz' })),
        quizCreator({ spaceId: data.space.id, bookId: data.books[0]?.id, subject: data.space.subject, onCreated: () => setTimeout(reload, 400) })));
  },

  history(data, { reload }) {
    return h('div', { class: 'stack' },
      h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Learning history' }), h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost sm', type: 'button', text: 'Clear history', onClick: () => confirmSheet({
          title: 'Clear this space’s history?', body: 'Topic history for this space is deleted. Notes, saved questions and chat stay. Credits are not affected.',
          confirmLabel: 'Clear history', tone: 'danger',
          onConfirm: async () => { await api.del(`/api/history/${data.space.id}`, { confirm: true }); toast('History cleared.'); reload(); },
        }) })),
        data.topics.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'When' }), h('th', { text: 'Kind' }), h('th', { text: 'Topic' }), h('th', { text: 'Detail' }))),
          h('tbody', {}, data.topics.map(t => h('tr', {}, h('td', { class: 'tiny muted', text: timeAgo(t.created_at) }), h('td', {}, h('span', { class: 'tag grey', text: t.kind })), h('td', { text: t.topic }), h('td', { class: 'tiny muted', text: t.detail || '' })))))
          : emptyState('Nothing recorded yet', 'Chats, scans, quizzes and sessions in this space are logged here.')));
  },

  settings(data, { navigate }) {
    const { space } = data;
    return h('div', { class: 'grid cols-2' },
      h('section', { class: 'card stack' }, h('h3', { text: 'Space details' }),
        h('p', { class: 'muted tiny', text: 'Name, subject, colour and the tutor instructions for this space.' }),
        h('div', {}, h('button', { class: 'btn secondary', type: 'button', text: 'Edit space', onClick: () => spaceForm(space, () => navigate(`#/spaces/${space.id}?tab=settings`)) }))),
      h('section', { class: 'card stack' }, h('h3', { text: 'Tidy up' }),
        h('div', { class: 'row' },
          h('button', { class: 'btn secondary sm', type: 'button', text: space.archived ? 'Unarchive' : 'Archive', onClick: async () => {
            try { await api.patch(`/api/spaces/${space.id}`, { archived: !space.archived }); toast(space.archived ? 'Space restored.' : 'Space archived.'); refresh(); navigate('#/spaces'); }
            catch (error) { errorToast(error); }
          } }),
          h('button', { class: 'btn secondary sm', type: 'button', text: 'Clear chat', onClick: () => confirmSheet({
            title: 'Clear the tutor chat?', body: 'All messages in this space are deleted. Notes and questions stay.', confirmLabel: 'Clear chat', tone: 'danger',
            onConfirm: async () => { await api.del(`/api/spaces/${space.id}/messages`); toast('Chat cleared.'); },
          }) }),
          h('button', { class: 'btn danger sm', type: 'button', text: 'Delete space', onClick: () => confirmSheet({
            title: 'Delete this space?', body: 'Its chat, notes, saved questions, quizzes and history are deleted. Linked books stay in your library. Credits are not reversed.',
            confirmLabel: 'Delete space', tone: 'danger', requireTyped: 'delete',
            onConfirm: async () => { await api.del(`/api/spaces/${space.id}`); toast('Space deleted.'); refresh(); navigate('#/spaces'); },
          }) }))));
  },
};

function noteEditor(spaceId, note, onSaved) {
  const title = h('input', { type: 'text', maxlength: '120', value: note?.title || '', dataset: { autofocus: '1' } });
  const body = h('textarea', { maxlength: '20000', style: { minHeight: '260px' } }, note?.body || '');
  const save = h('button', { class: 'btn', type: 'submit', text: 'Save note' });
  const close = openSheet(h('form', { class: 'stack', onSubmit: async event => {
    event.preventDefault();
    if (!title.value.trim()) { toast('Add a title.', 'bad'); return; }
    save.disabled = true;
    try {
      if (note) await api.patch(`/api/notes/${note.id}`, { version: note.version, title: title.value.trim(), body: body.value });
      else await api.post(`/api/spaces/${spaceId}/notes`, { title: title.value.trim(), body: body.value });
      close();
      toast('Note saved.', 'good');
      onSaved();
    } catch (error) {
      save.disabled = false;
      if (error.code === 'write_conflict') toast('This note changed somewhere else. Copy your text, reopen the note and try again.', 'bad', 9000);
      else errorToast(error);
    }
  } },
  sheetTitle(note ? 'Edit note' : 'New note', 'Use “# ” for headings and “- ” for bullet points.'),
  field('Title', title), field('Note', body),
  h('div', { class: 'row end' }, h('button', { class: 'btn secondary', type: 'button', text: 'Cancel', onClick: () => close() }), save)));
}
