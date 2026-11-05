import { api } from '../api.js';
import { debounce, emptyState, errorCard, errorToast, field, h, loadingCard, openSheet, pageHead, select, sheetTitle, spinner, timeAgo, toast } from '../ui.js';
import { quizCreator } from './quiz.js';

const STATUSES = [['todo', 'To scan'], ['scanning', 'Scanning'], ['studying', 'Studying'], ['done', 'Finished']];

export async function render(root, { args, navigate }) {
  if (args[0]) return bookDetail(root, args[0], { navigate });
  return bookList(root, { navigate });
}

async function bookList(root, { navigate }) {
  root.appendChild(pageHead('My Library', 'Your books', 'Everything here is a book you scanned or typed yourself. StudyBridge never fills a library from a cover picture.',
    [h('a', { class: 'btn', href: '#/scanner', text: 'Scan a book' }), h('button', { class: 'btn secondary', type: 'button', text: 'Add by hand', onClick: () => bookForm(null, b => navigate(`#/library/${b.id}`)) })]));
  const search = h('input', { type: 'search', placeholder: 'Search title, author, subject…', 'aria-label': 'Search library' });
  const subject = h('input', { type: 'text', placeholder: 'Subject filter', 'aria-label': 'Subject filter' });
  const wrap = h('div', { class: 'grid cols-3' });
  root.append(h('div', { class: 'row' }, h('div', { style: { flex: '2 1 240px' } }, search), h('div', { style: { flex: '1 1 160px' } }, subject)), wrap);
  let all = [];

  async function load() {
    wrap.replaceChildren(loadingCard('Loading library…'));
    try {
      const res = await api.get('/api/books');
      all = res.items;
      paint();
    } catch (error) { wrap.replaceChildren(errorCard(error, load)); }
  }
  function paint() {
    const q = search.value.trim().toLowerCase();
    const s = subject.value.trim().toLowerCase();
    const items = all.filter(b => (!q || [b.title, b.author, b.subject, b.publisher].some(v => String(v || '').toLowerCase().includes(q)))
      && (!s || String(b.subject || '').toLowerCase() === s));
    if (!all.length) {
      wrap.replaceChildren(emptyState('No books yet', 'Add a textbook by hand, or photograph the cover and correct what the model read.',
        h('a', { class: 'btn', href: '#/scanner', text: 'Start scanning' })));
      return;
    }
    if (!items.length) { wrap.replaceChildren(emptyState('Nothing matches', 'Try a shorter word, or clear the subject filter.')); return; }
    wrap.replaceChildren(...items.map(b => h('a', { class: 'card book-card', href: `#/library/${b.id}` },
      h('div', { class: 'row' }, h('span', { class: 'book-spine', 'aria-hidden': 'true' }), h('div', { style: { flex: 1 } },
        h('h3', { text: b.title, style: { margin: 0 } }), h('p', { class: 'tiny muted', text: [b.author, b.publisher].filter(Boolean).join(' · ') || 'No author recorded' }))),
      h('div', { class: 'row wrap-gap' },
        b.subject ? h('span', { class: 'tag grey', text: b.subject }) : null,
        h('span', { class: `tag ${b.chapters && b.chaptersDone === b.chapters ? 'green' : 'amber'}`, text: `${b.chaptersDone}/${b.chapters} chapters done` }),
        h('span', { class: 'tag grey', text: `${b.documents} upload${b.documents === 1 ? '' : 's'}` }),
        b.spaces.length ? h('span', { class: 'tag teal', text: `${b.spaces.length} space${b.spaces.length === 1 ? '' : 's'}` }) : null),
      h('small', { class: 'muted', text: `Updated ${timeAgo(b.updated_at)} · ${sourceLabel(b.source)}` }))));
  }
  search.addEventListener('input', debounce(paint, 250));
  subject.addEventListener('input', debounce(paint, 250));
  await load();
}

function sourceLabel(source) {
  return { manual: 'typed by you', search: 'from a search match', cover_scan: 'from a cover scan', upload: 'from an upload', link: 'linked', note: 'from a note' }[source] || source || 'added';
}

async function bookDetail(root, bookId, { navigate }) {
  root.appendChild(loadingCard('Opening book…'));
  let data;
  try { data = await api.get(`/api/books/${bookId}`); } catch (error) {
    const deadLink = error.status === 404 || error.code === 'book_not_found'
      || error.code === 'invalid_input' || error.code === 'not_found';
    root.replaceChildren(deadLink
      ? emptyState('Book not found', 'It may have been deleted.', h('a', { class: 'btn sm', href: '#/library', text: 'Back to library' }))
      : errorCard(error, () => { root.replaceChildren(); bookDetail(root, bookId, { navigate }); }));
    return;
  }
  const { book } = data;
  const reload = () => { root.replaceChildren(); bookDetail(root, bookId, { navigate }); };
  root.replaceChildren(pageHead(book.subject || 'Book', book.title, [book.author, book.publisher, book.edition, book.publication_year || ''].filter(Boolean).join(' · '),
    [h('a', { class: 'btn', href: `#/scanner?book=${book.id}`, text: 'Scan more' }),
      h('button', { class: 'btn secondary', type: 'button', text: 'Edit details', onClick: () => bookForm(book, reload) }),
      h('button', { class: 'btn ghost', type: 'button', text: 'Delete book', onClick: () => deleteBook(book, navigate) })]));

  const progress = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Scan progress' }), h('span', { class: 'spacer' }),
      h('span', { class: 'tag teal', text: `${data.pages} page${data.pages === 1 ? '' : 's'} of verified text` })),
    h('p', { class: 'tiny muted', text: `${data.chapters.length} chapters recorded · ${data.chapters.filter(c => c.status === 'done').length} marked finished · ${data.spaces.length} space${data.spaces.length === 1 ? '' : 's'} linked.` }));

  const chapters = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Chapters' }), h('span', { class: 'spacer' }),
      h('button', { class: 'btn sm secondary', type: 'button', text: 'Add chapter', onClick: () => chapterForm(bookId, null, reload) })),
    data.chapters.length ? h('ul', { class: 'list-plain chapter-list' }, data.chapters.map(c => h('li', { class: 'row chapter-row' },
      h('b', { class: 'chapter-num', text: c.number ? `Ch ${c.number}` : '—' }),
      h('div', { style: { flex: 1 } }, h('div', { text: c.title }), h('small', { class: 'muted', text: c.summary || `${c.pages_extracted} pages scanned` })),
      statusSelect(c, reload),
      h('button', { class: 'btn ghost sm', type: 'button', text: 'Edit', onClick: () => chapterForm(bookId, c, reload) }),
      h('a', { class: 'btn ghost sm', href: `#/scanner?book=${bookId}&chapter=${c.id}`, text: 'Scan pages' })))
      ) : h('p', { class: 'muted tiny', text: 'No chapters yet. Use the scanner stage 2 (contents page) or add one by hand.' }));

  const searchBox = h('input', { type: 'search', placeholder: 'Search inside this book (2+ characters)' });
  const hits = h('div', { class: 'stack' });
  const doSearch = async () => {
    if (searchBox.value.trim().length < 2) { hits.replaceChildren(); return; }
    hits.replaceChildren(spinner('Searching your scanned text…'));
    try {
      const res = await api.get(`/api/books/${bookId}/search?q=${encodeURIComponent(searchBox.value.trim())}`);
      hits.replaceChildren(...(res.hits.length ? res.hits.map(hit => h('div', { class: 'card tight' },
        h('div', { class: 'row between' }, h('b', { class: 'tiny', text: `Page ${hit.page}` }), hit.chapter ? h('span', { class: 'tag grey', text: hit.chapter }) : null),
        h('p', { class: 'tiny', text: hit.excerpt }))) : [emptyState('No match in your scans', 'Only pages you have scanned are searchable. Scan more pages, or check the spelling.')]));
    } catch (error) { hits.replaceChildren(errorCard(error, doSearch)); }
  };
  searchBox.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
  const searchCard = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Search inside the book' })), h('div', { class: 'row' }, searchBox, h('button', { class: 'btn sm', type: 'button', text: 'Search', onClick: doSearch })), hits);

  const docRows = data.documents.map(d => h('li', { class: 'row' },
    h('span', { class: 'tag grey', text: d.kind }), h('span', { text: d.file_name, style: { flex: 1 } }),
    h('small', { class: 'muted', text: `${d.stage} · ${d.status} · ${Math.round((d.size || 0) / 1024)} KB · ${timeAgo(d.created_at)}` }),
    h('button', { class: 'btn ghost sm', type: 'button', text: 'Open', onClick: async () => {
      try {
        const full = await api.get(`/api/documents/${d.id}`);
        if (full.download_url) window.open(full.download_url, '_blank', 'noopener');
        else toast('That upload has no readable file yet.', 'bad');
      } catch (error) { errorToast(error); }
    } }),
    h('button', { class: 'btn ghost sm', type: 'button', text: 'Remove', onClick: async () => {
      try { await api.del(`/api/documents/${d.id}`); toast('Upload removed.'); reload(); } catch (error) { errorToast(error); }
    } })));
  const docs = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Uploads' })),
    data.documents.length ? h('ul', { class: 'list-plain doc-list' }, docRows)
      : h('p', { class: 'muted tiny', text: 'No uploads stored for this book yet.' }));

  const spaceBox = h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Linked spaces' })),
    h('p', { class: 'tiny muted', text: 'A linked book becomes the tutor’s evidence: answers cite these pages instead of guessing.' }),
    h('div', { class: 'row wrap-gap' },
      data.spaces.map(s => h('a', { class: 'tag teal', href: `#/spaces/${s.id}`, text: s.name })),
      data.spaces.length ? null : h('a', { class: 'btn ghost sm', href: '#/spaces', text: 'Link one from a space' })));

  root.appendChild(h('div', { class: 'grid side' },
    h('div', { class: 'stack' }, chapters, searchCard),
    h('div', { class: 'stack' }, progress, h('section', { class: 'card' }, h('div', { class: 'card-head' }, h('h3', { text: 'Practise from this book' })),
      quizCreator({ bookId, chapterId: data.chapters.find(c => c.pages_extracted > 0)?.id, spaceId: data.spaces[0]?.id, subject: book.subject, onCreated: reload })), spaceBox, docs)));
}

function statusSelect(chapter, onSaved) {
  return select(STATUSES, chapter.status, { class: 'sm-status', 'aria-label': 'Chapter status', onChange: async event => {
    try { await api.patch(`/api/chapters/${chapter.id}`, { status: event.target.value }); toast(event.target.value === 'done' ? 'Chapter marked finished — reward checked.' : 'Status saved.'); onSaved(); }
    catch (error) { event.target.value = chapter.status; errorToast(error); }
  } });
}

function bookForm(book, onSaved) {
  const f = key => h('input', { type: 'text', maxlength: '160', value: book?.[key] || '' });
  const title = f('title'); title.dataset.autofocus = '1'; title.placeholder = 'Physics — Class 10 (Punjab Board)';
  const author = f('author'); const subject = f('subject'); const publisher = f('publisher'); const edition = f('edition');
  const year = h('input', { type: 'number', min: '0', max: '2100', value: book?.publication_year || '' });
  const url = f('external_url'); url.placeholder = 'https://…';
  const close = openSheet(h('form', { class: 'stack', onSubmit: async event => {
    event.preventDefault();
    if (!title.value.trim()) { toast('A title is required.', 'bad'); return; }
    const payload = { title: title.value.trim(), author: author.value.trim(), subject: subject.value.trim(), publisher: publisher.value.trim(), edition: edition.value.trim(), publication_year: Number(year.value) || 0, external_url: url.value.trim(), source: 'manual', corrected: true };
    try {
      const saved = book ? await api.patch(`/api/books/${book.id}`, payload) : await api.post('/api/books', payload);
      close(); toast(book ? 'Book updated.' : 'Book added to your library.', 'good'); onSaved?.(saved);
    } catch (error) { errorToast(error); }
  } },
  sheetTitle(book ? 'Edit book' : 'Add a book by hand', 'Type only what your book actually says — nothing is guessed.'),
  field('Title', title), h('div', { class: 'field-row' }, field('Author', author), field('Subject', subject), field('Publisher', publisher)),
  h('div', { class: 'field-row' }, field('Edition', edition), field('Year', year), field('Official link', url)),
  h('div', { class: 'row end' }, h('button', { class: 'btn secondary', type: 'button', text: 'Cancel', onClick: () => close() }), h('button', { class: 'btn', type: 'submit', text: 'Save book' }))));
}

function chapterForm(bookId, chapter, onSaved) {
  const number = h('input', { type: 'number', min: '0', max: '500', value: chapter?.number || '' });
  const title = h('input', { type: 'text', maxlength: '160', value: chapter?.title || '' });
  const summary = h('textarea', { maxlength: '2000', style: { minHeight: '70px' } }, chapter?.summary || '');
  const close = openSheet(h('form', { class: 'stack', onSubmit: async event => {
    event.preventDefault();
    if (!title.value.trim()) { toast('Chapter title is required.', 'bad'); return; }
    try {
      if (chapter) await api.patch(`/api/chapters/${chapter.id}`, { title: title.value.trim(), summary: summary.value.trim(), status: chapter.status });
      else await api.post(`/api/books/${bookId}/chapters`, { chapters: [{ number: Number(number.value) || 0, title: title.value.trim(), summary: summary.value.trim() }] });
      close(); toast('Saved.'); onSaved();
    } catch (error) { errorToast(error); }
  } }, sheetTitle(chapter ? 'Edit chapter' : 'Add chapter'),
  h('div', { class: 'field-row' }, field('Number', number), field('Title', title)), field('Summary', summary),
  h('div', { class: 'row end' }, h('button', { class: 'btn secondary', type: 'button', text: 'Cancel', onClick: () => close() }), h('button', { class: 'btn', type: 'submit', text: 'Save' }))));
}

function deleteBook(book, navigate) {
  const input = h('input', { type: 'text', placeholder: 'Type DELETE', 'aria-label': 'Type DELETE' });
  const close = openSheet(h('div', { class: 'stack' }, sheetTitle('Delete this book?'),
    h('p', { text: `“${book.title}” and all its chapters, scanned pages, uploads and space links are removed permanently. Notes and chat in your spaces stay. Credits already earned are not reversed.` }),
    field('Confirmation', input),
    h('div', { class: 'row end' },
      h('button', { class: 'btn secondary', type: 'button', text: 'Cancel', onClick: () => close() }),
      h('button', { class: 'btn danger', type: 'button', text: 'Delete book', onClick: async event => {
        if (input.value.trim().toUpperCase() !== 'DELETE') { toast('Type DELETE to confirm.', 'bad'); return; }
        // currentTarget is gone once the await resumes, so hold the button itself.
        const button = event.currentTarget;
        button.disabled = true;
        try { await api.del(`/api/books/${book.id}`); close(); toast('Book deleted.'); navigate('#/library'); }
        catch (error) { button.disabled = false; errorToast(error); }
      } }))));
}
