import type { SupabaseClient } from "@supabase/supabase-js";

export const HEALTH_ADMIN_ROLES = [
  "health_admin", "facility_manager", "registration_clerk", "triage_nurse", "clinician",
  "lab_staff", "pharmacist", "ward_nurse", "billing_clerk", "credentialing_officer",
  "privacy_officer", "health_auditor", "health_viewer", "unassigned",
] as const;
export type HealthAdminRole = (typeof HEALTH_ADMIN_ROLES)[number];

export const HEALTH_ADMIN_CAPABILITIES = [
  "settings", "facility_admin", "patient_registration", "patient_identity_read", "appointments",
  "encounters", "triage", "clinical_notes", "diagnostic_orders", "diagnostic_results",
  "medication_orders", "pharmacy_dispense", "medication_admin", "inpatient", "procedures",
  "discharge", "billing", "claims", "licenses", "credentialing", "inventory", "asset_admin",
  "privacy_ops", "evidence", "reports", "staff_roles", "audit", "export",
] as const;
export type HealthAdminCapabilities = Record<(typeof HEALTH_ADMIN_CAPABILITIES)[number], boolean>;

export const HEALTH_ADMIN_RESOURCES = [
  "bootstrap", "settings", "facilities", "departments", "patients", "patient_private", "patient_matches",
  "duplicate_cases", "appointments", "encounters", "queue_entries", "triage_events", "clinical_records",
  "diagnostic_orders", "specimens", "diagnostic_results", "medication_orders", "medication_administrations",
  "wards", "beds", "admissions", "transfers", "procedures", "discharges", "follow_ups", "invoices",
  "payments", "payer_accreditations", "claims", "staff_roles", "staff_credentials", "licenses",
  "medicine_items", "medicine_lots", "stock_movements", "replenishment_requests", "assets",
  "asset_maintenance", "privacy_incidents", "data_requests", "disclosures", "external_workflows", "evidence",
  "audit", "facility_report", "clinical_report", "diagnostic_report", "pharmacy_report", "inpatient_report",
  "billing_report", "claims_report", "compliance_report", "staff_report",
] as const;
export type HealthAdminResource = (typeof HEALTH_ADMIN_RESOURCES)[number];

export const HEALTH_ADMIN_PURPOSES = [
  "registration", "appointment", "direct_care", "triage", "laboratory", "pharmacy", "ward_care", "billing",
  "claims", "credential_review", "privacy_review", "compliance_review", "aggregate_reporting", "authorized_export",
] as const;
export type HealthAdminAccessPurpose = (typeof HEALTH_ADMIN_PURPOSES)[number];

const fields = {
  configure_private_key: ["key_config", "expected_version"], assign_staff_role: ["id", "user_id", "role", "expected_version"], assign_facility_scope: ["id", "staff_role_id", "facility_id", "department_id", "expected_version"],
  save_facility: ["id", "expected_version", "facility_code", "display_name", "facility_type", "district", "region", "ownership", "state", "source_url", "official_reference"], transition_facility: ["id", "expected_version", "state", "reason"], save_department: ["id", "facility_id", "expected_version", "name", "code", "state"],
  save_license: ["id", "facility_id", "expected_version", "authority", "license_kind", "reference", "issue_date", "due_date", "status", "official_url"], transition_license: ["id", "expected_version", "status", "reason"], save_staff_credential: ["id", "facility_id", "expected_version", "staff_code", "profession", "council", "issue_date", "expiry_date", "state", "verifier_source", "verifier_reference", "nonce", "ciphertext"], transition_staff_credential: ["id", "expected_version", "state", "reason"],
  register_patient: ["id", "facility_id", "expected_version", "nonce", "ciphertext", "blind_indexes"], update_patient_private: ["id", "expected_version", "nonce", "ciphertext", "blind_indexes"], review_duplicate_case: ["id", "expected_version", "status", "reason"],
  create_appointment: ["id", "patient_id", "facility_id", "department_id", "expected_version", "appointment_type", "scheduled_at", "state"], transition_appointment: ["id", "expected_version", "state", "reason"], reschedule_appointment: ["id", "expected_version", "scheduled_at", "reason"], create_encounter: ["id", "patient_id", "facility_id", "department_id", "expected_version", "encounter_type", "state"], transition_encounter: ["id", "expected_version", "state", "reason"], assign_queue_entry: ["id", "encounter_id", "expected_version", "queue", "state"], record_triage: ["id", "encounter_id", "expected_version", "tool_name", "tool_version", "route_outcome", "nonce", "ciphertext"], save_clinical_record: ["id", "encounter_id", "expected_version", "record_type", "nonce", "ciphertext"],
  create_diagnostic_order: ["id", "encounter_id", "expected_version", "order_type", "state", "nonce", "ciphertext"], transition_diagnostic_order: ["id", "expected_version", "state", "reason"], create_specimen: ["id", "order_id", "expected_version", "barcode", "state"], record_specimen_handoff: ["id", "expected_version", "state", "mode", "reason"], record_diagnostic_result: ["id", "order_id", "expected_version", "nonce", "ciphertext"], approve_diagnostic_result: ["id", "expected_version", "state", "reason"], deliver_diagnostic_result: ["id", "expected_version", "state", "reason"],
  create_medication_order: ["id", "encounter_id", "expected_version", "state", "nonce", "ciphertext"], transition_medication_order: ["id", "expected_version", "state", "reason"], record_medication_administration: ["id", "order_id", "expected_version", "nonce", "ciphertext"], save_ward: ["id", "facility_id", "expected_version", "name", "state"], save_bed: ["id", "ward_id", "expected_version", "label", "state"], admit_patient: ["id", "patient_id", "expected_version", "state", "nonce", "ciphertext"], assign_bed: ["id", "admission_id", "bed_id", "expected_version"], transfer_patient: ["id", "admission_id", "expected_version", "from_bed_id", "to_bed_id", "reason"], save_procedure: ["id", "encounter_id", "expected_version", "state", "nonce", "ciphertext"], transition_procedure: ["id", "expected_version", "state", "reason"], save_discharge: ["id", "encounter_id", "expected_version", "nonce", "ciphertext"], finalize_discharge: ["id", "expected_version", "state", "reason"], save_follow_up: ["id", "patient_id", "expected_version", "state", "nonce", "ciphertext"],
  save_invoice: ["id", "patient_id", "facility_id", "expected_version", "amount_tzs", "state", "nonce", "ciphertext"], record_payment: ["id", "invoice_id", "expected_version", "amount_tzs", "state", "reference"], save_payer_accreditation: ["id", "facility_id", "expected_version", "payer", "status", "source_url", "official_reference"], create_claim: ["id", "invoice_id", "expected_version", "amount_tzs", "state", "nonce", "ciphertext"], transition_claim: ["id", "expected_version", "state", "reason"], record_claim_response: ["id", "claim_id", "expected_version", "state", "reason", "nonce", "ciphertext"],
  save_medicine_item: ["id", "expected_version", "product_code", "product_description", "strength", "form", "unit", "regulator_reference", "status"], receive_medicine_lot: ["id", "item_id", "facility_id", "expected_version", "lot_reference", "expiry_date", "received_quantity", "state"], record_stock_movement: ["id", "lot_id", "expected_version", "movement_type", "quantity", "movement_date", "reason", "reference"], quarantine_medicine_lot: ["id", "expected_version", "reason"], dispose_medicine_lot: ["id", "expected_version", "reason", "disposal_date"], create_replenishment_request: ["id", "facility_id", "item_id", "expected_version", "requested_quantity", "state", "reason", "reference"], transition_replenishment_request: ["id", "expected_version", "state", "reason"], save_asset: ["id", "facility_id", "expected_version", "asset_type", "state", "source_reference"], record_asset_maintenance: ["id", "asset_id", "expected_version", "state", "maintenance_date", "reason"], save_privacy_incident: ["id", "expected_version", "incident_reference", "incident_date", "severity", "status", "source_reference"], transition_privacy_incident: ["id", "expected_version", "status", "reason"], save_data_request: ["id", "expected_version", "request_type", "request_date", "status", "reference"], transition_data_request: ["id", "expected_version", "status", "reason"], log_disclosure: ["id", "expected_version", "recipient_category", "purpose", "disclosure_date", "outcome", "reference"], save_external_workflow: ["id", "expected_version", "authority", "workflow_type", "state", "source_url", "reference"], link_evidence: ["id", "expected_version", "entity_type", "entity_id", "label", "source_url", "official_reference", "status"], supersede_evidence: ["id", "expected_version", "reason"], audit_sensitive_export: ["resource", "entity_ids", "format", "purpose_code"],
} as const;
export type HealthAdminAction = keyof typeof fields;
export const HEALTH_ADMIN_ACTIONS = Object.keys(fields) as HealthAdminAction[];
export const HEALTH_ADMIN_COMMAND_FIELDS = fields;

export type HealthAdminRecord = Record<string, unknown>;
export interface HealthAdminPage<T extends HealthAdminRecord = HealthAdminRecord> { rows: T[]; total_count: number; offset: number; limit: number; has_more: boolean }
export type HealthAdminStorageReviewState = "unverified" | "approved";
export type HealthAdminResidencyApprovalStatus = "unrecorded" | "pending" | "approved" | "rejected";
export interface HealthAdminSettings {
  jurisdiction: string; display_name: string; timezone_name: string; clinical_data_enabled: boolean;
  storage_review_state: HealthAdminStorageReviewState; version: number;
  clinical_data_region?: string | null; residency_approval_status?: HealthAdminResidencyApprovalStatus | null;
  residency_approval_reference?: string | null; residency_approval_recorded_by?: string | null; residency_approval_recorded_at?: string | null;
  residency_approval_verified_by?: string | null; residency_approval_verified_at?: string | null;
  key_config?: import("./officeHealthAdminCrypto").HealthAdminKeyConfig | null;
}
export interface HealthAdminBootstrap { role: HealthAdminRole; clinical_data_enabled: boolean; storage_review_state: HealthAdminStorageReviewState; storage_ready: boolean; storage_state?: string; settings?: HealthAdminSettings | null; key_config?: import("./officeHealthAdminCrypto").HealthAdminKeyConfig | null; capabilities?: HealthAdminCapabilities; summary?: Record<string, number> }
export interface HealthAdminRpcClient { rpc(name: string, params?: Record<string, unknown>): Promise<{ data: unknown; error: { message: string; code?: string } | null }> }
export type HealthAdminClient = HealthAdminRpcClient | SupabaseClient;

export type HealthAdminResidencyAction = "record_approval" | "verify_approval" | "set_clinical_gate";
export type HealthAdminResidencyPayload =
  | { reference: string; expected_version: number; idempotency_key: string }
  | { decision: "approved" | "rejected"; expected_version: number; idempotency_key: string }
  | { enabled: boolean; expected_version: number; idempotency_key: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const MONEY = /^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/;
const QUANTITY = /^(?:0|[1-9]\d{0,21})(?:\.\d{1,6})?$/;
const isRecord = (v: unknown): v is HealthAdminRecord => !!v && typeof v === "object" && !Array.isArray(v);
const nonnegative = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const checkWorkspace = (id: string) => { if (typeof id !== "string" || !UUID.test(id)) throw new Error("A valid Health Administration workspace is required."); };
const rpc = async (client: HealthAdminClient, name: string, params: HealthAdminRecord) => { const result = await (client as HealthAdminRpcClient).rpc(name, params); if (result.error) throw new Error("Health Administration request could not be completed."); return result.data; };
function decodedLength(v: string): number { return atob(v).length; }
function validPage(value: unknown): value is HealthAdminPage { if (!isRecord(value) || !Array.isArray(value.rows) || !value.rows.every(isRecord) || !nonnegative(value.total_count) || !nonnegative(value.offset) || !nonnegative(value.limit) || value.limit < 1 || value.limit > 200 || value.rows.length > value.limit || typeof value.has_more !== "boolean") return false; return value.has_more === value.offset + value.rows.length < value.total_count; }
export function isHealthAdminPage<T extends HealthAdminRecord = HealthAdminRecord>(value: unknown): value is HealthAdminPage<T> { return validPage(value); }
export function isHealthAdminBootstrap(value: unknown): value is Omit<HealthAdminBootstrap, "storage_ready"> { if (!isRecord(value) || Object.keys(value).some((key) => !["role", "clinical_data_enabled", "storage_review_state"].includes(key)) || !HEALTH_ADMIN_ROLES.includes(value.role as HealthAdminRole) || typeof value.clinical_data_enabled !== "boolean" || (value.storage_review_state !== "unverified" && value.storage_review_state !== "approved")) return false; return true; }
export function healthAdminRecordsContext(workspaceId: string): string { checkWorkspace(workspaceId); return `COCCE HealthAdmin:${workspaceId}:v1`; }

const safeFilterKeys = new Set(["id", "facility_id", "department_id", "state", "status", "type", "from", "to", "assigned_user_id", "version", "index_type", "digest"]);
const privateActions = new Set<HealthAdminAction>(["configure_private_key", "register_patient", "update_patient_private", "record_triage", "save_clinical_record", "create_diagnostic_order", "record_diagnostic_result", "create_medication_order", "record_medication_administration", "admit_patient", "save_procedure", "save_discharge", "save_follow_up", "save_invoice", "create_claim", "record_claim_response"]);
const privateFieldDenylist = /^(?:patient[_-]?(?:name|number|identifier)|member[_-]?id|(?:full|first|last)[_-]?name|name|mrn|phone(?:[_-]?number)?|email|national[_-]?id|passport(?:[_-]?number)?|diagnos(?:is|es)?|symptom(?:s)?|narrative|note(?:s)?|prescription(?:s)?|medication(?:s|[_-]?name)?|date[_-]?of[_-]?birth|dob|address|allerg(?:y|ies)|medical[_-]?history)$/i;
const opaquePrivateFields = new Set(["ciphertext", "nonce", "digest"]);
const operationalMetadataActions = new Set<HealthAdminAction>(["save_facility", "save_department", "save_ward", "save_bed"]);
const scanPrivate = (action: HealthAdminAction, v: unknown): void => { if (Array.isArray(v)) { v.forEach((item) => scanPrivate(action, item)); return; } if (!isRecord(v)) return; for (const [key, child] of Object.entries(v)) { if (opaquePrivateFields.has(key)) continue; if (privateFieldDenylist.test(key) || (key === "name" && !operationalMetadataActions.has(action))) throw new Error("Health Administration accepts encrypted private fields only."); scanPrivate(action, child); } };
function validateCipher(v: unknown): void { if (typeof v !== "string" || !BASE64.test(v)) throw new Error("Encrypted private fields are malformed."); }
function validatePrivate(action: HealthAdminAction, p: HealthAdminRecord): void { if (!privateActions.has(action)) return; if (action === "configure_private_key") return; if (typeof p.nonce === "string" || typeof p.ciphertext === "string") { validateCipher(p.nonce); validateCipher(p.ciphertext); if (typeof p.nonce !== "string" || typeof p.ciphertext !== "string" || decodedLength(p.nonce) !== 12 || decodedLength(p.ciphertext) < 16) throw new Error("Encrypted private fields are malformed."); } else if (action !== "audit_sensitive_export" && action !== "register_patient") throw new Error("Encrypted private fields are required."); }
function validateDecimals(p: HealthAdminRecord): void { for (const [k, v] of Object.entries(p)) if (["amount_tzs", "total_amount_tzs", "paid_amount_tzs"].includes(k) && (typeof v !== "string" || !MONEY.test(v))) throw new Error("Amounts must be exact decimal strings."); else if (["quantity", "requested_quantity", "received_quantity", "available_quantity"].includes(k) && (typeof v !== "string" || !QUANTITY.test(v))) throw new Error("Quantities must be exact decimal strings."); }

export const officeHealthAdminResidencyApi = {
  async command<T extends HealthAdminRecord = HealthAdminRecord>(client: HealthAdminClient, workspaceId: string, action: HealthAdminResidencyAction, payload: HealthAdminResidencyPayload): Promise<T> {
    checkWorkspace(workspaceId);
    const keys = action === "record_approval" ? ["reference", "expected_version", "idempotency_key"] : action === "verify_approval" ? ["decision", "expected_version", "idempotency_key"] : ["enabled", "expected_version", "idempotency_key"];
    if (Object.keys(payload).sort().join(",") !== [...keys].sort().join(",")) throw new Error("Residency command has unsupported fields.");
    if (!Number.isSafeInteger(payload.expected_version) || payload.expected_version < 0) throw new Error("A valid expected version is required.");
    if (typeof payload.idempotency_key !== "string" || !UUID.test(payload.idempotency_key)) throw new Error("A valid Health Administration request key is required.");
    if (action === "record_approval") { const reference = (payload as Extract<HealthAdminResidencyPayload, { reference: string }>).reference; if (typeof reference !== "string" || reference.trim().length < 1 || reference.length > 500) throw new Error("A real approval document reference is required."); }
    if (action === "verify_approval") { const decision = (payload as Extract<HealthAdminResidencyPayload, { decision: string }>).decision; if (decision !== "approved" && decision !== "rejected") throw new Error("A valid approval decision is required."); }
    if (action === "set_clinical_gate" && typeof (payload as Extract<HealthAdminResidencyPayload, { enabled: boolean }>).enabled !== "boolean") throw new Error("A boolean clinical gate value is required.");
    const data = await rpc(client, "office_health_admin_residency_command", { p_workspace_id: workspaceId, p_action: action, p_payload: payload });
    if (!isRecord(data) || !Number.isSafeInteger(data.version) || (data.version as number) < 1) throw new Error("Health Administration returned a malformed residency confirmation.");
    return data as T;
  },
};

export const officeHealthAdminApi = {
  async read<T extends HealthAdminRecord = HealthAdminRecord>(client: HealthAdminClient, workspaceId: string, resource: HealthAdminResource, filter: HealthAdminRecord = {}, limit = 100, offset = 0, purpose?: HealthAdminAccessPurpose): Promise<HealthAdminPage<T> | HealthAdminBootstrap> {
    checkWorkspace(workspaceId); if (!HEALTH_ADMIN_RESOURCES.includes(resource)) throw new Error("Unknown Health Administration resource."); if (!isRecord(filter) || Object.keys(filter).some(k => !safeFilterKeys.has(k))) throw new Error("Health Administration filters are restricted."); if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !nonnegative(offset)) throw new Error("Invalid Health Administration pagination."); if (resource !== "bootstrap" && (!purpose || !HEALTH_ADMIN_PURPOSES.includes(purpose))) throw new Error("A valid Health Administration access purpose is required.");
    const data = await rpc(client, "office_health_admin_read", { p_workspace_id: workspaceId, p_resource: resource, p_filter: filter, p_limit: limit, p_offset: offset, p_purpose_code: purpose ?? null });
    if (resource === "bootstrap") { if (!isHealthAdminBootstrap(data)) throw new Error("Health Administration returned malformed access data."); return { ...data, storage_ready: data.clinical_data_enabled === true && data.storage_review_state === "approved" }; }
    if (!validPage(data) || data.limit !== limit || data.offset !== offset) throw new Error("Health Administration returned malformed record pagination."); for (const row of data.rows) validateDecimals(row); return data as HealthAdminPage<T>;
  },
  async command<T extends HealthAdminRecord = HealthAdminRecord>(client: HealthAdminClient, workspaceId: string, action: HealthAdminAction, payload: HealthAdminRecord): Promise<T> {
    checkWorkspace(workspaceId); if (!Object.prototype.hasOwnProperty.call(fields, action)) throw new Error("Unknown Health Administration action."); if (!isRecord(payload)) throw new Error("Health Administration command data must be an object."); const allowed = new Set([...fields[action], "idempotency_key"]); if (Object.keys(payload).some(k => !allowed.has(k))) throw new Error("Health Administration command has unsupported fields."); if (typeof payload.idempotency_key !== "string" || !UUID.test(payload.idempotency_key)) throw new Error("A valid Health Administration request key is required."); if (action !== "audit_sensitive_export" && (!Number.isSafeInteger(payload.expected_version) || (payload.expected_version as number) < 0)) throw new Error("A valid expected version is required."); scanPrivate(action, payload); validatePrivate(action, payload); validateDecimals(payload);
    const data = await rpc(client, "office_health_admin_command", { p_workspace_id: workspaceId, p_action: action, p_payload: payload }); if (!isRecord(data) || typeof data.id !== "string" || !UUID.test(data.id) || !Number.isSafeInteger(data.version) || (data.version as number) < 1) throw new Error("Health Administration returned a malformed save confirmation."); return data as T;
  },
  async auditExport(client: HealthAdminClient, workspaceId: string, resource: HealthAdminResource, entityIds: string[], format: "csv" | "pdf" | "print", purpose: HealthAdminAccessPurpose): Promise<void> { checkWorkspace(workspaceId); if (!HEALTH_ADMIN_RESOURCES.includes(resource) || !Array.isArray(entityIds) || entityIds.length < 1 || entityIds.length > 1000 || entityIds.some(id => !UUID.test(id)) || !["csv", "pdf", "print"].includes(format) || purpose !== "authorized_export") throw new Error("Invalid Health Administration export request."); await this.command(client, workspaceId, "audit_sensitive_export", { resource, entity_ids: entityIds, format, purpose_code: purpose, idempotency_key: crypto.randomUUID() }); },
  async patientLookup(client: HealthAdminClient, workspaceId: string, kind: string, digest: string, purpose: HealthAdminAccessPurpose, limit = 100, offset = 0): Promise<HealthAdminPage> { checkWorkspace(workspaceId); if (!["facility_mrn", "national_id", "passport", "phone"].includes(kind) || typeof digest !== "string" || !BASE64.test(digest)) throw new Error("Invalid patient lookup."); return this.read(client, workspaceId, "patient_matches", { index_type: kind, digest }, limit, offset, purpose) as Promise<HealthAdminPage>; },
};
