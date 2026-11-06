// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SchoolTimetableWorkspace from './SchoolTimetableWorkspace';
import type { SchoolTimetableEntry, SchoolTimetableEvent } from './lib/officeSchoolTimetable';

const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  listWorkspaces: vi.fn(),
  listMembers: vi.fn(),
  getSpace: vi.fn(),
  registerSpace: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  cancel: vi.fn(),
  listEvents: vi.fn(),
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
vi.mock('./lib/officeSchoolTimetable', () => ({
  officeSchoolTimetableApi: {
    list: mocks.list, create: mocks.create, update: mocks.update,
    cancel: mocks.cancel, listEvents: mocks.listEvents,
  },
}));

const workspaceId = 'school-team-1';
const workspace = { workspace_id: workspaceId, name: 'Kijiji School · School', role: 'owner' as const, created_at: '2026-11-06T09:00:00Z' };
const owner = {
  user_id: 'owner-1', username: 'owner', display_name: 'School Owner', avatar_url: null, is_vip: false,
  vip_expires_at: null, role: 'owner' as const, status: 'active' as const, joined_at: '2026-11-06T09:00:00Z',
};
const profile = { workspace_id: workspaceId, industry_id: 'school', office_name: 'Kijiji School', country: 'Tanzania', created_at: '2026-11-06T10:00:00Z' };
const entry: SchoolTimetableEntry = {
  entry_id: 'slot-1', workspace_id: workspaceId, academic_year: '2026/2027', term_label: 'Term 1',
  class_label: 'Form 1A', subject_label: 'Mathematics', teacher_user_id: 'owner-1', room_label: 'Room 4',
  day_of_week: 1, start_minute: 480, end_minute: 525, status: 'scheduled', version: 1,
  created_by: 'owner-1', created_at: '2026-11-06T10:00:00Z', updated_by: 'owner-1', updated_at: '2026-11-06T10:00:00Z',
};
const renderSchool = () => render(<SchoolTimetableWorkspace
  workspaceId={workspaceId} officeName="Kijiji School" country="Tanzania" accent="#8e9cff"
  catalog={{ terms: [{ academic_year: '2026/2027', term_label: 'Term 1', status: 'open' }], classes: [{ class_id: 'class-1', class_label: 'Form 1A', status: 'active' }], subjects: [{ subject_id: 'subject-1', subject_label: 'Mathematics', status: 'active' }], classStaff: [{ class_id: 'class-1', subject_id: 'subject-1', user_id: 'owner-1', assignment_kind: 'subject_teacher', active: true }] }}
/>);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('crypto', { randomUUID: () => 'retry-key' });
  mocks.getUser.mockResolvedValue({ data: { user: { id: 'owner-1' } }, error: null });
  mocks.listWorkspaces.mockResolvedValue([workspace]);
  mocks.listMembers.mockResolvedValue([owner]);
  mocks.getSpace.mockResolvedValue(profile);
  mocks.registerSpace.mockResolvedValue(profile);
  mocks.list.mockResolvedValue([]);
  mocks.create.mockResolvedValue('slot-1');
  mocks.update.mockResolvedValue(2);
  mocks.cancel.mockResolvedValue(2);
  mocks.listEvents.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('School shared timetable workspace', () => {
  it('reads only the linked authenticated School team and shows the no-learner boundary', async () => {
    const localBytes = JSON.stringify({ version: 1, offices: [{ items: [{ title: 'Local only' }] }] });
    window.localStorage.setItem('cocce-office-industry-workspaces-v1', localBytes);
    mocks.list.mockResolvedValue([entry]);
    renderSchool();

    expect((await screen.findAllByText('Mathematics')).length).toBeGreaterThan(0);
    expect(screen.getByRole('note').textContent).toMatch(/never enter learner or guardian names/i);
    expect(screen.getAllByText('School Owner').length).toBeGreaterThan(0);
    expect(mocks.getSpace).toHaveBeenCalledWith(expect.anything(), workspaceId);
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), workspaceId, { limit: 100 });
    expect(window.localStorage.getItem('cocce-office-industry-workspaces-v1')).toBe(localBytes);
  });

  it('requires an explicit empty School profile setup and never imports browser-local items', async () => {
    const localBytes = JSON.stringify({ version: 1, offices: [{ items: [{ title: 'Private local preview' }] }] });
    window.localStorage.setItem('cocce-office-industry-workspaces-v1', localBytes);
    mocks.getSpace.mockResolvedValue(null);
    renderSchool();

    expect(await screen.findByRole('heading', { name: 'Connect this team to Schools' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create empty School profile' }));
    await waitFor(() => expect(mocks.registerSpace).toHaveBeenCalledWith(expect.anything(), {
      workspaceId, industryId: 'school', officeName: 'Kijiji School', country: 'Tanzania',
    }));
    expect(await screen.findByText('An empty School profile was created. Device-local items were not imported.')).toBeTruthy();
    expect(window.localStorage.getItem('cocce-office-industry-workspaces-v1')).toBe(localBytes);
  });

  it('does not read timetable entries for a user who is not a member of the linked team', async () => {
    mocks.listWorkspaces.mockResolvedValue([]);
    renderSchool();

    expect((await screen.findByRole('alert')).textContent).toMatch(/not available to this account/i);
    expect(mocks.getSpace).not.toHaveBeenCalled();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it('keeps timetable mutation controls read-only for ordinary members', async () => {
    mocks.listWorkspaces.mockResolvedValue([{ ...workspace, role: 'member' }]);
    mocks.list.mockResolvedValue([entry]);
    renderSchool();

    expect((await screen.findAllByText('Mathematics')).length).toBeGreaterThan(0);
    expect(screen.getByText(/only an active Office Team owner or administrator can change the timetable/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Create timetable slot' })).toBeNull();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('creates a server-backed slot and keeps browser-local preview bytes unchanged', async () => {
    const localBytes = JSON.stringify({ version: 1, offices: [{ items: [{ title: 'Not copied' }] }] });
    window.localStorage.setItem('cocce-office-industry-workspaces-v1', localBytes);
    mocks.list.mockResolvedValueOnce([]).mockResolvedValueOnce([entry]);
    renderSchool();

    expect(await screen.findByRole('heading', { name: 'New timetable slot' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Academic year'), { target: { value: '2026/2027' } });
    fireEvent.change(screen.getByLabelText('Term'), { target: { value: 'Term 1' } });
    fireEvent.change(screen.getByLabelText('Class or stream'), { target: { value: 'Form 1A' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Mathematics' } });
    fireEvent.change(screen.getByLabelText('Teacher · assigned for this class/subject'), { target: { value: 'owner-1' } });
    fireEvent.change(screen.getByLabelText('Room or venue'), { target: { value: 'Room 4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create timetable slot' }));

    await waitFor(() => expect(mocks.create).toHaveBeenCalledWith(expect.anything(), {
      workspaceId, academicYear: '2026/2027', termLabel: 'Term 1', classLabel: 'Form 1A',
      subjectLabel: 'Mathematics', teacherUserId: 'owner-1', roomLabel: 'Room 4',
      dayOfWeek: 1, startMinute: 480, endMinute: 525, idempotencyKey: 'retry-key',
    }));
    expect(await screen.findByText('Timetable entry added for this School Office Team.')).toBeTruthy();
    expect(window.localStorage.getItem('cocce-office-industry-workspaces-v1')).toBe(localBytes);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it('shows server conflict errors without optimistic local scheduling', async () => {
    mocks.create.mockRejectedValue(new Error('Timetable conflict: this teacher is already scheduled during that interval'));
    renderSchool();
    await screen.findByRole('heading', { name: 'New timetable slot' });
    fireEvent.change(screen.getByLabelText('Academic year'), { target: { value: '2026/2027' } });
    fireEvent.change(screen.getByLabelText('Term'), { target: { value: 'Term 1' } });
    fireEvent.change(screen.getByLabelText('Class or stream'), { target: { value: 'Form 1A' } });
    fireEvent.change(screen.getByLabelText('Subject'), { target: { value: 'Mathematics' } });
    fireEvent.change(screen.getByLabelText('Teacher · assigned for this class/subject'), { target: { value: 'owner-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create timetable slot' }));

    expect((await screen.findByRole('alert')).textContent).toContain('Timetable conflict: this teacher');
    expect(document.querySelector('.school-timetable-card')).toBeNull();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });

  it('renders immutable before/after audit snapshots on demand', async () => {
    const previous = { ...entry, room_label: 'Room 3' };
    const updated = { ...entry, room_label: 'Room 4', version: 2 };
    const event: SchoolTimetableEvent = {
      event_id: 'event-2', entry_id: entry.entry_id, actor_id: 'owner-1', event_kind: 'updated',
      schedule_version: 2, changed_fields: ['room_label'], before_state: previous,
      after_state: updated, created_at: '2026-11-06T10:30:00Z',
    };
    mocks.list.mockResolvedValue([entry]);
    mocks.listEvents.mockResolvedValue([event]);
    const { container } = renderSchool();
    expect((await screen.findAllByText('Mathematics')).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText(/Schedule history/));

    await waitFor(() => expect(container.querySelector('.school-timetable-audit')?.textContent).toContain('Room 3'));
    expect(container.querySelector('.school-timetable-audit')?.textContent).toContain('Room 4');
    expect(mocks.listEvents).toHaveBeenCalledWith(expect.anything(), workspaceId, entry.entry_id, { limit: 50 });
  });
});
