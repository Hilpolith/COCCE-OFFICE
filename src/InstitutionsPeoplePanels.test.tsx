// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { afterEach } from 'vitest';
import { useState } from 'react';
import { PeoplePanel, SafeguardingPanel, PrivacyPanel } from './InstitutionsPeoplePanels';

const ID = '10000000-0000-4000-8000-000000000001';
const baseContext = (overrides: Record<string, unknown> = {}) => ({
  workspaceId: '20000000-0000-4000-8000-000000000001', actorId: 'actor', busy: false, revision: 1, feedback: '',
  bootstrap: { workspace_id: '20000000-0000-4000-8000-000000000001', role: 'institution_admin', capabilities: { manage: true, people: true, safeguarding: true, privacy: true }, settings: { initialized: true, version: 1, base_currency: 'TZS', private_data_enabled: true, storage_review_state: 'approved' } },
  keyConfigs: { people: { configured: true }, safeguarding: { configured: true } }, unlocked: { people: true, safeguarding: true },
  load: vi.fn(async (resource: string, _filter?: Record<string, string>) => resource === 'people_index' ? { rows: [{ id: ID, code: 'P-1', status: 'active', version: 2 }], total_count: 1, limit: 50, offset: 0, has_more: false } : resource === 'safeguarding_index' ? { rows: [{ id: ID, code: 'S-1', status: 'reported', version: 3 }], total_count: 1, limit: 50, offset: 0, has_more: false } : { rows: [{ id: ID, code: 'S-1', status: 'reported', version: 3, nonce: 'n', ciphertext: 'c', lawful_basis: 'consent', notice_reference: 'SYNTHETIC-NOTICE', retention_until: '2030-01-01' }], total_count: 1, limit: 50, offset: 0, has_more: false }),
  save: vi.fn(async () => ({ id: ID, version: 1, status: 'open' })),
  transition: vi.fn(async (_resource: string, _row: Record<string, unknown>, to: string) => ({ id: ID, version: 5, status: to })),
  run: vi.fn(async (action: string, payload: Record<string, unknown>) => { void action; void payload; return { id: ID, version: 1, status: 'reported' }; }),
  seal: vi.fn(async () => ({ nonce: 'nonce', ciphertext: 'ciphertext' })), decrypt: vi.fn(async () => ({ details: 'memory only', intake: 'safe private', risk: 'synthetic low risk' })),
  unlock: vi.fn(), configureKey: vi.fn(), lock: vi.fn(), notify: vi.fn(), ...overrides,
});

describe('InstitutionsPeoplePanels', () => {
  afterEach(() => cleanup());
  it('does not call a private index while the people gate is closed', async () => {
    const context = baseContext({ bootstrap: { ...baseContext().bootstrap, capabilities: { people: false, safeguarding: false, privacy: false }, settings: { ...baseContext().bootstrap.settings, private_data_enabled: false } } });
    render(<PeoplePanel context={context as never} />);
    await waitFor(() => expect(screen.getByText(/gate is closed/i)).toBeTruthy());
    expect(context.load).not.toHaveBeenCalled();
    expect(context.run).not.toHaveBeenCalled();
  });

  it('sends a people UUID at the top level and keeps data ciphertext-only', async () => {
    const context = baseContext(); render(<PeoplePanel context={context as never} />);
    await waitFor(() => expect(context.load).toHaveBeenCalledWith('people_index', {}, 0));
    fireEvent.change(screen.getByLabelText('Code'), { target: { value: 'P-NEW' } });
    fireEvent.change(screen.getByLabelText('Lawful basis'), { target: { value: 'consent' } });
    fireEvent.change(screen.getByLabelText('Notice reference'), { target: { value: 'N-1' } });
    fireEvent.change(screen.getByLabelText('Retention until'), { target: { value: '2030-01-01' } });
    fireEvent.change(screen.getByLabelText('Private contact/membership details'), { target: { value: 'private person' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create encrypted person' }));
    await waitFor(() => expect(context.run).toHaveBeenCalledWith('save_private', expect.objectContaining({ id: expect.any(String), data: expect.objectContaining({ nonce: 'nonce', ciphertext: 'ciphertext', code: 'P-NEW' }) })));
    const payload = context.run.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.data).not.toHaveProperty('details'); expect(payload.id).not.toBeUndefined();
  });

  it('reads people by exact id with an explicit purpose', async () => {
    const context = baseContext(); render(<PeoplePanel context={context as never} />);
    await waitFor(() => expect(context.load).toHaveBeenCalledWith('people_index', {}, 0));
    fireEvent.change(screen.getByLabelText('Exact person index row'), { target: { value: ID } });
    fireEvent.click(screen.getByRole('button', { name: /Read exact ID/ }));
    await waitFor(() => expect(context.load).toHaveBeenCalledWith('people', { id: ID, purpose: 'administration' }, 0));
    expect(context.decrypt).toHaveBeenCalledWith('people', 'people', expect.objectContaining({ id: ID }));
  });

  it('updates safeguarding ciphertext before progressing with the refreshed version', async () => {
    const context = baseContext(); render(<SafeguardingPanel context={context as never} />);
    await waitFor(() => expect(context.load).toHaveBeenCalledWith('safeguarding_index', {}, 0));
    fireEvent.change(screen.getByLabelText('Safeguarding case'), { target: { value: ID } });
    expect((screen.getByRole('button', { name: 'Triage' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Open exact case' }));
    await screen.findByLabelText('Intake');
    fireEvent.click(screen.getByRole('button', { name: 'Triage' }));
    await waitFor(() => expect(context.transition).toHaveBeenCalled());
    expect(context.run).toHaveBeenCalledWith('save_private', expect.objectContaining({ id: ID, expected_version: 3, data: expect.objectContaining({ nonce: 'nonce', ciphertext: 'ciphertext', lawful_basis: 'consent', notice_reference: 'SYNTHETIC-NOTICE', retention_until: '2030-01-01' }) }));
    expect(context.transition.mock.invocationCallOrder[0]).toBeGreaterThan(context.run.mock.invocationCallOrder[0]);
  });

  it('preserves case metadata and progresses after its own encrypted-save revision refresh', async () => {
    const context = baseContext();
    context.run.mockResolvedValue({ id: ID, version: 4, status: 'reported' });
    function Harness() {
      const [revision, setRevision] = useState(1);
      const run = async (action: string, payload: Record<string, unknown>) => {
        const result = await context.run(action, payload);
        setRevision(value => value + 1);
        await new Promise(resolve => setTimeout(resolve, 0));
        return result;
      };
      return <SafeguardingPanel context={{ ...context, revision, run } as never} />;
    }
    render(<Harness />);
    await waitFor(() => expect(context.load).toHaveBeenCalledWith('safeguarding_index', {}, 0));
    fireEvent.change(screen.getByLabelText('Safeguarding case'), { target: { value: ID } });
    fireEvent.click(screen.getByRole('button', { name: 'Open exact case' }));
    await screen.findByLabelText('Intake');
    fireEvent.click(screen.getByRole('button', { name: 'Triage' }));
    await waitFor(() => expect(context.transition).toHaveBeenCalledWith('safeguarding', expect.objectContaining({ id: ID, version: 4 }), 'triaged', {}));
    const payload = context.run.mock.calls[0][1] as { data: Record<string, unknown> };
    expect(payload.data).not.toHaveProperty('branch_id');
    expect(payload.data.notice_reference).toBe('SYNTHETIC-NOTICE');
    expect(context.seal).toHaveBeenCalledWith('safeguarding', 'safeguarding', ID, expect.objectContaining({ intake: 'safe private', risk: 'synthetic low risk' }));
  });

  it('includes the real intake reference when recording a privacy request', async () => {
    const context = baseContext(); render(<PrivacyPanel context={context as never} />);
    fireEvent.change(screen.getByLabelText('Request code'), { target: { value: 'SYNTHETIC-PRIVACY-1' } });
    fireEvent.change(screen.getByLabelText('Received on'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('Due on'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByLabelText('Intake reference'), { target: { value: 'SYNTHETIC-INTAKE-REF' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Record request metadata' }).closest('form')!);
    await waitFor(() => expect(context.save).toHaveBeenCalledWith('privacy_requests', expect.objectContaining({ code: 'SYNTHETIC-PRIVACY-1', reference: 'SYNTHETIC-INTAKE-REF', request_type: 'access', received_on: '2026-11-01', due_on: '2026-12-01' })));
  });
});
