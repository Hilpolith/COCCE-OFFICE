import { useEffect, useMemo, useRef, useState } from 'react';
import type { Editor } from '@tiptap/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { CellSelection } from '@tiptap/pm/tables';
import { AlertCircle, Check, ChevronDown, ChevronRight, FileText, LoaderCircle, Plus, Save, ShieldCheck, Sparkles, WandSparkles, X } from 'lucide-react';
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
          setWorkspaces([]);
          setWorkspaceId('');
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
      const payload = buildOfficeAiDocumentSummaryRequest(extractOfficeAiDocumentText(sourceDoc), workspaceId);
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
  const canRunAiActions = authStatus === 'signed-in' && workspaces.length > 0 && Boolean(workspaceId) && !workspaceLoading && (availability === 'available' || availability === 'unavailable');

  return <section className="office-ai-panel" aria-label="AI writing assistant">
    <button className="office-ai-disclosure" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <span className="office-ai-disclosure-title"><span className="office-ai-icon"><Sparkles size={17} /></span><span><strong>COCCE AI</strong><small>Document-aware writing and editing</small></span></span>
      <span className="office-ai-disclosure-status"><span className="office-ai-provider-pill">OPENROUTER · FREE</span><span>{availabilityLabel}</span>{expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
    </button>

    {expanded && <div className="office-ai-body">
      <label className="office-ai-field office-ai-workspace-scope"><span className="office-ai-label">Workspace</span><select aria-label="AI workspace scope" value={workspaceId} disabled={workspaceLoading || workspaces.length === 0} onChange={(event) => { setWorkspaceId(event.target.value); setResult(''); setPreviewTarget(null); setError(''); }}><option value="*">All AI-enabled workspaces</option>{workspaces.map((space) => <option key={space.workspace_id} value={space.workspace_id}>{space.name}</option>)}</select></label>
      <p className="office-ai-privacy"><ShieldCheck size={15} /><span>Nothing is sent automatically. Only the text or prompt you choose to submit is shared.</span></p>
      <details className="office-ai-privacy-details"><summary>Privacy and model details</summary><p>Requests use OpenRouter’s openrouter/free router. OpenRouter selects an eligible free model for each request; COCCE Office verifies the returned model is marked free and the reported response cost is zero. No paid-model fallback is enabled. Provider and model data-handling policies can differ; review the current OpenRouter and selected model terms before sharing sensitive text.</p></details>

      {authStatus === 'signed-in' && !workspaceLoading && workspaces.length === 0 && <div className="office-ai-state" role="status"><AlertCircle size={15} /><span>No Office workspace yet.</span><button className="office-ai-inline-button" onClick={onGoToTeam}>Create workspace</button></div>}
      {selection.isCellSelection && <div className="office-ai-state" role="status"><AlertCircle size={15} /><span>Select ordinary text to use excerpt actions.</span></div>}
      {authStatus === 'misconfigured' && <div className="office-ai-state" role="status"><AlertCircle size={15} /><span>COCCE account connection is unavailable.</span></div>}
      {authStatus === 'signed-out' && <div className="office-ai-state" role="status"><AlertCircle size={15} /><span>Sign in with your COCCE account to use AI.</span><button className="office-ai-inline-button" onClick={onGoToTeam}>Sign in</button></div>}
      {authStatus === 'signed-in' && availability === 'not-configured' && <div className="office-ai-state" role="status"><AlertCircle size={15} /><span>COCCE AI is not configured on this deployment.</span></div>}
      {authStatus === 'signed-in' && availability === 'unavailable' && <div className="office-ai-state" role="status"><AlertCircle size={15} /><span>The free AI service is temporarily unavailable. Try again later.</span></div>}

      <div className="office-ai-selection-block">
        <div className="office-ai-section-heading"><div><span className="eyebrow">SELECTED TEXT</span><h3>Quick actions</h3></div><span className="office-ai-count">{selection.text.length.toLocaleString()} chars</span></div>
        <textarea id="office-ai-selected-text" className="office-ai-textarea office-ai-selection-preview" value={selection.text} readOnly placeholder="Select a passage in your document." aria-label="Selected document text" />
        <div className="office-ai-actions office-ai-quick-actions">
          {OFFICE_AI_ACTIONS.slice(0, 3).map((action) => <button key={action.id} className="office-ai-action-button" disabled={busy || !selectionAvailable || !canRunAiActions} onClick={() => { void runAction(action.id); }} title={action.hint}>{action.label}</button>)}
        </div>
        <details className="office-ai-accordion"><summary>More actions <span>{OFFICE_AI_ACTIONS.length - 3}</span></summary><div className="office-ai-actions office-ai-more-actions">
          {OFFICE_AI_ACTIONS.slice(3).map((action) => <button key={action.id} className="office-ai-action-button" disabled={busy || !selectionAvailable || !canRunAiActions} onClick={() => { void runAction(action.id); }} title={action.hint}>{action.label}</button>)}
        </div></details>
        <div className="office-ai-custom-row">
          <label className="office-ai-field"><span className="office-ai-label">Ask AI to</span><input value={customInstruction} maxLength={OFFICE_AI_MAX_PROMPT_CHARS} onChange={(event) => setCustomInstruction(event.target.value)} placeholder="e.g. Make this clearer and more confident" /></label>
          <button className="office-ai-primary-button" disabled={busy || !selectionAvailable || !canRunAiActions || !customInstruction.trim()} onClick={() => { void runAction('custom', customInstruction); }}><WandSparkles size={15} /> Run</button>
        </div>
      </div>

      <details className="office-ai-accordion office-ai-extra"><summary><span>Draft from a prompt</span><span><FileText size={14} /></span></summary><div className="office-ai-extra-body">
        <label className="office-ai-field"><span className="office-ai-label">Starter</span><select value={draftTemplate} onChange={(event) => { const template = OFFICE_AI_DRAFT_TEMPLATES.find((item) => item.id === event.target.value); setDraftTemplate(event.target.value); if (template) setDraftPrompt(template.prompt); }}><option value="">Choose a starter…</option>{OFFICE_AI_DRAFT_TEMPLATES.map((template) => <option key={template.id} value={template.id}>{template.label}</option>)}</select></label>
        <label className="office-ai-field"><span className="office-ai-label">What should AI write?</span><textarea className="office-ai-textarea" value={draftPrompt} maxLength={OFFICE_AI_MAX_PROMPT_CHARS} onChange={(event) => setDraftPrompt(event.target.value)} placeholder="Describe the document and provide the facts to use. Unknown details will be marked as placeholders." rows={4} /></label>
        <div className="office-ai-draft-footer"><span className="office-ai-help">Prompt only · preview before inserting</span><button className="office-ai-primary-button" disabled={busy || !draftPrompt.trim() || !canRunAiActions} onClick={() => { void runAction('draft'); }}><Sparkles size={15} /> Draft</button></div>
      </div></details>

      <details className="office-ai-accordion office-ai-extra"><summary><span>Summarize full document</span><span><FileText size={14} /></span></summary><div className="office-ai-extra-body">
        <p className="office-ai-help">The complete document text is sent only after you review and confirm. Maximum {OFFICE_AI_MAX_DOCUMENT_SUMMARY_CHARS.toLocaleString()} characters per request.</p>
        <button ref={documentSummaryTriggerRef} type="button" className="office-ai-primary-button" disabled={busy || !canRunAiActions} onClick={openDocumentSummaryConfirmation}><Sparkles size={15} /> Review and summarize</button>
      </div></details>

      <details className="office-ai-accordion office-ai-extra"><summary><span>Saved workflows</span><span>{workflows.length}</span></summary><div className="office-ai-extra-body">
        <div className="office-ai-section-heading"><h3>Reusable instructions</h3><button className="office-ai-inline-button" onClick={() => setWorkflowFormOpen((open) => !open)}><Plus size={14} /> Save</button></div>
        {workflowFormOpen && <div className="office-ai-workflow-form">
          <label className="office-ai-field"><span className="office-ai-label">Name</span><input value={workflowName} maxLength={60} onChange={(event) => setWorkflowName(event.target.value)} placeholder="e.g. Executive summary" /></label>
          <label className="office-ai-field"><span className="office-ai-label">Instructions</span><textarea className="office-ai-textarea" value={workflowInstruction} maxLength={OFFICE_AI_MAX_PROMPT_CHARS} onChange={(event) => setWorkflowInstruction(event.target.value)} placeholder="Describe the reusable instruction." rows={3} /></label>
          <div className="office-ai-form-actions"><span className="office-ai-help">Saved in this browser · {workflows.length}/{OFFICE_AI_MAX_SAVED_WORKFLOWS}</span><button className="office-ai-primary-button" onClick={saveWorkflow}><Save size={14} /> Save</button></div>
        </div>}
        {workflows.length > 0 ? <div className="office-ai-workflow-list">{workflows.map((workflow) => <div className="office-ai-workflow" key={workflow.id}><div className="office-ai-workflow-copy"><strong>{workflow.name}</strong><span>{workflow.instruction}</span></div><button className="office-ai-action-button" disabled={busy || !selectionAvailable || !canRunAiActions} onClick={() => { void runAction('custom', workflow.instruction); }}>Run</button><button className="office-ai-icon-button" aria-label={`Delete ${workflow.name}`} title="Remove workflow" onClick={() => deleteWorkflow(workflow.id)}><X size={15} /></button></div>)}</div> : <div className="office-ai-empty">No saved workflows yet.</div>}
      </div></details>

      {busy && <div className="office-ai-progress" role="status"><LoaderCircle size={16} className="office-ai-spinner" /> Preparing preview…</div>}
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
          <p id="office-ai-confirm-description">The complete plain-text content of <strong>{documentSummaryConfirmation.title}</strong> ({documentSummaryConfirmation.payload.documentText.length.toLocaleString()} characters) will be sent through OpenRouter’s openrouter/free router. OpenRouter selects an eligible free model when the request runs. No text is sent until you choose the confirmation button.</p>
          <p>COCCE Office verifies that the returned model is marked free and reports zero response cost; no paid-model fallback is enabled. Provider and model retention or training terms may differ, so review the current terms before sharing sensitive text. The document title, ID, file, and other metadata are not sent.</p>
          <p>Confirm only if you are allowed to share this document with that cloud provider. The request limit is {OFFICE_AI_MAX_DOCUMENT_SUMMARY_CHARS.toLocaleString()} characters and {Math.round(OFFICE_AI_MAX_REQUEST_BYTES / 1_000)} KB; the text will not be truncated or split.</p>
          <div className="office-ai-confirm-actions">
            <button type="button" className="office-ai-action-button" onClick={() => setDocumentSummaryConfirmation(null)}>Cancel · keep it local</button>
            <button ref={documentSummaryConfirmRef} type="button" className="office-ai-primary-button" disabled={busy} onClick={() => { void confirmDocumentSummary(); }}>Confirm and send full text</button>
          </div>
        </div>
      </div>}

      {result && previewTarget && <section className="office-ai-result" aria-labelledby="office-ai-result-title">
        <div className="office-ai-result-heading"><div><span className="eyebrow">PREVIEW</span><h3 id="office-ai-result-title">Review AI result</h3></div><button className="office-ai-icon-button" aria-label="Discard AI preview" onClick={() => { setResult(''); setPreviewTarget(null); }}><X size={16} /></button></div>
        {previewTarget.kind === 'selection' && <div className="office-ai-diff-review" aria-label="Before and after text comparison">
          <div className="office-ai-diff-block office-ai-diff-before"><div><span>BEFORE</span><small>Original selection · {previewTarget.selectedText.length.toLocaleString()} characters</small></div><pre>{previewTarget.selectedText}</pre></div>
          <div className="office-ai-diff-block office-ai-diff-after"><div><span>AI PROPOSAL</span><small>Review this revision before replacing</small></div><pre>{result}</pre></div>
        </div>}
        {previewTarget.kind === 'document-summary' && <p className="office-ai-document-source">Based on the full document you confirmed. The document is unchanged until you insert this preview.</p>}
        {previewTarget.kind !== 'selection' && <pre className="office-ai-result-text">{result}</pre>}
        <div className="office-ai-result-footer"><span className="office-ai-help">Review before applying. Nothing changes until you approve. Use Undo (Ctrl/Cmd+Z) to roll back an applied edit.</span><button className="office-ai-primary-button" onClick={applyResult}><Check size={15} />{previewTarget.kind === 'selection' ? 'Replace selection' : previewTarget.kind === 'draft' ? 'Insert at cursor' : 'Insert summary'}</button></div>
      </section>}

      <p className="office-ai-footnote">AI results stay in preview until you apply them.</p>
    </div>}
  </section>;
}
