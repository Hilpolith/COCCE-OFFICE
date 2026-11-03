import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import type { DocsTextMatch } from './docsFindReplace';
import {
  findDocsTextMatches, MAX_DOCS_FIND_MATCHES, MAX_DOCS_FIND_QUERY_CHARS,
  MAX_DOCS_FIND_REPLACEMENT_CHARS, MAX_DOCS_FIND_TEXT_CHARS, replaceDocsTextMatches,
} from './docsFindReplace';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    table: { group: 'block', content: 'tableRow+' },
    tableRow: { content: 'tableCell+' },
    tableCell: { content: 'block+' },
    text: { group: 'inline' },
  },
  marks: { strong: {} },
});

function paragraph(...children: ReturnType<typeof schema.text>[]) {
  return schema.node('paragraph', null, children);
}

function documentWith(...blocks: ReturnType<typeof schema.node>[]) {
  return schema.node('doc', null, blocks);
}

describe('bounded local Docs Find & Replace', () => {
  it('searches literal text case-insensitively by default and reports document positions', () => {
    const doc = documentWith(paragraph(schema.text('Plan alpha; '), schema.text('ALPHA', [schema.marks.strong.create()])));
    const matches = findDocsTextMatches(doc, 'alpha');

    expect(matches.map(({ text }) => text)).toEqual(['alpha', 'ALPHA']);
    expect(matches.map(({ from, to }) => doc.textBetween(from, to))).toEqual(['alpha', 'ALPHA']);
    expect(matches[1]?.marks.map((mark) => mark.type.name)).toEqual(['strong']);
    expect(findDocsTextMatches(doc, 'alpha', true).map(({ text }) => text)).toEqual(['alpha']);
  });

  it('treats regex characters literally and never matches across text, formatting, block, or table-cell boundaries', () => {
    const table = schema.node('table', null, [schema.node('tableRow', null, [
      schema.node('tableCell', null, [paragraph(schema.text('cell needle'))]),
      schema.node('tableCell', null, [paragraph(schema.text('next cell'))]),
    ])]);
    const doc = documentWith(
      paragraph(schema.text('[a]. '), schema.text('bet'), schema.text('ter', [schema.marks.strong.create()])),
      paragraph(schema.text('needle')),
      table,
    );

    expect(findDocsTextMatches(doc, '[a].').map(({ text }) => text)).toEqual(['[a].']);
    expect(findDocsTextMatches(doc, 'better')).toEqual([]);
    expect(findDocsTextMatches(doc, 'needle')).toHaveLength(2);
    expect(findDocsTextMatches(doc, 'cell needle')).toHaveLength(1);
  });

  it('rejects blank-external limits and caps query, scanned text, and match count', () => {
    const doc = documentWith(paragraph(schema.text('x')));
    expect(findDocsTextMatches(doc, '')).toEqual([]);
    expect(() => findDocsTextMatches(doc, 'q'.repeat(MAX_DOCS_FIND_QUERY_CHARS + 1))).toThrow('limited to 128 characters');
    expect(() => findDocsTextMatches(documentWith(paragraph(schema.text('x'.repeat(MAX_DOCS_FIND_TEXT_CHARS + 1)))), 'x'))
      .toThrow('limited to 200,000 document text characters');

    const atLimit = documentWith(paragraph(schema.text('x '.repeat(MAX_DOCS_FIND_MATCHES))));
    expect(findDocsTextMatches(atLimit, 'x')).toHaveLength(MAX_DOCS_FIND_MATCHES);
    const overLimit = documentWith(paragraph(schema.text('x '.repeat(MAX_DOCS_FIND_MATCHES + 1))));
    expect(() => findDocsTextMatches(overLimit, 'x')).toThrow('stops at 2,000 matches');
  });

  it('replaces all matches in one transaction, inserts plain text, and preserves each match’s inline marks', () => {
    const doc = documentWith(paragraph(
      schema.text('old', [schema.marks.strong.create()]),
      schema.text(' and old'),
    ));
    const state = EditorState.create({ schema, doc });
    const matches = findDocsTextMatches(doc, 'old', true);
    const result = replaceDocsTextMatches(state.tr, doc, matches, '<b>new</b>');

    expect(result.replacedCount).toBe(2);
    expect(result.unchangedCount).toBe(0);
    expect(result.transaction.steps).toHaveLength(2);
    expect(result.transaction.doc.textContent).toBe('<b>new</b> and <b>new</b>');
    const replacedParagraph = result.transaction.doc.firstChild!;
    expect(replacedParagraph.firstChild?.marks.map((mark) => mark.type.name)).toEqual(['strong']);
    expect(replacedParagraph.lastChild?.marks).toHaveLength(0);
  });

  it('deletes matches as plain text, treats identical replacements as no-ops, and rejects overlong replacement text', () => {
    const doc = documentWith(paragraph(schema.text('remove keep')));
    const state = EditorState.create({ schema, doc });
    const match = findDocsTextMatches(doc, 'remove', true);
    const deleted = replaceDocsTextMatches(state.tr, doc, match, '');
    expect(deleted.transaction.doc.textContent).toBe(' keep');
    expect(deleted.replacedCount).toBe(1);

    const same = findDocsTextMatches(doc, 'keep', true);
    const noOp = replaceDocsTextMatches(state.tr, doc, same, 'keep');
    expect(noOp.replacedCount).toBe(0);
    expect(noOp.unchangedCount).toBe(1);
    expect(noOp.transaction.docChanged).toBe(false);
    expect(() => replaceDocsTextMatches(state.tr, doc, match, 'x'.repeat(MAX_DOCS_FIND_REPLACEMENT_CHARS + 1)))
      .toThrow('limited to 1,000 characters');
  });

  it('validates every range and output size before applying any step', () => {
    const doc = documentWith(paragraph(schema.text('one two')));
    const state = EditorState.create({ schema, doc });
    const matches = findDocsTextMatches(doc, 'one', true);
    const invalid = [...matches, { from: 99, to: 100, text: 'bad', marks: [] }];
    expect(() => replaceDocsTextMatches(state.tr, doc, invalid, 'x')).toThrow('invalid or overlapping');
    expect(state.tr.steps).toHaveLength(0);

    const longDoc = documentWith(paragraph(schema.text(`${'x'.repeat(MAX_DOCS_FIND_TEXT_CHARS - 1)}z`)));
    const longState = EditorState.create({ schema, doc: longDoc });
    const finalCharacter = findDocsTextMatches(longDoc, 'z', true);
    expect(() => replaceDocsTextMatches(longState.tr, longDoc, finalCharacter, 'too long'))
      .toThrow('would exceed the 200,000-character local Docs limit');
    expect(longState.tr.steps).toHaveLength(0);
  });

  it('rejects changed match ranges before mutation', () => {
    const original = documentWith(paragraph(schema.text('before')));
    const stale = findDocsTextMatches(original, 'before', true);
    const changed = documentWith(paragraph(schema.text('after!')));
    const state = EditorState.create({ schema, doc: changed });

    expect(() => replaceDocsTextMatches(state.tr, changed, stale, 'replaced'))
      .toThrow('document changed during replacement');
    expect(state.tr.steps).toHaveLength(0);
  });
});


describe('adversarial replacement range validation', () => {
  it('rejects crafted matches spanning text marks or paragraphs and rejects changed mark sets atomically', () => {
    const formattedDoc = documentWith(paragraph(
      schema.text('ab'),
      schema.text('cd', [schema.marks.strong.create()]),
    ));
    const acrossMarks: DocsTextMatch = { from: 1, to: 5, text: 'abcd', marks: [] };
    expect(formattedDoc.textBetween(acrossMarks.from, acrossMarks.to, '')).toBe('abcd');
    const formattedState = EditorState.create({ schema, doc: formattedDoc });
    expect(() => replaceDocsTextMatches(formattedState.tr, formattedDoc, [acrossMarks], 'flat'))
      .toThrow('one current text run');
    expect(formattedState.tr.steps).toHaveLength(0);

    const paragraphDoc = documentWith(paragraph(schema.text('ab')), paragraph(schema.text('cd')));
    const acrossBlocks: DocsTextMatch = { from: 1, to: 7, text: 'abcd', marks: [] };
    expect(paragraphDoc.textBetween(acrossBlocks.from, acrossBlocks.to, '')).toBe('abcd');
    const paragraphState = EditorState.create({ schema, doc: paragraphDoc });
    expect(() => replaceDocsTextMatches(paragraphState.tr, paragraphDoc, [acrossBlocks], 'flat'))
      .toThrow('one current text run');
    expect(paragraphState.tr.steps).toHaveLength(0);

    const markedDoc = documentWith(paragraph(schema.text('secret', [schema.marks.strong.create()])));
    const originalMatch = findDocsTextMatches(markedDoc, 'secret', true)[0]!;
    const forgedMarks: DocsTextMatch = { ...originalMatch, marks: [] };
    const markedState = EditorState.create({ schema, doc: markedDoc });
    expect(() => replaceDocsTextMatches(markedState.tr, markedDoc, [forgedMarks], 'plain'))
      .toThrow('unchanged inline marks');
    expect(markedState.tr.steps).toHaveLength(0);
  });
});
