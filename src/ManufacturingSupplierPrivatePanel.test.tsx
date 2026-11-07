// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createOfficeRecordsKeyConfig, encryptOfficePrivateRecord } from "./lib/officePrivateRecordsCrypto";
import ManufacturingSupplierPrivatePanel from "./ManufacturingSupplierPrivatePanel";
import type { ManufacturingRecord } from "./lib/officeManufacturingManagement";

const workspaceId = "11111111-1111-4111-8111-111111111111";
const supplierId = "22222222-2222-4222-8222-222222222222";
const supplier = { id: supplierId, supplier_code: "SUP-001", display_label: "Reference label" };
const privateFields = { legal_name: "Synthetic Supplier Ltd", contact_name: "Ada Example", email: "ada@example.test", phone: "+255700000000", tin: "TIN-1", vrn: "VRN-1", address: "Synthetic address", notes: "Synthetic note" };

function page(rows: ManufacturingRecord[], offset = 0, has_more = false) {
  return { rows, total_count: rows.length, offset, limit: 25, has_more };
}
async function setup() {
  const context = `COCCE Manufacturing:${workspaceId}:v1`;
  const created = await createOfficeRecordsKeyConfig("correct horse battery staple", context);
  const readPage = vi.fn(async (resource: string) => resource === "suppliers" ? page([supplier]) : page([]));
  const onCommand = vi.fn().mockResolvedValue({ id: supplierId, version: 1 });
  const props = { workspaceId, recordsKey: created.key, canManage: true, identityToken: "actor-a", readPage, onCommand, busy: false };
  render(<ManufacturingSupplierPrivatePanel {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByRole("option", { name: /SUP-001/ });
  fireEvent.change(screen.getByLabelText("Supplier reference"), { target: { value: supplierId } });
  return { ...props, context };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe("ManufacturingSupplierPrivatePanel", () => {
  it("uses real WebCrypto and sends only encrypted fields with a new-record version", async () => {
    const state = await setup();
    const encrypted = await encryptOfficePrivateRecord(state.recordsKey, privateFields, state.context);
    state.readPage.mockImplementation(async (resource: string) => resource === "suppliers" ? page([supplier]) : page([{ supplier_id: supplierId, ...encrypted, version: 1 }]));
    fireEvent.change(screen.getByLabelText("Legal name"), { target: { value: privateFields.legal_name } });
    fireEvent.click(screen.getByRole("button", { name: "Save encrypted details" }));
    await waitFor(() => expect(state.onCommand).toHaveBeenCalledWith("save_supplier_private", expect.objectContaining({ supplier_id: supplierId, nonce: expect.any(String), ciphertext: expect.any(String), expected_version: 0, idempotency_key: expect.any(String) }), "Private supplier details encrypted and saved."));
    const payload = state.onCommand.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("legal_name");
    expect(payload).not.toHaveProperty("email");
  });

  it("fails generically when the encrypted row was made with another context/key", async () => {
    const state = await setup();
    const other = await createOfficeRecordsKeyConfig("another correct horse battery staple", `COCCE Manufacturing:${workspaceId}:v1`);
    const encrypted = await encryptOfficePrivateRecord(other.key, privateFields, `COCCE Manufacturing:${workspaceId}:v1`);
    state.readPage.mockResolvedValue(page([{ supplier_id: supplierId, ...encrypted, version: 2 }]));
    fireEvent.click(screen.getByRole("button", { name: "Reload encrypted details" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not decrypt/i);
    expect(screen.queryByDisplayValue("Synthetic Supplier Ltd")).toBeNull();
  });

  it("clears a pending private read when the document becomes hidden", async () => {
    const state = await setup();
    let resolvePrivate!: (value: ReturnType<typeof page>) => void;
    state.readPage.mockImplementation((resource: string) => resource === "suppliers" ? Promise.resolve(page([supplier])) : new Promise((resolve) => { resolvePrivate = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Reload encrypted details" }));
    fireEvent(document, new Event("visibilitychange"));
    resolvePrivate(page([{ supplier_id: supplierId, nonce: "bad", ciphertext: "bad", version: 3 }]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByDisplayValue("Synthetic Supplier Ltd")).toBeNull();
  });

  it("ignores a private read that completes after the identity context changes", async () => {
    const state = await setup();
    let resolvePrivate!: (value: ReturnType<typeof page>) => void;
    state.readPage.mockImplementation((resource: string) => resource === "suppliers" ? Promise.resolve(page([supplier])) : new Promise((resolve) => { resolvePrivate = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Reload encrypted details" }));
    const replacement = { ...state, identityToken: "actor-b" };
    const view = render(<ManufacturingSupplierPrivatePanel {...replacement} />);
    resolvePrivate(page([{ supplier_id: supplierId, nonce: "bad", ciphertext: "bad", version: 3 }]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByDisplayValue("Synthetic Supplier Ltd")).toBeNull();
    view.unmount();
  });

  it("does not call the private resource when read-only", async () => {
    const readPage = vi.fn().mockResolvedValue(page([supplier]));
    render(<ManufacturingSupplierPrivatePanel workspaceId={workspaceId} recordsKey={null} canManage={false} identityToken="actor-a" readPage={readPage} onCommand={vi.fn()} busy={false} />);
    expect(screen.getByText(/restricted to authorized/i)).toBeTruthy();
    expect(readPage).not.toHaveBeenCalled();
  });
});
