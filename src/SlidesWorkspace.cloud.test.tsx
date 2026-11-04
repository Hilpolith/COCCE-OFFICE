// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import type { SlidesCloudSnapshot } from './lib/slidesCloudSnapshot';
import { SLIDES_STORAGE_KEY } from './lib/slidesStore';
import { localSlidesAssetRepository } from './lib/slidesAssets';

const cloudMock = vi.hoisted(() => ({ snapshot: null as unknown, onError: vi.fn() }));
vi.mock('./SlidesCloudPanel', () => ({
  default: ({ onRestore }: { onRestore: (snapshot: SlidesCloudSnapshot) => Promise<void> }) => createElement(
    'button',
    { type: 'button', onClick: () => { void onRestore(cloudMock.snapshot as SlidesCloudSnapshot).catch(cloudMock.onError); } },
    'Restore synthetic cloud copy',
  ),
}));

import SlidesWorkspace from './SlidesWorkspace';

function pngBytes(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(bytes.buffer).setUint32(16, 8, false);
  new DataView(bytes.buffer).setUint32(20, 6, false);
  return bytes;
}
function validPngFile() { return new File([pngBytes().buffer as ArrayBuffer], 'local-original.png', { type: 'image/png' }); }
function makeCloudSnapshot(): SlidesCloudSnapshot {
  return {
    deck: {
      id: 'cloud-source-deck', workspaceId: 'cloud-source-workspace', title: 'Cloud plan', theme: 'ocean',
      updatedAt: '2026-11-04T10:30:00.000Z',
      slides: [{ id: 'cloud-source-slide', title: 'Launch', body: 'First step\nSecond step', notes: 'Mention the dependency.', layout: 'two-column', imageAssetId: 'cloud-source-image', imageAltText: 'Synthetic chart' }],
    },
    images: [{
      id: 'cloud-source-image', deckId: 'cloud-source-deck', mimeType: 'image/png', size: 33, width: 8, height: 6,
      createdAt: '2026-11-04T10:00:00.000Z', sha256Hex: 'a'.repeat(64), bytes: pngBytes(),
    }],
  };
}
function savedState() { return JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!); }
let originalCreateObjectURL: PropertyDescriptor | undefined;
let originalRevokeObjectURL: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.stubEnv('VITE_OFFICE_CLOUD_FILES_READY', 'true');
  vi.stubEnv('VITE_OFFICE_SLIDES_CLOUD_FILES_READY', 'true');
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('createImageBitmap', async () => ({ width: 8, height: 6, close: vi.fn() }));
  window.localStorage.clear();
  window.sessionStorage.clear();
  cloudMock.snapshot = makeCloudSnapshot();
  cloudMock.onError.mockReset();
  originalCreateObjectURL = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
  originalRevokeObjectURL = Object.getOwnPropertyDescriptor(URL, 'revokeObjectURL');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: vi.fn(() => 'blob:slides-cloud-restore-test') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: vi.fn() });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  if (originalCreateObjectURL) Object.defineProperty(URL, 'createObjectURL', originalCreateObjectURL);
  else delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
  if (originalRevokeObjectURL) Object.defineProperty(URL, 'revokeObjectURL', originalRevokeObjectURL);
  else delete (URL as unknown as { revokeObjectURL?: unknown }).revokeObjectURL;
  window.localStorage.clear();
  window.sessionStorage.clear();
});

async function createLocalOriginal() {
  render(<SlidesWorkspace workspaceId="local-workspace" />);
  fireEvent.click(screen.getByRole('button', { name: 'Create a presentation' }));
  await screen.findByRole('textbox', { name: 'Presentation title' });
  fireEvent.change(screen.getByRole('textbox', { name: 'Presentation title' }), { target: { value: 'Original local deck' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Slide title' }), { target: { value: 'Original slide' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Slide text' }), { target: { value: 'Do not replace this local content' } });
  fireEvent.change(screen.getByRole('textbox', { name: 'Speaker notes' }), { target: { value: 'Original local notes' } });
  fireEvent.change(screen.getByLabelText('Choose a local slide image'), { target: { files: [validPngFile()] } });
  await waitFor(() => expect(savedState().decks[0].slides[0].imageAssetId).toBeTruthy());
  return savedState().decks[0];
}

describe('Slides cloud restore into local workspace', () => {
  it('keeps only Slides cloud controls disabled without its separate release gate', async () => {
    vi.stubEnv('VITE_OFFICE_SLIDES_CLOUD_FILES_READY', 'false');
    render(<SlidesWorkspace workspaceId="local-workspace" />);
    expect(screen.queryByRole('button', { name: 'Cloud copies' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Create a presentation' }));
    await screen.findByRole('textbox', { name: 'Presentation title' });
    expect(screen.queryByRole('button', { name: 'Cloud copies' })).toBeNull();
  });

  it('adds a fresh local deck and image IDs while preserving every original local field and image', async () => {
    const original = await createLocalOriginal();
    const originalAssetRows = await localSlidesAssetRepository.listDeckImages(original.id);
    expect(originalAssetRows).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cloud copies' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore synthetic cloud copy' }));

    await screen.findByDisplayValue('Cloud plan');
    await waitFor(() => expect(savedState().decks).toHaveLength(2));
    const all = savedState().decks;
    const restored = all.find((deck: { title: string }) => deck.title === 'Cloud plan')!;
    const originalAfter = all.find((deck: { id: string }) => deck.id === original.id)!;
    expect(originalAfter).toEqual(original);
    expect(restored).toMatchObject({
      workspaceId: 'local-workspace', title: 'Cloud plan', theme: 'ocean', updatedAt: '2026-11-04T10:30:00.000Z',
      slides: [{ title: 'Launch', body: 'First step\nSecond step', notes: 'Mention the dependency.', layout: 'two-column', imageAltText: 'Synthetic chart' }],
    });
    expect(restored.id).not.toBe('cloud-source-deck');
    expect(restored.slides[0].id).not.toBe('cloud-source-slide');
    expect(restored.slides[0].imageAssetId).not.toBe('cloud-source-image');
    expect(original.slides[0].imageAssetId).toBe(originalAfter.slides[0].imageAssetId);
    expect(await localSlidesAssetRepository.listDeckImages(original.id)).toEqual(originalAssetRows);
    expect(await localSlidesAssetRepository.listDeckImages(restored.id)).toEqual([expect.objectContaining({
      id: restored.slides[0].imageAssetId, deckId: restored.id, mimeType: 'image/png', size: 33, width: 8, height: 6,
    })]);
    expect(cloudMock.onError).not.toHaveBeenCalled();
  });

  it('rolls back restored image records if writing the new local deck fails', async () => {
    const original = await createLocalOriginal();
    const restoreSpy = vi.spyOn(localSlidesAssetRepository, 'restoreCloudImages');
    fireEvent.click(screen.getByRole('button', { name: 'Cloud copies' }));
    const originalSetItem = window.localStorage.setItem.bind(window.localStorage);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation((key, value) => {
      if (key === SLIDES_STORAGE_KEY) throw new DOMException('synthetic local quota', 'QuotaExceededError');
      originalSetItem(key, value);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Restore synthetic cloud copy' }));
    await waitFor(() => expect(cloudMock.onError).toHaveBeenCalledOnce());
    const attemptedDeckId = restoreSpy.mock.calls[0]![0];
    expect(await localSlidesAssetRepository.listDeckImages(attemptedDeckId)).toEqual([]);
    expect(savedState().decks).toEqual([original]);
    expect(original.slides[0].imageAssetId).toBeTruthy();
  });
});
