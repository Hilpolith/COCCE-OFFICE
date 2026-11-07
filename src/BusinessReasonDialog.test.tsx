// @vitest-environment happy-dom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BusinessReasonDialog from './BusinessReasonDialog';
afterEach(cleanup);
function Harness({ confirm, initial = '', busy = false }: { confirm: () => Promise<boolean>; initial?: string; busy?: boolean }) {
  const [open, setOpen] = useState(false); const [value, setValue] = useState(initial);
  return <><button type="button" onClick={() => setOpen(true)}>Open reason</button>{open && <BusinessReasonDialog label="Resolve case" value={value} busy={busy} onChange={setValue} onCancel={() => setOpen(false)} onConfirm={confirm}/>}</>;
}
describe('Business frosted reason dialog', () => {
  it('focuses the required reason and refuses blank confirmations', async () => {
    const confirm = vi.fn().mockResolvedValue(true);
    render(<Harness confirm={confirm}/>); fireEvent.click(screen.getByText('Open reason'));
    expect(screen.getByRole('dialog', { name: 'Resolve case' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Reason'));
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Service restored.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
  });
  it('retains text and explains an unconfirmed result without pretending success', async () => {
    render(<Harness confirm={vi.fn().mockResolvedValue(false)} initial="Keep this reason"/>);
    fireEvent.click(screen.getByText('Open reason')); fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect((await screen.findByRole('alert')).textContent).toContain('not confirmed');
    expect((screen.getByLabelText('Reason') as HTMLTextAreaElement).value).toBe('Keep this reason');
  });
  it('closes on Escape and restores the previously focused control', () => {
    render(<Harness confirm={vi.fn().mockResolvedValue(true)}/>);
    const trigger = screen.getByText('Open reason'); trigger.focus(); fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByLabelText('Reason'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull(); expect(document.activeElement).toBe(trigger);
  });
  it('traps keyboard focus within its active controls', () => {
    render(<Harness confirm={vi.fn().mockResolvedValue(true)} initial="A valid reason"/>);
    fireEvent.click(screen.getByText('Open reason'));
    fireEvent.keyDown(screen.getByLabelText('Reason'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Confirm' }));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Confirm' }), { key: 'Tab' });
    expect(document.activeElement).toBe(screen.getByLabelText('Reason'));
  });
  it('allows closing an uncertain pending workflow to reach the root retry controls', () => {
    const confirm = vi.fn().mockResolvedValue(true);
    render(<Harness confirm={confirm} initial="A valid reason" busy/>);
    fireEvent.click(screen.getByText('Open reason'));
    expect((screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('dialog')).toBeNull(); expect(confirm).not.toHaveBeenCalled();
  });
});
