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

    expect(await screen.findByRole('heading', { name: 'Local government preview item' })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Shared team' }));

    const governmentModule = await screen.findByTestId('government-correspondence-preview');
    expect(governmentModule.textContent ?? '').toContain('Kijiji Council');
    expect(screen.getByRole('tab', { name: 'Correspondence' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tab', { name: 'Shared work items' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Local government preview item' })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)!).offices[0].items[0].title)
      .toBe('Local government preview item');
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

  it('keeps linked offices in device mode by default and never copies their existing local tasks', async () => {
    const office = createIndustryOffice(emptyIndustryState(), {
      industryId: 'business', name: 'Kijiji Studio', country: 'Tanzania',
    }).office!;
    const localTask = addIndustryWorkItem({ version: 1, offices: [office] }, office.id, {
      title: 'Local-only item', notes: 'This old browser record stays here.',
    });
    const linked = linkIndustryTeam(localTask.state, office.id, 'server-team-id');
    writeIndustryState(window.localStorage, linked);
    render(<IndustrySuitesWorkspace preferredIndustryId="business" onCreateTeam={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Local-only item' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'This device preview' }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(screen.getByRole('tab', { name: 'Shared team' }));

    expect(await screen.findByText('Shared workbench is unavailable')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Local-only item' })).toBeNull();
    const persisted = JSON.parse(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)!);
    expect(persisted.offices[0].items[0].title).toBe('Local-only item');
    expect(persisted.offices[0].teamWorkspaceId).toBe('server-team-id');
  });

  it('creates a sector edition, persists work stages locally, and hands team creation to Office collaboration', async () => {
    const onCreateTeam = vi.fn();
    render(<IndustrySuitesWorkspace preferredIndustryId="manufacturing" onCreateTeam={onCreateTeam} />);

    fireEvent.change(screen.getByLabelText('Office or organization name'), { target: { value: 'Kijiji Factory' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Manufacturing office' }));
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

  it('shows the healthcare privacy boundary and never implies clinical records are supported', () => {
    render(<IndustrySuitesWorkspace preferredIndustryId="healthcare-admin" onCreateTeam={vi.fn()} />);
    expect(screen.getByText(/administrative only: no patient names, diagnoses, clinical records, or prescriptions/i)).toBeTruthy();
    expect(screen.getByText(/not an accounting or payroll system, clinical record, approved government system/i)).toBeTruthy();
  });

  it('keeps an unreadable local store intact and disables register edits', () => {
    const corrupt = '{not-json';
    window.localStorage.setItem(INDUSTRY_STORAGE_KEY, corrupt);
    render(<IndustrySuitesWorkspace preferredIndustryId="business" onCreateTeam={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toMatch(/existing bytes were preserved/i);
    expect(screen.getByLabelText('Office or organization name')).toHaveProperty('disabled', true);
    expect(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)).toBe(corrupt);
  });
});
