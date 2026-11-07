import { describe, expect, it, vi } from 'vitest';
import { businessRecordsContext, normalizeBusinessPrivateContact, officeBusinessManagementApi } from './officeBusinessManagement';
import type { BusinessAction, BusinessResource } from './officeBusinessManagement';

function client(data: unknown = []) {
  return { rpc: vi.fn().mockResolvedValue({ data, error: null }) };
}
describe('Business specialist API', () => {
  it('calls bounded filtered resources without a total-record cap', async () => {
    const api = client([{ account_id: 'account-1' }]);
    await expect(officeBusinessManagementApi.read(api, 'workspace', 'accounts', { status: 'active' }, 100, 4500)).resolves.toEqual([{ account_id: 'account-1' }]);
    expect(api.rpc).toHaveBeenCalledWith('office_business_read', { p_workspace_id: 'workspace', p_resource: 'accounts', p_filter: { status: 'active' }, p_limit: 100, p_offset: 4500 });
  });
  it('clamps pagination and rejects malformed resource/filter values before a network request', async () => {
    const api = client();
    await officeBusinessManagementApi.read(api, 'workspace', 'accounts', {}, Infinity, NaN);
    expect(api.rpc).toHaveBeenLastCalledWith('office_business_read', expect.objectContaining({ p_limit: 100, p_offset: 0 }));
    await officeBusinessManagementApi.read(api, 'workspace', 'accounts', {}, 2000, 2.9);
    expect(api.rpc).toHaveBeenLastCalledWith('office_business_read', expect.objectContaining({ p_limit: 200, p_offset: 2 }));
    api.rpc.mockClear();
    await expect(officeBusinessManagementApi.read(api, 'workspace', 'bad' as BusinessResource)).rejects.toThrow('Unknown');
    await expect(officeBusinessManagementApi.read(api, 'workspace', 'accounts', [] as unknown as Record<string, unknown>)).rejects.toThrow('object');
    expect(api.rpc).not.toHaveBeenCalled();
  });
  it('preserves exact idempotent command data and returns authoritative server results', async () => {
    const data = { entity_id: 'invoice-1', version: 2, outstanding_total: '1200.00' };
    const api = client(data);
    const payload = { invoice_id: 'invoice-1', expected_version: 1, amount: '100.00', idempotency_key: 'same-retry-key' };
    await expect(officeBusinessManagementApi.command(api, 'workspace', 'record_receipt', payload)).resolves.toEqual(data);
    expect(api.rpc).toHaveBeenCalledWith('office_business_command', { p_workspace_id: 'workspace', p_action: 'record_receipt', p_payload: payload });
    expect(api.rpc.mock.calls[0][1].p_payload).toBe(payload);
  });
  it('does not transmit plaintext private contacts or key passphrases', async () => {
    const api = client();
    await expect(officeBusinessManagementApi.command(api, 'workspace', 'save_account_private', { account_id: 'account', nonce: 'ciphernonce', ciphertext: 'encrypted', contact_name: 'PRIVATE NAME', idempotency_key: 'key' })).rejects.toThrow('Only encrypted');
    await expect(officeBusinessManagementApi.command(api, 'workspace', 'configure_contact_key', { salt: 'salt', nonce: 'nonce', ciphertext: 'encrypted', passphrase: 'PRIVATE PASSWORD', idempotency_key: 'key' })).rejects.toThrow('Only encrypted');
    expect(api.rpc).not.toHaveBeenCalled();
    await officeBusinessManagementApi.command(api, 'workspace', 'save_account_private', { account_id: 'account', nonce: 'ciphernonce', ciphertext: 'encrypted', expected_version: 1, idempotency_key: 'key' });
    expect(api.rpc).toHaveBeenCalledTimes(1);
  });
  it('fails visibly on server denial, unknown commands and non-object data', async () => {
    const api = client();
    api.rpc.mockResolvedValue({ data: null, error: { message: 'Business role required' } });
    await expect(officeBusinessManagementApi.read(api, 'workspace', 'accounts')).rejects.toThrow('Business role required');
    api.rpc.mockClear();
    await expect(officeBusinessManagementApi.command(api, 'workspace', 'bad' as BusinessAction, {})).rejects.toThrow('Unknown');
    await expect(officeBusinessManagementApi.command(api, 'workspace', 'save_account', null as unknown as Record<string, unknown>)).rejects.toThrow('object');
    expect(api.rpc).not.toHaveBeenCalled();
  });
  it('binds encrypted contacts to their Business workspace and validates contact fields', () => {
    expect(businessRecordsContext('a')).not.toBe(businessRecordsContext('b'));
    expect(businessRecordsContext('a')).toBe('COCCE Business:a:v1');
    expect(() => businessRecordsContext('')).toThrow('workspace');
    expect(() => businessRecordsContext(' a ')).toThrow('workspace');
    expect(normalizeBusinessPrivateContact({ contact_name: '  Test  ', email: 'a@example.test' })).toEqual({ contact_name: 'Test', email: 'a@example.test', phone: '', address: '', tax_or_registration_reference: '' });
    expect(() => normalizeBusinessPrivateContact({ email: 'not-an-email' })).toThrow('email');
    expect(() => normalizeBusinessPrivateContact({ phone: 'x'.repeat(41) })).toThrow('invalid');
    expect(() => normalizeBusinessPrivateContact({ address: 'secret\u0000data' })).toThrow('invalid');
  });
});
