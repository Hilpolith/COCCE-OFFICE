import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrostedConfirm } from './FrostedConfirm';
import type { ChangeEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Extension, Node as TiptapNode, mergeAttributes } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Underline from '@tiptap/extension-underline';
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Selection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { OfficeDocument } from './lib/localStore';
import { activeDocsTable, countDocsTablesWithoutHeaderRow, DOCS_TABLE_LIMITS, DOCS_TABLE_LIMITS_COPY, docsTableDocumentViolation, docsTableGridViolation, inspectDocsTableUsage } from './lib/docsTableLimits';
import { initialDocumentHtml, markdownToRichHtml, plainTextToRichHtml, richTextToMarkdown, richTextToPlainText, sanitizeRichTextHtml, sanitizeRichTextHtmlWithWarnings } from './lib/documentEditor';
import { DocsHighlight, DocsLink, DocsTextAlign, DocsTextStyle, safeDocsLinkHref } from './lib/docsFormattingExtensions';
import {
  createDocsReviewComment, deleteDocsReviewComment, listDocsReviewComments,
  mapDocsReviewCommentAnchors, MAX_DOCS_REVIEW_COMMENT_CHARS, MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT,
  MAX_DOCS_REVIEW_QUOTE_CHARS, reconcileDocsReviewCommentAnchors, replaceDocsReviewComments,
  saveDocsReviewComment,
} from './lib/docsReviewComments';
import type { DocsReviewComment } from './lib/docsReviewComments';
import { findDocsTextMatches, MAX_DOCS_FIND_MATCHES, MAX_DOCS_FIND_QUERY_CHARS, MAX_DOCS_FIND_REPLACEMENT_CHARS, replaceDocsTextMatches } from './lib/docsFindReplace';
import type { DocsTextMatch } from './lib/docsFindReplace';
import OfficeAiWriter from './OfficeAiWriter';
import { OfficeWorkbenchLayout } from './OfficeWorkbench';
import DocsCloudPanel from './DocsCloudPanel';
import type { DocsCloudSnapshot } from './lib/docsCloudSnapshot';
import './docs.css';
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, ArrowDown, ArrowLeftToLine, ArrowRightToLine, ArrowUpRight, Bold, Check, ChevronLeft, Columns3,
  FileText, Heading1, Heading2, Heading3, Highlighter, Italic, Link2, List, ListOrdered, LockKeyhole, MessageSquarePlus, Code, Eraser, Minus, Palette, ImagePlus,
  Pilcrow, Quote, Redo2, Replace, Rows3, Search, Strikethrough, Table2, Trash2, RotateCcw,
  Underline as UnderlineIcon, Undo2, X,
} from 'lucide-react';

type DocumentPatch = Partial<Pick<OfficeDocument, 'title' | 'content' | 'richText'>>;

function friendlyDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso));
}

const DocsImage = TiptapNode.create({
  name: 'docsImage',
  group: 'block',
  atom: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: null },
      alt: { default: '' },
      width: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: 'img[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    const rawWidth = Number(HTMLAttributes.width);
    const widthStyle = Number.isInteger(rawWidth) && rawWidth >= 80 && rawWidth <= 1600 ? `${rawWidth}px` : '100%';
    return ['img', mergeAttributes(HTMLAttributes, {
      class: 'docs-inline-image',
      style: `width:${widthStyle};max-width:100%;height:auto;display:block;margin:14px auto`,
      loading: 'lazy',
      decoding: 'async',
    })];
  },
});

async function prepareDocsImage(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
    throw new Error('Choose a PNG, JPEG or WebP image.');
  }
  if (file.size <= 0 || file.size > 12 * 1024 * 1024) {
    throw new Error('Images must be smaller than 12 MB before compression.');
  }
  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error('The selected image could not be decoded.'));
      image.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
  const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
  let width = Math.max(1, Math.round(image.naturalWidth * scale));
  let height = Math.max(1, Math.round(image.naturalHeight * scale));
  let result = '';
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const canvas = window.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser could not prepare the image.');
    context.drawImage(image, 0, 0, width, height);
    result = canvas.toDataURL('image/webp', Math.max(0.55, 0.84 - attempt * 0.06));
    if (!result.startsWith('data:image/webp;base64,')) result = canvas.toDataURL('image/jpeg', 0.78);
    if (result.length <= 1_800_000) break;
    width = Math.max(1, Math.round(width * 0.78));
    height = Math.max(1, Math.round(height * 0.78));
  }
  if (!result || result.length > 1_800_000) {
    throw new Error('This image is too detailed to embed safely. Choose a smaller image.');
  }
  return result;
}

function createDocsTableGuard(onRejected: (message: string) => void) {
  return Extension.create({
    name: 'cocceDocsTableBounds',
    addProseMirrorPlugins() {
      return [new Plugin({
        filterTransaction(transaction) {
          if (!transaction.docChanged) return true;
          const violation = docsTableDocumentViolation(transaction.doc);
          if (violation) {
            onRejected(violation);
            return false;
          }
          return true;
        },
      })];
    },
  });
}

interface DocsReviewScope {
  workspaceId: string | null;
  documentId: string;
  key: string;
}

interface DocsReviewCommentDraft {
  scopeKey: string;
  from: number;
  to: number;
  quote: string;
  body: string;
  document: ProseMirrorNode;
}

interface LoadedDocsReviewComments {
  comments: DocsReviewComment[];
  notice: string;
}

interface DocsReviewCommentPluginState {
  scopeKey: string;
  comments: DocsReviewComment[];
  decorations: DecorationSet;
}

const docsReviewCommentPluginKey = new PluginKey<DocsReviewCommentPluginState>('cocceDocsReviewComments');

function makeDocsReviewScope(workspaceId: string | null, documentId: string): DocsReviewScope {
  return { workspaceId, documentId, key: JSON.stringify([workspaceId, documentId]) };
}

function updateDocsReviewCommentStatus(comment: DocsReviewComment, status: DocsReviewComment['status']): DocsReviewComment {
  return { ...comment, status, updatedAt: new Date().toISOString() };
}

function loadDocsReviewComments(scope: DocsReviewScope): LoadedDocsReviewComments {
  try { return { comments: listDocsReviewComments(window.localStorage, scope.workspaceId, scope.documentId), notice: '' }; }
  catch (error) {
    const detail = error instanceof Error ? error.message : 'Saved comments could not be read.';
    return { comments: [], notice: `Local review comments could not be loaded: ${detail}` };
  }
}

function createDocsReviewCommentPluginState(
  doc: ProseMirrorNode,
  scope: DocsReviewScope,
  comments: DocsReviewComment[],
): DocsReviewCommentPluginState {
  const reconciled = reconcileDocsReviewCommentAnchors(comments, doc);
  const decorations = reconciled.flatMap((comment) => {
    if (comment.status !== 'open' || comment.anchorState !== 'attached'
      || comment.from < 0 || comment.to <= comment.from || comment.to > doc.content.size) return [];
    return [Decoration.inline(comment.from, comment.to, {
      class: 'docs-review-comment-anchor',
      'data-docs-review-comment-id': comment.id,
    }, { inclusiveStart: false, inclusiveEnd: false })];
  });
  return { scopeKey: scope.key, comments: reconciled, decorations: DecorationSet.create(doc, decorations) };
}

interface DocsReviewCommentExtensionStorage {
  scope: DocsReviewScope;
  comments: DocsReviewComment[];
}

function createDocsReviewCommentExtension() {
  return Extension.create({
    name: 'cocceDocsReviewCommentDecorations',
    addStorage() {
      return { scope: makeDocsReviewScope(null, ''), comments: [] };
    },
    addProseMirrorPlugins() {
      const storage = this.storage as DocsReviewCommentExtensionStorage;
      return [new Plugin<DocsReviewCommentPluginState>({
        key: docsReviewCommentPluginKey,
        state: {
          init: (_config, state) => createDocsReviewCommentPluginState(state.doc, storage.scope, storage.comments),
          apply: (transaction, previous, _oldState, newState) => {
            const scope = storage.scope;
            const supplied = transaction.getMeta(docsReviewCommentPluginKey) as DocsReviewComment[] | undefined;
            if (scope.key !== previous.scopeKey) return createDocsReviewCommentPluginState(newState.doc, scope, storage.comments);
            if (supplied) {
              storage.comments = supplied;
              return createDocsReviewCommentPluginState(newState.doc, scope, supplied);
            }
            if (transaction.docChanged) {
              const mapped = mapDocsReviewCommentAnchors(previous.comments, transaction.mapping, newState.doc);
              storage.comments = mapped;
              return createDocsReviewCommentPluginState(newState.doc, scope, mapped);
            }
            return previous;
          },
        },
        props: { decorations: (state) => docsReviewCommentPluginKey.getState(state)?.decorations ?? DecorationSet.empty },
      })];
    },
  });
}

function getDocsReviewCommentExtensionStorage(editor: Editor): DocsReviewCommentExtensionStorage {
  return (editor.storage as unknown as Record<string, DocsReviewCommentExtensionStorage>).cocceDocsReviewCommentDecorations;
}

function FormattingButton({ label, icon, active, disabled, onClick }: {
  label: string; icon: ReactNode; active?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return <button type="button" className="docs-format-button" aria-label={label} title={label}
    aria-pressed={active} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{icon}</button>;
}

function TableActionButton({ label, icon, disabled, pressed, onClick }: {
  label: string; icon: ReactNode; disabled?: boolean; pressed?: boolean; onClick: () => void;
}) {
  return <button type="button" className="docs-table-action" aria-label={label} aria-pressed={pressed} disabled={disabled}
    onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{icon}<span>{label}</span></button>;
}

type DocsTableSelectionKind = 'row' | 'column' | 'table';

function docsTableCellSelectionRange(selection: Selection, kind: DocsTableSelectionKind) {
  const activeCellPosition = selection instanceof CellSelection ? selection.$anchorCell : selection.$from;
  let tableDepth = -1;
  for (let depth = activeCellPosition.depth; depth > 0; depth -= 1) {
    if (activeCellPosition.node(depth).type.name === 'table') { tableDepth = depth; break; }
  }
  if (tableDepth < 0) return null;

  const tablePosition = activeCellPosition.before(tableDepth);
  const table = activeCellPosition.node(tableDepth);
  const rowIndex = activeCellPosition.index(tableDepth);
  const columnIndex = activeCellPosition.index(tableDepth + 1);
  const cellPositions: number[][] = [];
  table.forEach((row, rowOffset) => {
    const rowPositions: number[] = [];
    row.forEach((cell, cellOffset) => {
      if (cell.type.name !== 'tableCell' && cell.type.name !== 'tableHeader') return;
      rowPositions.push(tablePosition + 1 + rowOffset + 1 + cellOffset);
    });
    cellPositions.push(rowPositions);
  });

  if (cellPositions.length === 0 || cellPositions.some((row) => row.length !== cellPositions[0]?.length)) return null;
  const currentRow = cellPositions[rowIndex];
  if (!currentRow || !currentRow[columnIndex]) return null;
  if (kind === 'row') return { anchorCell: currentRow[0]!, headCell: currentRow[currentRow.length - 1]! };
  if (kind === 'column') {
    const columnCells = cellPositions.map((row) => row[columnIndex]);
    if (columnCells.some((position) => position === undefined)) return null;
    return { anchorCell: columnCells[0]!, headCell: columnCells[columnCells.length - 1]! };
  }
  return { anchorCell: cellPositions[0]![0]!, headCell: cellPositions[cellPositions.length - 1]![cellPositions[0]!.length - 1]! };
}

export default function DocsEditor({ document, hasUnsavedChanges, onPatch, onBack, onExport, onExportDocx, onDelete, onGoToTeam, onRestoreCloudCopy }: {
  document: OfficeDocument;
  hasUnsavedChanges: boolean;
  onPatch: (patch: DocumentPatch) => boolean;
  onBack: () => void;
  onExport: (richText: string) => void;
  onExportDocx: (richText: string) => void | Promise<void>;
  onDelete: () => void;
  onGoToTeam: () => void;
  onRestoreCloudCopy?: (snapshot: DocsCloudSnapshot) => boolean;
}) {
  const confirm = useFrostedConfirm();
  const patchRef = useRef(onPatch);
  const [cloudOpen, setCloudOpen] = useState(false);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [imageNotice, setImageNotice] = useState('');
  const [activeRibbonTab, setActiveRibbonTab] = useState<'home' | 'insert' | 'review' | 'view'>('home');
  const [sourceMode, setSourceMode] = useState<'html' | 'markdown' | null>(null);
  const [sourceText, setSourceText] = useState('');
  const [sourceNotice, setSourceNotice] = useState('');
  const [pageZoom, setPageZoom] = useState('100%');
  const cloudEnabled = import.meta.env.VITE_OFFICE_CLOUD_FILES_READY === 'true' && Boolean(onRestoreCloudCopy);
  const [tableNotice, setTableNotice] = useState('');
  const tableGuard = useMemo(() => createDocsTableGuard(setTableNotice), []);
  const initialReviewScope = makeDocsReviewScope(document.workspaceId, document.id);
  const [initialReviewData] = useState(() => loadDocsReviewComments(initialReviewScope));
  const [reviewComments, setReviewComments] = useState(initialReviewData.comments);
  const reviewCommentsRef = useRef(initialReviewData.comments);
  const reviewCommentScopeRef = useRef(initialReviewScope);
  const loadedDocumentScope = useRef(initialReviewScope.key);
  const suppressCommentAnchorPersistence = useRef(false);
  const [commentDraft, setCommentDraft] = useState<DocsReviewCommentDraft | null>(null);
  const [reviewCommentNotice, setReviewCommentNotice] = useState(initialReviewData.notice);
  const [reviewCommentError, setReviewCommentError] = useState(Boolean(initialReviewData.notice));
  const reviewCommentExtension = useMemo(() => createDocsReviewCommentExtension(), []);
  const [initialHtml] = useState(() => initialDocumentHtml(document.content, document.richText));
  const [insertRows, setInsertRows] = useState('3');
  const [insertColumns, setInsertColumns] = useState('3');
  const [fontFamily, setFontFamily] = useState('Arial');
  const [fontSize, setFontSize] = useState('12pt');
  const [textColor, setTextColor] = useState('#202733');
  const [highlightColor, setHighlightColor] = useState('#fff2a8');
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findReplacement, setFindReplacement] = useState('');
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findMatchIndex, setFindMatchIndex] = useState(0);
  const [findDocumentRevision, setFindDocumentRevision] = useState(0);
  const [findNotice, setFindNotice] = useState<{ text: string; error: boolean }>({ text: '', error: false });
  const findInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => { patchRef.current = onPatch; }, [onPatch]);

  const saveEditor = (activeEditor: Editor, extraPatch: DocumentPatch = {}): boolean => {
    const sanitized = sanitizeRichTextHtmlWithWarnings(activeEditor.getHTML());
    const notice = sanitized.warnings.join(' ');
    setTableNotice((current) => current === notice ? current : notice);
    if (notice) activeEditor.commands.setContent(sanitized.html, { emitUpdate: false });
    return patchRef.current({ content: richTextToPlainText(sanitized.html), richText: sanitized.html, ...extraPatch });
  };

  const editor = useEditor({
    extensions: [StarterKit.configure({
      heading: { levels: [1, 2, 3] }, link: false, underline: false,
    }), Underline, DocsImage, TableKit.configure({ table: { resizable: false, renderWrapper: true, allowTableNodeSelection: false } }), DocsTextStyle, DocsHighlight, DocsLink, DocsTextAlign, reviewCommentExtension, tableGuard],
    content: initialHtml,
    editorProps: {
      attributes: { class: 'rich-text-editor', role: 'textbox', 'aria-label': 'Document content', 'aria-multiline': 'true', spellcheck: 'true' },
      handlePaste(view, event) {
        event.preventDefault();
        const text = event.clipboardData?.getData('text/plain') ?? '';
        const fragment = window.document.createElement('div');
        fragment.innerHTML = plainTextToRichHtml(text);
        const slice = ProseMirrorDOMParser.fromSchema(view.state.schema).parseSlice(fragment, { preserveWhitespace: 'full' });
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
        return true;
      },
      handleDrop: () => true,
    },
    onUpdate: ({ editor: activeEditor }) => { saveEditor(activeEditor); },
    onBlur: ({ editor: activeEditor }) => { saveEditor(activeEditor); },
    onTransaction: ({ editor: activeEditor, transaction }) => {
      if (transaction.docChanged) {
        setFindDocumentRevision((revision) => revision + 1);
        setFindMatchIndex(0);
      }
      if (!transaction.docChanged || suppressCommentAnchorPersistence.current) return;
      const pluginState = docsReviewCommentPluginKey.getState(activeEditor.state);
      const scope = reviewCommentScopeRef.current;
      if (!pluginState || pluginState.scopeKey !== scope.key || pluginState.comments.length === 0) return;
      const before = reviewCommentsRef.current;
      const anchorsChanged = before.length !== pluginState.comments.length || before.some((comment, index) => {
        const next = pluginState.comments[index];
        return !next || comment.id !== next.id || comment.from !== next.from || comment.to !== next.to
          || comment.anchorState !== next.anchorState;
      });
      if (!anchorsChanged) return;
      reviewCommentsRef.current = pluginState.comments;
      setReviewComments(pluginState.comments);
      try {
        replaceDocsReviewComments(window.localStorage, scope.workspaceId, scope.documentId, pluginState.comments);
        setReviewCommentNotice('');
        setReviewCommentError(false);
      } catch (error) {
        const detail = error instanceof Error ? error.message : 'The updated anchor could not be saved.';
        setReviewCommentNotice(`The document edit remains local, but review-comment anchors could not be updated: ${detail}`);
        setReviewCommentError(true);
      }
    },
  });

  const findResult = useMemo(() => {
    const sourceDoc = editor?.state.doc ?? null;
    if (!editor || !findQuery) return { matches: [] as DocsTextMatch[], error: '', revision: findDocumentRevision, sourceDoc };
    try { return { matches: findDocsTextMatches(editor.state.doc, findQuery, findCaseSensitive), error: '', revision: findDocumentRevision, sourceDoc }; }
    catch (error) { return { matches: [] as DocsTextMatch[], error: error instanceof Error ? error.message : 'Document search failed.', revision: findDocumentRevision, sourceDoc }; }
  }, [editor, findCaseSensitive, findDocumentRevision, findQuery]);

  useEffect(() => {
    if (findOpen) findInputRef.current?.focus();
  }, [findOpen]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const nextScope = makeDocsReviewScope(document.workspaceId, document.id);
    const extensionStorage = getDocsReviewCommentExtensionStorage(editor);
    if (loadedDocumentScope.current === nextScope.key) {
      let pluginState = docsReviewCommentPluginKey.getState(editor.state);
      if (pluginState?.scopeKey !== nextScope.key) {
        extensionStorage.scope = nextScope;
        extensionStorage.comments = reviewCommentsRef.current;
        editor.view.dispatch(editor.state.tr.setMeta(docsReviewCommentPluginKey, extensionStorage.comments));
        pluginState = docsReviewCommentPluginKey.getState(editor.state);
      }
      const currentComments = pluginState?.comments;
      if (currentComments && JSON.stringify(currentComments) !== JSON.stringify(reviewCommentsRef.current)) {
        reviewCommentsRef.current = currentComments;
        setReviewComments(currentComments);
      }
      return;
    }
    const loaded = loadDocsReviewComments(nextScope);
    setFindQuery('');
    setFindReplacement('');
    setFindMatchIndex(0);
    setFindNotice({ text: '', error: false });
    setFindDocumentRevision((revision) => revision + 1);
    reviewCommentScopeRef.current = nextScope;
    reviewCommentsRef.current = loaded.comments;
    extensionStorage.scope = nextScope;
    extensionStorage.comments = loaded.comments;
    setReviewComments(loaded.comments);
    setCommentDraft(null);
    setReviewCommentNotice(loaded.notice);
    setReviewCommentError(Boolean(loaded.notice));
    suppressCommentAnchorPersistence.current = true;
    try {
      editor.commands.setContent(initialDocumentHtml(document.content, document.richText), { emitUpdate: false });
      editor.view.dispatch(editor.state.tr.setMeta(docsReviewCommentPluginKey, extensionStorage.comments));
      const currentComments = docsReviewCommentPluginKey.getState(editor.state)?.comments ?? loaded.comments;
      reviewCommentsRef.current = currentComments;
      setReviewComments(currentComments);
      loadedDocumentScope.current = nextScope.key;
    } finally {
      suppressCommentAnchorPersistence.current = false;
    }
  }, [editor, document.id, document.workspaceId, document.content, document.richText]);

  useEffect(() => {
    const match = findResult.matches[0];
    if (!findOpen || !editor || !findQuery || findResult.error || findResult.sourceDoc !== editor.state.doc || !match) return;
    const selection = editor.state.selection;
    if (selection.from === match.from && selection.to === match.to) return;
    editor.view.dispatch(editor.state.tr
      .setSelection(TextSelection.create(editor.state.doc, match.from, match.to))
      .scrollIntoView());
  }, [editor, findOpen, findQuery, findResult]);

  const editorState = useEditorState({
    editor,
    selector: ({ editor: activeEditor }) => {
      if (!activeEditor) return {
        bold: false, italic: false, underline: false, heading1: false, heading2: false, heading3: false,
        strike: false, paragraph: false, bulletList: false, orderedList: false, blockquote: false,
        canUndo: false, canRedo: false, empty: true, wordCount: 0, tableActive: false, tableRows: 0, tableColumns: 0,
        tableCount: 0, tableTextChars: 0, tableHeaderRow: false, hasTextSelection: false, selectedCells: 0, imageActive: false, imageWidth: null,
      };
      const activeTable = activeDocsTable(activeEditor.state.selection);
      const usage = inspectDocsTableUsage(activeEditor.state.doc);
      const selection = activeEditor.state.selection;
      let selectedCells = 0;
      if (selection instanceof CellSelection) selection.forEachCell(() => { selectedCells += 1; });
      return {
        bold: activeEditor.isActive('bold'),
        italic: activeEditor.isActive('italic'),
        underline: activeEditor.isActive('underline'),
        heading1: activeEditor.isActive('heading', { level: 1 }),
        heading2: activeEditor.isActive('heading', { level: 2 }),
        heading3: activeEditor.isActive('heading', { level: 3 }),
        strike: activeEditor.isActive('strike'),
        paragraph: activeEditor.isActive('paragraph'),
        bulletList: activeEditor.isActive('bulletList'),
        orderedList: activeEditor.isActive('orderedList'),
        blockquote: activeEditor.isActive('blockquote'),
        canUndo: activeEditor.can().undo(),
        canRedo: activeEditor.can().redo(),
        empty: activeEditor.isEmpty,
        wordCount: activeEditor.getText().trim() ? activeEditor.getText().trim().split(/\s+/u).length : 0,
        tableActive: Boolean(activeTable),
        tableRows: activeTable?.rows ?? 0,
        tableColumns: activeTable?.columns ?? 0,
        tableCount: usage.count,
        tableTextChars: usage.textChars,
        tableHeaderRow: activeTable?.headerRow ?? false,
        hasTextSelection: !(selection instanceof CellSelection) && !selection.empty
          && activeEditor.state.doc.textBetween(selection.from, selection.to, '\n').trim().length > 0,
        selectedCells,
      };
    },
  });

  const normalizedSourceText = sourceText.trim();
  const documentWordCount = sourceMode
    ? (normalizedSourceText ? normalizedSourceText.split(/\s+/u).length : 0)
    : editorState.wordCount;

  const insertTable = () => {
    if (!editor) return;
    const rows = Number(insertRows);
    const columns = Number(insertColumns);
    if (!Number.isInteger(rows) || !Number.isInteger(columns)) {
      setTableNotice('Enter whole-number row and column counts.');
      return;
    }
    const usage = inspectDocsTableUsage(editor.state.doc);
    const emptyGrid = Array.from({ length: Math.max(0, rows) }, () => ({ cells: Array.from({ length: Math.max(0, columns) }, () => '') }));
    const violation = docsTableGridViolation(emptyGrid, usage.count, usage.textChars);
    if (violation) {
      setTableNotice(violation);
      return;
    }
    setTableNotice('');
    editor.chain().focus().insertTable({ rows, cols: columns, withHeaderRow: true }).run();
  };

  const selectTableCells = (kind: DocsTableSelectionKind) => {
    if (!editor) return;
    const range = docsTableCellSelectionRange(editor.state.selection, kind);
    if (!range) {
      setTableNotice('Select a cell in a simple table before choosing a row, column, or table.');
      return;
    }
    setTableNotice('');
    editor.chain().focus().setCellSelection(range).run();
  };

  const showReviewCommentNotice = (message: string, isError = false) => {
    setReviewCommentNotice(message);
    setReviewCommentError(isError);
  };

  const beginReviewComment = () => {
    if (!editor) return;
    const selection = editor.state.selection;
    const quote = selection.empty || selection instanceof CellSelection
      ? ''
      : editor.state.doc.textBetween(selection.from, selection.to, '\n');
    if (!quote.trim()) {
      showReviewCommentNotice('Select text in the document before adding a review comment.', true);
      return;
    }
    if (quote.length > MAX_DOCS_REVIEW_QUOTE_CHARS) {
      showReviewCommentNotice(`Select ${MAX_DOCS_REVIEW_QUOTE_CHARS.toLocaleString()} characters or fewer for a review comment.`, true);
      return;
    }
    const scope = reviewCommentScopeRef.current;
    setCommentDraft({ scopeKey: scope.key, from: selection.from, to: selection.to, quote, body: '', document: editor.state.doc });
    showReviewCommentNotice('');
  };

  const saveReviewComment = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editor || !commentDraft) return;
    const scope = reviewCommentScopeRef.current;
    if (commentDraft.scopeKey !== scope.key || !editor.state.doc.eq(commentDraft.document)
      || editor.state.doc.textBetween(commentDraft.from, commentDraft.to, '\n') !== commentDraft.quote) {
      showReviewCommentNotice('The selected text changed. Select it again before saving this comment.', true);
      return;
    }
    try {
      const nextComment = createDocsReviewComment({
        workspaceId: scope.workspaceId,
        documentId: scope.documentId,
        from: commentDraft.from,
        to: commentDraft.to,
        quote: commentDraft.quote,
        body: commentDraft.body,
      });
      saveDocsReviewComment(window.localStorage, nextComment);
      const next = [...reviewCommentsRef.current, nextComment];
      reviewCommentsRef.current = next;
      setReviewComments(next);
      editor.view.dispatch(editor.state.tr.setMeta(docsReviewCommentPluginKey, next));
      setCommentDraft(null);
      showReviewCommentNotice('Review comment saved on this device.');
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The comment could not be saved.';
      showReviewCommentNotice(`Review comment not saved: ${detail}`, true);
    }
  };

  const setReviewCommentStatus = (comment: DocsReviewComment, status: DocsReviewComment['status']) => {
    const current = reviewCommentsRef.current.find((item) => item.id === comment.id);
    if (!current) return;
    const updated = updateDocsReviewCommentStatus(current, status);
    const next = reviewCommentsRef.current.map((item) => item.id === comment.id ? updated : item);
    try {
      saveDocsReviewComment(window.localStorage, updated);
      reviewCommentsRef.current = next;
      setReviewComments(next);
      editor?.view.dispatch(editor.state.tr.setMeta(docsReviewCommentPluginKey, next));
      showReviewCommentNotice(status === 'resolved' ? 'Comment resolved locally.' : 'Comment reopened locally.');
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The comment status could not be saved.';
      showReviewCommentNotice(`Comment status not saved: ${detail}`, true);
    }
  };

  const removeReviewComment = async (comment: DocsReviewComment, index: number) => {
    if (!await confirm('Delete this review comment from this device? This removes only the local comment.')) return;
    const scope = reviewCommentScopeRef.current;
    try {
      deleteDocsReviewComment(window.localStorage, scope.workspaceId, scope.documentId, comment.id);
      const next = reviewCommentsRef.current.filter((item) => item.id !== comment.id);
      reviewCommentsRef.current = next;
      setReviewComments(next);
      editor?.view.dispatch(editor.state.tr.setMeta(docsReviewCommentPluginKey, next));
      showReviewCommentNotice(`Review comment ${index + 1} deleted from this device.`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The comment could not be deleted.';
      showReviewCommentNotice(`Review comment not deleted: ${detail}`, true);
    }
  };

  const readCurrentFindMatches = (): DocsTextMatch[] | null => {
    if (!editor) return null;
    try { return findDocsTextMatches(editor.state.doc, findQuery, findCaseSensitive); }
    catch (error) {
      setFindNotice({ text: error instanceof Error ? error.message : 'Document search failed.', error: true });
      return null;
    }
  };

  const navigateFindMatch = (direction: -1 | 1) => {
    const matches = readCurrentFindMatches();
    if (!matches || !editor) return;
    if (!matches.length) {
      setFindNotice({ text: 'No matches in this document.', error: false });
      return;
    }
    const current = Math.min(findMatchIndex, matches.length - 1);
    const next = (current + direction + matches.length) % matches.length;
    const match = matches[next]!;
    setFindMatchIndex(next);
    editor.view.dispatch(editor.state.tr
      .setSelection(TextSelection.create(editor.state.doc, match.from, match.to))
      .scrollIntoView());
    setFindNotice({ text: `Match ${next + 1} of ${matches.length}.`, error: false });
  };

  const handleFindKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      navigateFindMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setFindOpen(false);
    }
  };

  const replaceCurrentFindMatch = () => {
    if (!editor) return;
    const matches = readCurrentFindMatches();
    if (!matches) return;
    if (!matches.length) {
      setFindNotice({ text: 'No matches in this document; no text was changed.', error: false });
      return;
    }
    const index = Math.min(findMatchIndex, matches.length - 1);
    try {
      const result = replaceDocsTextMatches(editor.state.tr, editor.state.doc, [matches[index]!], findReplacement);
      if (!result.replacedCount) {
        setFindNotice({ text: 'The replacement is identical to this match; no text was changed.', error: false });
        return;
      }
      editor.view.dispatch(result.transaction.scrollIntoView());
      setFindNotice({ text: 'Replaced the current match. Use Undo to restore it.', error: false });
    } catch (error) {
      setFindNotice({ text: error instanceof Error ? error.message : 'The current match could not be replaced.', error: true });
    }
  };

  const replaceAllFindMatches = async () => {
    if (!editor) return;
    const matches = readCurrentFindMatches();
    if (!matches) return;
    if (!matches.length) {
      setFindNotice({ text: 'No matches in this document; no text was changed.', error: false });
      return;
    }
    if (matches.every((match) => match.text === findReplacement)) {
      setFindNotice({ text: 'The replacement already matches every result; no text was changed.', error: false });
      return;
    }
    const approved = await confirm(`Replace all ${matches.length.toLocaleString()} matches in this local document? This is one undoable edit; no document text is sent anywhere.`);
    if (!approved) {
      setFindNotice({ text: 'Replace all cancelled; no text was changed.', error: false });
      return;
    }
    try {
      const result = replaceDocsTextMatches(editor.state.tr, editor.state.doc, matches, findReplacement);
      if (!result.replacedCount) {
        setFindNotice({ text: 'No text was changed.', error: false });
        return;
      }
      editor.view.dispatch(result.transaction.scrollIntoView());
      const skipped = result.unchangedCount ? ` ${result.unchangedCount} already matched the replacement.` : '';
      setFindNotice({ text: `Replaced ${result.replacedCount.toLocaleString()} matches.${skipped} Undo restores the whole edit.`, error: false });
    } catch (error) {
      setFindNotice({ text: error instanceof Error ? error.message : 'Replace all failed; no text was changed.', error: true });
    }
  };

  const applyTextAlign = (alignment: 'left' | 'center' | 'right' | 'justify') => {
    if (!editor) return;
    editor.chain().focus()
      .updateAttributes('paragraph', { textAlign: alignment })
      .updateAttributes('heading', { textAlign: alignment })
      .run();
  };

  const insertLink = () => {
    if (!editor) return;
    if (editor.state.selection.empty) {
      setTableNotice('Select the text you want to turn into a link.');
      return;
    }
    const entered = window.prompt('Enter an https://, http:// or mailto: link');
    if (!entered) return;
    const href = safeDocsLinkHref(entered);
    if (!href) {
      setTableNotice('Only valid http, https and mailto links are supported.');
      return;
    }
    setTableNotice('');
    editor.chain().focus().setMark('docsLink', { href }).run();
  };

  const insertImageFile = async (file: File) => {
    if (!editor || editor.isDestroyed) throw new Error('The document editor is not ready for image insertion.');
    setImageNotice('');
    try {
      const src = await prepareDocsImage(file);
      if (editor.isDestroyed) throw new Error('The document editor closed before the image could be inserted.');
      editor.chain().focus().insertContent({
        type: 'docsImage',
        attrs: { src, alt: file.name.replace(/[<>]/g, '').slice(0, 180), width: null },
      }).run();
    } catch (reason) {
      setImageNotice(reason instanceof Error ? reason.message : 'The image could not be inserted.');
      throw reason;
    }
  };

  const insertImage = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) {
      try { await insertImageFile(file); }
      catch { /* The editor displays the specific insertion error inline. */ }
    }
  };

  const downloadLocalText = (extension: string, mime: string, contents: string, success: string) => {
    const safeName = (document.title || 'document').replace(/[\\\\/:*?"<>|]/g, '-').trim().slice(0, 100) || 'document';
    const blob = new Blob([contents], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement('a');
    anchor.href = url;
    anchor.download = safeName + '.' + extension;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setTableNotice(success);
  };
  const exportHtml = () => {
    if (!editor) return;
    const title = (document.title || 'Document').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
    const safeBody = sanitizeRichTextHtmlWithWarnings(editor.getHTML()).html;
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title + '</title><style>body{font:16px/1.65 Arial,sans-serif;max-width:850px;margin:48px auto;padding:0 24px;color:#20242b}img{max-width:100%;height:auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #cbd0d8;padding:8px;text-align:left}</style></head><body><main>' + safeBody + '</main></body></html>';
    downloadLocalText('html', 'text/html;charset=utf-8', html, 'Standalone HTML downloaded on this device.');
  };
  const exportPlainText = () => {
    if (!editor) return;
    const safeBody = sanitizeRichTextHtmlWithWarnings(editor.getHTML()).html;
    downloadLocalText('txt', 'text/plain;charset=utf-8', richTextToPlainText(safeBody), 'Plain-text file downloaded on this device.');
  };

  const exportMarkdown = async () => {
    if (!editor) {
      setTableNotice('The document editor is still loading; nothing was exported.');
      return;
    }
    const headerlessTables = countDocsTablesWithoutHeaderRow(editor.state.doc);
    if (headerlessTables > 0) {
      const tableLabel = headerlessTables === 1 ? 'table has' : 'tables have';
      const approved = await confirm(`Markdown table syntax requires a header row. ${headerlessTables} table ${tableLabel} no header row, so export will treat each first row as a header. Continue?`);
      if (!approved) {
        setTableNotice('Markdown export cancelled; the document was not changed.');
        return;
      }
    }
    setTableNotice('');
    onExport(editor.getHTML());
  };

  const openSourceMode = (mode: 'html' | 'markdown') => {
    if (!editor) return;
    if (sourceMode && sourceText.length > 1_000_000) {
      setSourceNotice('Source text is limited to 1,000,000 characters. Shorten it before switching formats.');
      return;
    }
    const currentHtml = sourceMode
      ? sourceMode === 'html' ? sanitizeRichTextHtml(sourceText) : markdownToRichHtml(sourceText).html
      : editor.getHTML();
    setSourceText(mode === 'html' ? currentHtml : richTextToMarkdown(currentHtml, document.content));
    setSourceMode(mode);
    setSourceNotice('');
  };

  const applySourceChanges = () => {
    if (!editor || !sourceMode) return;
    if (sourceText.length > 1_000_000) {
      setSourceNotice('Source text is limited to 1,000,000 characters. Nothing was applied.');
      return;
    }
    const converted = sourceMode === 'markdown'
      ? markdownToRichHtml(sourceText)
      : sanitizeRichTextHtmlWithWarnings(sourceText);
    if (sourceText.trim() && !converted.html.trim()) {
      setSourceNotice(converted.warnings.join(' ') || 'No supported document content remains after sanitization. Nothing was applied.');
      return;
    }
    editor.commands.setContent(converted.html, { emitUpdate: false });
    if (!saveEditor(editor)) {
      setSourceNotice('The source was converted, but local document storage did not confirm the save. Retry Apply before leaving this editor.');
      return;
    }
    setTableNotice(converted.warnings.join(' '));
    setSourceMode(null);
    setSourceText('');
    setSourceNotice('');
  };

  const discardSourceChanges = () => {
    setSourceMode(null);
    setSourceText('');
    setSourceNotice('');
  };

  return <div className={`page editor-page office-editor-page ${sourceMode ? "docs-source-mode" : ""}`.trim()}>
    <input ref={imageInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label="Choose an image to insert" onChange={(event) => void insertImage(event)} />
    <div className="editor-toolbar">
      <button type="button" className="back-button" onClick={onBack}><ChevronLeft size={16} /> All documents</button>
      <div className="editor-actions">
        <span className={`autosave-label ${hasUnsavedChanges ? 'autosave-failed' : ''}`} role="status">
          {hasUnsavedChanges ? <X size={13} /> : <span className="status-dot" />}
          {hasUnsavedChanges ? 'Unsaved · kept in this tab' : 'Saved on this device'}
        </span>
        {hasUnsavedChanges && <button type="button" className="button-secondary small-button" onClick={() => { if (editor) saveEditor(editor); }}>Retry save</button>}
        {cloudEnabled && <button type="button" className="button-secondary small-button" aria-expanded={cloudOpen} aria-controls={cloudOpen ? 'docs-cloud-area' : undefined} onClick={() => setCloudOpen((open) => !open)}>Cloud copies</button>}
        <button type="button" className="button-secondary small-button" aria-expanded={findOpen} aria-controls={findOpen ? 'docs-find-panel' : undefined} onClick={() => { setFindOpen((open) => !open); setFindNotice({ text: '', error: false }); }}><Search size={14} /> Find &amp; Replace</button>
        <button type="button" className="button-secondary small-button" disabled={!editor} onClick={exportMarkdown}><ArrowUpRight size={14} /> Export .md</button>
        <button type="button" className="button-secondary small-button" disabled={!editor} onClick={exportHtml}>Export .html</button>
        <button type="button" className="button-secondary small-button" disabled={!editor} onClick={exportPlainText}>Export .txt</button>
        <button type="button" className="button-secondary small-button" onClick={() => { void onExportDocx(editor?.getHTML() ?? document.richText ?? ''); }}><FileText size={14} /> Export .docx</button>
        <button type="button" className="icon-button danger-button" onClick={onDelete} aria-label="Delete document" title="Delete local document"><X size={16} /></button>
      </div>
    </div>

    {cloudEnabled && cloudOpen && onRestoreCloudCopy && <div id="docs-cloud-area"><DocsCloudPanel key={document.id} document={document} hasUnsavedChanges={hasUnsavedChanges} onRestore={onRestoreCloudCopy} onInsertImage={insertImageFile} onGoToTeam={onGoToTeam} /></div>}

    <OfficeWorkbenchLayout className="docs-workbench-layout" rail={sourceMode ? <div className="office-ai-source-paused" role="status"><span className="office-ai-source-paused-icon"><LockKeyhole size={16} /></span><span className="eyebrow">AI PAUSED</span><strong>Apply or discard source edits</strong><p>COCCE AI resumes when this HTML or Markdown draft is applied to the rich-text document. This prevents the assistant from working on stale content.</p></div> : <OfficeAiWriter editor={editor} documentTitle={document.title} onGoToTeam={onGoToTeam} defaultExpanded />}>
      <div className="docs-editor-main">
    <div className="docs-ribbon-tabs" role="tablist" aria-label="Document ribbon">
      <button type="button" role="tab" aria-selected={activeRibbonTab === 'home'} className={activeRibbonTab === 'home' ? 'is-active' : ''} onClick={() => setActiveRibbonTab('home')}>Home</button>
      <button type="button" role="tab" aria-selected={activeRibbonTab === 'insert'} className={activeRibbonTab === 'insert' ? 'is-active' : ''} onClick={() => setActiveRibbonTab('insert')}>Insert</button>
      <button type="button" role="tab" aria-selected={activeRibbonTab === 'review'} className={activeRibbonTab === 'review' ? 'is-active' : ''} onClick={() => setActiveRibbonTab('review')}>Review</button>
      <button type="button" role="tab" aria-selected={activeRibbonTab === 'view'} className={activeRibbonTab === 'view' ? 'is-active' : ''} onClick={() => setActiveRibbonTab('view')}>View</button>
    </div>
    <div className="docs-format-toolbar glass-card" role="toolbar" aria-label="Document formatting">
      <span className="docs-format-group" aria-label="Paragraph style" hidden={activeRibbonTab !== 'home'}>
        <FormattingButton label="Paragraph" icon={<Pilcrow size={16} />} active={editorState.paragraph} onClick={() => editor?.chain().focus().setParagraph().run()} />
        <FormattingButton label="Heading 1" icon={<Heading1 size={16} />} active={editorState.heading1} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} />
        <FormattingButton label="Heading 2" icon={<Heading2 size={16} />} active={editorState.heading2} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} />
        <FormattingButton label="Heading 3" icon={<Heading3 size={16} />} active={editorState.heading3} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} />
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group docs-format-controls" aria-label="Font controls" hidden={activeRibbonTab !== 'home'}>
        <label className="docs-format-select"><span>Font</span><select aria-label="Font family" value={fontFamily} onChange={(event) => { const value = event.target.value; setFontFamily(value); editor?.chain().focus().setMark('docsTextStyle', { fontFamily: value }).run(); }}><option>Arial</option><option>Aptos</option><option>Calibri</option><option>Cambria</option><option>Georgia</option><option>Times New Roman</option><option>Verdana</option><option>Tahoma</option><option>Trebuchet MS</option><option>Courier New</option><option>Consolas</option><option>Inter</option></select></label>
        <label className="docs-format-select docs-format-size"><span>Size</span><select aria-label="Font size" value={fontSize} onChange={(event) => { const value = event.target.value; setFontSize(value); editor?.chain().focus().setMark('docsTextStyle', { fontSize: value }).run(); }}>{['8pt','9pt','10pt','11pt','12pt','14pt','16pt','18pt','20pt','24pt','28pt','32pt','36pt','48pt','72pt'].map((size) => <option key={size}>{size}</option>)}</select></label>
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group" aria-label="Text style" hidden={activeRibbonTab !== 'home'}>
        <FormattingButton label="Bold" icon={<Bold size={16} />} active={editorState.bold} onClick={() => editor?.chain().focus().toggleBold().run()} />
        <FormattingButton label="Italic" icon={<Italic size={16} />} active={editorState.italic} onClick={() => editor?.chain().focus().toggleItalic().run()} />
        <FormattingButton label="Underline" icon={<UnderlineIcon size={16} />} active={editorState.underline} onClick={() => editor?.chain().focus().toggleUnderline().run()} />
        <FormattingButton label="Strikethrough" icon={<Strikethrough size={16} />} active={editorState.strike} onClick={() => editor?.chain().focus().toggleStrike().run()} />
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group docs-format-color-group" aria-label="Text colour and highlighting" hidden={activeRibbonTab !== 'home'}>
        <label className="docs-format-color-control" title="Text colour"><Palette size={15}/><input aria-label="Text colour" type="color" value={textColor} onChange={(event) => { setTextColor(event.target.value); editor?.chain().focus().setMark('docsTextStyle', { color: event.target.value }).run(); }} /></label>
        <label className="docs-format-color-control" title="Highlight colour"><Highlighter size={15}/><input aria-label="Highlight colour" type="color" value={highlightColor} onChange={(event) => { setHighlightColor(event.target.value); editor?.chain().focus().setMark('docsHighlight', { color: event.target.value }).run(); }} /></label>
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group" aria-label="Lists and quotes" hidden={activeRibbonTab !== 'home'}>
        <FormattingButton label="Bulleted list" icon={<List size={16} />} active={editorState.bulletList} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleBulletList().run()} />
        <FormattingButton label="Numbered list" icon={<ListOrdered size={16} />} active={editorState.orderedList} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleOrderedList().run()} />
        <FormattingButton label="Quote" icon={<Quote size={16} />} active={editorState.blockquote} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleBlockquote().run()} />
        <FormattingButton label="Inline code" icon={<Code size={16} />} onClick={() => editor?.chain().focus().toggleCode().run()} />
        <FormattingButton label="Code block" icon={<Code size={16} />} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleCodeBlock().run()} />
        <FormattingButton label="Clear formatting" icon={<Eraser size={16} />} onClick={() => editor?.chain().focus().unsetAllMarks().clearNodes().updateAttributes('paragraph', { textAlign: null }).updateAttributes('heading', { textAlign: null }).run()} />
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group" aria-label="Paragraph alignment" hidden={activeRibbonTab !== 'home'}>
        <FormattingButton label="Align left" icon={<AlignLeft size={16}/>} onClick={() => applyTextAlign('left')} />
        <FormattingButton label="Center" icon={<AlignCenter size={16}/>} onClick={() => applyTextAlign('center')} />
        <FormattingButton label="Align right" icon={<AlignRight size={16}/>} onClick={() => applyTextAlign('right')} />
        <FormattingButton label="Justify" icon={<AlignJustify size={16}/>} onClick={() => applyTextAlign('justify')} />
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group" aria-label="Edit history" hidden={activeRibbonTab !== 'home'}>
        <FormattingButton label="Undo" icon={<Undo2 size={16} />} disabled={!editorState.canUndo} onClick={() => editor?.chain().focus().undo().run()} />
        <FormattingButton label="Redo" icon={<Redo2 size={16} />} disabled={!editorState.canRedo} onClick={() => editor?.chain().focus().redo().run()} />
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group" aria-label="Insert" hidden={activeRibbonTab !== 'insert'}>
        <FormattingButton label="Insert link" icon={<Link2 size={16}/>} onClick={insertLink} />
        <FormattingButton label="Insert image" icon={<ImagePlus size={16}/>} disabled={!editor} onClick={() => imageInputRef.current?.click()} />
        {editorState.imageActive && <label className="docs-format-select"><span>Image width</span><select aria-label="Image width" value={String(editorState.imageWidth ?? 'auto')} onChange={(event) => editor?.chain().focus().updateAttributes('docsImage', { width: event.target.value === 'auto' ? null : Number(event.target.value) }).run()}><option value="auto">Auto</option><option value="320">Small</option><option value="640">Medium</option><option value="960">Large</option><option value="1280">Full</option></select></label>}
        <FormattingButton label="Horizontal rule" icon={<Minus size={16}/>} onClick={() => editor?.chain().focus().setHorizontalRule().run()} />
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group" aria-label="Review comments" hidden={activeRibbonTab !== 'review' && activeRibbonTab !== 'home'}>
        <FormattingButton label="Add comment to selected text" icon={<MessageSquarePlus size={16} />}
          disabled={!editorState.hasTextSelection || reviewComments.length >= MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT}
          onClick={beginReviewComment} />
      </span>
      {activeRibbonTab === 'view' && <span className="docs-format-group docs-view-controls" aria-label="View controls">
        <label className="docs-format-select"><span>Zoom</span><select aria-label="Document zoom" value={pageZoom} onChange={(event) => setPageZoom(event.target.value)}><option>75%</option><option>90%</option><option>100%</option><option>110%</option><option>125%</option></select></label>
        <FormattingButton label="Print document" icon={<FileText size={16} />} onClick={() => window.print()} />
        <FormattingButton label="Edit HTML source" icon={<Code size={16} />} disabled={!editor} onClick={() => openSourceMode('html')} />
        <FormattingButton label="Edit Markdown source" icon={<FileText size={16} />} disabled={!editor} onClick={() => openSourceMode('markdown')} />
      </span>}
      <span className="docs-format-hint">Local rich text</span>
    </div>

    {imageNotice && <p className="docs-image-notice" role="alert">{imageNotice}</p>}
    <div className="docs-table-toolbar glass-card" role="toolbar" aria-label="Table editing">
      <div className="docs-table-insert-controls">
        <span className="docs-table-insert-label"><Table2 size={15} /> Insert table</span>
        <label>Rows <input aria-label="New table rows" type="number" min="1" max={DOCS_TABLE_LIMITS.maxRows} value={insertRows} onChange={(event) => setInsertRows(event.target.value)} /></label>
        <label>Columns <input aria-label="New table columns" type="number" min="1" max={DOCS_TABLE_LIMITS.maxColumns} value={insertColumns} onChange={(event) => setInsertColumns(event.target.value)} /></label>
        <button type="button" className="docs-table-action docs-table-primary" disabled={!editor || editorState.tableCount >= DOCS_TABLE_LIMITS.maxTables} onMouseDown={(event) => event.preventDefault()} onClick={insertTable}><Table2 size={15} /><span>Insert</span></button>
      </div>
      {editorState.tableActive ? <>
        <span className="docs-table-dimensions" aria-live="polite">{editorState.tableRows} × {editorState.tableColumns} table</span>
        <span className="docs-table-divider" aria-hidden="true" />
        <TableActionButton label="Select current row" icon={<Rows3 size={15} />} onClick={() => selectTableCells('row')} />
        <TableActionButton label="Select current column" icon={<Columns3 size={15} />} onClick={() => selectTableCells('column')} />
        <TableActionButton label="Select entire table" icon={<Table2 size={15} />} onClick={() => selectTableCells('table')} />
        <TableActionButton label={editorState.tableHeaderRow ? 'Remove header row' : 'Use first row as header'}
          icon={<Rows3 size={15} />} pressed={editorState.tableHeaderRow}
          onClick={() => { const changed = editor?.chain().focus().toggleHeaderRow().run(); setTableNotice(changed ? '' : 'The table header row could not be changed.'); }} />
        {editorState.selectedCells > 0 && <span className="docs-table-selection-status" role="status">
          {editorState.selectedCells} {editorState.selectedCells === 1 ? 'cell' : 'cells'} selected · apply text formatting above
        </span>}
        <span className="docs-table-divider" aria-hidden="true" />
        <TableActionButton label="Add row below" icon={<Rows3 size={15} />} disabled={editorState.tableRows >= DOCS_TABLE_LIMITS.maxRows} onClick={() => editor?.chain().focus().addRowAfter().run()} />
        <TableActionButton label="Add column right" icon={<ArrowRightToLine size={15} />} disabled={editorState.tableColumns >= DOCS_TABLE_LIMITS.maxColumns} onClick={() => editor?.chain().focus().addColumnAfter().run()} />
        <TableActionButton label="Delete row" icon={<ArrowDown size={15} />} disabled={editorState.tableRows <= 1} onClick={() => editor?.chain().focus().deleteRow().run()} />
        <TableActionButton label="Delete column" icon={<ArrowLeftToLine size={15} />} disabled={editorState.tableColumns <= 1} onClick={() => editor?.chain().focus().deleteColumn().run()} />
        <TableActionButton label="Delete table" icon={<Trash2 size={15} />} onClick={() => editor?.chain().focus().deleteTable().run()} />
      </> : <span className="docs-table-hint">Select a cell to edit its rows and columns.</span>}
    </div>
    <p className="docs-table-limit-copy">{DOCS_TABLE_LIMITS_COPY} The first row can be marked as a semantic header and is preserved in supported DOCX files. Markdown requires a header row, so headerless tables trigger an export confirmation.</p>
    {tableNotice && <p className="docs-table-warning" role="status">{tableNotice}</p>}

    {findOpen && <section id="docs-find-panel" className="docs-find-panel glass-card" role="search" aria-label="Find and replace in document">
      <div className="docs-find-heading"><div><strong><Search size={15} /> Find &amp; Replace</strong><span>Search this document locally; changes use normal undo and autosave.</span></div>
        <button type="button" className="docs-find-close" aria-label="Close Find & Replace" onClick={() => setFindOpen(false)}><X size={16} /></button>
      </div>
      <div className="docs-find-fields">
        <label className="docs-find-field"><span>Find</span><input ref={findInputRef} type="text" autoComplete="off" spellCheck={false} maxLength={MAX_DOCS_FIND_QUERY_CHARS}
          value={findQuery} onKeyDown={handleFindKeyDown} onChange={(event) => { setFindQuery(event.target.value); setFindMatchIndex(0); setFindNotice({ text: '', error: false }); }} aria-label="Find in document" placeholder="Word or phrase" /></label>
        <label className="docs-find-field"><span>Replace with</span><input type="text" maxLength={MAX_DOCS_FIND_REPLACEMENT_CHARS} value={findReplacement}
          onKeyDown={handleFindKeyDown} onChange={(event) => { setFindReplacement(event.target.value); setFindNotice({ text: '', error: false }); }} aria-label="Replace with" placeholder="Plain text" /></label>
        <label className="docs-find-case"><input type="checkbox" checked={findCaseSensitive} onChange={(event) => { setFindCaseSensitive(event.target.checked); setFindMatchIndex(0); setFindNotice({ text: '', error: false }); }} /> Match case</label>
      </div>
      <div className="docs-find-actions">
        <button type="button" className="docs-find-button" disabled={!findResult.matches.length || Boolean(findResult.error)} onMouseDown={(event) => event.preventDefault()} onClick={() => navigateFindMatch(-1)}>Previous</button>
        <button type="button" className="docs-find-button" disabled={!findResult.matches.length || Boolean(findResult.error)} onMouseDown={(event) => event.preventDefault()} onClick={() => navigateFindMatch(1)}>Next</button>
        <button type="button" className="docs-find-button" disabled={!findResult.matches.length || Boolean(findResult.error)} onMouseDown={(event) => event.preventDefault()} onClick={replaceCurrentFindMatch}><Replace size={14} /> Replace current</button>
        <button type="button" className="docs-find-button docs-find-primary" disabled={!findResult.matches.length || Boolean(findResult.error)} onMouseDown={(event) => event.preventDefault()} onClick={replaceAllFindMatches}><Replace size={14} /> Replace all</button>
      </div>
      <p className={`docs-find-status ${findResult.error || findNotice.error ? 'is-error' : ''}`} role={findResult.error || findNotice.error ? 'alert' : 'status'} aria-live="polite">
        {findResult.error || findNotice.text || (!findQuery ? 'Enter text to search this document.' : findResult.matches.length ? `Match ${Math.min(findMatchIndex + 1, findResult.matches.length)} of ${findResult.matches.length}.` : 'No matches in this document.')}
      </p>
      <p className="docs-find-note">Search is local and excludes review-comment notes. Matches do not cross inline-formatting, paragraph, or table-cell boundaries. Limits: {MAX_DOCS_FIND_QUERY_CHARS}-character query, {MAX_DOCS_FIND_REPLACEMENT_CHARS.toLocaleString()}-character replacement, {MAX_DOCS_FIND_MATCHES.toLocaleString()} matches, and 200,000 document text characters.</p>
    </section>}

    <section className="docs-review-panel glass-card" aria-label="Local document review comments">
      <div className="docs-review-heading">
        <div><span className="eyebrow">REVIEW</span><h2>Comments</h2><small>{reviewComments.filter((comment) => comment.status === 'open').length} open · {reviewComments.length} total</small></div>
        <span className="local-only-chip"><LockKeyhole size={13} /> This device only</span>
      </div>
      <p className="docs-review-privacy">Comment notes and status stay in this browser; they are not added to Markdown/DOCX exports or sent as comment text to AI. AI actions still use only document text you explicitly select or confirm.</p>

      {commentDraft && <form className="docs-review-composer" aria-label="Add local review comment" onSubmit={saveReviewComment}>
        <div className="docs-review-selected-text"><span>Selected text</span><blockquote>{commentDraft.quote}</blockquote></div>
        <label className="docs-review-comment-field">Comment<textarea aria-label="Review comment" rows={3} maxLength={MAX_DOCS_REVIEW_COMMENT_CHARS}
          value={commentDraft.body} onChange={(event) => setCommentDraft({ ...commentDraft, body: event.target.value })}
          placeholder="Add a note for yourself about this passage…" /></label>
        <div className="docs-review-compose-footer"><span>{commentDraft.body.length.toLocaleString()} / {MAX_DOCS_REVIEW_COMMENT_CHARS.toLocaleString()}</span>
          <div><button type="button" className="docs-review-secondary" onClick={() => { setCommentDraft(null); showReviewCommentNotice(''); }}>Cancel</button>
            <button type="submit" className="docs-review-primary" disabled={!commentDraft.body.trim()}>Save comment</button></div>
        </div>
      </form>}

      {reviewComments.length === 0
        ? <p className="docs-review-empty">No comments yet. Select text in the document and choose “Add comment to selected text”.</p>
        : <ul className="docs-review-list" aria-label="Saved review comments">{[...reviewComments].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((comment, index) =>
          <li key={comment.id} className={`docs-review-item ${comment.status === 'resolved' ? 'is-resolved' : ''}`}>
            <div className="docs-review-item-heading"><blockquote>“{comment.quote}”</blockquote><span className={`docs-review-status ${comment.status}`}>{comment.status === 'open' ? 'Open' : 'Resolved'}</span></div>
            <p className="docs-review-body">{comment.body}</p>
            {comment.anchorState === 'orphaned' && <p className="docs-review-orphan">The original text has changed or moved; this comment is kept, but its text is no longer highlighted.</p>}
            <div className="docs-review-item-actions">
              <button type="button" className="docs-review-secondary" aria-label={comment.status === 'open' ? 'Resolve review comment' : 'Reopen review comment'}
                onClick={() => setReviewCommentStatus(comment, comment.status === 'open' ? 'resolved' : 'open')}>
                {comment.status === 'open' ? <Check size={14} /> : <RotateCcw size={14} />}{comment.status === 'open' ? 'Resolve' : 'Reopen'}
              </button>
              <button type="button" className="docs-review-delete" aria-label={`Delete review comment ${index + 1}`}
                onClick={() => removeReviewComment(comment, index)}><Trash2 size={14} />Delete</button>
            </div>
          </li>)}</ul>}
      {reviewCommentNotice && <p className={`docs-review-notice ${reviewCommentError ? 'is-error' : ''}`} role={reviewCommentError ? 'alert' : 'status'}>{reviewCommentNotice}</p>}
      {reviewComments.length >= MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT && <p className="docs-review-limit">This document has reached the {MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT}-comment local limit.</p>}
    </section>

    <article className="document-canvas glass-card" style={{ zoom: pageZoom }}>
      <input className="document-title-input" value={document.title} onChange={(event) => {
        if (editor) saveEditor(editor, { title: event.target.value });
        else onPatch({ title: event.target.value });
      }} aria-label="Document title" placeholder="Untitled document" />
      <div className="document-meta"><span><FileText size={13} /> Local rich-text draft</span><span>Edited {friendlyDate(document.updatedAt)}</span></div>
      {sourceMode && <section className="docs-source-editor" aria-label={sourceMode === 'html' ? 'HTML source editor' : 'Markdown source editor'}>
        <div className="docs-source-heading"><div><span className="eyebrow">{sourceMode === 'html' ? 'HTML SOURCE' : 'MARKDOWN SOURCE'}</span><strong>{sourceMode === 'html' ? 'Edit document markup' : 'Edit Markdown'}</strong><small>Changes remain a local preview until you apply them. Unsafe HTML and remote image links are removed.</small></div><span className="docs-source-local"><LockKeyhole size={12} /> LOCAL</span></div>
        <div className="docs-source-mode-tabs" role="group" aria-label="Source format">
          <button type="button" aria-pressed={sourceMode === 'html'} onClick={() => openSourceMode('html')}>HTML</button>
          <button type="button" aria-pressed={sourceMode === 'markdown'} onClick={() => openSourceMode('markdown')}>Markdown</button>
        </div>
        <textarea className="docs-source-textarea" aria-label={sourceMode === 'html' ? 'HTML source' : 'Markdown source'} spellCheck={false} autoCapitalize="off" autoCorrect="off" value={sourceText} onChange={(event) => setSourceText(event.target.value)} />
        {sourceNotice && <p className="docs-source-notice" role="status">{sourceNotice}</p>}
        <div className="docs-source-actions"><span>{sourceText.length.toLocaleString()} / 1,000,000 characters · nothing is sent to AI automatically</span><div><button type="button" className="button-secondary" onClick={discardSourceChanges}>Discard</button><button type="button" className="button-primary" onClick={applySourceChanges} disabled={!editor}>Apply to document</button></div></div>
      </section>}
      <div className="docs-editor-container" hidden={Boolean(sourceMode)}>
        {editorState.empty && <p className="docs-writing-placeholder" aria-hidden="true">Start writing… Your draft is stored in this browser only.</p>}
        <EditorContent editor={editor} />
      </div>
      <div className="document-editor-bottom"><span>{sourceMode ? <Code size={13} /> : hasUnsavedChanges ? <X size={13} /> : <Check size={13} />}{sourceMode ? 'Source preview · apply to update the rich-text document' : hasUnsavedChanges ? 'Export or retry before closing this tab' : 'Formatting saves locally as you type'}</span><span>{sourceMode ? sourceText.length.toLocaleString() : document.content.length.toLocaleString()} characters · {documentWordCount.toLocaleString()} words</span></div>
    </article>
    <p className="editor-footnote"><LockKeyhole size={13} /> Drafts and review-comment sidecars stay in this browser. Simple bounded tables round-trip in DOCX; merged, nested, uneven, or over-limit imported tables become warned text, and unsupported export tables are refused. Review comments are not included in document exports or AI requests. Other Word structures may be omitted. {cloudEnabled ? 'Only an explicit, confirmed cloud-copy action sends document text and formatting to the chosen Office workspace. Documents with review comments are refused by this first copy format. Live sync and shared editing are not connected.' : 'Files are not uploaded, and cloud sync, sharing, and collaboration are not connected.'}</p>
      </div>
    </OfficeWorkbenchLayout>
  </div>;
}
