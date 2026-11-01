// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import VaultWorkspace from './VaultWorkspace';
import { BrowserVaultRepository } from './lib/vaultStore';

const PASSPHRASE = 'local vault passphrase';

afterEach(() => cleanup());

describe('local Vault workspace UI', () => {
  it('creates a vault, saves a protected folder, then reloads and unlocks it', async () => {
    const repository = new BrowserVaultRepository(new IDBFactory());
    const firstRender = render(<VaultWorkspace repository={repository} />);
    await screen.findByRole('heading', { name: 'Start a local Vault' });
    fireEvent.change(screen.getByLabelText('New Vault passphrase'), { target: { value: PASSPHRASE } });
    fireEvent.change(screen.getByLabelText('Confirm Vault passphrase'), { target: { value: PASSPHRASE } });
    fireEvent.click(screen.getByRole('button', { name: 'Create local Vault' }));
    await screen.findByText('Unlocked in this tab');
    expect(screen.queryByLabelText('New Vault passphrase')).toBeNull();

    fireEvent.change(screen.getByLabelText('New protected folder name'), { target: { value: 'Tax records' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create protected folder' }));
    await screen.findByRole('button', { name: /^Tax records 0$/ });
    fireEvent.change(screen.getByLabelText('Choose a file to encrypt'), {
      target: { files: [new File(['private payroll memo'], 'wage-slip.txt', { type: 'text/plain' })] },
    });
    await screen.findByRole('button', { name: 'Download wage-slip.txt' });

    firstRender.unmount();
    render(<VaultWorkspace repository={repository} />);
    await screen.findByRole('heading', { name: 'Unlock on this device' });
    fireEvent.change(screen.getByLabelText('Vault passphrase'), { target: { value: PASSPHRASE } });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock Vault' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Tax records 1$/ })).toBeTruthy());
    await screen.findByRole('button', { name: 'Download wage-slip.txt' });
    expect(screen.getByText(/600,000 rounds/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lock Vault' }));
    await screen.findByRole('heading', { name: 'Unlock on this device' });
    expect(screen.queryByRole('button', { name: 'Download wage-slip.txt' })).toBeNull();
  });
});
