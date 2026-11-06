// My Library and the Smart Scanner. Uploads are Storage objects the Function
// signs, verifies and owns; extraction is either the PDF text layer or a vision
// model, and every page keeps its source reference.
import { LIMITS, clamp, dayOf, nowIso, text as asText, truncate, uuid as asUuid } from '../util.mjs';
import { extractPdfPages, isPdf } from '../pdf.mjs';
import { parseContents } from '../toc.mjs';
import { parseJsonBlock, readBody } from '../ai.mjs';

const BOOK_SOURCES = ['manual', 'search', 'cover_scan', 'upload', 'link', 'note'];
const STAGES = ['cover', 'contents', 'chapter', 'page', 'note'];

function safeName(value) {
  const cleaned = String(value || 'upload').replace(/[^\w.\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 80);
  return cleaned || 'upload';
}

function looksLikePdf(bytes) {
  try { return isPdf(bytes); } catch { return false; }
}

const COVER_PROMPT = 'Look at this textbook cover photograph. Report ONLY what is actually visible as JSON: {"title":"","subtitle":"","author":"","publisher":"","edition":"","year":0,"language":"","confidence":{"title":0,"author":0,"publisher":0,"edition":0},"notes":""}. Use empty strings for anything you cannot read. Do not guess a book from the artwork.';
const TOC_PROMPT = 'This is a textbook table of contents. Return ONLY a JSON array: [{"number":1,"title":"Chapter name","page":12,"topics":["subtopic"]}]. Include every entry you can read, in order, with the printed page number when visible. Do not invent entries.';
const PAGE_PROMPT = 'Transcribe the printed text of this textbook page exactly. Return ONLY JSON: {"text":"...","confidence":0-100,"equations":["..."],"figures":["short captions"]}. Keep headings, symbols and units. Do not answer, summarise or correct the book.';

export function createLibrary({ add, db, fail, rows, storage, ai, rewards, verifyUploadedObject }) {
  // Scanner stages are core learning tools and cost 0 Bridge Credits. They are
  // still written to the request log, so an administrator can see what ran and
  // what failed without a student ever being charged for scanning.
  async function freeModelCall(user, feature, run) {
    const reservation = await rewards.reserveAi(user.id, { feature, requestKey: '', credits: 0, label: feature });
    try {
      const result = await run();
      await rewards.settleAi(user.id, reservation.key, {
        providerKey: result?.result?.provider?.provider_key || '',
        modelId: result?.result?.model?.model_id || '',
        statusCode: 200,
        detail: feature,
      });
      return result;
    } catch (error) {
      await rewards.refundAi(user.id, reservation.key, { reason: error?.code || 'failed', feature });
      throw error;
    }
  }
  const bookColumns = 'id,title,author,subject,publisher,edition,publication_year,cover_object_path,external_url,source,verified,chapters_ready,created_at,updated_at';
  const docColumns = 'id,book_id,space_id,file_name,kind,mime,size,stage,status,extraction,created_at,updated_at';
  // Storage paths stay server-side; only this query needs them.
  const docColumnsPrivate = `${docColumns},object_path`;

  async function ownedBook(user, id) {
    const key = asUuid(id) || fail('invalid_input', 400);
    const found = rows(await db.from('books').select(bookColumns).eq('id', key).eq('owner_id', user.id).limit(1));
    if (!found?.length) fail('book_not_found', 404);
    return found[0];
  }

  async function ownedDoc(user, id) {
    const key = asUuid(id) || fail('invalid_input', 400);
    const found = rows(await db.from('documents').select(docColumnsPrivate).eq('id', key).eq('owner_id', user.id).limit(1));
    if (!found?.length) fail('not_found', 404);
    return found[0];
  }

  async function objectBytes(document) {
    let response;
    try { response = await storage.download(document.object_path); }
    catch (error) { if (error?.code === 'storage_object_not_found') fail('upload_pending', 409); throw error; }
    if (!response?.ok) fail('storage_unavailable', 503);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length) fail('upload_pending', 409);
    return bytes;
  }

  async function dataUrl(document, bytes) {
    if (bytes.length > 5 * 1024 * 1024) fail('invalid_upload', 422, 'Photographs sent to a vision model must stay under 5 MB.');
    const mime = document.mime || 'image/jpeg';
    let binary = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + step, bytes.length)));
    }
    return `data:${mime};base64,${btoa(binary)}`;
  }

  add('GET', '/api/books', async ({ user, query }) => {
    const raw = String(query.get('q') || '').trim().toLowerCase().slice(0, 60);
    const subject = String(query.get('subject') || '').trim().toLowerCase().slice(0, 40);
    const found = rows(await db.from('books').select(bookColumns).eq('owner_id', user.id)
      .order('updated_at', { ascending: false }).limit(200)) || [];
    const chapters = rows(await db.from('chapters').select('book_id,status,number,title').eq('owner_id', user.id).limit(600)) || [];
    const links = rows(await db.from('book_links').select('book_id,space_id').eq('owner_id', user.id).limit(600)) || [];
    const docs = rows(await db.from('documents').select('book_id,status,kind').eq('owner_id', user.id).limit(600)) || [];
    const perChapter = new Map();
    for (const row of chapters) {
      const entry = perChapter.get(row.book_id) || { total: 0, done: 0, items: [] };
      entry.total += 1;
      if (row.status === 'done') entry.done += 1;
      entry.items.push(row);
      perChapter.set(row.book_id, entry);
    }
    const perLink = new Map();
    for (const link of links) {
      const list = perLink.get(link.book_id) || [];
      list.push(link.space_id);
      perLink.set(link.book_id, list);
    }
    const perDoc = new Map();
    for (const doc of docs) perDoc.set(doc.book_id, (perDoc.get(doc.book_id) || 0) + 1);
    let items = found.map(book => ({
      ...book,
      chapters: perChapter.get(book.id)?.total || 0,
      chaptersDone: perChapter.get(book.id)?.done || 0,
      spaces: perLink.get(book.id) || [],
      documents: perDoc.get(book.id) || 0,
    }));
    if (raw) {
      items = items.filter(book => [book.title, book.author, book.subject, book.publisher]
        .some(field => String(field || '').toLowerCase().includes(raw)));
    }
    if (subject) items = items.filter(book => String(book.subject || '').toLowerCase() === subject);
    return Response.json({ items, total: items.length });
  });

  add('GET', '/api/books/:book_id', async ({ user, params }) => {
    const book = await ownedBook(user, params.book_id);
    const chapters = rows(await db.from('chapters')
      .select('id,number,title,summary,position,status,pages_extracted,completed_at')
      .eq('owner_id', user.id).eq('book_id', book.id).order('position', { ascending: true }).limit(200)) || [];
    const documents = rows(await db.from('documents')
      .select('id,file_name,kind,mime,size,stage,status,created_at')
      .eq('owner_id', user.id).eq('book_id', book.id).order('created_at', { ascending: false }).limit(60)) || [];
    const links = rows(await db.from('book_links').select('space_id').eq('owner_id', user.id).eq('book_id', book.id).limit(40)) || [];
    const spaces = links.length ? rows(await db.from('spaces').select('id,name,subject,color')
      .eq('owner_id', user.id).in('id', links.map(l => l.space_id)).limit(40)) || [] : [];
    const pageCount = rows(await db.from('pages').select('id').eq('owner_id', user.id).eq('book_id', book.id).limit(400)) || [];
    return Response.json({ book, chapters, documents, spaces, pages: pageCount.length });
  });

  add('POST', '/api/books', async ({ user, body }) => {
    const input = await body();
    const title = asText(input.title, { max: 160, min: 1, allowEmpty: false }) || fail('title_required', 400);
    const id = crypto.randomUUID();
    rows(await db.from('books').insert({
      id, owner_id: user.id, title,
      author: asText(input.author, { max: 120 }) ?? '',
      subject: asText(input.subject, { max: 80 }) ?? '',
      publisher: asText(input.publisher, { max: 120 }) ?? '',
      edition: asText(input.edition, { max: 60 }) ?? '',
      publication_year: clamp(Number(input.publication_year) || 0, 0, 2100),
      cover_object_path: asText(input.cover_object_path, { max: 200 }) ?? '',
      external_url: /^https:\/\//.test(String(input.external_url || '')) ? String(input.external_url).slice(0, 300) : '',
      source: BOOK_SOURCES.includes(input.source) ? input.source : 'manual',
      verified: input.source === 'manual' ? { manual: true } : { manual: false, corrected: false },
      chapters_ready: false, created_at: nowIso(), updated_at: nowIso(),
    }));
    const created = rows(await db.from('books').select(bookColumns).eq('id', id).eq('owner_id', user.id).limit(1))?.[0];
    if (!created) fail('database_unavailable', 503);
    await rewards.grantAchievement(user.id, 'first_book');
    return Response.json(created, { status: 201 });
  });

  add('PATCH', '/api/books/:book_id', async ({ user, params, body }) => {
    const book = await ownedBook(user, params.book_id);
    const input = await body();
    const patch = { updated_at: nowIso() };
    const fields = {
      title: 160, author: 120, subject: 80, publisher: 120, edition: 60, cover_object_path: 200,
    };
    for (const [field, max] of Object.entries(fields)) {
      if (input[field] !== undefined) patch[field] = asText(input[field], { max, allowEmpty: field !== 'title', min: field === 'title' ? 1 : 0 }) ?? patch[field];
      if (input[field] !== undefined && patch[field] === undefined) fail('invalid_input', 400);
    }
    if (input.publication_year !== undefined) patch.publication_year = clamp(Number(input.publication_year) || 0, 0, 2100);
    if (input.external_url !== undefined) patch.external_url = /^https:\/\//.test(String(input.external_url)) ? String(input.external_url).slice(0, 300) : '';
    if (input.corrected === true) patch.verified = { ...(book.verified || {}), manual: true, corrected: true };
    const updated = rows(await db.from('books').update(patch).eq('id', book.id).eq('owner_id', user.id).select(bookColumns));
    if (!updated?.length) fail('write_conflict', 409);
    return Response.json(updated[0]);
  });

  add('DELETE', '/api/books/:book_id', async ({ user, params }) => {
    const book = await ownedBook(user, params.book_id);
    const documents = rows(await db.from('documents').select('object_path').eq('owner_id', user.id).eq('book_id', book.id).limit(100)) || [];
    for (const table of ['pages', 'chapters', 'book_links', 'documents']) {
      await db.from(table).delete().eq('owner_id', user.id).eq('book_id', book.id);
    }
    for (const doc of documents) {
      try { await storage.remove([doc.object_path]); } catch { /* orphan objects are cleaned by the owner */ }
    }
    const deleted = rows(await db.from('books').delete().eq('id', book.id).eq('owner_id', user.id).select('id'));
    if (!deleted?.length) fail('write_conflict', 409);
    return Response.json({ ok: true, id: book.id, removed_objects: documents.length });
  });

  add('POST', '/api/books/:book_id/chapters', async ({ user, params, body }) => {
    const book = await ownedBook(user, params.book_id);
    const input = await body();
    const list = Array.isArray(input.chapters) ? input.chapters.slice(0, 120) : [];
    if (!list.length) fail('invalid_input', 400);
    let added = 0;
    let position = (rows(await db.from('chapters').select('position').eq('owner_id', user.id).eq('book_id', book.id)
      .order('position', { ascending: false }).limit(1))?.[0]?.position) || 0;
    for (const item of list) {
      const title = asText(item.title, { max: 160, min: 1, allowEmpty: false });
      if (!title) continue;
      const number = clamp(Number(item.number) || 0, 0, 500);
      position += 1;
      const result = rows(await db.from('chapters').insertIfAbsent({
        id: crypto.randomUUID(), owner_id: user.id, book_id: book.id, number, title,
        summary: asText(item.summary, { max: 600 }) ?? '', position, status: 'todo', pages_extracted: 0,
        created_at: nowIso(),
      }, { onConflict: 'owner_id,book_id,number,title' }).select('id'));
      if (result?.length) added += 1;
    }
    rows(await db.from('books').update({ chapters_ready: true, updated_at: nowIso() }).eq('id', book.id).eq('owner_id', user.id).select('id'));
    return Response.json({ added, book_id: book.id });
  });

  add('PATCH', '/api/chapters/:chapter_id', async ({ user, params, body }) => {
    const chapterId = asUuid(params.chapter_id) || fail('invalid_input', 400);
    const found = rows(await db.from('chapters').select('id,book_id,status').eq('id', chapterId).eq('owner_id', user.id).limit(1));
    if (!found?.length) fail('chapter_not_found', 404);
    const input = await body();
    const patch = {};
    if (input.title !== undefined) patch.title = asText(input.title, { max: 160, min: 1, allowEmpty: false }) || fail('invalid_input', 400);
    if (input.summary !== undefined) patch.summary = asText(input.summary, { max: 600 }) ?? '';
    if (input.status !== undefined) {
      if (!['todo', 'scanning', 'studying', 'done'].includes(input.status)) fail('invalid_input', 400);
      patch.status = input.status;
      if (input.status === 'done') patch.completed_at = nowIso();
    }
    const updated = rows(await db.from('chapters').update(patch).eq('id', chapterId).eq('owner_id', user.id).select('id,status,title,summary'));
    if (!updated?.length) fail('write_conflict', 409);
    if (patch.status === 'done') await rewards.grantAchievement(user.id, 'chapter_finished');
    return Response.json(updated[0]);
  });

  add('DELETE', '/api/chapters/:chapter_id', async ({ user, params }) => {
    const chapterId = asUuid(params.chapter_id) || fail('invalid_input', 400);
    await db.from('pages').update({ chapter_id: null }).eq('owner_id', user.id).eq('chapter_id', chapterId);
    const deleted = rows(await db.from('chapters').delete().eq('id', chapterId).eq('owner_id', user.id).select('id'));
    if (!deleted?.length) fail('not_found', 404);
    return Response.json({ ok: true });
  });

  add('GET', '/api/chapters/:chapter_id/pages', async ({ user, params }) => {
    const chapterId = asUuid(params.chapter_id) || fail('invalid_input', 400);
    const found = rows(await db.from('chapters').select('id,book_id,title,number').eq('id', chapterId).eq('owner_id', user.id).limit(1));
    if (!found?.length) fail('chapter_not_found', 404);
    const pages = rows(await db.from('pages').select('id,page_number,text,extraction,confidence,document_id')
      .eq('owner_id', user.id).eq('chapter_id', chapterId).order('page_number', { ascending: true }).limit(80)) || [];
    return Response.json({ chapter: found[0], pages });
  });

  add('GET', '/api/books/:book_id/search', async ({ user, params, query }) => {
    const book = await ownedBook(user, params.book_id);
    const needle = String(query.get('q') || '').trim().toLowerCase().slice(0, 60);
    if (needle.length < 2) fail('invalid_input', 400);
    const pages = rows(await db.from('pages').select('id,chapter_id,page_number,text')
      .eq('owner_id', user.id).eq('book_id', book.id).order('page_number', { ascending: true }).limit(300)) || [];
    const hits = [];
    for (const page of pages) {
      const index = String(page.text || '').toLowerCase().indexOf(needle);
      if (index < 0) continue;
      hits.push({
        page: page.page_number,
        chapter_id: page.chapter_id,
        excerpt: truncate(String(page.text).slice(Math.max(0, index - 90), index + 180), 300),
      });
      if (hits.length >= 20) break;
    }
    return Response.json({ book_id: book.id, query: needle, hits });
  });

  // ---- uploads ------------------------------------------------------------
  add('POST', '/api/uploads/prepare', async ({ user, body }) => {
    const input = await body();
    const kind = ['image', 'pdf'].includes(input.kind) ? input.kind : fail('invalid_upload', 422);
    const mime = asText(input.mime, { max: 60 }) || fail('invalid_upload', 422);
    const allowed = kind === 'pdf' ? LIMITS.pdf.types : LIMITS.image.types;
    if (!allowed.includes(mime)) fail('invalid_upload', 422, `Only ${allowed.join(', ')} accepted.`);
    const size = Number(input.size);
    const maxBytes = kind === 'pdf' ? LIMITS.pdf.maxBytes : LIMITS.image.maxBytes;
    if (!Number.isSafeInteger(size) || size <= 0 || size > maxBytes) fail('payload_too_large', 413);
    const stage = STAGES.includes(input.stage) ? input.stage : 'page';
    const bookId = asUuid(input.book_id);
    const spaceId = asUuid(input.space_id);
    if (bookId) await ownedBook(user, bookId);
    const id = crypto.randomUUID();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(user.id));
    const ownerTag = [...new Uint8Array(digest)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
    const objectPath = `uploads/${ownerTag}/${id}/${safeName(input.file_name)}`;
    rows(await db.from('documents').insert({
      id, owner_id: user.id, book_id: bookId, space_id: spaceId, object_path: objectPath,
      file_name: safeName(input.file_name), kind, mime, size, stage, status: 'pending', extraction: {},
      created_at: nowIso(), updated_at: nowIso(),
    }));
    const signed = await storage.createSignedUploadUrl(objectPath, { upsert: false });
    return Response.json({ document_id: id, object_path: objectPath, signed_url: signed.signedUrl || signed.signedURL, expires_in: 600, max_bytes: maxBytes }, { status: 201 });
  });

  add('POST', '/api/uploads/:document_id/complete', async ({ user, params }) => {
    const document = await ownedDoc(user, params.document_id);
    const limits = document.kind === 'pdf' ? LIMITS.pdf : LIMITS.image;
    let stored;
    try { stored = await storage.download(document.object_path); }
    catch (error) {
      if (error?.code === 'storage_object_not_found') fail('upload_pending', 409);
      fail('storage_unavailable', 503);
    }
    if (!stored?.ok || !stored.body) fail('upload_pending', 409);
    const storedType = stored.headers.get('content-type') || '';
    const bytes = new Uint8Array(await stored.arrayBuffer());
    if (bytes.length > limits.maxBytes) fail('payload_too_large', 413);
    // The PDF header check reads the bytes actually stored, not a declared type.
    if (document.kind === 'pdf' && !looksLikePdf(bytes)) fail('invalid_upload', 422, 'That file is not a valid PDF.');
    // The stored object is already in memory; verification re-measures those exact
    // bytes against the size the client declared and the stored MIME metadata.
    let verified;
    try {
      verified = await verifyUploadedObject(new Response(new Uint8Array(bytes), { headers: { 'content-type': storedType } }), {
        maxBytes: limits.maxBytes,
        expectedBytes: document.size,
        allowedContentTypes: limits.types,
      });
    } catch {
      fail('invalid_upload', 422, 'The stored file did not match the upload you started. Try again.');
    }
    const updated = rows(await db.from('documents').update({ status: 'ready', size: verified.size, mime: verified.contentType, updated_at: nowIso() })
      .eq('id', document.id).eq('owner_id', user.id).eq('status', 'pending').select('id,status,size,mime'));
    if (!updated?.length) {
      const again = rows(await db.from('documents').select('id,status,size,mime').eq('id', document.id).eq('owner_id', user.id).limit(1));
      if (again?.[0]?.status === 'ready') return Response.json(again[0]);
      fail('write_conflict', 409);
    }
    return Response.json(updated[0]);
  });

  add('GET', '/api/documents/:document_id', async ({ user, params }) => {
    const document = await ownedDoc(user, params.document_id);
    const signed = document.status === 'ready' ? await storage.createSignedUrl(document.object_path, 300) : null;
    return Response.json({ ...document, object_path: undefined, download_url: signed?.signedUrl || signed?.signedURL || null });
  });

  add('DELETE', '/api/documents/:document_id', async ({ user, params }) => {
    const document = await ownedDoc(user, params.document_id);
    rows(await db.from('documents').delete().eq('id', document.id).eq('owner_id', user.id).select('id'));
    try { await storage.remove([document.object_path]); } catch { /* metadata row is already gone */ }
    return Response.json({ ok: true });
  });

  // ---- scanner stages -----------------------------------------------------
  add('POST', '/api/scan/cover', async ({ user, body }) => {
    const input = await body();
    const document = await ownedDoc(user, input.document_id);
    const bytes = await objectBytes(document);
    const image = await dataUrl(document, bytes);
    const result = await freeModelCall(user, 'scan_cover', () => ai.modelOutputToJson(user.id, {
      prompt: COVER_PROMPT,
      system: 'You read text from photographs of book covers. Only report visible evidence.',
      purpose: 'scan_cover', needVision: true, images: [image], spaceId: document.space_id,
    }));
    const fields = result.json && typeof result.json === 'object' ? result.json : {};
    const guessed = fields.title || fields.author;
    let lookup = null;
    if (guessed) {
      try { lookup = await searchOpenLibrary(`${fields.title || ''} ${fields.author || ''}`.trim(), upstreamFetch()); }
      catch { lookup = null; }
    }
    await rewards.grantAchievement(user.id, 'first_scan_tool');
    rows(await db.from('documents').update({ extraction: { fields, provider: result.result?.model?.model_id || '' }, updated_at: nowIso() })
      .eq('id', document.id).eq('owner_id', user.id).select('id'));
    return Response.json({
      document_id: document.id,
      fields,
      matches: lookup || [],
      provider: result.result?.provider || null,
      model: result.result?.model || null,
      note: 'Read from your photograph. Correct anything that looks wrong before saving.',
    });
  });

  add('POST', '/api/scan/toc', async ({ user, body }) => {
    const input = await body();
    const document = await ownedDoc(user, input.document_id);
    const book = input.book_id ? await ownedBook(user, input.book_id) : null;
    const bytes = await objectBytes(document);
    let chapters = null;
    let origin = '';
    let exact = false;
    if (document.kind === 'pdf' || looksLikePdf(bytes)) {
      const extracted = await extractPdfPages(bytes);
      const text = extracted.pages.map(p => p.text).join('\n').slice(0, 12000);
      if (text.replace(/\s/g, '').length > 40) {
        const parsed = parseContents(text);
        if (parsed.length) {
          chapters = parsed;
          origin = 'pdf_text_layer';
          exact = true;
        } else {
          const result = await freeModelCall(user, 'scan_toc', () => ai.modelOutputToJson(user.id, {
            prompt: `${TOC_PROMPT}\n\nContents page text:\n${text}`,
            system: 'You index textbook tables of contents exactly as printed.',
            purpose: 'scan_toc', spaceId: document.space_id,
          }));
          chapters = Array.isArray(result.json) ? result.json : result.json?.chapters;
          origin = 'pdf_text_model';
        }
      }
    }
    if (!chapters) {
      const image = await dataUrl(document, bytes);
      const result = await freeModelCall(user, 'scan_toc', () => ai.modelOutputToJson(user.id, {
        prompt: TOC_PROMPT, system: 'You read printed tables of contents from photographs.',
        purpose: 'scan_toc', needVision: true, images: [image], spaceId: document.space_id,
      }));
      chapters = Array.isArray(result.json) ? result.json : result.json?.chapters;
      origin = 'vision';
    }
    const list = (Array.isArray(chapters) ? chapters : []).slice(0, 120).map((item, index) => ({
      number: clamp(Number(item?.number) || index + 1, 0, 500),
      title: asText(item?.title, { max: 160, min: 1, allowEmpty: false }) || `Entry ${index + 1}`,
      page: clamp(Number(item?.page) || 0, 0, 5000),
      topics: Array.isArray(item?.topics) ? item.topics.map(t => truncate(String(t), 80)).slice(0, 12) : [],
    })).filter(item => item.title);
    if (book) {
      rows(await db.from('documents').update({ extraction: { chapters: list, origin, book_id: book.id }, updated_at: nowIso() })
        .eq('id', document.id).eq('owner_id', user.id).select('id'));
    }
    return Response.json({
      document_id: document.id, book_id: book?.id || null, origin, exact, chapters: list,
      note: exact
        ? 'Read exactly from the PDF text layer — no model was used and nothing was charged. Check it against your book, then save.'
        : 'Read by a model, so treat it as a draft. Check chapter names and page numbers against your book, then save the index.',
    });
  });

  add('POST', '/api/scan/chapter', async ({ user, body }) => {
    const input = await body();
    const document = await ownedDoc(user, input.document_id);
    const book = await ownedBook(user, input.book_id || document.book_id);
    const chapterId = asUuid(input.chapter_id);
    const pageStart = clamp(Number(input.page_start) || 1, 1, 5000);
    const bytes = await objectBytes(document);
    let pages = [];
    let origin = '';
    if (document.kind === 'pdf' || looksLikePdf(bytes)) {
      const extracted = await extractPdfPages(bytes);
      if (extracted.hasTextLayer) {
        pages = extracted.pages.map((page, index) => ({
          page_number: pageStart + index,
          text: String(page.text).slice(0, 20000),
          confidence: 100,
        }));
        origin = 'text_layer';
      }
    }
    if (!pages.length) {
      const image = await dataUrl(document, bytes);
      const result = await freeModelCall(user, 'scan_pages', () => ai.modelOutputToJson(user.id, {
        prompt: PAGE_PROMPT, system: 'You transcribe textbook pages exactly. Never interpret or answer.',
        purpose: 'scan_pages', needVision: true, images: [image], spaceId: document.space_id,
      }));
      const text = result.json?.text || (typeof result.json === 'string' ? result.json : '');
      if (!text) fail('extraction_failed', 502, 'No readable text came back from that page.');
      pages = [{ page_number: pageStart, text: String(text).slice(0, 20000), confidence: clamp(Number(result.json?.confidence) || 80, 0, 100) }];
      origin = 'vision';
    }
    const stored = [];
    for (const page of pages.slice(0, 60)) {
      if (!page.text || page.text.replace(/\s/g, '').length < 20) continue;
      const id = crypto.randomUUID();
      rows(await db.from('pages').insert({
        id, owner_id: user.id, book_id: book.id, chapter_id: chapterId, document_id: document.id,
        page_number: page.page_number, text: page.text, extraction: origin, confidence: page.confidence ?? 90,
        created_at: nowIso(),
      }));
      stored.push({ id, page_number: page.page_number, characters: page.text.length, confidence: page.confidence ?? 90 });
    }
    if (!stored.length) fail('extraction_failed', 502);
    if (chapterId) {
      const existing = rows(await db.from('chapters').select('pages_extracted').eq('id', chapterId).eq('owner_id', user.id).limit(1))?.[0];
      rows(await db.from('chapters').update({
        pages_extracted: (existing?.pages_extracted || 0) + stored.length,
        status: existing?.status === 'done' ? 'done' : 'scanning',
      }).eq('id', chapterId).eq('owner_id', user.id).select('id'));
    }
    rows(await db.from('documents').update({ status: 'extracted', stage: 'chapter', extraction: { pages: stored, origin }, updated_at: nowIso() })
      .eq('id', document.id).eq('owner_id', user.id).select('id'));
    await rewards.grantAchievement(user.id, 'first_chapter_scan');
    if (document.space_id) await rewards.bumpStreak(user.id, dayOf());
    const counters = await rewards.weekCounters(user.id);
    const weekly = await rewards.maybeWeeklyChallenge(user.id, counters);
    return Response.json({
      document_id: document.id, book_id: book.id, chapter_id: chapterId, origin,
      pages: stored, weekly,
      note: origin === 'text_layer'
        ? 'Text came from the PDF text layer, so it is exact. Page numbers follow the order you set.'
        : 'Text came from a vision model. Proofread important formulas before relying on them.',
    });
  });

  add('GET', '/api/books/:book_id/pages', async ({ user, params, query }) => {
    const book = await ownedBook(user, params.book_id);
    const chapterId = asUuid(query.get('chapter_id'));
    const clauses = chapterId ? [['chapter_id', chapterId]] : [['book_id', book.id]];
    let builder = db.from('pages').select('id,chapter_id,page_number,text,extraction,confidence,created_at').eq('owner_id', user.id);
    for (const [column, value] of clauses) builder = builder.eq(column, value);
    const pages = rows(await builder.order('page_number', { ascending: true }).limit(120)) || [];
    return Response.json({ book_id: book.id, pages: pages.map(p => ({ ...p, preview: truncate(p.text, 400), text: undefined })) });
  });

  add('POST', '/api/lookup', async ({ user, body }) => {
    const input = await body();
    const query = asText(input.query, { max: 120, min: 1, allowEmpty: false }) || fail('invalid_input', 400);
    const fetchImpl = upstreamFetch();
    if (!fetchImpl) fail('service_not_configured', 503);
    try {
      const matches = await searchOpenLibrary(query, fetchImpl);
      return Response.json({ query, matches, note: 'Open Library covers many titles but not most local textbooks. If nothing fits, add the book manually — nothing is guessed.' });
    } catch {
      fail('search_unavailable', 502);
    }
  });

  function upstreamFetch() {
    return typeof fetch === 'function' ? fetch.bind(globalThis) : null;
  }
}

// Fixed, credential-free third-party metadata lookup.
async function searchOpenLibrary(query, fetchImpl) {
  const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=8&fields=title,author_name,publish_date,publisher,edition_count,first_publish_year`;
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('lookup_failed');
  const json = parseJsonBlock(await readBody(response, 400000));
  const docs = Array.isArray(json?.docs) ? json.docs : [];
  return docs.slice(0, 8).map(doc => ({
    title: truncate(String(doc.title || ''), 160),
    author: Array.isArray(doc.author_name) ? truncate(doc.author_name.join(', '), 120) : '',
    publisher: Array.isArray(doc.publisher) ? truncate(doc.publisher[0], 120) : '',
    year: Number(doc.first_publish_year) || Number(String(doc.publish_date?.[0] || '').slice(0, 4)) || 0,
    editions: Number(doc.edition_count) || 0,
  })).filter(doc => doc.title);
}
