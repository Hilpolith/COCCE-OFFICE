import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { User } from '@supabase/supabase-js';
import { CircleAlert, LoaderCircle, LogIn, LogOut, ShieldCheck, UserRound, X } from 'lucide-react';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import './officeAccount.css';

function friendlyError(error: unknown) {
  return error instanceof Error ? error.message : 'COCCE Auth could not complete that request.';
}

export default function OfficeAccountControl() {
  const config = resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment);
  const client = getOfficeTeamClient(config);
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!client);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const eventVersion = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const closePanel = useCallback(() => {
    setOpen(false);
    setPassword('');
    setError('');
    setNotice('');
  }, []);

  useEffect(() => {
    if (!client) return undefined;
    let alive = true;
    const { data: subscription } = client.auth.onAuthStateChange((_event, session) => {
      eventVersion.current += 1;
      setUser(session?.user ?? null);
      setPassword('');
      setError('');
      setNotice('');
      setAuthReady(true);
    });
    const startingVersion = eventVersion.current;
    const restoreSession = async () => {
      try {
        const { data, error: sessionError } = await client.auth.getSession();
        if (sessionError) throw sessionError;
        if (!alive || eventVersion.current !== startingVersion) return;
        if (!data.session) {
          setUser(null);
          setAuthReady(true);
          return;
        }
        const { data: verified, error: userError } = await client.auth.getUser();
        if (!alive || eventVersion.current !== startingVersion) return;
        if (userError) throw userError;
        setUser(verified.user);
        setAuthReady(true);
      } catch (cause) {
        if (alive && eventVersion.current === startingVersion) {
          setError(friendlyError(cause));
          setUser(null);
          setAuthReady(true);
        }
      }
    };
    void restoreSession();
    return () => {
      alive = false;
      subscription.subscription.unsubscribe();
    };
  }, [client]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closePanel();
    };
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

  const signInWithPassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!client) return;
    const normalizedEmail = email.trim();
    if (!normalizedEmail || !password) {
      setError('Enter the email and password for an existing COCCE account.');
      return;
    }
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data, error: signInError } = await client.auth.signInWithPassword({ email: normalizedEmail, password });
      if (signInError) throw signInError;
      if (!data.user) throw new Error('COCCE Auth did not return an account for this sign-in.');
      setUser(data.user);
      setPassword('');
      setNotice('Signed in with your existing COCCE account in this Office browser.');
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  };

  const signInWithGoogle = async () => {
    if (!client) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { error: oauthError } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      });
      if (oauthError) throw oauthError;
    } catch (cause) {
      setError(friendlyError(cause));
      setBusy(false);
    }
  };

  const signOut = async () => {
    if (!client) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { error: signOutError } = await client.auth.signOut({ scope: 'local' });
      if (signOutError) throw signOutError;
      setUser(null);
      setPassword('');
      setNotice('Signed out of Office in this browser. Other COCCE app sessions are unchanged.');
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setBusy(false);
    }
  };

  const label = !client ? 'Auth unavailable' : !authReady ? 'Checking account' : user ? 'Account' : 'Sign in';
  return <div className="office-account-control" ref={rootRef}>
    <button
      className={`office-account-trigger ${user ? 'is-signed-in' : ''}`}
      type="button"
      aria-label={user ? `Account: ${user.email ?? 'signed in'}` : 'Sign in to COCCE Office'}
      aria-expanded={open}
      aria-controls="office-account-popover"
      onClick={() => { if (open) closePanel(); else setOpen(true); }}
    >
      {user ? <ShieldCheck size={16} /> : <UserRound size={16} />}
      <span>{label}</span>
    </button>
    {open && <section className="office-account-popover glass-popover" id="office-account-popover" aria-label="COCCE account">
      <div className="office-account-heading">
        <div><span className="eyebrow">COCCE ACCOUNT</span><h2>{user ? 'Your Office session' : 'Sign in to Office'}</h2></div>
        <button className="icon-button" type="button" aria-label="Close account panel" onClick={closePanel}><X size={16} /></button>
      </div>
      {error && <p className="office-account-message is-error" role="alert"><CircleAlert size={15} />{error}</p>}
      {notice && <p className="office-account-message" role="status"><ShieldCheck size={15} />{notice}</p>}
      {!client ? <p className="office-account-copy" role="status">COCCE Auth is not configured in this environment. Office has not connected to another project.</p>
        : !authReady ? <p className="office-account-copy" role="status"><LoaderCircle className="office-account-spinner" size={16} /> Checking this browser’s COCCE Auth session…</p>
          : user ? <div className="office-account-session">
            <span className="office-account-avatar"><UserRound size={17} /></span>
            <div><strong>{user.email ?? 'COCCE account'}</strong><small>Existing COCCE account · Office-only browser session</small></div>
            <button className="office-account-action is-secondary" type="button" disabled={busy} onClick={() => { void signOut(); }}><LogOut size={15} />{busy ? 'Signing out…' : 'Sign out'}</button>
          </div>
            : <>
              <p className="office-account-copy">Use an existing COCCE Super App account. Office does not create accounts.</p>
              <form className="office-account-form" onSubmit={signInWithPassword}>
                <label>Email<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required disabled={busy} /></label>
                <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required disabled={busy} /></label>
                <button className="office-account-action is-primary" type="submit" disabled={busy}><LogIn size={15} />{busy ? 'Signing in…' : 'Sign in'}</button>
              </form>
              <div className="office-account-divider"><span>or</span></div>
              <button className="office-account-action is-google" type="button" disabled={busy} onClick={() => { void signInWithGoogle(); }}><span className="office-google-mark" aria-hidden="true">G</span>{busy ? 'Connecting…' : 'Continue with Google'}</button>
              <p className="office-account-footnote">Your existing COCCE Auth session is separate from other COCCE apps and does not change account settings.</p>
            </>}
    </section>}
  </div>;
}
