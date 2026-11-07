import type { SupabaseClient } from '@supabase/supabase-js';
import type { NgoAction, NgoBootstrap, NgoFilter, NgoKeyConfigs, NgoMutationResult, NgoPage, NgoResource, NgoRow, NgoSaveResource } from './officeNgoTypes';
import { NGO_ACTIONS, NGO_CAPABILITIES, NGO_RESOURCES, NGO_ROLES, NGO_SAVE_RESOURCES } from './officeNgoTypes';

export type NgoRpcClient = Pick<SupabaseClient, 'rpc'>;

type Dict = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CURRENCY = /^[A-Z]{3}$/;
const MONEY = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/;
const QUANTITY = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const PURPOSE = ['direct_service', 'record_correction', 'safeguarding_response', 'compliance_review'] as const;
const FILTERS = new Set(['id', 'project_id', 'grant_id', 'status', 'purpose']);
const PROTECTED = new Set(['workspace_id', 'status', 'version', 'created_by', 'created_at', 'updated_at']);
const KEY_KINDS = ['beneficiary', 'safeguarding'] as const;
const SETTINGS = new Set(['base_currency', 'jurisdiction', 'private_data_enabled', 'storage_review_state', 'version', 'initialized', 'storage_review_reference']);
const SUMMARY_KEYS = new Set(['members', 'donors', 'grants', 'projects', 'budget_lines', 'disbursements', 'expenses', 'procurements', 'partners', 'subgrants', 'activities', 'indicators', 'measurements', 'beneficiaries', 'safeguarding', 'staff_assignments', 'assets', 'obligations', 'governance', 'evidence', 'reports']);
const DECIMAL_MONEY = new Set(['award_amount', 'amount', 'cost']);
const DECIMAL_QUANTITY = new Set(['target_quantity', 'actual_quantity', 'baseline', 'target', 'value']);
const RESOURCE_FIELDS: Record<NgoSaveResource, readonly string[]> = {
  donors: ['code', 'name', 'donor_type', 'country_code', 'reference'],
  grants: ['donor_id', 'code', 'title', 'currency', 'award_amount', 'start_on', 'end_on', 'restriction_reference'],
  projects: ['grant_id', 'code', 'title', 'region', 'district', 'start_on', 'end_on'],
  budget_lines: ['grant_id', 'project_id', 'code', 'category', 'amount'],
  disbursements: ['grant_id', 'code', 'amount', 'due_on'],
  expenses: ['budget_line_id', 'procurement_id', 'subgrant_id', 'code', 'description', 'amount', 'spent_on'],
  procurements: ['budget_line_id', 'code', 'description', 'method', 'threshold_reference', 'amount', 'supplier_public'],
  partners: ['code', 'legal_name', 'registration_reference', 'jurisdiction', 'risk_rating', 'due_diligence_on'],
  subgrants: ['partner_id', 'budget_line_id', 'code', 'title', 'amount', 'report_due_on'],
  activities: ['project_id', 'code', 'title', 'due_on', 'owner_id', 'target_quantity', 'actual_quantity'],
  indicators: ['project_id', 'code', 'title', 'unit', 'baseline', 'target', 'frequency'],
  measurements: ['indicator_id', 'period_start', 'period_end', 'value', 'disaggregation', 'evidence_id'],
  beneficiaries: ['project_id', 'code', 'cohort', 'lawful_basis', 'notice_reference', 'retention_until'],
  beneficiary_private: ['beneficiary_id', 'nonce', 'ciphertext'],
  safeguarding: ['project_id', 'code', 'priority', 'nonce', 'ciphertext', 'retention_until'],
  staff_assignments: ['project_id', 'user_id', 'staff_code', 'staff_type', 'position', 'training_due_on'],
  assets: ['project_id', 'code', 'name', 'category', 'serial_reference', 'custodian_id', 'acquired_on', 'cost', 'condition', 'next_service_on'],
  obligations: ['jurisdiction', 'kind', 'period_start', 'period_end', 'due_on', 'title', 'authority_url'],
  governance: ['code', 'title', 'meeting_on', 'meeting_type', 'decision_reference', 'action_owner_id', 'due_on'],
  evidence: ['project_id', 'grant_id', 'entity_resource', 'entity_id', 'description', 'file_id', 'reference', 'source_url'],
  reports: ['project_id', 'grant_id', 'code', 'title', 'report_type', 'period_start', 'period_end'],
};
const TRANSITION_FIELDS: Record<NgoSaveResource, readonly string[]> = {
  donors: [], grants: ['restriction_reference'], projects: [], budget_lines: [], disbursements: ['bank_reference', 'received_on'], expenses: ['payment_reference', 'evidence_id'], procurements: ['order_reference', 'receipt_reference', 'evidence_id'], partners: [], subgrants: [], activities: ['evidence_id'], indicators: [], measurements: [], beneficiaries: [], beneficiary_private: [], safeguarding: ['reference'], staff_assignments: [], assets: [], obligations: ['submission_reference', 'evidence_id'], governance: [], evidence: [], reports: ['submission_reference', 'evidence_id'],
};

function isObj(value: unknown): value is Dict { return !!value && typeof value === 'object' && !Array.isArray(value); }
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function positiveInt(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function nonnegativeInt(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function workspace(id: string): void { if (!uuid(id)) throw new Error('A valid NGO workspace is required.'); }
function exactKeys(value: Dict, allowed: readonly string[], label: string): void { const set = new Set(allowed); for (const key of Object.keys(value)) if (!set.has(key)) throw new Error(`Unknown ${label} field.`); }
function required(value: Dict, keys: readonly string[], label: string): void { for (const key of keys) if (value[key] === undefined) throw new Error(`${label} requires ${key}.`); }
function canonicalB64(value: unknown, label: string, min: number, max: number): void {
  if (typeof value !== 'string' || !B64.test(value)) throw new Error(`${label} must be canonical base64`);
  let decoded: string;
  try { decoded = atob(value); } catch { throw new Error(`${label} must be canonical base64`); }
  let encoded = ''; for (let i = 0; i < decoded.length; i += 0x8000) encoded += btoa(decoded.slice(i, i + 0x8000));
  if (encoded !== value || decoded.length < min || decoded.length > max) throw new Error(`${label} must be canonical base64 with a valid length`);
}
function date(value: unknown, label: string): void { if (typeof value !== 'string' || !DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) throw new Error(`${label} must be a valid date.`); }
function validateFilter(filter: unknown): asserts filter is NgoFilter {
  if (!isObj(filter)) throw new Error('NGO filters must be an object.');
  exactKeys(filter, [...FILTERS], 'NGO filter');
  for (const key of ['id', 'project_id', 'grant_id']) if (filter[key] !== undefined && !uuid(filter[key])) throw new Error(`Invalid NGO ${key} filter.`);
  if (filter.status !== undefined && (typeof filter.status !== 'string' || filter.status.length === 0)) throw new Error('Invalid NGO status filter.');
  if (filter.purpose !== undefined && !PURPOSE.includes(filter.purpose as typeof PURPOSE[number])) throw new Error('Invalid protected-read purpose.');
  if (filter.purpose !== undefined && !filter.id && filter.project_id === undefined) throw new Error('Protected reads require a scope filter.');
}
function validateSettings(value: unknown): void {
  if (!isObj(value)) throw new Error('NGO settings must be an object.');
  exactKeys(value, [...SETTINGS], 'NGO settings');
  if (typeof value.base_currency !== 'string' || !CURRENCY.test(value.base_currency) || !['mainland', 'zanzibar'].includes(String(value.jurisdiction)) || typeof value.private_data_enabled !== 'boolean' || !['unverified', 'pending', 'approved', 'rejected'].includes(String(value.storage_review_state)) || !positiveInt(value.version)) throw new Error('Malformed NGO settings.');
  if (value.initialized !== undefined && typeof value.initialized !== 'boolean') throw new Error('Malformed NGO settings.');
  if (value.storage_review_reference !== undefined && (typeof value.storage_review_reference !== 'string' || value.storage_review_reference.length === 0)) throw new Error('Malformed NGO settings.');
}
export function isNgoPage(value: unknown): value is NgoPage {
  if (!isObj(value) || !Array.isArray(value.rows) || !value.rows.every(isObj) || !nonnegativeInt(value.total_count) || !positiveInt(value.limit) || !nonnegativeInt(value.offset) || typeof value.has_more !== 'boolean') return false;
  const page = value as unknown as NgoPage;
  return page.limit <= 100 && page.rows.length <= page.limit && page.offset <= page.total_count && page.offset <= Number.MAX_SAFE_INTEGER - page.rows.length && page.has_more === (page.offset + page.rows.length < page.total_count);
}
export function isNgoBootstrap(value: unknown): value is NgoBootstrap {
  if (!isObj(value) || !uuid(value.actor_id) || (!NGO_ROLES.includes(value.role as typeof NGO_ROLES[number]) && value.role !== 'unassigned') || !isObj(value.capabilities) || !isObj(value.summary) || !isObj(value.settings)) return false;
  const caps = value.capabilities; if (Object.keys(caps).some(k => !(NGO_CAPABILITIES as readonly string[]).includes(k)) || !NGO_CAPABILITIES.every(k => typeof caps[k] === 'boolean')) return false;
  if (value.role === 'unassigned' && NGO_CAPABILITIES.some(k => caps[k] !== false)) return false;
  const summary = value.summary; if (Object.keys(summary).some(k => !SUMMARY_KEYS.has(k)) || Object.values(summary).some(v => !(typeof v === 'string' || nonnegativeInt(v)))) return false;
  try { validateSettings(value.settings); } catch { return false; } return true;
}
export function isNgoKeyConfigs(value: unknown): value is NgoKeyConfigs {
  if (!isObj(value) || Object.keys(value).some(k => !KEY_KINDS.includes(k as typeof KEY_KINDS[number]))) return false;
  return KEY_KINDS.every(kind => { const config = value[kind]; if (!isObj(config)) return false; const allowed = ['configured', 'key_version', 'derivation', 'iterations', 'salt', 'nonce', 'ciphertext']; exactKeys(config, allowed, 'NGO key configuration'); if (typeof config.configured !== 'boolean') return false; if (!config.configured) return Object.keys(config).every(k => k === 'configured'); try { if (config.key_version !== 1 || config.derivation !== 'PBKDF2-HMAC-SHA-256/AES-256-GCM' || config.iterations !== 600000) return false; canonicalB64(config.salt, 'salt', 16, 16); canonicalB64(config.nonce, 'nonce', 12, 12); canonicalB64(config.ciphertext, 'ciphertext', 17, 32768); return true; } catch { return false; } });
}
function validateData(resource: NgoSaveResource, data: unknown): asserts data is Dict {
  if (!isObj(data)) throw new Error('NGO record data must be an object.'); exactKeys(data, RESOURCE_FIELDS[resource], `${resource} data`);
  for (const key of Object.keys(data)) { const value = data[key]; if (DECIMAL_MONEY.has(key) && (typeof value !== 'string' || !MONEY.test(value))) throw new Error('Money values must be exact decimal strings with at most 2 decimals.'); if (DECIMAL_QUANTITY.has(key) && (typeof value !== 'string' || !QUANTITY.test(value))) throw new Error('Quantity values must be exact decimal strings with at most 6 decimals.'); if (key.endsWith('_id') && value !== undefined && !uuid(value)) throw new Error(`${key} must be a UUID.`); if (key.endsWith('_on') && value !== undefined) date(value, key); if (PROTECTED.has(key)) throw new Error('Protected NGO fields cannot be written.'); }
  if (resource === 'beneficiary_private') { required(data, ['beneficiary_id', 'nonce', 'ciphertext'], resource); canonicalB64(data.nonce, 'nonce', 12, 12); canonicalB64(data.ciphertext, 'ciphertext', 17, 32768); }
  if (resource === 'safeguarding') { required(data, ['project_id', 'code', 'priority', 'nonce', 'ciphertext', 'retention_until'], resource); canonicalB64(data.nonce, 'nonce', 12, 12); canonicalB64(data.ciphertext, 'ciphertext', 17, 32768); }
}
function validateEnrollment(payload: Dict): void {
  required(payload, ['id', 'data', 'private_record'], 'enroll_beneficiary');
  if (!uuid(payload.id) || !isObj(payload.data) || !isObj(payload.private_record)) throw new Error('Malformed beneficiary enrollment.');
  exactKeys(payload.data, RESOURCE_FIELDS.beneficiaries, 'beneficiary enrollment data');
  exactKeys(payload.private_record, ['nonce', 'ciphertext'], 'beneficiary private record');
  for (const key of Object.keys(payload.data)) {
    const value = payload.data[key];
    if (key === 'project_id' && !uuid(value)) throw new Error('project_id must be a UUID.');
    if (key === 'retention_until') date(value, key);
    if (typeof value !== 'string') throw new Error('Beneficiary metadata values must be strings.');
  }
  required(payload.private_record, ['nonce', 'ciphertext'], 'beneficiary private record');
  canonicalB64(payload.private_record.nonce, 'nonce', 12, 12);
  canonicalB64(payload.private_record.ciphertext, 'ciphertext', 17, 32768);
}
function validatePayload(action: NgoAction, payload: Dict): void {
  const allowed: Record<NgoAction, readonly string[]> = { initialize: ['idempotency_key'], assign_role: ['user_id', 'role', 'active', 'idempotency_key'], save_settings: ['base_currency', 'jurisdiction', 'expected_version', 'idempotency_key'], configure_private_key: ['kind', 'key_version', 'derivation', 'iterations', 'salt', 'nonce', 'ciphertext', 'idempotency_key'], review_storage: ['state', 'reference', 'idempotency_key'], set_private_gate: ['enabled', 'expected_version', 'idempotency_key'], enroll_beneficiary: ['id', 'data', 'private_record', 'idempotency_key'], audit_export: ['resource', 'entity_ids', 'format', 'idempotency_key'], save_record: ['resource', 'id', 'expected_version', 'data', 'idempotency_key'], transition_record: ['resource', 'id', 'expected_version', 'to_state', 'data', 'idempotency_key'] };
  exactKeys(payload, allowed[action], 'NGO command'); required(payload, ['idempotency_key'], action); if (!uuid(payload.idempotency_key)) throw new Error('A valid NGO idempotency key is required.');
  if (action === 'assign_role') { required(payload, ['user_id', 'role', 'active'], action); if (!uuid(payload.user_id) || (!NGO_ROLES.includes(payload.role as typeof NGO_ROLES[number]) && payload.role !== 'unassigned') || typeof payload.active !== 'boolean') throw new Error('Malformed role assignment.'); }
  if (action === 'save_settings') { required(payload, ['base_currency', 'jurisdiction', 'expected_version'], action); if (typeof payload.base_currency !== 'string' || !CURRENCY.test(payload.base_currency) || !['mainland', 'zanzibar'].includes(String(payload.jurisdiction)) || !positiveInt(payload.expected_version)) throw new Error('Malformed NGO settings update.'); }
  if (action === 'configure_private_key') { required(payload, ['kind', 'key_version', 'derivation', 'iterations', 'salt', 'nonce', 'ciphertext'], action); if (!KEY_KINDS.includes(payload.kind as typeof KEY_KINDS[number]) || payload.key_version !== 1 || payload.derivation !== 'PBKDF2-HMAC-SHA-256/AES-256-GCM' || payload.iterations !== 600000) throw new Error('Unsupported NGO key configuration.'); canonicalB64(payload.salt, 'salt', 16, 16); canonicalB64(payload.nonce, 'nonce', 12, 12); canonicalB64(payload.ciphertext, 'ciphertext', 17, 32768); }
  if (action === 'review_storage') { required(payload, ['state', 'reference'], action); if (!['pending', 'approved', 'rejected'].includes(String(payload.state)) || typeof payload.reference !== 'string' || !payload.reference) throw new Error('Malformed storage review.'); }
  if (action === 'set_private_gate') { required(payload, ['enabled', 'expected_version'], action); if (typeof payload.enabled !== 'boolean' || !positiveInt(payload.expected_version)) throw new Error('Malformed private gate update.'); }
  if (action === 'enroll_beneficiary') validateEnrollment(payload);
  if (action === 'audit_export') { required(payload, ['resource', 'entity_ids', 'format'], action); if (payload.resource !== 'reports' || payload.format !== 'csv' || !Array.isArray(payload.entity_ids) || payload.entity_ids.length === 0 || !payload.entity_ids.every(uuid)) throw new Error('Audit export requires non-empty report UUIDs and csv format.'); }
  if (action === 'save_record') { required(payload, ['resource', 'data'], action); if (!NGO_SAVE_RESOURCES.includes(payload.resource as NgoSaveResource)) throw new Error('Unknown NGO save resource.'); const protectedResource = payload.resource === 'beneficiary_private' || payload.resource === 'safeguarding'; if (payload.id !== undefined && (!protectedResource || !uuid(payload.id))) throw new Error('Only protected creates may supply a client UUID.'); if (payload.id !== undefined && payload.expected_version !== undefined) throw new Error('Creates cannot include expected_version.'); if (payload.id === undefined && payload.expected_version !== undefined) throw new Error('Updates require id.'); if (payload.id !== undefined && payload.expected_version !== undefined && !positiveInt(payload.expected_version)) throw new Error('Invalid expected_version.'); validateData(payload.resource as NgoSaveResource, payload.data); if (payload.resource === 'beneficiary_private' && payload.id !== undefined && payload.id !== (payload.data as Dict).beneficiary_id) throw new Error('Beneficiary private id must equal beneficiary_id.'); }
  if (action === 'transition_record') { required(payload, ['resource', 'id', 'expected_version', 'to_state'], action); if (!NGO_SAVE_RESOURCES.includes(payload.resource as NgoSaveResource) || !uuid(payload.id) || !positiveInt(payload.expected_version) || typeof payload.to_state !== 'string' || !payload.to_state) throw new Error('Malformed NGO transition.'); if (payload.data !== undefined) { if (!isObj(payload.data)) throw new Error('Transition data must be an object.'); exactKeys(payload.data, TRANSITION_FIELDS[payload.resource as NgoSaveResource], 'transition'); for (const key of Object.keys(payload.data)) { if (key.endsWith('_id') && !uuid(payload.data[key])) throw new Error(`${key} must be a UUID.`); if (key.endsWith('_on')) date(payload.data[key], key); } } const requiredFields: readonly string[] | undefined = payload.resource === 'grants' && payload.to_state === 'active' ? ['restriction_reference'] : payload.resource === 'disbursements' && payload.to_state === 'received' ? ['bank_reference', 'received_on'] : payload.resource === 'expenses' && payload.to_state === 'paid' ? ['payment_reference', 'evidence_id'] : payload.resource === 'procurements' && payload.to_state === 'ordered' ? ['order_reference'] : payload.resource === 'procurements' && payload.to_state === 'received' ? ['receipt_reference', 'evidence_id'] : payload.resource === 'activities' && payload.to_state === 'completed' ? ['evidence_id'] : payload.resource === 'obligations' && payload.to_state === 'filed' ? ['submission_reference', 'evidence_id'] : payload.resource === 'reports' && payload.to_state === 'submitted' ? ['submission_reference', 'evidence_id'] : payload.resource === 'safeguarding' && payload.to_state === 'open' ? ['reference'] : undefined; if (requiredFields) { if (!isObj(payload.data)) throw new Error('This transition requires data.'); required(payload.data, requiredFields, 'Transition'); if (payload.resource === 'grants' && (typeof payload.data.restriction_reference !== 'string' || payload.data.restriction_reference.trim() === '')) throw new Error('Transition requires a nonblank restriction_reference.'); } }
}
async function rpc(client: NgoRpcClient, name: string, params: Dict): Promise<unknown> { const result = await client.rpc(name, params); if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code }); return result.data; }

export const officeNgoManagementApi = {
  async read(client: NgoRpcClient, workspaceId: string, resource: NgoResource, filter: NgoFilter = {}, limit = 100, offset = 0) { workspace(workspaceId); if (!NGO_RESOURCES.includes(resource)) throw new Error('Unknown NGO resource.'); validateFilter(filter); if (resource === 'beneficiary_private' && (!filter.id || !filter.purpose)) throw new Error('Beneficiary private reads require filter.id and purpose.'); if (resource === 'safeguarding' && !filter.purpose) throw new Error('Safeguarding reads require purpose.'); if (filter.purpose && resource !== 'beneficiary_private' && resource !== 'safeguarding') throw new Error('Protected-read purpose is only valid for protected resources.'); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER - limit) throw new Error('Invalid NGO pagination.'); const data = await rpc(client, 'office_ngo_read', { p_workspace_id: workspaceId, p_resource: resource, p_filter: filter, p_limit: limit, p_offset: offset }); if (resource === 'bootstrap') { if (!isNgoBootstrap(data)) throw new Error('Malformed NGO bootstrap.'); return data; } if (resource === 'private_keys') { if (!isNgoKeyConfigs(data)) throw new Error('Malformed NGO key configuration.'); return data; } if (!isNgoPage(data) || data.limit !== limit || data.offset !== offset || data.total_count < data.offset) throw new Error('Malformed NGO page.'); return data;
  },
  async command<T extends NgoMutationResult = NgoMutationResult>(client: NgoRpcClient, workspaceId: string, action: NgoAction, payload: NgoRow) { workspace(workspaceId); if (!NGO_ACTIONS.includes(action)) throw new Error('Unknown NGO action.'); if (!isObj(payload)) throw new Error('NGO command payload must be an object.'); validatePayload(action, payload); const data = await rpc(client, 'office_ngo_command', { p_workspace_id: workspaceId, p_action: action, p_payload: payload }); if (!isObj(data) || !uuid(data.id) || !positiveInt(data.version) || typeof data.status !== 'string' || !data.status) throw new Error('Malformed NGO mutation confirmation.'); return data as T; },
};
