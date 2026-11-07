import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './frostedConfirm.css';

type Props = { label: string; value: string; busy: boolean; onChange: (value: string) => void; onCancel: () => void; onConfirm: () => Promise<boolean> };
export default function BusinessReasonDialog({ label, value, busy, onChange, onCancel, onConfirm }: Props) {
  const id = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const alive = useRef(true);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    input.current?.focus();
    return () => {
      alive.current = false;
      document.body.style.overflow = overflow;
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<div className="frosted-confirm-backdrop">
    <div ref={dialog} className="frosted-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
      if (event.key === 'Tab') {
        const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('textarea,button:not([disabled])') ?? []);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <div className="frosted-confirm-kicker">Business workflow</div>
      <h2 id={`${id}-title`}>{label}</h2>
      <p id={`${id}-description`}>Enter the operational reason. It will be recorded with this action; do not include private contact information.</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!value.trim() || busy || submitting.current) return;
        submitting.current = true; setPending(true); setNotice('');
        void (async () => {
          try { const completed = await onConfirm(); if (!completed && alive.current) setNotice('The action was not confirmed. Close this dialog to review the office notice before retrying.'); }
          catch (error) { if (alive.current) setNotice(error instanceof Error ? error.message : 'Unable to confirm this action.'); }
          finally { submitting.current = false; if (alive.current) setPending(false); }
        })();
      }}>
        <label className="business-reason-label" htmlFor={`${id}-reason`}>Reason</label>
        <textarea ref={input} id={`${id}-reason`} className="business-reason-input" value={value} onChange={(event) => onChange(event.target.value)} required maxLength={2000} rows={4} disabled={pending} />
        {notice && <p role="alert">{notice}</p>}
        <div className="frosted-confirm-actions">
          <button type="button" className="frosted-confirm-cancel" onClick={onCancel}>Keep editing</button>
          <button type="submit" className="frosted-confirm-accept" disabled={!value.trim() || busy || pending}>{pending ? 'Confirming…' : 'Confirm'}</button>
        </div>
      </form>
    </div>
  </div>, document.body);
}
