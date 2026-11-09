import assert from 'node:assert/strict';
import test from 'node:test';
const { createOfficeAiHandler } = await import('../api/office-ai.js');
const COCCE_URL = 'https://nresyncmhdybucenhxbw.supabase.co';
const ANON_KEY = 'sb_publishable_test_public_key';
const OPENROUTER_TEST_KEY = 'test-only-server-key';
const LEGACY_OPENAI_TEST_KEY = 'must-not-be-used';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const FREE_MODEL_ID = 'google/gemma-4-31b-it:free';
const TEST_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

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
  providerStatus = 200,
  providerError = null,
  user = { id: 'existing-cocce-test-user' },
  output = 'A polished, shorter passage.',
  returnedModel = FREE_MODEL_ID,
  reportedCost = 0,
  workspaceAiEnabled = true,
  workspaceRows = [{ workspace_id: TEST_WORKSPACE_ID, name: 'Synthetic workspace' }],
  maxRequests = 12,
  windowMs = 600_000,
  now = () => 1_000,
  logger = { warn() {} },
} = {}) {
  const calls = [];
  const effectiveEnv = {
    VITE_COCCE_SUPABASE_URL: COCCE_URL,
    VITE_COCCE_SUPABASE_ANON_KEY: ANON_KEY,
    OPENROUTER_API_KEY: OPENROUTER_TEST_KEY,
    OPENAI_API_KEY: LEGACY_OPENAI_TEST_KEY,
    ...env,
  };
  const fetchImpl = async (input, init = {}) => {
    calls.push({ input: String(input), init });
    if (String(input) === `${COCCE_URL}/auth/v1/user`) {
      return { ok: authStatus >= 200 && authStatus < 300, status: authStatus, json: async () => user };
    }
    if (String(input) === `${COCCE_URL}/rest/v1/rpc/office_list_workspaces`) {
      return { ok: true, status: 200, json: async () => workspaceRows };
    }
    if (String(input) === `${COCCE_URL}/rest/v1/rpc/office_get_workspace_ai_enabled`) {
      return { ok: true, status: 200, json: async () => workspaceAiEnabled };
    }
    if (String(input) === OPENROUTER_URL) {
      return {
        ok: providerStatus >= 200 && providerStatus < 300,
        status: providerStatus,
        json: async () => providerError ?? {
          model: returnedModel,
          usage: { cost: reportedCost },
          choices: [{ message: { content: output } }],
        },
      };
    }
    throw new Error(`Unexpected URL: ${String(input)}`);
  };
  const handler = createOfficeAiHandler({ envProvider: () => effectiveEnv, fetchImpl, now, maxRequests, windowMs, logger });
  return { handler, calls, effectiveEnv };
}

async function invoke(handler, { method = 'POST', token = 'valid-user-access-token', body, contentLength } = {}) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  if (contentLength !== undefined) headers['content-length'] = String(contentLength);
  const scopedBody = method === 'POST' && body && typeof body === 'object' && !Array.isArray(body)
    ? { workspaceId: TEST_WORKSPACE_ID, ...body }
    : body;
  const req = { method, headers, body: scopedBody };
  const res = makeResponse();
  await handler(req, res);
  return res;
}

function providerCallFrom(calls) {
  return calls.find((call) => call.input === OPENROUTER_URL);
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
  assert.equal(JSON.stringify(res.body).includes(OPENROUTER_TEST_KEY), false);
});

test('rejects requests without a workspace scope before provider access', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { body: { workspaceId: null, action: 'summarize', selectedText: 'Excerpt.' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'WORKSPACE_REQUIRED');
  assert.equal(providerCallFrom(calls), undefined);
});

test('workspace AI controls block disabled workspaces and non-members before provider access', async () => {
  const disabled = makeHarness({ workspaceAiEnabled: false });
  const disabledResponse = await invoke(disabled.handler, { body: { action: 'summarize', selectedText: 'Excerpt.' } });
  assert.equal(disabledResponse.statusCode, 403);
  assert.equal(disabledResponse.body.error, 'WORKSPACE_AI_DISABLED');
  assert.equal(providerCallFrom(disabled.calls), undefined);

  const nonMember = makeHarness({ workspaceRows: [] });
  const deniedResponse = await invoke(nonMember.handler, { body: { action: 'summarize', selectedText: 'Excerpt.' } });
  assert.equal(deniedResponse.statusCode, 403);
  assert.equal(deniedResponse.body.error, 'WORKSPACE_ACCESS_DENIED');
  assert.equal(providerCallFrom(nonMember.calls), undefined);
});

test('POST sends only an explicitly selected excerpt to the fixed free OpenRouter model', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { body: { action: 'summarize', selectedText: 'Only the passage the user selected.' } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { text: 'A polished, shorter passage.' });
  const providerCall = providerCallFrom(calls);
  assert.ok(providerCall);
  assert.equal(providerCall.init.headers.Authorization, `Bearer ${OPENROUTER_TEST_KEY}`);
  const request = JSON.parse(providerCall.init.body);
  assert.equal(request.model, FREE_MODEL_ID);
  assert.equal(request.model.endsWith(':free'), true);
  assert.deepEqual(request.provider, { only: ['google-ai-studio'], allow_fallbacks: false });
  assert.equal(Object.hasOwn(request, 'models'), false);
  assert.equal(request.max_tokens, 1_200);
  assert.equal(request.temperature, 0.2);
  assert.equal(Object.hasOwn(request, 'store'), false);
  assert.equal(Object.hasOwn(request, 'reasoning_effort'), false);
  assert.equal(request.messages[0].role, 'system');
  const userContent = JSON.parse(request.messages[1].content);
  assert.equal(userContent.action, 'summarize');
  assert.equal(userContent.selectedText, 'Only the passage the user selected.');
  assert.equal(Object.hasOwn(userContent, 'documentTitle'), false);
  assert.equal(Object.hasOwn(userContent, 'documentId'), false);
  assert.equal(Object.hasOwn(userContent, 'documentContent'), false);
  assert.equal(JSON.stringify(request).includes(OPENROUTER_TEST_KEY), false);
  assert.equal(JSON.stringify(res.body).includes(OPENROUTER_TEST_KEY), false);
});

test('document_summary sends only synthetic plain text plus the fixed server instruction', async () => {
  const { handler, calls } = makeHarness();
  const syntheticText = 'Synthetic full document body for contract testing.';
  const res = await invoke(handler, { body: { action: 'document_summary', documentText: syntheticText } });
  assert.equal(res.statusCode, 200);
  const providerCall = providerCallFrom(calls);
  assert.ok(providerCall);
  const request = JSON.parse(providerCall.init.body);
  assert.equal(request.model, FREE_MODEL_ID);
  assert.deepEqual(request.provider, { only: ['google-ai-studio'], allow_fallbacks: false });
  const userContent = JSON.parse(request.messages[1].content);
  assert.deepEqual(Object.keys(userContent).sort(), ['action', 'documentText', 'instruction']);
  assert.equal(userContent.action, 'document_summary');
  assert.equal(userContent.documentText, syntheticText);
  assert.match(userContent.instruction, /complete supplied document/i);
  for (const forbidden of ['selectedText', 'prompt', 'documentTitle', 'documentId', 'fileName', 'documentContent']) {
    assert.equal(Object.hasOwn(userContent, forbidden), false, `${forbidden} must not reach OpenRouter`);
  }
  assert.equal(JSON.stringify(request).includes('Synthetic local report'), false);
});

test('draft sends only the typed brief and never an existing document selection', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { body: { action: 'draft', prompt: 'Draft notes from these user-supplied facts.' } });
  assert.equal(res.statusCode, 200);
  const providerCall = providerCallFrom(calls);
  assert.ok(providerCall);
  const userContent = JSON.parse(JSON.parse(providerCall.init.body).messages[1].content);
  assert.deepEqual(userContent, { action: 'draft', draftingBrief: 'Draft notes from these user-supplied facts.' });
});

test('invalid or over-broad request fields are rejected before any OpenRouter call', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { body: {
    action: 'summarize',
    selectedText: 'excerpt',
    documentTitle: 'private title',
    documentContent: 'entire document',
  } });
  assert.equal(res.statusCode, 400);
  assert.equal(providerCallFrom(calls), undefined);
  assert.equal(JSON.stringify(calls).includes('entire document'), false);
});

test('document summaries reject selected-text, prompt, and metadata fields rather than broadening the payload', async () => {
  const { handler, calls } = makeHarness();
  for (const body of [
    { action: 'document_summary', documentText: 'Synthetic text.', selectedText: 'extra excerpt' },
    { action: 'document_summary', documentText: 'Synthetic text.', prompt: 'extra prompt' },
    { action: 'document_summary', documentText: 'Synthetic text.', documentTitle: 'private title' },
    { action: 'summarize', selectedText: 'Synthetic excerpt.', documentText: 'must not append document' },
  ]) {
    const res = await invoke(handler, { body });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(providerCallFrom(calls), undefined);
  assert.equal(JSON.stringify(calls).includes('must not append document'), false);
});

test('clients cannot supply model, alternate models, or provider-routing overrides', async () => {
  const { handler, calls } = makeHarness();
  for (const body of [
    { action: 'summarize', selectedText: 'Excerpt.', model: 'paid/model' },
    { action: 'summarize', selectedText: 'Excerpt.', models: ['paid/model'] },
    { action: 'summarize', selectedText: 'Excerpt.', provider: { allow_fallbacks: true } },
  ]) {
    const res = await invoke(handler, { body });
    assert.equal(res.statusCode, 400);
  }
  assert.equal(providerCallFrom(calls), undefined);
});

test('draft requests containing any selectedText field are rejected', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { body: { action: 'draft', prompt: 'Write a note.', selectedText: 'existing text' } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.error, 'DRAFT_MUST_NOT_INCLUDE_SELECTION');
  const withDocumentText = await invoke(handler, { body: { action: 'draft', prompt: 'Write a note.', documentText: 'existing document' } });
  assert.equal(withDocumentText.statusCode, 400);
  assert.equal(providerCallFrom(calls), undefined);
});

test('requires a valid existing COCCE Auth session before provider access', async () => {
  const { handler, calls } = makeHarness({ authStatus: 401 });
  const res = await invoke(handler, { body: { action: 'proofread', selectedText: 'Excerpt.' } });
  assert.equal(res.statusCode, 401);
  assert.equal(calls.length, 1);
  assert.equal(providerCallFrom(calls), undefined);
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

test('fails closed without OPENROUTER_API_KEY even when a legacy OPENAI_API_KEY exists', async () => {
  const { handler, calls } = makeHarness({ env: { OPENROUTER_API_KEY: '' } });
  const status = await invoke(handler, { method: 'GET' });
  assert.deepEqual(status.body, { configured: false });
  const res = await invoke(handler, { body: { action: 'summarize', selectedText: 'Excerpt.' } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'AI_NOT_CONFIGURED');
  assert.equal(providerCallFrom(calls), undefined);
});

test('enforces excerpt, prompt, and request-size limits', async () => {
  const { handler, calls } = makeHarness();
  const longSelection = await invoke(handler, { body: { action: 'summarize', selectedText: 'x'.repeat(8_001) } });
  assert.equal(longSelection.statusCode, 400);
  const longPrompt = await invoke(handler, { body: { action: 'draft', prompt: 'x'.repeat(1_201) } });
  assert.equal(longPrompt.statusCode, 400);
  const hugeBody = await invoke(handler, { body: { action: 'summarize', selectedText: 'x'.repeat(40_001) } });
  assert.equal(hugeBody.statusCode, 413);
  const longDocument = await invoke(handler, { body: { action: 'document_summary', documentText: 'x'.repeat(20_001) } });
  assert.equal(longDocument.statusCode, 413);
  assert.equal(longDocument.body.error, 'DOCUMENT_TOO_LARGE');
  const multibyteDocument = await invoke(handler, { body: { action: 'document_summary', documentText: '😀'.repeat(10_000) } });
  assert.equal(multibyteDocument.statusCode, 413);
  assert.equal(multibyteDocument.body.error, 'DOCUMENT_TOO_LARGE');
  assert.equal(providerCallFrom(calls), undefined);
});

test('accepts a bounded multibyte synthetic full document and preserves the exact text', async () => {
  const { handler, calls } = makeHarness();
  const syntheticText = 'é'.repeat(10_000);
  const res = await invoke(handler, { body: { action: 'document_summary', documentText: syntheticText } });
  assert.equal(res.statusCode, 200);
  const userContent = JSON.parse(JSON.parse(providerCallFrom(calls).init.body).messages[1].content);
  assert.equal(userContent.documentText, syntheticText);
});

test('accepts exactly 38,000 serialized bytes and rejects the next byte before Auth', async () => {
  const emptyPayload = JSON.stringify({ action: 'document_summary', documentText: '' });
  const remainingBytes = 38_000 - Buffer.byteLength(emptyPayload, 'utf8');
  const cjkCharacters = Math.floor(remainingBytes / 3);
  const asciiRemainder = remainingBytes - cjkCharacters * 3;
  const documentText = '界'.repeat(cjkCharacters) + 'x'.repeat(asciiRemainder);
  const body = JSON.stringify({ action: 'document_summary', documentText });
  assert.equal(Buffer.byteLength(body, 'utf8'), 38_000);
  assert.ok(documentText.length <= 20_000);

  const { handler, calls } = makeHarness();
  const accepted = await invoke(handler, { body, contentLength: 38_000 });
  assert.equal(accepted.statusCode, 200);
  const callsAfterAccepted = calls.length;

  const oneByteTooLarge = JSON.stringify({ action: 'document_summary', documentText: `${documentText}x` });
  assert.equal(Buffer.byteLength(oneByteTooLarge, 'utf8'), 38_001);
  const rejected = await invoke(handler, { body: oneByteTooLarge, contentLength: 38_001 });
  assert.equal(rejected.statusCode, 413);
  assert.equal(rejected.body.error, 'DOCUMENT_TOO_LARGE');
  assert.equal(calls.length, callsAfterAccepted);
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
  const { handler, calls } = makeHarness({ maxRequests: 1, now: () => clock });
  const first = await invoke(handler, { body: { action: 'summarize', selectedText: 'Excerpt.' } });
  assert.equal(first.statusCode, 200);
  const callCount = calls.length;
  const limited = await invoke(handler, { body: { action: 'summarize', selectedText: 'Another excerpt.' } });
  assert.equal(limited.statusCode, 429);
  assert.equal(calls.length, callCount + 1);
  clock += 600_001;
  const afterWindow = await invoke(handler, { body: { action: 'summarize', selectedText: 'A later excerpt.' } });
  assert.equal(afterWindow.statusCode, 200);
});

test('free-model rate limits and missing free endpoints return a clear no-paid-fallback response', async () => {
  for (const providerStatus of [404, 429, 503]) {
    const { handler, calls } = makeHarness({
      providerStatus,
      providerError: { error: { type: 'rate_limit_error', code: 'rate_limit_exceeded', message: 'Private provider details and selected text.' } },
    });
    const res = await invoke(handler, { body: { action: 'summarize', selectedText: 'Synthetic excerpt.' } });
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.error, 'FREE_MODEL_UNAVAILABLE');
    assert.match(res.body.message, /temporarily unavailable or rate-limited/i);
    assert.match(res.body.message, /No paid model or alternate-provider fallback/i);
    assert.equal(providerCallFrom(calls) !== undefined, true);
    const request = JSON.parse(providerCallFrom(calls).init.body);
    assert.equal(request.model, FREE_MODEL_ID);
    assert.deepEqual(request.provider, { only: ['google-ai-studio'], allow_fallbacks: false });
    assert.equal(Object.hasOwn(request, 'models'), false);
    assert.equal(JSON.stringify(res.body).includes('Private provider details'), false);
  }
});

test('rejects any response not proven to be the fixed free model or reporting positive cost', async () => {
  const wrongModel = makeHarness({ returnedModel: 'google/gemma-4-31b-it' });
  const wrongModelResponse = await invoke(wrongModel.handler, { body: { action: 'summarize', selectedText: 'Excerpt.' } });
  assert.equal(wrongModelResponse.statusCode, 503);
  assert.equal(wrongModelResponse.body.error, 'FREE_MODEL_UNAVAILABLE');
  assert.equal(Object.hasOwn(wrongModelResponse.body, 'text'), false);

  const positiveCost = makeHarness({ reportedCost: 0.001 });
  const positiveCostResponse = await invoke(positiveCost.handler, { body: { action: 'summarize', selectedText: 'Excerpt.' } });
  assert.equal(positiveCostResponse.statusCode, 503);
  assert.equal(positiveCostResponse.body.error, 'FREE_MODEL_UNAVAILABLE');
  assert.equal(Object.hasOwn(positiveCostResponse.body, 'text'), false);
});

test('does not reveal upstream failures or provider error details', async () => {
  const logs = [];
  const { handler } = makeHarness({
    providerStatus: 401,
    providerError: { error: { type: 'invalid_request_error', code: 'invalid_api_key', message: 'Sensitive provider text with sk-or-v1-marker and the selected excerpt.' } },
    logger: { warn(event, details) { logs.push({ event, details }); } },
  });
  const res = await invoke(handler, { body: { action: 'proofread', selectedText: 'Excerpt.' } });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.error, 'AI_UPSTREAM_UNAVAILABLE');
  assert.equal(JSON.stringify(res.body).includes(OPENROUTER_TEST_KEY), false);
  assert.equal(JSON.stringify(res.body).includes('invalid_api_key'), false);
  assert.deepEqual(logs, [{ event: '[office-ai] provider failure', details: { status: 401, type: 'invalid_request_error', code: 'invalid_api_key' } }]);
  assert.equal(JSON.stringify(logs).includes(OPENROUTER_TEST_KEY), false);
  assert.equal(JSON.stringify(logs).includes(LEGACY_OPENAI_TEST_KEY), false);
  assert.equal(JSON.stringify(logs).includes('Excerpt.'), false);
  assert.equal(JSON.stringify(logs).includes('sk-or-v1-marker'), false);
  assert.equal(JSON.stringify(logs).includes('Sensitive provider text'), false);
});

test('unsupported HTTP methods are rejected without network access', async () => {
  const { handler, calls } = makeHarness();
  const res = await invoke(handler, { method: 'DELETE' });
  assert.equal(res.statusCode, 405);
  assert.equal(calls.length, 0);
});
