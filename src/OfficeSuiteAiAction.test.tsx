// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import OfficeSuiteAiAction from './OfficeSuiteAiAction';

it('opens COCCE AI with the active workspace and current suite tab context', () => {
  const received: CustomEvent[] = [];
  const listener = (event: Event) => received.push(event as CustomEvent);
  window.addEventListener('cocce-office:navigate', listener);
  render(<OfficeSuiteAiAction workspaceId="workspace-123" suiteLabel="Accounting" tabLabel="Bank reconciliation" />);
  fireEvent.click(screen.getByRole('button', { name: /Ask COCCE AI about Accounting, Bank reconciliation/i }));
  fireEvent.click(screen.getByRole('menuitem', { name: /Summarise this tab/i }));

  expect(received).toHaveLength(1);
  expect(received[0].detail.page).toBe('ai');
  expect(received[0].detail.workspaceId).toBe('workspace-123');
  expect(received[0].detail.prompt).toContain('Accounting Office suite');
  expect(received[0].detail.prompt).toContain('Bank reconciliation tab');
  expect(received[0].detail.prompt).toContain('Summarise the authorised information relevant to this tab');
  window.removeEventListener('cocce-office:navigate', listener);
});
