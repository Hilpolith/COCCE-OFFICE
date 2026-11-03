// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SlidesWorkspace from './SlidesWorkspace';
import { SLIDES_STORAGE_KEY } from './lib/slidesStore';

beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear(); });

async function createPresentation() {
  render(<SlidesWorkspace workspaceId={null} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create a presentation' }));
  await screen.findByRole('textbox', { name: 'Presentation title' });
}

describe('Slides workspace', () => {
  it('creates, edits, adds, reorders, and persists presentation content', async () => {
    await createPresentation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Presentation title' }), { target: { value: 'Product notes' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide title' }), { target: { value: 'What changed' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide text' }), { target: { value: 'Faster setup\nBetter review' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Speaker notes' }), { target: { value: 'Call out the trade-off.' } });
    expect(screen.getByRole('heading', { name: 'What changed' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Add slide' }));
    await waitFor(() => expect(screen.getByText('Slide 2 of 2')).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide title' }), { target: { value: 'Next steps' } });
    fireEvent.click(screen.getByRole('button', { name: 'Move slide up' }));
    expect(screen.getByText('Slide 1 of 2')).toBeTruthy();

    const saved = JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!);
    expect(saved.decks[0].title).toBe('Product notes');
    expect(saved.decks[0].slides[0].title).toBe('Next steps');
    expect(saved.decks[0].slides[1].notes).toBe('Call out the trade-off.');
  });

  it('supports duplicate/delete boundaries and presenter keyboard navigation', async () => {
    await createPresentation();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate slide' }));
    await waitFor(() => expect(screen.getByText('Slide 2 of 2')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));
    expect(screen.getByRole('dialog', { name: 'Presentation mode' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(screen.getByText('2 / 2')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Presentation mode' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete slide' }));
    expect(screen.getByText('Slide 1 of 1')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Delete slide' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keeps presenter notes hidden by default and toggles an accessible notes region', async () => {
    await createPresentation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Speaker notes' }), { target: { value: 'Mention the launch date.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));

    expect(screen.queryByRole('region', { name: 'Presenter notes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show speaker notes' }));
    expect(screen.getByRole('region', { name: 'Presenter notes' }).textContent).toContain('Mention the launch date.');
    expect(screen.getByRole('button', { name: 'Hide speaker notes' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Hide speaker notes' }));
    expect(screen.queryByRole('region', { name: 'Presenter notes' })).toBeNull();
  });

  it('updates the visible presenter notes when navigating between slides', async () => {
    await createPresentation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Speaker notes' }), { target: { value: 'First slide note.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add slide' }));
    await waitFor(() => expect(screen.getByText('Slide 2 of 2')).toBeTruthy());
    fireEvent.change(screen.getByRole('textbox', { name: 'Speaker notes' }), { target: { value: 'Second slide note.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Present' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show speaker notes' }));
    expect(screen.getByRole('region', { name: 'Presenter notes' }).textContent).toContain('Second slide note.');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByRole('region', { name: 'Presenter notes' }).textContent).toContain('First slide note.');
  });

  it('does not include speaker notes in the print slide stack', async () => {
    await createPresentation();
    fireEvent.change(screen.getByRole('textbox', { name: 'Speaker notes' }), { target: { value: 'Private print-excluded note.' } });
    const printStack = document.querySelector('.slide-print-stack');
    expect(printStack).toBeTruthy();
    expect(printStack?.textContent).not.toContain('Private print-excluded note.');
  });

  it('keeps an in-tab draft and offers retry when browser storage rejects a write', async () => {
    await createPresentation();
    const write = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new DOMException('Storage is full', 'QuotaExceededError'); });
    fireEvent.change(screen.getByRole('textbox', { name: 'Slide title' }), { target: { value: 'Not lost' } });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/recovered from this tab/));
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Not lost');
    expect(window.sessionStorage.getItem(`${SLIDES_STORAGE_KEY}:tab-recovery`)).not.toBeNull();
    cleanup();
    render(<SlidesWorkspace workspaceId={null} />);
    expect(screen.getByRole('alert').textContent).toMatch(/Recovered unsaved edits/);
    fireEvent.click(screen.getByRole('button', { name: /Untitled presentation/ }));
    expect((screen.getByRole('textbox', { name: 'Slide title' }) as HTMLInputElement).value).toBe('Not lost');
    write.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    await waitFor(() => expect(screen.getByText('Saved in this browser')).toBeTruthy());
    expect(JSON.parse(window.localStorage.getItem(SLIDES_STORAGE_KEY)!).decks[0].slides[0].title).toBe('Not lost');
    expect(window.sessionStorage.getItem(`${SLIDES_STORAGE_KEY}:tab-recovery`)).toBeNull();
  });

  it('shows a message instead of overwriting malformed local data', () => {
    window.localStorage.setItem(SLIDES_STORAGE_KEY, '{broken');
    render(<SlidesWorkspace workspaceId={null} />);
    expect(screen.getByRole('alert').textContent).toMatch(/left untouched/);
    expect(window.localStorage.getItem(SLIDES_STORAGE_KEY)).toBe('{broken');
  });
});
