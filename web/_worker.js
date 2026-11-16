// Pages Advanced-mode proxy Worker. Cloudflare Pages `_redirects` cannot
// proxy (200) to another host — only relative paths — so the two backend
// prefixes are forwarded here to the API Worker and everything else is
// served straight from static assets (_routes.json limits invocation to
// the proxy prefixes; the ASSETS branch is a safety net).
const API_HOST = 'https://studybridge-ai-final.zainabshoaib496.workers.dev';

const PROXY_PREFIXES = ['/functions/v1/app', '/storage'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (PROXY_PREFIXES.some(prefix => url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) {
      const target = new URL(url.pathname + url.search, API_HOST);
      return fetch(new Request(target, request));
    }
    return env.ASSETS.fetch(request);
  },
};
