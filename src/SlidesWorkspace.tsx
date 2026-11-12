import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFrostedConfirm } from './FrostedConfirm';
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronLeft, Copy,
  Download, FileText, FileUp, ImagePlus, LockKeyhole, Maximize2, Plus, Presentation,
  Printer, Redo2, Trash2, Undo2, X,
} from 'lucide-react';
import {
  createSlidesHistory, hasSameEditableDeckContent, recordSlidesHistory, redoSlidesHistory, undoSlidesHistory,
} from './lib/slidesHistory';
import type { SlidesHistory, SlidesHistorySnapshot } from './lib/slidesHistory';
import SlidesCloudPanel from './SlidesCloudPanel';
import { createRestoredSlidesDeck } from './lib/slidesCloudSnapshot';
import { slidesCloudFilesEnabled } from './lib/slidesCloudFeature';
import type { SlidesCloudSnapshot } from './lib/slidesCloudSnapshot';
import OfficeAiPromptWorkbench, { OfficeWorkbenchLayout } from './OfficeWorkbench';
import {
  localSlidesAssetRepository, MAX_ACTIVE_SLIDE_IMAGES, MAX_ACTIVE_SLIDE_IMAGE_BYTES, MAX_SLIDE_IMAGE_BYTES,
} from './lib/slidesAssets';
import { createPptxBlob, importPptxFile } from './lib/pptxExport';
import {
  addSlide, createDeck, duplicateSlide, importDeck, moveSlide, readSlidesState,
  removeDeck, removeSlide, serializeDeck, SLIDE_LAYOUTS, SLIDES_STORAGE_KEY, updateDeck, updateSlide, writeSlidesState,
} from './lib/slidesStore';
import type { PresentationDeck, Slide, SlideImageFit, SlideLayout, SlidesState, SlidesTheme } from './lib/slidesStore';
import './slides.css';

type Props = { workspaceId: string | null; onGoToTeam?: () => void };

const themeNames: Record<SlidesTheme, string> = { violet: 'Violet glass', ocean: 'Ocean glass', ember: 'Ember glass' };
const layoutNames: Record<SlideLayout, string> = {
  'title-content': 'Title and content',
  'two-column': 'Two columns',
  quote: 'Quote',
  'section-divider': 'Section divider',
};
const layoutDescriptions: Record<SlideLayout, string> = {
  'title-content': 'A clear title with the original body text below.',
  'two-column': 'Splits non-empty body lines evenly into two columns.',
  quote: 'Frames the body as a quotation beneath the title.',
  'section-divider': 'Centers the title and treats each body line as a subtitle.',
};
const RECOVERY_KEY = `${SLIDES_STORAGE_KEY}:tab-recovery`;
type LoadedSlides = { state: SlidesState | null; error: string | null; recovered: boolean };

function readSlidesForTab(): LoadedSlides {
  const saved = readSlidesState(window.localStorage);
  if (!saved.state) return { ...saved, recovered: false };
  try {
    const recoveryRaw = window.sessionStorage.getItem(RECOVERY_KEY);
    if (recoveryRaw) {
      const recovery = readSlidesState({ getItem: (key) => key === SLIDES_STORAGE_KEY ? recoveryRaw : null });
      if (recovery.state) return { ...recovery, recovered: true };
    }
  } catch { /* The saved local copy remains available if tab storage is blocked. */ }
  return { ...saved, recovered: false };
}

function clearTabRecovery() {
  try { window.sessionStorage.removeItem(RECOVERY_KEY); } catch { /* Recovery cleanup is best-effort. */ }
}

export default function SlidesWorkspace({ workspaceId, onGoToTeam = () => undefined }: Props) {
  const confirm = useFrostedConfirm();
  const [loadResult, setLoadResult] = useState<LoadedSlides>(readSlidesForTab);
  const state = loadResult.state;
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);
  const [imageContextRevision, setImageContextRevision] = useState(0);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [unsaved, setUnsaved] = useState(loadResult.recovered);
  const [presenting, setPresenting] = useState(false);
  const [presenterNotesVisible, setPresenterNotesVisible] = useState(false);
  const [slidesCloudOpen, setSlidesCloudOpen] = useState(false);
  const slidesCloudReady = slidesCloudFilesEnabled(import.meta.env);
  const [feedback, setFeedback] = useState(loadResult.recovered ? 'Recovered unsaved edits from this tab. Retry save to keep them in local storage.' : '');
  const [pptxExporting, setPptxExporting] = useState(false);
  const [history, setHistory] = useState<SlidesHistory>(createSlidesHistory);
  const [historyAnnouncement, setHistoryAnnouncement] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [loadedImages, setLoadedImages] = useState<{ deckId: string | null; signature: string; revision: number; urls: Record<string, string>; missing: string[] }>({ deckId: null, signature: '', revision: -1, urls: {}, missing: [] });
  const pendingDeckAssetCleanupRef = useRef(new Set<string>());
  const deferredDeckAssetCleanupRef = useRef(new Set<string>());
  const imageImportGenerationRef = useRef(new Map<string, number>());
  const selectionRevisionRef = useRef(0);
  const [assetCleanupFailed, setAssetCleanupFailed] = useState(false);
  const currentWorkspaceIdRef = useRef(workspaceId);

  const decks = useMemo(() => state?.decks.filter((deck) => deck.workspaceId === workspaceId) ?? [], [state, workspaceId]);
  const activeDeck = decks.find((deck) => deck.id === activeDeckId) ?? null;
  const activeSlide = activeDeck?.slides[activeSlideIndex] ?? null;
  const currentStateRef = useRef(state);
  const currentSelectionRef = useRef({ deckId: activeDeck?.id ?? null, slideId: activeSlide?.id ?? null });
  const imageAssetSignature = activeDeck?.slides.map((slide) => slide.imageAssetId ?? '').filter(Boolean).join('|') ?? '';
  const imageUrls = loadedImages.deckId === activeDeckId && loadedImages.signature === imageAssetSignature && loadedImages.revision === imageContextRevision ? loadedImages.urls : {};
  const missingImageIds = loadedImages.deckId === activeDeckId && loadedImages.signature === imageAssetSignature && loadedImages.revision === imageContextRevision ? loadedImages.missing : [];
  const canPresent = Boolean(activeDeck?.slides.every((slide) => !slide.imageAssetId || Boolean(imageUrls[slide.imageAssetId])));

  const selectDeck = (deckId: string | null) => {
    setImageContextRevision((revision) => revision + 1);
    setActiveDeckId(deckId);
  };

  useLayoutEffect(() => {
    const nextSelection = { deckId: activeDeck?.id ?? null, slideId: activeSlide?.id ?? null };
    if (currentSelectionRef.current.deckId !== nextSelection.deckId || currentSelectionRef.current.slideId !== nextSelection.slideId) {
      selectionRevisionRef.current += 1;
    }
    currentStateRef.current = state;
    currentSelectionRef.current = nextSelection;
    currentWorkspaceIdRef.current = workspaceId;
  }, [state, activeDeck?.id, activeSlide?.id, workspaceId]);

  useEffect(() => {
    let cancelled = false;
    const allocatedUrls: string[] = [];
    if (!activeDeckId || !imageAssetSignature) return () => { cancelled = true; };
    const assetIds = [...new Set(imageAssetSignature.split('|'))];
    const revokeAllocatedUrls = () => {
      const urls = allocatedUrls.splice(0);
      urls.forEach((url) => URL.revokeObjectURL(url));
    };
    void Promise.all(assetIds.map(async (assetId) => {
      try {
        const result = await localSlidesAssetRepository.readImage(assetId, activeDeckId);
        const url = URL.createObjectURL(result.blob);
        allocatedUrls.push(url);
        return [assetId, url] as const;
      } catch {
        return [assetId, null] as const;
      }
    })).then((entries) => {
      if (cancelled) {
        revokeAllocatedUrls();
        return;
      }
      const urls: Record<string, string> = {};
      const missing: string[] = [];
      entries.forEach(([assetId, url]) => {
        if (url) urls[assetId] = url;
        else missing.push(assetId);
      });
      setLoadedImages({ deckId: activeDeckId, signature: imageAssetSignature, revision: imageContextRevision, urls, missing });
      if (missing.length) setFeedback('A local slide image is unavailable. Replace it before printing or presenting this deck.');
    }).catch(() => {
      if (!cancelled) setFeedback('Could not read local slide images from this browser.');
    });
    return () => {
      cancelled = true;
      revokeAllocatedUrls();
    };
  }, [activeDeckId, imageAssetSignature, imageContextRevision]);

  const persist = (next: SlidesState): boolean => {
    setLoadResult({ state: next, error: null, recovered: false });
    try {
      writeSlidesState(window.localStorage, next);
      clearTabRecovery();
      setUnsaved(false);
      setFeedback('Saved on this device');
      return true;
    } catch {
      let recovered = false;
      try { window.sessionStorage.setItem(RECOVERY_KEY, JSON.stringify(next)); recovered = true; } catch { /* The active component still retains this edit for retry. */ }
      setLoadResult({ state: next, error: null, recovered });
      setUnsaved(true);
      setFeedback(recovered ? 'Not saved in browser storage — recovered from this tab after navigation. Retry before closing.' : 'Not saved — your latest edits are kept in this tab. Retry before closing.');
      return false;
    }
  };

  const commitActiveDeckEdit = (next: SlidesState, nextSlideId = activeSlide?.id ?? null, groupKey: string | null = null): boolean => {
    const currentState = currentStateRef.current;
    const currentDeckId = currentSelectionRef.current.deckId;
    if (!currentState || !currentDeckId) return false;
    const beforeDeck = currentState.decks.find((deck) => deck.id === currentDeckId);
    const afterDeck = next.decks.find((deck) => deck.id === currentDeckId);
    if (!beforeDeck || !afterDeck || hasSameEditableDeckContent(beforeDeck, afterDeck)) return false;
    persist(next);
    setHistory((current) => recordSlidesHistory(current, beforeDeck, afterDeck, activeSlide?.id ?? null, groupKey));
    const selectedIndex = afterDeck.slides.findIndex((slide) => slide.id === nextSlideId);
    setActiveSlideIndex(selectedIndex >= 0 ? selectedIndex : 0);
    return true;
  };

  const applyHistorySnapshot = (snapshot: SlidesHistorySnapshot) => {
    if (!state || !activeDeck || snapshot.deck.id !== activeDeck.id) return;
    const restoredDeck = { ...snapshot.deck, updatedAt: new Date().toISOString() };
    const next = { ...state, decks: state.decks.map((deck) => deck.id === restoredDeck.id ? restoredDeck : deck) };
    const selectedIndex = restoredDeck.slides.findIndex((slide) => slide.id === snapshot.slideId);
    persist(next);
    setActiveSlideIndex(selectedIndex >= 0 ? selectedIndex : 0);
  };

  const canUndo = Boolean(activeDeck && history.deckId === activeDeck.id && history.past.length > 0);
  const canRedo = Boolean(activeDeck && history.deckId === activeDeck.id && history.future.length > 0);

  const undoEdit = () => {
    if (!activeDeck || !activeSlide || !canUndo) return;
    const transition = undoSlidesHistory(history, activeDeck, activeSlide.id);
    if (!transition.target) return;
    setHistory(transition.history);
    applyHistorySnapshot(transition.target);
    setHistoryAnnouncement('Undid the last Slides edit.');
  };

  const redoEdit = () => {
    if (!activeDeck || !activeSlide || !canRedo) return;
    const transition = redoSlidesHistory(history, activeDeck, activeSlide.id);
    if (!transition.target) return;
    setHistory(transition.history);
    applyHistorySnapshot(transition.target);
    setHistoryAnnouncement('Redid the last Slides edit.');
  };

  const handleHistoryShortcut = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!activeDeck || presenting || (!event.ctrlKey && !event.metaKey) || event.altKey) return;
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || (target instanceof HTMLElement && target.isContentEditable)) return;
    const key = event.key.toLowerCase();
    const undoRequested = key === 'z' && !event.shiftKey;
    const redoRequested = (key === 'z' && event.shiftKey) || key === 'y';
    if (undoRequested && canUndo) {
      event.preventDefault();
      undoEdit();
    } else if (redoRequested && canRedo) {
      event.preventDefault();
      redoEdit();
    }
  };

  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);

  useEffect(() => {
    if (!presenting) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPresenting(false);
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === ' ') {
        event.preventDefault();
        setActiveSlideIndex((index) => Math.min(index + 1, (activeDeck?.slides.length ?? 1) - 1));
      }
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveSlideIndex((index) => Math.max(index - 1, 0));
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [presenting, activeDeck?.slides.length]);

  const beginDeck = () => {
    if (!state) return;
    const result = createDeck(state, workspaceId);
    persist(result.state);
    setHistory(createSlidesHistory());
    setHistoryAnnouncement('');
    selectDeck(result.deck.id);
    setActiveSlideIndex(0);
  };

  const addNewSlide = () => {
    if (!state || !activeDeck) return;
    const result = addSlide(state, activeDeck.id);
    if (!result.slide) { setFeedback('A presentation can contain up to 100 slides.'); return; }
    commitActiveDeckEdit(result.state, result.slide.id);
  };

  const duplicateCurrentSlide = () => {
    if (!state || !activeDeck || !activeSlide) return;
    const result = duplicateSlide(state, activeDeck.id, activeSlide.id);
    if (!result.slide) { setFeedback('A presentation can contain up to 100 slides.'); return; }
    commitActiveDeckEdit(result.state, result.slide.id);
  };

  const deleteCurrentSlide = () => {
    if (!state || !activeDeck || !activeSlide || activeDeck.slides.length <= 1) return;
    const next = removeSlide(state, activeDeck.id, activeSlide.id);
    const nextDeck = next.decks.find((deck) => deck.id === activeDeck.id);
    if (!nextDeck) return;
    const nextIndex = Math.min(activeSlideIndex, nextDeck.slides.length - 1);
    commitActiveDeckEdit(next, nextDeck.slides[nextIndex]?.id ?? null);
  };

  const shiftSlide = (direction: -1 | 1) => {
    if (!state || !activeDeck || !activeSlide) return;
    const target = activeSlideIndex + direction;
    if (target < 0 || target >= activeDeck.slides.length) return;
    commitActiveDeckEdit(moveSlide(state, activeDeck.id, activeSlide.id, direction), activeSlide.id);
  };

  const retryPendingAssetCleanup = async () => {
    const pendingDeckIds = [...pendingDeckAssetCleanupRef.current];
    if (!pendingDeckIds.length) { setAssetCleanupFailed(false); return; }
    try {
      await Promise.all(pendingDeckIds.map((deckId) => localSlidesAssetRepository.deleteDeckImages(deckId)));
      pendingDeckAssetCleanupRef.current.clear();
      setAssetCleanupFailed(false);
      setFeedback('Deleted presentation image files cleared from this browser.');
    } catch {
      setAssetCleanupFailed(true);
      setFeedback('The presentation is deleted, but its image files could not yet be cleared. Retry image cleanup.');
    }
  };

  const retrySave = async () => {
    const currentState = currentStateRef.current;
    if (!currentState) return;
    try {
      writeSlidesState(window.localStorage, currentState);
      clearTabRecovery();
      setLoadResult({ state: currentState, error: null, recovered: false });
      setUnsaved(false);
      setFeedback('Saved on this device');
    } catch {
      setFeedback('Still not saved — browser storage is unavailable or full.');
      return;
    }
    deferredDeckAssetCleanupRef.current.forEach((deckId) => pendingDeckAssetCleanupRef.current.add(deckId));
    deferredDeckAssetCleanupRef.current.clear();
    if (pendingDeckAssetCleanupRef.current.size) await retryPendingAssetCleanup();
  };

  const restoreCloudCopy = async (snapshot: SlidesCloudSnapshot) => {
    if (unsaved || !currentStateRef.current) throw new Error('Save local Slides changes before restoring a cloud copy.');
    const originalState = currentStateRef.current;
    const destinationWorkspaceId = workspaceId;
    const usedIds = new Set(originalState.decks.flatMap((deck) => [deck.id, ...deck.slides.map((slide) => slide.id), ...deck.slides.flatMap((slide) => slide.imageAssetId ? [slide.imageAssetId] : [])]));
    const makeFreshId = () => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const id = globalThis.crypto?.randomUUID?.() ?? `slides-cloud-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
        if (!usedIds.has(id)) { usedIds.add(id); return id; }
      }
      throw new Error('Could not generate fresh local IDs for this presentation.');
    };
    const newDeckId = makeFreshId();
    let imagesInstalled = false;
    try {
      const assetIdMap = await localSlidesAssetRepository.restoreCloudImages(newDeckId, snapshot.images.map((image) => ({
        sourceId: image.id,
        mimeType: image.mimeType,
        size: image.size,
        width: image.width,
        height: image.height,
        createdAt: image.createdAt,
        bytes: image.bytes,
      })));
      imagesInstalled = snapshot.images.length > 0;
      if (currentStateRef.current !== originalState || currentWorkspaceIdRef.current !== destinationWorkspaceId || unsaved)
        throw new Error('The active local workspace or presentation changed during restore. No presentation was added.');
      const restoredDeck = createRestoredSlidesDeck(snapshot, destinationWorkspaceId, newDeckId, assetIdMap, makeFreshId);
      const nextState = { ...originalState, decks: [restoredDeck, ...originalState.decks] };
      writeSlidesState(window.localStorage, nextState);
      clearTabRecovery();
      currentStateRef.current = nextState;
      setLoadResult({ state: nextState, error: null, recovered: false });
      setUnsaved(false);
      setHistory(createSlidesHistory());
      setHistoryAnnouncement('');
      setActiveSlideIndex(0);
      selectDeck(restoredDeck.id);
      setSlidesCloudOpen(false);
      setFeedback('Cloud copy restored as a new local presentation with its image files.');
    } catch (cause) {
      if (imagesInstalled) {
        try {
          await localSlidesAssetRepository.deleteDeckImages(newDeckId);
        } catch {
          pendingDeckAssetCleanupRef.current.add(newDeckId);
          setAssetCleanupFailed(true);
          throw new Error('Restore was not added to local presentations, but its temporary image files could not yet be removed. Retry image cleanup.');
        }
      }
      throw cause;
    }
  };

  const downloadJson = async (deck: PresentationDeck) => {
    const imageCount = deck.slides.filter((slide) => Boolean(slide.imageAssetId)).length;
    if (imageCount > 0 && !await confirm(`This JSON transfer will omit ${imageCount} local image${imageCount === 1 ? '' : 's'}; it includes slide text, layouts, notes, and image descriptions only. Image files remain in this browser. Continue?`)) return;
    const blob = new Blob([serializeDeck(deck)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileName(deck.title)}.cocce-slides.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFeedback('Presentation JSON downloaded.');
  };

  const downloadPptx = async (deck: PresentationDeck) => {
    if (pptxExporting) return;
    setPptxExporting(true);
    try {
      const blob = await createPptxBlob(deck);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = safeFileName(deck.title) + '.pptx';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setFeedback('Editable PowerPoint presentation downloaded, including retained local images and speaker notes.');
    } catch (error) {
      setFeedback('PowerPoint export failed: ' + (error instanceof Error ? error.message : 'The presentation could not be exported.'));
    } finally {
      setPptxExporting(false);
    }
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !state) return;
    const isPptx = file.name.toLowerCase().endsWith('.pptx');
    if (file.size > (isPptx ? 25_000_000 : 5_000_000)) { setFeedback(isPptx ? 'That PowerPoint file is larger than the 25 MB import limit.' : 'That JSON file is larger than the 5 MB import limit.'); return; }
    try {
      const importedResult = isPptx ? await importPptxFile(file, workspaceId) : importDeck(await file.text(), workspaceId);
      const imported = importedResult.deck;
      const saved = persist({ ...state, decks: [imported, ...state.decks] });
      setHistory(createSlidesHistory());
      setHistoryAnnouncement('');
      selectDeck(imported.id);
      setActiveSlideIndex(0);
      if (saved) setFeedback(importedResult.omittedImageCount
        ? `Presentation imported. ${importedResult.omittedImageCount} embedded image${importedResult.omittedImageCount === 1 ? ' was' : 's were'} not imported; reinsert those images in the affected slides.`
        : 'Presentation imported on this device.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Could not read that presentation file.');
    }
  };

  const addLocalImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !activeDeck || !activeSlide || !state) return;
    if (file.size > MAX_SLIDE_IMAGE_BYTES) {
      setFeedback('Slide images must be 2 MB or smaller. Choose a smaller local image.');
      return;
    }
    const deckId = activeDeck.id;
    const slideId = activeSlide.id;
    const importKey = `${deckId}\u001f${slideId}`;
    const importGeneration = (imageImportGenerationRef.current.get(importKey) ?? 0) + 1;
    imageImportGenerationRef.current.set(importKey, importGeneration);
    const selectionRevision = selectionRevisionRef.current;
    const isLatestImport = () => imageImportGenerationRef.current.get(importKey) === importGeneration;
    const isOriginalSelection = () => selectionRevisionRef.current === selectionRevision
      && currentSelectionRef.current.deckId === deckId && currentSelectionRef.current.slideId === slideId;
    try {
      const referencedIds = new Set(activeDeck.slides.flatMap((slide) => slide.imageAssetId ? [slide.imageAssetId] : []));
      const oldAssetId = activeSlide.imageAssetId;
      if (oldAssetId && !activeDeck.slides.some((slide) => slide.id !== slideId && slide.imageAssetId === oldAssetId)) {
        referencedIds.delete(oldAssetId);
      }
      if (referencedIds.size >= MAX_ACTIVE_SLIDE_IMAGES) {
        setFeedback(`A presentation can show up to ${MAX_ACTIVE_SLIDE_IMAGES} local images at once. Remove an image before adding another.`);
        return;
      }
      const existing = await localSlidesAssetRepository.listDeckImages(deckId);
      if (!isLatestImport()) return;
      if (!isOriginalSelection()) {
        setFeedback('Image import was canceled because the active slide changed. Choose the image again on the intended slide.');
        return;
      }
      const activeBytes = existing.filter((image) => referencedIds.has(image.id)).reduce((sum, image) => sum + image.size, 0);
      if (activeBytes + file.size > MAX_ACTIVE_SLIDE_IMAGE_BYTES) {
        setFeedback('Active slide images in a presentation are capped at 12 MB total. Remove an image or choose a smaller file.');
        return;
      }
      const saved = await localSlidesAssetRepository.saveImage(file, deckId);
      if (!isLatestImport()) {
        await localSlidesAssetRepository.deleteImage(saved.id, deckId);
        return;
      }
      if (!isOriginalSelection()) {
        await localSlidesAssetRepository.deleteImage(saved.id, deckId);
        setFeedback('Image import was canceled because the active slide changed. Choose the image again on the intended slide.');
        return;
      }
      const latestState = currentStateRef.current;
      if (!latestState?.decks.some((deck) => deck.id === deckId && deck.slides.some((slide) => slide.id === slideId))) {
        await localSlidesAssetRepository.deleteImage(saved.id, deckId);
        setFeedback('Image import was canceled because the presentation changed.');
        return;
      }
      const filenameDescription = file.name.replace(/\.[^.]+$/u, '').trim().slice(0, 500) || 'Slide image';
      const latestSlide = latestState.decks.find((deck) => deck.id === deckId)!.slides.find((slide) => slide.id === slideId)!;
      const next = updateSlide(latestState, deckId, slideId, {
        imageAssetId: saved.id,
        imageAltText: latestSlide.imageAltText?.trim() || filenameDescription,
      });
      if (commitActiveDeckEdit(next, slideId)) setFeedback('Local image added. Its file stays in this browser’s image store.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Could not add this local slide image.');
    } finally {
      if (isLatestImport()) imageImportGenerationRef.current.delete(importKey);
    }
  };

  const removeLocalImage = () => {
    if (!state || !activeDeck || !activeSlide?.imageAssetId) return;
    commitActiveDeckEdit(updateSlide(state, activeDeck.id, activeSlide.id, { imageAssetId: undefined, imageAltText: undefined }), activeSlide.id);
    setFeedback('Image removed from this slide. Undo can restore it; its local bytes remain with this presentation until the presentation is deleted.');
  };

  const printPresentation = async () => {
    if (!activeDeck) return;
    if (activeDeck.slides.some((slide) => slide.imageAssetId && (!imageUrls[slide.imageAssetId] || missingImageIds.includes(slide.imageAssetId)))) {
      setFeedback('A local image is unavailable. Replace it before printing so the PDF does not omit media.');
      return;
    }
    try {
      const images = Array.from(document.querySelectorAll<HTMLImageElement>('.slide-print-stack img'));
      await Promise.all(images.map((image) => image.decode ? image.decode() : Promise.resolve()));
      window.print();
    } catch {
      setFeedback('A local slide image could not be prepared for printing. No print dialog was opened.');
    }
  };

  const deletePresentation = async () => {
    if (!state || !activeDeck) return;
    if (!await confirm(`Delete “${activeDeck.title || 'Untitled presentation'}” and permanently remove its local image files from this browser?`)) return;
    const deletedDeckId = activeDeck.id;
    const saved = persist(removeDeck(state, deletedDeckId));
    if (saved) {
      void localSlidesAssetRepository.deleteDeckImages(deletedDeckId).then((count) => {
        if (count) setFeedback(`Presentation deleted and ${count} local image${count === 1 ? '' : 's'} permanently removed.`);
      }).catch(() => {
        pendingDeckAssetCleanupRef.current.add(deletedDeckId);
        setAssetCleanupFailed(true);
        setFeedback('The presentation is deleted, but its image files could not yet be cleared. Retry image cleanup.');
      });
    } else deferredDeckAssetCleanupRef.current.add(deletedDeckId);
    setHistory(createSlidesHistory());
    setHistoryAnnouncement('');
    selectDeck(null);
    setActiveSlideIndex(0);
  };

  const patchDeck = (patch: Partial<Pick<PresentationDeck, 'title' | 'theme'>>) => {
    if (state && activeDeck) {
      const groupKey = patch.title !== undefined ? `deck:${activeDeck.id}:title` : null;
      commitActiveDeckEdit(updateDeck(state, activeDeck.id, patch), activeSlide?.id ?? null, groupKey);
    }
  };

  const patchSlide = (patch: Partial<Pick<Slide, 'title' | 'body' | 'notes' | 'layout' | 'imageAltText' | 'imageFit'>>) => {
    if (state && activeDeck && activeSlide) {
      const field = Object.keys(patch)[0] ?? '';
      commitActiveDeckEdit(updateSlide(state, activeDeck.id, activeSlide.id, patch), activeSlide.id, `slide:${activeSlide.id}:${field}`);
    }
  };

  if (!state) {
    return <div className="page slides-page"><div className="slides-error glass-card" role="alert"><LockKeyhole size={18} /><div><strong>Saved presentations are protected</strong><p>{loadResult.error}</p></div></div></div>;
  }

  const aiTargetId = activeDeck && activeSlide ? `${activeDeck.id}:${activeSlide.id}` : '';
  const previewAiSlideText = (output: string) => {
    const candidate = output.trim();
    if (!candidate) return { candidate: null, previewText: output, reason: 'The response was empty. Nothing can be applied.' };
    if (candidate.length > 12_000) return { candidate: null, previewText: output, reason: 'The response is longer than this slide’s 12,000-character limit. Nothing can be applied.' };
    return { candidate, previewText: candidate, detail: 'Only the active slide body will change. Its title, notes, image, layout, and other slides remain untouched.' };
  };

  return (
    <div className="page slides-page office-editor-page" onKeyDown={handleHistoryShortcut}>
      <div className="slides-page-heading">
        <div>
          <span className="eyebrow">{slidesCloudReady ? 'COCCE SLIDES · LOCAL-FIRST' : 'COCCE SLIDES · LOCAL MODE'}</span>
          <h1>{activeDeck ? 'Edit presentation' : 'Presentations'}</h1>
          <p className="page-lede">{slidesCloudReady ? 'Create and edit presentations saved in this browser. Manual cloud copies are optional; PowerPoint export is available; background sync and co-editing are not connected.' : 'Create and edit simple presentations saved in this browser. PowerPoint export is available; cloud copies and co-editing are not connected in this environment.'}</p>
        </div>
        <div className="slides-heading-actions">
          {activeDeck ? <button className="button-secondary" onClick={() => { selectDeck(null); setActiveSlideIndex(0); setHistoryAnnouncement(''); }}><ChevronLeft size={16} /> All presentations</button> : <button className="button-primary" onClick={beginDeck}><Plus size={17} /> New presentation</button>}
        </div>
      </div>

      <div className="slides-local-note"><LockKeyhole size={14} /><span>Slides are saved in this browser, scoped to <strong>{workspaceId ? 'this local workspace' : 'Personal space'}</strong>. Image files use local IndexedDB; {slidesCloudReady ? 'a confirmed cloud copy includes the full presentation and all retained image files. No background sync occurs.' : 'JSON transfer omits local images after confirmation; PPTX import preserves text and notes, while embedded images are flagged for reinsertion. PowerPoint export embeds retained local images and notes.'}</span></div>
      {unsaved && <div className="slides-unsaved" role="alert"><span>{feedback}</span><button className="button-tertiary" onClick={retrySave}>Retry save</button></div>}
      {assetCleanupFailed && <div className="slides-unsaved" role="alert"><span>The presentation is deleted, but its local image files still need cleanup.</span><button className="button-tertiary" onClick={() => { void retryPendingAssetCleanup(); }}>Retry image cleanup</button></div>}

      {!activeDeck && <section className="slides-library">
        <div className="slides-library-toolbar">
          <div><span className="eyebrow">YOUR DECKS</span><h2>{decks.length ? `${decks.length} ${decks.length === 1 ? 'presentation' : 'presentations'}` : 'A clear canvas'}</h2></div>
          <div className="slides-library-actions">
            <input ref={inputRef} className="visually-hidden-input" type="file" accept="application/json,.json,application/vnd.openxmlformats-officedocument.presentationml.presentation,.pptx" onChange={importFile} aria-label="Choose a PowerPoint or COCCE presentation file" />
            <button className="button-secondary" onClick={() => inputRef.current?.click()}><FileUp size={15} /> Import JSON</button>
            {slidesCloudReady && <button className="button-secondary" aria-expanded={slidesCloudOpen} onClick={() => setSlidesCloudOpen((open) => !open)}>{slidesCloudOpen ? 'Hide cloud copies' : 'Cloud copies'}</button>}
            {decks.length > 0 && <button className="button-primary" onClick={beginDeck}><Plus size={16} /> New presentation</button>}
          </div>
        </div>
        {decks.length ? <div className="slides-deck-grid">{decks.map((deck) => <button className="slides-deck-card glass-card" key={deck.id} onClick={() => { setHistory((current) => current.deckId === deck.id ? current : createSlidesHistory()); setHistoryAnnouncement(''); selectDeck(deck.id); setActiveSlideIndex(0); }}>
          <span className={`slides-deck-preview theme-${deck.theme}`}><Presentation size={24} /><span>{deck.slides.length} {deck.slides.length === 1 ? 'slide' : 'slides'}</span></span>
          <span className="slides-deck-card-copy"><strong>{deck.title || 'Untitled presentation'}</strong><small>Edited {formatDate(deck.updatedAt)}</small></span><ArrowRight size={16} className="slides-deck-arrow" />
        </button>)}</div> : <div className="slides-empty glass-card"><div className="slides-empty-art"><Presentation size={28} /><span><i /><i /><i /></span></div><h2>Your first presentation starts here</h2><p>Make a small deck, edit each slide, then present it or print/save it as a PDF from your browser.</p><div className="slides-empty-actions"><button className="button-primary" onClick={beginDeck}><Plus size={16} /> Create a presentation</button><button className="button-secondary" onClick={() => inputRef.current?.click()}><FileUp size={15} /> Import a JSON deck</button></div></div>}
      </section>}

      {!activeDeck && slidesCloudReady && slidesCloudOpen && <SlidesCloudPanel deck={null} hasUnsavedChanges={unsaved} onRestore={restoreCloudCopy} onGoToTeam={onGoToTeam} />}

      {activeDeck && activeSlide && <OfficeWorkbenchLayout className="slides-workbench-layout" rail={<OfficeAiPromptWorkbench
        area="slides"
        description="Draft body text for the active slide, review the before/after preview, then apply it explicitly."
        targetId={aiTargetId}
        targetLabel={`slide ${activeSlideIndex + 1} body`}
        currentValue={activeSlide.body}
        currentValueLabel="Current slide text"
        proposedValueLabel="Proposed slide text"
        promptPlaceholder="For example: write three concise points about a fictional community garden launch."
        privacyNote="Only your typed prompt is sent. Active slide text, speaker notes, images, deck title, and other slides are not sent."
        applyLabel="Apply to slide"
        maxPromptChars={900}
        liveActionVerified={false}
        buildPrompt={(prompt) => `Draft plain-text body content for one slide, using only facts supplied in my prompt. Return one line per idea; do not include explanations, Markdown fences, or invented details. User request: ${prompt}`}
        previewResult={previewAiSlideText}
        onApply={(candidate, capturedTargetId) => {
          const latest = currentStateRef.current;
          if (!latest || !activeDeck || !activeSlide || capturedTargetId !== aiTargetId
            || currentSelectionRef.current.deckId !== activeDeck.id || currentSelectionRef.current.slideId !== activeSlide.id
            || candidate.length > 12_000) return false;
          const latestSlide = latest.decks.find((deck) => deck.id === activeDeck.id)?.slides.find((slide) => slide.id === activeSlide.id);
          if (!latestSlide || latestSlide.body !== activeSlide.body) return false;
          if (latestSlide.body === candidate) return true;
          return commitActiveDeckEdit(updateSlide(latest, activeDeck.id, activeSlide.id, { body: candidate }), activeSlide.id, `slide:${activeSlide.id}:body`);
        }}
      />}>
        <>
        <div className="slides-editor-toolbar">
          <label className="slides-deck-name"><span className="eyebrow">PRESENTATION TITLE</span><input aria-label="Presentation title" value={activeDeck.title} maxLength={300} onChange={(event) => patchDeck({ title: event.target.value })} /></label>
          <div className="slides-toolbar-actions">
            <label className="slides-theme-picker"><span className="eyebrow">THEME</span><select aria-label="Slide theme" value={activeDeck.theme} onChange={(event) => patchDeck({ theme: event.target.value as SlidesTheme })}>{(Object.keys(themeNames) as SlidesTheme[]).map((theme) => <option key={theme} value={theme}>{themeNames[theme]}</option>)}</select></label>
            {slidesCloudReady && <button className="button-secondary small-button" aria-expanded={slidesCloudOpen} onClick={() => setSlidesCloudOpen((open) => !open)}>{slidesCloudOpen ? 'Hide cloud copies' : 'Cloud copies'}</button>}
            <div className="slides-history-actions" role="group" aria-label="Edit history for this presentation, up to 50 changes in this session">
              <button type="button" className="button-secondary" aria-label="Undo" aria-keyshortcuts="Control+Z Meta+Z" title="Undo last Slides edit (Ctrl/Cmd+Z)" disabled={!canUndo} onClick={undoEdit}><Undo2 size={15} /><span>Undo</span></button>
              <button type="button" className="button-secondary" aria-label="Redo" aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y Meta+Y" title="Redo last Slides edit (Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y)" disabled={!canRedo} onClick={redoEdit}><Redo2 size={15} /><span>Redo</span></button>
              <span className="slides-history-live" role="status" aria-live="polite">{historyAnnouncement}</span>
            </div>
            <button className="icon-button" title="Download presentation JSON" aria-label="Download presentation JSON" onClick={() => downloadJson(activeDeck)}><Download size={16} /></button>
            <button className="icon-button" title="Download editable PowerPoint" aria-label="Download PowerPoint PPTX" disabled={pptxExporting} onClick={() => void downloadPptx(activeDeck)}><FileText size={16} /></button>
            <button className="icon-button" title="Print or save as PDF" aria-label="Print or save as PDF" onClick={() => { void printPresentation(); }}><Printer size={16} /></button>
            <button className="button-present" disabled={!canPresent} title={canPresent ? 'Present this local deck' : 'Wait for local images to load or replace unavailable images'} onClick={() => setPresenting(true)}><Maximize2 size={15} /> Present</button>
            <button className="icon-button danger-icon" title="Delete presentation" aria-label="Delete presentation" onClick={deletePresentation}><Trash2 size={16} /></button>
          </div>
        </div>

        {slidesCloudReady && slidesCloudOpen && <SlidesCloudPanel deck={activeDeck} hasUnsavedChanges={unsaved} onRestore={restoreCloudCopy} onGoToTeam={onGoToTeam} />}

        <div className="slides-editor-layout">
          <aside className="slides-rail glass-card" aria-label="Slide list">
            <div className="slides-rail-heading"><div><span className="eyebrow">SLIDES</span><strong>{String(activeSlideIndex + 1).padStart(2, '0')} <span>/ {String(activeDeck.slides.length).padStart(2, '0')}</span></strong></div><button className="icon-button" aria-label="Add slide" title="Add slide" onClick={addNewSlide}><Plus size={16} /></button></div>
            <div className="slides-thumbnails">{activeDeck.slides.map((slide, index) => <button key={slide.id} className={`slides-thumbnail ${index === activeSlideIndex ? 'selected' : ''}`} aria-label={`Slide ${index + 1}: ${slide.title || 'Untitled slide'}`} aria-current={index === activeSlideIndex ? 'true' : undefined} onClick={() => setActiveSlideIndex(index)}><span className={`slides-thumbnail-canvas theme-${activeDeck.theme} slide-layout-${slide.layout}`}>{slide.imageAssetId && imageUrls[slide.imageAssetId] && <img className={`slides-thumbnail-image slide-image-fit-${slide.imageFit ?? 'contain'}`} src={imageUrls[slide.imageAssetId]} alt="" />}<strong>{slide.title || 'Untitled slide'}</strong><small>{slide.body || 'No slide text yet'}</small></span><span className="slides-thumbnail-caption">{String(index + 1).padStart(2, '0')} · {slide.title || 'Untitled slide'}</span></button>)}</div>
          </aside>

          <section className="slides-workbench" aria-label="Slide editor">
            <div className="slides-canvas-wrap"><SlideCanvas deck={activeDeck} slide={activeSlide} index={activeSlideIndex} imageUrl={activeSlide.imageAssetId ? imageUrls[activeSlide.imageAssetId] : undefined} imageMissing={Boolean(activeSlide.imageAssetId && missingImageIds.includes(activeSlide.imageAssetId))} /></div>
            <div className="slides-page-controls">
              <span>Slide {activeSlideIndex + 1} of {activeDeck.slides.length}</span>
              <div><button className="icon-button" aria-label="Move slide up" title="Move slide up" disabled={activeSlideIndex === 0} onClick={() => shiftSlide(-1)}><ArrowUp size={15} /></button><button className="icon-button" aria-label="Move slide down" title="Move slide down" disabled={activeSlideIndex === activeDeck.slides.length - 1} onClick={() => shiftSlide(1)}><ArrowDown size={15} /></button><button className="icon-button" aria-label="Duplicate slide" title="Duplicate slide" disabled={activeDeck.slides.length >= 100} onClick={duplicateCurrentSlide}><Copy size={15} /></button><button className="icon-button danger-icon" aria-label="Delete slide" title="Delete slide" disabled={activeDeck.slides.length <= 1} onClick={deleteCurrentSlide}><Trash2 size={15} /></button></div>
            </div>
            <div className="slides-edit-fields glass-card">
              <input ref={imageInputRef} className="visually-hidden-input" type="file" accept="image/png,image/jpeg,image/webp" onChange={addLocalImage} aria-label="Choose a local slide image" />
              <label className="slides-layout-field"><span>Slide layout</span><select aria-label="Slide layout" value={activeSlide.layout} aria-describedby="slide-layout-help" onChange={(event) => patchSlide({ layout: event.target.value as SlideLayout })}>{SLIDE_LAYOUTS.map((layout) => <option key={layout} value={layout}>{layoutNames[layout]}</option>)}</select><small id="slide-layout-help">{layoutDescriptions[activeSlide.layout]} Changes appearance only; all text and notes stay intact.</small></label>
              <label><span>Slide title</span><input aria-label="Slide title" value={activeSlide.title} maxLength={12_000} onChange={(event) => patchSlide({ title: event.target.value })} placeholder="Give this slide a title" /></label>
              <label><span>Slide text</span><textarea aria-label="Slide text" value={activeSlide.body} maxLength={12_000} onChange={(event) => patchSlide({ body: event.target.value })} placeholder="Add a short paragraph or one idea per line" rows={4} /></label>
              <div className="slides-image-tools">
                <div className="slides-image-actions"><button type="button" className="button-secondary" onClick={() => imageInputRef.current?.click()}><ImagePlus size={15} /> {activeSlide.imageAssetId ? 'Replace local image' : 'Add local image'}</button>{activeSlide.imageAssetId && <button type="button" className="button-tertiary" onClick={removeLocalImage}>Remove from slide</button>}</div>
                <label><span>Image description (alt text)</span><input aria-label="Image description" value={activeSlide.imageAltText ?? ''} maxLength={500} onChange={(event) => patchSlide({ imageAltText: event.target.value })} placeholder="Describe the image, or leave blank if decorative" /></label>
                 <label><span>Image fit</span><select aria-label="Image fit" value={activeSlide.imageFit ?? 'contain'} onChange={(event) => patchSlide({ imageFit: event.target.value as SlideImageFit })}><option value="contain">Fit entire image</option><option value="cover">Fill image frame (crop)</option></select><small>Crop is visual only; the original image remains unchanged.</small></label>
                <small>PNG, JPEG, or WebP · up to 2 MB per image · kept in this browser unless you confirm a cloud copy. Removing from a slide is undoable; deleting the presentation clears its local image files.</small>
              </div>
              <label className="slides-notes-field"><span>Speaker notes <small>Stored in this local deck. A confirmed cloud copy shares them with workspace members.</small></span><textarea aria-label="Speaker notes" value={activeSlide.notes} maxLength={12_000} onChange={(event) => patchSlide({ notes: event.target.value })} placeholder="Add reminders for your talk" rows={3} /></label>
            </div>
          </section>
        </div>
        <div className="slides-editor-footer"><span><Check size={14} />{unsaved ? 'Unsaved · kept in this tab' : 'Saved in this browser'}</span><span>{feedback && !unsaved ? feedback : `${activeDeck.slides.length} slide${activeDeck.slides.length === 1 ? '' : 's'} · JSON export${slidesCloudReady ? ' and explicit cloud copy' : ''} available`}</span><span className="slides-history-note">Undo/redo: latest 50 edits for this presentation · this session only</span></div>
        </>
      </OfficeWorkbenchLayout>}

      {activeDeck && activeSlide && <div className="slide-print-stack" aria-hidden="true">{activeDeck.slides.map((slide, index) => <div className={`print-slide theme-${activeDeck.theme} slide-layout-${slide.layout} ${slide.imageAssetId ? 'has-image' : ''}`} key={slide.id}><div className="print-slide-content"><span className="eyebrow">{activeDeck.title || 'Untitled presentation'}</span><h1>{slide.title || 'Untitled slide'}</h1><SlideBody body={slide.body} cover={index === 0} layout={slide.layout} /></div>{slide.imageAssetId && imageUrls[slide.imageAssetId] && <img className={`print-slide-image slide-image-fit-${slide.imageFit ?? 'contain'}`} src={imageUrls[slide.imageAssetId]} alt={slide.imageAltText ?? ''} />}{slide.imageAssetId && missingImageIds.includes(slide.imageAssetId) && <span className="print-image-missing">Local image unavailable</span>}<small>{index + 1}</small></div>)}</div>}

      {presenting && activeDeck && activeSlide && <div className="slides-present-overlay" role="dialog" aria-modal="true" aria-label="Presentation mode"><button className="icon-button present-close" aria-label="Exit presentation" onClick={() => setPresenting(false)}><X size={19} /></button><div className="present-counter">{activeSlideIndex + 1} / {activeDeck.slides.length}</div><div className={`present-stage ${presenterNotesVisible ? 'with-notes' : ''}`}><SlideCanvas deck={activeDeck} slide={activeSlide} index={activeSlideIndex} large imageUrl={activeSlide.imageAssetId ? imageUrls[activeSlide.imageAssetId] : undefined} imageMissing={Boolean(activeSlide.imageAssetId && missingImageIds.includes(activeSlide.imageAssetId))} />{presenterNotesVisible && <aside id="presenter-notes-panel" className="presenter-notes-panel" aria-label="Presenter notes" role="region"><div className="presenter-notes-heading"><FileText size={15} /><strong>Presenter notes</strong></div><p>{activeSlide.notes || 'No notes for this slide.'}</p></aside>}</div><div className="present-controls"><button className="button-secondary" onClick={() => setActiveSlideIndex((index) => Math.max(0, index - 1))} disabled={activeSlideIndex === 0}><ArrowLeft size={16} /> Previous</button><div className="present-controls-center"><button className="button-secondary presenter-notes-toggle" aria-pressed={presenterNotesVisible} aria-controls="presenter-notes-panel" onClick={() => setPresenterNotesVisible((visible) => !visible)}><FileText size={15} /> {presenterNotesVisible ? 'Hide speaker notes' : 'Show speaker notes'}</button><span>Use arrow keys to navigate · Esc to exit</span></div><button className="button-primary" onClick={() => setActiveSlideIndex((index) => Math.min(activeDeck.slides.length - 1, index + 1))} disabled={activeSlideIndex === activeDeck.slides.length - 1}>Next <ArrowRight size={16} /></button></div></div>}
      {feedback && !activeDeck && <div className="slides-feedback" role="status">{feedback}</div>}
    </div>
  );
}

function SlideCanvas({ deck, slide, index, large = false, imageUrl, imageMissing = false }: { deck: PresentationDeck; slide: Slide; index: number; large?: boolean; imageUrl?: string; imageMissing?: boolean }) {
  return <article className={`slide-canvas theme-${deck.theme} slide-layout-${slide.layout} ${index === 0 ? 'slide-cover' : ''} ${large ? 'slide-canvas-large' : ''} ${slide.imageAssetId ? 'has-image' : ''}`} aria-label={`Slide ${index + 1}: ${slide.title || 'Untitled slide'}`}>
    <div className="slide-canvas-glow" /><span className="slide-canvas-brand"><Presentation size={14} /> COCCE SLIDES</span><div className="slide-canvas-content"><span className="slide-canvas-kicker">{slide.layout === 'section-divider' ? 'SECTION' : index === 0 ? 'A NEW PRESENTATION' : `IDEA ${String(index).padStart(2, '0')}`}</span><h2>{slide.title || <span className="slide-placeholder">Your title goes here</span>}</h2><SlideBody body={slide.body} cover={index === 0} layout={slide.layout} /></div>{slide.imageAssetId && <div className="slide-image-frame">{imageUrl ? <img className={`slide-local-image slide-image-fit-${slide.imageFit ?? 'contain'}`} src={imageUrl} alt={slide.imageAltText ?? ''} /> : <span>{imageMissing ? 'Local image unavailable' : 'Loading local image…'}</span>}</div>}<span className="slide-canvas-page">{String(index + 1).padStart(2, '0')}</span>
  </article>;
}

function SlideBody({ body, cover, layout }: { body: string; cover: boolean; layout: SlideLayout }) {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return <p className="slide-placeholder">Add text to bring this slide to life.</p>;
  if (layout === 'quote') return <blockquote className="slide-quote"><span className="slide-quote-mark" aria-hidden="true">“</span><div className="slide-quote-copy">{lines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}</div></blockquote>;
  if (layout === 'section-divider') return <div className="slide-section-copy">{lines.map((line, index) => <p key={`${index}-${line}`}>{line}</p>)}</div>;
  if (layout === 'two-column') {
    const splitAt = Math.ceil(lines.length / 2);
    const columns = [lines.slice(0, splitAt), lines.slice(splitAt)];
    return <div className="slide-two-columns">{columns.map((column, columnIndex) => <ul key={columnIndex}>{column.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul>)}</div>;
  }
  if (lines.length > 1) return <ul className={cover ? 'cover-points' : ''}>{lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul>;
  return <p className={cover ? 'slide-subtitle' : 'slide-paragraph'}>{lines[0]}</p>;
}

function safeFileName(name: string) { return name.trim().replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'untitled-presentation'; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'recently' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date); }
