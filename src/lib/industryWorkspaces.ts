export type IndustryId =
  | 'government'
  | 'school'
  | 'university'
  | 'business'
  | 'accounting'
  | 'manufacturing'
  | 'healthcare-admin'
  | 'ngo'
  | 'hospitality'
  | 'church';

export interface IndustryDefinition {
  id: IndustryId;
  label: string;
  shortLabel: string;
  summary: string;
  workArea: string;
  itemLabel: string;
  referenceLabel: string;
  stages: readonly string[];
  dataNote: string;
}

export const industryCatalog: readonly IndustryDefinition[] = [
  {
    id: 'government', label: 'Government & public administration', shortLabel: 'Government',
    summary: 'Route everyday office work through a simple register.', workArea: 'Administrative correspondence',
    itemLabel: 'Correspondence or service item', referenceLabel: 'Local reference',
    stages: ['Received', 'Assigned', 'In progress', 'Ready for review', 'Closed'],
    dataNote: 'Not an approved government records system or official reference-number service.',
  },
  {
    id: 'school', label: 'Schools', shortLabel: 'Schools',
    summary: 'Track school administration and follow-ups.', workArea: 'School administration',
    itemLabel: 'Administration task', referenceLabel: 'Local reference',
    stages: ['To triage', 'Assigned', 'In progress', 'Review requested', 'Closed'],
    dataNote: 'Do not enter student, guardian, grade, health, or safeguarding details.',
  },
  {
    id: 'university', label: 'Universities', shortLabel: 'Universities',
    summary: 'Keep academic administration moving from intake to close.', workArea: 'Academic administration',
    itemLabel: 'Academic work item', referenceLabel: 'Local reference',
    stages: ['To triage', 'Assigned', 'In progress', 'Review requested', 'Closed'],
    dataNote: 'Do not enter student, applicant, transcript, or research-participant details.',
  },
  {
    id: 'business', label: 'Companies & business', shortLabel: 'Business',
    summary: 'Track operational requests, opportunities, and project follow-ups.', workArea: 'Business operations',
    itemLabel: 'Business work item', referenceLabel: 'Local reference',
    stages: ['New', 'Qualified', 'In progress', 'Review requested', 'Closed'],
    dataNote: 'Do not enter customer payment details or confidential client records.',
  },
  {
    id: 'accounting', label: 'Accounting firms', shortLabel: 'Accounting',
    summary: 'Review client books, post balanced journals and reconcile statements in a linked team.', workArea: 'Accounting work queue',
    itemLabel: 'Accounting work item', referenceLabel: 'Local file reference',
    stages: ['Requested', 'Preparing', 'Review requested', 'Ready to return', 'Closed'],
    dataNote: 'The device-local preview is not a ledger. Use the linked team for reviewed journals; keep personal identities out of public labels. No tax filing integration.',
  },
  {
    id: 'manufacturing', label: 'Manufacturing & factories', shortLabel: 'Manufacturing',
    summary: 'Manage stock, bills of materials, production batches, quality and equipment in a linked team.', workArea: 'Production work queue',
    itemLabel: 'Production work item', referenceLabel: 'Local work-order reference',
    stages: ['Planned', 'In progress', 'Quality check', 'Ready for dispatch', 'Closed'],
    dataNote: 'The device-local preview does not reserve stock. Linked team controls support operations and evidence, not official safety certification or fiscal integration.',
  },
  {
    id: 'healthcare-admin', label: 'Healthcare administration', shortLabel: 'Health admin',
    summary: 'Coordinate non-clinical operational requests.', workArea: 'Administrative requests only',
    itemLabel: 'Administrative request', referenceLabel: 'Local reference',
    stages: ['Received', 'Assigned', 'In progress', 'Ready for review', 'Closed'],
    dataNote: 'Administrative only: no patient names, diagnoses, clinical records, or prescriptions.',
  },
  {
    id: 'ngo', label: 'NGOs & projects', shortLabel: 'NGO',
    summary: 'Track grant and field-activity follow-ups at a high level.', workArea: 'Project administration',
    itemLabel: 'Project work item', referenceLabel: 'Local grant or project reference',
    stages: ['Planned', 'Active', 'Evidence review', 'Ready to report', 'Closed'],
    dataNote: 'Do not enter beneficiary identities, case records, or restricted grant data.',
  },
  {
    id: 'hospitality', label: 'Hotels & hospitality', shortLabel: 'Hospitality',
    summary: 'Coordinate housekeeping and service operations without guest records.', workArea: 'Hotel operations',
    itemLabel: 'Operations task', referenceLabel: 'Local reference',
    stages: ['Requested', 'Assigned', 'In progress', 'Ready', 'Closed'],
    dataNote: 'Do not enter guest identities, payment data, or live reservation details.',
  },
  {
    id: 'church', label: 'Churches & institutions', shortLabel: 'Institutions',
    summary: 'Coordinate events, departments, and institution operations.', workArea: 'Institution administration',
    itemLabel: 'Institution work item', referenceLabel: 'Local reference',
    stages: ['Planned', 'Assigned', 'In progress', 'Review requested', 'Closed'],
    dataNote: 'Do not enter private member, donor, pastoral, or safeguarding details.',
  },
] as const;

export const INDUSTRY_STORAGE_KEY = 'cocce-office-industry-workspaces-v1';
export const MAX_INDUSTRY_OFFICES = 24;
export const MAX_INDUSTRY_ITEMS_PER_OFFICE = 500;
export const MAX_INDUSTRY_ITEMS_TOTAL = 5000;
export const MAX_INDUSTRY_NOTES = 2000;
const MAX_HISTORY_PER_ITEM = 100;

type IndustryStorage = Pick<Storage, 'getItem' | 'setItem'>;

export interface IndustryWorkEvent {
  at: string;
  from: string | null;
  to: string;
}

export interface IndustryWorkItem {
  id: string;
  title: string;
  reference: string;
  owner: string;
  dueDate: string | null;
  notes: string;
  stage: string;
  createdAt: string;
  updatedAt: string;
  history: IndustryWorkEvent[];
}

export interface IndustryOffice {
  id: string;
  industryId: IndustryId;
  name: string;
  country: string;
  teamWorkspaceId: string | null;
  createdAt: string;
  updatedAt: string;
  items: IndustryWorkItem[];
}

export interface IndustryState {
  version: 1;
  offices: IndustryOffice[];
}

export interface IndustryReadResult {
  state: IndustryState;
  issue: string | null;
}

export interface IndustryTeamSetup {
  officeId: string;
  officeName: string;
  industryId: IndustryId;
  teamWorkspaceId?: string | null;
}

export const emptyIndustryState = (): IndustryState => ({ version: 1, offices: [] });
export const getIndustryDefinition = (id: IndustryId) => industryCatalog.find((industry) => industry.id === id)!;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number, allowEmpty = true): value is string {
  return typeof value === 'string' && value.length <= max && (allowEmpty || value.trim().length > 0);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && value.length <= 40;
}

function isDateOnly(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isIndustryId(value: unknown): value is IndustryId {
  return typeof value === 'string' && industryCatalog.some((industry) => industry.id === value);
}

function isValidEvent(value: unknown): value is IndustryWorkEvent {
  if (!isRecord(value)) return false;
  return isTimestamp(value.at)
    && (value.from === null || isText(value.from, 80, false))
    && isText(value.to, 80, false);
}

function isValidItem(value: unknown, industryId: IndustryId): value is IndustryWorkItem {
  if (!isRecord(value)) return false;
  const stages = getIndustryDefinition(industryId).stages;
  return isText(value.id, 128, false)
    && isText(value.title, 140, false)
    && isText(value.reference, 100)
    && isText(value.owner, 100)
    && isDateOnly(value.dueDate)
    && isText(value.notes, MAX_INDUSTRY_NOTES)
    && typeof value.stage === 'string' && stages.includes(value.stage)
    && isTimestamp(value.createdAt)
    && isTimestamp(value.updatedAt)
    && Array.isArray(value.history) && value.history.length <= MAX_HISTORY_PER_ITEM
    && value.history.every((event) => isValidEvent(event)
      && stages.includes(event.to)
      && (event.from === null || stages.includes(event.from)));
}

function isValidOffice(value: unknown): value is IndustryOffice {
  if (!isRecord(value)) return false;
  const industryId = value.industryId;
  if (!isIndustryId(industryId)) return false;
  if (!isText(value.id, 128, false) || !isText(value.name, 100, false) || !isText(value.country, 48)) return false;
  if (value.teamWorkspaceId !== null && !isText(value.teamWorkspaceId, 128, false)) return false;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return false;
  if (!Array.isArray(value.items) || value.items.length > MAX_INDUSTRY_ITEMS_PER_OFFICE) return false;
  if (!value.items.every((item) => isValidItem(item, industryId))) return false;
  const ids = value.items.map((item) => (item as IndustryWorkItem).id);
  return new Set(ids).size === ids.length;
}

function isValidState(value: unknown): value is IndustryState {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.offices) || value.offices.length > MAX_INDUSTRY_OFFICES) return false;
  if (!value.offices.every(isValidOffice)) return false;
  const offices = value.offices as IndustryOffice[];
  const officeIds = offices.map((office) => office.id);
  const totalItems = offices.reduce((total, office) => total + office.items.length, 0);
  return new Set(officeIds).size === officeIds.length && totalItems <= MAX_INDUSTRY_ITEMS_TOTAL;
}

export function readIndustryState(storage: IndustryStorage): IndustryReadResult {
  let raw: string | null;
  try {
    raw = storage.getItem(INDUSTRY_STORAGE_KEY);
  } catch {
    return { state: emptyIndustryState(), issue: 'Browser storage could not be read. Existing industry data has not been changed.' };
  }
  if (raw === null) return { state: emptyIndustryState(), issue: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: emptyIndustryState(), issue: 'Industry data is unreadable. Existing bytes were preserved; reset nothing and do not add data here.' };
  }
  if (!isValidState(parsed)) {
    return { state: emptyIndustryState(), issue: 'Industry data is unreadable or from a newer version. Existing bytes were preserved; reset nothing and do not add data here.' };
  }
  return { state: parsed, issue: null };
}

export function writeIndustryState(storage: IndustryStorage, state: IndustryState): void {
  let current: string | null;
  try {
    current = storage.getItem(INDUSTRY_STORAGE_KEY);
  } catch {
    throw new Error('Industry data could not be read from this browser; existing data was kept.');
  }
  if (current !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(current); } catch { throw new Error('Existing industry data is unreadable; it was kept and not overwritten.'); }
    if (!isValidState(parsed)) throw new Error('Existing industry data uses an unsupported format; it was kept and not overwritten.');
  }
  if (!isValidState(state)) throw new Error('Industry changes did not pass local validation; nothing was saved.');
  try {
    storage.setItem(INDUSTRY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    throw new Error('Industry data could not be saved in this browser. The last saved copy was kept.');
  }
}

let generatedId = 0;
function newId(prefix: string) {
  try { return `${prefix}_${globalThis.crypto.randomUUID()}`; }
  catch { generatedId += 1; return `${prefix}_${Date.now()}_${generatedId}`; }
}

export function createIndustryOffice(
  state: IndustryState,
  input: { industryId: IndustryId; name: string; country: string },
  now = new Date(),
): { state: IndustryState; office: IndustryOffice | null } {
  const name = input.name.trim();
  const country = input.country.trim();
  if (state.offices.length >= MAX_INDUSTRY_OFFICES || !isIndustryId(input.industryId) || !name || name.length > 100 || country.length > 48) {
    return { state, office: null };
  }
  const timestamp = now.toISOString();
  const office: IndustryOffice = {
    id: newId('industry'), industryId: input.industryId, name, country,
    teamWorkspaceId: null, createdAt: timestamp, updatedAt: timestamp, items: [],
  };
  return { state: { ...state, offices: [...state.offices, office] }, office };
}

export function addIndustryWorkItem(
  state: IndustryState,
  officeId: string,
  input: { title: string; reference?: string; owner?: string; dueDate?: string | null; notes?: string },
  now = new Date(),
): { state: IndustryState; item: IndustryWorkItem | null } {
  const office = state.offices.find((candidate) => candidate.id === officeId);
  const title = input.title.trim();
  const reference = input.reference?.trim() ?? '';
  const owner = input.owner?.trim() ?? '';
  const dueDate = input.dueDate || null;
  const notes = input.notes?.trim() ?? '';
  const currentTotal = state.offices.reduce((total, candidate) => total + candidate.items.length, 0);
  if (!office || !title || title.length > 140 || reference.length > 100 || owner.length > 100 || notes.length > MAX_INDUSTRY_NOTES
    || !isDateOnly(dueDate) || office.items.length >= MAX_INDUSTRY_ITEMS_PER_OFFICE || currentTotal >= MAX_INDUSTRY_ITEMS_TOTAL) {
    return { state, item: null };
  }
  const timestamp = now.toISOString();
  const stage = getIndustryDefinition(office.industryId).stages[0];
  const item: IndustryWorkItem = {
    id: newId('work'), title, reference, owner, dueDate, notes, stage,
    createdAt: timestamp, updatedAt: timestamp,
    history: [{ at: timestamp, from: null, to: stage }],
  };
  return {
    state: {
      ...state,
      offices: state.offices.map((candidate) => candidate.id === officeId
        ? { ...candidate, updatedAt: timestamp, items: [item, ...candidate.items] }
        : candidate),
    },
    item,
  };
}

function changeItemStage(state: IndustryState, officeId: string, itemId: string, direction: -1 | 1, now: Date): IndustryState {
  let changed = false;
  const timestamp = now.toISOString();
  const offices = state.offices.map((office) => {
    if (office.id !== officeId) return office;
    const stages = getIndustryDefinition(office.industryId).stages;
    const items = office.items.map((item) => {
      if (item.id !== itemId) return item;
      const currentIndex = stages.indexOf(item.stage);
      const nextStage = stages[Math.max(0, Math.min(stages.length - 1, currentIndex + direction))];
      if (nextStage === item.stage) return item;
      changed = true;
      return {
        ...item,
        stage: nextStage,
        updatedAt: timestamp,
        history: [...item.history, { at: timestamp, from: item.stage, to: nextStage }].slice(-MAX_HISTORY_PER_ITEM),
      };
    });
    return changed ? { ...office, updatedAt: timestamp, items } : office;
  });
  return changed ? { ...state, offices } : state;
}

export function advanceIndustryWorkItem(state: IndustryState, officeId: string, itemId: string, now = new Date()): IndustryState {
  return changeItemStage(state, officeId, itemId, 1, now);
}

export function returnIndustryWorkItem(state: IndustryState, officeId: string, itemId: string, now = new Date()): IndustryState {
  return changeItemStage(state, officeId, itemId, -1, now);
}

export function linkIndustryTeam(state: IndustryState, officeId: string, teamWorkspaceId: string, now = new Date()): IndustryState {
  const normalizedWorkspaceId = teamWorkspaceId.trim();
  if (!normalizedWorkspaceId || normalizedWorkspaceId.length > 128) return state;
  let linked = false;
  const timestamp = now.toISOString();
  const offices = state.offices.map((office) => {
    if (office.id !== officeId) return office;
    linked = true;
    return { ...office, teamWorkspaceId: normalizedWorkspaceId, updatedAt: timestamp };
  });
  return linked ? { ...state, offices } : state;
}
