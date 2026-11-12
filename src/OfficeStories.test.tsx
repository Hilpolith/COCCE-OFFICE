// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SupabaseClient } from '@supabase/supabase-js';
import OfficeStories from './OfficeStories';

const mocks = vi.hoisted(() => ({
  listStories: vi.fn(),
  createStory: vi.fn(),
  markStoryViewed: vi.fn(),
  deleteStory: vi.fn(),
  cloud: { reserve: vi.fn(), upload: vi.fn(), finalize: vi.fn(), trash: vi.fn(), getSyncState: vi.fn(), download: vi.fn() },
}));
vi.mock('./lib/officeTeamApi', () => ({ officeTeamApi: {
  listStories: mocks.listStories, createStory: mocks.createStory,
  markStoryViewed: mocks.markStoryViewed, deleteStory: mocks.deleteStory,
} }));
vi.mock('./lib/officeCloudFiles', () => ({
  OFFICE_CLOUD_MAX_FILE_BYTES: 25 * 1024 * 1024,
  createOfficeCloudApi: () => mocks.cloud,
}));

const client = {} as SupabaseClient;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listStories.mockResolvedValue([]);
  mocks.createStory.mockResolvedValue('story-id');
  mocks.markStoryViewed.mockResolvedValue(undefined);
  mocks.deleteStory.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('OfficeStories', () => {
  it('loads the workspace story rail and opens the composer', async () => {
    render(<OfficeStories client={client} publicKey="public-key" userId="user-1" workspaceId="workspace-1" />);
    expect(await screen.findByText('Stories')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add story' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add story' }));
    expect(screen.getByRole('dialog', { name: 'Create a story' })).toBeTruthy();
  });

  it('publishes a text story through the authenticated story RPC', async () => {
    render(<OfficeStories client={client} publicKey="public-key" userId="user-1" workspaceId="workspace-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add story' }));
    fireEvent.change(screen.getByPlaceholderText('Share an update with your workspace…'), { target: { value: 'Team meeting at 10' } });
    fireEvent.click(screen.getByRole('button', { name: 'Share story' }));
    await waitFor(() => expect(mocks.createStory).toHaveBeenCalledWith(client, 'workspace-1', 'Team meeting at 10', null, 'text', 'text/plain'));
    await waitFor(() => expect(mocks.listStories).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog', { name: 'Create a story' })).toBeNull();
  });
});
