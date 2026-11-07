import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  decryptOfficePrivateRecord,
  encryptOfficePrivateRecord,
} from "./lib/officePrivateRecordsCrypto";
import {
  manufacturingRecordsContext,
  type ManufacturingAction,
  type ManufacturingRecord,
  type ManufacturingResource,
} from "./lib/officeManufacturingManagement";

export type ManufacturingSupplierPrivatePanelProps = {
  workspaceId: string;
  recordsKey: CryptoKey | null;
  canManage: boolean;
  identityToken: string;
  readPage: (
    resource: ManufacturingResource,
    filter?: ManufacturingRecord,
    offset?: number,
  ) => Promise<{
    rows: ManufacturingRecord[];
    total_count: number;
    offset: number;
    limit: number;
    has_more: boolean;
  } | null>;
  onCommand: (
    action: ManufacturingAction,
    payload: ManufacturingRecord,
    success?: string,
  ) => Promise<ManufacturingRecord>;
  busy: boolean;
};

type PrivateFields = {
  legal_name: string;
  contact_name: string;
  email: string;
  phone: string;
  tin: string;
  vrn: string;
  address: string;
  notes: string;
};

type PrivateRow = { nonce: string; ciphertext: string; version: number };

const EMPTY: PrivateFields = {
  legal_name: "",
  contact_name: "",
  email: "",
  phone: "",
  tin: "",
  vrn: "",
  address: "",
  notes: "",
};
const FIELDS: Array<{ key: keyof PrivateFields; label: string; maxLength: number }> = [
  { key: "legal_name", label: "Legal name", maxLength: 160 },
  { key: "contact_name", label: "Contact name", maxLength: 120 },
  { key: "email", label: "Email", maxLength: 160 },
  { key: "phone", label: "Phone", maxLength: 40 },
  { key: "tin", label: "TIN", maxLength: 40 },
  { key: "vrn", label: "VRN", maxLength: 40 },
  { key: "address", label: "Address", maxLength: 500 },
  { key: "notes", label: "Notes", maxLength: 1000 },
];
const PRIVATE_KEYS = new Set(Object.keys(EMPTY));
const PAGE_SIZE = 25;

function text(row: ManufacturingRecord, key: string): string {
  return typeof row[key] === "string" ? row[key] as string : "";
}
function emptyFields(): PrivateFields { return { ...EMPTY }; }
function safeError(error: unknown): string {
  return error instanceof Error && error.message && !/plaintext|private|legal_name|contact_name|email|phone|tin|vrn|address|notes/i.test(error.message)
    ? error.message.slice(0, 240)
    : "The supplier private record could not be processed.";
}
function requestId(): string {
  if (!globalThis.crypto?.randomUUID) throw new Error("Secure request identifiers are unavailable.");
  return globalThis.crypto.randomUUID();
}
function decodePrivateRow(row: ManufacturingRecord): PrivateRow {
  const version = row.version;
  if (typeof row.nonce !== "string" || typeof row.ciphertext !== "string" || typeof version !== "number" || !Number.isSafeInteger(version) || version < 1)
    throw new Error("Malformed encrypted supplier record.");
  return { nonce: row.nonce, ciphertext: row.ciphertext, version };
}
function validateFields(value: unknown): PrivateFields {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed decrypted supplier record.");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !PRIVATE_KEYS.has(key))) throw new Error("Malformed decrypted supplier record.");
  const result = emptyFields();
  for (const field of FIELDS) {
    if (record[field.key] !== undefined && typeof record[field.key] !== "string") throw new Error("Malformed decrypted supplier record.");
    const valueForField = record[field.key];
    if (typeof valueForField === "string" && valueForField.length > field.maxLength) throw new Error("Malformed decrypted supplier record.");
    result[field.key] = typeof valueForField === "string" ? valueForField : "";
  }
  return result;
}

export default function ManufacturingSupplierPrivatePanel({
  workspaceId, recordsKey, canManage, identityToken, readPage, onCommand, busy,
}: ManufacturingSupplierPrivatePanelProps) {
  const [query, setQuery] = useState("");
  const [suppliers, setSuppliers] = useState<ManufacturingRecord[]>([]);
  const [supplierOffset, setSupplierOffset] = useState(0);
  const [supplierHasMore, setSupplierHasMore] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [fields, setFields] = useState<PrivateFields>(emptyFields);
  const [loadedVersion, setLoadedVersion] = useState<number | null>(null);
  const [hasPrivateRecord, setHasPrivateRecord] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const generation = useRef(0);
  const context = manufacturingRecordsContext(workspaceId);
  const current = (token: number) => mounted.current && token === generation.current;

  const clearSensitive = useCallback(() => {
    generation.current += 1;
    setSelectedId("");
    setFields(emptyFields());
    setLoadedVersion(null);
    setHasPrivateRecord(false);
    setNotice("");
    setError("");
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
      setFields(emptyFields());
    };
  }, []);
  useEffect(() => {
    generation.current += 1;
    setSuppliers([]);
    setSupplierOffset(0);
    setSupplierHasMore(false);
    setSelectedId("");
    setFields(emptyFields());
    setLoadedVersion(null);
    setHasPrivateRecord(false);
    setNotice("");
    setError("");
  }, [workspaceId, identityToken, recordsKey, canManage]);
  useEffect(() => {
    const onVisibility = () => { if (document.visibilityState === "hidden") clearSensitive(); };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [clearSensitive]);

  const searchSuppliers = async (offset = 0) => {
    const token = generation.current;
    setError("");
    try {
      const result = await readPage("suppliers", query.trim() ? { q: query.trim().slice(0, 120) } : {}, offset);
      if (!current(token)) return;
      setSuppliers((result?.rows ?? []).filter((row) => typeof row.id === "string"));
      setSupplierOffset(result?.offset ?? offset);
      setSupplierHasMore(result?.has_more ?? false);
    } catch (caught) {
      if (current(token)) setError(safeError(caught));
    }
  };
  const selectSupplier = (id: string) => {
    generation.current += 1;
    setSelectedId(id);
    setFields(emptyFields());
    setLoadedVersion(null);
    setHasPrivateRecord(false);
    setNotice("");
    setError("");
  };
  const loadPrivate = useCallback(async () => {
    if (!canManage || !recordsKey || !selectedId) return;
    const token = generation.current;
    setError("");
    try {
      const result = await readPage("supplier_private", { supplier_id: selectedId }, 0);
      if (!current(token)) return;
      if (!result || result.rows.length === 0) {
        setFields(emptyFields()); setLoadedVersion(null); setHasPrivateRecord(false);
        setNotice("No encrypted private record is saved for this supplier.");
        return;
      }
      const row = decodePrivateRow(result.rows[0]);
      const decrypted = await decryptOfficePrivateRecord<Record<string, unknown>>(recordsKey, row, context);
      if (!current(token)) return;
      setFields(validateFields(decrypted));
      setLoadedVersion(row.version);
      setHasPrivateRecord(true);
      setNotice("Private supplier details loaded into this device only.");
    } catch (caught) {
      if (current(token)) { setFields(emptyFields()); setLoadedVersion(null); setHasPrivateRecord(false); setError("Could not decrypt this supplier record. Check the key, context, and record integrity."); }
    }
  }, [canManage, context, readPage, recordsKey, selectedId]);
  useEffect(() => { void loadPrivate(); }, [loadPrivate]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canManage || !recordsKey || !selectedId || busy) return;
    const token = generation.current;
    setError(""); setNotice("");
    try {
      const encrypted = await encryptOfficePrivateRecord(recordsKey, fields, context);
      if (!current(token)) return;
      await onCommand("save_supplier_private", {
        supplier_id: selectedId,
        nonce: encrypted.nonce,
        ciphertext: encrypted.ciphertext,
        expected_version: hasPrivateRecord ? loadedVersion : 0,
        idempotency_key: requestId(),
      }, "Private supplier details encrypted and saved.");
      if (!current(token)) return;
      const fresh = await readPage("supplier_private", { supplier_id: selectedId }, 0);
      if (!current(token)) return;
      if (!fresh || fresh.rows.length === 0) throw new Error("The saved supplier record could not be refreshed.");
      const row = decodePrivateRow(fresh.rows[0]);
      const decrypted = await decryptOfficePrivateRecord<Record<string, unknown>>(recordsKey, row, context);
      if (!current(token)) return;
      setFields(validateFields(decrypted));
      setLoadedVersion(row.version);
      setHasPrivateRecord(true);
      setNotice("Private supplier details encrypted and saved.");
    } catch (caught) {
      if (current(token)) setError(safeError(caught));
    }
  };

  if (!canManage) return <section className="manufacturing-card" aria-label="Private supplier details"><h2>Private supplier details</h2><p>Private supplier details are restricted to authorized manufacturing roles.</p></section>;
  return (
    <section className="manufacturing-card pearl-glass" aria-labelledby="supplier-private-title">
      <h2 id="supplier-private-title">Private supplier details</h2>
      <p>Reference labels show organization code and display label only. Private values are encrypted in this browser and never sent as plaintext.</p>
      {!recordsKey ? <p role="status">Private supplier details are locked. Unlock the Manufacturing records key to view or edit them.</p> : <>
        {error && <div role="alert">{error}</div>}
        {notice && <div role="status">{notice}</div>}
        <form onSubmit={(event) => void save(event)}>
          <label htmlFor="supplier-private-search">Search suppliers</label>
          <input id="supplier-private-search" value={query} maxLength={120} onChange={(event) => setQuery(event.target.value)} placeholder="Reference labels only" />
          <button type="button" onClick={() => void searchSuppliers(0)} disabled={busy}>Search</button>
          <label htmlFor="supplier-private-selector">Supplier reference</label>
          <select id="supplier-private-selector" value={selectedId} onChange={(event) => selectSupplier(event.target.value)}>
            <option value="">Choose a supplier…</option>
            {suppliers.map((row) => <option key={String(row.id)} value={String(row.id)}>{text(row, "supplier_code")} · {text(row, "display_label")}</option>)}
          </select>
          <div>
            <button type="button" onClick={() => void searchSuppliers(Math.max(0, supplierOffset - PAGE_SIZE))} disabled={busy || supplierOffset <= 0}>Previous</button>
            <button type="button" onClick={() => void searchSuppliers(supplierOffset + PAGE_SIZE)} disabled={busy || !supplierHasMore}>Next</button>
          </div>
          {selectedId && <>
            {FIELDS.map((field) => <label key={field.key} htmlFor={`supplier-private-${field.key}`}>{field.label}<input id={`supplier-private-${field.key}`} value={fields[field.key]} maxLength={field.maxLength} onChange={(event) => setFields((previous) => ({ ...previous, [field.key]: event.target.value }))} /></label>)}
            <button type="submit" disabled={busy || !recordsKey}>{busy ? "Saving…" : "Save encrypted details"}</button>
            <button type="button" onClick={() => void loadPrivate()} disabled={busy}>Reload encrypted details</button>
          </>}
        </form>
      </>}
    </section>
  );
}
