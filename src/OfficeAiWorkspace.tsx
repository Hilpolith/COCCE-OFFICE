import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowUp, Bot, CheckCircle2, LoaderCircle, MessageCircle, Sparkles } from 'lucide-react';
import { officeTeamApi } from './lib/officeTeamApi';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeWorkspace } from './lib/officeTeamApi';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import './officeAiWorkspace.css';

export default function OfficeAiWorkspace({ initialWorkspaceId, initialPrompt }: { initialWorkspaceId?: string; initialPrompt?: string } = {}) {
  const config = useMemo(() => resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment), []);
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const [workspaces, setWorkspaces] = useState<OfficeWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId ?? '');
  const [includeWorkspaceContext, setIncludeWorkspaceContext] = useState(true);
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
  const [answer, setAnswer] = useState('');
  const [status, setStatus] = useState<'loading' | 'ready' | 'signed-out' | 'misconfigured' | 'not-configured'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    if (!client || config.status !== 'ready') {
      setStatus('misconfigured');
      return;
    }
    void (async () => {
      const { data: sessionData, error: sessionError } = await client.auth.getSession();
      if (!active) return;
      if (sessionError || !sessionData.session) {
        setStatus('signed-out');
        return;
      }
      const { data: availability, error: availabilityError } = await client.functions.invoke('office-ai-chat', { body: { action: 'status' } });
      if (!active) return;
      if (availabilityError) {
        setError('The COCCE AI service could not be reached.');
        setStatus('not-configured');
        return;
      }
      if (availability?.configured !== true) {
        setStatus('not-configured');
        return;
      }
      const spaces = await officeTeamApi.listWorkspaces(client);
      if (!active) return;
      setWorkspaces(spaces);
      if (!spaces.length) {
        setStatus('ready');
        return;
      }
      setWorkspaceId(initialWorkspaceId && spaces.some((space) => space.workspace_id === initialWorkspaceId) ? initialWorkspaceId : '*');
      setStatus('ready');
    })().catch((reason: unknown) => {
      if (active) {
        setError(reason instanceof Error ? reason.message : 'COCCE Office AI could not initialize.');
        setStatus('not-configured');
      }
    });
    return () => { active = false; };
  }, [client, config.status]);

  const changeWorkspace = async (nextId: string) => {
    setWorkspaceId(nextId);
    setAnswer('');
    setError('');
    if (!client) return;
    // Workspace selection is validated again by the Edge Function on every request.
    // No conversation ID is trusted or supplied by the browser. 
  };

  const ask = async () => {
    if (!client || !workspaceId || !prompt.trim() || busy) return;
    setBusy(true);
    setError('');
    setAnswer('');
    try {
      const { data, error: invokeError } = await client.functions.invoke('office-ai-chat', {
        body: { action: 'chat', workspaceId, prompt: prompt.trim(), includeConversations: includeWorkspaceContext },
      });
      if (invokeError) throw new Error(invokeError.message || 'COCCE AI request failed.');
      if (typeof data?.text !== 'string' || !data.text.trim()) throw new Error(data?.message || 'COCCE AI returned no answer.');
      setAnswer(data.text);
      setPrompt('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'COCCE AI could not complete the request.');
    } finally {
      setBusy(false);
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
        <div className="office-ai-context"><label>Workspace<select value={workspaceId} onChange={event => void changeWorkspace(event.target.value)}><option value="*">All authorised workspaces</option>{workspaces.map(space => <option key={space.workspace_id} value={space.workspace_id}>{space.name}</option>)}</select></label><label className="office-ai-context-toggle"><span>Workspace context</span><span><input type="checkbox" checked={includeWorkspaceContext} onChange={event => setIncludeWorkspaceContext(event.target.checked)} /><small>{includeWorkspaceContext ? 'On · authorised team conversations' : 'Off · private prompt only'}</small></span></label></div>
        {!workspaces.length && <div className="office-ai-state">Create or join an Office workspace before using workspace-aware AI.</div>}
        <div className="office-ai-answer" aria-live="polite">{answer ? <><div className="office-ai-answer-label"><Sparkles size={14} /> COCCE AI</div><p>{answer}</p></> : <div className="office-ai-empty"><MessageCircle size={23} /><strong>Your next idea starts here.</strong><span>Choose one workspace or all AI-enabled workspaces. Ask for summaries, plans, drafts, and practical next steps.</span></div>}</div>
        <form className="office-ai-compose" onSubmit={event => { event.preventDefault(); void ask(); }}><textarea value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={1600} placeholder="Ask across your workspace…" disabled={!workspaceId || busy} /><button type="submit" disabled={!workspaceId || !prompt.trim() || busy} aria-label="Send to COCCE AI">{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={19} />}</button></form>
        <div className="office-ai-footnote">{includeWorkspaceContext ? 'COCCE AI can read up to 20 AI-enabled authorised workspaces, sampling up to 2 conversations and 2 recent messages per conversation through membership-checked RPCs. Drive file contents are not included in this release.' : 'Workspace context is off. Your prompt is sent without team conversation history.'} AI responses use the pinned OpenRouter free model; no paid-model fallback is enabled.</div>
      </>}
      {error && status === 'ready' && <div className="office-ai-error" role="alert"><AlertCircle size={14} /> {error}</div>}
    </section>
  </div>;
}
