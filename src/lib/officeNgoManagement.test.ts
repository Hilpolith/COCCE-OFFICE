import { describe, expect, it, vi } from 'vitest';
import { isNgoBootstrap, isNgoKeyConfigs, isNgoPage, officeNgoManagementApi, type NgoRpcClient } from './officeNgoManagement';

const workspace = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const other = '33333333-3333-4333-8333-333333333333';
const idem = '44444444-4444-4444-8444-444444444444';
const rpc = vi.fn(async () => ({ data: { id, version: 1, status: 'draft' }, error: null }));
const client = { rpc } as unknown as NgoRpcClient;
const page = (overrides = {}) => ({ rows: [], total_count: 0, limit: 10, offset: 0, has_more: false, ...overrides });
const b64 = (n: number) => btoa('x'.repeat(n));
const caps = Object.fromEntries(['manage', 'programmes', 'finance', 'approve_finance', 'procurement', 'delivery', 'monitoring', 'beneficiary_private', 'safeguarding', 'people_assets', 'compliance', 'reports', 'audit'].map(k => [k, false]));
const bootstrap = { actor_id: id, role: 'unassigned', capabilities: caps, summary: {}, settings: { base_currency: 'TZS', jurisdiction: 'mainland', private_data_enabled: false, storage_review_state: 'unverified', version: 1 } };

function expectNoRpc(promise: Promise<unknown>) { return expect(promise).rejects.toThrow().then(() => expect(rpc).not.toHaveBeenCalled()); }

describe('office NGO management contract validation', () => {
  it('uses parenthesized has_more semantics and rejects unsafe pages', () => {
    expect(isNgoPage(page({ total_count: 11, rows: [{}], has_more: true }))).toBe(true);
    expect(isNgoPage(page({ total_count: 11, rows: [{}], has_more: false }))).toBe(false);
    expect(isNgoPage(page({ total_count: -1 }))).toBe(false);
    expect(isNgoPage(page({ limit: 0 }))).toBe(false);
    expect(isNgoPage(page({ total_count: 2, offset: 3, has_more: false }))).toBe(false);
  });

  it('accepts an unassigned bootstrap only with all-false capabilities and strict settings', () => {
    expect(isNgoBootstrap(bootstrap)).toBe(true);
    expect(isNgoBootstrap({ ...bootstrap, role: 'ngo_viewer', capabilities: { ...caps, reports: true } })).toBe(true);
    expect(isNgoBootstrap({ ...bootstrap, summary: { made_up: 1 } })).toBe(false);
    expect(isNgoBootstrap({ ...bootstrap, settings: { ...bootstrap.settings, version: 0 } })).toBe(false);
  });

  it('validates key configuration lengths, derivation, and canonical base64', () => {
    const config = { configured: true, key_version: 1, derivation: 'PBKDF2-HMAC-SHA-256/AES-256-GCM', iterations: 600000, salt: b64(16), nonce: b64(12), ciphertext: b64(17) };
    expect(isNgoKeyConfigs({ beneficiary: config, safeguarding: config })).toBe(true);
    expect(isNgoKeyConfigs({ beneficiary: { configured: false, salt: b64(16) }, safeguarding: { configured: false } })).toBe(false);
    expect(isNgoKeyConfigs({ beneficiary: { ...config, iterations: 1 }, safeguarding: config })).toBe(false);
    expect(isNgoKeyConfigs({ beneficiary: { ...config, salt: `${config.salt}=` }, safeguarding: config })).toBe(false);
  });

  it('rejects protected plaintext and unknown nested fields before RPC', async () => {
    rpc.mockClear();
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'save_record', { resource: 'beneficiary_private', id, data: { beneficiary_id: id, nonce: b64(12), ciphertext: b64(17), identity: 'plaintext' }, idempotency_key: idem }));
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'save_record', { resource: 'safeguarding', id, data: { project_id: id, code: 'S-1', priority: 'high', nonce: b64(12), ciphertext: b64(17), retention_until: '2027-01-01', nested: {} }, idempotency_key: idem }));
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'enroll_beneficiary', { id, data: { project_id: id, code: 'B-1', identity: 'plaintext' }, private_record: { nonce: b64(12), ciphertext: b64(17) }, idempotency_key: idem }));
  });

  it('accepts only the atomic beneficiary enrollment envelope and forwards it unchanged', async () => {
    rpc.mockClear();
    const payload = { id, data: { project_id: workspace, code: 'B-1', cohort: 'youth', lawful_basis: 'consent', notice_reference: 'NOTICE-1', retention_until: '2027-01-01' }, private_record: { nonce: b64(12), ciphertext: b64(17) }, idempotency_key: idem };
    await officeNgoManagementApi.command(client, workspace, 'enroll_beneficiary', payload);
    expect(rpc).toHaveBeenCalledWith('office_ngo_command', { p_workspace_id: workspace, p_action: 'enroll_beneficiary', p_payload: payload });
  });

  it('requires positive expected versions for settings and private-gate updates and accepts uppercase currencies', async () => {
    rpc.mockClear();
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'save_settings', { base_currency: 'USD', jurisdiction: 'mainland', idempotency_key: idem }));
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'save_settings', { base_currency: 'usd', jurisdiction: 'mainland', expected_version: 1, idempotency_key: idem }));
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'set_private_gate', { enabled: true, idempotency_key: idem }));
    await officeNgoManagementApi.command(client, workspace, 'save_settings', { base_currency: 'USD', jurisdiction: 'mainland', expected_version: 1, idempotency_key: idem });
  });

  it('enforces protected create IDs and update expected versions', async () => {
    rpc.mockClear();
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'save_record', { resource: 'donors', id, data: { code: 'D', name: 'Donor' }, idempotency_key: idem }));
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'save_record', { resource: 'donors', data: { code: 'D', name: 'Donor' }, expected_version: 1, idempotency_key: idem }));
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'save_record', { resource: 'beneficiary_private', id: other, data: { beneficiary_id: id, nonce: b64(12), ciphertext: b64(17) }, idempotency_key: idem }));
  });

  it('requires all special transition fields and exact decimal strings', async () => {
    rpc.mockClear();
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'transition_record', { resource: 'disbursements', id, expected_version: 1, to_state: 'received', idempotency_key: idem }));
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'transition_record', { resource: 'safeguarding', id, expected_version: 1, to_state: 'open', data: {}, idempotency_key: idem }));
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'save_record', { resource: 'grants', data: { code: 'G', title: 'Grant', award_amount: '1.999' }, idempotency_key: idem }));
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'save_record', { resource: 'activities', data: { project_id: id, code: 'A', title: 'Activity', target_quantity: '1.1234567' }, idempotency_key: idem }));
  });

  it('requires a nonblank grant restriction reference for review-to-active transitions and forwards it unchanged', async () => {
    rpc.mockClear();
    const base = { resource: 'grants', id, expected_version: 1, to_state: 'active', idempotency_key: idem };
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'transition_record', base));
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'transition_record', { ...base, data: { restriction_reference: '   ' } }));

    const payload = { ...base, data: { restriction_reference: 'RESTRICTION-2026-01' } };
    await officeNgoManagementApi.command(client, workspace, 'transition_record', payload);
    expect(rpc).toHaveBeenCalledWith('office_ngo_command', { p_workspace_id: workspace, p_action: 'transition_record', p_payload: payload });
  });

  it('rejects unrelated grant transition fields before RPC', async () => {
    rpc.mockClear();
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'transition_record', { resource: 'grants', id, expected_version: 1, to_state: 'active', data: { restriction_reference: 'REF-1', unrelated: 'nope' }, idempotency_key: idem }));
  });

  it('requires report UUIDs and csv for audit export', async () => {
    rpc.mockClear();
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'audit_export', { resource: 'reports', entity_ids: [], format: 'csv', idempotency_key: idem }));
    await expectNoRpc(officeNgoManagementApi.command(client, workspace, 'audit_export', { resource: 'reports', entity_ids: [id], format: 'json', idempotency_key: idem }));
  });
});
