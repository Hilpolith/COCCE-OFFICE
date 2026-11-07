import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import './frostedConfirm.css';

export type FrostedConfirmOptions = {
  title?: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  allowBackdropClose?: boolean;
};

type PendingConfirm = FrostedConfirmOptions & { resolve: (confirmed: boolean) => void };

const normalizeOptions = (options: FrostedConfirmOptions | string): FrostedConfirmOptions =>
  typeof options === 'string' ? { description: options } : options;

const nativeConfirm = (options: FrostedConfirmOptions | string): Promise<boolean> => {
  const normalized = normalizeOptions(options);
  return Promise.resolve(window.confirm(normalized.description));
};

const ConfirmContext = createContext<((options: FrostedConfirmOptions | string) => Promise<boolean>) | null>(null);

export function FrostedConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const confirm = useCallback((input: FrostedConfirmOptions | string) => {
    const options = normalizeOptions(input);
    triggerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return new Promise<boolean>((resolve) => setPending({ ...options, resolve }));
  }, []);

  const finish = useCallback((confirmed: boolean) => {
    if (!pending) return;
    const resolve = pending.resolve;
    setPending(null);
    resolve(confirmed);
    window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, [pending]);

  useEffect(() => {
    if (!pending) return;
    const dialog = dialogRef.current;
    const focusable = dialog?.querySelector<HTMLElement>('button:not([disabled])');
    focusable?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
      if (event.key === 'Tab' && dialog) {
        const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not([disabled])')];
        if (buttons.length < 2) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length];
        event.preventDefault();
        next?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [finish, pending]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {pending ? (
        <div
          className="frosted-confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && pending.allowBackdropClose !== false) finish(false);
          }}
        >
          <div
            ref={dialogRef}
            className={`frosted-confirm-dialog${pending.destructive ? ' is-destructive' : ''}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="frosted-confirm-title"
            aria-describedby="frosted-confirm-description"
          >
            <div className="frosted-confirm-kicker">Confirmation required</div>
            <h2 id="frosted-confirm-title">{pending.title ?? 'Please confirm'}</h2>
            <p id="frosted-confirm-description">{pending.description}</p>
            <div className="frosted-confirm-actions">
              <button type="button" className="frosted-confirm-cancel" onClick={() => finish(false)}>
                {pending.cancelLabel ?? 'Cancel'}
              </button>
              <button type="button" className="frosted-confirm-accept" onClick={() => finish(true)}>
                {pending.confirmLabel ?? 'Yes'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useFrostedConfirm() {
  const context = useContext(ConfirmContext);
  return context ?? nativeConfirm;
}
