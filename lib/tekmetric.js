const HOSTS = new Set(['sandbox.tekmetric.com', 'shop.tekmetric.com']);
function configuration(env) {
  const url = new URL(env.TEKMETRIC_BASE_URL);
  if (url.protocol !== 'https:' || !HOSTS.has(url.hostname) || url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Invalid API configuration');
  if (!env.TEKMETRIC_CLIENT_ID || !env.TEKMETRIC_CLIENT_SECRET || !/^[1-9]\d*$/.test(env.TEKMETRIC_SHOP_ID || '')) throw new Error('Invalid API configuration');
  return { base: url.origin, shop: env.TEKMETRIC_SHOP_ID };
}
function createClient(env = process.env, fetchImpl = fetch, options = {}) {
  const { base, shop } = configuration(env);
  const deadline = Date.now() + (options.budgetMs ?? 45000);
  const timeoutMs = options.timeoutMs ?? 8000;
  let tokenPromise;
  async function request(path, init = {}) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('API request unavailable');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
    try {
      const response = await fetchImpl(`${base}${path}`, { ...init, redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error('API request unavailable');
      return await response.json();
    } catch { throw new Error('API request unavailable'); }
    finally { clearTimeout(timer); }
  }
  async function token() {
    if (!tokenPromise) tokenPromise = request('/api/v1/oauth/token', {
      method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${env.TEKMETRIC_CLIENT_ID}:${env.TEKMETRIC_CLIENT_SECRET}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials',
    }).then(data => {
      if (!data || typeof data.access_token !== 'string' || !data.access_token.trim()) throw new Error('API authentication unavailable');
      return data.access_token;
    });
    return tokenPromise;
  }
  return {
    shop, async authenticate() { await token(); },
    async get(path, query) {
      if (!['/repair-orders', '/jobs', '/employees'].includes(path)) throw new Error('Invalid API path');
      const accessToken = await token();
      return request(`/api/v1${path}?${new URLSearchParams(query)}`, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    },
  };
}
module.exports = { createClient, configuration };
