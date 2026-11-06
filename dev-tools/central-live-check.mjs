// Live check for the platform-managed provider: does the central connection
// provision itself, does its catalogue verify as free against the provider's
// own published prices, and does a real question come back and cost exactly
// 2 BC?
//
// Nothing here fakes an answer and nothing here invents a key.
//
//   With OPENROUTER_API_KEY set   → the app's own router, adapter and ledger
//                                    are used for one real question. The reply,
//                                    the model that answered and the credits
//                                    charged are printed.
//   Without it                    → only the catalogue read is performed
//                                    (OpenRouter publishes it) and the script
//                                    says plainly that no generation was
//                                    attempted. A placeholder key is used for
//                                    the catalogue request and is labelled as
//                                    one; it cannot answer anything.
//
// Run:
//   OPENROUTER_API_KEY=<your key> ./dev-tools/node.sh dev-tools/central-live-check.mjs
import { boot } from './function-smoke.mjs';

const KEY = String(process.env.OPENROUTER_API_KEY || '').trim();
const PLACEHOLDER = 'sk-or-v1-local-catalogue-read-not-a-real-key';
const QUESTION = 'Explain Newton\'s first law of motion in simple Class 10 language.';

const env = await boot({
  envProvider: name => ({
    CREDENTIAL_KEY: 'local-central-check-credential-key',
    OPENROUTER_API_KEY: KEY || PLACEHOLDER,
  })[name],
  fetchImpl: (url, init) => fetch(url, init),
});

const say = (...parts) => console.log(...parts);
const line = () => say('-'.repeat(72));

// ---- 1. does the central provider provision itself? -------------------------
// GET /api/ai/settings is the student-facing read. It calls centralState(),
// which calls ensureCentral(): the provider row, the routing model and the
// catalogue sync all happen there, on a real request, exactly as they do in
// the deployed Function.
say('');
say('STUDYBRIDGE — central provider live check');
line();
const settings = await env.call('GET', '/api/ai/settings');
const central = settings.json?.central || null;
if (!central) {
  say('The central block was not returned. Raw response:');
  console.log(JSON.stringify(settings.json, null, 2).slice(0, 1200));
  process.exit(1);
}
say('configured      :', central.configured);
say('available       :', central.available);
say('provider_key    :', central.provider_key);
say('base url        :', (env.db.rows('ai_providers')[0] || {}).base_url);
say('wire            :', (env.db.rows('ai_providers')[0] || {}).wire);
say('key hint        :', central.key_hint || '(none)', '(last four only)');
say('routing model   :', central.model);
say('free models     :', central.free_models, 'of', central.approved_models, 'selectable');
say('catalogue check :', central.last_status, central.checked_at ? `at ${central.checked_at}` : 'never');
if (central.last_error) say('last error      :', central.last_error);

const provider = env.db.rows('ai_providers')[0] || {};
const cipher = String(provider.key_cipher || '');
say('stored cipher   :', cipher ? `${cipher.slice(0, 24)}… (${cipher.length} chars, AES-GCM)` : '(none)');
say('cipher contains the plaintext key:',
  cipher.includes(KEY || PLACEHOLDER) ? 'YES — that would be a bug' : 'no');

// ---- 2. which models passed the zero-price gate? ----------------------------
line();
const models = env.db.rows('ai_models');
const free = models.filter(m => m.free_tier === true && m.pricing_verified === true);
const priced = models.filter(m => m.pricing_verified === true);
const routers = models.filter(m => m.router === true);
say(`catalogue read  : ${models.length} models recorded, ${priced.length} with a published price, ${free.length} at exactly $0`);
for (const model of free.slice(0, 12)) {
  say(`   free  ${model.model_id}  (in ${model.input_micro_per_1k}/1k, out ${model.output_micro_per_1k}/1k, enabled ${model.enabled})`);
}
for (const model of routers) say(`   router ${model.model_id}`);

// ---- 3. a real question, only with a real key -------------------------------
line();
if (!KEY) {
  say('NO OPENROUTER_API_KEY — no generation was attempted and no answer is claimed.');
  say('The catalogue read above is real. A question needs a real key:');
  say('  OPENROUTER_API_KEY=<your key> ./dev-tools/node.sh dev-tools/central-live-check.mjs');
  process.exit(0);
}

const space = await env.call('POST', '/api/spaces', { name: 'Central check', subject: 'Physics', color: 'teal' });
const spaceId = space.json?.id;
if (!spaceId) { say('Could not create a space:', JSON.stringify(space.json)); process.exit(1); }

// Earn the daily login reward first, so the wallet starts from a known state.
const login = await env.call('POST', '/api/daily/login');
const before = login.json?.balance;
say('daily login     :', login.json?.claimed ? `+${login.json?.credits} BC` : `not claimed (${login.json?.reason})`);
say('balance before  :', before);

const question = await env.call('POST', `/api/spaces/${spaceId}/chat`, {
  message: QUESTION,
  client_key: crypto.randomUUID(),
});
if (question.status >= 400) {
  say('the request failed:', question.status, question.json?.error);
  say('hint:', question.json?.hint || '(none)');
  const wallet = await env.call('GET', '/api/wallet');
  say('balance after   :', wallet.json?.balance, '(unchanged — a failed request is not charged)');
  process.exit(1);
}
say('');
say('REPLY FROM THE PROVIDER:');
say(String(question.json?.reply || '').slice(0, 1200));
line();
say('model that answered :', question.json?.model?.model_id || question.json?.model?.model_name);
say('provider            :', question.json?.provider?.api_name || question.json?.provider?.provider_key);
say('tokens              :', question.json?.tokens);
say('credits spent       :', question.json?.credits_spent, '(the published price of a basic question)');
say('balance after       :', question.json?.balance, 'was', before);

const wallet = await env.call('GET', '/api/wallet');
say('ledger              :', JSON.stringify(wallet.json?.history?.slice(0, 4).map(row => [row.direction, row.amount, row.reason])));
say('daily allowance     :', JSON.stringify(wallet.json?.daily_ai));
say('');
