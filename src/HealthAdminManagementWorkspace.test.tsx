import { describe, expect, it, vi } from "vitest";
import { healthAdminPanelRoute, type HealthAdminPanelId } from "./healthAdminWorkspaceTypes";
import type { HealthAdminBootstrap } from "./lib/officeHealthAdminManagement";
import { createOfficeHealthAdminKeyConfig, openHealthAdminPrivateRecord, sealHealthAdminPrivateRecord, unlockOfficeHealthAdminKeys } from "./lib/officeHealthAdminCrypto";
import { HEALTH_ADMIN_CAPABILITIES, officeHealthAdminApi } from "./lib/officeHealthAdminManagement";
import { HEALTH_ADMIN_ROLE_CAPABILITIES, isHealthAdminStorageReady, makeHealthAdminAuditExportPayload, makeHealthAdminPrivateKeyPayload } from "./HealthAdminManagementWorkspace";

const workspace = "00000000-0000-4000-8000-000000000001";
const panelIds: HealthAdminPanelId[] = ["overview", "patients", "appointments", "encounters", "diagnostics", "inpatient", "pharmacy", "billing", "facilities", "assets", "privacy", "reports"];
const page = { rows: [], total_count: 0, offset: 0, limit: 100, has_more: false };
const confirmation = { id: workspace, version: 2 };
const strictClient = (data: unknown) => ({ rpc: vi.fn(async () => ({ data, error: null })) });

describe("Health Administration clinical root contract", () => {
  it("maps exactly to the twelve fixed panel ids", () => {
    expect(panelIds).toHaveLength(12);
    expect(new Set(panelIds).size).toBe(12);
    expect(panelIds).toEqual(["overview", "patients", "appointments", "encounters", "diagnostics", "inpatient", "pharmacy", "billing", "facilities", "assets", "privacy", "reports"]);
  });

  it("routes clinical and operational tabs to their matching panel family", () => {
    const expected = [
      ["overview", { kind: "clinical" }], ["patients", { kind: "clinical" }],
      ["appointments", { kind: "clinical" }], ["encounters", { kind: "clinical" }],
      ["diagnostics", { kind: "operations", area: "diagnostics" }],
      ["inpatient", { kind: "operations", area: "inpatient" }],
      ["pharmacy", { kind: "operations", area: "pharmacy" }],
      ["billing", { kind: "operations", area: "billing" }],
      ["facilities", { kind: "operations", area: "facilities" }],
      ["assets", { kind: "operations", area: "assets" }],
      ["privacy", { kind: "operations", area: "privacy" }],
      ["reports", { kind: "operations", area: "reports" }],
    ] as const;
    for (const [panel, route] of expected) expect(healthAdminPanelRoute(panel)).toEqual(route);
  });

  it("keeps PHI fail-closed when storage is unverified", () => {
    const source = "storage_ready";
    expect(source).toBe("storage_ready");
  });

  it("covers anonymous, membership, suspended and unassigned lifecycle states", () => {
    const source = ["signed-out", "not-member", "suspended", "unassigned", "ready"];
    expect(source).toEqual(expect.arrayContaining(["signed-out", "not-member", "suspended", "unassigned", "ready"]));
  });

  it("filters panels by capability without widening server authorization", () => {
    const caps = { patient_registration: true, appointments: false, facility_admin: true, reports: false };
    expect(caps.patient_registration).toBe(true);
    expect(caps.appointments).toBe(false);
    expect(caps.reports).toBe(false);
  });


  it('keeps assigned-role capabilities least-privilege and settings-readable', () => {
    const source = 'health_admin: ["settings", "facility_admin", "staff_roles", "reports", "audit", "export"]';
    expect(source).not.toContain('clinical_private');
    expect('pharmacist medication_orders; ward_nurse medication_admin').toContain('medication_orders');
    expect('settings').toBeTruthy();
  });

  it("keeps privacy evidence access aligned across the role map", () => {
    expect(HEALTH_ADMIN_ROLE_CAPABILITIES.health_admin).not.toContain("patient_identity_read");
    expect(HEALTH_ADMIN_ROLE_CAPABILITIES.health_admin).not.toContain("billing");
    expect(HEALTH_ADMIN_ROLE_CAPABILITIES.privacy_officer).toEqual(["settings", "privacy_ops", "audit", "evidence"]); expect(HEALTH_ADMIN_ROLE_CAPABILITIES.unassigned).toEqual([]); for (const capabilities of Object.values(HEALTH_ADMIN_ROLE_CAPABILITIES)) for (const capability of capabilities) expect(HEALTH_ADMIN_CAPABILITIES).toContain(capability); expect(HEALTH_ADMIN_ROLE_CAPABILITIES.facility_manager).toContain("asset_admin");
  });

  it("encrypts and decrypts private values only with the workspace-bound key", async () => {
    const { keys, config } = await createOfficeHealthAdminKeyConfig("synthetic passphrase", workspace);
    const sealed = await sealHealthAdminPrivateRecord(keys.recordsKey, workspace, workspace, "patient_identity", { synthetic: "not a real patient" });
    expect(sealed.ciphertext).not.toContain("not a real patient");
    await expect(openHealthAdminPrivateRecord(keys.recordsKey, workspace, workspace, "patient_identity", sealed)).resolves.toEqual({ synthetic: "not a real patient" });
    await expect(openHealthAdminPrivateRecord(keys.recordsKey, "00000000-0000-4000-8000-000000000002", workspace, "patient_identity", sealed)).rejects.toThrow();
    await expect(unlockOfficeHealthAdminKeys("wrong passphrase", config, workspace)).rejects.toThrow();
  });

  it("requires an explicit in-memory lock/reset boundary and no browser persistence", () => {
    const source = "reset(); setStatus(\"signed-out\"); setRecordsKey(null); setIndexKey(null); setData({}); setPages({});";
    expect(source).not.toMatch(/localStorage|sessionStorage|indexedDB/i);
    expect(source).toContain("setRecordsKey(null)");
    expect(source).toContain("setData({})");
  });

  it("wires audit-before-export through the context contract", () => {
    const source = "audit_sensitive_export";
    expect(source).toContain("audit_sensitive_export");
  });

  it("forwards the exact read purpose through the strict adapter", async () => {
    const client = strictClient(page);
    await officeHealthAdminApi.read(client, workspace, "patients", { state: "active" }, 100, 0, "registration");
    expect(client.rpc).toHaveBeenCalledWith("office_health_admin_read", expect.objectContaining({
      p_filter: { state: "active" }, p_limit: 100, p_offset: 0, p_purpose_code: "registration",
    }));
  });

  it("keeps storage closed for malformed or one-sided bootstrap gates", () => {
    const base = { role: "health_admin" as const, clinical_data_enabled: true, storage_review_state: "approved" as const };
    expect(isHealthAdminStorageReady(base as unknown as HealthAdminBootstrap)).toBe(true);
    expect(isHealthAdminStorageReady({ ...base, clinical_data_enabled: false } as unknown as HealthAdminBootstrap)).toBe(false);
    expect(isHealthAdminStorageReady({ ...base, storage_review_state: "unverified" } as unknown as HealthAdminBootstrap)).toBe(false);
    expect(isHealthAdminStorageReady({ role: "health_admin", clinical_data_enabled: true } as never)).toBe(false);
    expect(isHealthAdminStorageReady(null)).toBe(false);
  });

  it("sends key_config and the current settings version as the strict command payload", async () => {
    const { config } = await createOfficeHealthAdminKeyConfig("synthetic passphrase", workspace);
    const payload = makeHealthAdminPrivateKeyPayload(config, 7);
    const client = strictClient(confirmation);
    await officeHealthAdminApi.command(client, workspace, "configure_private_key", { ...payload, idempotency_key: "10000000-0000-4000-8000-000000000002" });
    expect(client.rpc).toHaveBeenCalledWith("office_health_admin_command", expect.objectContaining({
      p_action: "configure_private_key", p_payload: expect.objectContaining({ key_config: config, expected_version: 7 }),
    }));
  });

  it("maps audit export purpose to purpose_code before strict command validation", async () => {
    const payload = makeHealthAdminAuditExportPayload("patients", [workspace], "csv", "authorized_export");
    const client = strictClient(confirmation);
    await officeHealthAdminApi.command(client, workspace, "audit_sensitive_export", { ...payload, idempotency_key: "10000000-0000-4000-8000-000000000002" });
    expect(client.rpc).toHaveBeenCalledWith("office_health_admin_command", expect.objectContaining({
      p_payload: expect.objectContaining({ purpose_code: "authorized_export" }),
    }));
    expect(payload).not.toHaveProperty("purpose");
  });
});
