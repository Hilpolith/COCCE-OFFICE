import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import { Bell, Check, CircleAlert, LogIn, LogOut, MessageCircle, Plus, RefreshCw, Shield, Users, X } from 'lucide-react';
import { officeTeamApi } from './lib/officeTeamApi';
import OfficePersonIdentity from './OfficePersonIdentity';
import OfficeChatPanel from './OfficeChatPanel';
import type { OfficeConversation, OfficeInvitation, OfficeMember, OfficeNotification, OfficePresence, OfficeSearchResult, OfficeWorkspace, OfficeWorkspaceInvitation, OfficeSuiteId } from './lib/officeTeamApi';
import { industryCatalog } from './lib/industryWorkspaces';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeTeamConfigState, OfficeTeamEnvironment } from './lib/officeTeamSupabase';

function friendlyError(error: unknown) {
  return error instanceof Error ? error.message : 'The Office collaboration request could not be completed.';
}

function displayName(person: { display_name?: string | null; username?: string | null; user_id?: string }) {
  return person.display_name?.trim() || (person.username ? `@${person.username}` : 'COCCE member');
}

type OfficeConfigFailure = Exclude<OfficeTeamConfigState, { status: 'ready' }>['status'];

function OfficeConnectionGate({ status }: { status: OfficeConfigFailure }) {
  const message = status === 'missing-url'
    ? 'Set VITE_COCCE_SUPABASE_URL to the existing COCCE Super App Supabase project URL.'
    : status === 'missing-public-key'
      ? 'Set this project’s public anon/publishable key as VITE_COCCE_SUPABASE_ANON_KEY.'
      : status === 'invalid-public-key'
        ? 'Office accepts only a public anon/publishable key; service-role and secret keys are rejected.'
        : status === 'wrong-project'
          ? 'Office is restricted to the existing COCCE Super App Supabase project and will not connect to another project.'
          : 'The configured COCCE Supabase URL must be the expected HTTPS project URL without query parameters.';
  return <section className="office-collab-panel glass-card" aria-labelledby="office-collab-title">
    <div className="office-collab-heading"><span className="office-collab-icon"><Shield size={18} /></span><div><span className="eyebrow">OFFICE COLLABORATION · CONFIGURATION REQUIRED</span><h2 id="office-collab-title">Membership, invitations, and chat</h2></div></div>
    <div className="office-collab-blocker" role="status"><CircleAlert size={17} /><div><strong>COCCE Auth is not configured.</strong><p>{message} Office RPCs remain inactive until the connection is valid and the Office schema gate is enabled. Auth settings, existing tables/RLS, and shared services are not modified.</p></div></div>
    <p className="office-collab-footnote">Office uses its own browser session against existing COCCE Auth, supports existing accounts only, and never creates accounts.</p>
  </section>;
}

export default function OfficeTeamCollaboration({
  initialWorkspaceName,
  initialWorkspaceId,
  initialSuiteId,
  onWorkspaceCreated,
}: {
  initialWorkspaceName?: string;
  initialWorkspaceId?: string;
  initialSuiteId?: OfficeSuiteId;
  onWorkspaceCreated?: (workspaceId: string, workspaceName: string) => void;
} = {}) {
  const config = resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment);
  const client = getOfficeTeamClient(config);
  const publicKey = config.status === 'ready' ? config.anonKey : '';
  const schemaReady = config.status === 'ready' && config.schemaReady;
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!client);
  const userIdRef = useRef<string | null>(null);
  const accountGenerationRef = useRef(0);
  const authEventVersionRef = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [authEmail, setAuthEmail] = useState('');
  const [authPassword, setAuthPassword] = useState('');
  const [workspaces, setWorkspaces] = useState<OfficeWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState('');
  const workspaceIdRef = useRef('');
  const globalWorkspaceIdRef = useRef('');
  const preferredWorkspaceSelectionRef = useRef<{ target: string | undefined; resolved: boolean }>({ target: initialWorkspaceId, resolved: false });
  const workspaceGenerationRef = useRef(0);
  useEffect(() => {
    preferredWorkspaceSelectionRef.current = { target: initialWorkspaceId, resolved: false };
  }, [initialWorkspaceId]);
  const setWorkspaceScope = useCallback((nextId: string) => {
    if (workspaceIdRef.current !== nextId) {
      workspaceIdRef.current = nextId;
      workspaceGenerationRef.current += 1;
      setBusy(false);
    }
    setWorkspaceId(nextId);
  }, []);
  const [workspaceName, setWorkspaceName] = useState(initialWorkspaceName ?? '');
  const [workspaceSuiteId, setWorkspaceSuiteId] = useState<OfficeSuiteId>(initialSuiteId ?? 'business');
  const [invitations, setInvitations] = useState<OfficeInvitation[]>([]);
  const [notifications, setNotifications] = useState<OfficeNotification[]>([]);
  const [members, setMembers] = useState<OfficeMember[]>([]);
  const [loadedWorkspaceId, setLoadedWorkspaceId] = useState('');
  const [workspaceInvitations, setWorkspaceInvitations] = useState<OfficeWorkspaceInvitation[]>([]);
  const [workspaceAiEnabled, setWorkspaceAiEnabled] = useState(true);
  const [presence, setPresence] = useState<OfficePresence[]>([]);
  const [presenceNow, setPresenceNow] = useState(() => Date.now());
  const [search, setSearch] = useState('');
  const [searchResults, setSearchResults] = useState<OfficeSearchResult[]>([]);
  const [inviteRole, setInviteRole] = useState<'admin' | 'member'>('member');
  const [inviteJobTitle, setInviteJobTitle] = useState('');
  const [conversations, setConversations] = useState<OfficeConversation[]>([]);
  const [conversationId, setConversationId] = useState('');
  const conversationIdRef = useRef('');
  const conversationGenerationRef = useRef(0);
  const setConversationScope = useCallback((nextId: string) => {
    if (conversationIdRef.current !== nextId) {
      conversationIdRef.current = nextId;
      conversationGenerationRef.current += 1;
      setBusy(false);
    }
    setConversationId(nextId);
  }, []);
  const [groupTitle, setGroupTitle] = useState('');
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([]);

  const resetAccountScopedState = useCallback(() => {
    setWorkspaces([]); setWorkspaceScope(''); setInvitations([]); setNotifications([]);
    setMembers([]); setLoadedWorkspaceId(''); setWorkspaceInvitations([]); setWorkspaceAiEnabled(true); setPresence([]);
    setSearchResults([]); setConversations([]); setConversationScope(''); setWorkspaceName(initialWorkspaceName ?? ''); setSearch(''); setInviteRole('member'); setInviteJobTitle('');
    setGroupTitle(''); setGroupMemberIds([]);
    setBusy(false);
  }, [initialWorkspaceName, setConversationScope, setWorkspaceScope]);
  const adoptUser = useCallback((nextUser: User | null) => {
    const nextUserId = nextUser?.id ?? null;
    if (userIdRef.current !== nextUserId) {
      userIdRef.current = nextUserId;
      accountGenerationRef.current += 1;
      resetAccountScopedState();
      preferredWorkspaceSelectionRef.current = { target: initialWorkspaceId, resolved: false };
      setAuthPassword('');
    }
    setUser(nextUser);
    setError(''); setNotice('');
  }, [initialWorkspaceId, resetAccountScopedState]);

  const activeWorkspace = workspaces.find((item) => item.workspace_id === workspaceId) ?? null;
  const isAdmin = activeWorkspace?.role === 'owner' || activeWorkspace?.role === 'admin';
  const isOwner = activeWorkspace?.role === 'owner';
  const workspaceDataReady = Boolean(workspaceId) && loadedWorkspaceId === workspaceId;
  const visibleMembers = workspaceDataReady ? members : [];
  const visiblePresence = workspaceDataReady ? presence : [];
  const visibleConversations = workspaceDataReady ? conversations : [];
  const visibleWorkspaceInvitations = workspaceDataReady ? workspaceInvitations : [];
  const activeMembers = visibleMembers.filter((member) => member.status === 'active' && member.user_id !== user?.id);

  useEffect(() => {
    if (!schemaReady || !client || !user) return undefined;
    const timer = window.setInterval(() => setPresenceNow(Date.now()), 15_000);
    return () => window.clearInterval(timer);
  }, [client, schemaReady, user]);

  useEffect(() => {
    if (!client) return undefined;
    let alive = true;
    const { data: subscription } = client.auth.onAuthStateChange((_event, session) => {
      authEventVersionRef.current += 1;
      adoptUser(session?.user ?? null);
      setAuthReady(true);
    });
    const startingAuthVersion = authEventVersionRef.current;
    const loadExistingSession = async () => {
      try {
        const { data: sessionData, error: sessionError } = await client.auth.getSession();
        if (!alive || authEventVersionRef.current !== startingAuthVersion) return;
        if (sessionError) {
          setError(sessionError.message);
          adoptUser(null);
          setAuthReady(true);
          return;
        }
        if (!sessionData.session) {
          adoptUser(null);
          setAuthReady(true);
          return;
        }
        const { data, error: authError } = await client.auth.getUser();
        if (!alive || authEventVersionRef.current !== startingAuthVersion) return;
        if (authError) { setError(authError.message); adoptUser(null); }
        else adoptUser(data.user);
        setAuthReady(true);
      } catch (cause) {
        if (alive && authEventVersionRef.current === startingAuthVersion) { setError(friendlyError(cause)); setAuthReady(true); }
      }
    };
    void loadExistingSession();
    return () => { alive = false; subscription.subscription.unsubscribe(); };
  }, [adoptUser, client]);

  useEffect(() => {
    if (!schemaReady || !client || !user) return undefined;
    let alive = true;
    let loading = false;
    const generation = accountGenerationRef.current;
    const scopedUserId = user.id;
    const isCurrent = () => alive && generation === accountGenerationRef.current && scopedUserId === userIdRef.current;
    const load = async () => {
      if (loading || !isCurrent()) return;
      loading = true;
      try {
        const [nextWorkspaces, nextInvitations, nextNotifications] = await Promise.all([
          officeTeamApi.listWorkspaces(client), officeTeamApi.listMyInvitations(client), officeTeamApi.listNotifications(client),
        ]);
        if (!isCurrent()) return;
        setWorkspaces(nextWorkspaces);
        setInvitations(nextInvitations);
        setNotifications(nextNotifications);
        const selectedWorkspaceId = workspaceIdRef.current;
        const globallySelectedId = globalWorkspaceIdRef.current;
        const globalSelectionAvailable = Boolean(globallySelectedId && nextWorkspaces.some((item) => item.workspace_id === globallySelectedId));
        const preferredId = initialWorkspaceId?.trim();
        const preferredSelection = preferredWorkspaceSelectionRef.current;
        const preferredIsAvailable = Boolean(preferredId && nextWorkspaces.some((item) => item.workspace_id === preferredId));
        if (globalSelectionAvailable) {
          setWorkspaceScope(globallySelectedId);
          setConversationScope('');
        } else if (preferredId && (preferredSelection.target !== initialWorkspaceId || !preferredSelection.resolved || (preferredIsAvailable && !selectedWorkspaceId))) {
          preferredWorkspaceSelectionRef.current = { target: initialWorkspaceId, resolved: true };
          setWorkspaceScope(preferredIsAvailable ? preferredId : '');
          setConversationScope('');
          setNotice(preferredIsAvailable
            ? 'Opened the existing team linked to this industry office.'
            : 'The team linked to this industry office is not available to this Office account. Check the signed-in account or team membership; no new team was created.');
        } else if (!preferredId && (!selectedWorkspaceId || !nextWorkspaces.some((item) => item.workspace_id === selectedWorkspaceId))) {
          setWorkspaceScope(nextWorkspaces[0]?.workspace_id ?? '');
          setConversationScope('');
        }
      } catch (cause) { if (isCurrent()) setError(friendlyError(cause)); }
      finally { loading = false; }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [client, initialWorkspaceId, schemaReady, setConversationScope, setWorkspaceScope, user, workspaceId]);

  useEffect(() => {
    const handleWorkspaceChange = (event: Event) => {
      const nextId = (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId ?? '';
      globalWorkspaceIdRef.current = nextId;
      if (!nextId || !workspaces.some((item) => item.workspace_id === nextId)) return;
      setWorkspaceScope(nextId);
      setConversationScope('');
      setNotice('');
      setMembers([]);
      setLoadedWorkspaceId('');
      setWorkspaceInvitations([]);
      setWorkspaceAiEnabled(true);
      setPresence([]);
      setSearch('');
      setSearchResults([]);
      setConversations([]);
      setGroupTitle('');
      setGroupMemberIds([]);
    };
    const handleWorkspaceClear = () => {
      globalWorkspaceIdRef.current = '';
      setWorkspaceScope('');
      setConversationScope('');
      setMembers([]);
      setLoadedWorkspaceId('');
      setWorkspaceInvitations([]);
      setPresence([]);
      setConversations([]);
    };
    window.addEventListener('cocce-office:workspace-changed', handleWorkspaceChange);
    window.addEventListener('cocce-office:workspace-cleared', handleWorkspaceClear);
    return () => {
      window.removeEventListener('cocce-office:workspace-changed', handleWorkspaceChange);
      window.removeEventListener('cocce-office:workspace-cleared', handleWorkspaceClear);
    };
  }, [workspaces, setWorkspaceScope, setConversationScope]);

  useEffect(() => {
    if (!schemaReady || !client || !user || !workspaceId) return undefined;
    let alive = true;
    let loading = false;
    const generation = accountGenerationRef.current;
    const scopedUserId = user.id;
    const targetWorkspaceId = workspaceId;
    const workspaceGeneration = workspaceGenerationRef.current;
    const conversationGeneration = conversationGenerationRef.current;
    const isCurrent = () => alive && generation === accountGenerationRef.current && scopedUserId === userIdRef.current
      && targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current;
    const load = async () => {
      if (loading || !isCurrent()) return;
      loading = true;
      try {
        const [nextMembers, nextConversations, nextPresence] = await Promise.all([
          officeTeamApi.listMembers(client, targetWorkspaceId), officeTeamApi.listConversations(client, targetWorkspaceId), officeTeamApi.listPresence(client, targetWorkspaceId),
        ]);
        if (!isCurrent()) return;
        const nextWorkspaceInvitations = activeWorkspace && ['owner', 'admin'].includes(activeWorkspace.role)
          ? await officeTeamApi.listWorkspaceInvitations(client, targetWorkspaceId) : [];
        if (!isCurrent()) return;
        setMembers(nextMembers); setConversations(nextConversations); setPresence(nextPresence); setWorkspaceInvitations(nextWorkspaceInvitations); setLoadedWorkspaceId(targetWorkspaceId);
        if (conversationGenerationRef.current === conversationGeneration) {
          const selectedConversationId = conversationIdRef.current;
          setConversationScope(selectedConversationId && nextConversations.some((item) => item.conversation_id === selectedConversationId)
            ? selectedConversationId : nextConversations[0]?.conversation_id ?? '');
        }
      } catch (cause) { if (isCurrent()) setError(friendlyError(cause)); }
      finally { loading = false; }
    };
    void load();
    const timer = window.setInterval(() => { void load(); }, 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [activeWorkspace, client, schemaReady, setConversationScope, user, workspaceId]);

  const workspaceIdsKey = workspaces.map((item) => item.workspace_id).sort().join(',');

  useEffect(() => {
    if (!schemaReady || !client || !user) return undefined;
    let alive = true;
    const generation = accountGenerationRef.current;
    const scopedUserId = user.id;
    const workspaceIds = workspaceIdsKey ? workspaceIdsKey.split(',') : [];
    const isCurrent = () => alive && generation === accountGenerationRef.current && scopedUserId === userIdRef.current;
    const heartbeat = () => {
      if (!isCurrent()) return;
      const status = document.visibilityState === 'visible' ? 'online' : 'away';
      workspaceIds.forEach((scopeId) => {
        void officeTeamApi.touchPresence(client, scopeId, status).catch((cause: unknown) => { if (isCurrent()) setError(friendlyError(cause)); });
      });
    };
    heartbeat();
    const timer = window.setInterval(heartbeat, 25_000);
    const onVisibility = () => heartbeat();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      const mayMarkOffline = isCurrent();
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (mayMarkOffline) workspaceIds.forEach((scopeId) => { void officeTeamApi.touchPresence(client, scopeId, 'offline').catch(() => undefined); });
    };
  }, [client, schemaReady, user, workspaceIdsKey]);


  const signInWithExistingAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    const email = authEmail.trim();
    if (!email || !authPassword) { setError('Enter the email and password for an existing COCCE account.'); return; }
    const startingAuthVersion = authEventVersionRef.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const { data, error: signInError } = await client.auth.signInWithPassword({ email, password: authPassword });
      if (signInError) throw signInError;
      if (!data.user) throw new Error('COCCE Auth did not return an account for this sign-in.');
      if (authEventVersionRef.current !== startingAuthVersion && userIdRef.current !== data.user.id) return;
      if (userIdRef.current !== data.user.id) adoptUser(data.user);
      setAuthPassword('');
      setNotice('Signed in to an existing COCCE account in this Office browser.');
    } catch (cause) {
      if (authEventVersionRef.current === startingAuthVersion) setError(friendlyError(cause));
    } finally {
      if (authEventVersionRef.current === startingAuthVersion || userIdRef.current) setBusy(false);
    }
  };

  const signOutOfficeSession = async () => {
    if (!client) return;
    const startingGeneration = accountGenerationRef.current;
    const startingUserId = userIdRef.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
      if (signOutError) throw signOutError;
      setAuthPassword('');
      if (userIdRef.current === null) setNotice('Signed out of Office in this browser only; other COCCE app sessions are not affected.');
    } catch (cause) {
      if (accountGenerationRef.current === startingGeneration && userIdRef.current === startingUserId) setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!client) return <OfficeConnectionGate status={config.status === 'ready' ? 'invalid-public-key' : config.status} />;
  if (!authReady) return <section className="office-collab-panel glass-card"><p role="status">Checking this Office browser’s COCCE Auth session…</p></section>;

  const signInForm = <div className="office-collab-auth">
    <p>Sign in with an existing COCCE account. Office does not provide account creation.</p>
    <form className="office-inline-auth" onSubmit={signInWithExistingAccount}>
      <label>Email<input type="email" autoComplete="username" value={authEmail} onChange={(event) => setAuthEmail(event.target.value)} required disabled={busy} /></label>
      <label>Password<input type="password" autoComplete="current-password" value={authPassword} onChange={(event) => setAuthPassword(event.target.value)} required disabled={busy} /></label>
      <button className="button-primary" disabled={busy}><LogIn size={15} /> Sign in</button>
    </form>
    <p className="office-collab-footnote">This creates only an Office-local browser session for your existing COCCE account. There is no sign-up flow.</p>
  </div>;

  if (!schemaReady) return <section className="office-collab-panel glass-card" aria-labelledby="office-collab-title">
    <div className="office-collab-heading"><span className="office-collab-icon"><Shield size={18} /></span><div><span className="eyebrow">EXISTING COCCE AUTH · OFFICE DATA DISABLED</span><h2 id="office-collab-title">Membership, invitations, and chat</h2></div></div>
    {error && <div className="office-collab-alert" role="alert"><CircleAlert size={15} />{error}</div>}
    {notice && <div className="office-collab-status" role="status"><Check size={15} />{notice}</div>}
    {user ? <div className="office-collab-account"><span>Signed in to existing COCCE Auth · <strong>{user.email ?? user.id}</strong></span><small>Office keeps an independent session in this browser; signing out here does not sign out other COCCE apps.</small><button className="button-tertiary office-signout" disabled={busy} onClick={() => { void signOutOfficeSession(); }}><LogOut size={14} /> Sign out of Office</button></div> : signInForm}
    <div className="office-collab-blocker" role="status"><CircleAlert size={17} /><div><strong>Office collaboration is not enabled.</strong><p>The Office feature gate is off in this build. Existing COCCE Auth remains available, but no Office collaboration RPCs are called until the gate is enabled.</p></div></div>
  </section>;

  const run = async (action: (isCurrent: () => boolean) => Promise<unknown>, success?: string, scopeIsCurrent: () => boolean = () => true) => {
    const generation = accountGenerationRef.current;
    const scopedUserId = user?.id ?? null;
    const isCurrent = () => generation === accountGenerationRef.current && scopedUserId === userIdRef.current && scopeIsCurrent();
    setBusy(true); setError(''); setNotice('');
    try { const result = await action(isCurrent); if (result !== false && isCurrent() && success) setNotice(success); }
    catch (cause) { if (isCurrent()) setError(friendlyError(cause)); }
    finally { if (isCurrent()) setBusy(false); }
  };

  const createWorkspace = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workspaceName.trim()) return;
    const requestedName = workspaceName.trim();
    const startingWorkspaceGeneration = workspaceGenerationRef.current;
    const startingConversationGeneration = conversationGenerationRef.current;
    void run(async (isCurrent) => {
      const createdWorkspaceId = await officeTeamApi.createWorkspaceWithSuite(client, requestedName, '', workspaceSuiteId);
      if (!isCurrent()) return;
      setWorkspaceName('');
      const next = await officeTeamApi.listWorkspaces(client);
      if (!isCurrent()) return;
      setWorkspaces(next);
      if (workspaceGenerationRef.current === startingWorkspaceGeneration) {
        const createdIsListed = next.some((item) => item.workspace_id === createdWorkspaceId);
        setWorkspaceScope(createdIsListed ? createdWorkspaceId : next[0]?.workspace_id ?? '');
        setConversationScope('');
      }
      onWorkspaceCreated?.(createdWorkspaceId, requestedName);
      window.dispatchEvent(new CustomEvent('cocce-office:workspace-created', { detail: { workspaceId: createdWorkspaceId, name: requestedName, suiteId: workspaceSuiteId } }));
    }, 'Office space created.', () => startingWorkspaceGeneration === workspaceGenerationRef.current
      && startingConversationGeneration === conversationGenerationRef.current);
  };

  const searchUsers = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!workspaceId) return;
    const targetWorkspaceId = workspaceIdRef.current;
    const workspaceGeneration = workspaceGenerationRef.current;
    void run(async (isCurrent) => {
      const next = await officeTeamApi.searchUsers(client, targetWorkspaceId, search.trim());
      if (isCurrent() && targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current) setSearchResults(next);
    }, undefined, () => targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current);
  };

  const inviteUser = (person: OfficeSearchResult) => {
    const targetWorkspaceId = workspaceIdRef.current;
    const workspaceGeneration = workspaceGenerationRef.current;
    void run(async (isCurrent) => {
      const isWorkspaceCurrent = () => isCurrent() && targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current;
      await officeTeamApi.createInvitation(client, targetWorkspaceId, person.user_id, inviteRole, inviteJobTitle.trim());
      if (!isWorkspaceCurrent()) return;
      const next = await officeTeamApi.listWorkspaceInvitations(client, targetWorkspaceId);
      if (!isWorkspaceCurrent()) return;
      setWorkspaceInvitations(next);
      setInviteJobTitle('');
      setSearchResults((items) => items.map((item) => item.user_id === person.user_id ? { ...item, invitation_status: 'pending' } : item));
    }, 'Invitation sent to the selected COCCE account.', () => targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current);
  };

  const respond = (invitation: OfficeInvitation, accept: boolean) => {
    const startingWorkspaceId = workspaceIdRef.current;
    const startingWorkspaceGeneration = workspaceGenerationRef.current;
    const startingConversationId = conversationIdRef.current;
    const startingConversationGeneration = conversationGenerationRef.current;
    void run(async (isCurrent) => {
      await officeTeamApi.respondInvitation(client, invitation.invitation_id, accept);
      if (!isCurrent()) return;
      const nextInvitations = await officeTeamApi.listMyInvitations(client);
      if (!isCurrent()) return;
      setInvitations(nextInvitations);
      const nextWorkspaces = await officeTeamApi.listWorkspaces(client);
      if (!isCurrent()) return;
      setWorkspaces(nextWorkspaces);
      if (!workspaceIdRef.current) {
        setWorkspaceScope(nextWorkspaces[0]?.workspace_id ?? '');
        setConversationScope('');
      }
    }, accept ? 'Invitation accepted.' : 'Invitation declined.', () => startingWorkspaceId === workspaceIdRef.current
      && startingWorkspaceGeneration === workspaceGenerationRef.current && startingConversationId === conversationIdRef.current
      && startingConversationGeneration === conversationGenerationRef.current);
  };

  const manageMember = (member: OfficeMember, action: 'role' | 'suspend' | 'restore' | 'remove', role?: 'admin' | 'member') => {
    const targetWorkspaceId = workspaceIdRef.current;
    const workspaceGeneration = workspaceGenerationRef.current;
    void run(async (isCurrent) => {
      const isWorkspaceCurrent = () => isCurrent() && targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current;
      await officeTeamApi.manageMember(client, targetWorkspaceId, member.user_id, action, role);
      if (!isWorkspaceCurrent()) return;
      const next = await officeTeamApi.listMembers(client, targetWorkspaceId);
      if (isWorkspaceCurrent()) setMembers(next);
    }, 'Membership updated.', () => targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current);
  };

  const saveMemberJobTitle = (member: OfficeMember, jobTitle: string) => {
    const value = jobTitle.trim();
    if (value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) {
      setError('Position must be plain text up to 80 characters.');
      return;
    }
    if (value === (member.job_title ?? '')) return;
    const targetWorkspaceId = workspaceIdRef.current;
    const workspaceGeneration = workspaceGenerationRef.current;
    void run(async (isCurrent) => {
      const isWorkspaceCurrent = () => isCurrent() && targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current;
      await officeTeamApi.setMemberTitle(client, targetWorkspaceId, member.user_id, value);
      if (!isWorkspaceCurrent()) return;
      const next = await officeTeamApi.listMembers(client, targetWorkspaceId);
      if (isWorkspaceCurrent()) setMembers(next);
    }, 'Member position updated.', () => targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current);
  };

  const updateWorkspaceAi = (enabled: boolean) => {
    const targetWorkspaceId = workspaceIdRef.current;
    const workspaceGeneration = workspaceGenerationRef.current;
    void run(async (isCurrent) => {
      await officeTeamApi.setWorkspaceAiEnabled(client, targetWorkspaceId, enabled);
      if (isCurrent() && targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current) {
        setWorkspaceAiEnabled(enabled);
      }
    }, enabled ? 'COCCE AI enabled for this workspace.' : 'COCCE AI disabled for this workspace.', () => targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current);
  };

  const loadWorkspaceLists = async (isCurrent: () => boolean) => {
    const targetWorkspaceId = workspaceIdRef.current;
    const workspaceGeneration = workspaceGenerationRef.current;
    const isWorkspaceCurrent = () => isCurrent() && targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current;
    const [nextMembers, nextPresence, nextAiEnabled] = await Promise.all([
      officeTeamApi.listMembers(client, targetWorkspaceId),
      officeTeamApi.listPresence(client, targetWorkspaceId),
      officeTeamApi.getWorkspaceAiEnabled(client, targetWorkspaceId),
    ]);
    if (!isWorkspaceCurrent()) return;
    const nextInvitations = isAdmin ? await officeTeamApi.listWorkspaceInvitations(client, targetWorkspaceId) : [];
    if (!isWorkspaceCurrent()) return;
    setMembers(nextMembers);
    setPresence(nextPresence);
    setWorkspaceAiEnabled(nextAiEnabled);
    setLoadedWorkspaceId(targetWorkspaceId);
    setWorkspaceInvitations(nextInvitations);
  };

  const cancelInvitation = (invitation: OfficeWorkspaceInvitation) => {
    const targetWorkspaceId = workspaceIdRef.current;
    const workspaceGeneration = workspaceGenerationRef.current;
    void run(async (isCurrent) => {
      const isWorkspaceCurrent = () => isCurrent() && targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current;
      await officeTeamApi.cancelInvitation(client, invitation.invitation_id);
      if (!isWorkspaceCurrent()) return;
      await loadWorkspaceLists(isCurrent);
    }, 'Invitation revoked.', () => targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current);
  };

  const markNotificationRead = (notification: OfficeNotification) => {
    const targetWorkspaceId = workspaceIdRef.current;
    const workspaceGeneration = workspaceGenerationRef.current;
    const targetConversationId = conversationIdRef.current;
    const conversationGeneration = conversationGenerationRef.current;
    void run(async (isCurrent) => {
      await officeTeamApi.markNotificationRead(client, notification.notification_id);
      if (!isCurrent()) return;
      const next = await officeTeamApi.listNotifications(client);
      if (isCurrent()) setNotifications(next);
    }, 'Notification marked read.', () => targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current
      && targetConversationId === conversationIdRef.current && conversationGeneration === conversationGenerationRef.current);
  };

  const refreshOfficeData = () => {
    const targetWorkspaceId = workspaceIdRef.current;
    const workspaceGeneration = workspaceGenerationRef.current;
    const targetConversationId = conversationIdRef.current;
    const conversationGeneration = conversationGenerationRef.current;
    void run(async (isCurrent) => {
      const nextWorkspaces = await officeTeamApi.listWorkspaces(client);
      if (!isCurrent()) return;
      setWorkspaces(nextWorkspaces);
      if (targetWorkspaceId) await loadWorkspaceLists(isCurrent);
      if (!isCurrent()) return;
      const nextInvitations = await officeTeamApi.listMyInvitations(client);
      if (!isCurrent()) return;
      setInvitations(nextInvitations);
      const nextNotifications = await officeTeamApi.listNotifications(client);
      if (isCurrent()) setNotifications(nextNotifications);
    }, 'Office data refreshed.', () => targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current
      && targetConversationId === conversationIdRef.current && conversationGeneration === conversationGenerationRef.current);
  };

  const startDirect = (member: OfficeMember) => {
    const targetWorkspaceId = workspaceIdRef.current;
    const workspaceGeneration = workspaceGenerationRef.current;
    const conversationGeneration = conversationGenerationRef.current;
    void run(async (isCurrent) => {
      const isWorkspaceCurrent = () => isCurrent() && targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current;
      const id = await officeTeamApi.createConversation(client, targetWorkspaceId, 'direct', [member.user_id], null);
      if (!isWorkspaceCurrent() || conversationGeneration !== conversationGenerationRef.current) return false;
      const next = await officeTeamApi.listConversations(client, targetWorkspaceId);
      if (!isWorkspaceCurrent() || conversationGeneration !== conversationGenerationRef.current) return false;
      setConversations(next);
      setConversationScope(id);
      return true;
    }, `Direct conversation opened with ${displayName(member)}.`, () => targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current);
  };

  const startGroup = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!groupTitle.trim() || groupMemberIds.length < 1) return;
    const targetWorkspaceId = workspaceIdRef.current;
    const workspaceGeneration = workspaceGenerationRef.current;
    const conversationGeneration = conversationGenerationRef.current;
    void run(async (isCurrent) => {
      const isWorkspaceCurrent = () => isCurrent() && targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current;
      const id = await officeTeamApi.createConversation(client, targetWorkspaceId, 'group', groupMemberIds, groupTitle.trim());
      if (!isWorkspaceCurrent() || conversationGeneration !== conversationGenerationRef.current) return false;
      const next = await officeTeamApi.listConversations(client, targetWorkspaceId);
      if (!isWorkspaceCurrent() || conversationGeneration !== conversationGenerationRef.current) return false;
      setConversations(next);
      setConversationScope(id); setGroupTitle(''); setGroupMemberIds([]);
      return true;
    }, 'Group conversation created.', () => targetWorkspaceId === workspaceIdRef.current && workspaceGeneration === workspaceGenerationRef.current);
  };

  return <section className="office-collab-panel glass-card" aria-labelledby="office-collab-title">
    <div className="office-collab-heading"><span className="office-collab-icon"><Users size={18} /></span><div><span className="eyebrow">OFFICE COLLABORATION · SERVER-BACKED</span><h2 id="office-collab-title">Membership, invitations, and chat</h2></div></div>
    {error && <div className="office-collab-alert" role="alert"><CircleAlert size={15} />{error}</div>}
    {notice && <div className="office-collab-status" role="status"><Check size={15} />{notice}</div>}
    {!user ? signInForm : <>
      <div className="office-collab-account"><span>Signed in to existing COCCE Auth · <strong>{user.email ?? user.id}</strong></span><small>Office’s session is local to this browser. Signing out here does not sign out other COCCE apps.</small><button className="button-tertiary office-signout" disabled={busy} onClick={() => { void signOutOfficeSession(); }}><LogOut size={14} /> Sign out of Office</button></div>
      {invitations.length > 0 && <div className="office-inbox"><h3><Bell size={15} /> Invitations for you</h3>{invitations.map((invitation) => { const inviterPresence = invitation.workspace_id === workspaceId ? visiblePresence.find((person) => person.user_id === invitation.inviter_id) : undefined; return <article className="office-invite-row" key={invitation.invitation_id}><div><strong>{invitation.workspace_name}</strong><OfficePersonIdentity name={invitation.inviter_name} avatarUrl={invitation.inviter_avatar_url} isVip={invitation.inviter_is_vip} vipExpiresAt={invitation.inviter_vip_expires_at} presenceStatus={inviterPresence?.status ?? invitation.inviter_presence_status} lastSeenAt={inviterPresence?.last_seen_at ?? invitation.inviter_last_seen_at} now={presenceNow} compact /><small>{invitation.role}</small></div><button className="button-primary" disabled={busy} onClick={() => respond(invitation, true)}>Accept</button><button className="button-secondary" disabled={busy} onClick={() => respond(invitation, false)}>Decline</button></article>; })}</div>}
      {!initialWorkspaceId && <div className="office-create-space"><h3>{initialWorkspaceName ? 'Create an Office team for this industry office' : workspaces.length ? 'Create another Office space' : 'Create an Office space'}</h3><p>{initialWorkspaceName ? `This creates a server-backed team named for ${initialWorkspaceName}. Industry register items remain local and are not uploaded.` : workspaces.length ? 'Create a separate organisation or team workspace. You can switch between every workspace you own or have joined.' : 'This creates your first server-backed Office workspace in the selected COCCE project. It does not convert or upload the local planner above.'}</p><form onSubmit={createWorkspace}><input aria-label="Office space name" value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} maxLength={80} placeholder="Office space name" required /><label className="office-create-suite-field">Office suite<select aria-label="Office suite" value={workspaceSuiteId} onChange={(event) => setWorkspaceSuiteId(event.target.value as OfficeSuiteId)} disabled={busy}>{industryCatalog.map((industry) => <option key={industry.id} value={industry.id}>{industry.label}</option>)}</select></label><button className="button-primary" type="submit" disabled={busy}><Plus size={15} /> {initialWorkspaceName ? 'Create team' : 'Create Office'}</button></form></div>}
      {workspaces.length === 0 ? null : <>
        <div className="office-workspace-controls"><label className="office-workspace-select">Office space<select aria-label="Office space" value={workspaceId} onChange={(event) => { globalWorkspaceIdRef.current = event.target.value; setWorkspaceScope(event.target.value); setConversationScope(''); setNotice(''); setMembers([]); setLoadedWorkspaceId(''); setWorkspaceInvitations([]); setWorkspaceAiEnabled(true); setPresence([]); setSearch(''); setSearchResults([]); setConversations([]); setGroupTitle(''); setGroupMemberIds([]); }}>{!workspaceId && <option value="" disabled>Select an available team</option>}{workspaces.map((item) => <option key={item.workspace_id} value={item.workspace_id}>{item.name} · {item.role}</option>)}</select></label><div className="office-workspace-ai-control"><span><strong>COCCE AI</strong><small>{!workspaceDataReady ? 'Checking workspace setting' : workspaceAiEnabled ? 'Enabled in this workspace' : 'Disabled in this workspace'}</small></span>{isAdmin && <label><input type="checkbox" checked={workspaceAiEnabled} disabled={busy || !workspaceDataReady} onChange={(event) => updateWorkspaceAi(event.target.checked)} /><span className="sr-only">Enable COCCE AI in this workspace</span></label>}</div></div>
        {activeWorkspace && <div className="office-collab-grid">
          <div className="office-collab-column">
            <section className="office-subpanel"><div className="office-subpanel-title"><h3><Users size={15} /> Members</h3><span>{visibleMembers.filter((member) => member.status === 'active').length}</span></div>
              {visibleMembers.map((member) => { const own = member.user_id === user.id; const canManage = isAdmin && !own && (isOwner || member.role === 'member'); const memberPresence = visiblePresence.find((person) => person.user_id === member.user_id); return <article className="office-member-row" key={member.user_id}><OfficePersonIdentity name={`${displayName(member)}${own ? ' · you' : ''}`} avatarUrl={member.avatar_url} isVip={member.is_vip} vipExpiresAt={member.vip_expires_at} presenceStatus={memberPresence ? memberPresence.status : 'offline'} lastSeenAt={memberPresence?.last_seen_at} now={presenceNow} compact /><span className="office-member-role">{member.role} · {member.status}{member.job_title ? ` · ${member.job_title}` : ''}</span>{isAdmin && (isOwner || member.role !== 'owner') && member.status === 'active' && <input className="office-member-job-title" aria-label={`Job position for ${displayName(member)}`} defaultValue={member.job_title ?? ''} maxLength={80} placeholder="Add position" onBlur={(event) => saveMemberJobTitle(member, event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} />}{!own && member.status === 'active' && <button className="button-tertiary office-message-member" disabled={busy} onClick={() => startDirect(member)} aria-label={`Message ${displayName(member)}`}><MessageCircle size={14} /></button>}{canManage && <select className="office-member-action" aria-label={`Manage ${displayName(member)}`} value="" disabled={busy} onChange={(event) => { const value = event.target.value; if (value === 'member' || value === 'admin') manageMember(member, 'role', value); else if (value === 'suspend' || value === 'remove' || value === 'restore') manageMember(member, value); event.currentTarget.value = ''; }}><option value="" disabled>Manage</option>{isOwner && member.status === 'active' && <><option value="member">Set member</option><option value="admin">Set admin</option></>}{member.status === 'active' ? <option value="suspend">Suspend</option> : <option value="restore">Restore</option>}<option value="remove">Remove</option></select>}</article>; })}
            </section>
            {isAdmin && <section className="office-subpanel"><div className="office-subpanel-title"><h3>Invite a COCCE member</h3><span>COCCE-visible profile fields</span></div><form className="office-search-form" onSubmit={searchUsers}><input aria-label="Search COCCE members" value={search} onChange={(event) => setSearch(event.target.value)} minLength={2} placeholder="Search username or display name" /><button className="button-secondary" disabled={busy}><RefreshCw size={14} /> Search</button></form><div className="office-invite-settings">{isOwner && <label className="office-role-select">Permission role<select value={inviteRole} onChange={(event) => setInviteRole(event.target.value as 'admin' | 'member')}><option value="member">Member</option><option value="admin">Administrator</option></select></label>}<label className="office-job-title-field">Job position <span>(optional)</span><input value={inviteJobTitle} onChange={(event) => setInviteJobTitle(event.target.value)} maxLength={80} placeholder="e.g. CEO, COO, VP, Supervisor, Officer" /></label></div>{searchResults.map((person) => { const personPresence = visiblePresence.find((item) => item.user_id === person.user_id); return <article className="office-invite-row" key={person.user_id}><OfficePersonIdentity name={displayName(person)} avatarUrl={person.avatar_url} isVip={person.is_vip} vipExpiresAt={person.vip_expires_at} presenceStatus={personPresence?.status ?? person.presence_status} lastSeenAt={personPresence?.last_seen_at ?? person.last_seen_at} now={presenceNow} compact />{person.membership_status === 'active' ? <span>Already a member</span> : person.invitation_status === 'pending' ? <span>Invitation pending</span> : <button className="button-primary" disabled={busy} onClick={() => inviteUser(person)}>Invite</button>}</article>; })}{visibleWorkspaceInvitations.length > 0 && <div className="office-pending-list"><h4>Pending invitations</h4>{visibleWorkspaceInvitations.map((invitation) => { const inviteePresence = visiblePresence.find((person) => person.user_id === invitation.invitee_id); return <article className="office-invite-row" key={invitation.invitation_id}><div><OfficePersonIdentity name={displayName({ display_name: invitation.display_name, username: invitation.username, user_id: invitation.invitee_id })} avatarUrl={invitation.avatar_url} isVip={invitation.is_vip} vipExpiresAt={invitation.vip_expires_at} presenceStatus={inviteePresence?.status ?? invitation.presence_status} lastSeenAt={inviteePresence?.last_seen_at ?? invitation.last_seen_at} now={presenceNow} compact /><small>{invitation.role} · expires {new Date(invitation.expires_at).toLocaleDateString()}</small></div><button className="button-tertiary" disabled={busy} onClick={() => cancelInvitation(invitation)} aria-label={`Revoke invitation for ${displayName({ display_name: invitation.display_name, username: invitation.username, user_id: invitation.invitee_id })}`}><X size={14} /> Revoke</button></article>; })}</div>}</section>}
            <section className="office-subpanel"><div className="office-subpanel-title"><h3><Bell size={15} /> Notifications</h3><span>{notifications.filter((item) => !item.read_at).length} unread</span></div>{notifications.filter((item) => item.workspace_id === workspaceId).slice(0, 5).map((item) => { const actorPresence = item.actor_id ? visiblePresence.find((person) => person.user_id === item.actor_id) : undefined; return <article className={`office-notification-row ${item.read_at ? '' : 'is-unread'}`} key={item.notification_id}>{item.actor_id && <OfficePersonIdentity name={item.actor_name ?? `COCCE member ${item.actor_id.slice(0, 8)}`} avatarUrl={item.actor_avatar_url} isVip={item.actor_is_vip} vipExpiresAt={item.actor_vip_expires_at} presenceStatus={actorPresence?.status ?? item.actor_presence_status} lastSeenAt={actorPresence?.last_seen_at ?? item.actor_last_seen_at} now={presenceNow} compact />}<span>{item.kind.replaceAll('_', ' ')}</span><small>{new Date(item.created_at).toLocaleString()}</small>{!item.read_at && <button className="button-tertiary" disabled={busy} onClick={() => markNotificationRead(item)}>Mark read</button>}</article>; })}{notifications.filter((item) => item.workspace_id === workspaceId).length === 0 && <p className="office-muted">No Office notifications yet.</p>}</section>
          </div>
          <div className="office-collab-column">
            <section className="office-subpanel"><div className="office-subpanel-title"><h3><MessageCircle size={15} /> Chat</h3><span>server-backed</span></div><div className="office-conversation-list">{visibleConversations.map((conversation) => { const directPresence = conversation.direct_user_id ? visiblePresence.find((person) => person.user_id === conversation.direct_user_id) : undefined; return <button className={`office-conversation-button ${conversation.conversation_id === conversationId ? 'is-active' : ''}`} key={conversation.conversation_id} onClick={() => { setConversationScope(conversation.conversation_id); }}>{conversation.kind === 'direct' && conversation.direct_user_id ? <OfficePersonIdentity name={displayName({ display_name: conversation.direct_user_display_name, username: conversation.direct_user_username, user_id: conversation.direct_user_id })} avatarUrl={conversation.direct_user_avatar_url} isVip={conversation.direct_user_is_vip} vipExpiresAt={conversation.direct_user_vip_expires_at} presenceStatus={directPresence?.status ?? conversation.direct_user_presence_status} lastSeenAt={directPresence?.last_seen_at ?? conversation.direct_user_last_seen_at} now={presenceNow} compact /> : <span>{conversation.title || conversation.kind}</span>}<small>{conversation.kind}</small></button>; })}</div><form className="office-group-form" onSubmit={startGroup}><label>New group name<input value={groupTitle} onChange={(event) => setGroupTitle(event.target.value)} maxLength={80} placeholder="Project group" /></label><div className="office-group-members">{activeMembers.map((member) => { const memberPresence = visiblePresence.find((person) => person.user_id === member.user_id); return <label key={member.user_id}><input type="checkbox" checked={groupMemberIds.includes(member.user_id)} onChange={(event) => setGroupMemberIds((ids) => event.target.checked ? [...ids, member.user_id] : ids.filter((id) => id !== member.user_id))} /><OfficePersonIdentity name={displayName(member)} avatarUrl={member.avatar_url} isVip={member.is_vip} vipExpiresAt={member.vip_expires_at} presenceStatus={memberPresence ? memberPresence.status : 'offline'} lastSeenAt={memberPresence?.last_seen_at} now={presenceNow} compact /></label>; })}</div><button className="button-secondary" disabled={busy || !groupTitle.trim() || groupMemberIds.length === 0}><Plus size={14} /> Create group</button></form>
              {conversationId ? <OfficeChatPanel client={client} user={user} publicKey={publicKey} workspaceId={workspaceId} conversationId={conversationId} disabled={busy} canModerate={isAdmin} /> : <p className="office-muted">Choose a conversation or start a direct or group chat to begin.</p>}</section>
          </div>
        </div>}
      </>}
      <div className="office-collab-footer"><span>Chats use Supabase Realtime with a 15-second polling fallback; workspace members, conversations, and presence refresh every 15 seconds; workspaces, invitations, and notifications refresh every 30 seconds. Presence heartbeats run every 25 seconds.</span><button className="button-tertiary" disabled={busy} onClick={refreshOfficeData}><RefreshCw size={13} /> Refresh</button></div>
    </>}
  </section>;
}
