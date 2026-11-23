// The dedicated AI Chat: titled conversations persisted per student, each turn
// answered by the SAME central gateway and charged by the SAME Bridge Credits
// ledger as the AI Tutor. Nothing here talks to a provider directly, prices a
// model or moves a balance — ai.complete picks only verified free models, and
// rewards.reserveAi/refundAi/settleAi own every credit movement.
import { nowIso, text as asText, truncate, uuid as asUuid } from '../util.mjs';

const HISTORY_ROWS = 16;

function deriveTitle(content) {
  const clean = String(content || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`~\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(clean || 'New chat', 60);
}

// Chat wording for the transcript block: the tutor's context block says "in
// this space", which a standalone chat is not.
function chatContextBlock(history) {
  if (!history?.length) return '';
  return `Earlier in this conversation:\n${history
    .map(m => `${m.role === 'user' ? 'Student' : 'AI'}: ${truncate(m.content, 400)}`)
    .join('\n')}`.slice(0, 7000);
}

export function createChat({ add, db, fail, rows, ai, rewards, economy, ensureProfile }) {
  const LIST_COLUMNS = 'id,title,message_count,model,provider,created_at,updated_at';
  const MESSAGE_COLUMNS = 'id,conversation_id,role,content,provider,model,tokens,cost_micro,sources,request_key,state,created_at';

  async function priceOf(feature) {
    const price = await economy.price(feature);
    if (price === null) fail('invalid_input', 400, 'This request has no configured price.');
    return price;
  }

  function publicConversation(row) {
    return {
      id: row.id, title: row.title, message_count: row.message_count,
      model: row.model, provider: row.provider,
      created_at: row.created_at, updated_at: row.updated_at,
    };
  }

  // Newest-first sidebar page. `before` is the last updated_at the client has.
  add('GET', '/api/chats', async (scoped) => {
    const { user, query, limit: pageLimit } = scoped;
    const size = pageLimit(query.get('limit'), 30, 100);
    const before = query.get('before') || '';
    let found = db.from('chat_conversations').select(LIST_COLUMNS).eq('owner_id', user.id)
      .order('updated_at', { ascending: false }).limit(size + 1);
    if (before) found = found.lt('updated_at', before);
    const fetched = rows(await found) || [];
    const more = fetched.length > size;
    const page = fetched.slice(0, size);
    return Response.json({
      conversations: page.map(publicConversation),
      next_before: more && page.length ? page[page.length - 1].updated_at : null,
    });
  });

  // One ascending page of messages. `before` is the oldest created_at already
  // shown, so "load earlier" walks backwards without ever loading the whole
  // thread (requirement: avoid loading entire histories at once).
  add('GET', '/api/chats/:id/messages', async (scoped) => {
    const { user, params, query, limit: pageLimit } = scoped;
    const conversationId = asUuid(params.id) || fail('invalid_input', 400);
    const size = pageLimit(query.get('limit'), 50, 100);
    const before = query.get('before') || '';
    const conversation = rows(await db.from('chat_conversations').select(LIST_COLUMNS)
      .eq('id', conversationId).eq('owner_id', user.id).limit(1))[0];
    if (!conversation) fail('not_found', 404);
    let found = db.from('chat_messages').select(MESSAGE_COLUMNS)
      .eq('conversation_id', conversationId).eq('owner_id', user.id)
      .order('created_at', { ascending: false }).limit(size + 1);
    if (before) found = found.lt('created_at', before);
    const fetched = rows(await found) || [];
    const more = fetched.length > size;
    const page = fetched.slice(0, size).reverse();
    return Response.json({
      conversation: publicConversation(conversation),
      messages: page,
      next_before: more && page.length ? page[0].created_at : null,
    });
  });

  add('PATCH', '/api/chats/:id', async (scoped) => {
    const { user, params, body } = scoped;
    const conversation = await scoped.own('chat_conversations', params.id, { notFound: 'not_found' });
    const input = await body();
    const title = asText(input.title, { max: 80, min: 1, allowEmpty: false }) || fail('invalid_input', 400, 'Give the conversation a name.');
    const updated = rows(await db.from('chat_conversations')
      .update({ title, updated_at: nowIso() })
      .eq('id', conversation.id).eq('owner_id', user.id).select(LIST_COLUMNS));
    return Response.json({ conversation: publicConversation(updated[0] || conversation) });
  });

  add('DELETE', '/api/chats/:id', async (scoped) => {
    const { user, params } = scoped;
    const conversation = await scoped.own('chat_conversations', params.id, { notFound: 'not_found' });
    rows(await db.from('chat_messages').delete()
      .eq('conversation_id', conversation.id).eq('owner_id', user.id));
    rows(await db.from('chat_conversations').delete()
      .eq('id', conversation.id).eq('owner_id', user.id));
    return Response.json({ ok: true });
  });

  // Start a chat: creates the conversation AND sends its first message, so an
  // abandoned draft can never leave an empty conversation row behind. If the
  // first turn fails (no credits, gateway down), the conversation row goes with
  // it — a retry re-creates both, and the refunded credits are unaffected.
  add('POST', '/api/chats', async (scoped) => {
    const { user, body } = scoped;
    const input = await body();
    const content = asText(input.content, { max: 6000, min: 1, allowEmpty: false }) || fail('invalid_input', 400, 'Type a message first.');
    const created = rows(await db.from('chat_conversations').insert({
      id: crypto.randomUUID(), owner_id: user.id, title: '', message_count: 0,
      model: '', provider: '', created_at: nowIso(), updated_at: nowIso(),
    }).select(LIST_COLUMNS));
    const conversation = created[0] || fail('database_unavailable', 503);
    try {
      return await respond(scoped, conversation, content, input);
    } catch (error) {
      rows(await db.from('chat_messages').delete()
        .eq('conversation_id', conversation.id).eq('owner_id', user.id));
      rows(await db.from('chat_conversations').delete()
        .eq('id', conversation.id).eq('owner_id', user.id));
      throw error;
    }
  });

  add('POST', '/api/chats/:id/messages', async (scoped) => {
    const { user, params, body } = scoped;
    const input = await body();
    const content = asText(input.content, { max: 6000, min: 1, allowEmpty: false }) || fail('invalid_input', 400, 'Type a message first.');
    const conversation = await scoped.own('chat_conversations', params.id, { notFound: 'not_found' });
    return respond(scoped, conversation, content, input);
  });

  // The full turn: reserve credits → replay check → store the user message →
  // one gateway call → settle (or refund) → store the answer. Mirrors the AI
  // Tutor turn in spaces.mjs; the ledger and gateway semantics are identical.
  async function respond(scoped, conversation, content, input) {
    const { user } = scoped;
    const key = asUuid(input.client_key) || '';
    const price = await priceOf('basic_question');

    // Credits are reserved before any model is contacted. A request that
    // cannot be paid for never reaches a provider; a request that fails after
    // this point gets its credits back.
    const reservation = await rewards.reserveAi(user.id, {
      feature: 'basic_question', requestKey: key, credits: price, label: 'AI Chat message',
    });
    if (reservation.replayed) {
      if (reservation.state === 'settled') {
        const previous = rows(await db.from('chat_messages').select(MESSAGE_COLUMNS)
          .eq('conversation_id', conversation.id).eq('owner_id', user.id)
          .eq('request_key', reservation.key).eq('role', 'assistant').limit(1))[0];
        if (previous) {
          const sources = previous.sources || {};
          return Response.json({
            id: previous.id, conversation_id: conversation.id, reply: previous.content,
            provider: { provider_key: previous.provider || '' },
            model: { model_id: previous.model || '' },
            tokens: previous.tokens || 0, cost_micro: previous.cost_micro || 0,
            credits_spent: reservation.credits ?? price, balance: await balanceOf(user.id),
            cached: Boolean(sources.cached), attempts: sources.attempts || 1,
            retried: Boolean(sources.retried), fell_back: Boolean(sources.fell_back),
            fell_back_from: sources.fell_back_from || [],
            title: conversation.title, replayed: true,
            note: 'This exact message was already answered and paid for. The same answer is shown again — no credits were taken a second time.',
          });
        }
      }
      fail('idempotency_conflict', 409, 'This request is already running. Wait for the answer instead of sending it again.');
    }

    // The reservation is ours. A retry of a refunded attempt reuses the failed
    // user row instead of duplicating it; a fresh send inserts a new row.
    const prior = key ? rows(await db.from('chat_messages').select(MESSAGE_COLUMNS)
      .eq('conversation_id', conversation.id).eq('owner_id', user.id)
      .eq('request_key', key).eq('role', 'user').limit(1))[0] : null;
    let userMessage;
    if (prior) {
      userMessage = rows(await db.from('chat_messages')
        .update({ content, state: '' })
        .eq('id', prior.id).eq('owner_id', user.id).select(MESSAGE_COLUMNS))[0];
      if (!userMessage) fail('write_conflict', 409);
    } else {
      userMessage = rows(await db.from('chat_messages').insert({
        id: crypto.randomUUID(), owner_id: user.id, conversation_id: conversation.id,
        role: 'user', content, provider: '', model: '', tokens: 0, cost_micro: 0,
        sources: {}, request_key: reservation.key, state: '', created_at: nowIso(),
      }).select(MESSAGE_COLUMNS))[0] || fail('database_unavailable', 503);
    }

    const title = conversation.title || deriveTitle(content);
    rows(await db.from('chat_conversations')
      .update({ title, updated_at: nowIso(), message_count: conversation.message_count + (prior ? 0 : 1) })
      .eq('id', conversation.id).eq('owner_id', user.id));

    const profile = await ensureProfile(user);
    const style = 'simple';
    const language = profile.language || 'en';
    const history = (rows(await db.from('chat_messages').select('role,content')
      .eq('conversation_id', conversation.id).eq('owner_id', user.id)
      .order('created_at', { ascending: false }).limit(HISTORY_ROWS)) || []).reverse();
    const system = ai.buildSystem({ space: null, style, language, notes: [], memory: [] });
    const contextBlock = chatContextBlock(history.slice(0, -1));
    const prompt = contextBlock ? `${contextBlock}\n\nStudent message: ${content}` : content;

    let result;
    try {
      result = await ai.complete(user.id, {
        prompt, system, spaceId: null, style, message: content, purpose: 'chat',
        minTier: ai.classify(content, style),
      });
    } catch (error) {
      // Nothing was delivered, so the reserved credits go back and the user
      // row stays visible as failed — the retry affordance re-sends with the
      // SAME key, which the ledger books as attempt 2 of one message.
      rows(await db.from('chat_messages')
        .update({ state: 'failed' })
        .eq('id', userMessage.id).eq('owner_id', user.id).select('id'));
      await rewards.refundAi(user.id, reservation.key, { reason: error?.code || 'chat_failed', feature: 'basic_question' });
      throw error;
    }

    const answerId = crypto.randomUUID();
    const sources = {
      cached: Boolean(result.cached), attempts: result.attempts || 1,
      retried: Boolean(result.retried), fell_back: Boolean(result.fellBack),
      fell_back_from: (result.failures || []).map(f => `${f.model} (${f.code})`).slice(0, 3),
      request_key: reservation.key,
    };
    const answer = rows(await db.from('chat_messages').insert({
      id: answerId, owner_id: user.id, conversation_id: conversation.id,
      role: 'assistant', content: String(result.text).slice(0, 20000),
      provider: result.provider?.provider_key || '', model: result.model?.model_id || '',
      style, tokens: (result.inputTokens || 0) + (result.outputTokens || 0),
      cost_micro: result.costMicro || 0, sources, request_key: reservation.key,
      state: '', created_at: nowIso(),
    }).select(MESSAGE_COLUMNS))[0] || fail('database_unavailable', 503);
    await rewards.settleAi(user.id, reservation.key, {
      providerKey: result.provider?.provider_key || '', modelId: result.model?.model_id || '',
    });
    rows(await db.from('chat_conversations')
      .update({
        updated_at: nowIso(),
        message_count: conversation.message_count + (prior ? 0 : 1) + 1,
        model: result.model?.model_id || '', provider: result.provider?.provider_key || '',
      })
      .eq('id', conversation.id).eq('owner_id', user.id));

    return Response.json({
      id: answer.id, conversation_id: conversation.id, reply: result.text,
      user_message_id: userMessage.id,
      provider: result.provider, model: result.model,
      tokens: (result.inputTokens || 0) + (result.outputTokens || 0),
      cost_micro: result.costMicro || 0, credits_spent: price,
      balance: await balanceOf(user.id), cached: Boolean(result.cached),
      attempts: result.attempts || 1, retried: Boolean(result.retried),
      fell_back: Boolean(result.fellBack),
      fell_back_from: sources.fell_back_from,
      title, created_at: answer.created_at,
    });
  }

  async function balanceOf(ownerId) {
    const wallet = await rewards.ensureWallet(ownerId);
    return wallet.balance;
  }
}
