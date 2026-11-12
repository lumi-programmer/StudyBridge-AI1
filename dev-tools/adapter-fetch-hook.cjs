// Test-only preload hook for the spawned production server (section N).
//
// guardEndpoint() requires an HTTPS base URL on a non-private host, so the
// spawned process points OPENROUTER_BASE_URL at a fake HTTPS name and this
// hook transparently forwards those requests to the local fake Supabase.
// Without it the child would silently fall back to the real OpenRouter and
// make live network calls. Never used outside the test harness.
const target = String(process.env.ADAPTER_FAKE_AI_URL || '').replace(/\/+$/, '');
const source = 'https://gateway.studybridge.test';
if (target) {
  const original = globalThis.fetch;
  const patched = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : '';
    if (url.startsWith(source)) {
      return original(`${target}${url.slice(source.length)}`, init);
    }
    return original(input, init);
  };
  patched.__adapterHook = true;
  globalThis.fetch = patched;
}
