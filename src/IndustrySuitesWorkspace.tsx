import { useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import {
  ArrowLeft, ArrowRight, Building2, CalendarDays, Check,
  CircleAlert, Clock3, FileText, GraduationCap, LockKeyhole, Plus, ShieldAlert, Sparkles, Users, X,
} from 'lucide-react';
import {
  addIndustryWorkItem, advanceIndustryWorkItem, createIndustryOffice,
  emptyIndustryState, getIndustryDefinition, industryCatalog, readIndustryState,
  returnIndustryWorkItem, writeIndustryState,
} from './lib/industryWorkspaces';
import type { IndustryId, IndustryState, IndustryTeamSetup } from './lib/industryWorkspaces';
import IndustrySharedWorkspace from './IndustrySharedWorkspace';
import GovernmentCorrespondenceWorkspace from './GovernmentCorrespondenceWorkspace';
import SchoolManagementWorkspace from './SchoolManagementWorkspace';
import UniversityManagementWorkspace from './UniversityManagementWorkspace';
import './industrySuites.css';

const accentByIndustry: Record<IndustryId, string> = {
  government: '#ff9b63', school: '#55d5c3', university: '#77a9ff', business: '#be91ff',
  accounting: '#ffd166', manufacturing: '#ff846e', 'healthcare-admin': '#67c6e9',
  ngo: '#87d986', hospitality: '#f39ac0', church: '#b7a1ff',
};

function readInitialState() {
  try { return readIndustryState(window.localStorage); }
  catch { return { state: emptyIndustryState(), issue: 'Browser storage is unavailable. Existing industry data has not been changed.' }; }
}

function friendlyDate(value: string | null) {
  if (!value) return 'No due date';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T12:00:00`));
}

export default function IndustrySuitesWorkspace({
  preferredIndustryId,
  onCreateTeam,
}: {
  preferredIndustryId: IndustryId | null;
  onCreateTeam: (setup: IndustryTeamSetup) => void;
}) {
  const [initial] = useState(readInitialState);
  const [state, setState] = useState<IndustryState>(initial.state);
  const [storageIssue, setStorageIssue] = useState(initial.issue);
  const officesForEntry = preferredIndustryId
    ? initial.state.offices.filter((office) => office.industryId === preferredIndustryId)
    : initial.state.offices;
  const initialOffice = officesForEntry.find((office) => Boolean(office.teamWorkspaceId)) ?? officesForEntry[0] ?? null;
  const [selectedOfficeId, setSelectedOfficeId] = useState<string | null>(initialOffice?.id ?? null);
  const [createOpen, setCreateOpen] = useState(() => preferredIndustryId
    ? !initial.state.offices.some((office) => office.industryId === preferredIndustryId)
    : initial.state.offices.length === 0);
  const [industryId, setIndustryId] = useState<IndustryId>(preferredIndustryId ?? 'business');
  const [officeName, setOfficeName] = useState('');
  const [country, setCountry] = useState('Tanzania');
  const [title, setTitle] = useState('');
  const [reference, setReference] = useState('');
  const [owner, setOwner] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');
  const [recordSearch, setRecordSearch] = useState('');
  const [feedback, setFeedback] = useState('');
  const [dataMode, setDataMode] = useState<'device' | 'shared'>('shared');
  const [governmentPanel, setGovernmentPanel] = useState<'correspondence' | 'tasks'>('correspondence');
  const [schoolPanel, setSchoolPanel] = useState<'management' | 'tasks'>('management');
  const [universityPanel, setUniversityPanel] = useState<'management' | 'tasks'>('management');

  const activeOffice = state.offices.find((office) => office.id === selectedOfficeId) ?? null;
  const definition = activeOffice ? getIndustryDefinition(activeOffice.industryId) : null;
  const accent = activeOffice ? accentByIndustry[activeOffice.industryId] : accentByIndustry[industryId];
  const sharedWorkspaceLabel = definition?.id === 'school' ? 'School Management system'
    : definition?.id === 'government' ? 'Government Correspondence workspace'
      : `${definition?.shortLabel ?? 'industry'} shared work-item workspace`;
  const visibleItems = useMemo(() => {
    if (!activeOffice) return [];
    const normalized = recordSearch.trim().toLocaleLowerCase();
    return activeOffice.items
      .filter((item) => !normalized || `${item.title} ${item.reference} ${item.owner} ${item.notes} ${item.stage}`.toLocaleLowerCase().includes(normalized))
      .sort((a, b) => Number(a.stage === definition?.stages.at(-1)) - Number(b.stage === definition?.stages.at(-1))
        || (a.dueDate ?? '9999-12-31').localeCompare(b.dueDate ?? '9999-12-31')
        || b.updatedAt.localeCompare(a.updatedAt));
  }, [activeOffice, definition, recordSearch]);

  const persist = (next: IndustryState, success: string) => {
    try {
      writeIndustryState(window.localStorage, next);
      setState(next);
      setStorageIssue(null);
      setFeedback(success);
      return true;
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'The industry work register could not be saved.');
      return false;
    }
  };

  const submitOffice = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const created = createIndustryOffice(state, { industryId, name: officeName, country });
    if (!created.office) {
      setFeedback('Enter an office name and country, or check the local industry workspace limit.');
      return;
    }
    if (persist(created.state, `${getIndustryDefinition(industryId).shortLabel} office profile saved. Opening Office Team setup.`)) {
      setSelectedOfficeId(created.office.id);
      setDataMode('shared');
      setGovernmentPanel('correspondence');
      setSchoolPanel('management');
      setUniversityPanel('management');
      setOfficeName('');
      setCreateOpen(false);
      setRecordSearch('');
      onCreateTeam({ officeId: created.office.id, officeName: created.office.name, industryId: created.office.industryId, teamWorkspaceId: created.office.teamWorkspaceId });
    }
  };

  const submitWork = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!activeOffice) return;
    const created = addIndustryWorkItem(state, activeOffice.id, { title, reference, owner, dueDate: dueDate || null, notes });
    if (!created.item) {
      setFeedback('Enter a work-item title and check the local record limits.');
      return;
    }
    if (persist(created.state, `${definition?.itemLabel ?? 'Work item'} saved on this device.`)) {
      setTitle(''); setReference(''); setOwner(''); setDueDate(''); setNotes('');
    }
  };

  const moveItem = (itemId: string, direction: 'back' | 'forward') => {
    if (!activeOffice) return;
    const next = direction === 'forward'
      ? advanceIndustryWorkItem(state, activeOffice.id, itemId)
      : returnIndustryWorkItem(state, activeOffice.id, itemId);
    if (next !== state) persist(next, 'Work stage updated on this device.');
  };

  const openTeam = () => {
    if (!activeOffice) return;
    onCreateTeam({
      officeId: activeOffice.id,
      officeName: activeOffice.name,
      industryId: activeOffice.industryId,
      teamWorkspaceId: activeOffice.teamWorkspaceId,
    });
  };

  const activeCount = activeOffice && definition
    ? activeOffice.items.filter((item) => item.stage !== definition.stages.at(-1)).length : 0;
  const closedCount = activeOffice && definition
    ? activeOffice.items.filter((item) => item.stage === definition.stages.at(-1)).length : 0;

  return <div className="page subpage industry-page" style={{ '--industry-accent': accent } as CSSProperties}>
    <div className="industry-page-heading">
      <div>
        <span className="eyebrow industry-eyebrow"><Sparkles size={13} /> OFFICE SUITES · {activeOffice?.teamWorkspaceId && dataMode === 'shared' ? 'SHARED OFFICE TEAM' : dataMode === 'shared' ? 'TEAM SETUP REQUIRED' : 'DEVICE-LOCAL PREVIEW'}</span>
        <h1>Work for your industry</h1>
        <p className="page-lede">Choose a sector and track operational work in its sector-specific register. Device-local preview and shared Office Team tasks stay separate.</p>
      </div>
      <button className="button-primary" onClick={() => { setIndustryId(preferredIndustryId ?? 'business'); setDataMode('shared'); setCreateOpen(true); }}><Plus size={16} /> New office</button>
    </div>

    {dataMode === 'device' && <div className="industry-boundary-note" role="note">
        <LockKeyhole size={17} />
        <div><strong>Prototype only · use non-sensitive data.</strong><span>This is not a complete sector suite or secure cloud workspace. Office records are saved in this browser, not encrypted, shared with team members, or backed up. Team membership and chat use a separate server-backed feature. This preview is not an accounting or payroll system, clinical record, approved government system, or statutory integration.</span></div>
    </div>}

    {storageIssue && <div className="industry-alert" role="alert"><CircleAlert size={16} />{storageIssue}</div>}
    {feedback && <div className="industry-feedback" role={/could not|unreadable|unsupported|not saved|limit/i.test(feedback) ? 'alert' : 'status'}><Check size={15} />{feedback}<button type="button" aria-label="Dismiss message" onClick={() => setFeedback('')}><X size={14} /></button></div>}

    {state.offices.length > 0 && <div className="industry-office-picker" role="group" aria-label="Your industry offices">
      {state.offices.map((office) => {
        const officeIndustry = getIndustryDefinition(office.industryId);
        return <button key={office.id} className={`industry-office-chip ${office.id === selectedOfficeId && !createOpen ? 'is-active' : ''}`} onClick={() => { setSelectedOfficeId(office.id); setIndustryId(office.industryId); setCreateOpen(false); setDataMode('shared'); setGovernmentPanel('correspondence'); setSchoolPanel('management'); setUniversityPanel('management'); setRecordSearch(''); }}>
          <span className="industry-chip-dot" style={{ background: accentByIndustry[office.industryId] }} />
          <span><strong>{office.name}</strong><small>{officeIndustry.shortLabel}</small></span>
        </button>;
      })}
    </div>}

    {createOpen && <section className="industry-create-card glass-card" aria-labelledby="industry-create-title">
      <div className="industry-section-heading"><div className="industry-heading-icon"><Building2 size={19} /></div><div><span className="eyebrow">START WITH A SECTOR</span><h2 id="industry-create-title">Create an industry office</h2><p>This saves the office profile locally, then opens Office Team setup for the shared industry workspace. Existing local preview items are never copied.</p></div></div>
      <div className="industry-catalog-grid" role="group" aria-label="Choose an industry">
        {industryCatalog.map((industry) => <button type="button" key={industry.id} className={`industry-option-card ${industryId === industry.id ? 'is-selected' : ''}`} style={{ '--option-accent': accentByIndustry[industry.id] } as CSSProperties} aria-pressed={industryId === industry.id} onClick={() => setIndustryId(industry.id)}>
          <span className="industry-option-orb">{industry.shortLabel.slice(0, 1)}</span><span><strong>{industry.label}</strong><small>{industry.summary}</small></span><span className="industry-option-check"><Check size={15} /></span>
        </button>)}
      </div>
      <form className="industry-office-form" onSubmit={submitOffice}>
        <label>Office or organization name<input value={officeName} onChange={(event) => setOfficeName(event.target.value)} maxLength={100} placeholder="e.g. Kijiji School" required disabled={Boolean(storageIssue)} /></label>
        <label>Country<input value={country} onChange={(event) => setCountry(event.target.value)} maxLength={48} placeholder="Country" disabled={Boolean(storageIssue)} /></label>
        <div className="industry-form-actions">{state.offices.length > 0 && <button type="button" className="button-secondary" onClick={() => setCreateOpen(false)}>Cancel</button>}<button type="submit" className="button-primary" disabled={Boolean(storageIssue)}><Plus size={15} /> Create {getIndustryDefinition(industryId).shortLabel} office</button></div>
      </form>
      <p className="industry-sector-note"><ShieldAlert size={14} />{getIndustryDefinition(industryId).dataNote}</p>
    </section>}

    {activeOffice && definition && !createOpen && activeOffice.teamWorkspaceId && <div className="industry-data-mode" role="tablist" aria-label="Industry workbench storage mode">
      <button type="button" role="tab" aria-selected={dataMode === 'device'} className={dataMode === 'device' ? 'is-active' : ''} onClick={() => setDataMode('device')}><LockKeyhole size={14} /> This device preview</button>
      <button type="button" role="tab" aria-selected={dataMode === 'shared'} className={dataMode === 'shared' ? 'is-active' : ''} onClick={() => setDataMode('shared')}><Users size={14} /> Shared team</button>
      <span>Local items are never copied automatically.</span>
    </div>}

    {activeOffice && definition && !createOpen && !activeOffice.teamWorkspaceId && dataMode === 'shared' && <section className="industry-team-gate glass-card" aria-labelledby="industry-team-gate-title">
      <div className="industry-heading-icon"><Users size={19} /></div>
      <span className="eyebrow">OFFICE TEAM REQUIRED</span>
      <h2 id="industry-team-gate-title">Connect {activeOffice.name} to its shared workspace</h2>
      <p>Create an Office Team workspace to open the {sharedWorkspaceLabel}. This office profile and any existing device-local preview items stay separate; nothing is imported automatically.</p>
      <div className="industry-form-actions"><button type="button" className="button-primary" onClick={openTeam}><Users size={15} /> Create or link Office Team</button><button type="button" className="button-secondary" onClick={() => setDataMode('device')}>Open device-local preview</button></div>
    </section>}

    {activeOffice && definition && !createOpen && dataMode === 'device' && <>
      <section className="industry-office-hero glass-card">
        <div className="industry-office-hero-main"><span className="industry-office-mark"><Building2 size={22} /></span><div><span className="eyebrow">{definition.label.toUpperCase()} · {activeOffice.country.toUpperCase()}</span><h2>{activeOffice.name}</h2><p>{definition.workArea} · Local workspace</p></div></div>
        <div className="industry-office-actions"><span className={`industry-team-status ${activeOffice.teamWorkspaceId ? 'is-linked' : ''}`}><Users size={14} />{activeOffice.teamWorkspaceId ? 'Team linked' : 'No team yet'}</span><button className="button-secondary industry-team-button" onClick={openTeam}><Users size={15} />{activeOffice.teamWorkspaceId ? 'Open team' : 'Create team'}</button></div>
      </section>

      <section className="industry-metrics" aria-label="Office work summary">
        <div className="industry-metric-card industry-metric-total"><span>Work items</span><strong>{activeOffice.items.length}</strong><small>Saved in this browser</small></div>
        <div className="industry-metric-card industry-metric-active"><span>In progress</span><strong>{activeCount}</strong><small>Not yet closed</small></div>
        <div className="industry-metric-card industry-metric-closed"><span>Closed</span><strong>{closedCount}</strong><small>No automatic actions</small></div>
      </section>

      <div className="industry-work-layout">
        <section className="industry-work-panel glass-card" aria-labelledby="industry-work-title">
          <div className="industry-work-heading"><div><span className="eyebrow">{definition.workArea.toUpperCase()}</span><h2 id="industry-work-title">{definition.itemLabel}s</h2></div><label className="industry-search"><span className="sr-only">Search work items</span><input value={recordSearch} onChange={(event) => setRecordSearch(event.target.value)} placeholder="Find work…" /></label></div>
          <div className="industry-work-register">
            {definition.stages.map((stage, stageIndex) => {
              const items = visibleItems.filter((item) => item.stage === stage);
              return <section className={`industry-stage-column industry-stage-${stageIndex % 5}`} key={stage} aria-label={`${stage} items`}>
                <div className="industry-stage-heading"><span className="industry-stage-dot" /><h3>{stage}</h3><span className="industry-stage-count">{items.length}</span></div>
                {items.length === 0 ? <p className="industry-stage-empty">No items</p> : items.map((item) => <article className="industry-work-card" key={item.id}>
                  <div className="industry-card-meta"><span className="industry-reference">{item.reference || 'No reference'}</span>{item.dueDate && <span className="industry-due"><CalendarDays size={12} />{friendlyDate(item.dueDate)}</span>}</div>
                  <h4>{item.title}</h4>
                  {item.notes && <p className="industry-card-notes">{item.notes}</p>}
                  <div className="industry-card-owner"><Users size={12} /><span>{item.owner || 'No owner noted'}</span></div>
                  <details className="industry-history"><summary>Local stage history · {item.history.length}</summary><ol>{item.history.map((event, index) => <li key={`${event.at}-${index}`}><span>{event.from ? `${event.from} → ` : 'Created at '}{event.to}</span><time>{new Date(event.at).toLocaleString()}</time></li>)}</ol></details>
                  <div className="industry-card-actions">
                    <button type="button" className="industry-move-button" disabled={stageIndex === 0 || Boolean(storageIssue)} aria-label={`Move ${item.title} back one stage`} onClick={() => moveItem(item.id, 'back')}><ArrowLeft size={14} /> Back</button>
                    <button type="button" className="industry-move-button is-forward" disabled={stageIndex === definition.stages.length - 1 || Boolean(storageIssue)} aria-label={`Advance ${item.title} to next stage`} onClick={() => moveItem(item.id, 'forward')}>Move forward <ArrowRight size={14} /></button>
                  </div>
                </article>)}
              </section>;
            })}
          </div>
          {visibleItems.length === 0 && <div className="industry-empty-work"><div className="industry-empty-icon"><FileText size={19} /></div><strong>{recordSearch ? 'No matching work items' : 'Nothing in the register yet'}</strong><span>{recordSearch ? 'Try a different search.' : `Add a ${definition.itemLabel.toLowerCase()} to begin.`}</span></div>}
        </section>

        <aside className="industry-work-side">
          <section className="industry-add-panel glass-card" aria-labelledby="industry-add-title">
            <div className="industry-side-heading"><span className="industry-side-icon"><Plus size={17} /></span><div><span className="eyebrow">ADD WORK</span><h2 id="industry-add-title">New {definition.itemLabel.toLowerCase()}</h2></div></div>
            <form className="industry-record-form" onSubmit={submitWork}>
              <label>Work item<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={140} placeholder={`Describe a ${definition.itemLabel.toLowerCase()}`} required disabled={Boolean(storageIssue)} /></label>
              <label>{definition.referenceLabel}<input value={reference} onChange={(event) => setReference(event.target.value)} maxLength={100} placeholder="Optional" disabled={Boolean(storageIssue)} /></label>
              <label>Owner or team note<input value={owner} onChange={(event) => setOwner(event.target.value)} maxLength={100} placeholder="Optional · not an account assignment" disabled={Boolean(storageIssue)} /></label>
              <label>Target date<input type="date" value={dueDate} onChange={(event) => setDueDate(event.target.value)} disabled={Boolean(storageIssue)} /></label>
              <label>Notes<textarea value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} rows={3} placeholder="Short, non-sensitive work note" disabled={Boolean(storageIssue)} /></label>
              <button type="submit" className="button-primary industry-save-button" disabled={Boolean(storageIssue) || !title.trim()}><Check size={15} /> Save locally</button>
            </form>
            <p className="industry-stage-help"><Clock3 size={13} /> {definition.stages[0]} → {definition.stages.at(-1)} · stages are local labels, not approval controls.</p>
          </section>
          <section className="industry-privacy-card glass-card"><div className="industry-privacy-icon"><ShieldAlert size={18} /></div><strong>Keep this register non-sensitive</strong><p>{definition.dataNote} There is no role enforcement, server backup, shared task sync, retention manager, or automated reminder in this local workbench.</p></section>
          {activeOffice.teamWorkspaceId && <section className="industry-linked-card glass-card"><div><Users size={15} /><strong>Office Team is linked</strong></div><p>Only the team workspace ID is linked locally. These work items are not shared with its members.</p></section>}
        </aside>
      </div>
    </>}

    {activeOffice && definition && !createOpen && dataMode === 'shared' && activeOffice.teamWorkspaceId && <>
      <section className="industry-office-hero glass-card">
        <div className="industry-office-hero-main"><span className="industry-office-mark"><Building2 size={22} /></span><div><span className="eyebrow">{definition.label.toUpperCase()} · {activeOffice.country.toUpperCase()}</span><h2>{activeOffice.name}</h2><p>{definition.workArea} · Shared team workspace</p></div></div>
        <div className="industry-office-actions"><span className="industry-team-status is-linked"><Users size={14} />Team linked</span><button className="button-secondary industry-team-button" onClick={openTeam}><Users size={15} />Open team</button></div>
      </section>
      {activeOffice.industryId === 'government' && <div className="government-module-tabs" role="tablist" aria-label="Government office modules">
        <button type="button" role="tab" aria-selected={governmentPanel === 'correspondence'} className={governmentPanel === 'correspondence' ? 'is-active' : ''} onClick={() => setGovernmentPanel('correspondence')}><FileText size={14} /> Correspondence</button>
        <button type="button" role="tab" aria-selected={governmentPanel === 'tasks'} className={governmentPanel === 'tasks' ? 'is-active' : ''} onClick={() => setGovernmentPanel('tasks')}><Check size={14} /> Shared work items</button>
      </div>}
      {activeOffice.industryId === 'school' && <div className="government-module-tabs school-module-tabs" role="tablist" aria-label="School office modules">
        <button type="button" role="tab" aria-selected={schoolPanel === 'management'} className={schoolPanel === 'management' ? 'is-active' : ''} onClick={() => setSchoolPanel('management')}><GraduationCap size={14} /> School Management</button>
        <button type="button" role="tab" aria-selected={schoolPanel === 'tasks'} className={schoolPanel === 'tasks' ? 'is-active' : ''} onClick={() => setSchoolPanel('tasks')}><Check size={14} /> Shared work items</button>
      </div>}
      {activeOffice.industryId === 'university' && <div className="government-module-tabs university-module-tabs" role="tablist" aria-label="University office modules">
        <button type="button" role="tab" aria-selected={universityPanel === 'management'} className={universityPanel === 'management' ? 'is-active' : ''} onClick={() => setUniversityPanel('management')}><GraduationCap size={14} /> University Management</button>
        <button type="button" role="tab" aria-selected={universityPanel === 'tasks'} className={universityPanel === 'tasks' ? 'is-active' : ''} onClick={() => setUniversityPanel('tasks')}><Check size={14} /> Shared work items</button>
      </div>}
      {activeOffice.industryId === 'government' && governmentPanel === 'correspondence'
        ? <GovernmentCorrespondenceWorkspace
          key={`government-${activeOffice.teamWorkspaceId}`}
          workspaceId={activeOffice.teamWorkspaceId}
          officeName={activeOffice.name}
          country={activeOffice.country}
          accent={accent}
        />
        : activeOffice.industryId === 'school' && schoolPanel === 'management'
          ? <SchoolManagementWorkspace
            key={`school-management-${activeOffice.teamWorkspaceId}`}
            workspaceId={activeOffice.teamWorkspaceId}
            officeName={activeOffice.name}
            country={activeOffice.country}
            accent={accent}
          />
          : activeOffice.industryId === 'university' && universityPanel === 'management'
            ? <UniversityManagementWorkspace
              key={`university-management-${activeOffice.teamWorkspaceId}`}
              workspaceId={activeOffice.teamWorkspaceId}
              officeName={activeOffice.name}
              country={activeOffice.country}
              accent={accent}
            />
          : <IndustrySharedWorkspace
          key={`industry-${activeOffice.teamWorkspaceId}`}
          workspaceId={activeOffice.teamWorkspaceId}
          officeName={activeOffice.name}
          country={activeOffice.country}
          industryId={activeOffice.industryId}
          definition={definition}
          accent={accent}
        />}
    </>}

    {!activeOffice && !createOpen && <section className="industry-empty-office glass-card"><div className="industry-empty-icon"><Building2 size={21} /></div><h2>Create your first industry office</h2><p>Choose an industry to get its working register and stage flow.</p><button className="button-primary" onClick={() => setCreateOpen(true)}><Plus size={15} /> Choose an industry</button></section>}
  </div>;
}
