import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import {
  ArrowLeft, ArrowRight, CalendarDays, Check, CircleAlert, Clock3, Edit3,
  History, Plus, RefreshCw, Save, ShieldAlert, Users, X,
} from 'lucide-react';
import { officeTeamApi } from './lib/officeTeamApi';
import type { OfficeMember, OfficeWorkspace } from './lib/officeTeamApi';
import {
  officeIndustryTasksApi,
} from './lib/officeIndustryTasks';
import type {
  OfficeIndustryCursor, OfficeIndustrySpace, OfficeIndustryWorkEvent, OfficeIndustryWorkItem,
} from './lib/officeIndustryTasks';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import type { IndustryDefinition, IndustryId } from './lib/industryWorkspaces';

const PAGE_SIZE = 100;
const HISTORY_PAGE_SIZE = 50;
const emptyForm = { title: '', reference: '', assigneeUserId: '', dueDate: '', notes: '' };

type SharedForm = typeof emptyForm;
type ViewStatus = 'loading' | 'signed-out' | 'not-member' | 'setup-required' | 'ready' | 'profile-conflict' | 'error';
type HistoryState = {
  events: OfficeIndustryWorkEvent[];
  cursor: OfficeIndustryCursor | null;
  hasMore: boolean;
  loading: boolean;
  loaded: boolean;
};

function friendlyError(error: unknown) {
  return error instanceof Error ? error.message : 'The shared team request could not be completed.';
}

function memberName(member: OfficeMember | undefined) {
  return member?.display_name?.trim() || (member?.username ? `@${member.username}` : 'Team member');
}

function friendlyDate(value: string | null) {
  if (!value) return 'No due date';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
    .format(new Date(`${value}T12:00:00`));
}

function cursorForItem(item: OfficeIndustryWorkItem): OfficeIndustryCursor {
  return { createdAt: item.created_at, id: item.item_id };
}

function cursorForEvent(event: OfficeIndustryWorkEvent): OfficeIndustryCursor {
  return { createdAt: event.created_at, id: event.event_id };
}

function newIdempotencyKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error('This browser cannot safely create a retry key. Try a current browser.');
  return globalThis.crypto.randomUUID();
}

function configMessage(status: string) {
  if (status === 'missing-url') return 'The Office Supabase URL is not configured in this deployment.';
  if (status === 'missing-public-key') return 'The Office public Supabase key is not configured in this deployment.';
  if (status === 'invalid-public-key') return 'Only the public anon/publishable key is accepted here; secret keys are never used by this feature.';
  if (status === 'wrong-project') return 'This Office feature is restricted to the existing COCCE Super App project.';
  return 'The configured Office Supabase URL is invalid.';
}

export default function IndustrySharedWorkspace({
  workspaceId,
  officeName,
  country,
  industryId,
  definition,
  accent,
}: {
  workspaceId: string;
  officeName: string;
  country: string;
  industryId: IndustryId;
  definition: IndustryDefinition;
  accent: string;
}) {
  const config = useMemo(() => resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment), []);
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const [status, setStatus] = useState<ViewStatus>('loading');
  const [space, setSpace] = useState<OfficeIndustrySpace | null>(null);
  const [workspace, setWorkspace] = useState<OfficeWorkspace | null>(null);
  const [members, setMembers] = useState<OfficeMember[]>([]);
  const [items, setItems] = useState<OfficeIndustryWorkItem[]>([]);
  const [cursor, setCursor] = useState<OfficeIndustryCursor | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [registering, setRegistering] = useState(false);
  const [search, setSearch] = useState('');
  const [feedback, setFeedback] = useState('');
  const [form, setForm] = useState<SharedForm>(emptyForm);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [movingItemId, setMovingItemId] = useState<string | null>(null);
  const [historyByItem, setHistoryByItem] = useState<Record<string, HistoryState>>({});
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null);
  const formRef = useRef<HTMLElement>(null);
  const loadGenerationRef = useRef(0);
  const canRegister = workspace?.role === 'owner' || workspace?.role === 'admin';
  const activeMembers = useMemo(() => members.filter((member) => member.status === 'active'), [members]);
  const memberById = useMemo(() => new Map(activeMembers.map((member) => [member.user_id, member])), [activeMembers]);

  const loadFirstPage = useCallback(async (currentClient = client) => {
    if (!currentClient) return;
    const page = await officeIndustryTasksApi.listWorkItems(currentClient, workspaceId, { limit: PAGE_SIZE });
    setItems(page);
    setCursor(page.length ? cursorForItem(page[page.length - 1]) : null);
    setHasMore(page.length === PAGE_SIZE);
    setHistoryByItem({});
  }, [client, workspaceId]);

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
      setFeedback('Office Team is not enabled in this deployment. No shared data was changed.');
      return;
    }
    if (!client) {
      setStatus('error');
      setFeedback('The Office Team connection is unavailable. No shared data was changed.');
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
      const selectedWorkspace = workspaces.find((candidate) => candidate.workspace_id === workspaceId);
      if (!selectedWorkspace) {
        setStatus('not-member');
        return;
      }
      const [teamMembers, sharedSpace] = await Promise.all([
        officeTeamApi.listMembers(client, workspaceId),
        officeIndustryTasksApi.getSpace(client, workspaceId),
      ]);
      if (!isCurrent()) return;
      setWorkspace(selectedWorkspace);
      setMembers(teamMembers);
      if (!sharedSpace) {
        setStatus('setup-required');
        return;
      }
      setSpace(sharedSpace);
      if (sharedSpace.industry_id !== industryId) {
        setStatus('profile-conflict');
        return;
      }
      await loadFirstPage(client);
      if (!isCurrent()) return;
      setStatus('ready');
    } catch (error) {
      if (!isCurrent()) return;
      setStatus('error');
      setFeedback(friendlyError(error));
    }
  }, [client, config, industryId, loadFirstPage, workspaceId]);

  const refreshTeam = () => {
    setStatus('loading');
    setFeedback('');
    setItems([]);
    setSpace(null);
    setWorkspace(null);
    setMembers([]);
    setCursor(null);
    setHasMore(false);
    setHistoryByItem({});
    void loadTeam();
  };

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadTeam(); }, 0);
    return () => {
      window.clearTimeout(timer);
      loadGenerationRef.current += 1;
    };
  }, [loadTeam]);

  const registerSpace = async () => {
    if (!client || !canRegister || registering) return;
    setRegistering(true);
    setFeedback('');
    try {
      const registered = await officeIndustryTasksApi.registerSpace(client, {
        workspaceId, industryId, officeName, country,
      });
      setSpace(registered);
      if (registered.industry_id !== industryId) {
        setStatus('profile-conflict');
        return;
      }
      await loadFirstPage(client);
      setStatus('ready');
      setFeedback('An empty shared profile was created. Existing device-local items were not copied.');
    } catch (error) {
      setFeedback(friendlyError(error));
    } finally {
      setRegistering(false);
    }
  };

  const loadMoreItems = async () => {
    if (!client || !cursor || !hasMore || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await officeIndustryTasksApi.listWorkItems(client, workspaceId, { limit: PAGE_SIZE, before: cursor });
      setItems((current) => {
        const known = new Set(current.map((item) => item.item_id));
        return [...current, ...page.filter((item) => !known.has(item.item_id))];
      });
      setCursor(page.length ? cursorForItem(page[page.length - 1]) : cursor);
      setHasMore(page.length === PAGE_SIZE);
    } catch (error) {
      setFeedback(friendlyError(error));
    } finally {
      setLoadingMore(false);
    }
  };

  const submitWork = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || status !== 'ready' || !form.title.trim() || submitting) return;
    setSubmitting(true);
    setFeedback('');
    const clean = {
      workspaceId,
      title: form.title.trim(),
      reference: form.reference.trim(),
      assigneeUserId: form.assigneeUserId || null,
      dueDate: form.dueDate || null,
      notes: form.notes.trim(),
    };
    try {
      if (editingItemId) {
        const original = items.find((item) => item.item_id === editingItemId);
        if (!original) throw new Error('This work item is no longer loaded. Refresh the list and try again.');
        const version = await officeIndustryTasksApi.updateWorkItem(client, {
          ...clean, itemId: editingItemId, expectedVersion: original.version,
        });
        const now = new Date().toISOString();
        setItems((current) => current.map((item) => item.item_id === editingItemId
          ? { ...item, ...clean, version, updated_by: null, updated_at: now }
          : item));
        setHistoryByItem((current) => { const next = { ...current }; delete next[editingItemId]; return next; });
        setFeedback('Shared work item updated.');
      } else {
        await officeIndustryTasksApi.createWorkItem(client, { ...clean, idempotencyKey: newIdempotencyKey() });
        await loadFirstPage(client);
        setFeedback('Shared work item created for this Office Team.');
      }
      setForm(emptyForm);
      setEditingItemId(null);
    } catch (error) {
      setFeedback(friendlyError(error));
      if (error instanceof Error && /changed elsewhere|refresh before/i.test(error.message)) {
        try { await loadFirstPage(client); } catch { /* Keep the original concurrency message visible. */ }
      }
    } finally {
      setSubmitting(false);
    }
  };

  const beginEdit = (item: OfficeIndustryWorkItem) => {
    setEditingItemId(item.item_id);
    setForm({
      title: item.title,
      reference: item.reference,
      assigneeUserId: item.assignee_user_id ?? '',
      dueDate: item.due_date ?? '',
      notes: item.notes,
    });
    setFeedback('');
    window.setTimeout(() => formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 0);
  };

  const cancelEdit = () => { setEditingItemId(null); setForm(emptyForm); };

  const moveItem = async (item: OfficeIndustryWorkItem, direction: -1 | 1) => {
    if (!client || movingItemId) return;
    const stageIndex = definition.stages.indexOf(item.stage);
    const nextStage = definition.stages[stageIndex + direction];
    if (!nextStage) return;
    setMovingItemId(item.item_id);
    setFeedback('');
    try {
      const version = await officeIndustryTasksApi.moveWorkItem(client, {
        workspaceId, itemId: item.item_id, expectedVersion: item.version, direction,
      });
      setItems((current) => current.map((candidate) => candidate.item_id === item.item_id
        ? { ...candidate, stage: nextStage, version, updated_by: null, updated_at: new Date().toISOString() }
        : candidate));
      setHistoryByItem((current) => { const next = { ...current }; delete next[item.item_id]; return next; });
      setFeedback(`Moved to ${nextStage}.`);
    } catch (error) {
      setFeedback(friendlyError(error));
      if (error instanceof Error && /changed elsewhere|refresh before/i.test(error.message)) {
        try { await loadFirstPage(client); } catch { /* Keep the original concurrency message visible. */ }
      }
    } finally {
      setMovingItemId(null);
    }
  };

  const loadHistory = async (itemId: string, before?: OfficeIndustryCursor | null) => {
    if (!client || historyBusyId) return;
    const current = historyByItem[itemId];
    if (!before && current?.loaded) return;
    setHistoryBusyId(itemId);
    setHistoryByItem((previous) => ({
      ...previous,
      [itemId]: { events: current?.events ?? [], cursor: current?.cursor ?? null, hasMore: current?.hasMore ?? false, loading: true, loaded: current?.loaded ?? false },
    }));
    try {
      const page = await officeIndustryTasksApi.listWorkEvents(client, workspaceId, itemId, {
        limit: HISTORY_PAGE_SIZE, before: before ?? null,
      });
      setHistoryByItem((previous) => {
        const old = previous[itemId];
        const known = new Set(old?.events.map((event) => event.event_id) ?? []);
        const merged = before ? [...(old?.events ?? []), ...page.filter((event) => !known.has(event.event_id))] : page;
        return {
          ...previous,
          [itemId]: {
            events: merged,
            cursor: page.length ? cursorForEvent(page[page.length - 1]) : old?.cursor ?? null,
            hasMore: page.length === HISTORY_PAGE_SIZE,
            loading: false,
            loaded: true,
          },
        };
      });
    } catch (error) {
      setFeedback(friendlyError(error));
      setHistoryByItem((previous) => ({ ...previous, [itemId]: { ...(previous[itemId] ?? { events: [], cursor: null, hasMore: false, loaded: false }), loading: false } }));
    } finally {
      setHistoryBusyId(null);
    }
  };

  const visibleItems = useMemo(() => {
    const normalized = search.trim().toLocaleLowerCase();
    return items.filter((item) => !normalized || `${item.title} ${item.reference} ${item.stage} ${item.notes}`.toLocaleLowerCase().includes(normalized));
  }, [items, search]);
  const activeCount = items.filter((item) => item.stage !== definition.stages.at(-1)).length;
  const closedCount = items.filter((item) => item.stage === definition.stages.at(-1)).length;
  const dataPageCount = Math.ceil(items.length / PAGE_SIZE);

  return <section className="industry-shared-workspace" style={{ '--industry-accent': accent } as CSSProperties} aria-label="Shared industry team workbench">
    <div className="industry-shared-boundary" role="note">
      <ShieldAlert size={18} />
      <div><strong>Shared team data · operational notes only</strong><span>Active Office Team members can access these tasks. Do not enter sensitive, student, patient, beneficiary, financial, pastoral, or regulated information. This is not an approved records system. Device-local preview items are separate and are never copied here automatically.</span></div>
    </div>

    {feedback && <div className="industry-shared-feedback" role={/could not|invalid|denied|changed elsewhere|refresh|not loaded|unavailable|not configured|not enabled|not returned/i.test(feedback) ? 'alert' : 'status'}><CircleAlert size={15} />{feedback}<button type="button" aria-label="Dismiss message" onClick={() => setFeedback('')}><X size={14} /></button></div>}

    <header className="industry-shared-heading">
      <div><span className="eyebrow">SHARED OFFICE TEAM</span><h2>{space?.office_name ?? officeName}</h2><p>{space?.country ?? country} · {definition.label}</p></div>
      <button type="button" className="button-secondary" onClick={refreshTeam} disabled={status === 'loading'}><RefreshCw size={14} /> Refresh</button>
    </header>

    {status === 'loading' && <div className="industry-shared-state" role="status"><RefreshCw size={16} className="industry-spin" /> Checking Office sign-in, team membership, and shared profile…</div>}
    {status === 'signed-out' && <div className="industry-shared-state" role="status"><Users size={17} /><div><strong>Sign in to Office Team</strong><span>Open the linked team above, sign in to your existing COCCE account, then return here. No shared data was changed.</span></div></div>}
    {status === 'not-member' && <div className="industry-shared-state is-alert" role="alert"><CircleAlert size={17} /><div><strong>This team is not available to this account</strong><span>Check the signed-in Office account or ask to join this team. The server has not returned any shared work items.</span></div></div>}
    {status === 'error' && <div className="industry-shared-state is-alert" role="alert"><CircleAlert size={17} /><div><strong>Shared workbench is unavailable</strong><span>{feedback || 'The Office Team connection is not ready. The device-local preview remains separate.'}</span></div></div>}

    {status === 'setup-required' && <div className="industry-shared-setup glass-card">
      <div className="industry-shared-setup-icon"><Users size={20} /></div>
      <div><span className="eyebrow">EMPTY TEAM PROFILE</span><h3>Connect this team to {definition.shortLabel}</h3><p>This creates only the shared industry label for the linked Office Team. Existing items in this browser stay local and will not be imported. {canRegister ? 'Only an Office Team owner or admin can set it up.' : 'Ask the Office Team owner or admin to set it up.'}</p></div>
      <button type="button" className="button-primary" onClick={() => void registerSpace()} disabled={!canRegister || registering}>{registering ? <><RefreshCw size={14} className="industry-spin" /> Setting up…</> : <><Plus size={15} /> Create empty shared profile</>}</button>
    </div>}

    {status === 'profile-conflict' && <div className="industry-shared-state is-alert" role="alert"><CircleAlert size={17} /><div><strong>This team is set up for a different industry</strong><span>The shared team profile is “{space?.industry_id}”, not “{industryId}”. It has not been changed, and its tasks are not shown here.</span></div></div>}

    {status === 'ready' && space && <>
      {(space.office_name !== officeName || space.country !== country) && <div className="industry-shared-profile-note" role="note">The shared team uses its existing profile “{space.office_name}” ({space.country}). Your device-local office profile remains unchanged.</div>}
      <div className="industry-shared-metrics" aria-label="Shared work summary">
        <div className="industry-metric-card industry-metric-total"><span>Loaded work items</span><strong>{items.length}</strong><small>{hasMore ? `Page ${dataPageCount} · load more for complete list` : 'All available items loaded'}</small></div>
        <div className="industry-metric-card industry-metric-active"><span>Not closed</span><strong>{activeCount}</strong><small>Across loaded items</small></div>
        <div className="industry-metric-card industry-metric-closed"><span>Closed</span><strong>{closedCount}</strong><small>Across loaded items</small></div>
      </div>

      <div className="industry-shared-layout">
        <section className="industry-work-panel glass-card" aria-labelledby="industry-shared-list-title">
          <div className="industry-work-heading"><div><span className="eyebrow">{definition.workArea.toUpperCase()}</span><h2 id="industry-shared-list-title">Shared {definition.itemLabel}s</h2></div><label className="industry-search"><span className="sr-only">Search loaded shared work items</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search loaded items…" /></label></div>
          <div className="industry-work-register">
            {definition.stages.map((stage, stageIndex) => {
              const stageItems = visibleItems.filter((item) => item.stage === stage);
              return <section className={`industry-stage-column industry-stage-${stageIndex % 5}`} key={stage} aria-label={`${stage} shared items`}>
                <div className="industry-stage-heading"><span className="industry-stage-dot" /><h3>{stage}</h3><span className="industry-stage-count">{stageItems.length}</span></div>
                {stageItems.length === 0 ? <p className="industry-stage-empty">No items loaded</p> : stageItems.map((item) => {
                  const itemIndex = definition.stages.indexOf(item.stage);
                  const itemHistory = historyByItem[item.item_id];
                  return <article className="industry-work-card" key={item.item_id}>
                    <div className="industry-card-meta"><span className="industry-reference">{item.reference || 'No reference'}</span>{item.due_date && <span className="industry-due"><CalendarDays size={12} />{friendlyDate(item.due_date)}</span>}</div>
                    <h4>{item.title}</h4>
                    {item.notes && <p className="industry-card-notes">{item.notes}</p>}
                    <div className="industry-card-owner"><Users size={12} /><span>{item.assignee_user_id ? memberName(memberById.get(item.assignee_user_id)) : 'Unassigned'}</span><span className="industry-shared-version">v{item.version}</span></div>
                    <details className="industry-history" onToggle={(event) => { if (event.currentTarget.open && !itemHistory?.loaded) void loadHistory(item.item_id); }}>
                      <summary><History size={12} /> Shared history{itemHistory?.loaded ? ` · ${itemHistory.events.length}` : ''}</summary>
                      {itemHistory?.loading && <p className="industry-history-loading">Loading history…</p>}
                      {itemHistory?.events.length ? <ol>{itemHistory.events.map((entry) => <li key={entry.event_id}>
                        <span>{entry.event_kind === 'created' ? `Created · ${entry.to_stage ?? item.stage}` : entry.event_kind === 'stage_changed' ? `${entry.from_stage} → ${entry.to_stage}` : `Updated fields: ${entry.changed_fields.join(', ')}`}</span>
                        <small>{entry.actor_id ? memberName(memberById.get(entry.actor_id)) : 'Team member'}</small><time>{new Date(entry.created_at).toLocaleString()}</time>
                      </li>)}</ol> : itemHistory?.loaded && !itemHistory.loading ? <p className="industry-history-loading">No history returned.</p> : null}
                      {itemHistory?.hasMore && <button type="button" className="industry-history-more" disabled={historyBusyId === item.item_id} onClick={() => void loadHistory(item.item_id, itemHistory.cursor)}>{historyBusyId === item.item_id ? 'Loading…' : 'Load older history'}</button>}
                    </details>
                    <div className="industry-card-actions">
                      <button type="button" className="industry-move-button" disabled={itemIndex <= 0 || movingItemId === item.item_id} aria-label={`Move ${item.title} back one stage`} onClick={() => void moveItem(item, -1)}><ArrowLeft size={14} /> Back</button>
                      <button type="button" className="industry-edit-button" aria-label={`Edit ${item.title}`} onClick={() => beginEdit(item)}><Edit3 size={13} /> Edit</button>
                      <button type="button" className="industry-move-button is-forward" disabled={itemIndex < 0 || itemIndex >= definition.stages.length - 1 || movingItemId === item.item_id} aria-label={`Advance ${item.title} to next stage`} onClick={() => void moveItem(item, 1)}>Move forward <ArrowRight size={14} /></button>
                    </div>
                  </article>;
                })}
              </section>;
            })}
          </div>
          {visibleItems.length === 0 && <div className="industry-empty-work"><div className="industry-empty-icon"><History size={19} /></div><strong>{search ? 'No matching loaded items' : 'No shared work items yet'}</strong><span>{search ? 'Load more pages to extend the search.' : 'Add the first non-sensitive operational task for this team.'}</span></div>}
          {hasMore && <div className="industry-shared-load-more"><span>Search and counts use the items already loaded.</span><button type="button" className="button-secondary" disabled={loadingMore} onClick={() => void loadMoreItems()}>{loadingMore ? <><RefreshCw size={14} className="industry-spin" /> Loading…</> : 'Load next 100 items'}</button></div>}
        </section>

        <aside className="industry-work-side">
          <section ref={formRef} className="industry-add-panel glass-card" aria-labelledby="industry-shared-add-title">
            <div className="industry-side-heading"><span className="industry-side-icon">{editingItemId ? <Save size={17} /> : <Plus size={17} />}</span><div><span className="eyebrow">{editingItemId ? 'EDIT SHARED TASK' : 'ADD TO TEAM'}</span><h2 id="industry-shared-add-title">{editingItemId ? 'Update work item' : `New ${definition.itemLabel.toLowerCase()}`}</h2></div></div>
            <form className="industry-record-form" onSubmit={submitWork}>
              <label>Work item<input value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} maxLength={140} placeholder={`Describe a ${definition.itemLabel.toLowerCase()}`} required /></label>
              <label>{definition.referenceLabel}<input value={form.reference} onChange={(event) => setForm((current) => ({ ...current, reference: event.target.value }))} maxLength={100} placeholder="Optional" /></label>
              <label>Assign to active team member<select value={form.assigneeUserId} onChange={(event) => setForm((current) => ({ ...current, assigneeUserId: event.target.value }))}><option value="">Unassigned</option>{activeMembers.map((member) => <option value={member.user_id} key={member.user_id}>{memberName(member)}</option>)}</select></label>
              <label>Target date<input type="date" value={form.dueDate} onChange={(event) => setForm((current) => ({ ...current, dueDate: event.target.value }))} /></label>
              <label>Non-sensitive operational notes<textarea value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} maxLength={2000} rows={3} placeholder="Do not enter sensitive or regulated details" /></label>
              <div className="industry-shared-form-actions">
                {editingItemId && <button type="button" className="button-secondary" onClick={cancelEdit}>Cancel edit</button>}
                <button type="submit" className="button-primary industry-save-button" disabled={submitting || !form.title.trim()}>{submitting ? <><RefreshCw size={14} className="industry-spin" /> Saving…</> : <><Check size={15} /> {editingItemId ? 'Save shared changes' : 'Create shared task'}</>}</button>
              </div>
            </form>
            <p className="industry-stage-help"><Clock3 size={13} /> {definition.stages[0]} → {definition.stages.at(-1)} · updates use version checks; a conflict requires refresh.</p>
          </section>
          <section className="industry-privacy-card glass-card"><div className="industry-privacy-icon"><ShieldAlert size={18} /></div><strong>Keep shared notes non-sensitive</strong><p>These notes are available to active team members. Do not store student, patient, beneficiary, payment, identity, confidential, pastoral, or regulated details here.</p></section>
        </aside>
      </div>
    </>}
  </section>;
}
