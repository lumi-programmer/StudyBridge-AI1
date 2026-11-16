// AI Tutor — one conversation per space. Context, citations and cost all come
// from the Function; the browser holds no key and never grades itself.
import { api } from '../api.js';
import { clientKey, refresh, savePrefs, store } from '../store.js';
import { confirmSheet, citationList, emptyState, errorToast, field, h, modelTag, num, pageHead, richText, spinner, timeAgo, toast, untilLabel } from '../ui.js';

const STYLES = [
  ['beginner', 'Total beginner'], ['simple', 'Simple and short'], ['school', 'School textbook'],
  ['detailed', 'Detailed'], ['advanced', 'Advanced'], ['example', 'With worked examples'],
];
const LANGS = [['en', 'English'], ['ur', 'اردو (Urdu)']];

// Named by cause, because "an error happened" sends a student to the wrong fix.
const FAULT_HEADLINE = {
  second_model_required: 'Two models needed',
  provider_auth_failed: 'Your provider refused the key',
  provider_model_not_found: 'That model id was refused',
  provider_access_denied: 'Your plan does not include that model',
  provider_rate_limited: 'The provider throttled this minute',
  // Opposite cure to a throttle: waiting seconds does nothing here.
  provider_quota_exhausted: 'This key’s allowance is spent',
  models_temporarily_unavailable: 'The provider is busy right now',
  // Nothing was sent: this is StudyBridge resting the connection, not a refusal.
  provider_paused: 'Not sent — paused to let the provider recover',
  provider_unavailable: 'The provider is busy right now',
  provider_unreachable: 'The provider endpoint did not answer',
  provider_timeout: 'The provider took too long',
  provider_bad_request: 'The provider rejected the request',
  all_providers_failed: 'No configured provider answered',
  // Credit and capacity failures: no credits were taken for any of them.
  insufficient_credits: 'Not enough Bridge Credits',
  free_models_unavailable: 'Every free model is busy right now',
  unverified_model: 'That answer was discarded',
  pricing_not_verified: 'That model is not verified as free',
  daily_limit_reached: 'Today’s priced request limit is used up',
  idempotency_conflict: 'That request is already running',
};

// The codes a student can act on themselves. The rest point at Settings.
const SETTINGS_CODES = ['no_provider_configured', 'credentials_not_configured', 'no_model_available', 'trial_unavailable',
  'trial_daily_limit', 'trial_total_limit', 'no_vision_model', 'provider_auth_failed',
  'provider_model_not_found', 'provider_access_denied', 'provider_bad_request',
  'provider_rate_limited', 'provider_quota_exhausted', 'provider_unreachable', 'provider_timeout',
  'models_temporarily_unavailable', 'provider_paused', 'all_providers_failed'];

// What one request costs, read from the server's price table. The button says
// the number before the request is sent, and the ledger charges the same one.
function priceOf(feature) {
  const price = store.boot?.economy?.pricing?.[feature];
  return Number.isFinite(price) ? price : 0;
}

// Which model is actually going to answer, stated the way the router works:
// the platform's centrally managed free AI first, a provider the student
// connected themselves after that, and no model at all when neither exists.
function tutorIntro() {
  const boot = store.boot || {};
  const free = boot.free_models;
  const central = free?.central || {};
  const price = priceOf('basic_question');
  const paid = `Each question costs ${price} Bridge Credit${price === 1 ? '' : 's'}, shown before you send it and refunded automatically if the answer does not come back.`;
  const daily = boot.daily_ai || {};
  const allowance = daily.limit
    ? `You may ask ${daily.remaining === null ? daily.limit : daily.remaining} more question${(daily.remaining ?? daily.limit) === 1 ? '' : 's'} today; the allowance returns at midnight Pakistan time.`
    : '';
  if (boot.providers?.count) {
    return `Answers come from the provider you connected in Settings, written from the pages in this space. The list under each reply is the material it was actually given, and it is instructed never to invent page numbers or references. ${paid} ${allowance}`;
  }
  if (central.configured && central.available) {
    return `Answers come from StudyBridge Free AI — ${central.free_models} verified free model${central.free_models === 1 ? '' : 's'} whose $0 price was checked against the provider’s own catalogue. You do not need an account or an API key of your own, and a paid model is never substituted. The list under each reply is the material it was actually given, and it is instructed never to invent page numbers or references. ${paid} ${allowance}`;
  }
  if (free?.approved_free_models) {
    return `Answers come from the platform’s ${free.approved_free_models} verified free model${free.approved_free_models === 1 ? '' : 's'} — no key of your own is needed, and no paid model can ever answer. ${paid} ${allowance}`;
  }
  if (boot.trial?.configured) {
    return `Answers come from the platform Free Trial — ${boot.trial.remaining_today} of ${boot.trial.daily_limit} left today — until you connect your own key in Settings. It is finite, and it is instructed never to invent page numbers or references. ${paid}`;
  }
  return 'No model is connected yet, so questions cannot be answered here. Add your own key in Settings → AI Providers, or ask an administrator to publish a verified free model. Notes, saved questions, quizzes from your own text, focus, games and progress all work without a key.';
}

export async function render(root, { query, navigate }) {
  let spaces = [];
  try { spaces = await api.get('/api/spaces'); } catch { spaces = []; }
  if (!spaces.length) {
    root.appendChild(pageHead('🤖 AI Tutor', 'Pick a space first', 'The tutor only reads the books linked to the space you are in, so one subject never leaks into another.'));
    root.appendChild(emptyState('No spaces yet', 'Create a space, link a scanned book, then ask away.',
      h('a', { class: 'btn', href: '#/spaces?new=1', text: 'Create a space' })));
    return;
  }
  let spaceId = query.get('space') || store.prefs.lastSpace || spaces[0].id;
  if (!spaces.some(s => s.id === spaceId)) spaceId = spaces[0].id;

  const picker = h('select', { 'aria-label': 'Space', onChange: e => { spaceId = e.value; savePrefs({ lastSpace: spaceId }); load(); } },
    spaces.map(s => h('option', { value: s.id, selected: s.id === spaceId }, `${s.name}${s.subject ? ` · ${s.subject}` : ''}`)));
  const styleSel = h('select', { 'aria-label': 'Explanation style', onChange: e => savePrefs({ tutorStyle: e.target.value }) }, STYLES.map(([v, l]) => h('option', { value: v, selected: v === store.prefs.tutorStyle }, l)));
  const langSel = h('select', { 'aria-label': 'Language', onChange: e => savePrefs({ tutorLanguage: e.target.value }) }, LANGS.map(([v, l]) => h('option', { value: v, selected: v === store.prefs.tutorLanguage }, l)));
  let modelRowId = '';
  const modelSel = h('select', { 'aria-label': 'Model', onChange: e => { modelRowId = e.value; } });

  root.appendChild(pageHead('🤖 AI Tutor', 'Ask about this space', tutorIntro(),
    [h('a', { class: 'btn secondary', href: `#/spaces/${spaceId}`, text: 'Open space' })]));
  const balanceChip = h('span', { class: 'tag amber', text: `${num(store.boot?.wallet?.balance ?? 0)} BC` });
  const costChip = h('span', { class: 'tag grey', text: `${priceOf('basic_question')} BC per question` });
  // The daily allowance and the moment it returns. Both come from the server,
  // so the device clock only decides how long the countdown reads.
  const daily = store.boot?.daily_ai || {};
  const usageChip = h('span', { class: 'tag teal', text: daily.limit ? `${num(daily.remaining ?? 0)} of ${num(daily.limit)} questions left today` : 'daily questions unlimited' });
  const resetChip = h('span', { class: 'tag grey', text: `resets ${untilLabel(store.boot?.next_reset)} (Pakistan time)` });
  root.appendChild(h('div', { class: 'card row wrap-gap' },
    h('div', { style: { flex: '1 1 200px' } }, field('Space', picker)),
    h('div', { style: { flex: '1 1 160px' } }, field('Style', styleSel)),
    h('div', { style: { flex: '1 1 120px' } }, field('Language', langSel)),
    h('div', { style: { flex: '1 1 180px' } }, field('Model', modelSel, 'Auto = cheapest capable model')),
    h('div', { class: 'row wrap-gap', style: { alignItems: 'flex-end' } },
      balanceChip, costChip, usageChip, resetChip,
      h('button', { class: 'btn ghost sm', type: 'button', text: 'Advanced check (10 BC)', onClick: () => advancedToggle() }))));

  const log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' });
  const note = h('p', { class: 'tiny muted' });
  const input = h('textarea', { placeholder: 'Ask anything about this subject…', maxlength: '4000', 'aria-label': 'Question', rows: '2' });
  const ask = h('button', { class: 'btn', type: 'button', text: 'Ask', onClick: () => send() });
  let advanced = false;
  function advancedToggle() {
    advanced = !advanced;
    ask.textContent = advanced ? 'Run two-model check (10 BC)' : 'Ask';
    ask.classList.toggle('amber', advanced);
    costChip.textContent = `${priceOf(advanced ? 'advanced_comparison' : 'basic_question')} BC per question`;
    note.textContent = advanced
      ? 'Advanced check: two of your enabled models answer, then a third pass merges them. Costs 10 BC and two provider calls on your own account. Needs at least two enabled models.'
      : '';
    if (advanced) toast('Advanced check uses your provider twice and 10 BC.', '', 7000);
  }

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); }
  });

  let data = null;
  async function load() {
    log.replaceChildren(spinner('Loading this conversation…'));
    try {
      data = await api.get(`/api/spaces/${spaceId}`);
      // The Function stores what it did in each answer's `sources` column; the
      // tags below are rebuilt from it, so a reload shows the same provenance.
      for (const message of data.messages || []) {
        const stored = message.sources || {};
        if (!message.citations) message.citations = stored.citations;
        if (message.cached === undefined) message.cached = stored.cached;
        if (message.retried === undefined) message.retried = stored.retried;
        if (message.fell_back === undefined) message.fell_back = stored.fell_back;
        if (!message.fell_back_from) message.fell_back_from = stored.fell_back_from;
      }
      paintMessages();
      const models = [];
      try {
        const p = await api.get('/api/providers');
        for (const provider of p.providers) {
          for (const model of provider.models.filter(m => m.enabled)) models.push([model.id, `${provider.api_name} · ${model.model_name || model.model_id}`]);
        }
      } catch { /* the auto router still works with no list */ }
      modelSel.replaceChildren(h('option', { value: '' }, 'Auto (cheapest capable)'), ...models.map(([v, l]) => h('option', { value: v, selected: v === modelRowId }, l)));
      if (data.space.instructions) note.textContent = `Space instructions: ${data.space.instructions.slice(0, 160)}`;
    } catch (error) {
      log.replaceChildren(h('div', { class: 'banner bad' }, h('div', {}, h('b', { text: 'Could not open this space' }), h('span', { text: error.hint || error.message }))));
    }
  }

  function paintMessages() {
    const nodes = data.messages.map(m => bubble(m));
    if (!nodes.length) nodes.push(emptyState('No questions yet', 'Try “explain Newton’s second law with one example from my pages”.'));
    log.replaceChildren(...nodes);
    log.scrollTop = log.scrollHeight;
  }

  async function send() {
    const message = input.value.trim();
    if (!message) { toast('Type a question first.', 'bad'); return; }
    if (advanced && !store.boot?.providers?.models) { toast('The advanced check needs at least two enabled models. Ask normally instead.', 'bad', 7000); return; }
    ask.disabled = true;
    input.disabled = true;
    data.messages.push({ role: 'user', content: message, created_at: new Date().toISOString() });
    paintMessages();
    const thinking = spinner(advanced ? 'Running the two-model check…' : 'Thinking…');
    log.appendChild(thinking);
    log.scrollTop = log.scrollHeight;
    try {
      const res = await api.post(`/api/spaces/${spaceId}/chat`, {
        message, style: store.prefs.tutorStyle, language: store.prefs.tutorLanguage,
        model_row_id: modelRowId || undefined, advanced: advanced || undefined,
        // Every request carries a key, so a double click or a retry can never be
        // charged twice for the same question.
        client_key: clientKey(),
      });
      thinking.remove();
      data.messages.push({
        role: 'assistant', content: res.reply, created_at: new Date().toISOString(),
        provider: res.provider, model: res.model, citations: res.citations, checked: res.checked,
        cached: res.cached, tokens: res.tokens, advanced: res.advanced, note: res.note,
        retried: res.retried, fell_back: res.fell_back, fell_back_from: res.fell_back_from,
        credits_spent: res.credits_spent, replayed: res.replayed,
      });
      paintMessages();
      input.value = '';
      advanced = false;
      ask.textContent = 'Ask';
      ask.classList.remove('amber');
      costChip.textContent = `${priceOf('basic_question')} BC per question`;
      if (res.balance !== undefined) {
        balanceChip.textContent = `${num(res.balance)} BC`;
        toast(res.replayed
          ? 'That exact question was already answered — no credits were taken again.'
          : `Answered · ${num(res.credits_spent ?? 0)} BC used · balance ${num(res.balance)} BC.`);
      }
      refresh().then(paintNote);
    } catch (error) {
      thinking.remove();
      data.messages = data.messages.filter(m => !(m.role === 'user' && m.content === message));
      paintMessages();
      // A failed trial call still spends budget, so the counts are re-read here too.
      refresh().then(paintNote);
      log.appendChild(h('div', { class: 'banner bad' }, h('div', {},
        h('b', { text: FAULT_HEADLINE[error.code] || 'That answer did not come back' }),
        h('span', { text: error.hint || error.message || 'Try again, or ask normally.' }),
        error.code === 'insufficient_credits'
          ? h('a', { class: 'btn sm', href: '#/rewards', text: 'Earn Bridge Credits' })
          : error.code === 'free_models_unavailable'
            ? h('a', { class: 'btn sm', href: '#/rewards', text: 'Rewards Center' })
            : null,
        SETTINGS_CODES.includes(error.code)
          ? h('a', { class: 'btn sm', href: '#/settings', text: 'Open Settings' }) : null)));
    }
    ask.disabled = false;
    input.disabled = false;
    input.focus();
  }

  function bubble(message) {
    const mine = message.role === 'user';
    const dir = !mine && store.prefs.tutorLanguage === 'ur' ? 'rtl' : null;
    return h('article', { class: `msg ${mine ? 'me' : 'ai'}` },
      h('div', { class: 'row between msg-head' },
        h('b', { class: 'tiny', text: mine ? 'You' : 'Tutor' }),
        h('span', { class: 'row wrap-gap' },
          mine ? null : modelTag(message.provider, message.model),
          // The model that actually answered is named, and so is the one that
          // did not: a fallback is never silent.
          message.fell_back ? h('span', {
            class: 'tag amber',
            title: `Skipped: ${(message.fell_back_from || []).join(', ') || 'an earlier model'}`,
            text: 'via fallback',
          }) : null,
          message.retried ? h('span', { class: 'tag grey', title: 'Retried after a temporary provider error', text: 'retried' }) : null,
          message.cached ? h('span', { class: 'tag teal', text: 'cached' }) : null,
          message.credits_spent ? h('span', { class: 'tag amber', text: `${num(message.credits_spent)} BC` }) : null,
          message.replayed ? h('span', { class: 'tag grey', text: 'replayed — not charged twice' }) : null,
          message.tokens ? h('span', { class: 'tag grey', text: `${num(message.tokens)} tokens` }) : null,
          h('small', { class: 'muted tiny', text: timeAgo(message.created_at) }))),
      mine ? h('p', { text: message.content }) : richText(message.content, { dir }),
      message.checked ? h('details', { class: 'card-flat' }, h('summary', { class: 'tiny', text: `The two raw answers that were merged (${message.checked.length})` }),
        message.checked.map(a => h('div', { class: 'tight' }, h('b', { class: 'tiny', text: a.label }), richText(a.text)))) : null,
      mine ? null : citationList(message.citations),
      mine ? null : (message.note ? h('p', { class: 'tiny muted', text: message.note }) : null),
      mine ? h('div', { class: 'row end' }, h('button', { class: 'btn ghost sm', type: 'button', text: 'Save to questions', onClick: async () => {
        try { await api.post(`/api/spaces/${spaceId}/questions`, { question: message.content.slice(0, 1200), topic: data.space.subject || '' }); toast('Saved to this space’s questions.', 'good'); }
        catch (error) { errorToast(error); }
      } })) : null);
  }

  await load();
  const prefill = query.get('ask');
  if (prefill) { input.value = prefill; input.focus(); }
  // Say what will actually happen when the student presses Ask — the platform's
  // own free AI answering, or the request failing with a pointer to Settings.
  // Repainted after every send, because a failed call still costs nothing but
  // the allowance counter has to be read from the server again.
  function paintNote() {
    const boot = store.boot || {};
    const daily = boot.daily_ai || {};
    usageChip.textContent = daily.limit ? `${num(daily.remaining ?? 0)} of ${num(daily.limit)} questions left today` : 'daily questions unlimited';
    resetChip.textContent = `resets ${untilLabel(boot.next_reset)} (Pakistan time)`;
    if (boot.providers?.count) return;
    const free = boot.free_models;
    const central = free?.central || {};
    const trial = boot.trial;
    const status = central.configured && central.available
      ? `StudyBridge Free AI answers here — ${central.free_models} verified free model${central.free_models === 1 ? '' : 's'}, each checked at $0 on the provider’s own list. No key of your own is needed and no paid model can be selected.`
      : central.configured && central.quota_blocked
        ? 'The shared free allowance is used up, so StudyBridge AI is temporarily busy. Please try again later — nothing was charged.'
        : free?.approved_free_models
          ? `The platform’s ${free.approved_free_models} verified free model${free.approved_free_models === 1 ? '' : 's'} answer here. No key of your own is needed, and no paid model can be selected.`
          : trial?.configured
            ? `No provider of your own yet, so the platform Free Trial answers instead — ${trial.remaining_today} of ${trial.daily_limit} left today. Your own key in Settings has no platform cap.`
            : 'No model is connected, so asking here stops with that message instead of an invented answer. Add a key in Settings → AI Providers; notes, saved questions, quizzes from your own text, focus and games need no key at all.';
    note.textContent = status;
  }
  paintNote();
  root.appendChild(h('div', { class: 'tutor stack' }, log,
    h('div', { class: 'card row compose' }, h('div', { style: { flex: 1 } }, input), ask),
    note,
    h('div', { class: 'row' },
      h('button', { class: 'btn ghost sm', type: 'button', text: 'Clear this chat', onClick: () => confirmSheet({
        title: 'Clear the chat in this space?', body: 'Every message here is deleted. Notes, saved questions and credits are untouched.',
        confirmLabel: 'Clear chat', tone: 'danger',
        onConfirm: async () => { await api.del(`/api/spaces/${spaceId}/messages`); toast('Chat cleared.'); load(); },
      }) }),
      h('a', { class: 'btn ghost sm', href: '#/scanner?stage=tools', text: 'Run a study tool instead' }))));
}
