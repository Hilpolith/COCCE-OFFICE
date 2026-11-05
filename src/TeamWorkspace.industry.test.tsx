// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TeamWorkspace from './TeamWorkspace';
import { LOCAL_TEAM_KEY } from './lib/teamStore';
import {
  INDUSTRY_STORAGE_KEY, addIndustryWorkItem, createIndustryOffice, emptyIndustryState,
  writeIndustryState,
} from './lib/industryWorkspaces';
import type { IndustryTeamSetup } from './lib/industryWorkspaces';

vi.mock('./OfficeTeamCollaboration', () => ({
  default: ({ initialWorkspaceName, onWorkspaceCreated }: {
    initialWorkspaceName?: string;
    onWorkspaceCreated?: (workspaceId: string, workspaceName: string) => void;
  }) => <>
    <output data-testid="initial-team-name">{initialWorkspaceName}</output>
    <button type="button" onClick={() => onWorkspaceCreated?.('server-team-id', initialWorkspaceName ?? 'Office Team')}>
      Create synthetic Office Team
    </button>
  </>,
}));

const setup: IndustryTeamSetup = { officeId: 'industry-office-id', officeName: 'Kijiji School', industryId: 'school' };
const fixed = new Date('2026-11-05T12:00:00.000Z');

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); });

function renderIndustryTeam(onIndustryTeamLinked = vi.fn(), industrySetup = setup) {
  return { onIndustryTeamLinked, ...render(
    <TeamWorkspace
      workspaceId="server-workspace"
      workspaceName="Kijiji School · Schools"
      query=""
      industryTeamSetup={industrySetup}
      onIndustryTeamLinked={onIndustryTeamLinked}
    />,
  ) };
}

describe('industry office to Office Team handoff', () => {
  it('creates a prefilled team and stores only its workspace ID beside the untouched local register', async () => {
    const created = createIndustryOffice(emptyIndustryState(), {
      industryId: setup.industryId, name: setup.officeName, country: 'Tanzania',
    }, fixed);
    const work = addIndustryWorkItem(created.state, created.office!.id, { title: 'Prepare term timetable' }, fixed);
    writeIndustryState(window.localStorage, work.state);
    const onIndustryTeamLinked = vi.fn();

    renderIndustryTeam(onIndustryTeamLinked, { ...setup, officeId: created.office!.id });
    expect(screen.getByTestId('initial-team-name').textContent).toBe('Kijiji School · Schools');
    fireEvent.click(screen.getByRole('button', { name: 'Create synthetic Office Team' }));

    await waitFor(() => {
      const saved = JSON.parse(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)!);
      expect(saved.offices[0].teamWorkspaceId).toBe('server-team-id');
    });
    const saved = JSON.parse(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)!);
    expect(saved.offices[0].items[0].title).toBe('Prepare term timetable');
    expect(onIndustryTeamLinked).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/work items remain on this device and are not shared/i)).toBeTruthy();
    expect(window.localStorage.getItem(LOCAL_TEAM_KEY)).toBeNull();
  });

  it('preserves malformed local bytes if the team is created while the industry office store is unreadable', async () => {
    const corrupt = '{not valid JSON';
    window.localStorage.setItem(INDUSTRY_STORAGE_KEY, corrupt);
    const onIndustryTeamLinked = vi.fn();

    renderIndustryTeam(onIndustryTeamLinked);
    fireEvent.click(screen.getByRole('button', { name: 'Create synthetic Office Team' }));

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toMatch(/was created, but its ID could not be linked/i);
    expect(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)).toBe(corrupt);
    expect(onIndustryTeamLinked).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(LOCAL_TEAM_KEY)).toBeNull();
  });
});
