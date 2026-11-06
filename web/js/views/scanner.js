// Smart Scanner — four stages. Verified book text and AI interpretation are kept
// visibly apart, and every extract keeps its page reference.
import { api, uploadFile } from '../api.js';
import { clientKey, store } from '../store.js';
import { citationList, emptyState, errorToast, field, h, modelTag, pageHead, richText, spinner, toast } from '../ui.js';
import { ACTION_LIST, originBanner } from './shared.js';
import { playQuiz } from './quiz.js';

const STAGES = [
  ['cover', '1 · Book cover'],
  ['contents', '2 · Table of contents'],
  ['chapter', '3 · Chapter pages'],
  ['tools', '4 · AI study tools'],
];

export async function render(root, { query }) {
  let books = [];
  try { books = (await api.get('/api/books')).items; } catch { books = []; }
  let spaces = [];
  try { spaces = await api.get('/api/spaces'); } catch { spaces = []; }

  let current = query.get('chapter') ? 'chapter' : (query.get('stage') || 'cover');
  let bookId = query.get('book') || books[0]?.id || '';

  root.appendChild(pageHead('Smart Scanner', 'Scan your textbook', 'Photograph a cover, index the contents, then bring in the pages you are actually studying. A PDF with a text layer is read exactly; a photograph goes through a vision model and you proofread it.',
    [books.length ? h('select', { 'aria-label': 'Book', onChange: e => { bookId = e.value; show(current); } }, books.map(b => h('option', { value: b.id, selected: b.id === bookId }, b.title))) : null,
      h('a', { class: 'btn secondary', href: '#/library', text: 'My library' })]));

  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { class: 'tab-panel stack' });
  root.append(tabs, panel);

  function show(name) {
    current = name;
    tabs.replaceChildren(...STAGES.map(([key, label]) => h('button', {
      class: `tab${key === name ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(key === name), onClick: () => show(key),
    }, label)));
    panel.replaceChildren(spinner('Loading this stage…'));
    PANEL[name](name).then(node => { if (current === name) panel.replaceChildren(node); }).catch(error => {
      panel.replaceChildren(h('div', { class: 'banner bad' }, h('div', {}, h('b', { text: 'This stage could not open' }), h('span', { text: error?.hint || error?.message || 'Reload the page.' }))));
    });
  }
  show(current);
}

// Replaced by the real panel map below; kept as a closure helper name only.
let PANEL;

// ---------- shared upload control ----------
function uploader(stage, book_id, { accept = 'image/*,application/pdf', label = 'Choose file' } = {}) {
  const input = h('input', { type: 'file', accept, 'aria-label': `${stage} upload`, style: { maxWidth: '320px' } });
  const status = h('span', { class: 'tiny muted' });
  const go = h('button', { class: 'btn', type: 'button', text: 'Upload', onClick: run });
  const row = h('div', { class: 'row' }, input, go, status);
  async function run() {
    const file = input.files?.[0];
    if (!file) { toast('Pick a photo or PDF first.', 'bad'); return null; }
    if (file.size > 10 * 1024 * 1024) { toast('Files must stay under 10 MB.', 'bad'); return null; }
    go.disabled = true;
    status.textContent = 'Uploading…';
    try {
      const res = await uploadFile(file, { stage, book_id: book_id || undefined }, share => { status.textContent = `Uploading ${Math.round(share * 100)}%`; });
      status.textContent = `${file.name} stored (${Math.round(res.document.size / 1024)} KB).`;
      go.disabled = false;
      return res.documentId;
    } catch (error) {
      go.disabled = false;
      status.textContent = '';
      errorToast(error);
      return null;
    }
  }
  return { row, run, input, setBook: id => { book_id = id; } };
}

function guidance(error) {
  const code = error?.code;
  if (code === 'no_provider_configured' || code === 'credentials_not_configured') {
    return h('div', { class: 'banner warn' }, h('div', {}, h('b', { text: 'No AI provider connected yet' }),
      h('span', { text: 'Reading a photograph needs a vision model. Add your own key in Settings, or use a PDF that already has a text layer — text-layer PDFs are read exactly, with no model and no cost. You can always type the chapter index by hand.' }),
      h('a', { class: 'btn sm', href: '#/settings', text: 'Open Settings' })));
  }
  if (code === 'no_vision_model' || code === 'model_not_found') {
    return h('div', { class: 'banner warn' }, h('div', {}, h('b', { text: 'That model cannot read images' }),
      h('span', { text: 'Mark one enabled model as vision-capable in Settings → AI Providers, or upload a text-layer PDF.' }),
      h('a', { class: 'btn sm', href: '#/settings', text: 'Provider settings' })));
  }
  if (code === 'daily_limit_reached' || code === 'rate_limited') {
    return h('div', { class: 'banner bad' }, h('div', {}, h('b', { text: 'Daily AI limit reached' }), h('span', { text: error.hint || 'Core study tools stay free — raise the limit in Settings tomorrow.' })));
  }
  return h('div', { class: 'banner bad' }, h('div', {}, h('b', { text: 'That step did not complete' }), h('span', { text: error?.hint || error?.message || 'Try again, or use the manual path below.' })));
}

// ---------- stage panels ----------
PANEL = {
  async cover(name) {
    const box = h('div', { class: 'stack' });
    const up = uploader('cover', null, { accept: 'image/*', label: 'Cover photo' });
    const out = h('div', { class: 'stack' });
    const grab = h('button', { class: 'btn', type: 'button', text: 'Read the cover', onClick: async () => {
      // Locked before the upload starts: a second click during the upload used to
      // run a second upload and a second model call for one action.
      if (grab.disabled) return;
      grab.disabled = true;
      grab.textContent = 'Working…';
      const documentId = await up.run();
      if (!documentId) { grab.disabled = false; grab.textContent = 'Read the cover'; return; }
      grab.textContent = 'Reading…';
      out.replaceChildren(spinner('The model is transcribing what it can see on the cover…'));
      try {
        const res = await api.post('/api/scan/cover', { document_id: documentId });
        out.replaceChildren(coverEditor(res, documentId));
      } catch (error) { out.replaceChildren(guidance(error)); }
      grab.disabled = false;
      grab.textContent = 'Read the cover';
    } });
    box.append(
      h('div', { class: 'card stack' }, h('h3', { text: 'Stage 1 — identify the book' }),
        h('p', { class: 'tiny muted', text: 'Upload a clear photo of the front cover. The reader reports only what it can see and marks its confidence; you correct the rest. Nothing is inferred from the artwork.' }),
        up.row, grab), out,
      h('details', { class: 'card card-flat' }, h('summary', { text: 'No photo? Add the book by hand' }),
        h('p', { class: 'tiny muted', text: 'Hand entry is stored exactly as you type it and counts as verified by you.' }),
        h('a', { class: 'btn sm secondary', href: '#/library', text: 'Library → Add by hand' })));
    return box;
  },

  async contents(name) {
    const books = (await api.get('/api/books').catch(() => ({ items: [] }))).items;
    if (!books.length) return emptyState('Add a book first', 'The contents index is stored against one of your books.', h('a', { class: 'btn sm', href: '#/scanner', text: 'Stage 1' }));
    let bookId = books[0].id;
    const picker = h('select', { 'aria-label': 'Book', onChange: e => { bookId = e.value; up.setBook(bookId); } }, books.map(b => h('option', { value: b.id }, b.title)));
    const up = uploader('contents', bookId, { accept: 'image/*,application/pdf' });
    const out = h('div', { class: 'stack' });
    const grab = h('button', { class: 'btn', type: 'button', text: 'Read the contents page', onClick: async () => {
      if (grab.disabled) return;
      grab.disabled = true; grab.textContent = 'Working…';
      const documentId = await up.run();
      if (!documentId) { grab.disabled = false; grab.textContent = 'Read the contents page'; return; }
      grab.textContent = 'Indexing…';
      out.replaceChildren(spinner('Reading the printed contents…'));
      try {
        const res = await api.post('/api/scan/toc', { document_id: documentId, book_id: bookId });
        out.replaceChildren(res.chapters.length ? chapterEditor(bookId, res) : guidance({ code: 'extraction_failed', hint: 'No entries came back. Check the photo, or add the chapters by hand below.' }));
      } catch (error) { out.replaceChildren(guidance(error)); }
      grab.disabled = false; grab.textContent = 'Read the contents page';
    } });
    return h('div', { class: 'stack' },
      h('div', { class: 'card stack' }, h('h3', { text: 'Stage 2 — index the chapters' }),
        h('p', { class: 'tiny muted', text: 'A PDF contents page is read from its text layer (exact, free). A photo goes through the vision model. Either way you check the list before saving.' }),
        h('div', { class: 'field-row' }, field('Book', picker), null), up.row, grab),
      out);
  },

  async chapter(name) {
    const books = (await api.get('/api/books').catch(() => ({ items: [] }))).items;
    if (!books.length) return emptyState('Add a book first', 'Chapter pages are stored against a book.', h('a', { class: 'btn sm', href: '#/scanner', text: 'Stage 1' }));
    let bookId = books[0].id;
    let chapters = [];
    const chapterSelect = h('select', { 'aria-label': 'Chapter' });
    const pageStart = h('input', { type: 'number', min: '1', max: '5000', value: '1' });
    const up = uploader('chapter', bookId, { accept: 'application/pdf,image/*' });
    const out = h('div', { class: 'stack' });
    const picker = h('select', { 'aria-label': 'Book', onChange: async e => { bookId = e.value; up.setBook(bookId); await loadChapters(); } },
      books.map(b => h('option', { value: b.id }, b.title)));
    async function loadChapters() {
      chapterSelect.replaceChildren(h('option', { value: '' }, 'Loading chapters…'));
      try {
        const res = await api.get(`/api/books/${bookId}`);
        chapters = res.chapters;
        chapterSelect.replaceChildren(...(chapters.length
          ? chapters.map(c => h('option', { value: c.id }, c.number ? `Ch ${c.number} — ${c.title}` : c.title))
          : [h('option', { value: '' }, 'No chapters yet — use Stage 2')]));
      } catch { chapterSelect.replaceChildren(h('option', { value: '' }, 'Could not load chapters')); }
    }
    const send = h('button', { class: 'btn', type: 'button', text: 'Extract this page / PDF', onClick: async () => {
      if (send.disabled) return;
      send.disabled = true; send.textContent = 'Working…';
      const documentId = await up.run();
      if (!documentId) { send.disabled = false; send.textContent = 'Extract this page / PDF'; return; }
      send.textContent = 'Extracting…';
      out.replaceChildren(spinner('Pulling the printed text out…'));
      try {
        const res = await api.post('/api/scan/chapter', {
          document_id: documentId, book_id: bookId,
          chapter_id: chapterSelect.value || undefined, page_start: Number(pageStart.value) || 1,
        });
        out.replaceChildren(h('div', { class: 'card stack' },
          h('div', { class: 'card-head' }, h('h3', { text: `${res.pages.length} page${res.pages.length === 1 ? '' : 's'} stored` }),
            h('span', { class: 'spacer' }), h('span', { class: `tag ${res.origin === 'text_layer' ? 'teal' : 'amber'}`, text: res.origin === 'text_layer' ? 'Exact PDF text layer' : 'Vision transcription' })),
          h('p', { class: 'tiny muted', text: res.note }),
          h('ul', { class: 'list-plain page-list' }, res.pages.map(p => h('li', { class: 'row' }, h('b', { class: 'tiny', text: `p. ${p.page_number}` }),
            h('span', { class: 'tiny muted', text: `${num(p.characters)} characters` }), h('span', { class: 'tiny muted', text: `confidence ${p.confidence}%` })))),
          h('div', { class: 'row' }, h('a', { class: 'btn sm', href: `#/scanner?stage=tools&book=${bookId}${chapterSelect.value ? `&chapter=${chapterSelect.value}` : ''}`, text: 'Go to AI tools' }))));
        if (res.weekly?.done) toast('Weekly challenge complete — check your wallet.', 'good');
      } catch (error) { out.replaceChildren(guidance(error)); }
      send.disabled = false; send.textContent = 'Extract this page / PDF';
    } });
    await loadChapters();
    return h('div', { class: 'stack' },
      h('div', { class: 'card stack' }, h('h3', { text: 'Stage 3 — bring in the pages you are studying' }),
        h('p', { class: 'tiny muted', text: 'Upload one PDF containing the chapter, or a photo of a single page. Page numbers follow the start value you set, so citations match your book.' }),
        h('div', { class: 'field-row' }, field('Book', picker), field('Chapter', chapterSelect), field('First page number', pageStart)),
        up.row, send),
      out);
  },

  async tools(name) {
    const [books, spaces] = await Promise.all([
      api.get('/api/books').catch(() => ({ items: [] })),
      api.get('/api/spaces').catch(() => []),
    ]);
    let bookId = new URLSearchParams(location.hash.split('?')[1] || '').get('book') || '';
    let chapterId = new URLSearchParams(location.hash.split('?')[1] || '').get('chapter') || '';
    let spaceId = spaces[0]?.id || '';
    const bookPicker = h('select', { 'aria-label': 'Book', onChange: async e => { bookId = e.value; await loadChapters(); } },
      [h('option', { value: '' }, 'Whole book'), ...books.items.map(b => h('option', { value: b.id, selected: b.id === bookId }, b.title))]);
    const chapterSelect = h('select', { 'aria-label': 'Chapter' }, h('option', { value: '' }, 'All scanned pages'));
    const spacePicker = h('select', { 'aria-label': 'Space', onChange: e => { spaceId = e.value; } },
      [h('option', { value: '' }, 'No space'), ...spaces.map(s => h('option', { value: s.id, selected: s.id === spaceId }, s.name))]);
    async function loadChapters() {
      chapterSelect.replaceChildren(h('option', { value: '' }, 'All scanned pages'));
      if (!bookId) return;
      try {
        const res = await api.get(`/api/books/${bookId}`);
        chapterSelect.replaceChildren(h('option', { value: '' }, 'All scanned pages'),
          ...res.chapters.filter(c => c.pages_extracted > 0).map(c => h('option', { value: c.id, selected: c.id === chapterId }, c.number ? `Ch ${c.number} — ${c.title}` : c.title)));
      } catch { /* the picker simply stays empty */ }
    }
    await loadChapters();
    const out = h('div', { class: 'stack' });
    // The price of a tool is read from the server's economy table, so the badge
    // on the button is the number the ledger charges.
    const priceOf = action => {
      const feature = store.boot?.economy?.actions?.[action];
      if (!feature) return null;
      const price = store.boot?.economy?.pricing?.[feature];
      return Number.isFinite(price) ? price : null;
    };
    const run = async (item, button) => {
      button.disabled = true;
      const label = button.textContent;
      button.textContent = 'Working…';
      out.prepend(spinner(`${label} — reading your scanned pages…`));
      try {
        const res = await api.post('/api/ai/action', {
          action: item.action, book_id: bookId || undefined, chapter_id: chapterId || undefined,
          space_id: spaceId || undefined, client_key: clientKey(),
        });
        out.firstChild?.remove?.();
        out.prepend(res.quiz_id ? quizResult(res) : textResult(item, res, spaceId));
        if (res.balance !== undefined) {
          toast(res.credits_spent
            ? `${item.label} used ${num(res.credits_spent)} BC — balance ${num(res.balance)} BC.`
            : `No credits were deducted — balance ${num(res.balance)} BC.`);
        }
      } catch (error) {
        out.firstChild?.remove?.();
        out.prepend(error.code === 'no_material'
          ? h('div', { class: 'banner warn' }, h('div', {}, h('b', { text: 'No scanned text yet' }), h('span', { text: error.hint || 'Finish Stage 3 for the chapter you want, then run this tool.' })))
          : error.code === 'insufficient_credits'
            ? h('div', { class: 'banner bad' }, h('div', {}, h('b', { text: 'Not enough Bridge Credits' }),
              h('span', { text: error.hint || 'Earn more from the daily rewards.' }),
              h('a', { class: 'btn sm', href: '#/rewards', text: 'Rewards Center' })))
            : guidance(error));
      }
      button.disabled = false;
      button.textContent = label;
    };
    return h('div', { class: 'stack' },
      h('div', { class: 'card stack' }, h('h3', { text: 'Stage 4 — study tools over your own text' }),
        h('p', { class: 'tiny muted', text: 'Each tool shows its price before you run it. The credits are taken only if an answer comes back — if the request fails, they are refunded automatically. Scanning itself is free.' }),
        h('div', { class: 'field-row' }, field('Book', bookPicker), field('Chapter', chapterSelect), field('Save notes into space', spacePicker)),
        h('div', { class: 'action-grid' }, ACTION_LIST.map(item => {
          const price = priceOf(item.action);
          return h('button', {
            class: 'action', type: 'button', onClick: event => run(item, event.currentTarget),
          }, h('b', { text: item.label }), price === null
            ? h('small', { class: 'tag green', text: 'free' })
            : h('small', { class: `tag ${price ? 'amber' : 'green'}`, text: price ? `${price} BC` : 'free' }));
        }))),
      out);
  },
};

function num(value) { return (Number(value) || 0).toLocaleString(); }

function textResult(item, res, spaceId) {
  const dir = item.action === 'urdu_explain' ? 'rtl' : null;
  return h('article', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h3', { text: item.label }), h('span', { class: 'spacer' }),
      h('span', { class: `tag ${res.origin === 'local_text' ? 'teal' : 'amber'}`, text: res.origin === 'local_text' ? 'from your pages, no AI' : 'AI written' }),
      modelTag(res.provider, res.model)),
    originBanner(res.origin, res.note),
    richText(res.text, { dir }),
    citationList(res.citations),
    spaceId && ['short_notes', 'long_notes', 'summary', 'revision', 'concepts'].includes(item.action)
      ? h('p', { class: 'tiny muted', text: 'Saved to this space’s notes tab.' }) : null,
    res.tokens ? h('small', { class: 'muted tiny', text: `${res.tokens} tokens${res.cached ? ' · served from cache' : ''}` }) : null);
}

function quizResult(res) {
  return h('article', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h3', { text: res.title || 'Quiz ready' }), h('span', { class: 'spacer' }), modelTag(res.provider, res.model)),
    originBanner(res.origin, res.note),
    h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', text: `Start (${res.questions.length} questions)`, onClick: () => playQuiz(res, {}) })));
}

// ---------- editors ----------
function coverEditor(res, documentId) {
  const fields = res.fields || {};
  const conf = fields.confidence || {};
  const make = key => {
    const input = h('input', { type: 'text', value: String(fields[key] ?? ''), maxlength: key === 'title' ? 160 : 120 });
    const label = { title: 'Title', subtitle: 'Subtitle', author: 'Author', publisher: 'Publisher', edition: 'Edition', language: 'Language' }[key] || key;
    const score = Number(conf[key]);
    return field(label, input, Number.isFinite(score) ? `Reader confidence ${score}%` : null);
  };
  const title = make('title'); const subtitle = make('subtitle'); const author = make('author');
  const publisher = make('publisher'); const edition = make('edition'); const language = make('language');
  const year = h('input', { type: 'number', min: '0', max: '2100', value: String(fields.year || '') });
  const subject = h('input', { type: 'text', maxlength: '80', value: '' });
  const save = h('button', { class: 'btn', type: 'button', text: 'Save to my library', onClick: async () => {
    if (!title.querySelector('input').value.trim()) { toast('A title is required.', 'bad'); return; }
    save.disabled = true;
    try {
      const created = await api.post('/api/books', {
        title: title.querySelector('input').value.trim(),
        author: author.querySelector('input').value.trim(),
        publisher: publisher.querySelector('input').value.trim(),
        edition: edition.querySelector('input').value.trim(),
        subject: subject.querySelector('input').value.trim(),
        publication_year: Number(year.querySelector('input').value) || 0,
        source: 'cover_scan',
      });
      toast('Book saved. Check the fields match your copy.', 'good');
      location.hash = `#/scanner?stage=contents&book=${created.id}`;
    } catch (error) { save.disabled = false; errorToast(error); }
  } });
  return h('div', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h3', { text: 'What the reader saw' }), h('span', { class: 'spacer' }), h('span', { class: 'tag grey', text: 'correct anything wrong' })),
    h('p', { class: 'tiny muted', text: fields.notes ? `Reader note: ${fields.notes}` : 'Fix anything that does not match your book before saving — saved text is treated as verified by you.' }),
    h('div', { class: 'field-row' }, title, subtitle, author),
    h('div', { class: 'field-row' }, publisher, edition, language),
    h('div', { class: 'field-row' }, year, subject, null),
    h('div', { class: 'row' }, save),
    res.matches?.length ? h('div', { class: 'stack' }, h('div', { class: 'stat-label', text: 'Similar published records (Open Library)' }),
      h('ul', { class: 'list-plain match-list' }, res.matches.map(m => h('li', { class: 'row' },
        h('div', { style: { flex: 1 } }, h('b', { class: 'tiny', text: m.title }), h('div', { class: 'tiny muted', text: [m.author, m.publisher, m.year].filter(Boolean).join(' · ') })),
        h('button', { class: 'btn ghost sm', type: 'button', text: 'Use these', onClick: () => {
          title.querySelector('input').value = m.title;
          author.querySelector('input').value = m.author || '';
          publisher.querySelector('input').value = m.publisher || '';
          if (m.year) year.querySelector('input').value = String(m.year);
        } }))))) : h('p', { class: 'tiny muted', text: 'No published match found — normal for local and board textbooks. Type the details yourself.' }));
}

const PROVENANCE = {
  pdf_text_layer: ['teal', 'read exactly from the PDF text'],
  pdf_text_model: ['amber', 'PDF text read by a model'],
  vision: ['amber', 'read from the photograph by a model'],
};

function chapterEditor(bookId, res) {
  const rowsWrap = h('div', { class: 'stack' });
  const rowNode = (item, index) => {
    const number = h('input', { type: 'number', min: '0', max: '500', value: String(item.number ?? index + 1), 'aria-label': 'Chapter number' });
    const title = h('input', { type: 'text', maxlength: '160', value: item.title, 'aria-label': 'Chapter title' });
    const page = h('input', { type: 'number', min: '0', max: '5000', value: String(item.page || ''), 'aria-label': 'Page' });
    const summary = h('input', { type: 'text', maxlength: '2000', value: (item.topics || []).join(', '), 'aria-label': 'Topics' });
    return h('div', { class: 'toc-row' }, number, title, page, summary,
      h('button', { class: 'btn ghost sm', type: 'button', text: 'Remove', onClick: event => event.currentTarget.parentElement.remove() }));
  };
  rowsWrap.append(...(res.chapters || []).map(rowNode));
  const save = h('button', { class: 'btn', type: 'button', text: 'Save this index', onClick: async () => {
    const chapters = [...rowsWrap.children].map(node => {
      const [n, t, , s] = node.querySelectorAll('input');
      return { number: Number(n.value) || 0, title: t.value.trim(), summary: [s.value.trim(), t.value.trim() && Number(node.querySelectorAll('input')[2].value) ? `p. ${node.querySelectorAll('input')[2].value}` : ''].filter(Boolean).join(' · ') };
    }).filter(c => c.title);
    if (!chapters.length) { toast('Keep at least one chapter title.', 'bad'); return; }
    save.disabled = true;
    try {
      const res2 = await api.post(`/api/books/${bookId}/chapters`, { chapters });
      toast(`Saved ${res2.added} new chapter${res2.added === 1 ? '' : 's'} (duplicates skipped).`, 'good');
      location.hash = `#/scanner?stage=chapter&book=${bookId}`;
    } catch (error) { save.disabled = false; errorToast(error); }
  } });
  const [tone, label] = PROVENANCE[res.origin] || ['amber', 'read by a model'];
  return h('div', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Chapter index' }), h('span', { class: 'spacer' }),
      h('span', { class: `tag ${tone}`, text: label })),
    h('p', { class: 'tiny muted', text: res.note || 'Check the titles and page numbers against your book.' }),
    h('div', { class: 'toc-head tiny muted' }, h('span', { text: '#' }), h('span', { text: 'Chapter' }), h('span', { text: 'Page' }), h('span', { text: 'Topics' }), h('span')),
    rowsWrap,
    h('div', { class: 'row' },
      h('button', { class: 'btn secondary sm', type: 'button', text: 'Add empty row', onClick: () => rowsWrap.appendChild(rowNode({ number: rowsWrap.children.length + 1, title: '' }, rowsWrap.children.length)) }),
      save));
}
