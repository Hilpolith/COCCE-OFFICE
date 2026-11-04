// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
  DOCS_CLOUD_MAX_BYTES,
  createDocsCloudSnapshot,
  parseDocsCloudSnapshot,
  safeDocsCloudFilename,
} from './docsCloudSnapshot';

const document = (
  overrides: Partial<{ title: string; content: string; richText: string }> = {},
) => ({
  title: 'Résumé 日本語',
  content: 'Legacy text',
  richText: '<h1>Résumé 日本語</h1><p>Keep <strong>format</strong>.</p>',
  ...overrides,
});

const parseJson = (bytes: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
const bytesFor = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value));

function expectRefused(action: () => unknown, text?: string) {
  expect(action).toThrow(/Docs cloud snapshot refused/);
  if (text) expect(action).toThrow(text);
}

describe('Docs cloud snapshots', () => {
  it('round-trips Unicode, content, format, and supported markup', () => {
    const parsed = parseDocsCloudSnapshot(
      createDocsCloudSnapshot(document(), 0),
    );
    expect(parsed).toEqual({
      title: 'Résumé 日本語',
      content: 'Résumé 日本語\nKeep format.',
      richText: '<h1>Résumé 日本語</h1><p>Keep <strong>format</strong>.</p>',
    });
  });

  it('uses the legacy plain-text fallback when richText is absent or empty', () => {
    for (const richText of [undefined, '']) {
      const parsed = parseDocsCloudSnapshot(
        createDocsCloudSnapshot(
          { title: 'Legacy', content: 'A < B\nnext', richText },
          0,
        ),
      );
      expect(parsed.richText).toBe('<p>A &lt; B</p><p>next</p>');
      expect(parsed.content).toBe('A < B\nnext');
    }
  });

  it('preserves supported simple tables and refuses lossy tables', () => {
    const good = parseDocsCloudSnapshot(
      createDocsCloudSnapshot(
        {
          title: 'Table',
          content: '',
          richText:
            '<table><tr><th><p>Name</p></th><th><p>Value</p></th></tr><tr><td><p>A</p></td><td><p>1</p></td></tr></table>',
        },
        0,
      ),
    );
    expect(good.richText).toContain('<table>');
    expect(good.content).toBe('Name\tValue\nA\t1');
    expectRefused(
      () =>
        createDocsCloudSnapshot(
          {
            title: 'Table',
            content: '',
            richText:
              '<table><tr><td rowspan="2">A</td></tr><tr><td>B</td></tr></table>',
          },
          0,
        ),
      'lossy table',
    );
  });

  it('refuses any nonzero or invalid review comment count', () => {
    for (const count of [1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expectRefused(
        () => createDocsCloudSnapshot(document(), count),
        'review comments',
      );
    }
  });

  it('emits only the exact copy envelope with no local metadata', () => {
    const envelope = parseJson(createDocsCloudSnapshot(document(), 0));
    expect(envelope).toEqual({
      format: 'cocce-office-docs-copy',
      version: 1,
      title: 'Résumé 日本語',
      html: document().richText,
    });
    expect(JSON.stringify(envelope)).not.toMatch(
      /id|workspace|timestamp|created|updated|auth|history|ai/i,
    );
  });

  it('refuses malformed JSON, fatal UTF-8, unknown versions, and unknown keys', () => {
    expectRefused(() => parseDocsCloudSnapshot(new TextEncoder().encode('{')));
    expectRefused(
      () => parseDocsCloudSnapshot(new Uint8Array([0xff, 0xfe])),
      'UTF-8',
    );
    expectRefused(
      () =>
        parseDocsCloudSnapshot(
          bytesFor({
            format: 'cocce-office-docs-copy',
            version: 2,
            title: 'x',
            html: '',
          }),
        ),
      'version',
    );
    expectRefused(
      () =>
        parseDocsCloudSnapshot(
          bytesFor({
            format: 'cocce-office-docs-copy',
            version: 1,
            title: 'x',
            html: '',
            extra: true,
          }),
        ),
      'unknown',
    );
  });

  it('refuses XSS and other lossy source markup rather than persisting it', () => {
    expectRefused(
      () =>
        parseDocsCloudSnapshot(
          bytesFor({
            format: 'cocce-office-docs-copy',
            version: 1,
            title: 'x',
            html: '<p onclick="bad()">x</p>',
          }),
        ),
      'dangerous',
    );
    expectRefused(
      () =>
        parseDocsCloudSnapshot(
          bytesFor({
            format: 'cocce-office-docs-copy',
            version: 1,
            title: 'x',
            html: '<script>alert(1)</script>',
          }),
        ),
      'dangerous',
    );
    for (const richText of [
      '<p onclick="bad()">x</p>',
      '<script>bad()</script>',
      '<h4>x</h4>',
      '<p>x</p><!-- private review metadata -->',
      '<p class="unknown">x</p>',
    ]) {
      expectRefused(
        () => createDocsCloudSnapshot(document({ richText }), 0),
        'dangerous or lossy',
      );
    }
  });

  it('enforces title, markup, block, and total envelope limits without truncating', () => {
    expectRefused(
      () =>
        createDocsCloudSnapshot(
          { title: 'x'.repeat(201), content: '', richText: '' },
          0,
        ),
      'title',
    );
    expectRefused(
      () =>
        createDocsCloudSnapshot(
          {
            title: 'x',
            content: '',
            richText: `<p>${'<strong>'.repeat(300_000)}x${'</strong>'.repeat(300_000)}</p>`,
          },
          0,
        ),
      'markup',
    );
    expectRefused(
      () =>
        createDocsCloudSnapshot(
          { title: 'x', content: '', richText: '<p>x</p>'.repeat(10_001) },
          0,
        ),
      'block',
    );
    const oversized = new Uint8Array(DOCS_CLOUD_MAX_BYTES + 1);
    expectRefused(() => parseDocsCloudSnapshot(oversized), '3 MiB');
  });

  it('makes a server-safe filename with the required suffix', () => {
    const filename = safeDocsCloudFilename('  bad/name\\with\u0000controls  ');
    expect(filename).toBe('bad-name-with-controls.cocce-docs.json');
    expect(filename.endsWith('.cocce-docs.json')).toBe(true);
    expect(filename.length).toBeLessThanOrEqual(255);
    expect(safeDocsCloudFilename('a'.repeat(500))).toHaveLength(255);
    for (const title of ['\u{1f4c4}'.repeat(200), 'bad\ud800title']) {
      const safe = safeDocsCloudFilename(title);
      expect(safe.length).toBeLessThanOrEqual(255);
      expect(safe.endsWith('.cocce-docs.json')).toBe(true);
      expect(() => encodeURIComponent(safe)).not.toThrow();
    }
  });
});
