import { describe, expect, it } from 'vitest';
import { createOfficeAiHandler } from './office-ai.js';

const SUPABASE = 'https://nresyncmhdybucenhxbw.supabase.co';
const RPC = `${SUPABASE}/rest/v1/rpc/office_gov_record_control_read`;
const OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions';
const workspaceId = '11111111-1111-4111-8111-111111111111';
const correspondenceId = '22222222-2222-4222-8222-222222222222';

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}
function harness(control = { workspace_id: workspaceId, correspondence_id: correspondenceId, classification: 'public', status: 'registered' }, rpcStatus = 200) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === `${SUPABASE}/auth/v1/user`) return response({ id: 'user-1' });
    if (url === RPC) return response(control, rpcStatus);
    if (url === OPENROUTER) return response({ model: 'google/gemma-4-31b-it:free', usage: { cost: 0 }, choices: [{ message: { content: 'Suggestion.' } }] });
    throw new Error(`Unexpected URL ${url}`);
  };
  const handler = createOfficeAiHandler({
    envProvider: () => ({ VITE_COCCE_SUPABASE_URL: SUPABASE, VITE_COCCE_SUPABASE_ANON_KEY: 'sb_publishable_test_public_key', OPENROUTER_API_KEY: 'openrouter-test' }),
    fetchImpl,
  });
  return { handler, calls };
}
function invoke(handler, body) {
  const res = { statusCode: 0, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  return handler({ method: 'POST', headers: { authorization: 'Bearer token' }, body }, res).then(() => res);
}
function payload(overrides = {}) {
  return { action: 'government_review', workspaceId, correspondenceId, selectedText: 'A public policy excerpt.', reviewAction: 'summarize', nonSensitiveConfirmed: true, ...overrides };
}
function providerCalls(calls) { return calls.filter((call) => call.url === OPENROUTER); }

describe('Government AI server guard', () => {
  it('rejects confidential, restricted, or classified records before AI', async () => {
    for (const classification of ['confidential', 'restricted', 'classified']) {
      const { handler, calls } = harness({ workspace_id: workspaceId, correspondence_id: correspondenceId, classification, status: 'registered' });
      const result = await invoke(handler, payload());
      expect(result.statusCode).toBe(403);
      expect(providerCalls(calls)).toHaveLength(0);
    }
  });

  it('rejects missing or malformed context and missing confirmation before RPC/provider', async () => {
    for (const body of [payload({ workspaceId: '' }), payload({ correspondenceId: '' }), payload({ workspaceId: 'not-a-uuid' }), payload({ nonSensitiveConfirmed: false })]) {
      const { handler, calls } = harness();
      const result = await invoke(handler, body);
      expect(result.statusCode).toBe(400);
      expect(calls.some((call) => call.url === RPC)).toBe(false);
      expect(providerCalls(calls)).toHaveLength(0);
    }
  });

  it('rejects obvious PII before RPC/provider', async () => {
    for (const selectedText of ['Contact person@example.com.', 'Call +1 (555) 123-4567.', 'Reference 123456789.']) {
      const { handler, calls } = harness();
      const result = await invoke(handler, payload({ selectedText }));
      expect(result.statusCode).toBe(400);
      expect(calls.some((call) => call.url === RPC)).toBe(false);
      expect(providerCalls(calls)).toHaveLength(0);
    }
  });

  it('fails closed when record-control RPC fails or the status is ineligible', async () => {
    for (const rpcStatus of [401, 500]) {
      const { handler, calls } = harness(null, rpcStatus);
      const result = await invoke(handler, payload());
      expect(result.statusCode).toBe(503);
      expect(providerCalls(calls)).toHaveLength(0);
    }
    const { handler, calls } = harness({ workspace_id: workspaceId, correspondence_id: correspondenceId, classification: 'public', status: 'closed' });
    const result = await invoke(handler, payload());
    expect(result.statusCode).toBe(403);
    expect(providerCalls(calls)).toHaveLength(0);
  });

  it('proceeds for public/internal eligible records and sends only the confirmed selected text', async () => {
    for (const classification of ['public', 'internal']) {
      const { handler, calls } = harness({ workspace_id: workspaceId, correspondence_id: correspondenceId, classification, status: 'registered' });
      const result = await invoke(handler, payload({ reviewAction: 'proofread' }));
      expect(result.statusCode).toBe(200);
      const rpcCall = calls.find((call) => call.url === RPC);
      expect(rpcCall.init.headers.Authorization).toBe('Bearer token');
      const providerCall = calls.find((call) => call.url === OPENROUTER);
      const userContent = JSON.parse(JSON.parse(providerCall.init.body).messages[1].content);
      expect(userContent).toEqual({ action: 'proofread', instruction: 'Correct spelling, grammar, punctuation, and obvious typographical errors. Preserve the original meaning and voice.', selectedText: 'A public policy excerpt.' });
      expect(Object.hasOwn(userContent, 'workspaceId')).toBe(false);
      expect(Object.hasOwn(userContent, 'correspondenceId')).toBe(false);
    }
  });
});
