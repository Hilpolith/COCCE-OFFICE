import assert from 'node:assert/strict';
import test from 'node:test';
const { createOfficeAiHandler } = await import('../api/office-ai.js');
const COCCE_URL = 'https://nresyncmhdybucenhxbw.supabase.co';
const ANON_KEY = 'sb_publishable_test_public_key';
const OPENAI_TEST_KEY = 'test-only-server-key';

function makeResponse() {
  return {
    statusCode: 0,
    body: null,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function makeHarness({
  env = {},
  authStatus = 200,
  openaiStatus = 200,
  user = { id: 'existing-cocce-test-user' },
  output = 'A polished, shorter passage.',
  maxRequests = 12,
  windowMs = 600_000,
  now = () => 1_000,
} = {}) {
  const calls = [];
  const effectiveEnv = {
    VITE_COCCE_SUPABASE_URL: COCCE_URL,
    VITE_COCCE_SUPABASE_ANON_KEY: ANON_KEY,
    OPENAI_API_KEY: OPENAI_TEST_KEY,
    ...env,
  };
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    if (String(input) === `${COCCE_URL}/auth/v1/user`) {
      return { ok: authStatus >= 200 && authStatus < 300, status: authStatus, json: async () => user };
    }
    if (String(input) === 'https://api.openai.com/v1/chat/completions') {
      return {
        ok: openaiStatus >= 200 && openaiStatus < 300,
        status: openaiStatus,
        json: async () => ({ choices: [{ message: { content: output } }] }),
      };
    }
    throw new Error(`Unexpected URL: ${String(input)}`);
  };
  const handler = createOfficeAiHandler({ envProvider: () => effectiveEnv, fetchImpl, now, maxRequests, windowMs });
  return { handler, calls, effectiveEnv };
}

async function invoke(handler, { method = 'POST', token = 'valid-user-access-token', body, contentLength } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (contentLength !== undefined) headers['content-length'] = String(contentLength);
  const req = { method, headers, body };
  const res = makeResponse();
  await handler(req, res);
  return res;
}

test('availability status is authenticated, cache disabled, and returns no credential', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { method: 'GET' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { configured: true });
  assert.equal(res.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].input, `${COCCE_URL}/auth/v1/user`);
  assert.equal(calls[0].init.headers.apikey, ANON_KEY);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer valid-user-access-token');
  assert.equal(JSON.stringify(res.body).includes(OPENAI_TEST_KEY), false);
});

test('POST sends only an explicitly selected excerpt and the fixed task to OpenAI', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { body: { action: 'summarize', selectedText: 'Only the passage the user selected.' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { text: 'A polished, shorter passage.' });
  const providerCall = calls.find((call) => call.input === 'https://api.openai.com/v1/chat/completions');
  assert.ok(providerCall);
  assert.equal(providerCall.init.headers.Authorization, `Bearer ${OPENAI_TEST_KEY}`);
  const request = JSON.parse(providerCall.init.body);
  assert.equal(request.model, 'gpt-6-luna');
  assert.equal(request.reasoning_effort, 'none');
  assert.equal(Object.hasOwn(request, 'temperature'), false);
  assert.equal(request.max_completion_tokens, 1_200);
  assert.equal(request.store, false);
  assert.equal(request.messages[0].role, 'developer');
  const userContent = JSON.parse(request.messages[1].content);
  assert.equal(userContent.action, 'summarize');
  assert.equal(userContent.selectedText, 'Only the passage the user selected.');
  assert.equal(Object.hasOwn(userContent, 'documentTitle'), false);
  assert.equal(Object.hasOwn(userContent, 'documentId'), false);
  assert.equal(JSON.stringify(res.body).includes(OPENAI_TEST_KEY), false);
});

test('draft sends only the typed brief and never an existing document selection', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { body: { action: 'draft', prompt: 'Draft notes from these user-supplied facts.' } });
  assert.equal(res.statusCode, 200);
  const providerCall = calls.find((call) => call.input === 'https://api.openai.com/v1/chat/completions');
  assert.ok(providerCall);
  const userContent = JSON.parse(JSON.parse(providerCall.init.body).messages[1].content);
  assert.deepEqual(userContent, { action: 'draft', draftingBrief: 'Draft notes from these user-supplied facts.' });
});

test('invalid or over-broad request fields are rejected before any OpenAI call', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { body: {
    action: 'summarize',
    selectedText: 'excerpt',
    documentTitle: 'private title',
    documentContent: 'entire document',
  } });
  assert.equal(res.statusCode, 400);
  assert.equal(calls.some((call) => call.input === 'https://api.openai.com/v1/chat/completions'), false);
  assert.equal(calls.some((call) => JSON.stringify(call.init).includes('entire document')), false);
});

test('draft requests containing any selectedText field are rejected', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { body: { action: 'draft', prompt: 'Write a note.', selectedText: 'existing text' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'DRAFT_MUST_NOT_INCLUDE_SELECTION');
  assert.equal(calls.some((call) => call.input === 'https://api.openai.com/v1/chat/completions'), false);
});

test('requires a valid existing COCCE Auth session before provider access', async () => {
  const { handler, calls } = makeHarness({ authStatus: 401 });
  const res = await invoke(handler, { body: { action: 'proofread', selectedText: 'Excerpt.' } });
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 1);
  assert.equal(calls.some((call) => call.input === 'https://api.openai.com/v1/chat/completions'), false);
});

test('requires an existing COCCE session bearer token', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { token: '', body: { action: 'summarize', selectedText: 'Excerpt.' } });
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 0);
});

test('rejects mismatched Supabase projects and service-role keys', async () => {
  const wrongProject = makeHarness({ env: { VITE_COCCE_SUPABASE_URL: 'https://another-project.supabase.co' } });
  const wrongUrlResponse = await invoke(wrongProject.handler, { method: 'GET' });
  assert.equal(wrongUrlResponse.statusCode, 503);
  assert.equal(wrongProject.calls.length, 0);

  const serviceKey = makeHarness({ env: { VITE_COCCE_SUPABASE_ANON_KEY: 'sb_secret_do_not_use' } });
  const serviceKeyResponse = await invoke(serviceKey.handler, { method: 'GET' });
  assert.equal(serviceKeyResponse.statusCode, 503);
  assert.equal(serviceKey.calls.length, 0);
});

test('fails closed when OPENAI_API_KEY is absent and never attempts provider access', async () => {
  const { handler, calls } = makeHarness({ env: { OPENAI_API_KEY: '' } });
  const status = await invoke(handler, { method: 'GET' });
  assert.deepEqual(status.body, { configured: false });
  const res = await invoke(handler, { body: { action: 'summarize', selectedText: 'Excerpt.' } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'AI_NOT_CONFIGURED');
  assert.equal(calls.some((call) => call.input === 'https://api.openai.com/v1/chat/completions'), false);
});

test('enforces excerpt, prompt, and request-size limits', async () => {
  const { handler, calls } = makeHarness();
  const longSelection = await invoke(handler, { body: { action: 'summarize', selectedText: 'x'.repeat(8_001) } });
  assert.equal(longSelection.statusCode, 400);
  const longPrompt = await invoke(handler, { body: { action: 'draft', prompt: 'x'.repeat(1_201) } });
  assert.equal(longPrompt.statusCode, 400);
  const hugeBody = await invoke(handler, { body: { action: 'summarize', selectedText: 'x'.repeat(40_001) } });
  assert.equal(hugeBody.statusCode, 413);
  assert.equal(calls.some((call) => call.input === 'https://api.openai.com/v1/chat/completions'), false);
});

test('rejects oversized declared bodies before Auth or provider calls', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { body: {}, contentLength: 40_001 });
  assert.equal(res.statusCode, 413);
  assert.equal(res.body.error, 'BODY_TOO_LARGE');
  assert.equal(calls.length, 0);
});

test('applies a short-window per-user request cap', async () => {
  let clock = 1_000;
  const { handler } = makeHarness({ maxRequests: 1, now: () => clock });
  const first = await invoke(handler, { body: { action: 'summarize', selectedText: 'Excerpt.' } });
  assert.equal(first.statusCode, 200);
  const limited = await invoke(handler, { body: { action: 'summarize', selectedText: 'Another excerpt.' } });
  assert.equal(limited.statusCode, 429);
  clock += 600_001;
  const afterWindow = await invoke(handler, { body: { action: 'summarize', selectedText: 'A later excerpt.' } });
  assert.equal(afterWindow.statusCode, 200);
});

test('does not reveal upstream failures or provider error details', async () => {
  const { handler } = makeHarness({ openaiStatus: 401 });
  const res = await invoke(handler, { body: { action: 'proofread', selectedText: 'Excerpt.' } });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'AI_UPSTREAM_UNAVAILABLE');
  assert.equal(JSON.stringify(res.body).includes(OPENAI_TEST_KEY), false);
  assert.equal(JSON.stringify(res.body).includes('invalid_api_key'), false);
});

test('unsupported HTTP methods are rejected without network access', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { method: 'DELETE' });
  assert.equal(res.statusCode, 405);
  assert.equal(calls.length, 0);
});
