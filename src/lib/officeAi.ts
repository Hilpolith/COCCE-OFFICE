export const OFFICE_AI_MAX_SELECTION_CHARS = 8_000;
export const OFFICE_AI_MAX_PROMPT_CHARS = 1_200;
export const OFFICE_AI_MAX_DOCUMENT_SUMMARY_CHARS = 20_000;
export const OFFICE_AI_MAX_REQUEST_BYTES = 38_000;
export const OFFICE_AI_MAX_SAVED_WORKFLOWS = 12;
export const OFFICE_AI_WORKFLOWS_STORAGE_KEY = 'cocce-office-ai-workflows-v1';

export const OFFICE_AI_ACTIONS = [
  { id: 'summarize', label: 'Summarize', hint: 'Create a concise summary.' },
  { id: 'proofread', label: 'Proofread', hint: 'Correct spelling, grammar, and punctuation.' },
  { id: 'quality_check', label: 'Quality check', hint: 'Review structure, clarity, consistency, and missing details.' },
  { id: 'clarify', label: 'Improve clarity', hint: 'Make the writing clearer and easier to follow.' },
  { id: 'concise', label: 'Make concise', hint: 'Shorten while preserving important meaning.' },
  { id: 'expand', label: 'Expand', hint: 'Add useful detail without inventing facts.' },
  { id: 'key_points', label: 'Key points', hint: 'Extract the main points.' },
  { id: 'action_items', label: 'Action list', hint: 'Turn the passage into actionable tasks.' },
  { id: 'outline', label: 'Make an outline', hint: 'Organize the passage as a clear outline.' },
  { id: 'email', label: 'Turn into an email', hint: 'Rewrite the passage as a professional email.' },
] as const;

export type OfficeAiAction = typeof OFFICE_AI_ACTIONS[number]['id'] | 'custom' | 'draft';
export type OfficeAiSelectionRequest = {
  action: OfficeAiAction;
  workspaceId: string;
  selectedText?: string;
  prompt?: string;
};
export type OfficeAiDocumentSummaryRequest = { action: 'document_summary'; workspaceId: string; documentText: string };
export type GovernmentReviewAction = 'summarize' | 'proofread' | 'quality_check';
export type GovernmentReviewRequest = {
  action: 'government_review';
  workspaceId: string;
  correspondenceId: string;
  selectedText: string;
  reviewAction: GovernmentReviewAction;
  nonSensitiveConfirmed: true;
};
export type OfficeAiRequest = OfficeAiSelectionRequest | OfficeAiDocumentSummaryRequest | GovernmentReviewRequest;
export type OfficeAiWorkflow = {
  id: string;
  name: string;
  instruction: string;
};

export const OFFICE_AI_DRAFT_TEMPLATES = [
  {
    id: 'email',
    label: 'Email',
    prompt: 'Draft a clear, professional email using only the facts I provide. Use bracketed placeholders for missing names, dates, or details.\n\nDetails:\n',
  },
  {
    id: 'meeting-notes',
    label: 'Meeting notes',
    prompt: 'Draft structured meeting notes with sections for Purpose, Discussion, Decisions, and Action items. Use only the details I provide and use bracketed placeholders for missing information.\n\nNotes and context:\n',
  },
  {
    id: 'project-brief',
    label: 'Project brief',
    prompt: 'Draft a practical project brief with sections for Overview, Goals, Scope, Milestones, Risks, and Success measures. Do not invent facts; use bracketed placeholders for unknowns.\n\nProject details:\n',
  },
  {
    id: 'proposal',
    label: 'Proposal',
    prompt: 'Create a persuasive but factual proposal draft with sections for the problem, recommended approach, benefits, requirements, risks, and next steps. Use bracketed placeholders rather than inventing details.\n\nProposal context:\n',
  },
  {
    id: 'report-outline',
    label: 'Report outline',
    prompt: 'Create a clear report outline with informative headings and a short note on what belongs in each section. Use only the information I provide and mark unknowns as placeholders.\n\nReport topic and context:\n',
  },
] as const;

export class OfficeAiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OfficeAiError';
    this.code = code;
  }
}

export function extractOfficeAiSelection(
  doc: { textBetween: (from: number, to: number, blockSeparator?: string) => string },
  from: number,
  to: number,
): string {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return '';
  return doc.textBetween(from, to, '\n');
}

export function extractOfficeAiDocumentText(doc: {
  content: { size: number };
  textBetween: (from: number, to: number, blockSeparator?: string) => string;
}): string {
  if (!Number.isInteger(doc.content.size) || doc.content.size < 0) return '';
  return doc.textBetween(0, doc.content.size, '\n');
}

export function buildOfficeAiDocumentSummaryRequest(documentText: string, workspaceId = '*'): OfficeAiDocumentSummaryRequest {
  if (typeof workspaceId !== 'string' || (workspaceId !== '*' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId))) throw new OfficeAiError('WORKSPACE_REQUIRED', 'Choose an Office workspace with COCCE AI enabled.');
  if (!documentText.trim()) throw new OfficeAiError('DOCUMENT_TEXT_REQUIRED', 'This document has no text to summarize.');
  if (documentText.length > OFFICE_AI_MAX_DOCUMENT_SUMMARY_CHARS) {
    throw new OfficeAiError('DOCUMENT_TOO_LARGE', `Full-document summaries are limited to ${OFFICE_AI_MAX_DOCUMENT_SUMMARY_CHARS.toLocaleString()} characters and ${Math.round(OFFICE_AI_MAX_REQUEST_BYTES / 1_000)} KB per request. Use a shorter document or summarize selected text instead; no text has been sent.`);
  }
  const payload: OfficeAiDocumentSummaryRequest = { action: 'document_summary', workspaceId, documentText };
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > OFFICE_AI_MAX_REQUEST_BYTES) {
    throw new OfficeAiError('DOCUMENT_TOO_LARGE', `This document exceeds the ${Math.round(OFFICE_AI_MAX_REQUEST_BYTES / 1_000)} KB request limit. Use a shorter document or summarize selected text instead; no text has been sent.`);
  }
  return payload;
}

export function buildOfficeAiRequest(action: OfficeAiAction, selectedText: string, prompt: string, workspaceId = '*'): OfficeAiRequest {
  if (typeof workspaceId !== 'string' || (workspaceId !== '*' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspaceId))) throw new OfficeAiError('WORKSPACE_REQUIRED', 'Choose an Office workspace with COCCE AI enabled.');
  const cleanPrompt = prompt.trim();
  if (cleanPrompt.length > OFFICE_AI_MAX_PROMPT_CHARS) {
    throw new OfficeAiError('PROMPT_TOO_LONG', `Instructions must be ${OFFICE_AI_MAX_PROMPT_CHARS.toLocaleString()} characters or fewer.`);
  }

  if (action === 'draft') {
    if (selectedText.trim()) throw new OfficeAiError('DRAFT_MUST_NOT_INCLUDE_SELECTION', 'Draft from a brief never includes selected document text.');
    if (!cleanPrompt) throw new OfficeAiError('PROMPT_REQUIRED', 'Describe what you want drafted first.');
    if (cleanPrompt.length > OFFICE_AI_MAX_PROMPT_CHARS) {
      throw new OfficeAiError('PROMPT_TOO_LONG', `Instructions must be ${OFFICE_AI_MAX_PROMPT_CHARS.toLocaleString()} characters or fewer.`);
    }
    return { action, workspaceId, prompt: cleanPrompt };
  }

  if (!selectedText.trim()) throw new OfficeAiError('SELECTION_REQUIRED', 'Select some text in the document first.');
  if (selectedText.length > OFFICE_AI_MAX_SELECTION_CHARS) {
    throw new OfficeAiError('SELECTION_TOO_LONG', `Select no more than ${OFFICE_AI_MAX_SELECTION_CHARS.toLocaleString()} characters at a time.`);
  }
  if (action === 'custom' && !cleanPrompt) {
    throw new OfficeAiError('PROMPT_REQUIRED', 'Add instructions for this workflow first.');
  }
  if (action === 'custom' && cleanPrompt.length > OFFICE_AI_MAX_PROMPT_CHARS) {
    throw new OfficeAiError('PROMPT_TOO_LONG', `Instructions must be ${OFFICE_AI_MAX_PROMPT_CHARS.toLocaleString()} characters or fewer.`);
  }

  return action === 'custom' ? { action, workspaceId, selectedText, prompt: cleanPrompt } : { action, workspaceId, selectedText };
}

export function buildGovernmentReviewRequest(workspaceId: string, correspondenceId: string, selectedText: string, reviewAction: GovernmentReviewAction): GovernmentReviewRequest {
  if (!workspaceId.trim() || !correspondenceId.trim()) throw new OfficeAiError('GOVERNMENT_CONTEXT_REQUIRED', 'Government review requires a workspace and correspondence context.');
  if (!['summarize', 'proofread', 'quality_check'].includes(reviewAction)) throw new OfficeAiError('GOVERNMENT_ACTION_INVALID', 'That Government review action is not available.');
  if (!selectedText.trim()) throw new OfficeAiError('SELECTION_REQUIRED', 'Select some text in the document first.');
  if (selectedText.length > OFFICE_AI_MAX_SELECTION_CHARS) throw new OfficeAiError('SELECTION_TOO_LONG', `Select no more than ${OFFICE_AI_MAX_SELECTION_CHARS.toLocaleString()} characters at a time.`);
  return { action: 'government_review', workspaceId, correspondenceId, selectedText, reviewAction, nonSensitiveConfirmed: true };
}

function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export async function checkOfficeAiStatus(accessToken: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  const response = await fetcher('/api/office-ai', {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  });
  const data = asRecord(await readJson(response));
  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : 'AI_STATUS_UNAVAILABLE';
    throw new OfficeAiError(code, typeof data?.message === 'string' ? data.message : 'Could not check cloud AI availability.');
  }
  if (typeof data?.configured !== 'boolean') throw new OfficeAiError('AI_STATUS_INVALID', 'The cloud AI service returned an invalid status.');
  return data.configured;
}

export async function requestOfficeAi(accessToken: string, payload: OfficeAiRequest, fetcher: typeof fetch = fetch): Promise<string> {
  const body = JSON.stringify(payload);
  if (new TextEncoder().encode(body).byteLength > OFFICE_AI_MAX_REQUEST_BYTES) {
    const isDocumentSummary = payload.action === 'document_summary';
    throw new OfficeAiError(
      isDocumentSummary ? 'DOCUMENT_TOO_LARGE' : 'REQUEST_TOO_LARGE',
      isDocumentSummary
        ? `This document exceeds the ${Math.round(OFFICE_AI_MAX_REQUEST_BYTES / 1_000)} KB request limit. Use a shorter document or summarize selected text instead; no text has been sent.`
        : `This AI request exceeds the ${Math.round(OFFICE_AI_MAX_REQUEST_BYTES / 1_000)} KB limit. Select a shorter excerpt; no text has been sent.`,
    );
  }
  const response = await fetcher('/api/office-ai', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body,
    cache: 'no-store',
  });
  const data = asRecord(await readJson(response));
  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : 'AI_REQUEST_FAILED';
    const message = typeof data?.message === 'string' ? data.message : 'The writing assistant could not complete that request.';
    throw new OfficeAiError(code, message);
  }
  if (typeof data?.text !== 'string' || !data.text.trim()) {
    throw new OfficeAiError('AI_RESPONSE_INVALID', 'The writing assistant returned no usable text.');
  }
  return data.text;
}

function normalizeWorkflow(value: unknown): OfficeAiWorkflow | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id)) return null;
  if (typeof item.name !== 'string' || typeof item.instruction !== 'string') return null;
  const name = item.name.trim();
  const instruction = item.instruction.trim();
  if (!name || name.length > 60 || !instruction || instruction.length > OFFICE_AI_MAX_PROMPT_CHARS) return null;
  return { id: item.id, name, instruction };
}

export function parseOfficeAiWorkflows(raw: string | null): OfficeAiWorkflow[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const workflows: OfficeAiWorkflow[] = [];
    const seenIds = new Set<string>();
    for (const item of parsed) {
      const workflow = normalizeWorkflow(item);
      if (!workflow || seenIds.has(workflow.id)) continue;
      seenIds.add(workflow.id);
      workflows.push(workflow);
      if (workflows.length >= OFFICE_AI_MAX_SAVED_WORKFLOWS) break;
    }
    return workflows;
  } catch {
    return [];
  }
}

export function loadOfficeAiWorkflows(storage: Pick<Storage, 'getItem'>): OfficeAiWorkflow[] {
  try {
    return parseOfficeAiWorkflows(storage.getItem(OFFICE_AI_WORKFLOWS_STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveOfficeAiWorkflows(storage: Pick<Storage, 'setItem'>, workflows: OfficeAiWorkflow[]): boolean {
  try {
    const valid = parseOfficeAiWorkflows(JSON.stringify(workflows)).slice(0, OFFICE_AI_MAX_SAVED_WORKFLOWS);
    storage.setItem(OFFICE_AI_WORKFLOWS_STORAGE_KEY, JSON.stringify(valid));
    return true;
  } catch {
    return false;
  }
}
