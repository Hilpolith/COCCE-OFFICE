// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const mocks = vi.hoisted(() => {
  const state = {
    actor_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    role: 'ngo_admin' as const,
    capabilities: { manage: true, programmes: true, finance: false, approve_finance: false, procurement: false, delivery: false, monitoring: false, beneficiary_private: false, safeguarding: false, people_assets: false, compliance: false, reports: true, audit: true },
    summary: {},
    settings: { base_currency: 'TZS', jurisdiction: 'mainland' as const, private_data_enabled: true, storage_review_state: 'rejected' as const, storage_review_reference: 'review-1', version: 7 },
  };
  const command = vi.fn(async (_client: unknown, _workspace: string, action: string, payload: Record<string, unknown>) => {
    if (action === 'set_private_gate') {
      expect(payload).toMatchObject({ enabled: false, expected_version: 7 });
      state.settings = { ...state.settings, private_data_enabled: false, version: 8 };
    }
    return { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: state.settings.version, status: 'updated' };
  });
  const read = vi.fn(async (_client: unknown, _workspace: string, resource: string, _filter: Record<string, unknown> = {}, limit = 100, offset = 0) => {
    if (resource === 'bootstrap') return state;
    if (resource === 'private_keys') return { beneficiary: { configured: false }, safeguarding: { configured: false } };
    const total_count = ({ projects: 4, grants: 2, reports: 3 } as Record<string, number>)[resource] ?? 0;
    return { rows: [], total_count, limit, offset, has_more: offset < total_count };
  });
  return { state, command, read };
});
const { state: bootstrap, command, read } = mocks;

vi.mock('./lib/officeNgoManagement', () => ({ officeNgoManagementApi: { read: mocks.read, command: mocks.command } }));
vi.mock('./lib/officeTeamSupabase', () => ({ getOfficeTeamClient: vi.fn(() => ({ auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } } })), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) } })), resolveOfficeTeamConfig: vi.fn(() => ({})) }));

import NgoManagementWorkspace from './NgoManagementWorkspace';

beforeEach(() => {
  bootstrap.capabilities = { manage: true, programmes: true, finance: false, approve_finance: false, procurement: false, delivery: false, monitoring: false, beneficiary_private: false, safeguarding: false, people_assets: false, compliance: false, reports: true, audit: true };
  bootstrap.summary = {};
  bootstrap.settings = { base_currency: 'TZS', jurisdiction: 'mainland', private_data_enabled: true, storage_review_state: 'rejected', storage_review_reference: 'review-1', version: 7 };
  command.mockClear();
  read.mockClear();
});

afterEach(() => cleanup());

describe('NGO server-backed overview', () => {
  it('loads total counts only for resources permitted by the active role', async () => {
    render(<NgoManagementWorkspace workspaceId={workspaceId} officeName="COCCE" country="Tanzania" />);
    await waitFor(() => expect(screen.getByText('projects')).toBeTruthy());
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText('grants')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('reports')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
    expect(read).toHaveBeenCalledWith(expect.anything(), workspaceId, 'projects', {}, 1, 0);
    expect(read).toHaveBeenCalledWith(expect.anything(), workspaceId, 'grants', {}, 1, 0);
    expect(read).toHaveBeenCalledWith(expect.anything(), workspaceId, 'reports', {}, 1, 0);
    expect(read).not.toHaveBeenCalledWith(expect.anything(), workspaceId, 'safeguarding', expect.anything(), expect.anything(), expect.anything());
  });
});

describe('NGO private data gate', () => {
  it('hydrates an enabled server gate, allows closing when prerequisites are ineligible, and reconciles after refresh', async () => {
    render(<NgoManagementWorkspace workspaceId={workspaceId} officeName="COCCE" country="Tanzania" />);

    await waitFor(() => expect(screen.getByRole('tab', { name: 'Security' })).toBeTruthy());
    fireEvent.click(screen.getByRole('tab', { name: 'Security' }));
    fireEvent.click(screen.getByRole('button', { name: 'storage' }));

    const gate = await screen.findByRole('combobox', { name: 'Private data gate' });
    expect((gate as HTMLSelectElement).value).toBe('enabled');
    expect((gate as HTMLSelectElement).disabled).toBe(false);

    fireEvent.change(gate, { target: { value: 'closed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply gate' }));

    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), workspaceId, 'set_private_gate', expect.objectContaining({ enabled: false, expected_version: 7, idempotency_key: expect.any(String) })));
    await waitFor(() => expect((screen.getByRole('combobox', { name: 'Private data gate' }) as HTMLSelectElement).value).toBe('closed'));
    expect(bootstrap.settings.private_data_enabled).toBe(false);
    expect(read).toHaveBeenCalledWith(expect.anything(), workspaceId, 'bootstrap', {}, 1, 0);
  });
});
