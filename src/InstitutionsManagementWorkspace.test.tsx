// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstitutionsBootstrap } from './lib/officeInstitutionsTypes';
import type { InstitutionsWorkspaceContext } from './institutionsWorkspaceTypes';

const mocks = vi.hoisted(() => ({
  bootstrap: vi.fn(), keys: vi.fn(), page: vi.fn(), command: vi.fn(),
  encrypt: vi.fn(), decrypt: vi.fn(), unlock: vi.fn(), create: vi.fn(),
  authChange: null as null | ((event: string, session: { user: { id: string } } | null) => void),
  context: null as InstitutionsWorkspaceContext | null,
}));
const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const ACTOR = '20000000-0000-4000-8000-000000000002';
vi.mock('./lib/officeTeamSupabase', () => ({
  resolveOfficeTeamConfig: () => ({}),
  getOfficeTeamClient: () => ({ auth: {
    getUser: async () => ({ data: { user: { id: '20000000-0000-4000-8000-000000000002' } } }),
    onAuthStateChange: (callback: typeof mocks.authChange) => { mocks.authChange = callback; return { data: { subscription: { unsubscribe: vi.fn() } } }; },
  } }),
}));
vi.mock('./lib/officeInstitutionsManagement', () => ({
  loadInstitutionsBootstrap: mocks.bootstrap, loadInstitutionsKeys: mocks.keys,
  loadInstitutionsPage: mocks.page, runInstitutionsCommand: mocks.command,
}));
vi.mock('./lib/officePrivateRecordsCrypto', () => ({
  createOfficeRecordsKeyConfig: mocks.create, unlockOfficeRecordsKeyConfig: mocks.unlock,
  encryptOfficePrivateRecord: mocks.encrypt, decryptOfficePrivateRecord: mocks.decrypt,
}));
vi.mock('./InstitutionsPeoplePanels', () => ({
  PeoplePanel: ({ context }: { context: InstitutionsWorkspaceContext }) => { mocks.context = context; return <p data-testid="private-context">{context.actorId}:{String(context.unlocked.people)}</p>; },
  PrivacyPanel: () => <p>Privacy controls</p>, SafeguardingPanel: () => <p>Safeguarding controls</p>,
}));
import InstitutionsManagementWorkspace from './InstitutionsManagementWorkspace';

function bootstrap(open = false): InstitutionsBootstrap {
  return {
    workspace_id: WORKSPACE, role: 'institution_admin', summary: {},
    capabilities: { manage: true, people: true, governance: true, finance: true, approve: true, facilities: true, programmes: true, staff: true, safeguarding: false, privacy: true, reports: true, audit: true },
    settings: { initialized: true, version: 7, base_currency: 'TZS', private_data_enabled: open, storage_review_state: open ? 'approved' : 'unverified', storage_review_reference: open ? 'SYNTHETIC-REVIEW-1' : null },
  };
}
let current: InstitutionsBootstrap;
beforeEach(() => {
  vi.clearAllMocks(); mocks.context = null; mocks.authChange = null; current = bootstrap();
  mocks.bootstrap.mockImplementation(async () => structuredClone(current));
  mocks.keys.mockResolvedValue({ people: { configured: true }, safeguarding: { configured: false } });
  mocks.page.mockResolvedValue({ rows: [], total_count: 0, limit: 50, offset: 0, has_more: false });
  mocks.command.mockResolvedValue({ status: 'saved', version: 8 });
  mocks.unlock.mockResolvedValue({ type: 'secret' }); mocks.encrypt.mockResolvedValue({ nonce: 'n', ciphertext: 'c' });
  mocks.create.mockResolvedValue({ key: { type: 'secret' }, payload: { salt: 's', nonce: 'n', ciphertext: 'c' } });
});
afterEach(cleanup);

async function openPeople() {
  render(<InstitutionsManagementWorkspace workspaceId={WORKSPACE} />);
  await screen.findByRole('tab', { name: 'People' });
  fireEvent.click(screen.getByRole('tab', { name: 'People' }));
  await screen.findByTestId('private-context');
}

describe('Institutions root privacy lifecycle', () => {
  it('loads configuration before an unverified gate without losing it to an initial lock, and uses the real actor ID', async () => {
    await openPeople();
    expect(mocks.keys).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('private-context').textContent).toBe(`${ACTOR}:false`);
    expect(mocks.context?.keyConfigs.people.configured).toBe(true);
    await expect(mocks.context!.seal('people', 'people', ACTOR, { detail: 'private' })).rejects.toThrow();
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it('never unlocks private records merely because an administrator configures a key', async () => {
    mocks.keys.mockResolvedValue({ people: { configured: false }, safeguarding: { configured: false } });
    await openPeople();
    await act(async () => { await mocks.context!.configureKey('people', 'a strong passphrase'); });
    expect(mocks.command).toHaveBeenCalledWith(expect.anything(), WORKSPACE, 'configure_private_key', expect.objectContaining({ kind: 'people', expected_version: 7 }));
    expect(screen.getByTestId('private-context').textContent).toBe(`${ACTOR}:false`);
    expect(mocks.unlock).not.toHaveBeenCalled();
  });

  it('clears an unlocked key when the enabled gate closes even if its review remains approved', async () => {
    current = bootstrap(true); await openPeople();
    await act(async () => { await mocks.context!.unlock('people', 'a strong passphrase'); });
    expect(screen.getByTestId('private-context').textContent).toBe(`${ACTOR}:true`);
    current = { ...current, settings: { ...current.settings, private_data_enabled: false } };
    await act(async () => { mocks.authChange!('TOKEN_REFRESHED', { user: { id: ACTOR } }); });
    await waitFor(() => expect(screen.getByTestId('private-context').textContent).toBe(`${ACTOR}:false`));
    await expect(mocks.context!.seal('people', 'people', ACTOR, {})).rejects.toThrow();
  });

  it('rejects a private crypto namespace that does not match its key kind', async () => {
    current = bootstrap(true); await openPeople();
    await act(async () => { await mocks.context!.unlock('people', 'a strong passphrase'); });
    await expect(mocks.context!.seal('people', 'safeguarding', ACTOR, {})).rejects.toThrow(/gate|capability/);
    expect(mocks.encrypt).not.toHaveBeenCalled();
  });

  it('sends actual report dates, title and type rather than an empty report command', async () => {
    render(<InstitutionsManagementWorkspace workspaceId={WORKSPACE} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Reports' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Quarterly governance review' } });
    fireEvent.change(screen.getByLabelText('Period start'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Period end'), { target: { value: '2026-03-31' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Create report snapshot' }).closest('form')!);
    await waitFor(() => expect(mocks.command).toHaveBeenCalledWith(expect.anything(), WORKSPACE, 'create_report', expect.objectContaining({ report_type: 'governance', title: 'Quarterly governance review', period_start: '2026-01-01', period_end: '2026-03-31', idempotency_key: expect.any(String) })));
  });
});
