// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FrostedConfirmProvider } from "./FrostedConfirm";
import HealthAdminResidencyApprovalPanel from "./HealthAdminResidencyApprovalPanel";
import type { HealthAdminWorkspaceContext } from "./healthAdminWorkspaceTypes";

const W = "00000000-0000-4000-8000-000000000001";
const A = "00000000-0000-4000-8000-000000000002";
const B = "00000000-0000-4000-8000-000000000003";
const base = (settings: Record<string, unknown> | null, overrides: Partial<HealthAdminWorkspaceContext> = {}) => ({
  workspaceId: W, officeName: "Synthetic", country: "Tanzania", userId: A, role: "privacy_officer", capabilities: { privacy_ops: true } as never,
  storageReady: false, storageState: "unverified", settings, keyConfig: { configured: false }, recordsKey: null, indexKey: null, busy: false,
  data: {}, pages: {}, read: vi.fn(), command: vi.fn(), residencyCommand: vi.fn().mockResolvedValue({ version: 2 }), sealPrivate: vi.fn(), openPrivate: vi.fn(), makeBlindIndex: vi.fn(), findPatient: vi.fn(), auditExport: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined), lockPrivate: vi.fn(), setFeedback: vi.fn(), ...overrides,
} as unknown as HealthAdminWorkspaceContext);
const renderPanel = (context: HealthAdminWorkspaceContext) => render(<FrostedConfirmProvider><HealthAdminResidencyApprovalPanel context={context} /></FrostedConfirmProvider>);

describe("HealthAdminResidencyApprovalPanel", () => {
  afterEach(() => cleanup());
  it("shows a safe closed no-settings state without auto-enabling", () => {
    const context = base(null); renderPanel(context);
    expect(screen.getByText(/No Health Administration settings row exists yet/)).toBeTruthy();
    expect(screen.getByText("Not recorded")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Enable clinical gate/i })).toHaveProperty("disabled", true);
    expect(context.residencyCommand).not.toHaveBeenCalled();
  });
  it("keeps pending/rejected evidence and two-person prerequisites visibly closed", () => {
    const context = base({ version: 3, storage_review_state: "approved", clinical_data_enabled: false, residency_approval_status: "rejected", residency_approval_reference: "REF", residency_approval_recorded_by: A, residency_approval_verified_by: A }); renderPanel(context);
    expect(screen.getByText("rejected")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Enable clinical gate/i })).toHaveProperty("disabled", true);
    expect(screen.getByText(/recorded and verifying actors differ/)).toBeTruthy();
  });
  it("requires the frosted confirmation before an eligible enable command", async () => {
    const context = base({ version: 3, storage_review_state: "approved", clinical_data_enabled: false, residency_approval_status: "approved", residency_approval_reference: "REAL-REF", residency_approval_recorded_by: A, residency_approval_verified_by: B }, { keyConfig: { configured: true } }); renderPanel(context);
    fireEvent.click(screen.getAllByRole("button", { name: /Enable clinical gate/i }).find((button) => !(button as HTMLButtonElement).disabled)!);
    expect(await screen.findByRole("alertdialog")).toBeTruthy();
    expect(context.residencyCommand).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: /Enable clinical gate/i }));
    await waitFor(() => expect(context.residencyCommand).toHaveBeenCalledWith("set_clinical_gate", expect.objectContaining({ enabled: true, expected_version: 3 })));
  });
});
