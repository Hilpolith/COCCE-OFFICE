import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import {
  Archive, ArrowDownToLine, FileLock2, FileText, Folder, FolderPlus,
  KeyRound, LockKeyhole, ShieldAlert, ShieldCheck, Trash2, Upload,
} from 'lucide-react';
import {
  MAX_VAULT_BACKUP_BYTES, MAX_VAULT_FILE_BYTES, MAX_VAULT_TOTAL_BYTES, VAULT_MIN_PASSPHRASE_LENGTH,
  createLocalVault, exportEncryptedVaultBackup, importEncryptedVaultBackup,
  localVaultRepository, saveVaultEntries, unlockLocalVault, validateVaultName,
} from './lib/vaultStore';
import type { VaultEntry, VaultFile, VaultFolder, VaultRepository, VaultSession } from './lib/vaultStore';
import './vault.css';

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
};

const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const newId = () => globalThis.crypto?.randomUUID?.() ?? `vault-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const formatSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};

function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function VaultWorkspace({ repository = localVaultRepository }: { repository?: VaultRepository }) {
  const [mode, setMode] = useState<'loading' | 'setup' | 'locked' | 'unlocked'>('loading');
  const [session, setSession] = useState<VaultSession | null>(null);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [selectedFolder, setSelectedFolder] = useState('all');
  const [passphrase, setPassphrase] = useState('');
  const [confirmPassphrase, setConfirmPassphrase] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [backupFile, setBackupFile] = useState<File | null>(null);
  const [folderName, setFolderName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    repository.getRecord().then((record) => {
      if (active) setMode(record ? 'locked' : 'setup');
    }).catch((reason: unknown) => {
      if (!active) return;
      setError(reason instanceof Error ? reason.message : 'Could not inspect local Vault storage.');
      setMode('setup');
    });
    return () => { active = false; };
  }, [repository]);

  const folders = useMemo(() => entries.filter((entry): entry is VaultFolder => entry.kind === 'folder'), [entries]);
  const visibleFiles = useMemo(() => entries.filter((entry): entry is VaultFile => entry.kind === 'file'
    && (selectedFolder === 'all' || (selectedFolder === 'unfiled' ? entry.folderId === null : entry.folderId === selectedFolder))), [entries, selectedFolder]);
  const totalBytes = useMemo(() => entries.reduce((sum, entry) => sum + (entry.kind === 'file' ? entry.size : 0), 0), [entries]);
  const selectedFolderName = selectedFolder === 'all' ? 'All files'
    : selectedFolder === 'unfiled' ? 'Unfiled'
      : folders.find((folder) => folder.id === selectedFolder)?.name ?? 'Folder';

  const setUnlocked = (next: VaultSession) => {
    setSession(next);
    setEntries(next.entries);
    setMode('unlocked');
    setSelectedFolder('all');
    setError('');
    setNotice('Vault opened in this browser.');
    setFolderName('');
  };

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setNotice('');
    if (passphrase !== confirmPassphrase) {
      setError('The passphrases do not match.');
      return;
    }
    setBusy(true);
    const secret = passphrase;
    setPassphrase('');
    setConfirmPassphrase('');
    try {
      const next = await createLocalVault(secret, repository);
      setUnlocked(next);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create the local Vault.');
    } finally { setBusy(false); }
  };

  const handleUnlock = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setNotice('');
    setBusy(true);
    const secret = passphrase;
    setPassphrase('');
    try {
      const record = await repository.getRecord();
      if (!record) throw new Error('There is no local Vault in this browser. Create one or import an encrypted backup.');
      setUnlocked(await unlockLocalVault(secret, repository));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not unlock the local Vault.');
    } finally { setBusy(false); }
  };

  const handleRestore = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setNotice('');
    if (!backupFile) {
      setError('Choose an encrypted .coccevault backup first.');
      return;
    }
    const secret = restorePassphrase;
    setRestorePassphrase('');
    setBusy(true);
    try {
      if (backupFile.size > MAX_VAULT_BACKUP_BYTES) throw new Error('This encrypted backup is larger than the local preview limit.');
      const backupText = await backupFile.text();
      const restored = await importEncryptedVaultBackup(backupText, secret, repository);
      setBackupFile(null);
      if (restoreInput.current) restoreInput.current.value = '';
      setUnlocked(restored);
      setNotice('Encrypted backup checked and restored in this browser.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not restore this encrypted backup.');
    } finally { setBusy(false); }
  };

  const persistEntries = async (nextEntries: VaultEntry[], successMessage: string): Promise<boolean> => {
    if (!session) return false;
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const next = await saveVaultEntries(session, nextEntries, repository);
      setSession(next);
      setEntries(next.entries);
      setNotice(successMessage);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save encrypted Vault data.');
      return false;
    } finally { setBusy(false); }
  };

  const addFolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      const name = validateVaultName(folderName);
      const folder: VaultFolder = { id: newId(), kind: 'folder', name, createdAt: new Date().toISOString() };
      if (await persistEntries([...entries, folder], `“${name}” was encrypted and saved in this browser.`)) {
        setFolderName('');
        setSelectedFolder(folder.id);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not create this folder.');
    }
  };

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (event.target) event.target.value = '';
    if (!file || !session) return;
    if (file.size > MAX_VAULT_FILE_BYTES) {
      setError(`Files must be ${formatSize(MAX_VAULT_FILE_BYTES)} or smaller in this local preview.`);
      return;
    }
    if (totalBytes + file.size > MAX_VAULT_TOTAL_BYTES) {
      setError(`The local Vault has a ${formatSize(MAX_VAULT_TOTAL_BYTES)} total file-content limit.`);
      return;
    }
    try {
      const name = validateVaultName(file.name);
      setBusy(true);
      setError('');
      setNotice('');
      const contentBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
      const entry: VaultFile = {
        id: newId(), kind: 'file', name,
        folderId: selectedFolder === 'all' || selectedFolder === 'unfiled' ? null : selectedFolder,
        mimeType: file.type || 'application/octet-stream', size: file.size, contentBase64,
        createdAt: new Date().toISOString(),
      };
      const next = await saveVaultEntries(session, [...entries, entry], repository);
      setSession(next);
      setEntries(next.entries);
      setNotice(`${name} was encrypted before being saved to this browser.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not encrypt and save this file.');
    } finally { setBusy(false); }
  };

  const downloadFile = (file: VaultFile) => {
    try {
      const bytes = base64ToBytes(file.contentBase64);
      download(file.name, new Blob([bytes.slice().buffer as ArrayBuffer], { type: file.mimeType }));
      setNotice(`${file.name} was decrypted in this tab and downloaded.`);
      setError('');
    } catch {
      setError('Could not decrypt this file in the current tab.');
    }
  };

  const deleteEntry = async (entry: VaultEntry) => {
    const message = entry.kind === 'folder'
      ? `Delete “${entry.name}” and its ${entries.filter((item) => item.kind === 'file' && item.folderId === entry.id).length} files from this local Vault?`
      : `Permanently remove “${entry.name}” from this local Vault?`;
    if (!window.confirm(`${message} This cannot be undone unless you have an encrypted backup.`)) return;
    const next = entry.kind === 'folder'
      ? entries.filter((item) => item.id !== entry.id && !(item.kind === 'file' && item.folderId === entry.id))
      : entries.filter((item) => item.id !== entry.id);
    if (entry.kind === 'folder' && selectedFolder === entry.id) setSelectedFolder('all');
    await persistEntries(next, `“${entry.name}” was removed from this local Vault.`);
  };

  const lockVault = () => {
    setSession(null);
    setEntries([]);
    setPassphrase('');
    setConfirmPassphrase('');
    setRestorePassphrase('');
    setMode('locked');
    setSelectedFolder('all');
    setNotice('Vault locked. This screen dropped its key and decrypted-data references; the browser does not guarantee immediate memory erasure.');
    setError('');
  };

  const exportBackup = async () => {
    setError('');
    try {
      const contents = await exportEncryptedVaultBackup(repository);
      download('cocce-office-vault-backup.coccevault', new Blob([contents], { type: 'application/json' }));
      setNotice('Encrypted backup downloaded. It still requires the original passphrase; the passphrase is not included.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not export this encrypted backup.');
    }
  };

  return (
    <div className="page subpage vault-page">
      <div className="page-title-row vault-title-row">
        <div>
          <span className="eyebrow vault-eyebrow"><LockKeyhole size={12} /> COCCE VAULT · DEVICE-LOCAL ENCRYPTION</span>
          <h1>Your private files, encrypted here.</h1>
          <p className="page-lede">A browser-local encrypted vault for this device. It is not cloud storage or enterprise access control.</p>
        </div>
        <img className="vault-brand-icon" src="/brand/cocce-office-squircle-icon-256.png" alt="COCCE Office squircle icon" />
      </div>

      <section className="vault-trust-banner glass-card" aria-label="Vault security boundary">
        <span className="vault-trust-icon"><ShieldCheck size={18} /></span>
        <div><strong>Encrypted on this device</strong><p>File names, folder names and file bytes are encrypted with browser-native Web Crypto before local storage. COCCE Office never stores or sends your passphrase; browser password managers are separate.</p></div>
        <span className="vault-local-chip">Local only</span>
      </section>

      {(error || notice) && <div className={`vault-feedback ${error ? 'vault-error' : 'vault-notice'}`} role={error ? 'alert' : 'status'}>{error || notice}</div>}

      {mode === 'loading' && <section className="vault-panel glass-card" role="status">Checking this browser’s local Vault…</section>}

      {mode === 'setup' && (
        <div className="vault-setup-grid">
          <section className="vault-panel glass-card">
            <span className="vault-step-icon"><KeyRound size={18} /></span>
            <span className="eyebrow">CREATE YOUR KEY</span>
            <h2>Start a local Vault</h2>
            <p>Choose a unique passphrase with at least {VAULT_MIN_PASSPHRASE_LENGTH} characters. The app derives an encryption key locally; it cannot reset or recover your passphrase.</p>
            <form className="vault-form" onSubmit={handleCreate}>
              <label>New passphrase<input type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} minLength={VAULT_MIN_PASSPHRASE_LENGTH} required aria-label="New Vault passphrase" /></label>
              <label>Confirm passphrase<input type="password" autoComplete="off" value={confirmPassphrase} onChange={(event) => setConfirmPassphrase(event.target.value)} minLength={VAULT_MIN_PASSPHRASE_LENGTH} required aria-label="Confirm Vault passphrase" /></label>
              <button className="button-primary vault-primary" type="submit" disabled={busy}>{busy ? 'Creating encrypted Vault…' : <><LockKeyhole size={15} /> Create local Vault</>}</button>
            </form>
            <div className="vault-warning"><ShieldAlert size={16} /><p><strong>Irrecoverable if lost.</strong> If you forget this passphrase and do not have a usable copy, encrypted files cannot be recovered. Export an encrypted backup and store it separately.</p></div>
          </section>
          <section className="vault-panel glass-card vault-recovery-panel">
            <span className="vault-step-icon"><Archive size={18} /></span>
            <span className="eyebrow">RECOVER AN ENCRYPTED COPY</span>
            <h2>Restore from backup</h2>
            <p>Import a previously exported <code>.coccevault</code> file and enter its original passphrase. Import is available only when this browser has no local Vault.</p>
            <form className="vault-form" onSubmit={handleRestore}>
              <label>Encrypted backup<input ref={restoreInput} type="file" accept=".coccevault,application/json" onChange={(event) => setBackupFile(event.target.files?.[0] ?? null)} aria-label="Encrypted Vault backup file" /></label>
              <label>Backup passphrase<input type="password" autoComplete="current-password" value={restorePassphrase} onChange={(event) => setRestorePassphrase(event.target.value)} minLength={VAULT_MIN_PASSPHRASE_LENGTH} required aria-label="Backup Vault passphrase" /></label>
              <button className="button-secondary" type="submit" disabled={busy || !backupFile}>{busy ? 'Verifying encrypted backup…' : <><Archive size={15} /> Verify and restore</>}</button>
            </form>
          </section>
        </div>
      )}

      {mode === 'locked' && (
        <section className="vault-panel glass-card vault-lock-panel">
          <span className="vault-lock-art"><LockKeyhole size={26} /></span>
          <span className="eyebrow">LOCAL VAULT FOUND</span>
          <h2>Unlock on this device</h2>
          <p>The passphrase is used only in this tab to derive the key. A wrong passphrase or damaged ciphertext will not overwrite your saved vault.</p>
          <form className="vault-unlock-form" onSubmit={handleUnlock}>
            <label className="sr-only" htmlFor="vault-unlock-passphrase">Vault passphrase</label>
            <input id="vault-unlock-passphrase" type="password" autoComplete="off" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} minLength={VAULT_MIN_PASSPHRASE_LENGTH} required placeholder="Enter your Vault passphrase" />
            <button className="button-primary vault-primary" type="submit" disabled={busy}>{busy ? 'Deriving key…' : 'Unlock Vault'}</button>
          </form>
          <button className="button-secondary vault-backup-button" onClick={() => void exportBackup()}><Archive size={15} /> Export encrypted backup</button>
          <p className="vault-quiet-note">The export contains encrypted data and public algorithm/version metadata, never your passphrase. It cannot recover data if the passphrase is lost.</p>
        </section>
      )}

      {mode === 'unlocked' && session && (
        <>
          <div className="vault-open-toolbar">
            <div className="vault-open-state"><span className="vault-open-dot" /><span><strong>Unlocked in this tab</strong><small>{formatSize(totalBytes)} of {formatSize(MAX_VAULT_TOTAL_BYTES)} local file-content limit</small></span></div>
            <div className="vault-toolbar-actions">
              <button className="button-secondary" onClick={() => void exportBackup()} disabled={busy}><Archive size={15} /> Encrypted backup</button>
              <button className="button-secondary" onClick={lockVault}><LockKeyhole size={15} /> Lock Vault</button>
            </div>
          </div>
          <div className="vault-crypto-note"><ShieldCheck size={14} /><span>AES-GCM 256-bit + PBKDF2/SHA-256 (600,000 rounds) · Format v1 · max 25 MB/file and 50 MB total · data decrypts while this tab is unlocked</span></div>
          <div className="vault-workspace-grid">
            <aside className="vault-folder-panel glass-card" aria-label="Vault folders">
              <div className="vault-section-head"><div><span className="eyebrow">YOUR VAULT</span><h2>Folders</h2></div><FolderPlus size={17} /></div>
              <button className={`vault-folder-item ${selectedFolder === 'all' ? 'selected' : ''}`} onClick={() => setSelectedFolder('all')}><Archive size={16} /><span>All files</span><small>{entries.filter((entry) => entry.kind === 'file').length}</small></button>
              <button className={`vault-folder-item ${selectedFolder === 'unfiled' ? 'selected' : ''}`} onClick={() => setSelectedFolder('unfiled')}><Folder size={16} /><span>Unfiled</span><small>{entries.filter((entry) => entry.kind === 'file' && entry.folderId === null).length}</small></button>
              {folders.map((folder) => <div className="vault-folder-row" key={folder.id}><button className={`vault-folder-item ${selectedFolder === folder.id ? 'selected' : ''}`} onClick={() => setSelectedFolder(folder.id)}><Folder size={16} /><span>{folder.name}</span><small>{entries.filter((entry) => entry.kind === 'file' && entry.folderId === folder.id).length}</small></button><button className="vault-icon-action" aria-label={`Delete folder ${folder.name}`} title="Delete folder" disabled={busy} onClick={() => void deleteEntry(folder)}><Trash2 size={14} /></button></div>)}
              <form className="vault-folder-form" onSubmit={(event) => void addFolder(event)}>
                <label className="sr-only" htmlFor="vault-new-folder">New protected folder name</label>
                <input id="vault-new-folder" value={folderName} onChange={(event) => setFolderName(event.target.value)} maxLength={255} placeholder="New protected folder" disabled={busy} />
                <button type="submit" aria-label="Create protected folder" title="Create protected folder" disabled={busy || !folderName.trim()}><FolderPlus size={16} /></button>
              </form>
              <div className="vault-folder-foot"><span>Folders and names are encrypted</span><LockKeyhole size={13} /></div>
            </aside>
            <section className="vault-files-panel glass-card" aria-label="Encrypted Vault files">
              <div className="vault-files-heading"><div><span className="eyebrow">PROTECTED CONTENT</span><h2>{selectedFolderName}</h2><p>{visibleFiles.length} {visibleFiles.length === 1 ? 'file' : 'files'} · encrypted in this browser</p></div><div className="vault-upload-wrap"><input ref={fileInput} type="file" className="sr-only" onChange={(event) => void handleUpload(event)} aria-label="Choose a file to encrypt" /><button className="button-primary vault-primary" onClick={() => fileInput.current?.click()} disabled={busy}><Upload size={15} /> Add file</button></div></div>
              {visibleFiles.length === 0 ? <div className="vault-empty"><span className="vault-empty-icon"><FileLock2 size={22} /></span><h3>No files in {selectedFolderName.toLocaleLowerCase()} yet</h3><p>Files are encrypted in this tab before they are saved to local browser storage.</p><button className="button-secondary" onClick={() => fileInput.current?.click()} disabled={busy}><Upload size={15} /> Choose a file</button></div> : <div className="vault-file-list">{visibleFiles.map((file) => <div className="vault-file-row" key={file.id}><span className="vault-file-icon"><FileText size={17} /></span><span className="vault-file-info"><strong>{file.name}</strong><small>{formatSize(file.size)} · {file.mimeType || 'unknown type'} · encrypted</small></span><button className="vault-icon-action" aria-label={`Download ${file.name}`} title="Decrypt and download" disabled={busy} onClick={() => downloadFile(file)}><ArrowDownToLine size={16} /></button><button className="vault-icon-action" aria-label={`Delete ${file.name}`} title="Remove file" disabled={busy} onClick={() => void deleteEntry(file)}><Trash2 size={15} /></button></div>)}</div>}
              <div className="vault-files-footer"><span><LockKeyhole size={13} /> {formatSize(totalBytes)} encrypted file content</span><span>Names are never indexed by the app outside the unlocked tab</span></div>
            </section>
          </div>
          <section className="vault-limitations glass-card"><ShieldAlert size={16} /><p><strong>Local encryption is not server access control.</strong> No server, accounts, secure sharing, access logs, version history, automatic idle lock, biometric unlock, or passkey recovery is connected. Browser extensions or malware may read content while the Vault is unlocked, and clearing this browser’s site data can erase the only copy. Removing a file updates the current encrypted snapshot; it cannot erase exported backups or guarantee forensic deletion of browser-storage remnants.</p></section>
        </>
      )}
    </div>
  );
}
