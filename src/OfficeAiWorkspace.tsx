import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, ArrowUp, Bot, CheckCircle2, LoaderCircle, MessageCircle, Sparkles } from 'lucide-react';
import { officeTeamApi } from './lib/officeTeamApi';
import { createOfficeCloudApi } from './lib/officeCloudFiles';
import type { CloudFile } from './lib/officeCloudFiles';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeWorkspace } from './lib/officeTeamApi';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import './officeAiWorkspace.css';

export default function OfficeAiWorkspace({ initialWorkspaceId, initialPrompt }: { initialWorkspaceId?: string; initialPrompt?: string } = {}) {
  const config = useMemo(() => resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment), []);
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const [workspaces, setWorkspaces] = useState<OfficeWorkspace[]>([]);
  const [userId, setUserId] = useState('');
  const [driveFiles, setDriveFiles] = useState<CloudFile[]>([]);
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([]);
  const [driveFilesOpen, setDriveFilesOpen] = useState(false);
  const [driveFilesLoading, setDriveFilesLoading] = useState(false);
  const [driveFilesError, setDriveFilesError] = useState('');
  const [driveFileOffsets, setDriveFileOffsets] = useState<Record<string, number>>({});
  const [driveFileHasMore, setDriveFileHasMore] = useState(false);
  const driveLoadGeneration = useRef(0);
  const authGeneration = useRef(0);
  const aiRequestGeneration = useRef(0);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? '');
  const [includeWorkspaceContext, setIncludeWorkspaceContext] = useState(true);
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
  const [answer, setAnswer] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'signed-out' | 'misconfigured' | 'not-configured'>('loading');
  const [busy, setBusy] = useState(false);
  const [showDriveConsent, setShowDriveConsent] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const clearAiContext = (nextStatus: 'loading' | 'signed-out') => {
      authGeneration.current += 1;
      aiRequestGeneration.current += 1;
      driveLoadGeneration.current += 1;
      setBusy(false);
      setDriveFilesLoading(false);
      setWorkspaces([]);
      setUserId('');
      setDriveFiles([]);
      setSelectedFileIds([]);
      setDriveFileOffsets({});
      setDriveFileHasMore(false);
      setDriveFilesOpen(false);
      setWorkspaceId('');
      setAnswer('');
      setPrompt('');
      setShowDriveConsent(false);
      setDriveFilesError('');
      setError('');
      setStatus(nextStatus);
    };
    const initialize = async () => {
      const generation = ++authGeneration.current;
      const isCurrent = () => active && generation === authGeneration.current;
      if (!client || config.status !== 'ready') {
        setStatus('misconfigured');
        return;
      }
      setStatus('loading');
      try {
        const { data: sessionData, error: sessionError } = await client.auth.getSession();
        if (!isCurrent()) return;
        if (sessionError || !sessionData.session) {
          clearAiContext('signed-out');
          return;
        }
        setUserId(sessionData.session.user.id);
        const { data: availability, error: availabilityError } = await client.functions.invoke('office-ai-chat', { body: { action: 'status' } });
        if (!isCurrent()) return;
        if (availabilityError || availability?.configured !== true) {
          setError(availabilityError ? 'The COCCE AI service could not be reached.' : 'The free COCCE AI model is not configured.');
          setStatus('not-configured');
          return;
        }
        const spaces = await officeTeamApi.listWorkspaces(client);
        if (!isCurrent()) return;
        setWorkspaces(spaces);
        if (!spaces.length) {
          setWorkspaceId('');
          setStatus('ready');
          return;
        }
        setWorkspaceId(initialWorkspaceId && spaces.some((space) => space.workspace_id === initialWorkspaceId) ? initialWorkspaceId : '*');
        setStatus('ready');
      } catch (reason) {
        if (isCurrent()) {
          setError(reason instanceof Error ? reason.message : 'COCCE Office AI could not initialize.');
          setStatus('not-configured');
        }
      }
    };
    if (!client || config.status !== 'ready') {
      setStatus('misconfigured');
      return () => { active = false; };
    }
    const { data: { subscription } } = client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' || !session) {
        clearAiContext('signed-out');
      } else if (event === 'SIGNED_IN' || event === 'USER_UPDATED') {
        clearAiContext('loading');
        window.setTimeout(() => { if (active) void initialize(); }, 0);
      }
    });
    void initialize();
    return () => { active = false; subscription.unsubscribe(); };
  }, [client, config.status, initialWorkspaceId]);

  useEffect(() => {
    aiRequestGeneration.current += 1;
    driveLoadGeneration.current += 1;
    setBusy(false);
    setDriveFilesLoading(false);
    setPrompt(initialPrompt ?? '');
    setError('');
    setDriveFiles([]);
    setSelectedFileIds([]);
    setDriveFileOffsets({});
    setDriveFileHasMore(false);
    setDriveFilesOpen(false);
    setDriveFilesError('');
  }, [initialPrompt, initialWorkspaceId]);

  const changeWorkspace = (nextId: string) => {
    aiRequestGeneration.current += 1;
    driveLoadGeneration.current += 1;
    setBusy(false);
    setDriveFilesLoading(false);
    setWorkspaceId(nextId);
    setAnswer('');
    setError('');
    setDriveFiles([]);
    setSelectedFileIds([]);
    setDriveFileOffsets({});
    setDriveFileHasMore(false);
    setDriveFilesError('');
    setDriveFilesOpen(false);
    setShowDriveConsent(false);
    // Workspace selection and every selected file are revalidated by the Edge Function.
  };

  useEffect(() => {
    const applyWorkspace = (nextId: string) => {
      if (!nextId || !workspaces.some((space) => space.workspace_id === nextId)) return;
      aiRequestGeneration.current += 1;
      driveLoadGeneration.current += 1;
      setBusy(false);
      setDriveFilesLoading(false);
      setWorkspaceId(nextId);
      setAnswer('');
      setError('');
      setDriveFiles([]);
      setSelectedFileIds([]);
      setDriveFileOffsets({});
      setDriveFileHasMore(false);
      setDriveFilesError('');
      setDriveFilesOpen(false);
    };
    const handleWorkspaceChange = (event: Event) => {
      const nextId = (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId ?? '';
      applyWorkspace(nextId);
    };
    const handleWorkspaceClear = () => {
      aiRequestGeneration.current += 1;
      driveLoadGeneration.current += 1;
      setBusy(false);
      setDriveFilesLoading(false);
      setWorkspaceId('');
      setAnswer('');
      setPrompt('');
      setError('');
      setDriveFiles([]);
      setSelectedFileIds([]);
      setDriveFileOffsets({});
      setDriveFileHasMore(false);
      setDriveFilesOpen(false);
      setDriveFilesError('');
      setShowDriveConsent(false);
    };
    window.addEventListener('cocce-office:workspace-changed', handleWorkspaceChange);
    window.addEventListener('cocce-office:workspace-cleared', handleWorkspaceClear);
    return () => {
      window.removeEventListener('cocce-office:workspace-changed', handleWorkspaceChange);
      window.removeEventListener('cocce-office:workspace-cleared', handleWorkspaceClear);
    };
  }, [workspaces]);

  useEffect(() => {
    if (!initialWorkspaceId || !workspaces.some((space) => space.workspace_id === initialWorkspaceId)) return;
    aiRequestGeneration.current += 1;
    driveLoadGeneration.current += 1;
    setBusy(false);
    setWorkspaceId(initialWorkspaceId);
    setAnswer('');
    setDriveFiles([]);
    setSelectedFileIds([]);
    setDriveFileOffsets({});
    setDriveFileHasMore(false);
    setDriveFilesOpen(false);
  }, [initialWorkspaceId, workspaces]);

  const supportedDriveFile = (file: CloudFile) => file.sizeBytes <= 512 * 1024 && /\.(txt|md|csv|tsv|json|xml|yaml|yml|log)$/i.test(file.displayName);

  const openDriveFiles = async () => {
    if (driveFilesOpen) { setDriveFilesOpen(false); return; }
    setDriveFilesOpen(true);
    if (!client || config.status !== 'ready' || !userId || driveFilesLoading) return;
    const generation = ++driveLoadGeneration.current;
    setDriveFilesLoading(true);
    setDriveFilesError('');
    try {
      if (!config.schemaReady) throw new Error('Private Cloud Drive is not enabled for this Office deployment.');
      const api = createOfficeCloudApi(client, config.anonKey, userId);
      const scope = workspaceId === '*' ? workspaces.slice(0, 20) : workspaces.filter((space) => space.workspace_id === workspaceId);
      const enabledScope = (await Promise.all(scope.map(async (space) => {
        try { return await officeTeamApi.getWorkspaceAiEnabled(client, space.workspace_id) ? space : null; }
        catch { return null; }
      }))).filter((space): space is OfficeWorkspace => Boolean(space));
      if (generation !== driveLoadGeneration.current) return;
      if (!enabledScope.length) {
        setDriveFiles([]);
        setDriveFileOffsets({});
        setDriveFileHasMore(false);
        setDriveFilesError('No AI-enabled workspace could be verified in this scope. Check the connection or ask an owner to enable COCCE AI.');
        return;
      }
      const pageSize = workspaceId === '*' ? 5 : 50;
      const results = await Promise.all(enabledScope.map(async (space) => {
        try {
          const page = await api.list(space.workspace_id, false, 0);
          const rows = page.slice(0, pageSize);
          return { workspaceId: space.workspace_id, files: rows, offset: rows.length, hasMore: page.length > rows.length || page.length === 50 };
        } catch { return { workspaceId: space.workspace_id, files: [] as CloudFile[], offset: 0, hasMore: false }; }
      }));
      if (generation !== driveLoadGeneration.current) return;
      const files = results.flatMap((result) => result.files).filter(supportedDriveFile).slice(0, 100);
      setDriveFiles(files);
      setDriveFileOffsets(Object.fromEntries(results.map((result) => [result.workspaceId, result.offset])));
      setDriveFileHasMore(results.some((result) => result.hasMore) && files.length < 100);
      if (!files.length) setDriveFilesError('No supported files were found. COCCE Docs and Sheets cloud copies plus .txt, .md, .csv, .tsv, .json, .xml, .yaml and .log files up to 512 KiB are supported.');
    } catch (reason) {
      if (generation === driveLoadGeneration.current) setDriveFilesError(reason instanceof Error ? reason.message : 'Private Drive files could not be listed.');
    } finally {
      if (generation === driveLoadGeneration.current) setDriveFilesLoading(false);
    }
  };

  const loadMoreDriveFiles = async () => {
    if (!client || config.status !== 'ready' || !userId || driveFilesLoading || !driveFileHasMore) return;
    const generation = ++driveLoadGeneration.current;
    setDriveFilesLoading(true);
    setDriveFilesError('');
    try {
      if (!config.schemaReady) throw new Error('Private Cloud Drive is not enabled for this Office deployment.');
      const api = createOfficeCloudApi(client, config.anonKey, userId);
      const scope = workspaceId === '*' ? workspaces.slice(0, 20) : workspaces.filter((space) => space.workspace_id === workspaceId);
      const enabledScope = (await Promise.all(scope.map(async (space) => {
        try { return await officeTeamApi.getWorkspaceAiEnabled(client, space.workspace_id) ? space : null; }
        catch { return null; }
      }))).filter((space): space is OfficeWorkspace => Boolean(space));
      if (generation !== driveLoadGeneration.current) return;
      if (!enabledScope.length) {
        setDriveFilesError('No AI-enabled workspace could be verified in this scope.');
        return;
      }
      const pageSize = workspaceId === '*' ? 5 : 50;
      const results = await Promise.all(enabledScope.map(async (space) => {
        const offset = driveFileOffsets[space.workspace_id] ?? 0;
        try {
          const page = await api.list(space.workspace_id, false, offset);
          const rows = page.slice(0, pageSize);
          return { workspaceId: space.workspace_id, files: rows, offset: offset + rows.length, hasMore: page.length > rows.length || page.length === 50 };
        } catch { return { workspaceId: space.workspace_id, files: [] as CloudFile[], offset, hasMore: false }; }
      }));
      if (generation !== driveLoadGeneration.current) return;
      const more = results.flatMap((result) => result.files).filter(supportedDriveFile);
      const seen = new Set(driveFiles.map((file) => file.fileId));
      const nextFiles = [...driveFiles, ...more.filter((file) => !seen.has(file.fileId))].slice(0, 100);
      setDriveFiles(nextFiles);
      setDriveFileOffsets((current) => ({ ...current, ...Object.fromEntries(results.map((result) => [result.workspaceId, result.offset])) }));
      setDriveFileHasMore(results.some((result) => result.hasMore) && nextFiles.length < 100);
    } catch (reason) {
      if (generation === driveLoadGeneration.current) setDriveFilesError(reason instanceof Error ? reason.message : 'More private Drive files could not be loaded.');
    } finally { if (generation === driveLoadGeneration.current) setDriveFilesLoading(false); }
  };

  const toggleDriveFile = (fileId: string, checked: boolean) => {
    setSelectedFileIds((current) => {
      if (!checked) return current.filter((id) => id !== fileId);
      if (current.includes(fileId) || current.length >= 3) return current;
      return [...current, fileId];
    });
  };

  const ask = async (confirmedDriveSharing = false) => {
    if (!client || !workspaceId || !prompt.trim() || busy) return;
    if (selectedFileIds.length > 0 && !confirmedDriveSharing) { setShowDriveConsent(true); return; }
    setShowDriveConsent(false);
    const requestGeneration = ++aiRequestGeneration.current;
    setBusy(true);
    setError('');
    setAnswer('');
    try {
      const { data, error: invokeError } = await client.functions.invoke('office-ai-chat', {
        body: { action: 'chat', workspaceId, prompt: prompt.trim(), includeConversations: includeWorkspaceContext, ...(selectedFileIds.length ? { fileIds: selectedFileIds } : {}) },
      });
      if (requestGeneration !== aiRequestGeneration.current) return;
      if (invokeError) throw new Error(invokeError.message || 'COCCE AI request failed.');
      if (typeof data?.text !== 'string' || !data.text.trim()) throw new Error(data?.message || 'COCCE AI returned no answer.');
      setAnswer(data.text);
      setPrompt('');
    } catch (reason) {
      if (requestGeneration === aiRequestGeneration.current) setError(reason instanceof Error ? reason.message : 'COCCE AI could not complete the request.');
    } finally {
      if (requestGeneration === aiRequestGeneration.current) setBusy(false);
    }
  };

  return <div className="page subpage office-ai-page">
    <div className="office-ai-hero">
      <div className="office-ai-orbit office-ai-orbit-one" /><div className="office-ai-orbit office-ai-orbit-two" />
      <div className="office-ai-mark"><Sparkles size={25} /></div>
      <div><span className="eyebrow">COCCE OFFICE · INTELLIGENCE</span><h1>COCCE AI</h1><p>Ask questions across the workspaces you belong to. Workspace owners can switch AI access off at any time.</p></div>
      <span className="office-ai-free"><span /> FREE MODEL ONLY</span>
    </div>
    <section className="office-ai-shell glass-card">
      <div className="office-ai-shell-heading"><div><span className="eyebrow">YOUR WORKSPACE ASSISTANT</span><h2><Bot size={20} /> Ask COCCE AI</h2></div><span className="office-ai-secure"><CheckCircle2 size={14} /> COCCE account required</span></div>
      {status === 'loading' && <div className="office-ai-state"><LoaderCircle className="spin" size={18} /> Connecting securely to COCCE AI…</div>}
      {status === 'signed-out' && <div className="office-ai-state"><AlertCircle size={18} /> Sign in to your existing COCCE account in Office to use AI.</div>}
      {status === 'misconfigured' && <div className="office-ai-state"><AlertCircle size={18} /> COCCE Auth is not configured for this Office deployment.</div>}
      {status === 'not-configured' && <div className="office-ai-state"><AlertCircle size={18} /> {error || 'The OpenRouter free-model secret is not available to the Office AI service. Check Supabase Edge Function secrets.'}</div>}
      {status === 'ready' && <>
        <div className="office-ai-context"><label>Workspace<select value={workspaceId} disabled={driveFilesLoading || busy || status !== 'ready'} onChange={event => void changeWorkspace(event.target.value)}><option value="*">All AI-enabled workspaces (up to 20)</option>{workspaces.map(space => <option key={space.workspace_id} value={space.workspace_id}>{space.name}</option>)}</select></label><label className="office-ai-context-toggle"><span>Team conversation context</span><span><input type="checkbox" checked={includeWorkspaceContext} onChange={event => setIncludeWorkspaceContext(event.target.checked)} /><small>{includeWorkspaceContext ? 'On · authorised team conversations' : 'Off · no team history'}</small></span></label></div>
        {!workspaces.length && <div className="office-ai-state">Create or join an Office workspace before using workspace-aware AI.</div>}
        <section className="office-ai-drive-context" aria-label="Selected Drive file context">
          <div className="office-ai-drive-heading"><div><strong>Drive file context</strong><small>Attach up to 3 private text files or COCCE Docs/Sheets copies. All-workspace mode shows the latest 5 per workspace; a single workspace starts with 50 and can load more. Contents are fetched server-side only after you ask.</small></div><button type="button" className="button-secondary" onClick={() => void openDriveFiles()} disabled={!workspaceId || !userId || busy}>{driveFilesOpen ? 'Hide files' : 'Browse Drive'}</button></div>
          {selectedFileIds.length > 0 && <div className="office-ai-drive-selected">{selectedFileIds.length} of 3 files attached until you deselect them</div>}
          {driveFilesOpen && <div className="office-ai-drive-list">
            {driveFilesLoading ? <div className="office-ai-state"><LoaderCircle className="spin" size={15}/> Loading private Drive files…</div> : driveFiles.map((file) => <label className="office-ai-drive-file" key={file.fileId}><input type="checkbox" checked={selectedFileIds.includes(file.fileId)} disabled={!selectedFileIds.includes(file.fileId) && selectedFileIds.length >= 3} onChange={(event) => toggleDriveFile(file.fileId, event.target.checked)} /><span><strong>{file.displayName}</strong><small>{workspaces.find((space) => space.workspace_id === file.workspaceId)?.name ?? 'Office workspace'} · {file.sizeBytes.toLocaleString()} bytes</small></span></label>)}
            {driveFileHasMore && <button type="button" className="office-ai-inline-button" onClick={() => void loadMoreDriveFiles()} disabled={driveFilesLoading}>{driveFilesLoading ? 'Loading…' : 'Load more files'}</button>}
            {driveFilesError && <p className="office-ai-drive-error" role="status">{driveFilesError}</p>}
          </div>}
        </section>
        <div className="office-ai-answer" aria-live="polite">{answer ? <><div className="office-ai-answer-label"><Sparkles size={14} /> COCCE AI</div><p>{answer}</p></> : <div className="office-ai-empty"><MessageCircle size={23} /><strong>Your next idea starts here.</strong><span>Choose one workspace or all AI-enabled workspaces. Ask for summaries, plans, drafts, and practical next steps.</span></div>}</div>
        <form className="office-ai-compose" onSubmit={event => { event.preventDefault(); void ask(); }}><textarea value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={1600} placeholder="Ask across your workspace…" disabled={!workspaceId || busy} /><button type="submit" disabled={!workspaceId || !prompt.trim() || busy} aria-label="Send to COCCE AI">{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={19} />}</button></form>
        {showDriveConsent && <div className="office-ai-consent-backdrop">
          <section className="office-ai-consent glass-card" role="dialog" aria-modal="true" aria-labelledby="office-ai-consent-title" aria-describedby="office-ai-consent-description">
            <div className="office-ai-consent-mark"><AlertCircle size={19} /></div>
            <div><span className="eyebrow">EXTERNAL AI DATA SHARING</span><h3 id="office-ai-consent-title">Share selected Drive content with COCCE AI?</h3></div>
            <p id="office-ai-consent-description">The selected file contents will be read from private Office Drive by the authenticated server and sent to OpenRouter's Google AI Studio free-model provider to generate this answer. The file contents are not stored in the COCCE AI chat history. This is not a zero-data-retention guarantee.</p>
            <ul>{selectedFileIds.map((fileId) => {
              const file = driveFiles.find((item) => item.fileId === fileId);
              return <li key={fileId}>{file?.displayName ?? 'Selected Drive file'}</li>;
            })}</ul>
            <div className="office-ai-consent-actions">
              <button type="button" className="button-secondary" onClick={() => setShowDriveConsent(false)}>Cancel</button>
              <button type="button" className="button-primary" onClick={() => void ask(true)} disabled={busy}>Send selected content</button>
            </div>
          </section>
        </div>}
        <div className="office-ai-footnote">{includeWorkspaceContext ? 'COCCE AI samples authorised team conversations from up to 20 enabled workspaces.' : 'Team conversation history is off.'} {selectedFileIds.length ? 'Selected text files and native Docs/Sheets cloud copies are read server-side from enabled workspaces, limited to 3 files, 512 KiB and 8,000 extracted characters each (20,000 total).' : 'Drive files are never read unless you explicitly select them.'} AI responses use the pinned OpenRouter free model; no paid-model fallback is enabled.</div>
      </>}
      {error && status === 'ready' && <div className="office-ai-error" role="alert"><AlertCircle size={14} /> {error}</div>}
    </section>
  </div>;
}
