import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import {
  CalendarDays, Check, CircleAlert, Clock3, Edit3, History, LockKeyhole,
  Plus, RefreshCw, Save, ShieldAlert, Users, X,
} from 'lucide-react';
import { officeTeamApi } from './lib/officeTeamApi';
import type { OfficeMember, OfficeWorkspace } from './lib/officeTeamApi';
import { officeIndustryTasksApi } from './lib/officeIndustryTasks';
import {
  officeSchoolTimetableApi,
} from './lib/officeSchoolTimetable';
import type {
  SchoolTimetableCursor, SchoolTimetableEntry, SchoolTimetableEvent,
  SchoolTimetableInput, SchoolTimetableSnapshot,
} from './lib/officeSchoolTimetable';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import './industrySuites.css';

const PAGE_SIZE = 100;
const HISTORY_PAGE_SIZE = 50;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const emptyForm = {
  academicYear: '', termLabel: '', classLabel: '', subjectLabel: '',
  teacherUserId: '', roomLabel: '', dayOfWeek: '1', startTime: '08:00', endTime: '08:45',
};
type TimetableForm = typeof emptyForm;
type ViewStatus = 'loading' | 'signed-out' | 'not-member' | 'setup-required' | 'profile-conflict' | 'ready' | 'error';
type HistoryState = { events: SchoolTimetableEvent[]; loaded: boolean; loading: boolean };

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : 'The School timetable request could not be completed.';
  if (/office_school_timetable|PGRST202|could not find the function/i.test(message)) {
    return 'The School timetable service is not enabled in this deployment. No timetable changes were saved.';
  }
  return message;
}

function memberName(member: OfficeMember | undefined) {
  return member?.display_name?.trim() || (member?.username ? `@${member.username}` : 'Team member');
}

function cursorForEntry(entry: SchoolTimetableEntry): SchoolTimetableCursor {
  return { createdAt: entry.created_at, id: entry.entry_id };
}

function randomIdempotencyKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error('This browser cannot safely create a retry key. Try a current browser.');
  return globalThis.crypto.randomUUID();
}

function configMessage(status: string) {
  if (status === 'missing-url') return 'The Office Supabase URL is not configured in this deployment.';
  if (status === 'missing-public-key') return 'The Office public Supabase key is not configured in this deployment.';
  if (status === 'invalid-public-key') return 'Only the public anon/publishable key is accepted; secret keys are never used by this feature.';
  if (status === 'wrong-project') return 'This Office feature is restricted to the existing COCCE Super App project.';
  return 'The configured Office Supabase URL is invalid.';
}

function timeText(minute: number) {
  const hour = Math.floor(minute / 60).toString().padStart(2, '0');
  const minutes = (minute % 60).toString().padStart(2, '0');
  return `${hour}:${minutes}`;
}

function timeMinutes(value: string) {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function snapshotDescription(snapshot: SchoolTimetableSnapshot, memberById: Map<string, OfficeMember>) {
  const teacher = snapshot.teacher_user_id ? memberName(memberById.get(snapshot.teacher_user_id)) : 'Unassigned';
  return `${snapshot.academic_year} · ${snapshot.term_label} · ${DAYS[snapshot.day_of_week - 1]} ${timeText(snapshot.start_minute)}–${timeText(snapshot.end_minute)} · ${snapshot.class_label} · ${snapshot.subject_label} · ${teacher} · ${snapshot.room_label || 'No room'}`;
}

type SchoolTimetableCatalog = {
  terms: { academic_year: string; term_label: string; status?: string }[];
  classes: { class_id: string; class_label: string; status?: string }[];
  subjects: { subject_id: string; subject_label: string; status?: string }[];
  classStaff: { class_id: string; subject_id: string | null; user_id: string; assignment_kind: string; active: boolean }[];
};

export default function SchoolTimetableWorkspace({
  workspaceId, officeName, country, accent, catalog,
}: {
  workspaceId: string;
  officeName: string;
  country: string;
  accent: string;
  catalog: SchoolTimetableCatalog;
}) {
  const config = useMemo(() => resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment), []);
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const [status, setStatus] = useState<ViewStatus>('loading');
  const [space, setSpace] = useState<{ industry_id: string; office_name: string; country: string } | null>(null);
  const [workspace, setWorkspace] = useState<OfficeWorkspace | null>(null);
  const [members, setMembers] = useState<OfficeMember[]>([]);
  const [entries, setEntries] = useState<SchoolTimetableEntry[]>([]);
  const [cursor, setCursor] = useState<SchoolTimetableCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [form, setForm] = useState<TimetableForm>(emptyForm);
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [cancelingEntryId, setCancelingEntryId] = useState<string | null>(null);
  const [historyByEntry, setHistoryByEntry] = useState<Record<string, HistoryState>>({});
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [showCancelled, setShowCancelled] = useState(false);
  const formRef = useRef<HTMLElement>(null);
  const generationRef = useRef(0);
  const canWrite = workspace?.role === 'owner' || workspace?.role === 'admin';
  const activeMembers = useMemo(() => members.filter((member) => member.status === 'active'), [members]);
  const schoolYears = useMemo(() => [...new Set(catalog.terms
    .filter((term) => term.status !== 'closed' || (editingEntryId && term.academic_year === form.academicYear && term.term_label === form.termLabel))
    .map((term) => term.academic_year))].sort(), [catalog.terms, editingEntryId, form.academicYear, form.termLabel]);
  const schoolTerms = useMemo(() => catalog.terms.filter((term) => term.academic_year === form.academicYear
    && (term.status !== 'closed' || (editingEntryId && term.term_label === form.termLabel))),
  [catalog.terms, editingEntryId, form.academicYear, form.termLabel]);
  const selectedClass = catalog.classes.find((item) => item.class_label === form.classLabel);
  const selectedSubject = catalog.subjects.find((item) => item.subject_label === form.subjectLabel);
  const assignedTeacherIds = useMemo(() => new Set(catalog.classStaff.filter((assignment) => assignment.active
    && assignment.class_id === selectedClass?.class_id
    && (assignment.assignment_kind === 'class_teacher'
      || (assignment.assignment_kind === 'subject_teacher' && assignment.subject_id === selectedSubject?.subject_id)))
    .map((assignment) => assignment.user_id)), [catalog.classStaff, selectedClass?.class_id, selectedSubject?.subject_id]);
  const assignedTeachers = useMemo(() => activeMembers.filter((member) => assignedTeacherIds.has(member.user_id)), [activeMembers, assignedTeacherIds]);
  const memberById = useMemo(() => new Map(activeMembers.map((member) => [member.user_id, member])), [activeMembers]);
  const visibleEntries = useMemo(() => entries
    .filter((entry) => showCancelled || entry.status === 'scheduled')
    .sort((a, b) => a.day_of_week - b.day_of_week || a.start_minute - b.start_minute
      || a.academic_year.localeCompare(b.academic_year) || a.term_label.localeCompare(b.term_label)
      || a.class_label.localeCompare(b.class_label)), [entries, showCancelled]);

  const loadFirstPage = useCallback(async (currentClient = client) => {
    if (!currentClient) return;
    const page = await officeSchoolTimetableApi.list(currentClient, workspaceId, { limit: PAGE_SIZE });
    setEntries(page);
    setCursor(page.length ? cursorForEntry(page[page.length - 1]) : null);
    setHasMore(page.length === PAGE_SIZE);
    setHistoryByEntry({});
  }, [client, workspaceId]);

  const loadTeam = useCallback(async () => {
    const generation = ++generationRef.current;
    const isCurrent = () => generation === generationRef.current;
    if (config.status !== 'ready') {
      setStatus('error');
      setFeedback(configMessage(config.status));
      return;
    }
    if (!config.schemaReady || !client) {
      setStatus('error');
      setFeedback('Office Team is not enabled in this deployment. No School timetable data was changed.');
      return;
    }

    try {
      const { data: authData, error: authError } = await client.auth.getUser();
      if (!isCurrent()) return;
      if (authError) throw authError;
      if (!authData.user) { setStatus('signed-out'); return; }

      const workspaces = await officeTeamApi.listWorkspaces(client);
      if (!isCurrent()) return;
      const selectedWorkspace = workspaces.find((candidate) => candidate.workspace_id === workspaceId);
      if (!selectedWorkspace) { setStatus('not-member'); return; }

      const [teamMembers, sharedSpace] = await Promise.all([
        officeTeamApi.listMembers(client, workspaceId),
        officeIndustryTasksApi.getSpace(client, workspaceId),
      ]);
      if (!isCurrent()) return;
      setWorkspace(selectedWorkspace);
      setMembers(teamMembers);
      if (!sharedSpace) { setSpace(null); setStatus('setup-required'); return; }
      setSpace(sharedSpace);
      if (sharedSpace.industry_id !== 'school') { setStatus('profile-conflict'); return; }
      await loadFirstPage(client);
      if (!isCurrent()) return;
      setStatus('ready');
    } catch (error) {
      if (!isCurrent()) return;
      setStatus('error');
      setFeedback(friendlyError(error));
    }
  }, [client, config, loadFirstPage, workspaceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadTeam(); }, 0);
    return () => {
      window.clearTimeout(timer);
      generationRef.current += 1;
    };
  }, [loadTeam]);

  const refresh = () => {
    setStatus('loading');
    setFeedback('');
    setEntries([]);
    setSpace(null);
    setWorkspace(null);
    setMembers([]);
    setCursor(null);
    setHasMore(false);
    setHistoryByEntry({});
    void loadTeam();
  };

  const registerProfile = async () => {
    if (!client || !canWrite || registering) return;
    setRegistering(true);
    setFeedback('');
    try {
      const registered = await officeIndustryTasksApi.registerSpace(client, {
        workspaceId, industryId: 'school', officeName, country,
      });
      setSpace(registered);
      if (registered.industry_id !== 'school') { setStatus('profile-conflict'); return; }
      await loadFirstPage(client);
      setStatus('ready');
      setFeedback('An empty School profile was created. Device-local items were not imported.');
    } catch (error) {
      setFeedback(friendlyError(error));
    } finally {
      setRegistering(false);
    }
  };

  const loadMore = async () => {
    if (!client || !cursor || !hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await officeSchoolTimetableApi.list(client, workspaceId, { limit: PAGE_SIZE, before: cursor });
      setEntries((current) => {
        const known = new Set(current.map((entry) => entry.entry_id));
        return [...current, ...page.filter((entry) => !known.has(entry.entry_id))];
      });
      setCursor(page.length ? cursorForEntry(page[page.length - 1]) : cursor);
      setHasMore(page.length === PAGE_SIZE);
    } catch (error) {
      setFeedback(friendlyError(error));
    } finally {
      setLoadingMore(false);
    }
  };

  const submitEntry = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || status !== 'ready' || !canWrite || submitting) return;
    setSubmitting(true);
    setFeedback('');
    const input: SchoolTimetableInput = {
      workspaceId,
      academicYear: form.academicYear.trim(),
      termLabel: form.termLabel.trim(),
      classLabel: form.classLabel.trim(),
      subjectLabel: form.subjectLabel.trim(),
      teacherUserId: form.teacherUserId,
      roomLabel: form.roomLabel.trim(),
      dayOfWeek: Number(form.dayOfWeek),
      startMinute: timeMinutes(form.startTime),
      endMinute: timeMinutes(form.endTime),
    };
    try {
      if (editingEntryId) {
        const original = entries.find((entry) => entry.entry_id === editingEntryId);
        if (!original) throw new Error('This timetable entry is no longer loaded. Refresh and try again.');
        await officeSchoolTimetableApi.update(client, { ...input, entryId: editingEntryId, expectedVersion: original.version });
        setFeedback('Timetable entry updated.');
      } else {
        await officeSchoolTimetableApi.create(client, { ...input, idempotencyKey: randomIdempotencyKey() });
        setFeedback('Timetable entry added for this School Office Team.');
      }
      setForm(emptyForm);
      setEditingEntryId(null);
      await loadFirstPage(client);
    } catch (error) {
      setFeedback(friendlyError(error));
      if (error instanceof Error && /changed elsewhere|refresh before/i.test(error.message)) {
        try { await loadFirstPage(client); } catch { /* Keep the concurrency message visible. */ }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const beginEdit = (entry: SchoolTimetableEntry) => {
    if (!canWrite || entry.status !== 'scheduled') return;
    setEditingEntryId(entry.entry_id);
    setForm({
      academicYear: entry.academic_year,
      termLabel: entry.term_label,
      classLabel: entry.class_label,
      subjectLabel: entry.subject_label,
      teacherUserId: entry.teacher_user_id ?? '',
      roomLabel: entry.room_label,
      dayOfWeek: String(entry.day_of_week),
      startTime: timeText(entry.start_minute),
      endTime: timeText(entry.end_minute),
    });
    setFeedback('');
    window.setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
  };

  const cancelEdit = () => { setEditingEntryId(null); setForm(emptyForm); };

  const cancelEntry = async (entry: SchoolTimetableEntry) => {
    if (!client || !canWrite || entry.status !== 'scheduled' || cancelingEntryId) return;
    setCancelingEntryId(entry.entry_id);
    setFeedback('');
    try {
      await officeSchoolTimetableApi.cancel(client, {
        workspaceId, entryId: entry.entry_id, expectedVersion: entry.version,
      });
      await loadFirstPage(client);
      setFeedback('Timetable entry cancelled; its history is retained.');
    } catch (error) {
      setFeedback(friendlyError(error));
      if (error instanceof Error && /changed elsewhere|refresh before/i.test(error.message)) {
        try { await loadFirstPage(client); } catch { /* Keep the concurrency message visible. */ }
      }
    } finally {
      setCancelingEntryId(null);
    }
  };

  const loadHistory = async (entryId: string) => {
    if (!client || historyBusyId) return;
    const current = historyByEntry[entryId];
    if (current?.loaded) return;
    setHistoryBusyId(entryId);
    setHistoryByEntry((previous) => ({
      ...previous,
      [entryId]: { events: current?.events ?? [], loaded: current?.loaded ?? false, loading: true },
    }));
    try {
      const events = await officeSchoolTimetableApi.listEvents(client, workspaceId, entryId, { limit: HISTORY_PAGE_SIZE });
      setHistoryByEntry((previous) => ({ ...previous, [entryId]: { events, loaded: true, loading: false } }));
    } catch (error) {
      setFeedback(friendlyError(error));
      setHistoryByEntry((previous) => ({ ...previous, [entryId]: { ...(previous[entryId] ?? { events: [], loaded: false }), loading: false } }));
    } finally {
      setHistoryBusyId(null);
    }
  };

  const scheduledCount = entries.filter((entry) => entry.status === 'scheduled').length;
  const cancelledCount = entries.length - scheduledCount;
  const renderEntry = (entry: SchoolTimetableEntry) => {
    const entryHistory = historyByEntry[entry.entry_id];
    return <article className={`school-timetable-card ${entry.status === 'cancelled' ? 'is-cancelled' : ''}`} key={entry.entry_id}>
      <div className="school-timetable-card-time"><Clock3 size={13} /><strong>{timeText(entry.start_minute)}–{timeText(entry.end_minute)}</strong><span>{entry.academic_year} · {entry.term_label}</span></div>
      <div className="school-timetable-card-main">
        <div className="school-timetable-card-tags"><span>{entry.class_label}</span><span>{entry.subject_label}</span>{entry.room_label && <span>Room {entry.room_label}</span>}{entry.status === 'cancelled' && <span className="school-timetable-cancelled-tag">Cancelled</span>}</div>
        <strong className="school-timetable-card-teacher"><Users size={13} />{entry.teacher_user_id ? memberName(memberById.get(entry.teacher_user_id)) : 'Former team member · reassign needed'}</strong>
        <span className="school-timetable-version">v{entry.version}</span>
      </div>
      <details className="industry-history school-timetable-history" onToggle={(event) => { if (event.currentTarget.open && !entryHistory?.loaded) void loadHistory(entry.entry_id); }}>
        <summary><History size={12} /> Schedule history{entryHistory?.loaded ? ` · ${entryHistory.events.length}` : ''}</summary>
        {entryHistory?.loading && <p className="industry-history-loading">Loading history…</p>}
        {entryHistory?.events.map((audit) => <div className="school-timetable-audit" key={audit.event_id}>
          <strong>{audit.event_kind === 'created' ? 'Created' : audit.event_kind === 'cancelled' ? 'Cancelled' : `Updated · ${audit.changed_fields.join(', ')}`}</strong>
          <small>{audit.actor_id ? memberName(memberById.get(audit.actor_id)) : 'Team member'} · v{audit.schedule_version} · {new Date(audit.created_at).toLocaleString()}</small>
          {audit.before_state && <span><b>Before:</b> {snapshotDescription(audit.before_state, memberById)}</span>}
          <span><b>After:</b> {snapshotDescription(audit.after_state, memberById)}</span>
        </div>)}
        {entryHistory?.loaded && !entryHistory.events.length && <p className="industry-history-loading">No history returned.</p>}
      </details>
      {canWrite && entry.status === 'scheduled' && <div className="industry-card-actions school-timetable-actions">
        <button type="button" className="industry-edit-button" aria-label={`Edit ${entry.class_label} ${entry.subject_label} ${DAYS[entry.day_of_week - 1]} ${timeText(entry.start_minute)}`} onClick={() => beginEdit(entry)}><Edit3 size={13} /> Edit</button>
        <button type="button" className="industry-move-button" aria-label={`Cancel ${entry.class_label} ${entry.subject_label} ${DAYS[entry.day_of_week - 1]} ${timeText(entry.start_minute)}`} disabled={cancelingEntryId === entry.entry_id} onClick={() => void cancelEntry(entry)}>{cancelingEntryId === entry.entry_id ? 'Cancelling…' : 'Cancel slot'}</button>
      </div>}
    </article>;
  };

  return <section className="industry-shared-workspace school-timetable-workspace" style={{ '--industry-accent': accent } as CSSProperties} aria-label="School shared timetable">
    <div className="industry-shared-boundary" role="note">
      <ShieldAlert size={18} />
      <div><strong>School timetable · no learner records</strong><span>Only class, subject, active team teacher, room and weekly times are stored. Never enter learner or guardian names, IDs, attendance, grades, fees, or safeguarding details. This is not a student information system or official school records service; no NECTA/MoEST connection or document sync is provided. Device-local items are separate and are never copied here.</span></div>
    </div>

    {feedback && <div className="industry-shared-feedback" role={/could not|invalid|denied|changed elsewhere|refresh|not loaded|unavailable|not configured|not enabled|not returned|conflict|service/i.test(feedback) ? 'alert' : 'status'}><CircleAlert size={15} />{feedback}<button type="button" aria-label="Dismiss message" onClick={() => setFeedback('')}><X size={14} /></button></div>}

    <header className="industry-shared-heading">
      <div><span className="eyebrow">SCHOOL · WEEKLY SCHEDULE</span><h2>{space?.office_name ?? officeName}</h2><p>{space?.country ?? country} · shared with active Office Team members</p></div>
      <button type="button" className="button-secondary" onClick={refresh} disabled={status === 'loading'}><RefreshCw size={14} /> Refresh</button>
    </header>

    {status === 'loading' && <div className="industry-shared-state" role="status"><RefreshCw size={16} className="industry-spin" /> Checking Office sign-in, team membership, and School profile…</div>}
    {status === 'signed-out' && <div className="industry-shared-state" role="status"><Users size={17} /><div><strong>Sign in to Office Team</strong><span>Open the linked team above, sign in to your existing COCCE account, then return here. No timetable data was changed.</span></div></div>}
    {status === 'not-member' && <div className="industry-shared-state is-alert" role="alert"><CircleAlert size={17} /><div><strong>This School team is not available to this account</strong><span>Check the signed-in Office account or ask to join this team. The server has not returned timetable entries.</span></div></div>}
    {status === 'error' && <div className="industry-shared-state is-alert" role="alert"><CircleAlert size={17} /><div><strong>School timetable is unavailable</strong><span>{feedback || 'The Office Team connection is not ready. Device-local preview records remain separate.'}</span></div></div>}

    {status === 'setup-required' && <div className="industry-shared-setup glass-card">
      <div className="industry-shared-setup-icon"><CalendarDays size={20} /></div>
      <div><span className="eyebrow">EMPTY SCHOOL PROFILE</span><h3>Connect this team to Schools</h3><p>This creates only an empty School profile for the linked Office Team. Browser-local preview items remain local and will not be imported. {canWrite ? 'Only an owner or admin can set it up.' : 'Ask the Office Team owner or admin to set it up.'}</p></div>
      <button type="button" className="button-primary" onClick={() => void registerProfile()} disabled={!canWrite || registering}>{registering ? <><RefreshCw size={14} className="industry-spin" /> Setting up…</> : <><Plus size={15} /> Create empty School profile</>}</button>
    </div>}

    {status === 'profile-conflict' && <div className="industry-shared-state is-alert" role="alert"><CircleAlert size={17} /><div><strong>This team is set up for a different industry</strong><span>The shared profile is “{space?.industry_id}”, not “school”. It has not been changed, and no timetable entries were read.</span></div></div>}

    {status === 'ready' && space && <>
      {(space.office_name !== officeName || space.country !== country) && <div className="industry-shared-profile-note" role="note">The shared team uses its existing profile “{space.office_name}” ({space.country}). Your device-local office profile remains unchanged.</div>}
      <div className="industry-shared-metrics" aria-label="School timetable summary">
        <div className="industry-metric-card industry-metric-total"><span>Loaded slots</span><strong>{entries.length}</strong><small>{hasMore ? 'Page loaded · more available' : 'All available on this page'}</small></div>
        <div className="industry-metric-card industry-metric-active"><span>Scheduled</span><strong>{scheduledCount}</strong><small>Weekly recurring slots</small></div>
        <div className="industry-metric-card industry-metric-closed"><span>Cancelled</span><strong>{cancelledCount}</strong><small>Retained for history</small></div>
      </div>
      <div className="school-timetable-toolbar">
        <div><span className="eyebrow">WEEKLY VIEW</span><h3>Classes, teachers and rooms</h3></div>
        <label className="school-show-cancelled"><input type="checkbox" checked={showCancelled} onChange={(event) => setShowCancelled(event.target.checked)} /> Show cancelled slots</label>
      </div>
      <div className="school-timetable-grid">
        {DAYS.map((day, index) => {
          const dayEntries = visibleEntries.filter((entry) => entry.day_of_week === index + 1);
          return <section className="school-timetable-day" key={day} aria-label={`${day} timetable`}>
            <div className="school-timetable-day-heading"><span>{day.slice(0, 3).toUpperCase()}</span><strong>{day}</strong><small>{dayEntries.length} {dayEntries.length === 1 ? 'slot' : 'slots'}</small></div>
            {dayEntries.length ? dayEntries.map(renderEntry) : <p className="school-timetable-empty">No slots loaded</p>}
          </section>;
        })}
      </div>
      {hasMore && <div className="industry-shared-load-more"><span>Only the first {entries.length} recently created slots are loaded.</span><button type="button" className="button-secondary" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <><RefreshCw size={14} className="industry-spin" /> Loading…</> : 'Load next 100 slots'}</button></div>}

      <div className="school-timetable-bottom">
        <section ref={formRef} className="industry-add-panel glass-card" aria-labelledby="school-timetable-form-title">
          <div className="industry-side-heading"><span className="industry-side-icon">{editingEntryId ? <Save size={17} /> : <Plus size={17} />}</span><div><span className="eyebrow">{editingEntryId ? 'EDIT WEEKLY SLOT' : 'ADD TO SCHOOL'}</span><h3 id="school-timetable-form-title">{editingEntryId ? 'Update timetable slot' : 'New timetable slot'}</h3></div></div>
          {canWrite ? <form className="industry-record-form school-timetable-form" onSubmit={submitEntry}>
            <div className="school-timetable-form-row"><label>Academic year<select value={form.academicYear} onChange={(event) => setForm((current) => { const year = event.target.value; const matching = catalog.terms.filter((term) => term.academic_year === year); return { ...current, academicYear: year, termLabel: matching.some((term) => term.term_label === current.termLabel) ? current.termLabel : matching[0]?.term_label ?? '' }; })} required><option value="">Choose year</option>{schoolYears.map((year) => <option key={year} value={year}>{year}</option>)}</select></label><label>Term<select value={form.termLabel} onChange={(event) => setForm((current) => ({ ...current, termLabel: event.target.value }))} required><option value="">Choose term</option>{schoolTerms.map((term) => <option key={`${term.academic_year}-${term.term_label}`} value={term.term_label}>{term.term_label}</option>)}</select></label></div>
            <div className="school-timetable-form-row"><label>Class or stream<select value={form.classLabel} onChange={(event) => setForm((current) => ({ ...current, classLabel: event.target.value, teacherUserId: '' }))} required><option value="">Choose class</option>{catalog.classes.map((item) => <option key={item.class_label} value={item.class_label}>{item.class_label}</option>)}</select></label><label>Subject<select value={form.subjectLabel} onChange={(event) => setForm((current) => ({ ...current, subjectLabel: event.target.value, teacherUserId: '' }))} required><option value="">Choose subject</option>{catalog.subjects.map((item) => <option key={item.subject_label} value={item.subject_label}>{item.subject_label}</option>)}</select></label></div>
            <label>Teacher · assigned for this class/subject<select value={form.teacherUserId} onChange={(event) => setForm((current) => ({ ...current, teacherUserId: event.target.value }))} required><option value="">Choose an assigned teacher</option>{assignedTeachers.map((member) => <option value={member.user_id} key={member.user_id}>{memberName(member)}</option>)}</select></label>
            <label>Room or venue<input value={form.roomLabel} onChange={(event) => setForm((current) => ({ ...current, roomLabel: event.target.value }))} maxLength={80} placeholder="Optional · e.g. Room 4" /></label>
            <div className="school-timetable-form-row"><label>Weekday<select value={form.dayOfWeek} onChange={(event) => setForm((current) => ({ ...current, dayOfWeek: event.target.value }))}>{DAYS.map((day, index) => <option value={index + 1} key={day}>{day}</option>)}</select></label><label>Start time<input type="time" value={form.startTime} onChange={(event) => setForm((current) => ({ ...current, startTime: event.target.value }))} required /></label><label>End time<input type="time" value={form.endTime} onChange={(event) => setForm((current) => ({ ...current, endTime: event.target.value }))} required /></label></div>
            <div className="industry-shared-form-actions">{editingEntryId && <button type="button" className="button-secondary" onClick={cancelEdit}>Cancel edit</button>}<button type="submit" className="button-primary industry-save-button" disabled={submitting || !form.academicYear.trim() || !form.classLabel.trim() || !form.subjectLabel.trim() || !form.teacherUserId}>{submitting ? <><RefreshCw size={14} className="industry-spin" /> Saving…</> : <><Check size={15} /> {editingEntryId ? 'Save timetable changes' : 'Create timetable slot'}</>}</button></div>
          </form> : <div className="school-timetable-readonly"><LockKeyhole size={16} /><span>Only an active Office Team owner or administrator can change the timetable. You can view the weekly schedule and audit history.</span></div>}
          <p className="industry-stage-help"><Clock3 size={13} /> Times are weekly wall-clock labels. Assign a class/subject teacher in School setup first; server checks prevent class, teacher and room overlaps in the same year and term.</p>
        </section>
        <aside className="industry-privacy-card glass-card"><div className="industry-privacy-icon"><ShieldAlert size={18} /></div><strong>Keep School data minimal</strong><p>Use only class/subject labels and team teacher assignments. No learners, guardians, attendance, grades, payments or safeguarding details. The weekly timetable does not handle holidays, date exceptions, timezone conversion or official submissions.</p></aside>
      </div>
    </>}
  </section>;
}
