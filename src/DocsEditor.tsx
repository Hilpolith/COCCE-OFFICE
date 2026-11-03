import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Extension } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Underline from '@tiptap/extension-underline';
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { OfficeDocument } from './lib/localStore';
import { activeDocsTable, DOCS_TABLE_LIMITS, DOCS_TABLE_LIMITS_COPY, docsTableDocumentViolation, docsTableGridViolation, inspectDocsTableUsage } from './lib/docsTableLimits';
import { initialDocumentHtml, plainTextToRichHtml, richTextToPlainText, sanitizeRichTextHtmlWithWarnings } from './lib/documentEditor';
import {
  createDocsReviewComment, deleteDocsReviewComment, listDocsReviewComments,
  mapDocsReviewCommentAnchors, MAX_DOCS_REVIEW_COMMENT_CHARS, MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT,
  MAX_DOCS_REVIEW_QUOTE_CHARS, reconcileDocsReviewCommentAnchors, replaceDocsReviewComments,
  saveDocsReviewComment,
} from './lib/docsReviewComments';
import type { DocsReviewComment } from './lib/docsReviewComments';
import OfficeAiWriter from './OfficeAiWriter';
import './docs.css';
import {
  ArrowDown, ArrowLeftToLine, ArrowRightToLine, ArrowUpRight, Bold, Check, ChevronLeft,
  FileText, Heading1, Heading2, Heading3, Italic, List, ListOrdered, LockKeyhole, MessageSquarePlus,
  Pilcrow, Quote, Redo2, Rows3, Strikethrough, Table2, Trash2, RotateCcw,
  Underline as UnderlineIcon, Undo2, X,
} from 'lucide-react';

type DocumentPatch = Partial<Pick<OfficeDocument, 'title' | 'content' | 'richText'>>;

function friendlyDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso));
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

function TableActionButton({ label, icon, disabled, onClick }: {
  label: string; icon: ReactNode; disabled?: boolean; onClick: () => void;
}) {
  return <button type="button" className="docs-table-action" aria-label={label} disabled={disabled}
    onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{icon}<span>{label}</span></button>;
}

export default function DocsEditor({ document, hasUnsavedChanges, onPatch, onBack, onExport, onExportDocx, onDelete, onGoToTeam }: {
  document: OfficeDocument;
  hasUnsavedChanges: boolean;
  onPatch: (patch: DocumentPatch) => boolean;
  onBack: () => void;
  onExport: (richText: string) => void;
  onExportDocx: (richText: string) => void | Promise<void>;
  onDelete: () => void;
  onGoToTeam: () => void;
}) {
  const patchRef = useRef(onPatch);
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
      code: false, codeBlock: false, horizontalRule: false,
    }), Underline, TableKit.configure({ table: { resizable: false, renderWrapper: true, allowTableNodeSelection: false } }), reviewCommentExtension, tableGuard],
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

  useEffect(() => {
    if (!editor) return;
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

  const editorState = useEditorState({
    editor,
    selector: ({ editor: activeEditor }) => {
      if (!activeEditor) return {
        bold: false, italic: false, underline: false, heading1: false, heading2: false, heading3: false,
        strike: false, paragraph: false, bulletList: false, orderedList: false, blockquote: false,
        canUndo: false, canRedo: false, empty: true, tableActive: false, tableRows: 0, tableColumns: 0,
        tableCount: 0, tableTextChars: 0, hasTextSelection: false,
      };
      const activeTable = activeDocsTable(activeEditor.state.selection);
      const usage = inspectDocsTableUsage(activeEditor.state.doc);
      const selection = activeEditor.state.selection;
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
        tableActive: Boolean(activeTable),
        tableRows: activeTable?.rows ?? 0,
        tableColumns: activeTable?.columns ?? 0,
        tableCount: usage.count,
        tableTextChars: usage.textChars,
        hasTextSelection: !selection.empty && activeEditor.state.doc.textBetween(selection.from, selection.to, '\n').trim().length > 0,
      };
    },
  });

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

  const showReviewCommentNotice = (message: string, isError = false) => {
    setReviewCommentNotice(message);
    setReviewCommentError(isError);
  };

  const beginReviewComment = () => {
    if (!editor) return;
    const selection = editor.state.selection;
    const quote = selection.empty ? '' : editor.state.doc.textBetween(selection.from, selection.to, '\n');
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

  const removeReviewComment = (comment: DocsReviewComment, index: number) => {
    if (!window.confirm('Delete this review comment from this device? This removes only the local comment.')) return;
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

  return <div className="page editor-page">
    <div className="editor-toolbar">
      <button type="button" className="back-button" onClick={onBack}><ChevronLeft size={16} /> All documents</button>
      <div className="editor-actions">
        <span className={`autosave-label ${hasUnsavedChanges ? 'autosave-failed' : ''}`} role="status">
          {hasUnsavedChanges ? <X size={13} /> : <span className="status-dot" />}
          {hasUnsavedChanges ? 'Unsaved · kept in this tab' : 'Saved on this device'}
        </span>
        {hasUnsavedChanges && <button type="button" className="button-secondary small-button" onClick={() => { if (editor) saveEditor(editor); }}>Retry save</button>}
        <button type="button" className="button-secondary small-button" onClick={() => onExport(editor?.getHTML() ?? document.richText ?? '')}><ArrowUpRight size={14} /> Export .md</button>
        <button type="button" className="button-secondary small-button" onClick={() => { void onExportDocx(editor?.getHTML() ?? document.richText ?? ''); }}><FileText size={14} /> Export .docx</button>
        <button type="button" className="icon-button danger-button" onClick={onDelete} aria-label="Delete document" title="Delete local document"><X size={16} /></button>
      </div>
    </div>

    <div className="docs-format-toolbar glass-card" role="toolbar" aria-label="Document formatting">
      <span className="docs-format-group" aria-label="Paragraph style">
        <FormattingButton label="Paragraph" icon={<Pilcrow size={16} />} active={editorState.paragraph} onClick={() => editor?.chain().focus().setParagraph().run()} />
        <FormattingButton label="Heading 1" icon={<Heading1 size={16} />} active={editorState.heading1} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} />
        <FormattingButton label="Heading 2" icon={<Heading2 size={16} />} active={editorState.heading2} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} />
        <FormattingButton label="Heading 3" icon={<Heading3 size={16} />} active={editorState.heading3} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} />
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group" aria-label="Text style">
        <FormattingButton label="Bold" icon={<Bold size={16} />} active={editorState.bold} onClick={() => editor?.chain().focus().toggleBold().run()} />
        <FormattingButton label="Italic" icon={<Italic size={16} />} active={editorState.italic} onClick={() => editor?.chain().focus().toggleItalic().run()} />
        <FormattingButton label="Underline" icon={<UnderlineIcon size={16} />} active={editorState.underline} onClick={() => editor?.chain().focus().toggleUnderline().run()} />
        <FormattingButton label="Strikethrough" icon={<Strikethrough size={16} />} active={editorState.strike} onClick={() => editor?.chain().focus().toggleStrike().run()} />
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group" aria-label="Lists and quotes">
        <FormattingButton label="Bulleted list" icon={<List size={16} />} active={editorState.bulletList} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleBulletList().run()} />
        <FormattingButton label="Numbered list" icon={<ListOrdered size={16} />} active={editorState.orderedList} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleOrderedList().run()} />
        <FormattingButton label="Quote" icon={<Quote size={16} />} active={editorState.blockquote} disabled={editorState.tableActive} onClick={() => editor?.chain().focus().toggleBlockquote().run()} />
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group" aria-label="Edit history">
        <FormattingButton label="Undo" icon={<Undo2 size={16} />} disabled={!editorState.canUndo} onClick={() => editor?.chain().focus().undo().run()} />
        <FormattingButton label="Redo" icon={<Redo2 size={16} />} disabled={!editorState.canRedo} onClick={() => editor?.chain().focus().redo().run()} />
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group" aria-label="Review comments">
        <FormattingButton label="Add comment to selected text" icon={<MessageSquarePlus size={16} />}
          disabled={!editorState.hasTextSelection || reviewComments.length >= MAX_DOCS_REVIEW_COMMENTS_PER_DOCUMENT}
          onClick={beginReviewComment} />
      </span>
      <span className="docs-format-hint">Local rich text</span>
    </div>

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
        <TableActionButton label="Add row below" icon={<Rows3 size={15} />} disabled={editorState.tableRows >= DOCS_TABLE_LIMITS.maxRows} onClick={() => editor?.chain().focus().addRowAfter().run()} />
        <TableActionButton label="Add column right" icon={<ArrowRightToLine size={15} />} disabled={editorState.tableColumns >= DOCS_TABLE_LIMITS.maxColumns} onClick={() => editor?.chain().focus().addColumnAfter().run()} />
        <TableActionButton label="Delete row" icon={<ArrowDown size={15} />} disabled={editorState.tableRows <= 1} onClick={() => editor?.chain().focus().deleteRow().run()} />
        <TableActionButton label="Delete column" icon={<ArrowLeftToLine size={15} />} disabled={editorState.tableColumns <= 1} onClick={() => editor?.chain().focus().deleteColumn().run()} />
        <TableActionButton label="Delete table" icon={<Trash2 size={15} />} onClick={() => editor?.chain().focus().deleteTable().run()} />
      </> : <span className="docs-table-hint">Select a cell to edit its rows and columns.</span>}
    </div>
    <p className="docs-table-limit-copy">{DOCS_TABLE_LIMITS_COPY}</p>
    {tableNotice && <p className="docs-table-warning" role="status">{tableNotice}</p>}

    <OfficeAiWriter editor={editor} documentTitle={document.title} onGoToTeam={onGoToTeam} />

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

    <article className="document-canvas glass-card">
      <input className="document-title-input" value={document.title} onChange={(event) => {
        if (editor) saveEditor(editor, { title: event.target.value });
        else onPatch({ title: event.target.value });
      }} aria-label="Document title" placeholder="Untitled document" />
      <div className="document-meta"><span><FileText size={13} /> Local rich-text draft</span><span>Edited {friendlyDate(document.updatedAt)}</span></div>
      <div className="docs-editor-container">
        {editorState.empty && <p className="docs-writing-placeholder" aria-hidden="true">Start writing… Your draft is stored in this browser only.</p>}
        <EditorContent editor={editor} />
      </div>
      <div className="document-editor-bottom"><span>{hasUnsavedChanges ? <X size={13} /> : <Check size={13} />}{hasUnsavedChanges ? 'Export or retry before closing this tab' : 'Formatting saves locally as you type'}</span><span>{document.content.length.toLocaleString()} characters</span></div>
    </article>
    <p className="editor-footnote"><LockKeyhole size={13} /> Drafts and review-comment sidecars stay in this browser. Simple bounded tables round-trip in DOCX; merged, nested, uneven, or over-limit imported tables become warned text, and unsupported export tables are refused. Review comments are not included in document exports or AI requests. Other Word structures may be omitted. Files are not uploaded, and cloud sync, sharing, and collaboration are not connected.</p>
  </div>;
}
