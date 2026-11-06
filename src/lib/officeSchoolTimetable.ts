import type { SupabaseClient } from '@supabase/supabase-js';

export type SchoolTimetableStatus = 'scheduled' | 'cancelled';
export type SchoolTimetableChangedField =
  | 'academic_year' | 'term_label' | 'class_label' | 'subject_label'
  | 'teacher_user_id' | 'room_label' | 'day_of_week'
  | 'start_minute' | 'end_minute' | 'status';
export type SchoolTimetableSnapshot = {
  academic_year: string;
  term_label: string;
  class_label: string;
  subject_label: string;
  teacher_user_id: string | null;
  room_label: string;
  day_of_week: number;
  start_minute: number;
  end_minute: number;
  status: SchoolTimetableStatus;
};
export type SchoolTimetableCursor = { createdAt: string; id: string };

export interface SchoolTimetableEntry extends SchoolTimetableSnapshot {
  entry_id: string;
  workspace_id: string;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface SchoolTimetableEvent {
  event_id: string;
  entry_id: string;
  actor_id: string | null;
  event_kind: 'created' | 'updated' | 'cancelled';
  schedule_version: number;
  changed_fields: SchoolTimetableChangedField[];
  before_state: SchoolTimetableSnapshot | null;
  after_state: SchoolTimetableSnapshot;
  created_at: string;
}

export interface SchoolTimetableInput {
  workspaceId: string;
  academicYear: string;
  termLabel: string;
  classLabel: string;
  subjectLabel: string;
  teacherUserId: string;
  roomLabel: string;
  dayOfWeek: number;
  startMinute: number;
  endMinute: number;
}

export interface SchoolTimetableRpcClient {
  rpc: (name: string, params?: Record<string, unknown>) => Promise<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

async function rpc<T>(client: SchoolTimetableRpcClient | SupabaseClient, name: string, params?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(name, params) as { data: T | null; error: { message: string } | null };
  if (error) throw new Error(error.message);
  return data as T;
}

function rows<T>(value: unknown): T[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error('The School timetable response was not a row list.');
  return value as T[];
}

function safeVersion(value: number | string): number {
  const version = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('The School timetable response contained an invalid version.');
  return version;
}

function withEntryVersion(entry: Omit<SchoolTimetableEntry, 'version'> & { version: number | string }): SchoolTimetableEntry {
  return { ...entry, version: safeVersion(entry.version) };
}

function withEventVersion(event: Omit<SchoolTimetableEvent, 'schedule_version'> & { schedule_version: number | string }): SchoolTimetableEvent {
  return { ...event, schedule_version: safeVersion(event.schedule_version) };
}

function inputParams(input: SchoolTimetableInput) {
  return {
    p_workspace_id: input.workspaceId,
    p_academic_year: input.academicYear,
    p_term_label: input.termLabel,
    p_class_label: input.classLabel,
    p_subject_label: input.subjectLabel,
    p_teacher_user_id: input.teacherUserId,
    p_room_label: input.roomLabel,
    p_day_of_week: input.dayOfWeek,
    p_start_minute: input.startMinute,
    p_end_minute: input.endMinute,
  };
}

export const officeSchoolTimetableApi = {
  async list(client: SchoolTimetableRpcClient | SupabaseClient, workspaceId: string, options: {
    academicYear?: string | null;
    termLabel?: string | null;
    limit?: number;
    before?: SchoolTimetableCursor | null;
  } = {}): Promise<SchoolTimetableEntry[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 100)));
    const result = await rpc<unknown>(client, 'office_school_timetable_list', {
      p_workspace_id: workspaceId,
      p_academic_year: options.academicYear?.trim() || null,
      p_term_label: options.termLabel?.trim() || null,
      p_limit: limit,
      p_before_created_at: options.before?.createdAt ?? null,
      p_before_entry_id: options.before?.id ?? null,
    });
    return rows<Omit<SchoolTimetableEntry, 'version'> & { version: number | string }>(result).map(withEntryVersion);
  },

  async create(client: SchoolTimetableRpcClient | SupabaseClient, input: SchoolTimetableInput & { idempotencyKey: string }): Promise<string> {
    return rpc<string>(client, 'office_school_timetable_create', {
      ...inputParams(input),
      p_idempotency_key: input.idempotencyKey,
    });
  },

  async update(client: SchoolTimetableRpcClient | SupabaseClient, input: SchoolTimetableInput & {
    entryId: string;
    expectedVersion: number;
  }): Promise<number> {
    const result = await rpc<number | string>(client, 'office_school_timetable_update', {
      ...inputParams(input),
      p_entry_id: input.entryId,
      p_expected_version: input.expectedVersion,
    });
    return safeVersion(result);
  },

  async cancel(client: SchoolTimetableRpcClient | SupabaseClient, input: {
    workspaceId: string;
    entryId: string;
    expectedVersion: number;
  }): Promise<number> {
    const result = await rpc<number | string>(client, 'office_school_timetable_cancel', {
      p_workspace_id: input.workspaceId,
      p_entry_id: input.entryId,
      p_expected_version: input.expectedVersion,
    });
    return safeVersion(result);
  },

  async listEvents(client: SchoolTimetableRpcClient | SupabaseClient, workspaceId: string, entryId: string, options: {
    limit?: number;
    before?: SchoolTimetableCursor | null;
  } = {}): Promise<SchoolTimetableEvent[]> {
    const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 50)));
    const result = await rpc<unknown>(client, 'office_school_timetable_list_events', {
      p_workspace_id: workspaceId,
      p_entry_id: entryId,
      p_limit: limit,
      p_before_created_at: options.before?.createdAt ?? null,
      p_before_event_id: options.before?.id ?? null,
    });
    return rows<Omit<SchoolTimetableEvent, 'schedule_version'> & { schedule_version: number | string }>(result)
      .map(withEventVersion);
  },
};
