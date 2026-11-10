// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  createSchoolKeyConfig, decryptSchoolNotice, decryptSchoolPrivatePerson,
  encryptSchoolNotice, encryptSchoolPrivatePerson, officeSchoolManagementApi, unlockSchoolKey,
} from './officeSchoolManagement';
import type { SchoolPrivatePersonRecord, SchoolRpcClient } from './officeSchoolManagement';

const identity: SchoolPrivatePersonRecord = {
  legal_name: 'Synthetic Learner', preferred_name: 'Learner', date_of_birth: '2012-03-04',
  guardians: [{ name: 'Synthetic Guardian', relationship: 'parent', phone: '+255000000000', email: 'guardian@example.test' }],
};

function mockClient(rpc: ReturnType<typeof vi.fn>) { return { rpc } as unknown as SchoolRpcClient; }

describe('School Management client encryption and RPC adapter', () => {
  it('encrypts identity and guardian details before RPC and round-trips only with the passphrase', async () => {
    const created = await createSchoolKeyConfig('synthetic school passphrase');
    const cipher = await encryptSchoolPrivatePerson(created.key, identity);
    const storedPayload = JSON.stringify(cipher);

    expect(storedPayload).not.toContain('Synthetic Learner');
    expect(storedPayload).not.toContain('+255000000000');
    await expect(decryptSchoolPrivatePerson(created.key, cipher)).resolves.toEqual(identity);
    const unlocked = await unlockSchoolKey('synthetic school passphrase', {
      configured: true, key_version: 1, iterations: 600000, ...created.payload,
    });
    await expect(decryptSchoolPrivatePerson(unlocked, cipher)).resolves.toEqual(identity);
    await expect(unlockSchoolKey('wrong passphrase', {
      configured: true, key_version: 1, iterations: 600000, ...created.payload,
    })).rejects.toThrow(/did not unlock/i);
  });

  it('rejects weak passphrases and overly broad guardian payloads', async () => {
    await expect(createSchoolKeyConfig('short')).rejects.toThrow(/12 and 256/i);
    const { key } = await createSchoolKeyConfig('synthetic school passphrase');
    await expect(encryptSchoolPrivatePerson(key, { ...identity, guardians: Array.from({ length: 5 }, () => identity.guardians[0]) }))
      .rejects.toThrow(/four/i);
    await expect(encryptSchoolPrivatePerson(key, { ...identity, legal_name: '' })).rejects.toThrow(/Legal name/i);
  });

  it('encrypts notice bodies and rejects tampering', async () => {
    const { key } = await createSchoolKeyConfig('synthetic school passphrase');
    const body = 'Synthetic class notice for a test only.';
    const cipher = await encryptSchoolNotice(key, body);
    expect(JSON.stringify(cipher)).not.toContain(body);
    await expect(decryptSchoolNotice(key, cipher)).resolves.toBe(body);
    const tampered = { ...cipher, ciphertext: `${cipher.ciphertext.slice(0, -4)}AAAA` };
    await expect(decryptSchoolNotice(key, tampered)).rejects.toThrow(/Could not decrypt/i);
  });

  it('reads validated role-scoped server KPI summaries through the dedicated RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { terms_count: 4, students_count: 12 }, error: null });
    await expect(officeSchoolManagementApi.summary(mockClient(rpc), 'workspace-1')).resolves.toEqual({ terms_count: 4, students_count: 12 });
    expect(rpc).toHaveBeenCalledWith('office_school_summary', { p_workspace_id: 'workspace-1' });
    rpc.mockResolvedValueOnce({ data: { terms_count: -1 }, error: null });
    await expect(officeSchoolManagementApi.summary(mockClient(rpc), 'workspace-1')).rejects.toThrow(/invalid KPI/i);
  });

  it('uses the allowlisted RPC names and bounds list size without writing to browser storage', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { role: 'registrar' }, error: null })
      .mockResolvedValueOnce({ data: { application_id: 'synthetic-id' }, error: null });
    const client = mockClient(rpc);
    await expect(officeSchoolManagementApi.read(client, 'workspace-1', 'bootstrap', {}, 1000, 50)).resolves.toEqual({ role: 'registrar' });
    await expect(officeSchoolManagementApi.command(client, 'workspace-1', 'create_application', { ciphertext: 'c2VudGlubmVs' }))
      .resolves.toEqual({ application_id: 'synthetic-id' });
    expect(rpc).toHaveBeenNthCalledWith(1, 'office_school_read', {
      p_workspace_id: 'workspace-1', p_resource: 'bootstrap', p_filter: { offset: 50 }, p_limit: 200,
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'office_school_command', {
      p_workspace_id: 'workspace-1', p_action: 'create_application', p_payload: { ciphertext: 'c2VudGlubmVs' },
    });
    expect(globalThis).not.toHaveProperty('localStorage');
  });
});
