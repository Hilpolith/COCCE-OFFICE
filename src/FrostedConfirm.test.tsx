// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FrostedConfirmProvider, useFrostedConfirm } from './FrostedConfirm';

function Trigger({ onResult }: { onResult: (value: boolean) => void }) {
  const confirm = useFrostedConfirm();
  return <button type="button" onClick={() => void confirm({
    title: 'Delete local item?',
    description: 'This cannot be undone.',
    confirmLabel: 'Yes, delete',
    cancelLabel: 'Keep it',
    destructive: true,
  }).then(onResult)}>Open confirmation</button>;
}

afterEach(() => cleanup());

describe('FrostedConfirmProvider', () => {
  it('resolves confirm and returns focus to the trigger', async () => {
    const result = vi.fn();
    render(<FrostedConfirmProvider><Trigger onResult={result} /></FrostedConfirmProvider>);
    const trigger = screen.getByRole('button', { name: 'Open confirmation' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Delete local item?' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    await vi.waitFor(() => expect(result).toHaveBeenCalledWith(true));
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('resolves cancel and Escape as false without invoking native confirm', async () => {
    const result = vi.fn();
    const native = vi.fn();
    Object.defineProperty(window, 'confirm', { configurable: true, value: native });
    render(<FrostedConfirmProvider><Trigger onResult={result} /></FrostedConfirmProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open confirmation' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    await vi.waitFor(() => expect(result).toHaveBeenCalledWith(false));
    expect(native).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Open confirmation' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    await vi.waitFor(() => expect(result).toHaveBeenCalledTimes(2));
    expect(result).toHaveBeenLastCalledWith(false);
    Reflect.deleteProperty(window, 'confirm');
  });
});
