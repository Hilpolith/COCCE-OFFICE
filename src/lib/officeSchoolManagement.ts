import type { SupabaseClient } from '@supabase/supabase-js';

export type SchoolRole = 'school_admin' | 'registrar' | 'teacher' | 'bursar' | 'viewer' | 'unassigned';
export type SchoolKeyConfig = {
  configured: boolean;
  key_version?: number;
  derivation?: string;
  iterations?: number;
  salt?: string;
  nonce?: string;
  ciphertext?: string;
};
export type SchoolPrivateGuardian = {
  name: string;
  relationship: 'parent' | 'guardian' | 'other';
  phone: string;
  email: string;
};
export type SchoolPrivatePersonRecord = {
  legal_name: string;
  preferred_name: string;
  date_of_birth: string;
  guardians: SchoolPrivateGuardian[];
};
export type SchoolCiphertext = { nonce: string; ciphertext: string };
export interface SchoolRpcClient {
  rpc: (name: string, params?: Record<string, unknown>) => Promise<{
    data: unknown;
    error: { message: string } | null;
  }>;
}

const KEY_CHECK = 'COCCE School private records key · version 1';
const FIXED_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error('This browser does not provide secure cryptography. Use a current browser over HTTPS.');
  }
  return globalThis.crypto;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('The encrypted School record is malformed.');
  }
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left[index] ^ right[index];
  return mismatch === 0;
}

function requirePassphrase(passphrase: string) {
  if (passphrase.length < 12 || passphrase.length > 256) {
    throw new Error('Use a School records passphrase between 12 and 256 characters.');
  }
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  requirePassphrase(passphrase);
  if (salt.length !== 16 || iterations !== FIXED_ITERATIONS) throw new Error('The School key configuration is not supported.');
  const api = cryptoApi();
  const material = await api.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return api.subtle.deriveKey(
    { name: 'PBKDF2', salt: ownedBuffer(salt), iterations, hash: 'SHA-256' }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

async function seal(key: CryptoKey, value: Uint8Array): Promise<SchoolCiphertext> {
  const api = cryptoApi();
  const nonce = api.getRandomValues(new Uint8Array(12));
  const ciphertext = await api.subtle.encrypt({ name: 'AES-GCM', iv: ownedBuffer(nonce), tagLength: 128 }, key, ownedBuffer(value));
  return { nonce: encodeBase64(nonce), ciphertext: encodeBase64(new Uint8Array(ciphertext)) };
}

async function open(key: CryptoKey, payload: SchoolCiphertext): Promise<Uint8Array> {
  const nonce = decodeBase64(payload.nonce);
  const ciphertext = decodeBase64(payload.ciphertext);
  if (nonce.length !== 12 || ciphertext.length < 17 || ciphertext.length > 32784) {
    throw new Error('The encrypted School record is malformed.');
  }
  const plaintext = await cryptoApi().subtle.decrypt(
    { name: 'AES-GCM', iv: ownedBuffer(nonce), tagLength: 128 }, key, ownedBuffer(ciphertext),
  );
  return new Uint8Array(plaintext);
}

function hasControlCharacters(value: string, allowLineBreaks = false) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code === 0x7f || (code < 0x20 && !(allowLineBreaks && (code === 0x09 || code === 0x0a || code === 0x0d)))) return true;
  }
  return false;
}

function validatePrivatePerson(record: SchoolPrivatePersonRecord): SchoolPrivatePersonRecord {
  const clean = (value: string, field: string, max: number, required = false) => {
    if (typeof value !== 'string' || value.length > max || hasControlCharacters(value) || (required && !value.trim())) {
      throw new Error(`${field} is missing or too long.`);
    }
    return value.trim();
  };
  const legalName = clean(record.legal_name, 'Legal name', 120, true);
  const preferredName = clean(record.preferred_name, 'Preferred name', 120);
  const birthDate = clean(record.date_of_birth, 'Date of birth', 10);
  if (birthDate && !/^\d{4}-\d{2}-\d{2}$/.test(birthDate)) throw new Error('Date of birth must use YYYY-MM-DD.');
  if (!Array.isArray(record.guardians) || record.guardians.length > 4) throw new Error('Add no more than four parent/guardian contacts.');
  const guardians = record.guardians.map((guardian) => {
    if (!['parent', 'guardian', 'other'].includes(guardian.relationship)) throw new Error('Choose a supported guardian relationship.');
    return {
      name: clean(guardian.name, 'Guardian name', 120, true),
      relationship: guardian.relationship,
      phone: clean(guardian.phone, 'Guardian phone', 32),
      email: clean(guardian.email, 'Guardian email', 160),
    };
  });
  return { legal_name: legalName, preferred_name: preferredName, date_of_birth: birthDate, guardians };
}

export async function createSchoolKeyConfig(passphrase: string): Promise<{ key: CryptoKey; payload: { salt: string; nonce: string; ciphertext: string } }> {
  requirePassphrase(passphrase);
  const salt = cryptoApi().getRandomValues(new Uint8Array(16));
  const key = await deriveKey(passphrase, salt, FIXED_ITERATIONS);
  const verification = await seal(key, encoder.encode(KEY_CHECK));
  return { key, payload: { salt: encodeBase64(salt), nonce: verification.nonce, ciphertext: verification.ciphertext } };
}

export async function unlockSchoolKey(passphrase: string, config: SchoolKeyConfig): Promise<CryptoKey> {
  if (!config.configured || !config.salt || !config.nonce || !config.ciphertext) {
    throw new Error('The School private-record key has not been configured.');
  }
  const key = await deriveKey(passphrase, decodeBase64(config.salt), config.iterations ?? FIXED_ITERATIONS);
  let plain: Uint8Array;
  try { plain = await open(key, { nonce: config.nonce, ciphertext: config.ciphertext }); }
  catch { throw new Error('That passphrase did not unlock the School records.'); }
  if (!equalBytes(plain, encoder.encode(KEY_CHECK))) throw new Error('That passphrase did not unlock the School records.');
  return key;
}

export async function encryptSchoolPrivatePerson(key: CryptoKey, record: SchoolPrivatePersonRecord): Promise<SchoolCiphertext> {
  const checked = validatePrivatePerson(record);
  return seal(key, encoder.encode(JSON.stringify(checked)));
}

export async function decryptSchoolPrivatePerson(key: CryptoKey, payload: SchoolCiphertext): Promise<SchoolPrivatePersonRecord> {
  let parsed: unknown;
  try { parsed = JSON.parse(decoder.decode(await open(key, payload))); }
  catch { throw new Error('Could not decrypt this identity record. Check the passphrase or record version.'); }
  if (!parsed || typeof parsed !== 'object' || !('legal_name' in parsed) || !('guardians' in parsed)) {
    throw new Error('The encrypted identity record has an unsupported format.');
  }
  return validatePrivatePerson(parsed as SchoolPrivatePersonRecord);
}

export async function encryptSchoolNotice(key: CryptoKey, body: string): Promise<SchoolCiphertext> {
  const text = body.trim();
  const bytes = encoder.encode(text);
  if (!text || bytes.length > 8176 || hasControlCharacters(text, true)) {
    throw new Error('Notice text must be non-empty, under 8 KB, and contain no control characters.');
  }
  return seal(key, bytes);
}

export async function decryptSchoolNotice(key: CryptoKey, payload: SchoolCiphertext): Promise<string> {
  try { return decoder.decode(await open(key, payload)); }
  catch { throw new Error('Could not decrypt this notice. Check the passphrase or record version.'); }
}

async function rpc<T>(client: SchoolRpcClient | SupabaseClient, name: string, params: Record<string, unknown>): Promise<T> {
  const rpcClient = client as unknown as SchoolRpcClient;
  const { data, error } = await rpcClient.rpc(name, params) as { data: T | null; error: { message: string } | null };
  if (error) throw new Error(error.message);
  return data as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export const officeSchoolManagementApi = {
  async read<T = unknown>(client: SchoolRpcClient | SupabaseClient, workspaceId: string, resource: string, filter: Record<string, unknown> = {}, limit = 100): Promise<T> {
    const boundedLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    return rpc<T>(client, 'office_school_read', {
      p_workspace_id: workspaceId, p_resource: resource, p_filter: filter, p_limit: boundedLimit,
    });
  },
  async command<T extends Record<string, unknown> = Record<string, unknown>>(
    client: SchoolRpcClient | SupabaseClient, workspaceId: string, action: string, payload: Record<string, unknown>,
  ): Promise<T> {
    const result = await rpc<unknown>(client, 'office_school_command', {
      p_workspace_id: workspaceId, p_action: action, p_payload: payload,
    });
    if (!isRecord(result)) throw new Error('The School server returned an unexpected command response.');
    return result as T;
  },
};
