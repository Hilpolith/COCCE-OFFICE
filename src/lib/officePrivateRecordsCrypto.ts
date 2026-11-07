export type OfficeRecordsKeyConfig = {
  configured: boolean;
  key_version?: number;
  derivation?: string;
  iterations?: number;
  salt?: string;
  nonce?: string;
  ciphertext?: string;
};

export type OfficeRecordsCiphertext = { nonce: string; ciphertext: string };

const KEY_VERSION = 1;
const DERIVATION = 'PBKDF2-HMAC-SHA-256/AES-256-GCM';
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PAYLOAD_BYTES = 32_768;
const VERIFIER = 'COCCE Office private records key v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw new Error('Secure Office records cryptography is unavailable in this browser.');
  }
  return globalThis.crypto;
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
  }
  return btoa(binary);
}

function decodeBase64(value: string, label: string): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`The Office records ${label} is not valid canonical base64.`);
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error(`The Office records ${label} is not valid canonical base64.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (encodeBase64(bytes) !== value) throw new Error(`The Office records ${label} is not valid canonical base64.`);
  return bytes;
}

function requireContext(context: string): Uint8Array {
  if (typeof context !== 'string') throw new Error('The Office records context is required.');
  const bytes = encoder.encode(context);
  if (bytes.length === 0 || bytes.length > 200) {
    throw new Error('The Office records context must be non-empty and at most 200 UTF-8 bytes.');
  }
  return bytes;
}

function requirePassphrase(passphrase: string): void {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 256) {
    throw new Error('Use an Office records passphrase between 12 and 256 characters.');
  }
}

function aad(context: string, purpose: 'verifier' | 'records'): ArrayBuffer {
  requireContext(context);
  return ownedBuffer(encoder.encode(`COCCE Office private records/${purpose}/v1\0${context}`));
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  requirePassphrase(passphrase);
  if (salt.length !== SALT_BYTES || iterations !== ITERATIONS) {
    throw new Error('Unsupported Office records key configuration.');
  }
  const api = cryptoApi();
  const material = await api.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return api.subtle.deriveKey(
    { name: 'PBKDF2', salt: ownedBuffer(salt), iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key: CryptoKey, value: Uint8Array, context: string, purpose: 'verifier' | 'records'): Promise<OfficeRecordsCiphertext> {
  const api = cryptoApi();
  const nonce = api.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await api.subtle.encrypt(
    { name: 'AES-GCM', iv: ownedBuffer(nonce), additionalData: aad(context, purpose), tagLength: 128 },
    key,
    ownedBuffer(value),
  );
  const encrypted = new Uint8Array(ciphertext);
  if (encrypted.length > MAX_PAYLOAD_BYTES) throw new Error('The Office private record is too large.');
  return { nonce: encodeBase64(nonce), ciphertext: encodeBase64(encrypted) };
}

async function open(key: CryptoKey, payload: OfficeRecordsCiphertext, context: string, purpose: 'verifier' | 'records'): Promise<Uint8Array> {
  const nonce = decodeBase64(payload.nonce, 'record nonce');
  const ciphertext = decodeBase64(payload.ciphertext, 'record ciphertext');
  if (nonce.length !== NONCE_BYTES || ciphertext.length < TAG_BYTES || ciphertext.length > MAX_PAYLOAD_BYTES) {
    throw new Error('The Office encrypted record payload is malformed.');
  }
  const plaintext = await cryptoApi().subtle.decrypt(
    { name: 'AES-GCM', iv: ownedBuffer(nonce), additionalData: aad(context, purpose), tagLength: 128 },
    key,
    ownedBuffer(ciphertext),
  );
  return new Uint8Array(plaintext);
}

function validateConfig(config: OfficeRecordsKeyConfig): void {
  if (!config || config.configured !== true || !config.salt || !config.nonce || !config.ciphertext) {
    throw new Error('The Office private-record key has not been configured.');
  }
  if ((config.key_version !== undefined && config.key_version !== KEY_VERSION)
    || (config.derivation !== undefined && config.derivation !== DERIVATION)
    || (config.iterations !== undefined && config.iterations !== ITERATIONS)) {
    throw new Error('Unsupported Office records key configuration.');
  }
}

export async function createOfficeRecordsKeyConfig(passphrase: string, context: string): Promise<{ key: CryptoKey; payload: { salt: string; nonce: string; ciphertext: string } }> {
  requirePassphrase(passphrase);
  requireContext(context);
  const salt = cryptoApi().getRandomValues(new Uint8Array(SALT_BYTES));
  const key = await deriveKey(passphrase, salt, ITERATIONS);
  const verification = await seal(key, encoder.encode(VERIFIER), context, 'verifier');
  return { key, payload: { salt: encodeBase64(salt), nonce: verification.nonce, ciphertext: verification.ciphertext } };
}

export async function unlockOfficeRecordsKeyConfig(passphrase: string, config: OfficeRecordsKeyConfig, context: string): Promise<CryptoKey> {
  requireContext(context);
  validateConfig(config);
  const salt = decodeBase64(config.salt!, 'key salt');
  const nonce = decodeBase64(config.nonce!, 'key verifier nonce');
  const ciphertext = decodeBase64(config.ciphertext!, 'key verifier ciphertext');
  let key: CryptoKey;
  try {
    key = await deriveKey(passphrase, salt, config.iterations ?? ITERATIONS);
    const plain = await open(key, { nonce: encodeBase64(nonce), ciphertext: encodeBase64(ciphertext) }, context, 'verifier');
    if (decoder.decode(plain) !== VERIFIER) throw new Error('Verifier mismatch.');
  } catch {
    throw new Error('That passphrase or Office records context did not unlock the Office records.');
  }
  return key;
}

export async function encryptOfficePrivateRecord(key: CryptoKey, value: Record<string, unknown>, context: string): Promise<OfficeRecordsCiphertext> {
  requireContext(context);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('An Office private record must be a plain object.');
  let plaintext: Uint8Array;
  try {
    plaintext = encoder.encode(JSON.stringify(value));
  } catch {
    throw new Error('The Office private record must be JSON-serializable.');
  }
  if (plaintext.length + TAG_BYTES > MAX_PAYLOAD_BYTES) throw new Error('The Office private record is too large.');
  return seal(key, plaintext, context, 'records');
}

export async function decryptOfficePrivateRecord<T extends Record<string, unknown>>(key: CryptoKey, payload: OfficeRecordsCiphertext, context: string): Promise<T> {
  requireContext(context);
  try {
    const parsed: unknown = JSON.parse(decoder.decode(await open(key, payload, context, 'records')));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Record shape.');
    return parsed as T;
  } catch {
    throw new Error('Could not decrypt this Office private record. Check the key, context, and record integrity.');
  }
}
