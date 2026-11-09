// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import IndustrySuitesWorkspace from './IndustrySuitesWorkspace';
import {
  INDUSTRY_STORAGE_KEY, addIndustryWorkItem, createIndustryOffice, emptyIndustryState, linkIndustryTeam, writeIndustryState,
} from './lib/industryWorkspaces';

vi.mock('./GovernmentCorrespondenceWorkspace', () => ({
  default: ({ officeName }: { officeName: string }) => <div data-testid="government-correspondence-preview">Government correspondence for {officeName}</div>,
}));
vi.mock('./SchoolManagementWorkspace', () => ({
  default: ({ officeName }: { officeName: string }) => <div data-testid="school-management-preview">School Management for {officeName}</div>,
}));
vi.mock('./UniversityManagementWorkspace', () => ({
  default: ({ officeName }: { officeName: string }) => <div data-testid="university-management-preview">University Management for {officeName}</div>,
}));
vi.mock('./BusinessManagementWorkspace', () => ({
  default: ({ officeName }: { officeName: string }) => <div data-testid="business-management-preview">Business Management for {officeName}</div>,
}));
vi.mock('./HealthAdminManagementWorkspace', () => ({
  default: ({ officeName }: { officeName: string }) => <div data-testid="health-admin-management-preview">Health Administration for {officeName}</div>,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

beforeEach(() => window.localStorage.clear());

describe('industry office workbench', () => {
  it('opens a separate Government Correspondence module without importing local preview records', async () => {
    const office = createIndustryOffice(emptyIndustryState(), {
      industryId: 'government', name: 'Kijiji Council', country: 'Tanzania',
    }).office!;
    const localTask = addIndustryWorkItem({ version: 1, offices: [office] }, office.id, {
      title: 'Local government preview item', notes: 'Non-sensitive local example.',
    });
    const linked = linkIndustryTeam(localTask.state, office.id, 'government-server-team');
    writeIndustryState(window.localStorage, linked);
    render(<IndustrySuitesWorkspace preferredIndustryId="government" onCreateTeam={vi.fn()} />);

    const governmentModule = await screen.findByTestId('government-correspondence-preview');
    expect(governmentModule.textContent ?? '').toContain('Kijiji Council');
    expect(screen.getByRole('tab', { name: 'Correspondence' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Shared work items' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Local government preview item' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'This device preview' }));
    expect(await screen.findByRole('heading', { name: 'Local government preview item' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Shared team' }));
    expect(await screen.findByTestId('government-correspondence-preview')).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)!).offices[0].items[0].title)
      .toBe('Local government preview item');
  });

  it('opens the full School Management system as a separate Shared team module and preserves all local preview records', async () => {
    const office = createIndustryOffice(emptyIndustryState(), {
      industryId: 'school', name: 'Kijiji School', country: 'Tanzania',
    }).office!;
    const localWork = addIndustryWorkItem({ version: 1, offices: [office] }, office.id, {
      title: 'Local timetable mockup', notes: 'Synthetic local preview only.',
    });
    const linked = linkIndustryTeam(localWork.state, office.id, 'school-server-team');
    writeIndustryState(window.localStorage, linked);
    render(<IndustrySuitesWorkspace preferredIndustryId="school" onCreateTeam={vi.fn()} />);

    expect(await screen.findByTestId('school-management-preview')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'School Management' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('heading', { name: 'Local timetable mockup' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: 'This device preview' }));
    expect(await screen.findByRole('heading', { name: 'Local timetable mockup' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Shared team' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Shared work items' }));
    expect(await screen.findByText('Shared workbench is unavailable')).toBeTruthy();
    const persisted = JSON.parse(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)!);
    expect(persisted.offices[0].items[0].title).toBe('Local timetable mockup');
    expect(persisted.offices[0].teamWorkspaceId).toBe('school-server-team');
  });

  it('passes the existing Office Team ID when an office user chooses Open team', async () => {
    const office = createIndustryOffice(emptyIndustryState(), {
      industryId: 'school', name: 'Kijiji School', country: 'Tanzania',
    }).office!;
    const linked = linkIndustryTeam({ version: 1, offices: [office] }, office.id, 'server-team-id');
    writeIndustryState(window.localStorage, linked);
    const onCreateTeam = vi.fn();
    render(<IndustrySuitesWorkspace preferredIndustryId="school" onCreateTeam={onCreateTeam} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Open team' }));

    expect(onCreateTeam).toHaveBeenCalledWith({
      officeId: office.id,
      officeName: 'Kijiji School',
      industryId: 'school',
      teamWorkspaceId: 'server-team-id',
    });
  });

  it('opens linked industry offices in the shared workspace first and never copies their existing local tasks', async () => {
    const office = createIndustryOffice(emptyIndustryState(), {
      industryId: 'business', name: 'Kijiji Studio', country: 'Tanzania',
    }).office!;
    const localTask = addIndustryWorkItem({ version: 1, offices: [office] }, office.id, {
      title: 'Local-only item', notes: 'This old browser record stays here.',
    });
    const linked = linkIndustryTeam(localTask.state, office.id, 'server-team-id');
    writeIndustryState(window.localStorage, linked);
    render(<IndustrySuitesWorkspace preferredIndustryId="business" onCreateTeam={vi.fn()} />);

    expect(await screen.findByTestId('business-management-preview')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Business Management' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('heading', { name: 'Local-only item' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Shared work items' }));
    expect(await screen.findByText('Shared workbench is unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'This device preview' }));
    expect(await screen.findByRole('heading', { name: 'Local-only item' })).toBeTruthy();
    const persisted = JSON.parse(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)!);
    expect(persisted.offices[0].items[0].title).toBe('Local-only item');
    expect(persisted.offices[0].teamWorkspaceId).toBe('server-team-id');
  });

  it('opens University Management as the default shared module beside shared work items', async () => {
    const office = createIndustryOffice(emptyIndustryState(), {
      industryId: 'university', name: 'Synthetic University', country: 'Tanzania',
    }).office!;
    writeIndustryState(window.localStorage, linkIndustryTeam({ version: 1, offices: [office] }, office.id, 'university-team'));
    render(<IndustrySuitesWorkspace preferredIndustryId="university" onCreateTeam={vi.fn()} />);
    expect(await screen.findByTestId('university-management-preview')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'University Management' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Shared work items' })).toBeTruthy();
  });

  it('creates a sector edition, persists work stages locally, and hands team creation to Office collaboration', async () => {
    const onCreateTeam = vi.fn();
    render(<IndustrySuitesWorkspace preferredIndustryId="manufacturing" onCreateTeam={onCreateTeam} />);

    fireEvent.change(screen.getByLabelText('Office or organization name'), { target: { value: 'Kijiji Factory' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Manufacturing office' }));
    expect(onCreateTeam).toHaveBeenCalledWith(expect.objectContaining({ officeName: 'Kijiji Factory', industryId: 'manufacturing', teamWorkspaceId: null }));
    expect(await screen.findByRole('heading', { name: 'Connect Kijiji Factory to its shared workspace' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open device-local preview' }));
    expect(await screen.findByRole('heading', { name: 'Kijiji Factory' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Work item'), { target: { value: 'Review machine maintenance plan' } });
    fireEvent.change(screen.getByLabelText('Local work-order reference'), { target: { value: 'WO-LOCAL-01' } });
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Synthetic operational example only.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save locally' }));

    expect(await screen.findByRole('heading', { name: 'Review machine maintenance plan' })).toBeTruthy();
    expect(JSON.parse(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)!).offices[0].items[0]).toMatchObject({
      title: 'Review machine maintenance plan', stage: 'Planned', reference: 'WO-LOCAL-01',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Advance Review machine maintenance plan to next stage' }));
    await waitFor(() => expect(JSON.parse(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)!).offices[0].items[0].stage).toBe('In progress'));
    fireEvent.click(screen.getByText('Local stage history · 2'));
    expect(screen.getByText('Planned → In progress')).toBeTruthy();
    expect(screen.getByText(/not encrypted, shared with team members, or backed up/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create team' }));
    expect(onCreateTeam).toHaveBeenCalledWith(expect.objectContaining({ officeName: 'Kijiji Factory', industryId: 'manufacturing' }));
  });

  it('shows the healthcare-specific privacy boundary during office setup', () => {
    render(<IndustrySuitesWorkspace preferredIndustryId="healthcare-admin" onCreateTeam={vi.fn()} />);
    expect(screen.getByText(/administrative only: no patient names, diagnoses, clinical records, or prescriptions/i)).toBeTruthy();
  });

  it('opens Health Administration in a linked Team and keeps local preview records separate', async () => {
    const office = createIndustryOffice(emptyIndustryState(), {
      industryId: 'healthcare-admin', name: 'Synthetic District Facility', country: 'Tanzania',
    }).office!;
    const local = addIndustryWorkItem({ version: 1, offices: [office] }, office.id, {
      title: 'Old local-only checklist', notes: 'Synthetic local preview.',
    });
    writeIndustryState(window.localStorage, linkIndustryTeam(local.state, office.id, 'health-admin-server-team'));
    render(<IndustrySuitesWorkspace preferredIndustryId="healthcare-admin" onCreateTeam={vi.fn()} />);

    expect(await screen.findByTestId('health-admin-management-preview')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Health Administration' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Shared work items' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Old local-only checklist' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'This device preview' }));
    expect(await screen.findByRole('heading', { name: 'Old local-only checklist' })).toBeTruthy();
    const persisted = JSON.parse(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)!);
    expect(persisted.offices[0].items[0].title).toBe('Old local-only checklist');
  });

  it('keeps an unreadable local store intact and disables register edits', () => {
    const corrupt = '{not-json';
    window.localStorage.setItem(INDUSTRY_STORAGE_KEY, corrupt);
    render(<IndustrySuitesWorkspace preferredIndustryId="business" onCreateTeam={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toMatch(/existing bytes were preserved/i);
    expect(screen.getByLabelText('Office or organization name')).toHaveProperty('disabled', true);
    expect(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)).toBe(corrupt);
  });

  it('keeps the permission-aware COCCE AI action available across shared suite tabs', async () => {
    const office = createIndustryOffice(emptyIndustryState(), {
      industryId: 'school', name: 'Kijiji School', country: 'Tanzania',
    }).office!;
    const workspaceId = '11111111-1111-4111-8111-111111111111';
    writeIndustryState(window.localStorage, linkIndustryTeam({ version: 1, offices: [office] }, office.id, workspaceId));
    const listener = vi.fn();
    window.addEventListener('cocce-office:navigate', listener);
    render(<IndustrySuitesWorkspace preferredIndustryId="school" onCreateTeam={vi.fn()} />);

    expect(await screen.findByTestId('school-management-preview')).toBeTruthy();
    const askAi = await screen.findByRole('button', { name: 'Ask COCCE AI' });
    fireEvent.click(askAi);
    expect(listener).toHaveBeenCalledTimes(1);
    const event = listener.mock.calls[0][0] as CustomEvent<{ page: string; workspaceId: string; prompt: string }>;
    expect(event.detail).toMatchObject({ page: 'ai', workspaceId });
    expect(event.detail.prompt).toContain('Kijiji School');
    expect(event.detail.prompt).toContain('do not assume access to sector database records');

    fireEvent.click(screen.getByRole('tab', { name: 'Shared work items' }));
    expect(await screen.findByText('Shared workbench is unavailable')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ask COCCE AI' })).toBeTruthy();
    window.removeEventListener('cocce-office:navigate', listener);
  });
  it('opens the globally selected server-backed Office suite without exposing device-local preview records', async () => {
    const localOffice = createIndustryOffice(emptyIndustryState(), {
      industryId: 'school', name: 'Old Local School', country: 'Tanzania',
    }).office!;
    const localWork = addIndustryWorkItem({ version: 1, offices: [localOffice] }, localOffice.id, {
      title: 'Private device-only preview item', notes: 'This must never appear in the server workspace.',
    });
    writeIndustryState(window.localStorage, localWork.state);
    const workspaceId = '22222222-2222-4222-8222-222222222222';

    render(<IndustrySuitesWorkspace
      preferredIndustryId={null}
      activeWorkspace={{ workspaceId, name: 'Server-backed Academy', suiteId: 'school' }}
      onCreateTeam={vi.fn()}
    />);

    expect(await screen.findByTestId('school-management-preview')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Server-backed Academy' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'School Management' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('button', { name: 'Ask COCCE AI' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Private device-only preview item' })).toBeNull();
    const persisted = JSON.parse(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)!);
    expect(persisted.offices[0].items[0].title).toBe('Private device-only preview item');
    expect(persisted.offices[0].teamWorkspaceId).toBeUndefined();
  });

  it('does not guess a specialist suite for an existing server workspace with no suite metadata', () => {
    render(<IndustrySuitesWorkspace
      preferredIndustryId={null}
      activeWorkspace={{ workspaceId: '33333333-3333-4333-8333-333333333333', name: 'Unassigned Office', suiteId: null }}
      onCreateTeam={vi.fn()}
    />);

    expect(screen.getByRole('heading', { name: 'Unassigned Office' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Choose an Office suite' })).toBeTruthy();
    expect(screen.queryByTestId('business-management-preview')).toBeNull();
    expect(screen.queryByTestId('school-management-preview')).toBeNull();
  });

});
