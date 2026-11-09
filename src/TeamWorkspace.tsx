import { useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Archive, ArrowDownToLine, ArrowUpFromLine, BriefcaseBusiness, Building2, Check,
  ChevronDown, CircleAlert, FolderKanban, Layers3, ListTodo, LockKeyhole, Pencil,
  Plus, RotateCcw, Trash2, X,
} from 'lucide-react';
import {
  addLocalTeamItem, addLocalTeamTask, createLocalTeamBackup, getLocalTeamWorkspace,
  importLocalTeamBackup, readLocalTeamState, removeLocalTeamItem, removeLocalTeamTask,
  setLocalTeamItemArchived, updateLocalTeamItem, updateLocalTeamTask, writeLocalTeamState,
} from './lib/teamStore';
import type {
  LocalTeamItem, LocalTeamItemType, LocalTeamTask, LocalTeamTaskPriority, LocalTeamTaskStatus,
} from './lib/teamStore';
import { getIndustryDefinition, linkIndustryTeam, readIndustryState, writeIndustryState } from './lib/industryWorkspaces';
import type { IndustryTeamSetup } from './lib/industryWorkspaces';
import './team.css';
import OfficeTeamCollaboration from './OfficeTeamCollaboration';

const itemTypes: { id: LocalTeamItemType; label: string; icon: typeof Building2 }[] = [
  { id: 'department', label: 'Department', icon: Building2 },
  { id: 'team', label: 'Team', icon: BriefcaseBusiness },
  { id: 'project', label: 'Project', icon: FolderKanban },
  { id: 'channel', label: 'Channel', icon: Layers3 },
];

function formatDueDate(value: string | null) {
  if (!value) return 'No due date';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

function itemTypeLabel(type: LocalTeamItemType) {
  return itemTypes.find((item) => item.id === type)?.label ?? 'Item';
}

export default function TeamWorkspace({ workspaceId, workspaceName, query, industryTeamSetup = null, onIndustryTeamLinked }: {
  workspaceId: string | null;
  workspaceName: string;
  query: string;
  industryTeamSetup?: IndustryTeamSetup | null;
  onIndustryTeamLinked?: () => void;
}) {
  const [state, setState] = useState(() => readLocalTeamState(window.localStorage));
  const [feedback, setFeedback] = useState('');
  const [itemFormOpen, setItemFormOpen] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemType, setItemType] = useState<LocalTeamItemType>('department');
  const [itemName, setItemName] = useState('');
  const [itemDescription, setItemDescription] = useState('');
  const [itemParentId, setItemParentId] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [typeFilter, setTypeFilter] = useState<'all' | LocalTeamItemType>('all');
  const [taskTitle, setTaskTitle] = useState('');
  const [taskNotes, setTaskNotes] = useState('');
  const [taskProjectId, setTaskProjectId] = useState('');
  const [taskPriority, setTaskPriority] = useState<LocalTeamTaskPriority>('medium');
  const [taskDueDate, setTaskDueDate] = useState('');
  const [taskFilter, setTaskFilter] = useState<'open' | 'all' | 'done'>('open');
  const importInput = useRef<HTMLInputElement>(null);
  const scoped = useMemo(() => getLocalTeamWorkspace(state, workspaceId), [state, workspaceId]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleItems = useMemo(() => scoped.items
    .filter((item) => showArchived || !item.archived)
    .filter((item) => typeFilter === 'all' || item.type === typeFilter)
    .filter((item) => !normalizedQuery || `${item.name} ${item.description} ${itemTypeLabel(item.type)}`.toLocaleLowerCase().includes(normalizedQuery))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)),
  [scoped.items, showArchived, typeFilter, normalizedQuery]);
  const visibleTasks = useMemo(() => scoped.tasks
    .filter((task) => taskFilter === 'all' || (taskFilter === 'done' ? task.status === 'done' : task.status !== 'done'))
    .filter((task) => !normalizedQuery || `${task.title} ${task.notes} ${scoped.items.find((item) => item.id === task.projectId)?.name ?? ''}`.toLocaleLowerCase().includes(normalizedQuery))
    .sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31') || b.createdAt.localeCompare(a.createdAt)),
  [scoped.tasks, scoped.items, taskFilter, normalizedQuery]);
  const activeProjects = scoped.items.filter((item) => item.type === 'project' && !item.archived).sort((a, b) => a.name.localeCompare(b.name));
  const activeItems = scoped.items.filter((item) => !item.archived);
  const openTaskCount = scoped.tasks.filter((task) => task.status !== 'done').length;
  const linkedIndustryTeamId = industryTeamSetup?.teamWorkspaceId?.trim() || undefined;
  const suggestedIndustryTeamName = industryTeamSetup && !linkedIndustryTeamId
    ? `${industryTeamSetup.officeName} · ${getIndustryDefinition(industryTeamSetup.industryId).shortLabel}`.slice(0, 80)
    : undefined;

  const commit = (next: ReturnType<typeof readLocalTeamState>, successMessage: string) => {
    try {
      writeLocalTeamState(window.localStorage, next);
      setState(next);
      setFeedback(successMessage);
      return true;
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Planner changes could not be saved in this browser.');
      return false;
    }
  };

  const handleIndustryTeamCreated = (teamWorkspaceId: string, teamName: string) => {
    if (!industryTeamSetup) return;
    try {
      const current = readIndustryState(window.localStorage);
      if (current.issue) throw new Error(current.issue);
      const next = linkIndustryTeam(current.state, industryTeamSetup.officeId, teamWorkspaceId);
      if (next === current.state) throw new Error('The industry office no longer exists in this browser.');
      writeIndustryState(window.localStorage, next);
      setFeedback(`Office Team “${teamName}” created. Its workspace ID is linked locally; industry work items remain on this device and are not shared.`);
      onIndustryTeamLinked?.();
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Local browser storage is unavailable.';
      setFeedback(`Office Team “${teamName}” was created, but its ID could not be linked to the local industry office: ${detail}`);
    }
  };

  const startNewItem = () => {
    setEditingItemId(null);
    setItemType('department');
    setItemName('');
    setItemDescription('');
    setItemParentId('');
    setItemFormOpen(true);
  };

  const startEditItem = (item: LocalTeamItem) => {
    setEditingItemId(item.id);
    setItemType(item.type);
    setItemName(item.name);
    setItemDescription(item.description);
    setItemParentId(item.parentId ?? '');
    setItemFormOpen(true);
  };

  const closeItemForm = () => {
    setItemFormOpen(false);
    setEditingItemId(null);
  };

  const submitItem = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editingItemId) {
      const next = updateLocalTeamItem(state, workspaceId, editingItemId, {
        type: itemType, name: itemName, description: itemDescription, parentId: itemParentId || null,
      });
      if (next === state) {
        setFeedback('This change is invalid or duplicates an item at the same level. Check the name and parent.');
        return;
      }
      if (commit(next, 'Structure item updated on this device.')) closeItemForm();
      return;
    }
    const result = addLocalTeamItem(state, workspaceId, {
      type: itemType, name: itemName, description: itemDescription, parentId: itemParentId || null,
    });
    if (!result.item) {
      setFeedback('Add a unique name and choose a valid parent, or check the local item limit.');
      return;
    }
    if (commit(result.state, 'Structure item saved on this device.')) closeItemForm();
  };

  const archiveItem = (item: LocalTeamItem) => {
    const next = setLocalTeamItemArchived(state, workspaceId, item.id, !item.archived);
    if (next === state) {
      setFeedback('Resolve active children before archiving, or restore the parent before restoring this item.');
      return;
    }
    commit(next, item.archived ? 'Item restored on this device.' : 'Item archived on this device.');
  };

  const deleteItem = (item: LocalTeamItem) => {
    const next = removeLocalTeamItem(state, workspaceId, item.id);
    if (next === state) {
      setFeedback('This item has child items or tasks. Move or remove those first.');
      return;
    }
    commit(next, 'Item deleted from this device.');
  };

  const submitTask = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = addLocalTeamTask(state, workspaceId, {
      title: taskTitle,
      notes: taskNotes,
      projectId: taskProjectId || null,
      priority: taskPriority,
      dueDate: taskDueDate || null,
    });
    if (!result.task) {
      setFeedback('Enter a task title, choose an active project, or check the local task limit.');
      return;
    }
    if (commit(result.state, 'Task saved on this device.')) {
      setTaskTitle('');
      setTaskNotes('');
      setTaskProjectId('');
      setTaskPriority('medium');
      setTaskDueDate('');
    }
  };

  const updateTaskStatus = (task: LocalTeamTask, status: LocalTeamTaskStatus) => {
    commit(updateLocalTeamTask(state, workspaceId, task.id, { status }), 'Task status saved on this device.');
  };

  const deleteTask = (task: LocalTeamTask) => {
    commit(removeLocalTeamTask(state, workspaceId, task.id), 'Task deleted from this device.');
  };

  const exportBackup = () => {
    const blob = new Blob([createLocalTeamBackup(state, workspaceId)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const fileBase = (workspaceName || 'personal-space').replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'personal-space';
    anchor.href = url;
    anchor.download = `cocce-office-team-planner-${fileBase}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFeedback('A device-local planner backup was downloaded. It has not been synced.');
  };

  const importBackup = async (event: FormEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) {
      setFeedback('This backup is larger than 5 MB.');
      return;
    }
    try {
      const result = importLocalTeamBackup(state, workspaceId, await file.text());
      if (result.error) {
        setFeedback(result.error);
        return;
      }
      if (commit(result.state, `Imported ${result.importedItems} items and ${result.importedTasks} tasks into this device.`)) {
        setItemFormOpen(false);
      }
    } catch {
      setFeedback('Could not read this backup file. The existing planner data was not changed.');
    }
  };

  return (
    <div className="page subpage team-planner-page">
      <div className="team-page-heading">
        <div>
          <span className="eyebrow">COCCE TEAM · LOCAL PLANNER</span>
          <h1>Organize the work</h1>
          <p className="page-lede">Plan departments, teams, projects, channels, and personal tasks for <strong>{workspaceName}</strong>.</p>
        </div>
        <div className="team-heading-actions">
          <button className="button-secondary team-transfer-button" onClick={exportBackup}><ArrowDownToLine size={16} /> Export backup</button>
          <button className="button-secondary team-transfer-button" onClick={() => importInput.current?.click()}><ArrowUpFromLine size={16} /> Import backup</button>
          <input ref={importInput} className="team-hidden-file" type="file" accept="application/json,.json" onChange={importBackup} aria-label="Import Team Planner JSON backup" tabIndex={-1} />
        </div>
      </div>

      <div className="team-local-notice" role="note"><LockKeyhole size={16} /><span><strong>Local planning only.</strong> The structure and tasks below stay in this browser; they are not linked to Office memberships or conversations in the separate collaboration panel.</span></div>
      {industryTeamSetup && <div className="team-industry-setup" role="note"><Building2 size={17} /><span><strong>{linkedIndustryTeamId ? `Opening the linked team for ${industryTeamSetup.officeName}` : `Creating a team for ${industryTeamSetup.officeName}`}</strong><small>{getIndustryDefinition(industryTeamSetup.industryId).label} · the server-backed team is separate from this device-local industry work register.</small></span></div>}
      <OfficeTeamCollaboration initialWorkspaceName={suggestedIndustryTeamName} initialWorkspaceId={linkedIndustryTeamId} initialSuiteId={industryTeamSetup?.industryId} onWorkspaceCreated={handleIndustryTeamCreated} />
      {feedback && <div className="team-feedback" role={/could not|not saved|invalid|limit|larger|malformed|conflict|move or|resolve active|storage|quota|write failed/i.test(feedback) ? 'alert' : 'status'}><CircleAlert size={15} />{feedback}<button className="team-feedback-close" onClick={() => setFeedback('')} aria-label="Dismiss message"><X size={14} /></button></div>}

      <div className="team-planner-grid">
        <section className="team-panel glass-card" aria-labelledby="structure-title">
          <div className="team-panel-heading">
            <div className="team-panel-title-icon structure-title-icon"><Building2 size={18} /></div>
            <div className="team-panel-heading-copy"><span className="eyebrow">YOUR WORKSPACE MAP</span><h2 id="structure-title">Structure</h2><p>Local organizational labels</p></div>
            <button className="button-primary team-add-button" onClick={startNewItem}><Plus size={15} /> Add item</button>
          </div>
          <div className="team-filter-row">
            <label className="team-select-wrap"><span className="sr-only">Filter structure by type</span><select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as 'all' | LocalTeamItemType)}><option value="all">All types</option>{itemTypes.map((item) => <option key={item.id} value={item.id}>{item.label}s</option>)}</select><ChevronDown size={14} /></label>
            <button className={`team-toggle-filter ${showArchived ? 'is-active' : ''}`} aria-pressed={showArchived} onClick={() => setShowArchived((value) => !value)}>{showArchived ? 'Showing archived' : 'Include archived'}</button>
          </div>
          {itemFormOpen && <form className="team-inline-form" onSubmit={submitItem}>
            <div className="team-form-heading"><strong>{editingItemId ? 'Edit structure item' : 'Add to this workspace'}</strong><button type="button" className="team-small-icon-button" onClick={closeItemForm} aria-label="Close structure form"><X size={15} /></button></div>
            <div className="team-form-grid">
              <label className="team-field">Type<select value={itemType} onChange={(event) => setItemType(event.target.value as LocalTeamItemType)}>{itemTypes.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
              <label className="team-field">Name<input value={itemName} onChange={(event) => setItemName(event.target.value)} maxLength={72} placeholder="e.g. Operations" required /></label>
              <label className="team-field">Parent (optional)<select value={itemParentId} onChange={(event) => setItemParentId(event.target.value)}><option value="">Top level</option>{activeItems.filter((item) => item.id !== editingItemId).map((item) => <option key={item.id} value={item.id}>{itemTypeLabel(item.type)} · {item.name}</option>)}</select></label>
              <label className="team-field">Description<input value={itemDescription} onChange={(event) => setItemDescription(event.target.value)} maxLength={280} placeholder="A short note about this area" /></label>
            </div>
            <div className="team-form-actions"><button type="button" className="button-secondary" onClick={closeItemForm}>Cancel</button><button type="submit" className="button-primary"><Check size={15} /> {editingItemId ? 'Save changes' : 'Save item'}</button></div>
          </form>}
          <div className="team-structure-list">
            {visibleItems.length === 0 ? <div className="team-empty-state"><div className="team-empty-icon"><Building2 size={21} /></div><h3>{normalizedQuery ? 'No matching structure' : 'Start with a simple outline'}</h3><p>{normalizedQuery ? 'Try another search term or type filter.' : 'Add a department, team, project, or channel. Nothing is pre-filled.'}</p>{!normalizedQuery && <button className="button-tertiary" onClick={startNewItem}><Plus size={14} /> Add first item</button>}</div> : visibleItems.map((item) => {
              const Icon = itemTypes.find((type) => type.id === item.type)?.icon ?? Layers3;
              const parent = scoped.items.find((candidate) => candidate.id === item.parentId);
              return <article className={`team-structure-item ${item.archived ? 'is-archived' : ''}`} key={item.id}>
                <span className={`team-item-icon team-item-${item.type}`}><Icon size={16} /></span>
                <div className="team-item-main"><div className="team-item-title-row"><strong>{item.name}</strong>{item.archived && <span className="team-archived-tag">Archived</span>}</div><small>{itemTypeLabel(item.type)}{parent ? ` · under ${parent.name}` : ''}{item.description ? ` · ${item.description}` : ''}</small></div>
                <div className="team-item-actions"><button className="team-small-icon-button" onClick={() => startEditItem(item)} aria-label={`Edit ${item.name}`} title="Edit"><Pencil size={14} /></button><button className="team-small-icon-button" onClick={() => archiveItem(item)} aria-label={item.archived ? `Restore ${item.name}` : `Archive ${item.name}`} title={item.archived ? 'Restore' : 'Archive'}>{item.archived ? <RotateCcw size={14} /> : <Archive size={14} />}</button><button className="team-small-icon-button team-danger-button" onClick={() => deleteItem(item)} aria-label={`Delete ${item.name}`} title="Delete"><Trash2 size={14} /></button></div>
              </article>;
            })}
          </div>
          <div className="team-panel-footer"><span>{visibleItems.length} visible · {scoped.items.length} saved in this space</span><span>Private to this browser</span></div>
        </section>

        <section className="team-panel glass-card" aria-labelledby="tasks-title">
          <div className="team-panel-heading">
            <div className="team-panel-title-icon task-title-icon"><ListTodo size={18} /></div>
            <div className="team-panel-heading-copy"><span className="eyebrow">PERSONAL FOLLOW-THROUGH</span><h2 id="tasks-title">My tasks</h2><p>{openTaskCount} open · local to this device</p></div>
          </div>
          <form className="team-task-form" onSubmit={submitTask}>
            <label className="team-field">Task title<input value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} maxLength={180} placeholder="What needs to get done?" required /></label>
            <div className="team-task-form-row">
              <label className="team-field">Project<select value={taskProjectId} onChange={(event) => setTaskProjectId(event.target.value)}><option value="">No project</option>{activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
              <label className="team-field">Priority<select value={taskPriority} onChange={(event) => setTaskPriority(event.target.value as LocalTeamTaskPriority)}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
              <label className="team-field">Due date<input type="date" value={taskDueDate} onChange={(event) => setTaskDueDate(event.target.value)} /></label>
            </div>
            <label className="team-field">Notes <span className="team-optional-label">optional</span><textarea value={taskNotes} onChange={(event) => setTaskNotes(event.target.value)} maxLength={1000} rows={2} placeholder="Keep a little context with the task" /></label>
            <button type="submit" className="button-primary team-task-submit"><Plus size={15} /> Add personal task</button>
          </form>
          <div className="team-task-list-heading"><strong>Task list</strong><label className="team-select-wrap"><span className="sr-only">Filter tasks</span><select value={taskFilter} onChange={(event) => setTaskFilter(event.target.value as 'open' | 'all' | 'done')}><option value="open">Open</option><option value="all">All tasks</option><option value="done">Completed</option></select><ChevronDown size={14} /></label></div>
          <div className="team-task-list">
            {visibleTasks.length === 0 ? <div className="team-task-empty"><Check size={16} /><span>{normalizedQuery ? 'No matching tasks.' : taskFilter === 'done' ? 'No completed tasks yet.' : taskFilter === 'open' && scoped.tasks.length > 0 ? 'You are all caught up.' : 'Add a personal task to keep a next step in view.'}</span></div> : visibleTasks.map((task) => {
              const project = scoped.items.find((item) => item.id === task.projectId);
              return <article key={task.id} className={`team-task-row task-status-${task.status} ${task.status === 'done' ? 'task-is-done' : ''}`}>
                <label className="team-task-status-label"><span className="sr-only">Status for {task.title}</span><select value={task.status} onChange={(event) => updateTaskStatus(task, event.target.value as LocalTeamTaskStatus)} aria-label={`Status for ${task.title}`}><option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option></select></label>
                <div className="team-task-main"><strong>{task.title}</strong><small>{[project?.name, formatDueDate(task.dueDate), task.notes].filter(Boolean).join(' · ')}</small></div>
                <span className={`team-priority priority-${task.priority}`}>{task.priority}</span>
                <button className="team-small-icon-button team-danger-button" onClick={() => deleteTask(task)} aria-label={`Delete task ${task.title}`} title="Delete task"><Trash2 size={14} /></button>
              </article>;
            })}
          </div>
          <div className="team-panel-footer"><span>Tasks are personal notes, not assignments.</span><span>{scoped.tasks.length} total</span></div>
        </section>
      </div>
      <div className="team-privacy-note"><LockKeyhole size={14} /><span>This planner uses browser storage. Clearing site data can remove it; export a JSON backup if you need a separate copy. It is not a shared collaboration service.</span></div>
    </div>
  );
}
