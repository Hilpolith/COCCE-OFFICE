import { describe, expect, it } from 'vitest';
import { createOfficeActionIdempotencyKey, parseOfficeAiActionProposal } from './officeAiActionProposal';

describe('COCCE AI approved action proposals', () => {
  it('extracts one bounded create-work-item proposal and removes its JSON block from chat text', () => {
    const result = parseOfficeAiActionProposal('I can prepare this task for your review.\n\n```office-action\n{"type":"create_work_item","title":"Prepare monthly report","reference":"FIN-12","dueDate":"2026-12-01"}\n```');
    expect(result.displayText).toBe('I can prepare this task for your review.');
    expect(result.proposal).toEqual({
      type: 'create_work_item',
      title: 'Prepare monthly report',
      reference: 'FIN-12',
      dueDate: '2026-12-01',
    });
  });

  it('rejects extra fields, unsupported action types, malformed dates and multiple proposals', () => {
    const base = '{"type":"create_work_item","title":"Task","reference":"","dueDate":null}';
    expect(parseOfficeAiActionProposal('```office-action\n' + base.replace(',"dueDate"', ',"assignee":"x","dueDate"') + '\n```').proposal).toBeNull();
    expect(parseOfficeAiActionProposal('```office-action\n' + base.replace('create_work_item', 'delete_workspace') + '\n```').proposal).toBeNull();
    expect(parseOfficeAiActionProposal('```office-action\n' + base.replace('null', '"2026-02-31"') + '\n```').proposal).toBeNull();
    expect(parseOfficeAiActionProposal('```office-action\n' + base + '\n```\n```office-action\n' + base + '\n```').proposal).toBeNull();
  });

  it('creates an RFC 4122 UUID idempotency key for modern and fallback browsers', () => {
    expect(createOfficeActionIdempotencyKey()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('does not parse arbitrary JSON or untrusted text as an action', () => {
    expect(parseOfficeAiActionProposal('{"type":"create_work_item","title":"Task"}').proposal).toBeNull();
    expect(parseOfficeAiActionProposal('```json\n{"type":"create_work_item","title":"Task"}\n```').proposal).toBeNull();
  });
});
