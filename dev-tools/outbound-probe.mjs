// Counts every HTTP request StudyBridge actually sends when a provider refuses.
//
// A local server sits at the far end of a real socket and logs each call it
// receives. Only the host is redirected — every guard, adapter, retry, cooldown,
// dedup and queue line runs the way it does in the deployed Function. xKiro is
// never contacted and no existing provider row is read or changed.
//
// Each phase starts a fresh session, because a refusal cools the model and would
// otherwise decide the next phase's result for it.
//
// Run: ./dev-tools/node.sh dev-tools/outbound-probe.mjs
import { createServer } from 'node:http';

const PROBE_KEY = 'probe-key-never-sent-to-any-real-endpoint';
const STUB_BASE = 'https://api.stub-provider.example/v1';
const MODEL_ID = 'qwen/qwen3.8-max:free';

function stubProvider() {
  const log = [];
  const state = { mode: 503, retryAfter: 0, active: 0, maxActive: 0, word: 'Because F = ma, acceleration is force over mass.' };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      if (req.url.includes('/models')) {
        log.push({ at: Date.now(), path: '/models', status: 200 });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: MODEL_ID, object: 'model' }] }));
        return;
      }
      log.push({ at: Date.now(), path: req.url, status: state.mode });
      state.active += 1;
      if (state.active > state.maxActive) state.maxActive = state.active;
      setTimeout(() => {
        state.active -= 1;
        if (state.mode === 200) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: state.word } }], usage: { prompt_tokens: 12, completion_tokens: 9 } }));
          return;
        }
        // xKiro's own envelope: a generic server-fault sentence on a 429 and on a
        // 503. The Retry-After header is added only when a phase asks for it,
        // because on the real gateway it is never present.
        const headers = { 'content-type': 'application/json' };
        if (state.retryAfter) headers['retry-after'] = String(state.retryAfter);
        res.writeHead(state.mode, headers);
        res.end(JSON.stringify({
          error: { message: 'A server error occurred. Please try again.', type: 'server_error', code: 'server_error' },
        }));
      }, 120);
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port, state,
        mark() { log.length = 0; state.maxActive = 0; state.active = 0; },
        completions() { return log.filter(item => item.path.includes('chat/completions')).length; },
        usageReads() { return log.filter(item => item.path.includes('/usage')).length; },
        gaps() {
          const times = log.filter(item => item.path.includes('chat/completions')).map(item => item.at);
          return times.slice(1).map((at, index) => at - times[index]);
        },
        close() { server.close(); },
      });
    });
  });
}

// The one substitution: the public-shaped host the router builds is pointed at
// the local socket. Everything up to that line is the deployed code path.
function redirectingFetch(stub) {
  return (url, init) => fetch(String(url).replace('https://api.stub-provider.example', `http://127.0.0.1:${stub.port}`), init);
}

const BASE_ENV = {
  CREDENTIAL_KEY: 'probe-credential-key',
  AI_TIMEOUT_MS: '15000',
  AI_RETRY_ATTEMPTS: '3',
  AI_RETRY_BASE_MS: '250',
  AI_RETRY_MAX_MS: '1200',
  AI_RETRY_BUDGET_MS: '6000',
  AI_RETRY_AFTER_CAP_MS: '6000',
  MODEL_COOLDOWN_MS: '20000',
  MODEL_COOLDOWN_MAX_MS: '120000',
  AI_RECOVERY_PROBE_MS: '60000',
  AI_MAX_CONCURRENT: '1',
};

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function phase(name, envOverrides, body) {
  const stub = await stubProvider();
  const app = await boot({ envProvider: name => ({ ...BASE_ENV, ...envOverrides })[name], fetchImpl: redirectingFetch(stub) });
  const space = await app.call('POST', '/api/spaces', { name: 'Probe Space', subject: 'Physics' });
  const provider = await app.call('POST', '/api/providers', {
    api_name: 'Stub Qwen', provider_id: 'xkiro-qwen', base_url: STUB_BASE,
    api_key: PROBE_KEY, model: MODEL_ID, model_name: 'Qwen Max Free', consent: true,
  });
  if (!provider.json?.provider?.id) {
    console.log(`${name}: provider could not be saved`, provider.status, JSON.stringify(provider.json).slice(0, 160));
    stub.close();
    return;
  }
  stub.mark();
  const chat = message => app.call('POST', `/api/spaces/${space.json?.space?.id || space.json?.id}/chat`, { message });
  const lines = await body({ app, stub, chat, providerId: provider.json.provider.id });
  console.log(`\n--- ${name} ---`);
  for (const line of lines) console.log(`    ${line}`);
  stub.close();
}

const { boot } = await import('./function-smoke.mjs');

// 1 — what one refused question actually costs
await phase('one question, provider answers 503 (no Retry-After)', {}, async ({ chat, stub }) => {
  const started = Date.now();
  const res = await chat('Explain Newton second law');
  return [
    `requests the provider saw: ${stub.completions()} (AI_RETRY_ATTEMPTS=3, budget 6s)`,
    `wall time ${Date.now() - started} ms, gaps between attempts ${JSON.stringify(stub.gaps())} ms`,
    `student sees HTTP ${res.status} ${res.json?.error}: ${String(res.json?.hint || '').slice(0, 150)}`,
    `key in any response body: ${JSON.stringify(res.json).includes(PROBE_KEY) ? 'LEAKED' : 'no'}`,
  ];
});

// 2 — the same question pressed five times at once
await phase('5 concurrent presses of the identical question', {}, async ({ chat, stub }) => {
  const results = await Promise.all(Array.from({ length: 5 }, () => chat('Explain Newton second law')));
  return [
    `requests the provider saw: ${stub.completions()} for 5 student presses`,
    `peak simultaneous connections: ${stub.state.maxActive}`,
    `all five got a result: ${results.length === 5} (${results.every(r => r.status === results[0].status) ? 'same status ' + results[0].status : 'mixed'})`,
  ];
});

// 3 — two different questions at once, cap 1 vs cap 4
await phase('4 different questions at once, concurrency cap 1', {}, async ({ chat, stub }) => {
  await Promise.all(Array.from({ length: 4 }, (unused, index) => chat(`Question ${index}`)));
  return [
    `requests the provider saw: ${stub.completions()}, peak simultaneous: ${stub.state.maxActive} (one at a time)`,
  ];
});
await phase('4 different questions at once, concurrency cap 4', { AI_MAX_CONCURRENT: '4' }, async ({ chat, stub }) => {
  await Promise.all(Array.from({ length: 4 }, (unused, index) => chat(`Question ${index}`)));
  return [
    `requests the provider saw: ${stub.completions()}, peak simultaneous: ${stub.state.maxActive} (what an unserialised pool does)`,
  ];
});

// 4 — does a 429 that names its own wait get respected
await phase('429 with Retry-After: 2', { AI_RETRY_BASE_MS: '0', AI_RETRY_MAX_MS: '0' }, async ({ chat, stub }) => {
  stub.state.mode = 429;
  stub.state.retryAfter = 2;
  const res = await chat('Explain Newton second law');
  return [
    `requests the provider saw: ${stub.completions()} completions + ${stub.usageReads()} account-usage read (asked once per provider per 5 minutes, never per retry)`,
    `gaps between completion attempts: ${JSON.stringify(stub.gaps())} ms — each at least the 2s the provider asked for, plus the 250ms floor`,
    `classified as: HTTP ${res.status} ${res.json?.error}`,
  ];
});

// 5 — after the refusal, does the next question still reach the provider?
await phase('question, refusal, then 5 more questions while cooling', {}, async ({ chat, stub }) => {
  await chat('Explain Newton second law');
  stub.mark();
  const more = await Promise.all(Array.from({ length: 5 }, (unused, index) => chat(`Follow-up ${index}`)));
  const codes = [...new Set(more.map(r => `${r.status}/${r.json?.error}`))];
  const paused = more.filter(r => r.json?.error === 'provider_paused').length;
  return [
    `requests the provider saw from those 5 questions: ${stub.completions()} (one gated probe, then nothing)`,
    `answered without sending: ${paused} of 5, codes ${codes.join(' ')}`,
    `what the student reads: ${String(more.find(r => r.json?.error === 'provider_paused')?.json?.hint || '').slice(0, 170)}`,
  ];
});

// 6 — automatic recovery, with the provider back up and no config touched
await phase('recovery: short cooldown, then the provider answers again',
  { MODEL_COOLDOWN_MS: '1500', MODEL_COOLDOWN_MAX_MS: '2000', AI_RECOVERY_PROBE_MS: '5000' },
  async ({ chat, stub, app, providerId }) => {
    await chat('Explain gravity');
    stub.mark();
    const held = await Promise.all(Array.from({ length: 4 }, (unused, index) => chat(`Held ${index}`)));
    const during = stub.completions();
    await wait(7000);
    stub.state.mode = 200;
    stub.mark();
    const back = await chat('Explain gravity again');
    const after = await app.call('GET', '/api/providers');
    const row = (after.json?.providers || []).find(item => item.id === providerId);
    const model = row?.models?.[0];
    return [
      `during the pause 4 presses sent ${during} request(s); codes ${[...new Set(held.map(r => r.json?.error))].join(' ')}`,
      `after the window: ${stub.completions()} request, HTTP ${back.status}, reply "${String(back.json?.reply || back.json?.error || '').slice(0, 40)}"`,
      `provider row after all of it: enabled=${row?.enabled} status=${row?.status} model_id="${model?.model_id}" tier=${model?.tier} fail_streak=${model?.fail_streak}`,
      `any paid model introduced: ${(after.json?.providers || []).flatMap(item => item.models || []).some(item => (item.input_micro_per_1k || 0) > 0) ? 'YES' : 'no'} (only the free id above was ever enabled)`,
    ];
  });

console.log('\nEvery count above was taken by the server at the far end of the socket, not by the caller.');
