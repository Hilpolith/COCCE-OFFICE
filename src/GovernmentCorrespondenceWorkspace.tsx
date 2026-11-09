import OfficeSuiteAiAction from './OfficeSuiteAiAction';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import {
  Archive, ArrowRight, CalendarDays, Check, CircleAlert, FileText, History, LockKeyhole,
  Mail, Plus, RefreshCw, Send, Settings2, ShieldAlert, Users, X,
} from 'lucide-react';
import GovernmentWorkspacePanels from './GovernmentWorkspacePanels';
import { officeTeamApi } from './lib/officeTeamApi';
import type { OfficeMember, OfficeWorkspace } from './lib/officeTeamApi';
import { officeIndustryTasksApi } from './lib/officeIndustryTasks';
import type { OfficeIndustrySpace } from './lib/officeIndustryTasks';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeTeamConfigState, OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import {
  officeGovernmentCorrespondenceApi,
} from './lib/officeGovernmentCorrespondence';
import { officeGovernmentWorkspaceApi } from './lib/officeGovernmentWorkspace';
import type {
  GovernmentCorrespondence, GovernmentCorrespondenceAction, GovernmentCorrespondenceCursor,
  GovernmentCorrespondenceDirection, GovernmentCorrespondenceEvent, GovernmentCorrespondenceInput,
  GovernmentCorrespondenceStatus, GovernmentCorrespondenceType, GovernmentDispatchMethod,
} from './lib/officeGovernmentCorrespondence';
import type { GovernmentAccessProfile } from './lib/officeGovernmentWorkspace';

const PAGE_SIZE = 100;
const HISTORY_PAGE_SIZE = 50;
const statusOptions: GovernmentCorrespondenceStatus[] = [
  'received', 'registered', 'routed', 'in_progress', 'review_requested', 'changes_requested',
  'approved', 'draft', 'dispatched', 'closed', 'cancelled',
];
const recordTypes: GovernmentCorrespondenceType[] = [
  'letter', 'memo', 'circular', 'service_request', 'meeting_action', 'other',
];
const dispatchMethods: GovernmentDispatchMethod[] = ['email', 'courier', 'hand_delivery', 'other'];

type ViewStatus = 'loading' | 'signed-out' | 'not-member' | 'setup-required' | 'profile-conflict' | 'schema-missing' | 'error' | 'ready';
type DirectionFilter = 'all' | GovernmentCorrespondenceDirection;
type StatusFilter = 'all' | GovernmentCorrespondenceStatus;
type GovernmentModuleTab = 'register' | 'records' | 'outbound' | 'archives' | 'settings';
type GovernmentForm = Omit<GovernmentCorrespondenceInput, 'workspaceId'>;
type HistoryState = {
  events: GovernmentCorrespondenceEvent[];
  cursor: GovernmentCorrespondenceCursor | null;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
};
type RouteForm = { department: string; assignedUserId: string };
type DispatchForm = { method: GovernmentDispatchMethod; reference: string };

const emptyForm = (direction: GovernmentCorrespondenceDirection = 'incoming'): GovernmentForm => ({
  direction, recordType: 'letter', subject: '', summary: '', sourceUnit: '', destinationUnit: '',
  receivedDate: direction === 'incoming' ? new Date().toISOString().slice(0, 10) : null,
  dueDate: null, relatedIncomingId: null,
});

function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : 'The Government correspondence request could not be completed.';
  if (/PGRST202|schema cache|office_gov_|could not find the function/i.test(message)) {
    return 'The Government workspace schema is not available in this project yet. No shared Government data was changed.';
  }
  return message;
}

function configMessage(status: string) {
  if (status === 'missing-url') return 'The Office Supabase URL is not configured in this deployment.';
  if (status === 'missing-public-key') return 'The Office public Supabase key is not configured in this deployment.';
  if (status === 'invalid-public-key') return 'Only a public anon/publishable key is accepted; this feature never uses a service key.';
  if (status === 'wrong-project') return 'Office Team is restricted to the existing COCCE Super App project.';
  return 'The configured Office Supabase URL is invalid.';
}

function memberName(member: OfficeMember | undefined) {
  return member?.display_name?.trim() || (member?.username ? `@${member.username}` : 'Team member');
}

function prettyStatus(status: string) {
  return status.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function friendlyDate(value: string | null) {
  if (!value) return 'No target date';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(`${value}T12:00:00`));
}

function cursorForRecord(record: GovernmentCorrespondence): GovernmentCorrespondenceCursor {
  return { createdAt: record.created_at, id: record.correspondence_id };
}

function cursorForEvent(event: GovernmentCorrespondenceEvent): GovernmentCorrespondenceCursor {
  return { createdAt: event.created_at, id: event.event_id };
}

function newIdempotencyKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error('This browser cannot create a safe retry key. Try a current browser.');
  return globalThis.crypto.randomUUID();
}

function cleanSingleLine(value: string, max: number) {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f ? ' ' : character;
  }).join('').replace(/\s+/g, ' ').slice(0, max);
}

function eventLabel(event: GovernmentCorrespondenceEvent) {
  if (event.event_kind === 'created') return `Created · ${prettyStatus(event.to_status)}`;
  if (event.event_kind === 'updated') return `Updated fields: ${event.changed_fields.join(', ')}`;
  if (event.event_kind === 'routed') return `Routed to ${event.to_department || 'department'} · assignee changed`;
  if (event.event_kind === 'registered') return 'Institution-issued reference recorded';
  if (event.event_kind === 'work_started') return 'Work started';
  if (event.event_kind === 'review_requested') return 'Review requested';
  if (event.event_kind === 'approved') return 'Approved by an independent owner/admin';
  if (event.event_kind === 'changes_requested') return 'Returned for changes';
  if (event.event_kind === 'dispatched') return 'Dispatch logged (not sent by COCCE)';
  if (event.event_kind === 'closed') return 'Closed';
  return 'Cancelled';
}

export default function GovernmentCorrespondenceWorkspace({
  workspaceId,
  officeName,
  country,
  accent,
}: {
  workspaceId: string;
  officeName: string;
  country: string;
  accent: string;
}) {
  const config = useMemo(() => resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment), []);
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const [status, setStatus] = useState<ViewStatus>('loading');
  const [space, setSpace] = useState<OfficeIndustrySpace | null>(null);
  const [workspace, setWorkspace] = useState<OfficeWorkspace | null>(null);
  const [members, setMembers] = useState<OfficeMember[]>([]);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [accessProfile, setAccessProfile] = useState<GovernmentAccessProfile | null>(null);
  const [moduleTab, setModuleTab] = useState<GovernmentModuleTab>('register');
  const [records, setRecords] = useState<GovernmentCorrespondence[]>([]);
  const [cursor, setCursor] = useState<GovernmentCorrespondenceCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [registeringSpace, setRegisteringSpace] = useState(false);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<GovernmentForm>(() => emptyForm());
  const [formOpen, setFormOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const [referenceById, setReferenceById] = useState<Record<string, string>>({});
  const [routeById, setRouteById] = useState<Record<string, RouteForm>>({});
  const [dispatchById, setDispatchById] = useState<Record<string, DispatchForm>>({});
  const [confirmCancelId, setConfirmCancelId] = useState<string | null>(null);
  const [historyById, setHistoryById] = useState<Record<string, HistoryState>>({});
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null);
  const loadGenerationRef = useRef(0);
  const canAdminister = workspace?.role === 'owner' || workspace?.role === 'admin';
  const roles = accessProfile?.roles ?? [];
  const canManageRecords = canAdminister || roles.includes('records_manager');
  const canAudit = canAdminister || roles.includes('auditor');
  const canUseOutbound = canAdminister || roles.includes('outbound_dispatcher');
  const allowedTabs: GovernmentModuleTab[] = [
    'register',
    ...(canManageRecords || canAudit ? ['records' as const] : []),
    ...(canUseOutbound ? ['outbound' as const] : []),
    ...(canManageRecords || canAudit ? ['archives' as const] : []),
    ...(canAdminister ? ['settings' as const] : []),
  ];
  const activeTab = allowedTabs.includes(moduleTab) ? moduleTab : 'register';
  const moveModuleTab = (direction: 1 | -1) => {
    const currentIndex = allowedTabs.indexOf(activeTab);
    const nextIndex = (currentIndex + direction + allowedTabs.length) % allowedTabs.length;
    const tablist = document.activeElement?.closest('[role="tablist"]');
    setModuleTab(allowedTabs[nextIndex]);
    tablist?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[nextIndex]?.focus();
  };
  const activeMembers = useMemo(() => members.filter((member) => member.status === 'active'), [members]);
  const memberById = useMemo(() => new Map(activeMembers.map((member) => [member.user_id, member])), [activeMembers]);

  const loadFirstPage = useCallback(async (activeClient: NonNullable<typeof client>, generation?: number) => {
    const page = await officeGovernmentCorrespondenceApi.list(activeClient, workspaceId, { limit: PAGE_SIZE });
    if (generation !== undefined && generation !== loadGenerationRef.current) return;
    setRecords(page);
    setCursor(page.length ? cursorForRecord(page[page.length - 1]) : null);
    setHasMore(page.length === PAGE_SIZE);
    setHistoryById({});
  }, [workspaceId]);

  const loadTeam = useCallback(async () => {
    const generation = ++loadGenerationRef.current;
    const isCurrent = () => generation === loadGenerationRef.current;
    if (config.status !== 'ready') {
      setStatus('error');
      setFeedback(configMessage(config.status));
      return;
    }
    if (!config.schemaReady) {
      setStatus('error');
      setFeedback('Office Team is not enabled in this deployment. No shared correspondence was changed.');
      return;
    }
    if (!client) {
      setStatus('error');
      setFeedback('The Office Team connection is unavailable. No shared correspondence was changed.');
      return;
    }

    try {
      const { data: authData, error: authError } = await client.auth.getUser();
      if (!isCurrent()) return;
      if (authError) throw authError;
      if (!authData.user) {
        setStatus('signed-out');
        return;
      }
      const workspaces = await officeTeamApi.listWorkspaces(client);
      if (!isCurrent()) return;
      const selected = workspaces.find((candidate) => candidate.workspace_id === workspaceId);
      if (!selected) {
        setStatus('not-member');
        return;
      }
      const [teamMembers, sharedSpace] = await Promise.all([
        officeTeamApi.listMembers(client, workspaceId),
        officeIndustryTasksApi.getSpace(client, workspaceId),
      ]);
      if (!isCurrent()) return;
      setCurrentUserId(authData.user.id);
      setWorkspace(selected);
      setMembers(teamMembers);
      if (!sharedSpace) {
        setStatus('setup-required');
        return;
      }
      setSpace(sharedSpace);
      if (sharedSpace.industry_id !== 'government') {
        setStatus('profile-conflict');
        return;
      }
      const roleProfile = await officeGovernmentWorkspaceApi.accessProfile(client, workspaceId);
      if (!isCurrent()) return;
      setAccessProfile(roleProfile);
      await loadFirstPage(client, generation);
      if (!isCurrent()) return;
      setStatus('ready');
      setFeedback('');
    } catch (error) {
      if (!isCurrent()) return;
      const message = friendlyError(error);
      setStatus(/schema is not installed|schema is not available/i.test(message) ? 'schema-missing' : 'error');
      setFeedback(message);
    }
  }, [client, config, loadFirstPage, workspaceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadTeam(); }, 0);
    return () => {
      window.clearTimeout(timer);
      loadGenerationRef.current += 1;
    };
  }, [loadTeam]);

  const refresh = () => {
    setStatus('loading');
    setFeedback('');
    setRecords([]);
    setSpace(null);
    setWorkspace(null);
    setMembers([]);
    setAccessProfile(null);
    setCursor(null);
    setHasMore(false);
    setHistoryById({});
    void loadTeam();
  };

  const createSharedProfile = async () => {
    if (!client || !canAdminister || registeringSpace) return;
    const generation = loadGenerationRef.current;
    setRegisteringSpace(true);
    setFeedback('');
    try {
      const registered = await officeIndustryTasksApi.registerSpace(client, {
        workspaceId, industryId: 'government', officeName, country,
      });
      if (generation !== loadGenerationRef.current) return;
      setSpace(registered);
      if (registered.industry_id !== 'government') {
        setStatus('profile-conflict');
        return;
      }
      setAccessProfile(await officeGovernmentWorkspaceApi.accessProfile(client, workspaceId));
      await loadFirstPage(client, generation);
      if (generation !== loadGenerationRef.current) return;
      setStatus('ready');
      setFeedback('An empty Government profile was created. Device-local items were not copied.');
    } catch (error) {
      setFeedback(friendlyError(error));
    } finally {
      setRegisteringSpace(false);
    }
  };

  const loadMore = async () => {
    if (!client || !cursor || !hasMore || loadingMore) return;
    const generation = loadGenerationRef.current;
    setLoadingMore(true);
    try {
      const page = await officeGovernmentCorrespondenceApi.list(client, workspaceId, { limit: PAGE_SIZE, before: cursor });
      if (generation !== loadGenerationRef.current) return;
      setRecords((current) => {
        const known = new Set(current.map((record) => record.correspondence_id));
        return [...current, ...page.filter((record) => !known.has(record.correspondence_id))];
      });
      setCursor(page.length ? cursorForRecord(page[page.length - 1]) : cursor);
      setHasMore(page.length === PAGE_SIZE);
    } catch (error) {
      if (generation === loadGenerationRef.current) setFeedback(friendlyError(error));
    } finally {
      if (generation === loadGenerationRef.current) setLoadingMore(false);
    }
  };

  const visibleRecords = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    return records.filter((record) => {
      if (directionFilter !== 'all' && record.direction !== directionFilter) return false;
      if (statusFilter !== 'all' && record.status !== statusFilter) return false;
      if (!normalized) return true;
      const assignee = memberName(memberById.get(record.assigned_user_id ?? ''));
      return `${record.subject} ${record.summary} ${record.official_reference} ${record.source_unit} ${record.destination_unit} ${record.current_department} ${record.status} ${assignee}`
        .toLocaleLowerCase().includes(normalized);
    });
  }, [directionFilter, memberById, records, search, statusFilter]);

  const editRecord = (record: GovernmentCorrespondence) => {
    setEditingId(record.correspondence_id);
    setForm({
      direction: record.direction,
      recordType: record.record_type,
      subject: record.subject,
      summary: record.summary,
      sourceUnit: record.source_unit,
      destinationUnit: record.destination_unit,
      receivedDate: record.received_date,
      dueDate: record.due_date,
      relatedIncomingId: record.related_incoming_id,
    });
    setFormOpen(true);
    setFeedback('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(emptyForm(directionFilter === 'outgoing' ? 'outgoing' : 'incoming'));
  };

  const submitRecord = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || status !== 'ready' || !form.subject.trim() || submitting) return;
    const generation = loadGenerationRef.current;
    setSubmitting(true);
    setFeedback('');
    const payload: GovernmentCorrespondenceInput = {
      workspaceId,
      direction: form.direction,
      recordType: form.recordType,
      subject: cleanSingleLine(form.subject, 140).trim(),
      summary: cleanSingleLine(form.summary, 2000),
      sourceUnit: cleanSingleLine(form.sourceUnit, 100).trim(),
      destinationUnit: cleanSingleLine(form.destinationUnit, 100).trim(),
      receivedDate: form.direction === 'incoming' ? form.receivedDate || null : null,
      dueDate: form.dueDate || null,
      relatedIncomingId: form.direction === 'outgoing' ? form.relatedIncomingId || null : null,
    };
    try {
      if (editingId) {
        const original = records.find((record) => record.correspondence_id === editingId);
        if (!original) throw new Error('This record is no longer loaded. Refresh the register and try again.');
        await officeGovernmentCorrespondenceApi.update(client, {
          ...payload, correspondenceId: editingId, expectedVersion: original.version,
        });
        setFeedback('Correspondence metadata updated.');
      } else {
        await officeGovernmentCorrespondenceApi.create(client, {
          ...payload, idempotencyKey: newIdempotencyKey(),
        });
        setFeedback('Correspondence added to the shared Government register.');
      }
      if (generation !== loadGenerationRef.current) return;
      await loadFirstPage(client, generation);
      setForm(emptyForm(directionFilter === 'outgoing' ? 'outgoing' : 'incoming'));
      setEditingId(null);
      setFormOpen(false);
    } catch (error) {
      if (generation === loadGenerationRef.current) setFeedback(friendlyError(error));
    } finally {
      if (generation === loadGenerationRef.current) setSubmitting(false);
    }
  };

  const runWorkflowAction = async (record: GovernmentCorrespondence, action: GovernmentCorrespondenceAction, extra?: {
    dispatchMethod?: GovernmentDispatchMethod;
    dispatchReference?: string;
  }) => {
    if (!client || busyId) return;
    const generation = loadGenerationRef.current;
    setBusyId(record.correspondence_id);
    setFeedback('');
    try {
      await officeGovernmentCorrespondenceApi.transition(client, {
        workspaceId,
        correspondenceId: record.correspondence_id,
        expectedVersion: record.version,
        action,
        ...extra,
      });
      if (generation !== loadGenerationRef.current) return;
      setHistoryById((current) => { const next = { ...current }; delete next[record.correspondence_id]; return next; });
      await loadFirstPage(client, generation);
      setConfirmCancelId(null);
      setFeedback(action === 'dispatch'
        ? 'Dispatch was logged only. COCCE did not send the correspondence.'
        : `${prettyStatus(action === 'start_work' ? 'in_progress' : action === 'request_review' ? 'review_requested' : action === 'request_changes' ? 'changes_requested' : action)} recorded.`);
    } catch (error) {
      if (generation === loadGenerationRef.current) setFeedback(friendlyError(error));
    } finally {
      if (generation === loadGenerationRef.current) setBusyId(null);
    }
  };

  const registerReference = async (record: GovernmentCorrespondence) => {
    if (!client || !canAdminister || busyId) return;
    const officialReference = referenceById[record.correspondence_id]?.trim() ?? '';
    if (!officialReference) {
      setFeedback('Enter the reference issued by your institution; COCCE will not generate one.');
      return;
    }
    const generation = loadGenerationRef.current;
    setBusyId(record.correspondence_id);
    setFeedback('');
    try {
      await officeGovernmentCorrespondenceApi.register(client, {
        workspaceId, correspondenceId: record.correspondence_id,
        expectedVersion: record.version, officialReference,
      });
      if (generation !== loadGenerationRef.current) return;
      await loadFirstPage(client, generation);
      setReferenceById((current) => ({ ...current, [record.correspondence_id]: '' }));
      setFeedback('Institution-issued reference recorded. The correspondence content is now frozen.');
    } catch (error) {
      if (generation === loadGenerationRef.current) setFeedback(friendlyError(error));
    } finally {
      if (generation === loadGenerationRef.current) setBusyId(null);
    }
  };

  const routeRecord = async (record: GovernmentCorrespondence) => {
    if (!client || !canAdminister || busyId) return;
    const route = routeById[record.correspondence_id] ?? {
      department: record.current_department,
      assignedUserId: record.assigned_user_id ?? '',
    };
    if (!route.department.trim() || !route.assignedUserId) {
      setFeedback('Choose an internal department and an active team member.');
      return;
    }
    const generation = loadGenerationRef.current;
    setBusyId(record.correspondence_id);
    setFeedback('');
    try {
      await officeGovernmentCorrespondenceApi.route(client, {
        workspaceId, correspondenceId: record.correspondence_id,
        expectedVersion: record.version, department: route.department.trim(),
        assignedUserId: route.assignedUserId,
      });
      if (generation !== loadGenerationRef.current) return;
      await loadFirstPage(client, generation);
      setFeedback('Department routing and assignment recorded.');
    } catch (error) {
      if (generation === loadGenerationRef.current) setFeedback(friendlyError(error));
    } finally {
      if (generation === loadGenerationRef.current) setBusyId(null);
    }
  };

  const loadHistory = async (correspondenceId: string, before?: GovernmentCorrespondenceCursor | null) => {
    if (!client || historyBusyId) return;
    const existing = historyById[correspondenceId];
    if (!before && existing?.loaded) return;
    const generation = loadGenerationRef.current;
    setHistoryBusyId(correspondenceId);
    setHistoryById((current) => ({
      ...current,
      [correspondenceId]: {
        events: existing?.events ?? [], cursor: existing?.cursor ?? null,
        hasMore: existing?.hasMore ?? false, loading: true, loaded: existing?.loaded ?? false,
      },
    }));
    try {
      const page = await officeGovernmentCorrespondenceApi.listEvents(client, workspaceId, correspondenceId, {
        limit: HISTORY_PAGE_SIZE, before: before ?? null,
      });
      if (generation !== loadGenerationRef.current) return;
      setHistoryById((current) => {
        const previous = current[correspondenceId];
        const known = new Set(previous?.events.map((event) => event.event_id) ?? []);
        const merged = before ? [...(previous?.events ?? []), ...page.filter((event) => !known.has(event.event_id))] : page;
        return {
          ...current,
          [correspondenceId]: {
            events: merged,
            cursor: page.length ? cursorForEvent(page[page.length - 1]) : previous?.cursor ?? null,
            hasMore: page.length === HISTORY_PAGE_SIZE,
            loading: false,
            loaded: true,
          },
        };
      });
    } catch (error) {
      if (generation === loadGenerationRef.current) {
        setFeedback(friendlyError(error));
        setHistoryById((current) => ({
          ...current,
          [correspondenceId]: {
            ...(current[correspondenceId] ?? { events: [], cursor: null, hasMore: false, loaded: false }),
            loading: false,
          },
        }));
      }
    } finally {
      if (generation === loadGenerationRef.current) setHistoryBusyId(null);
    }
  };

  const loadedIncoming = records.filter((record) => record.direction === 'incoming');
  const isEditable = (record: GovernmentCorrespondence) =>
    (canAdminister || record.created_by === currentUserId)
    && (record.status === 'received' || record.status === 'draft' || record.status === 'changes_requested');
  const isRoutable = (record: GovernmentCorrespondence) => canAdminister && (
    (record.direction === 'incoming' && ['registered', 'routed', 'in_progress', 'changes_requested'].includes(record.status))
    || (record.direction === 'outgoing' && ['draft', 'changes_requested'].includes(record.status))
  );
  const canRequestReview = (record: GovernmentCorrespondence) =>
    (record.direction === 'incoming' && ['in_progress', 'changes_requested'].includes(record.status)
      || record.direction === 'outgoing' && ['draft', 'changes_requested'].includes(record.status))
    && (canAdminister || record.created_by === currentUserId || record.assigned_user_id === currentUserId);

  return <section className="industry-shared-workspace government-correspondence" style={{ '--industry-accent': accent } as CSSProperties} aria-label="Government workspace">
    <div className="industry-shared-boundary government-register-boundary" role="note">
      <LockKeyhole size={18} />
      <div><strong>Government workspace · keep shared records non-sensitive</strong><span>Do not store citizen names or IDs, case narratives, classified/confidential content, or other sensitive data. Attachments are limited to Public/Internal records and remain shared with active Office Team members in Bunny storage. External email sends and CMIS archive transfers are explicit actions; provider acceptance does not prove delivery, and archive behavior depends on the configured repository. This is not a certified statutory records system. Device-local preview items are never imported.</span></div>
    </div>

    {feedback && <div className="industry-shared-feedback" role={/could not|invalid|denied|changed elsewhere|refresh|not loaded|unavailable|not configured|not enabled|not installed|cannot|not available|not changed/i.test(feedback) ? 'alert' : 'status'}><CircleAlert size={15} />{feedback}<button type="button" aria-label="Dismiss message" onClick={() => setFeedback('')}><X size={14} /></button></div>}

    <header className="industry-shared-heading">
      <div><span className="eyebrow">GOVERNMENT · SHARED OFFICE TEAM</span><h2>{space?.office_name ?? officeName} workspace</h2><p>{space?.country ?? country} · role-based correspondence, records controls and explicit provider actions</p></div>
      <button type="button" className="button-secondary" onClick={refresh} disabled={status === 'loading'}><RefreshCw size={14} /> Refresh</button>
    </header>

    {status === 'loading' && <div className="industry-shared-state" role="status"><RefreshCw size={16} className="industry-spin" /> Checking Office sign-in, membership, Government profile and schema…</div>}
    {status === 'signed-out' && <div className="industry-shared-state" role="status"><Users size={17} /><div><strong>Sign in to Office Team</strong><span>Open the linked team above, sign in to your existing COCCE account, then return here. No register data was changed.</span></div></div>}
    {status === 'not-member' && <div className="industry-shared-state is-alert" role="alert"><CircleAlert size={17} /><div><strong>This team is not available to this account</strong><span>Check the signed-in Office account or ask to join this team. No shared correspondence was returned.</span></div></div>}
    {status === 'schema-missing' && <div className="industry-shared-state is-alert" role="alert"><CircleAlert size={17} /><div><strong>Government workspace schema is not available</strong><span>The required Government workspace migration is not installed in this database. No shared Government data was changed.</span></div></div>}
    {status === 'error' && <div className="industry-shared-state is-alert" role="alert"><CircleAlert size={17} /><div><strong>Government register unavailable</strong><span>{feedback || 'The Office Team connection is not ready. Device-local preview data remains separate.'}</span></div></div>}

    {status === 'setup-required' && <div className="industry-shared-setup glass-card">
      <div className="industry-shared-setup-icon"><Users size={20} /></div>
      <div><span className="eyebrow">EMPTY TEAM PROFILE</span><h3>Connect this team to Government</h3><p>This creates only an empty shared industry label. Existing items in this browser stay local and will not be imported. {canAdminister ? 'Only an Office Team owner/admin can set it up.' : 'Ask an Office Team owner/admin to set it up.'}</p></div>
      <button type="button" className="button-primary" onClick={() => void createSharedProfile()} disabled={!canAdminister || registeringSpace}>{registeringSpace ? <><RefreshCw size={14} className="industry-spin" /> Setting up…</> : <><Plus size={15} /> Create empty profile</>}</button>
    </div>}

    {status === 'profile-conflict' && <div className="industry-shared-state is-alert" role="alert"><CircleAlert size={17} /><div><strong>This team is set up for a different industry</strong><span>The existing profile is “{space?.industry_id}”. It has not been changed, and Government correspondence is not shown.</span></div></div>}

    {status === 'ready' && <>
      <div className="office-suite-ai-toolbar"><OfficeSuiteAiAction workspaceId={workspaceId} suiteLabel="Government" tabLabel={activeTab.replaceAll("_", " ")} /></div>
      <nav className="government-module-tabs government-workspace-tabs" role="tablist" aria-label="Government workspace modules">
        <button type="button" role="tab" tabIndex={activeTab === 'register' ? 0 : -1} aria-selected={activeTab === 'register'} className={activeTab === 'register' ? 'is-active' : ''} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); moveModuleTab(1); } if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); moveModuleTab(-1); } }} onClick={() => setModuleTab('register')}><FileText size={14} /> Register</button>
        {(canManageRecords || canAudit) && <button type="button" role="tab" tabIndex={activeTab === 'records' ? 0 : -1} aria-selected={activeTab === 'records'} className={activeTab === 'records' ? 'is-active' : ''} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); moveModuleTab(1); } if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); moveModuleTab(-1); } }} onClick={() => setModuleTab('records')}><Archive size={14} /> Records Management</button>}
        {canUseOutbound && <button type="button" role="tab" tabIndex={activeTab === 'outbound' ? 0 : -1} aria-selected={activeTab === 'outbound'} className={activeTab === 'outbound' ? 'is-active' : ''} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); moveModuleTab(1); } if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); moveModuleTab(-1); } }} onClick={() => setModuleTab('outbound')}><Mail size={14} /> Outbound</button>}
        {(canManageRecords || canAudit) && <button type="button" role="tab" tabIndex={activeTab === 'archives' ? 0 : -1} aria-selected={activeTab === 'archives'} className={activeTab === 'archives' ? 'is-active' : ''} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); moveModuleTab(1); } if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); moveModuleTab(-1); } }} onClick={() => setModuleTab('archives')}><History size={14} /> Archives</button>}
        {canAdminister && <button type="button" role="tab" tabIndex={activeTab === 'settings' ? 0 : -1} aria-selected={activeTab === 'settings'} className={activeTab === 'settings' ? 'is-active' : ''} onKeyDown={(event) => { if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); moveModuleTab(1); } if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); moveModuleTab(-1); } }} onClick={() => setModuleTab('settings')}><Settings2 size={14} /> Settings</button>}
      </nav>

      {activeTab !== 'register' && client && currentUserId && accessProfile && <GovernmentWorkspacePanels
        client={client}
        config={config as OfficeTeamConfigState}
        workspaceId={workspaceId}
        currentUserId={currentUserId}
        members={activeMembers}
        records={records}
        accessProfile={accessProfile}
        canAdminister={Boolean(canAdminister)}
        activeTab={activeTab}
        onRefresh={refresh}
        accent={accent}
      />}

      {activeTab === 'register' && <>
      <div className="government-register-toolbar">
        <div className="government-register-filters" role="group" aria-label="Filter correspondence">
          <label>Direction<select value={directionFilter} onChange={(event) => setDirectionFilter(event.target.value as DirectionFilter)}><option value="all">All directions</option><option value="incoming">Incoming</option><option value="outgoing">Outgoing</option></select></label>
          <label>Status<select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}><option value="all">All statuses</option>{statusOptions.map((item) => <option value={item} key={item}>{prettyStatus(item)}</option>)}</select></label>
          <label className="government-register-search">Search loaded records<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Subject, reference, unit…" /></label>
        </div>
        <button type="button" className="button-primary" onClick={() => { setEditingId(null); setForm(emptyForm(directionFilter === 'outgoing' ? 'outgoing' : 'incoming')); setFormOpen(true); }}><Plus size={15} /> New correspondence</button>
      </div>

      <div className="industry-shared-metrics" aria-label="Loaded correspondence summary">
        <div className="industry-metric-card industry-metric-total"><span>Loaded records</span><strong>{records.length}</strong><small>{hasMore ? 'More available via pagination' : 'All available rows loaded'}</small></div>
        <div className="industry-metric-card industry-metric-active"><span>Incoming</span><strong>{records.filter((record) => record.direction === 'incoming').length}</strong><small>Across loaded records</small></div>
        <div className="industry-metric-card industry-metric-closed"><span>Outgoing</span><strong>{records.filter((record) => record.direction === 'outgoing').length}</strong><small>Across loaded records</small></div>
      </div>

      <div className="government-register-layout">
        <section className="industry-work-panel glass-card" aria-labelledby="government-register-list-title">
          <div className="industry-work-heading"><div><span className="eyebrow">CORRESPONDENCE LOG</span><h2 id="government-register-list-title">Shared register</h2></div><span className="government-register-count">{visibleRecords.length} shown · {records.length} loaded</span></div>
          <div className="government-register-list">
            {visibleRecords.map((record) => {
              const recordHistory = historyById[record.correspondence_id];
              const route = routeById[record.correspondence_id] ?? { department: record.current_department, assignedUserId: record.assigned_user_id ?? '' };
              const dispatch = dispatchById[record.correspondence_id] ?? { method: 'email' as GovernmentDispatchMethod, reference: '' };
              const canReview = canAdminister && record.status === 'review_requested'
                && record.created_by !== currentUserId && record.assigned_user_id !== currentUserId;
              const canStart = record.direction === 'incoming' && ['routed', 'changes_requested'].includes(record.status)
                && (canAdminister || record.assigned_user_id === currentUserId);
              const canClose = canAdminister && (
                record.direction === 'incoming' && record.status === 'approved'
                || record.direction === 'outgoing' && record.status === 'dispatched'
              );
              const canCancel = canAdminister && !['dispatched', 'closed', 'cancelled'].includes(record.status);
              const canRegisterThis = canAdminister && (
                record.direction === 'incoming' && record.status === 'received'
                || record.direction === 'outgoing' && record.status === 'approved'
              );
              return <article className="government-correspondence-card" key={record.correspondence_id}>
                <div className="government-card-topline"><span className={`government-direction-badge is-${record.direction}`}>{record.direction === 'incoming' ? 'Incoming' : 'Outgoing'} · {record.record_type.replaceAll('_', ' ')}</span><span className={`government-status-badge is-${record.status}`}>{prettyStatus(record.status)}</span></div>
                <div className="government-card-reference"><span>{record.official_reference || 'Not registered'}</span>{record.due_date && <small><CalendarDays size={12} /> {friendlyDate(record.due_date)}</small>}</div>
                <h3>{record.subject}</h3>
                {record.summary && <p className="government-card-summary">{record.summary}</p>}
                <div className="government-card-grid"><span><small>From</small><strong>{record.source_unit || 'Not recorded'}</strong></span><span><small>To</small><strong>{record.destination_unit || 'Not recorded'}</strong></span><span><small>Department</small><strong>{record.current_department || 'Not routed'}</strong></span><span><small>Assignee</small><strong>{record.assigned_user_id ? memberName(memberById.get(record.assigned_user_id)) : 'Unassigned'}</strong></span></div>
                {record.direction === 'incoming' && <div className="government-card-date"><FileText size={13} /> Received {friendlyDate(record.received_date)}</div>}
                {record.related_incoming_id && <div className="government-card-date"><ArrowRight size={13} /> Linked incoming record · {loadedIncoming.find((item) => item.correspondence_id === record.related_incoming_id)?.official_reference || 'reference not loaded'}</div>}

                {canRegisterThis && <form className="government-action-form" onSubmit={(event) => { event.preventDefault(); void registerReference(record); }}>
                  <label>Institution-issued reference<input value={referenceById[record.correspondence_id] ?? ''} onChange={(event) => setReferenceById((current) => ({ ...current, [record.correspondence_id]: cleanSingleLine(event.target.value, 100) }))} maxLength={100} placeholder="Enter the assigned reference" required /></label>
                  <button type="submit" className="button-secondary" disabled={busyId === record.correspondence_id}>{busyId === record.correspondence_id ? 'Registering…' : 'Register reference'}</button>
                </form>}

                {isRoutable(record) && <form className="government-action-form" onSubmit={(event) => { event.preventDefault(); void routeRecord(record); }}>
                  <label>Internal department<input value={route.department} onChange={(event) => setRouteById((current) => ({ ...current, [record.correspondence_id]: { ...route, department: cleanSingleLine(event.target.value, 100) } }))} maxLength={100} placeholder="e.g. Registry" required /></label>
                  <label>Assign to active team member<select value={route.assignedUserId} onChange={(event) => setRouteById((current) => ({ ...current, [record.correspondence_id]: { ...route, assignedUserId: event.target.value } }))} required><option value="">Choose a member</option>{activeMembers.map((member) => <option value={member.user_id} key={member.user_id}>{memberName(member)}</option>)}</select></label>
                  <button type="submit" className="button-secondary" disabled={busyId === record.correspondence_id}>{busyId === record.correspondence_id ? 'Routing…' : record.current_department ? 'Re-route assignment' : 'Route to department'}</button>
                </form>}

                {record.direction === 'outgoing' && canAdminister && record.status === 'registered' && <form className="government-action-form government-dispatch-form" onSubmit={(event) => { event.preventDefault(); void runWorkflowAction(record, 'dispatch', { dispatchMethod: dispatch.method, dispatchReference: dispatch.reference }); }}>
                  <label>Dispatch method<select value={dispatch.method} onChange={(event) => setDispatchById((current) => ({ ...current, [record.correspondence_id]: { ...dispatch, method: event.target.value as GovernmentDispatchMethod } }))}>{dispatchMethods.map((method) => <option value={method} key={method}>{method.replaceAll('_', ' ')}</option>)}</select></label>
                  <label>Dispatch reference (optional)<input value={dispatch.reference} onChange={(event) => setDispatchById((current) => ({ ...current, [record.correspondence_id]: { ...dispatch, reference: cleanSingleLine(event.target.value, 100) } }))} maxLength={100} placeholder="Courier / sent-item reference" /></label>
                  <button type="submit" className="button-secondary" disabled={busyId === record.correspondence_id}><Send size={13} /> Log dispatch only</button>
                </form>}

                <details className="industry-history government-history" onToggle={(event) => { if (event.currentTarget.open && !recordHistory?.loaded) void loadHistory(record.correspondence_id); }}>
                  <summary><History size={13} /> Audit history{recordHistory?.loaded ? ` · ${recordHistory.events.length}` : ''}</summary>
                  {recordHistory?.loading && <p className="industry-history-loading">Loading event history…</p>}
                  {recordHistory?.events.length ? <ol>{recordHistory.events.map((entry) => <li key={entry.event_id}><span>{eventLabel(entry)}</span><small>{entry.actor_id ? memberName(memberById.get(entry.actor_id)) : 'Former team member'}</small><time>{new Date(entry.created_at).toLocaleString()} · v{entry.record_version}</time></li>)}</ol> : recordHistory?.loaded && !recordHistory.loading ? <p className="industry-history-loading">No events returned.</p> : null}
                  {recordHistory?.hasMore && <button type="button" className="industry-history-more" disabled={historyBusyId === record.correspondence_id} onClick={() => void loadHistory(record.correspondence_id, recordHistory.cursor)}>{historyBusyId === record.correspondence_id ? 'Loading…' : 'Load older events'}</button>}
                </details>

                <div className="government-record-actions">
                  {isEditable(record) && <button type="button" className="industry-edit-button" onClick={() => editRecord(record)}>Edit draft details</button>}
                  {canStart && <button type="button" className="industry-move-button is-forward" disabled={busyId === record.correspondence_id} onClick={() => void runWorkflowAction(record, 'start_work')}>Start work</button>}
                  {canRequestReview(record) && <button type="button" className="industry-move-button is-forward" disabled={busyId === record.correspondence_id} onClick={() => void runWorkflowAction(record, 'request_review')}>Request review</button>}
                  {canReview && <><button type="button" className="button-primary" disabled={busyId === record.correspondence_id} onClick={() => void runWorkflowAction(record, 'approve')}>Approve</button><button type="button" className="button-secondary" disabled={busyId === record.correspondence_id} onClick={() => void runWorkflowAction(record, 'request_changes')}>Return for changes</button><small className="government-review-note">Approval is single-step; discuss reasons through an approved channel, not in this register.</small></>}
                  {canClose && <button type="button" className="industry-move-button is-forward" disabled={busyId === record.correspondence_id} onClick={() => void runWorkflowAction(record, 'close')}>Close record</button>}
                  {canCancel && (confirmCancelId === record.correspondence_id
                    ? <><span className="government-cancel-note">Cancel is terminal and keeps the audit trail.</span><button type="button" className="button-secondary" onClick={() => setConfirmCancelId(null)}>Keep open</button><button type="button" className="industry-move-button" disabled={busyId === record.correspondence_id} onClick={() => void runWorkflowAction(record, 'cancel')}>Confirm cancel</button></>
                    : <button type="button" className="government-cancel-button" onClick={() => setConfirmCancelId(record.correspondence_id)}>Cancel record</button>)}
                </div>
                <div className="government-card-footer"><span>Created by {record.created_by ? memberName(memberById.get(record.created_by)) : 'Former team member'}</span><span>Version {record.version}</span></div>
              </article>;
            })}
          </div>
          {visibleRecords.length === 0 && <div className="industry-empty-work"><div className="industry-empty-icon"><FileText size={19} /></div><strong>{records.length ? 'No matching correspondence' : 'No shared correspondence yet'}</strong><span>{records.length ? 'Try a different filter or search.' : 'Create the first non-sensitive operational register entry.'}</span></div>}
          {hasMore && <div className="industry-shared-load-more"><span>Search and filters apply to loaded items only.</span><button type="button" className="button-secondary" disabled={loadingMore} onClick={() => void loadMore()}>{loadingMore ? <><RefreshCw size={14} className="industry-spin" /> Loading…</> : 'Load next 100 records'}</button></div>}
        </section>

        {formOpen && <aside className="industry-work-side">
          <section className="industry-add-panel glass-card" aria-labelledby="government-form-title">
            <div className="industry-side-heading"><span className="industry-side-icon">{editingId ? <FileText size={17} /> : <Plus size={17} />}</span><div><span className="eyebrow">{editingId ? 'UNREGISTERED CONTENT' : 'ADD TO REGISTER'}</span><h2 id="government-form-title">{editingId ? 'Edit correspondence' : 'New correspondence'}</h2></div></div>
            <form className="industry-record-form" onSubmit={submitRecord}>
              <label>Direction<select value={form.direction} disabled={Boolean(editingId)} onChange={(event) => { const direction = event.target.value as GovernmentCorrespondenceDirection; setForm((current) => ({ ...current, direction, receivedDate: direction === 'incoming' ? current.receivedDate || new Date().toISOString().slice(0, 10) : null, relatedIncomingId: direction === 'incoming' ? null : current.relatedIncomingId })); }}><option value="incoming">Incoming</option><option value="outgoing">Outgoing</option></select></label>
              <label>Record type<select value={form.recordType} onChange={(event) => setForm((current) => ({ ...current, recordType: event.target.value as GovernmentCorrespondenceType }))}>{recordTypes.map((type) => <option value={type} key={type}>{type.replaceAll('_', ' ')}</option>)}</select></label>
              <label>Subject<input value={form.subject} onChange={(event) => setForm((current) => ({ ...current, subject: cleanSingleLine(event.target.value, 140) }))} maxLength={140} placeholder="Short non-sensitive label" required /></label>
              <label>Summary<textarea value={form.summary} onChange={(event) => setForm((current) => ({ ...current, summary: cleanSingleLine(event.target.value, 2000) }))} maxLength={2000} rows={3} placeholder="Operational summary only; no personal or confidential details" /></label>
              <label>From unit<input value={form.sourceUnit} onChange={(event) => setForm((current) => ({ ...current, sourceUnit: cleanSingleLine(event.target.value, 100) }))} maxLength={100} placeholder="Office or unit" /></label>
              <label>To unit<input value={form.destinationUnit} onChange={(event) => setForm((current) => ({ ...current, destinationUnit: cleanSingleLine(event.target.value, 100) }))} maxLength={100} placeholder="Office or unit" /></label>
              {form.direction === 'incoming' && <label>Received date<input type="date" value={form.receivedDate ?? ''} onChange={(event) => setForm((current) => ({ ...current, receivedDate: event.target.value || null }))} required /></label>}
              <label>Target date<input type="date" value={form.dueDate ?? ''} onChange={(event) => setForm((current) => ({ ...current, dueDate: event.target.value || null }))} /></label>
              {form.direction === 'outgoing' && <label>Related incoming record (loaded records only)<select value={form.relatedIncomingId ?? ''} onChange={(event) => setForm((current) => ({ ...current, relatedIncomingId: event.target.value || null }))}><option value="">No linked item</option>{loadedIncoming.map((record) => <option key={record.correspondence_id} value={record.correspondence_id}>{record.official_reference || record.subject}</option>)}</select></label>}
              <div className="industry-shared-form-actions">
                {editingId && <button type="button" className="button-secondary" onClick={cancelEdit}>Cancel edit</button>}
                <button type="submit" className="button-primary industry-save-button" disabled={submitting || !form.subject.trim()}>{submitting ? <><RefreshCw size={14} className="industry-spin" /> Saving…</> : <><Check size={15} /> {editingId ? 'Save draft changes' : 'Add correspondence'}</>}</button>
              </div>
            </form>
            <p className="industry-stage-help"><CalendarDays size={13} /> References are entered by an owner/admin after checking the institution's process. Registered content is frozen.</p>
          </section>
          <section className="industry-privacy-card glass-card"><div className="industry-privacy-icon"><ShieldAlert size={18} /></div><strong>Keep this register non-sensitive</strong><p>Do not enter names, IDs, case details, legal or confidential text. Use Records Management for Public/Internal file links and lifecycle controls. Institution-issued references must be checked with the responsible office.</p></section>
        </aside>}
      </div>
      </>}
    </>}
  </section>;
}
