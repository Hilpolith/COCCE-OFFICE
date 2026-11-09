import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AlertCircle, Check, ChevronLeft, ChevronRight, LoaderCircle, LockKeyhole, Sparkles, X } from 'lucide-react';
import {
  buildOfficeAiRequest,
  checkOfficeAiStatus,
  OfficeAiError,
  requestOfficeAi,
} from './lib/officeAi';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import './officeWorkbench.css';

export type OfficeAiEditPreview = {
  candidate: string | null;
  previewText: string;
  detail?: string;
  reason?: string;
};

type AuthStatus = 'loading' | 'signed-in' | 'signed-out' | 'misconfigured' | 'unverified';
type Availability = 'unknown' | 'checking' | 'available' | 'not-configured' | 'unavailable';

export function OfficeWorkbenchLayout({
  children,
  rail,
  className = '',
}: {
  children: ReactNode;
  rail: ReactNode;
  className?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const railId = `office-ai-rail-${useId()}`;
  return <div className={`office-workbench-layout ${collapsed ? 'is-collapsed' : ''} ${className}`.trim()}>
    <aside className="office-workbench-rail" aria-label="COCCE AI">
      <div className="office-workbench-rail-heading">
        <span className="office-workbench-rail-title"><span className="office-workbench-rail-icon"><Sparkles size={16} /></span><span>COCCE AI</span></span>
        <button type="button" className="office-workbench-collapse" aria-label={collapsed ? 'Expand COCCE AI' : 'Collapse COCCE AI'} aria-controls={railId} aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
          {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
        </button>
      </div>
      <div id={railId} className="office-workbench-rail-content" hidden={collapsed}>{rail}</div>
    </aside>
    <div className="office-workbench-editor">{children}</div>
  </div>;
}

export default function OfficeAiPromptWorkbench({
  area,
  description,
  targetId,
  targetLabel,
  currentValue,
  currentValueLabel,
  proposedValueLabel,
  promptPlaceholder,
  privacyNote,
  applyLabel,
  maxPromptChars = 900,
  liveActionVerified,
  buildPrompt,
  previewResult,
  onApply,
}: {
  area: 'sheets' | 'slides';
  description: string;
  targetId: string;
  targetLabel: string;
  currentValue: string;
  currentValueLabel: string;
  proposedValueLabel: string;
  promptPlaceholder: string;
  privacyNote: string;
  applyLabel: string;
  maxPromptChars?: number;
  /** Must remain false until a real synthetic response from the deployed free model is verified. */
  liveActionVerified: boolean;
  buildPrompt: (prompt: string) => string;
  previewResult: (output: string, currentValue: string) => OfficeAiEditPreview;
  onApply: (candidate: string, capturedTargetId: string) => boolean;
}) {
  const teamConfig = useMemo(() => resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment), []);
  const client = useMemo(() => getOfficeTeamClient(teamConfig), [teamConfig]);
  const [authStatus, setAuthStatus] = useState<AuthStatus>(liveActionVerified ? (client ? 'loading' : 'misconfigured') : 'unverified');
  const [availability, setAvailability] = useState<Availability>('unknown');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState('');
  const [resultTargetId, setResultTargetId] = useState('');
  const [resultBefore, setResultBefore] = useState('');
  const currentTargetRef = useRef({ targetId, currentValue });
  useEffect(() => {
    currentTargetRef.current = { targetId, currentValue };
  }, [targetId, currentValue]);

  useEffect(() => {
    if (!liveActionVerified || !client) return;

    let active = true;
    const refreshAvailability = async (accessToken: string | undefined) => {
      if (!active) return;
      if (!accessToken) {
        setAuthStatus('signed-out');
        setAvailability('unknown');
        return;
      }
      setAuthStatus('signed-in');
      setAvailability('checking');
      try {
        const configured = await checkOfficeAiStatus(accessToken);
        if (active) setAvailability(configured ? 'available' : 'not-configured');
      } catch {
        if (active) setAvailability('unavailable');
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
      setResult('');
      setResultTargetId('');
      setResultBefore('');
      if (session) window.setTimeout(() => { void refreshAvailability(session.access_token); }, 0);
    });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [client, liveActionVerified]);

  const canRun = liveActionVerified && authStatus === 'signed-in' && availability === 'available';
  const canEditPrompt = liveActionVerified && authStatus === 'signed-in' && !busy;
  const visibleResult = liveActionVerified ? result : '';
  const stalePreview = Boolean(visibleResult) && (resultTargetId !== targetId || resultBefore !== currentValue);
  const generatedPreview = visibleResult ? previewResult(visibleResult, resultBefore) : null;
  const authLabel = !liveActionVerified ? 'Verification pending'
    : authStatus === 'loading' ? 'Checking sign-in'
      : authStatus === 'signed-out' ? 'Sign-in required'
        : authStatus === 'misconfigured' ? 'Auth unavailable'
          : availability === 'available' ? 'Free AI configured'
            : availability === 'checking' ? 'Checking service'
              : availability === 'not-configured' ? 'AI not configured'
                : availability === 'unavailable' ? 'AI unavailable' : 'Service status unknown';

  const runPreview = async () => {
    if (!canRun || !client || !prompt.trim() || busy) return;
    const capturedTargetId = targetId;
    const capturedValue = currentValue;
    setError('');
    setNotice('');
    setResult('');
    setResultTargetId('');
    setResultBefore('');
    setBusy(true);
    setAvailability('checking');
    try {
      const { data, error: sessionError } = await client.auth.getSession();
      if (sessionError || !data.session?.access_token) {
        setAuthStatus('signed-out');
        setAvailability('unknown');
        setError('Sign in with an existing COCCE account before using cloud AI. No editor content was sent.');
        return;
      }
      const accessToken = data.session.access_token;
      const configured = await checkOfficeAiStatus(accessToken);
      if (!configured) {
        setAvailability('not-configured');
        setError('Cloud AI is not enabled on this deployment. No editor content was sent.');
        return;
      }
      if (currentTargetRef.current.targetId !== capturedTargetId || currentTargetRef.current.currentValue !== capturedValue) {
        setError('The active target changed before the request started. Nothing was sent; review the current target and try again.');
        return;
      }
      const request = buildOfficeAiRequest('draft', '', buildPrompt(prompt.trim()));
      const output = await requestOfficeAi(accessToken, request);
      if (currentTargetRef.current.targetId !== capturedTargetId || currentTargetRef.current.currentValue !== capturedValue) {
        setError('The active target changed while the response was being prepared. The response was discarded and nothing was applied.');
        return;
      }
      setAvailability('available');
      setResult(output);
      setResultTargetId(capturedTargetId);
      setResultBefore(capturedValue);
    } catch (requestError) {
      setAvailability(requestError instanceof OfficeAiError && requestError.code === 'AI_NOT_CONFIGURED' ? 'not-configured' : 'unavailable');
      setError(requestError instanceof Error ? requestError.message : 'The free AI request could not be completed. No editor content was changed.');
    } finally {
      setBusy(false);
    }
  };

  const discardPreview = () => {
    setResult('');
    setResultTargetId('');
    setResultBefore('');
    setError('');
    setNotice('AI preview discarded. No editor content was changed.');
  };

  const applyPreview = () => {
    if (!liveActionVerified || !generatedPreview?.candidate || stalePreview || resultTargetId !== targetId) return;
    const applied = onApply(generatedPreview.candidate, resultTargetId);
    if (!applied) {
      setError('The target changed or could not be saved. Nothing was applied; review the editor and try again.');
      return;
    }
    setResult('');
    setResultTargetId('');
    setResultBefore('');
    setError('');
    setNotice('Preview applied. Use the editor’s Undo command to reverse it.');
  };

  return <section className={`office-ai-prompt-panel office-ai-prompt-${area}`} aria-label={`${area === 'sheets' ? 'Sheets' : 'Slides'} AI prompt workbench`}>
    <div className="office-ai-prompt-heading">
      <span className="office-ai-icon"><Sparkles size={17} /></span>
      <div><strong>{area === 'sheets' ? 'Formula assistant' : 'Slide writing assistant'}</strong><small>{authLabel}</small></div>
    </div>
    <p className="office-ai-prompt-description">{description}</p>
    <p className="office-ai-prompt-privacy"><LockKeyhole size={14} /><span>{privacyNote}</span></p>

    {!liveActionVerified && <div className="office-ai-prompt-state" role="note"><AlertCircle size={15} /><span>The free-model response has not been verified for this deployment yet, so generation is disabled. No workbook, slide, or document content has been sent.</span></div>}
    {liveActionVerified && authStatus === 'signed-out' && <div className="office-ai-prompt-state" role="status"><AlertCircle size={15} /><span>Sign in with an existing COCCE account to use cloud AI. Editor content remains local.</span></div>}
    {liveActionVerified && authStatus === 'misconfigured' && <div className="office-ai-prompt-state" role="status"><AlertCircle size={15} /><span>The existing COCCE Auth connection is not configured here. No prompt was sent.</span></div>}
    {liveActionVerified && availability === 'not-configured' && <div className="office-ai-prompt-state" role="status"><AlertCircle size={15} /><span>Cloud AI is not enabled on this deployment. No prompt was sent.</span></div>}
    {liveActionVerified && availability === 'unavailable' && <div className="office-ai-prompt-state" role="status"><AlertCircle size={15} /><span>The fixed free model is unavailable or rate-limited. No paid model or provider fallback is used.</span></div>}

    <label className="office-ai-prompt-label" htmlFor={`office-ai-prompt-${area}`}>Prompt for {targetLabel}</label>
    <textarea id={`office-ai-prompt-${area}`} className="office-ai-prompt-input" value={prompt} maxLength={maxPromptChars} disabled={!canEditPrompt} onChange={(event) => setPrompt(event.target.value)} placeholder={promptPlaceholder} aria-describedby={`office-ai-prompt-help-${area}`} />
    <div id={`office-ai-prompt-help-${area}`} className="office-ai-prompt-help">{prompt.length.toLocaleString()} / {maxPromptChars.toLocaleString()} characters. Your request is sent only after you choose Preview.</div>
    <button type="button" className="office-ai-prompt-run" disabled={!canRun || !prompt.trim() || busy} onClick={() => { void runPreview(); }}><Sparkles size={15} /> Preview suggestion</button>

    {busy && <p className="office-ai-prompt-progress" role="status"><LoaderCircle className="office-ai-spinner" size={15} /> Preparing a preview…</p>}
    {error && <p className="office-ai-prompt-message office-ai-prompt-error" role="alert"><AlertCircle size={14} />{error}</p>}
    {notice && <p className="office-ai-prompt-message" role="status"><Check size={14} />{notice}</p>}

    {visibleResult && generatedPreview && <section className="office-ai-prompt-preview" aria-label="AI edit preview">
      <div className="office-ai-prompt-preview-title"><div><span className="eyebrow">REVIEW BEFORE APPLY</span><strong>Suggested change for {targetLabel}</strong></div><button type="button" className="office-ai-prompt-icon-button" aria-label="Discard AI preview" onClick={discardPreview}><X size={15} /></button></div>
      <div className={`office-ai-prompt-diff ${area === 'sheets' ? 'is-compact' : ''}`}>
        <div><span>{currentValueLabel}</span><pre>{resultBefore || 'Empty'}</pre></div>
        <div><span>{proposedValueLabel}</span><pre>{generatedPreview.previewText || 'Empty'}</pre></div>
      </div>
      {generatedPreview.detail && <p className="office-ai-prompt-detail">{generatedPreview.detail}</p>}
      {(generatedPreview.reason || stalePreview) && <p className="office-ai-prompt-reason" role="status">{stalePreview ? 'The target changed after this preview; it cannot be applied.' : generatedPreview.reason}</p>}
      <div className="office-ai-prompt-preview-actions">
        <button type="button" className="office-ai-prompt-secondary" onClick={discardPreview}>Discard</button>
        <button type="button" className="office-ai-prompt-run" disabled={!canRun || !generatedPreview.candidate || Boolean(generatedPreview.reason) || stalePreview || resultTargetId !== targetId} onClick={applyPreview}>{applyLabel}</button>
      </div>
      <small className="office-ai-prompt-undo-note">The editor’s local Undo restores the prior value.</small>
    </section>}
  </section>;
}
