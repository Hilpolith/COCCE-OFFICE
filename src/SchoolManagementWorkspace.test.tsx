// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  it('builds the overview from loaded operational state without exposing PII', async () => {
    mocks.read.mockImplementation(async (_client, _workspaceId, resource) => {
      if (resource === 'bootstrap') return {
        role: 'school_admin',
        terms: [{ term_id: 'term-1', academic_year: '2026/27', term_label: 'Term 1', start_date: '', end_date: '', status: 'open' }],
        classes: [{ class_id: 'class-1', class_label: 'Form 1 A', level_label: 'Form 1', stream_label: 'A', capacity: 40, status: 'active' }],
        subjects: [],
      };
      if (resource === 'admissions') return [{ application_id: 'app-1', person_id: 'person-1', application_code: 'APP-001', term_id: 'term-1', academic_year: '2026/27', term_label: 'Term 1', requested_class_id: 'class-1', class_label: 'Form 1 A', status: 'submitted', version: 1, created_at: '' }];
      if (resource === 'attendance') return [{ session_id: 'session-1', class_id: 'class-1', class_label: 'Form 1 A', term_id: 'term-1', session_date: '2026-11-07', slot_label: 'Daily', status: 'open', marks: [{ student_id: 'student-1', student_code: 'ST-001', attendance_status: 'present' }] }];
      if (resource === 'key_config') return { configured: false };
      return [];
    });
    renderSchool();

    expect(await screen.findByText('Learner records')).toBeTruthy();
    expect(screen.getByText('Applications')).toBeTruthy();
    expect(screen.getByText('Marks by status')).toBeTruthy();
    expect(screen.getByText('Review admissions queue')).toBeTruthy();
    expect(screen.queryByText('Amina Guardian Secret')).toBeNull();
    expect(screen.queryByText('2020-01-01')).toBeNull();
  });

  it('loads subsequent student register pages from the server without replacing the first page', async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      student_id: `student-${index + 1}`, person_id: `person-${index + 1}`,
      student_code: `ST-${String(index + 1).padStart(3, '0')}`, status: 'active',
      class_id: null, class_label: null, term_id: null, academic_year: null, term_label: null,
    }));
    const nextPage = [{
      student_id: 'student-201', person_id: 'person-201', student_code: 'ST-201', status: 'active',
      class_id: null, class_label: null, term_id: null, academic_year: null, term_label: null,
    }];
    mocks.read.mockImplementation(async (_client, _workspaceId, resource, _filter, _limit, offset) => {
      if (resource === 'bootstrap') return { role: 'school_admin', terms: [], classes: [], subjects: [] };
      if (resource === 'key_config') return { configured: false };
      if (resource === 'students') return offset === 200 ? nextPage : firstPage;
      return [];
    });

    renderSchool();
    fireEvent.click(await screen.findByRole('tab', { name: 'Students' }));
    expect(await screen.findByText('ST-001')).toBeTruthy();
    const loadMore = await screen.findByRole('button', { name: 'Load next 200 learners' });
    fireEvent.click(loadMore);

    expect(await screen.findByText('ST-201')).toBeTruthy();
    expect(screen.getByText('ST-001')).toBeTruthy();
    expect(mocks.read).toHaveBeenCalledWith(expect.anything(), workspaceId, 'students', {}, 200, 200);
    expect(screen.queryByRole('button', { name: 'Load next 200 learners' })).toBeNull();
  });

  it('labels official services as manual and unconnected, and quick actions use real tabs', async () => {
    mocks.read.mockImplementation(async (_client, _workspaceId, resource) => {
      if (resource === 'bootstrap') return { role: 'school_admin', terms: [], classes: [], subjects: [] };
      if (resource === 'admissions') return [{ application_id: 'app-1', person_id: 'person-1', application_code: 'APP-001', term_id: 'term-1', academic_year: '2026/27', term_label: 'Term 1', requested_class_id: 'class-1', class_label: 'Form 1 A', status: 'submitted', version: 1, created_at: '' }];
      if (resource === 'key_config') return { configured: false };
      return [];
    });
    renderSchool();

    expect(await screen.findByText(/official manual services/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /ESMIS.*Manual link.*unconnected/i }).getAttribute('href')).toBe('https://esmis.moe.go.tz/');
    expect(screen.getByRole('link', { name: /SQAS.*Manual link.*unconnected/i }).getAttribute('href')).toBe('https://sqas.moe.go.tz/');
    expect(screen.getByRole('link', { name: /NECTA.*Manual link.*unconnected/i }).getAttribute('href')).toBe('https://www.necta.go.tz/');
    fireEvent.click(screen.getByRole('button', { name: /Review admissions queue/ }));
    expect(screen.getByRole('tab', { name: 'Admissions' }).getAttribute('aria-selected')).toBe('true');
  });

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
