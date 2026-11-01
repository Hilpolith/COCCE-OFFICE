import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import * as pdfjsLib from 'pdfjs-dist/build/pdf.min.mjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ArrowDownToLine, ArrowLeft, ArrowRight, BookOpenText, Check, FilePlus2, FileText, Files, LoaderCircle, RotateCw, Search, Upload } from 'lucide-react';
import { localDriveRepository } from './lib/driveStore';
import type { DriveFile, DriveRepository } from './lib/driveStore';
import { extractPdfPages, mergePdfFiles, parsePageRange, reorderPdfPages, rotatePdfPage } from './lib/pdfTools';
import './pdf.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface Props { workspaceId: string | null; repository?: DriveRepository }
interface SearchHit { page: number; excerpt: string }

const isPdf = (file: DriveFile) => file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
const toArrayBuffer = (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};
const outputName = (name: string, suffix: string) => `${name.replace(/\.pdf$/i, '')}-${suffix}.pdf`;

export default function PdfWorkspace({ workspaceId, repository = localDriveRepository }: Props) {
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [previewRotation, setPreviewRotation] = useState(0);
  const [pageOrder, setPageOrder] = useState<number[]>([]);
  const [pageRange, setPageRange] = useState('1');
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [canvasReady, setCanvasReady] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectedFile = useMemo(() => files.find((file) => file.id === selectedId) ?? files[0] ?? null, [files, selectedId]);
  const selectedFileId = selectedFile?.id;

  const refreshFiles = useCallback(async () => {
    setListLoading(true);
    try {
      const result = (await repository.listFiles(workspaceId)).filter(isPdf);
      setFiles(result);
      setSelectedId((current) => result.some((file) => file.id === current) ? current : result[0]?.id ?? '');
      setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read local PDF files.'); }
    finally { setListLoading(false); }
  }, [repository, workspaceId]);

  useEffect(() => {
    let active = true;
    void repository.listFiles(workspaceId)
      .then((result) => {
        if (!active) return;
        const pdfs = result.filter(isPdf);
        setFiles(pdfs);
        setSelectedId((current) => pdfs.some((file) => file.id === current) ? current : pdfs[0]?.id ?? '');
        setError('');
      })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not read local PDF files.'); })
      .finally(() => { if (active) setListLoading(false); });
    return () => { active = false; };
  }, [repository, workspaceId]);

  useEffect(() => {
    if (!selectedFileId) return undefined;
    let active = true;
    let loadingTask: PDFDocumentLoadingTask | undefined;
    void repository.readFile(selectedFileId, workspaceId).then(async ({ blob }) => {
      const data = new Uint8Array(await blob.arrayBuffer());
      loadingTask = pdfjsLib.getDocument({ data });
      const document = await loadingTask.promise;
      if (!active) return;
      setPdfDocument(document);
      setCurrentPage(1);
      setPreviewRotation(0);
      setPageRange('1');
      setPageOrder(Array.from({ length: document.numPages }, (_, index) => index + 1));
      setSearchHits([]);
    }).catch((cause: unknown) => {
      if (active) {
        setPdfDocument(null);
        setPreviewError(cause instanceof Error ? cause.message : 'This file could not be opened as a PDF.');
      }
    });
    return () => { active = false; if (loadingTask) void loadingTask.destroy(); };
  }, [repository, selectedFileId, workspaceId]);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current) return undefined;
    let active = true;
    let renderTask: RenderTask | undefined;
    void pdfDocument.getPage(currentPage).then(async (page) => {
      if (!active || !canvasRef.current) return;
      const viewport = page.getViewport({ scale: 1.22, rotation: previewRotation });
      const canvas = canvasRef.current;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is not available in this browser.');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      renderTask = page.render({ canvas, canvasContext: context, viewport });
      await renderTask.promise;
      if (active) { setCanvasReady(true); setPreviewError(''); }
    }).catch((cause: unknown) => {
      if (active) setPreviewError(cause instanceof Error ? cause.message : 'Could not render this PDF page.');
    });
    return () => { active = false; renderTask?.cancel(); };
  }, [pdfDocument, currentPage, previewRotation]);

  const selectFile = (id: string) => {
    setSelectedId(id);
    setPdfDocument(null);
    setCanvasReady(false);
    setPreviewError('');
    setCurrentPage(1);
    setNotice('');
    setError('');
  };

  const navigateToPage = (page: number) => { setCanvasReady(false); setCurrentPage(page); };
  const rotateView = () => { setCanvasReady(false); setPreviewRotation((rotation) => (rotation + 90) % 360); };

  const uploadFiles = async (inputFiles: File[]) => {
    if (!inputFiles.length) return;
    setBusy(true);
    setNotice('');
    setError('');
    const errors: string[] = [];
    let firstSavedId = '';
    for (const file of inputFiles) {
      if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
        errors.push(`${file.name}: only PDF files can be opened here.`);
        continue;
      }
      try {
        const saved = await repository.saveFile(file, workspaceId);
        firstSavedId ||= saved.id;
      } catch (cause) { errors.push(`${file.name}: ${cause instanceof Error ? cause.message : 'could not be saved'}`); }
    }
    await refreshFiles();
    if (firstSavedId) selectFile(firstSavedId);
    setBusy(false);
    if (firstSavedId) setNotice('PDF saved in this browser and added to Drive. No server upload occurred.');
    if (errors.length) setError(errors.join(' '));
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    void uploadFiles(selected);
  };

  const readSelectedBytes = async () => {
    if (!selectedFile) throw new Error('Choose a PDF file first.');
    const result = await repository.readFile(selectedFile.id, workspaceId);
    return new Uint8Array(await result.blob.arrayBuffer());
  };

  const savePdfCopy = async (filename: string, bytes: Uint8Array, message: string) => {
    const output = new File([toArrayBuffer(bytes)], filename, { type: 'application/pdf' });
    const saved = await repository.saveFile(output, workspaceId);
    await refreshFiles();
    selectFile(saved.id);
    setNotice(message);
  };

  const exportRotatedPage = async () => {
    if (!selectedFile) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const bytes = await rotatePdfPage(await readSelectedBytes(), currentPage, 90);
      await savePdfCopy(outputName(selectedFile.name, `page-${currentPage}-rotated`), bytes, `Created a new copy with page ${currentPage} rotated.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rotate this PDF page.'); }
    finally { setBusy(false); }
  };

  const exportExtract = async () => {
    if (!selectedFile || !pdfDocument) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const pages = parsePageRange(pageRange, pdfDocument.numPages);
      const bytes = await extractPdfPages(await readSelectedBytes(), pages);
      await savePdfCopy(outputName(selectedFile.name, `pages-${pages.join('-')}`), bytes, `Saved ${pages.length} selected page${pages.length === 1 ? '' : 's'} as a new PDF copy.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not extract those pages.'); }
    finally { setBusy(false); }
  };

  const movePageInOrder = (direction: -1 | 1) => {
    const position = pageOrder.indexOf(currentPage);
    const target = position + direction;
    if (position < 0 || target < 0 || target >= pageOrder.length) return;
    const next = [...pageOrder];
    [next[position], next[target]] = [next[target], next[position]];
    setPageOrder(next);
  };

  const exportReordered = async () => {
    if (!selectedFile || pageOrder.length < 2) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const bytes = await reorderPdfPages(await readSelectedBytes(), pageOrder);
      await savePdfCopy(outputName(selectedFile.name, 'reordered'), bytes, 'Saved a reordered copy; the original PDF was not changed.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not reorder PDF pages.'); }
    finally { setBusy(false); }
  };

  const mergeSelected = async () => {
    const selected = files.filter((file) => mergeIds.includes(file.id));
    if (selected.length < 2) { setError('Select at least two PDFs to merge.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const sources = await Promise.all(selected.map(async (file) => {
        const { blob } = await repository.readFile(file.id, workspaceId);
        return new Uint8Array(await blob.arrayBuffer());
      }));
      const merged = await mergePdfFiles(sources);
      await savePdfCopy(outputName(selected[0].name, 'merged'), merged, `Merged ${selected.length} PDFs into a new local copy.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not merge the selected PDFs.'); }
    finally { setBusy(false); }
  };

  const toggleMerge = (id: string) => setMergeIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);

  const runSearch = async () => {
    if (!pdfDocument || !searchTerm.trim()) { setSearchHits([]); return; }
    setSearching(true); setError(''); setSearchHits([]);
    try {
      const hits: SearchHit[] = [];
      const needle = searchTerm.trim().toLocaleLowerCase();
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);
        const textContent = await page.getTextContent();
        const text = textContent.items.map((item) => 'str' in item ? item.str : '').join(' ').replace(/\s+/g, ' ').trim();
        const index = text.toLocaleLowerCase().indexOf(needle);
        if (index >= 0) hits.push({ page: pageNumber, excerpt: text.slice(Math.max(0, index - 45), Math.min(text.length, index + needle.length + 55)) });
      }
      setSearchHits(hits);
      if (!hits.length) setNotice(`No matches for “${searchTerm.trim()}” in this PDF.`);
      else navigateToPage(hits[0].page);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not search this PDF.'); }
    finally { setSearching(false); }
  };

  const downloadOriginal = async () => {
    if (!selectedFile) return;
    try {
      const { blob, file } = await repository.readFile(selectedFile.id, workspaceId);
      const url = URL.createObjectURL(blob);
      const anchor = window.document.createElement('a');
      anchor.href = url; anchor.download = file.name; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not download this PDF.'); }
  };

  return (
    <div className="page subpage pdf-page">
      <div className="page-title-row pdf-title-row"><div><span className="eyebrow">COCCE PDF · BROWSER-LOCAL MODE</span><h1>PDF workspace</h1><p className="page-lede">View, search and create edited copies of PDFs stored in this browser. Originals remain unchanged; nothing is sent to a server.</p></div><div className="pdf-title-actions"><button className="button-primary" onClick={() => inputRef.current?.click()} disabled={busy}><Upload size={15} /> Add PDF</button><input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple className="visually-hidden" aria-label="Choose PDF files to save locally" onChange={onFileInput} /></div></div>

      <div className="pdf-local-note glass-card"><span className="pdf-note-icon"><BookOpenText size={18} /></span><div><strong>Local PDF tools</strong><small>Files are held in this browser’s COCCE Drive store. This does not provide cloud sharing, secure links, or a server backup. Per-file storage is limited to 25 MB.</small></div></div>
      {notice && <div className="pdf-feedback" role="status"><Check size={15} />{notice}</div>}
      {error && <div className="pdf-feedback pdf-error" role="alert">{error}</div>}

      <div className="pdf-workspace-layout">
        <aside className="pdf-library glass-card" aria-label="PDF files in this browser"><div className="pdf-library-heading"><div><span className="eyebrow">MY PDFs</span><strong>{files.length} local {files.length === 1 ? 'file' : 'files'}</strong></div><button className="icon-button" aria-label="Add a PDF" onClick={() => inputRef.current?.click()}><FilePlus2 size={16} /></button></div>
          {listLoading ? <div className="pdf-library-empty" role="status">Reading local files…</div> : files.length ? <div className="pdf-library-list">{files.map((file) => <article key={file.id} className={`pdf-library-item ${selectedFile?.id === file.id ? 'pdf-library-item-active' : ''}`}><button className="pdf-library-open" onClick={() => selectFile(file.id)}><span className="pdf-library-file-icon"><FileText size={17} /></span><span><strong title={file.name}>{file.name}</strong><small>{formatBytes(file.size)} · PDF</small></span></button><label className="pdf-merge-checkbox"><input type="checkbox" checked={mergeIds.includes(file.id)} onChange={() => toggleMerge(file.id)} aria-label={`Select ${file.name} for merge`} title="Select for merge" /></label></article>)}</div> : <div className="pdf-library-empty"><FileText size={22} /><p>No PDFs saved in this browser yet.</p><button className="button-tertiary" onClick={() => inputRef.current?.click()}><Upload size={14} /> Add a PDF</button></div>}
          {files.length > 1 && <div className="pdf-merge-action"><button className="button-secondary" onClick={() => void mergeSelected()} disabled={busy}><Files size={14} /> Merge selected ({mergeIds.length})</button><small>Creates a new PDF copy in Drive.</small></div>}
        </aside>

        <section className="pdf-viewer-panel glass-card" aria-label="PDF viewer">
          {selectedFile ? <>
            <div className="pdf-viewer-toolbar"><div className="pdf-viewer-title"><FileText size={17} /><strong title={selectedFile.name}>{selectedFile.name}</strong></div><div className="pdf-viewer-actions"><button className="icon-button" onClick={() => void downloadOriginal()} aria-label="Download original PDF" title="Download original"><ArrowDownToLine size={15} /></button></div></div>
            {previewError ? <div className="pdf-load-error" role="alert">{previewError}<small>Try another PDF or a smaller, unencrypted file.</small></div> : !pdfDocument ? <div className="pdf-loading" role="status"><LoaderCircle size={18} className="pdf-spinner" /> Opening PDF locally…</div> : <>
              <div className="pdf-page-toolbar"><button className="icon-button" onClick={() => navigateToPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1} aria-label="Previous page"><ArrowLeft size={15} /></button><label>Page <input aria-label="PDF page number" type="number" min={1} max={pdfDocument.numPages} value={currentPage} onChange={(event) => { const parsed = Number(event.target.value); if (Number.isInteger(parsed)) navigateToPage(Math.min(pdfDocument.numPages, Math.max(1, parsed))); }} /> of {pdfDocument.numPages}</label><button className="icon-button" onClick={() => navigateToPage(Math.min(pdfDocument.numPages, currentPage + 1))} disabled={currentPage >= pdfDocument.numPages} aria-label="Next page"><ArrowRight size={15} /></button><span className="pdf-page-toolbar-spacer" /><button className="button-tertiary" onClick={rotateView}><RotateCw size={14} /> View rotation</button></div>
              <div className="pdf-canvas-wrap"><canvas ref={canvasRef} className={`pdf-canvas ${canvasReady ? 'pdf-canvas-ready' : ''}`} aria-label={`PDF page ${currentPage}`} role="img" />{!canvasReady && !previewError && <div className="pdf-canvas-overlay" role="status"><LoaderCircle size={17} className="pdf-spinner" /> Rendering page…</div>}</div>
              <p className="pdf-viewer-footnote">Page text is rendered for viewing. Search below checks extracted text; selecting text on the page, annotations, highlights, and comments are not implemented.</p>
              <div className="pdf-search-row"><label className="pdf-search-input"><Search size={15} /><input aria-label="Search text in PDF" value={searchTerm} onChange={(event) => setSearchTerm(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }} placeholder="Find text in this PDF" /></label><button className="button-secondary" onClick={() => void runSearch()} disabled={searching || !searchTerm.trim()}>{searching ? 'Searching…' : 'Search'}</button></div>
              {searchHits.length > 0 && <div className="pdf-search-results" aria-label="PDF search results"><strong>{searchHits.length} matching page{searchHits.length === 1 ? '' : 's'}</strong>{searchHits.map((hit) => <button key={hit.page} onClick={() => navigateToPage(hit.page)}><span>Page {hit.page}</span><small>{hit.excerpt}</small></button>)}</div>}
              <section className="pdf-edit-tools"><div className="pdf-tools-heading"><div><span className="eyebrow">COPY-BASED PAGE TOOLS</span><h2>Create a new PDF copy</h2></div><span className="pdf-original-badge">Original stays unchanged</span></div>
                <div className="pdf-tool-card"><div><strong>Rotate current page</strong><small>Apply a 90° rotation to page {currentPage} in a saved copy.</small></div><button className="button-tertiary" onClick={() => void exportRotatedPage()} disabled={busy}><RotateCw size={14} /> Rotate copy</button></div>
                <div className="pdf-tool-card pdf-tool-range"><div><strong>Extract pages</strong><small>Enter individual page numbers or inclusive ranges, such as 1-3,5.</small></div><div className="pdf-tool-controls"><input aria-label="Pages to extract" value={pageRange} onChange={(event) => setPageRange(event.target.value)} /><button className="button-tertiary" onClick={() => void exportExtract()} disabled={busy}>Extract copy</button></div></div>
                <div className="pdf-tool-card pdf-tool-range"><div><strong>Reorder pages</strong><small>Move the current page in the order list, then save the reordered copy.</small></div><div className="pdf-tool-controls"><button className="button-tertiary" onClick={() => movePageInOrder(-1)} disabled={busy || pageOrder.indexOf(currentPage) <= 0}>Move earlier</button><button className="button-tertiary" onClick={() => movePageInOrder(1)} disabled={busy || pageOrder.indexOf(currentPage) < 0 || pageOrder.indexOf(currentPage) >= pageOrder.length - 1}>Move later</button><button className="button-secondary" onClick={() => void exportReordered()} disabled={busy || pageOrder.length < 2}>Save order</button></div></div>
              </section>
            </>}
          </> : <div className="pdf-viewer-empty"><div className="pdf-empty-icon"><BookOpenText size={28} /></div><h2>Open a local PDF</h2><p>Choose a PDF already in this browser’s Drive, or add a file to get started.</p><button className="button-primary" onClick={() => inputRef.current?.click()}><Upload size={15} /> Add PDF</button></div>}
        </section>
      </div>
    </div>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes >= 10 * 1024 ? 0 : 1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
}
