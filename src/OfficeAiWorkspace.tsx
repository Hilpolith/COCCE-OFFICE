import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, ArrowUp, Bot, CheckCircle2, LoaderCircle, Sparkles } from 'lucide-react';
import { officeTeamApi } from './lib/officeTeamApi';
import { useFrostedConfirm } from './FrostedConfirm';
import { createOfficeCloudApi } from './lib/officeCloudFiles';
import type { CloudFile } from './lib/officeCloudFiles';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeWorkspace } from './lib/officeTeamApi';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import { officeAiInvokeError } from './lib/officeAi';
import './officeAiWorkspace.css';


function renderOfficeAiMarkdown(source: string): ReactNode {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  const codeFence = String.fromCharCode(96).repeat(3);
  let index = 0;
  const inline = (value: string) => value.split(/(\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_)/g).filter(Boolean).map((part, key) => {
    if ((part.startsWith('**') && part.endsWith('**')) || (part.startsWith('__') && part.endsWith('__'))) return <strong key={key}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('*') && part.endsWith('*')) return <em key={key}>{part.slice(1, -1)}</em>;
    if (part.startsWith('_') && part.endsWith('_')) return <em key={key}>{part.slice(1, -1)}</em>;
    return <Fragment key={key}>{part}</Fragment>;
  });
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) { index += 1; continue; }
    if (line.trim().startsWith(codeFence)) {
      index += 1; const code: string[] = [];
      while (index < lines.length && !lines[index]!.trim().startsWith(codeFence)) code.push(lines[index++]!);
      if (index < lines.length) index += 1;
      blocks.push(<pre className="office-ai-code-block" key={blocks.length}><code>{code.join('\n')}</code></pre>);
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const Tag = heading[1]!.length === 1 ? 'h2' : heading[1]!.length === 2 ? 'h3' : 'h4';
      blocks.push(<Tag key={blocks.length}>{inline(heading[2]!)}</Tag>); index += 1; continue;
    }
    if (/^\s*(?:---+|\*\*\*|___)\s*$/.test(line)) { blocks.push(<hr key={blocks.length} />); index += 1; continue; }
    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index]!)) quote.push(lines[index++]!.replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={blocks.length}>{quote.map((item, key) => <p key={key}>{inline(item)}</p>)}</blockquote>); continue;
    }
    const list = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(line);
    if (list) {
      const ordered = Boolean(list[2]); const items: string[] = [];
      while (index < lines.length) {
        const match = /^\s*(?:([-+*])|(\d+)[.)])\s+(.+)$/.exec(lines[index]!);
        if (!match || Boolean(match[2]) !== ordered) break;
        items.push(match[3]!); index += 1;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List key={blocks.length}>{items.map((item, key) => <li key={key}>{inline(item)}</li>)}</List>); continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index]!.trim() && !/^\s*(?:#{1,3}\s|[-+*]\s+|\d+[.)]\s+|>|---+\s*$)/.test(lines[index]!)) paragraph.push(lines[index++]!);
    if (!paragraph.length) { index += 1; continue; }
    blocks.push(<p key={blocks.length}>{paragraph.map((part, key) => <Fragment key={key}>{key ? <br /> : null}{inline(part)}</Fragment>)}</p>);
  }
  return <>{blocks}</>;
}

type AiChatTurn = { role: 'user' | 'assistant'; content: string };
type AiConversation = { conversation_id: string; workspace_id: string; title: string; last_message_at: string };

const AI_DRIVE_TEXT_EXTENSIONS = new Set([
  'txt','md','markdown','mdx','csv','tsv','json','jsonl','ndjson','xml','yaml','yml','log',
  'ts','tsx','js','jsx','mjs','cjs','css','scss','sass','less','html','htm','sql','py','sh','bash','zsh',
  'toml','ini','conf','properties','dart','java','kt','kts','go','rs','php','rb','swift','c','h','cpp','hpp',
  'cs','r','lua','ps1','bat','graphql','gql','prisma','vue','svelte','astro','pdf','docx','xlsx','pptx',
]);
const AI_DRIVE_SENSITIVE_SEGMENT = /^(?:\.env(?:\..*)?|\.aws|\.ssh|\.kube|\.docker|\.git|\.npmrc|\.pypirc|\.netrc|\.git-credentials|kubeconfig|secrets?(?:\..*)?|credentials?(?:\..*)?|service[-_]account(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa))$|(?:^|[._-])(?:secrets?|credentials?|passwords?|tokens?|private[-_]?keys?)(?:[._-]|$)/i;
const AI_DRIVE_PRIVATE_KEY_EXTENSION = /\.(?:pem|key|p12|pfx|jks|keystore)$/i;

function isSensitiveDriveFileName(value: string): boolean {
  return value.normalize('NFC').replaceAll('\\', '/').split('/').some((segment) =>
    AI_DRIVE_SENSITIVE_SEGMENT.test(segment) || AI_DRIVE_PRIVATE_KEY_EXTENSION.test(segment));
}

export default function OfficeAiWorkspace({ mode = 'assistant', initialWorkspaceId, initialPrompt }: { mode?: 'assistant' | 'chat'; initialWorkspaceId?: string; initialPrompt?: string } = {}) {
  const confirm = useFrostedConfirm();
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
  const lastAppliedInitialWorkspaceId = useRef(initialWorkspaceId);
  const [includeWorkspaceContext, setIncludeWorkspaceContext] = useState(mode === 'assistant');
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
  const [turns, setTurns] = useState<AiChatTurn[]>([]);
  const [conversations, setConversations] = useState<AiConversation[]>([]);
  const [conversationSearch, setConversationSearch] = useState('');
  const answerPaneRef = useRef<HTMLDivElement | null>(null);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [hasMoreConversations, setHasMoreConversations] = useState(false);
  const historyLoadGeneration = useRef(0);
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
      setTurns([]);
      setConversations([]);
      setActiveConversationId(null);
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
        setWorkspaceId(initialWorkspaceId && spaces.some((space) => space.workspace_id === initialWorkspaceId) ? initialWorkspaceId : mode === 'chat' ? spaces[0].workspace_id : '*');
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
  }, [client, config.status, initialWorkspaceId, mode]);

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
    setTurns([]);
    setConversations([]);
    setHistoryLoading(false);
    setActiveConversationId(null);
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
      setTurns([]);
      setConversations([]);
      setHistoryLoading(false);
      setActiveConversationId(null);
      setError('');
      setDriveFiles([]);
      setSelectedFileIds([]);
      setDriveFileOffsets({});
      setDriveFileHasMore(false);
      setDriveFilesError('');
      setDriveFilesOpen(false);
      setShowDriveConsent(false);
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
      setTurns([]);
      setConversations([]);
      setHistoryLoading(false);
      setActiveConversationId(null);
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
    if (!initialWorkspaceId || initialWorkspaceId === lastAppliedInitialWorkspaceId.current || !workspaces.some((space) => space.workspace_id === initialWorkspaceId)) return;
    lastAppliedInitialWorkspaceId.current = initialWorkspaceId;
    aiRequestGeneration.current += 1;
    driveLoadGeneration.current += 1;
    setBusy(false);
    setWorkspaceId(initialWorkspaceId);
    setTurns([]);
    setConversations([]);
    setHistoryLoading(false);
    setActiveConversationId(null);
    setDriveFiles([]);
    setSelectedFileIds([]);
    setDriveFileOffsets({});
    setDriveFileHasMore(false);
    setDriveFilesOpen(false);
    setShowDriveConsent(false);
  }, [initialWorkspaceId, workspaces, workspaceId]);

  useEffect(() => {
    let active = true;
    const generation = ++historyLoadGeneration.current;
    const loadHistory = async () => {
      if (!client || typeof client.from !== 'function' || !userId || status !== 'ready' || !workspaceId || workspaceId === '*') {
        setConversations([]);
        setHasMoreConversations(false);
        setActiveConversationId(null);
        return;
      }
      setHistoryLoading(true);
      const { data, error: historyError } = await client
        .from('office_ai_conversations')
        .select('conversation_id,workspace_id,title,last_message_at')
        .eq('workspace_id', workspaceId)
        .order('last_message_at', { ascending: false })
        .range(0, 29);
      if (!active || generation !== historyLoadGeneration.current) return;
      if (historyError) {
        setError('Saved AI conversations could not be loaded. Check workspace access and try again.');
        setConversations([]);
        setHasMoreConversations(false);
      } else {
        const rows = (data ?? []) as AiConversation[];
        setConversations(rows);
        setHasMoreConversations(rows.length === 30);
      }
      setHistoryLoading(false);
    };
    void loadHistory();
    return () => { active = false; historyLoadGeneration.current += 1; };
  }, [client, userId, status, workspaceId]);

  const visibleConversations = useMemo(() => {
    const query = conversationSearch.trim().toLocaleLowerCase();
    return query ? conversations.filter((conversation) => conversation.title.toLocaleLowerCase().includes(query)) : conversations;
  }, [conversations, conversationSearch]);

  useEffect(() => {
    const pane = answerPaneRef.current;
    if (pane) pane.scrollTop = pane.scrollHeight;
  }, [turns, busy]);

  const loadMoreConversations = async () => {
    if (!client || !workspaceId || workspaceId === '*' || historyLoading || !hasMoreConversations) return;
    const generation = historyLoadGeneration.current;
    const offset = conversations.length;
    setHistoryLoading(true);
    try {
      const { data, error: pageError } = await client
        .from('office_ai_conversations')
        .select('conversation_id,workspace_id,title,last_message_at')
        .eq('workspace_id', workspaceId)
        .order('last_message_at', { ascending: false })
        .range(offset, offset + 29);
      if (generation !== historyLoadGeneration.current) return;
      if (pageError) throw pageError;
      const rows = (data ?? []) as AiConversation[];
      setConversations((current) => {
        const known = new Set(current.map((conversation) => conversation.conversation_id));
        return [...current, ...rows.filter((conversation) => !known.has(conversation.conversation_id))];
      });
      setHasMoreConversations(rows.length === 30);
    } catch {
      if (generation === historyLoadGeneration.current) setError('Older conversations could not be loaded. Please retry.');
    } finally {
      if (generation === historyLoadGeneration.current) setHistoryLoading(false);
    }
  };

  const openConversation = async (conversationId: string) => {
    if (!client || historyLoading || busy) return;
    const requestGeneration = ++aiRequestGeneration.current;
    setHistoryLoading(true);
    setError('');
    try {
      const { data, error: messagesError } = await client
        .from('office_ai_messages')
        .select('role,content')
        .eq('conversation_id', conversationId)
        .order('sequence_no', { ascending: true })
        .limit(100);
      if (requestGeneration !== aiRequestGeneration.current) return;
      if (messagesError) throw messagesError;
      setTurns((data ?? []).map((row: { role: 'user' | 'assistant'; content: string }) => ({ role: row.role, content: row.content })));
      setActiveConversationId(conversationId);
      setSelectedFileIds([]);
      setDriveFiles([]);
      setPrompt('');
    } catch {
      if (requestGeneration === aiRequestGeneration.current) setError('This saved conversation could not be opened. It may have been deleted or access may have changed.');
    } finally {
      if (requestGeneration === aiRequestGeneration.current) setHistoryLoading(false);
    }
  };

  const startNewConversation = () => {
    aiRequestGeneration.current += 1;
    setActiveConversationId(null);
    setTurns([]);
    setPrompt('');
    setError('');
    setSelectedFileIds([]);
    setShowDriveConsent(false);
  };

  const deleteConversation = async (conversationId: string) => {
    if (!client || busy) return;
    const conversation = conversations.find((item) => item.conversation_id === conversationId);
    const accepted = await confirm({
      title: 'Delete saved conversation?',
      description: `“${conversation?.title ?? 'This conversation'}” and its saved messages will be permanently deleted from this workspace. This cannot be undone.`,
      confirmLabel: 'Delete conversation',
      cancelLabel: 'Keep conversation',
      destructive: true,
    });
    if (!accepted) return;
    const { error: deleteError } = await client.rpc('office_ai_delete_conversation', { p_conversation_id: conversationId });
    if (deleteError) {
      setError('The conversation could not be deleted. Please retry.');
      return;
    }
    setConversations((current) => current.filter((item) => item.conversation_id !== conversationId));
    if (activeConversationId === conversationId) startNewConversation();
  };

  const supportedDriveFile = (file: CloudFile) => {
    const name = file.displayName.normalize('NFC').trim();
    const extension = name.split('.').pop()?.toLowerCase() ?? '';
    return file.sizeBytes <= 512 * 1024 && AI_DRIVE_TEXT_EXTENSIONS.has(extension) && !isSensitiveDriveFileName(name);
  };

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
      if (!files.length) setDriveFilesError('No supported files were found. COCCE Docs and Sheets copies, PDF, DOCX, XLSX, PPTX and safe text/source-code files up to 512 KiB are supported. Secret, credential and environment files are excluded.');
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
    const question = prompt.trim();
    const history = turns.slice(-12).map((turn) => ({ role: turn.role, content: turn.content.slice(-3000) }));
    const requestGeneration = ++aiRequestGeneration.current;
    setBusy(true);
    setError('');
    try {
      const { data, error: invokeError } = await client.functions.invoke('office-ai-chat', {
        body: { action: 'chat', workspaceId, prompt: question, includeConversations: includeWorkspaceContext, ...(history.length ? { history } : {}), ...(selectedFileIds.length ? { fileIds: selectedFileIds } : {}) },
      });
      if (requestGeneration !== aiRequestGeneration.current) return;
      if (invokeError) throw await officeAiInvokeError(invokeError);
      if (typeof data?.text !== 'string' || !data.text.trim()) throw new Error(data?.message || 'COCCE AI returned no answer.');
      setTurns((current) => [...current, { role: 'user' as const, content: question }, { role: 'assistant' as const, content: data.text }].slice(-100));
      setPrompt('');
      if (workspaceId !== '*') {
        try {
          let conversationId = activeConversationId;
          if (!conversationId) {
            const { data: createdId, error: createError } = await client.rpc('office_ai_create_conversation', {
              p_workspace_id: workspaceId,
              p_title: question.slice(0, 80),
            });
            if (createError || typeof createdId !== 'string') throw createError ?? new Error('Conversation creation failed');
            if (requestGeneration !== aiRequestGeneration.current) return;
            conversationId = createdId;
            setActiveConversationId(createdId);
          }
          const { error: saveError } = await client.rpc('office_ai_save_exchange', {
            p_conversation_id: conversationId,
            p_user_content: question,
            p_assistant_content: data.text,
            p_model: typeof data.model === 'string' ? data.model : 'unknown',
          });
          if (saveError) throw saveError;
          if (requestGeneration !== aiRequestGeneration.current) return;
          const { data: saved, error: listError } = await client
            .from('office_ai_conversations')
            .select('conversation_id,workspace_id,title,last_message_at')
            .eq('workspace_id', workspaceId)
            .order('last_message_at', { ascending: false })
            .range(0, 29);
          if (requestGeneration !== aiRequestGeneration.current) return;
          if (!listError) {
            const rows = (saved ?? []) as AiConversation[];
            setConversations(rows);
            setHasMoreConversations(rows.length === 30);
          }
        } catch {
          if (requestGeneration === aiRequestGeneration.current)
            setError('Your answer was generated, but this exchange could not be saved to conversation history. Retry by sending your message again if you need a saved copy.');
        }
      }
    } catch (reason) {
      if (requestGeneration === aiRequestGeneration.current) setError(reason instanceof Error ? reason.message : 'COCCE AI could not complete the request.');
    } finally {
      if (requestGeneration === aiRequestGeneration.current) setBusy(false);
    }
  };

  return <div className={`page subpage office-ai-page ${mode === 'chat' ? 'office-ai-page-chat' : ''}`}>
    <div className="office-ai-hero">
      <div className="office-ai-orbit office-ai-orbit-one" /><div className="office-ai-orbit office-ai-orbit-two" />
      <div className="office-ai-mark"><Sparkles size={25} /></div>
      <div><span className="eyebrow">{mode === 'chat' ? 'COCCE OFFICE · AI CHAT' : 'COCCE OFFICE · INTELLIGENCE'}</span><h1>{mode === 'chat' ? 'AI Chat' : 'COCCE AI'}</h1><p>{mode === 'chat' ? 'Private AI conversations saved to your selected Office workspace.' : 'Ask questions across the workspaces you belong to. Workspace owners can switch AI access off at any time.'}</p></div>
      <span className="office-ai-free"><span /> FREE MODEL ONLY</span>
    </div>
    <section className={`office-ai-shell glass-card ${mode === 'chat' ? 'office-ai-chat-shell' : ''}`}>
      <div className="office-ai-shell-heading"><div><span className="eyebrow">{mode === 'chat' ? 'PRIVATE CONVERSATIONS' : 'YOUR WORKSPACE ASSISTANT'}</span><h2><Bot size={20} /> {mode === 'chat' ? 'Messages' : 'Ask COCCE AI'}</h2></div><span className="office-ai-secure"><CheckCircle2 size={14} /> COCCE account required</span></div>
      {status === 'loading' && <div className="office-ai-state"><LoaderCircle className="spin" size={18} /> Connecting securely to COCCE AI…</div>}
      {status === 'signed-out' && <div className="office-ai-state"><AlertCircle size={18} /> Sign in to your existing COCCE account in Office to use AI.</div>}
      {status === 'misconfigured' && <div className="office-ai-state"><AlertCircle size={18} /> COCCE Auth is not configured for this Office deployment.</div>}
      {status === 'not-configured' && <div className="office-ai-state"><AlertCircle size={18} /> {error || 'The OpenRouter free-model secret is not available to the Office AI service. Check Supabase Edge Function secrets.'}</div>}
      {status === 'ready' && <>
        <div className="office-ai-context"><label>Workspace<select value={workspaceId} disabled={driveFilesLoading || busy || status !== 'ready'} onChange={event => void changeWorkspace(event.target.value)}>{mode === 'assistant' && <option value="*">All AI-enabled workspaces (up to 20)</option>}{workspaces.map(space => <option key={space.workspace_id} value={space.workspace_id}>{space.name}</option>)}</select></label>{mode === 'assistant' && <label className="office-ai-context-toggle"><span>Team conversation context</span><span><input type="checkbox" checked={includeWorkspaceContext} onChange={event => setIncludeWorkspaceContext(event.target.checked)} /><small>{includeWorkspaceContext ? 'On · authorised team conversations' : 'Off · no team history'}</small></span></label>}</div>
        {!workspaces.length && <div className="office-ai-state">Create or join an Office workspace before using workspace-aware AI.</div>}
        {mode === 'assistant' && <section className="office-ai-drive-context" aria-label="Selected Drive file context">
          <div className="office-ai-drive-heading"><div><strong>Drive file context</strong><small>Attach up to 3 private text, PDF, Word, Excel, PowerPoint or COCCE Docs/Sheets files. All-workspace mode shows the latest 5 per workspace; a single workspace starts with 50 and can load more. Contents are fetched server-side only after you ask.</small></div><button type="button" className="button-secondary" onClick={() => void openDriveFiles()} disabled={!workspaceId || !userId || busy}>{driveFilesOpen ? 'Hide files' : 'Browse Drive'}</button></div>
          {selectedFileIds.length > 0 && <div className="office-ai-drive-selected">{selectedFileIds.length} of 3 files attached until you deselect them</div>}
          {driveFilesOpen && <div className="office-ai-drive-list">
            {driveFilesLoading ? <div className="office-ai-state"><LoaderCircle className="spin" size={15}/> Loading private Drive files…</div> : driveFiles.map((file) => <label className="office-ai-drive-file" key={file.fileId}><input type="checkbox" checked={selectedFileIds.includes(file.fileId)} disabled={!selectedFileIds.includes(file.fileId) && selectedFileIds.length >= 3} onChange={(event) => toggleDriveFile(file.fileId, event.target.checked)} /><span><strong>{file.displayName}</strong><small>{workspaces.find((space) => space.workspace_id === file.workspaceId)?.name ?? 'Office workspace'} · {file.sizeBytes.toLocaleString()} bytes</small></span></label>)}
            {driveFileHasMore && <button type="button" className="office-ai-inline-button" onClick={() => void loadMoreDriveFiles()} disabled={driveFilesLoading}>{driveFilesLoading ? 'Loading…' : 'Load more files'}</button>}
            {driveFilesError && <p className="office-ai-drive-error" role="status">{driveFilesError}</p>}
          </div>}
        </section>}
        <aside className="office-ai-history" aria-label="Saved AI conversations">
          <div className="office-ai-history-heading"><strong>Messages</strong><button type="button" className="office-ai-inline-button" onClick={startNewConversation} disabled={busy || historyLoading}>New chat</button></div>
          {mode === "chat" && <input className="office-ai-history-search" type="search" value={conversationSearch} onChange={event => setConversationSearch(event.target.value)} placeholder="Search conversations" aria-label="Search conversations" />}
          {workspaceId === '*' ? <small className="office-ai-history-hint">Select one workspace to save and reopen conversations. All-workspace context remains available for one-off questions.</small> : historyLoading ? <small className="office-ai-history-hint">Loading saved conversations…</small> : visibleConversations.length ? visibleConversations.map((conversation) => <div className={`office-ai-history-row ${activeConversationId === conversation.conversation_id ? 'is-active' : ''}`} key={conversation.conversation_id}>
            <button type="button" className="office-ai-history-open" onClick={() => void openConversation(conversation.conversation_id)} disabled={busy}><strong>{conversation.title}</strong><small>{new Date(conversation.last_message_at).toLocaleString()}</small></button>
            <button type="button" className="office-ai-history-delete" aria-label={`Delete ${conversation.title}`} onClick={() => void deleteConversation(conversation.conversation_id)} disabled={busy}>×</button>
          </div>) : <small className="office-ai-history-hint">{conversationSearch.trim() ? 'No matching conversations.' : 'Your saved chats will appear here.'}</small>}
          {hasMoreConversations && !conversationSearch.trim() && <button type="button" className="office-ai-inline-button office-ai-load-more" onClick={() => void loadMoreConversations()} disabled={historyLoading || busy}>{historyLoading ? 'Loading older chats…' : 'Load older chats'}</button>}
        </aside>
        <div className="office-ai-answer" aria-live="polite" ref={answerPaneRef}>{turns.length ? <><div className="office-ai-thread-toolbar"><span><span className="office-ai-presence-dot" /> {activeConversationId ? 'Saved conversation' : 'New conversation'} · {Math.floor(turns.length / 2)} messages</span><button type="button" className="office-ai-inline-button" onClick={startNewConversation} disabled={busy}>Clear thread</button></div><div className="office-ai-thread">{turns.map((turn, index) => <article className={`office-ai-message office-ai-message-${turn.role}`} key={`${turn.role}-${index}`}><div className="office-ai-message-label">{turn.role === 'assistant' ? <><Sparkles size={13} /> COCCE AI</> : 'YOU'}</div>{turn.role === 'assistant' ? <div className="office-ai-rich-content">{renderOfficeAiMarkdown(turn.content)}</div> : <p>{turn.content}</p>}</article>)}{busy && <div className="office-ai-thinking"><LoaderCircle className="spin" size={15} /> COCCE AI is thinking…</div>}</div></> : <div className="office-ai-empty"><div className="office-ai-empty-orb"><Sparkles size={23} /></div><strong>Start a conversation</strong><span>Ask a question, work through an idea, or get help with your workspace.</span><div className="office-ai-suggestions"><span>Summarise a document</span><span>Draft a project plan</span><span>Analyse a report</span></div></div>}</div>
        <form className="office-ai-compose" onSubmit={event => { event.preventDefault(); void ask(); }}><textarea value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void ask(); } }} maxLength={1600} placeholder={mode === 'chat' ? 'Message…' : 'Ask across your workspace…'} aria-label={mode === 'chat' ? 'Message' : 'Ask across your workspace'} disabled={!workspaceId || busy} /><button type="submit" disabled={!workspaceId || !prompt.trim() || busy} aria-label="Send to COCCE AI">{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowUp size={19} />}</button></form>
        {showDriveConsent && <div className="office-ai-consent-backdrop">
          <section className="office-ai-consent glass-card" role="dialog" aria-modal="true" aria-labelledby="office-ai-consent-title" aria-describedby="office-ai-consent-description">
            <div className="office-ai-consent-mark"><AlertCircle size={19} /></div>
            <div><span className="eyebrow">EXTERNAL AI DATA SHARING</span><h3 id="office-ai-consent-title">Share selected Drive content with COCCE AI?</h3></div>
            <p id="office-ai-consent-description">The selected file contents will be read from private Office Drive by the authenticated server and sent to OpenRouter's free-model router to generate this answer. OpenRouter currently lists Google AI Studio as retaining prompts for 55 days (and not training on them); review its <a href="https://openrouter.ai/providers" target="_blank" rel="noopener noreferrer">provider retention details</a> before sharing confidential records. The file contents are not stored in the COCCE AI chat history. This is not a zero-data-retention guarantee.</p>
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
        <div className="office-ai-footnote">{mode === 'chat' ? 'Private AI Chat history is saved inside the selected workspace. Only your account can read these conversations.' : includeWorkspaceContext ? 'COCCE AI samples authorised team conversations from up to 20 enabled workspaces.' : 'Team conversation history is off.'} {mode === 'assistant' ? (selectedFileIds.length ? 'Selected text files and native Docs/Sheets cloud copies are read server-side from enabled workspaces, limited to 3 files, 512 KiB and 8,000 extracted characters each (20,000 total).' : 'Drive files are never read unless you explicitly select them.') : ''} AI responses use the pinned OpenRouter free model; no paid-model fallback is enabled.</div>
      </>}
      {error && status === 'ready' && <div className="office-ai-error" role="alert"><AlertCircle size={14} /> {error}</div>}
    </section>
  </div>;
}
