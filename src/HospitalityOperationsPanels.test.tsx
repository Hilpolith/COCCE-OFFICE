import { describe, expect, it } from "vitest";
import { expectedParent, issueStockPayload, licenceTransitionPayload, money, orderTransitionPayload, paymentPayload, quantity, roomChargePayload, shiftTransitionPayload } from "./HospitalityOperationsPanels";

describe("hospitality operations payloads", () => {
  it("uses the selected reservation version for payment and refund ledger entries", () => {
    const reservation = { id: "res-1", version: 8 };
    expect(paymentPayload(reservation, { amount: "25.00", method: "cash", reference: "cashier-7" })).toEqual({ reservation_id: "res-1", expected_version: 8, amount: "25.00", method: "cash", reference: "cashier-7" });
  });
  it("uses both selected parent versions for a room charge settlement", () => {
    expect(roomChargePayload({ id: "order-1", version: 4 }, { id: "res-1", version: 9 }, { method: "room_charge", reference: "folio-3" })).toEqual({ id: "order-1", expected_version: 4, reservation_id: "res-1", method: "room_charge", reference: "folio-3" });
  });
  it("issues stock with the lot version and rejects unsafe decimal strings", () => {
    expect(issueStockPayload({ id: "lot-1", version: 3 }, { quantity: "1.250000", reference: "kitchen-2" })).toEqual({ id: "lot-1", expected_version: 3, quantity: "1.250000", reference: "kitchen-2" });
    expect(quantity("0")).toBe(false); expect(quantity("1e3")).toBe(false); expect(money("10.001")).toBe(false); expect(money("10.00")).toBe(true);
  });
  it("requires evidence and a reference on licence activation transitions", () => {
    expect(licenceTransitionPayload({ id: "lic-1", version: 5 }, "active", "evidence-1", "authority-receipt-1")).toEqual({ id: "lic-1", expected_version: 5, to_state: "active", data: { evidence_id: "evidence-1", reference: "authority-receipt-1" } });
  });
  it("does not permit a transaction to omit a positive selected version", () => {
    expect(expectedParent({ id: "parent-1", version: 12 })).toEqual({ id: "parent-1", expected_version: 12 });
  });
});

it("builds strict kitchen and shift transition envelopes with references", () => {
  expect(orderTransitionPayload({ id: "order-1", version: 3 }, "preparing")).toEqual({ resource: "restaurant_orders", row: { id: "order-1", version: 3 }, to_state: "preparing", data: { reference: "kitchen_preparing" } });
  expect(shiftTransitionPayload({ id: "shift-1", version: 2 }, "cancelled")).toEqual({ resource: "shifts", row: { id: "shift-1", version: 2 }, to_state: "cancelled", data: { reference: "shift_cancelled" } });
});
