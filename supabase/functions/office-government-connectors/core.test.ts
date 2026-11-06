import { describe, expect, it } from 'vitest';
import { createOfficeGovernmentHandler } from './core';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherWorkspace = '99999999-9999-4999-8999-999999999999';
const actorId = '22222222-2222-4222-8222-222222222222';
const correspondenceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const attachmentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const fileId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const revisionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const attemptId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const idempotencyKey = '11111111-1111-4111-8111-111111111111';
const clientId = '33333333-3333-4333-8333-333333333333';
const graph = { provider: 'graph', tenantId: 'tenant.onmicrosoft.com', clientId, senderUpn: 'sender@example.gov', clientSecret: 'graph-secret' };
const cmis = { provider: 'cmis', serviceUrl: 'https://cmis.example.gov/service', repositoryId: 'repo', folderId: 'folder', authMode: 'bearer', bearerToken: 'bearer-secret' };
const env = { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'server-role-secret' }) };
const payload = new Uint8Array([1, 2, 3]);

function req(path: string, init: RequestInit = {}) {
  return new Request(`https://example.supabase.co/functions/v1/office-government-connectors${path}`, {
    ...init,
    headers: { Authorization: 'Bearer user-token', Origin: 'https://cocce-office.vercel.app', 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
}
function signedBunnyUrl() {
  const u = new URL(`https://de-s3.storage.bunnycdn.com/cocce-kyc/office/v1/workspaces/${workspaceId}/files/${fileId}/revisions/${revisionId}/payload`);
  for (const [key, value] of Object.entries({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'zone/scope', 'X-Amz-Date': '20261106T200000Z',
    'X-Amz-Expires': '600', 'X-Amz-SignedHeaders': 'host', 'X-Amz-Signature': 'a'.repeat(64),
    'response-content-type': 'application/pdf', 'response-content-disposition': 'attachment; filename="test.pdf"',
    'response-cache-control': 'private, no-store, max-age=0',
  })) u.searchParams.set(key, value);
  return u.href;
}
async function sha256Hex(bytes: Uint8Array) {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', copy)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

type Options = {
  profile?: Record<string, unknown> | null;
  configGraph?: boolean;
  configCmis?: boolean;
  providerFail?: boolean;
  onCall?: (url: URL, init?: RequestInit) => void;
};
function harness(options: Options = {}) {
  const calls: Array<{ url: URL; init?: RequestInit }> = [];
  const stores: Record<string, unknown>[] = [];
  let graphConfigured = options.configGraph !== false;
  let cmisConfigured = options.configCmis !== false;
  let outboundDone = false;
  let archiveDone = false;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    options.onCall?.(url, init);
    if (url.pathname === '/auth/v1/user') return new Response(JSON.stringify({ id: actorId }), { status: 200 });
    if (url.pathname.endsWith('/office_gov_access_profile')) {
      const profile = Object.prototype.hasOwnProperty.call(options, 'profile') ? options.profile : { is_admin: true, roles: ['records_manager', 'outbound_dispatcher'] };
      return new Response(JSON.stringify(profile), { status: 200 });
    }
    if (url.pathname.endsWith('/office_gov_connector_config_get')) {
      const request = JSON.parse(String(init?.body)) as { p_provider: string; p_workspace_id: string };
      const configured = request.p_provider === 'graph' ? graphConfigured : cmisConfigured;
      if (request.p_workspace_id !== workspaceId || !configured) return new Response(JSON.stringify({ provider: request.p_provider, state: 'unconfigured' }), { status: 200 });
      const result = request.p_provider === 'graph'
        ? { provider: 'graph', public_config: { tenantId: graph.tenantId, clientId: graph.clientId, senderUpn: graph.senderUpn }, secret_config: { clientSecret: graph.clientSecret }, state: 'healthy' }
        : { provider: 'cmis', public_config: { serviceUrl: cmis.serviceUrl, repositoryId: cmis.repositoryId, folderId: cmis.folderId, authMode: 'bearer' }, secret_config: { bearerToken: cmis.bearerToken }, state: 'healthy' };
      return new Response(JSON.stringify(result), { status: 200 });
    }
    if (url.pathname.endsWith('/office_gov_connector_config_status')) {
      const request = JSON.parse(String(init?.body)) as { p_workspace_id: string };
      const sameWorkspace = request.p_workspace_id === workspaceId;
      const graphReady = sameWorkspace && graphConfigured, cmisReady = sameWorkspace && cmisConfigured;
      return new Response(JSON.stringify({
        graph: { configured: graphReady, state: graphReady ? 'healthy' : 'not_configured', sender_configured: graphReady, last_tested_at: graphReady ? '2026-11-06T20:00:00Z' : null, error_code: null },
        cmis: { configured: cmisReady, state: cmisReady ? 'healthy' : 'not_configured', binding: cmisReady ? 'browser' : null, repository_configured: cmisReady, folder_configured: cmisReady, last_tested_at: cmisReady ? '2026-11-06T20:00:00Z' : null, error_code: null },
      }), { status: 200 });
    }
    if (url.pathname.endsWith('/office_gov_connector_config_store')) {
      const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
      stores.push(request);
      if (request.p_provider === 'graph') graphConfigured = true;
      if (request.p_provider === 'cmis') cmisConfigured = true;
      return new Response(JSON.stringify({ provider: request.p_provider, state: 'configured' }), { status: 200 });
    }
    if (url.pathname.endsWith('/office_gov_connector_config_test_update')) return new Response('true', { status: 200 });
    if (url.pathname.endsWith('/office_gov_connector_config_delete')) {
      const request = JSON.parse(String(init?.body)) as { p_provider: string };
      if (request.p_provider === 'graph') graphConfigured = false;
      if (request.p_provider === 'cmis') cmisConfigured = false;
      return new Response('true', { status: 200 });
    }
    if (url.hostname === 'login.microsoftonline.com') return options.providerFail ? new Response('{}', { status: 401 }) : new Response(JSON.stringify({ access_token: 'token-marker' }), { status: 200 });
    if (url.hostname === 'cmis.example.gov' && url.pathname === '/service/repo' && url.searchParams.get('cmisselector') === 'repositoryInfo') return new Response(JSON.stringify({ repositoryId: 'repo' }), { status: options.providerFail ? 401 : 200 });
    if (url.hostname === 'cmis.example.gov' && url.pathname === '/service/repo' && url.searchParams.get('cmisselector') === 'object') return new Response(JSON.stringify({ properties: { 'cmis:objectId': { value: 'folder' }, 'cmis:baseTypeId': { value: 'cmis:folder' } } }), { status: options.providerFail ? 401 : 200 });
    if (url.hostname === 'graph.microsoft.com') return new Response(null, { status: 202 });
    if (url.pathname === '/functions/v1/office-cloud-files') return new Response(JSON.stringify({ url: signedBunnyUrl() }), { status: 200 });
    if (url.hostname === 'de-s3.storage.bunnycdn.com') return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } });
    if (url.hostname === 'cmis.example.gov' && url.pathname === '/service' && init?.method === 'POST') return new Response(JSON.stringify({ properties: { 'cmis:objectId': { value: 'cmis-object-1' } } }), { status: 201 });
    if (url.pathname.endsWith('/office_gov_outbound_begin')) {
      if (outboundDone) return new Response(JSON.stringify({ attempt_id: attemptId, status: 'accepted' }), { status: 200 });
      return new Response(JSON.stringify({ attempt_id: attemptId, status: 'sending', attachments: [] }), { status: 200 });
    }
    if (url.pathname.endsWith('/office_gov_outbound_finish')) {
      const request = JSON.parse(String(init?.body)) as { p_status: string };
      if (request.p_status === 'accepted') outboundDone = true;
      return new Response(JSON.stringify({ attempt_id: attemptId, status: request.p_status, delivery_verified: false }), { status: 200 });
    }
    if (url.pathname.endsWith('/office_gov_archive_begin')) {
      if (archiveDone) return new Response(JSON.stringify({ attempt_id: attemptId, status: 'archived', provider_object_id: 'cmis-object-1' }), { status: 200 });
      return new Response(JSON.stringify({ attempt_id: attemptId, status: 'started', attachment_id: attachmentId, file_id: fileId, revision_id: revisionId, display_name: 'test.pdf', size_bytes: payload.length, sha256_hex: await sha256Hex(payload) }), { status: 200 });
    }
    if (url.pathname.endsWith('/office_gov_archive_finish')) {
      const request = JSON.parse(String(init?.body)) as { p_status: string };
      if (request.p_status === 'archived') archiveDone = true;
      return new Response(JSON.stringify({ attempt_id: attemptId, status: request.p_status, provider_object_id: 'cmis-object-1' }), { status: 200 });
    }
    throw new Error(`Unexpected mocked request: ${url.hostname}${url.pathname}${url.search}`);
  }) as typeof fetch;
  return { handler: createOfficeGovernmentHandler({ env, fetchImpl }), calls, stores };
}

describe('office government connectors', () => {
  it('requires an Office administrator for setup and stores only after a successful Graph token probe', async () => {
    const denied = harness({ profile: { is_admin: false, roles: ['outbound_dispatcher'] } });
    const deniedResponse = await denied.handler(req('/connections/graph/test-and-save', { method: 'POST', body: JSON.stringify({ workspaceId, tenantId: graph.tenantId, clientId, clientSecret: graph.clientSecret, senderUpn: graph.senderUpn }) }));
    expect(deniedResponse.status).toBe(403);
    expect(denied.calls.some(({ url }) => url.hostname === 'login.microsoftonline.com')).toBe(false);

    const failed = harness({ providerFail: true });
    const failedResponse = await failed.handler(req('/connections/graph/test-and-save', { method: 'POST', body: JSON.stringify({ workspaceId, tenantId: graph.tenantId, clientId, clientSecret: graph.clientSecret, senderUpn: graph.senderUpn }) }));
    expect(failedResponse.status).toBe(502);
    expect(failed.stores).toHaveLength(0);

    const success = harness();
    const response = await success.handler(req('/connections/graph/test-and-save', { method: 'POST', body: JSON.stringify({ workspaceId, tenantId: graph.tenantId, clientId, clientSecret: graph.clientSecret, senderUpn: graph.senderUpn }) }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.graph.state).toBe('ready');
    expect(JSON.stringify(result)).not.toContain(graph.clientSecret);
    expect(success.stores[0]).toMatchObject({ p_provider: 'graph', p_actor_user_id: actorId, p_secret: { clientSecret: graph.clientSecret } });
  });

  it('tests CMIS Browser Binding read-only, stores its secret in the server RPC, and rejects local/IP endpoints', async () => {
    let createCalls = 0;
    const success = harness({ onCall: (url, init) => { if (url.hostname === 'cmis.example.gov' && init?.method === 'POST') createCalls++; } });
    const response = await success.handler(req('/connections/cmis/test-and-save', { method: 'POST', body: JSON.stringify({ workspaceId, serviceUrl: cmis.serviceUrl, repositoryId: cmis.repositoryId, folderId: cmis.folderId, authMode: 'bearer', bearerToken: cmis.bearerToken, username: '', password: '' }) }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.cmis.state).toBe('ready');
    expect(createCalls).toBe(0);
    expect(success.stores[0]).toMatchObject({ p_provider: 'cmis', p_secret: { bearerToken: cmis.bearerToken }, p_actor_user_id: actorId });
    expect(JSON.stringify(result)).not.toContain(cmis.bearerToken);

    const blocked = harness();
    const bad = await blocked.handler(req('/connections/cmis/test-and-save', { method: 'POST', body: JSON.stringify({ workspaceId, serviceUrl: 'https://127.0.0.1/service', repositoryId: 'repo', folderId: 'folder', authMode: 'bearer', bearerToken: 'secret', username: '', password: '' }) }));
    expect(bad.status).toBe(400);
    expect(blocked.calls.some(({ url }) => url.hostname === '127.0.0.1')).toBe(false);
  });

  it('lets ordinary members read safe status while only administrators can actively test providers', async () => {
    const member = harness({ profile: { is_admin: false, roles: [] } });
    const response = await member.handler(req(`/status?workspaceId=${workspaceId}`, { method: 'GET' }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.graph.state).toBe('ready');
    expect(result.cmis.binding).toBe('browser');
    expect(JSON.stringify(result)).not.toMatch(/graph-secret|bearer-secret|token-marker|server-role-secret|password|tenantId|serviceUrl/i);
    expect(member.calls.some(({ url }) => url.hostname === 'login.microsoftonline.com' || url.hostname === 'cmis.example.gov')).toBe(false);
    const blockedCheck = await member.handler(req('/connections/check', { method: 'POST', body: JSON.stringify({ workspaceId }) }));
    expect(blockedCheck.status).toBe(403);

    const denied = harness({ profile: null });
    expect((await denied.handler(req(`/status?workspaceId=${workspaceId}`, { method: 'GET' }))).status).toBe(403);

    const admin = harness();
    const checked = await admin.handler(req('/connections/check', { method: 'POST', body: JSON.stringify({ workspaceId }) }));
    expect(checked.status).toBe(200);
    expect((await checked.json()).graph.state).toBe('ready');
    expect(admin.calls.some(({ url }) => url.hostname === 'login.microsoftonline.com')).toBe(true);
    expect(admin.calls.some(({ url }) => url.pathname.endsWith('/office_gov_connector_config_test_update'))).toBe(true);

    const other = harness();
    const otherResult = await other.handler(req(`/status?workspaceId=${otherWorkspace}`, { method: 'GET' }));
    expect((await otherResult.json()).graph.state).toBe('not_configured');
  });

  it('does not call providers or begin RPCs when either workspace connector is unconfigured', async () => {
    const x = harness({ configGraph: false, configCmis: false });
    const send = await x.handler(req('/outbound/send', { method: 'POST', body: JSON.stringify({ workspaceId, correspondenceId, expectedRecordVersion: 1, recipient: 'unit@example.gov', subject: 'Notice', body: 'Text', attachmentIds: [], idempotencyKey, nonSensitiveConfirmed: true }) }));
    const archive = await x.handler(req('/archive/file', { method: 'POST', body: JSON.stringify({ workspaceId, attachmentId, idempotencyKey }) }));
    expect(send.status).toBe(503);
    expect(archive.status).toBe(503);
    expect(x.calls.some(({ url }) => url.hostname === 'login.microsoftonline.com' || url.hostname === 'graph.microsoft.com' || url.hostname === 'cmis.example.gov' || url.pathname.endsWith('_begin'))).toBe(false);
  });

  it('tests Graph auth before opening the idempotent send attempt and never sends mail during setup', async () => {
    let mailCalls = 0, beginCalls = 0;
    const x = harness({ onCall: (url) => { if (url.hostname === 'graph.microsoft.com') mailCalls++; if (url.pathname.endsWith('/office_gov_outbound_begin')) beginCalls++; } });
    const setup = await x.handler(req('/connections/graph/test-and-save', { method: 'POST', body: JSON.stringify({ workspaceId, tenantId: graph.tenantId, clientId, clientSecret: graph.clientSecret, senderUpn: graph.senderUpn }) }));
    expect(setup.status).toBe(200);
    expect(mailCalls).toBe(0);
    const send = await x.handler(req('/outbound/send', { method: 'POST', body: JSON.stringify({ workspaceId, correspondenceId, expectedRecordVersion: 1, recipient: 'unit@example.gov', subject: 'Notice', body: 'Non-sensitive text', attachmentIds: [], idempotencyKey, nonSensitiveConfirmed: true }) }));
    expect(send.status).toBe(200);
    expect(await send.json()).toMatchObject({ status: 'accepted', attemptId, deliveryVerified: false, httpStatus: 202 });
    expect(beginCalls).toBe(1);
    expect(mailCalls).toBe(1);
    const replay = await x.handler(req('/outbound/send', { method: 'POST', body: JSON.stringify({ workspaceId, correspondenceId, expectedRecordVersion: 1, recipient: 'unit@example.gov', subject: 'Notice', body: 'Non-sensitive text', attachmentIds: [], idempotencyKey, nonSensitiveConfirmed: true }) }));
    expect(replay.status).toBe(200);
    expect((await replay.json()).status).toBe('accepted');
    expect(mailCalls).toBe(1);
  });

  it('archives a verified Bunny revision through CMIS once and preserves idempotent replay', async () => {
    let downloads = 0, creates = 0;
    const x = harness({ onCall: (url, init) => { if (url.hostname === 'de-s3.storage.bunnycdn.com') downloads++; if (url.hostname === 'cmis.example.gov' && init?.method === 'POST') creates++; } });
    const first = await x.handler(req('/archive/file', { method: 'POST', body: JSON.stringify({ workspaceId, attachmentId, idempotencyKey }) }));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ status: 'archived', attemptId, providerObjectId: 'cmis-object-1' });
    const replay = await x.handler(req('/archive/file', { method: 'POST', body: JSON.stringify({ workspaceId, attachmentId, idempotencyKey }) }));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ status: 'archived', providerObjectId: 'cmis-object-1' });
    expect(downloads).toBe(1);
    expect(creates).toBe(1);
  });

  it('does not reflect arbitrary CORS origins and always disables caching/referrers', async () => {
    const x = harness();
    const allowed = await x.handler(new Request('https://example.supabase.co/functions/v1/office-government-connectors/status', { method: 'OPTIONS', headers: { Origin: 'https://cocce-office.vercel.app' } }));
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://cocce-office.vercel.app');
    expect(allowed.headers.get('cache-control')).toBe('no-store');
    expect(allowed.headers.get('referrer-policy')).toBe('no-referrer');
    const denied = await x.handler(new Request('https://example.supabase.co/functions/v1/office-government-connectors/status', { method: 'OPTIONS', headers: { Origin: 'https://evil.invalid' } }));
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();
  });
});
