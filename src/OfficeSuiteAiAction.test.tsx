import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import OfficeSuiteAiAction from './OfficeSuiteAiAction';

afterEach(() => {
  window.removeEventListener('cocce-office:navigate', vi.fn());
});

it('opens COCCE AI with the active workspace and current suite tab context', () => {
  const received: CustomEvent[] = [];
  const listener = (event: Event) => received.push(event as CustomEvent);
  window.addEventListener('cocce-office:navigate', listener);
  render(<OfficeSuiteAiAction workspaceId="workspace-123" suiteLabel="Accounting" tabLabel="Bank reconciliation" />);
  fireEvent.click(screen.getByRole('button', { name: /Ask COCCE AI about Accounting, Bank reconciliation/i }));

  expect(received).toHaveLength(1);
  expect(received[0].detail.page).toBe('ai');
  expect(received[0].detail.workspaceId).toBe('workspace-123');
  expect(received[0].detail.prompt).toContain('Accounting Office suite');
  expect(received[0].detail.prompt).toContain('Bank reconciliation tab');
  window.removeEventListener('cocce-office:navigate', listener);
});
