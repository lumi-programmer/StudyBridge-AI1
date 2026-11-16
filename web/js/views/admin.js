// Admin dashboard — economy analytics, provider management and the controls
// that change prices, rewards and limits.
//
// The browser sends no privileged instruction here: every action below is a
// route on the Function, and the Function checks the caller's role before it
// reads or writes anything. A provider key is written once and never sent back.
import { api } from '../api.js';
import { store } from '../store.js';
import { emptyState, errorCard, errorToast, field, h, num, pageHead, spinner, timeAgo, toast } from '../ui.js';

const HEALTH_TONE = { ok: 'green', auth_failed: 'rose', failed: 'rose', unreachable: 'rose', no_key: 'amber', no_model: 'amber', untested: 'grey' };

export async function render(root, { navigate }) {
  root.appendChild(pageHead('🛡️ Administration', 'AI economy & provider control',
    'Only server-side administrators reach this page. It reads recorded rows and writes the price table, the reward amounts and the provider registry.',
    [h('a', { class: 'btn secondary', href: '#/wallet', text: 'Bridge Wallet' })]));
  const body = h('div', { class: 'stack' });
  root.appendChild(body);

  if (store.boot?.admin?.is_admin !== true) {
    body.appendChild(h('div', { class: 'banner bad' }, h('div', {},
      h('b', { text: 'This section is for platform administrators' }),
      h('span', { text: 'The role is decided by the server, not by this page. If you should have it, an administrator has to grant it in the user_roles table or through the ADMIN_OWNER_IDS secret.' }))));
    return;
  }

  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { class: 'tab-panel stack' });
  body.append(tabs, panel);

  const names = [['overview', 'Overview'], ['providers', 'AI providers'], ['economy', 'Economy controls'], ['requests', 'Requests']];
  const show = name => {
    tabs.replaceChildren(...names.map(([key, label]) => h('button', {
      class: `tab${key === name ? ' active' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(key === name),
      onClick: () => show(key),
    }, label)));
    panel.replaceChildren(spinner('Loading…'));
    PANELS[name](panel, { navigate }).catch(error => {
      panel.replaceChildren(errorCard(error, () => show(name)));
    });
  };
  show('overview');
}

const PANELS = {
  async overview(panel) {
    const data = await api.get('/api/admin/overview');
    const a = data.analytics || {};
    panel.appendChild(h('div', { class: 'grid cols-4' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Students' }), h('b', { text: num(a.students) }), h('small', { text: 'registered' })),
      h('div', { class: 'stat teal' }, h('span', { class: 'stat-label', text: 'BC earned' }), h('b', { text: num(a.total_earned) }), h('small', { text: 'all time' })),
      h('div', { class: 'stat amber' }, h('span', { class: 'stat-label', text: 'BC spent' }), h('b', { text: num(a.total_spent) }), h('small', { text: 'all time' })),
      h('div', { class: 'stat rose' }, h('span', { class: 'stat-label', text: 'BC in wallets' }), h('b', { text: num(a.total_balance) }), h('small', { text: 'unspent' }))));

    panel.appendChild(h('div', { class: 'grid cols-4' },
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'AI requests today' }), h('b', { text: num(a.requests_today) }), h('small', { text: `${num(a.succeeded_today)} succeeded` })),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Failed generations' }), h('b', { text: num(a.failed_today) }), h('small', { text: 'today' })),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Credits refunded' }), h('b', { text: num(a.credits_refunded) }), h('small', { text: `${num(a.refund_count)} refunds` })),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Requests per student' }), h('b', { text: num(a.average_requests_per_student) }), h('small', { text: 'average' }))));

    panel.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'Approved free models' }), h('span', { class: 'spacer' }),
        h('span', { class: 'tag green', text: `${num(a.approved_free_models)} selectable` }),
        h('span', { class: 'tag grey', text: `${num(a.providers)} providers` })),
      h('p', { class: 'tiny muted', style: { margin: '0 0 10px' }, text: 'A model only becomes selectable after its zero input and output pricing has been checked against the provider’s own catalogue. There is no paid fallback.' })));

    panel.appendChild(centralPanel(data.central));

    const health = data.health || [];
    panel.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'Provider monitoring' }), h('span', { class: 'spacer' })),
      health.length ? h('table', {}, h('thead', {}, h('tr', {},
        h('th', { text: 'Provider' }), h('th', { text: 'Health' }), h('th', { text: 'Models' }), h('th', { text: 'Free / selectable' }),
        h('th', { text: 'Requests' }), h('th', { text: 'Failures' }), h('th', { text: 'Quota' }), h('th', { text: 'Last success' }))),
        h('tbody', {}, health.map(row => h('tr', {},
          h('td', {}, h('div', { text: row.name }), h('small', { class: 'muted tiny', text: row.provider_key })),
          h('td', {}, h('span', { class: `tag ${HEALTH_TONE[row.health] || 'grey'}`, text: row.health || 'untested' }),
            row.last_error ? h('small', { class: 'muted tiny', style: { display: 'block' }, text: row.last_error.slice(0, 120) }) : null),
          h('td', { class: 'num', text: num(row.models) }),
          h('td', { class: 'num', text: `${num(row.free_models)} / ${num(row.selectable)}` }),
          h('td', { class: 'num', text: num(row.requests_today) }),
          h('td', { class: 'num', text: num(row.failures_today) }),
          h('td', { class: 'tiny muted', text: row.daily_quota ? `${num(row.quota_used)}/${num(row.daily_quota)}` : 'unlimited' }),
          h('td', { class: 'tiny muted', text: row.last_success ? timeAgo(row.last_success) : 'never' })))))
        : emptyState('No providers registered', 'Add one in the AI providers tab. A provider key is stored encrypted and is never shown again.')));

    const requests = data.requests || [];
    panel.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'Recent priced requests' }), h('span', { class: 'spacer' }),
        h('span', { class: 'tag grey', text: `${requests.length} shown` })),
      requests.length ? h('table', {}, h('thead', {}, h('tr', {},
        h('th', { text: 'When' }), h('th', { text: 'Feature' }), h('th', { text: 'BC' }), h('th', { text: 'State' }), h('th', { text: 'Model' }))),
        h('tbody', {}, requests.map(row => h('tr', {},
          h('td', { class: 'tiny muted', text: timeAgo(row.created_at) }),
          h('td', { text: String(row.feature || '').replace(/_/g, ' ') }),
          h('td', { class: 'num', text: num(row.credits) }),
          h('td', {}, h('span', { class: `tag ${row.state === 'settled' ? 'green' : row.state === 'refunded' ? 'amber' : 'grey'}`, text: row.state }),
            row.detail ? h('small', { class: 'muted tiny', style: { display: 'block' }, text: String(row.detail).slice(0, 100) }) : null),
          h('td', { class: 'tiny muted', text: [row.provider_key, row.model_id].filter(Boolean).join(' · ') })))))
        : emptyState('No AI requests yet', 'Requests appear here as soon as a student sends one.')));
  },

  async providers(panel, { navigate }) {
    const data = await api.get('/api/admin/providers');
    const reload = () => PANELS.providers(panel, { navigate });

    const addForm = providerForm(reload);
    panel.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'Add a platform provider' }), h('span', { class: 'spacer' }),
        h('span', { class: 'tag grey', text: 'key stored encrypted' })),
      h('p', { class: 'tiny muted', style: { margin: '0 0 12px' }, text: 'The key is encrypted on the server and never displayed again. Only models whose zero pricing was verified can answer.' }),
      addForm));

    const providers = data.providers || [];
    if (!providers.length) {
      panel.appendChild(emptyState('No providers yet', 'Add OpenRouter or any OpenAI-compatible provider above, then fetch its model list and verify pricing.'));
      return;
    }
    for (const provider of providers) {
      panel.appendChild(providerCard(provider, reload));
    }
  },

  async economy(panel, { navigate }) {
    const data = await api.get('/api/admin/economy');
    const reload = () => PANELS.economy(panel, { navigate });
    const save = async (patch, message) => {
      try {
        await api.patch('/api/admin/economy', patch);
        toast(message, 'good');
        await reload();
      } catch (error) { errorToast(error); }
    };

    const pricingInputs = {};
    const pricingRows = (data.features || []).map(feature => {
      const input = h('input', { type: 'number', min: '0', max: '500', value: String(data.pricing?.[feature.key] ?? 0), 'aria-label': `${feature.label} price` });
      pricingInputs[feature.key] = input;
      return h('tr', {},
        h('td', {}, h('div', { text: feature.label }), h('small', { class: 'muted tiny', text: feature.where })),
        h('td', { class: 'num' }, input));
    });
    panel.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'AI feature prices' }), h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', type: 'button', text: 'Save prices', onClick: () => {
          const patch = {};
          for (const [key, input] of Object.entries(pricingInputs)) patch[key] = Math.max(0, Math.min(500, Number(input.value) || 0));
          save({ pricing: patch }, 'Prices saved. The next request uses them.');
        } })),
      h('p', { class: 'tiny muted', style: { margin: '0 0 10px' }, text: 'The price shown to a student before sending a request is this number, and it is the number the ledger charges.' }),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Feature' }), h('th', { text: 'BC' }))),
        h('tbody', {}, pricingRows))));

    const rewardInputs = {};
    const flagInputs = {};
    const rewardRows = (data.reward_catalogue || []).map(reward => {
      const input = h('input', { type: 'number', min: '0', max: '10000', value: String(data.rewards?.[reward.code] ?? reward.amount), 'aria-label': `${reward.label} amount` });
      rewardInputs[reward.code] = input;
      const flag = h('input', { type: 'checkbox', checked: data.reward_flags?.[reward.code] !== false });
      flagInputs[reward.code] = flag;
      return h('tr', {},
        h('td', {}, h('div', { text: reward.label }), h('small', { class: 'muted tiny', text: reward.how })),
        h('td', { class: 'num' }, input),
        h('td', {}, h('label', { class: 'switch' }, flag, h('span', { text: 'On' }))));
    });
    panel.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'Reward amounts' }), h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', type: 'button', text: 'Save rewards', onClick: () => {
          const amounts = {};
          const flags = {};
          for (const [key, input] of Object.entries(rewardInputs)) amounts[key] = Math.max(0, Math.min(10000, Number(input.value) || 0));
          for (const [key, input] of Object.entries(flagInputs)) flags[key] = input.checked === true;
          save({ rewards: amounts, reward_flags: flags }, 'Rewards saved.');
        } })),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Reward' }), h('th', { text: 'BC' }), h('th', { text: 'Enabled' }))),
        h('tbody', {}, rewardRows))));

    const limitInputs = {};
    const limitRows = [
      ['daily_questions_per_student', 'Priced AI requests per student per day'],
      ['concurrent_requests_per_student', 'Concurrent requests per student'],
      ['max_output_tokens', 'Maximum output tokens per answer'],
      ['shared_daily_quota', 'Shared daily provider quota'],
    ].map(([key, label]) => {
      const input = h('input', { type: 'number', min: '0', max: '1000000', value: String(data.limits?.[key] ?? 0), 'aria-label': label });
      limitInputs[key] = input;
      return h('tr', {}, h('td', { text: label }), h('td', { class: 'num' }, input));
    });
    panel.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'Usage limits' }), h('span', { class: 'spacer' }),
        h('button', { class: 'btn sm', type: 'button', text: 'Save limits', onClick: () => {
          const patch = {};
          for (const [key, input] of Object.entries(limitInputs)) patch[key] = Math.max(0, Math.min(1000000, Number(input.value) || 0));
          save({ limits: patch }, 'Limits saved.');
        } })),
      h('table', {}, h('thead', {}, h('tr', {}, h('th', { text: 'Limit' }), h('th', { text: 'Value' }))),
        h('tbody', {}, limitRows)),
      h('p', { class: 'tiny muted', style: { marginTop: '10px' }, text: data.note })));
  },

  async requests(panel) {
    const data = await api.get('/api/admin/requests?limit=60');
    const requests = data.requests || [];
    panel.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'AI request log' }), h('span', { class: 'spacer' }),
        h('span', { class: 'tag grey', text: `${requests.length} shown` })),
      requests.length ? h('table', {}, h('thead', {}, h('tr', {},
        h('th', { text: 'When' }), h('th', { text: 'Feature' }), h('th', { text: 'BC' }), h('th', { text: 'State' }),
        h('th', { text: 'Provider' }), h('th', { text: 'Model' }), h('th', { text: 'Status' }))),
        h('tbody', {}, requests.map(row => h('tr', {},
          h('td', { class: 'tiny muted', text: timeAgo(row.created_at) }),
          h('td', { text: String(row.feature || '').replace(/_/g, ' ') }),
          h('td', { class: 'num', text: num(row.credits) }),
          h('td', {}, h('span', { class: `tag ${row.state === 'settled' ? 'green' : row.state === 'refunded' ? 'amber' : 'grey'}`, text: row.state })),
          h('td', { class: 'tiny muted', text: row.provider_key || '—' }),
          h('td', { class: 'tiny muted', text: row.model_id || '—' }),
          h('td', { class: 'tiny muted', text: row.status_code ? String(row.status_code) : '—' })))))
        : emptyState('No requests recorded', 'Requests appear here as students send them.')));

    const logs = data.health_logs || [];
    panel.appendChild(h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'Provider health log' }), h('span', { class: 'spacer' })),
      logs.length ? h('table', {}, h('thead', {}, h('tr', {},
        h('th', { text: 'When' }), h('th', { text: 'Provider' }), h('th', { text: 'Model' }), h('th', { text: 'OK' }), h('th', { text: 'Latency' }), h('th', { text: 'Detail' }))),
        h('tbody', {}, logs.map(row => h('tr', {},
          h('td', { class: 'tiny muted', text: timeAgo(row.created_at) }),
          h('td', { text: row.provider_key }),
          h('td', { class: 'tiny muted', text: row.model_id }),
          h('td', {}, h('span', { class: `tag ${row.ok ? 'green' : 'rose'}`, text: row.ok ? 'ok' : 'failed' })),
          h('td', { class: 'num', text: `${num(row.latency_ms)} ms` }),
          h('td', { class: 'tiny muted', text: String(row.detail || '').slice(0, 120) })))))
        : emptyState('No health entries', 'Health entries are written when a provider is tested or a request fails.')));
  },
};

// The centrally managed connection, watched on its own. The point of this
// panel is that "configured" and "answering" are two different facts, and
// only the second one means a student got a real answer.
function centralPanel(central) {
  if (!central) {
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', { text: 'StudyBridge Free AI' })),
      h('p', { class: 'tiny muted', style: { margin: 0 }, text: 'The central connection status could not be read.' }));
  }
  const state = !central.configured ? h('span', { class: 'tag grey', text: 'not configured' })
    : central.available ? h('span', { class: 'tag green', text: 'answering' })
    : central.quota_blocked ? h('span', { class: 'tag amber', text: 'quota used up' })
    : h('span', { class: 'tag rose', text: 'configured, not answering' });
  const requests = central.requests || {};
  return h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', { text: 'StudyBridge Free AI' }), h('span', { class: 'spacer' }), state,
      h('span', { class: 'tag grey', text: central.provider_key || '' })),
    h('p', { class: 'tiny muted', style: { margin: '0 0 10px' },
      text: central.configured
        ? `Key ends ${central.key_hint || '—'} and lives on the server only. Router: ${central.model}. Catalogue last checked ${central.checked_at ? timeAgo(central.checked_at) : 'never'}.`
        : 'Set OPENROUTER_API_KEY in the server environment. Nothing here is configured yet, so no student request can reach a model.' }),
    h('div', { class: 'grid cols-4' },
      h('div', { class: 'stat teal' }, h('span', { class: 'stat-label', text: 'Verified free models' }), h('b', { text: num(central.free_models) }), h('small', { text: `of ${num(central.approved_models)} selectable` })),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Successful answers' }), h('b', { text: num(requests.succeeded) }), h('small', { text: `${num(requests.total)} requests recorded` })),
      h('div', { class: 'stat rose' }, h('span', { class: 'stat-label', text: 'Failed requests' }), h('b', { text: num(requests.failed) }), h('small', { text: `${num(requests.rate_limited)} rate limited` })),
      h('div', { class: 'stat' }, h('span', { class: 'stat-label', text: 'Shared quota' }), h('b', { text: central.quota ? `${num(central.quota_used)}/${num(central.quota)}` : '∞' }), h('small', { text: central.quota ? 'requests today' : 'no platform quota set' }))),
    central.token_usage_available
      ? h('p', { class: 'tiny muted', style: { margin: '10px 0 0' }, text: `Token usage recorded: ${num(requests.input_tokens)} in · ${num(requests.output_tokens)} out.` })
      : null,
    h('p', { class: 'tiny muted', style: { margin: '10px 0 0' }, text: central.last_success ? `Last successful generation ${timeAgo(central.last_success)}.` : 'No successful generation recorded yet.' }),
    central.last_error ? h('div', { class: 'banner bad', style: { marginTop: '10px' } }, h('div', {},
      h('b', { text: 'Last error' }), h('span', { text: central.last_error }))) : null,
    central.last_error_detail ? h('p', { class: 'tiny muted', style: { margin: '6px 0 0' }, text: `Detail: ${central.last_error_detail}` }) : null,
    (central.models || []).length ? h('div', { class: 'model-row', style: { marginTop: '14px' } },
      h('div', { class: 'stat-label', text: `Models (${central.models.length})` }),
      h('table', {}, h('thead', {}, h('tr', {},
        h('th', { text: 'Model' }), h('th', { text: 'Eligibility' }), h('th', { text: 'Availability' }), h('th', { text: 'Enabled' }))),
        h('tbody', {}, central.models.map(model => h('tr', {},
          h('td', {}, h('div', { text: model.display_name || model.model_id }), h('small', { class: 'muted tiny', text: model.model_id })),
          h('td', {}, h('span', { class: `tag ${model.router ? 'teal' : model.pricing_verified && model.free_tier ? 'green' : 'grey'}`,
            text: model.router ? 'router' : model.pricing_verified ? (model.free_tier ? 'free' : 'paid') : 'unverified' })),
          h('td', {}, h('span', { class: `tag ${model.available ? 'green' : 'rose'}`, text: model.available ? 'published' : 'not published' }),
            model.cooling ? h('small', { class: 'muted tiny', style: { display: 'block' }, text: 'cooling down' }) : null),
          h('td', {}, h('span', { class: `tag ${model.enabled ? 'green' : 'grey'}`, text: model.enabled ? 'on' : 'off' })))))))
      : null);
}

function providerForm(reload) {
  const name = h('input', { type: 'text', placeholder: 'OpenRouter free tier', 'aria-label': 'Display name' });
  const key = h('input', { type: 'text', placeholder: 'openrouter-free', 'aria-label': 'Provider key' });
  const base = h('input', { type: 'text', placeholder: 'https://openrouter.ai/api/v1', 'aria-label': 'Base URL' });
  const wire = h('select', { 'aria-label': 'Protocol' },
    h('option', { value: 'openai' }, 'OpenAI-compatible'),
    h('option', { value: 'openrouter' }, 'OpenRouter'),
    h('option', { value: 'gemini' }, 'Google Gemini'));
  const apiKey = h('input', { type: 'password', placeholder: 'sk-…', 'aria-label': 'API key', autocomplete: 'off' });
  const quota = h('input', { type: 'number', min: '0', max: '100000', value: '0', 'aria-label': 'Daily quota' });
  const submit = h('button', { class: 'btn', type: 'submit', text: 'Add provider' });
  const form = h('form', { class: 'stack', onSubmit: async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await api.post('/api/admin/providers', {
        name: name.value.trim(), provider_key: key.value.trim(), base_url: base.value.trim(),
        wire: wire.value, api_key: apiKey.value.trim(), daily_quota: Number(quota.value) || 0,
      });
      apiKey.value = '';
      toast('Provider saved. Fetch its models and verify pricing next.', 'good');
      reload();
    } catch (error) { errorToast(error); }
    finally { submit.disabled = false; }
  } },
    h('div', { class: 'grid cols-3' },
      field('Display name', name), field('Provider key', key), field('Protocol', wire)),
    field('Base URL', base, 'The provider’s public API address. Only https, and never a private or local host.'),
    h('div', { class: 'grid cols-3' },
      field('API key', apiKey, 'Encrypted on the server. It is never displayed again.'), field('Daily quota', quota, 'Requests per day for this provider. 0 means no limit.'), h('div', { class: 'field' }, h('label', { text: ' ' }), submit)));
  return form;
}

function providerCard(provider, reload) {
  const models = provider.models || [];
  const status = h('span', { class: `tag ${HEALTH_TONE[provider.last_status] || 'grey'}`, text: provider.last_status || 'untested' });
  const quota = h('input', { type: 'number', min: '0', max: '100000', value: String(provider.daily_quota || 0), 'aria-label': `${provider.name} daily quota` });

  const card = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h3', { text: provider.name }), status,
      h('span', { class: 'spacer' }),
      h('small', { class: 'muted tiny', text: provider.checked_at ? `checked ${timeAgo(provider.checked_at)}` : 'never checked' })),
    h('p', { class: 'tiny muted', style: { margin: '0 0 10px' }, text: `${provider.provider_key} · ${provider.wire} · ${provider.base_url}${provider.key_hint ? ` · key ends ${provider.key_hint}` : ''}` }),
    provider.last_error ? h('div', { class: 'banner warn' }, h('div', {}, h('b', { text: 'Last error' }), h('span', { text: provider.last_error }))) : null,
    h('div', { class: 'row wrap-gap' },
      h('button', { class: 'btn sm', type: 'button', text: 'Test connection', onClick: async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Testing…';
        try {
          const result = await api.post(`/api/admin/providers/${provider.id}/test`);
          toast(result.message || `Status: ${result.status}`, result.status === 'ok' ? 'good' : 'bad');
          reload();
        } catch (error) { errorToast(error); button.disabled = false; button.textContent = 'Test connection'; }
      } }),
      h('button', { class: 'btn sm secondary', type: 'button', text: 'Verify pricing', onClick: async event => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Checking…';
        try {
          const result = await api.post(`/api/admin/providers/${provider.id}/verify`);
          toast(`${result.checked} models checked · ${result.free} free · ${result.unverifiable} unverifiable`, result.free ? 'good' : '');
          reload();
        } catch (error) { errorToast(error); button.disabled = false; button.textContent = 'Verify pricing'; }
      } }),
      h('button', { class: 'btn sm ghost', type: 'button', text: provider.enabled ? 'Disable provider' : 'Enable provider', onClick: async () => {
        try { await api.patch(`/api/admin/providers/${provider.id}`, { enabled: !provider.enabled }); reload(); }
        catch (error) { errorToast(error); }
      } }),
      h('button', { class: 'btn sm ghost', type: 'button', text: 'Save quota', onClick: async () => {
        try { await api.patch(`/api/admin/providers/${provider.id}`, { daily_quota: Number(quota.value) || 0 }); toast('Quota saved.', 'good'); reload(); }
        catch (error) { errorToast(error); }
      } }),
      h('button', { class: 'btn sm ghost danger', type: 'button', text: 'Delete provider', onClick: async () => {
        try { await api.del(`/api/admin/providers/${provider.id}`); toast('Provider deleted.', 'good'); reload(); }
        catch (error) { errorToast(error); }
      } })),
    h('div', { class: 'field', style: { maxWidth: '220px', marginTop: '10px' } }, h('label', { text: 'Daily quota' }), quota));

  card.appendChild(h('div', { class: 'model-row', style: { marginTop: '14px' } },
    h('div', { class: 'stat-label', text: `Models (${models.length})` }),
    models.length ? h('table', {}, h('thead', {}, h('tr', {},
      h('th', { text: 'Model' }), h('th', { text: 'Pricing' }), h('th', { text: 'Input / output' }), h('th', { text: 'Enabled' }))),
      h('tbody', {}, models.map(model => h('tr', {},
        h('td', {}, h('div', { text: model.display_name }), h('small', { class: 'muted tiny', text: model.model_id })),
        h('td', {}, h('span', { class: `tag ${model.router ? 'teal' : model.pricing_verified && model.free_tier ? 'green' : 'grey'}`,
          text: model.router ? 'router' : model.pricing_verified ? (model.free_tier ? 'free' : 'paid') : 'unverified' })),
        h('td', { class: 'tiny muted', text: `${num(model.input_micro_per_1k)} / ${num(model.output_micro_per_1k)}` }),
        h('td', {}, h('label', { class: 'switch' },
          h('input', { type: 'checkbox', checked: model.enabled, onChange: async event => {
            try { await api.patch(`/api/admin/models/${model.id}`, { enabled: event.currentTarget.checked }); reload(); }
            catch (error) { errorToast(error); reload(); }
          } }),
          h('span', { text: model.enabled ? 'On' : 'Off' })))))))
      : h('p', { class: 'muted tiny', text: 'No models registered yet. Run “Verify pricing” to read the provider’s own catalogue.' })));

  card.appendChild(modelForm(provider.id, reload));
  return card;
}

function modelForm(providerId, reload) {
  const modelId = h('input', { type: 'text', placeholder: 'openrouter/free', 'aria-label': 'Model id' });
  const display = h('input', { type: 'text', placeholder: 'OpenRouter free router', 'aria-label': 'Display name' });
  const router = h('input', { type: 'checkbox' });
  const submit = h('button', { class: 'btn sm', type: 'submit', text: 'Add model' });
  return h('form', { class: 'row wrap-gap', style: { marginTop: '12px' }, onSubmit: async event => {
    event.preventDefault();
    submit.disabled = true;
    try {
      await api.post(`/api/admin/providers/${providerId}/models`, {
        model_id: modelId.value.trim(), display_name: display.value.trim(), router: router.checked,
      });
      modelId.value = '';
      display.value = '';
      router.checked = false;
      toast('Model added. It stays disabled until its pricing is verified.', 'good');
      reload();
    } catch (error) { errorToast(error); }
    finally { submit.disabled = false; }
  } },
    field('Model id', modelId, 'Exactly as the provider lists it'),
    field('Display name', display),
    h('label', { class: 'switch' }, router, h('span', { text: 'This is a router' })),
    submit);
}
