// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TeamWorkspace from './TeamWorkspace';
import { LOCAL_TEAM_KEY } from './lib/teamStore';

function renderPlanner(workspaceId: string | null = 'workspace-a', query = '') {
  return render(<TeamWorkspace workspaceId={workspaceId} workspaceName={workspaceId ? 'Kijiji Studio' : 'Personal space'} query={query} />);
}

function addItem(type: string, name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'Add item' }));
  fireEvent.change(screen.getByLabelText('Type'), { target: { value: type } });
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } });
  fireEvent.click(screen.getByRole('button', { name: 'Save item' }));
}

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); window.localStorage.clear(); });

describe('local Team Planner UI', () => {
  it('creates real local structure and personal tasks and persists across remounts', async () => {
    const first = renderPlanner();
    addItem('department', 'Operations');
    expect(await screen.findByText('Operations')).toBeTruthy();
    addItem('project', 'Quarterly budget');
    expect(await screen.findAllByText('Quarterly budget')).toHaveLength(2);

    fireEvent.change(screen.getByLabelText('Task title'), { target: { value: 'Prepare budget' } });
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: screen.getByRole('option', { name: 'Quarterly budget' }).getAttribute('value') } });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: 'high' } });
    fireEvent.change(screen.getByLabelText('Due date'), { target: { value: '2026-12-05' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add personal task' }));
    expect(await screen.findByText('Prepare budget')).toBeTruthy();
    expect(screen.getByText(/Quarterly budget · Dec 5, 2026/)).toBeTruthy();
    expect(screen.getByText('high')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Status for Prepare budget'), { target: { value: 'done' } });
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(LOCAL_TEAM_KEY)!).tasks[0].status).toBe('done'));
    first.unmount();
    renderPlanner();
    fireEvent.change(screen.getByLabelText('Filter tasks'), { target: { value: 'all' } });
    expect(await screen.findByText('Prepare budget')).toBeTruthy();
    expect(await screen.findAllByText('Quarterly budget')).toHaveLength(2);
  });

  it('edits and archives a structure item, and allows archived items to be viewed or restored', async () => {
    renderPlanner();
    addItem('team', 'Design');
    fireEvent.click(screen.getByRole('button', { name: 'Edit Design' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Product design' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Product design')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Archive Product design' }));
    expect(await screen.findByText(/Item archived on this device/i)).toBeTruthy();
    expect(screen.queryByText('Product design')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Include archived' }));
    expect(await screen.findByText('Product design')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Product design' }));
    expect(await screen.findByText(/Item restored on this device/i)).toBeTruthy();
  });

  it('filters structure and tasks using the app-wide local search query', async () => {
    const { rerender } = renderPlanner();
    addItem('department', 'Operations');
    addItem('channel', 'Announcements');
    rerender(<TeamWorkspace workspaceId="workspace-a" workspaceName="Kijiji Studio" query="announce" />);
    expect(await screen.findByText('Announcements')).toBeTruthy();
    expect(screen.queryByText('Operations')).toBeNull();
    rerender(<TeamWorkspace workspaceId="workspace-a" workspaceName="Kijiji Studio" query="absent phrase" />);
    expect(await screen.findByText('No matching structure')).toBeTruthy();
  });

  it('keeps planner records isolated by active local workspace', async () => {
    const first = renderPlanner();
    addItem('department', 'Private operations');
    expect(await screen.findByText('Private operations')).toBeTruthy();
    first.unmount();
    renderPlanner('workspace-b');
    expect(await screen.findByText('Start with a simple outline')).toBeTruthy();
    expect(screen.queryByText('Private operations')).toBeNull();
  });

  it('reports a browser backup read failure without changing saved planner data', async () => {
    renderPlanner();
    addItem('department', 'Keep existing data');
    const file = new File(['{}'], 'unreadable.json', { type: 'application/json' });
    Object.defineProperty(file, 'text', { configurable: true, value: () => Promise.reject(new Error('permission denied')) });
    const input = screen.getByLabelText('Import Team Planner JSON backup');
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    fireEvent.change(input);
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read this backup file');
    expect(JSON.parse(window.localStorage.getItem(LOCAL_TEAM_KEY)!).items[0].name).toBe('Keep existing data');
  });

  it('announces local-storage write failures and keeps the planner unchanged', async () => {
    renderPlanner();
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Storage quota exceeded', 'QuotaExceededError'); });
    addItem('department', 'Not saved');
    expect((await screen.findByRole('alert')).textContent).toContain('Storage quota exceeded');
    expect(window.localStorage.getItem(LOCAL_TEAM_KEY)).toBeNull();
  });

  it('keeps collaboration fail-closed and separate from the local planner when COCCE Auth is unconfigured', () => {
    vi.stubEnv('VITE_COCCE_SUPABASE_URL', '');
    vi.stubEnv('VITE_COCCE_SUPABASE_ANON_KEY', '');
    vi.stubEnv('VITE_OFFICE_TEAM_SCHEMA_READY', 'false');
    renderPlanner();
    expect(screen.getByText(/COCCE Auth is not configured/i)).toBeTruthy();
    expect(screen.getByText(/local planning only/i)).toBeTruthy();
    expect(screen.getByText(/they are not linked to Office memberships or conversations in the separate collaboration panel/i)).toBeTruthy();
    expect(screen.getByText(/no Office RPCs run until the separate Office schema gate is approved/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /invite|message|send|assign to/i })).toBeNull();
  });
});
