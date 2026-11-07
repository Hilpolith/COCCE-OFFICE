import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrostedConfirm } from './FrostedConfirm';
import type { ChangeEvent, FormEvent } from 'react';
import * as pdfjsLib from 'pdfjs-dist/build/pdf.min.mjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import {
  ArrowDownToLine, ArrowLeft, ArrowRight, BookOpenText, Check, FilePlus2,
  FileText, Files, Highlighter, LoaderCircle, MessageSquare, RotateCw, Search,
  Strikethrough, Trash2, Underline, Undo2, Upload, X,
} from 'lucide-react';
import { localDriveRepository, MAX_LOCAL_FILE_BYTES } from './lib/driveStore';
import type { DriveFile, DriveRepository } from './lib/driveStore';
import {
  createPdfAnnotation, deletePdfAnnotation, deletePdfAnnotations, listPdfAnnotations,
  savePdfAnnotation, savePdfAnnotations,
} from './lib/pdfAnnotationStore';
import type { PdfAnnotation } from './lib/pdfAnnotationStore';
import {
  assertPdfAnnotationBundleMatchesSource, MAX_PDF_ANNOTATION_BUNDLE_BYTES,
  mergePdfAnnotationBundle, parsePdfAnnotationBundle, serializePdfAnnotationBundle,
} from './lib/pdfAnnotationInterchange';
import { capturePdfTextSelection } from './lib/pdfSelection';
import { pdfRectToViewportRect } from './lib/pdfSelection';
import type { PdfCapturedSelection, PdfViewportLike } from './lib/pdfSelection';
import { findPdfTextMatches } from './lib/pdfSearch';
import { mapPdfSearchTextRangeToItems, measurePdfSearchHitRects } from './lib/pdfSearchHighlights';
import type { PdfSearchOverlayRect } from './lib/pdfSearchHighlights';
import { pdfTextMarkToViewportLine } from './lib/pdfTextMarks';
import { createPdfAnnotatedCopy, fingerprintPdfBytes } from './lib/pdfAnnotatedCopy';
import {
  assertPdfMergeInputLimits, extractPdfPages, MAX_PDF_MERGE_INPUTS, MAX_PDF_MERGE_TOTAL_INPUT_BYTES,
  MAX_PDF_PAGE_OPERATION_PAGES, mergePdfFiles, parsePageRange, reorderPdfPages, rotatePdfPage,
} from './lib/pdfTools';
import './pdf.css';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

interface PdfTextLayerInstance { render(): Promise<unknown>; cancel(): void }
const PdfTextLayer = (pdfjsLib as unknown as {
  TextLayer: new (options: { textContentSource: unknown; container: HTMLElement; viewport: unknown }) => PdfTextLayerInstance;
}).TextLayer;

interface Props { workspaceId: string | null; repository?: DriveRepository }
interface SearchHit { page: number; offset: number; length: number; excerpt: string; segments: ReturnType<typeof mapPdfSearchTextRangeToItems> }
interface PageDimensions {
  width: number;
  height: number;
  viewport: PdfViewportLike;
  viewBox: readonly [number, number, number, number];
}
interface VerifiedPdfSnapshot { file: DriveFile; bytes: Uint8Array; fingerprint: string }
interface PdfAnnotationHistoryEntry { scope: string; added: PdfAnnotation[]; removed: PdfAnnotation[] }
const MAX_PDF_ANNOTATION_HISTORY = 50;
const PDF_PAGE_COPY_WARNING = 'This creates a separate browser-local PDF copy. Digital signatures may no longer be valid, and forms, embedded PDF features, bookmarks, attachments, or metadata may not be preserved. The local Office annotation sidecar is not copied. Original files and sidecars remain unchanged; nothing is uploaded.';

const isPdf = (file: DriveFile) => file.mimeType === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
const toArrayBuffer = (bytes: Uint8Array) => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};
const outputName = (name: string, suffix: string) => `${name.replace(/\.pdf$/i, '')}-${suffix}.pdf`;
const annotationBundleName = (name: string) => `${name.replace(/\.pdf$/i, '')}-annotations.json`;

function downloadLocalBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export default function PdfWorkspace({ workspaceId, repository = localDriveRepository }: Props) {
  const confirm = useFrostedConfirm();
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [pdfDocument, setPdfDocument] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [previewRotation, setPreviewRotation] = useState(0);
  const [pageDimensions, setPageDimensions] = useState<PageDimensions | null>(null);
  const [displayScale, setDisplayScale] = useState(1);
  const [pageOrder, setPageOrder] = useState<number[]>([]);
  const [pageRange, setPageRange] = useState('1');
  const [mergeIds, setMergeIds] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [currentSearchIndex, setCurrentSearchIndex] = useState(-1);
  const [searchRects, setSearchRects] = useState<PdfSearchOverlayRect[]>([]);
  const [searchTruncated, setSearchTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [previewError, setPreviewError] = useState('');
  const [canvasReady, setCanvasReady] = useState(false);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [sourceFingerprintState, setSourceFingerprintState] = useState<{ scope: string; value: string } | null>(null);
  const [annotationHistory, setAnnotationHistory] = useState<PdfAnnotationHistoryEntry[]>([]);
  const [selectionState, setSelectionState] = useState<{ scope: string; page: number; value: PdfCapturedSelection } | null>(null);
  const [commentEditorOpen, setCommentEditorOpen] = useState(false);
  const [commentDraft, setCommentDraft] = useState('');
  const [activeAnnotationId, setActiveAnnotationId] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const annotationBundleInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pageStageRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const pageTextItemsRef = useRef<{ page: number; items: string[] } | null>(null);
  const searchRequestIdRef = useRef(0);
  const selectedFile = useMemo(() => files.find((file) => file.id === selectedId) ?? files[0] ?? null, [files, selectedId]);
  const selectedFileId = selectedFile?.id;
  const annotationScope = JSON.stringify([workspaceId, selectedFileId]);
  const annotationScopeRef = useRef(annotationScope);
  useEffect(() => { annotationScopeRef.current = annotationScope; }, [annotationScope]);
  const sourceFingerprint = sourceFingerprintState?.scope === annotationScope ? sourceFingerprintState.value : '';
  const visualAnnotations = useMemo(() => annotations.filter((annotation) => annotation.kind !== 'comment'), [annotations]);
  const unverifiedVisualAnnotationCount = useMemo(
    () => visualAnnotations.filter((annotation) => !sourceFingerprint || annotation.sourceFingerprint !== sourceFingerprint).length,
    [sourceFingerprint, visualAnnotations],
  );
  const selection = selectionState?.scope === annotationScope && selectionState.page === currentPage ? selectionState.value : null;
  const setSelection = (value: PdfCapturedSelection | null) => setSelectionState(value ? { scope: annotationScope, page: currentPage, value } : null);
  const currentPageAnnotations = useMemo(
    () => annotations.filter((annotation) => annotation.page === currentPage),
    [annotations, currentPage],
  );
  const annotationCommentCount = annotations.length - visualAnnotations.length;
  const annotatedCopyDisabled = busy || !sourceFingerprint || visualAnnotations.length === 0 || unverifiedVisualAnnotationCount > 0;
  const annotatedCopyStatus = !sourceFingerprint
    ? 'Local source verification is unavailable; annotated-copy export is disabled.'
    : visualAnnotations.length === 0
      ? 'Add a highlight, underline, or strike-through to enable this copy.'
      : unverifiedVisualAnnotationCount > 0
        ? `${unverifiedVisualAnnotationCount} older or unverified mark${unverifiedVisualAnnotationCount === 1 ? '' : 's'} must be recreated on this exact PDF before export.`
        : `${visualAnnotations.length} visual mark${visualAnnotations.length === 1 ? '' : 's'} ready. ${annotationCommentCount} comment${annotationCommentCount === 1 ? '' : 's'} will be excluded.`;
  const pageCopyLimitMessage = !sourceFingerprint
    ? 'Page-copy actions are disabled because this browser cannot verify the open PDF with a local SHA-256 fingerprint.'
    : pdfDocument && pdfDocument.numPages > MAX_PDF_PAGE_OPERATION_PAGES
      ? `Page-copy actions are limited to ${MAX_PDF_PAGE_OPERATION_PAGES} pages; this PDF has ${pdfDocument.numPages}.`
      : '';
  const pageCopyDisabled = busy || Boolean(pageCopyLimitMessage);
  const canUndoAnnotation = annotationHistory.at(-1)?.scope === annotationScope;
  const recordAnnotationHistory = (entry: Omit<PdfAnnotationHistoryEntry, 'scope'>) => {
    setAnnotationHistory((current) => [...current, { ...entry, scope: annotationScope }].slice(-MAX_PDF_ANNOTATION_HISTORY));
  };

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
        const nextSelectedId = pdfs[0]?.id ?? '';
        setSelectedId(nextSelectedId);
        setPdfDocument(null);
        setSourceFingerprintState(null);
        setCanvasReady(false);
        setPageDimensions(null);
        setSelectionState(null);
        setCommentEditorOpen(false);
        setCommentDraft('');
        setActiveAnnotationId('');
        setAnnotationHistory([]);
        setPreviewError('');
        setSearchTerm('');
        setSearchHits([]);
        setCurrentSearchIndex(-1);
        setSearchRects([]);
        setSearchTruncated(false);
        setSearching(false);
        setNotice('');
        searchRequestIdRef.current += 1;
        pageTextItemsRef.current = null;
        setError('');
        if (nextSelectedId) {
          try { setAnnotations(listPdfAnnotations(window.localStorage, workspaceId, nextSelectedId)); }
          catch (cause) { setAnnotations([]); setError(cause instanceof Error ? cause.message : 'Could not read local PDF annotations.'); }
        } else setAnnotations([]);
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
      const sourceScope = JSON.stringify([workspaceId, selectedFileId]);
      let fingerprint = '';
      try { fingerprint = await fingerprintPdfBytes(data); } catch { /* Viewing and sidecar edits remain local; export stays disabled without this check. */ }
      loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(data) });
      const document = await loadingTask.promise;
      if (!active) return;
      setSourceFingerprintState({ scope: sourceScope, value: fingerprint });
      setPdfDocument(document);
      setCurrentPage(1);
      setPreviewRotation(0);
      setPageRange('1');
      setPageOrder(Array.from({ length: document.numPages }, (_, index) => index + 1));
    }).catch((cause: unknown) => {
      if (active) {
        setPdfDocument(null);
        setSourceFingerprintState(null);
        setPreviewError(cause instanceof Error ? cause.message : 'This file could not be opened as a PDF.');
      }
    });
    return () => { active = false; if (loadingTask) void loadingTask.destroy(); };
  }, [repository, selectedFileId, workspaceId]);

  useEffect(() => {
    if (!pdfDocument || !canvasRef.current || !textLayerRef.current) return undefined;
    let active = true;
    let renderTask: RenderTask | undefined;
    let textLayerTask: { render: () => Promise<unknown>; cancel: () => void } | undefined;
    const canvas = canvasRef.current;
    const layer = textLayerRef.current;
    layer.replaceChildren();
    pageTextItemsRef.current = null;
    setSearchRects([]);

    void pdfDocument.getPage(currentPage).then(async (page) => {
      if (!active || !canvasRef.current || !textLayerRef.current) return;
      const viewport = page.getViewport({ scale: 1.22, rotation: previewRotation });
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas rendering is not available in this browser.');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      layer.style.setProperty('--total-scale-factor', String(viewport.scale));
      const textContent = await page.getTextContent();
      if (!active || !canvasRef.current || !textLayerRef.current) return;
      const itemTexts = textContent.items.map((item) => 'str' in item ? item.str : '');
      pageTextItemsRef.current = { page: currentPage, items: itemTexts };
      textLayerTask = new PdfTextLayer({ textContentSource: textContent, container: layer, viewport });
      renderTask = page.render({ canvas, canvasContext: context, viewport });
      const renderedTextLayer = textLayerTask;
      await Promise.all([renderTask.promise, renderedTextLayer.render()]);
      renderTask = undefined;
      textLayerTask = undefined;
      if (active) {
        const viewBox: readonly [number, number, number, number] = [page.view[0], page.view[1], page.view[2], page.view[3]];
        setPageDimensions({ width: viewport.width, height: viewport.height, viewport, viewBox });
        setCanvasReady(true);
        setPreviewError('');
      }
    }).catch((cause: unknown) => {
      if (active) setPreviewError(cause instanceof Error ? cause.message : 'Could not render this PDF page.');
    });
    return () => { active = false; renderTask?.cancel(); textLayerTask?.cancel(); };
  }, [pdfDocument, currentPage, previewRotation]);

  useEffect(() => {
    const source = pageTextItemsRef.current;
    const textLayer = textLayerRef.current;
    const stage = pageStageRef.current;
    if (!canvasReady || !pageDimensions || source?.page !== currentPage || !textLayer || !stage || !searchHits.length) {
      setSearchRects((current) => current.length ? [] : current);
      return;
    }
    const pageHits = searchHits
      .map((hit, hitIndex) => ({ hit, hitIndex }))
      .filter(({ hit }) => hit.page === currentPage)
      .map(({ hit, hitIndex }) => ({ hitIndex, segments: hit.segments }));
    const bounds = stage.getBoundingClientRect();
    setSearchRects(measurePdfSearchHitRects(textLayer, bounds, source.items, pageHits));
  }, [canvasReady, currentPage, displayScale, pageDimensions, searchHits]);

  useEffect(() => {
    const hit = searchHits[currentSearchIndex];
    if (!canvasReady || hit?.page !== currentPage || !searchRects.some((rect) => rect.hitIndex === currentSearchIndex)) return;
    const currentMark = textLayerRef.current?.parentElement?.querySelector<HTMLElement>(`[data-pdf-search-hit="${currentSearchIndex}"]`);
    currentMark?.scrollIntoView?.({ behavior: 'smooth', block: 'center', inline: 'center' });
  }, [canvasReady, currentPage, currentSearchIndex, searchHits, searchRects]);

  useEffect(() => {
    const stage = pageStageRef.current;
    const canvas = canvasRef.current;
    if (!stage || !canvas || !pageDimensions) return undefined;
    const measure = () => {
      if (canvas.width > 0) setDisplayScale(Math.max(0.1, stage.clientWidth / canvas.width));
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(stage);
    window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure); };
  }, [pageDimensions]);

  const selectFile = (id: string) => {
    searchRequestIdRef.current += 1;
    setSelectedId(id);
    setPdfDocument(null);
    setSourceFingerprintState(null);
    setCanvasReady(false);
    setPageDimensions(null);
    setSelectionState(null);
    setAnnotationHistory([]);
    setCommentEditorOpen(false);
    setCommentDraft('');
    setActiveAnnotationId('');
    setError('');
    try { setAnnotations(listPdfAnnotations(window.localStorage, workspaceId, id)); }
    catch (cause) { setAnnotations([]); setError(cause instanceof Error ? cause.message : 'Could not read local PDF annotations.'); }
    setPreviewError('');
    setCurrentPage(1);
    setSearchHits([]);
    setCurrentSearchIndex(-1);
    setSearchRects([]);
    setSearchTruncated(false);
    setNotice('');
  };

  const navigateToPage = (page: number) => {
    if (page === currentPage) return;
    setSelection(null);
    setCommentEditorOpen(false);
    setPageDimensions(null);
    setCanvasReady(false);
    setSearchRects([]);
    setCurrentPage(page);
  };
  const rotateView = () => { setSelection(null); setCommentEditorOpen(false); setPageDimensions(null); setCanvasReady(false); setPreviewRotation((rotation) => (rotation + 90) % 360); };

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

  const readVerifiedPdfSnapshot = async (expectedFile: DriveFile, expectedFingerprint?: string): Promise<VerifiedPdfSnapshot> => {
    const { file: storedFile, blob } = await repository.readFile(expectedFile.id, workspaceId);
    const metadataMatches = storedFile.id === expectedFile.id
      && storedFile.workspaceId === workspaceId
      && expectedFile.workspaceId === workspaceId
      && storedFile.name === expectedFile.name
      && storedFile.mimeType === expectedFile.mimeType
      && storedFile.size === expectedFile.size
      && storedFile.createdAt === expectedFile.createdAt
      && storedFile.updatedAt === expectedFile.updatedAt
      && storedFile.deletedAt === null;
    if (!metadataMatches) throw new Error('A selected local PDF changed or is no longer available; no copy was created. Refresh the file list and try again.');
    if (!Number.isSafeInteger(storedFile.size) || storedFile.size < 1 || storedFile.size > MAX_LOCAL_FILE_BYTES || blob.size !== storedFile.size) {
      throw new Error(`Each local PDF input must match its stored size and fit the ${formatBytes(MAX_LOCAL_FILE_BYTES)} limit; no copy was created.`);
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (bytes.byteLength !== storedFile.size) throw new Error('A selected PDF changed while it was being read; no copy was created.');
    let fingerprint: string;
    try { fingerprint = await fingerprintPdfBytes(bytes); }
    catch { throw new Error('This browser cannot verify local PDF bytes with SHA-256, so no page copy was created.'); }
    if (expectedFingerprint && fingerprint !== expectedFingerprint) {
      throw new Error('The selected PDF bytes no longer match the open document; no copy was created. Reopen the PDF and try again.');
    }
    return { file: storedFile, bytes, fingerprint };
  };

  const assertPdfSnapshotStillCurrent = async (snapshot: VerifiedPdfSnapshot) => {
    await readVerifiedPdfSnapshot(snapshot.file, snapshot.fingerprint);
  };

  const exportAnnotationBackup = async () => {
    const file = selectedFile;
    const document = pdfDocument;
    const verifiedFingerprint = sourceFingerprint;
    if (!file || !document || !verifiedFingerprint) { setError('Open a locally stored PDF whose exact bytes can be verified before creating an annotation backup.'); return; }
    const scope = { workspaceId, fileId: file.id };
    const operationScope = annotationScope;
    const exportedAt = new Date();
    let scopedAnnotations: PdfAnnotation[];
    let json: string;
    try {
      scopedAnnotations = listPdfAnnotations(window.localStorage, workspaceId, file.id);
      if (scopedAnnotations.some((annotation) => annotation.page > document.numPages)) throw new Error('Some local annotations refer to pages outside this PDF. Nothing was exported.');
      json = serializePdfAnnotationBundle(scope, verifiedFingerprint, scopedAnnotations, exportedAt);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not prepare a local annotation backup.'); return; }

    const confirmed = await confirm(
      `Download a browser-local JSON backup for “${file.name}” with ${scopedAnnotations.length} annotation${scopedAnnotations.length === 1 ? '' : 's'}? It includes selected-text quotes, positions, comments, and note text stored on any annotation (including visual marks), but no PDF bytes. The backup can contain sensitive text. It is not uploaded and can be restored only into a byte-identical PDF. Continue?`,
    );
    if (!confirmed) return;

    setBusy(true); setError(''); setNotice('');
    try {
      const { blob, file: storedSource } = await repository.readFile(file.id, workspaceId);
      if (storedSource.id !== file.id || storedSource.workspaceId !== workspaceId) throw new Error('The selected PDF changed before backup; no file was downloaded.');
      const actualFingerprint = await fingerprintPdfBytes(new Uint8Array(await blob.arrayBuffer()));
      if (actualFingerprint !== verifiedFingerprint) throw new Error('The local PDF bytes changed since it was opened. Reopen the PDF before creating a backup.');
      if (annotationScopeRef.current !== operationScope) throw new Error('The selected PDF changed during backup; no file was downloaded.');
      const latestAnnotations = listPdfAnnotations(window.localStorage, workspaceId, file.id);
      const latestJson = serializePdfAnnotationBundle(scope, actualFingerprint, latestAnnotations, exportedAt);
      if (latestJson !== json) throw new Error('The local annotation sidecar changed during confirmation. Nothing was downloaded; retry to include the current annotations.');
      downloadLocalBlob(new Blob([json], { type: 'application/json;charset=utf-8' }), annotationBundleName(file.name));
      setNotice(`Downloaded a browser-local JSON backup of ${scopedAnnotations.length} annotations. It contains annotation text and positions, not PDF bytes; no upload occurred.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not download the local annotation backup.'); }
    finally { setBusy(false); }
  };

  const importAnnotationBackup = async (backupFile: File) => {
    const file = selectedFile;
    const document = pdfDocument;
    const verifiedFingerprint = sourceFingerprint;
    if (!file || !document || !verifiedFingerprint) { setError('Open a locally stored, verified PDF before restoring annotations.'); return; }
    const scope = { workspaceId, fileId: file.id };
    const operationScope = annotationScope;
    setBusy(true); setError(''); setNotice('');
    try {
      if (!Number.isSafeInteger(backupFile.size) || backupFile.size < 1 || backupFile.size > MAX_PDF_ANNOTATION_BUNDLE_BYTES) {
        throw new Error(`Annotation backup files must be ${MAX_PDF_ANNOTATION_BUNDLE_BYTES} bytes or smaller.`);
      }
      const bundle = parsePdfAnnotationBundle(await backupFile.text());
      const confirmed = await confirm(
        `Merge ${bundle.annotations.length} annotation${bundle.annotations.length === 1 ? '' : 's'} from “${backupFile.name}” into the local sidecar for “${file.name}”? The backup can contain sensitive selected-text quotes, comments, and note text on any annotation. It has no PDF bytes and will not be uploaded. This browser will recheck the PDF’s SHA-256; a different PDF is refused, and conflicting IDs within this PDF’s local sidecar abort the entire import. Continue?`,
      );
      if (!confirmed) { setNotice('Annotation backup import canceled; the current sidecar was not changed.'); return; }

      const { blob, file: storedSource } = await repository.readFile(file.id, workspaceId);
      if (storedSource.id !== file.id || storedSource.workspaceId !== workspaceId) throw new Error('The selected PDF changed before import; no annotations were added.');
      const actualFingerprint = await fingerprintPdfBytes(new Uint8Array(await blob.arrayBuffer()));
      if (actualFingerprint !== verifiedFingerprint) throw new Error('The local PDF bytes changed since it was opened. Reopen the PDF before restoring annotations.');
      assertPdfAnnotationBundleMatchesSource(bundle, actualFingerprint);
      if (annotationScopeRef.current !== operationScope) throw new Error('The selected PDF changed during import; no annotations were added.');
      if (bundle.annotations.some((annotation) => annotation.page > document.numPages)) throw new Error('This backup refers to a page outside the selected PDF. Nothing was imported.');

      const existing = listPdfAnnotations(window.localStorage, workspaceId, file.id);
      const merge = mergePdfAnnotationBundle(bundle, scope, existing);
      if (!merge.added.length) {
        setAnnotations(existing);
        setNotice(`All ${merge.alreadyPresent} backup annotations are already present; the local sidecar was unchanged.`);
        return;
      }
      savePdfAnnotations(window.localStorage, merge.added);
      const saved = listPdfAnnotations(window.localStorage, workspaceId, file.id);
      setAnnotations(saved);
      recordAnnotationHistory({ added: merge.added, removed: [] });
      setActiveAnnotationId('');
      setNotice(`Added ${merge.added.length} annotation${merge.added.length === 1 ? '' : 's'} locally${merge.alreadyPresent ? `; ${merge.alreadyPresent} identical item${merge.alreadyPresent === 1 ? ' was' : 's were'} already present` : ''}. The source PDF was not changed.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore the local annotation backup.'); }
    finally { setBusy(false); }
  };

  const onAnnotationBundleInput = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    event.target.value = '';
    if (selected) void importAnnotationBackup(selected);
  };

  const exportAnnotatedCopy = async () => {
    const file = selectedFile;
    const document = pdfDocument;
    if (!file || !document) return;
    let scopedAnnotations: PdfAnnotation[];
    try { scopedAnnotations = listPdfAnnotations(window.localStorage, workspaceId, file.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read local PDF annotations.'); return; }
    const marks = scopedAnnotations.filter((annotation) => annotation.kind !== 'comment');
    const comments = scopedAnnotations.length - marks.length;
    if (!marks.length) { setError('Add a local highlight, underline, or strike-through before creating an annotated copy.'); return; }
    if (!sourceFingerprint) { setError('This browser could not verify the exact PDF bytes locally, so annotated-copy export is unavailable.'); return; }
    if (marks.some((annotation) => annotation.sourceFingerprint !== sourceFingerprint)) {
      setError('Some saved marks are older or unverified. Re-create those marks on this exact PDF before exporting an annotated copy.');
      return;
    }
    const copyCount = marks.length;
    const commentNotice = comments
      ? `${comments} comment${comments === 1 ? '' : 's'} and all quote/note text will be excluded. `
      : 'Comments and note text are not included. ';
    const confirmed = await confirm(
      `Create a separate browser-local PDF copy of “${file.name}” with ${copyCount} saved highlight/underline/strike-through annotation${copyCount === 1 ? '' : 's'} flattened into page content? ${commentNotice}These are visual marks, not editable PDF annotation objects. The original file and local sidecar will remain unchanged. Signatures and advanced form behavior may not be preserved in this new copy. Continue?`,
    );
    if (!confirmed) return;

    setBusy(true); setError(''); setNotice('');
    try {
      const { blob, file: storedSource } = await repository.readFile(file.id, workspaceId);
      if (storedSource.id !== file.id) throw new Error('The selected PDF changed before export; no copy was created.');
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const pageNumbers = [...new Set(marks.map((annotation) => annotation.page))];
      const geometries = new Map<number, { viewBox: readonly [number, number, number, number]; rotation: number; userUnit: number }>();
      for (const pageNumber of pageNumbers) {
        const page = await document.getPage(pageNumber);
        geometries.set(pageNumber, {
          viewBox: [page.view[0], page.view[1], page.view[2], page.view[3]],
          rotation: page.rotate,
          userUnit: page.userUnit,
        });
      }
      const result = await createPdfAnnotatedCopy(bytes, { workspaceId, fileId: file.id }, scopedAnnotations, geometries);
      const commentResult = result.excludedComments
        ? ` ${result.excludedComments} comment${result.excludedComments === 1 ? '' : 's'} remained only in the local sidecar.`
        : ' Comments and note text were not included.';
      await savePdfCopy(
        outputName(file.name, 'annotated'),
        result.bytes,
        `Created a separate local copy with ${result.includedAnnotations} flattened visual marks across ${result.includedRectangles} text rectangles. The original PDF and annotation sidecar were not changed.${commentResult}`,
      );
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create a local annotated PDF copy.'); }
    finally { setBusy(false); }
  };

  const savePdfCopy = async (filename: string, bytes: Uint8Array, message: string) => {
    const output = new File([toArrayBuffer(bytes)], filename, { type: 'application/pdf' });
    const saved = await repository.saveFile(output, workspaceId);
    await refreshFiles();
    selectFile(saved.id);
    setNotice(message);
  };

  const confirmLocalPdfPageCopy = async (description: string) => await confirm(
    `${description}\n\n${PDF_PAGE_COPY_WARNING}\n\nSingle-PDF operations are limited to ${MAX_PDF_PAGE_OPERATION_PAGES} pages and ${formatBytes(MAX_LOCAL_FILE_BYTES)} per input/output. Merges accept ${MAX_PDF_MERGE_INPUTS} PDFs, ${formatBytes(MAX_PDF_MERGE_TOTAL_INPUT_BYTES)} combined source bytes, and ${MAX_PDF_PAGE_OPERATION_PAGES} total pages.`,
  );

  const runSinglePdfPageCopy = async (
    file: DriveFile,
    expectedFingerprint: string,
    description: string,
    suffix: string,
    transform: (source: Uint8Array) => Promise<Uint8Array>,
    successMessage: string,
  ) => {
    if (!expectedFingerprint) {
      setError('The open PDF could not be verified with a local SHA-256 fingerprint; no page copy was created.');
      return;
    }
    if (!await confirmLocalPdfPageCopy(description)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const snapshot = await readVerifiedPdfSnapshot(file, expectedFingerprint);
      const output = await transform(snapshot.bytes);
      await assertPdfSnapshotStillCurrent(snapshot);
      await savePdfCopy(outputName(file.name, suffix), output, successMessage);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create a local PDF page copy.'); }
    finally { setBusy(false); }
  };

  const exportRotatedPage = async () => {
    const file = selectedFile;
    const document = pdfDocument;
    const page = currentPage;
    const fingerprint = sourceFingerprint;
    if (!file || !document) return;
    void runSinglePdfPageCopy(
      file, fingerprint, `Rotate page ${page} of “${file.name}” in a new copy?`, `page-${page}-rotated`,
      (source) => rotatePdfPage(source, page, 90),
      `Created a separate local copy with page ${page} rotated. The original PDF and its annotation sidecar were not changed.`,
    );
  };

  const exportExtract = async () => {
    const file = selectedFile;
    const document = pdfDocument;
    const fingerprint = sourceFingerprint;
    if (!file || !document) return;
    let pages: number[];
    try { pages = parsePageRange(pageRange, document.numPages); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not parse that page range.'); return; }
    void runSinglePdfPageCopy(
      file, fingerprint, `Extract ${pages.length} page${pages.length === 1 ? '' : 's'} from “${file.name}” in a new copy?`, `pages-${pages.join('-')}`,
      (source) => extractPdfPages(source, pages),
      `Saved ${pages.length} selected page${pages.length === 1 ? '' : 's'} as a separate local PDF copy. The original PDF and its annotation sidecar were not changed.`,
    );
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
    const file = selectedFile;
    const document = pdfDocument;
    const fingerprint = sourceFingerprint;
    const order = [...pageOrder];
    if (!file || !document || order.length < 2) return;
    if (order.length === document.numPages && order.every((page, index) => page === index + 1)) {
      setNotice('The page order is unchanged; no copy was created.');
      return;
    }
    await runSinglePdfPageCopy(
      file, fingerprint, `Save the selected ${order.length}-page order for “${file.name}” as a new PDF copy?`, 'reordered',
      (source) => reorderPdfPages(source, order),
      'Saved a separate reordered local copy. The original PDF and its annotation sidecar were not changed.',
    );
  };

  const mergeSelected = async () => {
    const selected = files.filter((file) => mergeIds.includes(file.id));
    try { assertPdfMergeInputLimits(selected.map((file) => file.size)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The selected PDFs exceed the local merge limits.'); return; }
    const selectedNames = selected.map((file) => `${file.name} (${formatBytes(file.size)})`).join(' + ');
    if (!await confirmLocalPdfPageCopy(`Merge these selected local PDFs into a new copy: ${selectedNames}?`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const snapshots: VerifiedPdfSnapshot[] = [];
      for (const file of selected) snapshots.push(await readVerifiedPdfSnapshot(file));
      const merged = await mergePdfFiles(snapshots.map((snapshot) => snapshot.bytes));
      for (const snapshot of snapshots) await assertPdfSnapshotStillCurrent(snapshot);
      await savePdfCopy(
        outputName(selected[0].name, 'merged'), merged,
        `Merged ${selected.length} local PDFs into a separate copy. Original files and their annotation sidecars were not changed.`,
      );
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not merge the selected PDFs.'); }
    finally { setBusy(false); }
  };

  const toggleMerge = (id: string) => setMergeIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]);

  const resetSearchResults = (clearNotice = true) => {
    searchRequestIdRef.current += 1;
    setSearchHits([]);
    setCurrentSearchIndex(-1);
    setSearchRects([]);
    setSearchTruncated(false);
    setSearching(false);
    if (clearNotice) setNotice('');
  };

  const clearSearch = () => {
    resetSearchResults();
    setSearchTerm('');
    setError('');
  };

  const changeSearchTerm = (value: string) => {
    setSearchTerm(value);
    resetSearchResults();
    setError('');
  };

  const runSearch = async () => {
    const requestId = ++searchRequestIdRef.current;
    const query = searchTerm.trim();
    if (!pdfDocument || !query) {
      setSearchHits([]); setCurrentSearchIndex(-1); setSearchRects([]); setSearchTruncated(false); setSearching(false); setNotice('');
      return;
    }
    setSearching(true); setError(''); setNotice(''); setSearchHits([]); setCurrentSearchIndex(-1); setSearchRects([]); setSearchTruncated(false);
    try {
      const pages: string[] = [];
      const pageItems: string[][] = [];
      for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber);
        const textContent = await page.getTextContent();
        if (requestId !== searchRequestIdRef.current) return;
        const itemTexts = textContent.items.map((item) => 'str' in item ? item.str : '');
        pageItems.push(itemTexts);
        pages.push(itemTexts.join(' '));
      }
      if (requestId !== searchRequestIdRef.current) return;
      const result = findPdfTextMatches(pages, query);
      const hits: SearchHit[] = result.matches.map(({ page, offset, length }) => {
        const text = pages[page - 1] ?? '';
        return {
          page,
          offset,
          length,
          excerpt: text.slice(Math.max(0, offset - 45), Math.min(text.length, offset + length + 55)),
          segments: mapPdfSearchTextRangeToItems(pageItems[page - 1] ?? [], offset, length),
        };
      });
      setSearchHits(hits);
      setSearchTruncated(result.truncated);
      if (!hits.length) setNotice(`No matches for “${query}” in this PDF.`);
      else { setCurrentSearchIndex(0); navigateToPage(hits[0].page); }
    } catch (cause) { if (requestId === searchRequestIdRef.current) setError(cause instanceof Error ? cause.message : 'Could not search this PDF.'); }
    finally { if (requestId === searchRequestIdRef.current) setSearching(false); }
  };

  const navigateToSearchHit = (index: number) => {
    if (!searchHits.length) return;
    const nextIndex = (index + searchHits.length) % searchHits.length;
    setCurrentSearchIndex(nextIndex);
    if (searchHits[nextIndex].page !== currentPage) navigateToPage(searchHits[nextIndex].page);
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

  const captureSelection = () => {
    const stage = pageStageRef.current;
    if (!stage) return;
    const bounds = stage.getBoundingClientRect();
    const captured = capturePdfTextSelection(window.getSelection(), textLayerRef.current, {
      left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height,
    }, pageDimensions ? { viewport: pageDimensions.viewport, viewBox: pageDimensions.viewBox, cssScale: displayScale } : undefined);
    setSelection(captured);
    if (!captured) setCommentEditorOpen(false);
  };

  const saveSelectedAnnotation = (kind: PdfAnnotation['kind'], note = '') => {
    if (!selection || !selectedFileId) return;
    try {
      const color = kind === 'highlight' ? 'yellow' : kind === 'strike-through' ? 'rose' : 'cyan';
      const annotation = createPdfAnnotation({
        workspaceId, fileId: selectedFileId, page: currentPage, kind,
        quote: selection.text, note: note.trim(), color,
        rects: selection.rects, sourceFingerprint: sourceFingerprint || undefined,
      });
      savePdfAnnotation(window.localStorage, annotation);
      setAnnotations((current) => [...current, annotation].sort((left, right) => left.page - right.page || left.createdAt.localeCompare(right.createdAt)));
      recordAnnotationHistory({ added: [annotation], removed: [] });
      setSelection(null);
      setCommentEditorOpen(false);
      setCommentDraft('');
      window.getSelection()?.removeAllRanges();
      setError('');
      const label = kind === 'strike-through' ? 'Strikethrough' : kind[0].toUpperCase() + kind.slice(1);
      setNotice(`${label} saved in this browser as a local PDF overlay; the source file was not changed.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this local PDF annotation.'); }
  };

  const saveComment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!commentDraft.trim()) return;
    saveSelectedAnnotation('comment', commentDraft);
  };

  const removeAnnotation = (annotation: PdfAnnotation) => {
    if (!selectedFileId) return;
    try {
      deletePdfAnnotation(window.localStorage, workspaceId, selectedFileId, annotation.id);
      setAnnotations((current) => current.filter((item) => item.id !== annotation.id));
      recordAnnotationHistory({ added: [], removed: [annotation] });
      setActiveAnnotationId((current) => current === annotation.id ? '' : current);
      setError('');
      setNotice('Annotation removed from this browser.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not remove this local annotation.'); }
  };

  const clearCurrentPageAnnotations = async () => {
    if (!selectedFileId || !currentPageAnnotations.length) return;
    const count = currentPageAnnotations.length;
    if (!await confirm(`Remove all ${count} local annotation${count === 1 ? '' : 's'} from page ${currentPage}? The original PDF will not change.`)) return;
    try {
      deletePdfAnnotations(window.localStorage, workspaceId, selectedFileId, currentPageAnnotations.map((annotation) => annotation.id));
      setAnnotations((current) => current.filter((annotation) => annotation.page !== currentPage));
      recordAnnotationHistory({ added: [], removed: currentPageAnnotations });
      setActiveAnnotationId('');
      setError('');
      setNotice(`Cleared ${count} local annotation${count === 1 ? '' : 's'} from page ${currentPage}. The source PDF was not changed.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not clear local PDF annotations.'); }
  };

  const undoLastAnnotationChange = () => {
    const entry = annotationHistory.at(-1);
    if (!entry || entry.scope !== annotationScope || !selectedFileId) return;
    try {
      if (entry.added.length) deletePdfAnnotations(window.localStorage, workspaceId, selectedFileId, entry.added.map((annotation) => annotation.id));
      if (entry.removed.length) savePdfAnnotations(window.localStorage, entry.removed);
      const removedIds = new Set(entry.added.map((annotation) => annotation.id));
      const restoredIds = new Set(entry.removed.map((annotation) => annotation.id));
      setAnnotations((current) => [...current.filter((annotation) => !removedIds.has(annotation.id) && !restoredIds.has(annotation.id)), ...entry.removed]
        .sort((left, right) => left.page - right.page || left.createdAt.localeCompare(right.createdAt)));
      setAnnotationHistory((current) => current.slice(0, -1));
      setActiveAnnotationId('');
      setError('');
      setNotice('Undid the last local annotation change. The source PDF was not changed.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not undo the local PDF annotation change.'); }
  };

  return (
    <div className="page subpage pdf-page">
      <div className="page-title-row pdf-title-row"><div><span className="eyebrow">COCCE PDF · BROWSER-LOCAL MODE</span><h1>PDF workspace</h1><p className="page-lede">View, search, select text, and add local highlights, comments, underlines, or strike-through marks to PDFs stored in this browser. Originals remain unchanged; nothing is sent to a server.</p></div><div className="pdf-title-actions"><button className="button-primary" onClick={() => inputRef.current?.click()} disabled={busy}><Upload size={15} /> Add PDF</button><input ref={inputRef} type="file" accept="application/pdf,.pdf" multiple className="visually-hidden" aria-label="Choose PDF files to save locally" onChange={onFileInput} /></div></div>

      <div className="pdf-local-note glass-card"><span className="pdf-note-icon"><BookOpenText size={18} /></span><div><strong>Local PDF tools</strong><small>Files are held in this browser’s COCCE Drive store. Marks and comments stay in a local sidecar. Only the explicit Create annotated copy action flattens verified highlights, underlines, and strike-throughs into a separate PDF; comments and note text are excluded. Nothing is uploaded. Per-file storage is limited to 25 MB.</small></div></div>
      {notice && <div className="pdf-feedback" role="status"><Check size={15} />{notice}</div>}
      {error && <div className="pdf-feedback pdf-error" role="alert">{error}</div>}

      <div className="pdf-workspace-layout">
        <aside className="pdf-library glass-card" aria-label="PDF files in this browser"><div className="pdf-library-heading"><div><span className="eyebrow">MY PDFs</span><strong>{files.length} local {files.length === 1 ? 'file' : 'files'}</strong></div><button className="icon-button" aria-label="Add a PDF" onClick={() => inputRef.current?.click()}><FilePlus2 size={16} /></button></div>
          {listLoading ? <div className="pdf-library-empty" role="status">Reading local files…</div> : files.length ? <div className="pdf-library-list">{files.map((file) => <article key={file.id} className={`pdf-library-item ${selectedFile?.id === file.id ? 'pdf-library-item-active' : ''}`}><button className="pdf-library-open" onClick={() => selectFile(file.id)} disabled={busy}><span className="pdf-library-file-icon"><FileText size={17} /></span><span><strong title={file.name}>{file.name}</strong><small>{formatBytes(file.size)} · PDF</small></span></button><label className="pdf-merge-checkbox"><input type="checkbox" checked={mergeIds.includes(file.id)} onChange={() => toggleMerge(file.id)} aria-label={`Select ${file.name} for merge`} title="Select for merge" disabled={busy} /></label></article>)}</div> : <div className="pdf-library-empty"><FileText size={22} /><p>No PDFs saved in this browser yet.</p><button className="button-tertiary" onClick={() => inputRef.current?.click()}><Upload size={14} /> Add a PDF</button></div>}
          {files.length > 1 && <div className="pdf-merge-action"><button className="button-secondary" onClick={() => void mergeSelected()} disabled={busy}><Files size={14} /> Merge selected ({mergeIds.length})</button><small>Creates a separate local copy: up to {MAX_PDF_MERGE_INPUTS} PDFs, {formatBytes(MAX_PDF_MERGE_TOTAL_INPUT_BYTES)} combined input, and {MAX_PDF_PAGE_OPERATION_PAGES} pages. Sources and sidecars stay unchanged.</small></div>}
        </aside>

        <section className="pdf-viewer-panel glass-card" aria-label="PDF viewer">
          {selectedFile ? <>
            <div className="pdf-viewer-toolbar"><div className="pdf-viewer-title"><FileText size={17} /><strong title={selectedFile.name}>{selectedFile.name}</strong></div><div className="pdf-viewer-actions"><button className="icon-button" onClick={() => void downloadOriginal()} aria-label="Download original PDF" title="Download original"><ArrowDownToLine size={15} /></button></div></div>
            {previewError ? <div className="pdf-load-error" role="alert">{previewError}<small>Try another PDF or a smaller, unencrypted file.</small></div> : !pdfDocument ? <div className="pdf-loading" role="status"><LoaderCircle size={18} className="pdf-spinner" /> Opening PDF locally…</div> : <>
              <div className="pdf-page-toolbar"><button className="icon-button" onClick={() => navigateToPage(Math.max(1, currentPage - 1))} disabled={currentPage <= 1} aria-label="Previous page"><ArrowLeft size={15} /></button><label>Page <input aria-label="PDF page number" type="number" min={1} max={pdfDocument.numPages} value={currentPage} onChange={(event) => { const parsed = Number(event.target.value); if (Number.isInteger(parsed)) navigateToPage(Math.min(pdfDocument.numPages, Math.max(1, parsed))); }} /> of {pdfDocument.numPages}</label><button className="icon-button" onClick={() => navigateToPage(Math.min(pdfDocument.numPages, currentPage + 1))} disabled={currentPage >= pdfDocument.numPages} aria-label="Next page"><ArrowRight size={15} /></button><span className="pdf-page-toolbar-spacer" /><button className="button-tertiary" onClick={rotateView}><RotateCw size={14} /> View rotation</button></div>
              <div className="pdf-canvas-wrap"><div ref={pageStageRef} className="pdf-page-stage" onMouseUp={() => window.requestAnimationFrame(captureSelection)} onKeyUp={() => window.requestAnimationFrame(captureSelection)} role="group" aria-label={`PDF page ${currentPage}`}>
                <canvas ref={canvasRef} className={`pdf-canvas ${canvasReady ? 'pdf-canvas-ready' : ''}`} aria-label={`Rendered PDF page ${currentPage}`} role="img" />
                <div className="pdf-mark-layer" aria-hidden="true">{currentPageAnnotations.filter((annotation) => annotation.kind === 'highlight' || annotation.kind === 'comment').flatMap((annotation) => annotation.rects.map((pdfRect, index) => { const rect = pageDimensions ? pdfRectToViewportRect(pdfRect, pageDimensions.viewport, pageDimensions.viewBox) : pdfRect; return <span key={`${annotation.id}-${index}`} className={`pdf-mark-rect pdf-mark-${annotation.kind} pdf-mark-${annotation.color}`} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />; }))}</div>
                <div ref={textLayerRef} className="pdf-text-layer" data-testid="pdf-text-layer" style={{ transform: `scale(${displayScale})` }} />
                <svg className="pdf-text-mark-layer" data-testid="pdf-text-mark-layer" viewBox={pageDimensions ? `0 0 ${pageDimensions.width} ${pageDimensions.height}` : '0 0 1 1'} preserveAspectRatio="none" aria-hidden="true">{currentPageAnnotations.flatMap((annotation) => { if (annotation.kind !== 'underline' && annotation.kind !== 'strike-through') return []; return annotation.rects.map((rect, index) => { const line = pageDimensions ? pdfTextMarkToViewportLine(rect, annotation.kind, pageDimensions.viewport, pageDimensions.viewBox) : null; return line ? <line key={`${annotation.id}-${index}`} className={`pdf-text-mark-line pdf-text-mark-${annotation.kind} pdf-text-mark-color-${annotation.color}`} data-testid="pdf-text-mark-line" x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} /> : null; }); })}{/* Page-space geometry is reprojected after responsive scaling and rotation. */}</svg>
                <div className="pdf-search-mark-layer" data-testid="pdf-search-highlight-layer" aria-hidden="true">{searchRects.map((rect, rectIndex) => <span key={`${rect.hitIndex}-${rectIndex}`} className={`pdf-search-mark-rect${rect.hitIndex === currentSearchIndex ? ' pdf-search-mark-current' : ''}`} data-testid="pdf-search-hit-mark" data-pdf-search-hit={rect.hitIndex} data-current={rect.hitIndex === currentSearchIndex} style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` }} />)}</div>
                <div className="pdf-comment-markers">{currentPageAnnotations.filter((annotation) => annotation.kind === 'comment' && annotation.rects[0]).map((annotation) => { const storedRect = annotation.rects[0]; const rect = pageDimensions ? pdfRectToViewportRect(storedRect, pageDimensions.viewport, pageDimensions.viewBox) : storedRect; return <button key={annotation.id} className="pdf-comment-marker" aria-label={`Show comment: ${annotation.note}`} title={annotation.note} style={{ left: `${Math.min(98, (rect.x + rect.width) * 100)}%`, top: `${rect.y * 100}%` }} onClick={() => setActiveAnnotationId(annotation.id)}><MessageSquare size={12} /></button>; })}</div>
                {!canvasReady && !previewError && <div className="pdf-canvas-overlay" role="status"><LoaderCircle size={17} className="pdf-spinner" /> Rendering page…</div>}
              </div></div>
              <p className="pdf-viewer-footnote">PDF.js text on this page is selectable. Search matches are temporary and disappear when cleared. Saved marks are local overlays; original downloads and ordinary page-operation copies omit them. Use the explicit annotated-copy action to make a separate flattened visual copy.</p>
              {selection && <div className="pdf-selection-toolbar" role="group" aria-label="Actions for selected PDF text"><div><strong>Selected text</strong><small title={selection.text}>“{selection.text.slice(0, 160)}{selection.text.length > 160 ? '…' : ''}”</small></div><button className="button-tertiary" onClick={() => saveSelectedAnnotation('highlight')}><Highlighter size={14} /> Highlight</button><button className="button-tertiary" aria-label="Underline selected PDF text" onClick={() => saveSelectedAnnotation('underline')}><Underline size={14} /> Underline</button><button className="button-tertiary" aria-label="Strike through selected PDF text" onClick={() => saveSelectedAnnotation('strike-through')}><Strikethrough size={14} /> Strike through</button><button className="button-secondary" onClick={() => { setCommentEditorOpen(true); setCommentDraft(''); }}><MessageSquare size={14} /> Comment</button><button className="icon-button" aria-label="Dismiss text selection" onClick={() => { setSelection(null); setCommentEditorOpen(false); }}><X size={14} /></button></div>}
              {commentEditorOpen && selection && <form className="pdf-comment-form" onSubmit={saveComment}><label htmlFor="pdf-comment-draft">Comment on selected text</label><textarea id="pdf-comment-draft" rows={3} maxLength={4_000} value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} placeholder="Write a note about this passage" /><div><small>{selection.text.slice(0, 120)}{selection.text.length > 120 ? '…' : ''}</small><button className="button-primary" type="submit" disabled={!commentDraft.trim()}>Save comment locally</button><button className="button-tertiary" type="button" onClick={() => { setCommentEditorOpen(false); setCommentDraft(''); }}>Cancel</button></div></form>}
              <section className="pdf-annotations" aria-label="Local PDF annotations"><div className="pdf-annotations-heading"><div><span className="eyebrow">THIS BROWSER ONLY</span><h2>Highlights, comments &amp; text marks</h2></div><div className="pdf-annotation-actions"><button className="button-tertiary" aria-label="Undo last annotation change" title="Undo the last local annotation edit" onClick={undoLastAnnotationChange} disabled={!canUndoAnnotation}><Undo2 size={13} /> Undo</button><button className="button-tertiary" aria-label="Clear annotations on this page" onClick={clearCurrentPageAnnotations} disabled={!currentPageAnnotations.length}><Trash2 size={13} /> Clear page</button><span>{annotations.length} saved</span></div></div><p className="pdf-annotations-note">Select text to add a highlight, underline, strike-through, or comment. These overlays stay local and never change the source. A separate flattened copy can include only verified visual marks; comments and note text stay out.</p>
                {currentPageAnnotations.length ? <ul className="pdf-annotation-list">{currentPageAnnotations.map((annotation) => <li key={annotation.id} id={`pdf-annotation-${annotation.id}`} className={`pdf-annotation-item ${activeAnnotationId === annotation.id ? 'pdf-annotation-item-active' : ''}`}><div className={`pdf-annotation-icon pdf-annotation-icon-${annotation.kind}`} aria-hidden="true">{annotation.kind === 'highlight' ? <Highlighter size={14} /> : annotation.kind === 'comment' ? <MessageSquare size={14} /> : annotation.kind === 'underline' ? <Underline size={14} /> : <Strikethrough size={14} />}</div><div className="pdf-annotation-copy"><strong>{annotation.kind === 'strike-through' ? 'Strikethrough' : annotation.kind[0].toUpperCase() + annotation.kind.slice(1)} · page {annotation.page}</strong><blockquote>“{annotation.quote}”</blockquote>{annotation.note && <p>{annotation.note}</p>}</div><button className="icon-button pdf-delete-annotation" aria-label={`Delete PDF ${annotation.kind}`} title="Remove this local annotation" onClick={() => removeAnnotation(annotation)}><Trash2 size={14} /></button></li>)}</ul> : <div className="pdf-annotations-empty">No saved marks on page {currentPage}. Select text above to add one.</div>}
              </section>
              <section className="pdf-annotation-backup" aria-label="Local annotation backup">
                <div className="pdf-annotation-backup-copy">
                  <strong>Back up or restore annotations</strong>
                  <small>JSON backups include selected-text quotes, positions, comments and note text on any annotation, including visual marks, but no PDF bytes. These files can contain sensitive text. Restore requires a byte-identical PDF; nothing is uploaded. Each bundle is capped at 5 MB/2,000 annotations, and this browser’s sidecar holds at most 2,000 annotations total.</small>
                </div>
                <div className="pdf-annotation-backup-actions">
                  <button className="button-tertiary" onClick={() => void exportAnnotationBackup()} disabled={busy || !annotations.length || !sourceFingerprint}><ArrowDownToLine size={13} /> Export backup</button>
                  <button className="button-tertiary" onClick={() => annotationBundleInputRef.current?.click()} disabled={busy || !sourceFingerprint}><Upload size={13} /> Import backup</button>
                  <input ref={annotationBundleInputRef} type="file" accept="application/json,.json" className="visually-hidden" aria-label="Choose local PDF annotation backup JSON" onChange={onAnnotationBundleInput} />
                </div>
              </section>
              <div className="pdf-search-row"><label className="pdf-search-input"><Search size={15} /><input aria-label="Search text in PDF" value={searchTerm} onChange={(event) => changeSearchTerm(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runSearch(); }} placeholder="Find text in this PDF" /></label><button className="button-secondary" onClick={() => void runSearch()} disabled={searching || !searchTerm.trim()}>{searching ? 'Searching…' : 'Search'}</button>{searchTerm && <button className="button-tertiary pdf-search-clear" onClick={clearSearch} aria-label="Clear PDF search" title="Clear search"><X size={14} /> Clear</button>}</div>
              {(searchHits.length > 0 || searchTruncated) && <div className="pdf-search-results" aria-label="PDF search results"><div className="pdf-search-heading"><strong>{searchHits.length} match{searchHits.length === 1 ? '' : 'es'}{searchTruncated ? ' (first 2,000 shown)' : ''}</strong>{searchHits.length > 0 && <div className="pdf-search-navigation"><button className="icon-button" onClick={() => navigateToSearchHit(currentSearchIndex - 1)} aria-label="Previous search match" title="Previous match"><ArrowLeft size={14} /></button><span aria-live="polite" aria-atomic="true">{currentSearchIndex + 1} / {searchHits.length} · Page {searchHits[currentSearchIndex]?.page ?? currentPage}</span><button className="icon-button" onClick={() => navigateToSearchHit(currentSearchIndex + 1)} aria-label="Next search match" title="Next match"><ArrowRight size={14} /></button></div>}</div>{searchHits.map((hit, index) => <button key={`${hit.page}-${hit.offset}`} className={index === currentSearchIndex ? 'pdf-search-result-active' : ''} aria-current={index === currentSearchIndex ? 'true' : undefined} onClick={() => navigateToSearchHit(index)}><span>Match {index + 1} · Page {hit.page}</span><small>{hit.excerpt}</small></button>)}{searchTruncated && <small className="pdf-search-truncated">Search stopped at 2,000 matches.</small>}</div>}
              <section className="pdf-edit-tools"><div className="pdf-tools-heading"><div><span className="eyebrow">COPY-BASED PAGE TOOLS</span><h2>Create a new PDF copy</h2></div><span className="pdf-original-badge">Original stays unchanged</span></div>
                <p className="pdf-page-copy-note" role="note">Rotate, extract, reorder, and merge re-read selected files and verify their bytes before saving a separate local copy. Each source and output is limited to {formatBytes(MAX_LOCAL_FILE_BYTES)}; page copies are limited to {MAX_PDF_PAGE_OPERATION_PAGES} pages. Merges accept up to {MAX_PDF_MERGE_INPUTS} PDFs, {formatBytes(MAX_PDF_MERGE_TOTAL_INPUT_BYTES)} combined source bytes, and {MAX_PDF_PAGE_OPERATION_PAGES} total pages. Digital signatures and some embedded PDF features or metadata may not be preserved. For these four actions, Office sidecar annotations and comments are not copied; the separate “Flatten local marks” action below can include only verified visual marks, while comments and note text stay excluded. Source files and sidecars stay unchanged; nothing is uploaded.{pageCopyLimitMessage ? ` ${pageCopyLimitMessage}` : ''}</p>
                <div className="pdf-tool-card pdf-annotated-copy-card"><div><strong>Flatten local marks into a separate copy</strong><small>This writes verified highlights, underlines, and strike-throughs into page content. They will not be editable PDF annotation objects; comments and note text are excluded.</small><small className="pdf-annotated-copy-status" role="status">{annotatedCopyStatus}</small></div><button className="button-secondary" onClick={() => void exportAnnotatedCopy()} disabled={annotatedCopyDisabled}>{busy ? 'Working…' : 'Create annotated copy'}</button><small className="pdf-annotated-copy-warning">This browser-only operation does not change the source. It may not preserve digital signatures or advanced form behavior.</small></div>
                <div className="pdf-tool-card"><div><strong>Rotate current page</strong><small>Apply a 90° rotation to page {currentPage} in a saved copy.</small></div><button className="button-tertiary" onClick={exportRotatedPage} disabled={pageCopyDisabled}><RotateCw size={14} /> Rotate copy</button></div>
                <div className="pdf-tool-card pdf-tool-range"><div><strong>Extract pages</strong><small>Enter individual page numbers or inclusive ranges, such as 1-3,5.</small></div><div className="pdf-tool-controls"><input aria-label="Pages to extract" value={pageRange} onChange={(event) => setPageRange(event.target.value)} /><button className="button-tertiary" onClick={exportExtract} disabled={pageCopyDisabled}>Extract copy</button></div></div>
                <div className="pdf-tool-card pdf-tool-range"><div><strong>Reorder pages</strong><small>Move the current page in the order list, then save the reordered copy.</small></div><div className="pdf-tool-controls"><button className="button-tertiary" onClick={() => movePageInOrder(-1)} disabled={busy || pageOrder.indexOf(currentPage) <= 0}>Move earlier</button><button className="button-tertiary" onClick={() => movePageInOrder(1)} disabled={busy || pageOrder.indexOf(currentPage) < 0 || pageOrder.indexOf(currentPage) >= pageOrder.length - 1}>Move later</button><button className="button-secondary" onClick={() => void exportReordered()} disabled={pageCopyDisabled || pageOrder.length < 2}>Save order</button></div></div>
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
