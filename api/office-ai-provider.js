const SUPABASE_URL = 'https://nresyncmhdybucenhxbw.supabase.co';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FREE_ROUTER_MODEL = 'openrouter/free';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const requests = new Map();

function send(res, status, body) {
  res.setHeader?.('Cache-Control', 'no-store, max-age=0');
  res.setHeader?.('X-Content-Type-Options', 'nosniff');
  return res.status(status).json(body);
}
function bearer(req) {
  const value = req.headers?.authorization;
  const match = typeof value === 'string' && value.length <= 8300 ? /^Bearer\s+([^\s]+)$/i.exec(value) : null;
  return match?.[1]?.length <= 8192 ? match[1] : '';
}
function bodyOf(req) {
  let value = req.body;
  if (typeof value === 'string') { if (Buffer.byteLength(value) > 48000) return null; try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 48000) return null;
  if (Object.keys(value).some((key) => !['workspaceId','messages'].includes(key))) return null;
  if (typeof value.workspaceId !== 'string' || (value.workspaceId !== '*' && !UUID.test(value.workspaceId))) return null;
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 32) return null;
  let total = 0;
  for (const message of value.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || Object.keys(message).some((key) => !['role','content'].includes(key))
      || !['system','user','assistant'].includes(message.role)
      || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 24000) return null;
    total += message.content.length;
  }
  if (total > 46000) return null;
  return value;
}
async function verifyUser(token, env, fetchImpl) {
  const anon = env.VITE_COCCE_SUPABASE_ANON_KEY;
  if (env.VITE_COCCE_SUPABASE_URL !== SUPABASE_URL || typeof anon !== 'string' || !anon.trim()) return null;
  const response = await fetchImpl(SUPABASE_URL + '/auth/v1/user', { headers: { apikey: anon, Authorization: 'Bearer ' + token }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;
  const user = await response.json();
  return typeof user?.id === 'string' ? user : null;
}
async function verifyWorkspace(workspaceId, token, env, fetchImpl) {
  const headers = { apikey: env.VITE_COCCE_SUPABASE_ANON_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const response = await fetchImpl(SUPABASE_URL + '/rest/v1/rpc/office_list_workspaces', { method: 'POST', headers, body: '{}', cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('workspace_list_unavailable');
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error('workspace_list_invalid');
  const selected = workspaceId === '*' ? rows.slice(0,20) : rows.filter((row) => row?.workspace_id === workspaceId);
  if (!selected.length) return false;
  const settings = await Promise.all(selected.map(async (row) => {
    const check = await fetchImpl(SUPABASE_URL + '/rest/v1/rpc/office_get_workspace_ai_enabled', { method: 'POST', headers, body: JSON.stringify({ p_workspace_id: row.workspace_id }), cache: 'no-store', signal: AbortSignal.timeout(8000) });
    return check.ok ? await check.json() === true : null;
  }));
  if (settings.some((enabled) => enabled === true)) return true;
  if (settings.some((enabled) => enabled === null)) throw new Error('workspace_ai_control_unavailable');
  return false;
}
function rateAllowed(id, now = Date.now()) {
  for (const [key, item] of requests) if (now - item.started >= 600000) requests.delete(key);
  const item = requests.get(id);
  if (!item || now - item.started >= 600000) { requests.set(id, { started: now, count: 1 }); return true; }
  if (item.count >= 12) return false;
  item.count += 1; return true;
}

export function createOfficeAiProviderHandler({ envProvider = () => process.env, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  return async function officeAiProvider(req, res) {
    const env = envProvider();
    const method = String(req.method || '').toUpperCase();
    if (method === 'GET') return send(res, 200, { configured: typeof env.OPENROUTER_API_KEY === 'string' && Boolean(env.OPENROUTER_API_KEY.trim()), model: FREE_ROUTER_MODEL });
    if (method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (typeof env.OPENROUTER_API_KEY !== 'string' || !env.OPENROUTER_API_KEY.trim()) return send(res, 503, { error: 'AI_NOT_CONFIGURED', message: 'The server-side OpenRouter API key is missing.' });
    const token = bearer(req);
    if (!token) return send(res, 401, { error: 'AUTH_REQUIRED' });
    const body = bodyOf(req);
    if (!body) return send(res, 400, { error: 'INVALID_REQUEST' });
    let user;
    try { user = await verifyUser(token, env, fetchImpl); } catch { return send(res, 503, { error: 'AUTH_UNAVAILABLE' }); }
    if (!user) return send(res, 401, { error: 'AUTH_REQUIRED' });
    if (!rateAllowed(user.id, now())) return send(res, 429, { error: 'RATE_LIMITED', message: 'The free AI request limit has been reached for this account. Please retry later.' });
    try {
      if (!await verifyWorkspace(body.workspaceId, token, env, fetchImpl)) return send(res, 403, { error: 'WORKSPACE_AI_DISABLED_OR_DENIED' });
    } catch { return send(res, 503, { error: 'WORKSPACE_AI_CONTROL_UNAVAILABLE' }); }
    try {
      const upstream = await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.OPENROUTER_API_KEY.trim(), 'Content-Type': 'application/json', 'HTTP-Referer': 'https://cocce-office.vercel.app', 'X-Title': 'COCCE Office' },
        body: JSON.stringify({ model: FREE_ROUTER_MODEL, messages: body.messages, max_tokens: 1200, temperature: 0.25 }),
        signal: AbortSignal.timeout(25000),
      });
      if (!upstream.ok) {
        let code = ''; try { code = String((await upstream.json())?.error?.code || ''); } catch { /* sanitized */ }
        return send(res, [404,408,424,429,500,502,503,504].includes(upstream.status) || ['no_available_provider','no_endpoints_found','model_not_found'].includes(code) ? 503 : 502,
          { error: 'FREE_MODEL_UNAVAILABLE', message: 'OpenRouter could not serve a free model right now. COCCE Office never falls back to a paid model.' });
      }
      const result = await upstream.json();
      const text = result?.choices?.[0]?.message?.content;
      const model = result?.model;
      const cost = result?.usage?.cost;
      const validFreeModel = typeof model === 'string' && (model === FREE_ROUTER_MODEL || model.endsWith(':free'));
      const zeroCost = cost === undefined || cost === null || cost === 0 || (typeof cost === 'string' && Number(cost) === 0);
      if (!validFreeModel || !zeroCost || typeof text !== 'string' || !text.trim()) return send(res, 503, { error: 'FREE_MODEL_NOT_VERIFIED', message: 'A zero-cost free-model response could not be verified.' });
      return send(res, 200, { text: text.trim(), model, cost: 0 });
    } catch { return send(res, 503, { error: 'FREE_MODEL_UNAVAILABLE', message: 'The OpenRouter free-model service could not be reached. No paid fallback is enabled.' }); }
  };
}
export default createOfficeAiProviderHandler();
