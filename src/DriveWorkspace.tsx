import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent, ReactNode } from 'react';
import {
  ArrowDownToLine, ArrowUpRight, Check, File, FileAudio, FileImage, FileText,
  FileVideo, HardDrive, LockKeyhole, Pencil, Plus, RotateCcw, Trash2, Upload,
  X,
} from 'lucide-react';
import type { OfficeDocument } from './lib/localStore';
import { formatFileSize, localDriveRepository, MAX_LOCAL_FILE_BYTES } from './lib/driveStore';
import type { DriveFile, DriveRepository } from './lib/driveStore';
import './drive.css';
import CloudDriveWorkspace from './CloudDriveWorkspace';

interface Props {
  workspaceId: string | null;
  documents: OfficeDocument[];
  query: string;
  onOpenDocument: (document: OfficeDocument) => void;
  onCreateDocument: () => void;
  repository?: DriveRepository;
}

type Preview = { file: DriveFile; blob: Blob; url: string };
type DriveCategory = 'all' | 'documents' | 'images' | 'video' | 'audio' | 'other';
const driveCategoryOf = (file: DriveFile): Exclude<DriveCategory, 'all'> => {
  if (file.mimeType.startsWith('image/')) return 'images';
  if (file.mimeType.startsWith('video/')) return 'video';
  if (file.mimeType.startsWith('audio/')) return 'audio';
  if (file.mimeType === 'application/pdf' || file.mimeType.startsWith('text/')
    || /\.(docx?|odt|rtf|xlsx?|ods|pptx?|odp|md|markdown|csv|json|xml|yaml|yml|log)$/i.test(file.name)) return 'documents';
  return 'other';
};

const extensionOf = (name: string) => name.includes('.') ? name.split('.').pop()!.slice(0, 8).toUpperCase() : 'FILE';
const isTextPreview = (file: DriveFile) => file.mimeType.startsWith('text/') || /\.(md|markdown|csv|json|xml|yaml|yml|log)$/i.test(file.name);

function FileGlyph({ file }: { file: DriveFile }) {
  if (file.mimeType.startsWith('image/')) return <FileImage size={23} />;
  if (file.mimeType.startsWith('audio/')) return <FileAudio size={23} />;
  if (file.mimeType.startsWith('video/')) return <FileVideo size={23} />;
  if (isTextPreview(file)) return <FileText size={23} />;
  return <File size={23} />;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = window.document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function DriveWorkspace({
  workspaceId, documents, query, onOpenDocument, onCreateDocument,
  repository = localDriveRepository,
}: Props) {
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [showTrash, setShowTrash] = useState(false);
  const [fileCategory, setFileCategory] = useState<DriveCategory>('all');
  const [driveMode, setDriveMode] = useState<'device' | 'cloud'>('device');
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [renameTarget, setRenameTarget] = useState<DriveFile | null>(null);
  const [purgeTarget, setPurgeTarget] = useState<DriveFile | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const loadSequence = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++loadSequence.current;
    setLoading(true);
    try {
      const result = await repository.listFiles(workspaceId, showTrash);
      if (current === loadSequence.current) { setFiles(result); setError(''); }
    } catch (cause) {
      if (current === loadSequence.current) setError(cause instanceof Error ? cause.message : 'Could not open local file storage.');
    } finally {
      if (current === loadSequence.current) setLoading(false);
    }
  }, [repository, workspaceId, showTrash]);

  useEffect(() => {
    let active = true;
    void repository.listFiles(workspaceId, showTrash)
      .then((result) => { if (active) { setFiles(result); setError(''); } })
      .catch((cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : 'Could not open local file storage.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [repository, workspaceId, showTrash]);

  useEffect(() => {
    if (!preview) return undefined;
    return () => URL.revokeObjectURL(preview.url);
  }, [preview]);

  const matchingFiles = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? files.filter((file) => `${file.name} ${file.mimeType}`.toLocaleLowerCase().includes(needle)) : files;
  }, [files, query]);
  const visibleFiles = useMemo(
    () => fileCategory === 'all' ? matchingFiles : matchingFiles.filter((file) => driveCategoryOf(file) === fileCategory),
    [matchingFiles, fileCategory],
  );
  const usedBytes = useMemo(() => files.reduce((sum, file) => sum + file.size, 0), [files]);

  const uploadFiles = async (incoming: FileList | File[]) => {
    const selected = Array.from(incoming);
    if (!selected.length) return;
    setUploading(true);
    setNotice('');
    setError('');
    let imported = 0;
    const failures: string[] = [];
    for (const file of selected) {
      try { await repository.saveFile(file, workspaceId); imported += 1; }
      catch (cause) { failures.push(`${file.name}: ${cause instanceof Error ? cause.message : 'could not be saved'}`); }
    }
    await refresh();
    setUploading(false);
    if (imported && failures.length) setNotice(`${imported} file${imported === 1 ? '' : 's'} saved locally. ${failures.length} could not be saved.`);
    else if (imported) setNotice(`${imported} file${imported === 1 ? '' : 's'} saved in this browser. Nothing was uploaded to a server.`);
    if (failures.length) setError(failures.join(' '));
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const chosen = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = '';
    if (chosen.length) void uploadFiles(chosen);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) void uploadFiles(event.dataTransfer.files);
  };

  const openPreview = async (file: DriveFile) => {
    try {
      const result = await repository.readFile(file.id, workspaceId);
      setPreview({ ...result, url: URL.createObjectURL(result.blob) });
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not read this file.'); }
  };
  const download = async (file: DriveFile) => {
    try {
      const result = await repository.readFile(file.id, workspaceId);
      downloadBlob(result.blob, result.file.name);
      setNotice(`Downloaded ${result.file.name} from this browser.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not download this file.'); }
  };
  const startRename = (file: DriveFile) => { setRenameTarget(file); setRenameValue(file.name); setError(''); };
  const saveRename = async () => {
    if (!renameTarget) return;
    try {
      await repository.renameFile(renameTarget.id, workspaceId, renameValue);
      setRenameTarget(null);
      setNotice('File renamed in this browser.');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not rename this file.'); }
  };
  const moveToTrash = async (file: DriveFile) => {
    try {
      await repository.moveToTrash(file.id, workspaceId);
      setNotice(`${file.name} moved to local trash. You can restore it from the Trash tab.`);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not move this file to trash.'); }
  };
  const restore = async (file: DriveFile) => {
    try {
      await repository.restoreFile(file.id, workspaceId);
      setNotice(`${file.name} restored to My files.`);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not restore this file.'); }
  };
  const permanentlyDelete = async () => {
    if (!purgeTarget) return;
    try {
      await repository.deletePermanently(purgeTarget.id, workspaceId);
      setNotice(`${purgeTarget.name} was permanently deleted from this browser.`);
      setPurgeTarget(null);
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not permanently delete this file.'); }
  };

  return (
    <div className="page subpage drive-page">
      <div className="drive-mode-tabs" role="tablist" aria-label="Drive storage">
        <button type="button" role="tab" aria-selected={driveMode === 'device'} className={driveMode === 'device' ? 'is-active' : ''} onClick={() => setDriveMode('device')}><HardDrive size={15}/> This device</button>
        <button type="button" role="tab" aria-selected={driveMode === 'cloud'} className={driveMode === 'cloud' ? 'is-active' : ''} onClick={() => setDriveMode('cloud')}><LockKeyhole size={15}/> Cloud workspaces</button>
      </div>
      {driveMode === 'cloud' ? <CloudDriveWorkspace query={query} /> : <>
      <div className="page-title-row drive-title-row">
        <div><span className="eyebrow">COCCE DRIVE · BROWSER-LOCAL MODE</span><h1>{showTrash ? 'Trash' : 'My files'}</h1><p className="page-lede">Add files to this browser, preview and download them, or move them to a restorable local trash. These files are not synced or backed up.</p></div>
        <div className="drive-title-actions">
          {!showTrash && <button className="button-secondary" onClick={onCreateDocument}><Plus size={16} /> Create text file</button>}
          {!showTrash && <button className="button-primary" onClick={() => inputRef.current?.click()} disabled={uploading}><Upload size={16} /> {uploading ? 'Saving locally…' : 'Add files'}</button>}
          <input ref={inputRef} className="visually-hidden" type="file" multiple onChange={onFileInput} aria-label="Choose files to save locally" />
        </div>
      </div>

      <div className="drive-summary glass-card">
        <span className="drive-summary-icon"><HardDrive size={19} /></span>
        <div><strong>{showTrash ? `${files.length} items in local trash` : `${files.length} local ${files.length === 1 ? 'file' : 'files'}`}</strong><small>{showTrash ? 'Restorable in this browser' : `${formatFileSize(usedBytes)} stored on this device`}</small></div>
        <span className="local-only-chip"><LockKeyhole size={13} /> This device</span>
      </div>

      <div className="drive-tabs" role="tablist" aria-label="Drive areas">
        <button role="tab" aria-selected={!showTrash} className={!showTrash ? 'drive-tab-active' : ''} onClick={() => { setLoading(true); setShowTrash(false); setNotice(''); setError(''); }}>My files</button>
        <button role="tab" aria-selected={showTrash} className={showTrash ? 'drive-tab-active' : ''} onClick={() => { setLoading(true); setShowTrash(true); setNotice(''); setError(''); }}><Trash2 size={14} /> Trash</button>
      </div>
      {!showTrash && <div className="drive-category-tabs" role="tablist" aria-label="Filter files by type">
        {([
          ['all', 'All files'], ['documents', 'Documents'], ['images', 'Images'],
          ['video', 'Video'], ['audio', 'Audio'], ['other', 'Other'],
        ] as const).map(([category, label]) => <button key={category} type="button" role="tab"
          aria-selected={fileCategory === category} className={fileCategory === category ? 'is-active' : ''}
          onClick={() => setFileCategory(category)}>{label}<span>{category === 'all' ? matchingFiles.length : matchingFiles.filter((file) => driveCategoryOf(file) === category).length}</span></button>)}
      </div>}

      {notice && <div className="drive-feedback" role="status"><Check size={15} />{notice}</div>}
      {error && <div className="drive-feedback drive-error" role="alert">{error}</div>}
      {!showTrash && <div className={`drive-dropzone ${dragging ? 'drive-dropzone-active' : ''}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }} onDrop={onDrop}>
        <div className="drive-drop-icon"><Upload size={18} /></div><div><strong>{dragging ? 'Drop files to save them locally' : 'Drop files here, or choose files'}</strong><small>Each file may be up to {formatFileSize(MAX_LOCAL_FILE_BYTES)}. Any file type is accepted; files remain in this browser.</small></div><button className="button-tertiary" onClick={() => inputRef.current?.click()} disabled={uploading}>Choose files</button>
      </div>}

      <section className="drive-files-section" aria-label={showTrash ? 'Files in local trash' : 'Local files'}>
        {loading ? <div className="drive-empty glass-card" role="status">Reading this browser’s local files…</div> : visibleFiles.length ? <div className="drive-file-grid">{visibleFiles.map((file) => <DriveFileCard key={file.id} file={file} trashed={showTrash} onPreview={() => void openPreview(file)} onDownload={() => void download(file)} onRename={() => startRename(file)} onTrash={() => void moveToTrash(file)} onRestore={() => void restore(file)} onDeletePermanently={() => setPurgeTarget(file)} />)}</div> : <div className="drive-empty glass-card"><div className="drive-empty-icon"><HardDrive size={24} /></div><h2>{query ? 'No matching files' : showTrash ? 'Trash is empty' : 'Your local Drive is ready'}</h2><p>{query ? 'Try a different search term.' : showTrash ? 'Files moved here remain in this browser until you restore or permanently delete them.' : 'Save a file in this browser, or create a text draft with Docs. No upload to COCCE services occurs.'}</p>{!showTrash && <button className="button-primary" onClick={() => inputRef.current?.click()}><Upload size={15} /> Add a file</button>}</div>}
      </section>

      {!showTrash && documents.length > 0 && <section className="drive-documents-section"><div className="panel-heading"><div><span className="eyebrow">COCCE DOCS DRAFTS</span><h2>{documents.length} local {documents.length === 1 ? 'draft' : 'drafts'}</h2></div><span className="local-only-chip"><LockKeyhole size={13} /> Device only</span></div><div className="drive-draft-grid">{documents.slice(0, 6).map((document) => <button key={document.id} className="drive-draft-card glass-card" onClick={() => onOpenDocument(document)}><span><FileText size={17} /></span><strong>{document.title || 'Untitled document'}</strong><small>{new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(document.updatedAt))} · Draft</small><ArrowUpRight size={14} /></button>)}</div></section>}

      {renameTarget && <Dialog title="Rename file" onClose={() => setRenameTarget(null)}><label className="drive-dialog-label" htmlFor="drive-rename">File name</label><input id="drive-rename" className="drive-dialog-input" value={renameValue} maxLength={255} autoFocus onChange={(event) => setRenameValue(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void saveRename(); if (event.key === 'Escape') setRenameTarget(null); }} />{error && <p className="drive-dialog-error" role="alert">{error}</p>}<div className="drive-dialog-actions"><button className="button-secondary" onClick={() => setRenameTarget(null)}>Cancel</button><button className="button-primary" onClick={() => void saveRename()}><Check size={15} /> Save name</button></div></Dialog>}
      {purgeTarget && <Dialog title="Delete this file permanently?" onClose={() => setPurgeTarget(null)}><p className="drive-purge-copy"><strong>{purgeTarget.name}</strong> and its locally stored bytes will be removed from this browser. This cannot be undone.</p><div className="drive-dialog-actions"><button className="button-secondary" onClick={() => setPurgeTarget(null)}>Cancel</button><button className="button-primary drive-purge-confirm" onClick={() => void permanentlyDelete()}><Trash2 size={15} /> Delete permanently</button></div></Dialog>}
      {preview && <PreviewDialog preview={preview} onClose={() => setPreview(null)} onDownload={() => downloadBlob(preview.blob, preview.file.name)} />}
      </>}
    </div>
  );
}

function DriveFileCard({ file, trashed, onPreview, onDownload, onRename, onTrash, onRestore, onDeletePermanently }: {
  file: DriveFile; trashed: boolean; onPreview: () => void; onDownload: () => void; onRename: () => void; onTrash: () => void; onRestore: () => void; onDeletePermanently: () => void;
}) {
  const date = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(file.updatedAt));
  return <article className="drive-file-card glass-card">
    <button className="drive-file-open" onClick={onPreview} aria-label={`Preview ${file.name}`}><span className="drive-file-thumb"><FileGlyph file={file} /><small>{extensionOf(file.name)}</small></span><strong title={file.name}>{file.name}</strong><small className="drive-file-metadata">{formatFileSize(file.size)} · {date}</small></button>
    <div className="drive-file-actions">
      {trashed ? <><button className="icon-button" onClick={onRestore} aria-label={`Restore ${file.name}`} title="Restore"><RotateCcw size={15} /></button><button className="icon-button drive-delete-button" onClick={onDeletePermanently} aria-label={`Delete ${file.name} permanently`} title="Delete permanently"><Trash2 size={15} /></button></> : <>
        <button className="icon-button" onClick={onDownload} aria-label={`Download ${file.name}`} title="Download"><ArrowDownToLine size={15} /></button>
        <button className="icon-button" onClick={onRename} aria-label={`Rename ${file.name}`} title="Rename"><Pencil size={15} /></button>
        <button className="icon-button drive-delete-button" onClick={onTrash} aria-label={`Move ${file.name} to trash`} title="Move to trash"><Trash2 size={15} /></button>
      </>}
    </div>
  </article>;
}

function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  return <div className="drive-modal-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="drive-modal glass-card" role="dialog" aria-modal="true" aria-labelledby="drive-dialog-title"><button className="icon-button drive-modal-close" aria-label="Close dialog" onClick={onClose}><X size={16} /></button><h2 id="drive-dialog-title">{title}</h2>{children}</section></div>;
}

function PreviewDialog({ preview, onClose, onDownload }: { preview: Preview; onClose: () => void; onDownload: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [textError, setTextError] = useState('');
  const tooLargeTextPreview = isTextPreview(preview.file) && preview.blob.size > 200_000;
  useEffect(() => {
    if (!isTextPreview(preview.file) || tooLargeTextPreview) return;
    let active = true;
    void preview.blob.text().then((value) => { if (active) setText(value); }).catch(() => { if (active) setTextError('Could not read this text file.'); });
    return () => { active = false; };
  }, [preview, tooLargeTextPreview]);
  let content: ReactNode;
  if (tooLargeTextPreview) content = <div className="drive-preview-message">Text preview is limited to 200 KB. Download the file to view its full contents.</div>;
  else if (textError) content = <div className="drive-preview-message">{textError}</div>;
  else if (preview.file.mimeType.startsWith('image/')) content = <img className="drive-preview-image" src={preview.url} alt={preview.file.name} />;
  else if (preview.file.mimeType.startsWith('video/')) content = <video className="drive-preview-media" src={preview.url} controls preload="metadata" />;
  else if (preview.file.mimeType.startsWith('audio/')) content = <audio className="drive-preview-audio" src={preview.url} controls preload="metadata" />;
  else if (preview.file.mimeType === 'application/pdf') content = <iframe className="drive-preview-pdf" src={preview.url} title={`PDF preview: ${preview.file.name}`} sandbox="allow-scripts" />;
  else if (isTextPreview(preview.file)) content = <pre className="drive-preview-text">{text ?? 'Reading text file…'}</pre>;
  else content = <div className="drive-preview-message"><File size={28} /><p>A browser preview is not available for this file type.</p></div>;
  return <Dialog title={preview.file.name} onClose={onClose}><div className="drive-preview-content">{content}</div><div className="drive-dialog-actions"><span className="drive-preview-size">{formatFileSize(preview.file.size)} · Stored only in this browser</span><button className="button-primary" onClick={onDownload}><ArrowDownToLine size={15} /> Download</button></div></Dialog>;
}
