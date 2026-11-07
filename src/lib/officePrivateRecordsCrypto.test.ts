import { describe, expect, it } from 'vitest';
import {
  createOfficeRecordsKeyConfig,
  decryptOfficePrivateRecord,
  encryptOfficePrivateRecord,
  unlockOfficeRecordsKeyConfig,
  type OfficeRecordsKeyConfig,
} from './officePrivateRecordsCrypto';

const passphrase = 'correct horse battery staple';
const context = 'COCCE Business:workspace-123:v1';
const record = { legal_name: 'Ada Lovelace', tags: ['finance'], active: true };

async function configured() {
  const created = await createOfficeRecordsKeyConfig(passphrase, context);
  return {
    created,
    config: { configured: true, key_version: 1, derivation: 'PBKDF2-HMAC-SHA-256/AES-256-GCM', iterations: 600_000, ...created.payload } satisfies OfficeRecordsKeyConfig,
  };
}

describe('office private records crypto', () => {
  it('round-trips a record and unlocks the non-extractable key', async () => {
    const { created, config } = await configured();
    expect(created.key.extractable).toBe(false);
    const unlocked = await unlockOfficeRecordsKeyConfig(passphrase, config, context);
    const payload = await encryptOfficePrivateRecord(unlocked, record, context);
    await expect(decryptOfficePrivateRecord<typeof record>(created.key, payload, context)).resolves.toEqual(record);
  });

  it('rejects short passphrases and invalid contexts', async () => {
    await expect(createOfficeRecordsKeyConfig('too-short', context)).rejects.toThrow(/12 and 256/);
    await expect(createOfficeRecordsKeyConfig(passphrase, '')).rejects.toThrow(/context/);
    await expect(createOfficeRecordsKeyConfig(passphrase, '😀'.repeat(51))).rejects.toThrow(/200 UTF-8/);
  });

  it('rejects a wrong passphrase and wrong context', async () => {
    const { config } = await configured();
    await expect(unlockOfficeRecordsKeyConfig('wrong passphrase', config, context)).rejects.toThrow(/did not unlock/);
    await expect(unlockOfficeRecordsKeyConfig(passphrase, config, `${context}:other`)).rejects.toThrow(/did not unlock/);
  });

  it('rejects tampering, malformed base64, and unsupported configuration', async () => {
    const { config, created } = await configured();
    const tampered = { ...config, ciphertext: `${config.ciphertext.slice(0, -2)}AA==` };
    await expect(unlockOfficeRecordsKeyConfig(passphrase, tampered, context)).rejects.toThrow();
    await expect(unlockOfficeRecordsKeyConfig(passphrase, { ...config, salt: `${config.salt}=` }, context)).rejects.toThrow(/base64/);
    await expect(unlockOfficeRecordsKeyConfig(passphrase, { ...config, derivation: 'unsupported' }, context)).rejects.toThrow(/Unsupported/);
    await expect(unlockOfficeRecordsKeyConfig(passphrase, { ...config, iterations: 1 }, context)).rejects.toThrow(/Unsupported/);
    const payload = await encryptOfficePrivateRecord(created.key, record, context);
    await expect(decryptOfficePrivateRecord(created.key, { ...payload, nonce: `${payload.nonce}=` }, context)).rejects.toThrow(/Could not decrypt/);
  });

  it('binds records to context and rejects non-object JSON shapes', async () => {
    const { created } = await configured();
    const payload = await encryptOfficePrivateRecord(created.key, record, context);
    await expect(decryptOfficePrivateRecord(created.key, payload, 'COCCE Business:other:v1')).rejects.toThrow(/Could not decrypt/);
    await expect(encryptOfficePrivateRecord(created.key, [] as unknown as Record<string, unknown>, context)).rejects.toThrow(/plain object/);
    const arrayJson = { toJSON: () => [1, 2, 3] } as unknown as Record<string, unknown>;
    const arrayPayload = await encryptOfficePrivateRecord(created.key, arrayJson, context);
    await expect(decryptOfficePrivateRecord(created.key, arrayPayload, context)).rejects.toThrow(/Could not decrypt/);
  });

  it('rejects records whose encrypted payload exceeds 32768 bytes', async () => {
    const { created } = await configured();
    await expect(encryptOfficePrivateRecord(created.key, { data: 'x'.repeat(32_760) }, context)).rejects.toThrow(/too large/);
  });
});
