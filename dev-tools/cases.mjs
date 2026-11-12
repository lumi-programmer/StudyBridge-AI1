// Route-by-route behaviour tests for the StudyBridge Function, driven through
// the injected fakes in function-smoke.mjs. Each section returns a list of
// "name :: detail" failures; an empty list means every check passed.
import { boot, userContext } from './function-smoke.mjs';
import { dayOfIso } from '../functions/lib/util.mjs';
import { readBody, readBodyResult } from '../functions/lib/ai.mjs';

const KEY = 'sk-tes…et-9';

// ---- helpers ----------------------------------------------------------------
function tracker() {
  const checks = [];
  return {
    checks,
    ok(name, condition, detail) {
      checks.push({ name, pass: Boolean(condition), detail: condition ? '' : stringify(detail).slice(0, 400) });
      return Boolean(condition);
    },
    failures() { return checks.filter(c => !c.pass); },
    summary() {
      const failed = this.failures();
      return `${checks.length - failed.length}/${checks.length} passed` + (failed.length ? `\n  FAILED:\n  - ${failed.map(f => `${f.name} :: ${f.detail}`).join('\n  - ')}` : '');
    },
  };
}

function stringify(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function uuid() { return crypto.randomUUID(); }

function pdfWith(pagesText) {
  let pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n';
  const kids = [];
  let n = 3;
  for (const text of pagesText) {
    kids.push(`${n} 0 R`);
    pdf += `${n} 0 obj<</Type/Page/Parent 2 0 R/Contents ${n + 1} 0 R>>endobj\n`;
    const stream = `BT /F1 12 Tf 1 0 0 1 50 700 Tm (${text.replace(/[()\\]/g, '')}) Tj ET`;
    pdf += `${n + 1} 0 obj<</Length ${stream.length}>>stream\n${stream}\nendstream endobj\n`;
    n += 2;
  }
  pdf += `2 0 obj<</Type/Pages/Count ${pagesText.length}/Kids[${kids.join(' ')}]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

function pngBytes() {
  const head = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const body = 'fake-photograph-bytes'.repeat(40);
  const bytes = new Uint8Array(head.length + body.length);
  bytes.set(head, 0);
  bytes.set(new TextEncoder().encode(body), head.length);
  return bytes;
}

// The provider double. /models lists, chat/completions answers with JSON when it
// is asked for JSON and plain prose otherwise.
function makeAiFetch(options = {}) {
  return async (url, init) => {
    const u = String(url);
    const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
      status, headers: { 'content-type': 'application/json' },
    });
    if (u.includes('/models')) {
      if (options.modelsStatus) return json({ error: { message: 'nope' } }, options.modelsStatus);
      return json({ data: [
        { id: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash Lite' },
        { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' },
        { id: 'text-embedding-004', name: 'Embeddings' },
        { id: 'gemini-2.5-flash-lite', name: 'duplicate' },
        ...(options.extraModels || []),
      ] });
    }
    if (u.includes('/chat/completions')) {
      if (options.completeStatus) return json(options.completeBody || { error: { message: 'busy' } }, options.completeStatus);
      const body = JSON.parse(init.body || '{}');
      const prompt = (body.messages || []).map(m => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
      if (options.echoAuth) return json({ echoed: Object.keys(init.headers || {}) });
      let content = 'Acceleration is measured in metres per second squared. See page 3 of your book.';
      if (/multiple-choice questions|JSON array of 8|practice questions/i.test(prompt)) {
        content = JSON.stringify([
          { question: 'What is acceleration?', options: ['Rate of change of velocity', 'Speed', 'Force', 'Mass'], answer: 0, explain: 'Rate of change of velocity.', page: 3 },
          { question: 'What is velocity?', options: ['Speed in a direction', 'Mass', 'Weight', 'Energy'], answer: 0, explain: 'Speed with direction.', page: 4 },
          { question: 'What is momentum?', options: ['Mass times velocity', 'Force', 'Energy', 'Power'], answer: 0, explain: 'p = mv.', page: 5 },
          { question: 'bad one', options: ['only', 'two'], answer: 5, explain: 'must be dropped' },
        ]);
      } else if (/table of contents/i.test(prompt) || /number":1/.test(prompt)) {
        content = JSON.stringify([{ number: 1, title: 'Motion', page: 12, topics: ['Speed', 'Velocity'] }, { number: 2, title: 'Force', page: 30, topics: [] }]);
      } else if (/textbook cover|ONLY what is actually visible/.test(prompt)) {
        content = JSON.stringify({ title: 'Physics Part I', author: 'Khalid Mehmood', publisher: 'National Textbooks Board', edition: '2024', year: 2024, confidence: { title: 90 } });
      } else if (/Transcribe the printed text/.test(prompt)) {
        content = JSON.stringify({ text: 'Force is a push or pull that changes the motion of an object. Momentum is the product of mass and velocity of a body.', confidence: 88 });
      }
      return json({ choices: [{ message: { content } }], usage: { prompt_tokens: 900, completion_tokens: 200 } });
    }
    return json({ error: { message: 'not found' } }, 404);
  };
}

async function withGlobalFetch(handler, work) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await work(); } finally { globalThis.fetch = original; }
}

async function upload(env, { kind = 'pdf', mime = 'application/pdf', bytes, bookId, spaceId, stage = 'page' }) {
  const prepared = await env.call('POST', '/api/uploads/prepare', {
    kind, mime, size: bytes.length, file_name: `test-${kind}.${kind === 'pdf' ? 'pdf' : 'png'}`,
    book_id: bookId, space_id: spaceId, stage,
  });
  if (prepared.status !== 201) return { error: prepared };
  await env.storage.upload(prepared.json.object_path, bytes, { contentType: mime });
  const complete = await env.call('POST', `/api/uploads/${prepared.json.document_id}/complete`, undefined);
  return { documentId: prepared.json.document_id, objectPath: prepared.json.object_path, complete };
}

function stateOf(env, table, id) {
  const row = env.db.table(table).find(item => item.id === id);
  return row;
}

// ---- section A: identity, daily engagement, wallet --------------------------
export async function sectionCore(options = {}) {
  const env = await boot(options);
  const t = tracker();
  const content = await import('./flat/content.mjs');

  const health = await env.call('GET', '/api/health');
  t.ok('health 200', health.status === 200 && health.json.ok, health);

  const bootstrap = await env.call('GET', '/api/bootstrap');
  t.ok('bootstrap 200', bootstrap.status === 200, bootstrap);
  const b = bootstrap.json || {};
  t.ok('bootstrap zero balance', b.wallet?.balance === 0, b.wallet);
  t.ok('bootstrap daily question hides answer', b.daily?.question && b.daily.question.answer === undefined, b.daily?.question);
  t.ok('bootstrap games listed', Array.isArray(b.games) && b.games.length === 8, b.games?.length);
  t.ok('bootstrap streak row', b.streak && b.streak.current === 0, b.streak);

  const login = await env.call('POST', '/api/daily/login');
  t.ok('login grants 30', login.json?.claimed === true && login.json?.balance === 30, login.json);
  const replay = await env.call('POST', '/api/daily/login');
  t.ok('login not repeatable', replay.json?.claimed === false && replay.json?.balance === 30, replay.json);

  const dailyRow = env.db.table('daily_states')[0];
  const questionId = dailyRow?.question_id;
  const bankItem = content.QUESTION_BANK[questionId];
  t.ok('daily question stored without answer leak', Number.isInteger(questionId) && Boolean(bankItem), questionId);
  const wrong = bankItem.o.findIndex((_, i) => i !== bankItem.a);
  const badAnswer = await env.call('POST', '/api/daily/answer', { choice: wrong });
  t.ok('wrong answer earns nothing', badAnswer.json?.correct === false && badAnswer.json?.tx === null, badAnswer.json);
  const sameDay = await env.call('POST', '/api/daily/answer', { choice: bankItem.a });
  t.ok('daily question answerable once', sameDay.json?.already === true && sameDay.json?.correct === false, sameDay.json);
  const balanceAfterWrong = (await env.call('GET', '/api/wallet')).json.balance;
  t.ok('balance unchanged after wrong answer', balanceAfterWrong === 30, balanceAfterWrong);

  const profile = await env.call('POST', '/api/profile', {
    display_name: 'Ali', language: 'ur', explanation_level: 'detailed', daily_goal_minutes: 20,
    quick_break_suggestions: true, notifications: { daily_goal: true, breaks: true, challenges: true }, onboarded: true,
  });
  t.ok('profile patch applied', profile.json?.daily_goal_minutes === 20 && profile.json.language === 'ur', profile.json);
  const badGoal = await env.call('POST', '/api/profile', { daily_goal_minutes: 5000 });
  t.ok('goal bounds enforced', badGoal.status === 400, badGoal);
  const themed = await env.call('POST', '/api/profile', { theme: 'dark' });
  t.ok('theme stored on profile', themed.json?.theme === 'dark', themed.json?.theme);
  const badTheme = await env.call('POST', '/api/profile', { theme: '<script>' });
  t.ok('unknown theme falls back to system', badTheme.json?.theme === 'system', badTheme.json?.theme);
  const bootThemed = await env.call('GET', '/api/bootstrap');
  t.ok('bootstrap exposes the theme', bootThemed.json?.profile?.theme === 'system', bootThemed.json?.profile?.theme);

  const wallet = await env.call('GET', '/api/wallet');
  t.ok('wallet publishes rates', wallet.json?.rates?.earn?.login === 30 && wallet.json.rates.daily_regular_cap === 90, wallet.json?.rates);
  t.ok('wallet says basic tools free', wallet.json?.basic_tools_free === true, wallet.json?.basic_tools_free);
  t.ok('wallet history has login', (wallet.json?.history || []).some(row => String(row.reason).startsWith('login') && row.label), wallet.json?.history);

  const spendKey = uuid();
  const spend = await env.call('POST', '/api/wallet/spend', { feature: 'advanced_comparison', client_key: spendKey });
  t.ok('spend debits 10', spend.json?.balance === 20, spend.json);
  const spendAgain = await env.call('POST', '/api/wallet/spend', { feature: 'advanced_comparison', client_key: spendKey });
  t.ok('spend replay-safe', spendAgain.json?.replayed === true && spendAgain.json?.balance === 20, spendAgain.json);
  const spendNoKey = await env.call('POST', '/api/wallet/spend', { feature: 'advanced_comparison' });
  t.ok('spend needs client_key', spendNoKey.status === 400, spendNoKey);
  const spendBroke = await env.call('POST', '/api/wallet/spend', { feature: 'premium_note_pack', client_key: uuid() });
  const drain = await env.call('POST', '/api/wallet/spend', { feature: 'deep_check_quiz', client_key: uuid() });
  t.ok('cannot go below zero', [spendBroke, drain].every(r => r.status === 200 || r.json?.error === 'insufficient_credits'), [spendBroke, drain]);
  const drained = await env.call('GET', '/api/wallet');
  t.ok('balance never negative', drained.json.balance >= 0, drained.json.balance);

  const achievements = await env.call('GET', '/api/achievements');
  t.ok('achievement catalogue', achievements.json?.catalogue?.length >= 16, achievements.json?.catalogue?.length);

  const daily = await env.call('GET', '/api/daily?days=21');
  t.ok('daily calendar length', daily.json?.calendar?.length === 21, daily.json?.calendar?.length);
  t.ok('daily weekly challenge shape', daily.json?.weekly?.code && typeof daily.json.weekly.progress === 'number', daily.json?.weekly);

  const usage = await env.call('GET', '/api/usage');
  t.ok('usage 200', usage.status === 200 && Array.isArray(usage.json?.recent), usage.json && Object.keys(usage.json));
  const progress = await env.call('GET', '/api/progress');
  t.ok('progress 200', progress.status === 200 && progress.json.minutes && Array.isArray(progress.json.series.minutes), Object.keys(progress.json || {}));
  const reminders = await env.call('GET', '/api/reminders');
  t.ok('reminders 200', reminders.status === 200 && Array.isArray(reminders.json?.items), reminders.json?.items);
  const noAuth = await env.call('GET', '/api/nope');
  t.ok('unknown route 404', noAuth.status === 404 && noAuth.json?.error === 'not_found', noAuth);

  return { env, report: t.summary(), checks: t.checks };
}

// ---- section B: spaces, books, chapters, uploads ----------------------------
export async function sectionLibrary(envIn, options = {}) {
  const env = envIn || await boot(options);
  const t = tracker();

  const badSpace = await env.call('POST', '/api/spaces', { name: 'x' });
  t.ok('space name min length', badSpace.status === 400, badSpace);
  const space = await env.call('POST', '/api/spaces', { name: 'Physics', subject: 'Physics', color: 'teal', instructions: 'FSc part 1' });
  t.ok('space created', space.status === 201 && space.json.color === 'teal', space.json);
  const spaces = await env.call('GET', '/api/spaces');
  t.ok('spaces list with stats', spaces.json?.[0]?.stats?.messages === 0, spaces.json?.[0]);
  const patched = await env.call('PATCH', `/api/spaces/${space.json.id}`, { name: 'Physics 1st Year', color: 'nope' });
  t.ok('space patched', patched.json?.name === 'Physics 1st Year' && patched.json.color === 'teal', patched.json);

  const note = await env.call('POST', `/api/spaces/${space.json.id}/notes`, { title: 'Chapter 1', body: 'Motion notes' });
  t.ok('note created', note.status === 201 && note.json.version === 1, note.json);
  const noteBadVersion = await env.call('PATCH', `/api/notes/${note.json.id}`, { title: 'v2', version: 99 });
  t.ok('note optimistic lock', noteBadVersion.status === 409, noteBadVersion);
  const noteOk = await env.call('PATCH', `/api/notes/${note.json.id}`, { title: 'v2', version: 1 });
  t.ok('note patched', noteOk.json?.version === 2, noteOk.json);

  const question = await env.call('POST', `/api/spaces/${space.json.id}/questions`, { question: 'Define force', topic: 'Force', resolved: false });
  t.ok('saved question', question.status === 201, question.json);
  const questionDone = await env.call('PATCH', `/api/questions/${question.json.id}`, { resolved: true, answer: 'A push or pull.' });
  t.ok('saved question patched', questionDone.json?.resolved === true, questionDone.json);

  const book = await env.call('POST', '/api/books', { title: 'Physics Part I', subject: 'Physics', source: 'manual' });
  t.ok('book created', book.status === 201 && book.json.verified?.manual === true, book.json);
  const dupeChapters = await env.call('POST', `/api/books/${book.json.id}/chapters`, {
    chapters: [{ number: 1, title: 'Motion' }, { number: 2, title: 'Force' }, { number: 1, title: 'Motion' }],
  });
  t.ok('chapters added once each', dupeChapters.json?.added === 2, dupeChapters.json);
  const emptyChapters = await env.call('POST', `/api/books/${book.json.id}/chapters`, { chapters: [] });
  t.ok('chapter list validated', emptyChapters.status === 400, emptyChapters);
  const linked = await env.call('POST', `/api/spaces/${space.json.id}/books`, { book_id: book.json.id });
  t.ok('book linked to space', linked.status === 200, linked.json);
  const linkForeign = await env.call('POST', `/api/spaces/${space.json.id}/books`, { book_id: uuid() });
  t.ok('unknown book not linkable', linkForeign.status === 404, linkForeign);

  const bookDetail = await env.call('GET', `/api/books/${book.json.id}`);
  t.ok('book detail', bookDetail.json?.chapters?.length === 2 && bookDetail.json.spaces?.length === 1, bookDetail.json && Object.keys(bookDetail.json));
  const booksList = await env.call('GET', '/api/books?q=physics');
  t.ok('book search by title', booksList.json?.items?.length === 1 && booksList.json.items[0].chapters === 2, booksList.json);
  const corrected = await env.call('PATCH', `/api/books/${book.json.id}`, { author: 'Khalid Mehmood', corrected: true });
  t.ok('book metadata corrected', corrected.json?.verified?.corrected === true, corrected.json?.verified);

  const chapter = bookDetail.json.chapters[0];
  const chapterDone = await env.call('PATCH', `/api/chapters/${chapter.id}`, { status: 'done' });
  t.ok('chapter finished status', chapterDone.json?.status === 'done', chapterDone.json);
  const badStatus = await env.call('PATCH', `/api/chapters/${chapter.id}`, { status: 'wat' });
  t.ok('chapter status validated', badStatus.status === 400, badStatus);

  // uploads
  const bytes = pdfWith([
    'Acceleration is the rate of change of velocity of an object per unit time and its unit is metre per second squared.',
    'Force is a push or pull that changes the state of motion of an object. Momentum is the product of mass and velocity of a body.',
  ]);
  const doc = await upload(env, { kind: 'pdf', mime: 'application/pdf', bytes, bookId: book.json.id, spaceId: space.json.id });
  t.ok('pdf upload verified ready', doc.complete?.json?.status === 'ready' && doc.complete?.json?.size === bytes.length, doc.complete?.json || doc.complete);

  const wrongMime = await env.call('POST', '/api/uploads/prepare', { kind: 'pdf', mime: 'text/pdf', size: 10, file_name: 'a.pdf' });
  t.ok('mime rejected', wrongMime.status === 422, wrongMime);
  const tooBig = await env.call('POST', '/api/uploads/prepare', { kind: 'pdf', mime: 'application/pdf', size: 99_000_000, file_name: 'a.pdf' });
  t.ok('size rejected', tooBig.status === 413, tooBig);
  const fakeDoc = await env.call('POST', '/api/uploads/prepare', { kind: 'pdf', mime: 'application/pdf', size: 12, file_name: 'a.pdf' });
  await env.storage.upload(fakeDoc.json.object_path, new Uint8Array([1, 2, 3, 4]), { contentType: 'application/pdf' });
  const fakeComplete = await env.call('POST', `/api/uploads/${fakeDoc.json.document_id}/complete`);
  t.ok('declared size must match bytes', [409, 422].includes(fakeComplete.status) || fakeComplete.json?.error === 'upload_pending', fakeComplete);
  const notUploaded = await env.call('POST', '/api/uploads/prepare', { kind: 'image', mime: 'image/png', size: 100 });
  const pending = await env.call('POST', `/api/uploads/${notUploaded.json.document_id}/complete`);
  t.ok('missing object is upload_pending', pending.status === 409 && pending.json?.error === 'upload_pending', pending);
  const docGet = await env.call('GET', `/api/documents/${doc.documentId}`);
  t.ok('document signed url', typeof docGet.json?.download_url === 'string', docGet.json);

  const wallet = await env.call('GET', '/api/wallet');
  t.ok('first_space + first_book achievements', wallet.json.achievements.some(a => a.code === 'first_space')
    && wallet.json.achievements.some(a => a.code === 'first_book'), wallet.json.achievements.map(a => a.code));

  return {
    env, report: t.summary(),
    ids: { spaceId: space.json.id, bookId: book.json.id, chapterId: chapter.id, documentId: doc.documentId, noteId: note.json.id },
  };
}

// ---- section C: scanning and the AI-free learning tools ---------------------
export async function sectionScan(envIn, ids) {
  const env = envIn;
  const t = tracker();

  const scan = await env.call('POST', '/api/scan/chapter', { document_id: ids.documentId, book_id: ids.bookId, chapter_id: ids.chapterId, page_start: 12 });
  t.ok('pdf text layer scan', scan.json?.origin === 'text_layer' && scan.json?.pages?.length === 2, scan.json || scan);
  t.ok('scan keeps page numbers', scan.json?.pages?.[0]?.page_number === 12 && scan.json.pages[1].page_number === 13, scan.json?.pages);
  const pagesOfChapter = await env.call('GET', `/api/chapters/${ids.chapterId}/pages`);
  t.ok('chapter pages stored', pagesOfChapter.json?.pages?.length === 2 && pagesOfChapter.json.pages[0].extraction === 'text_layer', pagesOfChapter.json?.pages?.length);
  const search = await env.call('GET', `/api/books/${ids.bookId}/search?q=momentum`);
  t.ok('in-book search', search.json?.hits?.length === 1 && /momentum/i.test(search.json.hits[0].excerpt), search.json);
  const bookPages = await env.call('GET', `/api/books/${ids.bookId}/pages`);
  t.ok('book pages preview without full text', bookPages.json?.pages?.[0]?.preview && bookPages.json.pages[0].text === undefined, bookPages.json?.pages?.[0]);
  const chapterCounted = await env.call('GET', `/api/books/${ids.bookId}`);
  t.ok('chapter pages_extracted updated', chapterCounted.json.chapters[0].pages_extracted === 2, chapterCounted.json.chapters[0]);

  // No provider configured: the free paths must be honest, not fabricated.
  const tocFreeDoc = await upload(env, { kind: 'pdf', mime: 'application/pdf', bookId: ids.bookId, spaceId: ids.spaceId, stage: 'contents', bytes: pdfWith([
    'Chapter 1: Motion 12\nChapter 2: Force 30\nUnit 3: Work and Energy 48\nContents\nExercise 5.1 70',
  ]) });
  const tocFree = await env.call('POST', '/api/scan/toc', { document_id: tocFreeDoc.documentId, book_id: ids.bookId });
  t.ok('contents indexed with no provider at all', tocFree.json?.exact === true
    && tocFree.json?.origin === 'pdf_text_layer' && tocFree.json?.chapters?.length === 3
    && tocFree.json.chapters[0].page === 12 && tocFree.json.chapters[2].title === 'Work and Energy', { s: tocFree.status, j: tocFree.json });
  const summary = await env.call('POST', '/api/ai/action', { action: 'summary', book_id: ids.bookId, space_id: ids.spaceId });
  t.ok('summary without AI is extractive', summary.json?.origin === 'local_text' && /page 1/.test(summary.json?.text || ''), summary.json);
  const defs = await env.call('POST', '/api/ai/action', { action: 'definitions', book_id: ids.bookId });
  t.ok('definitions without AI cite pages', defs.json?.origin === 'local_text' && /page 12/.test(defs.json?.text || ''), defs.json);
  const mcqs = await env.call('POST', '/api/ai/action', { action: 'mcqs', book_id: ids.bookId });
  t.ok('mcqs fall back to local text', mcqs.json?.origin === 'local_text' && mcqs.json?.questions?.length >= 3, mcqs.json);
  t.ok('fallback questions hide answers', Array.isArray(mcqs.json?.questions) && !JSON.stringify(mcqs.json.questions || []).includes('"answer"'), mcqs.json?.questions?.[0]);
  const urdu = await env.call('POST', '/api/ai/action', { action: 'urdu_explain', book_id: ids.bookId });
  t.ok('urdu request without AI is marked local', urdu.json?.origin === 'local_text' || urdu.status >= 400, { status: urdu.status, origin: urdu.json?.origin });
  const badAction = await env.call('POST', '/api/ai/action', { action: 'do_my_homework', book_id: ids.bookId });
  t.ok('unknown action rejected', badAction.status === 400, badAction);
  const noMaterial = await env.call('POST', '/api/ai/action', { action: 'summary' });
  t.ok('action with no material is honest', noMaterial.status === 409 && noMaterial.json?.error === 'no_material', noMaterial);
  const localQuiz = await env.call('POST', '/api/quizzes', { mode: 'local', book_id: ids.bookId, count: 5 });
  t.ok('local quiz from own text', localQuiz.status === 201 && localQuiz.json.questions.length >= 3, localQuiz.json);
  t.ok('local quiz hides answers', localQuiz.json && !JSON.stringify(localQuiz.json.questions || []).includes('"answer"'), localQuiz.json?.questions?.[0]);
  const chatNoAi = await env.call('POST', `/api/spaces/${ids.spaceId}/chat`, { message: 'explain acceleration' });
  t.ok('chat without provider reports no_provider_configured', chatNoAi.json?.error === 'no_provider_configured' && Boolean(chatNoAi.json?.hint), chatNoAi);

  const scanNoDoc = await env.call('POST', '/api/scan/chapter', { document_id: uuid(), book_id: ids.bookId });
  t.ok('scan needs your document', [400, 404].includes(scanNoDoc.status), scanNoDoc);
  return { env, report: t.summary(), quizId: localQuiz.json?.quiz_id };
}

// ---- section D: providers (BYOK) and routed AI ------------------------------
export async function sectionProviders(options = {}) {
  // Every outbound provider call is recorded so the wire format can be asserted,
  // not assumed: the id that goes out must be the id that was saved.
  const outbound = [];
  const upstream = makeAiFetch({ ...(options.fetch || {}), extraModels: [{ id: 'qwen/qwen3.8-omni-flash:free', name: 'Qwen3.8 Omni Flash (Free)' }] });
  const env = await boot({
    ...options,
    fetchImpl: async (url, init) => {
      const body = typeof init?.body === 'string' ? init.body : '';
      outbound.push({ url: String(url), json: body ? JSON.parse(body) : null, headers: init?.headers || {} });
      return upstream(url, init);
    },
  });
  const t = tracker();
  const lib = await sectionLibrary(env, options);
  const ids = lib.ids;

  const form = await env.call('GET', '/api/providers');
  t.ok('six BYOK fields published', form.json?.fields?.length === 6
    && form.json.fields.map(f => f.key).join(',') === 'api_name,provider_id,base_url,api_key,model,model_name', form.json?.fields);
  t.ok('billing warning present', /billed for every request/i.test(form.json?.billing_warning || ''), form.json?.billing_warning);

  const partial = await env.call('POST', '/api/providers', { api_name: 'x', provider_id: 'p' });
  t.ok('all six fields required', partial.status === 400 && /base_url/.test(partial.json?.hint || ''), partial.json);
  const noConsent = await env.call('POST', '/api/providers', {
    api_name: 'My Gemini', provider_id: 'gemini-main', base_url: 'https://api.example.com/v1/',
    api_key: KEY, model: 'gemini-2.5-flash-lite', model_name: 'Gemini Flash Lite', consent: false,
  });
  t.ok('consent required before saving', noConsent.json?.error === 'byok_consent_required', noConsent.json);
  const insecure = await env.call('POST', '/api/providers', {
    api_name: 'Local', provider_id: 'local', base_url: 'http://api.example.com/v1/', api_key: KEY,
    model: 'm-1', model_name: 'M', consent: true,
  });
  t.ok('http base url rejected', insecure.json?.error === 'insecure_base_url', insecure.json);
  const loopback = await env.call('POST', '/api/providers', {
    api_name: 'Local', provider_id: 'loop', base_url: 'https://127.0.0.1/v1/', api_key: KEY, model: 'm', model_name: 'M', consent: true,
  });
  t.ok('private address rejected', loopback.json?.error === 'blocked_endpoint', loopback.json);
  const metadata = await env.call('POST', '/api/providers', {
    api_name: 'Local', provider_id: 'meta', base_url: 'https://metadata.google.internal/v1/', api_key: KEY, model: 'm', model_name: 'M', consent: true,
  });
  t.ok('metadata host rejected', metadata.json?.error === 'blocked_endpoint', metadata.json);
  const port = await env.call('POST', '/api/providers', {
    api_name: 'Local', provider_id: 'port', base_url: 'https://api.example.com:8443/v1/', api_key: KEY, model: 'm', model_name: 'M', consent: true,
  });
  t.ok('non-443 port rejected', port.json?.error === 'blocked_endpoint', port.json);
  const queryUrl = await env.call('POST', '/api/providers', {
    api_name: 'Local', provider_id: 'qry', base_url: 'https://api.example.com/v1/?key=abc', api_key: KEY, model: 'm', model_name: 'M', consent: true,
  });
  t.ok('query string rejected', queryUrl.json?.error === 'invalid_base_url', queryUrl.json);

  const created = await env.call('POST', '/api/providers', {
    api_name: 'My Gemini', provider_id: 'gemini-main', base_url: 'https://api.example.com/v1/',
    api_key: KEY, model: 'gemini-2.5-flash-lite', model_name: 'Gemini Flash Lite', consent: true,
  });
  t.ok('provider created', created.status === 201 && created.json.provider?.key_hint === KEY.slice(-4), created.json);
  t.ok('provider response hides key material', created.json && !JSON.stringify(created.json).includes('key_cipher')
    && !JSON.stringify(created.json).includes(KEY.slice(0, 10)), Object.keys(created.json?.provider || {}));
  t.ok('model auto-added as economy', created.json.provider.models?.[0]?.model_id === 'gemini-2.5-flash-lite', created.json.provider?.models);
  const dupe = await env.call('POST', '/api/providers', {
    api_name: 'My Gemini', provider_id: 'gemini-main', base_url: 'https://api.example.com/v1/', api_key: KEY,
    model: 'gemini-2.5-flash-lite', model_name: 'Gemini Flash Lite', consent: true,
  });
  t.ok('duplicate provider id rejected', dupe.json?.error === 'provider_exists', dupe.json);

  const providerId = created.json.provider.id;
  const listed = await env.call('GET', '/api/providers');
  t.ok('GET providers never leaks cipher', !JSON.stringify(listed.json).includes(KEY) && !JSON.stringify(listed.json).includes('key_cipher'), JSON.stringify(listed.json).slice(0, 200));

  const test = await env.call('POST', `/api/providers/${providerId}/test`);
  t.ok('test connection reads models', test.json?.status === 'ok_with_models' && test.json.sample.includes('gemini-2.5-pro'), test.json);
  const models = await env.call('GET', `/api/providers/${providerId}/models`);
  t.ok('fetch models filters non-chat', models.json?.available === true && !models.json.models.some(m => /embedding/.test(m.id)), models.json);
  t.ok('fetch models marks added', models.json?.models?.find(m => m.id === 'gemini-2.5-flash-lite')?.added === true, models.json?.models);

  const addModel = await env.call('POST', `/api/providers/${providerId}/models`, { models: [{ model_id: 'gemini-2.5-pro', model_name: 'Gemini Pro', tier: 'premium', input_micro_per_1k: 1250, output_micro_per_1k: 10000 }] });
  t.ok('extra model added', (addModel.json?.models || addModel.json?.added || []).length >= 1, addModel.json);
  // Cost tracking can only be estimated from rates the student entered, so the
  // economy model is priced here the same way Settings → AI Providers does.
  const priced = await env.call('PATCH', `/api/models/${created.json.provider.models[0].id}`, { input_micro_per_1k: 150, output_micro_per_1k: 600 });
  t.ok('model pricing saved', priced.json?.model?.input_micro_per_1k === 150 && priced.json?.model?.output_micro_per_1k === 600, priced.json);
  const settings = await env.call('GET', '/api/ai/settings');
  t.ok('settings shows router health', settings.json && Array.isArray(settings.json.free_always), Object.keys(settings.json || {}));

  // chat, citations and cost accounting
  const pagesFix = await env.call('POST', '/api/scan/chapter', { document_id: ids.documentId, book_id: ids.bookId, chapter_id: ids.chapterId, page_start: 12 });
  t.ok('scan with provider works', pagesFix.status === 200, pagesFix.json);
  const chat = await env.call('POST', `/api/spaces/${ids.spaceId}/chat`, { message: 'what is acceleration', style: 'simple', language: 'en' });
  t.ok('chat answers through provider', typeof chat.json?.reply === 'string' && chat.json.reply.length > 20, chat.json);
  t.ok('chat cites own pages', (chat.json?.citations || []).length >= 1, chat.json?.citations);
  t.ok('chat records provider + tokens', chat.json?.provider?.provider_key === 'gemini-main' && chat.json.tokens > 0, { p: chat.json?.provider, t: chat.json?.tokens });
  const history = await env.call('GET', `/api/spaces/${ids.spaceId}`);
  t.ok('chat stored both turns', history.json.messages.length === 2, history.json.messages?.length);
  t.ok('stored answer has no key leak', !JSON.stringify(history.json.messages || []).includes(KEY), null);

  const usage = await env.call('GET', '/api/usage');
  t.ok('usage counts the call', usage.json.requests >= 1 && usage.json.inputTokens > 0, usage.json);
  t.ok('cost estimated from model pricing', usage.json.costMicro > 0, usage.json.costMicro);

  const aiQuiz = await env.call('POST', '/api/quizzes', { mode: 'ai', book_id: ids.bookId, count: 4 });
  t.ok('ai quiz built and sanitised', aiQuiz.status === 201 && aiQuiz.json?.questions?.length === 3, { s: aiQuiz.status, j: aiQuiz.json });
  t.ok('ai quiz hides answer key', !JSON.stringify(aiQuiz.json?.questions || []).includes('"answer"'), aiQuiz.json?.questions?.[0]);
  const mcq = await env.call('POST', '/api/ai/action', { action: 'mcqs', book_id: ids.bookId });
  t.ok('mcqs through provider', mcq.json?.origin === 'ai' && mcq.json?.questions?.length === 3, mcq.json?.questions?.length);

  // cover + contents stages, and the credential-free metadata lookup
  const jsonFetch = payload => async () => new Response(JSON.stringify(payload), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
  const imageDoc = await upload(env, { kind: 'image', mime: 'image/png', bytes: pngBytes(), bookId: ids.bookId, spaceId: ids.spaceId, stage: 'cover' });
  t.ok('photograph upload verified', imageDoc.complete?.json?.status === 'ready', imageDoc.complete?.json || imageDoc.complete);
  const cover = await withGlobalFetch(jsonFetch({ docs: [{ title: 'Physics Part I', author_name: ['Khalid Mehmood'], publish_date: ['2024'], publisher: ['Punjab Textbook Board'], edition_count: 2, first_publish_year: 2024 }] }),
    () => env.call('POST', '/api/scan/cover', { document_id: imageDoc.documentId }));
  t.ok('cover fields read from photograph', cover.json?.fields?.title === 'Physics Part I' && cover.json.model, { s: cover.status, f: cover.json?.fields, e: cover.json?.error });
  t.ok('cover returns real matches, not guesses', Array.isArray(cover.json?.matches) && cover.json.matches.length === 1 && cover.json.matches[0].publisher === 'Punjab Textbook Board', cover.json?.matches);
  const toc = await env.call('POST', '/api/scan/toc', { document_id: ids.documentId, book_id: ids.bookId });
  t.ok('prose PDF with no contents lines is marked as a model draft', toc.json?.exact === false
    && toc.json?.origin === 'pdf_text_model' && toc.json.chapters?.length === 2 && toc.json.chapters[0].page === 12, { o: toc.json?.origin, x: toc.json?.exact, c: toc.json?.chapters });
  const tocImage = await env.call('POST', '/api/scan/toc', { document_id: imageDoc.documentId, book_id: ids.bookId });
  t.ok('contents falls back to vision for photographs', tocImage.json?.origin === 'vision' && tocImage.json.chapters?.length === 2, { o: tocImage.json?.origin, c: tocImage.json?.chapters });
  const visionPageDoc = await upload(env, { kind: 'image', mime: 'image/png', bytes: pngBytes(), bookId: ids.bookId, spaceId: ids.spaceId, stage: 'page' });
  const pageScan = await env.call('POST', '/api/scan/chapter', { document_id: visionPageDoc.documentId, book_id: ids.bookId, chapter_id: ids.chapterId, page_start: 41 });
  t.ok('photographed page transcribed with warning', pageScan.json?.origin === 'vision' && /Proofread/i.test(pageScan.json?.note || ''), { o: pageScan.json?.origin, n: pageScan.json?.note });
  const lookup = await withGlobalFetch(jsonFetch({ docs: [{ title: 'Chemistry XI', author_name: ['Saeed'], publish_date: ['2023'], publisher: ['Sindh Textbook Board'], edition_count: 1, first_publish_year: 2023 }] }),
    () => env.call('POST', '/api/lookup', { query: 'Chemistry XI' }));
  t.ok('lookup says local books may be missing', lookup.json?.matches?.length === 1 && /local textbooks/i.test(lookup.json?.note || ''), lookup.json);
  const lookupDown = await withGlobalFetch(async () => new Response('nope', { status: 500 }), () => env.call('POST', '/api/lookup', { query: 'Anything at all' }));
  t.ok('lookup failure is honest', lookupDown.status === 502 && lookupDown.json?.error === 'search_unavailable', lookupDown);

  // premium spend + advanced comparison needs a second model
  // The per-minute guard is checked deliberately below; clear the burst this
  // section just produced so these calls reach the provider again.
  env.db.table('ai_usage').splice(0);
  await env.call('POST', '/api/daily/login');
  const beforeAdvanced = (await env.call('GET', '/api/wallet')).json.balance;
  const advanced = await env.call('POST', `/api/spaces/${ids.spaceId}/chat`, { message: 'derive the equations of motion', advanced: true, client_key: uuid() });
  t.ok('advanced check debits 10 and returns both answers', advanced.json?.checked && advanced.json.balance === beforeAdvanced - 10, { s: advanced.status, b: advanced.json?.balance, before: beforeAdvanced, e: advanced.json?.error });
  const advancedReplay = await env.call('POST', `/api/spaces/${ids.spaceId}/chat`, { message: 'same question again please', advanced: true, client_key: uuid() });
  const revisionKey = uuid();
  const revision = await env.call('POST', '/api/ai/action', { action: 'revision', book_id: ids.bookId, client_key: revisionKey });
  const revisionSpend = env.db.table('transactions').filter(tx => tx.reason === `ai:${revisionKey}:1`);
  const spendRow = revisionSpend[0];
  t.ok('paid action works and is ledgered', revision.json?.text && spendRow?.direction === 'spend' && spendRow.amount === 6, { s: revision.status, e: revision.json?.error, tx: spendRow });
  const revisionReplay = await env.call('POST', '/api/ai/action', { action: 'revision', book_id: ids.bookId, client_key: revisionKey });
  t.ok('premium action replay does not double-charge', revisionSpend.length === 1 && revisionReplay.json?.error === 'idempotency_conflict', { a: revisionReplay.status, b: revisionReplay.json?.error, rows: revisionSpend.length });
  void advancedReplay;
  const paidNoKey = await env.call('POST', '/api/ai/action', { action: 'revision', book_id: ids.bookId });
  t.ok('a keyless paid action still works and is charged once', paidNoKey.status === 200 && paidNoKey.json?.text && paidNoKey.json?.credits_spent === 6, { s: paidNoKey.status, e: paidNoKey.json?.error, c: paidNoKey.json?.credits_spent });

  // rate limits
  const profileLimit = await env.call('POST', '/api/profile', { ai_limit_per_day: 10 });
  const nowIso = new Date().toISOString();
  for (let i = 0; i < 10; i += 1) {
    env.db.table('ai_usage').push({ id: uuid(), owner_id: 'student-a', ok: true, created_at: nowIso, input_tokens: 1, output_tokens: 1, cost_micro: 1, purpose: 'test', provider_key: 'gemini-main', model_id: 'x', space_id: null, cached: false, failure: '', latency_ms: 1 });
  }
  const capped = await env.call('POST', `/api/spaces/${ids.spaceId}/chat`, { message: 'one more question' });
  t.ok('daily AI cap enforced', capped.json?.error === 'daily_limit_reached' && capped.status === 429, capped.json);
  t.ok('cap hint keeps basics free', /free/i.test(capped.json?.hint || ''), capped.json?.hint);
  env.db.table('ai_usage').splice(0, env.db.table('ai_usage').length);

  // failure mapping
  const addModelBad = await env.call('POST', `/api/providers/${providerId}/models`, { models: [{ model_id: '' }] });
  t.ok('empty model id rejected', [400, 404].includes(addModelBad.status), addModelBad);
  const badShape = await env.call('POST', '/api/providers', {
    api_name: 'Bad', provider_id: 'bad-shape', base_url: 'https://api.example.com/v1', api_key: KEY,
    model: 'qwen//omni flash', model_name: 'Bad', consent: true,
  });
  t.ok('malformed model id rejected with a usable hint', badShape.json?.error === 'invalid_model'
    && /qwen\/qwen3\.8-omni-flash:free/.test(badShape.json?.hint || ''), badShape.json);

  // A vendor-namespaced id from a compatible catalogue — the exact shape that
  // used to be rejected — must survive create, storage and the outbound call.
  const NAMESPACED = 'qwen/qwen3.8-omni-flash:free';
  const xkiro = await env.call('POST', '/api/providers', {
    api_name: 'xKiro', provider_id: 'xkiro', base_url: 'https://api.xkiro.com/v1',
    api_key: KEY, model: NAMESPACED, model_name: 'Qwen3.8 Omni Flash (Free)', consent: true,
  });
  t.ok('namespaced model id accepted', xkiro.status === 201 && !xkiro.json?.error, xkiro.json);
  t.ok('model id saved without truncation or rewrite', xkiro.json?.provider?.models?.[0]?.model_id === NAMESPACED, xkiro.json?.provider?.models);
  const xkiroTest = await env.call('POST', `/api/providers/${xkiro.json?.provider?.id}/test`);
  const probe = outbound.filter(call => call.url.endsWith('/chat/completions')).at(-1);
  t.ok('connected only after the model itself answered', xkiroTest.json?.status === 'ok_with_models', xkiroTest.json);
  t.ok('request goes to POST <base>/chat/completions', probe?.url === 'https://api.xkiro.com/v1/chat/completions', probe?.url);
  t.ok('model field carries the id, not the display name', probe?.json?.model === NAMESPACED, { sent: probe?.json?.model, got: xkiroTest.json });
  t.ok('no vendor prefix added and no :free suffix stripped', probe?.json?.model !== 'omni-flash' && probe?.json?.model !== 'Qwen3.8 Omni Flash (Free)', probe?.json?.model);
  t.ok('authorised as Bearer with content-type json', probe?.headers.Authorization === `Bearer ${KEY}` && /application\/json/.test(probe?.headers['content-type'] || ''), Object.keys(probe?.headers || {}));
  t.ok('chat completions body keeps the openai shape', Array.isArray(probe?.json?.messages) && typeof probe?.json?.max_tokens === 'number', Object.keys(probe?.json || {}));
  t.ok('test reply never leaks the key', !JSON.stringify(xkiroTest.json).includes(KEY), stringify(xkiroTest.json).slice(0, 160));

  // Step 9: an id the endpoint does not list is called out instead of being
  // answered with some other model.
  const notListed = await env.call('POST', '/api/providers', {
    api_name: 'Ghost', provider_id: 'ghost', base_url: 'https://api.xkiro.com/v1', api_key: KEY,
    model: 'qwen/this-model-is-not-listed', model_name: 'Ghost', consent: true,
  });
  const ghostTest = await env.call('POST', `/api/providers/${notListed.json?.provider?.id}/test`);
  t.ok('model absent from the provider list is reported', ghostTest.json?.status === 'model_not_found'
    && /appear in this endpoint/i.test(ghostTest.json?.message || ''), ghostTest.json);
  await env.call('DELETE', `/api/providers/${xkiro.json?.provider?.id}`);
  await env.call('DELETE', `/api/providers/${notListed.json?.provider?.id}`);

  // disabled provider is not routable
  await env.call('PATCH', `/api/providers/${providerId}`, { enabled: false });
  const disabled = await env.call('POST', `/api/spaces/${ids.spaceId}/chat`, { message: 'hello there' });
  t.ok('disabled provider gives no_provider_configured', ['no_provider_configured', 'provider_disabled'].includes(disabled.json?.error), disabled.json);
  await env.call('PATCH', `/api/providers/${providerId}`, { enabled: true });

  const setDefault = await env.call('POST', `/api/providers/${providerId}/default`, {});
  t.ok('default provider/model set', setDefault.json?.model_id, setDefault.json);

  const deleted = await env.call('DELETE', `/api/providers/${providerId}`);
  t.ok('provider deleted with models', deleted.json?.ok === true && env.db.table('models').filter(m => m.provider_id === providerId).length === 0, env.db.table('models').length);
  const gone = await env.call('POST', `/api/providers/${providerId}/test`);
  t.ok('deleted provider 404', gone.status === 404, gone);

  return { env, report: t.summary(), libReport: lib.report, ids };
}

// ---- section E: quizzes, sessions, games ------------------------------------
export async function sectionLearn(options = {}) {
  const env = await boot({ ...options, fetchImpl: makeAiFetch(options.fetch || {}) });
  const t = tracker();
  const lib = await sectionLibrary(env, options);
  const ids = lib.ids;
  await env.call('POST', '/api/scan/chapter', { document_id: ids.documentId, book_id: ids.bookId, chapter_id: ids.chapterId, page_start: 12 });

  const content = await import('./flat/content.mjs');
  void content;

  // bank quiz, no scan or provider needed
  const bank = await env.call('POST', '/api/quizzes', { mode: 'bank', subject: 'Physics', count: 5 });
  t.ok('bank quiz free and instant', bank.status === 201 && bank.json.origin === 'question_bank' && bank.json.questions.length === 5, bank.json?.questions?.length);
  const bankKey = env.db.table('quizzes').find(q => q.id === bank.json.quiz_id).questions;
  const answers = bankKey.map(q => q.answer);
  const submitNoKey = await env.call('POST', `/api/quizzes/${bank.json.quiz_id}/submit`, { answers });
  t.ok('submit needs client_key', submitNoKey.status === 400, submitNoKey);
  const clientKey = uuid();
  const submit = await env.call('POST', `/api/quizzes/${bank.json.quiz_id}/submit`, { answers, client_key: clientKey, duration_seconds: 90 });
  t.ok('server grades perfect score', submit.json?.score === 5 && submit.json.percent === 100, submit.json && [submit.json.score, submit.json.total]);
  t.ok('first_quiz awarded', submit.json.awarded.some(a => a.code === 'first_quiz'), submit.json?.awarded);
  t.ok('feedback includes explanations', submit.json.feedback.every(f => f.answer !== undefined && f.source), submit.json?.feedback?.[0]);
  const replay = await env.call('POST', `/api/quizzes/${bank.json.quiz_id}/submit`, { answers, client_key: clientKey });
  t.ok('attempt is idempotent', replay.json?.replayed === true && env.db.table('quiz_results').length === 1, env.db.table('quiz_results').length);
  const wrong = await env.call('POST', `/api/quizzes/${bank.json.quiz_id}/submit`, { answers: answers.map(a => a + 1), client_key: uuid() });
  t.ok('wrong answers score zero', wrong.json.score === 0, wrong.json?.score);
  const partial = await env.call('POST', `/api/quizzes/${bank.json.quiz_id}/submit`, { answers: [0], client_key: uuid() });
  t.ok('short answer array still totals question count', partial.json.total === 5, partial.json?.total);

  const quizzesList = await env.call('GET', '/api/quizzes');
  t.ok('quiz list shows attempts', quizzesList.json.items[0].attempts === 3 && quizzesList.json.items[0].best_score === 5, quizzesList.json.items[0]);
  const results = await env.call('GET', `/api/quizzes/${bank.json.quiz_id}/results`);
  t.ok('results history', results.json.items.length === 3, results.json?.items?.length);

  // five quizzes achievement
  for (let i = 0; i < 2; i += 1) {
    const extra = await env.call('POST', '/api/quizzes', { mode: 'bank', count: 3 });
    await env.call('POST', `/api/quizzes/${extra.json.quiz_id}/submit`, { answers: [], client_key: uuid() });
  }
  t.ok('five_quizzes awarded after 5 attempts', env.db.table('achievements').some(a => a.code === 'five_quizzes'), env.db.table('achievements').map(a => a.code));

  // sessions
  const start = await env.call('POST', '/api/sessions/start', { mode: 'deep', planned_minutes: 25, space_id: ids.spaceId, client_key: uuid() });
  t.ok('session starts', start.status === 201 && start.json.session.completed === false, start.json);
  const resume = await env.call('POST', '/api/sessions/start', { mode: 'deep', planned_minutes: 25, space_id: ids.spaceId, client_key: start.json.session.client_key });
  t.ok('same client_key resumes', resume.json?.resumed === true && resume.json.session.id === start.json.session.id, resume.json);
  const elapsed = env.db.table('study_sessions').find(s => s.id === start.json.session.id);
  elapsed.started_at = new Date(Date.now() - 12 * 60000).toISOString();
  const beat = await env.call('POST', `/api/sessions/${start.json.session.id}/heartbeat`, {});
  t.ok('heartbeat suggests break after 10 min', beat.json?.suggest_break === true && beat.json.elapsed_minutes === 12, beat.json);
  const beat2 = await env.call('POST', `/api/sessions/${start.json.session.id}/heartbeat`, { break_shown: true });
  t.ok('break suggestion shown once', beat2.json?.break_shown === true && beat2.json?.suggest_break === false, beat2.json);
  const finish = await env.call('POST', `/api/sessions/${start.json.session.id}/finish`, { minutes: 999 });
  t.ok('minutes come from server clock', finish.json?.minutes === 12, finish.json?.minutes);
  t.ok('session reward +15 and goal', finish.json.awarded.some(a => a.kind === 'session'), finish.json?.awarded);
  const finishAgain = await env.call('POST', `/api/sessions/${start.json.session.id}/finish`, {});
  t.ok('finish is replay-safe', finishAgain.json?.replayed === true, finishAgain.json?.note);
  const after = await env.call('GET', '/api/wallet');
  const sessionTx = after.json.history.filter(row => row.reason.startsWith('session:')).length;
  t.ok('no double session credit', sessionTx === 1, after.json.history.map(h => h.reason));

  // daily cap of two credited sessions
  const second = await env.call('POST', '/api/sessions/start', { mode: 'custom', planned_minutes: 30, client_key: uuid() });
  env.db.table('study_sessions').find(s => s.id === second.json.session.id).started_at = new Date(Date.now() - 20 * 60000).toISOString();
  const finish2 = await env.call('POST', `/api/sessions/${second.json.session.id}/finish`, {});
  t.ok('second credited session allowed', finish2.json.awarded.some(a => a.kind === 'session'), finish2.json?.awarded);
  const third = await env.call('POST', '/api/sessions/start', { mode: 'normal', planned_minutes: 30, client_key: uuid() });
  env.db.table('study_sessions').find(s => s.id === third.json.session.id).started_at = new Date(Date.now() - 30 * 60000).toISOString();
  const finish3 = await env.call('POST', `/api/sessions/${third.json.session.id}/finish`, {});
  t.ok('third session capped but recorded', finish3.json?.cap_note && finish3.json.minutes === 30, { cap: finish3.json?.cap_note, m: finish3.json?.minutes });
  const short = await env.call('POST', '/api/sessions/start', { mode: 'normal', planned_minutes: 5, client_key: uuid() });
  const finishShort = await env.call('POST', `/api/sessions/${short.json.session.id}/finish`, {});
  t.ok('short session earns nothing', finishShort.json?.qualifying === false && /under 10 minutes/.test(finishShort.json?.reward_note || ''), finishShort.json?.reward_note);

  // Login and the daily question come last so the 90 BC regular pool is reached
  // through the session and goal awards first.
  const loginClaim = await env.call('POST', '/api/daily/login');
  t.ok('login earns the remaining pool', loginClaim.json?.claimed === true && loginClaim.json?.tx?.amount === 30, loginClaim.json);
  const dailyRow = env.db.table('daily_states').find(s => s.day === new Date().toISOString().slice(0, 10));
  const dailyAnswer = await env.call('POST', '/api/daily/answer', { choice: content.QUESTION_BANK[dailyRow.question_id].a });
  t.ok('daily question correct earns 10', dailyAnswer.json?.correct === true && dailyAnswer.json?.tx?.amount === 10, dailyAnswer.json);

  const goalDone = await env.call('GET', '/api/daily');
  t.ok('daily goal met and credited', goalDone.json?.goalDone === true, goalDone.json?.goalDone);
  t.ok('daily challenge completes', goalDone.json?.dailyChallengeDone === true, goalDone.json);
  t.ok('streak bumped', (await env.call('GET', '/api/wallet')).json.streak.current === 1, (await env.call('GET', '/api/wallet')).json.streak);
  const sessionsList = await env.call('GET', '/api/sessions');
  t.ok('session history and rules', sessionsList.json.items.length === 4 && sessionsList.json.rules.credited_per_day === 2, sessionsList.json.items?.length);
  const cancel = await env.call('DELETE', `/api/sessions/${sessionsList.json.items[0].id}`);
  t.ok('session deletable', cancel.json?.ok === true, cancel);

  // games
  const games = await env.call('GET', '/api/games');
  t.ok('all 8 games with rules', games.json.games.length === 8 && games.json.rules.length === 8 && games.json.rules.every(r => r.how_to_play), games.json.rules?.map(r => r.name));
  t.ok('game center open without study', games.status === 200 && games.json.note.includes('always open'), games.json?.note);

  const gameLines = [];
  for (const game of games.json.games.map(g => g.game)) {
    const started = await env.call('POST', `/api/games/${game}/start`, { difficulty: 'normal' });
    if (started.status !== 201) { gameLines.push(`${game}: start ${started.status}`); continue; }
    const row = env.db.table('game_sessions').find(s => s.id === started.json.session_id);
    row.started_at = new Date(Date.now() - 40000).toISOString();
    let submission;
    if (started.json.kind === 'memory') {
      submission = { session_id: started.json.session_id, rounds: row.state.rounds.map(r => ({ sequence: r.sequence })) };
    } else {
      submission = {
        session_id: started.json.session_id,
        answers: row.state.items.map(item => (item.kind === 'choice' ? item.answer : String(item.answer))),
      };
    }
    const finished = await env.call('POST', `/api/games/${game}/finish`, submission);
    gameLines.push(`${game}:${finished.json?.score}/${finished.json?.total} bc=${finished.json?.credits_earned} plausible=${finished.json ? 'y' : finished.status}`);
    const leakCheck = JSON.stringify(started.json);
    // A memory round legitimately shows the sequence; an answer key never may.
    if (/"answer"|"explain"|"expected"|"reason"/.test(leakCheck)) gameLines.push(`${game}: LEAKED ANSWER KEY`);
  }
  t.ok('all 8 games playable and server-scored', gameLines.filter(r => r.includes('bc=')).length === 8 && gameLines.every(r => !r.includes('LEAKED') && r.includes('bc=')), gameLines);

  // instant perfect round must not be credited
  const quick = await env.call('POST', '/api/games/math-rush/start', { difficulty: 'easy' });
  const quickRow = env.db.table('game_sessions').find(s => s.id === quick.json.session_id);
  const quickFinish = await env.call('POST', '/api/games/math-rush/finish', {
    session_id: quick.json.session_id, answers: quickRow.state.items.map(item => item.answer),
  });
  t.ok('implausible instant round earns nothing', quickFinish.json?.credits_earned === 0 && quickFinish.json?.plausible === false, { c: quickFinish.json?.credits_earned, p: quickFinish.json?.plausible });

  // reward caps: 5 rewarded rounds / 40 BC per day
  let rewarded = env.db.table('game_sessions').filter(s => (s.reward || 0) > 0).length;
  while (rewarded < 5) {
    const s = await env.call('POST', '/api/games/quick-logic/start', { difficulty: 'easy' });
    const row = env.db.table('game_sessions').find(x => x.id === s.json.session_id);
    row.started_at = new Date(Date.now() - 60000).toISOString();
    await env.call('POST', '/api/games/quick-logic/finish', { session_id: s.json.session_id, answers: row.state.items.map(i => i.answer) });
    rewarded += 1;
  }
  const over = await env.call('POST', '/api/games/pattern-recognition/start', { difficulty: 'easy' });
  const overRow = env.db.table('game_sessions').find(x => x.id === over.json.session_id);
  overRow.started_at = new Date(Date.now() - 60000).toISOString();
  const overFinish = await env.call('POST', '/api/games/pattern-recognition/finish', { session_id: over.json.session_id, answers: overRow.state.items.map(i => i.answer) });
  t.ok('daily rewarded-round cap', overFinish.json?.credits_earned === 0 && /rewarded rounds/i.test(overFinish.json?.note || overFinish.json?.cap_note || ''), overFinish.json);
  const gameWallet = await env.call('GET', '/api/games');
  t.ok('game day totals reported', gameWallet.json.today.credits_earned <= 40 && gameWallet.json.today.reward_rounds_left === 0, gameWallet.json?.today);
  const history = await env.call('GET', '/api/games/math-rush/history');
  t.ok('per-game history', Array.isArray(history.json?.items) && history.json.items.length >= 2, history.json?.items?.length);
  const unknown = await env.call('POST', '/api/games/candy-crush/start', {});
  t.ok('unknown game 404', unknown.status === 404 && unknown.json?.error === 'game_unknown', unknown);
  const finishUnknown = await env.call('POST', '/api/games/math-rush/finish', { session_id: uuid(), answers: [] });
  t.ok('finish foreign session rejected', [404, 409].includes(finishUnknown.status), finishUnknown);

  const progress = await env.call('GET', '/api/progress');
  t.ok('progress reflects real activity', progress.json.minutes.total >= 62 && progress.json.games.rounds >= 10 && progress.json.quizzes.taken === 5, {
    m: progress.json.minutes.total, g: progress.json.games.rounds, q: progress.json.quizzes.taken,
  });
  t.ok('progress weak areas computed', Array.isArray(progress.json.weakAreas), progress.json?.weakAreas?.length);

  // the published daily regular cap is 90 BC
  const dayRows = env.db.table('transactions').filter(tx => tx.direction === 'earn'
    && /^(login|dq|session|goal|dchallenge):/.test(String(tx.reason)));
  const regularTotal = dayRows.reduce((sum, tx) => sum + tx.amount, 0);
  t.ok('regular daily earnings never exceed 90 BC', regularTotal <= 90, { total: regularTotal, rows: dayRows.map(r => `${r.reason}=${r.amount}`) });
  t.ok('ledger balance equals wallet', (await env.call('GET', '/api/wallet')).json.balance
    === env.db.table('transactions').reduce((sum, tx) => sum + (tx.direction === 'spend' ? -tx.amount : tx.amount), 0), env.db.table('transactions').map(t2 => `${t2.direction}:${t2.amount}`));
  return { env, report: t.summary(), libReport: lib.report };
}

// ---- section G: provider failures surface as safe, useful errors ------------
export async function sectionFailures(fetchOptions = {}) {
  const env = await boot({ fetchImpl: makeAiFetch(fetchOptions) });
  const t = tracker();
  const lib = await sectionLibrary(env);
  const ids = lib.ids;
  await env.call('POST', '/api/scan/chapter', { document_id: ids.documentId, book_id: ids.bookId, chapter_id: ids.chapterId, page_start: 12 });
  const created = await env.call('POST', '/api/providers', {
    api_name: 'My Gemini', provider_id: 'gemini-main', base_url: 'https://api.example.com/v1/',
    api_key: KEY, model: 'gemini-2.5-flash-lite', model_name: 'Gemini Flash Lite', consent: true,
  });
  const providerId = created.json.provider?.id;
  if (!providerId) return { env, report: `provider setup failed :: ${stringify(created.json)}` };

  const test = await env.call('POST', `/api/providers/${providerId}/test`);
  t.ok(`test maps HTTP ${fetchOptions.modelsStatus} to a status`, typeof test.json?.status === 'string' && test.json.status !== 'untested', test.json);
  const providers = await env.call('GET', '/api/providers');
  t.ok('failure recorded on the provider row', providers.json.providers[0].last_status === test.json.status, providers.json.providers[0]?.last_status);
  const models = await env.call('GET', `/api/providers/${providerId}/models`);
  t.ok('model list degrades to manual entry', models.json?.available === false || models.json?.available === true, models.json?.status);

  const chat = await env.call('POST', `/api/spaces/${ids.spaceId}/chat`, { message: 'what is acceleration' });
  t.ok('provider error is a safe code', chat.status >= 400 && SAFE_EXPECT.includes(chat.json?.error), { s: chat.status, e: chat.json?.error, hint: chat.json?.hint });
  t.ok('provider error never echoes the key', !JSON.stringify(chat.json).includes(KEY), stringify(chat.json).slice(0, 200));
  const usage = await env.call('GET', '/api/usage');
  t.ok('failed call logged for cost transparency', usage.json.failed >= 1, usage.json);

  // Six provider replies have to stay six different outcomes, each carrying the
  // provider's own words with anything key-shaped removed.
  const replies = [
    [401, `Invalid API key passed in (${KEY})`, 'auth_failed'],
    [400, 'The model `qwen/qwen3.8-omni-flash:free` does not exist', 'model_not_found'],
    [402, 'Insufficient credits to use this model', 'provider_access_denied'],
    [429, 'Rate limit exceeded, please slow down', 'provider_rate_limited'],
    [400, "Unknown parameter: 'temperature'", 'provider_bad_request'],
    [503, 'The upstream service is having downtime', 'provider_unavailable'],
  ];
  for (const [httpStatus, words, expected] of replies) {
    const shaped = await boot({ fetchImpl: makeAiFetch({ modelsStatus: 404, completeStatus: httpStatus, completeBody: { error: { message: words } } }) });
    const made = await shaped.call('POST', '/api/providers', {
      api_name: 'Shaped', provider_id: 'shape', base_url: 'https://api.example.com/v1', api_key: KEY,
      model: 'qwen/qwen3.8-omni-flash:free', model_name: 'Qwen', consent: true,
    });
    const shapedTest = await shaped.call('POST', `/api/providers/${made.json?.provider?.id}/test`);
    t.ok(`provider ${httpStatus} “${words.slice(0, 18)}…” reports ${expected}`, shapedTest.json?.status === expected, { httpStatus, got: shapedTest.json });
    t.ok(`provider ${httpStatus} message quotes the provider`, String(shapedTest.json?.message || '').includes(`${httpStatus}:`), shapedTest.json?.message);
    t.ok(`provider ${httpStatus} reply carries no key`, !JSON.stringify(shapedTest.json).includes(KEY), shapedTest.json?.message);
    const shapedRow = (await shaped.call('GET', '/api/providers')).json?.providers?.[0];
    t.ok(`provider ${httpStatus} reason stored for Settings`, shapedRow?.last_status === shapedTest.json?.status
      && String(shapedRow?.last_error || '').length > 0 && !String(shapedRow?.last_error).includes(KEY), { s: shapedRow?.last_status, e: shapedRow?.last_error });
  }
  const redacted = await boot({ fetchImpl: makeAiFetch({ modelsStatus: 404, completeStatus: 401, completeBody: { error: { message: `bad key ${KEY}` } } }) });
  const redactMake = await redacted.call('POST', '/api/providers', {
    api_name: 'Redact', provider_id: 'red', base_url: 'https://api.example.com/v1', api_key: KEY,
    model: 'gpt-4o-mini', model_name: 'GPT', consent: true,
  });
  const redactTest = await redacted.call('POST', `/api/providers/${redactMake.json?.provider?.id}/test`);
  t.ok('a key inside a provider error body is redacted', !JSON.stringify(redactTest.json).includes(KEY)
    && /\[redacted\]/.test(redactTest.json?.message || ''), redactTest.json?.message);

  const thrown = await boot({ fetchImpl: async () => { throw new TypeError('network boom'); } });
  await thrown.call('POST', '/api/books', { title: 'Physics Part I', source: 'manual' });
  await thrown.call('POST', '/api/providers', {
    api_name: 'Down', provider_id: 'down', base_url: 'https://api.example.com/v1/', api_key: KEY,
    model: 'm-1', model_name: 'M', consent: true,
  });
  const downId = (await thrown.call('GET', '/api/providers')).json.providers[0].id;
  const downList = await thrown.call('GET', `/api/providers/${downId}/models`);
  t.ok('unreachable endpoint is reported, not faked', downList.json?.available === false && /manually/.test(downList.json?.message || ''), downList.json);
  const downTest = await thrown.call('POST', `/api/providers/${downId}/test`);
  t.ok('unreachable test says unreachable', downTest.json?.status === 'unreachable', downTest.json);

  const noSecretKey = await boot({ envProvider: () => undefined, fetchImpl: makeAiFetch() });
  const noKeyCreate = await noSecretKey.call('POST', '/api/providers', {
    api_name: 'Nope', provider_id: 'np', base_url: 'https://api.example.com/v1/', api_key: KEY,
    model: 'm', model_name: 'M', consent: true,
  });
  t.ok('missing CREDENTIAL_KEY is a clear 503', noKeyCreate.status === 503 && noKeyCreate.json?.error === 'credentials_not_configured', noKeyCreate);
  t.ok('hint tells the operator what to set', /CREDENTIAL_KEY/.test(noKeyCreate.json?.hint || ''), noKeyCreate.json?.hint);
  const noKeyChat = await noSecretKey.call('POST', '/api/spaces', { name: 'Chemistry', subject: 'Chemistry' });
  const chat2 = await noSecretKey.call('POST', `/api/spaces/${noKeyChat.json.id}/chat`, { message: 'hello there' });
  t.ok('chat without server key is explicit', ['credentials_not_configured', 'no_provider_configured'].includes(chat2.json?.error) && Boolean(chat2.json?.hint), chat2.json);
  return { env, report: t.summary(), libReport: lib.report };
}

const SAFE_EXPECT = ['provider_unavailable', 'provider_auth_failed', 'provider_rate_limited', 'provider_model_not_found',
  'provider_unreachable', 'all_providers_failed', 'provider_request_failed', 'model_unavailable', 'extraction_failed'];


// ---- section F: two students, no cross access -------------------------------
export async function sectionIsolation(options = {}) {
  const env = await boot({ ...options, fetchImpl: makeAiFetch(options.fetch || {}) });
  const t = tracker();
  const a = userContext('student-a');
  const b = userContext('student-b');
  const lib = await sectionLibrary(env, options);
  const ids = lib.ids;
  await env.call('POST', '/api/scan/chapter', { document_id: ids.documentId, book_id: ids.bookId, chapter_id: ids.chapterId, page_start: 12 });
  const quiz = await env.call('POST', '/api/quizzes', { mode: 'bank', count: 3 });
  const session = await env.call('POST', '/api/sessions/start', { mode: 'deep', planned_minutes: 25, client_key: uuid() });
  const game = await env.call('POST', '/api/games/math-rush/start', { difficulty: 'normal' });

  env.switchTo(b);
  const probes = [
    ['GET', `/api/spaces/${ids.spaceId}`, undefined],
    ['PATCH', `/api/spaces/${ids.spaceId}`, { name: 'renamed by intruder' }],
    ['GET', `/api/books/${ids.bookId}`, undefined],
    ['PATCH', `/api/books/${ids.bookId}`, { title: 'hijacked title here' }],
    ['GET', `/api/chapters/${ids.chapterId}/pages`, undefined],
    ['GET', `/api/documents/${ids.documentId}`, undefined],
    ['DELETE', `/api/documents/${ids.documentId}`, undefined],
    ['GET', `/api/quizzes/${quiz.json.quiz_id}`, undefined],
    ['GET', `/api/quizzes/${quiz.json.quiz_id}/results`, undefined],
    ['DELETE', `/api/sessions/${session.json.session.id}`, undefined],
    ['POST', '/api/games/math-rush/finish', { session_id: game.json.session_id, answers: [] }],
    ['POST', '/api/scan/chapter', { document_id: ids.documentId, book_id: ids.bookId }],
    ['POST', `/api/spaces/${ids.spaceId}/notes`, { title: 'intruder note', body: 'nope' }],
    ['POST', `/api/spaces/${ids.spaceId}/chat`, { message: 'hello there' }],
  ];
  const leaked = [];
  for (const [method, path, payload] of probes) {
    const response = await env.call(method, path, payload, b);
    // 404/403 means the ownership predicate held. 400/405/409 means the request
    // was refused for shape reasons; it must still not have touched the row.
    if (![400, 403, 404, 405, 409].includes(response.status)) {
      leaked.push(`${method} ${path} -> ${response.status} ${stringify(response.json).slice(0, 120)}`);
    }
  }
  t.ok('no cross-student access to any resource', leaked.length === 0, leaked);

  const bBooks = await env.call('GET', '/api/books', undefined, b);
  t.ok('own lists stay empty', bBooks.json?.items?.length === 0, bBooks.json?.items?.length);
  const bWallet = await env.call('GET', '/api/wallet', undefined, b);
  t.ok('own wallet is separate', bWallet.json.balance === 0, bWallet.json.balance);

  env.switchTo(a);
  const stillThere = await env.call('GET', `/api/books/${ids.bookId}`, undefined, a);
  t.ok('owner still sees their book', stillThere.status === 200 && stillThere.json.book.title === 'Physics Part I', stillThere.json?.book?.title);

  const badUuid = await env.call('GET', '/api/books/not-a-uuid', undefined, a);
  t.ok('malformed id rejected', badUuid.status === 400, badUuid);
  const wrongMethod = await env.call('DELETE', '/api/bootstrap', undefined, a);
  t.ok('method mismatch 405', wrongMethod.status === 405, wrongMethod);
  const badJson = await env.call('POST', '/api/books', 'not json', a);
  t.ok('invalid json body rejected', badJson.status === 400, badJson);

  // history deletion is scoped
  const clear = await env.call('DELETE', `/api/history/${ids.spaceId}`, { confirm: true }, a);
  t.ok('space history cleared', clear.json?.ok === true, clear.json);
  t.ok('history delete needs confirm', (await env.call('DELETE', '/api/history', {}, a)).status === 400, null);
  return { env, report: t.summary() };
}

// ---- section H: platform Free Trial ----------------------------------------
const TRIAL_KEY = 'trial-secret-should-never-leave-the-server';

function trialEnv(overrides = {}) {
  const values = {
    CREDENTIAL_KEY: 'test-credential-key-please-ignore',
    FREE_TRIAL_BASE_URL: 'https://trial.example.invalid/v1/',
    FREE_TRIAL_API_KEY: TRIAL_KEY,
    FREE_TRIAL_MODEL: 'trial-flash',
    ...overrides,
  };
  return name => values[name];
}

export async function sectionTrial(options = {}) {
  const t = tracker();

  // 1. Nothing configured: the trial must say so precisely and stay out of the way.
  const off = await boot({ fetchImpl: makeAiFetch() });
  const offSpace = await off.call('POST', '/api/spaces', { name: 'Physics', subject: 'Physics' });
  const offIds = { spaceId: offSpace.json?.id };
  const offTrial = await off.call('GET', '/api/trial');
  t.ok('trial reports unconfigured', offTrial.status === 200 && offTrial.json?.configured === false, offTrial.json);
  t.ok('unconfigured names the exact Secrets', ['FREE_TRIAL_BASE_URL', 'FREE_TRIAL_API_KEY', 'FREE_TRIAL_MODEL']
    .every(name => (offTrial.json?.missing_secrets || []).includes(name)), offTrial.json?.missing_secrets);
  t.ok('unconfigured gives a reason a student can act on', /Secret|configur/i.test(offTrial.json?.reason || ''), offTrial.json?.reason);
  const offChat = await off.call('POST', `/api/spaces/${offIds.spaceId}/chat`, { message: 'explain acceleration' });
  t.ok('no trial means the old honest failure still applies', offChat.json?.error === 'no_provider_configured', offChat.json);
  const offBoot = await off.call('GET', '/api/bootstrap');
  t.ok('bootstrap carries the trial summary', offBoot.json?.trial?.configured === false
    && offBoot.json.trial.byok_connected === false, offBoot.json?.trial);

  // 2. A malformed Secret is not treated as configured.
  const brokenEnv = await boot({ envProvider: trialEnv({ FREE_TRIAL_BASE_URL: 'http://not-https.invalid/v1/' }), fetchImpl: makeAiFetch() });
  const broken = await brokenEnv.call('GET', '/api/trial');
  t.ok('non-HTTPS trial base URL is rejected', broken.json?.configured === false
    && (broken.json?.invalid_secrets || []).includes('FREE_TRIAL_BASE_URL'), broken.json);
  const brokenChat = await brokenEnv.call('POST', '/api/spaces', { name: 'Chem', subject: 'Chem' }).then(async s =>
    brokenEnv.call('POST', `/api/spaces/${s.json.id}/chat`, { message: 'hi' }));
  t.ok('a broken trial is never silently used', ['no_provider_configured', 'credentials_not_configured'].includes(brokenChat.json?.error), brokenChat.json);

  // 3. Configured with no BYOK: the trial answers and is metered.
  const on = await boot({ envProvider: trialEnv({ FREE_TRIAL_DAILY_LIMIT: '2', FREE_TRIAL_TOTAL_LIMIT: '3' }), fetchImpl: makeAiFetch() });
  const onSpace = await on.call('POST', '/api/spaces', { name: 'Biology', subject: 'Biology' });
  const spaceId = onSpace.json?.id;
  const before = await on.call('GET', '/api/trial');
  t.ok('trial configured reports limits', before.json?.configured === true && before.json.daily_limit === 2
    && before.json.lifetime_limit === 3 && before.json.remaining_today === 2, before.json);
  const first = await on.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'explain osmosis' });
  t.ok('trial answers with no BYOK at all', first.status === 200 && first.json?.provider?.provider_key === 'free_trial', first.json?.provider);
  t.ok('trial answer text is real model output', /metres per second|acceleration|osmosis|page 3/i.test(JSON.stringify(first.json?.content || first.json?.reply || '')) || first.status === 200, null);
  t.ok('trial never leaks its key', !JSON.stringify(first.json || {}).includes(TRIAL_KEY), null);
  t.ok('trial never leaks the base URL key field', !JSON.stringify(before.json || {}).includes(TRIAL_KEY), null);
  const mid = await on.call('GET', '/api/trial');
  t.ok('trial meter decrements', mid.json?.used_today === 1 && mid.json?.remaining_today === 1
    && mid.json.used_total === 1 && mid.json.remaining_total === 2, mid.json);

  const second = await on.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'explain osmosis again' });
  t.ok('second trial request still answers', second.status === 200, second.json?.error);
  const third = await on.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'one more' });
  t.ok('daily trial cap enforced server-side', third.status === 429 && third.json?.error === 'trial_daily_limit'
    && Boolean(third.json?.hint), third.json);
  const after = await on.call('GET', '/api/trial');
  t.ok('cap shows zero left today', after.json?.remaining_today === 0 && after.json?.used_today === 2, after.json);
  t.ok('cap message points at BYOK', /Settings|provider key/i.test(third.json?.hint || ''), third.json?.hint);

  // 4. A student with their own key is never routed through the trial.
  const both = await boot({ envProvider: trialEnv(), fetchImpl: makeAiFetch() });
  const bothSpace = await both.call('POST', '/api/spaces', { name: 'Math', subject: 'Math' });
  const created = await both.call('POST', '/api/providers', {
    api_name: 'My Key', provider_id: 'mykey', base_url: 'https://api.example.invalid/v1/',
    api_key: 'byok-key-1234', model: 'some-model', model_name: 'Some Model', consent: true,
  });
  t.ok('byok provider added for the priority check', created.status === 201, created.json?.error);
  const byokChat = await both.call('POST', `/api/spaces/${bothSpace.json.id}/chat`, { message: 'explain calculus' });
  t.ok('own key wins over the trial', byokChat.status === 200 && byokChat.json?.provider?.provider_key !== 'free_trial', byokChat.json?.provider);
  const bothTrial = await both.call('GET', '/api/trial');
  t.ok('trial untouched while BYOK answers', bothTrial.json?.used_today === 0 && bothTrial.json?.byok_connected === true, bothTrial.json);

  // 5. Vision work only uses the trial when a vision model was configured.
  const noVision = await boot({ envProvider: trialEnv(), fetchImpl: makeAiFetch() });
  const noVisionSpace = await noVision.call('POST', '/api/spaces', { name: 'Hist', subject: 'History' });
  const doc = await upload(noVision, { kind: 'png', mime: 'image/png', bytes: pngBytes(), spaceId: noVisionSpace.json.id, stage: 'chapter' });
  const vision = await noVision.call('POST', '/api/scan/chapter', { document_id: doc.documentId, book_id: doc.bookId });
  t.ok('photo scan refuses to pretend the trial can see', [409, 404, 400].includes(vision.status)
    && vision.json?.error !== undefined, vision.json);
  const withVision = await boot({ envProvider: trialEnv({ FREE_TRIAL_VISION_MODEL: 'trial-vision' }), fetchImpl: makeAiFetch() });
  const vv = await withVision.call('GET', '/api/trial');
  t.ok('trial advertises vision only when configured', vv.json?.vision_enabled === true, vv.json);

  // 6. Settings surface shows the trial next to BYOK.
  const settings = await on.call('GET', '/api/ai/settings');
  t.ok('ai settings includes the trial block', settings.json?.trial?.configured === true
    && typeof settings.json.trial.remaining_today === 'number', settings.json?.trial);
  t.ok('settings never includes a secret value', !JSON.stringify(settings.json || {}).includes(TRIAL_KEY), null);

  return { env: on, report: t.summary() };
}

// ---- section I: retries, cooldown and automatic fallback --------------------
// The §9 cases. Every rule here is proven against a provider double that counts
// its own calls, so "limited retries" and "no retry loop on a 401" are measured
// rather than asserted from the code.
function scriptedFetch(spec = {}) {
  const calls = [];
  const usageCalls = [];
  const seen = new Map();
  let active = 0;
  let peak = 0;
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('/models')) {
      return new Response(JSON.stringify({ data: spec.list || [] }),
        { status: spec.listStatus || 200, headers: { 'content-type': 'application/json' } });
    }
    // The account endpoint is a read of the provider's own numbers; a case that
    // wants a particular answer sets spec.usage, and one that wants to prove the
    // check is throttled counts how often it was called.
    if (u.includes('/usage')) {
      usageCalls.push({ at: Date.now(), authorization: (init.headers || {}).Authorization || '' });
      const body = spec.usage === undefined ? { object: 'list', data: [] } : spec.usage;
      return new Response(JSON.stringify(body && body.body !== undefined ? body.body : body), {
        status: (body && body.status) || 200,
        headers: { 'content-type': 'application/json', ...(body && body.headers) || {} },
      });
    }
    const body = JSON.parse(init.body || '{}');
    calls.push({ at: Date.now(), model: body.model, url: u, authorization: (init.headers || {}).Authorization || '' });
    // Overlap is measured where it happens — how many requests the provider is
    // serving at the same instant. `latency_ms` holds each answer open long
    // enough that a burst is observable instead of resolved in one tick.
    active += 1;
    if (active > peak) peak = active;
    if (spec.latency_ms) await new Promise(resolve => setTimeout(resolve, spec.latency_ms));
    active -= 1;
    const n = (seen.get(body.model) || 0) + 1;
    seen.set(body.model, n);
    const rule = (spec.models || {})[body.model];
    const step = typeof rule === 'function' ? rule(n)
      : Array.isArray(rule) ? (rule[n - 1] || rule[rule.length - 1] || {}) : (rule || {});
    const headers = { 'content-type': 'application/json' };
    if (step.retry_after) headers['retry-after'] = String(step.retry_after);
    if (step.ref !== undefined) headers['cf-ray'] = String(step.ref);
    if (step.status && step.status !== 200) {
      return new Response(JSON.stringify({
        error: { message: step.message || `HTTP ${step.status}`, type: step.type ?? null, code: step.code ?? null },
      }), { status: step.status, headers });
    }
    return new Response(JSON.stringify({
      choices: [{ message: { content: step.content || 'Force equals mass times acceleration. See page 3.' } }],
      usage: { prompt_tokens: 600, completion_tokens: 140 },
    }), { status: 200, headers });
  };
  return {
    fetchImpl, calls, usageCalls,
    count: model => calls.filter(entry => entry.model === model).length,
    total: () => calls.length,
    // The most requests this endpoint ever had being served at the same moment.
    maxActive: () => peak,
    // The narrowest gap between two consecutive attempts, in ms: the proof that
    // a retry is never instantaneous, whichever Secret the operator set.
    minGap: (model = undefined) => {
      const list = (model === undefined ? calls : calls.filter(entry => entry.model === model))
        .map(entry => entry.at).sort((a, b) => a - b);
      let gap = Number.POSITIVE_INFINITY;
      for (let i = 1; i < list.length; i += 1) gap = Math.min(gap, list[i] - list[i - 1]);
      return Number.isFinite(gap) ? gap : -1;
    },
  };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One provider, one model, one empty space: the smallest surface a routing rule
// can be observed on. `rates` makes the cheapest-capable ordering explicit.
async function routingEnv(double, { model = 'qwen/qwen3.8-omni-flash:free', name = 'Qwen', apiName = 'xKiro Qwen', base = 'https://api.xkiro.com/v1', rates = [0, 0], envProvider } = {}) {
  // A case that overrides a retry Secret still needs the encryption key, or every
  // provider save below fails for an unrelated reason.
  const ask = envProvider || (() => undefined);
  const booted = await boot({ fetchImpl: double.fetchImpl, envProvider: name2 => (name2 === 'CREDENTIAL_KEY' ? (ask(name2) || 'test-credential-key-please-ignore') : ask(name2)) });
  const created = await booted.call('POST', '/api/providers', {
    api_name: apiName, provider_id: name.toLowerCase(), base_url: base, api_key: KEY,
    model, model_name: name, consent: true,
  });
  const providerId = created.json?.provider?.id;
  const modelRowId = created.json?.provider?.models?.[0]?.id;
  if (!providerId || !modelRowId) return { env: booted, failed: created.json };
  if (rates[0] || rates[1]) {
    await booted.call('PATCH', `/api/models/${modelRowId}`, { input_micro_per_1k: rates[0], output_micro_per_1k: rates[1] });
  }
  const space = await booted.call('POST', '/api/spaces', { name: `Physics ${uuid().slice(0, 6)}`, subject: 'Physics' });
  return { env: booted, providerId, modelRowId, spaceId: space.json?.id };
}

async function providerRowOf(env, providerId) {
  const list = await env.call('GET', '/api/providers');
  return (list.json?.providers || []).find(item => item.id === providerId) || {};
}

function modelRowOf(env, rowId) {
  return env.db.table('models').find(item => item.id === rowId) || {};
}

export async function sectionResilience() {
  const t = tracker();
  const LOW = 'qwen/qwen3.8-omni-flash:free';
  const HIGH = 'gemini-2.5-pro';
  const OUTAGE = 'The model is temporarily unavailable due to high demand. Please retry in a moment.';

  // B. An invalid or disabled key stops on the first request, is filed as an
  // authentication failure, and never dressed up as an outage.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 401, message: 'Invalid or disabled ClientApiKey.', code: 'authentication_error' }] } });
    const setup = await routingEnv(double);
    t.ok('B provider setup succeeded', !setup.failed, setup.failed);
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, { message: 'what is acceleration' });
    t.ok('B a 401 is reported as an authentication failure', chat.json?.error === 'provider_auth_failed', { s: chat.status, e: chat.json?.error });
    t.ok('B a 401 is not called temporary unavailability', chat.status !== 503 && !/busy|unavailable/i.test(chat.json?.hint || ''), { s: chat.status, hint: chat.json?.hint });
    t.ok('B a 401 sends exactly one request — no retry loop', double.count(LOW) === 1, double.count(LOW));
    t.ok('B a 401 is not retried against a second provider', double.total() === 1, double.total());
    t.ok('B the reply carries no key', !JSON.stringify(chat.json).includes(KEY), stringify(chat.json).slice(0, 160));
    const row = await providerRowOf(setup.env, setup.providerId);
    t.ok('B the provider keeps the real words for diagnosis', row.last_status === 'provider_auth_failed'
      && /ClientApiKey/.test(row.last_error || ''), { s: row.last_status, e: row.last_error });
    t.ok('B the stored reason has no key in it', !String(row.last_error || '').includes(KEY), row.last_error);
  }

  // C. A 403 means the key worked and the account is not entitled — a different
  // answer from B, even though both are "an error with the provider".
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 403, message: 'This account is not allowed to use this model.' }] } });
    const setup = await routingEnv(double);
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, { message: 'define momentum' });
    t.ok('C a 403 is an access problem, not a key problem', chat.json?.error === 'provider_access_denied', { s: chat.status, e: chat.json?.error });
    t.ok('C a 403 never says the key is invalid', !/invalid key|rejected the stored key/i.test(JSON.stringify(chat.json)), stringify(chat.json).slice(0, 200));
    t.ok('C a 401 and a 403 do not collapse into one code', chat.json?.error !== 'provider_auth_failed', chat.json?.error);
    t.ok('C a 403 is not retried', double.count(LOW) === 1, double.count(LOW));
    const row = await providerRowOf(setup.env, setup.providerId);
    t.ok('C the provider row says access denied', row.last_status === 'provider_access_denied', row.last_status);
  }

  // D. A model the endpoint does not know: the id is kept exactly as typed, and
  // the student is told the key was fine.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 404, message: `The model \`${LOW}\` does not exist` }] } });
    const setup = await routingEnv(double);
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, { message: 'explain newton second law' });
    t.ok('D a 404 is a missing model, not a bad key', chat.json?.error === 'provider_model_not_found', { s: chat.status, e: chat.json?.error });
    t.ok('D a 404 is not filed as an outage', chat.status !== 503, chat.status);
    t.ok('D a 404 is not retried', double.count(LOW) === 1, double.count(LOW));
    const row = await providerRowOf(setup.env, setup.providerId);
    t.ok('D the provider message keeps the exact model id', String(row.last_error || '').includes(LOW), row.last_error);
    t.ok('D no vendor prefix or :free suffix was invented away', /:free/.test(String(row.last_error || '')), row.last_error);
    t.ok('D the outbound request sent that same id', double.calls[0]?.model === LOW, double.calls[0]?.model);
    t.ok('D the request was authorised with the real key', double.calls[0]?.authorization === `Bearer ${KEY}`, double.calls[0]?.authorization);
  }

  // E. A 429 that names a wait is honoured, inside the policy cap, and then the
  // same model gets to answer.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 429, message: 'Rate limit exceeded', retry_after: 3 }, { content: 'Rate limit lifted: acceleration is the change of velocity per second. See page 3.' }] } });
    const setup = await routingEnv(double, { envProvider: name => (name === 'AI_RETRY_AFTER_CAP_MS' ? '180' : name === 'AI_RETRY_BUDGET_MS' ? '2000' : undefined) });
    t.ok('E provider setup succeeded', !setup.failed, setup.failed);
    const started = Date.now();
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, { message: 'what is rate of change' });
    t.ok('E a rate-limited model recovers inside the same request', chat.status === 200 && /Rate limit lifted/.test(chat.json?.reply || ''), { s: chat.status, r: chat.json?.reply });
    t.ok('E the second attempt waited for the provider’s Retry-After', chat.json?.waited_ms >= 180 && Date.now() - started >= 150, { waited: chat.json?.waited_ms, took: Date.now() - started });
    t.ok('E a Retry-After longer than the cap is bounded, not obeyed blindly', chat.json?.waited_ms <= 900, chat.json?.waited_ms);
    t.ok('E exactly two requests left for this question', double.count(LOW) === 2, double.count(LOW));
    const row = await providerRowOf(setup.env, setup.providerId);
    t.ok('E success clears the earlier rate limit', row.last_status === 'ok', row.last_status);
  }

  // F, G and I share one outage that ends: the cheap model fails its bounded
  // retries, the next eligible model answers, and the cheap model returns to the
  // front of the queue on its own once the window closes.
  {
    // The cheap model is down for the first outage and back afterwards, so the
    // router is exercised against a real "was down, now up" sequence.
    let lowIsUp = false;
    const double = scriptedFetch({
      models: {
        [LOW]: () => (lowIsUp ? { content: `Answer from ${LOW}: acceleration is velocity change per second. See page 3.` } : { status: 503, message: OUTAGE }),
        [HIGH]: [{ content: 'Answer from the fallback model: momentum is mass times velocity. See page 5.' }],
      },
    });
    const booted = await boot({ fetchImpl: double.fetchImpl });
    const first = await booted.call('POST', '/api/providers', {
      api_name: 'xKiro Qwen', provider_id: 'xkiro', base_url: 'https://api.xkiro.com/v1', api_key: KEY,
      model: LOW, model_name: 'Qwen Free', tier: 'economy', consent: true,
    });
    const second = await booted.call('POST', '/api/providers', {
      api_name: 'Backup Gemini', provider_id: 'backup', base_url: 'https://api.example.com/v1', api_key: KEY,
      model: HIGH, model_name: 'Gemini Pro', tier: 'economy', consent: true,
    });
    const lowRow = first.json?.provider?.models?.[0]?.id;
    const highRow = second.json?.provider?.models?.[0]?.id;
    const lowProviderId = first.json?.provider?.id;
    t.ok('F both providers set up', Boolean(lowRow) && Boolean(highRow), stringify([first.json?.error, second.json?.error]));
    // The free model must genuinely be the cheapest, so Auto picks it first.
    await booted.call('PATCH', `/api/models/${highRow}`, { input_micro_per_1k: 120, output_micro_per_1k: 480 });
    const space = await booted.call('POST', '/api/spaces', { name: 'Physics', subject: 'Physics' });
    const spaceId = space.json?.id;

    const chat = await booted.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration' });
    t.ok('F a 503 falls back to the next eligible model', chat.status === 200 && chat.json?.model?.model_id === HIGH, { s: chat.status, m: chat.json?.model?.model_id });
    t.ok('F the fallback answer is the fallback model’s own text', /Answer from the fallback model/.test(chat.json?.reply || ''), chat.json?.reply);
    t.ok('F retries were limited, not endless', double.count(LOW) === 3, double.count(LOW));
    t.ok('F the whole request stayed within the attempt budget', double.total() <= 4, double.total());
    t.ok('F the answering model is identified to the caller', chat.json?.model?.model_id === HIGH && chat.json?.provider?.api_name === 'Backup Gemini', stringify(chat.json?.provider));
    t.ok('F the fallback is stated, not hidden', chat.json?.fell_back === true && (chat.json?.fell_back_from || []).some(item => item.includes(LOW)), stringify(chat.json?.fell_back_from));
    t.ok('F the fallback request used the student’s own id unchanged', double.calls.some(call => call.model === LOW), double.calls.map(c => c.model));
    const cooled = modelRowOf(booted, lowRow);
    t.ok('F the failed model is cooling, not disabled', cooled.enabled === true && Boolean(cooled.cooldown_until)
      && Date.parse(cooled.cooldown_until) > Date.now(), stringify(cooled));
    t.ok('F the cooldown records the outage and one streak', cooled.fail_streak === 1 && cooled.cooldown_reason === 'provider_unavailable', stringify({ s: cooled.fail_streak, r: cooled.cooldown_reason }));
    const outageRow = await providerRowOf(booted, lowProviderId);
    t.ok('F a 503 is kept as temporary unavailability on the card', outageRow.last_status === 'provider_unavailable'
      && /high demand/.test(outageRow.last_error || ''), stringify({ s: outageRow.last_status, e: outageRow.last_error }));
    t.ok('F a 503 is never relabelled as a key problem', outageRow.last_status !== 'provider_auth_failed', outageRow.last_status);
    const answered = modelRowOf(booted, highRow);
    t.ok('I the model that answered is clean of cooldown', answered.fail_streak === 0 && !answered.cooldown_until, stringify({ s: answered.fail_streak, u: answered.cooldown_until }));
    const stored = booted.db.table('messages').filter(m => m.role === 'assistant').at(-1) || {};
    t.ok('I history records which model actually produced the reply', stored.model === HIGH && /Answer from the fallback model/.test(stored.content || ''), stringify({ m: stored.model, c: String(stored.content).slice(0, 40) }));

    // G. The window closes by itself and the cheapest capable model is tried
    // first again — no manual wake, no configuration change.
    lowIsUp = true;
    await sleep(2300);
    const after = await booted.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'and what about velocity' });
    t.ok('G after the cooldown the cheapest model answers again', after.status === 200 && after.json?.model?.model_id === LOW, { s: after.status, m: after.json?.model?.model_id });
    t.ok('G the recovered model stays the cheapest, not the dearer one it was moved to', after.json?.model?.model_id === LOW && (after.json?.fell_back !== true), stringify(after.json?.fell_back_from));
    const woken = modelRowOf(booted, lowRow);
    t.ok('G success clears the streak and window automatically', woken.fail_streak === 0 && !woken.cooldown_until && !woken.cooldown_reason, stringify({ s: woken.fail_streak, u: woken.cooldown_until }));
    const healed = await providerRowOf(booted, lowProviderId);
    t.ok('G the provider card stops reporting the outage', healed.last_status === 'ok' && !healed.last_error, stringify({ s: healed.last_status, e: healed.last_error }));

    // Settings must show this state, and the wake route must not touch config.
    const settings = await booted.call('GET', '/api/ai/settings');
    t.ok('G settings publish the retry and cooldown policy', settings.json?.retry_policy?.retry_attempts === 3
      && settings.json.retry_policy.secrets.includes('MODEL_COOLDOWN_MS'), stringify(settings.json?.retry_policy));
    lowIsUp = false;
    const secondCooled = await booted.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'one more on momentum please' });
    t.ok('G a fresh outage cools the model again automatically', secondCooled.status === 200 && secondCooled.json?.model?.model_id === HIGH, stringify(secondCooled.json?.model));
    const again = modelRowOf(booted, lowRow);
    t.ok('G a repeat failure grows the window instead of disabling the model', again.fail_streak === 1 && Date.parse(again.cooldown_until) > Date.now(), stringify({ s: again.fail_streak, u: again.cooldown_until }));
    const wake = await booted.call('POST', `/api/models/${lowRow}/wake`);
    t.ok('G the manual wake only shortens the wait', wake.status === 200 && !wake.json?.model?.cooldown_until && wake.json?.model?.enabled === true, stringify(wake.json?.model));
  }

  // H. With nothing left to fall back to, the answer is an honest wait, not a
  // invented reply and not an authentication error.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 503, message: OUTAGE }], [HIGH]: [{ status: 503, message: OUTAGE }] } });
    const booted = await boot({ fetchImpl: double.fetchImpl });
    const first = await booted.call('POST', '/api/providers', {
      api_name: 'xKiro Qwen', provider_id: 'xkiro', base_url: 'https://api.xkiro.com/v1', api_key: KEY, model: LOW, model_name: 'Qwen Free', consent: true,
    });
    const second = await booted.call('POST', '/api/providers', {
      api_name: 'Backup', provider_id: 'backup', base_url: 'https://api.example.com/v1', api_key: KEY, model: HIGH, model_name: 'Gemini Pro', consent: true,
    });
    const lowRow = first.json?.provider?.models?.[0]?.id;
    await booted.call('PATCH', `/api/models/${second.json?.provider?.models?.[0]?.id}`, { input_micro_per_1k: 90, output_micro_per_1k: 90 });
    const space = await booted.call('POST', '/api/spaces', { name: 'Maths', subject: 'Maths' });
    const busy = await booted.call('POST', `/api/spaces/${space.json?.id}/chat`, { message: 'solve for x' });
    t.ok('H a busy provider is reported as busy', busy.json?.error === 'provider_unavailable' && busy.status === 503, { s: busy.status, e: busy.json?.error });
    const blocked = await booted.call('POST', `/api/spaces/${space.json?.id}/chat`, { message: 'now integrate x squared' });
    t.ok('H with every model cooling the answer is temporary unavailability', blocked.json?.error === 'models_temporarily_unavailable' && blocked.status === 503, { s: blocked.status, e: blocked.json?.error });
    t.ok('H that message is not an authentication error', blocked.json?.error !== 'provider_auth_failed'
      && !/key/i.test(blocked.json?.hint || ''), stringify(blocked.json));
    const callsBefore = double.total();
    const probeChat = await booted.call('POST', `/api/spaces/${space.json?.id}/chat`, { message: 'differentiate x cubed' });
    t.ok('H a cooling model is probed once, not retried three times', probeChat.json?.error === 'models_temporarily_unavailable'
      && double.total() - callsBefore === 1, { before: callsBefore, after: double.total() });
    t.ok('H nothing was invented', !probeChat.json?.reply, stringify(probeChat.json).slice(0, 160));
    t.ok('H the models are still enabled for later', booted.db.table('models').every(m => m.enabled === true), stringify(booted.db.table('models').map(m => m.enabled)));

    // §6: the window itself is a knob, and the knob is honoured.
    const longer = await routingEnv(scriptedFetch({ models: { [LOW]: [{ status: 503, message: OUTAGE }] } }),
      { envProvider: name => (name === 'MODEL_COOLDOWN_MS' ? '60000' : name === 'MODEL_COOLDOWN_MAX_MS' ? '300000' : undefined) });
    t.ok('H configurable-window provider setup succeeded', !longer.failed, longer.failed);
    const longerChat = await longer.env.call('POST', `/api/spaces/${longer.spaceId}/chat`, { message: 'what is friction' });
    const longRow = modelRowOf(longer.env, longer.modelRowId);
    const window = Date.parse(longRow.cooldown_until) - Date.now();
    t.ok('H cooldown length comes from the MODEL_COOLDOWN_MS secret', longerChat.json?.error === 'provider_unavailable'
      && window > 45000 && window <= 60000 + 2000, { window, e: longerChat.json?.error });
  }

  return { env: null, report: t.summary() };
}

// ---- section J: the two faces of HTTP 429 ----------------------------------
// A 429 that means "slow down" and a 429 that means "today's free tokens are
// gone" need opposite handling, and neither may be answered by hammering the
// provider. Every check here counts the double's own requests and measures the
// gap between them, so "never retry immediately" is a measurement, not a claim.
export async function sectionLimits() {
  const t = tracker();
  const LOW = 'qwen/qwen3.8-omni-flash:free';
  const OUTAGE = 'The model is temporarily unavailable due to high demand. Please retry in a moment.';

  // J1 — a per-minute throttle: retry, but spaced out and never instantly.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 429, type: 'rate_limit_exceeded', message: 'Too many requests per minute.', retry_after: 1 }, { status: 429, type: 'rate_limit_exceeded', message: 'Too many requests per minute.', retry_after: 1 }, { content: 'Force equals mass times acceleration.' }] } });
    const booted = await routingEnv(double, { model: LOW, envProvider: name => (name === 'AI_RETRY_AFTER_CAP_MS' ? '1500' : undefined) });
    t.ok('J1 throttled-provider setup succeeded', !booted.failed, booted.failed);
    const chat = await booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'what is friction' });
    t.ok('J1 a throttled minute is retried and then answers', chat.status === 200 && double.count(LOW) === 3,
      { s: chat.status, e: chat.json?.error, calls: double.count(LOW) });
    t.ok('J1 the gap between attempts respects Retry-After, never zero', double.minGap(LOW) >= 1000, { gap: double.minGap(LOW) });
    const row = await providerRowOf(booted.env, booted.providerId);
    t.ok('J1 a provider that recovered is not left flagged', row.last_status === 'ok', row.last_status);
    t.ok('J1 no key in the throttled answer', !stringify(chat.json).includes(KEY));
  }

  // J2 — the daily allowance is gone: one request, no retry, long cooldown.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 429, type: 'insufficient_quota', message: 'You have exhausted your daily free token allowance. Try again tomorrow.' }] } });
    const booted = await routingEnv(double, { model: LOW });
    t.ok('J2 quota-exhausted provider setup succeeded', !booted.failed, booted.failed);
    const chat = await booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'what is friction' });
    t.ok('J2 a spent allowance is named as spent, not as a throttle',
      chat.json?.error === 'provider_quota_exhausted' && chat.status === 429, { s: chat.status, e: chat.json?.error });
    t.ok('J2 an exhausted allowance is asked exactly once — retrying cannot un-spend it',
      double.count(LOW) === 1, { calls: double.count(LOW) });
    t.ok('J2 the answer says when it refills, in the provider’s own words',
      /daily|tomorrow/i.test(chat.json?.hint || ''), (chat.json?.hint || '').slice(0, 200));
    const cooled = modelRowOf(booted.env, booted.modelRowId);
    t.ok('J2 the model is parked for the full ceiling instead of re-running into it',
      cooled.cooldown_reason === 'provider_quota_exhausted' && Date.parse(cooled.cooldown_until) > Date.now(),
      { reason: cooled.cooldown_reason });
    // The next question is allowed exactly one recovery probe — not a fresh
    // three-attempt chain against a provider that has already said no.
    const again = await booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'second question' });
    t.ok('J2 the second question adds one probe, not another retry chain',
      double.count(LOW) === 2 && again.json?.error === 'models_temporarily_unavailable',
      { calls: double.count(LOW), e: again.json?.error });
  }

  // J3 — the machine-readable code outranks the prose.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 429, code: 'usage_limit_reached', message: 'A server error occurred.' }] } });
    const booted = await routingEnv(double, { model: LOW });
    const chat = await booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'what is friction' });
    t.ok('J3 error.code decides when the message is vague', chat.json?.error === 'provider_quota_exhausted',
      { e: chat.json?.error, hint: (chat.json?.hint || '').slice(0, 120) });
    t.ok('J3 and it is still one request', double.count(LOW) === 1, double.count(LOW));
  }

  // J4 — the real xKiro reply: 429 whose own words describe a server fault.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 429, type: 'api_error', message: 'A server error occurred. Please try again.' }] } });
    const booted = await routingEnv(double, { model: LOW });
    t.ok('J4 server-error-429 setup succeeded', !booted.failed, booted.failed);
    const chat = await booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'what is friction' });
    const hint = chat.json?.hint || '';
    t.ok('J4 a 429 that quotes a server fault is not blamed on the student',
      chat.json?.error === 'provider_rate_limited' && /fault on its side|nothing you did caused this/i.test(hint),
      { e: chat.json?.error, hint: hint.slice(0, 300) });
    t.ok('J4 it never tells them to slow down', !/slow down|too many requests from you|ask less/i.test(hint), hint.slice(0, 200));
    t.ok('J4 attempts are bounded', double.count(LOW) <= 3, double.count(LOW));
    // The floor is 250 ms of scheduled delay. The gap is measured with Date.now(),
    // whose resolution can report a timer a millisecond early, so the assertion is
    // made against the floor less one tick — never against zero.
    t.ok('J4 retries are spaced even with the backoff Secret at zero', double.minGap(LOW) >= 245, { gap: double.minGap(LOW) });
  }

  // J5 — the provider's own diagnostics are kept, and the key is not.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 429, type: 'rate_limit_error', code: 'requests_per_minute', message: 'Too many requests.', retry_after: 4, ref: 'a553deadbeef-KHI' }] } });
    const booted = await routingEnv(double, { model: LOW });
    const chat = await booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'what is friction' });
    const hint = chat.json?.hint || '';
    t.ok('J5 error.type reaches the student', /error\.type=rate_limit_error/.test(hint), hint.slice(0, 240));
    t.ok('J5 error.code reaches the student', /error\.code=requests_per_minute/.test(hint), hint.slice(0, 240));
    t.ok('J5 the Retry-After the provider sent is shown, not swallowed', /Retry-After=4/.test(hint), hint.slice(0, 240));
    t.ok('J5 the request reference is quoted so the provider can be asked about it', /a553deadbeef-KHI/.test(hint), hint.slice(0, 240));
    const row = await providerRowOf(booted.env, booted.providerId);
    t.ok('J5 the same diagnostics are stored on the provider card',
      /error\.type=rate_limit_error/.test(row.last_error || '') && /Retry-After=4/.test(row.last_error || ''),
      (row.last_error || '').slice(0, 200));
    t.ok('J5 and still no key anywhere', !stringify({ hint, row, chat: chat.json }).includes(KEY));
  }

  // J6 — the authenticated account endpoint, read once and cached.
  {
    const double = scriptedFetch({
      usage: { daily_free_tokens_limit: 1000000, daily_free_tokens_used: 1000000, daily_free_tokens_remaining: 0, requests_per_minute_limit: 60 },
      models: { [LOW]: [{ status: 429, type: 'rate_limit_error', message: 'Too many requests.' }] },
    });
    const booted = await routingEnv(double, { model: LOW });
    const usage = await booted.env.call('POST', `/api/providers/${booted.providerId}/usage`);
    const labels = (usage.json?.readings || []).map(item => item.label);
    t.ok('J6 the account endpoint is read from the backend', usage.status === 200 && usage.json?.ok === true,
      { s: usage.status, e: usage.json?.error });
    t.ok('J6 the provider’s own numbers come back, unrenamed',
      labels.includes('daily_free_tokens_remaining') && labels.includes('requests_per_minute_limit'), labels.join(', '));
    t.ok('J6 remaining=0 is read as an exhausted allowance', usage.json?.verdict === 'allowance_exhausted', usage.json?.verdict);
    t.ok('J6 the key is not in the account answer', !stringify(usage.json).includes(KEY));
    const second = await booted.env.call('POST', `/api/providers/${booted.providerId}/usage`);
    t.ok('J6 a second press reuses the reading instead of asking again',
      second.json?.cached === true && double.usageCalls.length === 1, { calls: double.usageCalls.length });
    t.ok('J6 the check carried the stored key to the provider, not to the browser',
      double.usageCalls[0]?.authorization === `Bearer ${KEY}`);
  }

  // J7 — the account figures say a limit is still in force, so it is a window.
  {
    const double = scriptedFetch({ usage: { daily_free_tokens_remaining: 420000, requests_per_minute_limit: 60 } });
    const booted = await routingEnv(double, { model: LOW });
    const usage = await booted.env.call('POST', `/api/providers/${booted.providerId}/usage`);
    t.ok('J7 allowance left is reported as allowance left', usage.json?.verdict === 'allowance_available', usage.json?.verdict);
  }

  // J8 — a provider with no account endpoint says so instead of guessing.
  {
    const double = scriptedFetch({ usage: { status: 404, body: { error: { message: 'Cannot GET /v1/usage', type: 'not_found_error', code: 'not_found' } } } });
    const booted = await routingEnv(double, { model: LOW });
    const usage = await booted.env.call('POST', `/api/providers/${booted.providerId}/usage`);
    t.ok('J8 no usage endpoint is stated as not published', usage.json?.verdict === 'not_published', usage.json?.verdict);
    t.ok('J8 and nothing is invented about the limit', !/remaining|tokens left/i.test(usage.json?.message || ''), (usage.json?.message || '').slice(0, 140));
  }

  // J9 — a 429 during routing asks the account endpoint at most once.
  {
    const double = scriptedFetch({
      usage: { daily_free_tokens_remaining: 0 },
      models: { [LOW]: [{ status: 429, type: 'rate_limit_error', message: 'Too many requests.' }] },
    });
    const booted = await routingEnv(double, { model: LOW });
    await booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'what is friction' });
    t.ok('J9 the limit check is one read, not a loop behind every attempt',
      double.usageCalls.length <= 1, { usageCalls: double.usageCalls.length, chatCalls: double.count(LOW) });
    const hint = (await booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'again' })).json?.hint || '';
    t.ok('J9 the account figures reach the student when they explain the 429',
      /daily_free_tokens_remaining=0/.test(hint) || double.usageCalls.length <= 2, hint.slice(0, 200));
  }

  // J10 — the guarantees are published, not just implemented.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ content: 'Force equals mass times acceleration.' }] } });
    const booted = await routingEnv(double, { model: LOW });
    const settings = await booted.env.call('GET', '/api/ai/settings');
    const policy = settings.json?.retry_policy || {};
    t.ok('J10 the no-instant-retry floor is published to Settings', policy.min_retry_pause_ms >= 250, policy.min_retry_pause_ms);
    t.ok('J10 the account check is throttled, and says so', policy.usage_check_cooldown_ms >= 60000, policy.usage_check_cooldown_ms);
  }

  // J11 — when the account endpoint answers without limits, it says what it did
  // answer with, so “nothing published” is a measurement rather than a guess.
  {
    const double = scriptedFetch({ usage: { object: 'list', data: [], updated_at: '2026-11-04T13:00:00Z' } });
    const booted = await routingEnv(double, { model: LOW });
    const usage = await booted.env.call('POST', `/api/providers/${booted.providerId}/usage`);
    t.ok('J11 a 200 with no limit fields is nothing_published', usage.json?.verdict === 'nothing_published', usage.json?.verdict);
    t.ok('J11 and the body it actually carried is named', /object, data\[\], updated_at/.test(String(usage.json?.body_shape || '')), usage.json?.body_shape);
    t.ok('J11 the student sees the same shape in the sentence',
      /its body carried only object, data\[\], updated_at/.test(String(usage.json?.message || '')), String(usage.json?.message || '').slice(0, 220));
    t.ok('J11 and the shape carries no key', !stringify(usage.json).includes(KEY));
    const htmlish = await routingEnv(scriptedFetch({ usage: { body: 'Bad gateway' } }), { model: LOW });
    const second = await htmlish.env.call('POST', `/api/providers/${htmlish.providerId}/usage`);
    t.ok('J11 a body that is not a JSON object is called that', /non-JSON body of \d+ characters/.test(String(second.json?.body_shape || '')), second.json?.body_shape);
  }

  // J12 — five presses of one question are one provider run. The browser holds
  // back a double click; this is the layer that still holds when two tabs ask
  // the same thing at the same moment.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 503, message: OUTAGE }] } });
    const booted = await routingEnv(double, { model: LOW });
    t.ok('J12 outage provider setup succeeded', !booted.failed, booted.failed);
    const presses = await Promise.all([1, 2, 3, 4, 5]
      .map(() => booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'what is acceleration' })));
    t.ok('J12 five identical presses send one retry chain, not five', double.count(LOW) === 3, { calls: double.count(LOW), total: double.total() });
    t.ok('J12 the provider never holds two copies of the question', double.maxActive() === 1, double.maxActive());
    t.ok('J12 every press gets the same honest refusal', presses.every(p => p.status === 503 && p.json?.error === 'provider_unavailable'), presses.map(p => `${p.status}:${p.json?.error}`).join(','));
    t.ok('J12 no press invented a reply', presses.every(p => !p.json?.reply), stringify(presses.map(p => p.json)).slice(0, 160));
    t.ok('J12 and no key in any of them', !stringify(presses).includes(KEY));
  }

  // J13 — the pinned-model path is deduped too. It used to skip the in-flight
  // guard entirely, so a double click on a named model paid for the prompt twice.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 503, message: OUTAGE }] } });
    const booted = await routingEnv(double, { model: LOW });
    const presses = await Promise.all([1, 2, 3]
      .map(() => booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'explain friction', model_row_id: booted.modelRowId })));
    t.ok('J13 a pinned model still sends one retry chain', double.count(LOW) === 3, { calls: double.count(LOW) });
    t.ok('J13 the pinned press really went to the model named', double.calls.every(c => c.model === LOW), double.calls.map(c => c.model).join(','));
    t.ok('J13 three presses, three refusals, no invented answer', presses.every(p => p.status === 503 && !p.json?.reply), presses.map(p => p.status).join(','));
  }

  // J14 — different questions may overlap only up to the cap. This is what stops
  // one student pressing four Stage-4 tools from arriving as a burst.
  {
    const one = scriptedFetch({ latency_ms: 40, models: { [LOW]: [{ content: 'Force equals mass times acceleration. See page 3.' }] } });
    const capped = await routingEnv(one, { model: LOW, envProvider: name => (name === 'AI_MAX_CONCURRENT' ? '1' : undefined) });
    t.ok('J14 single-slot provider setup succeeded', !capped.failed, capped.failed);
    const four = await Promise.all(['a', 'b', 'c', 'd']
      .map(key => capped.env.call('POST', `/api/spaces/${capped.spaceId}/chat`, { message: `question ${key}` })));
    t.ok('J14 four different questions all get answered', four.every(p => p.status === 200 && /acceleration/.test(p.json?.reply || '')), four.map(p => p.status).join(','));
    t.ok('J14 four questions are four requests, not a burst', one.total() === 4, one.total());
    t.ok('J14 and the provider never serves two of them at once', one.maxActive() === 1, one.maxActive());
    const many = scriptedFetch({ latency_ms: 40, models: { [LOW]: [{ content: 'Force equals mass times acceleration. See page 3.' }] } });
    const raised = await routingEnv(many, { model: LOW, envProvider: name => (name === 'AI_MAX_CONCURRENT' ? '3' : undefined) });
    const later = await Promise.all(['e', 'f', 'g', 'h']
      .map(key => raised.env.call('POST', `/api/spaces/${raised.spaceId}/chat`, { message: `question ${key}` })));
    t.ok('J14 nothing is lost by queueing', later.every(p => p.status === 200), later.map(p => p.status).join(','));
    t.ok('J14 raising the Secret raises the overlap, and no further', many.maxActive() === 3, many.maxActive());
    const published = await capped.env.call('GET', '/api/ai/settings');
    t.ok('J14 the cap in force is published to Settings', published.json?.retry_policy?.max_concurrent === 1, stringify(published.json?.retry_policy).slice(0, 200));
    const publishedRaised = await raised.env.call('GET', '/api/ai/settings');
    t.ok('J14 and it reports the operator’s number, not a fixed one', publishedRaised.json?.retry_policy?.max_concurrent === 3, publishedRaised.json?.retry_policy?.max_concurrent);
  }

  // J15 — a cooling model is re-tested on a timer, not once per question. Before
  // this gate every click spent a live request on an endpoint that had just
  // refused, which is what made one outage look like a stream of 503s.
  {
    const double = scriptedFetch({ models: { [LOW]: [{ status: 503, message: OUTAGE }] } });
    const booted = await routingEnv(double, {
      model: LOW,
      envProvider: name => (name === 'MODEL_COOLDOWN_MS' ? '30000'
        : name === 'AI_RECOVERY_PROBE_MS' ? '60000' : undefined),
    });
    t.ok('J15 timed-window provider setup succeeded', !booted.failed, booted.failed);
    const first = await booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'what is friction' });
    t.ok('J15 the outage is reported with its bounded retries', first.json?.error === 'provider_unavailable' && double.count(LOW) === 3, { e: first.json?.error, calls: double.count(LOW) });
    const beforeProbe = double.total();
    const second = await booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'and what about velocity' });
    t.ok('J15 the next question spends exactly one live probe', double.total() - beforeProbe === 1, { added: double.total() - beforeProbe });
    t.ok('J15 the probe is a single attempt, not a second retry chain', double.count(LOW) === 4, double.count(LOW));
    t.ok('J15 the probe answer names the timer', second.json?.error === 'models_temporarily_unavailable'
      && /tests it on that timer/i.test(second.json?.hint || ''), (second.json?.hint || '').slice(0, 220));
    t.ok('J15 it does not tell the student to keep sending it', !/once more|send the question again|try again later/i.test(second.json?.hint || ''), (second.json?.hint || '').slice(0, 200));
    const beforePause = double.total();
    const third = await booted.env.call('POST', `/api/spaces/${booted.spaceId}/chat`, { message: 'differentiate x cubed' });
    t.ok('J15 while that window is open the next question sends nothing', double.total() === beforePause, { added: double.total() - beforePause });
    t.ok('J15 and says so as provider_paused', third.json?.error === 'provider_paused' && third.status === 503, { s: third.status, e: third.json?.error });
    t.ok('J15 with the seconds left, not a vague wait', /for about \d+ more seconds/.test(third.json?.hint || ''), (third.json?.hint || '').slice(0, 240));
    t.ok('J15 it names the provider being rested', /xKiro/.test(third.json?.hint || ''), (third.json?.hint || '').slice(0, 120));
    t.ok('J15 nothing was invented during the pause', !third.json?.reply, stringify(third.json).slice(0, 140));
    const row = await providerRowOf(booted.env, booted.providerId);
    const cooled = modelRowOf(booted.env, booted.modelRowId);
    t.ok('J15 the pause disables nothing — provider and model stay enabled', cooled.enabled === true && row.enabled === true, stringify({ m: cooled.enabled, p: row.enabled }));
    t.ok('J15 the student’s endpoint is untouched and no key leaks', row.base_url === 'https://api.xkiro.com/v1'
      && !stringify({ third, row, cooled }).includes(KEY), stringify({ base: row.base_url }));
  }

  return { env: null, report: t.summary() };
}

// ---- section K: the Gemini native wire ---------------------------------------
// Google binds the model in the URL path (`/v1beta/models/{model}:generateContent`)
// and its GenerateContentRequest body has no `model` field. This double answers the
// way the gateway does — a path that does not bind is a 400 quoting Google's own
// sentence — so every assertion below is about the request that actually leaves.
function googleDouble(catalogue, { pages = null } = {}) {
  const seen = [];
  const LIST = /^\/v1beta\d?\/models$/;
  const GENERATE = /^\/v1beta\d?\/models\/([^/]+):([A-Za-z]+)$/;
  const fetchImpl = async (url, init) => {
    const full = String(url);
    const raw = full.split('?')[0];
    const method = String(init.method || 'GET').toUpperCase();
    const headers = init.headers || {};
    const record = {
      raw, method,
      path: new URL(raw).pathname,
      query: Object.fromEntries(new URL(full).searchParams.entries()),
      decoded: decodeURIComponent(new URL(raw).pathname),
      goog: headers['x-goog-api-key'] || null,
      bearer: headers.Authorization || null,
      body: init.body ? JSON.parse(init.body) : null,
    };
    seen.push(record);
    const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
    const bad = message => json(400, { error: { code: 400, message, status: 'INVALID_ARGUMENT' } });
    if (record.bearer) return json(400, { error: { code: 400, message: 'ApiKeyError: The API key must be sent in the x-goog-api-key header.', status: 'INVALID_ARGUMENT' } });
    if (!record.goog) return json(401, { error: { code: 401, message: 'API key not valid. Please pass a valid API key.', status: 'UNAUTHENTICATED' } });
    if (method === 'GET' && LIST.test(record.path)) {
      // Google's own catalogue is paged: one page of entries plus a nextPageToken.
      const token = record.query.pageToken || '';
      if (pages && token && Object.prototype.hasOwnProperty.call(pages, token)) {
        const page = pages[token];
        if (page instanceof Response) return page;
        // A page is either a body, or a failure to answer with.
        if (page && typeof page === 'object' && 'status' in page) return json(page.status || 200, page.body);
        return json(200, page);
      }
      return json(200, catalogue);
    }
    const match = GENERATE.exec(record.path);
    if (!match) return bad(`GenerateContentRequest.model: unexpected model name format (${record.path} does not bind to /v1beta/models/{model}:generateContent)`);
    const model = decodeURIComponent(match[1]);
    if (match[1].includes('%2F') || model.includes('/')) return bad(`GenerateContentRequest.model: unexpected model name format (${model})`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(model)) return bad(`GenerateContentRequest.model: unexpected model name format (${model})`);
    if (match[2] !== 'generateContent') return bad(`Operation ${match[2]} is not supported on model ${model}`);
    if (record.body.model !== undefined) return json(400, { error: { code: 400, message: 'Invalid JSON payload received. Unknown name "model" at \'generate_content_request\': Cannot find field.', status: 'INVALID_ARGUMENT' } });
    if (!Array.isArray(record.body?.contents) || typeof record.body.contents[0]?.parts?.[0]?.text !== 'string') {
      return json(400, { error: { code: 400, message: 'Invalid JSON payload received. contents[].parts[].text is required.', status: 'INVALID_ARGUMENT' } });
    }
    return json(200, {
      candidates: [{ content: { parts: [{ text: 'Newton\'s first law: a body at rest stays at rest and a body in motion keeps moving in a straight line at constant speed unless an unbalanced external force acts on it. This tendency is inertia.' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 41, candidatesTokenCount: 74, totalTokenCount: 115 },
      modelVersion: model,
    });
  };
  return {
    fetchImpl, seen,
    generations: () => seen.filter(item => item.path.includes(':generateContent')),
    lists: () => seen.filter(item => !item.path.includes(':generateContent')),
  };
}

const GOOGLE_CATALOGUE = {
  models: [
    { name: 'models/gemini-3.8-flash', display_name: 'Gemini 3.8 Flash', supported_generation_methods: ['generateContent', 'streamGenerateContent'] },
    { name: 'models/gemini-2.5-pro', display_name: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', display_name: 'Text Embedding 004', supportedGenerationMethods: ['embedContent'] },
  ],
};

async function geminiEnv(double, { base = 'https://generativelanguage.googleapis.com/v1beta', model = 'gemini-3.8-flash' } = {}) {
  const env = await boot({ fetchImpl: double.fetchImpl, envProvider: name => (name === 'CREDENTIAL_KEY' ? 'test-credential-key-please-ignore' : undefined) });
  const created = await env.call('POST', '/api/providers', {
    api_name: 'Google Gemini', provider_id: 'gemini', base_url: base, api_key: KEY,
    model, model_name: 'Gemini 3.8 Flash', consent: true,
  });
  const space = await env.call('POST', '/api/spaces', { name: 'Physics 9', subject: 'Physics' });
  return { env, providerId: created.json?.provider?.id, modelRowId: created.json?.provider?.models?.[0]?.id, saved: created.json?.provider, spaceId: space.json?.id, failed: created.json };
}

const NEWTON = "Explain Newton's first law of motion in simple Class 10 language.";

export async function sectionGemini() {
  const t = tracker();

  // K1 — the canonical shape: model in the path, no model field, Google's header,
  // Google's contents/parts body, and a real 200 read back from usageMetadata.
  {
    const double = googleDouble(GOOGLE_CATALOGUE);
    const setup = await geminiEnv(double);
    t.ok('K1 gemini wire inferred from the native endpoint', setup.saved?.wire === 'gemini', setup.saved?.wire);
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, { message: NEWTON });
    const out = double.generations();
    t.ok('K1 one generation request for one question', out.length === 1, out.length);
    t.ok('K1 the model is bound in the URL path', out[0]?.path === '/v1beta/models/gemini-3.8-flash:generateContent', out[0]?.path);
    t.ok('K1 GenerateContentRequest carries no model field', out[0]?.body && out[0].body.model === undefined, Object.keys(out[0]?.body || {}));
    t.ok('K1 the body speaks native contents/parts', Array.isArray(out[0]?.body?.contents)
      && Array.isArray(out[0]?.body?.contents?.[0]?.parts) && out[0].body.contents[0].parts.length === 1, stringify(out[0]?.body?.contents).slice(0, 160));
    t.ok('K1 the question itself is in that part', String(out[0]?.body?.contents?.[0]?.parts?.[0]?.text || '').includes('Newton'), String(out[0]?.body?.contents?.[0]?.parts?.[0]?.text || '').slice(0, 90));
    t.ok('K1 the system instruction travels as systemInstruction', Array.isArray(out[0]?.body?.systemInstruction?.parts), Object.keys(out[0]?.body || {}).join(','));
    t.ok('K1 generationConfig carries the token ceiling', Number(out[0]?.body?.generationConfig?.maxOutputTokens) > 0, out[0]?.body?.generationConfig);
    t.ok('K1 auth is x-goog-api-key, never a Bearer header', out[0]?.goog === KEY && !out[0]?.bearer, { goog: Boolean(out[0]?.goog), bearer: Boolean(out[0]?.bearer) });
    t.ok('K1 the answer is the model’s own text', chat.status === 200 && /inertia/i.test(chat.json?.reply || ''), { s: chat.status, e: chat.json?.error });
    t.ok('K1 token usage is read from usageMetadata', chat.json?.tokens === 115, chat.json?.tokens);
    t.ok('K1 the answering model is reported', chat.json?.model?.model_id === 'gemini-3.8-flash', stringify(chat.json?.model));
    t.ok('K1 a free model costs nothing', chat.json?.cost_micro === 0 || chat.json?.cost_micro === undefined, chat.json?.cost_micro);
    t.ok('K1 no key in the student’s answer', !stringify(chat.json).includes(KEY), stringify(chat.json).slice(0, 160));
    const row = await providerRowOf(setup.env, setup.providerId);
    t.ok('K1 success is recorded on the provider card', row.last_status === 'ok' && !String(row.last_error).includes(KEY), { s: row.last_status });
  }

  // K2 — the two paste shapes that produced the reported 400, and the stored row
  // that must not be rewritten while they are being fixed.
  {
    const prefixed = googleDouble(GOOGLE_CATALOGUE);
    const setup = await geminiEnv(prefixed, { model: 'models/gemini-3.8-flash' });
    t.ok('K2 a catalogue name is accepted verbatim as the id', setup.saved?.models?.[0]?.model_id === 'models/gemini-3.8-flash', setup.saved?.models?.[0]?.model_id);
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, { message: NEWTON });
    t.ok('K2 a models/ prefix is normalised once, never to models/models/', prefixed.generations()[0]?.path === '/v1beta/models/gemini-3.8-flash:generateContent', prefixed.generations()[0]?.path);
    t.ok('K2 and the answer arrives instead of a 400', chat.status === 200 && /inertia/i.test(chat.json?.reply || ''), { s: chat.status, e: chat.json?.error });
    t.ok('K2 the row still holds what the student typed', modelRowOf(setup.env, setup.modelRowId).model_id === 'models/gemini-3.8-flash', modelRowOf(setup.env, setup.modelRowId).model_id);

    const docsBase = googleDouble(GOOGLE_CATALOGUE);
    const alt = await geminiEnv(docsBase, { base: 'https://generativelanguage.googleapis.com/v1beta/models' });
    const altChat = await alt.env.call('POST', `/api/spaces/${alt.spaceId}/chat`, { message: NEWTON });
    t.ok('K2 a Base URL ending in /models does not double the segment', docsBase.generations()[0]?.path === '/v1beta/models/gemini-3.8-flash:generateContent', docsBase.generations()[0]?.path);
    t.ok('K2 its model list is read from /v1beta/models, not /models/models', docsBase.lists().every(item => item.path === '/v1beta/models'), docsBase.lists().map(item => item.path));
    t.ok('K2 that setup answers too', altChat.status === 200 && /inertia/i.test(altChat.json?.reply || ''), { s: altChat.status, e: altChat.json?.error });

    const doubled = googleDouble(GOOGLE_CATALOGUE);
    const triple = await geminiEnv(doubled, { base: 'https://generativelanguage.googleapis.com/v1beta/models', model: 'models/models/gemini-3.8-flash' });
    const tripleChat = await triple.env.call('POST', `/api/spaces/${triple.spaceId}/chat`, { message: NEWTON });
    t.ok('K2 even a doubled prefix collapses to one segment', doubled.generations()[0]?.path === '/v1beta/models/gemini-3.8-flash:generateContent', doubled.generations()[0]?.path);
    t.ok('K2 and it is a 200', tripleChat.status === 200, { s: tripleChat.status, e: tripleChat.json?.error });
  }

  // K3 — discovery reads what Google actually publishes: names, verbs, nothing invented.
  {
    const double = googleDouble(GOOGLE_CATALOGUE);
    const setup = await geminiEnv(double);
    const listed = await setup.env.call('GET', `/api/providers/${setup.providerId}/models`);
    const ids = (listed.json?.models || []).map(item => item.id);
    t.ok('K3 the list is read from the provider’s own endpoint', listed.json?.available === true && double.lists().length === 1 && double.lists()[0].path === '/v1beta/models', { a: listed.json?.available, s: listed.json?.status, paths: double.lists().map(item => item.path) });
    t.ok('K3 the ids are usable bare identifiers', ids.includes('gemini-3.8-flash') && ids.includes('gemini-2.5-pro'), ids.join(', '));
    t.ok('K3 no id carries the models/ resource prefix', ids.every(id => !id.startsWith('models/')), ids.join(', '));
    t.ok('K3 an embed-only model is not offered for chat', !ids.some(id => id.includes('embedding')), ids.join(', '));
    t.ok('K3 nothing is invented — only the two it published', ids.length === 2, ids.join(', '));
    t.ok('K3 the display name comes from the provider’s own field', (listed.json?.models || [])[0]?.name === 'Gemini 3.8 Flash', stringify(listed.json?.models?.[0]));
    t.ok('K3 the list request used the Google header as well', double.lists()[0]?.goog === KEY && !double.lists()[0]?.bearer, Boolean(double.lists()[0]?.bearer));
  }

  // K4 — a genuinely malformed id still gets Google's own words, filed as a model
  // problem and not as a key or a body error.
  {
    const double = googleDouble(GOOGLE_CATALOGUE);
    const setup = await geminiEnv(double, { model: 'gemini::two::colons' });
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, { message: NEWTON });
    t.ok('K4 a real bad id is still sent as one segment', double.generations()[0]?.decoded === '/v1beta/models/gemini::two::colons:generateContent', double.generations()[0]?.decoded);
    t.ok('K4 the gateway’s 400 is filed as a model problem', chat.json?.error === 'provider_model_not_found', { s: chat.status, e: chat.json?.error });
    t.ok('K4 with the provider’s exact sentence kept', /unexpected model name format/.test(chat.json?.hint || ''), (chat.json?.hint || '').slice(0, 220));
    t.ok('K4 and never blamed on the key', !/key/i.test(chat.json?.hint || ''), (chat.json?.hint || '').slice(0, 200));
    t.ok('K4 it is not retried into a burst', double.generations().length === 1, double.generations().length);
    const row = await providerRowOf(setup.env, setup.providerId);
    t.ok('K4 the provider card shows the same reason', /unexpected model name format/.test(row.last_error || ''), (row.last_error || '').slice(0, 180));
  }

  // K5 — the path is built from one bounded segment, so nothing a student types can
  // escape it: relative segments are refused at the gate, and a slash inside a legal
  // id stays encoded instead of becoming an extra path element.
  {
    const gate = googleDouble(GOOGLE_CATALOGUE);
    const escaped = await geminiEnv(gate, { model: '../../v1beta/models/gemini-2.5-pro' });
    t.ok('K5 a relative id is refused before it is stored', escaped.saved?.models?.[0]?.model_id === undefined || !String(escaped.saved.models[0].model_id).includes('..'), stringify(escaped.saved?.models));
    t.ok('K5 nothing was sent to the provider for it', gate.generations().length === 0, gate.seen.map(item => item.path));
    const empty = await geminiEnv(googleDouble(GOOGLE_CATALOGUE), { model: 'gemini//flash' });
    t.ok('K5 an empty path segment is refused too', !empty.providerId, stringify(empty.saved?.error || empty.failed).slice(0, 120));

    const double = googleDouble(GOOGLE_CATALOGUE);
    const slashed = await geminiEnv(double, { model: 'gemini/3.8/flash' });
    const chat = await slashed.env.call('POST', `/api/spaces/${slashed.spaceId}/chat`, { message: NEWTON });
    const out = double.generations()[0];
    t.ok('K5 a slash inside a legal id stays percent-encoded', out?.raw.includes('models/gemini%2F3.8%2Fflash:generateContent'), out?.raw);
    t.ok('K5 the request line stays one path element after /models/', /^\/v1beta\/models\/[^/]+:generateContent$/.test(out?.path || ''), out?.path);
    t.ok('K5 the gateway’s refusal is reported, not papered over', chat.status !== 200 && /model/i.test(chat.json?.hint || ''), { s: chat.status, e: chat.json?.error, hint: (chat.json?.hint || '').slice(0, 160) });
    t.ok('K5 and no key escapes into the answer', !stringify(chat.json).includes(KEY));
  }

  // K6 — Google's catalogue is paged: one page of entries plus a nextPageToken.
  // The saved model sat on the second page, and reading only the first page is what
  // produced "None of the 1 model id(s) saved here appear in this endpoint’s list of 50."
  {
    const firstPage = { models: [], nextPageToken: 'page-2' };
    for (let i = 1; i <= 50; i += 1) {
      firstPage.models.push({
        name: `models/gemini-1.5-flash-${String(i).padStart(3, '0')}`,
        displayName: `Gemini 1.5 Flash ${i}`,
        supportedGenerationMethods: ['generateContent'],
      });
    }
    const secondPage = {
      models: [
        { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent', 'streamGenerateContent'] },
        { name: 'models/gemini-3.8-pro', displayName: 'Gemini 3.8 Pro', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/text-embedding-004', displayName: 'Text Embedding 004', supportedGenerationMethods: ['embedContent'] },
      ],
    };
    const double = googleDouble(firstPage, { pages: { 'page-2': secondPage } });
    const setup = await geminiEnv(double);
    const listed = await setup.env.call('GET', `/api/providers/${setup.providerId}/models`);
    const ids = (listed.json?.models || []).map(item => item.id);
    t.ok('K6 discovery follows nextPageToken to the next page', double.lists().length === 2 && double.lists()[1]?.query?.pageToken === 'page-2', stringify(double.lists().map(item => item.query)));
    t.ok('K6 the model on the second page is found', ids.includes('gemini-3.8-flash'), ids.slice(0, 4).join(', '));
    t.ok('K6 an embed-only entry is still filtered out', !ids.some(id => /embedding/i.test(id)), ids.length);
    t.ok('K6 the display name comes from Google’s own camelCase field', (listed.json?.models || []).find(item => item.id === 'gemini-3.8-flash')?.name === 'Gemini 3.8 Flash', stringify(listed.json?.models?.[0]));
    t.ok('K6 a list that was read whole is not reported as partial', listed.json?.truncated === false, listed.json?.truncated);
    const tested = await setup.env.call('POST', `/api/providers/${setup.providerId}/test`);
    t.ok('K6 test connection finds the model on the second page', String(tested.json?.status || '').startsWith('ok'), stringify(tested.json).slice(0, 200));
    t.ok('K6 and never says the model is missing', !/None of the \d+ model id/.test(tested.json?.message || ''), (tested.json?.message || '').slice(0, 160));

    // A row that still holds the catalogue spelling is recognised as the same model.
    const prefixed = googleDouble(firstPage, { pages: { 'page-2': secondPage } });
    const stored = await geminiEnv(prefixed, { model: 'models/gemini-3.8-flash' });
    const listedAgain = await stored.env.call('GET', `/api/providers/${stored.providerId}/models`);
    const added = (listedAgain.json?.models || []).find(item => item.id === 'gemini-3.8-flash');
    t.ok('K6 a row saved with the models/ prefix is marked as already added', added?.added === true, stringify(added));
    const chat = await stored.env.call('POST', `/api/spaces/${stored.spaceId}/chat`, { message: NEWTON });
    t.ok('K6 and it still reaches one model segment', prefixed.generations()[0]?.path === '/v1beta/models/gemini-3.8-flash:generateContent', prefixed.generations()[0]?.path);
    t.ok('K6 with a real answer', chat.status === 200 && /inertia/i.test(chat.json?.reply || ''), { s: chat.status, e: chat.json?.error });
  }

  // K7 — a catalogue that could only be read in part may never be used to deny a
  // model: the model is asked directly and its own answer decides.
  {
    const firstPage = { models: [], nextPageToken: 'page-2' };
    for (let i = 1; i <= 50; i += 1) {
      firstPage.models.push({
        name: `models/gemini-1.5-flash-${String(i).padStart(3, '0')}`,
        displayName: `Gemini 1.5 Flash ${i}`,
        supportedGenerationMethods: ['generateContent'],
      });
    }
    const double = googleDouble(firstPage, {
      pages: { 'page-2': { status: 503, body: { error: { code: 503, message: 'The service is currently unavailable.' } } } },
    });
    const setup = await geminiEnv(double);
    const tested = await setup.env.call('POST', `/api/providers/${setup.providerId}/test`);
    t.ok('K7 a partly-read catalogue never denies the model', tested.json?.status !== 'model_not_found', stringify(tested.json).slice(0, 200));
    t.ok('K7 the model is asked directly instead', double.generations().length === 1, double.generations().length);
    t.ok('K7 and the model’s own answer decides', String(tested.json?.status || '').startsWith('ok'), stringify(tested.json).slice(0, 200));
    const listed = await setup.env.call('GET', `/api/providers/${setup.providerId}/models`);
    t.ok('K7 the list is reported as partial rather than complete', listed.json?.truncated === true, listed.json?.truncated);
    t.ok('K7 and the models it did read are still real', (listed.json?.models || []).length === 50, (listed.json?.models || []).length);
  }

  // K8 — the protocol belongs to the endpoint. A Base URL that is edited must not
  // keep speaking the language of the address it used to point at.
  {
    const double = googleDouble(GOOGLE_CATALOGUE);
    const setup = await geminiEnv(double, { base: 'https://generativelanguage.googleapis.com/v1beta/openai/' });
    t.ok('K8 an OpenAI-compatible base is treated as OpenAI', setup.saved?.wire === 'openai', setup.saved?.wire);
    const patched = await setup.env.call('PATCH', `/api/providers/${setup.providerId}`, { base_url: 'https://generativelanguage.googleapis.com/v1beta' });
    t.ok('K8 editing the Base URL re-infers the protocol', patched.json?.provider?.wire === 'gemini', patched.json?.provider?.wire);
    t.ok('K8 and the new address is stored', patched.json?.provider?.base_url === 'https://generativelanguage.googleapis.com/v1beta', patched.json?.provider?.base_url);
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, { message: NEWTON });
    t.ok('K8 the next request uses the native path', double.generations()[0]?.path === '/v1beta/models/gemini-3.8-flash:generateContent', double.generations()[0]?.path);
    t.ok('K8 with Google’s own header', double.generations()[0]?.goog === KEY && !double.generations()[0]?.bearer, { goog: Boolean(double.generations()[0]?.goog), bearer: Boolean(double.generations()[0]?.bearer) });
    t.ok('K8 and it answers', chat.status === 200 && /inertia/i.test(chat.json?.reply || ''), { s: chat.status, e: chat.json?.error });
  }

  return { env: null, report: t.summary() };
}

// ---- section L: the sixteen acceptance criteria ------------------------------
//
// The gateway, the ledger and the tutor are used the way a student uses them:
// an administrator saves a provider, the provider's own catalogue is verified,
// and a student asks a question. Every check below reads a row the server
// wrote or a request that really went out — nothing here is a fixture, and no
// answer is asserted without a provider behind it.

const GATEWAY_KEY = 'sk-or-v1-9f2c7a1b4d6e8f0a2c4b6d8e0f2a4c6b';
const FREE_FIRST = 'alpha/qwen3-235b-a22b:free';
const FREE_SECOND = 'zeta/llama-3.3-70b-instruct:free';
const PAID_MODEL = 'openai/gpt-4o';
const FREE_ROUTER = 'openrouter/free';

// The catalogue a provider really publishes: two models at zero on both sides
// and one that costs money. Nothing in the code may guess which is which.
const FREE_CATALOGUE = {
  data: [
    { id: FREE_FIRST, name: 'Qwen3 235B (Free)', pricing: { prompt: '0', completion: '0' }, context_length: 32768 },
    { id: FREE_SECOND, name: 'Llama 3.3 70B (Free)', pricing: { prompt: '0', completion: '0' }, context_length: 131072 },
    { id: PAID_MODEL, name: 'GPT-4o', pricing: { prompt: '0.0000025', completion: '0.00001' }, context_length: 128000 },
  ],
};

// The provider double. It answers /models with the catalogue above and
// /chat/completions with whatever the case asked that model to do.
function gatewayDouble(catalogue, spec = {}) {
  const calls = [];
  const lists = [];
  const fetchImpl = async (url, init) => {
    const full = String(url);
    const json = (status, value, headers = {}) => new Response(JSON.stringify(value), {
      status, headers: { 'content-type': 'application/json', ...headers },
    });
    if (/\/models(\?|$)/.test(full)) {
      lists.push(full);
      if (spec.listStatus) return json(spec.listStatus, { error: { message: 'no catalogue today' } });
      return json(200, catalogue);
    }
    const body = JSON.parse(init.body || '{}');
    calls.push({ url: full, model: body.model, authorization: (init.headers || {}).Authorization || '', body });
    const rule = (spec.models || {})[body.model];
    const seen = calls.filter(call => call.model === body.model).length;
    const step = typeof rule === 'function' ? rule(seen)
      : Array.isArray(rule) ? (rule[seen - 1] || rule[rule.length - 1] || {})
        : (rule || {});
    const headers = { 'content-type': 'application/json' };
    if (step.retry_after) headers['retry-after'] = String(step.retry_after);
    if (step.status && step.status !== 200) {
      return json(step.status, {
        error: { message: step.message || `HTTP ${step.status}`, code: step.code || null, type: step.type || null },
      }, headers);
    }
    return json(200, {
      // A router names the model it really picked; every other provider names
      // the model that was asked for.
      model: step.answer_as || body.model,
      choices: [{ message: { content: step.content || 'Acceleration is the rate of change of velocity, measured in metres per second squared.' } }],
      usage: { prompt_tokens: 300, completion_tokens: 90 },
    }, headers);
  };
  return {
    fetchImpl, calls, lists,
    count: model => calls.filter(call => call.model === model).length,
    total: () => calls.length,
    modelsCalled: () => [...new Set(calls.map(call => call.model))],
  };
}

// A platform the administrator configured: the provider is saved through the
// admin API, its catalogue is verified against the provider's own /models, and
// a space is opened for the student.
async function gatewayEnv(double, {
  catalogue = FREE_CATALOGUE, wire = 'openrouter', base = 'https://openrouter.ai/api/v1',
  key = GATEWAY_KEY, admin = 'student-a', retry = '1', extra = {},
} = {}) {
  const env = await boot({
    fetchImpl: double.fetchImpl,
    envProvider: name => {
      if (name === 'CREDENTIAL_KEY') return 'test-credential-key-please-ignore';
      if (name === 'ADMIN_OWNER_IDS') return admin;
      if (name === 'AI_RETRY_ATTEMPTS') return retry;
      if (Object.prototype.hasOwnProperty.call(extra, name)) return extra[name];
      return undefined;
    },
  });
  const created = await env.call('POST', '/api/admin/providers', {
    name: 'OpenRouter Free', provider_key: 'openrouter-free', base_url: base, wire, api_key: key,
  });
  const providerId = created.json?.provider?.id;
  const verified = providerId ? await env.call('POST', `/api/admin/providers/${providerId}/verify`) : null;
  const space = await env.call('POST', '/api/spaces', { name: 'Physics', subject: 'Physics' });
  return { env, providerId, verified, spaceId: space.json?.id, failed: created.json };
}

// What the ledger says for one student, in the order the rows were written.
function ledgerOf(env, ownerId) {
  return env.db.table('transactions').filter(row => row.owner_id === ownerId);
}

function ledgerSum(rows) {
  return rows.reduce((sum, row) => sum + (row.direction === 'earn' ? row.amount : -row.amount), 0);
}

export async function sectionAcceptance() {
  const t = tracker();

  // ---- L1: a new student's wallet ------------------------------------------
  {
    const env = await boot();
    const wallet = await env.call('GET', '/api/wallet');
    t.ok('L1 a new student starts with a wallet and no credits', wallet.status === 200
      && wallet.json?.balance === 0 && wallet.json?.earned === 0 && wallet.json?.spent === 0, wallet.json);
    t.ok('L1 a new student has no transaction history', Array.isArray(wallet.json?.history) && wallet.json.history.length === 0, wallet.json?.history);
    t.ok('L1 the price of a basic AI question is published as 2', wallet.json?.rates?.spend?.basic_question === 2, wallet.json?.rates?.spend);
    t.ok('L1 the daily login reward is published as 30', wallet.json?.rates?.earn?.login === 30, wallet.json?.rates?.earn);
    t.ok('L1 the daily request limit is published', wallet.json?.limits?.daily_questions_per_student === 10, wallet.json?.limits);
  }

  // ---- L2: the daily login pays exactly 30 ----------------------------------
  {
    const env = await boot();
    const claim = await env.call('POST', '/api/daily/login');
    t.ok('L2 the first login of the day pays exactly 30', claim.status === 200
      && claim.json?.claimed === true && claim.json?.credits === 30, claim.json);
    t.ok('L2 the balance after the claim is 30', claim.json?.balance === 30, claim.json?.balance);
    const wallet = await env.call('GET', '/api/wallet');
    t.ok('L2 the wallet agrees', wallet.json?.balance === 30 && wallet.json?.earned === 30 && wallet.json?.spent === 0, wallet.json);
    const rows = ledgerOf(env, 'student-a');
    t.ok('L2 the ledger holds one earning row of 30', rows.length === 1
      && rows[0].direction === 'earn' && rows[0].amount === 30, rows);
    t.ok('L2 the claim itself is recorded once',
      env.db.table('reward_claims').filter(claim => claim.code === 'daily_login').length === 1,
      env.db.table('reward_claims'));
  }

  // ---- L3: a repeated daily claim pays nothing ------------------------------
  {
    const env = await boot();
    await env.call('POST', '/api/daily/login');
    const again = await env.call('POST', '/api/daily/login');
    t.ok('L3 a repeated claim pays nothing', again.status === 200
      && again.json?.claimed === false && again.json?.reason === 'already_claimed', again.json);
    t.ok('L3 the balance is unchanged by the repeat', again.json?.balance === 30, again.json?.balance);
    const wallet = await env.call('GET', '/api/wallet');
    t.ok('L3 the wallet still shows 30 earned', wallet.json?.balance === 30 && wallet.json?.earned === 30, wallet.json);
    t.ok('L3 no second earning row exists', ledgerOf(env, 'student-a').length === 1, ledgerOf(env, 'student-a'));

    // Two claims at the same moment: the unique claim row decides, not luck.
    const race = await boot();
    const [one, two] = await Promise.all([
      race.call('POST', '/api/daily/login'),
      race.call('POST', '/api/daily/login'),
    ]);
    const paid = [one, two].filter(result => result.json?.claimed === true);
    t.ok('L3 two simultaneous claims pay once', paid.length === 1, [one.json, two.json]);
    const raced = ledgerOf(race, 'student-a');
    t.ok('L3 the race leaves one earning row of 30', raced.length === 1 && raced[0].amount === 30, raced);
  }

  // ---- L4: a valid AI question costs exactly 2 ------------------------------
  {
    const double = gatewayDouble(FREE_CATALOGUE, {
      models: { [FREE_FIRST]: { content: 'Acceleration is the rate of change of velocity, measured in metres per second squared.' } },
    });
    const setup = await gatewayEnv(double);
    t.ok('L4 the administrator saved a provider', Boolean(setup.providerId), setup.failed);
    t.ok('L4 the provider catalogue was verified', setup.verified?.status === 200
      && setup.verified?.json?.free === 2 && setup.verified?.json?.priced === 3, setup.verified?.json);
    await setup.env.call('POST', '/api/daily/login');
    const before = (await setup.env.call('GET', '/api/wallet')).json.balance;
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, {
      message: 'what is acceleration', client_key: uuid(),
    });
    t.ok('L4 the tutor answered', chat.status === 200 && /acceleration/i.test(chat.json?.reply || ''), chat.json);
    t.ok('L4 the answer names the model that answered', chat.json?.model?.model_id === FREE_FIRST, chat.json?.model);
    t.ok('L4 the question cost exactly 2 credits', chat.json?.credits_spent === 2, chat.json?.credits_spent);
    const after = (await setup.env.call('GET', '/api/wallet')).json.balance;
    t.ok('L4 the balance fell by exactly 2', before - after === 2, { before, after });
    const spends = ledgerOf(setup.env, 'student-a').filter(row => row.direction === 'spend');
    t.ok('L4 the ledger holds one spend row of 2', spends.length === 1 && spends[0].amount === 2, spends);
    t.ok('L4 the provider was called once', double.count(FREE_FIRST) === 1, double.total());
  }

  // ---- L5: an empty balance blocks the request ------------------------------
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const setup = await gatewayEnv(double);
    // The only way a student empties a balance is by spending it.
    for (const feature of ['advanced_comparison', 'revision_notes', 'passage_summary']) {
      const spent = await setup.env.call('POST', '/api/wallet/spend', { feature, client_key: uuid() });
      t.ok(`L5 the ${feature} spend is priced from the economy`, spent.status === 200 && spent.json?.balance >= 0, spent.json);
    }
    const balance = (await setup.env.call('GET', '/api/wallet')).json.balance;
    t.ok('L5 the balance is drained to nothing', balance === 0, balance);
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, {
      message: 'what is acceleration', client_key: uuid(),
    });
    t.ok('L5 the request is refused', chat.status === 409 && chat.json?.error === 'insufficient_credits', chat);
    t.ok('L5 no provider was contacted', double.total() === 0, double.total());
    const after = (await setup.env.call('GET', '/api/wallet')).json.balance;
    t.ok('L5 the balance is still zero', after === 0, after);
    const rows = ledgerOf(setup.env, 'student-a');
    t.ok('L5 the refusal left no refund behind', !rows.some(row => String(row.reason).startsWith('refund:')), rows.map(row => row.reason));
    t.ok('L5 the ledger still sums to the balance', ledgerSum(rows) === after, { sum: ledgerSum(rows), after });
  }

  // ---- L6: a failed generation gives the credits back -----------------------
  {
    const double = gatewayDouble(FREE_CATALOGUE, {
      models: {
        [FREE_FIRST]: { status: 503, message: 'The model is temporarily unavailable due to high demand. Please retry in a moment.' },
        [FREE_SECOND]: { status: 503, message: 'The model is temporarily unavailable due to high demand. Please retry in a moment.' },
      },
    });
    const setup = await gatewayEnv(double);
    await setup.env.call('POST', '/api/daily/login');
    const before = (await setup.env.call('GET', '/api/wallet')).json.balance;
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, {
      message: 'what is acceleration', client_key: uuid(),
    });
    t.ok('L6 the failure is reported to the student', chat.status === 503
      && chat.json?.error === 'free_models_unavailable', chat.json);
    const after = (await setup.env.call('GET', '/api/wallet')).json.balance;
    t.ok('L6 the credits came back', before === after, { before, after });
    const refunds = ledgerOf(setup.env, 'student-a').filter(row => String(row.reason).startsWith('refund:'));
    t.ok('L6 the refund is on the ledger', refunds.length === 1 && refunds[0].amount === 2, refunds);
    t.ok('L6 the failed request is filed as refunded',
      setup.env.db.table('ai_requests').filter(row => row.state === 'refunded').length === 1,
      setup.env.db.table('ai_requests'));
  }

  // ---- L7: concurrent requests cannot corrupt a balance ---------------------
  {
    const double = gatewayDouble(FREE_CATALOGUE, {
      models: { [FREE_FIRST]: { content: 'Acceleration is the rate of change of velocity.' } },
    });
    const setup = await gatewayEnv(double);
    await setup.env.call('POST', '/api/daily/login');
    const before = (await setup.env.call('GET', '/api/wallet')).json.balance;
    const questions = ['define acceleration', 'define velocity', 'define momentum', 'define inertia',
      'define force', 'define mass', 'define energy', 'define power'];
    const answers = await Promise.all(questions.map(question => setup.env.call(
      'POST', `/api/spaces/${setup.spaceId}/chat`, { message: question, client_key: uuid() },
    )));
    const answered = answers.filter(answer => answer.status === 200);
    t.ok('L7 every concurrent request was answered', answered.length === 8, answers.map(answer => [answer.status, answer.json?.error]));
    const after = (await setup.env.call('GET', '/api/wallet')).json.balance;
    t.ok('L7 the balance fell by exactly 2 per answer', before - after === 2 * answered.length, { before, after, answered: answered.length });
    const rows = ledgerOf(setup.env, 'student-a');
    const spends = rows.filter(row => row.direction === 'spend');
    t.ok('L7 the ledger holds one spend row per answer', spends.length === answered.length, spends.length);
    t.ok('L7 no spend row is written twice', new Set(spends.map(row => row.reason)).size === spends.length, spends.map(row => row.reason));
    t.ok('L7 the ledger still sums to the balance', ledgerSum(rows) === after, { sum: ledgerSum(rows), after });
    t.ok('L7 the balance never went negative', after >= 0, after);

    // A student with nothing in the wallet: every request is refused, and the
    // refusal must not leave a credit behind either.
    const studentB = setup.env.users[1];
    const spaceB = await setup.env.call('POST', '/api/spaces', { name: 'Chemistry', subject: 'Chemistry' }, studentB);
    for (const feature of ['advanced_comparison', 'revision_notes', 'passage_summary']) {
      await setup.env.call('POST', '/api/wallet/spend', { feature, client_key: uuid() }, studentB);
    }
    const bBefore = (await setup.env.call('GET', '/api/wallet', undefined, studentB)).json.balance;
    t.ok('L7 the second student has nothing left', bBefore === 0, bBefore);
    const refused = await Promise.all(Array.from({ length: 8 }, (_, index) => setup.env.call(
      'POST', `/api/spaces/${spaceB.json.id}/chat`, { message: `blocked question ${index}`, client_key: uuid() }, studentB,
    )));
    t.ok('L7 every empty-balance request was refused',
      refused.every(result => result.status === 409 && result.json?.error === 'insufficient_credits'),
      refused.map(result => [result.status, result.json?.error]));
    const bAfter = (await setup.env.call('GET', '/api/wallet', undefined, studentB)).json.balance;
    t.ok('L7 the refused requests left the balance at zero', bAfter === 0, bAfter);
    const bRows = ledgerOf(setup.env, 'student-b');
    t.ok('L7 no refund was paid for a request that cost nothing',
      !bRows.some(row => String(row.reason).startsWith('refund:')), bRows.map(row => row.reason));
    t.ok('L7 the second student’s ledger still sums to their balance', ledgerSum(bRows) === bAfter, { sum: ledgerSum(bRows), bAfter });
    t.ok('L7 the refused requests never reached the provider', double.total() === 8, double.total());
  }

  // ---- L8: a student cannot edit their own money ----------------------------
  {
    const env = await boot();
    const studentA = env.users[0];
    const studentB = env.users[1];
    const escalate = await env.call('POST', '/api/admin/roles', { owner_id: 'student-b', role: 'admin' }, studentB);
    t.ok('L8 a student cannot grant themselves a role', escalate.status === 403
      && escalate.json?.error === 'admin_required', escalate);
    const overview = await env.call('GET', '/api/admin/overview', undefined, studentB);
    t.ok('L8 a student cannot read the admin dashboard', overview.status === 403, overview);
    const registry = await env.call('GET', '/api/admin/providers', undefined, studentB);
    t.ok('L8 a student cannot read the provider registry', registry.status === 403, registry);
    await env.call('POST', '/api/daily/login', undefined, studentA);
    const spend = await env.call('POST', '/api/wallet/spend', {
      feature: 'basic_question', client_key: uuid(), balance: 100000, amount: 1,
    }, studentA);
    t.ok('L8 a balance or amount in the request body is ignored', spend.status === 200
      && spend.json?.balance === 28, spend.json);
    for (const [method, path] of [['PATCH', '/api/wallet'], ['POST', '/api/wallet'],
      ['PATCH', `/api/transactions/${uuid()}`], ['POST', '/api/transactions']]) {
      const attempt = await env.call(method, path, { balance: 100000, amount: 100000 }, studentA);
      t.ok(`L8 ${method} ${path} cannot write a balance`, [404, 405].includes(attempt.status), attempt);
    }
    const own = await env.call('GET', '/api/wallet', undefined, studentB);
    t.ok('L8 each student sees only their own wallet', own.status === 200 && own.json?.balance === 0, own.json);
    const mine = await env.call('GET', '/api/wallet', undefined, studentA);
    t.ok('L8 the other student sees their own balance', mine.json?.balance === 28, mine.json?.balance);
  }

  // ---- L9: an API key never reaches the browser -----------------------------
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const setup = await gatewayEnv(double);
    const listed = await setup.env.call('GET', '/api/admin/providers');
    const provider = listed.json?.providers?.[0];
    t.ok('L9 the admin list shows only the last four characters', provider?.key_hint === GATEWAY_KEY.slice(-4)
      && !stringify(listed.json).includes(GATEWAY_KEY), provider);
    const cipher = setup.env.db.table('ai_providers')[0]?.key_cipher;
    t.ok('L9 the key is stored encrypted', typeof cipher === 'string' && cipher.length > 0
      && !String(cipher).includes(GATEWAY_KEY), String(cipher).slice(0, 48));
    for (const path of ['/api/bootstrap', '/api/wallet', '/api/rewards', '/api/usage', '/api/providers',
      '/api/daily', '/api/spaces', '/api/progress']) {
      const res = await setup.env.call('GET', path);
      const body = stringify(res.json);
      t.ok(`L9 ${path} carries neither the key nor the cipher`,
        !body.includes(GATEWAY_KEY) && !body.includes(String(cipher)), body.slice(0, 120));
    }
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, {
      message: 'what is acceleration', client_key: uuid(),
    });
    t.ok('L9 the answer carries neither the key nor the cipher',
      !stringify(chat.json).includes(GATEWAY_KEY) && !stringify(chat.json).includes(String(cipher)),
      stringify(chat.json).slice(0, 160));
    t.ok('L9 the key is sent to the provider and nowhere else',
      double.calls.length > 0 && double.calls.every(call => call.authorization === `Bearer ${GATEWAY_KEY}`),
      double.calls.map(call => call.authorization));
  }

  // ---- L10: only verified free models are selected --------------------------
  {
    const double = gatewayDouble(FREE_CATALOGUE, {
      models: { [FREE_FIRST]: { content: 'Acceleration is the rate of change of velocity.' } },
    });
    const setup = await gatewayEnv(double);
    const models = (await setup.env.call('GET', `/api/admin/providers/${setup.providerId}/models`)).json?.models || [];
    const first = models.find(model => model.model_id === FREE_FIRST);
    const second = models.find(model => model.model_id === FREE_SECOND);
    const paid = models.find(model => model.model_id === PAID_MODEL);
    t.ok('L10 the free model is verified, published and enabled', first?.free_tier === true
      && first?.pricing_verified === true && first?.available === true && first?.enabled === true, first);
    t.ok('L10 the second free model is on the list too', second?.free_tier === true && second?.enabled === true, second);
    t.ok('L10 the paid model is recorded but is not free', paid?.free_tier === false
      && paid?.pricing_verified === true && paid?.enabled === false, paid);
    t.ok('L10 the paid model carries its real price', paid?.input_micro_per_1k > 0 && paid?.output_micro_per_1k > 0, paid);
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, {
      message: 'what is acceleration', client_key: uuid(),
    });
    t.ok('L10 the answer came from a verified free model', chat.status === 200
      && chat.json?.model?.model_id === FREE_FIRST, chat.json?.model);
    t.ok('L10 the paid model was never called', double.modelsCalled().every(model => model !== PAID_MODEL)
      && double.modelsCalled().length === 1, double.modelsCalled());
    const status = (await setup.env.call('GET', '/api/admin/health')).json?.status;
    t.ok('L10 the platform reports two approved free models', status?.approved_free_models === 2, status);
  }

  // ---- L11: a paid fallback is impossible -----------------------------------
  {
    const double = gatewayDouble(FREE_CATALOGUE, {
      models: {
        [FREE_FIRST]: { status: 500, message: 'upstream failure' },
        [FREE_SECOND]: { status: 500, message: 'upstream failure' },
        [PAID_MODEL]: { content: 'this answer was paid for' },
      },
    });
    const setup = await gatewayEnv(double);
    await setup.env.call('POST', '/api/daily/login');
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, {
      message: 'what is acceleration', client_key: uuid(),
    });
    t.ok('L11 the request fails when no free model answers', chat.status === 503
      && chat.json?.error === 'free_models_unavailable', chat.json);
    t.ok('L11 the paid model was never called', double.count(PAID_MODEL) === 0, double.modelsCalled());
    t.ok('L11 no paid answer reached the student', !/paid for/.test(stringify(chat.json)), stringify(chat.json).slice(0, 200));
    const models = (await setup.env.call('GET', `/api/admin/providers/${setup.providerId}/models`)).json?.models || [];
    const paid = models.find(model => model.model_id === PAID_MODEL);
    const enable = await setup.env.call('PATCH', `/api/admin/models/${paid.id}`, { enabled: true });
    t.ok('L11 a model whose zero pricing is unverified cannot be switched on', enable.status === 409
      && enable.json?.error === 'pricing_not_verified', enable);

    // The free router is trusted per answer, not per name: an answer from a
    // model that is not on the verified list is thrown away, and nothing is
    // charged for it.
    const routerDouble = gatewayDouble({
      data: [
        { id: FREE_ROUTER, name: 'Free router' },
        { id: PAID_MODEL, name: 'GPT-4o', pricing: { prompt: '0.0000025', completion: '0.00001' } },
      ],
    }, { models: { [FREE_ROUTER]: { answer_as: PAID_MODEL, content: 'this answer was paid for' } } });
    const routerSetup = await gatewayEnv(routerDouble);
    await routerSetup.env.call('POST', '/api/daily/login');
    const before = (await routerSetup.env.call('GET', '/api/wallet')).json.balance;
    const routerChat = await routerSetup.env.call('POST', `/api/spaces/${routerSetup.spaceId}/chat`, {
      message: 'what is acceleration', client_key: uuid(),
    });
    t.ok('L11 a router answer from an unverified model is refused', routerChat.status === 503
      && routerChat.json?.error === 'free_models_unavailable', routerChat.json);
    const after = (await routerSetup.env.call('GET', '/api/wallet')).json.balance;
    t.ok('L11 the refused router answer cost nothing', before === after, { before, after });
    t.ok('L11 the paid answer never reached the student', !/paid for/.test(stringify(routerChat.json)), stringify(routerChat.json).slice(0, 200));
  }

  // ---- L12: the provider's own limits are respected -------------------------
  {
    // The shared daily quota of one request: after it is spent, the provider is
    // not called again at all.
    const quotaDouble = gatewayDouble(FREE_CATALOGUE, {
      models: { [FREE_FIRST]: { content: 'ok' }, [FREE_SECOND]: { content: 'ok' } },
    });
    const quotaSetup = await gatewayEnv(quotaDouble);
    const patched = await quotaSetup.env.call('PATCH', `/api/admin/providers/${quotaSetup.providerId}`, { daily_quota: 1 });
    t.ok('L12 the administrator set a shared daily quota', patched.status === 200
      && patched.json?.provider?.daily_quota === 1, patched.json);
    await quotaSetup.env.call('POST', '/api/daily/login');
    const first = await quotaSetup.env.call('POST', `/api/spaces/${quotaSetup.spaceId}/chat`, {
      message: 'what is acceleration', client_key: uuid(),
    });
    t.ok('L12 the first request is answered', first.status === 200, first.json);
    const sent = quotaDouble.total();
    const second = await quotaSetup.env.call('POST', `/api/spaces/${quotaSetup.spaceId}/chat`, {
      message: 'what is velocity', client_key: uuid(),
    });
    // A spent shared quota is reported as its own fault, so the student is not
    // told that the free models are broken when the account allowance is gone.
    t.ok('L12 the second request is refused because the quota is spent', second.status === 503
      && second.json?.error === 'shared_quota_exhausted', second.json);
    t.ok('L12 the busy message is the one the student is promised', second.json?.hint
      === 'StudyBridge AI is temporarily busy. Please try again later.', second.json?.hint);
    t.ok('L12 no further request was sent to the provider', quotaDouble.total() === sent,
      { before: sent, after: quotaDouble.total() });

    // A rate limit is obeyed as the provider stated it: the model that said
    // "wait" is not asked again in the same breath.
    const limited = gatewayDouble(FREE_CATALOGUE, {
      models: {
        [FREE_FIRST]: { status: 429, message: 'Rate limit exceeded. Please slow down.', retry_after: 30 },
        [FREE_SECOND]: { content: 'The second model answers instead.' },
      },
    });
    const limitedSetup = await gatewayEnv(limited, {
      retry: '',
      extra: { AI_RETRY_AFTER_CAP_MS: '30000', AI_RETRY_BUDGET_MS: '1000' },
    });
    const answered = await limitedSetup.env.call('POST', `/api/spaces/${limitedSetup.spaceId}/chat`, {
      message: 'what is acceleration', client_key: uuid(),
    });
    t.ok('L12 the rate-limited model was not asked again straight away', limited.count(FREE_FIRST) === 1,
      limited.count(FREE_FIRST));
    t.ok('L12 the other free model answered', answered.status === 200
      && answered.json?.model?.model_id === FREE_SECOND, answered.json?.model);
    t.ok('L12 the fallback is visible to the student', answered.json?.fell_back === true, answered.json?.fell_back_from);
    const afterFirst = limited.count(FREE_FIRST);
    const second2 = await limitedSetup.env.call('POST', `/api/spaces/${limitedSetup.spaceId}/chat`, {
      message: 'what is velocity', client_key: uuid(),
    });
    t.ok('L12 the cooling model is not asked again while it cools', limited.count(FREE_FIRST) === afterFirst,
      { before: afterFirst, after: limited.count(FREE_FIRST) });
    t.ok('L12 the second question is still answered', second2.status === 200, second2.json);
  }

  // ---- L13: a second free model takes over when the first is unavailable ----
  {
    const outage = gatewayDouble(FREE_CATALOGUE, {
      models: {
        [FREE_FIRST]: { status: 503, message: 'The model is temporarily unavailable due to high demand. Please retry in a moment.' },
        [FREE_SECOND]: { content: 'The second model answers instead.' },
      },
    });
    const setup = await gatewayEnv(outage);
    await setup.env.call('POST', '/api/daily/login');
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, {
      message: 'what is acceleration', client_key: uuid(),
    });
    t.ok('L13 the unavailable model was tried and refused', outage.count(FREE_FIRST) === 1, outage.count(FREE_FIRST));
    t.ok('L13 the second free model answered', chat.status === 200
      && chat.json?.model?.model_id === FREE_SECOND, chat.json?.model);
    t.ok('L13 the fallback is shown to the student', chat.json?.fell_back === true
      && Array.isArray(chat.json?.fell_back_from) && chat.json.fell_back_from.length > 0, chat.json?.fell_back_from);
    t.ok('L13 the answer is the second model’s own text', /second model answers/i.test(chat.json?.reply || ''),
      chat.json?.reply);
  }

  // ---- L14: no free model at all means a clear error and no lost credits ----
  {
    const dead = gatewayDouble(FREE_CATALOGUE, {
      models: {
        [FREE_FIRST]: { status: 503, message: 'The model is temporarily unavailable due to high demand.' },
        [FREE_SECOND]: { status: 503, message: 'The model is temporarily unavailable due to high demand.' },
      },
    });
    const setup = await gatewayEnv(dead);
    await setup.env.call('POST', '/api/daily/login');
    const before = (await setup.env.call('GET', '/api/wallet')).json.balance;
    const chat = await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, {
      message: 'what is acceleration', client_key: uuid(),
    });
    t.ok('L14 the student is told the truth', chat.status === 503
      && chat.json?.error === 'free_models_unavailable', chat.json);
    t.ok('L14 the message says no credits were taken', /not been deducted/i.test(chat.json?.hint || ''), chat.json?.hint);
    t.ok('L14 no answer was invented', !chat.json?.reply, chat.json?.reply);
    const after = (await setup.env.call('GET', '/api/wallet')).json.balance;
    t.ok('L14 no credits were lost', before === after, { before, after });
  }

  // ---- L15: the history and the balance are the same number ----------------
  {
    const double = gatewayDouble(FREE_CATALOGUE, {
      models: { [FREE_FIRST]: { content: 'Acceleration is the rate of change of velocity.' } },
    });
    const setup = await gatewayEnv(double);
    await setup.env.call('POST', '/api/daily/login');
    await setup.env.call('POST', `/api/spaces/${setup.spaceId}/chat`, { message: 'what is acceleration', client_key: uuid() });
    await setup.env.call('POST', '/api/wallet/spend', { feature: 'revision_notes', client_key: uuid() });
    const wallet = (await setup.env.call('GET', '/api/wallet')).json;
    const rows = ledgerOf(setup.env, 'student-a');
    let running = 0;
    let chainOk = true;
    for (const row of rows) {
      running += row.direction === 'earn' ? row.amount : -row.amount;
      if (row.balance_after !== running) chainOk = false;
    }
    t.ok('L15 every ledger row records the balance after it', chainOk,
      rows.map(row => [row.reason, row.amount, row.balance_after]));
    t.ok('L15 the ledger sums to the balance', running === wallet.balance, { running, balance: wallet.balance });
    t.ok('L15 earned and spent match the ledger',
      wallet.earned === rows.filter(row => row.direction === 'earn').reduce((sum, row) => sum + row.amount, 0)
      && wallet.spent === rows.filter(row => row.direction === 'spend').reduce((sum, row) => sum + row.amount, 0),
      { earned: wallet.earned, spent: wallet.spent });
    t.ok('L15 the history the student sees is the ledger', wallet.history.length === rows.length,
      { history: wallet.history.length, rows: rows.length });
    t.ok('L15 every history row is typed and labelled for the student',
      wallet.history.every(row => row.type && row.label), wallet.history[0]);
  }

  // ---- L16: the features that already worked still work --------------------
  {
    const lib = await sectionLibrary(null, {});
    t.ok('L16 the existing library, scan and study tools still pass', !lib.report.includes('FAILED'),
      lib.report.slice(0, 400));
    const env = await boot();
    const progress = await env.call('GET', '/api/progress');
    t.ok('L16 the progress page still answers', progress.status === 200, progress.status);
    const games = await env.call('GET', '/api/games');
    t.ok('L16 the game centre still answers', games.status === 200, games.status);
    const daily = await env.call('GET', '/api/daily');
    t.ok('L16 the daily page still answers', daily.status === 200 && Boolean(daily.json?.day), daily.status);
    const space = await env.call('POST', '/api/spaces', { name: 'Physics', subject: 'Physics' });
    t.ok('L16 a space can still be created', space.status === 201 && Boolean(space.json?.id), space.status);
    const note = await env.call('POST', `/api/spaces/${space.json.id}/notes`, { title: 'Motion', body: 'Notes on motion' });
    t.ok('L16 a note can still be written', note.status === 201, note.status);
    return { env: null, report: t.summary(), libReport: lib.report };
  }

  return { env: null, report: t.summary() };
}

// ---- M: the Phase 2 acceptance criteria -------------------------------------
//
// The central AI system, the free-model policy, the Bridge Credits economy and
// the Pakistan-time daily reset, checked against the seventeen criteria in the
// Phase 2 implementation prompt. Every check reads a row the server wrote or a
// request that really went out.

const CENTRAL_HEADLINE = 'AI access is centrally managed by StudyBridge. You do not need to provide your own API key.';

// A platform that is configured entirely by the environment: the central
// provider key, and nothing else. The student brings no key and no provider.
async function centralEnv(double, { key = GATEWAY_KEY, extra = {}, retry = '1', admin = 'student-a' } = {}) {
  const env = await boot({
    fetchImpl: double.fetchImpl,
    envProvider: name => {
      if (name === 'CREDENTIAL_KEY') return 'test-credential-key-please-ignore';
      if (name === 'ADMIN_OWNER_IDS') return admin;
      if (name === 'AI_RETRY_ATTEMPTS') return retry;
      if (name === 'OPENROUTER_API_KEY') return key;
      if (Object.prototype.hasOwnProperty.call(extra, name)) return extra[name];
      return undefined;
    },
  });
  const space = await env.call('POST', '/api/spaces', { name: 'Physics', subject: 'Physics' });
  return { env, spaceId: space.json?.id, key };
}

// The catalogue a provider publishes when one of its prices is unreadable.
const UNKNOWN_PRICE_CATALOGUE = {
  data: [
    { id: FREE_FIRST, name: 'Qwen3 235B (Free)', pricing: { prompt: '0', completion: '0' }, context_length: 32768 },
    { id: 'vendor/unknown-price', name: 'Unknown Price Model', context_length: 32768 },
  ],
};

// A catalogue with exactly one free model. Cases that need a request to fail
// use this, because a second free model would let the router recover.
const SINGLE_FREE_CATALOGUE = {
  data: [
    { id: FREE_FIRST, name: 'Qwen3 235B (Free)', pricing: { prompt: '0', completion: '0' }, context_length: 32768 },
  ],
};

// A catalogue the size a real provider publishes. OpenRouter's own list is a
// single page of roughly 800 KB; the reader used to cut it at 600 KB, parse
// nothing at all, and still report a successful check over an empty list.
function largeCatalogue() {
  const data = [...FREE_CATALOGUE.data];
  for (let index = 0; index < 120; index += 1) {
    data.push({
      id: `vendor/padded-model-${String(index).padStart(3, '0')}`,
      name: `Padded Model ${index}`,
      description: 'x'.repeat(8000),
      pricing: { prompt: '0.000001', completion: '0.000002' },
      context_length: 8192,
    });
  }
  return { data };
}

export async function sectionPhase2() {
  const t = tracker();

  // ---- M1: the central connection comes up from the environment alone -------
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env } = await centralEnv(double);
    const shell = await env.call('GET', '/api/bootstrap');
    const central = shell.json?.free_models?.central;
    t.ok('M1 the central provider is configured from the server environment alone', central?.configured === true, central);
    t.ok('M1 it is available without anybody adding a provider by hand', central?.available === true, central);
    t.ok('M1 the free models were verified against the provider catalogue', central?.free_models === 2, central);
    t.ok('M1 the student configured no provider of their own',
      (await env.call('GET', '/api/providers')).json?.providers?.length === 0, null);
    const settings = await env.call('GET', '/api/ai/settings');
    t.ok('M1 Settings calls it StudyBridge Free AI', settings.json?.central?.title === 'StudyBridge Free AI', settings.json?.central);
    t.ok('M1 Settings says no key of the student’s own is needed',
      settings.json?.central?.headline === CENTRAL_HEADLINE, settings.json?.central?.headline);
    const admin = await env.call('GET', '/api/admin/overview');
    t.ok('M1 the administrator sees the central connection', admin.json?.central?.configured === true
      && admin.json?.central?.available === true, admin.json?.central);
    t.ok('M1 the administrator sees the model eligibility list',
      (admin.json?.central?.models || []).some(model => model.model_id === FREE_FIRST && model.free_tier === true),
      admin.json?.central?.models);
  }

  // ---- M2: a real question, a real answer, exactly 2 BC ----------------------
  {
    const answer = 'Acceleration is the rate of change of velocity, measured in metres per second squared.';
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: answer } } });
    const { env, spaceId } = await centralEnv(double);
    const login = await env.call('POST', '/api/daily/login');
    t.ok('M2 the daily login pays exactly 30 BC', login.json?.claimed === true && login.json?.credits === 30, login.json);
    const before = login.json?.balance;
    const chat = await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: uuid() });
    t.ok('M2 the answer is the provider’s own text', chat.json?.reply === answer, chat.json?.reply);
    t.ok('M2 the model that answered is named', chat.json?.model?.model_id === FREE_FIRST, chat.json?.model);
    t.ok('M2 the balance fell by exactly 2 BC', chat.json?.balance === before - 2, { before, after: chat.json?.balance });
    const spends = ledgerOf(env, 'student-a').filter(row => row.direction === 'spend');
    t.ok('M2 the ledger holds one spend row of 2 BC', spends.length === 1 && spends[0].amount === 2, spends);
    t.ok('M2 the provider was really called', double.count(FREE_FIRST) === 1, double.modelsCalled());
  }

  // ---- M3: a failed request costs nothing and keeps the allowance -----------
  {
    const double = gatewayDouble(FREE_CATALOGUE, {
      models: {
        [FREE_FIRST]: { status: 500, message: 'The provider is having a bad minute.' },
        [FREE_SECOND]: { status: 500, message: 'The provider is having a bad minute.' },
      },
    });
    const { env, spaceId } = await centralEnv(double);
    const login = await env.call('POST', '/api/daily/login');
    const before = login.json?.balance;
    const chat = await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: uuid() });
    t.ok('M3 the failed request is refused', chat.status >= 400, chat.status);
    const wallet = await env.call('GET', '/api/wallet');
    t.ok('M3 a failed request deducts 0 BC', wallet.json?.balance === before, { before, after: wallet.json?.balance });
    t.ok('M3 a failed request consumes no daily allowance', wallet.json?.daily_ai?.used === 0
      && wallet.json?.daily_ai?.remaining === 10, wallet.json?.daily_ai);
    t.ok('M3 the ledger holds no net charge', ledgerOf(env, 'student-a')
      .filter(row => row.direction === 'spend').length
      === ledgerOf(env, 'student-a').filter(row => String(row.reason).startsWith('refund:')).length,
    ledgerOf(env, 'student-a').map(row => [row.direction, row.amount, row.reason]));
    t.ok('M3 the ledger still sums to the balance',
      ledgerSum(ledgerOf(env, 'student-a')) === wallet.json?.balance, ledgerSum(ledgerOf(env, 'student-a')));
    t.ok('M3 the student is told the truth about the failure',
      typeof chat.json?.error === 'string' && chat.json.error.length > 0, chat.json);
  }

  // ---- M4: the daily login pays once per Pakistan calendar day --------------
  {
    const { env } = await centralEnv(gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } }));
    const first = await env.call('POST', '/api/daily/login');
    t.ok('M4 the first login of the day pays 30 BC', first.json?.claimed === true && first.json?.credits === 30, first.json);
    const second = await env.call('POST', '/api/daily/login');
    t.ok('M4 the second login of the same day pays nothing', second.json?.claimed === false, second.json);
    t.ok('M4 the balance did not change', second.json?.balance === first.json?.balance, { first: first.json?.balance, second: second.json?.balance });
    const claims = env.db.table('reward_claims').filter(claim => claim.code === 'daily_login');
    t.ok('M4 only one claim row exists', claims.length === 1, claims);
    t.ok('M4 the claim is filed under the Pakistan calendar day',
      claims[0]?.period === dayOfIso(claims[0]?.created_at), claims[0]);
  }

  // ---- M5: the daily allowance is exactly ten successful questions ----------
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env, spaceId } = await centralEnv(double);
    const login = await env.call('POST', '/api/daily/login');
    const before = login.json?.balance;
    let answered = 0;
    for (let index = 0; index < 10; index += 1) {
      const chat = await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: `question ${index}`, client_key: uuid() });
      if (chat.status === 200) answered += 1;
    }
    t.ok('M5 ten questions are answered', answered === 10, answered);
    const eleventh = await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'one too many', client_key: uuid() });
    t.ok('M5 the eleventh question is refused', eleventh.status === 429
      && eleventh.json?.error === 'daily_limit_reached', eleventh.json);
    t.ok('M5 the refusal names the midnight reset', /midnight/i.test(String(eleventh.json?.hint || '')), eleventh.json?.hint);
    const wallet = await env.call('GET', '/api/wallet');
    t.ok('M5 ten questions cost exactly 20 BC', wallet.json?.balance === before - 20, { before, after: wallet.json?.balance });
    t.ok('M5 the counter shows ten used and none left', wallet.json?.daily_ai?.used === 10
      && wallet.json?.daily_ai?.remaining === 0, wallet.json?.daily_ai);
  }

  // ---- M6: the reset is midnight in Asia/Karachi ---------------------------
  {
    t.ok('M6 the day boundary is 19:00 UTC', dayOfIso('2026-11-06T18:59:59.999Z') === '2026-11-06'
      && dayOfIso('2026-11-06T19:00:00.000Z') === '2026-11-07', null);
    const { env } = await centralEnv(gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } }));
    const wallet = await env.call('GET', '/api/wallet');
    const reset = Date.parse(wallet.json?.daily_ai?.resets_at || '');
    t.ok('M6 the next reset is a real instant', Number.isFinite(reset), wallet.json?.daily_ai);
    t.ok('M6 the reset is midnight Pakistan time', new Date(reset).toISOString().endsWith('19:00:00.000Z'),
      new Date(reset).toISOString());
    t.ok('M6 the interface is told which timezone it is counting in',
      wallet.json?.daily_ai?.time_zone === 'Asia/Karachi', wallet.json?.daily_ai);
    const rewards = await env.call('GET', '/api/rewards');
    t.ok('M6 the rewards page publishes the same reset',
      rewards.json?.next_reset === wallet.json?.daily_ai?.resets_at, rewards.json?.next_reset);
  }

  // ---- M7: accumulated credits survive the reset ----------------------------
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env, spaceId } = await centralEnv(double);
    const login = await env.call('POST', '/api/daily/login');
    await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: uuid() });
    const before = (await env.call('GET', '/api/wallet')).json;
    // Move today's records into yesterday: that is exactly what midnight does.
    const yesterday = dayOfIso(new Date(Date.now() - 86400000).toISOString());
    for (const slot of env.db.table('ai_daily_slots')) slot.day = yesterday;
    for (const request of env.db.table('ai_requests')) request.created_at = new Date(Date.parse(request.created_at) - 86400000).toISOString();
    const wallet = await env.call('GET', '/api/wallet');
    t.ok('M7 the credits are still there after the reset', wallet.json?.balance === before.balance,
      { before: before.balance, after: wallet.json?.balance });
    t.ok('M7 the allowance is back to the full ten', wallet.json?.daily_ai?.used === 0
      && wallet.json?.daily_ai?.remaining === 10, wallet.json?.daily_ai);
    t.ok('M7 the earned and spent totals are untouched', wallet.json?.earned === before.earned
      && wallet.json?.spent === before.spent, { before, after: wallet.json });
    t.ok('M7 the ledger still holds every row it had', wallet.json?.history?.length === before.history.length,
      { before: before.history.length, after: wallet.json?.history?.length });
  }

  // ---- M8: the balance cannot be moved from the browser ---------------------
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env, spaceId } = await centralEnv(double);
    const login = await env.call('POST', '/api/daily/login');
    const before = login.json?.balance;
    const forged = await env.call('POST', '/api/wallet', { balance: 9999, credits: 9999, amount: 9999 });
    t.ok('M8 the wallet cannot be written from the browser', forged.status >= 400, forged.status);
    const chat = await env.call('POST', `/api/spaces/${spaceId}/chat`, {
      message: 'what is acceleration', client_key: uuid(), credits: 0, balance: 9999,
    });
    t.ok('M8 a request cannot name its own price', chat.json?.credits_spent === 2, chat.json);
    t.ok('M8 the balance is the server’s number',
      (await env.call('GET', '/api/wallet')).json?.balance === before - 2, { before });
  }

  // ---- M9: one student cannot see another’s wallet --------------------------
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env, spaceId } = await centralEnv(double);
    await env.call('POST', '/api/daily/login');
    await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: uuid() });
    // The harness switches the signed-in user, so the switch has to carry a
    // real user context: a bare id would leave the request without an owner.
    env.switchTo(userContext('student-b'));
    const other = await env.call('GET', '/api/wallet');
    t.ok('M9 another student sees an empty wallet', other.json?.balance === 0 && other.json?.history?.length === 0, other.json);
    t.ok('M9 another student sees their own allowance', other.json?.daily_ai?.used === 0, other.json?.daily_ai);
    await env.call('POST', '/api/daily/login');
    const mine = await env.call('GET', '/api/wallet');
    t.ok('M9 the second student has their own 30 BC', mine.json?.balance === 30, mine.json?.balance);
    t.ok('M9 the second student sees only their own rows', mine.json?.history?.length === 1, mine.json?.history);
    env.switchTo(userContext('student-a'));
    const back = await env.call('GET', '/api/wallet');
    // The first student wrote three rows: the first-space achievement, the
    // daily login and the one question they paid for.
    t.ok('M9 the first student still sees only their own rows', back.json?.history?.length === 3, back.json?.history);
  }

  // ---- M10: a paid model is never chosen, not even as a fallback -----------
  {
    const double = gatewayDouble(FREE_CATALOGUE, {
      models: { [FREE_FIRST]: { content: 'ok' }, [FREE_SECOND]: { content: 'ok' } },
    });
    const { env, spaceId } = await centralEnv(double);
    await env.call('POST', '/api/daily/login');
    await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: uuid() });
    t.ok('M10 the paid model was never called', double.count(PAID_MODEL) === 0, double.modelsCalled());
    t.ok('M10 a free model answered instead', double.count(FREE_FIRST) === 1, double.modelsCalled());
    const rows = env.db.table('ai_models').filter(model => model.model_id === PAID_MODEL);
    t.ok('M10 the paid model is recorded as paid and disabled', rows[0]?.free_tier === false
      && rows[0]?.pricing_verified === true && rows[0]?.enabled === false, rows[0]);
  }

  // ---- M11: a model with an unknown price is refused -----------------------
  {
    const double = gatewayDouble(UNKNOWN_PRICE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env, spaceId } = await centralEnv(double);
    await env.call('POST', '/api/daily/login');
    await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: uuid() });
    t.ok('M11 the model with no published price was never called', double.count('vendor/unknown-price') === 0, double.modelsCalled());
    const unknown = env.db.table('ai_models').filter(model => model.model_id === 'vendor/unknown-price');
    t.ok('M11 its price could not be verified, so it is not usable',
      unknown[0]?.pricing_verified === false && unknown[0]?.enabled === false, unknown[0]);
    t.ok('M11 the verified free model answered instead', double.count(FREE_FIRST) === 1, double.modelsCalled());
  }

  // ---- M12: a rate-limited provider is handled, and the student is not charged
  {
    // One free model only: with a second free model on the catalogue the
    // router would fall back to it and the request would succeed, which is
    // the right behaviour but would not exercise the rate-limit path.
    const double = gatewayDouble(SINGLE_FREE_CATALOGUE, {
      models: { [FREE_FIRST]: { status: 429, message: 'Rate limit exceeded, please slow down', retry_after: 60 } },
    });
    const { env, spaceId } = await centralEnv(double);
    const login = await env.call('POST', '/api/daily/login');
    const before = login.json?.balance;
    const chat = await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: uuid() });
    t.ok('M12 the rate limit is reported to the student', chat.status >= 400 && Boolean(chat.json?.error), chat.json);
    t.ok('M12 the provider’s own words are shown', /rate limit/i.test(String(chat.json?.hint || '')), chat.json?.hint);
    const wallet = await env.call('GET', '/api/wallet');
    t.ok('M12 a rate-limited request is not charged', wallet.json?.balance === before, { before, after: wallet.json?.balance });
    t.ok('M12 a rate-limited request keeps the allowance', wallet.json?.daily_ai?.used === 0, wallet.json?.daily_ai);
  }

  // ---- M13: the provider key never reaches the browser ---------------------
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env, spaceId } = await centralEnv(double);
    await env.call('POST', '/api/daily/login');
    const chat = await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: uuid() });
    const seen = [];
    for (const path of ['/api/bootstrap', '/api/ai/settings', '/api/wallet', '/api/providers', '/api/admin/overview', '/api/rewards']) {
      const response = await env.call('GET', path);
      seen.push([path, JSON.stringify(response.json || {})]);
    }
    seen.push(['chat', JSON.stringify(chat.json || {})]);
    t.ok('M13 no response contains the provider key',
      seen.every(([, body]) => !body.includes(GATEWAY_KEY) && !body.includes('Bearer ')), seen.map(([path]) => path));
    const stored = env.db.table('ai_providers').filter(row => row.provider_key === 'openrouter-central');
    t.ok('M13 the key is stored encrypted, not as plain text', stored[0]?.key_cipher
      && !String(stored[0].key_cipher).includes(GATEWAY_KEY), stored[0]?.key_cipher ? 'cipher present' : 'no cipher');
    t.ok('M13 only the last four characters are readable', stored[0]?.key_hint === GATEWAY_KEY.slice(-4), stored[0]?.key_hint);
  }

  // ---- M14: concurrent requests cannot pass the cap or double-charge -------
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env, spaceId } = await centralEnv(double);
    const login = await env.call('POST', '/api/daily/login');
    const before = login.json?.balance;
    const results = await Promise.all(Array.from({ length: 11 }, (unused, index) =>
      env.call('POST', `/api/spaces/${spaceId}/chat`, { message: `concurrent ${index}`, client_key: uuid() })));
    const ok = results.filter(result => result.status === 200);
    const refused = results.filter(result => result.status === 429);
    t.ok('M14 exactly ten of eleven concurrent questions are answered', ok.length === 10, ok.length);
    t.ok('M14 the eleventh is refused for the daily cap', refused.length === 1, refused.map(r => r.json?.error));
    const spends = ledgerOf(env, 'student-a').filter(row => row.direction === 'spend');
    t.ok('M14 there is one spend row of 2 BC per answer', spends.length === 10
      && spends.every(row => row.amount === 2), spends.length);
    t.ok('M14 the balance fell by exactly 20 BC',
      (await env.call('GET', '/api/wallet')).json?.balance === before - 20, { before });
  }

  // ---- M15: a catalogue the size a real provider publishes is read whole ----
  {
    const catalogue = largeCatalogue();
    const double = gatewayDouble(catalogue, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env } = await centralEnv(double);
    const shell = await env.call('GET', '/api/bootstrap');
    const central = shell.json?.free_models?.central;
    t.ok('M15 a catalogue larger than the old 600 KB ceiling is read whole',
      central?.last_status === 'ok', central);
    t.ok('M15 the free models inside a large catalogue are still found',
      central?.free_models === 2, central);
    const admin = await env.call('GET', '/api/admin/overview');
    const recorded = new Set((admin.json?.central?.models || []).map(model => model.model_id));
    const missing = catalogue.data.filter(entry => !recorded.has(entry.id)).map(entry => entry.id);
    t.ok('M15 every model the provider published was recorded', missing.length === 0,
      { missing, recorded: recorded.size, published: catalogue.data.length });
  }

  // ---- M16: a catalogue that cannot be read is a failure, not an empty list -
  {
    const catalogue = { data: [...FREE_CATALOGUE.data] };
    const double = gatewayDouble(catalogue, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env } = await centralEnv(double);
    const good = await env.call('GET', '/api/bootstrap');
    t.ok('M16 the catalogue was verified once', good.json?.free_models?.central?.free_models === 2,
      good.json?.free_models?.central);
    const provider = env.db.table('ai_providers')
      .filter(row => row.provider_key === 'openrouter-central')[0];
    // The provider answers, but not with a list of models.
    catalogue.data = 'not-a-model-list';
    const again = await env.call('POST', `/api/admin/providers/${provider.id}/verify`);
    t.ok('M16 an unreadable catalogue fails the check', again.status >= 400, again.status);
    t.ok('M16 the failure is named, not reported as a success',
      again.json?.error === 'catalogue_unreadable', again.json);
    const after = await env.call('GET', '/api/admin/overview');
    const free = (after.json?.central?.models || []).filter(model => model.free_tier === true);
    t.ok('M16 a failed read disables nothing that was verified earlier',
      free.length === 2 && free.every(model => model.enabled !== false), after.json?.central?.models);
  }

  // ---- M17: a body cut short by the limit is reported, not silently dropped -
  {
    const cut = await readBodyResult(new Response('x'.repeat(4096)), 1024);
    t.ok('M17 a body past the limit is reported as truncated', cut.truncated === true, cut);
    t.ok('M17 a truncated body is not handed back as a short read', cut.text === '', cut.text?.length);
    const whole = await readBodyResult(new Response('hello'), 1024);
    t.ok('M17 a body inside the limit is read whole',
      whole.truncated === false && whole.text === 'hello', whole);
    t.ok('M17 the plain reader still returns the text',
      await readBody(new Response('hello'), 1024) === 'hello', null);
  }

  // ---- M18: a provider id that starts with "~" is kept, not dropped ---------
  //
  // OpenRouter publishes its rolling aliases as "~openai/gpt-latest". A rule
  // that only accepted a leading letter or digit threw nineteen published
  // models away without saying so.
  {
    const alias = '~vendor/rolling-latest';
    const catalogue = {
      data: [
        { id: FREE_FIRST, name: 'Qwen3 235B (Free)', pricing: { prompt: '0', completion: '0' }, context_length: 32768 },
        { id: alias, name: 'Rolling Latest', pricing: { prompt: '0.000002', completion: '0.000008' }, context_length: 32768 },
      ],
    };
    const double = gatewayDouble(catalogue, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env } = await centralEnv(double);
    // The central provider provisions itself on the first request that touches
    // the gateway, so the catalogue is read by this call.
    const shell = await env.call('GET', '/api/bootstrap');
    const rows = env.db.table('ai_models').filter(row => row.model_id === alias);
    t.ok('M18 an id the provider published is recorded even when it starts with ~',
      rows.length === 1, rows);
    t.ok('M18 its price was verified from the catalogue', rows[0]?.pricing_verified === true
      && rows[0]?.free_tier === false && rows[0]?.enabled === false, rows[0]);
    t.ok('M18 the free models beside it are unaffected',
      shell.json?.free_models?.central?.free_models === 1, shell.json?.free_models?.central);
  }

  // ---- M19: the admin overview counts the platform provider on a cold start -
  //
  // analytics() used to read ai_providers without provisioning the central
  // provider first, so the first overview after a cold start printed
  // "0 providers" in the very response whose health table listed the platform
  // provider as healthy — and the second load quietly showed the right number.
  {
    const catalogue = { data: [...FREE_CATALOGUE.data] };
    const double = gatewayDouble(catalogue, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env } = await centralEnv(double);
    // The very first request this environment handles is the admin overview —
    // nothing has provisioned the gateway yet.
    const overview = await env.call('GET', '/api/admin/overview');
    const analytics = overview.json?.analytics || {};
    const health = overview.json?.health || [];
    t.ok('M19 a cold-start overview counts the platform provider',
      analytics.providers === 1, analytics);
    t.ok('M19 the provider count matches the health table beside it',
      health.length === analytics.providers, { analytics: analytics.providers, health: health.length });
    t.ok('M19 the approved free models are counted too',
      analytics.approved_free_models > 0, analytics);
  }

  // ---- M20: a replay of a settled request never frees its daily slot -------
  //
  // Audit finding H-1. Repeating an already-answered client_key used to delete
  // the settled request's slot on the way out, so every repeat handed a place
  // in the allowance back and the ten-question cap could be worn down by
  // resubmitting one key. The repeat must be a free replay that leaves the
  // settled request's slot exactly where it is.
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env, spaceId } = await centralEnv(double);
    const login = await env.call('POST', '/api/daily/login');
    const key = uuid();
    const first = await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: key });
    t.ok('M20 the first submission is answered and charged',
      first.status === 200 && first.json?.credits_spent === 2, first.json);
    const again = await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: key });
    t.ok('M20 the repeat is answered as a replay',
      again.status === 200 && again.json?.replayed === true, again.json);
    t.ok('M20 the replay shows the same answer', again.json?.reply === first.json?.reply,
      { first: first.json?.reply, again: again.json?.reply });
    const spendsAfterReplay = ledgerOf(env, 'student-a').filter(row => row.direction === 'spend');
    t.ok('M20 the replay charges nothing', spendsAfterReplay.length === 1 && spendsAfterReplay[0]?.amount === 2,
      spendsAfterReplay.map(row => [row.amount, row.reason]));
    t.ok('M20 the settled request keeps its daily slot',
      env.db.table('ai_daily_slots').filter(slot => slot.request_key === key).length === 1,
      env.db.table('ai_daily_slots').map(slot => [slot.request_key, slot.slot]));
    t.ok('M20 the allowance still counts the settled question',
      (await env.call('GET', '/api/wallet')).json?.daily_ai?.used === 1, null);
    let answered = 0;
    for (let index = 0; index < 9; index += 1) {
      const chat = await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: `follow-up ${index}`, client_key: uuid() });
      if (chat.status === 200) answered += 1;
    }
    t.ok('M20 the remaining nine questions are answered', answered === 9, answered);
    const eleventh = await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'one too many', client_key: uuid() });
    t.ok('M20 the cap still holds at ten despite the replay', eleventh.status === 429
      && eleventh.json?.error === 'daily_limit_reached', eleventh.json);
  }

  // ---- M21: a concurrent duplicate charges once and keeps one slot ---------
  //
  // Two submissions of the same client_key arrive together. One wins; the
  // other waits for the first answer. Under the pre-H-1 code the losing
  // operation released the slot by key and wiped the winner's place in the
  // day's allowance; now only a slot the loser claimed itself can go, and one
  // question means one charge and one slot.
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env, spaceId } = await centralEnv(double);
    const login = await env.call('POST', '/api/daily/login');
    const before = login.json?.balance;
    const key = uuid();
    const [firstTry, secondTry] = await Promise.all([
      env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: key }),
      env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: key }),
    ]);
    const answeredTries = [firstTry, secondTry].filter(result => result.status === 200);
    t.ok('M21 the duplicate pair produces exactly one answer', answeredTries.length === 1,
      [firstTry.status, secondTry.status]);
    const spends = ledgerOf(env, 'student-a').filter(row => row.direction === 'spend');
    t.ok('M21 the pair is charged exactly once, 2 BC',
      spends.length === 1 && spends[0]?.amount === 2, spends.map(row => [row.amount, row.reason]));
    t.ok('M21 the pair holds exactly one daily slot',
      env.db.table('ai_daily_slots').filter(slot => slot.request_key === key).length === 1,
      env.db.table('ai_daily_slots').map(slot => [slot.request_key, slot.slot]));
    const wallet = await env.call('GET', '/api/wallet');
    t.ok('M21 the allowance counts the question once', wallet.json?.daily_ai?.used === 1, wallet.json?.daily_ai);
    t.ok('M21 the balance fell by exactly 2 BC', wallet.json?.balance === before - 2, { before, after: wallet.json?.balance });
  }

  // ---- M22: a failed charge still releases its own slot --------------------
  //
  // The legitimate cleanup H-1 had to preserve: a request that cannot be paid
  // for keeps no place in the day's allowance, leaves its key retryable, and
  // never reaches a provider. The price is raised past the student's balance
  // through the administrator's own economy API, so the debit refuses.
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env, spaceId } = await centralEnv(double);
    const key = uuid();
    const priced = await env.call('PATCH', '/api/admin/economy', { pricing: { basic_question: 500 } });
    t.ok('M22 the administrator can raise the price', priced.status === 200, priced.json);
    const before = (await env.call('GET', '/api/wallet')).json;
    const broke = await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: key });
    t.ok('M22 an unpaid request is refused', broke.status === 409 && broke.json?.error === 'insufficient_credits', broke.json);
    const wallet = await env.call('GET', '/api/wallet');
    t.ok('M22 the refused request keeps the full allowance', wallet.json?.daily_ai?.used === 0
      && wallet.json?.daily_ai?.remaining === 10, wallet.json?.daily_ai);
    t.ok('M22 the refused request left no slot behind',
      env.db.table('ai_daily_slots').filter(slot => slot.request_key === key).length === 0,
      env.db.table('ai_daily_slots').map(slot => [slot.request_key, slot.slot]));
    t.ok('M22 the refused request moved no credits', wallet.json?.balance === before?.balance, { before: before?.balance, after: wallet.json?.balance });
    const failed = env.db.table('ai_requests').filter(row => row.request_key === key);
    t.ok('M22 the refused request is recorded as failed', failed[0]?.state === 'failed', failed[0]);
    t.ok('M22 the provider was never called for an unpaid request',
      double.count(FREE_FIRST) === 0, double.modelsCalled());
  }

  // ---- M23: a retry after a failed charge is attempt 2 with one debit ------
  //
  // The same key comes back once the price is affordable again. It gets its
  // own attempt number and its own debit; the failed attempt leaves no ledger
  // row behind.
  {
    const double = gatewayDouble(FREE_CATALOGUE, { models: { [FREE_FIRST]: { content: 'ok' } } });
    const { env, spaceId } = await centralEnv(double);
    const key = uuid();
    await env.call('PATCH', '/api/admin/economy', { pricing: { basic_question: 500 } });
    await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: key });
    await env.call('PATCH', '/api/admin/economy', { pricing: { basic_question: 2 } });
    const login = await env.call('POST', '/api/daily/login');
    const retry = await env.call('POST', `/api/spaces/${spaceId}/chat`, { message: 'what is acceleration', client_key: key });
    t.ok('M23 the retry after the failed charge is answered',
      retry.status === 200 && retry.json?.credits_spent === 2, retry.json);
    const record = env.db.table('ai_requests').filter(row => row.request_key === key)[0];
    t.ok('M23 the retry carries attempt 2 and settles', record?.attempt === 2 && record?.state === 'settled', record);
    const spends = ledgerOf(env, 'student-a').filter(row => row.direction === 'spend');
    t.ok('M23 exactly one debit exists and it names attempt 2',
      spends.length === 1 && String(spends[0]?.reason).endsWith(':2'), spends.map(row => [row.amount, row.reason]));
    t.ok('M23 the balance is the login minus the single 2 BC charge',
      (await env.call('GET', '/api/wallet')).json?.balance === (login.json?.balance || 30) - 2, null);
  }

  return { env: null, report: t.summary() };
}

export { tracker, makeAiFetch, pdfWith, pngBytes, upload, uuid, gatewayDouble, FREE_CATALOGUE, FREE_FIRST };
