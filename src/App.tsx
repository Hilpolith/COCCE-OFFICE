import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent, ReactNode } from 'react';
import {
  Activity, ArrowDownRight, ArrowUpRight, BookOpenText, BriefcaseBusiness, Building2,
  Check, ChevronDown, ChevronLeft, CircleHelp, CloudOff, Command,
  FileSpreadsheet, FileText, FolderOpen, Grid2X2, LayoutDashboard,
  LockKeyhole, Menu, MessageCircle, MoreHorizontal, Plus, Search, Settings2,
  ShieldCheck, Sparkles, Sun, X,
} from 'lucide-react';
import {
  addDocument, addWorkspace, readPreviewState, removeDocument, selectWorkspace,
  updateDocument, writePreviewState,
} from './lib/localStore';
import type { OfficeDocument, PreviewState, ThemeId, WorkspaceKind } from './lib/localStore';
import type { DocsCloudSnapshot } from './lib/docsCloudSnapshot';
import { deleteDocsReviewCommentsForDocument } from './lib/docsReviewComments';
import { createDocxBlob, DOCX_IMPORT_CONFIRMATION, importDocxFile, safeDocxFilename } from './lib/docxInterchange';
import SheetsWorkspace from './SheetsWorkspace';
import DriveWorkspace from './DriveWorkspace';
import SlidesWorkspace from './SlidesWorkspace';
import { slidesCloudFilesEnabled } from './lib/slidesCloudFeature';
import { escapeMarkdownText, richTextToMarkdown, richTextToPlainText } from './lib/documentEditor';
import VaultWorkspace from './VaultWorkspace';
import { FrostedConfirmProvider, useFrostedConfirm } from './FrostedConfirm';
import OfficeAccountControl from './OfficeAccountControl';
import OfficeEditorChrome from './OfficeEditorChrome';
import { readSurfaceStyle, writeSurfaceStyle } from './lib/appearancePreferences';
import type { SurfaceStyle } from './lib/appearancePreferences';
import IndustrySuitesWorkspace from './IndustrySuitesWorkspace';
import { getIndustryDefinition, industryCatalog } from './lib/industryWorkspaces';
import type { IndustryId, IndustryTeamSetup } from './lib/industryWorkspaces';
import './officeNavigation.css';

const DocumentEditor = lazy(() => import('./DocsEditor'));
const PdfWorkspace = lazy(() => import('./PdfWorkspace'));
const TeamWorkspace = lazy(() => import('./TeamWorkspace'));

const documentNav = [
  { id: 'docs', label: 'Docs', icon: FileText, detail: 'Local rich-text drafts' },
  { id: 'sheets', label: 'Sheets', icon: FileSpreadsheet, detail: 'Local formula engine' },
  { id: 'slides', label: 'Slides', icon: Grid2X2, detail: 'Presentation editor' },
  { id: 'pdf', label: 'PDF', icon: BookOpenText, detail: 'PDF tools' },
  { id: 'drive', label: 'Drive', icon: FolderOpen, detail: 'Files in this browser' },
  { id: 'vault', label: 'Vault', icon: LockKeyhole, detail: 'Protected files' },
] as const;

const toolkitNav = [
  { id: 'docs', label: 'Documents', icon: FileText, detail: 'Docs, Sheets, Slides, PDF, Drive and Vault' },
  { id: 'industry', label: 'Industry suites', icon: Building2, detail: 'Industry workspaces with local preview or shared team tasks' },
  { id: 'team', label: 'Team & collaboration', icon: MessageCircle, detail: 'Local planner and separate Office Team' },
] as const;

type PageId = 'home' | 'docs' | 'sheets' | 'slides' | 'pdf' | 'drive' | 'team' | 'vault' | 'industry' | 'settings';
const documentPageIds: readonly PageId[] = ['docs', 'sheets', 'slides', 'pdf', 'drive', 'vault'];
type DialogMode = 'workspace' | 'delete' | null;

const themeOptions: { id: ThemeId; name: string; color: string }[] = [
  { id: 'dark', name: 'Dark Liquid Glass', color: '#8d8bff' },
  { id: 'light', name: 'Pearl Light Glass', color: '#777CC8' },
  { id: 'midnight', name: 'Midnight Glass', color: '#62c4ff' },
  { id: 'amber', name: 'Warm Amber Glass', color: '#ffae66' },
  { id: 'aurora', name: 'Aurora Glass', color: '#54d9b2' },
  { id: 'lavender', name: 'Frosted Lavender', color: '#c1a0ff' },
];

const friendlyDate = (iso: string | undefined) => {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso));
};

const unavailableBrowserStorage = {
  getItem(): never { throw new Error('Browser storage is unavailable.'); },
  setItem(): never { throw new Error('Browser storage is unavailable.'); },
};
function getBrowserStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  try { return window.localStorage; } catch { return unavailableBrowserStorage; }
}

function App() {
  const [browserStorage] = useState(getBrowserStorage);
  const [state, setState] = useState<PreviewState>(() => readPreviewState(browserStorage));
  const [surfaceStyle, setSurfaceStyle] = useState<SurfaceStyle>(() => readSurfaceStyle(browserStorage));
  const searchRef = useRef<HTMLInputElement>(null);
  const [unsavedDocuments, setUnsavedDocuments] = useState<Record<string, OfficeDocument>>({});
  const [page, setPage] = useState<PageId>('home');
  const [selectedDocumentId, setSelectedDocumentId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogMode>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [documentsExpanded, setDocumentsExpanded] = useState(false);
  const [officeSuitesExpanded, setOfficeSuitesExpanded] = useState(true);
  const [industryFocus, setIndustryFocus] = useState<IndustryId | null>(null);
  const [industryTeamSetup, setIndustryTeamSetup] = useState<IndustryTeamSetup | null>(null);
  const [query, setQuery] = useState('');
  const [feedback, setFeedback] = useState(browserStorage === unavailableBrowserStorage ? 'Could not save or read browser storage. Existing local data has not been changed; allow browser storage before editing.' : '');
  const [clockLabel] = useState(() => {
    const hour = new Date().getHours();
    return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.style.setProperty('--accent', state.accent);
  }, [state.theme, state.accent]);

  useEffect(() => {
    document.documentElement.dataset.surface = surfaceStyle;
    return () => { delete document.documentElement.dataset.surface; };
  }, [surfaceStyle]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      const target = event.target;
      if (event.defaultPrevented || event.isComposing || (target instanceof Element && target !== searchRef.current && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'))) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', focusSearch);
    return () => window.removeEventListener('keydown', focusSearch);
  }, []);

  const chooseSurfaceStyle = (surface: SurfaceStyle) => {
    try {
      writeSurfaceStyle(browserStorage, surface);
      setSurfaceStyle(surface);
      setFeedback('');
    } catch {
      setFeedback('Could not save the appearance preference in this browser. The previous surface choice and your documents were kept.');
    }
  };

  useEffect(() => {
    if (Object.keys(unsavedDocuments).length === 0) return;
    const warnBeforeClosing = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeClosing);
    return () => window.removeEventListener('beforeunload', warnBeforeClosing);
  }, [unsavedDocuments]);

  const persist = (next: PreviewState): boolean => {
    try {
      writePreviewState(browserStorage, next);
      setState(next);
      setFeedback('');
      return true;
    } catch (error) {
      setFeedback(error instanceof Error && error.message.includes('preserved')
        ? error.message
        : 'Could not save changes in this browser. Check available storage; your last saved data was kept.');
      return false;
    }
  };
  const activeWorkspace = state.workspaces.find((workspace) => workspace.id === state.activeWorkspaceId) ?? null;
  const workspaceDocuments = useMemo(
    () => state.documents.filter((document) => document.workspaceId === state.activeWorkspaceId)
      .map((document) => unsavedDocuments[document.id] ?? document),
    [state.documents, state.activeWorkspaceId, unsavedDocuments],
  );
  const visibleDocuments = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const documents = [...workspaceDocuments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return normalized
      ? documents.filter((document) => `${document.title} ${document.content} ${document.richText ? richTextToPlainText(document.richText) : ''}`.toLocaleLowerCase().includes(normalized))
      : documents;
  }, [workspaceDocuments, query]);
  const selectedDocument = workspaceDocuments.find((document) => document.id === selectedDocumentId) ?? null;
  const lastEdited = [...workspaceDocuments].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.updatedAt;
  const activeEditorModule = page === 'docs' || page === 'sheets' || page === 'slides' ? page : null;

  const goTo = (nextPage: PageId) => {
    setPage(nextPage);
    if (documentPageIds.includes(nextPage)) { setDocumentsExpanded(true); setOfficeSuitesExpanded(false); }
    if (nextPage === 'industry') { setOfficeSuitesExpanded(true); setDocumentsExpanded(false); }
    setSelectedDocumentId(null);
    setMobileMenuOpen(false);
    setQuery('');
  };

  const toggleDocuments = () => {
    if (!documentPageIds.includes(page)) { goTo('docs'); return; }
    setDocumentsExpanded((open) => !open);
  };

  const toggleOfficeSuites = () => {
    if (page !== 'industry') { setIndustryFocus(null); goTo('industry'); return; }
    setOfficeSuitesExpanded((open) => !open);
  };

  const selectIndustry = (industryId: IndustryId) => {
    setIndustryFocus(industryId);
    goTo('industry');
  };

  const openIndustryTeam = (setup: IndustryTeamSetup) => {
    setIndustryTeamSetup(setup);
    goTo('team');
  };

  const returnToIndustryOffice = () => {
    const setup = industryTeamSetup;
    setIndustryTeamSetup(null);
    if (!setup) return;
    setIndustryFocus(setup.industryId);
    setPage('industry');
    setOfficeSuitesExpanded(true);
    setDocumentsExpanded(false);
    setSelectedDocumentId(null);
    setMobileMenuOpen(false);
    setQuery('');
  };

  const createDocument = () => {
    const result = addDocument(state);
    if (!persist(result.state)) return;
    setPage('docs');
    setDocumentsExpanded(true);
    setSelectedDocumentId(result.document.id);
    setFeedback('New document created on this device.');
    window.setTimeout(() => setFeedback(''), 2800);
  };

  const openDocument = (document: OfficeDocument) => {
    setPage('docs');
    setDocumentsExpanded(true);
    setSelectedDocumentId(document.id);
  };

  const patchDocument = (patch: Partial<Pick<OfficeDocument, 'title' | 'content' | 'richText'>>): boolean => {
    if (!selectedDocument) return false;
    const next = updateDocument(state, selectedDocument.id, {
      title: selectedDocument.title, content: selectedDocument.content, richText: selectedDocument.richText, ...patch,
    });
    const saved = persist(next);
    const draft = next.documents.find((document) => document.id === selectedDocument.id);
    if (draft) setUnsavedDocuments((current) => {
      const buffer = { ...current };
      if (saved) delete buffer[draft.id];
      else buffer[draft.id] = draft;
      return buffer;
    });
    return saved;
  };

  const exportDocument = (richText?: string) => {
    if (!selectedDocument) return;
    const safeName = (selectedDocument.title.trim() || 'untitled-document').replace(/[^\p{L}\p{N}-]+/gu, '-').toLowerCase();
    const body = richTextToMarkdown(richText ?? selectedDocument.richText ?? '', selectedDocument.content);
    const title = escapeMarkdownText((selectedDocument.title.trim() || 'Untitled document').replace(/[\r\n]+/g, ' '));
    const blob = new Blob([`# ${title}\n\n${body}`], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeName}.md`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFeedback('Markdown file downloaded.');
    window.setTimeout(() => setFeedback(''), 2800);
  };

  const exportDocumentDocx = async (richText?: string) => {
    if (!selectedDocument) return;
    try {
      const blob = await createDocxBlob({ title: selectedDocument.title, content: selectedDocument.content, richText: richText ?? selectedDocument.richText });
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url;
      anchor.download = safeDocxFilename(selectedDocument.title);
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setFeedback('DOCX file downloaded on this device.');
      window.setTimeout(() => setFeedback(''), 2800);
    } catch (error) {
      setFeedback(`DOCX export failed: ${error instanceof Error ? error.message : 'The file could not be generated.'}`);
    }
  };

  const importDocumentDocx = async (file: File): Promise<boolean> => {
    try {
      const imported = await importDocxFile(file);
      const created = addDocument(state);
      const next = updateDocument(created.state, created.document.id, {
        title: imported.title, content: imported.content, richText: imported.richText,
      });
      const draft = next.documents.find((document) => document.id === created.document.id);
      if (!draft) throw new Error('The imported draft could not be created.');
      const saved = persist(next);
      if (!saved) {
        setState(next);
        setUnsavedDocuments((current) => ({ ...current, [draft.id]: draft }));
      }
      setPage('docs');
      setDocumentsExpanded(true);
      setSelectedDocumentId(draft.id);
      const warning = imported.warnings.length ? ` ${imported.warnings.join(' ')}` : '';
      setFeedback(saved
        ? `Imported “${draft.title}” as a new document on this device.${warning}`
        : `Import completed, but storage is full. The new draft is kept in this tab; retry save or export it before closing.${warning}`);
      return true;
    } catch (error) {
      setFeedback(`DOCX import failed: ${error instanceof Error ? error.message : 'The file could not be imported.'}`);
      return false;
    }
  };

  const deleteDocument = () => {
    if (!selectedDocument) return;
    setDialog('delete');
  };

  const restoreCloudDocument = (snapshot: DocsCloudSnapshot): boolean => {
    const created = addDocument(state);
    const next = updateDocument(created.state, created.document.id, {
      title: `${snapshot.title} (cloud copy)`, content: snapshot.content, richText: snapshot.richText,
    });
    if (!persist(next)) return false;
    setPage('docs');
    setDocumentsExpanded(true);
    setSelectedDocumentId(created.document.id);
    setFeedback('Cloud copy restored as a new document on this device. Existing local drafts were not changed.');
    return true;
  };

  const confirmDeleteDocument = () => {
    if (!selectedDocument) return;
    if (!persist(removeDocument(state, selectedDocument.id))) return;
    let deletionFeedback = 'Document deleted from this device.';
    try {
      deleteDocsReviewCommentsForDocument(window.localStorage, selectedDocument.workspaceId, selectedDocument.id);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The review-comment sidecar could not be updated.';
      deletionFeedback = `Document deleted from this device, but its local review comments could not be cleaned up: ${detail}`;
    }
    setUnsavedDocuments((current) => {
      const buffer = { ...current };
      delete buffer[selectedDocument.id];
      return buffer;
    });
    setSelectedDocumentId(null);
    setDialog(null);
    setFeedback(deletionFeedback);
    window.setTimeout(() => setFeedback(''), 2800);
  };

  const createWorkspace = (name: string, kind: WorkspaceKind, country: string) => {
    if (!persist(addWorkspace(state, { name, kind, country }))) return;
    setDialog(null);
    setFeedback('Local workspace created on this device.');
    window.setTimeout(() => setFeedback(''), 2800);
  };

  const chooseWorkspace = (workspaceId: string | null) => {
    if (!persist(selectWorkspace(state, workspaceId))) return;
    setWorkspaceMenuOpen(false);
    setSelectedDocumentId(null);
    setPage('home');
  };

  return (
    <FrostedConfirmProvider>
    <main className="app-frame">
      <aside className={`sidebar ${mobileMenuOpen ? 'sidebar-open' : ''}`} aria-label="Main navigation">
        <div className="brand-lockup">
          <img src="/brand/cocce-office-squircle-icon-256.png" className="brand-mark" alt="COCCE Office" />
          <div className="brand-copy"><strong>COCCE <span>OFFICE</span></strong><small>Office workspace</small></div>
          <button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setMobileMenuOpen(false)}><X size={18} /></button>
        </div>

        <button className="workspace-switcher" onClick={() => setWorkspaceMenuOpen((open) => !open)} aria-expanded={workspaceMenuOpen}>
          <span className="workspace-emblem"><BriefcaseBusiness size={16} /></span>
          <span className="workspace-label"><strong>{activeWorkspace?.name ?? 'Personal space'}</strong><small>{activeWorkspace ? `${activeWorkspace.kind} · ${activeWorkspace.currency}` : 'Local workspace'}</small></span>
          <ChevronDown size={16} className="muted" />
        </button>
        {workspaceMenuOpen && (
          <div className="workspace-menu glass-popover">
            <p className="eyebrow">Switch local space</p>
            <button className={`workspace-option ${state.activeWorkspaceId === null ? 'selected' : ''}`} onClick={() => chooseWorkspace(null)}>
              <span className="workspace-mini-icon"><BriefcaseBusiness size={15} /></span><span><strong>Personal space</strong><small>This browser only</small></span>{state.activeWorkspaceId === null && <Check size={15} />}
            </button>
            {state.workspaces.map((workspace) => (
              <button key={workspace.id} className={`workspace-option ${state.activeWorkspaceId === workspace.id ? 'selected' : ''}`} onClick={() => chooseWorkspace(workspace.id)}>
                <span className="workspace-mini-icon"><BriefcaseBusiness size={15} /></span><span><strong>{workspace.name}</strong><small>{workspace.kind} · {workspace.currency}</small></span>{state.activeWorkspaceId === workspace.id && <Check size={15} />}
              </button>
            ))}
            <button className="workspace-create" onClick={() => { setDialog('workspace'); setWorkspaceMenuOpen(false); }}><Plus size={15} /> Create local workspace</button>
          </div>
        )}

        <div className="sidebar-section-label">WORKSPACE</div>
        <nav className="primary-nav">
          <NavButton active={page === 'home'} icon={<LayoutDashboard size={18} />} label="Overview" onClick={() => goTo('home')} />
          <button type="button" className={`nav-button nav-group-trigger ${documentPageIds.includes(page) ? 'active' : ''}`} aria-expanded={documentsExpanded} aria-controls="documents-subnav" onClick={toggleDocuments}>
            <FileText size={18} /><span>Documents</span><ChevronDown size={14} className={`nav-group-caret ${documentsExpanded ? 'is-expanded' : ''}`} />{documentPageIds.includes(page) && <span className="nav-active-marker" />}
          </button>
          {documentsExpanded && <div className="nav-subgroup" id="documents-subnav">
            {documentNav.map(({ id, label, icon: Icon }) => <NavButton key={id} className="nav-subbutton" active={page === id} icon={<Icon size={16} />} label={label} onClick={() => goTo(id)} />)}
          </div>}
          <button type="button" className={`nav-button nav-group-trigger ${page === 'industry' ? 'active' : ''}`} aria-expanded={officeSuitesExpanded} aria-controls="industry-subnav" onClick={toggleOfficeSuites}>
            <Building2 size={18} /><span>Office suites</span><ChevronDown size={14} className={`nav-group-caret ${officeSuitesExpanded ? 'is-expanded' : ''}`} />{page === 'industry' && <span className="nav-active-marker" />}
          </button>
          {officeSuitesExpanded && <div className="nav-subgroup" id="industry-subnav">
            {industryCatalog.map((industry) => <NavButton key={industry.id} className={`nav-subbutton nav-industry-button nav-industry-${industry.id}`} active={page === 'industry' && industryFocus === industry.id} icon={<span className={`nav-industry-dot nav-industry-${industry.id}`} />} label={industry.shortLabel} onClick={() => selectIndustry(industry.id)} />)}
          </div>}
          <NavButton active={page === 'team'} icon={<MessageCircle size={18} />} label="Team" onClick={() => goTo('team')} />
        </nav>

        <div className="sidebar-bottom">
          <div className="sidebar-divider" />
          <NavButton active={page === 'settings'} icon={<Settings2 size={18} />} label="Preferences" onClick={() => goTo('settings')} />
          <div className="local-profile">
            <div className="profile-orb"><span>CO</span></div>
            <div className="profile-copy"><strong>Workspace profile</strong><small>Team sign-in is separate</small></div>
            <MoreHorizontal size={17} className="muted" />
          </div>
        </div>
      </aside>

      {mobileMenuOpen && <button className="mobile-scrim" aria-label="Close navigation overlay" onClick={() => setMobileMenuOpen(false)} />}

      <section className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <button className="icon-button mobile-menu-button" aria-label="Open navigation" onClick={() => setMobileMenuOpen(true)}><Menu size={19} /></button>
            <div className="breadcrumb"><span>COCCE Office</span><ChevronLeft size={13} className="breadcrumb-sep" /><strong>{pageTitle(page, Boolean(selectedDocument), industryFocus)}</strong></div>
          </div>
          <div className="topbar-actions">
            <label className="search-box"><Search size={16} /><input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this space" aria-keyshortcuts="Control+k Meta+k" aria-label={page === 'team' ? 'Search local planner items' : page === 'industry' ? 'Search local industry work' : page === 'drive' ? 'Search local files and documents' : 'Search local documents'} /><kbd><Command size={11} /> K</kbd></label>
            <span className="local-status"><span className="status-dot" /> Office workspace</span>
            <OfficeAccountControl />
            <button className="icon-button help-button" title="Workspace information" aria-label="Workspace information" onClick={() => goTo('settings')}><CircleHelp size={18} /></button>
          </div>
        </header>

        {Object.keys(unsavedDocuments).length > 0 && <div className="unsaved-drafts-banner" role="alert"><ShieldCheck size={15} /><span>{Object.keys(unsavedDocuments).length} unsaved {Object.keys(unsavedDocuments).length === 1 ? 'draft is' : 'drafts are'} kept in this tab only. Reopen the draft and retry save or export Markdown or DOCX before closing this tab.</span></div>}
        <div className="content-scroll">
          {activeEditorModule && <OfficeEditorChrome active={activeEditorModule} storageLabel={activeWorkspace ? 'Local Office space · this browser' : 'Personal space · this browser'} onNavigate={(module) => goTo(module)} />}
          {page === 'home' && <Dashboard greeting={clockLabel} activeWorkspace={activeWorkspace?.name ?? 'Personal space'} workspaceCount={state.workspaces.length} documentCount={workspaceDocuments.length} lastEdited={lastEdited} documents={visibleDocuments.slice(0, 5)} onCreateDocument={createDocument} onOpenDocument={openDocument} onCreateWorkspace={() => setDialog('workspace')} onNavigate={goTo} />}
          {page === 'docs' && (selectedDocument
            ? <Suspense fallback={<div className="page" role="status">Opening local editor…</div>}><DocumentEditor document={selectedDocument} hasUnsavedChanges={Boolean(unsavedDocuments[selectedDocument.id])} onPatch={patchDocument} onBack={() => setSelectedDocumentId(null)} onExport={exportDocument} onExportDocx={exportDocumentDocx} onDelete={deleteDocument} onRestoreCloudCopy={restoreCloudDocument} onGoToTeam={() => { setPage('team'); setMobileMenuOpen(false); setQuery(''); }} /></Suspense>
            : <DocumentsPage documents={visibleDocuments} query={query} onCreate={createDocument} onOpen={openDocument} onImportDocx={importDocumentDocx} />)}
          {page === 'drive' && <DriveWorkspace workspaceId={activeWorkspace?.id ?? null} documents={visibleDocuments} query={query} onOpenDocument={openDocument} onCreateDocument={createDocument} />}
          {page === 'pdf' && <Suspense fallback={<div className="page" role="status">Opening local PDF tools…</div>}><PdfWorkspace workspaceId={activeWorkspace?.id ?? null} /></Suspense>}
          {page === 'sheets' && <SheetsWorkspace state={state} onState={persist} onGoToTeam={() => { setPage('team'); setMobileMenuOpen(false); setQuery(''); }} />}
          {page === 'slides' && <SlidesWorkspace workspaceId={activeWorkspace?.id ?? null} onGoToTeam={() => { setPage('team'); setMobileMenuOpen(false); setQuery(''); }} />}
          {page === 'vault' && <VaultWorkspace />}
          {page === 'industry' && <IndustrySuitesWorkspace key={industryFocus ?? 'all'} preferredIndustryId={industryFocus} onCreateTeam={openIndustryTeam} />}
          {page === 'team' && <Suspense fallback={<div className="page" role="status">Opening local Team planner…</div>}><TeamWorkspace workspaceId={activeWorkspace?.id ?? null} workspaceName={activeWorkspace?.name ?? 'Personal space'} query={query} industryTeamSetup={industryTeamSetup} onIndustryTeamLinked={returnToIndustryOffice} /></Suspense>}
          {page === 'settings' && <SettingsPage state={state} surfaceStyle={surfaceStyle} onSurfaceStyle={chooseSurfaceStyle} onTheme={(theme) => persist({ ...state, theme, themeExplicitlySelected: true, accent: themeOptions.find((option) => option.id === theme)?.color ?? state.accent })} onAccent={(accent) => persist({ ...state, accent })} />}
        </div>

        <footer className="app-footer"><span><ShieldCheck size={13} /> Docs/Sheets/Slides offer manual cloud copies only (no auto-sync); Drive/PDF/Vault stay browser-local. Linked industry suites use role-gated team records. Bunny file transfers are not yet verified.</span><span>COCCE OFFICE · INDUSTRY WORKSPACES</span></footer>
      </section>

      {feedback && <div className="toast" role={/could not save|not saved|preserved/i.test(feedback) ? 'alert' : 'status'}><Check size={16} />{feedback}</div>}
      {dialog === 'workspace' && <WorkspaceDialog onClose={() => setDialog(null)} onCreate={createWorkspace} />}
      {dialog === 'delete' && selectedDocument && <DeleteDocumentDialog title={selectedDocument.title} onClose={() => setDialog(null)} onDelete={confirmDeleteDocument} />}
    </main>
    </FrostedConfirmProvider>
  );
}

function pageTitle(page: PageId, editing: boolean, industryFocus: IndustryId | null) {
  if (page === 'docs' && editing) return 'Document editor';
  if (page === 'home') return 'Overview';
  if (page === 'settings') return 'Preferences';
  if (page === 'industry') return industryFocus ? getIndustryDefinition(industryFocus).shortLabel : 'Office suites';
  return documentNav.find((item) => item.id === page)?.label ?? toolkitNav.find((item) => item.id === page)?.label ?? 'Overview';
}

function NavButton({ active, icon, label, onClick, className = '' }: { active: boolean; icon: ReactNode; label: string; onClick: () => void; className?: string }) {
  return <button type="button" className={`nav-button ${className} ${active ? 'active' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined}>{icon}<span>{label}</span>{active && <span className="nav-active-marker" />}</button>;
}

function Dashboard({
  greeting, activeWorkspace, workspaceCount, documentCount, lastEdited, documents,
  onCreateDocument, onOpenDocument, onCreateWorkspace, onNavigate,
}: {
  greeting: string; activeWorkspace: string; workspaceCount: number; documentCount: number; lastEdited?: string;
  documents: OfficeDocument[]; onCreateDocument: () => void; onOpenDocument: (document: OfficeDocument) => void;
  onCreateWorkspace: () => void; onNavigate: (page: PageId) => void;
}) {
  return (
    <div className="page dashboard-page">
      <section className="welcome-row">
        <div>
          <div className="eyebrow accent-eyebrow"><span className="sparkle-dot"><Sparkles size={13} /></span> YOUR PRIVATE WORKSPACE</div>
          <h1>{greeting}, <span className="gradient-text">let’s make room</span><br className="desktop-break" /> for focused work.</h1>
          <p className="welcome-subtitle">A calm place for your ideas, documents, and next steps.</p>
          <div className="welcome-actions"><button className="button-primary" onClick={onCreateDocument}><Plus size={17} /> New document</button><button className="button-secondary" onClick={() => onNavigate('industry')}><Building2 size={16} /> Choose an industry</button><button className="button-secondary" onClick={onCreateWorkspace}><BriefcaseBusiness size={16} /> Create Office space</button></div>
        </div>
        <div className="hero-brand-card glass-card"><div className="hero-orbit orbit-one" /><div className="hero-orbit orbit-two" /><img src="/brand/cocce-office-squircle-icon-512.png" alt="COCCE Office squircle app icon" /><div className="hero-brand-caption"><span className="live-pip" />{activeWorkspace}<small>Saved privately on this device</small></div></div>
      </section>

      <section className="metric-grid" aria-label="Local workspace summary">
        <MetricCard icon={<FileText size={17} />} label="My documents" value={String(documentCount)} note={documentCount === 1 ? '1 local draft' : 'Local drafts'} tone="violet" />
        <MetricCard icon={<BriefcaseBusiness size={17} />} label="Office spaces" value={String(workspaceCount)} note="Created in this browser" tone="cyan" />
        <MetricCard icon={<Activity size={17} />} label="Last edit" value={friendlyDate(lastEdited)} note={lastEdited ? 'From a local document' : 'No edits yet'} tone="amber" />
      </section>

      <section className="dashboard-lower-grid">
        <div className="panel recent-panel glass-card">
          <div className="panel-heading"><div><span className="eyebrow">YOUR WORK</span><h2>Recent documents</h2></div><button className="text-button" onClick={() => onNavigate('docs')}>View all <ArrowUpRight size={14} /></button></div>
          {documents.length === 0 ? <EmptyDocuments onCreate={onCreateDocument} /> : <DocumentRows documents={documents} onOpen={onOpenDocument} />}
        </div>
        <div className="panel quick-panel glass-card">
          <div className="panel-heading"><div><span className="eyebrow">QUICK START</span><h2>Make a little progress</h2></div><span className="small-star"><Sparkles size={15} /></span></div>
          <button className="quick-action" onClick={onCreateDocument}><span className="quick-icon quick-doc"><FileText size={17} /></span><span><strong>Start a document</strong><small>Write and save locally</small></span><ArrowUpRight size={15} /></button>
          <button className="quick-action" onClick={() => onNavigate('industry')}><span className="quick-icon quick-space"><Building2 size={17} /></span><span><strong>Set up an industry office</strong><small>Choose a sector and work flow</small></span><ArrowUpRight size={15} /></button>
          <button className="quick-action" onClick={onCreateWorkspace}><span className="quick-icon quick-space"><BriefcaseBusiness size={17} /></span><span><strong>Create an Office space</strong><small>Separate work by organization</small></span><ArrowUpRight size={15} /></button>
          <div className="quick-note"><LockKeyhole size={15} /><p><strong>Private by design.</strong> Personal drafts and local workspace labels stay in this browser and are not synced or backed up. Office Team collaboration uses a separate service.</p></div>
        </div>
      </section>

      <section className="module-section">
        <div className="panel-heading module-heading"><div><span className="eyebrow">THE OFFICE TOOLKIT</span><h2>Explore your workspace</h2></div><span className="module-caption">Documents, industry work and team collaboration</span></div>
        <div className="module-grid">{toolkitNav.map((module) => {
          const Icon = module.icon;
          return <button key={module.id} className={`module-card module-${module.id}`} onClick={() => onNavigate(module.id)}><span className="module-icon"><Icon size={18} /></span><span><strong>{module.label}</strong><small>{module.detail}</small></span><ArrowUpRight size={15} className="module-arrow" /></button>;
        })}</div>
      </section>
    </div>
  );
}

function MetricCard({ icon, label, value, note, tone }: { icon: ReactNode; label: string; value: string; note: string; tone: string }) {
  return <div className={`metric-card glass-card metric-${tone}`}><div className="metric-top"><span className="metric-icon">{icon}</span><span className="metric-label">{label}</span><span className="metric-indicator"><ArrowDownRight size={13} /></span></div><div className="metric-value">{value}</div><div className="metric-note">{note}</div></div>;
}

function EmptyDocuments({ onCreate }: { onCreate: () => void }) {
  return <div className="empty-documents"><div className="empty-visual"><div className="empty-sheet"><FileText size={24} /></div><div className="empty-spark spark-a" /><div className="empty-spark spark-b" /></div><h3>Your first page is waiting</h3><p>Create a local text document and it will appear here. Nothing is uploaded.</p><button className="button-tertiary" onClick={onCreate}><Plus size={15} /> Create document</button></div>;
}

function DocumentRows({ documents, onOpen }: { documents: OfficeDocument[]; onOpen: (document: OfficeDocument) => void }) {
  return <div className="document-list">{documents.map((document) => <button className="document-row" key={document.id} onClick={() => onOpen(document)}><span className="document-type-icon"><FileText size={17} /></span><span className="document-row-main"><strong>{document.title || 'Untitled document'}</strong><small>{document.content.trim().slice(0, 84) || 'No text yet · stored in this browser'}</small></span><span className="document-date">{friendlyDate(document.updatedAt)}</span><ArrowUpRight size={15} className="row-arrow" /></button>)}</div>;
}

function DocumentsPage({ documents, query, onCreate, onOpen, onImportDocx }: { documents: OfficeDocument[]; query: string; onCreate: () => void; onOpen: (document: OfficeDocument) => void; onImportDocx: (file: File) => Promise<boolean> }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const confirm = useFrostedConfirm();
  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    if (!file || !(await confirm({ title: 'Import a local DOCX?', description: DOCX_IMPORT_CONFIRMATION, confirmLabel: 'Import file', cancelLabel: 'Cancel' }))) return;
    setImporting(true);
    try { await onImportDocx(file); } finally { setImporting(false); }
  };
  return <div className="page subpage">
    <div className="page-title-row docs-page-title-row">
      <div>
        <span className="eyebrow">COCCE DOCS · LOCAL MODE</span>
        <h1>Documents</h1>
        <p className="page-lede">Format local drafts with headings, text styles, lists, quotes, and simple tables. Add review comments to selected text; comment notes stay in this browser. DOCX import/export supports bounded rectangular tables. Cloud sync and shared collaboration are not connected.</p>
      </div>
      <div className="docs-page-actions">
        <input ref={inputRef} className="visually-hidden" type="file" accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={handleFile} aria-label="Choose a DOCX file" />
        <button className="button-secondary" disabled={importing} onClick={() => inputRef.current?.click()}><FileText size={16} /> {importing ? 'Importing…' : 'Import DOCX'}</button>
        <button className="button-primary" onClick={onCreate}><Plus size={17} /> New document</button>
      </div>
    </div>
    <div className="panel glass-card listing-panel">
      <div className="panel-heading">
        <div><span className="eyebrow">{query ? 'SEARCH RESULTS' : 'THIS SPACE'}</span><h2>{documents.length} {documents.length === 1 ? 'document' : 'documents'}</h2></div>
        <span className="local-only-chip"><LockKeyhole size={13} /> Device only</span>
      </div>
      {documents.length ? <DocumentRows documents={documents} onOpen={onOpen} /> : <EmptyDocuments onCreate={onCreate} />}
    </div>
  </div>;
}

function SettingsPage({ state, surfaceStyle, onSurfaceStyle, onTheme, onAccent }: { state: PreviewState; surfaceStyle: SurfaceStyle; onSurfaceStyle: (surface: SurfaceStyle) => void; onTheme: (theme: ThemeId) => void; onAccent: (accent: string) => void }) {
  return <div className="page subpage settings-page">
    <div className="page-title-row"><div><span className="eyebrow">PREFERENCES</span><h1>Make it yours</h1><p className="page-lede">Theme and accent choices are saved in this browser.</p></div><span className="local-only-chip"><LockKeyhole size={13} /> Local settings</span></div>
    <section className="settings-panel glass-card" aria-labelledby="surface-heading">
      <div className="settings-heading"><div className="settings-icon"><Grid2X2 size={19} /></div><div><h2 id="surface-heading">Surface appearance</h2><p>A softer workspace, with a clear alternative when you need it.</p></div></div>
      <div className="surface-options" role="group" aria-label="Surface appearance">
        <button className="surface-option" aria-label="Frosted glass" aria-pressed={surfaceStyle === 'glass'} onClick={() => onSurfaceStyle('glass')}><span className="surface-preview surface-preview-glass" aria-hidden="true"><i /><i /></span><span><strong>Frosted glass</strong><small>Depth, blur and soft reflections</small></span>{surfaceStyle === 'glass' && <Check size={17} aria-hidden="true" />}</button>
        <button className="surface-option" aria-label="Solid surfaces" aria-pressed={surfaceStyle === 'solid'} onClick={() => onSurfaceStyle('solid')}><span className="surface-preview surface-preview-solid" aria-hidden="true"><i /><i /></span><span><strong>Solid surfaces</strong><small>Opaque panels without backdrop blur</small></span>{surfaceStyle === 'solid' && <Check size={17} aria-hidden="true" />}</button>
      </div>
      <p className="surface-help">Saved on this device only, separately from your documents. Supported system settings for reduced transparency or increased contrast take priority. Browsers without backdrop blur use solid panels. Document pages, slide content and printed output keep their own rendering.</p>
    </section>
    <section className="settings-panel glass-card">
      <div className="settings-heading"><div className="settings-icon"><Sun size={19} /></div><div><h2>Liquid Glass themes</h2><p>Choose a surface style for this workspace.</p></div></div>
      <div className="theme-grid">{themeOptions.map((theme) => <button key={theme.id} className={`theme-option theme-preview-${theme.id} ${state.theme === theme.id ? 'theme-selected' : ''}`} onClick={() => onTheme(theme.id)} aria-pressed={state.theme === theme.id}><span className="theme-swatch"><i style={{ background: theme.color }} /><i /><i /></span><span className="theme-name">{theme.name}</span>{state.theme === theme.id && <Check size={15} className="theme-check" />}</button>)}</div>
      <div className="accent-picker"><div><strong>Accent color</strong><small>Applied to highlights and focus states.</small></div><label className="color-control"><input aria-label="Custom accent color" type="color" value={state.accent} onChange={(event) => onAccent(event.target.value)} /><span>{state.accent.toUpperCase()}</span></label></div>
    </section>
    <section className="settings-panel glass-card connection-panel">
      <div className="settings-heading"><div className="settings-icon connection-icon"><Activity size={18} /></div><div><h2>Connection status</h2><p>Office Team collaboration is server-backed; most productivity tools remain browser-local.</p></div></div>
      <div className="connection-list"><ConnectionRow label="COCCE Auth" value="Existing accounts · Team only" /><ConnectionRow label="Office collaboration data" value="Office-specific backend" /><ConnectionRow label="Cloud file storage" value={import.meta.env.VITE_OFFICE_CLOUD_FILES_READY === 'true' ? (slidesCloudFilesEnabled(import.meta.env) ? 'Explicit copies · Docs, Sheets, and Slides' : 'Explicit copies · Docs and Sheets') : 'Not enabled in this environment'} /><ConnectionRow label="AI provider" value="OpenRouter free model · Docs only" /></div>
      <p className="connection-note">Office collaboration uses existing COCCE Auth and only Office-specific database objects. Docs AI sends selected excerpts or typed draft prompts after a user action; a full-document summary requires a separate confirmation and sends bounded plain text only. The fixed free Google AI Studio provider is listed as retaining prompts for 55 days with no training; no paid or alternate-provider fallback or background AI run occurs.</p>
    </section>
  </div>;
}

function ConnectionRow({ label, value }: { label: string; value: string }) {
  return <div className="connection-row"><span>{label}</span><span><span className="connection-dot" />{value}</span></div>;
}

function WorkspaceDialog({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, kind: WorkspaceKind, country: string) => void }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<WorkspaceKind>('Business');
  const [country, setCountry] = useState('Tanzania');
  const submit = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); onCreate(name, kind, country); };
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal glass-card" role="dialog" aria-modal="true" aria-labelledby="workspace-dialog-title"><button className="icon-button modal-close" onClick={onClose} aria-label="Close dialog"><X size={18} /></button><div className="modal-symbol"><BriefcaseBusiness size={20} /></div><span className="eyebrow">A SPACE OF YOUR OWN</span><h2 id="workspace-dialog-title">Create an Office space</h2><p className="modal-copy">Organize local drafts by business, school, institute, or team.</p><form onSubmit={submit}><label className="form-label">Office name<input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Kijiji Studio" required maxLength={64} autoFocus /></label><div className="form-row"><label className="form-label">Type<select value={kind} onChange={(event) => setKind(event.target.value as WorkspaceKind)}><option>Business</option><option>School</option><option>Institute</option><option>Team</option><option>Personal</option></select></label><label className="form-label">Country<input value={country} onChange={(event) => setCountry(event.target.value)} maxLength={48} /></label></div><div className="modal-warning"><CloudOff size={15} /><span>This creates a local label only. It does not create a shared Office, invite members, or connect to COCCE services.</span></div><div className="modal-actions"><button type="button" className="button-secondary" onClick={onClose}>Cancel</button><button type="submit" className="button-primary"><Plus size={16} /> Create locally</button></div></form></section></div>;
}

function DeleteDocumentDialog({ title, onClose, onDelete }: { title: string; onClose: () => void; onDelete: () => void }) {
  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="modal glass-card" role="dialog" aria-modal="true" aria-labelledby="delete-dialog-title"><button className="icon-button modal-close" onClick={onClose} aria-label="Close dialog"><X size={18} /></button><div className="modal-symbol delete-symbol"><X size={20} /></div><span className="eyebrow">LOCAL DOCUMENT</span><h2 id="delete-dialog-title">Delete this document?</h2><p className="modal-copy">“{title || 'Untitled document'}” will be removed from this browser. This cannot be undone.</p><div className="modal-warning"><LockKeyhole size={15} /><span>Only this local copy is affected. No server or shared COCCE data is changed.</span></div><div className="modal-actions"><button type="button" className="button-secondary" onClick={onClose}>Keep document</button><button type="button" className="button-secondary danger-text" onClick={onDelete}><X size={15} /> Delete locally</button></div></section></div>;
}

export default App;
