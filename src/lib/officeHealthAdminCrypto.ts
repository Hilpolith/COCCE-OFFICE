import {
  decryptOfficePrivateRecord,
  encryptOfficePrivateRecord,
  createOfficeRecordsKeyConfig,
  unlockOfficeRecordsKeyConfig,
  type OfficeRecordsCiphertext,
  type OfficeRecordsKeyConfig,
} from "./officePrivateRecordsCrypto";

export type HealthAdminIndexKind = "facility_mrn" | "national_id" | "passport" | "phone";
export type HealthAdminPrivateScope = "patient_identity" | "clinical" | "triage" | "diagnostic" | "pharmacy" | "inpatient" | "billing_claims" | "workforce_private" | "privacy_private";
export type HealthAdminKeyConfig = OfficeRecordsKeyConfig & { configured: boolean; version?: number; index_key_nonce?: string; index_key_ciphertext?: string };
export type HealthAdminKeys = { recordsKey: CryptoKey; indexKey: CryptoKey };

const encoder = new TextEncoder();
const b64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const INDEX_CONTEXT = "health-admin-index-key";
const scopePattern = /^(patient_identity|clinical|triage|diagnostic|pharmacy|inpatient|billing_claims|workforce_private|privacy_private)$/;
function api(): Crypto { if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) throw new Error("Secure Health Administration cryptography is unavailable."); return globalThis.crypto; }
function copy(bytes: Uint8Array): ArrayBuffer { const out = new Uint8Array(bytes.length); out.set(bytes); return out.buffer; }
function encode(bytes: Uint8Array): string { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length))); return btoa(s); }
function decode(value: string, label: string): Uint8Array { if (typeof value !== "string" || !b64.test(value)) throw new Error(`Health Administration ${label} is malformed.`); const raw = atob(value); const out = Uint8Array.from(raw, c => c.charCodeAt(0)); if (encode(out) !== value) throw new Error(`Health Administration ${label} is malformed.`); return out; }
function context(workspaceId: string): string { if (typeof workspaceId !== "string" || workspaceId.length < 1 || workspaceId.length > 100) throw new Error("Health Administration workspace context is required."); return `COCCE HealthAdmin:${workspaceId}:v1`; }
function recordContext(workspaceId: string, recordId: string, scope: HealthAdminPrivateScope): string { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(recordId) || !scopePattern.test(scope)) throw new Error("Health Administration private-record context is invalid."); return `${context(workspaceId)}:record:${recordId}:scope:${scope}`; }
function normalize(kind: HealthAdminIndexKind, value: string): string { if (!["facility_mrn", "national_id", "passport", "phone"].includes(kind) || typeof value !== "string" || value.length === 0 || value.length > 256) throw new Error("Unsupported Health Administration identifier."); const trimmed = value.normalize("NFKC").trim(); if (kind === "phone") { const digits = trimmed.replace(/[\s().-]/g, ""); if (!/^\+?[0-9]{7,20}$/.test(digits)) throw new Error("Unsupported Health Administration identifier."); return digits; } const normalized = trimmed.toUpperCase().replace(/[\s-]/g, ""); if (!/^[A-Z0-9/]{2,128}$/.test(normalized)) throw new Error("Unsupported Health Administration identifier."); return normalized; }
async function importIndexKey(seed: Uint8Array): Promise<CryptoKey> { if (seed.length !== 32) throw new Error("Health Administration index key is malformed."); return api().subtle.importKey("raw", copy(seed), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); }
function keyEnvelope(seed: Uint8Array): Record<string, unknown> { return { seed: encode(seed) }; }

export async function createOfficeHealthAdminKeyConfig(passphrase: string, workspaceId: string): Promise<{ keys: HealthAdminKeys; config: HealthAdminKeyConfig }> {
  const base = await createOfficeRecordsKeyConfig(passphrase, context(workspaceId));
  const seed = api().getRandomValues(new Uint8Array(32));
  const sealed = await encryptOfficePrivateRecord(base.key, keyEnvelope(seed), `${context(workspaceId)}:${INDEX_CONTEXT}`);
  return { keys: { recordsKey: base.key, indexKey: await importIndexKey(seed) }, config: { configured: true, version: 1, key_version: 1, derivation: "PBKDF2-HMAC-SHA-256/AES-256-GCM", iterations: 600000, salt: base.payload.salt, nonce: base.payload.nonce, ciphertext: base.payload.ciphertext, index_key_nonce: sealed.nonce, index_key_ciphertext: sealed.ciphertext } };
}

export async function unlockOfficeHealthAdminKeys(passphrase: string, config: HealthAdminKeyConfig, workspaceId: string): Promise<HealthAdminKeys> {
  if (!config?.configured || !config.index_key_nonce || !config.index_key_ciphertext) throw new Error("Health Administration keys are not configured.");
  const recordsKey = await unlockOfficeRecordsKeyConfig(passphrase, config as HealthAdminKeyConfig, context(workspaceId));
  try { const opened = await decryptOfficePrivateRecord<{ seed: string }>(recordsKey, { nonce: config.index_key_nonce, ciphertext: config.index_key_ciphertext }, `${context(workspaceId)}:${INDEX_CONTEXT}`); const seed = decode(opened.seed, "index key"); return { recordsKey, indexKey: await importIndexKey(seed) }; } catch { throw new Error("Health Administration keys could not be unlocked."); }
}

export async function sealHealthAdminPrivateRecord<T extends Record<string, unknown>>(recordsKey: CryptoKey, workspaceId: string, recordId: string, scope: HealthAdminPrivateScope, value: T): Promise<OfficeRecordsCiphertext> { return encryptOfficePrivateRecord(recordsKey, value, recordContext(workspaceId, recordId, scope)); }
export async function openHealthAdminPrivateRecord<T extends Record<string, unknown>>(recordsKey: CryptoKey, workspaceId: string, recordId: string, scope: HealthAdminPrivateScope, payload: OfficeRecordsCiphertext): Promise<T> { return decryptOfficePrivateRecord<T>(recordsKey, payload, recordContext(workspaceId, recordId, scope)); }
export async function makeHealthAdminBlindIndex(indexKey: CryptoKey, workspaceOrKind: string, kindOrValue: HealthAdminIndexKind | string, maybeValue?: string): Promise<{ index_type: HealthAdminIndexKind; digest: string }> { const legacy = maybeValue === undefined; const workspaceId = legacy ? "legacy" : workspaceOrKind; const kind = (legacy ? workspaceOrKind : kindOrValue) as HealthAdminIndexKind; const value = (legacy ? kindOrValue : maybeValue) as string; const normalized = normalize(kind, value); const signature = await api().subtle.sign("HMAC", indexKey, copy(encoder.encode(`${context(workspaceId)}\0${kind}\0${normalized}`))); return { index_type: kind, digest: encode(new Uint8Array(signature)) }; }

// Compatibility aliases for the existing workspace adapter; they preserve the same
// ciphertext-only implementation and do not broaden any storage or RPC contract.
function workspaceFromContext(value: string): string {
  const match = /^COCCE HealthAdmin:([^:]+):v1$/.exec(value);
  return match?.[1] ?? value;
}
export const createHealthAdminKeyConfig = async (passphrase: string, workspaceContext: string) => {
  const result = await createOfficeHealthAdminKeyConfig(passphrase, workspaceFromContext(workspaceContext));
  return { recordsKey: result.keys.recordsKey, indexKey: result.keys.indexKey, config: result.config };
};
export const unlockHealthAdminKeyConfig = async (passphrase: string, config: HealthAdminKeyConfig | Record<string, unknown>, workspaceContext: string) => {
  const result = await unlockOfficeHealthAdminKeys(passphrase, config as HealthAdminKeyConfig, workspaceFromContext(workspaceContext));
  return { recordsKey: result.recordsKey, indexKey: result.indexKey };
};
export const sealHealthAdminPrivate = sealHealthAdminPrivateRecord;
export const openHealthAdminPrivate = openHealthAdminPrivateRecord;
