export type SourceDocumentFormat = "html" | "markdown";
export interface SourceWorkspaceDocument {
  id: string;
  workspaceId: string | null;
  format: SourceDocumentFormat;
  title: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}
type StorageLike = Pick<Storage, "getItem" | "setItem">;
const STORAGE_KEY = "cocce-office-source-workspaces-v1";
const MAX_DOCUMENTS = 300;
const MAX_SOURCE_LENGTH = 1_000_000;
const MAX_STORAGE_CHARS = 2_000_000;

function validDocument(value: unknown): value is SourceWorkspaceDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Partial<SourceWorkspaceDocument>;
  return typeof doc.id === "string" && doc.id.length > 0 && doc.id.length <= 120
    && (doc.workspaceId === null || (typeof doc.workspaceId === "string" && doc.workspaceId.length <= 160))
    && (doc.format === "html" || doc.format === "markdown")
    && typeof doc.title === "string" && doc.title.trim().length > 0 && doc.title.length <= 160
    && typeof doc.source === "string" && doc.source.length <= MAX_SOURCE_LENGTH
    && typeof doc.createdAt === "string" && Number.isFinite(Date.parse(doc.createdAt))
    && typeof doc.updatedAt === "string" && Number.isFinite(Date.parse(doc.updatedAt));
}

function readAll(storage: StorageLike): SourceWorkspaceDocument[] {
  let raw: string | null;
  try { raw = storage.getItem(STORAGE_KEY); }
  catch { throw new Error("Browser storage is unavailable. Export your current source before leaving this page."); }
  if (!raw) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("Saved source-workspace data is unreadable. It was preserved and will not be overwritten."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || (parsed as { version?: unknown }).version !== 1
    || !Array.isArray((parsed as { documents?: unknown }).documents)) {
    throw new Error("Saved source-workspace data uses an unsupported version. It was preserved and will not be overwritten.");
  }
  const documents = (parsed as { documents: unknown[] }).documents;
  if (documents.length > MAX_DOCUMENTS || !documents.every(validDocument)
    || new Set(documents.map((doc) => (doc as SourceWorkspaceDocument).id)).size !== documents.length) {
    throw new Error("Saved source-workspace data failed validation. It was preserved and will not be overwritten.");
  }
  return documents as SourceWorkspaceDocument[];
}

export function readSourceWorkspaceDocuments(
  storage: StorageLike,
  workspaceId: string | null,
  format: SourceDocumentFormat,
): SourceWorkspaceDocument[] {
  return readAll(storage)
    .filter((doc) => doc.workspaceId === workspaceId && doc.format === format)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function saveSourceWorkspaceDocument(storage: StorageLike, document: SourceWorkspaceDocument): void {
  if (!validDocument(document)) throw new Error("The source document is invalid or exceeds the 1 MB editor limit.");
  const documents = readAll(storage);
  const previous = documents.find((doc) => doc.id === document.id);
  if (previous && (previous.workspaceId !== document.workspaceId || previous.format !== document.format)) throw new Error("A source draft cannot be moved between workspaces or editor formats.");
  const existing = Boolean(previous);
  if (!existing && documents.length >= MAX_DOCUMENTS) throw new Error("This browser has reached the 300 source-document limit. Export or delete an old draft first.");
  const next = existing ? documents.map((doc) => doc.id === document.id ? document : doc) : [document, ...documents];
  const payload = JSON.stringify({ version: 1, documents: next });
  if (payload.length > MAX_STORAGE_CHARS) throw new Error("The local source-workspace storage limit is reached. Export older drafts before saving more.");
  try { storage.setItem(STORAGE_KEY, payload); }
  catch { throw new Error("Browser storage is full or unavailable. Export this draft before closing the tab."); }
}

export function deleteSourceWorkspaceDocument(storage: StorageLike, id: string): void {
  const documents = readAll(storage);
  try { storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, documents: documents.filter((doc) => doc.id !== id) })); }
  catch { throw new Error("The source document could not be deleted from browser storage."); }
}
