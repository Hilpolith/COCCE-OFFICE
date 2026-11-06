// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import IndustrySharedWorkspace from './IndustrySharedWorkspace';
import { industryCatalog } from './lib/industryWorkspaces';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  listWorkspaces: vi.fn(),
  listMembers: vi.fn(),
  getSpace: vi.fn(),
  registerSpace: vi.fn(),
  listWorkItems: vi.fn(),
  createWorkItem: vi.fn(),
  updateWorkItem: vi.fn(),
  moveWorkItem: vi.fn(),
  listWorkEvents: vi.fn(),
}));

vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({ status: 'ready', url: 'https://nresyncmhdybucenhxbw.supabase.co', projectRef: 'nresyncmhdybucenhxbw', anonKey: 'sb_publishable_test', schemaReady: true }),
  getOfficeTeamClient: () => ({ auth: { getUser: mocks.getUser } }),
}));
vi.mock('./lib/officeTeamApi', () => ({
  officeTeamApi: { listWorkspaces: mocks.listWorkspaces, listMembers: mocks.listMembers },
}));
vi.mock('./lib/officeIndustryTasks', () => ({
  officeIndustryTasksApi: {
    getSpace: mocks.getSpace, registerSpace: mocks.registerSpace, listWorkItems: mocks.listWorkItems,
    createWorkItem: mocks.createWorkItem, updateWorkItem: mocks.updateWorkItem, moveWorkItem: mocks.moveWorkItem,
    listWorkEvents: mocks.listWorkEvents,
  },
}));

const workspaceId = 'shared-team-id';
const profile = {
  workspace_id: workspaceId, industry_id: 'business' as const, office_name: 'Kijiji Studio', country: 'Tanzania',
  created_at: '2026-11-06T10:00:00Z',
};
const workspace = { workspace_id: workspaceId, name: 'Kijiji Studio · Business', role: 'owner' as const, created_at: '2026-11-06T09:00:00Z' };
const member = {
  user_id: 'user-1', username: 'owner', display_name: 'Team Owner', avatar_url: null, is_vip: false,
  vip_expires_at: null, role: 'owner' as const, status: 'active' as const, joined_at: '2026-11-06T09:00:00Z',
};
const sharedItem = {
  item_id: 'item-1', workspace_id: workspaceId, industry_id: 'business' as const, title: 'Quarterly filing',
  reference: 'FY26-Q1', assignee_user_id: 'user-1', due_date: '2026-11-20', notes: 'Operational note',
  stage: 'New', version: 1, created_by: 'user-1', created_at: '2026-11-06T10:00:00Z',
  updated_by: 'user-1', updated_at: '2026-11-06T10:00:00Z',
};
const definition = industryCatalog.find((entry) => entry.id === 'business')!;
const renderShared = () => render(<IndustrySharedWorkspace
  workspaceId={workspaceId} officeName="Kijiji Studio" country="Tanzania" industryId="business" definition={definition} accent="#be91ff"
/>);

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
  mocks.listWorkspaces.mockResolvedValue([workspace]);
  mocks.listMembers.mockResolvedValue([member]);
  mocks.getSpace.mockResolvedValue(profile);
  mocks.registerSpace.mockResolvedValue(profile);
  mocks.listWorkItems.mockResolvedValue([]);
  mocks.createWorkItem.mockResolvedValue('item-id');
  mocks.updateWorkItem.mockResolvedValue(2);
  mocks.moveWorkItem.mockResolvedValue(2);
  mocks.listWorkEvents.mockResolvedValue([]);
});

describe('shared industry workbench', () => {
  it('validates the signed-in team membership and displays only server-returned tasks', async () => {
    const localBytes = JSON.stringify({ version: 1, offices: [{ id: 'local-office', items: [{ id: 'local-only', title: 'Never upload this local item' }] }] });
    window.localStorage.setItem('cocce-office-industry-workspaces-v1', localBytes);
    renderShared();

    expect(await screen.findByRole('heading', { name: 'Shared Business work items' })).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/do not enter sensitive/i);
    expect(screen.queryByText('Never upload this local item')).toBeNull();
    expect(window.localStorage.getItem('cocce-office-industry-workspaces-v1')).toBe(localBytes);
    expect(mocks.getSpace).toHaveBeenCalledWith(expect.anything(), workspaceId);
    expect(mocks.listWorkItems).toHaveBeenCalledWith(expect.anything(), workspaceId, { limit: 100 });
    expect(mocks.createWorkItem).not.toHaveBeenCalled();
  });

  it('requires an explicit admin action to create an empty profile and does not copy browser items', async () => {
    mocks.getSpace.mockResolvedValue(null);
    renderShared();

    expect(await screen.findByRole('heading', { name: 'Connect this team to Business' })).toBeTruthy();
    expect(screen.getByText(/existing items in this browser stay local and will not be imported/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create empty shared profile' }));

    await waitFor(() => expect(mocks.registerSpace).toHaveBeenCalledWith(expect.anything(), {
      workspaceId, industryId: 'business', officeName: 'Kijiji Studio', country: 'Tanzania',
    }));
    expect(await screen.findByText(/empty shared profile was created/i)).toBeTruthy();
    expect(mocks.createWorkItem).not.toHaveBeenCalled();
    expect(mocks.listWorkItems).toHaveBeenCalledTimes(1);
  });

  it('does not offer profile registration to an ordinary team member', async () => {
    mocks.getSpace.mockResolvedValue(null);
    mocks.listWorkspaces.mockResolvedValue([{ ...workspace, role: 'member' }]);
    renderShared();

    const setup = await screen.findByRole('button', { name: 'Create empty shared profile' });
    expect(setup).toHaveProperty('disabled', true);
    expect(mocks.registerSpace).not.toHaveBeenCalled();
  });

  it('assigns, advances, edits, and loads history through the shared RPC adapter', async () => {
    mocks.listWorkItems.mockResolvedValue([sharedItem]);
    mocks.listWorkEvents.mockResolvedValue([{
      event_id: 'event-1', item_id: sharedItem.item_id, actor_id: 'user-1', event_kind: 'created',
      task_version: 1, from_stage: null, to_stage: 'New', changed_fields: [], created_at: '2026-11-06T10:00:00Z',
    }]);
    renderShared();

    expect(await screen.findByText('Quarterly filing')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Advance Quarterly filing to next stage' }));
    await waitFor(() => expect(mocks.moveWorkItem).toHaveBeenCalledWith(expect.anything(), {
      workspaceId, itemId: sharedItem.item_id, expectedVersion: 1, direction: 1,
    }));
    expect(await screen.findByText('Qualified')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Edit Quarterly filing' }));
    fireEvent.change(screen.getByLabelText('Work item'), { target: { value: 'Updated filing' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save shared changes' }));
    await waitFor(() => expect(mocks.updateWorkItem).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      workspaceId, itemId: sharedItem.item_id, expectedVersion: 2, title: 'Updated filing', assigneeUserId: 'user-1',
    })));

    fireEvent.click(screen.getByText(/^Shared history/));
    expect(await screen.findByText('Created · New')).toBeTruthy();
    expect(mocks.listWorkEvents).toHaveBeenCalledWith(expect.anything(), workspaceId, sharedItem.item_id, { limit: 50, before: null });
  });

  it('blocks task loading when the existing server profile belongs to another industry', async () => {
    mocks.getSpace.mockResolvedValue({ ...profile, industry_id: 'school' });
    renderShared();

    expect((await screen.findByRole('alert')).textContent).toMatch(/set up for a different industry/i);
    expect(mocks.listWorkItems).not.toHaveBeenCalled();
    expect(mocks.registerSpace).not.toHaveBeenCalled();
  });

  it('does not read shared tasks unless the linked team is an authenticated membership', async () => {
    mocks.listWorkspaces.mockResolvedValue([]);
    renderShared();

    expect((await screen.findByRole('alert')).textContent).toMatch(/not available to this account/i);
    expect(mocks.getSpace).not.toHaveBeenCalled();
    expect(mocks.listWorkItems).not.toHaveBeenCalled();
  });
});
