import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronLeft, Copy,
  Download, FileText, FileUp, LockKeyhole, Maximize2, Plus, Presentation,
  Printer, Trash2, X,
} from 'lucide-react';
import {
  addSlide, createDeck, duplicateSlide, importDeck, moveSlide, readSlidesState,
  removeDeck, removeSlide, serializeDeck, SLIDES_STORAGE_KEY, updateDeck, updateSlide, writeSlidesState,
} from './lib/slidesStore';
import type { PresentationDeck, Slide, SlidesState, SlidesTheme } from './lib/slidesStore';
import './slides.css';

type Props = { workspaceId: string | null };

const themeNames: Record<SlidesTheme, string> = { violet: 'Violet glass', ocean: 'Ocean glass', ember: 'Ember glass' };
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

export default function SlidesWorkspace({ workspaceId }: Props) {
  const [loadResult, setLoadResult] = useState<LoadedSlides>(readSlidesForTab);
  const state = loadResult.state;
  const [activeDeckId, setActiveDeckId] = useState<string | null>(null);
  const [activeSlideIndex, setActiveSlideIndex] = useState(0);
  const [unsaved, setUnsaved] = useState(loadResult.recovered);
  const [presenting, setPresenting] = useState(false);
  const [presenterNotesVisible, setPresenterNotesVisible] = useState(false);
  const [feedback, setFeedback] = useState(loadResult.recovered ? 'Recovered unsaved edits from this tab. Retry save to keep them in local storage.' : '');
  const inputRef = useRef<HTMLInputElement>(null);

  const decks = useMemo(() => state?.decks.filter((deck) => deck.workspaceId === workspaceId) ?? [], [state, workspaceId]);
  const activeDeck = decks.find((deck) => deck.id === activeDeckId) ?? null;
  const activeSlide = activeDeck?.slides[activeSlideIndex] ?? null;

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
    setActiveDeckId(result.deck.id);
    setActiveSlideIndex(0);
  };

  const addNewSlide = () => {
    if (!state || !activeDeck) return;
    const result = addSlide(state, activeDeck.id);
    if (!result.slide) { setFeedback('A presentation can contain up to 100 slides.'); return; }
    persist(result.state);
    setActiveSlideIndex(activeDeck.slides.length);
  };

  const duplicateCurrentSlide = () => {
    if (!state || !activeDeck || !activeSlide) return;
    const result = duplicateSlide(state, activeDeck.id, activeSlide.id);
    if (!result.slide) { setFeedback('A presentation can contain up to 100 slides.'); return; }
    persist(result.state);
    setActiveSlideIndex(activeDeck.slides.findIndex((slide) => slide.id === activeSlide.id) + 1);
  };

  const deleteCurrentSlide = () => {
    if (!state || !activeDeck || !activeSlide || activeDeck.slides.length <= 1) return;
    persist(removeSlide(state, activeDeck.id, activeSlide.id));
    setActiveSlideIndex((index) => Math.min(index, activeDeck.slides.length - 2));
  };

  const shiftSlide = (direction: -1 | 1) => {
    if (!state || !activeDeck || !activeSlide) return;
    const target = activeSlideIndex + direction;
    if (target < 0 || target >= activeDeck.slides.length) return;
    persist(moveSlide(state, activeDeck.id, activeSlide.id, direction));
    setActiveSlideIndex(target);
  };

  const retrySave = () => {
    if (!state) return;
    try {
      writeSlidesState(window.localStorage, state);
      clearTabRecovery();
      setLoadResult({ state, error: null, recovered: false });
      setUnsaved(false);
      setFeedback('Saved on this device');
    } catch {
      setFeedback('Still not saved — browser storage is unavailable or full.');
    }
  };

  const downloadJson = (deck: PresentationDeck) => {
    const blob = new Blob([serializeDeck(deck)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${safeFileName(deck.title)}.cocce-slides.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setFeedback('Presentation JSON downloaded.');
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !state) return;
    if (file.size > 5_000_000) { setFeedback('That file is larger than the 5 MB import limit.'); return; }
    try {
      const imported = importDeck(await file.text(), workspaceId);
      const saved = persist({ ...state, decks: [imported, ...state.decks] });
      setActiveDeckId(imported.id);
      setActiveSlideIndex(0);
      if (saved) setFeedback('Presentation imported on this device.');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Could not read that presentation file.');
    }
  };

  const deletePresentation = () => {
    if (!state || !activeDeck) return;
    if (!window.confirm(`Delete “${activeDeck.title || 'Untitled presentation'}” from this browser?`)) return;
    persist(removeDeck(state, activeDeck.id));
    setActiveDeckId(null);
    setActiveSlideIndex(0);
  };

  const patchDeck = (patch: Partial<Pick<PresentationDeck, 'title' | 'theme'>>) => {
    if (state && activeDeck) persist(updateDeck(state, activeDeck.id, patch));
  };

  const patchSlide = (patch: Partial<Pick<Slide, 'title' | 'body' | 'notes'>>) => {
    if (state && activeDeck && activeSlide) persist(updateSlide(state, activeDeck.id, activeSlide.id, patch));
  };

  if (!state) {
    return <div className="page slides-page"><div className="slides-error glass-card" role="alert"><LockKeyhole size={18} /><div><strong>Saved presentations are protected</strong><p>{loadResult.error}</p></div></div></div>;
  }

  return (
    <div className="page slides-page">
      <div className="slides-page-heading">
        <div>
          <span className="eyebrow">COCCE SLIDES · LOCAL MODE</span>
          <h1>{activeDeck ? 'Edit presentation' : 'Presentations'}</h1>
          <p className="page-lede">Create and edit simple presentations saved in this browser. PPTX, cloud sync, and co-editing are not connected.</p>
        </div>
        <div className="slides-heading-actions">
          {activeDeck ? <button className="button-secondary" onClick={() => { setActiveDeckId(null); setActiveSlideIndex(0); }}><ChevronLeft size={16} /> All presentations</button> : <button className="button-primary" onClick={beginDeck}><Plus size={17} /> New presentation</button>}
        </div>
      </div>

      <div className="slides-local-note"><LockKeyhole size={14} /><span>Saved in this browser, scoped to <strong>{workspaceId ? 'this local workspace' : 'Personal space'}</strong>. Export JSON to move a deck to another device.</span></div>
      {unsaved && <div className="slides-unsaved" role="alert"><span>{feedback}</span><button className="button-tertiary" onClick={retrySave}>Retry save</button></div>}

      {!activeDeck && <section className="slides-library">
        <div className="slides-library-toolbar">
          <div><span className="eyebrow">YOUR DECKS</span><h2>{decks.length ? `${decks.length} ${decks.length === 1 ? 'presentation' : 'presentations'}` : 'A clear canvas'}</h2></div>
          <div className="slides-library-actions">
            <input ref={inputRef} className="visually-hidden-input" type="file" accept="application/json,.json" onChange={importFile} aria-label="Choose a presentation JSON file" />
            <button className="button-secondary" onClick={() => inputRef.current?.click()}><FileUp size={15} /> Import JSON</button>
            {decks.length > 0 && <button className="button-primary" onClick={beginDeck}><Plus size={16} /> New presentation</button>}
          </div>
        </div>
        {decks.length ? <div className="slides-deck-grid">{decks.map((deck) => <button className="slides-deck-card glass-card" key={deck.id} onClick={() => { setActiveDeckId(deck.id); setActiveSlideIndex(0); }}>
          <span className={`slides-deck-preview theme-${deck.theme}`}><Presentation size={24} /><span>{deck.slides.length} {deck.slides.length === 1 ? 'slide' : 'slides'}</span></span>
          <span className="slides-deck-card-copy"><strong>{deck.title || 'Untitled presentation'}</strong><small>Edited {formatDate(deck.updatedAt)}</small></span><ArrowRight size={16} className="slides-deck-arrow" />
        </button>)}</div> : <div className="slides-empty glass-card"><div className="slides-empty-art"><Presentation size={28} /><span><i /><i /><i /></span></div><h2>Your first presentation starts here</h2><p>Make a small deck, edit each slide, then present it or print/save it as a PDF from your browser.</p><div className="slides-empty-actions"><button className="button-primary" onClick={beginDeck}><Plus size={16} /> Create a presentation</button><button className="button-secondary" onClick={() => inputRef.current?.click()}><FileUp size={15} /> Import a JSON deck</button></div></div>}
      </section>}

      {activeDeck && activeSlide && <>
        <div className="slides-editor-toolbar">
          <label className="slides-deck-name"><span className="eyebrow">PRESENTATION TITLE</span><input aria-label="Presentation title" value={activeDeck.title} maxLength={300} onChange={(event) => patchDeck({ title: event.target.value })} /></label>
          <div className="slides-toolbar-actions">
            <label className="slides-theme-picker"><span className="eyebrow">THEME</span><select aria-label="Slide theme" value={activeDeck.theme} onChange={(event) => patchDeck({ theme: event.target.value as SlidesTheme })}>{(Object.keys(themeNames) as SlidesTheme[]).map((theme) => <option key={theme} value={theme}>{themeNames[theme]}</option>)}</select></label>
            <button className="icon-button" title="Download presentation JSON" aria-label="Download presentation JSON" onClick={() => downloadJson(activeDeck)}><Download size={16} /></button>
            <button className="icon-button" title="Print or save as PDF" aria-label="Print or save as PDF" onClick={() => window.print()}><Printer size={16} /></button>
            <button className="button-present" onClick={() => setPresenting(true)}><Maximize2 size={15} /> Present</button>
            <button className="icon-button danger-icon" title="Delete presentation" aria-label="Delete presentation" onClick={deletePresentation}><Trash2 size={16} /></button>
          </div>
        </div>

        <div className="slides-editor-layout">
          <aside className="slides-rail glass-card" aria-label="Slide list">
            <div className="slides-rail-heading"><div><span className="eyebrow">SLIDES</span><strong>{String(activeSlideIndex + 1).padStart(2, '0')} <span>/ {String(activeDeck.slides.length).padStart(2, '0')}</span></strong></div><button className="icon-button" aria-label="Add slide" title="Add slide" onClick={addNewSlide}><Plus size={16} /></button></div>
            <div className="slides-thumbnails">{activeDeck.slides.map((slide, index) => <button key={slide.id} className={`slides-thumbnail ${index === activeSlideIndex ? 'selected' : ''}`} aria-label={`Slide ${index + 1}: ${slide.title || 'Untitled slide'}`} aria-current={index === activeSlideIndex ? 'true' : undefined} onClick={() => setActiveSlideIndex(index)}><span className={`slides-thumbnail-canvas theme-${activeDeck.theme}`}><strong>{slide.title || 'Untitled slide'}</strong><small>{slide.body || 'No slide text yet'}</small></span><span className="slides-thumbnail-caption">{String(index + 1).padStart(2, '0')} · {slide.title || 'Untitled slide'}</span></button>)}</div>
          </aside>

          <section className="slides-workbench" aria-label="Slide editor">
            <div className="slides-canvas-wrap"><SlideCanvas deck={activeDeck} slide={activeSlide} index={activeSlideIndex} /></div>
            <div className="slides-page-controls">
              <span>Slide {activeSlideIndex + 1} of {activeDeck.slides.length}</span>
              <div><button className="icon-button" aria-label="Move slide up" title="Move slide up" disabled={activeSlideIndex === 0} onClick={() => shiftSlide(-1)}><ArrowUp size={15} /></button><button className="icon-button" aria-label="Move slide down" title="Move slide down" disabled={activeSlideIndex === activeDeck.slides.length - 1} onClick={() => shiftSlide(1)}><ArrowDown size={15} /></button><button className="icon-button" aria-label="Duplicate slide" title="Duplicate slide" disabled={activeDeck.slides.length >= 100} onClick={duplicateCurrentSlide}><Copy size={15} /></button><button className="icon-button danger-icon" aria-label="Delete slide" title="Delete slide" disabled={activeDeck.slides.length <= 1} onClick={deleteCurrentSlide}><Trash2 size={15} /></button></div>
            </div>
            <div className="slides-edit-fields glass-card">
              <label><span>Slide title</span><input aria-label="Slide title" value={activeSlide.title} maxLength={12_000} onChange={(event) => patchSlide({ title: event.target.value })} placeholder="Give this slide a title" /></label>
              <label><span>Slide text</span><textarea aria-label="Slide text" value={activeSlide.body} maxLength={12_000} onChange={(event) => patchSlide({ body: event.target.value })} placeholder="Add a short paragraph or one idea per line" rows={4} /></label>
              <label className="slides-notes-field"><span>Speaker notes <small>Only you can see these in this local deck.</small></span><textarea aria-label="Speaker notes" value={activeSlide.notes} maxLength={12_000} onChange={(event) => patchSlide({ notes: event.target.value })} placeholder="Add reminders for your talk" rows={3} /></label>
            </div>
          </section>
        </div>
        <div className="slides-editor-footer"><span><Check size={14} />{unsaved ? 'Unsaved · kept in this tab' : 'Saved in this browser'}</span><span>{feedback && !unsaved ? feedback : `${activeDeck.slides.length} slide${activeDeck.slides.length === 1 ? '' : 's'} · JSON export available`}</span></div>
        <div className="slide-print-stack" aria-hidden="true">{activeDeck.slides.map((slide, index) => <div className={`print-slide theme-${activeDeck.theme}`} key={slide.id}><span className="eyebrow">{activeDeck.title || 'Untitled presentation'}</span><h1>{slide.title || 'Untitled slide'}</h1><SlideBody body={slide.body} cover={index === 0} /><small>{index + 1}</small></div>)}</div>
      </>}

      {presenting && activeDeck && activeSlide && <div className="slides-present-overlay" role="dialog" aria-modal="true" aria-label="Presentation mode"><button className="icon-button present-close" aria-label="Exit presentation" onClick={() => setPresenting(false)}><X size={19} /></button><div className="present-counter">{activeSlideIndex + 1} / {activeDeck.slides.length}</div><div className={`present-stage ${presenterNotesVisible ? 'with-notes' : ''}`}><SlideCanvas deck={activeDeck} slide={activeSlide} index={activeSlideIndex} large />{presenterNotesVisible && <aside id="presenter-notes-panel" className="presenter-notes-panel" aria-label="Presenter notes" role="region"><div className="presenter-notes-heading"><FileText size={15} /><strong>Presenter notes</strong></div><p>{activeSlide.notes || 'No notes for this slide.'}</p></aside>}</div><div className="present-controls"><button className="button-secondary" onClick={() => setActiveSlideIndex((index) => Math.max(0, index - 1))} disabled={activeSlideIndex === 0}><ArrowLeft size={16} /> Previous</button><div className="present-controls-center"><button className="button-secondary presenter-notes-toggle" aria-pressed={presenterNotesVisible} aria-controls="presenter-notes-panel" onClick={() => setPresenterNotesVisible((visible) => !visible)}><FileText size={15} /> {presenterNotesVisible ? 'Hide speaker notes' : 'Show speaker notes'}</button><span>Use arrow keys to navigate · Esc to exit</span></div><button className="button-primary" onClick={() => setActiveSlideIndex((index) => Math.min(activeDeck.slides.length - 1, index + 1))} disabled={activeSlideIndex === activeDeck.slides.length - 1}>Next <ArrowRight size={16} /></button></div></div>}
      {feedback && !activeDeck && <div className="slides-feedback" role="status">{feedback}</div>}
    </div>
  );
}

function SlideCanvas({ deck, slide, index, large = false }: { deck: PresentationDeck; slide: Slide; index: number; large?: boolean }) {
  return <article className={`slide-canvas theme-${deck.theme} ${index === 0 ? 'slide-cover' : ''} ${large ? 'slide-canvas-large' : ''}`} aria-label={`Slide ${index + 1}: ${slide.title || 'Untitled slide'}`}>
    <div className="slide-canvas-glow" /><span className="slide-canvas-brand"><Presentation size={14} /> COCCE SLIDES</span><div className="slide-canvas-content"><span className="slide-canvas-kicker">{index === 0 ? 'A NEW PRESENTATION' : `IDEA ${String(index).padStart(2, '0')}`}</span><h2>{slide.title || <span className="slide-placeholder">Your title goes here</span>}</h2><SlideBody body={slide.body} cover={index === 0} /></div><span className="slide-canvas-page">{String(index + 1).padStart(2, '0')}</span>
  </article>;
}

function SlideBody({ body, cover }: { body: string; cover: boolean }) {
  const lines = body.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return <p className="slide-placeholder">Add text to bring this slide to life.</p>;
  if (lines.length > 1) return <ul className={cover ? 'cover-points' : ''}>{lines.map((line, index) => <li key={`${index}-${line}`}>{line}</li>)}</ul>;
  return <p className={cover ? 'slide-subtitle' : 'slide-paragraph'}>{lines[0]}</p>;
}

function safeFileName(name: string) { return name.trim().replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '').toLowerCase() || 'untitled-presentation'; }
function formatDate(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? 'recently' : new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date); }
