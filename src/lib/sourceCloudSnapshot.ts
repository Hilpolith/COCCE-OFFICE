import type { SourceDocumentFormat } from './sourceWorkspaceStore';

export const SOURCE_CLOUD_MAX_BYTES = 5 * 1024 * 1024;
const MAX_SOURCE_CHARS = 1_000_000;

export type SourceCloudSnapshot = {
  version: 1;
  format: SourceDocumentFormat;
  title: string;
  source: string;
};

export function createSourceCloudSnapshot(
  format: SourceDocumentFormat,
  title: string,
  source: string,
): Uint8Array {
  if ((format !== 'html' && format !== 'markdown') || typeof title !== 'string'
    || !title.trim() || title.length > 160 || typeof source !== 'string'
    || source.length > MAX_SOURCE_CHARS) {
    throw new Error('The source draft is invalid or exceeds the cloud-copy limit.');
  }
  const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, format, title: title.trim(), source }));
  if (bytes.byteLength > SOURCE_CLOUD_MAX_BYTES) throw new Error('The source cloud copy exceeds the 5 MiB limit.');
  return bytes;
}

export function parseSourceCloudSnapshot(bytes: Uint8Array, expectedFormat: SourceDocumentFormat): SourceCloudSnapshot {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > SOURCE_CLOUD_MAX_BYTES) {
    throw new Error('The downloaded source cloud copy has an invalid size.');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new Error('The downloaded source cloud copy is not valid UTF-8 JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('The downloaded source cloud copy is invalid.');
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).length !== 4 || value.version !== 1 || value.format !== expectedFormat
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 160
    || typeof value.source !== 'string' || value.source.length > MAX_SOURCE_CHARS) {
    throw new Error('The downloaded source cloud copy failed format or content validation.');
  }
  return { version: 1, format: expectedFormat, title: value.title, source: value.source };
}

export function safeSourceCloudFilename(title: string, format: SourceDocumentFormat): string {
  const base = title.trim().replace(/[^\p{L}\p{N}._ -]+/gu, '').replace(/\s+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  return (base || 'cocce-office-source') + '.' + format + '.cocce-source.bin';
}
