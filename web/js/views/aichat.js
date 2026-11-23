// AI Chat — the dedicated ChatGPT-style section. Whole titled conversations
// persist per student on the server (app.chat_conversations/chat_messages); the
// same central gateway answers and the same Bridge Credits ledger charges as
// the AI Tutor. The browser never sees a key, never prices a model and never
// computes a balance — every number on screen is read back from the Function.
import { api } from '../api.js';
import { clientKey, refresh, store } from '../store.js';
import {
  confirmSheet, errorCard, errorToast, field, h, modelTag, num,
  openSheet, richText, sheetTitle, spinner, timeAgo, toast,
} from '../ui.js';

// Named by cause, shared with the tutor so every surface phrases the same
// failure the same way.
const FAULT_HEADLINE = {
  insufficient_credits: 'Not enough Bridge Credits',
  free_models_unavailable: 'Every free model is busy right now',
  unverified_model: 'That answer was discarded',
  pricing_not_verified: 'That model is not verified as free',
  daily_limit_reached: 'Today’s AI question allowance is used up',
  idempotency_conflict: 'That message is already being answered',
  models_temporarily_unavailable: 'The provider is busy right now',
  provider_paused: 'Not sent — paused to let the provider recover',
  all_providers_failed: 'No configured provider answered',
  no_provider_configured: 'No AI model is connected yet',
};

const SUGGESTIONS = [
  'Explain a difficult chemistry concept',
  'Help me understand a physics problem',
  'Summarize my study notes',
  'Create practice questions for my exam',
];

function priceOf(feature) {
  const price = store.boot?.economy?.pricing?.[feature];
  return Number.isFinite(price) ? price : 0;
}

function chatIntro() {
  const boot = store.boot || {};
  const price = priceOf('basic_question');
  const paid = `Each message costs ${price} Bridge Credit${price === 1 ? '' : 's'} and is refunded automatically if no answer comes back.`;
  const daily = boot.daily_ai || {};
  const allowance = daily.limit
    ? ` ${num(daily.remaining ?? daily.limit)} of ${num(daily.limit)} questions left today; the allowance returns at midnight Pakistan time.`
    : '';
  const free = boot.free_models;
  const central = free?.central || {};
  if (boot.providers?.count) {
    return `Answers come from the provider you connected in Settings. ${paid}${allowance}`;
  }
  if (central.configured && central.available) {
    return `Answers come from StudyBridge Free AI — ${central.free_models} verified free model${central.free_models === 1 ? '' : 's'} whose $0 price was checked against the provider’s own catalogue. No key of your own is needed, and a paid model is never substituted. ${paid}${allowance}`;
  }
  if (free?.approved_free_models) {
    return `Answers come from the platform’s ${free.approved_free_models} verified free model${free.approved_free_models === 1 ? '' : 's'} — no key of your own is needed, and no paid model can ever answer. ${paid}${allowance}`;
  }
  if (boot.trial?.configured) {
    return `Answers come from the platform Free Trial — ${boot.trial.remaining_today} of ${boot.trial.daily_limit} left today — until you connect your own key in Settings. ${paid}`;
  }
  return 'No model is connected yet, so messages cannot be answered here. Add your own key in Settings → AI Providers, or ask an administrator to publish a verified free model. Focus, games and progress all work without a key.';
}

// ---------- markdown with fenced code blocks ----------
// Everything is built with textContent — model output can never become markup.
// Text outside fences goes through the shared richText renderer; fences become
// a labelled block with a Copy button and light token colouring for languages
// the highlighter actually knows.
const HASH_COMMENT_LANGS = new Set(['python', 'py', 'bash', 'sh', 'shell', 'ruby', 'yaml', 'yml', 'r']);
const SQL_LANGS = new Set(['sql']);
const KNOWN_LANGS = new Set([
  'js', 'javascript', 'ts', 'typescript', 'jsx', 'tsx', 'python', 'py', 'java', 'c', 'cpp', 'csharp', 'cs',
  'go', 'rust', 'php', 'ruby', 'swift', 'kotlin', 'sql', 'json', 'bash', 'sh', 'shell', 'yaml', 'yml', 'r',
]);
const KEYWORDS = new Set([
  'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'def', 'default',
  'delete', 'do', 'elif', 'else', 'end', 'enum', 'except', 'export', 'extends', 'false', 'finally', 'fn',
  'for', 'from', 'func', 'function', 'go', 'if', 'implements', 'import', 'in', 'instanceof', 'interface',
  'is', 'lambda', 'let', 'match', 'mut', 'new', 'nil', 'none', 'not', 'null', 'or', 'package', 'pass',
  'print', 'private', 'protected', 'public', 'raise', 'return', 'select', 'self', 'static', 'str', 'struct',
  'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'update', 'var', 'void', 'where',
  'while', 'with', 'yield', 'insert', 'into', 'values', 'join', 'group', 'order', 'limit',
]);

function highlightCode(code, lang) {
  const comment = HASH_COMMENT_LANGS.has(lang) ? '#[^\\n]*'
    : SQL_LANGS.has(lang) ? '--[^\\n]*'
    : '//[^\\n]*';
  const pattern = new RegExp(
    `(${comment})|("(?:\\\\.|[^"\\\\])*"|'(?:\\\\.|[^'\\\\])*'|\`(?:\\\\.|[^\`\\\\])*\`)`
    + `|(\\b\\d+(?:\\.\\d+)?\\b)|(\\b[A-Za-z_$][\\w$]*\\b)`, 'g');
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of String(code).matchAll(pattern)) {
    if (m.index > last) frag.appendChild(document.createTextNode(code.slice(last, m.index)));
    const [full, com, str, numLit, word] = m;
    if (com) frag.appendChild(h('span', { class: 'tok-com', text: com }));
    else if (str) frag.appendChild(h('span', { class: 'tok-str', text: str }));
    else if (numLit) frag.appendChild(h('span', { class: 'tok-num', text: numLit }));
    else if (word && KEYWORDS.has(word.toLowerCase())) frag.appendChild(h('span', { class: 'tok-kw', text: word }));
    else frag.appendChild(document.createTextNode(full));
    last = m.index + full.length;
  }
  if (last < code.length) frag.appendChild(document.createTextNode(code.slice(last)));
  return frag;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch {
    const area = h('textarea', { value: text, style: { position: 'fixed', opacity: '0' } });
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    toast(ok ? 'Copied.' : 'Copy failed — select the code manually.', ok ? '' : 'bad');
  }
}

function codeBlock(lang, code) {
  const known = KNOWN_LANGS.has(lang);
  const label = lang || 'code';
  const body = h('code');
  if (known) body.appendChild(highlightCode(code, lang));
  else body.textContent = code;
  return h('figure', { class: 'codeblock' },
    h('figcaption', { class: 'codeblock-head' },
      h('span', { class: 'tiny muted', text: label }),
      h('button', {
        class: 'btn ghost sm', type: 'button', text: 'Copy',
        onClick: () => copyText(code),
      })),
    h('pre', {}, body));
}

// Fenced ``` blocks are split out first; the surrounding prose keeps the shared
// renderer (headings, bullets, bold — and now inline `code`).
function chatRich(text) {
  const root = h('div', { class: 'rich' });
  const source = String(text || '').replace(/\r/g, '');
  const fence = /```[ \t]*([A-Za-z0-9_+#.-]*)[ \t]*\r?\n?([\s\S]*?)```/g;
  let last = 0;
  for (const m of source.matchAll(fence)) {
    if (m.index > last) root.appendChild(richText(source.slice(last, m.index)));
    root.appendChild(codeBlock(m[1].toLowerCase(), m[2].replace(/\n$/, '')));
    last = m.index + m[0].length;
  }
  if (last < source.length) root.appendChild(richText(source.slice(last)));
  return root;
}

export async function render(root, { query }) {
  let conversations = [];
  let convBefore = null;
  let currentId = null;   // null = a fresh draft; the row is created on first send
  let currentTitle = 'New chat';
  let messages = [];
  let msgBefore = null;   // cursor for "load earlier" in the open thread
  let sending = false;
  let convToken = 0;

  // ---------- chrome ----------
  const balanceChip = h('span', { class: 'tag amber', title: 'Bridge Credits balance', text: `${num(store.boot?.wallet?.balance ?? 0)} BC` });
  const costChip = h('span', { class: 'tag grey', text: `${priceOf('basic_question')} BC per message` });
  const headTitle = h('b', { class: 'chat-main-title', text: currentTitle });
  const renameBtn = h('button', { class: 'btn ghost sm', type: 'button', text: 'Rename', hidden: true, onClick: () => renameSheet(conversations.find(c => c.id === currentId)) });
  const deleteBtn = h('button', { class: 'btn ghost sm danger', type: 'button', text: 'Delete', hidden: true, onClick: () => { const c = conversations.find(x => x.id === currentId); if (c) deleteConversation(c); } });
  const drawerBtn = h('button', {
    class: 'btn ghost sm chat-drawer-btn', type: 'button', text: '☰ Chats',
    onClick: () => document.body.classList.toggle('chat-drawer-open'),
  });
  const closeDrawer = () => document.body.classList.remove('chat-drawer-open');

  // ---------- sidebar ----------
  const sideList = h('div', { class: 'chat-side-list' });
  const sideMore = h('button', { class: 'btn ghost sm chat-side-more', type: 'button', hidden: true, text: 'Load older chats', onClick: loadMoreConversations });
  const newBtn = h('button', { class: 'btn chat-new', type: 'button', text: '＋ New chat', onClick: () => { if (!sending) { startDraft(); closeDrawer(); } else toast('Wait for the current answer first.', 'bad'); } });

  function paintSidebar() {
    if (!conversations.length) {
      sideList.replaceChildren(h('p', { class: 'tiny muted chat-side-empty', text: 'No chats yet. Start one with “New chat” — it is saved here automatically.' }));
      sideMore.hidden = true;
      return;
    }
    sideList.replaceChildren(...conversations.map(conv => h('div', { class: `chat-item${conv.id === currentId ? ' active' : ''}`, dataset: { cid: conv.id } },
      h('button', {
        class: 'chat-item-main', type: 'button',
        title: conv.title || 'New chat',
        onClick: () => { if (!sending) { openConversation(conv.id); closeDrawer(); } else toast('Wait for the current answer first.', 'bad'); },
      },
        h('span', { class: 'chat-item-title', text: conv.title || 'New chat' }),
        h('span', { class: 'tiny muted chat-item-meta', text: `${timeAgo(conv.updated_at)} · ${num(conv.message_count)} message${conv.message_count === 1 ? '' : 's'}` })),
      h('button', { class: 'chat-item-act', type: 'button', 'aria-label': `Rename “${conv.title || 'New chat'}”`, title: 'Rename', text: '✏️', onClick: () => renameSheet(conv) }),
      h('button', { class: 'chat-item-act', type: 'button', 'aria-label': `Delete “${conv.title || 'New chat'}”`, title: 'Delete', text: '🗑️', onClick: () => deleteConversation(conv) }))));
    sideMore.hidden = !convBefore;
  }

  async function loadConversations() {
    sideList.replaceChildren(spinner('Loading chats…'));
    try {
      const data = await api.get('/api/chats?limit=30');
      conversations = data.conversations || [];
      convBefore = data.next_before;
      paintSidebar();
    } catch {
      sideList.replaceChildren(h('p', { class: 'tiny muted chat-side-empty', text: 'Chats could not be loaded just now.' }));
      sideMore.hidden = true;
    }
  }

  async function loadMoreConversations() {
    if (!convBefore) return;
    sideMore.disabled = true;
    try {
      const data = await api.get(`/api/chats?limit=30&before=${encodeURIComponent(convBefore)}`);
      conversations = [...conversations, ...(data.conversations || [])];
      convBefore = data.next_before;
      paintSidebar();
    } catch (error) {
      errorToast(error);
    }
    sideMore.disabled = false;
  }

  function renameSheet(conv) {
    if (!conv) return;
    const input = h('input', { type: 'text', maxlength: '80', value: conv.title || '', 'aria-label': 'Conversation name', dataset: { autofocus: '1' } });
    const saveBtn = h('button', { class: 'btn', type: 'button', text: 'Save', onClick: async () => {
      const title = input.value.trim();
      if (!title) { toast('Give the chat a name.', 'bad'); return; }
      saveBtn.disabled = true;
      try {
        const res = await api.patch(`/api/chats/${conv.id}`, { title });
        conv.title = res.conversation?.title || title;
        if (conv.id === currentId) { currentTitle = conv.title; headTitle.textContent = conv.title; }
        paintSidebar();
        close();
        toast('Renamed.', 'good');
      } catch (error) {
        saveBtn.disabled = false;
        errorToast(error);
      }
    } });
    const close = openSheet(h('div', {},
      sheetTitle('Rename chat'),
      field('Name', input),
      h('div', { class: 'row end', style: { marginTop: '16px' } },
        h('button', { class: 'btn secondary', type: 'button', text: 'Cancel', onClick: () => close() }),
        saveBtn)));
  }

  function deleteConversation(conv) {
    confirmSheet({
      title: 'Delete this chat?',
      body: `“${conv.title || 'New chat'}” and all of its messages will be removed for good. Credits already spent are not returned.`,
      confirmLabel: 'Delete chat', tone: 'danger',
      onConfirm: async () => {
        await api.del(`/api/chats/${conv.id}`);
        conversations = conversations.filter(c => c.id !== conv.id);
        if (conv.id === currentId) startDraft();
        paintSidebar();
        toast('Chat deleted.');
      },
    });
  }

  // ---------- main panel ----------
  const log = h('div', { class: 'chat-log chat-page-log', role: 'log', 'aria-live': 'polite' });
  let stick = true;
  log.addEventListener('scroll', () => {
    stick = log.scrollHeight - log.scrollTop - log.clientHeight < 140;
  });
  function scrollBottom(force) {
    if (force || stick) log.scrollTop = log.scrollHeight;
  }

  const input = h('textarea', {
    class: 'chat-input', placeholder: 'Message StudyBridge AI…', maxlength: '6000', rows: '1', 'aria-label': 'Message',
  });
  const sendBtn = h('button', { class: 'btn chat-send', type: 'button', text: 'Send', onClick: () => send() });

  function autoresize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
  }
  input.addEventListener('input', autoresize);
  // Enter sends; Shift+Enter makes a newline — the composer stays multiline.
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  });

  function welcome() {
    return h('div', { class: 'chat-welcome' },
      h('div', { class: 'chat-welcome-mark', 'aria-hidden': 'true', text: '✨' }),
      h('h2', { text: 'How can I help you study today?' }),
      h('p', { class: 'muted', text: chatIntro() }),
      h('div', { class: 'chat-suggest' },
        SUGGESTIONS.map(s => h('button', { class: 'chat-suggest-btn', type: 'button', text: s, onClick: () => send(s) }))));
  }

  function retryStrip(m) {
    return h('div', { class: 'row between chat-retry' },
      h('span', { class: 'tiny muted', text: 'No answer came back — nothing was charged. You can try again.' }),
      h('button', { class: 'btn sm', type: 'button', text: 'Retry', onClick: () => { if (!sending) performSend(m.content, m.key); else toast('Wait for the current answer first.', 'bad'); } }));
  }

  function bubble(m) {
    const mine = m.role === 'user';
    return h('article', { class: `msg ${mine ? 'me' : 'ai'}` },
      h('div', { class: 'row between msg-head' },
        h('b', { class: 'tiny', text: mine ? 'You' : 'AI' }),
        h('span', { class: 'row wrap-gap' },
          mine ? null : modelTag(m.provider, m.model),
          m.fell_back ? h('span', {
            class: 'tag amber',
            title: `Skipped: ${(m.fell_back_from || []).join(', ') || 'an earlier model'}`,
            text: 'via fallback',
          }) : null,
          m.retried ? h('span', { class: 'tag grey', title: 'Retried after a temporary provider error', text: 'retried' }) : null,
          m.cached ? h('span', { class: 'tag teal', text: 'cached' }) : null,
          m.replayed ? h('span', { class: 'tag grey', text: 'replayed — not charged twice' }) : null,
          m.state === 'failed' ? h('span', { class: 'tag rose', text: 'failed — refunded' }) : null,
          m.credits_spent ? h('span', { class: 'tag amber', text: `${num(m.credits_spent)} BC` }) : null,
          h('small', { class: 'muted tiny', text: timeAgo(m.created_at) }))),
      mine ? h('p', { text: m.content }) : chatRich(m.content),
      mine && m.state === 'failed' ? retryStrip(m) : null,
      !mine && m.note ? h('p', { class: 'tiny muted', text: m.note }) : null);
  }

  const earlierBtn = h('button', { class: 'btn ghost sm chat-earlier', type: 'button', text: 'Load earlier messages', onClick: loadEarlier });

  function paint() {
    const nodes = [];
    if (msgBefore) nodes.push(earlierBtn);
    if (!messages.length) nodes.push(welcome());
    else nodes.push(...messages.map(bubble));
    log.replaceChildren(...nodes);
  }

  // ---------- data flows ----------
  function startDraft() {
    currentId = null;
    currentTitle = 'New chat';
    messages = [];
    msgBefore = null;
    paint();
    paintHeader();
    markActive();
    input.focus();
  }

  function markActive() {
    for (const item of sideList.querySelectorAll('.chat-item')) {
      item.classList.toggle('active', item.dataset.cid === currentId);
    }
  }

  function paintHeader() {
    headTitle.textContent = currentTitle;
    const live = Boolean(currentId);
    renameBtn.hidden = !live;
    deleteBtn.hidden = !live;
  }

  async function openConversation(id) {
    const token = ++convToken;
    currentId = id;
    messages = [];
    msgBefore = null;
    log.replaceChildren(spinner('Loading this chat…'));
    try {
      const data = await api.get(`/api/chats/${id}/messages`);
      if (token !== convToken) return;
      messages = (data.messages || []).map(m => ({ ...m, key: m.request_key || undefined }));
      msgBefore = data.next_before;
      const conv = conversations.find(c => c.id === id);
      currentTitle = conv?.title || data.conversation?.title || 'Chat';
      paint();
      paintHeader();
      markActive();
      stick = true;
      scrollBottom(true);
    } catch (error) {
      if (token !== convToken) return;
      if (error?.code === 'not_found') {
        conversations = conversations.filter(c => c.id !== id);
        paintSidebar();
        startDraft();
        return;
      }
      log.replaceChildren(errorCard(error, () => openConversation(id)));
    }
  }

  async function loadEarlier() {
    if (!currentId || !msgBefore) return;
    earlierBtn.disabled = true;
    try {
      const data = await api.get(`/api/chats/${currentId}/messages?limit=50&before=${encodeURIComponent(msgBefore)}`);
      const older = data.messages || [];
      if (older.length) {
        const prevHeight = log.scrollHeight;
        const prevTop = log.scrollTop;
        messages = [...older.map(m => ({ ...m, key: m.request_key || undefined })), ...messages];
        msgBefore = data.next_before;
        paint();
        log.scrollTop = log.scrollHeight - prevHeight + prevTop;
      } else {
        msgBefore = null;
        paint();
      }
    } catch (error) {
      errorToast(error);
    }
    earlierBtn.disabled = false;
  }

  async function send(preset) {
    const content = String(preset ?? input.value).trim();
    if (!content) { toast('Type a message first.', 'bad'); return; }
    if (sending) return;
    await performSend(content, clientKey());
  }

  // One send, one key. A retry of a failed message reuses the SAME key, so the
  // ledger books it as another attempt of one message — never a second charge
  // for an answer that was refunded.
  async function performSend(content, key) {
    sending = true;
    sendBtn.disabled = true;
    sendBtn.textContent = '…';
    const optimistic = {
      role: 'user', content, key, state: 'sending',
      created_at: new Date().toISOString(),
    };
    messages.push(optimistic);
    paint();
    stick = true;
    scrollBottom(true);
    const thinking = spinner('Thinking…');
    log.appendChild(thinking);
    scrollBottom(true);
    try {
      const res = currentId
        ? await api.post(`/api/chats/${currentId}/messages`, { content, client_key: key })
        : await api.post('/api/chats', { content, client_key: key });
      thinking.remove();
      optimistic.id = res.user_message_id || undefined;
      optimistic.state = '';
      optimistic.credits_spent = res.credits_spent;
      messages.push({
        role: 'assistant', content: res.reply, provider: res.provider, model: res.model,
        cached: res.cached, retried: res.retried, fell_back: res.fell_back,
        fell_back_from: res.fell_back_from, tokens: res.tokens,
        credits_spent: res.credits_spent, replayed: res.replayed, note: res.note,
        created_at: res.created_at || new Date().toISOString(),
      });
      if (!currentId) currentId = res.conversation_id;
      currentTitle = res.title || currentTitle;
      input.value = '';
      autoresize();
      if (res.balance !== undefined) balanceChip.textContent = `${num(res.balance)} BC`;
      toast(res.replayed
        ? 'That exact message was already answered — no credits were taken again.'
        : `Answered · ${num(res.credits_spent ?? 0)} BC used · balance ${num(res.balance)} BC.`);
      paint();
      stick = true;
      scrollBottom(true);
      paintHeader();
      markActive();
      loadConversations();
      refresh();
    } catch (error) {
      thinking.remove();
      optimistic.state = 'failed';
      paint();
      scrollBottom();
      refresh();
      log.appendChild(h('div', { class: 'banner bad' }, h('div', {},
        h('b', { text: FAULT_HEADLINE[error.code] || 'That answer did not come back' }),
        h('span', { text: error.hint || error.message || 'Try again — nothing was charged.' }),
        error.code === 'insufficient_credits'
          ? h('a', { class: 'btn sm', href: '#/rewards', text: 'Earn Bridge Credits' })
          : error.code === 'free_models_unavailable' || error.code === 'models_temporarily_unavailable'
            ? h('span', { class: 'tiny muted', text: 'This is temporary — press Retry on your message in a moment.' })
            : null,
        error.code === 'no_provider_configured'
          ? h('a', { class: 'btn sm', href: '#/settings', text: 'Open Settings' })
          : null)));
      scrollBottom();
    }
    sending = false;
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send';
    input.focus();
  }

  // ---------- mount ----------
  const overlay = h('div', { class: 'chat-overlay', onClick: closeDrawer });
  root.appendChild(h('div', { class: 'chat-app' },
    overlay,
    h('aside', { class: 'chat-side' }, newBtn, sideList, sideMore),
    h('section', { class: 'chat-main' },
      h('header', { class: 'chat-main-head' },
        drawerBtn, headTitle, h('span', { class: 'spacer' }), balanceChip, costChip, renameBtn, deleteBtn),
      log,
      h('div', { class: 'chat-compose' },
        h('div', { class: 'chat-compose-box' }, input, sendBtn),
        h('p', { class: 'tiny muted chat-compose-hint', text: 'Enter to send · Shift+Enter for a new line' })))));

  const onKey = event => {
    if (event.key === 'Escape') closeDrawer();
  };
  document.addEventListener('keydown', onKey);

  await loadConversations();
  const deepLink = query.get('c');
  if (deepLink && conversations.some(c => c.id === deepLink)) await openConversation(deepLink);
  else if (conversations.length === 1) await openConversation(conversations[0].id);
  paintHeader();
  input.focus();

  return () => {
    document.removeEventListener('keydown', onKey);
    document.body.classList.remove('chat-drawer-open');
  };
}
