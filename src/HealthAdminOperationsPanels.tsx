import { useEffect, useMemo, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useFrostedConfirm } from "./FrostedConfirm";
import type { HealthAdminPanelProps, HealthAdminPrivateScope } from "./healthAdminWorkspaceTypes";
import { HEALTH_ADMIN_COMMAND_FIELDS, type HealthAdminAction } from "./lib/officeHealthAdminManagement";
import type { HealthAdminAccessPurpose, HealthAdminRecord, HealthAdminResource } from "./lib/officeHealthAdminManagement";
import HealthAdminResidencyApprovalPanel from "./HealthAdminResidencyApprovalPanel";

export const RESOURCES = {
  diagnostics: ["diagnostic_orders", "specimens", "diagnostic_results"],
  inpatient: ["wards", "beds", "admissions", "transfers", "procedures", "discharges", "follow_ups"],
  pharmacy: ["medication_orders", "medication_administrations", "medicine_items", "medicine_lots", "stock_movements", "replenishment_requests"],
  billing: ["invoices", "payments", "payer_accreditations", "claims"],
  facilities: ["facilities", "departments", "licenses", "staff_roles", "staff_credentials"],
  assets: ["assets", "asset_maintenance"],
  privacy: ["privacy_incidents", "data_requests", "disclosures", "external_workflows", "evidence"],
  reports: ["audit", "facility_report", "clinical_report", "diagnostic_report", "pharmacy_report", "inpatient_report", "billing_report", "claims_report", "compliance_report", "staff_report"],
} as const;
export type Area = keyof typeof RESOURCES;
type Row = HealthAdminRecord;
type Props = HealthAdminPanelProps & { area?: Area };
type Capability = keyof Props["context"]["capabilities"];
type Field = { name: string; label: string; kind?: "text" | "date" | "decimal2" | "decimal6" | "private" | "select" | "relation"; resource?: HealthAdminResource; options?: string[]; required?: boolean };
type Workflow = { action: HealthAdminAction; label: string; resource: HealthAdminResource; capability: Capability; roles?: string[]; fields: Field[]; scope?: HealthAdminPrivateScope };

const CAPABILITY: Record<Area, Capability> = { diagnostics: "diagnostic_results", inpatient: "inpatient", pharmacy: "pharmacy_dispense", billing: "billing", facilities: "facility_admin", assets: "asset_admin", privacy: "privacy_ops", reports: "reports" };
export const EVIDENCE_ENTITY_TYPE_OPTIONS = ["privacy_incident"] as const;
export const ROLE_CAPABILITIES: Record<string, Capability[]> = {
  health_admin: ["settings", "facility_admin", "staff_roles", "reports", "audit", "export"], facility_manager: ["settings", "facility_admin", "licenses", "asset_admin", "inventory", "reports"],
  registration_clerk: ["settings", "patient_registration", "patient_identity_read", "appointments", "encounters"], triage_nurse: ["settings", "patient_identity_read", "triage", "appointments", "encounters"],
  lab_staff: ["settings", "patient_identity_read", "diagnostic_orders", "diagnostic_results"], pharmacist: ["settings", "patient_identity_read", "pharmacy_dispense", "inventory", "medication_orders"],
  ward_nurse: ["settings", "patient_identity_read", "inpatient", "medication_admin"], clinician: ["settings", "patient_registration", "patient_identity_read", "clinical_notes", "diagnostic_orders", "diagnostic_results", "medication_orders", "procedures", "discharge", "encounters", "inpatient"],
  billing_clerk: ["settings", "patient_identity_read", "billing", "claims"], credentialing_officer: ["settings", "credentialing", "staff_roles"], privacy_officer: ["settings", "privacy_ops", "audit", "evidence"], health_auditor: ["settings", "audit", "reports"], health_viewer: ["settings", "reports"], unassigned: [],
};
const SOURCE_LINKS = { mainland: [["HFRS", "https://hfrportal.moh.go.tz/web/index.php?r=site%2Fabout"], ["MCT", "https://www.mct.go.tz/index.php/registration-licensing/licensing/practicing-license"], ["TNMC", "https://tnmcis.tnmc.go.tz/practitioners/search"], ["Pharmacy Council", "https://www.pc.go.tz/"], ["NHIF Self Service", "https://selfservice.nhif.or.tz/"], ["NHIF Verification ServicePortal", "https://verification.nhif.or.tz/ServicePortal/"], ["MoH DHIS", "https://dhis.moh.go.tz/"], ["eLMIS/OpenLMIS", "https://elmis.moh.go.tz/"], ["MSD LMS", "https://www.msd.go.tz/en/media-center/news/msd-and-dar-es-salaam-regional-health-leadership-discuss-strengthening-the-health-commodities-supply-chain/"], ["TMDA pharmacovigilance", "https://www.tmda.go.tz/pages/paper-based-system-for-submission-of-adverse-drug-reaction"]], zanzibar: [["Ministry of Health Zanzibar", "https://mohz.go.tz/"]] } as const;
export const PRIVATE_SCOPES: Record<Area, HealthAdminPrivateScope> = { diagnostics: "diagnostic", inpatient: "inpatient", pharmacy: "pharmacy", billing: "billing_claims", facilities: "workforce_private", assets: "privacy_private", privacy: "privacy_private", reports: "clinical" };
export const AREA_CAPABILITY = (area: Area) => CAPABILITY[area];
export const MANUAL_SOURCE_LINKS = SOURCE_LINKS;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const REPORT_COLUMNS: Record<string, readonly string[]> = {
  audit: ["id", "resource", "action", "purpose_code", "format", "status", "created_at"],
  facility_report: ["id", "facility_id", "facility_type", "district", "region", "ownership", "state", "created_at"],
  clinical_report: ["id", "facility_id", "department_id", "encounter_type", "state", "created_at"],
  diagnostic_report: ["id", "facility_id", "order_type", "state", "created_at"],
  pharmacy_report: ["id", "facility_id", "movement_type", "state", "quantity", "requested_quantity", "received_quantity", "created_at"],
  inpatient_report: ["id", "facility_id", "state", "created_at"],
  billing_report: ["id", "facility_id", "amount_tzs", "state", "created_at"],
  claims_report: ["id", "facility_id", "amount_tzs", "state", "created_at"],
  compliance_report: ["id", "facility_id", "status", "severity", "created_at"],
  staff_report: ["id", "facility_id", "profession", "council", "state", "created_at"],
};
export function safeReportRows(resource: HealthAdminResource, rows: Row[]) {
  const columns = REPORT_COLUMNS[resource] ?? [];
  return rows.map((row) => Object.fromEntries(columns.filter((column) => Object.prototype.hasOwnProperty.call(row, column)).map((column) => [column, row[column]])));
}
export function reportEntityIds(rows: Row[]) { return rows.map((row) => row.id).filter((value): value is string => typeof value === "string" && UUID.test(value)); }

const id = () => globalThis.crypto?.randomUUID?.() ?? "00000000-0000-4000-8000-000000000001";
const asResource = (value: string) => value as HealthAdminResource;
const text = (row: Row, key: string) => row[key] === null || row[key] === undefined ? "—" : String(row[key]);
export const rowsFor = (context: Props["context"], resource: string) => context.data[asResource(resource)] ?? [];
export const exactDecimal = (value: string, scale: 2 | 6) => new RegExp(`^(?:0|[1-9]\\d{0,${scale === 2 ? 17 : 21}})(?:\\.\\d{1,${scale}})?$`).test(value);
export const canUse = (context: Props["context"], area: Area) => Boolean(context.storageReady && context.recordsKey && context.capabilities[CAPABILITY[area]] && (ROLE_CAPABILITIES[String(context.role)] ?? []).includes(CAPABILITY[area]));
export function operationIdentity(action: HealthAdminAction, selectedRow: Row | undefined, generatedId: string) {
  const selectedId = typeof selectedRow?.id === "string" ? selectedRow.id : undefined;
  const expectedVersion = Number(selectedRow?.version ?? 1);
  if (action === "record_payment") return { id: generatedId, invoice_id: selectedId, expected_version: expectedVersion };
  if (action === "record_claim_response") return { id: generatedId, claim_id: selectedId, expected_version: expectedVersion };
  return { id: selectedId ?? generatedId, expected_version: expectedVersion };
}

function Card({ title, children }: { title: string; children: ReactNode }) { return <section className="health-admin-card"><h3>{title}</h3>{children}</section>; }
function Notice({ children, tone = "status" }: { children: ReactNode; tone?: "status" | "alert" }) { return <div className="health-admin-alert" role={tone}>{children}</div>; }
function Button({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button type="button" className="health-admin-button" {...props}>{children}</button>; }
function RowPicker({ rows, label, value, onChange, required = true }: { rows: Row[]; label: string; value: string; onChange: (value: string) => void; required?: boolean }) { return <label><span>{label}</span><select required={required} value={value} onChange={(e) => onChange(e.target.value)}><option value="">Select a loaded record</option>{rows.map((row) => <option key={String(row.id)} value={String(row.id)}>{text(row, "display_label") !== "—" ? text(row, "display_label") : `${text(row, "state")} · ${String(row.id).slice(0, 8)}`}</option>)}</select></label>; }

export async function sealPayload(context: Props["context"], recordId: string, scope: HealthAdminPrivateScope, value: Record<string, unknown>) { if (!context.storageReady || !context.recordsKey) throw new Error("Private records are unavailable while storage is unapproved or the key is locked."); const sealed = await context.sealPrivate(recordId, scope, value); return { nonce: sealed.nonce, ciphertext: sealed.ciphertext }; }

const relation = (name: string, label: string, resource: HealthAdminResource): Field => ({ name, label, kind: "relation", resource });
const privateField = (label: string): Field => ({ name: "private_text", label, kind: "private", required: true });
const common = (name: string, label: string, kind: Field["kind"] = "text"): Field => ({ name, label, kind, required: true });
const workflows: Record<Area, Workflow[]> = {
  diagnostics: [
    { action: "create_diagnostic_order", label: "Create diagnostic order", resource: "diagnostic_orders", capability: "diagnostic_orders", roles: ["clinician"], scope: "diagnostic", fields: [relation("encounter_id", "Loaded encounter", "encounters"), common("order_type", "Order type"), common("state", "State"), privateField("Clinical order details")] },
    { action: "create_specimen", label: "Create specimen", resource: "specimens", capability: "diagnostic_orders", fields: [relation("order_id", "Loaded diagnostic order", "diagnostic_orders"), common("barcode", "Barcode"), common("state", "State")] },
    { action: "record_specimen_handoff", label: "Record specimen handoff", resource: "specimens", capability: "diagnostic_orders", fields: [common("state", "Handoff state"), common("mode", "Handoff mode"), common("reason", "Reason")] },
    { action: "record_diagnostic_result", label: "Record diagnostic result", resource: "diagnostic_results", capability: "diagnostic_results", scope: "diagnostic", fields: [relation("order_id", "Loaded diagnostic order", "diagnostic_orders"), privateField("Result content")] },
    { action: "approve_diagnostic_result", label: "Approve diagnostic result", resource: "diagnostic_results", capability: "diagnostic_results", fields: [common("state", "Approval state"), common("reason", "Reason")] },
    { action: "deliver_diagnostic_result", label: "Deliver diagnostic result", resource: "diagnostic_results", capability: "diagnostic_results", fields: [common("state", "Delivery state"), common("reason", "Reason")] },
  ],
  inpatient: [
    { action: "save_ward", label: "Save ward", resource: "wards", capability: "inpatient", fields: [relation("facility_id", "Loaded facility", "facilities"), common("name", "Ward name"), common("state", "State")] },
    { action: "save_bed", label: "Save bed", resource: "beds", capability: "inpatient", fields: [relation("ward_id", "Loaded ward", "wards"), common("label", "Bed label"), common("state", "State")] },
    { action: "admit_patient", label: "Admit patient", resource: "admissions", capability: "inpatient", scope: "inpatient", fields: [relation("patient_id", "Loaded patient", "patients"), common("state", "Admission state"), privateField("Admission details")] },
    { action: "assign_bed", label: "Assign bed", resource: "beds", capability: "inpatient", fields: [relation("admission_id", "Loaded admission", "admissions"), relation("bed_id", "Loaded bed", "beds")] },
    { action: "transfer_patient", label: "Transfer patient", resource: "transfers", capability: "inpatient", fields: [relation("admission_id", "Loaded admission", "admissions"), relation("from_bed_id", "Current loaded bed", "beds"), relation("to_bed_id", "Destination loaded bed", "beds"), common("reason", "Reason")] },
    { action: "save_procedure", label: "Record procedure", resource: "procedures", capability: "procedures", scope: "inpatient", fields: [relation("encounter_id", "Loaded encounter", "encounters"), common("state", "Procedure state"), privateField("Procedure details")] },
    { action: "save_discharge", label: "Prepare discharge", resource: "discharges", capability: "discharge", scope: "inpatient", fields: [relation("encounter_id", "Loaded encounter", "encounters"), privateField("Discharge details")] },
    { action: "finalize_discharge", label: "Finalize discharge", resource: "discharges", capability: "discharge", fields: [common("state", "Discharge state"), common("reason", "Reason")] },
    { action: "save_follow_up", label: "Record follow-up", resource: "follow_ups", capability: "inpatient", scope: "inpatient", fields: [relation("patient_id", "Loaded patient", "patients"), common("state", "Follow-up state"), privateField("Follow-up details")] },
  ],
  pharmacy: [
    { action: "create_medication_order", label: "Create medication order", resource: "medication_orders", capability: "medication_orders", roles: ["clinician"], scope: "pharmacy", fields: [relation("encounter_id", "Loaded encounter", "encounters"), common("state", "Order state"), privateField("Order details")] },
    { action: "record_medication_administration", label: "Record administration", resource: "medication_administrations", capability: "medication_admin", scope: "pharmacy", fields: [relation("order_id", "Loaded medication order", "medication_orders"), privateField("Administration details")] },
    { action: "save_medicine_item", label: "Save medicine item", resource: "medicine_items", capability: "inventory", fields: [common("product_code", "Product code"), common("product_description", "Product description"), common("strength", "Strength"), common("form", "Form"), common("unit", "Unit"), common("regulator_reference", "Regulator reference"), common("status", "Status")] },
    { action: "receive_medicine_lot", label: "Receive medicine lot", resource: "medicine_lots", capability: "inventory", fields: [relation("item_id", "Loaded medicine item", "medicine_items"), relation("facility_id", "Loaded facility", "facilities"), common("lot_reference", "Lot reference"), common("expiry_date", "Expiry date", "date"), common("received_quantity", "Received quantity", "decimal6"), common("state", "State")] },
    { action: "record_stock_movement", label: "Record stock movement", resource: "stock_movements", capability: "inventory", fields: [relation("lot_id", "Loaded medicine lot", "medicine_lots"), common("movement_type", "Movement type"), common("quantity", "Quantity", "decimal6"), common("movement_date", "Movement date", "date"), common("reason", "Reason"), common("reference", "Reference")] },
    { action: "quarantine_medicine_lot", label: "Quarantine lot", resource: "medicine_lots", capability: "inventory", fields: [common("reason", "Reason")] },
    { action: "dispose_medicine_lot", label: "Dispose lot", resource: "medicine_lots", capability: "inventory", fields: [common("reason", "Reason"), common("disposal_date", "Disposal date", "date")] },
    { action: "create_replenishment_request", label: "Request replenishment", resource: "replenishment_requests", capability: "inventory", fields: [relation("facility_id", "Loaded facility", "facilities"), relation("item_id", "Loaded medicine item", "medicine_items"), common("requested_quantity", "Requested quantity", "decimal6"), common("state", "State"), common("reason", "Reason"), common("reference", "Reference")] },
  ],
  billing: [
    { action: "save_invoice", label: "Save invoice", resource: "invoices", capability: "billing", scope: "billing_claims", fields: [relation("patient_id", "Loaded patient", "patients"), relation("facility_id", "Loaded facility", "facilities"), common("amount_tzs", "Amount (exact TZSh decimal)", "decimal2"), common("state", "Invoice state"), privateField("Invoice details")] },
    { action: "record_payment", label: "Record payment", resource: "invoices", capability: "billing", fields: [common("amount_tzs", "Amount (exact TZSh decimal)", "decimal2"), common("state", "Payment state"), common("reference", "Reference")] },
    { action: "save_payer_accreditation", label: "Save payer accreditation", resource: "payer_accreditations", capability: "billing", fields: [relation("facility_id", "Loaded facility", "facilities"), common("payer", "Payer"), common("status", "Status"), common("source_url", "Source URL"), common("official_reference", "Official reference")] },
    { action: "create_claim", label: "Create claim", resource: "claims", capability: "claims", scope: "billing_claims", fields: [relation("invoice_id", "Loaded invoice", "invoices"), common("amount_tzs", "Amount (exact TZSh decimal)", "decimal2"), common("state", "Claim state"), privateField("Claim details")] },
    { action: "record_claim_response", label: "Record claim response", resource: "claims", capability: "claims", scope: "billing_claims", fields: [common("state", "Response state"), common("reason", "Reason"), privateField("Response details")] },
  ],
  facilities: [
    { action: "save_facility", label: "Save facility", resource: "facilities", capability: "facility_admin", fields: [common("facility_code", "Facility code"), common("display_name", "Display name"), common("facility_type", "Facility type"), common("district", "District"), common("region", "Region"), common("ownership", "Ownership"), common("state", "State"), common("source_url", "Source URL"), common("official_reference", "Official reference")] },
    { action: "save_department", label: "Save department", resource: "departments", capability: "facility_admin", fields: [relation("facility_id", "Loaded facility", "facilities"), common("name", "Department name"), common("code", "Code"), common("state", "State")] },
    { action: "save_license", label: "Save license", resource: "licenses", capability: "licenses", fields: [relation("facility_id", "Loaded facility", "facilities"), common("authority", "Authority"), common("license_kind", "License kind"), common("reference", "Reference"), common("issue_date", "Issue date", "date"), common("due_date", "Due date", "date"), common("status", "Status"), common("official_url", "Official URL")] },
    { action: "assign_staff_role", label: "Assign workforce role", resource: "staff_roles", capability: "staff_roles", fields: [common("user_id", "Loaded staff user"), common("role", "Health role")] },
    { action: "assign_facility_scope", label: "Assign facility scope", resource: "staff_roles", capability: "staff_roles", fields: [relation("staff_role_id", "Loaded staff role", "staff_roles"), relation("facility_id", "Loaded facility", "facilities"), relation("department_id", "Loaded department", "departments")] },
    { action: "save_staff_credential", label: "Save staff credential", resource: "staff_credentials", capability: "credentialing", scope: "workforce_private", fields: [relation("facility_id", "Loaded facility", "facilities"), common("staff_code", "Staff code"), common("profession", "Profession"), common("council", "Council"), common("issue_date", "Issue date", "date"), common("expiry_date", "Expiry date", "date"), common("state", "State"), common("verifier_source", "Verifier source"), common("verifier_reference", "Verifier reference"), privateField("Credential details")] },
  ],
  assets: [
    { action: "save_asset", label: "Save asset", resource: "assets", capability: "asset_admin", fields: [relation("facility_id", "Loaded facility", "facilities"), common("asset_type", "Asset type"), common("state", "State"), common("source_reference", "Source reference")] },
    { action: "record_asset_maintenance", label: "Record maintenance", resource: "asset_maintenance", capability: "asset_admin", fields: [relation("asset_id", "Loaded asset", "assets"), common("state", "Maintenance state"), common("maintenance_date", "Maintenance date", "date"), common("reason", "Reason")] },
  ],
  privacy: [
    { action: "save_privacy_incident", label: "Save privacy incident", resource: "privacy_incidents", capability: "privacy_ops", fields: [common("incident_reference", "Incident reference"), common("incident_date", "Incident date", "date"), common("severity", "Severity"), common("status", "Status"), common("source_reference", "Source reference")] },
    { action: "save_data_request", label: "Save data request", resource: "data_requests", capability: "privacy_ops", fields: [common("request_type", "Request type"), common("request_date", "Request date", "date"), common("status", "Status"), common("reference", "Reference")] },
    { action: "log_disclosure", label: "Log disclosure", resource: "disclosures", capability: "privacy_ops", fields: [common("recipient_category", "Recipient category"), common("purpose", "Purpose"), common("disclosure_date", "Disclosure date", "date"), common("outcome", "Outcome"), common("reference", "Reference")] },
    { action: "save_external_workflow", label: "Record manual external workflow", resource: "external_workflows", capability: "privacy_ops", fields: [common("authority", "Authority"), common("workflow_type", "Workflow type"), common("state", "State"), common("source_url", "Manual source URL"), common("reference", "Reference")] },
    { action: "link_evidence", label: "Link evidence", resource: "evidence", capability: "evidence", fields: [{ name: "entity_type", label: "Related record type", kind: "select", options: [...EVIDENCE_ENTITY_TYPE_OPTIONS], required: true }, relation("entity_id", "Related privacy incident", "privacy_incidents"), common("label", "Evidence label"), common("source_url", "Source URL"), common("official_reference", "Official reference"), common("status", "Status")] },
  ],
  reports: [],
};

function fieldValue(fields: Record<string, string>, field: Field) { return fields[field.name] ?? ""; }
export const purposeFor = (resource: HealthAdminResource, area: Area): HealthAdminAccessPurpose => {
  if (resource === "patients" || resource === "facilities" || resource === "departments") return "registration";
  if (["encounters", "appointments", "queue_entries", "triage_events", "clinical_records", "procedures", "discharges", "follow_ups"].includes(resource)) return "direct_care";
  if (["diagnostic_orders", "specimens", "diagnostic_results", "diagnostic_report"].includes(resource)) return "laboratory";
  if (["medication_orders", "medication_administrations", "medicine_items", "medicine_lots", "stock_movements", "replenishment_requests", "pharmacy_report"].includes(resource)) return "pharmacy";
  if (["wards", "beds", "admissions", "transfers", "inpatient_report"].includes(resource)) return "ward_care";
  if (["invoices", "payments", "billing_report"].includes(resource)) return "billing";
  if (["claims", "claims_report"].includes(resource)) return "claims";
  if (["staff_credentials", "staff_roles", "staff_report"].includes(resource)) return "credential_review";
  if (area === "privacy" || ["privacy_incidents", "data_requests", "disclosures", "external_workflows", "evidence", "audit"].includes(resource)) return "privacy_review";
  return "aggregate_reporting";
};
function Operations({ context, area }: { context: Props["context"]; area: Area }) {
  const available = workflows[area].filter((item) => context.capabilities[item.capability] && (!item.roles || item.roles.includes(String(context.role)) || String(context.role) === "health_admin"));
  const [workflowName, setWorkflowName] = useState<string>(available[0]?.action ?? ""); const workflow = available.find((item) => item.action === workflowName) ?? available[0];
  const [selected, setSelected] = useState(""); const [values, setValues] = useState<Record<string, string>>({}); const [feedback, setFeedback] = useState(""); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false); const [loadError, setLoadError] = useState(""); const confirm = useFrostedConfirm();
  const rows = workflow ? rowsFor(context, workflow.resource) : []; const selectedRow = rows.find((row) => String(row.id) === selected); const allowed = canUse(context, area);
  const readResources = useMemo(() => workflow ? [workflow.resource, ...workflow.fields.filter((field) => field.kind === "relation" && field.resource).map((field) => field.resource!)] .filter((resource, index, all) => all.indexOf(resource) === index) : [], [workflow]);
  const readKey = readResources.join("|");
  useEffect(() => {
    let active = true;
    if (!workflow || !allowed || !context.storageReady || !context.recordsKey || !readResources.length) { setLoading(false); return () => { active = false; }; }
    setLoading(true); setLoadError("");
    void Promise.all(readResources.map((resource) => context.read(resource, {}, 0, purposeFor(resource, area))))
      .then(() => { if (active) setLoading(false); })
      .catch((error) => { if (active) { setLoading(false); setLoadError(error instanceof Error ? error.message : "Authorized records could not be loaded."); } });
    return () => { active = false; };
  }, [allowed, area, context.read, context.recordsKey, context.storageReady, readKey, workflow]);
  const set = (key: string, value: string) => setValues((old) => ({ ...old, [key]: value }));
  const submit = async (event: FormEvent) => { event.preventDefault(); if (busy || context.busy || !workflow || !allowed || !context.recordsKey) return; setBusy(true); const specialCreate = workflow.action === "record_payment" || workflow.action === "record_claim_response"; const entityId = specialCreate ? id() : selected || id(); const payload: Row = { ...operationIdentity(workflow.action, selectedRow, entityId) };
    try { for (const field of workflow.fields) { const value = fieldValue(values, field); if (field.required && !value) throw new Error(`${field.label} is required.`); if ((field.kind === "decimal2" && !exactDecimal(value, 2)) || (field.kind === "decimal6" && !exactDecimal(value, 6))) throw new Error(`${field.label} must remain an exact decimal string.`); if (field.kind === "private") continue; payload[field.name] = value; }
      const privateText = values.private_text; if (workflow.scope && privateText) Object.assign(payload, await sealPayload(context, entityId, workflow.scope, { prose: privateText }));
      if (selected && !["save_facility", "save_department", "save_ward", "save_bed", "save_license", "save_staff_credential", "save_medicine_item", "save_asset", "save_payer_accreditation"].includes(workflow.action)) { if (!(await confirm({ title: "Confirm human state transition", description: "This transition will be recorded in the immutable audit trail against the selected loaded record.", confirmLabel: "Record transition" }))) return; }
      await context.command(workflow.action, { ...payload, idempotency_key: id() }); setFeedback(`${workflow.label} saved for the selected resource.`); setValues({}); setSelected(""); await context.refresh();
    } catch (error) { setFeedback(error instanceof Error ? error.message : "The operation was not saved."); } finally { setBusy(false); } };
  if (!context.storageReady) return <Notice tone="alert">Clinical and sensitive operations are disabled until the deployment storage review is approved. No PHI was read or written.</Notice>;
  if (!allowed) return <Notice tone="alert">Your active role and capability do not permit this workspace area. Server authorization remains authoritative.</Notice>;
  if (!workflow) return <Notice tone="alert">No workflow is available for this role in this area.</Notice>;
  return <div className="health-admin-grid"><Card title={`${area.replaceAll("_", " ")} workflows`}><label><span>Specialist action</span><select value={workflow.action} onChange={(e) => { setWorkflowName(e.target.value); setSelected(""); setValues({}); }}>{available.map((item) => <option key={item.action} value={item.action}>{item.label}</option>)}</select></label>{loading && <Notice>Loading authorized records for this action…</Notice>}{loadError && <Notice tone="alert">{loadError}</Notice>}{!loading && !loadError && !rows.length && <Notice>No authorized loaded {workflow.resource.replaceAll("_", " ")} records were returned.</Notice>}<RowPicker rows={rows} label={`Selected loaded ${workflow.resource.replaceAll("_", " ")} (for transition)`} value={selected} onChange={setSelected} required={workflow.action.startsWith("transition_") || ["approve_diagnostic_result", "deliver_diagnostic_result", "record_specimen_handoff", "assign_bed", "transfer_patient", "finalize_discharge", "quarantine_medicine_lot", "dispose_medicine_lot", "record_asset_maintenance", "record_payment", "record_claim_response"].includes(workflow.action)} /><form onSubmit={(event) => void submit(event)}>{workflow.fields.map((field) => field.kind === "relation" ? <RowPicker key={field.name} rows={rowsFor(context, field.resource!)} label={field.label} value={fieldValue(values, field)} onChange={(value) => set(field.name, value)} /> : field.kind === "private" ? <label key={field.name}><span>{field.label} (encrypted before command)</span><textarea required={field.required} value={fieldValue(values, field)} onChange={(e) => set(field.name, e.target.value)} /></label> : field.kind === "select" ? <label key={field.name}><span>{field.label}</span><select required={field.required} value={fieldValue(values, field)} onChange={(e) => set(field.name, e.target.value)}><option value="">Select</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select></label> : <label key={field.name}><span>{field.label}</span><input required={field.required} type={field.kind === "date" ? "date" : "text"} inputMode={field.kind?.startsWith("decimal") ? "decimal" : undefined} value={fieldValue(values, field)} onChange={(e) => set(field.name, e.target.value)} /></label>)}<Button disabled={busy || context.busy || !context.recordsKey}>{busy ? "Saving…" : selected ? "Record selected transition" : workflow.label}</Button></form>{feedback && <Notice>{feedback}</Notice>}</Card><Card title="Operational boundary"><p className="health-admin-muted">This workspace records routing, inventory, administration and human lifecycle decisions. It does not diagnose, interpret results, choose treatment or dose, decide admission/discharge, or submit claims automatically.</p></Card></div>;
}

function ManualSources({ context }: { context: Props["context"] }) { const jurisdiction = String(context.data.settings?.[0]?.jurisdiction ?? "tanzania_mainland"); const links = jurisdiction === "zanzibar" ? SOURCE_LINKS.zanzibar : SOURCE_LINKS.mainland; return <Card title="Official sources — reference only"><p className="health-admin-muted">These are manual reference links only. No API connection, scraping, upload, or automatic claim submission is represented.</p><ul>{links.map(([name, url]) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{name}</a> <small>Manual reference link · not connected</small></li>)}</ul></Card>; }
function Reports({ context }: { context: Props["context"] }) { const [resource, setResource] = useState<HealthAdminResource>("audit"); const [feedback, setFeedback] = useState(""); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(false); const [loadError, setLoadError] = useState(""); const rows = rowsFor(context, resource); const ids = reportEntityIds(rows); const safe = safeReportRows(resource, rows);
  useEffect(() => { let active = true; if (!context.storageReady || !context.recordsKey || !context.capabilities.reports) { setLoading(false); return () => { active = false; }; } setLoading(true); setLoadError(""); void context.read(resource, {}, 0, resource === "audit" ? "privacy_review" : "aggregate_reporting").then(() => { if (active) setLoading(false); }).catch((error) => { if (active) { setLoading(false); setLoadError(error instanceof Error ? error.message : "The selected report could not be loaded."); } }); return () => { active = false; }; }, [context.capabilities.reports, context.read, context.recordsKey, context.storageReady, resource]);
  const exportRows = async () => { if (busy || context.busy) return; if (!context.storageReady || !context.capabilities.export || !rows.length) return setFeedback("No authorized loaded report rows are available."); if (!ids.length) return setFeedback("This report is view-only because it has no valid UUID entity IDs for an export audit."); setBusy(true); setFeedback(""); try { await context.auditExport(resource, ids, "csv", "authorized_export"); const columns = REPORT_COLUMNS[resource] ?? []; const csv = [columns.filter((column) => safe.some((row) => Object.prototype.hasOwnProperty.call(row, column))).join(","), ...safe.map((row) => columns.filter((column) => Object.prototype.hasOwnProperty.call(row, column)).map((column) => JSON.stringify(row[column] ?? "")).join(","))].filter((line, index) => index === 0 || line.length > 0).join("\n"); const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `health-report-${resource}.csv`; anchor.click(); URL.revokeObjectURL(url); setFeedback("CSV export audit succeeded before the downloadable artifact was created."); } catch (error) { setFeedback(error instanceof Error ? error.message : "Export audit failed; no artifact was created."); } finally { setBusy(false); } }; return <Card title="Reports and immutable audit"><label><span>Actual loaded report</span><select value={resource} onChange={(e) => setResource(e.target.value as HealthAdminResource)}>{RESOURCES.reports.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>{loading && <Notice>Loading authorized report rows…</Notice>}{loadError && <Notice tone="alert">{loadError}</Notice>}{!loading && !loadError && !rows.length && <Notice>No rows were returned for this report.</Notice>}<p className="health-admin-muted">Loaded rows: {rows.length}. No seeded totals or invented metrics. CSV contains only explicitly approved columns for this report. PDF and print exports are not offered.</p><Button onClick={() => void exportRows()} disabled={busy || context.busy || loading || !rows.length || !context.storageReady || !context.capabilities.export || !ids.length}>{busy ? "Auditing…" : "Audit and download CSV"}</Button>{feedback && <Notice>{feedback}</Notice>}</Card>; }

function HealthAdminOperationsPanelRoot({ context, area = "diagnostics" }: Props) { return <main aria-label="Health Administration operations">{area === "privacy" && <HealthAdminResidencyApprovalPanel context={context} />}{area === "reports" ? <Reports context={context} /> : <Operations context={context} area={area} />}{(area === "billing" || area === "privacy" || area === "facilities") && <ManualSources context={context} />}</main>; }
export const HealthAdminOperationsPanels = Operations;
export default HealthAdminOperationsPanelRoot;
export { HEALTH_ADMIN_COMMAND_FIELDS };
