// Learning spaces, their private context, notes, saved questions and the AI
// tutor conversation that belongs to one space only.
import { nowIso, text as asText, truncate, uuid as asUuid } from '../util.mjs';
import { buildLocalQuiz, importantTerms, publicQuestions, sanitizeQuestions } from '../quiz.mjs';

const ACTIONS = new Set([
  'explain_simple', 'explain_detailed', 'definitions', 'summary', 'short_notes', 'long_notes',
  'mcqs', 'practice', 'numericals', 'examples', 'concepts', 'revision', 'urdu_explain',
]);
const PAID_ACTIONS = { long_notes: 'premium_note_pack', revision: 'premium_note_pack' };

const ACTION_PROMPT = {
  explain_simple: 'Explain this material simply and briefly.',
  explain_detailed: 'Explain this material in detail with headings, then one worked example.',
  urdu_explain: 'Explain this material in Urdu (Urdu script). Keep formulas, symbols and unit names unchanged.',
  definitions: 'List the important definitions that appear in this material, one per line as “Term — definition”.',
  summary: 'Write a chapter summary in 6–10 bullet points, in the order the material presents them.',
  short_notes: 'Write short exam notes: headings, then 2–4 line points under each.',
  long_notes: 'Write long, structured notes with examples and common mistakes.',
  mcqs: 'Return ONLY a JSON array of 8 multiple-choice questions with keys question, options (4 strings), answer (0-3), explain, page.',
  practice: 'Return ONLY a JSON array of 6 practice questions with keys question, answer, page.',
  numericals: 'Solve the numerical problems in this material step by step: given data, formula, substitution, result with units.',
  examples: 'Give three worked examples with solutions based on this material.',
  concepts: 'List the key concepts a student must remember from this material, each with one line of why it matters.',
  revision: 'Build a revision sheet: must-know facts, formulas, common exam questions and short answers.',
};

function extractiveSummary(pages) {
  const lines = [];
  for (const page of pages) {
    const sentences = String(page.text || '').split(/(?<=[.!?])\s+/).filter(s => s.length > 40 && s.length < 240);
    for (const sentence of sentences.slice(0, 3)) {
      lines.push({ text: sentence.trim(), page: page.page_number });
      if (lines.length >= 10) break;
    }
    if (lines.length >= 10) break;
  }
  return lines;
}

export function createSpaces({ add, db, fail, rows, ai, rewards, limit, ensureProfile }) {
  const spaceColumns = 'id,name,subject,color,instructions,archived,created_at,updated_at';

  async function counts(user, ids) {
    if (!ids.length) return new Map();
    const map = new Map(ids.map(id => [id, { messages: 0, notes: 0, questions: 0 }]));
    const messages = rows(await db.from('messages').select('space_id')
      .eq('owner_id', user.id).in('space_id', ids).limit(1500)) || [];
    for (const row of messages) {
      const entry = map.get(row.space_id);
      if (entry) entry.messages += 1;
    }
    const notes = rows(await db.from('notes').select('space_id').eq('owner_id', user.id).in('space_id', ids).limit(1500)) || [];
    for (const row of notes) { const entry = map.get(row.space_id); if (entry) entry.notes += 1; }
    const questions = rows(await db.from('saved_questions').select('space_id').eq('owner_id', user.id).in('space_id', ids).limit(1500)) || [];
    for (const row of questions) { const entry = map.get(row.space_id); if (entry) entry.questions += 1; }
    return map;
  }

  add('GET', '/api/spaces', async (scoped) => {
    const { user, query } = scoped;
    const archived = query.get('archived') === 'true';
    const found = rows(await db.from('spaces').select(spaceColumns)
      .eq('owner_id', user.id).eq('archived', archived).order('updated_at', { ascending: false }).limit(100)) || [];
    const statMap = await counts(user, found.map(s => s.id));
    return Response.json(found.map(space => ({ ...space, stats: statMap.get(space.id) || { messages: 0, notes: 0, questions: 0 } })));
  });

  add('POST', '/api/spaces', async (scoped) => {
    const { user, body } = scoped;
    const input = await body();
    const name = asText(input.name, { max: 60, min: 2, allowEmpty: false }) || fail('space_name_required', 400);
    const subject = asText(input.subject, { max: 60 }) ?? '';
    const color = ['indigo', 'teal', 'amber', 'rose', 'violet', 'emerald', 'sky', 'slate'].includes(input.color) ? input.color : 'indigo';
    const instructions = asText(input.instructions, { max: 1500 }) ?? '';
    const id = crypto.randomUUID();
    rows(await db.from('spaces').insert({
      id, owner_id: user.id, name, subject, color, instructions, archived: false,
      created_at: nowIso(), updated_at: nowIso(),
    }));
    const created = rows(await db.from('spaces').select(spaceColumns).eq('id', id).eq('owner_id', user.id).limit(1))?.[0];
    if (!created) fail('database_unavailable', 503);
    await rewards.grantAchievement(user.id, 'first_space');
    return Response.json(created, { status: 201 });
  });

  add('GET', '/api/spaces/:space_id', async (scoped) => {
    const { user, params, query } = scoped;
    const spaceId = asUuid(params.space_id) || fail('invalid_input', 400);
    const space = await scoped.space(user, spaceId);
    const window = limit(query.get('messages'), 60, 200);
    const messages = rows(await db.from('messages')
      .select('id,role,content,provider,model,style,tokens,cost_micro,sources,created_at')
      .eq('owner_id', user.id).eq('space_id', spaceId).order('created_at', { ascending: false }).limit(window))
      || [];
    const notes = rows(await db.from('notes').select('id,title,body,version,updated_at')
      .eq('owner_id', user.id).eq('space_id', spaceId).order('updated_at', { ascending: false }).limit(60)) || [];
    const questions = rows(await db.from('saved_questions').select('id,question,answer,topic,resolved,created_at')
      .eq('owner_id', user.id).eq('space_id', spaceId).order('created_at', { ascending: false }).limit(80)) || [];
    const topics = rows(await db.from('learning_history').select('kind,topic,detail,created_at')
      .eq('owner_id', user.id).eq('space_id', spaceId).order('created_at', { ascending: false }).limit(60)) || [];
    const links = rows(await db.from('book_links').select('book_id').eq('owner_id', user.id).eq('space_id', spaceId).limit(40)) || [];
    const ids = links.map(l => l.book_id).filter(Boolean);
    const books = ids.length ? rows(await db.from('books').select('id,title,author,subject,chapters_ready')
      .eq('owner_id', user.id).in('id', ids).limit(40)) || [] : [];
    const quizzes = rows(await db.from('quizzes').select('id,title,origin,created_at,questions')
      .eq('owner_id', user.id).eq('space_id', spaceId).order('created_at', { ascending: false }).limit(20)) || [];
    return Response.json({
      space,
      messages: messages.reverse(),
      notes,
      questions,
      topics,
      books,
      quizzes: quizzes.map(q => ({ ...q, questions: undefined, count: Array.isArray(q.questions) ? q.questions.length : 0 })),
    });
  });

  add('PATCH', '/api/spaces/:space_id', async (scoped) => {
    const { user, params, body } = scoped;
    const spaceId = asUuid(params.space_id) || fail('invalid_input', 400);
    const space = await scoped.space(user, spaceId);
    const input = await body();
    const patch = { updated_at: nowIso() };
    if (input.name !== undefined) patch.name = asText(input.name, { max: 60, min: 2, allowEmpty: false }) || fail('invalid_input', 400);
    if (input.subject !== undefined) patch.subject = asText(input.subject, { max: 60 }) ?? '';
    if (input.color !== undefined && ['indigo', 'teal', 'amber', 'rose', 'violet', 'emerald', 'sky', 'slate'].includes(input.color)) patch.color = input.color;
    if (input.instructions !== undefined) patch.instructions = asText(input.instructions, { max: 1500 }) ?? '';
    if (input.archived !== undefined) patch.archived = input.archived === true;
    const updated = rows(await db.from('spaces').update(patch).eq('id', space.id).eq('owner_id', user.id)
      .select(spaceColumns));
    if (!updated?.length) fail('write_conflict', 409);
    return Response.json(updated[0]);
  });

  add('DELETE', '/api/spaces/:space_id', async (scoped) => {
    const { user, params } = scoped;
    const spaceId = asUuid(params.space_id) || fail('invalid_input', 400);
    const space = await scoped.space(user, spaceId);
    for (const table of ['messages', 'notes', 'saved_questions', 'learning_history', 'book_links', 'quizzes']) {
      await db.from(table).delete().eq('owner_id', user.id).eq('space_id', spaceId);
    }
    const deleted = rows(await db.from('spaces').delete().eq('id', space.id).eq('owner_id', user.id).select('id'));
    if (!deleted?.length) fail('write_conflict', 409);
    return Response.json({ ok: true, id: spaceId });
  });

  add('POST', '/api/spaces/:space_id/books', async (scoped) => {
    const { user, params, body } = scoped;
    const spaceId = asUuid(params.space_id) || fail('invalid_input', 400);
    await scoped.space(user, spaceId);
    const input = await body();
    const bookId = asUuid(input.book_id) || fail('invalid_input', 400);
    const book = rows(await db.from('books').select('id').eq('id', bookId).eq('owner_id', user.id).limit(1));
    if (!book?.length) fail('book_not_found', 404);
    rows(await db.from('book_links').insertIfAbsent({
      id: crypto.randomUUID(), owner_id: user.id, book_id: bookId, space_id: spaceId, created_at: nowIso(),
    }, { onConflict: 'owner_id,book_id,space_id' }).select('id'));
    return Response.json({ ok: true, space_id: spaceId, book_id: bookId });
  });

  add('DELETE', '/api/spaces/:space_id/books/:book_id', async (scoped) => {
    const { user, params } = scoped;
    const spaceId = asUuid(params.space_id) || fail('invalid_input', 400);
    const bookId = asUuid(params.book_id) || fail('invalid_input', 400);
    const deleted = rows(await db.from('book_links').delete().eq('owner_id', user.id)
      .eq('space_id', spaceId).eq('book_id', bookId).select('id'));
    if (!deleted?.length) fail('not_found', 404);
    return Response.json({ ok: true });
  });

  add('POST', '/api/spaces/:space_id/notes', async (scoped) => {
    const { user, params, body } = scoped;
    const spaceId = asUuid(params.space_id) || fail('invalid_input', 400);
    await scoped.space(user, spaceId);
    const input = await body();
    const title = asText(input.title, { max: 120, min: 1, allowEmpty: false }) || fail('invalid_input', 400);
    const noteBody = asText(input.body, { max: 20000 }) ?? '';
    const id = crypto.randomUUID();
    rows(await db.from('notes').insert({
      id, owner_id: user.id, space_id: spaceId, title, body: noteBody, version: 1,
      created_at: nowIso(), updated_at: nowIso(),
    }));
    const created = rows(await db.from('notes').select('id,title,body,version,updated_at').eq('id', id).eq('owner_id', user.id).limit(1));
    return Response.json(created?.[0] || { id, title, body: noteBody, version: 1 }, { status: 201 });
  });

  add('PATCH', '/api/notes/:note_id', async (scoped) => {
    const { user, params, body } = scoped;
    const noteId = asUuid(params.note_id) || fail('invalid_input', 400);
    const found = rows(await db.from('notes').select('id,version,space_id').eq('id', noteId).eq('owner_id', user.id).limit(1));
    if (!found?.length) fail('not_found', 404);
    const input = await body();
    if (!Number.isInteger(input.version)) fail('invalid_input', 400);
    const patch = { updated_at: nowIso(), version: input.version + 1 };
    if (input.title !== undefined) patch.title = asText(input.title, { max: 120, min: 1, allowEmpty: false }) || fail('invalid_input', 400);
    if (input.body !== undefined) patch.body = asText(input.body, { max: 20000 }) ?? '';
    const updated = rows(await db.from('notes').update(patch).eq('id', noteId).eq('owner_id', user.id).eq('version', input.version)
      .select('id,title,body,version,updated_at'));
    if (!updated?.length) fail('write_conflict', 409);
    return Response.json(updated[0]);
  });

  add('DELETE', '/api/notes/:note_id', async (scoped) => {
    const { user, params } = scoped;
    const noteId = asUuid(params.note_id) || fail('invalid_input', 400);
    const deleted = rows(await db.from('notes').delete().eq('id', noteId).eq('owner_id', user.id).select('id'));
    if (!deleted?.length) fail('not_found', 404);
    return Response.json({ ok: true });
  });

  add('POST', '/api/spaces/:space_id/questions', async (scoped) => {
    const { user, params, body } = scoped;
    const spaceId = asUuid(params.space_id) || fail('invalid_input', 400);
    await scoped.space(user, spaceId);
    const input = await body();
    const question = asText(input.question, { max: 1200, min: 1, allowEmpty: false }) || fail('invalid_input', 400);
    const answer = asText(input.answer, { max: 6000 }) ?? '';
    const topic = asText(input.topic, { max: 80 }) ?? '';
    const id = crypto.randomUUID();
    rows(await db.from('saved_questions').insert({
      id, owner_id: user.id, space_id: spaceId, question, answer, topic,
      resolved: input.resolved === true, created_at: nowIso(),
    }));
    const created = rows(await db.from('saved_questions').select('id,question,answer,topic,resolved,created_at')
      .eq('id', id).eq('owner_id', user.id).limit(1));
    return Response.json(created?.[0] || { id, question, answer, topic }, { status: 201 });
  });

  add('PATCH', '/api/questions/:question_id', async (scoped) => {
    const { user, params, body } = scoped;
    const questionId = asUuid(params.question_id) || fail('invalid_input', 400);
    const input = await body();
    const patch = {};
    if (input.resolved !== undefined) patch.resolved = input.resolved === true;
    if (input.answer !== undefined) patch.answer = asText(input.answer, { max: 6000 }) ?? '';
    const updated = rows(await db.from('saved_questions').update(patch).eq('id', questionId).eq('owner_id', user.id)
      .select('id,question,answer,topic,resolved'));
    if (!updated?.length) fail('not_found', 404);
    return Response.json(updated[0]);
  });

  add('DELETE', '/api/questions/:question_id', async (scoped) => {
    const { user, params } = scoped;
    const questionId = asUuid(params.question_id) || fail('invalid_input', 400);
    const deleted = rows(await db.from('saved_questions').delete().eq('id', questionId).eq('owner_id', user.id).select('id'));
    if (!deleted?.length) fail('not_found', 404);
    return Response.json({ ok: true });
  });

  add('DELETE', '/api/spaces/:space_id/messages', async (scoped) => {
    const { user, params } = scoped;
    const spaceId = asUuid(params.space_id) || fail('invalid_input', 400);
    await scoped.space(user, spaceId);
    await db.from('messages').delete().eq('owner_id', user.id).eq('space_id', spaceId);
    return Response.json({ ok: true });
  });

  // The tutor turn: one provider call, space-scoped context, real citations.
  add('POST', '/api/spaces/:space_id/chat', async (scoped) => {
    const { user, params, body } = scoped;
    const spaceId = asUuid(params.space_id) || fail('invalid_input', 400);
    const space = await scoped.space(user, spaceId);
    const input = await body();
    const message = asText(input.message, { max: 4000, min: 1, allowEmpty: false }) || fail('invalid_input', 400);
    const profile = await ensureProfile(user);
    const style = asText(input.style, { max: 20 }) || profile.explanation_level || 'simple';
    const language = asText(input.language, { max: 8 }) || profile.language || 'en';
    const modelRowId = asUuid(input.model_row_id);
    const context = await scoped.contextFor(user, spaceId);
    const pages = await scoped.pagesFor(user, { bookIds: context.bookIds, limit: 10 });
    const system = ai.buildSystem({ space, style, language, notes: context.notes, memory: context.memory });
    const contextBlock = ai.buildContextBlock({ history: context.history, pages, books: context.books });
    const prompt = `${contextBlock ? `${contextBlock}\n\n` : ''}Student question: ${message}`;
    const advanced = input.advanced === true;

    rows(await db.from('messages').insert({
      id: crypto.randomUUID(), owner_id: user.id, space_id: spaceId, role: 'user', content: message,
      style, tokens: 0, cost_micro: 0, sources: {}, created_at: nowIso(),
    }));

    if (advanced) {
      const spendKey = asUuid(input.client_key) || fail('invalid_input', 400, 'Send a client_key with the advanced check.');
      const spend = await rewards.applyDelta(user.id, {
        reason: `spend:compare:${spendKey}`, label: 'Advanced two-model check', amount: 10, direction: 'spend', meta: { space_id: spaceId },
      });
      const compared = await ai.compare(user.id, { prompt, system, spaceId, purpose: 'compare' });
      const answerId = crypto.randomUUID();
      rows(await db.from('messages').insert({
        id: answerId, owner_id: user.id, space_id: spaceId, role: 'assistant', content: compared.final,
        provider: compared.provider?.provider_key || '', model: compared.model?.model_id || '', style,
        tokens: 0, cost_micro: 0, sources: { citations: citationsFor(pages), checked: compared.answers },
        created_at: nowIso(),
      }));
      await scoped.log({ spaceId, kind: 'chat', topic: topicOf(message, space), detail: 'advanced comparison' });
      return Response.json({
        reply: compared.final, checked: compared.answers, balance: spend.wallet?.balance,
        model: compared.model, provider: compared.provider, citations: citationsFor(pages), advanced: true,
      });
    }

    const result = await ai.complete(user.id, {
      prompt, system, spaceId, style, message, modelRowId, purpose: 'chat',
      minTier: ai.classify(message, style),
    });
    const answerId = crypto.randomUUID();
    rows(await db.from('messages').insert({
      id: answerId, owner_id: user.id, space_id: spaceId, role: 'assistant', content: String(result.text).slice(0, 20000),
      provider: result.provider?.provider_key || '', model: result.model?.model_id || '', style,
      tokens: (result.inputTokens || 0) + (result.outputTokens || 0), cost_micro: result.costMicro || 0,
      sources: {
        citations: citationsFor(pages), cached: Boolean(result.cached), attempts: result.attempts || 1,
        retried: Boolean(result.retried), fell_back: Boolean(result.fellBack),
        fell_back_from: (result.failures || []).map(f => `${f.model} (${f.code})`).slice(0, 3),
      },
      created_at: nowIso(),
    }));
    await scoped.log({ spaceId, kind: 'chat', topic: topicOf(message, space), detail: truncate(result.text, 200) });
    return Response.json({
      id: answerId,
      reply: result.text,
      provider: result.provider,
      model: result.model,
      tokens: (result.inputTokens || 0) + (result.outputTokens || 0),
      cost_micro: result.costMicro || 0,
      cached: Boolean(result.cached),
      attempts: result.attempts || 1,
      // Which model actually answered is stated, never implied: a fallback is
      // visible to the student and recorded alongside the answer.
      retried: Boolean(result.retried),
      fell_back: Boolean(result.fellBack),
      fell_back_from: (result.failures || []).map(f => `${f.model} (${f.code})`).slice(0, 3),
      waited_ms: result.waitedMs || 0,
      citations: citationsFor(pages),
      note: pages.length
        ? 'The tutor was given verified text from your own scans. Anything outside that text is the model’s own knowledge.'
        : 'No scanned material is connected to this space yet, so this answer comes from the model’s general knowledge.',
    });
  });

  add('POST', '/api/ai/action', async (scoped) => {
    const { user, body } = scoped;
    const input = await body();
    const action = asText(input.action, { max: 30 }) || '';
    if (!ACTIONS.has(action)) fail('invalid_input', 400);
    const spaceId = asUuid(input.space_id);
    const bookId = asUuid(input.book_id);
    const chapterId = asUuid(input.chapter_id);
    const profile = await ensureProfile(user);
    const language = action === 'urdu_explain' ? 'ur' : (asText(input.language, { max: 8 }) || profile.language || 'en');
    const space = spaceId ? await scoped.space(user, spaceId) : null;
    const pages = await scoped.pagesFor(user, {
      bookId, chapterId,
      bookIds: spaceId ? (await scoped.contextFor(user, spaceId)).bookIds : null,
      limit: action === 'numericals' ? 14 : 12,
    });
    if (!pages.length) fail('no_material', 409, 'Scan a chapter page or connect a book to this space first.');

    const paid = PAID_ACTIONS[action];
    let spend = null;
    if (paid) {
      // A client key makes the debit replay-safe: a double click cannot spend
      // the same premium action twice.
      const spendKey = asUuid(input.client_key) || fail('invalid_input', 400, 'Send a client_key with a premium action.');
      spend = await rewards.applyDelta(user.id, {
        reason: `spend:${paid}:${spendKey}`, label: `Premium ${action.replace(/_/g, ' ')}`,
        amount: 15, direction: 'spend', meta: { action },
      });
    }

    if (action === 'mcqs' || action === 'practice') {
      const wanted = action === 'mcqs' ? 8 : 6;
      try {
        const generated = await ai.modelOutputToJson(user.id, {
          prompt: `${ACTION_PROMPT[action]}\n\nMaterial:\n${materialBlock(pages)}`,
          system: 'You write exam-ready questions for students. Use only the supplied material. Cite page numbers you can see.',
          spaceId, purpose: action, allowCache: false,
        });
        const list = Array.isArray(generated.json) ? generated.json : Array.isArray(generated.json?.questions) ? generated.json.questions : null;
        const cleaned = sanitizeQuestions(list, pages);
        if (!cleaned.length) throw new Error('unusable');
        const quizId = crypto.randomUUID();
        rows(await db.from('quizzes').insert({
          id: quizId, owner_id: user.id, space_id: spaceId, book_id: bookId, chapter_id: chapterId,
          title: titleFor(action, space, pages), questions: cleaned, origin: 'ai',
          provider: generated.result.provider?.provider_key || '', model: generated.result.model?.model_id || '',
          created_at: nowIso(),
        }));
        return Response.json({ quiz_id: quizId, title: titleFor(action, space, pages), questions: publicQuestions(cleaned), origin: 'ai', provider: generated.result.provider, model: generated.result.model, balance: spend?.wallet?.balance });
      } catch (error) {
        if (['credentials_not_configured', 'rate_limited', 'daily_limit_reached', 'no_provider_configured'].includes(error?.code)) {
          const local = buildLocalQuiz(pages, { count: wanted, title: titleFor(action, space, pages) });
          const quizId = crypto.randomUUID();
          rows(await db.from('quizzes').insert({
            id: quizId, owner_id: user.id, space_id: spaceId, book_id: bookId, chapter_id: chapterId,
            title: local.title, questions: local.questions, origin: local.origin, provider: '', model: '', created_at: nowIso(),
          }));
          return Response.json({ quiz_id: quizId, title: local.title, questions: publicQuestions(local.questions), origin: local.origin, note: local.note, balance: spend?.wallet?.balance });
        }
        throw error;
      }
    }

    const system = ai.buildSystem({ space, style: action === 'explain_detailed' ? 'detailed' : profile.explanation_level, language, notes: [], memory: [] });
    let result;
    try {
      result = await ai.complete(user.id, {
        prompt: `${ACTION_PROMPT[action]}\n\nMaterial:\n${materialBlock(pages)}`,
        system, spaceId, purpose: action, style: action === 'explain_detailed' ? 'detailed' : 'simple', language,
        allowCache: action === 'summary' || action === 'definitions',
      });
    } catch (error) {
      if (error?.code === 'no_provider_configured' || error?.code === 'credentials_not_configured' || error?.code === 'daily_limit_reached') {
        if (action === 'definitions') {
          const terms = importantTerms(pages);
          return Response.json({ text: terms.map(t => `${t.term} — ${t.definition} (page ${t.page})`).join('\n'), origin: 'local_text', citations: citationsFor(pages) });
        }
        const lines = extractiveSummary(pages);
        return Response.json({
          text: lines.map(l => `• ${l.text} (page ${l.page})`).join('\n'),
          origin: 'local_text',
          note: 'No AI provider is configured, so this is a plain extract of your own scanned sentences — not an AI explanation.',
          citations: citationsFor(pages),
        });
      }
      throw error;
    }
    const body2 = String(result.text).slice(0, 20000);
    if (spaceId && ['short_notes', 'long_notes', 'summary', 'revision', 'concepts'].includes(action)) {
      rows(await db.from('notes').insert({
        id: crypto.randomUUID(), owner_id: user.id, space_id: spaceId,
        title: `${titleFor(action, space, pages)} (${action.replace(/_/g, ' ')})`, body: body2,
        version: 1, created_at: nowIso(), updated_at: nowIso(),
      }));
      await scoped.log({ spaceId, kind: 'notes', topic: titleFor(action, space, pages), detail: action });
    }
    await scoped.log({ spaceId, kind: 'action', topic: action, detail: truncate(body2, 120) });
    return Response.json({
      text: body2, origin: 'ai', provider: result.provider, model: result.model,
      tokens: (result.inputTokens || 0) + (result.outputTokens || 0), cost_micro: result.costMicro || 0,
      cached: Boolean(result.cached), citations: citationsFor(pages), balance: spend?.wallet?.balance,
    });
  });
}

function materialBlock(pages) {
  return pages.map(page => `[page ${page.page_number}${page.chapter_title ? `, ${page.chapter_title}` : ''}${page.book_title ? `, ${page.book_title}` : ''}]\n${truncate(page.text, 1400)}`).join('\n\n').slice(0, 9000);
}

function citationsFor(pages) {
  return pages.slice(0, 12).map(page => ({
    book: page.book_title || null, chapter: page.chapter_title || null,
    page: page.page_number, extraction: page.extraction,
  }));
}

function titleFor(action, space, pages) {
  if (pages[0]?.chapter_title) return pages[0].chapter_title;
  if (space?.name) return space.name;
  return action.replace(/_/g, ' ');
}

function topicOf(message, space) {
  const cleaned = String(message).replace(/\s+/g, ' ').trim();
  return truncate(cleaned.split(/[?.!]/)[0] || space?.name || 'question', 80);
}
