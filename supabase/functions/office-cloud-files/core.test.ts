import { describe, expect, it } from 'vitest';
import {
  createOfficeCloudHandler,
  createPresignedS3Url,
  isOfficeObjectKey,
  MAX_FILE_BYTES,
  officeObjectKey,
} from './core';

const actorId = '11111111-1111-4111-8111-111111111111';
const workspaceId = '22222222-2222-4222-8222-222222222222';
const fileId = '33333333-3333-4333-8333-333333333333';
const revisionId = '44444444-4444-4444-8444-444444444444';
const sessionId = '55555555-5555-4555-8555-555555555555';
const idempotencyKey = '66666666-6666-4666-8666-666666666666';
const objectKey = officeObjectKey(workspaceId, fileId, revisionId);
const secretEnv = {
  SUPABASE_URL: 'https://nresyncmhdybucenhxbw.supabase.co',
  SUPABASE_ANON_KEY: 'synthetic-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service-role-token',
  CREATOR_BUNNY_KYC_STORAGE_ZONE: 'cocce-kyc',
  CREATOR_BUNNY_KYC_STORAGE_WRITE_PASSWORD: 'synthetic-bunny-secret-not-real',
};
const origin = 'https://cocce-office.vercel.app';
const token = 'synthetic-user-access-token';
const fixedNow = Date.parse('2026-11-04T11:00:00.000Z');

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

function request(action: Record<string, unknown>, extraHeaders: Record<string, string> = {}): Request {
  return new Request('https://nresyncmhdybucenhxbw.supabase.co/functions/v1/office-cloud-files', {
    method: 'POST',
    headers: {
      Origin: origin,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    body: JSON.stringify(action),
  });
}

function sessionRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    upload_session_id: sessionId,
    workspace_id: workspaceId,
    file_id: fileId,
    revision_id: revisionId,
    storage_location_id: 'bunny_cocce_kyc_de',
    object_key: objectKey,
    declared_content_type: 'application/pdf',
    expected_size_bytes: 13,
    expected_sha256_hex: '0'.repeat(64),
    status: 'pending',
    display_name: 'synthetic.pdf',
    created_by: actorId,
    expires_at: '2026-11-04T11:15:00.000Z',
    object_absent_first_seen_at: null,
    ...overrides,
  };
}

function fileLinkRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspace_id: workspaceId,
    file_id: fileId,
    revision_id: revisionId,
    storage_location_id: 'bunny_cocce_kyc_de',
    object_key: objectKey,
    display_name: 'synthetic.pdf',
    verified_content_type: 'application/octet-stream',
    verified_size_bytes: 13,
    ...overrides,
  };
}

type FetchCall = { url: string; init: RequestInit };
type Router = (url: URL, init: RequestInit, calls: FetchCall[]) => Response | Promise<Response>;

function routedFetch(router: Router): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const urlText = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(urlText);
    calls.push({ url: urlText, init });
    if (url.pathname === '/auth/v1/user') return Response.json({ id: actorId });
    return router(url, init, calls);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function rpcPayload(call: FetchCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

function authHeaders(call: FetchCall): Headers {
  return new Headers(call.init.headers);
}

describe('Office cloud Edge Function', () => {
  it('creates only a fixed-prefix upload URL with signed MIME and SHA-256 headers', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic');
    const checksum = await sha256Hex(bytes);
    const { fetchImpl, calls } = routedFetch((url) => {
      expect(url.pathname).toBe('/rest/v1/rpc/office_cloud_begin_upload');
      return Response.json(sessionRecord({ expected_size_bytes: bytes.length, expected_sha256_hex: checksum }));
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({
      action: 'begin_upload', workspaceId, idempotencyKey, displayName: 'synthetic.pdf',
      contentType: 'application/pdf', sizeBytes: bytes.length, sha256Hex: checksum,
    }));
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.status).toBe('upload_pending');
    expect(result.uploadUrlExpiresInSeconds).toBe(300);
    const url = new URL(result.uploadUrl);
    expect(url.origin).toBe('https://de-s3.storage.bunnycdn.com');
    expect(url.pathname).toBe(`/cocce-kyc/${objectKey}`);
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host;x-amz-checksum-sha256;x-amz-meta-office-session;x-amz-meta-office-sha256');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(result.requiredHeaders['Content-Type']).toBe('application/pdf');
    const expectedChecksum = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))));
    expect(result.requiredHeaders['x-amz-checksum-sha256']).toBe(expectedChecksum);
    expect(result.requiredHeaders['x-amz-meta-office-session']).toBe(sessionId);
    expect(result.requiredHeaders['x-amz-meta-office-sha256']).toBe(checksum);
    expect(result.requiredHeaders).not.toHaveProperty('Content-Length');
    expect(calls).toHaveLength(2);
    const payload = rpcPayload(calls[1]);
    expect(payload.p_actor_id).toBe(actorId);
    expect(payload.p_workspace_id).toBe(workspaceId);
    expect(payload.p_expected_size_bytes).toBe(bytes.length);
    expect(payload).not.toHaveProperty('p_object_key');
    expect(authHeaders(calls[1]).get('authorization')).toBe('Bearer synthetic-service-role-token');
    expect(JSON.stringify(result)).not.toContain('synthetic-bunny-secret-not-real');
    expect(JSON.stringify(result)).not.toContain('synthetic-service-role-token');
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('creates a conflict-bound revision grant for the exact file without transferring bytes', async () => {
    const bytes = new TextEncoder().encode('revision payload');
    const checksum = await sha256Hex(bytes);
    const baseRevisionId = '77777777-7777-4777-8777-777777777777';
    const { fetchImpl, calls } = routedFetch((url, init) => {
      expect(url.pathname).toBe('/rest/v1/rpc/office_cloud_begin_revision');
      expect(JSON.parse(String(init.body))).toEqual({
        p_actor_id: actorId, p_workspace_id: workspaceId, p_file_id: fileId,
        p_expected_revision_id: baseRevisionId, p_idempotency_key: idempotencyKey,
        p_expected_size_bytes: bytes.length, p_expected_sha256_hex: checksum,
      });
      return Response.json(sessionRecord({
        declared_content_type: 'application/octet-stream',
        expected_size_bytes: bytes.length, expected_sha256_hex: checksum,
        display_name: 'sync.cocce-docs.json',
      }));
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({
      action: 'begin_revision', workspaceId, fileId,
      expectedRevisionId: baseRevisionId, idempotencyKey,
      sizeBytes: bytes.length, sha256Hex: checksum,
    }));
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.status).toBe('upload_pending');
    expect(result.fileId).toBe(fileId);
    expect(result.revisionId).toBe(revisionId);
    expect(new URL(result.uploadUrl).pathname).toBe(`/cocce-kyc/${objectKey}`);
    expect(result.requiredHeaders['x-amz-meta-office-sha256']).toBe(checksum);
    expect(JSON.stringify(result)).not.toContain('objectKey');
    expect(JSON.stringify(result)).not.toContain('synthetic-bunny-secret-not-real');
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))).toBe(false);
  });

  it('caps the signed PUT URL to the fixed session expiry and refuses an expired begin-upload session', async () => {
    const soonExpiresAt = new Date(fixedNow + 30_000).toISOString();
    const { fetchImpl } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_begin_upload')) return Response.json(sessionRecord({ expires_at: soonExpiresAt }));
      throw new Error('Unexpected route');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({
      action: 'begin_upload', workspaceId, idempotencyKey, displayName: 'synthetic.pdf',
      contentType: 'application/pdf', sizeBytes: 13, sha256Hex: '0'.repeat(64),
    }));
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.uploadUrlExpiresInSeconds).toBe(30);
    expect(new URL(result.uploadUrl).searchParams.get('X-Amz-Expires')).toBe('30');

    const expired = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_begin_upload')) return Response.json(sessionRecord({ expires_at: new Date(fixedNow - 1_000).toISOString() }));
      throw new Error('Unexpected route');
    });
    const expiredHandler = createOfficeCloudHandler({ env: secretEnv, fetchImpl: expired.fetchImpl, now: () => fixedNow });
    const expiredResponse = await expiredHandler(request({
      action: 'begin_upload', workspaceId, idempotencyKey, displayName: 'synthetic.pdf',
      contentType: 'application/pdf', sizeBytes: 13, sha256Hex: '0'.repeat(64),
    }));
    expect(expiredResponse.status).toBe(409);
    expect(JSON.stringify(await expiredResponse.json())).not.toContain('uploadUrl');
  });

  it('authenticates with Supabase before any metadata or Bunny operation', async () => {
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url).pathname === '/auth/v1/user') return new Response('unauthorized', { status: 401 });
      throw new Error('Unexpected downstream call');
    }) as typeof fetch;
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'list_files', workspaceId }));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe('AUTHENTICATION_REQUIRED');
  });

  it('resolves an upload by exact workspace/idempotency keys and returns a distinct safe 404 when absent', async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      expect(url.pathname).toBe('/rest/v1/rpc/office_cloud_find_upload');
      return Response.json(null);
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'resolve_upload', workspaceId, idempotencyKey }));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: 'UPLOAD_LOOKUP_NOT_FOUND' });
    expect(calls).toHaveLength(2);
    expect(rpcPayload(calls[1])).toEqual({
      p_actor_id: actorId, p_workspace_id: workspaceId, p_idempotency_key: idempotencyKey,
    });
    expect(calls.some((call) => call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))).toBe(false);
  });

  it.each([
    ['pending', { status: 'recovery_required', sessionStatus: 'pending', workspaceId, fileId, uploadSessionId: sessionId, expiresAt: '2026-11-04T11:15:00.000Z' }],
    ['failed', { status: 'recovery_required', sessionStatus: 'failed', workspaceId, fileId, uploadSessionId: sessionId, expiresAt: '2026-11-04T11:15:00.000Z' }],
    ['expired', { status: 'recovery_required', sessionStatus: 'expired', workspaceId, fileId, uploadSessionId: sessionId, expiresAt: '2026-11-04T10:45:00.000Z' }],
    ['finalized', { status: 'finalized', workspaceId, fileId, uploadSessionId: sessionId }],
  ])('returns safe %s resolve metadata without URL/object credentials', async (status, expected) => {
    const { fetchImpl, calls } = routedFetch((url) => {
      expect(url.pathname).toBe('/rest/v1/rpc/office_cloud_find_upload');
      return Response.json(sessionRecord({ status, expires_at: status === 'expired' ? '2026-11-04T10:45:00.000Z' : '2026-11-04T11:15:00.000Z' }));
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'resolve_upload', workspaceId, idempotencyKey }));
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toMatch(/url|object|checksum|secret|credential|bunny/i);
    expect(calls).toHaveLength(2);
  });

  it('rejects unapproved origins and disallows other HTTP methods', async () => {
    const { fetchImpl, calls } = routedFetch(() => Response.json([]));
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const crossOrigin = await handler(new Request('https://example.invalid/office-cloud-files', {
      method: 'POST', headers: { Origin: 'https://evil.invalid', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
    }));
    expect(crossOrigin.status).toBe(403);
    const getResponse = await handler(new Request('https://nresyncmhdybucenhxbw.supabase.co/functions/v1/office-cloud-files', {
      method: 'GET', headers: { Origin: origin },
    }));
    expect(getResponse.status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it('answers production CORS preflight without reflecting arbitrary origins', async () => {
    const handler = createOfficeCloudHandler({ env: secretEnv, now: () => fixedNow });
    const response = await handler(new Request('https://nresyncmhdybucenhxbw.supabase.co/functions/v1/office-cloud-files', {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
    const rejected = await handler(new Request('https://nresyncmhdybucenhxbw.supabase.co/functions/v1/office-cloud-files', {
      method: 'OPTIONS', headers: { Origin: 'https://evil.invalid' },
    }));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('rejects client-supplied actor IDs, keys, unknown fields, and oversized files', async () => {
    const { fetchImpl, calls } = routedFetch(() => Response.json({}));
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const spoofed = await handler(request({ action: 'list_files', workspaceId, actorId }));
    expect(spoofed.status).toBe(400);
    const pathSpoof = await handler(request({ action: 'begin_upload', workspaceId, idempotencyKey, displayName: 'x', contentType: 'application/pdf', sizeBytes: 1, sha256Hex: '0'.repeat(64), objectKey }));
    expect(pathSpoof.status).toBe(400);
    const tooLarge = await handler(request({ action: 'begin_upload', workspaceId, idempotencyKey, displayName: 'large.pdf', contentType: 'application/pdf', sizeBytes: MAX_FILE_BYTES + 1, sha256Hex: '0'.repeat(64) }));
    expect(tooLarge.status).toBe(413);
    expect(calls.some((call) => call.url.includes('/rest/v1/rpc/') || call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))).toBe(false);
  });

  it('bounds and rejects oversized JSON request bodies', async () => {
    const { fetchImpl, calls } = routedFetch(() => Response.json([]));
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const oversized = new Request('https://nresyncmhdybucenhxbw.supabase.co/functions/v1/office-cloud-files', {
      method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'list_files', workspaceId, pad: 'x'.repeat(20_000) }),
    });
    const response = await handler(oversized);
    expect(response.status).toBe(400);
    expect(calls.some((call) => call.url.includes('/rest/v1/rpc/') || call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))).toBe(false);
  });

  it('rejects invalid server configuration rather than falling back to another zone or project', async () => {
    const { fetchImpl, calls } = routedFetch(() => Response.json({}));
    const handler = createOfficeCloudHandler({
      env: { ...secretEnv, CREATOR_BUNNY_KYC_STORAGE_ZONE: 'coccesuperapp' },
      fetchImpl,
      now: () => fixedNow,
    });
    const response = await handler(request({ action: 'list_files', workspaceId }));
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('finalizes after Bunny confirms the signed checksum/session metadata and exact object size without reading document bytes', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic fixture');
    const checksum = await sha256Hex(bytes);
    const { fetchImpl, calls } = routedFetch((url, init) => {
      if (url.pathname.endsWith('/office_cloud_get_upload')) return Response.json(sessionRecord({ expected_size_bytes: bytes.length, expected_sha256_hex: checksum }));
      if (url.hostname === 'de-s3.storage.bunnycdn.com') {
        expect(init.method).toBe('HEAD');
        return new Response(null, { headers: {
          'content-length': String(bytes.length),
          'x-amz-meta-office-sha256': checksum,
          'x-amz-meta-office-session': sessionId,
        } });
      }
      if (url.pathname.endsWith('/office_cloud_finalize_upload')) return Response.json({ status: 'finalized' });
      throw new Error(`Unexpected route ${url.pathname} ${String(init.method)}`);
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'finalize_upload', uploadSessionId: sessionId }));
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result).toMatchObject({ status: 'finalized', fileId, sizeBytes: bytes.length, verifiedContentType: 'application/octet-stream' });
    const verifyCall = calls.find((call) => call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))!;
    expect(new URL(verifyCall.url).searchParams.get('X-Amz-Expires')).toBe('60');
    expect(verifyCall.init.method).toBe('HEAD');
    expect(verifyCall.init.body).toBeUndefined();
    const finalizeCall = calls.find((call) => call.url.endsWith('/office_cloud_finalize_upload'))!;
    expect(rpcPayload(finalizeCall)).toMatchObject({
      p_actor_id: actorId, p_upload_session_id: sessionId,
      p_actual_size_bytes: bytes.length, p_actual_sha256_hex: checksum,
      p_verified_content_type: 'application/octet-stream',
    });
    expect(JSON.stringify(result)).not.toContain('X-Amz-Signature');
  });

  it('rejects late finalization before requesting Bunny object metadata', async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_get_upload')) return Response.json(sessionRecord({ expires_at: new Date(fixedNow - 1_000).toISOString() }));
      throw new Error('Expired sessions must not access Bunny');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'finalize_upload', uploadSessionId: sessionId }));
    expect(response.status).toBe(409);
    expect(calls.some((call) => call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))).toBe(false);
  });

  it('recovers an expired completed upload using HEAD metadata only', async () => {
    const bytes = new TextEncoder().encode('synthetic recovered file');
    const checksum = await sha256Hex(bytes);
    const { fetchImpl, calls } = routedFetch((url, init) => {
      if (url.pathname.endsWith('/office_cloud_get_upload')) return Response.json(sessionRecord({
        expected_size_bytes: bytes.length,
        expected_sha256_hex: checksum,
        expires_at: new Date(fixedNow - 60_000).toISOString(),
      }));
      if (url.hostname === 'de-s3.storage.bunnycdn.com') {
        expect(init.method).toBe('HEAD');
        return new Response(null, { headers: {
          'content-length': String(bytes.length),
          'x-amz-meta-office-sha256': checksum,
          'x-amz-meta-office-session': sessionId,
        } });
      }
      if (url.pathname.endsWith('/office_cloud_recover_upload')) return Response.json({ status: 'recovered' });
      throw new Error(`Unexpected recovery route ${url.pathname}`);
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'recover_upload', uploadSessionId: sessionId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'recovered', fileId, sizeBytes: bytes.length });
    const head = calls.find((call) => call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))!;
    expect(head.init.method).toBe('HEAD');
    expect(head.init.body).toBeUndefined();
    const recovery = calls.find((call) => call.url.endsWith('/office_cloud_recover_upload'))!;
    expect(rpcPayload(recovery)).toMatchObject({
      p_actor_id: actorId, p_upload_session_id: sessionId,
      p_actual_size_bytes: bytes.length, p_actual_sha256_hex: checksum,
      p_verified_content_type: 'application/octet-stream',
    });
    expect(calls.some((call) => call.init.method === 'GET' && call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))).toBe(false);
  });

  it('records the first provider 404 and holds the reservation for a 24-hour grace', async () => {
    const { fetchImpl, calls } = routedFetch((url, init) => {
      if (url.pathname.endsWith('/office_cloud_get_upload')) return Response.json(sessionRecord({
        expires_at: new Date(fixedNow - 60_000).toISOString(),
      }));
      if (url.hostname === 'de-s3.storage.bunnycdn.com') {
        expect(init.method).toBe('HEAD');
        return new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith('/office_cloud_note_object_absent')) return Response.json({
        status: 'reconciliation_pending',
        first_absent_at: new Date(fixedNow).toISOString(),
        release_eligible_at: new Date(fixedNow + 24 * 60 * 60 * 1000).toISOString(),
      });
      throw new Error(`Unexpected release route ${url.pathname}`);
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'recover_upload', uploadSessionId: sessionId }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      status: 'reconciliation_pending', fileId,
      releaseEligibleAt: new Date(fixedNow + 24 * 60 * 60 * 1000).toISOString(),
    });
    const note = calls.find((call) => call.url.endsWith('/office_cloud_note_object_absent'))!;
    expect(rpcPayload(note)).toEqual({ p_actor_id: actorId, p_upload_session_id: sessionId });
    expect(calls.some((call) => call.url.endsWith('/office_cloud_release_expired_upload'))).toBe(false);
  });

  it('releases only after the 24-hour absence grace and a fresh provider 404', async () => {
    const firstSeen = new Date(fixedNow - 25 * 60 * 60 * 1000).toISOString();
    const { fetchImpl, calls } = routedFetch((url, init) => {
      if (url.pathname.endsWith('/office_cloud_get_upload')) return Response.json(sessionRecord({
        status: 'expired',
        expires_at: new Date(fixedNow - 25 * 60 * 60 * 1000).toISOString(),
        object_absent_first_seen_at: firstSeen,
      }));
      if (url.hostname === 'de-s3.storage.bunnycdn.com') {
        expect(init.method).toBe('HEAD');
        return new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith('/office_cloud_release_expired_upload')) return Response.json({ status: 'reservation_released' });
      throw new Error(`Unexpected release route ${url.pathname}`);
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'recover_upload', uploadSessionId: sessionId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'reservation_released', fileId });
    const release = calls.find((call) => call.url.endsWith('/office_cloud_release_expired_upload'))!;
    expect(rpcPayload(release)).toEqual({ p_actor_id: actorId, p_upload_session_id: sessionId });
  });

  it('does not release a quota reservation when provider metadata is mismatched or unavailable', async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_get_upload')) return Response.json(sessionRecord({
        expires_at: new Date(fixedNow - 60_000).toISOString(),
      }));
      if (url.hostname === 'de-s3.storage.bunnycdn.com') return new Response(null, { headers: {
        'content-length': '13',
        'x-amz-meta-office-sha256': 'b'.repeat(64),
        'x-amz-meta-office-session': sessionId,
      } });
      throw new Error('A mismatched object must not be finalized or released');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'recover_upload', uploadSessionId: sessionId }));
    expect(response.status).toBe(422);
    expect(calls.some((call) => call.url.endsWith('/office_cloud_release_expired_upload'))).toBe(false);
    expect(calls.some((call) => call.url.endsWith('/office_cloud_recover_upload'))).toBe(false);
  });

  it('does not inspect or release a still-active pending upload during recovery', async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_get_upload')) return Response.json(sessionRecord());
      throw new Error('Active upload recovery must not access Bunny');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'recover_upload', uploadSessionId: sessionId }));
    expect(response.status).toBe(409);
    expect(calls.some((call) => call.url.endsWith('/office_cloud_release_expired_upload'))).toBe(false);
    expect(calls.some((call) => call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))).toBe(false);
  });

  it('returns safe byte-accurate quota usage with the 80/90/100 warning threshold', async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_get_usage')) return Response.json({
        workspace_id: workspaceId, tier_code: 'small_office',
        base_quota_bytes: '25000000000', purchased_quota_bytes: 0,
        quota_bytes: '25000000000', active_stored_bytes: 18_000_000_000,
        trash_bytes: 1_000_000_000, reserved_bytes: 1_000_000_000,
        total_consumed_bytes: 20_000_000_000, available_bytes: 5_000_000_000,
        usage_percent: 80, warning_at_percent: 80,
      });
      throw new Error('Unexpected usage route');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'get_usage', workspaceId }));
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.usage).toMatchObject({ tierCode: 'small_office', quotaBytes: 25_000_000_000, totalConsumedBytes: 20_000_000_000, warningAtPercent: 80 });
    expect(rpcPayload(calls.find((call) => call.url.endsWith('/office_cloud_get_usage'))!)).toEqual({ p_actor_id: actorId, p_workspace_id: workspaceId });
  });

  it('rejects quota usage returned for a different workspace', async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_get_usage')) return Response.json({
        workspace_id: fileId, tier_code: 'personal', base_quota_bytes: 5_000_000_000,
        purchased_quota_bytes: 0, quota_bytes: 5_000_000_000, active_stored_bytes: 0,
        trash_bytes: 0, reserved_bytes: 0, total_consumed_bytes: 0, available_bytes: 5_000_000_000,
        usage_percent: 0, warning_at_percent: 0,
      });
      throw new Error('Unexpected usage route');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'get_usage', workspaceId }));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(fileId);
    expect(calls.some((call) => call.url.endsWith('/office_cloud_get_usage'))).toBe(true);
  });

  it('lists only validated trash metadata and never queries Bunny objects', async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_list_trash')) return Response.json([
        { file_id: fileId, workspace_id: workspaceId, display_name: 'old.pdf', verified_size_bytes: '1200', deleted_at: '2026-11-04T10:00:00Z', created_at: '2026-11-03T10:00:00Z' },
        { file_id: revisionId, workspace_id: fileId, display_name: 'cross-tenant.pdf', verified_size_bytes: 99, deleted_at: '2026-11-04T10:00:00Z', created_at: '2026-11-03T10:00:00Z' },
        { file_id: sessionId, workspace_id: workspaceId, display_name: '../bad.pdf', verified_size_bytes: 10, deleted_at: '2026-11-04T10:00:00Z', created_at: '2026-11-03T10:00:00Z' },
      ]);
      throw new Error('Trash listing must not contact Bunny');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'list_trash', workspaceId }));
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ fileId, workspaceId, displayName: 'old.pdf', sizeBytes: 1200 });
    expect(calls.some((call) => call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))).toBe(false);
  });

  it.each([13, '13'])('lists verified files with a safe numeric byte count from %s', async (size) => {
    const { fetchImpl, calls } = routedFetch((url) => {
      expect(url.pathname).toBe('/rest/v1/rpc/office_cloud_list_files');
      return Response.json([{
        file_id: fileId, workspace_id: workspaceId, display_name: 'synthetic.txt',
        verified_content_type: 'application/octet-stream', verified_size_bytes: size,
        verified_sha256_hex: 'a'.repeat(64), created_at: '2026-11-04T10:00:00Z',
      }]);
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'list_files', workspaceId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ files: [{
      fileId, workspaceId, displayName: 'synthetic.txt', contentType: 'application/octet-stream',
      sizeBytes: 13, sha256Hex: 'a'.repeat(64), createdAt: '2026-11-04T10:00:00Z',
    }] });
    expect(calls).toHaveLength(2);
  });

  it('filters malformed listing sizes and foreign workspace rows without querying Bunny', async () => {
    const valid = {
      file_id: fileId, workspace_id: workspaceId, display_name: 'synthetic.txt',
      verified_content_type: 'application/octet-stream', verified_size_bytes: 13,
      verified_sha256_hex: 'a'.repeat(64), created_at: '2026-11-04T10:00:00Z',
    };
    const invalidSizes = [null, -1, 0, MAX_FILE_BYTES + 1, '-1', '13.0', '1e2', '9007199254740993', 'NaN'];
    const { fetchImpl, calls } = routedFetch((url) => {
      expect(url.pathname).toBe('/rest/v1/rpc/office_cloud_list_files');
      return Response.json([
        ...invalidSizes.map((size) => ({ ...valid, verified_size_bytes: size })),
        { ...valid, workspace_id: fileId }, { ...valid, display_name: '../bad.txt' }, valid,
      ]);
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'list_files', workspaceId }));
    expect(response.status).toBe(200);
    expect((await response.json()).files).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('returns only authorized sync metadata and never signs or exposes the object key', async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      expect(url.pathname).toBe('/rest/v1/rpc/office_cloud_get_sync_state');
      return Response.json({
        file_id: fileId, workspace_id: workspaceId,
        display_name: 'sync.cocce-docs.json', current_revision_id: revisionId,
        revision_number: 4, verified_size_bytes: 123,
        verified_sha256_hex: 'a'.repeat(64), updated_at: '2026-11-04T10:00:00Z',
        object_key: objectKey,
      });
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'get_sync_state', fileId }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toEqual({ syncState: {
      fileId, workspaceId, displayName: 'sync.cocce-docs.json',
      currentRevisionId: revisionId, revisionNumber: 4, sizeBytes: 123,
      sha256Hex: 'a'.repeat(64), updatedAt: '2026-11-04T10:00:00Z',
    } });
    const rpc = calls.find((call) => call.url.endsWith('/office_cloud_get_sync_state'))!;
    expect(rpcPayload(rpc)).toEqual({ p_actor_id: actorId, p_file_id: fileId });
    expect(JSON.stringify(result)).not.toContain(objectKey);
    expect(calls.some((call) => call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))).toBe(false);
  });

  it.each([
    ['trash_file', 'office_cloud_trash_file', 'trashed'],
    ['restore_file', 'office_cloud_restore_file', 'restored'],
  ])('%s uses the Office RPC only and does not physically delete or fetch the Bunny object', async (action, rpcName, status) => {
    const { fetchImpl, calls } = routedFetch((url) => {
      if (url.pathname.endsWith(`/${rpcName}`)) return Response.json({ status });
      throw new Error('Trash/restore must not access Bunny');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action, fileId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status, fileId });
    expect(rpcPayload(calls.find((call) => call.url.endsWith(`/${rpcName}`))!)).toEqual({ p_actor_id: actorId, p_file_id: fileId });
    expect(calls.some((call) => call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))).toBe(false);
  });

  it('does not expose a free tier-upgrade or coin-debit route before the atomic wallet integration is approved', async () => {
    const { fetchImpl, calls } = routedFetch(() => {
      throw new Error('No database action is allowed for unsupported purchase routes');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'set_workspace_tier', workspaceId, tierCode: 'enterprise' }));
    expect(response.status).toBe(400);
    expect(calls.some((call) => call.url.includes('/rest/v1/rpc/'))).toBe(false);
  });

  it('marks a wrong Bunny size/checksum/session metadata result failed without downloading content', async () => {
    const actual = new TextEncoder().encode('synthetic bytes');
    const { fetchImpl, calls } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_get_upload')) return Response.json(sessionRecord({ expected_size_bytes: actual.length, expected_sha256_hex: 'a'.repeat(64) }));
      if (url.hostname === 'de-s3.storage.bunnycdn.com') return new Response(null, { headers: {
        'content-length': String(actual.length),
        'x-amz-meta-office-sha256': 'b'.repeat(64),
        'x-amz-meta-office-session': sessionId,
      } });
      if (url.pathname.endsWith('/office_cloud_fail_upload')) return Response.json({ status: 'failed' });
      throw new Error(`Unexpected route ${url.pathname}`);
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'finalize_upload', uploadSessionId: sessionId }));
    expect(response.status).toBe(422);
    expect((await response.json()).error).toBe('INTEGRITY_MISMATCH');
    expect(calls.some((call) => call.url.endsWith('/office_cloud_finalize_upload'))).toBe(false);
    const failedCall = calls.find((call) => call.url.endsWith('/office_cloud_fail_upload'))!;
    expect(rpcPayload(failedCall)).toMatchObject({ p_actor_id: actorId, p_reason_code: 'integrity_mismatch' });
  });

  it('does not sign a backend-returned key outside the exact workspace/file/revision path', async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_get_file_link')) return Response.json(fileLinkRecord({ object_key: 'office/v1/../../kyc/private.pdf' }));
      throw new Error('Unexpected Bunny request');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'get_link', fileId, purpose: 'download' }));
    expect(response.status).toBe(503);
    expect(calls.some((call) => call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))).toBe(false);
    expect(isOfficeObjectKey(objectKey, workspaceId, fileId, revisionId)).toBe(true);
    expect(isOfficeObjectKey('office/v1/workspaces/../kyc/file')).toBe(false);
    expect(isOfficeObjectKey('kyc/private.pdf')).toBe(false);
  });

  it('issues a short-lived, file-specific preview fetch URL that is forced to generic attachment bytes', async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_get_file_link')) return Response.json(fileLinkRecord());
      throw new Error('Unexpected direct Bunny call');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'get_link', fileId, purpose: 'preview' }));
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.expiresInSeconds).toBe(120);
    expect(result.contentType).toBe('application/octet-stream');
    const url = new URL(result.url);
    expect(url.pathname).toBe(`/cocce-kyc/${objectKey}`);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(url.searchParams.get('response-content-type')).toBe('application/octet-stream');
    expect(url.searchParams.get('response-content-disposition')).toContain('attachment');
    expect(url.searchParams.get('response-content-disposition')).not.toContain('inline');
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain('synthetic-bunny-secret-not-real');
  });

  it('keeps active or unknown content non-inline even when requesting a preview link', async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_get_file_link')) return Response.json(fileLinkRecord({ verified_content_type: 'application/octet-stream' }));
      throw new Error('No link should be signed');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'get_link', fileId, purpose: 'preview' }));
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.contentType).toBe('application/octet-stream');
    expect(new URL(result.url).searchParams.get('response-content-disposition')).toContain('attachment');
    expect(calls.some((call) => call.url.startsWith('https://de-s3.storage.bunnycdn.com/'))).toBe(false);
  });

  it('uses only authenticated, workspace-scoped metadata RPCs and returns a generic denial', async () => {
    const { fetchImpl, calls } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_list_files')) return new Response(JSON.stringify({ code: '42501', message: 'private workspace info' }), { status: 403 });
      throw new Error('Unexpected route');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'list_files', workspaceId }));
    expect(response.status).toBe(403);
    const result = await response.json();
    expect(JSON.stringify(result)).not.toContain('private workspace info');
    const rpc = calls.find((call) => call.url.endsWith('/office_cloud_list_files'))!;
    expect(rpcPayload(rpc)).toEqual({ p_actor_id: actorId, p_workspace_id: workspaceId, p_limit: 50, p_offset: 0 });
  });

  it('returns a generic 429 when the workspace metadata rate limit is reached', async () => {
    const { fetchImpl } = routedFetch((url) => {
      if (url.pathname.endsWith('/office_cloud_list_files')) return new Response(JSON.stringify({ code: '54000', message: 'private rate-limit detail' }), { status: 400 });
      throw new Error('Unexpected route');
    });
    const handler = createOfficeCloudHandler({ env: secretEnv, fetchImpl, now: () => fixedNow });
    const response = await handler(request({ action: 'list_files', workspaceId }));
    expect(response.status).toBe(429);
    expect(JSON.stringify(await response.json())).not.toContain('private rate-limit detail');
  });

  it('constructs HEAD, GET and PUT signatures with fixed zone/region and bounded expiry', async () => {
    const put = new URL(await createPresignedS3Url('synthetic-secret', {
      method: 'PUT', objectKey, expiresSeconds: 300, nowMs: fixedNow,
      contentType: 'application/pdf', contentLengthBytes: 4,
      checksumBase64: 'dGVzdA==', checksumHex: 'a'.repeat(64), uploadSessionId: sessionId,
    }));
    const get = new URL(await createPresignedS3Url('synthetic-secret', {
      method: 'GET', objectKey, expiresSeconds: 120, nowMs: fixedNow,
      responseContentType: 'application/octet-stream', responseContentDisposition: 'attachment; filename="x.bin"',
    }));
    const head = new URL(await createPresignedS3Url('synthetic-secret', {
      method: 'HEAD', objectKey, expiresSeconds: 60, nowMs: fixedNow,
    }));
    expect(put.searchParams.get('X-Amz-Credential')).toContain('cocce-kyc/20261104/de/s3/aws4_request');
    expect(put.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host;x-amz-checksum-sha256;x-amz-meta-office-session;x-amz-meta-office-sha256');
    expect(put.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(get.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(get.searchParams.get('X-Amz-Expires')).toBe('120');
    expect(head.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(head.searchParams.get('X-Amz-Expires')).toBe('60');
    await expect(createPresignedS3Url('synthetic-secret', {
      method: 'GET', objectKey: 'cocce-kyc/kyc/private.pdf', expiresSeconds: 120, nowMs: fixedNow,
      responseContentType: 'application/pdf', responseContentDisposition: 'inline',
    })).rejects.toThrow('Invalid signing request');
  });
});
