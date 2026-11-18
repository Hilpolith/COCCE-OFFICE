import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { Code, Download, FileCode2, FileText, FolderOpen, Plus, Save, Trash2, Upload } from "lucide-react";
import {
  deleteSourceWorkspaceDocument,
  readSourceWorkspaceDocuments,
  saveSourceWorkspaceDocument,
} from "./lib/sourceWorkspaceStore";
import type { SourceDocumentFormat, SourceWorkspaceDocument } from "./lib/sourceWorkspaceStore";
import { buildSandboxedHtmlPreview, markdownToPreviewHtml } from "./lib/sourcePreview";
import "./sourceWorkspace.css";

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? "source-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}

function starter(format: SourceDocumentFormat): string {
  return format === "html"
    ? "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n  <title>My page</title>\n  <style>\n    body { font-family: system-ui, sans-serif; margin: 2rem; }\n  </style>\n</head>\n<body>\n  <main>\n    <h1>Hello, COCCE Office</h1>\n    <p>Start building your page here.</p>\n  </main>\n</body>\n</html>"
    : "# My document\n\nStart writing in Markdown.\n\n- Add a list\n- **Emphasize** important ideas\n";
}

function safeFileName(value: string, extension: string): string {
  const base = value.trim().replace(/[^\p{L}\p{N}._ -]+/gu, "").replace(/\s+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  return (base || "cocce-office-document") + extension;
}

export default function SourceWorkspace({
  format,
  workspaceId,
}: {
  format: SourceDocumentFormat;
  workspaceId: string | null;
}) {
  const [documents, setDocuments] = useState<SourceWorkspaceDocument[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [source, setSource] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const importRef = useRef<HTMLInputElement | null>(null);
  const extension = format === "html" ? ".html" : ".md";
  const label = format === "html" ? "HTML Studio" : "Markdown Studio";

  const load = useCallback((doc: SourceWorkspaceDocument | null) => {
    setActiveId(doc?.id ?? null);
    setTitle(doc?.title ?? "");
    setSource(doc?.source ?? "");
    setDirty(false);
    setError("");
    setNotice("");
  }, []);

  useEffect(() => {
    try {
      const next = readSourceWorkspaceDocuments(window.localStorage, workspaceId, format);
      setDocuments(next);
      load(next[0] ?? null);
    } catch (cause) {
      setDocuments([]);
      load(null);
      setError(cause instanceof Error ? cause.message : "Saved source documents could not be read.");
    }
  }, [format, load, workspaceId]);

  const save = useCallback((): boolean => {
    if (!activeId) return false;
    const existing = documents.find((doc) => doc.id === activeId);
    if (!existing) {
      setError("This draft is no longer available in the current workspace. Create or import a new file.");
      return false;
    }
    const next: SourceWorkspaceDocument = {
      ...existing,
      title: title.trim() || "Untitled " + (format === "html" ? "HTML" : "Markdown"),
      source,
      updatedAt: new Date().toISOString(),
    };
    try {
      saveSourceWorkspaceDocument(window.localStorage, next);
      setDocuments((current) => [next, ...current.filter((doc) => doc.id !== next.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
      setTitle(next.title);
      setDirty(false);
      setError("");
      setNotice("Saved on this device");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The draft could not be saved.");
      return false;
    }
  }, [activeId, documents, format, source, title]);

  useEffect(() => {
    if (!dirty || !activeId) return;
    const timer = window.setTimeout(() => { save(); }, 800);
    return () => window.clearTimeout(timer);
  }, [activeId, dirty, save, source, title]);

  const create = useCallback((nextTitle?: string, nextSource?: string) => {
    if (dirty && !save()) return;
    const now = new Date().toISOString();
    const doc: SourceWorkspaceDocument = {
      id: createId(),
      workspaceId,
      format,
      title: nextTitle?.trim() || "Untitled " + (format === "html" ? "HTML" : "Markdown"),
      source: nextSource ?? starter(format),
      createdAt: now,
      updatedAt: now,
    };
    try {
      saveSourceWorkspaceDocument(window.localStorage, doc);
      setDocuments((current) => [doc, ...current.filter((item) => item.id !== doc.id)]);
      load(doc);
      setNotice("New local draft created");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "A new draft could not be created.");
    }
  }, [dirty, format, load, save, workspaceId]);

  const select = useCallback((doc: SourceWorkspaceDocument) => {
    if (doc.id === activeId) return;
    if (dirty && !save()) return;
    load(doc);
  }, [activeId, dirty, load, save]);

  const remove = useCallback(() => {
    if (!activeId || !window.confirm("Delete this local source draft? This cannot be undone.")) return;
    try {
      deleteSourceWorkspaceDocument(window.localStorage, activeId);
      const next = documents.filter((doc) => doc.id !== activeId);
      setDocuments(next);
      load(next[0] ?? null);
      setNotice("Draft deleted from this device");
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The draft could not be deleted.");
    }
  }, [activeId, documents, load]);

  const importFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    if (file.size > 1_000_000) {
      setError("Files must be 1 MB or smaller. The original file was not imported.");
      return;
    }
    try {
      const text = await file.text();
      if (text.length > 1_000_000) throw new Error("Files must be 1 MB or smaller.");
      create(file.name.replace(/\.(html?|md)$/i, ""), text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The selected file could not be imported.");
    }
  }, [create]);

  const exportFile = useCallback(() => {
    if (!activeId) return;
    if (dirty && !save()) return;
    const blob = new Blob([source], { type: format === "html" ? "text/html;charset=utf-8" : "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = safeFileName(title, extension);
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("File exported to this device");
  }, [activeId, dirty, extension, format, save, source, title]);

  const preview = useMemo(() => buildSandboxedHtmlPreview(
    format === "html" ? source : markdownToPreviewHtml(source),
  ), [format, source]);

  const updateSource = (value: string) => {
    setSource(value);
    setDirty(true);
    setNotice("");
    setError("");
  };

  return <main className="page source-workspace">
    <header className="source-workspace-header glass-card">
      <div className="source-workspace-brand">
        <span className="source-workspace-icon">{format === "html" ? <Code size={20} /> : <FileText size={20} />}</span>
        <div><span className="eyebrow">COCCE OFFICE · LOCAL EDITOR</span><h1>{label}</h1><p>{format === "html" ? "Build standalone pages with a live preview; script execution is disabled for safety." : "Write clean Markdown with a live rendered preview."}</p></div>
      </div>
      <div className="source-workspace-actions">
        <span className="source-local-status"><FolderOpen size={13} /> {workspaceId ? "This workspace · this browser" : "Personal space · this browser"}</span>
        <button type="button" className="button-secondary small-button" onClick={() => create()}><Plus size={14} /> New</button>
        <button type="button" className="button-secondary small-button" onClick={() => importRef.current?.click()}><Upload size={14} /> Import</button>
        <button type="button" className="button-secondary small-button" onClick={save} disabled={!activeId || !dirty}><Save size={14} /> Save</button>
        <button type="button" className="button-primary small-button" onClick={exportFile} disabled={!activeId}><Download size={14} /> Export {extension}</button>
        <input ref={importRef} type="file" accept={format === "html" ? ".html,.htm,text/html" : ".md,.markdown,text/markdown,text/plain"} hidden onChange={(event) => void importFile(event)} />
      </div>
    </header>

    <div className="source-workspace-grid">
      <aside className="source-files-panel glass-card">
        <div className="source-panel-heading"><div><span className="eyebrow">LIBRARY</span><h2>Your files</h2></div><span className="source-file-count">{documents.length}</span></div>
        {documents.length ? <div className="source-file-list">{documents.map((doc) => <button key={doc.id} type="button" className={"source-file-item " + (doc.id === activeId ? "active" : "")} onClick={() => select(doc)}>
          {format === "html" ? <Code size={15} /> : <FileCode2 size={15} />}
          <span><strong>{doc.title}</strong><small>{new Date(doc.updatedAt).toLocaleString()}</small></span>
        </button>)}</div> : <div className="source-empty"><FileCode2 size={22} /><strong>No files yet</strong><p>Create a draft or import an existing {extension} file.</p></div>}
        <div className="source-library-note"><span className="source-status-dot" /> Local drafts · up to 1 MB each</div>
      </aside>

      <section className="source-editor-panel glass-card">
        <div className="source-panel-heading"><div><span className="eyebrow">SOURCE</span><h2>Editor</h2></div><span className={"source-save-state " + (dirty ? "dirty" : "")}>{dirty ? "Unsaved changes" : "Saved"}</span></div>
        {activeId ? <>
          <label className="source-title-field"><span>File name</span><input value={title} maxLength={160} onChange={(event) => { setTitle(event.target.value); setDirty(true); setNotice(""); }} /></label>
          <textarea className="source-code-editor" aria-label={(format === "html" ? "HTML" : "Markdown") + " source editor"} value={source} spellCheck={false} onChange={(event) => updateSource(event.target.value)} onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(); } }} />
          <div className="source-editor-footer"><span>{source.length.toLocaleString()} / 1,000,000 characters</span><button type="button" className="source-delete-button" onClick={remove}><Trash2 size={13} /> Delete</button></div>
        </> : <div className="source-empty source-empty-editor"><FileCode2 size={25} /><strong>Choose or create a file</strong><p>Your {format === "html" ? "HTML" : "Markdown"} drafts stay in this browser and are scoped to the selected local workspace.</p><button type="button" className="button-primary small-button" onClick={() => create()}>Create first file</button></div>}
      </section>

      <section className="source-preview-panel glass-card">
        <div className="source-panel-heading"><div><span className="eyebrow">LIVE PREVIEW</span><h2>Preview</h2></div><span className="source-preview-badge">Scripts disabled</span></div>
        {activeId ? <iframe title={(format === "html" ? "HTML" : "Markdown") + " preview"} sandbox="" srcDoc={preview} /> : <div className="source-empty"><FileCode2 size={22} /><strong>Preview appears here</strong><p>Create or select a file to see the rendered result.</p></div>}
      </section>
    </div>
    {(error || notice) && <div className={"source-feedback " + (error ? "error" : "")} role={error ? "alert" : "status"}>{error || notice}</div>}
  </main>;
}
