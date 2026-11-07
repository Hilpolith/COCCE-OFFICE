// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import UniversityManagementWorkspace from './UniversityManagementWorkspace';
import { FrostedConfirmProvider } from './FrostedConfirm';

const { read, command, getUser } = vi.hoisted(() => ({ read: vi.fn(), command: vi.fn(), getUser: vi.fn() }));
vi.mock('./lib/officeUniversityManagement', () => ({
  officeUniversityManagementApi: { read, command },
  createUniversityKeyConfig: vi.fn(), unlockUniversityKey: vi.fn(), encryptUniversityPrivatePerson: vi.fn(), decryptUniversityPrivatePerson: vi.fn(),
}));
vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({ status: 'ready' }),
  getOfficeTeamClient: () => ({ auth: { getUser } }),
}));
vi.mock('./lib/officeTeamApi', () => ({ officeTeamApi: { listWorkspaces: vi.fn() } }));
vi.mock('./lib/officeIndustryTasks', () => ({ officeIndustryTasksApi: { getSpace: vi.fn(), registerSpace: vi.fn() } }));

import { officeTeamApi } from './lib/officeTeamApi';
import { officeIndustryTasksApi } from './lib/officeIndustryTasks';

const baseProps = { workspaceId: 'ws-1', officeName: 'Synthetic University', country: 'Tanzania', accent: '#77a9ff' };
const bootstrap = (role = 'university_admin') => ({ role, terms: [{ term_id: 'term-1', label: '2026 Semester 1' }], programmes: [{ programme_id: 'prog-1', code: 'BSC-CS', name: 'Computer Science' }], courses: [{ course_id: 'course-1', code: 'CS101', name: 'Foundations' }] });

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } });
  (officeTeamApi.listWorkspaces as ReturnType<typeof vi.fn>).mockResolvedValue([{ workspace_id: 'ws-1' }]);
  (officeIndustryTasksApi.getSpace as ReturnType<typeof vi.fn>).mockResolvedValue({ industry_id: 'university' });
  read.mockImplementation(async (_client: unknown, _workspace: string, resource: string) => resource === 'bootstrap' ? bootstrap() : resource === 'key_config' ? { configured: false } : []);
  command.mockResolvedValue({ entity_id: 'new-1', version: 1 });
});
afterEach(() => cleanup());

describe('University Management workflows', () => {
  it('shows only role-authorized tabs and loaded bootstrap records', async () => {
    read.mockImplementation(async (_client: unknown, _workspace: string, resource: string) => resource === 'bootstrap' ? bootstrap('lecturer') : []);
    render(<UniversityManagementWorkspace {...baseProps} />);
    expect(await screen.findByRole('heading', { name: 'University Management' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Academics' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Students & results' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Admissions' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Finance & funding' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Academics' }));
    expect(await screen.findByText('2026 Semester 1')).toBeTruthy();
  });

  it('submits an academic form with idempotency and clears it only after success', async () => {
    render(<UniversityManagementWorkspace {...baseProps} />);
    await screen.findByRole('heading', { name: 'University Management' });
    fireEvent.click(screen.getByRole('tab', { name: 'Academics' }));
    const code = screen.getAllByLabelText('code')[1];
    fireEvent.change(screen.getAllByLabelText('course id')[0], { target: { value: 'course-new' } });
    fireEvent.change(code, { target: { value: 'NEW-101' } });
    fireEvent.change(screen.getAllByLabelText('name')[1], { target: { value: 'New Course' } });
    fireEvent.change(screen.getByLabelText('credits'), { target: { value: '10' } });
    fireEvent.change(screen.getAllByLabelText('status')[1], { target: { value: 'active' } });
    fireEvent.submit(code.closest('form')!);
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), 'ws-1', 'save_course', expect.objectContaining({ code: 'NEW-101', idempotency_key: expect.any(String) })));
    await waitFor(() => expect((code as HTMLInputElement).value).toBe(''));
  });

  it('retains entered values when a command fails', async () => {
    command.mockRejectedValueOnce(new Error('permission denied for university command'));
    render(<UniversityManagementWorkspace {...baseProps} />);
    await screen.findByRole('heading', { name: 'University Management' });
    fireEvent.click(screen.getByRole('tab', { name: 'Academics' }));
    const code = screen.getAllByLabelText('code')[1];
    fireEvent.change(screen.getAllByLabelText('course id')[0], { target: { value: 'course-keep' } });
    fireEvent.change(code, { target: { value: 'KEEP-101' } });
    fireEvent.change(screen.getAllByLabelText('name')[1], { target: { value: 'Keep this draft' } });
    fireEvent.change(screen.getByLabelText('credits'), { target: { value: '5' } });
    fireEvent.change(screen.getAllByLabelText('status')[1], { target: { value: 'active' } });
    fireEvent.submit(code.closest('form')!);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/does not allow/i));
    expect((code as HTMLInputElement).value).toBe('KEEP-101');
  });

  it('loads additional records without replacing the first page', async () => {
    let calls = 0;
    read.mockImplementation(async (_client: unknown, _workspace: string, resource: string) => {
      if (resource === 'bootstrap') return bootstrap();
      if (resource === 'key_config') return { configured: false };
      if (resource === 'terms') { calls += 1; return calls === 1 ? [{ term_id: 't-1', label: 'First page' }] : [{ term_id: 't-2', label: 'Second page' }]; }
      return [];
    });
    render(<UniversityManagementWorkspace {...baseProps} />);
    await screen.findByRole('heading', { name: 'University Management' });
    fireEvent.click(screen.getByRole('tab', { name: 'Academics' }));
    expect(await screen.findByText('2026 Semester 1')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Load more' })[0]);
    expect(await screen.findByText('First page')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: 'Load more' })[0]);
    expect(await screen.findByText('Second page')).toBeTruthy();
    expect(screen.getByText('First page')).toBeTruthy();
  });

  it('requires confirmation before locking an assessment', async () => {
    read.mockImplementation(async (_client: unknown, _workspace: string, resource: string) => resource === 'bootstrap' ? bootstrap('lecturer') : resource === 'assessments' ? [{ assessment_id: 'a-1', title: 'Midterm', status: 'draft', version: 2 }] : []);
    render(<FrostedConfirmProvider><UniversityManagementWorkspace {...baseProps} /></FrostedConfirmProvider>);
    await screen.findByRole('heading', { name: 'University Management' });
    fireEvent.click(screen.getByRole('tab', { name: 'Students & results' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lock' }));
    expect(await screen.findByRole('alertdialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lock results' }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), 'ws-1', 'set_assessment_status', expect.objectContaining({ assessment_id: 'a-1', status: 'locked', expected_version: 2 })));
  });
});
