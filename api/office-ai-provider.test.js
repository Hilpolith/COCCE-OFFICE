import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOfficeAiProviderHandler } from './office-ai-provider.js';

const SUPABASE = 'https://nresyncmhdybucenhxbw.supabase.co';
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function harness({ userId = crypto.randomUUID(), workspaceId = crypto.randomUUID(), providerResponse, providerStatus = 200, env = {}, workspaceEnabled = true, authStatus = 200, workspaceStatus = 200, aiStatus = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === SUPABASE + '/auth/v1/user') return response({ id: userId }, authStatus);
    if (url === SUPABASE + '/rest/v1/rpc/office_list_workspaces') return response([{ workspace_id: workspaceId, name: 'Test workspace' }], workspaceStatus);
    if (url === SUPABASE + '/rest/v1/rpc/office_get_workspace_ai_enabled') return response(workspaceEnabled, aiStatus);
    if (url === OPENROUTER) return response(providerResponse ?? {
      model: 'google/gemma-4-31b-it:free',
      usage: { cost: 0 },
      choices: [{ message: { content: 'A safe test response.' } }],
    }, providerStatus);
    throw new Error('Unexpected request: ' + url);
  };
  const handler = createOfficeAiProviderHandler({
    envProvider: () => ({
      VITE_COCCE_SUPABASE_URL: SUPABASE,
      VITE_COCCE_SUPABASE_ANON_KEY: 'sb_publishable_test_key',
      OPENROUTER_API_KEY: 'server-only-test-key',
      ...env,
    }),
    fetchImpl,
  });
  return { handler, calls, userId, workspaceId };
}

function invoke(handler, { method = 'POST', body, authorization = 'Bearer test-session' } = {}) {
  const res = {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  return Promise.resolve(handler({
    method,
    headers: authorization ? { authorization } : {},
    body,
  }, res)).then(() => res);
}

function payload(workspaceId, overrides = {}) {
  return {
    workspaceId,
    messages: [
      { role: 'system', content: 'You are a concise assistant.' },
      { role: 'user', content: 'Summarize the sample report.' },
    ],
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('COCCE Office free AI provider boundary', () => {
  it('reports configuration without exposing the provider key', async () => {
    const { handler } = harness();
    const result = await invoke(handler, { method: 'GET' });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ configured: true, model: 'openrouter/free' });
    expect(JSON.stringify(result.body)).not.toContain('server-only-test-key');
    expect(result.headers['Cache-Control']).toContain('no-store');
  });

  it('fails closed when the provider key or public Supabase configuration is missing', async () => {
    const missingProvider = harness({ env: { OPENROUTER_API_KEY: '' } });
    const unavailable = await invoke(missingProvider.handler, { body: payload(missingProvider.workspaceId) });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body.error).toBe('AI_NOT_CONFIGURED');
    expect(missingProvider.calls).toHaveLength(0);

    const missingAuthConfig = harness({ env: { VITE_COCCE_SUPABASE_ANON_KEY: '' } });
    const authFailure = await invoke(missingAuthConfig.handler, { body: payload(missingAuthConfig.workspaceId) });
    expect(authFailure.statusCode).toBe(401);
    expect(authFailure.body.error).toBe('AUTH_REQUIRED');
    expect(missingAuthConfig.calls).toHaveLength(0);
  });

  it('requires a valid bearer session and rejects malformed or oversized request bodies', async () => {
    const noToken = harness();
    expect((await invoke(noToken.handler, { body: payload(noToken.workspaceId), authorization: '' })).statusCode).toBe(401);
    expect(noToken.calls).toHaveLength(0);

    for (const body of [
      null,
      [],
      { ...payload(crypto.randomUUID()), extra: 'not permitted' },
      payload(crypto.randomUUID(), { messages: [] }),
      payload(crypto.randomUUID(), { messages: [{ role: 'tool', content: 'not permitted' }] }),
      payload(crypto.randomUUID(), { messages: [{ role: 'user', content: 'x'.repeat(24001) }] }),
      payload(crypto.randomUUID(), { messages: Array.from({ length: 33 }, () => ({ role: 'user', content: 'x' })) }),
    ]) {
      const test = harness();
      const result = await invoke(test.handler, { body });
      expect(result.statusCode).toBe(400);
      expect(test.calls.some((call) => call.url === OPENROUTER)).toBe(false);
    }
  });

  it('verifies workspace membership and AI enablement before contacting OpenRouter', async () => {
    const disabled = harness({ workspaceEnabled: false });
    const denied = await invoke(disabled.handler, { body: payload(disabled.workspaceId) });
    expect(denied.statusCode).toBe(403);
    expect(denied.body.error).toBe('WORKSPACE_AI_DISABLED_OR_DENIED');
    expect(disabled.calls.some((call) => call.url === OPENROUTER)).toBe(false);

    const missingWorkspace = harness({ workspaceId: crypto.randomUUID() });
    const notMember = await invoke(missingWorkspace.handler, { body: payload(crypto.randomUUID()) });
    expect(notMember.statusCode).toBe(403);
    expect(missingWorkspace.calls.some((call) => call.url === OPENROUTER)).toBe(false);

    const rpcUnavailable = harness({ aiStatus: 500 });
    const unavailable = await invoke(rpcUnavailable.handler, { body: payload(rpcUnavailable.workspaceId) });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.body.error).toBe('WORKSPACE_AI_CONTROL_UNAVAILABLE');
    expect(rpcUnavailable.calls.some((call) => call.url === OPENROUTER)).toBe(false);
  });

  it('sends the free router only the authenticated request and never a paid fallback', async () => {
    const test = harness();
    const result = await invoke(test.handler, { body: payload(test.workspaceId) });
    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ text: 'A safe test response.', model: 'google/gemma-4-31b-it:free', cost: 0 });
    const upstream = test.calls.find((call) => call.url === OPENROUTER);
    expect(upstream.init.headers.Authorization).toBe('Bearer server-only-test-key');
    const sent = JSON.parse(upstream.init.body);
    expect(sent.model).toBe('openrouter/free');
    expect(sent.max_tokens).toBe(1200);
    expect(sent.messages).toEqual(payload(test.workspaceId).messages);
    expect(JSON.stringify(upstream.init)).not.toContain(test.userId);
  });

  it('rejects non-free model identities, non-zero cost, and empty provider answers', async () => {
    const invalidResponses = [
      { model: 'google/gemma-4-31b-it', usage: { cost: 0 }, choices: [{ message: { content: 'Answer' } }] },
      { model: 'google/gemma-4-31b-it:free', usage: { cost: 0.001 }, choices: [{ message: { content: 'Answer' } }] },
      { model: 'google/gemma-4-31b-it:free', usage: { cost: 0 }, choices: [{ message: { content: '  ' } }] },
    ];
    for (const providerResponse of invalidResponses) {
      const test = harness({ providerResponse });
      const result = await invoke(test.handler, { body: payload(test.workspaceId) });
      expect(result.statusCode).toBe(503);
      expect(result.body.error).toBe('FREE_MODEL_NOT_VERIFIED');
    }
  });

  it('normalizes provider throttling and upstream failures without leaking raw provider errors', async () => {
    for (const status of [429, 500, 502, 503]) {
      const test = harness({ providerResponse: { error: { message: 'private upstream diagnostic', code: 'no_available_provider' } }, providerStatus: status });
      const result = await invoke(test.handler, { body: payload(test.workspaceId) });
      expect(result.statusCode).toBe(503);
      expect(result.body.error).toBe('FREE_MODEL_UNAVAILABLE');
      expect(JSON.stringify(result.body)).not.toContain('private upstream diagnostic');
    }
  });

  it('uses authenticated per-user throttling before making free-provider requests', async () => {
    const test = harness();
    const results = [];
    for (let index = 0; index < 13; index += 1) {
      results.push(await invoke(test.handler, { body: payload(test.workspaceId) }));
    }
    expect(results.slice(0, 12).every((result) => result.statusCode === 200)).toBe(true);
    expect(results[12].statusCode).toBe(429);
    expect(test.calls.filter((call) => call.url === OPENROUTER)).toHaveLength(12);
  });
});
