// Settings — preferences, notifications, bring-your-own-key providers and data
// cleanup. The API key exists only inside this form submission; nothing here
// writes a key to storage, logs, or the DOM.
import { api } from '../api.js';
import { refresh, store } from '../store.js';
import { MODES, currentMode, resolved, setMode } from '../theme.js';
import { confirmSheet, emptyState, errorCard, errorToast, field, h, microToText, num, openSheet, pageHead, pct, select, sheetTitle, timeAgo, toast, untilLabel } from '../ui.js';

const LEVELS = [['beginner', 'Total beginner'], ['simple', 'Simple'], ['school', 'School textbook'], ['detailed', 'Detailed'], ['advanced', 'Advanced'], ['example', 'Worked examples']];
const NOTIFS = [['daily_goal', 'Daily goal reminder'], ['daily_question', 'Daily question reminder'], ['breaks', 'Break reminders'], ['challenges', 'Challenge reminders'], ['streak', 'Streak reminders']];

export async function render(root, { navigate }) {
  root.appendChild(pageHead('Settings', 'Your setup', 'Preferences, AI providers you connect yourself, and the data you can delete at any time. Free tools keep working with no provider at all.'));
  const body = h('div', { class: 'stack' });
  root.appendChild(body);
  const boot = store.boot;
  if (!boot?.profile) { body.replaceChildren(emptyState('No profile yet', 'Reload the page to sign in and create one.')); return; }

  const teardowns = [];
  body.appendChild(profileCard(boot.profile));
  body.appendChild(appearanceCard(boot.profile, teardowns));
  body.appendChild(notificationCard(boot.profile));
  const providers = h('div', { class: 'stack' }, loadingSection('Reading your AI providers…'));
  body.appendChild(providers);
  body.appendChild(dataCard());
  body.appendChild(aboutCard(boot));
  // Every provider/model mutation re-reads /api/ai/settings into this one host,
  // so the numbers shown always come from the server, not from local guesses.
  const reloadProviders = async () => { await refresh(); await loadProviders(providers, navigate, reloadProviders); };
  await loadProviders(providers, navigate, reloadProviders);
  return () => { for (const stop of teardowns) stop(); };
}

// ---------- appearance ----------
function appearanceCard(profile, teardowns) {
  const status = h('p', { class: 'tiny muted' });
  const buttons = MODES.map(([value, label]) => h('button', {
    type: 'button', text: label, onClick: () => { setMode(value); paint(); },
  }));
  const group = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Colour theme' }, buttons);
  function paint() {
    buttons.forEach((node, index) => {
      const on = MODES[index][0] === currentMode();
      node.classList.toggle('on', on);
      node.setAttribute('aria-pressed', String(on));
    });
    const now = resolved();
    status.textContent = currentMode() === 'system'
      ? `Following your device, which is reporting ${now} mode.`
      : `Showing ${now} mode on this device.`;
  }
  paint();
  const onChange = () => paint();
  document.addEventListener('studybridge:theme', onChange);
  teardowns.push(() => document.removeEventListener('studybridge:theme', onChange));
  return h('section', { class: 'card stack' },
    h('h3', { text: 'Appearance' }),
    h('p', { class: 'tiny muted', text: 'Light, dark, or match your device. Applies immediately — no reload. Both themes keep the same meaning for every colour: teal is verified book text, amber is earned credits.' }),
    group,
    status,
    h('p', { class: 'tiny muted', text: profile?.theme
      ? `Your profile already remembers “${profile.theme}”, so this choice follows you to another device. A change made here updates it.`
      : 'Saved on this device and written to your profile, so the next device you sign in on starts in the same theme.' }));
}

function loadingSection(text) {
  return h('section', { class: 'card' }, h('p', { class: 'muted tiny', text: text }));
}

// ---------- profile ----------
function profileCard(profile) {
  const name = h('input', { type: 'text', maxlength: '40', value: profile.display_name || '' });
  const language = select([['en', 'English'], ['ur', 'اردو (Urdu)']], profile.language);
  const level = select(LEVELS, profile.explanation_level);
  const goal = h('input', { type: 'number', min: '5', max: '480', value: String(profile.daily_goal_minutes ?? 30) });
  const limit = h('input', { type: 'number', min: '10', max: '2000', value: String(profile.ai_limit_per_day ?? 120) });
  const quick = h('input', { type: 'checkbox', checked: profile.quick_break_suggestions !== false });
  const save = h('button', { class: 'btn', type: 'submit', text: 'Save preferences' });

  async function send(event) {
    event.preventDefault();
    save.disabled = true;
    save.textContent = 'Saving…';
    try {
      await api.post('/api/profile', {
        display_name: name.value.trim(),
        language: language.value,
        explanation_level: level.value,
        daily_goal_minutes: Number(goal.value) || 30,
        ai_limit_per_day: Number(limit.value) || 120,
        quick_break_suggestions: quick.checked === true,
      });
      await refresh();
      toast('Preferences saved.', 'good');
    } catch (error) { errorToast(error); }
    save.disabled = false;
    save.textContent = 'Save preferences';
  }

  return h('form', { class: 'card stack', onSubmit: send },
    h('h3', { text: 'Study profile' }),
    h('div', { class: 'field-row' }, field('Display name', name), field('Language', language), field('Explanation level', level)),
    h('div', { class: 'field-row' },
      field('Daily goal (minutes)', goal, '5–480. Drives the goal reward of +20 BC.'),
      field('AI requests per day', limit, '10–2000. A hard server-side cap on your own key’s use.'), null),
    h('label', { class: 'switch' }, quick, 'Show quick break suggestions after 10 minutes of focus'),
    h('div', { class: 'row end' }, save),
    h('p', { class: 'tiny muted', text: 'Stored on your profile row; only your account can read it.' }));
}

// ---------- notifications ----------
function notificationCard(profile) {
  const prefs = profile.notification_prefs || {};
  const inputs = [];
  const boxes = NOTIFS.map(([key, label]) => {
    const box = h('input', { type: 'checkbox', checked: prefs[key] !== false });
    inputs.push(box);
    return h('label', { class: 'switch' }, box, label);
  });
  const save = h('button', { class: 'btn sm', type: 'button', text: 'Save reminders', onClick: async () => {
    const notifications = {};
    NOTIFS.forEach(([key], index) => { notifications[key] = inputs[index].checked; });
    try { await api.post('/api/profile', { notifications }); await refresh(); toast('Reminder settings saved.', 'good'); }
    catch (error) { errorToast(error); }
  } });
  const allow = h('button', { class: 'btn sm secondary', type: 'button', text: 'Allow browser notifications', onClick: async () => {
    if (!('Notification' in window)) { toast('This browser has no notification support. Reminders still show inside the app.', 'bad'); return; }
    const result = await Notification.requestPermission();
    toast(result === 'granted' ? 'Browser notifications allowed — reminders appear when the tab is open.' : `Permission ${result}. In-app reminders still work.`, result === 'granted' ? 'good' : '');
  } });
  const state = h('span', { class: 'tag grey', text: 'Notification' in window ? Notification.permission : 'unsupported' });
  return h('section', { class: 'card stack' }, h('div', { class: 'card-head' }, h('h3', { text: 'Reminders' }), h('span', { class: 'spacer' }), state),
    h('p', { class: 'tiny muted', text: 'Notifications are optional and never required for a reward. Missed days are not punished — nothing is deducted.' }),
    h('div', { class: 'grid cols-2' }, ...boxes),
    h('div', { class: 'row' }, save, allow));
}

// ---------- providers ----------
async function loadProviders(host, navigate, reloadProviders) {
  host.replaceChildren();
  let settings;
  try { settings = await api.get('/api/ai/settings'); } catch (error) { host.replaceChildren(errorCard(error, () => loadProviders(host, navigate, reloadProviders))); return; }
  host.appendChild(centralAiCard(settings.central, settings.daily_ai));
  host.appendChild(trialCard(settings.trial, settings.central));
  host.appendChild(byokCard(settings, reloadProviders));
  for (const provider of settings.providers) host.appendChild(providerCard(provider, reloadProviders));
  host.appendChild(routerCard(settings));
  host.appendChild(usageCard(settings));
}

// StudyBridge Free AI: the connection every student gets without an account,
// a key or a model setup of their own. What it says about itself is read
// from the server, never assumed by the page.
function centralAiCard(central, daily) {
  const c = central || {};
  const on = c.configured === true;
  const ready = c.available === true;
  const state = !on
    ? h('span', { class: 'tag grey', text: 'not connected yet' })
    : ready
      ? h('span', { class: 'tag green', text: 'available now' })
      : c.quota_blocked
        ? h('span', { class: 'tag amber', text: 'busy right now' })
        : h('span', { class: 'tag rose', text: 'not answering yet' });
  const meters = on ? h('div', { class: 'grid cols-3' },
    h('div', { class: 'stat teal' }, h('span', { class: 'stat-label', text: 'Verified free models' }),
      h('b', { text: num(c.free_models) }), h('small', { text: 'price checked at $0 on the provider’s own list' })),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Questions left today' }),
      h('b', { text: daily?.remaining === null || daily?.remaining === undefined ? '—' : `${num(daily.remaining)} / ${num(daily.limit)}` }),
      h('small', { text: `${num(daily?.used ?? 0)} used today` })),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Next reset' }),
      h('b', { class: 'tiny', text: '00:00 Pakistan time' }),
      h('small', { text: untilLabel(daily?.resets_at) }))) : null;
  return h('section', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h3', { text: 'StudyBridge Free AI' }), h('span', { class: 'spacer' }), state),
    h('p', { class: 'tiny', text: 'AI access is centrally managed by StudyBridge. You do not need to provide your own API key.' }),
    h('p', { class: 'tiny muted', text: c.note || 'Only models whose $0 input and output price was checked against the provider’s own catalogue can answer. A model whose price is unknown is never used, and a paid model is never substituted.' }),
    meters,
    on && !ready ? h('div', { class: 'banner warn' }, h('div', {},
      h('b', { text: c.quota_blocked ? 'The shared free allowance is used up' : 'The free models are not answering yet' }),
      h('span', { text: c.quota_blocked
        ? 'StudyBridge AI is temporarily busy. Please try again later — the provider’s own allowance refills on its schedule, not at midnight.'
        : c.message || 'An administrator has to finish the platform setup on the server.' }))) : null,
    on && c.last_error ? h('div', { class: 'banner bad' }, h('div', {}, h('b', { text: 'Last error on the platform connection' }), h('span', { text: c.last_error }))) : null,
    h('p', { class: 'tiny muted', text: 'The key lives on the server only. It is never sent to this browser and cannot be read from this page.' }));
}

function byokCard(settings, reloadProviders) {
  const F = {
    api_name: h('input', { type: 'text', maxlength: '60', placeholder: 'My Gemini Key' }),
    provider_id: h('input', { type: 'text', maxlength: '40', placeholder: 'gemini-main' }),
    base_url: h('input', { type: 'url', placeholder: 'https://generativelanguage.googleapis.com/v1beta/openai/' }),
    api_key: h('input', { type: 'password', maxlength: '400', autocomplete: 'off', placeholder: 'Paste your key' }),
    model: h('input', { type: 'text', maxlength: '128', placeholder: 'gemini-2.5-flash-lite or qwen/qwen3.8-omni-flash:free' }),
    model_name: h('input', { type: 'text', maxlength: '120', placeholder: 'Gemini Flash Lite' }),
  };
  const consent = h('input', { type: 'checkbox' });
  const add = h('button', { class: 'btn', type: 'button', text: 'Connect provider', onClick: async () => {
    for (const key of Object.keys(F)) {
      if (!F[key].value.trim()) { toast(`${key.replace(/_/g, ' ')} is required.`, 'bad'); F[key].focus(); return; }
    }
    if (!consent.checked) { toast('Tick the billing warning first — the provider bills your account.', 'bad', 7000); return; }
    add.disabled = true;
    add.textContent = 'Connecting…';
    try {
      const res = await api.post('/api/providers', {
        api_name: F.api_name.value.trim(), provider_id: F.provider_id.value.trim(),
        base_url: F.base_url.value.trim(), api_key: F.api_key.value, model: F.model.value.trim(),
        model_name: F.model_name.value.trim(), consent: true,
      });
      for (const key of Object.keys(F)) F[key].value = '';
      consent.checked = false;
      // The server read what was pasted: a stripped "Bearer " prefix or a secret
      // name instead of a value is reported here instead of failing later.
      toast(res.test?.message || 'Provider connected. Run Test Connection to confirm the key works.',
        res.provider?.key_warning ? '' : 'good', 9500);
      await reloadProviders();
    } catch (error) { errorToast(error); }
    add.disabled = false;
    add.textContent = 'Connect provider';
  } });
  const card = h('section', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Bring your own key' }), h('span', { class: 'spacer' }), h('span', { class: 'tag teal', text: 'six fields, exactly' })),
    h('p', { class: 'tiny muted', text: settings.note }),
    h('div', { class: 'banner warn' }, h('div', {}, h('b', { text: 'Before you connect' }), h('span', { text: settings.billing_warning }))),
    h('div', { class: 'field-row' }, field('API Name', F.api_name), field('Provider ID', F.provider_id),
      field('Model', F.model, 'Copy the id exactly as the provider lists it — a vendor prefix and a :free suffix are part of it, and are kept untouched.')),
    h('div', { class: 'field-row' }, field('Base URL', F.base_url), field('Model Name', F.model_name), null),
    field('API Key', F.api_key, 'Paste the secret value itself, not the name of the variable that holds it. Sent once over HTTPS, encrypted at rest, and never returned to the browser.'),
    h('label', { class: 'switch' }, consent, 'I understand this provider bills my own account for every request, and StudyBridge adds no markup or limit on top.'),
    h('div', { class: 'row' }, add,
      h('span', { class: 'tiny muted', text: 'No key? Everything except AI generation still works: scans, notes, quizzes from your own text, focus, games, progress.' })));
  return card;
}

function providerCard(provider, reloadProviders) {
  const statusTag = h('span', { class: `tag ${provider.last_status === 'ok' || provider.last_status === 'ok_with_models' ? 'green' : provider.last_status === 'untested' ? 'grey' : 'rose'}`, text: provider.last_status || 'untested' });
  const enabled = h('input', { type: 'checkbox', checked: provider.enabled });
  const models = h('div', { class: 'stack' });
  const remoteBox = h('div', { class: 'stack' });
  const reload = reloadProviders;

  // The provider's own reply stays on the card, not only in a toast that fades.
  const errorBody = h('span', { text: provider.last_error || '' });
  const errorBanner = h('div', { class: 'banner bad', hidden: !provider.last_error },
    h('div', {}, h('b', { text: 'Last error' }), errorBody));
  function showError(message, when) {
    if (!message) { errorBanner.hidden = true; errorBody.textContent = ''; return; }
    errorBody.textContent = `${message}${when ? ` (${when})` : ''}`;
    errorBanner.hidden = false;
  }

  // What the provider's account endpoint says about limits — the only answer to
  // “is this a busy minute, or is today’s free allowance gone?”.
  const usageBox = h('div', { class: 'stack', hidden: true });
  const VERDICT_TEXT = {
    allowance_exhausted: 'The provider’s own figures say the allowance is spent. Waiting a few seconds will not change that; it refills on the provider’s schedule.',
    allowance_available: 'The provider says allowance is still left, so a 429 here is a short window — requests per minute or concurrency — not a quota running out.',
    reported_without_answer: 'The provider answered with figures, but none of them says whether a limit is reached:',
    nothing_published: 'The provider published no limit or remaining figure at that address.',
    not_published: 'This provider has no account-usage endpoint at this address.',
    no_key: 'No usable key is stored, so the account endpoint cannot be reached.',
    unreachable: 'The account endpoint did not answer.',
    failed: 'The account check did not complete.',
  };
  function paintUsage(res) {
    const rows = (res.readings || []).map(item => h('div', { class: 'row wrap-gap tiny' },
      h('span', { class: 'mono', text: item.label }),
      h('span', { text: typeof item.value === 'number' ? item.value.toLocaleString('en-US') : String(item.value) })));
    usageBox.hidden = false;
    // replaceChildren() turns a null into the text “null”, so the optional line
    // is dropped from the list rather than passed along.
    usageBox.replaceChildren(...[
      h('p', { class: 'tiny' }, h('b', { text: `Account limits — ${String(res.verdict || 'unknown').replace(/_/g, ' ')}` }),
        ' ', h('span', { text: VERDICT_TEXT[res.verdict] || res.message || 'The provider answered.' })),
      res.message && VERDICT_TEXT[res.verdict] ? h('p', { class: 'tiny muted', text: res.message }) : null,
      ...rows,
      h('p', { class: 'tiny muted mono', text: `${res.endpoint || ''} · HTTP ${res.http_status || '—'} · ${timeAgo(res.checked_at || new Date().toISOString())}${res.cached ? ' · read minutes ago, not re-requested' : ''}` }),
      h('p', { class: 'tiny muted', text: res.note || '' }),
    ].filter(Boolean));
  }

  const section = h('section', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h3', { text: provider.api_name }),
      h('span', { class: 'tag grey', text: provider.provider_key }),
      provider.is_default ? h('span', { class: 'tag amber', text: 'default' }) : null,
      statusTag, h('span', { class: 'spacer' }),
      h('label', { class: 'switch' }, enabled, 'enabled')),
    h('p', { class: 'tiny muted mono', text: `${provider.base_url} · wire ${provider.wire} · key ${provider.key_hint || 'stored'}` }),
    errorBanner,
    usageBox,
    models,
    h('div', { class: 'row wrap-gap' },
      h('button', { class: 'btn sm', type: 'button', text: 'Test connection', onClick: async event => {
        // currentTarget is gone once the await resumes, so hold the button itself.
        const button = event.currentTarget;
        button.disabled = true;
        statusTag.textContent = 'testing…';
        try {
          const res = await api.post(`/api/providers/${provider.id}/test`);
          const ok = String(res.status || '').startsWith('ok');
          statusTag.textContent = res.status;
          statusTag.className = `tag ${ok ? 'green' : 'rose'}`;
          // Which half failed matters more than the word "error": a refused key
          // and a refused model id need different fixes.
          const verdict = res.auth === 'accepted' ? 'Key accepted.'
            : res.auth === 'rejected' ? 'Key refused.' : '';
          showError(ok ? '' : [verdict, res.message].filter(Boolean).join(' '),
            ok ? '' : timeAgo(res.checked_at || new Date().toISOString()));
          toast(res.message || `Status: ${res.status}`, ok ? 'good' : 'bad', 9000);
        } catch (error) {
          statusTag.textContent = 'failed';
          statusTag.className = 'tag rose';
          showError(error.hint || error.message, timeAgo(new Date().toISOString()));
          errorToast(error);
        }
        button.disabled = false;
      } }),
      h('button', { class: 'btn sm secondary', type: 'button', text: 'Check account limits', title: 'Reads your provider’s own usage endpoint with the stored key. The key never comes back to this page.', onClick: async event => {
        const button = event.currentTarget;
        button.disabled = true;
        usageBox.hidden = false;
        usageBox.replaceChildren(h('p', { class: 'tiny muted', text: 'Reading the provider’s account endpoint…' }));
        try {
          paintUsage(await api.post(`/api/providers/${provider.id}/usage`));
        } catch (error) {
          usageBox.replaceChildren(h('div', { class: 'banner bad' }, h('div', {}, h('b', { text: 'Account check failed' }), h('span', { text: error.hint || error.message }))));
        }
        button.disabled = false;
      } }),
      h('button', { class: 'btn sm secondary', type: 'button', text: 'Fetch models', onClick: async event => {
        const button = event.currentTarget;
        button.disabled = true;
        remoteBox.replaceChildren(h('p', { class: 'muted tiny', text: 'Reading the provider’s model list…' }));
        try {
          const res = await api.get(`/api/providers/${provider.id}/models`);
          remoteBox.replaceChildren(modelPicker(provider, res, reload));
        } catch (error) { remoteBox.replaceChildren(h('div', { class: 'banner bad' }, h('div', {}, h('b', { text: 'Model list failed' }), h('span', { text: error.hint || error.message })))); }
        button.disabled = false;
      } }),
      h('button', { class: 'btn sm secondary', type: 'button', text: 'Add a model by hand', onClick: () => manualModel(provider, reload) }),
      provider.is_default ? null : h('button', { class: 'btn sm secondary', type: 'button', text: 'Set as default', onClick: async () => {
        try { await api.post(`/api/providers/${provider.id}/default`, {}); toast('This provider is now the default. The router still picks the cheapest capable model unless you choose one in the tutor.'); reload(); }
        catch (error) { errorToast(error); }
      } }),
      h('button', { class: 'btn sm secondary', type: 'button', text: 'Save / rename', onClick: () => editProvider(provider, reload) }),
      h('button', { class: 'btn sm danger', type: 'button', text: 'Remove provider', onClick: () => confirmSheet({
        title: `Remove ${provider.api_name}?`, body: 'The encrypted key and its models are deleted. Chats and notes you already saved stay. Nothing is refunded because nothing was charged.',
        confirmLabel: 'Remove', tone: 'danger',
        onConfirm: async () => { await api.del(`/api/providers/${provider.id}`); toast('Provider removed.'); await reload(); },
      }) })),
    remoteBox);

  enabled.addEventListener('change', async () => {
    enabled.disabled = true;
    try { await api.patch(`/api/providers/${provider.id}`, { enabled: enabled.checked }); await reload(); }
    catch (error) { enabled.checked = !enabled.checked; enabled.disabled = false; errorToast(error); }
  });

  (provider.models || []).forEach(model => models.appendChild(modelRow(model, reload)));
  if (!provider.models?.length) models.appendChild(h('p', { class: 'tiny muted', text: 'No models yet — fetch the list or add one by hand. A provider needs at least one enabled model to answer.' }));
  return section;
}

function modelRow(model, reload) {
  const tier = select([['economy', 'economy'], ['standard', 'standard'], ['premium', 'premium']], model.tier);
  const vision = h('input', { type: 'checkbox', checked: model.vision });
  const enabledBox = h('input', { type: 'checkbox', checked: model.enabled });
  // A temporary pause is not a disabled model: it stays enabled, and the next
  // request after the window is its own recovery check.
  const coolsUntil = Date.parse(model.cooldown_until || '');
  const coolsIn = Number.isFinite(coolsUntil) ? coolsUntil - Date.now() : 0;
  const cooling = coolsIn > 0;
  const waiting = !cooling && Number(model.fail_streak) > 0;
  const coolLine = cooling
    ? h('p', { class: 'tiny muted', text: `On a short automatic pause after ${model.cooldown_reason || 'a temporary provider error'} — about ${Math.max(1, Math.round(coolsIn / 1000))} more seconds. It is still enabled; the router skips it meanwhile and tries it again by itself.` })
    : waiting
      ? h('p', { class: 'tiny muted', text: 'Its pause has ended, so this model is the next one the router tries. It stays in rotation as long as the provider answers.' })
      : null;
  const priceIn = h('input', { type: 'number', min: '0', max: '10000000', step: '1', value: String(model.input_micro_per_1k || 0) });
  const priceOut = h('input', { type: 'number', min: '0', max: '10000000', step: '1', value: String(model.output_micro_per_1k || 0) });
  const save = h('button', { class: 'btn sm secondary', type: 'button', text: 'Save model', onClick: async () => {
    save.disabled = true;
    try {
      await api.patch(`/api/models/${model.id}`, {
        tier: tier.value, vision: vision.checked, enabled: enabledBox.checked,
        input_micro_per_1k: Number(priceIn.value) || 0, output_micro_per_1k: Number(priceOut.value) || 0,
      });
      toast('Model updated.', 'good');
      reload();
    } catch (error) { errorToast(error); }
    save.disabled = false;
  } });
  return h('div', { class: 'card tight model-row' },
    h('div', { class: 'row between' },
      h('b', { text: model.model_name || model.model_id }),
      h('span', { class: 'row wrap-gap' }, model.is_default ? h('span', { class: 'tag amber', text: 'default' }) : null,
        vision.checked || model.vision ? h('span', { class: 'tag teal', text: 'vision' }) : null,
        cooling ? h('span', { class: 'tag rose', text: `cooling ~${Math.max(1, Math.round(coolsIn / 1000))}s` }) : null,
        waiting ? h('span', { class: 'tag green', text: 'recovered' }) : null)),
    h('div', { class: 'tiny mono muted', text: model.model_id }),
    coolLine,
    h('div', { class: 'field-row' },
      field('Tier', tier, 'The router tries economy first'),
      field('Input per 1k', priceIn, `≈ ${microToText(model.input_micro_per_1k)} per 1k tokens`),
      field('Output per 1k', priceOut, `≈ ${microToText(model.output_micro_per_1k)} per 1k tokens`)),
    h('div', { class: 'row wrap-gap' },
      h('label', { class: 'switch' }, vision, 'can read images'),
      h('label', { class: 'switch' }, enabledBox, 'enabled'),
      save,
      cooling ? h('button', { class: 'btn sm secondary', type: 'button', text: 'Try now', onClick: async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const res = await api.post(`/api/models/${model.id}/wake`, {});
          toast(res.note || 'Model is back in rotation.', 'good');
          reload();
        } catch (error) { errorToast(error); button.disabled = false; }
      } }) : null,
      h('button', { class: 'btn sm ghost', type: 'button', text: 'Delete model', onClick: async () => {
        try { await api.del(`/api/models/${model.id}`); reload(); } catch (error) { errorToast(error); }
      } })),
    h('p', { class: 'tiny muted', text: 'Prices are in the micro-unit of the currency your provider bills you in. They are used only to estimate cost — StudyBridge never charges you.' }));
}

function modelPicker(provider, res, reload) {
  if (!res.available) {
    return h('div', { class: 'banner warn' }, h('div', {}, h('b', { text: res.status || 'unavailable' }),
      h('span', { text: res.message || 'This endpoint does not expose a list. Add the model identifier by hand.' })));
  }
  const inputs = [];
  const boxes = (res.models || []).map(model => {
    const box = h('input', { type: 'checkbox', checked: Boolean(model.added), disabled: Boolean(model.added) });
    inputs.push(box);
    return h('label', { class: 'switch' }, box, `${model.name || model.id}${model.added ? ' (already added)' : ''}`);
  });
  const wrap = h('div', { class: 'stack' }, h('div', { class: 'stat-label', text: 'Models offered by this endpoint' }),
    boxes.length ? h('div', { class: 'grid cols-2' }, ...boxes) : h('p', { class: 'tiny muted', text: 'The endpoint returned no chat models.' }),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', text: 'Add selected', onClick: async event => {
      const button = event.currentTarget;
      const chosen = (res.models || []).filter((model, index) => inputs[index].checked && !model.added);
      if (!chosen.length) { toast('Tick at least one new model.', 'bad'); return; }
      button.disabled = true;
      try {
        const added = await api.post(`/api/providers/${provider.id}/models`, {
          models: chosen.map(model => ({ model_id: model.id, model_name: model.name || model.id, tier: 'economy', vision: /vision|gemini|gpt-4o|claude/i.test(model.id) })),
        });
        toast(`Added ${added.added} model(s).`, 'good');
        reload();
      } catch (error) { button.disabled = false; errorToast(error); }
    } })));
  return wrap;
}

function manualModel(provider, reload) {
  const id = h('input', { type: 'text', maxlength: '128', placeholder: 'gpt-4o-mini', dataset: { autofocus: '1' } });
  const name = h('input', { type: 'text', maxlength: '120', placeholder: 'GPT-4o mini' });
  const tier = select([['economy', 'economy'], ['standard', 'standard'], ['premium', 'premium']], 'economy');
  const vision = h('input', { type: 'checkbox' });
  const priceIn = h('input', { type: 'number', min: '0', value: '0' });
  const priceOut = h('input', { type: 'number', min: '0', value: '0' });
  const close = openSheet(h('div', { class: 'stack' }, sheetTitle('Add a model', provider.api_name),
    field('Model identifier', id, 'Exactly as your provider spells it.'), field('Display name', name),
    h('div', { class: 'field-row' }, field('Tier', tier), field('Input per 1k', priceIn), field('Output per 1k', priceOut)),
    h('label', { class: 'switch' }, vision, 'can read images (needed for photo scans)'),
    h('div', { class: 'row end' },
      h('button', { class: 'btn secondary', type: 'button', text: 'Cancel', onClick: () => close() }),
      h('button', { class: 'btn', type: 'button', text: 'Add model', onClick: async event => {
        if (!id.value.trim()) { toast('The model identifier is required.', 'bad'); return; }
        // currentTarget is gone once the await resumes, so hold the button itself.
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await api.post(`/api/providers/${provider.id}/models`, { models: [{ model_id: id.value.trim(), model_name: name.value.trim() || id.value.trim(), tier: tier.value, vision: vision.checked, input_micro_per_1k: Number(priceIn.value) || 0, output_micro_per_1k: Number(priceOut.value) || 0 }] });
          close(); toast('Model added.', 'good'); reload();
        } catch (error) { button.disabled = false; errorToast(error); }
      } }))));
}

function editProvider(provider, reload) {
  const name = h('input', { type: 'text', maxlength: '60', value: provider.api_name, dataset: { autofocus: '1' } });
  const base = h('input', { type: 'url', value: provider.base_url });
  const key = h('input', { type: 'password', maxlength: '400', autocomplete: 'off', placeholder: 'Leave empty to keep the current key' });
  const consent = h('input', { type: 'checkbox' });
  const close = openSheet(h('div', { class: 'stack' }, sheetTitle('Edit provider', 'Changing the Base URL points your key at a new endpoint — that needs a fresh confirmation.'),
    field('API Name', name), field('Base URL', base),
    field('New API key', key, 'Only sent if you type one. The stored key is never shown back.'),
    h('label', { class: 'switch' }, consent, 'I confirm this endpoint is my own account and it bills me directly.'),
    h('div', { class: 'row end' },
      h('button', { class: 'btn secondary', type: 'button', text: 'Cancel', onClick: () => close() }),
      h('button', { class: 'btn', type: 'button', text: 'Save changes', onClick: async event => {
        const changedUrl = base.value.trim() !== provider.base_url;
        if (changedUrl && !consent.checked) { toast('Confirm the new endpoint before saving.', 'bad'); return; }
        const button = event.currentTarget;
        button.disabled = true;
        const payload = { api_name: name.value.trim(), base_url: base.value.trim() };
        if (key.value) payload.api_key = key.value;
        try {
          const res = await api.patch(`/api/providers/${provider.id}`, payload);
          close();
          toast(res.provider?.key_warning || 'Provider updated.', res.provider?.key_warning ? '' : 'good', 9500);
          reload();
        }
        catch (error) { button.disabled = false; errorToast(error); }
      } }))));
}

function routerCard(settings) {
  const r = settings.router;
  const p = settings.retry_policy || {};
  const secs = ms => {
    const value = Number(ms) || 0;
    // Sub-second guarantees (the 250ms no-instant-retry floor) must not be
    // rounded into "0s", which is the opposite of what they promise.
    if (value < 1000) return `${value} ms`;
    if (value >= 120000 && value % 60000 === 0) return `${value / 60000} min`;
    return `${Math.round(value / 100) / 10}s`;
  };
  return h('section', { class: 'card stack' }, h('div', { class: 'card-head' }, h('h3', { text: 'AI router' })),
    h('div', { class: 'grid cols-3' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Enabled providers' }), h('b', { text: num(r.providers) })),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Enabled models' }), h('b', { text: num(r.enabled_models) })),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Vision models' }), h('b', { text: num(r.vision_models) }))),
    h('p', { class: 'tiny muted', text: 'These counts are the whole pool the router may use: StudyBridge Free AI — the provider StudyBridge manages for everyone — plus any provider you connected with a key of your own.' }),
    h('p', { class: 'tiny muted', text: 'Order: cheapest capable model first, then fallbacks on failure. Choose a specific model in the tutor to override it. Two enabled models unlock the 10 BC advanced comparison.' }),
    h('p', { class: 'tiny muted', text: `Temporary failures are retried up to ${num(p.retry_attempts || 0)} times with an exponential backoff of ${secs(p.retry_base_ms)} to ${secs(p.retry_max_ms)}, a ${secs(p.retry_budget_ms)} total wait budget and the provider’s Retry-After honoured up to ${secs(p.retry_after_cap_ms)}. No retry is ever sent faster than ${secs(p.min_retry_pause_ms)} after the last one, whatever the Secrets say. A model that keeps failing is skipped for ${secs(p.cooldown_ms)} (doubling up to ${secs(p.cooldown_max_ms)}) and returns on its own; a provider whose allowance is spent is asked once and parked, never re-tried into the same answer. Each call is cut off after ${secs(p.timeout_ms)}. Every one of these is a Site Secret, so an operator can widen them during a provider outage.` }),
    h('p', { class: 'tiny muted', text: `A 429 is read as one of two things: a short window (requests per minute or concurrent requests) or a spent allowance (daily free tokens). They need the opposite handling — the first is retried with a wait, the second is not retried at all. “Check account limits” on a provider card reads the provider’s own usage endpoint with your stored key, at most once every ${secs(p.usage_check_cooldown_ms)}, and the key itself never comes back to this page.` }),
    r.cooling_models ? h('div', { class: 'banner warn' }, h('div', {}, h('b', { text: `${num(r.cooling_models)} model(s) cooling` }), h('span', { text: r.cooling_note }))) : null,
    r.needs_vision_note ? h('div', { class: 'banner warn' }, h('div', {}, h('b', { text: 'Photo scans are blocked for now' }), h('span', { text: r.needs_vision_note }))) : null);
}

function usageCard(settings) {
  const u = settings.usage;
  return h('section', { class: 'card stack' }, h('div', { class: 'card-head' }, h('h3', { text: 'Usage and cost (last 30 days)' })),
    h('div', { class: 'grid cols-4' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Requests' }), h('b', { text: num(u.requests) }), h('small', { text: `${num(u.requests_today)} today of ${num(u.limit_per_day)} allowed` })),
      h('div', { class: 'stat rose' }, h('span', { class: 'stat-label', text: 'Failed' }), h('b', { text: num(u.failed) }), h('small', { text: `${num(u.failed_today)} today` })),
      h('div', { class: 'stat teal' }, h('span', { class: 'stat-label', text: 'Tokens' }), h('b', { text: num(u.inputTokens + u.outputTokens) }), h('small', { text: `${num(u.inputTokens)} in · ${num(u.outputTokens)} out` })),
      h('div', { class: 'stat amber' }, h('span', { class: 'stat-label', text: 'Cache hits' }), h('b', { text: num(u.cache_hits) }), h('small', { text: 'repeated questions answered free' }))),
    h('p', { class: 'tiny muted', text: `Estimated cost: ${u.cost_estimate_display}. ${settings.note}` }),
    u.failed && u.failed / Math.max(1, u.requests) > 0.2 ? h('div', { class: 'banner warn' }, h('div', {}, h('b', { text: `${pct((u.failed / u.requests) * 100)} of requests failed` }), h('span', { text: 'Check the provider status above, or Test Connection on each provider.' }))) : null,
    h('div', { class: 'free-list' }, (settings.free_always || []).map(label => h('span', { class: 'tag green', text: `${label} · 0 BC` }))));
}

// ---------- free trial ----------
function trialCard(trial, central) {
  const t = trial || {};
  const c = central || {};
  const on = t.configured === true;
  // The Free Trial and StudyBridge Free AI are two different things: the trial
  // is off, but the platform's own free models may still be answering. Saying
  // "you need your own key" while they answer would be false.
  const centralOn = c.configured === true && c.available === true;
  const state = h('span', { class: `tag ${on ? 'green' : 'grey'}`, text: on ? 'Available now' : 'Not switched on yet' });
  const meter = on ? h('div', { class: 'grid cols-3' },
    h('div', { class: 'stat teal' }, h('span', { class: 'stat-label', text: 'Left today' }),
      h('b', { text: `${num(t.remaining_today)} / ${num(t.daily_limit)}` }),
      h('small', { text: `${num(t.used_today)} used so far` })),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Left on this account' }),
      h('b', { text: `${num(t.remaining_total)} / ${num(t.lifetime_limit)}` }),
      h('small', { text: `${num(t.used_total)} used in total` })),
    h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Answers with' }),
      h('b', { class: 'tiny', text: t.model_name || 'platform model' }),
      h('small', { text: t.vision_enabled ? 'text and photos' : 'text only — photos need your own vision model' }))) : null;
  const unlock = h('ul', { class: 'steps' }, (t.unlocks || [
    'Add your own provider key below: no platform cap, billed only by your provider.',
    'Free tools — notes, quizzes from your own text, focus, games, progress — need no provider at all.',
  ]).map(line => h('li', { class: 'tiny muted', text: line })));
  return h('section', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h3', { text: 'Free Trial Provider' }), h('span', { class: 'spacer' }), state),
    h('p', { class: 'tiny muted', text: on
      ? 'A small number of AI answers a day, paid for by SchoolPlanner.pk so you can try the tutor before spending anything. It is used only while you have no provider of your own, and it stops when the cap is reached — it is not unlimited.'
      : centralOn
        ? 'The platform Free Trial is not switched on, but StudyBridge Free AI is answering, so you need no key of your own. Everything else in StudyBridge works without any key either.'
        : 'This site has not finished switching on the platform Free Trial, so AI needs your own provider key for now. Everything else in StudyBridge works without any key.' }),
    meter,
    on ? null : h('details', { class: 'card card-flat' }, h('summary', { class: 'tiny', text: 'Why is it unavailable?' }),
      h('p', { class: 'tiny muted', text: t.reason || 'The platform Free Trial Secrets are not configured on this deployment.' }),
      h('p', { class: 'tiny muted', text: centralOn
        ? 'This is the operator’s setup, not yours — a student cannot fix it. It does not stop you: StudyBridge Free AI answers in the meantime, and a key of your own is optional.'
        : 'This is the operator’s setup, not yours — a student cannot fix it. Connecting your own key is the path that works today.' })),
    h('div', { class: 'divider' }), h('h4', { class: 'stat-label', text: 'How to get more AI' }), unlock);
}

// ---------- data ----------
function dataCard() {
  const spaceSel = h('select', { 'aria-label': 'Space' });
  api.get('/api/spaces').then(spaces => {
    spaceSel.replaceChildren(...(spaces.length
      ? spaces.map(s => h('option', { value: s.id }, s.name))
      : [h('option', { value: '' }, 'No spaces')]));
  }).catch(() => spaceSel.replaceChildren(h('option', { value: '' }, 'Spaces unavailable')));
  return h('section', { class: 'card stack' }, h('h3', { text: 'Data and privacy' }),
    h('p', { class: 'tiny muted', text: 'Every row you create is owned by your account and read back only with your session. Deleting history never touches credits already earned, and a missed day is never charged back.' }),
    h('div', { class: 'row wrap-gap' },
      h('div', { style: { flex: '1 1 220px' } }, spaceSel),
      h('button', { class: 'btn sm secondary', type: 'button', text: 'Clear one space’s history', onClick: () => confirmSheet({
        title: 'Clear this space’s history?', body: 'Removes the topic log for that space. Notes, questions and chat stay.',
        confirmLabel: 'Clear', tone: 'danger',
        onConfirm: async () => {
          if (!spaceSel.value) { toast('Pick a space first.', 'bad'); return; }
          await api.del(`/api/history/${spaceSel.value}`, { confirm: true }); toast('History cleared.');
        },
      }) }),
      h('button', { class: 'btn sm danger', type: 'button', text: 'Delete ALL learning history', onClick: () => confirmSheet({
        title: 'Delete all learning history?', body: 'The topic log across every space is removed. Books, scans, notes, chats, quizzes, sessions and credits are untouched and still recorded.',
        confirmLabel: 'Delete history', tone: 'danger', requireTyped: 'delete',
        onConfirm: async () => { await api.del('/api/history', { confirm: true }); toast('All history deleted.'); },
      }) })),
    h('p', { class: 'tiny muted', text: 'Signed in as your Qoder account. No analytics or third-party scripts are loaded by this site.' }));
}

// ---------- about ----------
function aboutCard(boot) {
  const central = boot.free_models?.central || {};
  const aiLine = boot.providers?.count
    ? `AI answers come from the provider you connected${boot.providers.default ? ` (${boot.providers.default.api_name})` : ''}. The platform takes no cut of that spend.`
    : central.configured === true
      ? `AI answers come from StudyBridge Free AI — ${num(central.free_models)} free model${central.free_models === 1 ? '' : 's'} verified at $0 on ${central.name || 'the provider'}’s own list, and you need no key of your own.`
      : boot.trial?.configured
        ? `AI answers come from the platform Free Trial while it lasts — ${boot.trial.remaining_today} of ${boot.trial.daily_limit} left today, ${boot.trial.remaining_total} left on this account. Your own key in Settings removes that cap.`
        : 'No AI model is connected, so the AI screens stop with a clear message instead of inventing an answer. Add your own key in Settings, or ask whoever runs this site to switch on the platform Free Trial.';
  return h('section', { class: 'card stack' },
    h('div', { class: 'card-head' }, h('h3', { text: 'About StudyBridge AI' })),
    h('p', { class: 'tiny', text: 'A study platform for students who cannot pay for an AI subscription: scan a textbook, keep notes per subject, ask questions answered from your own pages, practise under timed conditions, and see the work add up.' }),
    h('div', { class: 'row wrap-gap' },
      h('span', { class: 'tag', text: 'StudyBridge AI by SchoolPlanner.pk' }),
      h('span', { class: 'tag teal', text: 'Powered by Future Innovations' }),
      h('a', { class: 'btn ghost sm', href: 'https://schoolplanner.pk', target: '_blank', rel: 'noopener noreferrer', text: 'schoolplanner.pk' })),
    h('p', { class: 'tiny muted', text: aiLine }),
    h('p', { class: 'tiny muted', text: 'Bridge Credits are earned from real study activity and written by the server’s ledger. There is no request that sets your own balance, and a missed day is never charged back.' }),
    h('p', { class: 'tiny muted', text: 'Notes, scans, chats and quiz attempts belong to your account and are read back only with your session. Nothing is shared with another student, and no document leaves this site except to a provider you connected yourself, after you agree to it.' }));
}
