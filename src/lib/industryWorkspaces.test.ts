// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  INDUSTRY_STORAGE_KEY, addIndustryWorkItem, advanceIndustryWorkItem,
  createIndustryOffice, emptyIndustryState, linkIndustryTeam, readIndustryState,
  returnIndustryWorkItem, writeIndustryState,
} from './industryWorkspaces';

const fixed = new Date('2026-11-05T12:00:00.000Z');

beforeEach(() => window.localStorage.clear());

describe('industry workspaces stay local and bounded', () => {
  it('creates an industry-specific office and persists its initial register', () => {
    const created = createIndustryOffice(emptyIndustryState(), {
      industryId: 'government', name: 'City Services', country: 'Tanzania',
    }, fixed);
    expect(created.office).toMatchObject({ industryId: 'government', name: 'City Services', country: 'Tanzania', items: [], teamWorkspaceId: null });
    writeIndustryState(window.localStorage, created.state);
    expect(readIndustryState(window.localStorage)).toEqual({ state: created.state, issue: null });
  });

  it('adds a sector-labeled work record and records each local stage transition', () => {
    const office = createIndustryOffice(emptyIndustryState(), {
      industryId: 'manufacturing', name: 'Kijiji Factory', country: 'Tanzania',
    }, fixed).office!;
    const state = { version: 1 as const, offices: [office] };
    const created = addIndustryWorkItem(state, office.id, {
      title: 'Review machine maintenance plan', reference: 'WO-LOCAL-01', owner: 'Maintenance team',
      dueDate: '2026-11-20', notes: 'Synthetic operational example only.',
    }, fixed);
    expect(created.item).toMatchObject({ stage: 'Planned', history: [{ from: null, to: 'Planned' }] });
    const advanced = advanceIndustryWorkItem(created.state, office.id, created.item!.id, new Date('2026-11-06T12:00:00.000Z'));
    expect(advanced.offices[0].items[0]).toMatchObject({ stage: 'In progress', history: [{ from: null, to: 'Planned' }, { from: 'Planned', to: 'In progress' }] });
    const returned = returnIndustryWorkItem(advanced, office.id, created.item!.id, new Date('2026-11-07T12:00:00.000Z'));
    expect(returned.offices[0].items[0].stage).toBe('Planned');
    expect(returned.offices[0].items[0].history).toHaveLength(3);
    expect(returnIndustryWorkItem(returned, office.id, created.item!.id)).toBe(returned);
  });

  it('refuses invalid or oversized work records without changing saved state', () => {
    const office = createIndustryOffice(emptyIndustryState(), {
      industryId: 'school', name: 'Demo School', country: 'Tanzania',
    }, fixed).office!;
    const state = { version: 1 as const, offices: [office] };
    expect(addIndustryWorkItem(state, office.id, { title: '   ' }, fixed)).toEqual({ state, item: null });
    expect(addIndustryWorkItem(state, office.id, { title: 'Valid title', notes: 'x'.repeat(2001) }, fixed)).toEqual({ state, item: null });
    expect(addIndustryWorkItem(state, office.id, { title: 'Invalid date', dueDate: '2026-02-31' }, fixed)).toEqual({ state, item: null });
    expect(advanceIndustryWorkItem(state, 'not-this-office', 'missing-item', fixed)).toBe(state);
  });

  it('links only the selected industry-office ID to the server-backed Office team ID', () => {
    const first = createIndustryOffice(emptyIndustryState(), { industryId: 'business', name: 'Studio', country: 'Tanzania' }, fixed).office!;
    const second = createIndustryOffice({ version: 1, offices: [first] }, { industryId: 'ngo', name: 'Field Office', country: 'Tanzania' }, fixed).office!;
    const state = { version: 1 as const, offices: [first, second] };
    const linked = linkIndustryTeam(state, first.id, 'server-office-workspace-123', fixed);
    expect(linked.offices[0].teamWorkspaceId).toBe('server-office-workspace-123');
    expect(linked.offices[1].teamWorkspaceId).toBeNull();
    expect(linkIndustryTeam(linked, first.id, '   ', fixed)).toBe(linked);
  });

  it('preserves malformed or newer local bytes and refuses to overwrite them', () => {
    const future = JSON.stringify({ version: 99, offices: [] });
    window.localStorage.setItem(INDUSTRY_STORAGE_KEY, future);
    expect(readIndustryState(window.localStorage).issue).toMatch(/newer version/i);
    expect(() => writeIndustryState(window.localStorage, emptyIndustryState())).toThrow(/unsupported format/i);
    expect(window.localStorage.getItem(INDUSTRY_STORAGE_KEY)).toBe(future);
  });
});
