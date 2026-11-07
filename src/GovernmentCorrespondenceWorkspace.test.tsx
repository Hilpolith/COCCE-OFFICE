// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import GovernmentCorrespondenceWorkspace from './GovernmentCorrespondenceWorkspace';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  listWorkspaces: vi.fn(),
  listMembers: vi.fn(),
  getSpace: vi.fn(),
  registerSpace: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  register: vi.fn(),
  route: vi.fn(),
  transition: vi.fn(),
  listEvents: vi.fn(),
  accessProfile: vi.fn(),
}));

vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({ status: 'ready', url: 'https://nresyncmhdybucenhxbw.supabase.co', projectRef: 'nresyncmhdybucenhxbw', anonKey: 'sb_publishable_test', schemaReady: true }),
  getOfficeTeamClient: () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock('./lib/officeTeamApi', () => ({
  officeTeamApi: { listWorkspaces: mocks.listWorkspaces, listMembers: mocks.listMembers },
}));
vi.mock('./lib/officeIndustryTasks', () => ({
  officeIndustryTasksApi: { getSpace: mocks.getSpace, registerSpace: mocks.registerSpace },
}));
vi.mock('./lib/officeGovernmentCorrespondence', () => ({
  officeGovernmentCorrespondenceApi: {
    list: mocks.list, create: mocks.create, update: mocks.update, register: mocks.register,
    route: mocks.route, transition: mocks.transition, listEvents: mocks.listEvents,
  },
}));
vi.mock('./lib/officeGovernmentWorkspace', () => ({
  officeGovernmentWorkspaceApi: { accessProfile: mocks.accessProfile },
}));

const workspaceId = 'government-team-id';
const profile = {
  workspace_id: workspaceId, industry_id: 'government' as const, office_name: 'Kijiji District Office',
  country: 'Tanzania', created_at: '2026-11-06T10:00:00Z',
};
const workspace = {
  workspace_id: workspaceId, name: 'Kijiji District Office · Government', role: 'owner' as const,
  created_at: '2026-11-06T09:00:00Z',
};
const owner = {
  user_id: 'user-owner', username: 'owner', display_name: 'Office Owner', avatar_url: null,
  is_vip: false, vip_expires_at: null, role: 'owner' as const, status: 'active' as const,
  joined_at: '2026-11-06T09:00:00Z',
};
const member = {
  user_id: 'user-member', username: 'member', display_name: 'Registry Officer', avatar_url: null,
  is_vip: false, vip_expires_at: null, role: 'member' as const, status: 'active' as const,
  joined_at: '2026-11-06T09:30:00Z',
};
const incomingRecord = {
  correspondence_id: 'record-incoming', workspace_id: workspaceId, direction: 'incoming' as const,
  record_type: 'letter' as const, subject: 'Synthetic non-sensitive work item', summary: 'Operational metadata only',
  official_reference: '', source_unit: 'External Office', destination_unit: 'Kijiji District Office',
  current_department: '', assigned_user_id: null, received_date: '2026-11-06', due_date: null,
  related_incoming_id: null, dispatch_method: null, dispatch_reference: '', dispatched_at: null,
  status: 'received' as const, version: 1, created_by: 'user-member', created_at: '2026-11-06T10:00:00Z',
  updated_by: 'user-member', updated_at: '2026-11-06T10:00:00Z',
};

const renderGovernment = () => render(<GovernmentCorrespondenceWorkspace
  workspaceId={workspaceId} officeName="Kijiji District Office" country="Tanzania" accent="#77d5be"
/>);

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-owner' } }, error: null });
  mocks.listWorkspaces.mockResolvedValue([workspace]);
  mocks.listMembers.mockResolvedValue([owner, member]);
  mocks.getSpace.mockResolvedValue(profile);
  mocks.registerSpace.mockResolvedValue(profile);
  mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue('new-record-id');
  mocks.update.mockResolvedValue(2);
  mocks.register.mockResolvedValue(2);
  mocks.route.mockResolvedValue(5);
  mocks.transition.mockResolvedValue(2);
  mocks.listEvents.mockResolvedValue([]);
  mocks.accessProfile.mockResolvedValue({ is_admin: true, roles: [] });
});

describe('Government correspondence workspace', () => {
  it('keeps the missing proposal schema explicit and does not read or copy device-local data', async () => {
    const localBytes = JSON.stringify({ offices: [{ items: [{ title: 'Browser-only draft' }] }] });
    window.localStorage.setItem('cocce-office-industry-workspaces-v1', localBytes);
    mocks.list.mockRejectedValue(new Error('Could not find the function public.office_gov_correspondence_list in the schema cache'));
    renderGovernment();

    expect(await screen.findByText('Government workspace schema is not available')).toBeTruthy();
    expect(screen.getByText(/required Government workspace migration is not installed/i)).toBeTruthy();
    expect(screen.queryByText('Browser-only draft')).toBeNull();
    expect(window.localStorage.getItem('cocce-office-industry-workspaces-v1')).toBe(localBytes);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('creates only an explicit shared register entry and sanitizes control characters', async () => {
    const localBytes = JSON.stringify({ offices: [{ items: [{ title: 'Stay local' }] }] });
    window.localStorage.setItem('cocce-office-industry-workspaces-v1', localBytes);
    renderGovernment();
    expect(await screen.findByRole('heading', { name: 'Kijiji District Office workspace' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/do not store citizen names or IDs/i);

    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Synthetic short label' } });
    fireEvent.change(screen.getByLabelText('Summary'), { target: { value: 'No\ncontrol chars' } });
    fireEvent.change(screen.getByLabelText('From unit'), { target: { value: 'External Office' } });
    fireEvent.change(screen.getByLabelText('To unit'), { target: { value: 'Kijiji District Office' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add correspondence' }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId, direction: 'incoming', subject: 'Synthetic short label', summary: 'No control chars',
      sourceUnit: 'External Office', destinationUnit: 'Kijiji District Office',
    })));
    expect(mocks.create.mock.calls[0][1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);
    expect(window.localStorage.getItem('cocce-office-industry-workspaces-v1')).toBe(localBytes);
  });

  it('requires owner registration of the institution-issued reference and freezes the content in the UI', async () => {
    mocks.list.mockResolvedValueOnce([incomingRecord]).mockResolvedValue([{
      ...incomingRecord, status: 'registered', official_reference: 'IN-2026-017', version: 2,
    }]);
    renderGovernment();
    await screen.findByText('Synthetic non-sensitive work item');
    fireEvent.change(screen.getByLabelText('Institution-issued reference'), { target: { value: 'IN-2026-017' } });
    fireEvent.click(screen.getByRole('button', { name: 'Register reference' }));

    await waitFor(() => expect(mocks.register).toHaveBeenCalledWith(expect.anything(), {
      workspaceId, correspondenceId: incomingRecord.correspondence_id, expectedVersion: 1,
      officialReference: 'IN-2026-017',
    }));
    expect(await screen.findByText(/content is now frozen/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Edit draft details' })).toBeNull();
  });

  it('allows an owner to reassign an in-progress incoming item and loads a separate audit trail', async () => {
    mocks.list.mockResolvedValue([{
      ...incomingRecord, official_reference: 'IN-2026-017', current_department: 'Operations',
      assigned_user_id: member.user_id, status: 'in_progress', version: 4,
    }]);
    mocks.listEvents.mockResolvedValue([{
      event_id: 'event-3', correspondence_id: incomingRecord.correspondence_id, actor_id: 'user-owner',
      event_kind: 'routed', record_version: 3, from_status: 'registered', to_status: 'routed',
      changed_fields: ['current_department', 'assigned_user_id'], from_department: '', to_department: 'Operations',
      from_assignee_user_id: null, to_assignee_user_id: member.user_id, created_at: '2026-11-06T10:10:00Z',
    }]);
    renderGovernment();
    await screen.findByText('Synthetic non-sensitive work item');

    fireEvent.change(screen.getByLabelText('Internal department'), { target: { value: 'Records Unit' } });
    fireEvent.change(screen.getByLabelText('Assign to active team member'), { target: { value: 'user-member' } });
    fireEvent.click(screen.getByRole('button', { name: 'Re-route assignment' }));
    await waitFor(() => expect(mocks.route).toHaveBeenCalledWith(expect.anything(), {
      workspaceId, correspondenceId: incomingRecord.correspondence_id, expectedVersion: 4,
      department: 'Records Unit', assignedUserId: 'user-member',
    }));

    fireEvent.click(screen.getByText(/Audit history/));
    expect(await screen.findByText(/Routed to Operations/)).toBeTruthy();
    expect(mocks.listEvents).toHaveBeenCalledWith(expect.anything(), workspaceId, incomingRecord.correspondence_id, { limit: 50, before: null });
  });

  it('moves focus and selection together through the role-visible module dock', async () => {
    renderGovernment();
    const register = await screen.findByRole('tab', { name: 'Register' });
    register.focus();
    fireEvent.keyDown(register, { key: 'ArrowRight' });
    const records = screen.getByRole('tab', { name: 'Records Management' });
    expect(document.activeElement).toBe(records);
    expect(records.getAttribute('aria-selected')).toBe('true');
    expect(register.getAttribute('tabindex')).toBe('-1');
  });
});
