// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import BusinessPrivateContacts from './BusinessPrivateContacts';

const cryptoMocks = vi.hoisted(() => ({
  create: vi.fn(),
  unlock: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
}));
const apiMocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('./lib/officePrivateRecordsCrypto', () => ({
  createOfficeRecordsKeyConfig: cryptoMocks.create,
  unlockOfficeRecordsKeyConfig: cryptoMocks.unlock,
  encryptOfficePrivateRecord: cryptoMocks.encrypt,
  decryptOfficePrivateRecord: cryptoMocks.decrypt,
}));
vi.mock('./lib/officeBusinessManagement', async () => {
  const actual = await vi.importActual<typeof import('./lib/officeBusinessManagement')>('./lib/officeBusinessManagement');
  return { ...actual, officeBusinessManagementApi: { read: apiMocks.read } };
});

const key = {} as CryptoKey;
const account = { account_id: 'account-1', display_name: 'Acme Ltd', public_reference: 'ACM-001' };
const config = { configured: true, salt: 'salt', nonce: 'nonce', ciphertext: 'ciphertext' };
const client = {} as SupabaseClient;
const baseProps = () => ({
  workspaceId: 'workspace-1', role: 'business_admin' as const, client, keyConfig: config,
  accounts: [account], busy: false, command: vi.fn().mockResolvedValue({ entity_id: 'account-1', version: 1 }), reportError: vi.fn(),
});

beforeEach(() => {
  vi.clearAllMocks();
  cryptoMocks.create.mockResolvedValue({ key, payload: { salt: 'salt', nonce: 'nonce', ciphertext: 'ciphertext' } });
  cryptoMocks.unlock.mockResolvedValue(key);
  cryptoMocks.encrypt.mockResolvedValue({ nonce: 'encrypted-nonce', ciphertext: 'encrypted-ciphertext' });
  cryptoMocks.decrypt.mockResolvedValue({ contact_name: 'Ada', email: 'ada@example.test', phone: '', address: '', tax_or_registration_reference: '' });
  apiMocks.read.mockResolvedValue(null);
});
afterEach(() => cleanup());

async function unlockPanel(props = baseProps()) {
  render(<BusinessPrivateContacts {...props} />);
  fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'correct horse battery staple' } });
  fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
  await screen.findByRole('button', { name: 'Lock and clear private data' });
  return props;
}

describe('BusinessPrivateContacts', () => {
  it('allows only an administrator to configure an unconfigured key', async () => {
    const props = { ...baseProps(), keyConfig: { configured: false }, role: 'manager' as const };
    render(<BusinessPrivateContacts {...props} />);
    expect((screen.getByRole('button', { name: 'Configure key' }) as HTMLButtonElement).disabled).toBe(true);
    expect(cryptoMocks.create).not.toHaveBeenCalled();

    cleanup();
    const adminProps = { ...baseProps(), keyConfig: { configured: false } };
    adminProps.command.mockResolvedValue({ entity_id: null, version: null });
    render(<BusinessPrivateContacts {...adminProps} />);
    fireEvent.change(screen.getByLabelText('Passphrase'), { target: { value: 'correct horse battery staple' } });
    fireEvent.click(screen.getByRole('button', { name: 'Configure key' }));
    await waitFor(() => expect(adminProps.command).toHaveBeenCalledWith('configure_contact_key', expect.objectContaining({ salt: expect.any(String) }), 'Private contact key configured.'));
  });

  it('sends ciphertext only and includes the loaded version on overwrite', async () => {
    const props = await unlockPanel();
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'account-1' } });
    apiMocks.read.mockResolvedValue({ account_id: 'account-1', nonce: 'old-nonce', ciphertext: 'old-ciphertext', version: 7 });
    fireEvent.click(screen.getByRole('button', { name: 'Load contact' }));
    await screen.findByDisplayValue('Ada');
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Ada Updated' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save encrypted contact' }));
    await waitFor(() => expect(props.command).toHaveBeenCalledWith('save_account_private', {
      account_id: 'account-1', nonce: 'encrypted-nonce', ciphertext: 'encrypted-ciphertext', expected_version: 7,
    }, 'Private contact encrypted and saved.'));
    const payload = props.command.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('contact_name');
  });

  it('rejects overwrite when the current record was not loaded', async () => {
    const props = await unlockPanel();
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'account-1' } });
    apiMocks.read.mockResolvedValue({ account_id: 'account-1', nonce: 'old-nonce', ciphertext: 'old-ciphertext', version: 2 });
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Private value' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save encrypted contact' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already exists');
    expect(props.command).not.toHaveBeenCalledWith('save_account_private', expect.anything(), expect.anything());
  });

  it('ignores a late read after the account selection changes', async () => {
    await unlockPanel();
    let resolveRead!: (value: unknown) => void;
    apiMocks.read.mockReturnValue(new Promise(resolve => { resolveRead = resolve; }));
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'account-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Load contact' }));
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: '' } });
    resolveRead({ account_id: 'account-1', nonce: 'old', ciphertext: 'old', version: 1 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect((screen.getByLabelText('Contact name') as HTMLInputElement).value).toBe('');
  });

  it('clears passphrase and private fields when locked', async () => {
    await unlockPanel();
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'account-1' } });
    fireEvent.change(screen.getByLabelText('Contact name'), { target: { value: 'Local only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lock and clear private data' }));
    expect((screen.getByLabelText('Passphrase') as HTMLInputElement).value).toBe('');
    expect(screen.queryByDisplayValue('Local only')).toBeNull();
  });
});
