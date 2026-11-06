import { describe, expect, it } from 'vitest';
import { createOfficeGovernmentHandler } from './core';

const base = {
  SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'anon',
  OFFICE_GOV_GRAPH_TENANT_ID: 'tenant', OFFICE_GOV_GRAPH_CLIENT_ID: 'client', OFFICE_GOV_GRAPH_CLIENT_SECRET: 'graph-secret', OFFICE_GOV_GRAPH_SENDER_UPN: 'sender@example.gov',
  OFFICE_GOV_CMIS_SERVICE_URL: 'https://cmis.example.gov/service', OFFICE_GOV_CMIS_REPOSITORY_ID: 'repo', OFFICE_GOV_CMIS_FOLDER_ID: 'folder', OFFICE_GOV_CMIS_BEARER_TOKEN: 'cmis-secret',
};
const token = 'user-token';
const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const correspondenceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const attachmentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const fileId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const revisionId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const attemptId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const key = '11111111-1111-4111-8111-111111111111';
function req(path: string, init: RequestInit = {}) { return new Request(`https://example.supabase.co/functions/v1/office-government-connectors${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, Origin: 'https://cocce-office.vercel.app', ...(init.headers || {}) } }); }
function fakeFetch(userOk = true, profile: unknown = { is_admin: false, roles: ['records_manager'] }): typeof fetch { return (async (input: RequestInfo | URL) => { const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); if (u.pathname === '/auth/v1/user') return new Response(userOk ? '{}' : 'no', { status: userOk ? 200 : 401 }); if (u.pathname.endsWith('/office_gov_access_profile')) return new Response(JSON.stringify(profile), { status: 200 }); throw new Error('unexpected provider call'); }) as typeof fetch; }
async function sha256Hex(bytes: Uint8Array) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join(''); }
function signedBunnyUrl() {
  const u = new URL(`https://de-s3.storage.bunnycdn.com/cocce-kyc/office/v1/workspaces/${workspaceId}/files/${fileId}/revisions/${revisionId}/payload`);
  for (const [k, v] of Object.entries({
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': 'zone/scope', 'X-Amz-Date': '20261106T200000Z',
    'X-Amz-Expires': '600', 'X-Amz-SignedHeaders': 'host', 'X-Amz-Signature': 'a'.repeat(64),
    'response-content-type': 'application/pdf', 'response-content-disposition': 'attachment; filename="test.pdf"',
    'response-cache-control': 'private, no-store, max-age=0',
  })) u.searchParams.set(k, v);
  return u.href;
}

describe('office government connectors', () => {
  it('requires auth before status and exposes only safe booleans', async () => {
    const h = createOfficeGovernmentHandler({ env: base, fetchImpl: fakeFetch() });
    const r = await h(req(`/status?workspaceId=${workspaceId}`, { method: 'GET' }));
    expect(r.status).toBe(200); expect(await r.json()).toEqual({ graph: { configured: true, senderConfigured: true }, cmis: { configured: true, repositoryConfigured: true, folderConfigured: true } });
    const denied = await createOfficeGovernmentHandler({ env: base, fetchImpl: fakeFetch(false) })(req(`/status?workspaceId=${workspaceId}`, { method: 'GET' }));
    expect(denied.status).toBe(401);
  });

  it('denies status for an unauthorized workspace profile and invalid workspace IDs', async () => {
    const unauthorized = await createOfficeGovernmentHandler({ env: base, fetchImpl: fakeFetch(true, { is_admin: false, roles: [] }) })(req(`/status?workspaceId=${workspaceId}`, { method: 'GET' }));
    expect(unauthorized.status).toBe(403);
    const invalid = await createOfficeGovernmentHandler({ env: base, fetchImpl: fakeFetch() })(req('/status', { method: 'GET' }));
    expect(invalid.status).toBe(400);
  });

  it('reports partial Graph and CMIS setup independently', async () => {
    const partial = { ...base, OFFICE_GOV_GRAPH_CLIENT_SECRET: '', OFFICE_GOV_CMIS_FOLDER_ID: '' };
    const h = createOfficeGovernmentHandler({ env: partial, fetchImpl: fakeFetch() });
    const r = await h(req(`/status?workspaceId=${workspaceId}`, { method: 'GET' }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ graph: { configured: false, senderConfigured: true }, cmis: { configured: true, repositoryConfigured: true, folderConfigured: false } });
  });

  it('returns actionable 503 when configuration is absent and never calls downstream', async () => {
    let calls = 0; const f = (async () => { calls++; throw new Error('must not call'); }) as typeof fetch;
    const r = await createOfficeGovernmentHandler({ env: {}, fetchImpl: f })(req('/outbound/send', { method: 'POST', body: '{}' }));
    expect(r.status).toBe(503); expect((await r.json()).error).toBe('GOVERNMENT_CONNECTOR_NOT_CONFIGURED'); expect(calls).toBe(0);
  });

  it('rejects non-sensitive confirmation, unknown fields, and malformed requests', async () => {
    const h = createOfficeGovernmentHandler({ env: base, fetchImpl: fakeFetch() });
    const r = await h(req('/outbound/send', { method: 'POST', body: JSON.stringify({ workspaceId: 'bad', extra: true }) }));
    expect(r.status).toBe(400); expect((await r.json()).error).toBe('INVALID_REQUEST');
  });

  it('sends once through mocked Graph and records acceptance without claiming delivery', async () => {
    const calls: string[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      calls.push(`${init?.method || 'GET'} ${u.hostname}${u.pathname}`);
      if (u.pathname === '/auth/v1/user') return new Response('{}', { status: 200 });
      if (u.pathname.endsWith('/office_gov_outbound_begin')) return new Response(JSON.stringify({ attempt_id: attemptId, status: 'sending', attachments: [] }), { status: 200 });
      if (u.hostname === 'login.microsoftonline.com') return new Response(JSON.stringify({ access_token: 'mock-token' }), { status: 200 });
      if (u.hostname === 'graph.microsoft.com') return new Response(null, { status: 202 });
      if (u.pathname.endsWith('/office_gov_outbound_finish')) return new Response(JSON.stringify({ attempt_id: attemptId, status: 'accepted', delivery_verified: false, record_version: 3 }), { status: 200 });
      throw new Error(`unexpected fetch ${u.href}`);
    }) as typeof fetch;
    const h = createOfficeGovernmentHandler({ env: base, fetchImpl: f });
    const r = await h(req('/outbound/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workspaceId, correspondenceId, expectedRecordVersion: 2, recipient: 'unit@example.gov', subject: 'Notice', body: 'Non-sensitive notice', attachmentIds: [], idempotencyKey: key, nonSensitiveConfirmed: true }) }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: 'accepted', attemptId, deliveryVerified: false, httpStatus: 202 });
    expect(calls.filter((call) => call.startsWith('POST graph.microsoft.com'))).toHaveLength(1);
  });

  it('marks a replayed in-progress outbound send unknown and never repeats Graph', async () => {
    let graphCalls = 0; let finishStatus = '';
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (u.pathname === '/auth/v1/user') return new Response('{}', { status: 200 });
      if (u.pathname.endsWith('/office_gov_outbound_begin')) return new Response(JSON.stringify({ attempt_id: attemptId, status: 'sending' }), { status: 200 });
      if (u.pathname.endsWith('/office_gov_outbound_finish')) { finishStatus = JSON.parse(String(init?.body)).p_status; return new Response('{}', { status: 200 }); }
      if (u.hostname === 'graph.microsoft.com') graphCalls++;
      throw new Error('unexpected provider call');
    }) as typeof fetch;
    const h = createOfficeGovernmentHandler({ env: base, fetchImpl: f });
    const r = await h(req('/outbound/send', { method: 'POST', body: JSON.stringify({ workspaceId, correspondenceId, expectedRecordVersion: 2, recipient: 'unit@example.gov', subject: 'Notice', body: 'Non-sensitive notice', attachmentIds: [], idempotencyKey: key, nonSensitiveConfirmed: true }) }));
    expect(r.status).toBe(200); expect((await r.json()).status).toBe('unknown');
    expect(finishStatus).toBe('unknown'); expect(graphCalls).toBe(0);
  });

  it('archives only verified pinned Bunny bytes using CMIS Browser Binding and preserves result', async () => {
    const bytes = new Uint8Array([1, 2, 3]); const digest = await sha256Hex(bytes); let archiveStatus = 'started'; let downloads = 0; let creates = 0;
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (u.pathname === '/auth/v1/user') return new Response('{}', { status: 200 });
      if (u.pathname.endsWith('/office_gov_archive_begin')) {
        const result = archiveStatus === 'started'
          ? { attempt_id: attemptId, status: 'started', attachment_id: attachmentId, file_id: fileId, revision_id: revisionId, display_name: 'notice.pdf', size_bytes: 3, sha256_hex: digest }
          : { attempt_id: attemptId, status: archiveStatus, provider_object_id: 'cmis-object-1' };
        return new Response(JSON.stringify(result), { status: 200 });
      }
      if (u.pathname === '/functions/v1/office-cloud-files') return new Response(JSON.stringify({ url: signedBunnyUrl() }), { status: 200 });
      if (u.hostname === 'de-s3.storage.bunnycdn.com') { downloads++; return new Response(bytes, { status: 200, headers: { 'content-length': '3' } }); }
      if (u.hostname === 'cmis.example.gov' && u.pathname === '/service/repo') return new Response('{}', { status: 200 });
      if (u.hostname === 'cmis.example.gov' && u.pathname === '/service' && init?.method === 'POST') { creates++; expect(init.body).toBeInstanceOf(FormData); archiveStatus = 'archived'; return new Response(JSON.stringify({ properties: { 'cmis:objectId': { value: 'cmis-object-1' } } }), { status: 201 }); }
      if (u.pathname.endsWith('/office_gov_archive_finish')) return new Response(JSON.stringify({ attempt_id: attemptId, status: 'archived', provider_object_id: 'cmis-object-1' }), { status: 200 });
      throw new Error(`unexpected fetch ${u.href}`);
    }) as typeof fetch;
    const h = createOfficeGovernmentHandler({ env: base, fetchImpl: f });
    const payload = { workspaceId, attachmentId, idempotencyKey: key };
    const first = await h(req('/archive/file', { method: 'POST', body: JSON.stringify(payload) }));
    expect(first.status).toBe(200); expect((await first.json()).status).toBe('archived');
    const second = await h(req('/archive/file', { method: 'POST', body: JSON.stringify(payload) }));
    expect(second.status).toBe(200); expect((await second.json()).providerObjectId).toBe('cmis-object-1');
    expect(downloads).toBe(1); expect(creates).toBe(1);
  });

  it('handles CORS preflight without reflecting an arbitrary origin', async () => {
    const h = createOfficeGovernmentHandler({ env: base, fetchImpl: fakeFetch() });
    const ok = await h(new Request('https://example.supabase.co/functions/v1/office-government-connectors/status', { method: 'OPTIONS', headers: { Origin: 'https://cocce-office.vercel.app' } }));
    expect(ok.status).toBe(204); expect(ok.headers.get('access-control-allow-origin')).toBe('https://cocce-office.vercel.app');
    const bad = await h(new Request('https://example.supabase.co/functions/v1/office-government-connectors/status', { method: 'OPTIONS', headers: { Origin: 'https://evil.invalid' } }));
    expect(bad.status).toBe(403); expect(bad.headers.get('access-control-allow-origin')).toBeNull();
  });
});
