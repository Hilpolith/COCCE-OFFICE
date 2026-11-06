// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import GovernmentWorkspacePanels from './GovernmentWorkspacePanels';

const mocks = vi.hoisted(() => ({
  listRecordControls: vi.fn(), listControlEvents: vi.fn(), listAttachments: vi.fn(), readRecordControl: vi.fn(),
  checkOfficeAiStatus: vi.fn(), requestOfficeAi: vi.fn(), buildGovernmentReviewRequest: vi.fn(),
}));
vi.mock('./lib/officeGovernmentWorkspace', () => ({
  officeGovernmentWorkspaceApi: {
    listRecordControls: mocks.listRecordControls,
    listControlEvents: mocks.listControlEvents,
    listAttachments: mocks.listAttachments,
    readRecordControl: mocks.readRecordControl,
  },
}));
vi.mock('./lib/officeGovernmentConnectors', () => ({ createOfficeGovernmentConnectorApi: vi.fn() }));
vi.mock('./lib/officeCloudFiles', () => ({ createOfficeCloudApi: vi.fn() }));
vi.mock('./lib/officeAi', () => ({
  checkOfficeAiStatus: mocks.checkOfficeAiStatus,
  requestOfficeAi: mocks.requestOfficeAi,
  buildGovernmentReviewRequest: (workspaceId: string, correspondenceId: string, selectedText: string, reviewAction: string) => ({ action: 'government_review', workspaceId, correspondenceId, selectedText, reviewAction, nonSensitiveConfirmed: true }),
  OFFICE_AI_MAX_SELECTION_CHARS: 8000,
}));

const workspaceId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const correspondenceId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const control = {
  correspondence_id: correspondenceId, direction: 'incoming' as const, subject: 'Routine policy notice', official_reference: 'REF-1', status: 'registered',
  classification: 'public' as const, retention_review_on: null, archive_status: 'active' as const, legal_hold: false, legal_hold_basis: null,
  disposition_state: 'none' as const, disposition_action: null, disposition_reference: '', record_version: 1, control_version: 1, created_at: '2026-11-06T12:00:00Z',
};
const record = {
  correspondence_id: correspondenceId, workspace_id: workspaceId, direction: 'incoming' as const, record_type: 'letter' as const,
  subject: 'Routine policy notice', summary: '', official_reference: 'REF-1', source_unit: 'Registry', destination_unit: '', current_department: '',
  assigned_user_id: userId, received_date: '2026-11-06', due_date: null, related_incoming_id: null, dispatch_method: null, dispatch_reference: '',
  dispatched_at: null, status: 'registered' as const, version: 1, created_by: userId, created_at: '2026-11-06T12:00:00Z', updated_by: userId, updated_at: '2026-11-06T12:00:00Z',
};
const config = { status: 'ready' as const, url: 'https://nresyncmhdybucenhxbw.supabase.co', projectRef: 'nresyncmhdybucenhxbw', anonKey: 'anon', schemaReady: true };
const client = { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'session-token' } }, error: null }) } } as unknown as SupabaseClient;

function renderRecords() {
  return render(<GovernmentWorkspacePanels
    client={client} config={config} workspaceId={workspaceId} currentUserId={userId} members={[]} records={[record]}
    accessProfile={{ is_admin: false, roles: ['records_manager'] }} canAdminister={false}
    activeTab="records" onRefresh={vi.fn()}
  />);
}

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listRecordControls.mockResolvedValue([control]);
  mocks.listControlEvents.mockResolvedValue([]);
  mocks.listAttachments.mockResolvedValue([]);
  mocks.readRecordControl.mockResolvedValue(control);
  mocks.checkOfficeAiStatus.mockResolvedValue(true);
  mocks.requestOfficeAi.mockResolvedValue('Reviewed suggestion.');
});

describe('Government review-only AI panel', () => {
  it('does not send record fields automatically and sends only the confirmed separate excerpt', async () => {
    renderRecords();
    await screen.findByText('Routine policy notice');
    expect(mocks.requestOfficeAi).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /routine policy notice/i }));
    const excerpt = 'A separately typed, non-sensitive excerpt.';
    fireEvent.change(screen.getByRole('textbox', { name: 'Separate AI review text' }), { target: { value: excerpt } });
    fireEvent.click(screen.getByRole('checkbox', { name: /i verified no personal, classified, confidential, or sensitive content/i }));
    fireEvent.click(screen.getByRole('button', { name: /request suggestion/i }));
    await waitFor(() => expect(mocks.requestOfficeAi).toHaveBeenCalledWith('session-token', { action: 'government_review', workspaceId, correspondenceId, selectedText: excerpt, reviewAction: 'summarize', nonSensitiveConfirmed: true }));
    expect(mocks.requestOfficeAi.mock.calls[0][1].selectedText).not.toContain('Routine policy notice');
  });

  it('blocks obvious email/PII patterns before invoking the AI service', async () => {
    renderRecords();
    await screen.findByText('Routine policy notice');
    fireEvent.click(screen.getByRole('button', { name: /routine policy notice/i }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Separate AI review text' }), { target: { value: 'Contact person@example.com for details.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /i verified no personal, classified, confidential, or sensitive content/i }));
    expect(screen.getByText(/possible email, phone, or long ID-like number detected/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /request suggestion/i })).toHaveProperty('disabled', true);
    expect(mocks.requestOfficeAi).not.toHaveBeenCalled();
  });
});
