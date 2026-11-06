// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import SchoolManagementWorkspace from './SchoolManagementWorkspace';

const mocks = vi.hoisted(() => ({
  read: vi.fn(), command: vi.fn(), listWorkspaces: vi.fn(), listMembers: vi.fn(), getSpace: vi.fn(),
  authGetUser: vi.fn(),
}));

vi.mock('./lib/officeSchoolManagement', () => ({
  createSchoolKeyConfig: vi.fn(), unlockSchoolKey: vi.fn(),
  decryptSchoolNotice: vi.fn(), decryptSchoolPrivatePerson: vi.fn(),
  encryptSchoolNotice: vi.fn(), encryptSchoolPrivatePerson: vi.fn(),
  officeSchoolManagementApi: { read: mocks.read, command: mocks.command },
}));
vi.mock('./lib/officeTeamApi', () => ({ officeTeamApi: { listWorkspaces: mocks.listWorkspaces, listMembers: mocks.listMembers } }));
vi.mock('./lib/officeIndustryTasks', () => ({ officeIndustryTasksApi: { getSpace: mocks.getSpace, registerSpace: vi.fn() } }));
vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({ status: 'ready', schemaReady: true }),
  getOfficeTeamClient: () => ({ auth: { getUser: mocks.authGetUser }, rpc: vi.fn() }),
}));
vi.mock('./SchoolTimetableWorkspace', () => ({ default: () => <div>Timetable submodule</div> }));

const workspaceId = 'synthetic-school-workspace';
const members = [{ user_id: 'synthetic-admin', display_name: 'Synthetic Admin', username: 'admin', status: 'active', role: 'owner' }];

beforeEach(() => {
  mocks.authGetUser.mockResolvedValue({ data: { user: { id: 'synthetic-admin' } }, error: null });
  mocks.listWorkspaces.mockResolvedValue([{ workspace_id: workspaceId, name: 'Synthetic School', role: 'owner' }]);
  mocks.listMembers.mockResolvedValue(members);
  mocks.getSpace.mockResolvedValue({ industry_id: 'school', office_name: 'Synthetic School', country: 'TZ' });
  mocks.command.mockResolvedValue({});
  mocks.read.mockImplementation(async (_client, _workspaceId, resource) => {
    if (resource === 'bootstrap') return { role: 'school_admin', terms: [], classes: [], subjects: [] };
    if (resource === 'key_config') return { configured: false };
    return [];
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function renderSchool() {
  return render(<SchoolManagementWorkspace workspaceId={workspaceId} officeName="Synthetic School" country="TZ" accent="#55d5c3" />);
}

describe('School Management workspace', () => {
  it('loads owner modules and permitted datasets without reading browser-local records', async () => {
    window.localStorage.setItem('school-local-sentinel', 'leave-me-here');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    renderSchool();

    expect(await screen.findByRole('tab', { name: 'Fees' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Classes & staff' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Timetable' })).toBeTruthy();
    const resources = mocks.read.mock.calls.map((call) => call[2]);
    for (const resource of ['bootstrap','admissions','key_config','staff','class_staff','students','attendance','gradebook','fees','notices']) {
      expect(resources).toContain(resource);
    }
    expect(getItem).not.toHaveBeenCalled();
    expect(window.localStorage.getItem('school-local-sentinel')).toBe('leave-me-here');
    getItem.mockRestore();
  });

  it('limits Teacher reads to assigned operational modules and hides admissions, fees, and staff management', async () => {
    mocks.read.mockImplementation(async (_client, _workspaceId, resource) => {
      if (resource === 'bootstrap') return { role: 'teacher', terms: [], classes: [], subjects: [] };
      return [];
    });
    renderSchool();
    expect(await screen.findByRole('tab', { name: 'Attendance' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Fees' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Admissions' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Classes & staff' })).toBeNull();
    await waitFor(() => expect(mocks.read.mock.calls.some((call) => call[2] === 'attendance')).toBe(true));
    const resources = mocks.read.mock.calls.map((call) => call[2]);
    expect(resources).not.toContain('admissions');
    expect(resources).not.toContain('key_config');
    expect(resources).not.toContain('fees');
    expect(resources).not.toContain('staff');
  });
});
