const MAX_PLAINTEXT_BYTES = 20 * 1024 * 1024;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 8 + NONCE_BYTES;
const MAGIC = new Uint8Array([0x43, 0x4f, 0x43, 0x43, 0x45, 0x2d, 0x45, 0x31]); // COCCE-E1
const VERSION = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

type AttachmentInput = { name: string; type: string; bytes: Uint8Array };
type AttachmentMetadata = { name: string; type: string; length: number };

function cryptoApi(): Crypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues)
    throw new Error(
      "Secure attachment cryptography is unavailable in this browser.",
    );
  return globalThis.crypto;
}
function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
function contextBytes(context: string): Uint8Array {
  if (typeof context !== "string")
    throw new Error("Attachment encryption context is required.");
  const bytes = encoder.encode(context);
  if (!bytes.length || bytes.length > 240)
    throw new Error("Attachment encryption context must be 1–240 UTF-8 bytes.");
  return encoder.encode(`COCCE Office encrypted attachment/v1\0${context}`);
}
function validateKey(key: CryptoKey): void {
  if (
    !key ||
    key.algorithm.name !== "AES-GCM" ||
    (key.algorithm as AesKeyAlgorithm).length !== 256
  )
    throw new Error("An AES-256-GCM CryptoKey is required for attachments.");
}
function validateInput(input: AttachmentInput): void {
  if (
    !input ||
    typeof input.name !== "string" ||
    !input.name.trim() ||
    input.name.length > 255 ||
    /[\x00-\x1f\x7f/\\]/.test(input.name)
  )
    throw new Error("Attachment filename is invalid.");
  if (
    typeof input.type !== "string" ||
    input.type.length > 255 ||
    /[\x00-\x1f\x7f]/.test(input.type)
  )
    throw new Error("Attachment MIME type is invalid.");
  if (
    !(input.bytes instanceof Uint8Array) ||
    input.bytes.byteLength > MAX_PLAINTEXT_BYTES
  )
    throw new Error("The attachment exceeds the 20 MiB plaintext limit.");
}
function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}
function readU32(bytes: Uint8Array, offset: number): number {
  return new DataView(
    ownedBuffer(bytes.subarray(offset, offset + 4)),
  ).getUint32(0, false);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Encrypt a binary attachment and its original filename/MIME metadata with AES-256-GCM. */
export async function encryptOfficeAttachment(
  key: CryptoKey,
  input: AttachmentInput,
  context: string,
): Promise<Uint8Array> {
  validateKey(key);
  validateInput(input);
  const aad = contextBytes(context);
  const metadata = encoder.encode(
    JSON.stringify({
      name: input.name,
      type: input.type,
      length: input.bytes.byteLength,
    } satisfies AttachmentMetadata),
  );
  if (metadata.byteLength > 4096)
    throw new Error("Attachment metadata is too large.");
  const plaintext = concat(u32(metadata.byteLength), metadata, input.bytes);
  const nonce = cryptoApi().getRandomValues(new Uint8Array(NONCE_BYTES));
  const encrypted = new Uint8Array(
    await cryptoApi().subtle.encrypt(
      {
        name: "AES-GCM",
        iv: ownedBuffer(nonce),
        additionalData: ownedBuffer(aad),
        tagLength: 128,
      },
      key,
      ownedBuffer(plaintext),
    ),
  );
  return concat(MAGIC, nonce, encrypted);
}

/** Decrypt and strictly validate a COCCE Office attachment envelope. */
export async function decryptOfficeAttachment(
  key: CryptoKey,
  envelope: Uint8Array,
  context: string,
): Promise<{ name: string; type: string; bytes: Uint8Array }> {
  validateKey(key);
  const aad = contextBytes(context);
  if (
    !(envelope instanceof Uint8Array) ||
    envelope.byteLength < HEADER_BYTES + TAG_BYTES ||
    envelope.byteLength > HEADER_BYTES + MAX_PLAINTEXT_BYTES + 4096 + TAG_BYTES
  )
    throw new Error(
      "The encrypted attachment envelope is truncated or too large.",
    );
  for (let i = 0; i < MAGIC.length; i += 1)
    if (envelope[i] !== MAGIC[i])
      throw new Error("Unsupported encrypted attachment format.");
  const nonce = envelope.subarray(8, HEADER_BYTES);
  const ciphertext = envelope.subarray(HEADER_BYTES);
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await cryptoApi().subtle.decrypt(
        {
          name: "AES-GCM",
          iv: ownedBuffer(nonce),
          additionalData: ownedBuffer(aad),
          tagLength: 128,
        },
        key,
        ownedBuffer(ciphertext),
      ),
    );
  } catch {
    throw new Error(
      "Could not decrypt this attachment. Check the key, context, and file integrity.",
    );
  }
  if (plain.byteLength < 4)
    throw new Error("The encrypted attachment metadata is truncated.");
  const metadataLength = readU32(plain, 0);
  if (
    metadataLength < 2 ||
    metadataLength > 4096 ||
    4 + metadataLength > plain.byteLength
  )
    throw new Error("The encrypted attachment metadata is malformed.");
  let metadata: unknown;
  try {
    metadata = JSON.parse(
      decoder.decode(plain.subarray(4, 4 + metadataLength)),
    );
  } catch {
    throw new Error("The encrypted attachment metadata is malformed.");
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new Error("The encrypted attachment metadata is malformed.");
  const item = metadata as Partial<AttachmentMetadata>;
  const originalLength = item.length;
  if (
    typeof item.name !== "string" ||
    !item.name.trim() ||
    item.name.length > 255 ||
    /[\x00-\x1f\x7f/\\]/.test(item.name) ||
    typeof item.type !== "string" ||
    item.type.length > 255 ||
    /[\x00-\x1f\x7f]/.test(item.type) ||
    typeof originalLength !== "number" ||
    !Number.isSafeInteger(originalLength) ||
    originalLength < 0 ||
    originalLength > MAX_PLAINTEXT_BYTES ||
    4 + metadataLength + originalLength !== plain.byteLength
  )
    throw new Error("The encrypted attachment metadata is invalid.");
  return {
    name: item.name,
    type: item.type,
    bytes: new Uint8Array(plain.subarray(4 + metadataLength)),
  };
}

export const OFFICE_ATTACHMENT_MAX_PLAINTEXT_BYTES = MAX_PLAINTEXT_BYTES;
export const OFFICE_ATTACHMENT_ENVELOPE_VERSION = VERSION;
