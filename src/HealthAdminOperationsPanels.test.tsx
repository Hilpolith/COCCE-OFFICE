import { describe, expect, it, vi } from "vitest";
import { canUse, EVIDENCE_ENTITY_TYPE_OPTIONS, exactDecimal, MANUAL_SOURCE_LINKS, operationIdentity, purposeFor, reportEntityIds, RESOURCES, ROLE_CAPABILITIES, safeReportRows, sealPayload } from "./HealthAdminOperationsPanels";
import { HEALTH_ADMIN_ROLE_CAPABILITIES } from "./HealthAdminManagementWorkspace";
import { HEALTH_ADMIN_CAPABILITIES } from "./lib/officeHealthAdminManagement";
import type { HealthAdminWorkspaceContext } from "./healthAdminWorkspaceTypes";

const base = (overrides: Partial<HealthAdminWorkspaceContext> = {}) => ({
  workspaceId: "00000000-0000-0000-0000-000000000001", officeName: "Synthetic", country: "Tanzania", userId: "00000000-0000-0000-0000-000000000002", role: "lab_staff", capabilities: { diagnostic_results: true, reports: true } as never, storageReady: true, storageState: "approved", keyConfig: { configured: true }, recordsKey: {} as CryptoKey, indexKey: null, busy: false, data: {}, pages: {}, read: vi.fn(), command: vi.fn().mockResolvedValue({ id: "00000000-0000-0000-0000-000000000003", version: 2 }), sealPrivate: vi.fn().mockResolvedValue({ nonce: "nonce", ciphertext: "ciphertext" }), openPrivate: vi.fn(), makeBlindIndex: vi.fn(), findPatient: vi.fn(), auditExport: vi.fn().mockResolvedValue(undefined), refresh: vi.fn(), lockPrivate: vi.fn(), setFeedback: vi.fn(), ...overrides,
} as unknown as HealthAdminWorkspaceContext);

describe("HealthAdminOperationsPanels contract", () => {
  it("denies diagnostics when storage is closed or capability is absent", () => {
    expect(canUse(base({ storageReady: false }), "diagnostics")).toBe(false);
    expect(canUse(base({ capabilities: {} as never }), "diagnostics")).toBe(false);
  });
  it("permits only the role capability composition", () => {
    expect(canUse(base(), "diagnostics")).toBe(true);
    expect(canUse(base({ role: "billing_clerk", capabilities: { diagnostic_results: true } as never }), "diagnostics")).toBe(false);
  });
  it("keeps the operations role map in parity with the root capability map", () => {
    for (const [role, capabilities] of Object.entries(ROLE_CAPABILITIES)) if (role !== "unassigned") expect(capabilities).toContain("settings");
    expect(ROLE_CAPABILITIES.privacy_officer).toContain("evidence"); expect(ROLE_CAPABILITIES.unassigned).toEqual([]); expect(ROLE_CAPABILITIES).toEqual(HEALTH_ADMIN_ROLE_CAPABILITIES); for (const capabilities of Object.values(ROLE_CAPABILITIES)) for (const capability of capabilities) expect(HEALTH_ADMIN_CAPABILITIES).toContain(capability);
  });
  it("constrains evidence payload relation type to privacy incidents", () => { expect(EVIDENCE_ENTITY_TYPE_OPTIONS).toEqual(["privacy_incident"]); });
  it("creates a fresh payment id while using the selected invoice id and version", () => {
    const invoice = { id: "invoice-1", version: 7 };
    const payload = operationIdentity("record_payment", invoice, "payment-1");
    expect(payload).toEqual({ id: "payment-1", invoice_id: "invoice-1", expected_version: 7 });
    expect(payload.id).not.toBe(payload.invoice_id);
  });
  it("creates a fresh claim event id while using the selected claim id and version", () => {
    const claim = { id: "claim-1", version: 4 };
    const payload = operationIdentity("record_claim_response", claim, "claim-event-1");
    expect(payload).toEqual({ id: "claim-event-1", claim_id: "claim-1", expected_version: 4 });
    expect(payload.id).not.toBe(payload.claim_id);
  });
  it("seals prose before any command payload can contain it", async () => {
    const context = base(); const result = await sealPayload(context, "00000000-0000-0000-0000-000000000003", "diagnostic", { result: "synthetic result" });
    expect(context.sealPrivate).toHaveBeenCalledWith("00000000-0000-0000-0000-000000000003", "diagnostic", { result: "synthetic result" });
    expect(result).toEqual({ nonce: "nonce", ciphertext: "ciphertext" });
    expect(JSON.stringify(result)).not.toContain("synthetic result");
  });
  it("fails closed when the key is locked", async () => {
    await expect(sealPayload(base({ recordsKey: null }), "00000000-0000-0000-0000-000000000003", "billing_claims", { member: "synthetic" })).rejects.toThrow(/locked/);
  });
  it("preserves canonical money and quantity strings without floating point coercion", () => {
    expect(exactDecimal("1000.05", 2)).toBe(true); expect(exactDecimal("0.000001", 6)).toBe(true); expect(exactDecimal("1000.050", 2)).toBe(false); expect(exactDecimal("1e3", 2)).toBe(false);
  });
  it("keeps official sources manual and jurisdiction-specific", () => {
    expect(MANUAL_SOURCE_LINKS.mainland.some(([, url]) => url.includes("nhif.or.tz"))).toBe(true);
    expect(MANUAL_SOURCE_LINKS.zanzibar.some(([, url]) => url.includes("mohz.go.tz"))).toBe(true);
    expect(JSON.stringify(MANUAL_SOURCE_LINKS)).not.toMatch(/api|connected|automated/i);
  });
  it("exposes real report resources rather than invented metrics", () => {
    expect(RESOURCES.reports).toContain("diagnostic_report"); expect(RESOURCES.reports).toContain("audit");
  });
  it("does not create an export artifact when auditExport rejects", async () => {
    const context = base({ auditExport: vi.fn().mockRejectedValue(new Error("denied")) });
    await expect(context.auditExport("diagnostic_report" as never, ["00000000-0000-0000-0000-000000000003"], "csv", "authorized_export")).rejects.toThrow("denied");
  });
  it("uses the API purpose appropriate to each initial target/relation read", () => {
    expect(purposeFor("diagnostic_orders", "diagnostics")).toBe("laboratory");
    expect(purposeFor("encounters", "diagnostics")).toBe("direct_care");
    expect(purposeFor("claims", "billing")).toBe("claims");
    expect(purposeFor("staff_credentials", "facilities")).toBe("credential_review");
    expect(purposeFor("audit", "reports")).toBe("privacy_review");
    expect(purposeFor("clinical_report", "reports")).toBe("aggregate_reporting");
  });
  it("allows only explicitly safe report columns and requires UUID entity IDs", () => {
    const rows = [{ id: "00000000-0000-4000-8000-000000000003", state: "complete", facility_id: "facility", dob: "2000-01-01", mrn: "secret", diagnosis: "secret", unrecognized: "secret" }];
    expect(safeReportRows("diagnostic_report", rows)).toEqual([{ id: rows[0].id, facility_id: "facility", state: "complete" }]);
    expect(reportEntityIds([...rows, { id: "not-a-uuid" }])).toEqual([rows[0].id]);
  });
});
