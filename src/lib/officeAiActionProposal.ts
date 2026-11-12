export type OfficeAiActionProposal = {
  type: 'create_work_item';
  title: string;
  reference: string;
  dueDate: string | null;
};

const PROPOSAL_BLOCK = /\`\`\`office-action\s*\n([\s\S]*?)\n\`\`\`/gi;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseOfficeAiActionProposal(content: string): {
  displayText: string;
  proposal: OfficeAiActionProposal | null;
} {
  if (typeof content !== 'string' || content.length > 20_000) return { displayText: content, proposal: null };
  const matches = [...content.matchAll(PROPOSAL_BLOCK)];
  if (matches.length !== 1) return { displayText: content, proposal: null };
  const match = matches[0]!;
  try {
    const value: unknown = JSON.parse(match[1]!);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { displayText: content, proposal: null };
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'dueDate,reference,title,type'
      || row.type !== 'create_work_item'
      || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 140
      || /[\u0000-\u001f\u007f]/.test(row.title)
      || typeof row.reference !== 'string' || row.reference.length > 100
      || /[\u0000-\u001f\u007f]/.test(row.reference)
      || !validDate(row.dueDate)) return { displayText: content, proposal: null };
    const displayText = (content.slice(0, match.index) + content.slice(match.index! + match[0].length)).replace(/\n{3,}/g, '\n\n').trim();
    return {
      displayText,
      proposal: {
        type: 'create_work_item',
        title: row.title.trim(),
        reference: row.reference.trim(),
        dueDate: row.dueDate,
      },
    };
  } catch {
    return { displayText: content, proposal: null };
  }
}
