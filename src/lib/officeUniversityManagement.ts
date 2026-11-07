import type { SupabaseClient } from "@supabase/supabase-js";

export type UniversityRole =
  | "university_admin"
  | "registrar"
  | "lecturer"
  | "finance_officer"
  | "research_coordinator"
  | "quality_officer"
  | "viewer"
  | "unassigned";
export type UniversityKeyConfig = {
  configured: boolean;
  key_version?: number;
  derivation?: string;
  iterations?: number;
  salt?: string;
  nonce?: string;
  ciphertext?: string;
};
export type UniversityPrivatePersonRecord = {
  legal_name: string;
  preferred_name: string;
  date_of_birth: string;
  email: string;
  phone: string;
  national_reference: string;
};
export type UniversityCiphertext = { nonce: string; ciphertext: string };
export interface UniversityRpcClient {
  rpc: (
    name: string,
    params?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
}
const ITERATIONS = 600_000;
const CHECK = "COCCE University private records key · version 1";
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
function api(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues)
    throw new Error("Secure browser cryptography is required.");
  return globalThis.crypto;
}
function b64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)),
    );
  return btoa(s);
}
function unb64(value: string) {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  )
    throw new Error("Malformed encrypted University record.");
  const s = atob(value);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
function buf(v: Uint8Array): ArrayBuffer {
  const x = new Uint8Array(v.byteLength);
  x.set(v);
  return x.buffer;
}
function requirePassphrase(p: string) {
  if (p.length < 12 || p.length > 256)
    throw new Error(
      "Use a University records passphrase between 12 and 256 characters.",
    );
}
async function derive(pass: string, salt: Uint8Array, iterations: number) {
  requirePassphrase(pass);
  if (salt.length !== 16 || iterations !== ITERATIONS)
    throw new Error("Unsupported University key configuration.");
  const material = await api().subtle.importKey(
    "raw",
    enc.encode(pass),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return api().subtle.deriveKey(
    { name: "PBKDF2", salt: buf(salt), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function seal(
  key: CryptoKey,
  value: Uint8Array,
): Promise<UniversityCiphertext> {
  const nonce = api().getRandomValues(new Uint8Array(12));
  const encrypted = await api().subtle.encrypt(
    { name: "AES-GCM", iv: buf(nonce), tagLength: 128 },
    key,
    buf(value),
  );
  return { nonce: b64(nonce), ciphertext: b64(new Uint8Array(encrypted)) };
}
async function open(key: CryptoKey, payload: UniversityCiphertext) {
  const nonce = unb64(payload.nonce),
    ciphertext = unb64(payload.ciphertext);
  if (
    nonce.length !== 12 ||
    ciphertext.length < 17 ||
    ciphertext.length > 32784
  )
    throw new Error("Malformed encrypted University record.");
  return new Uint8Array(
    await api().subtle.decrypt(
      { name: "AES-GCM", iv: buf(nonce), tagLength: 128 },
      key,
      buf(ciphertext),
    ),
  );
}
function clean(value: unknown, field: string, max: number, required = false) {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (required && !value.trim())
  )
    throw new Error(`${field} is missing or too long.`);
  return value.trim();
}
function validate(
  value: UniversityPrivatePersonRecord,
): UniversityPrivatePersonRecord {
  const result = {
    legal_name: clean(value.legal_name, "Legal name", 120, true),
    preferred_name: clean(value.preferred_name, "Preferred name", 120),
    date_of_birth: clean(value.date_of_birth, "Date of birth", 10),
    email: clean(value.email, "Email", 160),
    phone: clean(value.phone, "Phone", 40),
    national_reference: clean(
      value.national_reference,
      "National reference",
      80,
    ),
  };
  if (result.date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(result.date_of_birth))
    throw new Error("Date of birth must use YYYY-MM-DD.");
  if (result.date_of_birth) {
    const parsed = new Date(`${result.date_of_birth}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result.date_of_birth)
      throw new Error("Date of birth must be a real calendar date in YYYY-MM-DD format.");
  }
  if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email))
    throw new Error("Enter a valid email address or leave it empty.");
  return result;
}
export async function createUniversityKeyConfig(passphrase: string) {
  requirePassphrase(passphrase);
  const salt = api().getRandomValues(new Uint8Array(16));
  const key = await derive(passphrase, salt, ITERATIONS);
  const v = await seal(key, enc.encode(CHECK));
  return {
    key,
    payload: { salt: b64(salt), nonce: v.nonce, ciphertext: v.ciphertext },
  };
}
export async function unlockUniversityKey(
  passphrase: string,
  config: UniversityKeyConfig,
) {
  if (!config.configured || !config.salt || !config.nonce || !config.ciphertext)
    throw new Error(
      "The University private-record key has not been configured.",
    );
  if ((config.key_version !== undefined && config.key_version !== 1) ||
      (config.derivation !== undefined && config.derivation !== "PBKDF2-HMAC-SHA-256/AES-256-GCM"))
    throw new Error("Unsupported University key configuration.");
  const key = await derive(
    passphrase,
    unb64(config.salt),
    config.iterations ?? ITERATIONS,
  );
  try {
    const p = await open(key, {
      nonce: config.nonce,
      ciphertext: config.ciphertext,
    });
    if (dec.decode(p) !== CHECK) throw new Error();
    return key;
  } catch {
    throw new Error("That passphrase did not unlock the University records.");
  }
}
export async function encryptUniversityPrivatePerson(
  key: CryptoKey,
  record: UniversityPrivatePersonRecord,
) {
  return seal(key, enc.encode(JSON.stringify(validate(record))));
}
export async function decryptUniversityPrivatePerson(
  key: CryptoKey,
  payload: UniversityCiphertext,
) {
  try {
    return validate(
      JSON.parse(
        dec.decode(await open(key, payload)),
      ) as UniversityPrivatePersonRecord,
    );
  } catch {
    throw new Error("Could not decrypt this University identity record.");
  }
}
async function rpc<T>(
  client: UniversityRpcClient | SupabaseClient,
  name: string,
  params: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await (client as UniversityRpcClient).rpc(
    name,
    params,
  );
  if (error) throw new Error(error.message);
  return data as T;
}
export const officeUniversityManagementApi = {
  read<T = unknown>(
    client: UniversityRpcClient | SupabaseClient,
    workspaceId: string,
    resource: string,
    filter: Record<string, unknown> = {},
    limit = 100,
    offset = 0,
  ) {
    return rpc<T>(client, "office_university_read", {
      p_workspace_id: workspaceId,
      p_resource: resource,
      p_filter: filter,
      p_limit: Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 100,
      p_offset: Number.isFinite(offset) ? Math.max(0, Math.min(2147483647, Math.trunc(offset))) : 0,
    });
  },
  command<T extends Record<string, unknown> = Record<string, unknown>>(
    client: UniversityRpcClient | SupabaseClient,
    workspaceId: string,
    action: string,
    payload: Record<string, unknown>,
  ) {
    return rpc<T>(client, "office_university_command", {
      p_workspace_id: workspaceId,
      p_action: action,
      p_payload: payload,
    });
  },
};
