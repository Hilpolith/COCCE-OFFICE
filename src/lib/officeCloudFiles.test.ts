import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createOfficeCloudApi, hashBytes } from './officeCloudFiles';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const fileId = '22222222-2222-4222-8222-222222222222';
const revisionId = '33333333-3333-4333-8333-333333333333';
const sessionId = '44444444-4444-4444-8444-444444444444';
const userId = '55555555-5555-4555-8555-555555555555';
const token = 'jwt-test';

function client(
  session: unknown = { access_token: token, user: { id: userId } },
) {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session }, error: null }),
    },
  } as unknown as SupabaseClient;
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
function api(fetcher: typeof fetch) {
  return createOfficeCloudApi(client(), 'public-key', userId, fetcher);
}

const bunnyUrl = `https://de-s3.storage.bunnycdn.com/cocce-kyc/office/v1/workspaces/${workspaceId}/files/${fileId}/revisions/${revisionId}/payload?X-Amz-Signature=x`;

describe('office cloud files client', () => {
  it('requires a current session for every edge call and never calls the network when absent', async () => {
    const fetcher = vi.fn();
    const cloud = createOfficeCloudApi(
      client(null),
      'public-key',
      userId,
      fetcher,
    );
    await expect(cloud.list(workspaceId)).rejects.toThrow('authentication');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends only the pinned JWT and public key to the edge origin', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ files: [] }));
    await api(fetcher).list(workspaceId);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(
      'https://nresyncmhdybucenhxbw.supabase.co/functions/v1/office-cloud-files',
    );
    expect(init.headers.get('apikey')).toBe('public-key');
    expect(init.headers.get('Authorization')).toBe(`Bearer ${token}`);
    expect(init.body).toBe(
      JSON.stringify({
        action: 'list_files',
        workspaceId,
        limit: 50,
        offset: 0,
      }),
    );
  });

  it('rejects a grant whose signed URL is not the exact Bunny object', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({
        status: 'upload_pending',
        fileId,
        revisionId,
        uploadSessionId: sessionId,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        uploadUrl: bunnyUrl.replace(
          'de-s3.storage.bunnycdn.com',
          'evil.example',
        ),
        requiredHeaders: {
          'Content-Type': 'application/octet-stream',
          'x-amz-checksum-sha256': 'x',
          'x-amz-meta-office-session': sessionId,
          'x-amz-meta-office-sha256': await hashBytes(new Uint8Array([1])),
        },
      }),
    );
    await expect(
      api(fetcher).reserve(
        workspaceId,
        'a.bin',
        new Uint8Array([1]),
        sessionId,
      ),
    ).rejects.toThrow();
  });

  it('bounds the response stream and verifies the listing checksum', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const checksum = await hashBytes(data);
    const oversized = new Uint8Array([1, 2, 3, 4]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ url: bunnyUrl, purpose: 'download', fileId }),
      )
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(oversized);
              controller.close();
            },
          }),
          { status: 200 },
        ),
      );
    const file = {
      fileId,
      workspaceId,
      displayName: 'a.bin',
      sizeBytes: data.byteLength,
      sha256Hex: checksum,
      createdAt: new Date().toISOString(),
    };
    await expect(api(fetcher).download(file, 4)).rejects.toThrow('exceeded');
    expect(fetcher.mock.calls[1][1]).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect(fetcher.mock.calls[1][1].headers).toBeUndefined();
  });
});

describe('strict cloud contract validation', () => {
  it('accepts aggregate quotas above the per-file limit and enforces consistency', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      json({
        usage: {
          workspaceId,
          tierCode: 'small_office',
          baseQuotaBytes: 25_000_000_000,
          purchasedQuotaBytes: 2_000_000_000_000,
          quotaBytes: 2_025_000_000_000,
          activeStoredBytes: 1_000_000,
          trashBytes: 2_000_000,
          reservedBytes: 3_000_000,
          totalConsumedBytes: 6_000_000,
          availableBytes: 2_024_994_000_000,
          usagePercent: 0,
          warningAtPercent: 0,
        },
      }),
    );
    await expect(api(fetcher).usage(workspaceId)).resolves.toMatchObject({
      quotaBytes: 2_025_000_000_000,
    });
    const bad = vi.fn().mockResolvedValue(
      json({
        usage: {
          workspaceId,
          tierCode: 'small_office',
          baseQuotaBytes: 25_000_000_000,
          purchasedQuotaBytes: 0,
          quotaBytes: 25_000_000_000,
          activeStoredBytes: 2,
          trashBytes: 0,
          reservedBytes: 0,
          totalConsumedBytes: 1,
          availableBytes: 24_999_999_999,
          usagePercent: 0,
          warningAtPercent: 0,
        },
      }),
    );
    await expect(api(bad).usage(workspaceId)).rejects.toThrow();
  });

  it('rejects malformed, cross-scope, and over-cap listings instead of filtering them', async () => {
    const malformed = vi.fn().mockResolvedValue(
      json({
        files: [
          {
            fileId,
            workspaceId: fileId,
            displayName: 'bad',
            sizeBytes: 1,
            sha256Hex: '0'.repeat(64),
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    await expect(api(malformed).list(workspaceId)).rejects.toThrow();
    const tooMany = vi.fn().mockResolvedValue(
      json({
        files: Array.from({ length: 51 }, () => ({
          fileId,
          workspaceId,
          displayName: 'a',
          sizeBytes: 1,
          sha256Hex: '0'.repeat(64),
          createdAt: new Date().toISOString(),
        })),
      }),
    );
    await expect(api(tooMany).list(workspaceId)).rejects.toThrow();
    await expect(
      api(vi.fn()).list(workspaceId, false, 10001),
    ).rejects.toThrow();
  });

  it('binds a returned grant to exact headers and the reserved byte size', async () => {
    const data = new Uint8Array([1]);
    const hash = await hashBytes(data);
    const grant = {
      status: 'upload_pending',
      fileId,
      revisionId,
      uploadSessionId: sessionId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      uploadUrl: bunnyUrl,
      requiredHeaders: {
        'Content-Type': 'application/octet-stream',
        'x-amz-checksum-sha256': 'x',
        'x-amz-meta-office-session': sessionId,
        'x-amz-meta-office-sha256': hash,
      },
    };
    const fetcher = vi.fn().mockResolvedValue(json(grant));
    await expect(
      api(fetcher).reserve(workspaceId, 'a.bin', data, sessionId),
    ).rejects.toThrow();
  });

  it.each([401, 403, 409, 413, 422, 429, 503])(
    'maps HTTP %s to a stable cloud error',
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(json({ error: 'opaque' }, status));
      await expect(api(fetcher).list(workspaceId)).rejects.toMatchObject({
        status,
      });
    },
  );

  it('bounds JSON responses and validates operation statuses and IDs', async () => {
    const huge = vi
      .fn()
      .mockResolvedValue(
        new Response('x'.repeat(1024 * 1024 + 1), { status: 200 }),
      );
    await expect(api(huge).list(workspaceId)).rejects.toThrow();
    const wrongStatus = vi
      .fn()
      .mockResolvedValue(json({ status: 'anything', fileId }));
    await expect(api(wrongStatus).finalize(sessionId)).rejects.toThrow();
    const wrongPayload = vi.fn().mockResolvedValue(json({ status: 'ok' }));
    await expect(api(wrongPayload).trash(fileId)).rejects.toThrow();
  });
});

const lookupInput = {
  workspaceId,
  idempotencyKey: sessionId,
  displayName: 'Synthetic.cocce-docs.json',
  sizeBytes: 1,
  sha256Hex: 'a'.repeat(64),
};
describe('non-mutating upload recovery and transfer boundaries', () => {
  it('resolves an expired session by IDs only without re-entering begin_upload or sending document metadata', async () => {
    const descriptor = {
      status: 'recovery_required',
      sessionStatus: 'pending',
      workspaceId,
      fileId,
      uploadSessionId: sessionId,
      expiresAt: '2026-01-01T00:00:00Z',
    };
    const fetcher = vi.fn().mockResolvedValue(json(descriptor));
    await expect(api(fetcher).resolveReservation(lookupInput)).resolves.toEqual(
      descriptor,
    );
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      action: 'resolve_upload',
      workspaceId,
      idempotencyKey: sessionId,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('rejects cross-workspace or URL-bearing discovery descriptors', async () => {
    const descriptor = {
      status: 'recovery_required',
      sessionStatus: 'pending',
      workspaceId,
      fileId,
      uploadSessionId: sessionId,
      expiresAt: '2026-01-01T00:00:00Z',
    };
    for (const invalid of [
      { ...descriptor, workspaceId: fileId },
      { ...descriptor, uploadUrl: bunnyUrl },
      { ...descriptor, objectKey: 'private' },
    ]) {
      await expect(
        api(vi.fn().mockResolvedValue(json(invalid))).resolveReservation(
          lookupInput,
        ),
      ).rejects.toThrow();
    }
  });
  it('distinguishes a definite absent record from a gateway 404 without adopting server messages', async () => {
    await expect(
      api(
        vi
          .fn()
          .mockResolvedValue(json({ error: 'UPLOAD_LOOKUP_NOT_FOUND' }, 404)),
      ).resolveReservation(lookupInput),
    ).rejects.toMatchObject({ status: 404, code: 'UPLOAD_LOOKUP_NOT_FOUND' });
    await expect(
      api(
        vi.fn().mockResolvedValue(new Response('gateway', { status: 404 })),
      ).resolveReservation(lookupInput),
    ).rejects.toMatchObject({ status: 404, code: undefined });
  });
  it('maps aborted requests and malformed or unreadable success bodies to stable errors', async () => {
    const controller = new AbortController();
    let enteredFetch: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredFetch = resolve;
    });
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          enteredFetch?.();
          if (init?.signal?.aborted) {
            reject(new DOMException('synthetic abort detail', 'AbortError'));
            return;
          }
          init?.signal?.addEventListener(
            'abort',
            () =>
              reject(new DOMException('synthetic abort detail', 'AbortError')),
            { once: true },
          );
        }),
    );
    const cloud = createOfficeCloudApi(
      client(),
      'public-key',
      userId,
      fetchMock as unknown as typeof fetch,
      controller.signal,
    );
    const pending = cloud.list(workspaceId);
    await entered;
    controller.abort();
    const generic =
      'Cloud storage is temporarily unavailable. Your local original is unchanged.';
    await expect(pending).rejects.toMatchObject({ message: generic });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);

    const malformed = api(
      vi.fn().mockResolvedValue(new Response('{not json', { status: 200 })),
    );
    await expect(malformed.list(workspaceId)).rejects.toMatchObject({
      message: generic,
    });
    const unreadableBody = new ReadableStream<Uint8Array>({
      start(stream) {
        stream.error(new Error('private synthetic body-reader detail'));
      },
    });
    const unreadable = api(
      vi.fn().mockResolvedValue(new Response(unreadableBody, { status: 200 })),
    );
    await expect(unreadable.list(workspaceId)).rejects.toMatchObject({
      message: generic,
    });
  });
  it('accepts existing over-quota files with zero available bytes rather than hiding or deleting them', async () => {
    const value = {
      workspaceId,
      tierCode: 'personal',
      baseQuotaBytes: 100,
      purchasedQuotaBytes: 0,
      quotaBytes: 100,
      activeStoredBytes: 110,
      trashBytes: 10,
      reservedBytes: 0,
      totalConsumedBytes: 120,
      availableBytes: 0,
      usagePercent: 120,
      warningAtPercent: 100,
    };
    await expect(
      api(vi.fn().mockResolvedValue(json({ usage: value }))).usage(workspaceId),
    ).resolves.toEqual(value);
  });
  async function validGrant(data: Uint8Array) {
    const digest = await hashBytes(data);
    return {
      status: 'upload_pending',
      fileId,
      revisionId,
      uploadSessionId: sessionId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      uploadUrl: bunnyUrl,
      requiredHeaders: {
        'Content-Type': 'application/octet-stream',
        'x-amz-checksum-sha256': btoa(
          String.fromCharCode(
            ...new Uint8Array(
              await crypto.subtle.digest('SHA-256', data as BufferSource),
            ),
          ),
        ),
        'x-amz-meta-office-session': sessionId,
        'x-amz-meta-office-sha256': digest,
      },
    };
  }
  it('sends exactly four bound headers and no JWT, public key, cookies or referrer on the successful Bunny PUT', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json(await validGrant(data)))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    const cloud = api(fetcher);
    const grant = await cloud.reserve(
      workspaceId,
      'Synthetic.cocce-docs.json',
      data,
      sessionId,
    );
    if (grant.status !== 'upload_pending') throw new Error('Expected grant');
    await cloud.upload(grant, data);
    const put = fetcher.mock.calls[1][1];
    expect(put.credentials).toBe('omit');
    expect(put.referrerPolicy).toBe('no-referrer');
    expect(Object.keys(put.headers).sort()).toEqual(
      [
        'Content-Type',
        'x-amz-checksum-sha256',
        'x-amz-meta-office-session',
        'x-amz-meta-office-sha256',
      ].sort(),
    );
    expect(JSON.stringify(put.headers)).not.toContain(token);
    expect(put.headers.Authorization).toBeUndefined();
  });
  it('refuses runtime-forged extra headers, mismatched session/checksum/size and altered content before a PUT', async () => {
    const data = new Uint8Array([1]);
    const fetcher = vi.fn().mockResolvedValue(json(await validGrant(data)));
    const cloud = api(fetcher);
    const grant = await cloud.reserve(
      workspaceId,
      'Synthetic.cocce-docs.json',
      data,
      sessionId,
    );
    if (grant.status !== 'upload_pending') throw new Error('Expected grant');
    for (const changed of [
      {
        ...grant,
        requiredHeaders: {
          ...grant.requiredHeaders,
          Authorization: 'Bearer secret',
        },
      },
      {
        ...grant,
        requiredHeaders: { ...grant.requiredHeaders, Cookie: 'session=secret' },
      },
      {
        ...grant,
        requiredHeaders: {
          ...grant.requiredHeaders,
          'x-amz-meta-office-session': fileId,
        },
      },
      {
        ...grant,
        requiredHeaders: {
          ...grant.requiredHeaders,
          'x-amz-checksum-sha256': 'invalid',
        },
      },
      { ...grant, sizeBytes: 2 },
    ])
      await expect(cloud.upload(changed, data)).rejects.toThrow();
    await expect(cloud.upload(grant, new Uint8Array([2]))).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it('does not PUT after the account signs out while a valid grant is being prepared', async () => {
    const data = new Uint8Array([1]);
    const auth = client();
    const fetcher = vi.fn().mockResolvedValue(json(await validGrant(data)));
    const cloud = createOfficeCloudApi(auth, 'public-key', userId, fetcher);
    const grant = await cloud.reserve(
      workspaceId,
      'Synthetic.cocce-docs.json',
      data,
      sessionId,
    );
    if (grant.status !== 'upload_pending') throw new Error('Expected grant');
    vi.mocked(auth.auth.getSession).mockResolvedValue({
      data: { session: null },
      error: null,
    });
    await expect(cloud.upload(grant, data)).rejects.toMatchObject({
      status: 401,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('reads a strict sync-state record and rejects storage-key or cross-file metadata', async () => {
    const syncState = {
      fileId, workspaceId, displayName: 'Synthetic.cocce-docs.json',
      currentRevisionId: revisionId, revisionNumber: 3, sizeBytes: 12,
      sha256Hex: 'a'.repeat(64), updatedAt: '2026-11-06T12:00:00Z',
    };
    const fetcher = vi.fn().mockResolvedValue(json({ syncState }));
    await expect(api(fetcher).getSyncState(fileId)).resolves.toEqual(syncState);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      action: 'get_sync_state', fileId,
    });
    for (const bad of [
      { ...syncState, fileId: workspaceId },
      { ...syncState, revisionNumber: 0 },
      { ...syncState, sha256Hex: 'invalid' },
      { ...syncState, objectKey: 'private/path' },
    ]) {
      await expect(api(vi.fn().mockResolvedValue(json({ syncState: bad }))).getSyncState(fileId)).rejects.toThrow();
    }
  });

  it('begins a new immutable revision bound to the selected file and expected base', async () => {
    const data = new Uint8Array([4, 5, 6]);
    const fetcher = vi.fn().mockResolvedValue(json({
      status: 'finalized', fileId, revisionId, uploadSessionId: sessionId,
    }));
    await expect(api(fetcher).beginRevision(
      workspaceId, fileId, revisionId, data, sessionId,
    )).resolves.toEqual({
      status: 'finalized', fileId, revisionId, uploadSessionId: sessionId,
    });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      action: 'begin_revision', workspaceId, fileId,
      expectedRevisionId: revisionId, idempotencyKey: sessionId,
      sizeBytes: data.length, sha256Hex: await hashBytes(data),
    });
    const conflict = vi.fn().mockResolvedValue(json({ error: 'CONFLICT' }, 409));
    await expect(api(conflict).beginRevision(
      workspaceId, fileId, revisionId, data, crypto.randomUUID(),
    )).rejects.toMatchObject({ status: 409 });
  });
});


describe('Office Cloud monthly storage billing client', () => {
  const subscriptionId = '66666666-6666-4666-8666-666666666666';
  const plan = { planCode: 'storage_5gb_monthly', displayName: '5 GB', quotaBytes: 5000000000, monthlyCoins: 2000, sortOrder: 1 };
  const subscription = {
    subscriptionId, planCode: plan.planCode, displayName: plan.displayName,
    quotaBytes: plan.quotaBytes, monthlyCoins: plan.monthlyCoins, status: 'active',
    autoRenew: false, cancelAtPeriodEnd: false,
    currentPeriodStart: '2026-11-09T00:00:00Z', currentPeriodEnd: '2026-12-09T00:00:00Z',
    nextBillingAt: null, graceUntil: null, lastBilledAt: '2026-11-09T00:00:00Z',
    createdAt: '2026-11-09T00:00:00Z',
  };

  it('loads server-priced monthly plans and validates plan payloads', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ plans: [plan] }));
    await expect(api(fetcher).storagePlans(workspaceId)).resolves.toEqual([plan]);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: 'storage_plans', workspaceId });
    await expect(api(vi.fn().mockResolvedValue(json({ plans: [{ ...plan, monthlyCoins: -1 }] }))).storagePlans(workspaceId)).rejects.toThrow();
  });

  it('lists workspace subscriptions and billing history with strict validation', async () => {
    const events = [{
      eventId: '77777777-7777-4777-8777-777777777777', subscriptionId,
      eventType: 'purchased', planCode: plan.planCode, displayName: plan.displayName,
      coins: 2000, quotaBytes: plan.quotaBytes, createdAt: '2026-11-09T00:00:00Z',
    }];
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ subscriptions: [subscription] }))
      .mockResolvedValueOnce(json({ events }));
    await expect(api(fetcher).storageSubscriptions(workspaceId)).resolves.toEqual([subscription]);
    await expect(api(fetcher).storageHistory(workspaceId)).resolves.toEqual(events);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: 'storage_subscriptions', workspaceId });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ action: 'storage_history', workspaceId });
  });

  it('purchases with a client idempotency key and explicit auto-renew choice', async () => {
    const purchase = {
      subscriptionId, planCode: plan.planCode, displayName: plan.displayName,
      quotaBytes: plan.quotaBytes, monthlyCoins: plan.monthlyCoins, status: 'active',
      autoRenew: false, currentPeriodEnd: '2026-12-09T00:00:00Z',
      balance: 98000, replayed: false,
    };
    const fetcher = vi.fn().mockResolvedValue(json({ purchase }));
    await expect(api(fetcher).purchaseStorage(workspaceId, plan.planCode, sessionId, '2468')).resolves.toEqual(purchase);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      action: 'purchase_storage', workspaceId, planCode: plan.planCode,
      idempotencyKey: sessionId, walletPin: '2468', autoRenew: false,
    });
    await expect(api(vi.fn()).purchaseStorage(workspaceId, 'storage_unknown', sessionId, '2468')).rejects.toMatchObject({ status: 400 });
  });

  it('renews and changes auto-renew only through explicit edge actions', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(json({ renewal: { subscriptionId, status: 'active', currentPeriodEnd: '2027-01-09T00:00:00Z', replayed: false, balance: 96000 } }))
      .mockResolvedValueOnce(json({ subscription: { subscriptionId, autoRenew: true, cancelAtPeriodEnd: false, currentPeriodEnd: '2027-01-09T00:00:00Z' } }));
    await expect(api(fetcher).renewStorage(subscriptionId, sessionId, '2468')).resolves.toMatchObject({ subscriptionId, status: 'active' });
    await expect(api(fetcher).setStorageAutoRenew(subscriptionId, true, '2468')).resolves.toMatchObject({ subscriptionId, autoRenew: true });
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ action: 'renew_storage', subscriptionId, idempotencyKey: sessionId, walletPin: '2468' });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ action: 'set_storage_auto_renew', subscriptionId, autoRenew: true, walletPin: '2468' });
  });

  it('preserves payment-required status when the server rejects an insufficient Coin balance', async () => {
    const fetcher = vi.fn().mockResolvedValue(json({ error: 'PAYMENT_REQUIRED' }, 402));
    await expect(api(fetcher).purchaseStorage(workspaceId, plan.planCode, sessionId, '2468')).rejects.toMatchObject({
      status: 402,
      message: 'Your COCCE Coin balance is too low for this storage plan.',
    });
  });
});
