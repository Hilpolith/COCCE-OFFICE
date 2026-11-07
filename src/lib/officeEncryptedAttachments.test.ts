import { describe, expect, it } from 'vitest';
import { decryptOfficeAttachment, encryptOfficeAttachment } from './officeEncryptedAttachments';

async function key() { return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); }
const context = 'COCCE Manufacturing:11111111-1111-4111-8111-111111111111:v1:evidence:E-1';

describe('office encrypted attachments', () => {
  it('round trips binary data and encrypted metadata', async () => {
    const value = { name: 'private evidence.pdf', type: 'application/pdf', bytes: new Uint8Array([0, 1, 255, 9]) };
    const envelope = await encryptOfficeAttachment(await key(), value, context);
    expect(new TextDecoder().decode(envelope)).not.toContain(value.name);
    await expect(decryptOfficeAttachment(await key(), envelope, context)).rejects.toThrow();
    const k = await key(); const own = await encryptOfficeAttachment(k, value, context);
    await expect(decryptOfficeAttachment(k, own, context)).resolves.toEqual(value);
  });
  it('rejects tamper, wrong context, truncation, and malformed metadata', async () => {
    const k = await key(); const envelope = await encryptOfficeAttachment(k, { name: 'a.bin', type: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) }, context);
    const tampered = envelope.slice(); tampered[tampered.length - 1] ^= 1;
    await expect(decryptOfficeAttachment(k, tampered, context)).rejects.toThrow();
    await expect(decryptOfficeAttachment(k, envelope, `${context}:wrong`)).rejects.toThrow();
    await expect(decryptOfficeAttachment(k, envelope.subarray(0, envelope.length - 2), context)).rejects.toThrow();
    const malformed = envelope.slice(); malformed[0] = 0;
    await expect(decryptOfficeAttachment(k, malformed, context)).rejects.toThrow();
  });
  it('rejects invalid input and plaintext over 20 MiB', async () => {
    const k = await key();
    await expect(encryptOfficeAttachment(k, { name: '../secret', type: 'text/plain', bytes: new Uint8Array() }, context)).rejects.toThrow();
    await expect(encryptOfficeAttachment(k, { name: 'large.bin', type: 'application/octet-stream', bytes: new Uint8Array(20 * 1024 * 1024 + 1) }, context)).rejects.toThrow(/20 MiB/);
  });

  it('binds ciphertext to the exact context and rejects malformed key material', async () => {
    const k = await key();
    const envelope = await encryptOfficeAttachment(k, { name: 'context.bin', type: 'application/octet-stream', bytes: new Uint8Array([4, 5, 6]) }, context);
    await expect(decryptOfficeAttachment(k, envelope, `${context}:different-workspace`)).rejects.toThrow();
    const wrongAlgorithm = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, false, ['encrypt', 'decrypt']);
    await expect(encryptOfficeAttachment(wrongAlgorithm, { name: 'x.bin', type: 'application/octet-stream', bytes: new Uint8Array([1]) }, context)).rejects.toThrow(/AES-256/);
  });

  it('rejects overflowed and truncated envelope lengths before returning plaintext', async () => {
    const k = await key();
    const envelope = await encryptOfficeAttachment(k, { name: 'bounded.bin', type: 'application/octet-stream', bytes: new Uint8Array([1, 2, 3]) }, context);
    const oversized = new Uint8Array(8 + 12 + 16 + 20 * 1024 * 1024 + 4097);
    oversized.set(envelope.subarray(0, 8 + 12));
    await expect(decryptOfficeAttachment(k, oversized, context)).rejects.toThrow(/truncated or too large/);
    await expect(decryptOfficeAttachment(k, envelope.subarray(0, 8 + 12 + 15), context)).rejects.toThrow(/truncated or too large/);
  });

  it('rejects invalid filenames, MIME control bytes, contexts, and non-Uint8Array input', async () => {
    const k = await key();
    await expect(encryptOfficeAttachment(k, { name: 'bad\\name', type: 'application/pdf', bytes: new Uint8Array() }, context)).rejects.toThrow(/filename/);
    await expect(encryptOfficeAttachment(k, { name: 'ok.pdf', type: 'application/\u0000pdf', bytes: new Uint8Array() }, context)).rejects.toThrow(/MIME/);
    await expect(encryptOfficeAttachment(k, { name: 'ok.pdf', type: 'application/pdf', bytes: new Uint8Array() }, '')).rejects.toThrow(/context/);
    await expect(encryptOfficeAttachment(k, { name: 'ok.pdf', type: 'application/pdf', bytes: [] as unknown as Uint8Array }, context)).rejects.toThrow();
  });
});
