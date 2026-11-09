import { useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { CellSelection } from '@tiptap/pm/tables';
import { AlertCircle, Check, ChevronDown, ChevronRight, LoaderCircle, Plus, Save, ShieldCheck, Sparkles, WandSparkles, X } from 'lucide-react';
import {
  buildOfficeAiRequest,
  buildOfficeAiDocumentSummaryRequest,
  checkOfficeAiStatus,
  extractOfficeAiDocumentText,
  extractOfficeAiSelection,
  loadOfficeAiWorkflows,
  OFFICE_AI_ACTIONS,
  OFFICE_AI_DRAFT_TEMPLATES,
  OFFICE_AI_MAX_DOCUMENT_SUMMARY_CHARS,
  OFFICE_AI_MAX_REQUEST_BYTES,
  OFFICE_AI_MAX_PROMPT_CHARS,
  OFFICE_AI_MAX_SAVED_WORKFLOWS,
  OFFICE_AI_MAX_SELECTION_CHARS,
  OfficeAiError,
  requestOfficeAi,
  saveOfficeAiWorkflows,
} from './lib/officeAi';
import type { OfficeAiAction, OfficeAiDocumentSummaryRequest, OfficeAiWorkflow } from './lib/officeAi';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import { officeTeamApi, type OfficeWorkspace } from './lib/officeTeamApi';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';

type Selection = { from: number; to: number; text: string; isCellSelection: boolean };
type Availability = 'unknown' | 'checking' | 'available' | 'not-configured' | 'unavailable';
type AuthStatus = 'loading' | 'signed-in' | 'signed-out' | 'misconfigured';
type PreviewTarget = { kind: 'selection' | 'draft' | 'document-summary'; from: number; to: number; selectedText: string; doc: ProseMirrorNode; sourceChars?: number };
type DocumentSummaryConfirmation = { payload: OfficeAiDocumentSummaryRequest; title: string; doc: ProseMirrorNode; position: number };

function readLocalWorkflows(): OfficeAiWorkflow[] {
  try {
    return loadOfficeAiWorkflows(window.localStorage);
  } catch {
    return [];
  }
}

function currentSelection(editor: Editor): Selection {
  const activeSelection = editor.state.selection;
  const { from, to } = activeSelection;
  const isCellSelection = activeSelection instanceof CellSelection;
  return {
    from,
    to,
    text: isCellSelection || from === to ? '' : extractOfficeAiSelection(editor.state.doc, from, to),
    isCellSelection,
  };
}

function readableError(error: unknown): string {
  if (error instanceof OfficeAiError) return error.message;
  if (error instanceof Error) return error.message;
  return 'The writing assistant could not complete that request. Try again.';
}

export default function OfficeAiWriter({ editor, documentTitle = 'Untitled document', onGoToTeam, defaultExpanded = false }: { editor: Editor | null; documentTitle?: string; onGoToTeam: () => void; defaultExpanded?: boolean }) {
  const teamConfig = useMemo(
    () => resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment),
    [],
  );
  const client = useMemo(() => getOfficeTeamClient(teamConfig), [teamConfig]);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [authStatus, setAuthStatus] = useState<AuthStatus>(() => client ? 'loading' : 'misconfigured');
  const [availability, setAvailability] = useState<Availability>('unknown');
  const [workspaces, setWorkspaces] = useState<OfficeWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('*');
  const [workspaceLoading, setWorkspaceLoading] = useState(true);
  const [selection, setSelection] = useState<Selection>({ from: 0, to: 0, text: '', isCellSelection: false });
  const [customInstruction, setCustomInstruction] = useState('');
  const [draftPrompt, setDraftPrompt] = useState('');
  const [draftTemplate, setDraftTemplate] = useState('');
  const [workflows, setWorkflows] = useState<OfficeAiWorkflow[]>(readLocalWorkflows);
  const [workflowFormOpen, setWorkflowFormOpen] = useState(false);
  const [workflowName, setWorkflowName] = useState('');
  const [workflowInstruction, setWorkflowInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState('');
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  const [documentSummaryConfirmation, setDocumentSummaryConfirmation] = useState<DocumentSummaryConfirmation | null>(null);
  const documentSummaryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const documentSummaryConfirmRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!editor) return;
    const updateSelection = () => setSelection(currentSelection(editor));
    updateSelection();
    editor.on('selectionUpdate', updateSelection);
    editor.on('update', updateSelection);
    return () => {
      editor.off('selectionUpdate', updateSelection);
      editor.off('update', updateSelection);
    };
  }, [editor]);

  useEffect(() => {
    if (!client) return;
    let active = true;
    const refreshAvailability = async (accessToken: string | undefined) => {
      if (!active) return;
      if (!accessToken) {
        setAuthStatus('signed-out');
        setAvailability('unknown');
        setWorkspaces([]); setWorkspaceId(''); setWorkspaceLoading(false);
        return;
      }
      setAuthStatus('signed-in');
      setAvailability('checking');
      try {
        const [configured, spaces] = await Promise.all([
          checkOfficeAiStatus(accessToken),
          officeTeamApi.listWorkspaces(client),
        ]);
        if (active) {
          setAvailability(configured ? 'available' : 'not-configured');
          setWorkspaces(spaces);
          setWorkspaceId((current) => spaces.length === 0 ? '' : current === '*' || spaces.some((space) => space.workspace_id === current) ? current : '*');
          setWorkspaceLoading(false);
        }
      } catch {
        if (active) {
          setAvailability('unavailable');
          setWorkspaceLoading(false);
        }
      }
    };

    void client.auth.getSession().then(({ data, error: sessionError }) => {
      if (!active) return;
      if (sessionError) {
        setAuthStatus('signed-out');
        setAvailability('unknown');
        return;
      }
      void refreshAvailability(data.session?.access_token);
    }).catch(() => {
      if (active) {
        setAuthStatus('signed-out');
        setAvailability('unknown');
      }
    });

    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => {
      setAuthStatus(session ? 'signed-in' : 'signed-out');
      setAvailability(session ? 'checking' : 'unknown');
      setWorkspaceLoading(Boolean(session));
      if (!session) { setWorkspaces([]); setWorkspaceId(''); setWorkspaceLoading(false); }
      setResult('');
      setPreviewTarget(null);
      setDocumentSummaryConfirmation(null);
      if (session) window.setTimeout(() => { void refreshAvailability(session.access_token); }, 0);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    if (!documentSummaryConfirmation) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    documentSummaryConfirmRef.current?.focus();
    return () => { previouslyFocused?.focus(); };
  }, [documentSummaryConfirmation]);

  const runAction = async (action: OfficeAiAction, instruction = '') => {
    if (!editor || busy) return;
    setError('');
    setNotice('');
    setResult('');
    setPreviewTarget(null);

    const current = currentSelection(editor);
    const sourceDoc = editor.state.doc;
    const isDraft = action === 'draft';
    if (!isDraft && current.isCellSelection) {
      setError('Table cell ranges are for formatting only. Select ordinary text for an excerpt AI action; no cell text was sent.');
      return;
    }
    const prompt = action === 'draft' ? draftPrompt : instruction || customInstruction;
    let payload;
    try {
      payload = buildOfficeAiRequest(action, isDraft ? '' : current.text, prompt, workspaceId);
    } catch (requestError) {
      setError(readableError(requestError));
      return;
    }

    if (!client || teamConfig.status !== 'ready') {
      setError('Connect the existing COCCE Auth session before using cloud AI.');
      setAuthStatus('misconfigured');
      return;
    }

    setBusy(true);
    setAvailability('checking');
    try {
      const { data, error: sessionError } = await client.auth.getSession();
      if (sessionError || !data.session?.access_token) {
        setAuthStatus('signed-out');
        setAvailability('unknown');
        setError('Sign in with an existing COCCE account to use cloud AI.');
        return;
      }
      setAuthStatus('signed-in');
      const token = data.session.access_token;
      const configured = await checkOfficeAiStatus(token);
      if (!configured) {
        setAvailability('not-configured');
        setError('Cloud AI is not enabled on this deployment yet. Your document has not been sent.');
        return;
      }
      const output = await requestOfficeAi(token, payload);
      setAvailability('available');
      setResult(output);
      setPreviewTarget({
        kind: isDraft ? 'draft' : 'selection',
        from: isDraft ? current.to : current.from,
        to: isDraft ? current.to : current.to,
        selectedText: isDraft ? '' : current.text,
        doc: sourceDoc,
      });
    } catch (requestError) {
      setAvailability(requestError instanceof OfficeAiError && requestError.code === 'AI_NOT_CONFIGURED' ? 'not-configured' : 'unavailable');
      setError(readableError(requestError));
    } finally {
      setBusy(false);
    }
  };

  const openDocumentSummaryConfirmation = () => {
    if (!editor || busy) return;
    setError('');
    setNotice('');
    setResult('');
    setPreviewTarget(null);
    const sourceDoc = editor.state.doc;
    try {
      const payload = buildOfficeAiDocumentSummaryRequest(extractOfficeAiDocumentText(sourceDoc));
      setDocumentSummaryConfirmation({
        payload,
        title: documentTitle.trim() || 'Untitled document',
        doc: sourceDoc,
        position: editor.state.selection.to,
      });
    } catch (requestError) {
      setDocumentSummaryConfirmation(null);
      setError(readableError(requestError));
    }
  };

  const confirmDocumentSummary = async () => {
    const pending = documentSummaryConfirmation;
    if (!editor || !pending || busy) return;
    const currentTitle = documentTitle.trim() || 'Untitled document';
    const snapshotMatches = editor.state.doc.eq(pending.doc)
      && extractOfficeAiDocumentText(editor.state.doc) === pending.payload.documentText
      && pending.title === currentTitle;
    setDocumentSummaryConfirmation(null);
    if (!snapshotMatches) {
      setError('The active document changed after confirmation was shown. Nothing was sent; review the current document and confirm again.');
      return;
    }
    setError('');
    setNotice('');
    setResult('');
    setPreviewTarget(null);
    if (!client || teamConfig.status !== 'ready') {
      setError('Connect the existing COCCE Auth session before using cloud AI. No document text was sent.');
      setAuthStatus('misconfigured');
      return;
    }

    setBusy(true);
    setAvailability('checking');
    try {
      const { data, error: sessionError } = await client.auth.getSession();
      if (sessionError || !data.session?.access_token) {
        setAuthStatus('signed-out');
        setAvailability('unknown');
        setError('Sign in with an existing COCCE account to use cloud AI. No document text was sent.');
        return;
      }
      setAuthStatus('signed-in');
      const token = data.session.access_token;
      const configured = await checkOfficeAiStatus(token);
      if (!configured) {
        setAvailability('not-configured');
        setError('Cloud AI is not enabled on this deployment yet. No document text was sent.');
        return;
      }
      const documentStillMatches = editor.state.doc.eq(pending.doc)
        && extractOfficeAiDocumentText(editor.state.doc) === pending.payload.documentText
        && pending.title === (documentTitle.trim() || 'Untitled document');
      if (!documentStillMatches) {
        setError('The active document changed before the request started. Nothing was sent; reopen the confirmation to review it again.');
        return;
      }
      const output = await requestOfficeAi(token, pending.payload);
      setAvailability('available');
      setResult(output);
      setPreviewTarget({
        kind: 'document-summary',
        from: pending.position,
        to: pending.position,
        selectedText: '',
        doc: pending.doc,
        sourceChars: pending.payload.documentText.length,
      });
    } catch (requestError) {
      setAvailability(requestError instanceof OfficeAiError && requestError.code === 'AI_NOT_CONFIGURED' ? 'not-configured' : 'unavailable');
      setError(readableError(requestError));
    } finally {
      setBusy(false);
    }
  };

  const saveWorkflow = () => {
    setError('');
    setNotice('');
    const name = workflowName.trim();
    const instruction = workflowInstruction.trim();
    if (!name || !instruction) {
      setError('Add a workflow name and instructions before saving.');
      return;
    }
    if (name.length > 60 || instruction.length > OFFICE_AI_MAX_PROMPT_CHARS) {
      setError('Workflow names are limited to 60 characters and instructions to 1,200 characters.');
      return;
    }
    if (workflows.length >= OFFICE_AI_MAX_SAVED_WORKFLOWS) {
      setError(`You can save up to ${OFFICE_AI_MAX_SAVED_WORKFLOWS} workflows in this browser.`);
      return;
    }
    const workflow: OfficeAiWorkflow = {
      id: globalThis.crypto?.randomUUID?.() ?? `workflow_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      instruction,
    };
    const next = [...workflows, workflow];
    let saved = false;
    try { saved = saveOfficeAiWorkflows(window.localStorage, next); } catch { saved = false; }
    if (!saved) {
      setError('This browser did not allow the workflow to be saved locally.');
      return;
    }
    setWorkflows(next);
    setWorkflowName('');
    setWorkflowInstruction('');
    setWorkflowFormOpen(false);
    setNotice('Workflow saved in this browser only.');
  };

  const deleteWorkflow = (id: string) => {
    const next = workflows.filter((workflow) => workflow.id !== id);
    let saved = false;
    try { saved = saveOfficeAiWorkflows(window.localStorage, next); } catch { saved = false; }
    if (!saved) {
      setError('This browser did not allow the workflow to be removed.');
      return;
    }
    setWorkflows(next);
    setNotice('Workflow removed from this browser.');
  };

  const applyResult = () => {
    if (!editor || !result || !previewTarget) return;
    if (!editor.state.doc.eq(previewTarget.doc)) {
      setError('The document changed while the preview was open. Run the action again on the current text before inserting it.');
      return;
    }
    const activeSelection = editor.state.selection;
    if (activeSelection instanceof CellSelection) {
      setError('A table cell range is active for formatting. Click a text cursor before applying this AI preview; no table cells were changed.');
      return;
    }
    if (previewTarget.kind === 'selection') {
      const currentText = extractOfficeAiSelection(editor.state.doc, previewTarget.from, previewTarget.to);
      if (currentText !== previewTarget.selectedText) {
        setError('The selected passage no longer matches this preview. Run the action again before replacing it.');
        return;
      }
    }
    try {
      const insertionRange = previewTarget.kind === 'selection'
        ? { from: previewTarget.from, to: previewTarget.to }
        : { from: activeSelection.to, to: activeSelection.to };
      const inserted = editor.chain().focus().insertContentAt(
        insertionRange,
        { type: 'text', text: result },
      ).run();
      if (!inserted) {
        setError('The preview could not be inserted. Copy the text below and try again.');
        return;
      }
      const appliedNotice = previewTarget.kind === 'document-summary'
        ? 'Document summary inserted at the captured cursor position. Use Undo to reverse it.'
        : previewTarget.kind === 'draft'
          ? 'Draft inserted at the chosen cursor position.'
          : 'Selected text replaced with the reviewed version. Use Undo to reverse it.';
      setNotice(appliedNotice);
      setResult('');
      setPreviewTarget(null);
      setError('');
      setSelection(currentSelection(editor));
    } catch {
      setError('The preview could not be inserted. Copy the text below and try again.');
    }
  };

  const availabilityLabel = authStatus !== 'signed-in'
    ? authStatus === 'loading' ? 'Checking session' : authStatus === 'misconfigured' ? 'Auth unavailable' : 'Sign in required'
    : availability === 'available' ? 'Cloud AI configured'
      : availability === 'not-configured' ? 'AI not configured'
        : availability === 'checking' ? 'Checking service' : availability === 'unavailable' ? 'AI temporarily unavailable' : 'Service status unknown';
  const selectionAvailable = !selection.isCellSelection && selection.text.trim().length > 0;
  const canRunAiActions = authStatus === 'signed-in' && Boolean(workspaceId) && !workspaceLoading && (availability === 'available' || availability === 'unavailable');

  return <section className="office-ai-panel" aria-label="AI writing studio">
    <button className="office-ai-disclosure" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span className="office-ai-disclosure-title"><span className="office-ai-icon"><Sparkles size={17} /></span><span><strong>AI writing studio</strong><small>Selection tools, confirmed document summaries, workflows, and draft starters</small></span></span>
      <span className="office-ai-disclosure-status">{availabilityLabel}{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
    </button>

    {expanded && <div className="office-ai-body">
      <p className="office-ai-privacy"><ShieldCheck size={16} /><span>Nothing is uploaded automatically. Selection edits send only the text you select (up to {OFFICE_AI_MAX_SELECTION_CHARS.toLocaleString()} characters), and new drafts send only your typed prompt. A full-document summary sends the document's plain text only after the separate confirmation below. No file, title, or document metadata is sent.</span></p>
      <p className="office-ai-help">User-triggered text is sent through OpenRouter to its fixed free Google AI Studio model. The current provider policy lists 55-day prompt retention and no training. No paid model or alternate provider fallback is used; send only text you are permitted to share.</p>
      <label className="office-ai-field office-ai-workspace-scope"><span className="office-ai-label">AI workspace scope</span><select value={workspaceId} disabled={workspaceLoading || workspaces.length === 0} onChange={(event) => { setWorkspaceId(event.target.value); setResult(''); setPreviewTarget(null); setError(''); }}><option value="*">All AI-enabled workspaces (up to 20)</option>{workspaces.map((space) => <option key={space.workspace_id} value={space.workspace_id}>{space.name}</option>)}</select><span className="office-ai-help">The server checks membership and the owner/admin AI switch for every request. Disabled workspaces are excluded.</span></label>
      {authStatus === 'signed-in' && !workspaceLoading && workspaces.length === 0 && <div className="office-ai-state" role="status"><AlertCircle size={16} /><span>Create or join an Office Team workspace before using the writing assistant. No document text has been sent.</span><button className="office-ai-inline-button" onClick={onGoToTeam}>Open Team</button></div>}
      {selection.isCellSelection && <div className="office-ai-state" role="status"><AlertCircle size={16} /><span>Table cell ranges are for local formatting, not excerpt selection. Select ordinary text for excerpt AI actions; prompt-only drafts remain separate, and full-document summaries still require their separate confirmation.</span></div>}

      {authStatus === 'misconfigured' && <div className="office-ai-state" role="status"><AlertCircle size={16} /><span>Cloud AI uses the existing COCCE Auth connection. This deployment is not configured for that connection.</span></div>}
      {authStatus === 'signed-out' && <div className="office-ai-state" role="status"><AlertCircle size={16} /><span>Sign in with an existing COCCE account to use cloud AI. Office does not create separate accounts.</span><button className="office-ai-inline-button" onClick={onGoToTeam}>Open Team sign-in</button></div>}
      {authStatus === 'signed-in' && availability === 'not-configured' && <div className="office-ai-state" role="status"><AlertCircle size={16} /><span>Cloud AI is not enabled on this deployment yet. Your document remains local and no text has been sent.</span></div>}
      {authStatus === 'signed-in' && availability === 'unavailable' && <div className="office-ai-state" role="status"><AlertCircle size={16} /><span>The free model may be temporarily unavailable or rate-limited. No paid model or alternate provider will be used; try again later.</span></div>}

      <div className="office-ai-selection-block">
        <div className="office-ai-section-heading"><div><span className="eyebrow">WORK ON A SELECTION</span><h3>Writing and review</h3></div><span className="office-ai-count">{selection.text.length.toLocaleString()} / {OFFICE_AI_MAX_SELECTION_CHARS.toLocaleString()} chars</span></div>
        <label className="office-ai-label" htmlFor="office-ai-selected-text">Selected excerpt</label>
        <textarea id="office-ai-selected-text" className="office-ai-textarea office-ai-selection-preview" value={selection.text} readOnly placeholder="Select a passage in the document to enable these actions." aria-describedby="office-ai-selection-help" />
        <div id="office-ai-selection-help" className="office-ai-help">Only this selected excerpt is sent for these actions. Choose a saved workflow or add your own instruction below.</div>
        <div className="office-ai-actions">
          {OFFICE_AI_ACTIONS.map((action) => <button key={action.id} className="office-ai-action-button" disabled={busy || !selectionAvailable || !canRunAiActions} onClick={() => { void runAction(action.id); }} title={action.hint}>{action.label}</button>)}
        </div>
        <div className="office-ai-custom-row">
          <label className="office-ai-field"><span className="office-ai-label">Custom instruction</span><input value={customInstruction} maxLength={OFFICE_AI_MAX_PROMPT_CHARS} onChange={(event) => setCustomInstruction(event.target.value)} placeholder="e.g. Make this client-friendly and warm" /></label>
          <button className="office-ai-primary-button" disabled={busy || !selectionAvailable || !canRunAiActions || !customInstruction.trim()} onClick={() => { void runAction('custom', customInstruction); }}><WandSparkles size={15} /> Run</button>
        </div>
        <div className="office-ai-help">Custom instruction: {customInstruction.length.toLocaleString()} / {OFFICE_AI_MAX_PROMPT_CHARS.toLocaleString()} characters.</div>
      </div>

      <div className="office-ai-document-block">
        <div className="office-ai-section-heading"><div><span className="eyebrow">FULL DOCUMENT · CONFIRM FIRST</span><h3>Summarize the open document</h3></div></div>
        <p className="office-ai-help">This separate action can send the complete plain-text document, but only after you review and confirm what will be sent. The request is limited to {OFFICE_AI_MAX_DOCUMENT_SUMMARY_CHARS.toLocaleString()} characters and {Math.round(OFFICE_AI_MAX_REQUEST_BYTES / 1_000)} KB serialized; larger documents are rejected locally and are never truncated or chunked.</p>
        <button ref={documentSummaryTriggerRef} type="button" className="office-ai-primary-button" disabled={busy || !canRunAiActions} onClick={openDocumentSummaryConfirmation}><Sparkles size={15} /> Summarize full document</button>
      </div>

      <div className="office-ai-divider" />

      <div className="office-ai-draft-block">
        <div className="office-ai-section-heading"><div><span className="eyebrow">START SOMETHING NEW</span><h3>Draft from a prompt</h3></div></div>
        <p className="office-ai-help">Drafting sends only the prompt below—never the current selection or the rest of the document.</p>
        <label className="office-ai-field"><span className="office-ai-label">Starter template</span><select value={draftTemplate} onChange={(event) => {
          const template = OFFICE_AI_DRAFT_TEMPLATES.find((item) => item.id === event.target.value);
          setDraftTemplate(event.target.value);
          if (template) setDraftPrompt(template.prompt);
        }}><option value="">Choose a starter…</option>{OFFICE_AI_DRAFT_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}</select></label>
        <label className="office-ai-field"><span className="office-ai-label">Brief and details</span><textarea className="office-ai-textarea" value={draftPrompt} maxLength={OFFICE_AI_MAX_PROMPT_CHARS} onChange={(event) => setDraftPrompt(event.target.value)} placeholder="Describe what you want drafted and provide the facts to use. Unknown details will be marked as placeholders." rows={4} /></label>
        <div className="office-ai-draft-footer"><span className="office-ai-help">{draftPrompt.length.toLocaleString()} / {OFFICE_AI_MAX_PROMPT_CHARS.toLocaleString()} characters · output appears in a preview first</span><button className="office-ai-primary-button" disabled={busy || !draftPrompt.trim() || !canRunAiActions} onClick={() => { void runAction('draft'); }}><Sparkles size={15} /> Draft preview</button></div>
      </div>

      <div className="office-ai-divider" />

      <div className="office-ai-workflows-block">
        <div className="office-ai-section-heading"><div><span className="eyebrow">REUSABLE RECIPES</span><h3>Saved workflows</h3></div><button className="office-ai-inline-button" onClick={() => setWorkflowFormOpen((open) => !open)}><Plus size={14} /> Save a workflow</button></div>
        <p className="office-ai-help">Workflow names and instructions stay in this browser. Running one sends its instruction and only the selected excerpt.</p>
        {workflowFormOpen && <div className="office-ai-workflow-form">
          <label className="office-ai-field"><span className="office-ai-label">Name</span><input value={workflowName} maxLength={60} onChange={(event) => setWorkflowName(event.target.value)} placeholder="e.g. Executive-ready summary" /></label>
          <label className="office-ai-field"><span className="office-ai-label">Instructions</span><textarea className="office-ai-textarea" value={workflowInstruction} maxLength={OFFICE_AI_MAX_PROMPT_CHARS} onChange={(event) => setWorkflowInstruction(event.target.value)} placeholder="Describe how to transform or review the selected text." rows={3} /></label>
          <div className="office-ai-form-actions"><span className="office-ai-help">Saved locally only · {workflows.length}/{OFFICE_AI_MAX_SAVED_WORKFLOWS}</span><button className="office-ai-primary-button" onClick={saveWorkflow}><Save size={14} /> Save on this device</button></div>
        </div>}
        {workflows.length > 0 ? <div className="office-ai-workflow-list">{workflows.map((workflow) => <div className="office-ai-workflow" key={workflow.id}><div className="office-ai-workflow-copy"><strong>{workflow.name}</strong><span>{workflow.instruction}</span></div><button className="office-ai-action-button" disabled={busy || !selectionAvailable || !canRunAiActions} onClick={() => { void runAction('custom', workflow.instruction); }}>Run on selection</button><button className="office-ai-icon-button" aria-label={`Delete ${workflow.name}`} title="Remove saved workflow" onClick={() => deleteWorkflow(workflow.id)}><X size={15} /></button></div>)}</div> : <div className="office-ai-empty">No saved workflows yet. Save a reusable instruction above.</div>}
      </div>

      {busy && <div className="office-ai-progress" role="status"><LoaderCircle size={16} className="office-ai-spinner" /> Preparing an AI preview…</div>}
      {error && <div className="office-ai-message office-ai-error" role="alert"><AlertCircle size={15} />{error}</div>}
      {notice && <div className="office-ai-message office-ai-notice" role="status"><Check size={15} />{notice}</div>}

      {documentSummaryConfirmation && <div className="office-ai-confirm-backdrop">
        <div className="office-ai-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="office-ai-confirm-title" aria-describedby="office-ai-confirm-description" onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setDocumentSummaryConfirmation(null);
          } else if (event.key === 'Tab') {
            const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
            const first = buttons.item(0);
            const last = buttons.item(buttons.length - 1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
          <h3 id="office-ai-confirm-title">Confirm full-document summary</h3>
          <p id="office-ai-confirm-description">The complete plain-text content of <strong>{documentSummaryConfirmation.title}</strong> ({documentSummaryConfirmation.payload.documentText.length.toLocaleString()} characters) will be sent through OpenRouter to its fixed free Google AI Studio endpoint. No text is sent until you choose the confirmation button.</p>
          <p>Google AI Studio's current policy lists 55-day prompt retention and no training. No paid model or alternate provider fallback will be used. The document title, ID, file, and other metadata are not sent.</p>
          <p>Confirm only if you are allowed to share this document with that cloud provider. The request limit is {OFFICE_AI_MAX_DOCUMENT_SUMMARY_CHARS.toLocaleString()} characters and {Math.round(OFFICE_AI_MAX_REQUEST_BYTES / 1_000)} KB; the text will not be truncated or split.</p>
          <div className="office-ai-confirm-actions">
            <button type="button" className="office-ai-action-button" onClick={() => setDocumentSummaryConfirmation(null)}>Cancel · keep it local</button>
            <button ref={documentSummaryConfirmRef} type="button" className="office-ai-primary-button" disabled={busy} onClick={() => { void confirmDocumentSummary(); }}>Confirm and send full text</button>
          </div>
        </div>
      </div>}

      {result && previewTarget && <section className="office-ai-result" aria-labelledby="office-ai-result-title">
        <div className="office-ai-result-heading"><div><span className="eyebrow">REVIEW BEFORE APPLYING</span><h3 id="office-ai-result-title">AI preview</h3></div><button className="office-ai-icon-button" aria-label="Discard AI preview" onClick={() => { setResult(''); setPreviewTarget(null); }}><X size={16} /></button></div>
        {previewTarget.kind === 'selection' && <details className="office-ai-source"><summary>Sent excerpt ({previewTarget.selectedText.length.toLocaleString()} characters)</summary><pre>{previewTarget.selectedText}</pre></details>}
        {previewTarget.kind === 'document-summary' && <p className="office-ai-document-source">Summary based on the full document ({previewTarget.sourceChars?.toLocaleString()} characters) you confirmed. The document remains unchanged until you insert this preview.</p>}
        <pre className="office-ai-result-text">{result}</pre>
        <div className="office-ai-result-footer"><span className="office-ai-help">AI can make mistakes. Review the text; it is not inserted until you choose.</span><button className="office-ai-primary-button" onClick={applyResult}><Check size={15} />{previewTarget.kind === 'selection' ? 'Replace selection' : previewTarget.kind === 'draft' ? 'Insert at cursor' : 'Insert summary at cursor'}</button></div>
      </section>}

      <p className="office-ai-footnote">Cloud actions use OpenRouter's fixed <code>google/gemma-4-31b-it:free</code> model through the Office server route and require an existing COCCE account. The model and provider are fixed server-side, with no paid-model or alternate-provider fallback. Responses are shown here for review; no AI action runs in the background, and no document file is uploaded.</p>
    </div>}
  </section>;
}
