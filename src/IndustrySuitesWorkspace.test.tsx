// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import IndustrySuitesWorkspace from './IndustrySuitesWorkspace';
import {
  INDUSTRY_STORAGE_KEY, createIndustryOffice, emptyIndustryState, linkIndustryTeam, writeIndustryState,
} from './lib/industryWorkspaces';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

beforeEach(() => window.localStorage.clear());

describe('industry office workbench', () => {
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
