import { describe, expect, it, vi } from 'vitest';
import { officeSchoolTimetableApi } from './officeSchoolTimetable';
import type { SchoolTimetableEntry, SchoolTimetableEvent, SchoolTimetableRpcClient } from './officeSchoolTimetable';

const workspaceId = 'school-team-1';
const entryId = 'entry-1';
const input = {
  workspaceId,
  academicYear: '2026/2027',
  termLabel: 'Term 1',
  classLabel: 'Form 1A',
  subjectLabel: 'Mathematics',
  teacherUserId: 'teacher-1',
  roomLabel: 'Room 4',
  dayOfWeek: 1,
  startMinute: 480,
  endMinute: 525,
};

function entryRow(overrides: Partial<SchoolTimetableEntry> = {}) {
  return {
    entry_id: entryId, workspace_id: workspaceId, ...input,
    academic_year: input.academicYear, term_label: input.termLabel,
    class_label: input.classLabel, subject_label: input.subjectLabel,
    teacher_user_id: input.teacherUserId, room_label: input.roomLabel,
    day_of_week: input.dayOfWeek, start_minute: input.startMinute, end_minute: input.endMinute,
    status: 'scheduled' as const, version: '3', created_by: 'admin-1',
    created_at: '2026-11-06T10:00:00Z', updated_by: 'admin-1', updated_at: '2026-11-06T10:00:00Z',
    ...overrides,
  };
}

function mockClient(rpc: ReturnType<typeof vi.fn>) {
  return { rpc } as unknown as SchoolTimetableRpcClient;
}

describe('Office School timetable RPC adapter', () => {
  it('lists a selected year/term with a bounded keyset cursor and parses versions', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [entryRow()], error: null });
    const entries = await officeSchoolTimetableApi.list(mockClient(rpc), workspaceId, {
      academicYear: ' 2026/2027 ', termLabel: ' Term 1 ', limit: 500,
      before: { createdAt: '2026-11-05T09:00:00Z', id: 'entry-older' },
    });

    expect(entries[0].version).toBe(3);
    expect(rpc).toHaveBeenCalledWith('office_school_timetable_list', {
      p_workspace_id: workspaceId, p_academic_year: '2026/2027', p_term_label: 'Term 1', p_limit: 100,
      p_before_created_at: '2026-11-05T09:00:00Z', p_before_entry_id: 'entry-older',
    });
  });

  it('sends idempotent create and version-checked update/cancel RPCs', async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: entryId, error: null })
      .mockResolvedValueOnce({ data: '4', error: null })
      .mockResolvedValueOnce({ data: 5, error: null });
    const client = mockClient(rpc);

    await expect(officeSchoolTimetableApi.create(client, { ...input, idempotencyKey: 'retry-key' })).resolves.toBe(entryId);
    await expect(officeSchoolTimetableApi.update(client, { ...input, entryId, expectedVersion: 3 })).resolves.toBe(4);
    await expect(officeSchoolTimetableApi.cancel(client, { workspaceId, entryId, expectedVersion: 4 })).resolves.toBe(5);

    expect(rpc).toHaveBeenNthCalledWith(1, 'office_school_timetable_create', {
      p_workspace_id: workspaceId, p_academic_year: input.academicYear, p_term_label: input.termLabel,
      p_class_label: input.classLabel, p_subject_label: input.subjectLabel, p_teacher_user_id: input.teacherUserId,
      p_room_label: input.roomLabel, p_day_of_week: 1, p_start_minute: 480, p_end_minute: 525,
      p_idempotency_key: 'retry-key',
    });
    expect(rpc).toHaveBeenNthCalledWith(2, 'office_school_timetable_update', {
      p_workspace_id: workspaceId, p_academic_year: input.academicYear, p_term_label: input.termLabel,
      p_class_label: input.classLabel, p_subject_label: input.subjectLabel, p_teacher_user_id: input.teacherUserId,
      p_room_label: input.roomLabel, p_day_of_week: 1, p_start_minute: 480, p_end_minute: 525,
      p_entry_id: entryId, p_expected_version: 3,
    });
    expect(rpc).toHaveBeenNthCalledWith(3, 'office_school_timetable_cancel', {
      p_workspace_id: workspaceId, p_entry_id: entryId, p_expected_version: 4,
    });
  });

  it('returns audited before/after snapshots through paged history', async () => {
    const event: SchoolTimetableEvent = {
      event_id: 'event-2', entry_id: entryId, actor_id: 'admin-1', event_kind: 'updated',
      schedule_version: 2, changed_fields: ['room_label'],
      before_state: { ...entryRow(), status: 'scheduled', version: 1 } as unknown as SchoolTimetableEvent['before_state'],
      after_state: { ...entryRow({ room_label: 'Room 5' }), status: 'scheduled', version: 2 } as unknown as SchoolTimetableEvent['after_state'],
      created_at: '2026-11-06T10:30:00Z',
    };
    const rpc = vi.fn().mockResolvedValue({ data: [{ ...event, schedule_version: '2' }], error: null });
    const events = await officeSchoolTimetableApi.listEvents(mockClient(rpc), workspaceId, entryId, {
      before: { createdAt: '2026-11-06T11:00:00Z', id: 'event-newer' },
    });

    expect(events[0].schedule_version).toBe(2);
    expect(events[0].before_state?.room_label).toBe('Room 4');
    expect(events[0].after_state.room_label).toBe('Room 5');
    expect(rpc).toHaveBeenCalledWith('office_school_timetable_list_events', {
      p_workspace_id: workspaceId, p_entry_id: entryId, p_limit: 50,
      p_before_created_at: '2026-11-06T11:00:00Z', p_before_event_id: 'event-newer',
    });
  });

  it('surfaces conflicts and rejects invalid database versions', async () => {
    const conflict = vi.fn().mockResolvedValue({ data: null, error: { message: 'Timetable conflict: this teacher is already scheduled during that interval' } });
    await expect(officeSchoolTimetableApi.create(mockClient(conflict), { ...input, idempotencyKey: 'retry-key' }))
      .rejects.toThrow(/Timetable conflict: this teacher/);

    const invalidVersion = vi.fn().mockResolvedValue({ data: [{ ...entryRow(), version: '9007199254740992' }], error: null });
    await expect(officeSchoolTimetableApi.list(mockClient(invalidVersion), workspaceId)).rejects.toThrow(/invalid version/i);
  });
});
