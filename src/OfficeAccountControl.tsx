import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import {
  ArrowRight, Building2, CheckCircle2, CircleAlert, Eye, EyeOff,
  LoaderCircle, LockKeyhole, LogIn, LogOut, Mail, ShieldCheck, UserRound, X,
} from 'lucide-react';
import { officeTeamApi, type OfficeWorkspace } from './lib/officeTeamApi';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import './officeAccount.css';

type AuthMode = 'signin' | 'signup' | 'forgot' | 'recovery';
function friendlyError(error: unknown) {
  const message = error instanceof Error ? error.message : 'COCCE Auth could not complete that request.';
  if (/user already registered|already been registered/i.test(message)) return 'An account already exists with this email. Sign in instead.';
  if (/invalid login credentials/i.test(message)) return 'The email or password is incorrect. Check your details and try again.';
  if (/password should be at least/i.test(message)) return 'Use a password with at least 8 characters.';
  if (/signup is disabled|signups not allowed/i.test(message)) return 'Account creation is currently disabled in COCCE Auth. Enable email sign-ups in the existing COCCE Supabase Auth settings.';
  if (/email rate limit|too many requests/i.test(message)) return 'Too many email requests. Wait a little before trying again.';
  return message;
}

export default function OfficeAccountControl() {
  const config = useMemo(() => resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment), []);
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!client);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceDescription, setWorkspaceDescription] = useState('');
  const [workspaces, setWorkspaces] = useState<OfficeWorkspace[]>([]);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsWorkspace, setNeedsWorkspace] = useState(false);
  const eventVersion = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const closePanel = useCallback(() => {
    setOpen(false);
    setPassword('');
    setConfirmPassword('');
    setError('');
    setNotice('');
  }, []);

  const loadWorkspaces = useCallback(async () => {
    if (!client) return;
    try {
      const rows = await officeTeamApi.listWorkspaces(client);
      setWorkspaces(Array.isArray(rows) ? rows : []);
      setNeedsWorkspace(Array.isArray(rows) && rows.length === 0);
    } catch {
      // Auth remains usable even when the optional Office collaboration schema is not enabled.
      setWorkspaces([]);
      setNeedsWorkspace(false);
    }
  }, [client]);

  useEffect(() => {
    if (!client) return undefined;
    let alive = true;
    const { data: subscription } = client.auth.onAuthStateChange((event, session) => {
      eventVersion.current += 1;
      if (event === 'PASSWORD_RECOVERY') { setMode('recovery'); setOpen(true); setNotice('Choose a new password for your COCCE account.'); }
      const nextUser = session?.user ?? null;
      setUser(nextUser);
      setPassword('');
      setConfirmPassword('');
      setAuthReady(true);
      if (nextUser) window.setTimeout(() => { if (alive) void loadWorkspaces(); }, 0);
      else { setWorkspaces([]); setNeedsWorkspace(false); }
    });
    const startingVersion = eventVersion.current;
    const restoreSession = async () => {
      try {
        const { data, error: sessionError } = await client.auth.getSession();
        if (sessionError) throw sessionError;
        if (!alive || eventVersion.current !== startingVersion) return;
        if (!data.session) { setUser(null); setAuthReady(true); return; }
        const { data: verified, error: userError } = await client.auth.getUser();
        if (!alive || eventVersion.current !== startingVersion) return;
        if (userError) throw userError;
        setUser(verified.user);
        setAuthReady(true);
        if (verified.user) void loadWorkspaces();
      } catch (cause) {
        if (alive && eventVersion.current === startingVersion) {
          setError(friendlyError(cause)); setUser(null); setAuthReady(true);
        }
      }
    };
    void restoreSession();
    return () => { alive = false; subscription.subscription.unsubscribe(); };
  }, [client, loadWorkspaces]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') closePanel(); };
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) closePanel();
    };
    window.addEventListener('keydown', closeOnEscape);
    window.addEventListener('pointerdown', closeOutside);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('pointerdown', closeOutside);
    };
  }, [closePanel, open]);

  const switchMode = (next: AuthMode) => { setMode(next); setError(''); setNotice(''); setPassword(''); setConfirmPassword(''); };

  const signIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { data, error: authError } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (authError) throw authError;
      if (!data.user) throw new Error('COCCE Auth did not return an account for this sign-in.');
      setUser(data.user); setPassword(''); setNotice('You are signed in. Preparing your workspace…');
      await loadWorkspaces();
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setBusy(false); }
  };

  const signUp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    if (password.length < 8) { setError('Choose a password with at least 8 characters.'); return; }
    if (password !== confirmPassword) { setError('Your passwords do not match.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const { data, error: authError } = await client.auth.signUp({
        email: email.trim(),
        password,
        options: {
          emailRedirectTo: window.location.origin,
          data: { display_name: displayName.trim() },
        },
      });
      if (authError) throw authError;
      setPassword(''); setConfirmPassword('');
      if (data.session && data.user) {
        setUser(data.user); setMode('signin'); setNotice('Your COCCE account has been created. Let’s set up your first workspace.');
        await loadWorkspaces();
      } else {
        setMode('signin');
        setNotice('Account request received. Check your email and confirm your address, then return here to sign in. If no email arrives, check spam or contact the COCCE administrator.');
      }
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setBusy(false); }
  };

  const sendRecovery = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { error: resetError } = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
      if (resetError) throw resetError;
      setNotice('If an account exists for that email, a password-reset link has been sent.');
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setBusy(false); }
  };

  const updateRecoveredPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    if (password.length < 8 || password !== confirmPassword) { setError(password.length < 8 ? 'Use at least 8 characters.' : 'Your passwords do not match.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const { error: updateError } = await client.auth.updateUser({ password });
      if (updateError) throw updateError;
      setPassword(''); setConfirmPassword(''); setMode('signin'); setNotice('Your password has been updated. You can continue using COCCE Office.');
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setBusy(false); }
  };

  const signInWithGoogle = async () => {
    if (!client) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const officeOrigin = window.location.hostname === 'localhost' || window.location.hostname.endsWith('.vercel.app') && window.location.hostname !== 'cocce-office.vercel.app'
        ? window.location.origin
        : 'https://cocce-office.vercel.app';
      const officeCallback = new URL('/', officeOrigin);
      officeCallback.searchParams.set('cocce_office_oauth', '1');
      const { error: oauthError } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: officeCallback.toString(), queryParams: { prompt: 'select_account' } },
      });
      if (oauthError) throw oauthError;
    } catch (cause) { setError(friendlyError(cause)); setBusy(false); }
  };

  const createFirstWorkspace = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client || !user) return;
    if (workspaceName.trim().length < 2) { setError('Enter an organisation or workspace name.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const id = await officeTeamApi.createWorkspace(client, workspaceName.trim(), workspaceDescription.trim());
      await loadWorkspaces();
      setNeedsWorkspace(false);
      setNotice('Your organisation workspace is ready. You are its owner. Open Team & collaboration to manage members and invitations.');
      window.dispatchEvent(new CustomEvent('cocce-office:workspace-created', { detail: { workspaceId: id, name: workspaceName.trim() } }));
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setBusy(false); }
  };

  const signOut = async () => {
    if (!client) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
      if (signOutError) throw signOutError;
      setUser(null); setWorkspaces([]); setNeedsWorkspace(false); setPassword('');
      setNotice('Signed out of Office on this browser. Other COCCE app sessions are unchanged.');
    } catch (cause) { setError(friendlyError(cause)); }
    finally { setBusy(false); }
  };

  const label = !client ? 'Auth unavailable' : !authReady ? 'Checking account' : user ? 'My account' : 'Sign in';
  const formTitle = mode === 'signup' ? 'Create your account' : mode === 'forgot' ? 'Reset your password' : mode === 'recovery' ? 'Choose a new password' : 'Welcome back';
  return <div className="office-account-control" ref={rootRef}>
    <button className={`office-account-trigger ${user ? 'is-signed-in' : ''}`} type="button" aria-label={user ? `Account: ${user.email ?? 'signed in'}` : 'Sign in to COCCE Office'} aria-expanded={open} aria-controls="office-account-popover" onClick={() => { if (open) closePanel(); else setOpen(true); }}>
      {user ? <ShieldCheck size={16} /> : <UserRound size={16} />}<span>{label}</span>
    </button>
    {open && <div className="office-auth-scrim">
      <section className="office-account-popover office-auth-panel" id="office-account-popover" aria-label="COCCE account">
        <div className="office-auth-brand"><span className="office-auth-symbol"><img src="/brand/cocce-office-squircle-icon-256.png" alt="" /></span><span><b>COCCE OFFICE</b><small>One workspace for the way you work.</small></span><button className="office-auth-close" type="button" aria-label="Close account panel" onClick={closePanel}><X size={18}/></button></div>
        <div className="office-auth-content">
          <span className="office-auth-eyebrow">{user ? 'ACCOUNT & WORKSPACE' : 'YOUR WORKSPACE STARTS HERE'}</span>
          <h2>{user ? (needsWorkspace ? 'Set up your organisation' : 'Your account') : formTitle}</h2>
          <p className="office-auth-intro">{user ? (needsWorkspace ? 'Create your first organisation workspace. You will become its owner and can invite your team.' : 'Your COCCE identity is connected to this Office session.') : mode === 'signup' ? 'Create one COCCE account to access your organisation and Office tools.' : mode === 'forgot' ? 'We’ll send a secure reset link if this email belongs to an account.' : mode === 'recovery' ? 'Use a new password you have not used before.' : 'Sign in with your COCCE account to continue.'}</p>
          {error && <p className="office-account-message is-error" role="alert"><CircleAlert size={15}/>{error}</p>}
          {notice && <p className="office-account-message" role="status"><CheckCircle2 size={15}/>{notice}</p>}
          {!client ? <div className="office-auth-config-error"><LockKeyhole size={18}/><p>COCCE Auth is not configured in this deployment. Check the public COCCE Supabase URL and key; no other project will be used.</p></div>
            : !authReady ? <p className="office-account-copy"><LoaderCircle className="office-account-spinner" size={16}/> Checking your secure session…</p>
            : user && needsWorkspace ? <form className="office-auth-form" onSubmit={createFirstWorkspace}>
                <label>Organisation or workspace name<input value={workspaceName} onChange={e=>setWorkspaceName(e.target.value)} placeholder="e.g. Acme Tanzania" minLength={2} maxLength={80} required disabled={busy}/></label>
                <label>What does your team do? <span className="office-auth-optional">Optional</span><textarea value={workspaceDescription} onChange={e=>setWorkspaceDescription(e.target.value)} placeholder="A short description of your organisation" maxLength={240} disabled={busy}/></label>
                <button className="office-auth-submit" type="submit" disabled={busy}>{busy ? <LoaderCircle className="office-account-spinner" size={17}/> : <Building2 size={17}/>}Create organisation <ArrowRight size={16}/></button>
              </form>
            : user ? <div className="office-auth-account">
                <span className="office-auth-user-icon"><UserRound size={21}/></span><div><strong>{user.user_metadata?.display_name || user.email || 'COCCE account'}</strong><small>{user.email}</small></div>
                <div className="office-auth-workspaces"><b>Your workspaces</b>{workspaces.length ? workspaces.map(space=><span key={space.workspace_id}><Building2 size={14}/>{space.name}<small>{space.role}</small></span>) : <small>No workspace membership found yet.</small>}</div>
                <button className="office-auth-submit" type="button" onClick={()=>{closePanel();window.dispatchEvent(new CustomEvent('cocce-office:navigate',{detail:{page:'team'}}));}}>Open team workspace <ArrowRight size={16}/></button>
                <button className="office-auth-signout" type="button" disabled={busy} onClick={()=>void signOut()}><LogOut size={15}/>{busy?'Signing out…':'Sign out'}</button>
              </div>
            : <form className="office-auth-form" onSubmit={mode === 'signup' ? signUp : mode === 'forgot' ? sendRecovery : mode === 'recovery' ? updateRecoveredPassword : signIn}>
                {mode === 'signup' && <label>Full name<input autoComplete="name" value={displayName} onChange={e=>setDisplayName(e.target.value)} placeholder="Your name" maxLength={80} required disabled={busy}/></label>}
                <label>Email address<span className="office-auth-input-wrap"><Mail size={16}/><input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" required disabled={busy}/></span></label>
                {mode !== 'forgot' && <label>Password<span className="office-auth-input-wrap"><LockKeyhole size={16}/><input type={showPassword?'text':'password'} autoComplete={mode==='signup'?'new-password':'current-password'} value={password} onChange={e=>setPassword(e.target.value)} placeholder={mode==='signup'?'At least 8 characters':'Enter your password'} minLength={8} required disabled={busy}/><button className="office-auth-eye" type="button" aria-label={showPassword?'Hide password':'Show password'} onClick={()=>setShowPassword(v=>!v)}>{showPassword?<EyeOff size={16}/>:<Eye size={16}/>}</button></span></label>}
                {(mode === 'signup' || mode === 'recovery') && <label>Confirm password<input type={showPassword?'text':'password'} autoComplete="new-password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)} minLength={8} required disabled={busy}/></label>}
                {mode === 'signin' && <button className="office-auth-text-link" type="button" onClick={()=>switchMode('forgot')}>Forgot password?</button>}
                <button className="office-auth-submit" type="submit" disabled={busy}>{busy?<LoaderCircle className="office-account-spinner" size={17}/>:mode==='signup'?<UserRound size={17}/>:mode==='forgot'?<Mail size={17}/>:mode==='recovery'?<ShieldCheck size={17}/>:<LogIn size={17}/>} {busy?'Please wait…':mode==='signup'?'Create COCCE account':mode==='forgot'?'Send reset link':mode==='recovery'?'Update password':'Sign in'} <ArrowRight size={16}/></button>
              </form>}
          {!user && client && authReady && mode !== 'forgot' && mode !== 'recovery' && <>
            <div className="office-auth-divider"><span>OR CONTINUE WITH</span></div>
            <button className="office-auth-google" type="button" disabled={busy} onClick={()=>void signInWithGoogle()}><span className="office-google-mark">G</span>Continue with Google</button>
            <p className="office-auth-switch">{mode==='signup'?'Already have a COCCE account?':'New to COCCE Office?'} <button type="button" onClick={()=>switchMode(mode==='signup'?'signin':'signup')}>{mode==='signup'?'Sign in':'Create account'}</button></p>
          </>}
          {mode === 'forgot' && <p className="office-auth-switch"><button type="button" onClick={()=>switchMode('signin')}>Back to sign in</button></p>}
          <p className="office-auth-legal"><ShieldCheck size={13}/> Secure authentication through your existing COCCE account service. Your password is never stored by Office.</p>
        </div>
      </section>
    </div>}
  </div>;
}
