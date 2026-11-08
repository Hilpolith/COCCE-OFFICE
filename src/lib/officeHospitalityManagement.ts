import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  HospitalityAction,
  HospitalityBootstrap,
  HospitalityFilter,
  HospitalityKeyConfigs,
  HospitalityMutationResult,
  HospitalityPage,
  HospitalityResource,
  HospitalityRow,
  HospitalitySaveResource,
} from './officeHospitalityTypes';
import {
  HOSPITALITY_ACTIONS,
  HOSPITALITY_CAPABILITIES,
  HOSPITALITY_RESOURCES,
  HOSPITALITY_ROLES,
  HOSPITALITY_SAVE_RESOURCES,
} from './officeHospitalityTypes';

export type HospitalityRpcClient = Pick<SupabaseClient, 'rpc'>;
type Dict = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DECIMAL = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const FILTERS = ['id', 'property_id', 'reservation_id', 'status', 'purpose', 'start_on', 'end_on'] as const;
const PURPOSE = ['check_in', 'guest_service', 'privacy_review', 'incident_response'] as const;
const KEY_KINDS = ['guest', 'incident'] as const;
const SETTINGS_STATES = ['unverified', 'pending', 'approved', 'rejected'] as const;
const protectedFields = new Set(['workspace_id', 'status', 'version', 'created_by', 'created_at', 'updated_at']);
const moneyFields = new Set(['nightly_rate', 'unit_price', 'tax_amount', 'levy_amount', 'quoted_amount', 'reorder_level', 'unit_cost', 'amount', 'net_amount']);
const quantityFields = new Set(['quantity', 'temperature', 'min_temperature', 'max_temperature']);
const idFields = new Set(['id', 'property_id', 'reservation_id', 'room_id', 'guest_id', 'assignee_id', 'user_id', 'space_id', 'item_id', 'line_id', 'payment_id', 'evidence_id']);
const fieldMap: Record<HospitalitySaveResource, readonly string[]> = {
  properties: ['code', 'name', 'jurisdiction', 'currency', 'timezone', 'address_public'],
  rooms: ['property_id', 'code', 'room_type', 'capacity', 'nightly_rate'],
  reservations: ['property_id', 'room_id', 'guest_id', 'code', 'check_in_on', 'check_out_on', 'adults', 'children', 'source', 'source_reference', 'nightly_rate'],
  housekeeping: ['property_id', 'room_id', 'code', 'task_type', 'assignee_id', 'due_on'],
  maintenance: ['property_id', 'room_id', 'code', 'category', 'priority', 'description_public', 'assignee_id', 'due_on'],
  menu_items: ['property_id', 'code', 'name', 'category', 'unit_price', 'tax_amount', 'levy_amount'],
  restaurant_orders: ['property_id', 'code', 'table_reference', 'reservation_id'],
  inventory_items: ['property_id', 'code', 'name', 'unit', 'reorder_level'],
  food_safety: ['property_id', 'code', 'check_type', 'checked_at', 'temperature', 'min_temperature', 'max_temperature', 'reference', 'corrective_action'],
  shifts: ['property_id', 'user_id', 'team', 'start_at', 'end_at', 'break_minutes'],
  staff_credentials: ['property_id', 'user_id', 'credential_type', 'reference', 'issued_on', 'expires_on'],
  licences: ['property_id', 'code', 'licence_type', 'authority', 'jurisdiction', 'reference', 'issued_on', 'expires_on', 'source_url', 'verified_on'],
  incidents: ['property_id', 'code', 'category', 'priority', 'retention_until', 'nonce', 'ciphertext'],
  event_spaces: ['property_id', 'code', 'name', 'capacity'],
  events: ['property_id', 'space_id', 'code', 'title_public', 'start_at', 'end_at', 'attendees', 'quoted_amount', 'reference'],
  evidence: ['property_id', 'entity_resource', 'entity_id', 'description_public', 'reference', 'source_url'],
};
const transitionFields: Record<HospitalitySaveResource, readonly string[]> = {
  properties: ['reference', 'evidence_id', 'corrective_action'],
  rooms: ['reference', 'evidence_id', 'corrective_action'],
  reservations: ['reference', 'evidence_id', 'corrective_action'],
  housekeeping: ['reference', 'evidence_id', 'corrective_action'],
  maintenance: ['reference', 'evidence_id', 'corrective_action'],
  menu_items: ['reference', 'evidence_id', 'corrective_action'],
  restaurant_orders: ['reference', 'evidence_id', 'corrective_action'],
  inventory_items: ['reference', 'evidence_id', 'corrective_action'],
  food_safety: ['reference', 'evidence_id', 'corrective_action'],
  shifts: ['reference', 'evidence_id', 'corrective_action'],
  staff_credentials: ['reference', 'evidence_id', 'corrective_action'],
  licences: ['reference', 'evidence_id', 'corrective_action'],
  incidents: ['reference', 'evidence_id', 'corrective_action'],
  event_spaces: ['reference', 'evidence_id', 'corrective_action'],
  events: ['reference', 'evidence_id', 'corrective_action'],
  evidence: ['reference', 'evidence_id', 'corrective_action'],
};

function obj(value: unknown): value is Dict {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Dict, keys: readonly string[], label: string): void {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unsupported ${label} field: ${key}`);
}
function uuid(value: unknown): value is string { return typeof value === 'string' && UUID.test(value); }
function date(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !DATE.test(value)) throw new Error(`${label} must be a real calendar date.`);
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) throw new Error(`${label} must be a real calendar date.`);
}
function required(value: Dict, keys: readonly string[], label: string): void {
  for (const key of keys) if (value[key] === undefined) throw new Error(`${label} requires ${key}.`);
}
function positiveVersion(value: unknown, label = 'expected_version'): void {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw new Error(`A positive ${label} is required.`);
}
function decimal(value: unknown, label: string, positive = false): void {
  if (typeof value !== 'string' || !DECIMAL.test(value) || (positive && Number(value) <= 0)) throw new Error(`${label} must be a ${positive ? 'positive ' : ''}decimal string.`);
}
function b64(value: unknown, label: string, min: number, max: number): void {
  if (typeof value !== 'string' || !B64.test(value)) throw new Error(`${label} must be canonical base64.`);
  let decoded: string;
  try { decoded = atob(value); } catch { throw new Error(`${label} must be canonical base64.`); }
  if (btoa(decoded) !== value || decoded.length < min || decoded.length > max) throw new Error(`${label} has invalid length.`);
}
function validateFilter(value: unknown): asserts value is HospitalityFilter {
  if (!obj(value)) throw new Error('Hospitality filter must be an object.');
  exact(value, FILTERS, 'filter');
  for (const key of ['id', 'property_id', 'reservation_id']) if (value[key] !== undefined && !uuid(value[key])) throw new Error(`Invalid ${key} filter.`);
  if (value.status !== undefined && (typeof value.status !== 'string' || !value.status)) throw new Error('Invalid status filter.');
  if (value.purpose !== undefined && !PURPOSE.includes(value.purpose as typeof PURPOSE[number])) throw new Error('Invalid protected-read purpose.');
  for (const key of ['start_on', 'end_on']) if (value[key] !== undefined) date(value[key], key);
}
function validateData(resource: HospitalitySaveResource, value: unknown): void {
  if (!obj(value)) throw new Error('Record data must be an object.');
  exact(value, fieldMap[resource], `${resource} data`);
  for (const [key, item] of Object.entries(value)) {
    if (protectedFields.has(key)) throw new Error('Server-owned fields cannot be written.');
    if (idFields.has(key) && item !== undefined && !uuid(item)) throw new Error(`${key} must be a UUID.`);
    if (key.endsWith('_on') && item !== undefined) date(item, key);
    if (moneyFields.has(key) && item !== undefined) decimal(item, key);
    if (quantityFields.has(key) && item !== undefined) decimal(item, key);
    if (key === 'source_url' && item !== undefined) {
      try {
        if (typeof item !== 'string' || new URL(item).protocol !== 'https:') throw new Error();
      } catch { throw new Error('source_url must be an HTTPS URL.'); }
    }
    if (['capacity', 'adults', 'children', 'attendees', 'break_minutes'].includes(key) && item !== undefined) {
      if (!Number.isSafeInteger(item) || (item as number) < 0) throw new Error(`${key} must be a non-negative integer.`);
    }
  }
  if (resource === 'incidents') {
    required(value, ['property_id', 'code', 'category', 'priority', 'retention_until', 'nonce', 'ciphertext'], resource);
    b64(value.nonce, 'nonce', 12, 12);
    b64(value.ciphertext, 'ciphertext', 17, 32768);
  }
}
function validatePayload(action: HospitalityAction, payload: Dict): void {
  const common = ['idempotency_key'];
  const allowed: Record<HospitalityAction, readonly string[]> = {
    initialize: common,
    configure_settings: ['base_currency', 'jurisdiction', 'expected_version', ...common],
    assign_role: ['user_id', 'role', 'active', 'expected_version', ...common],
    configure_private_key: ['kind', 'salt', 'nonce', 'ciphertext', ...common],
    set_private_gate: ['enabled', 'storage_review_state', 'storage_review_reference', 'expected_version', ...common],
    save_record: ['resource', 'id', 'expected_version', 'data', ...common],
    transition_record: ['resource', 'id', 'expected_version', 'to_state', 'data', ...common],
    save_guest: ['id', 'expected_version', 'data', ...common],
    post_charge: ['reservation_id', 'expected_version', 'description_public', 'net_amount', 'tax_amount', 'levy_amount', 'reference', ...common],
    void_charge: ['reservation_id', 'expected_version', 'line_id', 'reference', ...common],
    record_payment: ['reservation_id', 'expected_version', 'amount', 'method', 'reference', ...common],
    refund_payment: ['reservation_id', 'expected_version', 'amount', 'method', 'reference', 'payment_id', ...common],
    check_in: ['id', 'expected_version', ...common],
    check_out: ['id', 'expected_version', ...common],
    move_room: ['id', 'expected_version', 'room_id', 'reference', ...common],
    receive_stock: ['property_id', 'item_id', 'lot_code', 'expires_on', 'quantity', 'unit_cost', 'reference', ...common],
    issue_stock: ['id', 'expected_version', 'quantity', 'reference', ...common],
    add_order_line: ['id', 'expected_version', 'item_id', 'quantity', ...common],
    settle_order: ['id', 'expected_version', 'method', 'reference', ...common],
    close_day: ['property_id', 'close_on', 'cash_actual', 'bank_actual', 'mobile_actual', 'card_actual', 'reference', ...common],
    create_report: ['property_id', 'period_start', 'period_end', 'title', 'report_type', ...common],
    export_report: ['id', 'expected_version', 'purpose', ...common],
  };
  exact(payload, allowed[action], action);
  required(payload, ['idempotency_key'], action);
  if (!uuid(payload.idempotency_key)) throw new Error('A valid idempotency key is required.');

  const versioned = ['configure_settings', 'set_private_gate', 'assign_role', 'post_charge', 'void_charge', 'record_payment', 'refund_payment', 'check_in', 'check_out', 'move_room', 'issue_stock', 'add_order_line', 'settle_order', 'export_report'];
  if (versioned.includes(action)) positiveVersion(payload.expected_version);
  const idKeys = ['id', 'user_id', 'reservation_id', 'line_id', 'payment_id', 'property_id', 'item_id', 'room_id'];
  for (const key of idKeys) if (payload[key] !== undefined && !uuid(payload[key])) throw new Error(`${key} must be a UUID.`);

  if (action === 'configure_settings') {
    positiveVersion(payload.expected_version);
    if (typeof payload.base_currency !== 'string' || !/^[A-Z]{3}$/.test(payload.base_currency) || !['mainland', 'zanzibar'].includes(String(payload.jurisdiction))) throw new Error('Malformed settings.');
  }
  if (action === 'assign_role') {
    if (!uuid(payload.user_id) || !HOSPITALITY_ROLES.includes(payload.role as never) || typeof payload.active !== 'boolean') throw new Error('Malformed role assignment.');
  }
  if (action === 'configure_private_key') {
    if (!KEY_KINDS.includes(payload.kind as never)) throw new Error('Invalid private key kind.');
    b64(payload.salt, 'salt', 16, 16); b64(payload.nonce, 'nonce', 12, 12); b64(payload.ciphertext, 'ciphertext', 17, 32768);
  }
  if (action === 'set_private_gate') {
    if (typeof payload.enabled !== 'boolean' || (payload.storage_review_state !== undefined && !SETTINGS_STATES.includes(payload.storage_review_state as never))) throw new Error('Malformed private-data gate.');
    if (payload.enabled && (payload.storage_review_state !== 'approved' || typeof payload.storage_review_reference !== 'string' || !payload.storage_review_reference.trim())) throw new Error('An approved storage review reference is required.');
  }
  if (action === 'save_record') {
    if (!HOSPITALITY_SAVE_RESOURCES.includes(payload.resource as never) || !obj(payload.data)) throw new Error('Unknown save resource.');
    if (payload.id !== undefined) {
      if (!uuid(payload.id)) throw new Error('Record id must be a UUID.');
      positiveVersion(payload.expected_version);
    } else if (payload.expected_version !== undefined) throw new Error('Creates cannot include expected_version.');
    validateData(payload.resource as HospitalitySaveResource, payload.data);
  }
  if (action === 'transition_record') {
    if (!HOSPITALITY_SAVE_RESOURCES.includes(payload.resource as never) || !uuid(payload.id) || !Number.isSafeInteger(payload.expected_version) || (payload.expected_version as number) <= 0 || typeof payload.to_state !== 'string' || !payload.to_state) throw new Error('Malformed transition.');
    if (payload.data !== undefined) { if (!obj(payload.data)) throw new Error('Transition data must be an object.'); exact(payload.data, transitionFields[payload.resource as HospitalitySaveResource], 'transition data'); }
  }
  if (action === 'save_guest') {
    if (payload.id !== undefined && !uuid(payload.id)) throw new Error('Guest id must be a UUID.');
    if (payload.expected_version !== undefined) {
      positiveVersion(payload.expected_version);
      if (payload.id === undefined) throw new Error('Creates cannot include expected_version.');
    }
    if (!obj(payload.data)) throw new Error('Guest data must be an object.');
    exact(payload.data, ['property_id', 'code', 'lawful_basis', 'notice_reference', 'retention_until', 'nonce', 'ciphertext'], 'guest data');
    if (!uuid(payload.data.property_id)) throw new Error('property_id must be a UUID.');
    date(payload.data.retention_until, 'retention_until'); b64(payload.data.nonce, 'nonce', 12, 12); b64(payload.data.ciphertext, 'ciphertext', 17, 32768);
  }
  if (['post_charge', 'record_payment', 'refund_payment'].includes(action)) decimal(payload.amount ?? payload.net_amount, 'amount');
  if (action === 'post_charge') { decimal(payload.net_amount, 'net_amount'); decimal(payload.tax_amount, 'tax_amount'); decimal(payload.levy_amount, 'levy_amount'); }
  if (action === 'receive_stock') { date(payload.expires_on, 'expires_on'); decimal(payload.quantity, 'quantity', true); decimal(payload.unit_cost, 'unit_cost'); }
  if (['issue_stock', 'add_order_line'].includes(action)) decimal(payload.quantity, 'quantity', true);
  if (action === 'close_day') { date(payload.close_on, 'close_on'); for (const key of ['cash_actual', 'bank_actual', 'mobile_actual', 'card_actual']) decimal(payload[key], key); }
  if (action === 'create_report') { date(payload.period_start, 'period_start'); date(payload.period_end, 'period_end'); if (payload.report_type !== undefined && !['occupancy', 'revenue', 'compliance', 'inventory'].includes(String(payload.report_type))) throw new Error('Invalid report type.'); }
}
async function call(client: HospitalityRpcClient, name: string, params: Dict): Promise<unknown> {
  const result = await client.rpc(name, params);
  if (result.error) throw Object.assign(new Error(result.error.message), { code: result.error.code });
  return result.data;
}

export function isHospitalityPage(value: unknown): value is HospitalityPage {
  if (!obj(value) || !Array.isArray(value.rows) || !value.rows.every(obj) || !Number.isSafeInteger(value.total_count) || (value.total_count as number) < 0 || !Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > 100 || !Number.isSafeInteger(value.offset) || (value.offset as number) < 0 || typeof value.has_more !== 'boolean') return false;
  return value.rows.length <= (value.limit as number) && value.has_more === ((value.offset as number) + value.rows.length < (value.total_count as number));
}
export function isHospitalityBootstrap(value: unknown): value is HospitalityBootstrap {
  if (!obj(value) || !uuid(value.workspace_id) || !uuid(value.actor_id) || (!HOSPITALITY_ROLES.includes(value.role as never) && value.role !== 'unassigned') || !obj(value.capabilities) || !obj(value.settings) || !obj(value.summary)) return false;
  const capabilities = value.capabilities;
  const settings = value.settings;
  return HOSPITALITY_CAPABILITIES.every((key) => typeof capabilities[key] === 'boolean') && Object.keys(capabilities).every((key) => (HOSPITALITY_CAPABILITIES as readonly string[]).includes(key)) && typeof settings.initialized === 'boolean' && typeof settings.base_currency === 'string' && /^[A-Z]{3}$/.test(settings.base_currency as string) && ['mainland', 'zanzibar'].includes(String(settings.jurisdiction)) && typeof settings.private_data_enabled === 'boolean' && SETTINGS_STATES.includes(settings.storage_review_state as never) && Number.isSafeInteger(settings.version) && (settings.version as number) > 0;
}
export function isHospitalityKeyConfigs(value: unknown): value is HospitalityKeyConfigs {
  if (!obj(value) || Object.keys(value).some((key) => !KEY_KINDS.includes(key as never))) return false;
  return KEY_KINDS.every((kind) => {
    const config = value[kind];
    if (!obj(config) || typeof config.configured !== 'boolean') return false;
    if (!config.configured) return Object.keys(config).length === 1;
    try { exact(config, ['configured', 'key_version', 'derivation', 'iterations', 'salt', 'nonce', 'ciphertext'], 'key config'); return config.key_version === 1 && config.derivation === 'PBKDF2-HMAC-SHA-256/AES-256-GCM' && config.iterations === 600000 && (b64(config.salt, 'salt', 16, 16), b64(config.nonce, 'nonce', 12, 12), b64(config.ciphertext, 'ciphertext', 17, 32768), true); } catch { return false; }
  });
}
function validateConfirmation(value: unknown): HospitalityMutationResult {
  if (!obj(value) || !uuid(value.id) || !Number.isSafeInteger(value.version) || (value.version as number) < 1) throw new Error('Malformed hospitality mutation confirmation.');
  exact(value, ['id', 'version', 'status', 'row'], 'mutation confirmation');
  if (value.status !== undefined && (typeof value.status !== 'string' || !value.status)) throw new Error('Malformed hospitality mutation confirmation.');
  if (value.row !== undefined && !obj(value.row)) throw new Error('Malformed hospitality mutation confirmation.');
  return value as HospitalityMutationResult;
}

export const officeHospitalityManagementApi = {
  async read(client: HospitalityRpcClient, workspaceId: string, resource: HospitalityResource, filter: HospitalityFilter = {}, limit = 100, offset = 0) {
    if (!uuid(workspaceId)) throw new Error('A valid hospitality workspace is required.');
    if (!HOSPITALITY_RESOURCES.includes(resource)) throw new Error('Unknown hospitality resource.');
    validateFilter(filter);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid hospitality pagination.');
    if ((resource === 'guests' || resource === 'incidents') && (!filter.id || !filter.purpose)) throw new Error('Protected reads require an exact id and approved purpose.');
    if (filter.purpose && resource !== 'guests' && resource !== 'incidents') throw new Error('Purpose is only valid for protected reads.');
    const data = await call(client, 'office_hospitality_read', { p_workspace_id: workspaceId, p_resource: resource, p_filter: filter, p_limit: limit, p_offset: offset });
    if (resource === 'bootstrap') { if (!isHospitalityBootstrap(data)) throw new Error('Malformed hospitality bootstrap.'); return data; }
    if (resource === 'private_keys') { if (!isHospitalityKeyConfigs(data)) throw new Error('Malformed hospitality key configuration.'); return data; }
    if (!isHospitalityPage(data) || data.limit !== limit || data.offset !== offset) throw new Error('Malformed hospitality page.');
    return data;
  },
  async command<T extends HospitalityMutationResult = HospitalityMutationResult>(client: HospitalityRpcClient, workspaceId: string, action: HospitalityAction, payload: HospitalityRow) {
    if (!uuid(workspaceId)) throw new Error('A valid hospitality workspace is required.');
    if (!HOSPITALITY_ACTIONS.includes(action)) throw new Error('Unknown hospitality action.');
    if (!obj(payload)) throw new Error('Hospitality command payload must be an object.');
    validatePayload(action, payload);
    return validateConfirmation(await call(client, 'office_hospitality_command', { p_workspace_id: workspaceId, p_action: action, p_payload: payload })) as T;
  },
};
