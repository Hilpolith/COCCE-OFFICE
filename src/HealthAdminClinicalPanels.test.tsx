// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import HealthAdminClinicalPanels, { PatientDesk, buildPatientPrivateUpdatePayload, buildPatientRegistrationPayload } from "./HealthAdminClinicalPanels";
import type { HealthAdminWorkspaceContext } from "./healthAdminWorkspaceTypes";
import { officeHealthAdminApi } from "./lib/officeHealthAdminManagement";

afterEach(() => cleanup());

const patientId = "00000000-0000-4000-8000-000000000001";
const facilityId = "00000000-0000-4000-8000-000000000002";
const context = (overrides: Partial<HealthAdminWorkspaceContext> = {}) => ({
  workspaceId: "00000000-0000-4000-8000-000000000010",
  officeName: "Synthetic Health Office", country: "Tanzania", userId: "00000000-0000-4000-8000-000000000011",
  role: "health_admin", capabilities: {}, storageReady: true, storageState: "approved", keyConfig: { configured: true },
  recordsKey: {} as CryptoKey, indexKey: {} as CryptoKey, busy: false, data: {
    facilities: [{ id: facilityId, display_label: "Synthetic Facility", version: 1 }],
    patients: [{ id: patientId, display_label: "Synthetic Patient", version: 1 }],
    appointments: [], encounters: [], queue_entries: [], triage_events: [], clinical_records: [],
  }, pages: {}, read: vi.fn(async () => ({ rows: [], total_count: 0, offset: 0, limit: 100, has_more: false })),
  command: vi.fn(async (action: string, payload: Record<string, unknown>) => ({ id: String(payload.id), version: 1, action })),
  sealPrivate: vi.fn(async () => ({ nonce: "AAAAAAAAAAAAAAAA", ciphertext: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" })),
  openPrivate: vi.fn(), makeBlindIndex: vi.fn(async () => ({ index_type: "facility_mrn", digest: "c3ludGhldGljLWRpZ2VzdA==" })),
  findPatient: vi.fn(async () => [{ id: patientId, display_label: "Synthetic Patient" }]), auditExport: vi.fn(), refresh: vi.fn(), lockPrivate: vi.fn(), setFeedback: vi.fn(),
  ...overrides,
}) as unknown as HealthAdminWorkspaceContext;

describe("HealthAdminClinicalPanels", () => {
  it("builds a registration payload with ciphertext and no plaintext identity", () => {
    const payload = buildPatientRegistrationPayload({ id: patientId, facilityId, sealed: { nonce: "AAAAAAAAAAAAAAAA", ciphertext: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" }, blindIndex: { index_type: "facility_mrn", digest: "c3ludGhldGljLWRpZ2VzdA==" } });
    expect(payload.ciphertext).toBeDefined();
    expect(JSON.stringify(payload)).not.toContain("Synthetic Patient");
    expect(JSON.stringify(payload)).not.toContain("MRN");
    expect(payload.blind_indexes).toEqual([{ index_type: "facility_mrn", digest: "c3ludGhldGljLWRpZ2VzdA==" }]);
  });

  it("builds and adapter-validates the private update payload without facility or patient extras", async () => {
    const payload = buildPatientPrivateUpdatePayload({ id: patientId, expectedVersion: 3, sealed: { nonce: "AAAAAAAAAAAAAAAA", ciphertext: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" }, blindIndex: { index_type: "facility_mrn", digest: "c3ludGhldGljLWRpZ2VzdA==" } });
    expect(Object.keys(payload).sort()).toEqual(["blind_indexes", "ciphertext", "expected_version", "id", "idempotency_key", "nonce"].sort());
    const rpc = vi.fn(async () => ({ data: { id: patientId, version: 4 }, error: null }));
    await expect(officeHealthAdminApi.command({ rpc }, "00000000-0000-4000-8000-000000000010", "update_patient_private", payload)).resolves.toMatchObject({ id: patientId, version: 4 });
    expect(rpc).toHaveBeenCalledWith("office_health_admin_command", expect.objectContaining({ p_action: "update_patient_private", p_payload: payload }));
  });

  it("fails closed without storage approval and does not read PHI", () => {
    const read = vi.fn();
    render(<PatientDesk context={context({ storageReady: false, read })} />);
    expect(screen.getByText(/storage is not approved/i)).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });

  it("fails closed while the private key is locked", () => {
    const read = vi.fn();
    render(<PatientDesk context={context({ recordsKey: null, indexKey: null, read })} />);
    expect(screen.getByText(/Unlock the private-record key/i)).toBeTruthy();
    expect(read).not.toHaveBeenCalled();
  });

  it("uses an audited exact-match lookup and never merges automatically", async () => {
    const findPatient = vi.fn(async () => [{ id: patientId, display_label: "Synthetic Patient" }]);
    const ctx = context({ findPatient });
    render(<PatientDesk context={ctx} />);
    fireEvent.change(screen.getByLabelText("Local opaque MRN"), { target: { value: "synthetic-mrn" } });
    fireEvent.click(screen.getByRole("button", { name: /check exact match/i }));
    await waitFor(() => expect(findPatient).toHaveBeenCalledWith("facility_mrn", "synthetic-mrn", "registration"));
    expect(ctx.command).not.toHaveBeenCalledWith(expect.stringMatching(/merge/i), expect.anything());
    expect(screen.getByText(/match found/i)).toBeTruthy();
  });

  it("opens selected patient ciphertext into bounded form state and clears it on lock", async () => {
    const openPrivate = vi.fn(async () => ({ name: "Synthetic Patient", dob: "1990-01-01", phone: "", mrn: "synthetic-mrn" })) as unknown as HealthAdminWorkspaceContext["openPrivate"];
    const ctx = context({ openPrivate, data: { facilities: [{ id: facilityId, display_label: "Synthetic Facility", version: 1 }], patients: [{ id: patientId, display_label: "Synthetic Patient", version: 2 }], patient_private: [{ id: patientId, nonce: "AAAAAAAAAAAAAAAA", ciphertext: "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=" }], appointments: [], encounters: [], queue_entries: [], triage_events: [], clinical_records: [] } });
    const { rerender } = render(<PatientDesk context={ctx} />);
    fireEvent.click(screen.getByRole("button", { name: /select synthetic patient/i }));
    await waitFor(() => expect(openPrivate).toHaveBeenCalledWith(patientId, "patient_identity", expect.objectContaining({ nonce: expect.any(String), ciphertext: expect.any(String) })));
    expect((screen.getByLabelText("Patient name") as HTMLInputElement).value).toBe("Synthetic Patient");
    rerender(<PatientDesk context={context({ ...ctx, recordsKey: null, indexKey: null })} />);
    expect(screen.queryByDisplayValue("Synthetic Patient")).toBeNull();
  });

  it("keeps panel navigation stateful without exposing raw-id entry", () => {
    const ctx = context();
    render(<HealthAdminClinicalPanels context={ctx} />);
    expect(screen.getByRole("heading", { name: "Register or edit patient" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Appointments & Triage" }));
    expect(screen.getByRole("heading", { name: "Schedule appointment" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Encounters & Notes" }));
    expect(screen.getByRole("heading", { name: "Encounter shell" })).toBeTruthy();
    expect(screen.queryByLabelText(/patient id/i)).toBeNull();
  });
});
