import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { EditorContent, useEditor, useEditorState } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model';
import type { OfficeDocument } from './lib/localStore';
import { initialDocumentHtml, plainTextToRichHtml, richTextToPlainText, sanitizeRichTextHtml } from './lib/documentEditor';
import OfficeAiWriter from './OfficeAiWriter';
import './docs.css';
import {
  ArrowUpRight, Bold, Check, ChevronLeft, FileText, Heading1, Heading2, Heading3,
  Italic, List, ListOrdered, LockKeyhole, Pilcrow, Quote, Redo2, Strikethrough, Underline as UnderlineIcon, Undo2, X,
} from 'lucide-react';

type DocumentPatch = Partial<Pick<OfficeDocument, 'title' | 'content' | 'richText'>>;

function friendlyDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso));
}

function FormattingButton({ label, icon, active, disabled, onClick }: {
  label: string; icon: ReactNode; active?: boolean; disabled?: boolean; onClick: () => void;
}) {
  return <button type="button" className="docs-format-button" aria-label={label} title={label}
    aria-pressed={active} disabled={disabled} onMouseDown={(event) => event.preventDefault()} onClick={onClick}>{icon}</button>;
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
  useEffect(() => { patchRef.current = onPatch; }, [onPatch]);
  const loadedDocumentId = useRef(document.id);
  const [initialHtml] = useState(() => initialDocumentHtml(document.content, document.richText));

  const saveEditor = (activeEditor: Editor, extraPatch: DocumentPatch = {}): boolean => {
    const richText = sanitizeRichTextHtml(activeEditor.getHTML());
    return patchRef.current({ content: richTextToPlainText(richText), richText, ...extraPatch });
  };

  const editor = useEditor({
    extensions: [StarterKit.configure({
      heading: { levels: [1, 2, 3] }, link: false, underline: false,
      code: false, codeBlock: false, horizontalRule: false,
    }), Underline],
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
    selector: ({ editor: activeEditor }) => ({
      bold: activeEditor?.isActive('bold') ?? false,
      italic: activeEditor?.isActive('italic') ?? false,
      underline: activeEditor?.isActive('underline') ?? false,
      heading1: activeEditor?.isActive('heading', { level: 1 }) ?? false,
      heading2: activeEditor?.isActive('heading', { level: 2 }) ?? false,
      heading3: activeEditor?.isActive('heading', { level: 3 }) ?? false,
      strike: activeEditor?.isActive('strike') ?? false,
      paragraph: activeEditor?.isActive('paragraph') ?? false,
      bulletList: activeEditor?.isActive('bulletList') ?? false,
      orderedList: activeEditor?.isActive('orderedList') ?? false,
      blockquote: activeEditor?.isActive('blockquote') ?? false,
      canUndo: activeEditor?.can().undo() ?? false,
      canRedo: activeEditor?.can().redo() ?? false,
      empty: activeEditor?.isEmpty ?? true,
    }),
  });

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
        <FormattingButton label="Heading 1" icon={<Heading1 size={16} />} active={editorState.heading1} onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()} />
        <FormattingButton label="Heading 2" icon={<Heading2 size={16} />} active={editorState.heading2} onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()} />
        <FormattingButton label="Heading 3" icon={<Heading3 size={16} />} active={editorState.heading3} onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()} />
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
        <FormattingButton label="Bulleted list" icon={<List size={16} />} active={editorState.bulletList} onClick={() => editor?.chain().focus().toggleBulletList().run()} />
        <FormattingButton label="Numbered list" icon={<ListOrdered size={16} />} active={editorState.orderedList} onClick={() => editor?.chain().focus().toggleOrderedList().run()} />
        <FormattingButton label="Quote" icon={<Quote size={16} />} active={editorState.blockquote} onClick={() => editor?.chain().focus().toggleBlockquote().run()} />
      </span>
      <span className="docs-format-divider" aria-hidden="true" />
      <span className="docs-format-group" aria-label="Edit history">
        <FormattingButton label="Undo" icon={<Undo2 size={16} />} disabled={!editorState.canUndo} onClick={() => editor?.chain().focus().undo().run()} />
        <FormattingButton label="Redo" icon={<Redo2 size={16} />} disabled={!editorState.canRedo} onClick={() => editor?.chain().focus().redo().run()} />
      </span>
      <span className="docs-format-hint">Local rich text</span>
    </div>

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
    <p className="editor-footnote"><LockKeyhole size={13} /> Drafts stay in this browser. DOCX import/export supports a limited text-and-formatting subset; other Word structures may be omitted. Files are not uploaded, and cloud sync, comments, sharing, and collaboration are not connected.</p>
  </div>;
}
