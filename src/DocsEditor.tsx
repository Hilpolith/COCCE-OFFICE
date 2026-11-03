import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Extension } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TableKit } from '@tiptap/extension-table';
import Underline from '@tiptap/extension-underline';
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import type { OfficeDocument } from './lib/localStore';
import { activeDocsTable, DOCS_TABLE_LIMITS, DOCS_TABLE_LIMITS_COPY, docsTableDocumentViolation, docsTableGridViolation, inspectDocsTableUsage } from './lib/docsTableLimits';
import { initialDocumentHtml, plainTextToRichHtml, richTextToPlainText, sanitizeRichTextHtmlWithWarnings } from './lib/documentEditor';
import OfficeAiWriter from './OfficeAiWriter';
import './docs.css';
import {
  ArrowDown, ArrowLeftToLine, ArrowRightToLine, ArrowUpRight, Bold, Check, ChevronLeft,
  FileText, Heading1, Heading2, Heading3, Italic, List, ListOrdered, LockKeyhole,
  Pilcrow, Quote, Redo2, Rows3, Strikethrough, Table2, Trash2,
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
  const loadedDocumentId = useRef(document.id);
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
    }), Underline, TableKit.configure({ table: { resizable: false, renderWrapper: true, allowTableNodeSelection: false } }), tableGuard],
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
  });

  useEffect(() => {
    if (!editor || loadedDocumentId.current === document.id) return;
    editor.commands.setContent(initialDocumentHtml(document.content, document.richText), { emitUpdate: false });
    loadedDocumentId.current = document.id;
  }, [editor, document.id, document.content, document.richText]);

  const editorState = useEditorState({
    editor,
    selector: ({ editor: activeEditor }) => {
      if (!activeEditor) return {
        bold: false, italic: false, underline: false, heading1: false, heading2: false, heading3: false,
        strike: false, paragraph: false, bulletList: false, orderedList: false, blockquote: false,
        canUndo: false, canRedo: false, empty: true, tableActive: false, tableRows: 0, tableColumns: 0,
        tableCount: 0, tableTextChars: 0,
      };
      const activeTable = activeDocsTable(activeEditor.state.selection);
      const usage = inspectDocsTableUsage(activeEditor.state.doc);
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
    <p className="editor-footnote"><LockKeyhole size={13} /> Drafts stay in this browser. Simple bounded tables round-trip in DOCX; merged, nested, uneven, or over-limit imported tables become warned text, and unsupported export tables are refused. Other Word structures may be omitted. Files are not uploaded, and cloud sync, comments, sharing, and collaboration are not connected.</p>
  </div>;
}
