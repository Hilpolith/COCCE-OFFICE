import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowUp, Bot, CheckCircle2, LoaderCircle, MessageCircle, Sparkles } from 'lucide-react';
import { officeTeamApi } from './lib/officeTeamApi';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeConversation, OfficeWorkspace } from './lib/officeTeamApi';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import './officeAiWorkspace.css';

export default function OfficeAiWorkspace() {
  const config = useMemo(() => resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment), []);
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const [workspaces, setWorkspaces] = useState<OfficeWorkspace[]>([]);
  const [conversations, setConversations] = useState<OfficeConversation[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const [conversationId, setConversationId] = useState('');
  const [prompt, setPrompt] = useState('');
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
      const firstSpace = spaces[0]!;
      setWorkspaceId(firstSpace.workspace_id);
      const chats = await officeTeamApi.listConversations(client, firstSpace.workspace_id);
      if (!active) return;
      setConversations(chats);
      setConversationId(chats[0]?.conversation_id ?? '');
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
    setConversationId('');
    setConversations([]);
    setAnswer('');
    setError('');
    if (!client) return;
    try {
      const chats = await officeTeamApi.listConversations(client, nextId);
      setConversations(chats);
      setConversationId(chats[0]?.conversation_id ?? '');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load conversations.');
    }
  };

  const ask = async () => {
    if (!client || !workspaceId || !conversationId || !prompt.trim() || busy) return;
    setBusy(true);
    setError('');
    setAnswer('');
    try {
      const { data, error: invokeError } = await client.functions.invoke('office-ai-chat', {
        body: { action: 'chat', workspaceId, conversationId, prompt: prompt.trim() },
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
      <div><span className="eyebrow">COCCE OFFICE · INTELLIGENCE</span><h1>COCCE AI</h1><p>Ask questions and work through ideas with the context of a conversation you already have permission to access.</p></div>
      <span className="office-ai-free"><span /> FREE MODEL ONLY</span>
    </div>
    <section className="office-ai-shell glass-card">
      <div className="office-ai-shell-heading"><div><span className="eyebrow">YOUR WORKSPACE ASSISTANT</span><h2><Bot size={20} /> Ask COCCE AI</h2></div><span className="office-ai-secure"><CheckCircle2 size={14} /> COCCE account required</span></div>
      {status === 'loading' && <div className="office-ai-state"><LoaderCircle className="spin" size={18} /> Connecting securely to COCCE AI…</div>}
      {status === 'signed-out' && <div className="office-ai-state"><AlertCircle size={18} /> Sign in to your existing COCCE account in Office to use AI.</div>}
      {status === 'misconfigured' && <div className="office-ai-state"><AlertCircle size={18} /> COCCE Auth is not configured for this Office deployment.</div>}
      {status === 'not-configured' && <div className="office-ai-state"><AlertCircle size={18} /> {error || 'The OpenRouter free-model secret is not available to the Office AI service. Check Supabase Edge Function secrets.'}</div>}
      {status === 'ready' && <>
        <div className="office-ai-context"><label>Workspace<select value={workspaceId} onChange={event => void changeWorkspace(event.target.value)}><option value="">Select workspace</option>{workspaces.map(space => <option key={space.workspace_id} value={space.workspace_id}>{space.name}</option>)}</select></label><label>Conversation<select value={conversationId} onChange={event => setConversationId(event.target.value)} disabled={!conversations.length}><option value="">Select conversation</option>{conversations.map(chat => <option key={chat.conversation_id} value={chat.conversation_id}>{chat.title || chat.kind}</option>)}</select></label></div>
        {!workspaces.length && <div className="office-ai-state">Create or join an Office workspace before asking about its conversations.</div>}
        {workspaces.length > 0 && !conversationId && <div className="office-ai-state">Select a workspace conversation first. COCCE AI can only read conversations returned by your existing membership permissions.</div>}
        <div className="office-ai-answer" aria-live="polite">{answer ? <><div className="office-ai-answer-label"><Sparkles size={14} /> COCCE AI</div><p>{answer}</p></> : <div className="office-ai-empty"><MessageCircle size={23} /><strong>Your next idea starts here.</strong><span>Choose a conversation and ask for a summary, a plan, a draft, or help thinking through the discussion.</span></div>}</div>
        <form className="office-ai-compose" onSubmit={event => { event.preventDefault(); void ask(); }}><textarea value={prompt} onChange={event => setPrompt(event.target.value)} maxLength={1600} placeholder="Ask about this conversation…" disabled={!conversationId || busy} /><button type="submit" disabled={!conversationId || !prompt.trim() || busy} aria-label="Send to COCCE AI">{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={19} />}</button></form>
        <div className="office-ai-footnote">Context is limited to the selected conversation (up to 24 recent messages). AI responses are generated by a pinned OpenRouter free model; no paid-model fallback is enabled.</div>
      </>}
      {error && status === 'ready' && <div className="office-ai-error" role="alert"><AlertCircle size={14} /> {error}</div>}
    </section>
  </div>;
}
