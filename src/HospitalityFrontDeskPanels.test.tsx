// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HospitalityFrontDeskPanels, { maintenanceTransitionPayload } from "./HospitalityFrontDeskPanels";
import type { HospitalityWorkspaceContext } from "./hospitalityWorkspaceTypes";

const property = { id: "prop-1", property_id: "prop-1", code: "DAR", name: "Dar House", status: "active" };
const room = { id: "room-1", property_id: "prop-1", code: "101", room_type: "standard", capacity: 2, status: "clean", nightly_rate: "50.00", version: 2 };
const guest = { id: "guest-1", property_id: "prop-1", code: "G-001", status: "active", version: 1 };
function makeContext(overrides: Partial<HospitalityWorkspaceContext> = {}) {
  const load = vi.fn(async (resource: string) => ({ rows: resource === "properties" ? [property] : resource === "rooms" ? [room] : resource === "guest_index" ? [guest] : [], total_count: 0, limit: 100, offset: 0, has_more: false }));
  return { workspaceId: "ws-1", actorId: "actor-1", bootstrap: { workspace_id: "ws-1", actor_id: "actor-1", role: "front_desk", capabilities: { manage: false, reservations: true, guest_private: true, rooms: true, maintenance: true, finance: false, stock: false, food: false, staff: false, compliance: false, incidents: false, reports: false, audit: false }, settings: { initialized: true, base_currency: "TZS", jurisdiction: "mainland", private_data_enabled: true, storage_review_state: "approved", storage_review_reference: "review-1", version: 1 }, summary: {} }, busy: false, revision: 1, feedback: "", keyConfigs: { guest: { configured: true }, incident: { configured: false } }, unlocked: { guest: true, incident: false }, load, save: vi.fn(async () => ({ id: "new-1", version: 1 })), transition: vi.fn(async () => ({ id: "room-1", version: 3 })), run: vi.fn(async () => ({ id: "res-1", version: 2 })), unlock: vi.fn(), configureKey: vi.fn(), lock: vi.fn(), seal: vi.fn(async () => ({ nonce: "nonce", ciphertext: "cipher" })), decrypt: vi.fn(), notify: vi.fn(), ...overrides } as unknown as HospitalityWorkspaceContext;
}
afterEach(cleanup);

describe("HospitalityFrontDeskPanels", () => {
  it("seals guest PII and sends only nonce/ciphertext plus lawful metadata", async () => {
    const context = makeContext();
    render(<HospitalityFrontDeskPanels context={context} view="front-desk" />);
    const guestCard = (await screen.findByText("Encrypted guest registration")).closest("section")!;
    const guestForm = within(guestCard);
    fireEvent.change(guestForm.getByLabelText("Property"), { target: { value: "prop-1" } });
    fireEvent.change(guestForm.getByLabelText(/Guest safe code/), { target: { value: "G-002" } });
    fireEvent.change(guestForm.getByLabelText(/Full name/), { target: { value: "Asha Guest" } });
    fireEvent.change(guestForm.getByLabelText(/Contact/), { target: { value: "+255700000000" } });
    fireEvent.change(guestForm.getByLabelText(/Identity document/), { target: { value: "ID-SECRET" } });
    fireEvent.change(guestForm.getByLabelText("Notice reference"), { target: { value: "notice-7" } });
    fireEvent.change(guestForm.getByLabelText("Retention until"), { target: { value: "2030-01-01" } });
    fireEvent.click(guestForm.getByRole("button", { name: "Seal and register guest" }));
    await waitFor(() => expect(context.run).toHaveBeenCalledWith("save_guest", expect.objectContaining({ data: expect.objectContaining({ nonce: "nonce", ciphertext: "cipher", lawful_basis: "consent", notice_reference: "notice-7", retention_until: "2030-01-01" }) })));
    const payload = (context.run as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(payload.data).not.toHaveProperty("name"); expect(payload.data).not.toHaveProperty("contact"); expect(payload.data).not.toHaveProperty("identity_document"); expect(payload.data).not.toHaveProperty("idempotency_key"); expect(payload).not.toHaveProperty("idempotency_key");
    expect(context.seal).toHaveBeenCalledWith("guest", expect.any(String), { name: "Asha Guest", contact: "+255700000000", identity_document: "ID-SECRET" });
  });

  it("submits reservation data and check-in with expected version", async () => {
    const context = makeContext({ load: vi.fn(async (resource: string) => ({ rows: resource === "properties" ? [property] : resource === "rooms" ? [room] : resource === "guest_index" ? [guest] : resource === "reservations" ? [{ id: "res-1", property_id: "prop-1", code: "R-1", status: "confirmed", room_id: "room-1", version: 4 }] : [], total_count: 0, limit: 100, offset: 0, has_more: false })) });
    render(<HospitalityFrontDeskPanels context={context} view="front-desk" />);
    const reservationCard = (await screen.findByText("New reservation")).closest("section")!;
    const reservationForm = within(reservationCard);
    fireEvent.change(reservationForm.getByLabelText("Property"), { target: { value: "prop-1" } });
    await waitFor(() => expect(reservationForm.getByLabelText("Actual room").querySelectorAll("option")).toHaveLength(2));
    fireEvent.change(reservationForm.getByLabelText("Actual room"), { target: { value: "room-1" } });
    fireEvent.change(reservationForm.getByLabelText("Guest safe record"), { target: { value: "guest-1" } });
    fireEvent.change(reservationForm.getByLabelText("Reservation code"), { target: { value: "R-2" } });
    fireEvent.change(reservationForm.getByLabelText("Check-out"), { target: { value: "2030-01-03" } });
    fireEvent.change(reservationForm.getByLabelText("Nightly rate"), { target: { value: "50.00" } });
    fireEvent.click(reservationForm.getByRole("button", { name: "Save provisional reservation" }));
    await waitFor(() => expect(context.save).toHaveBeenCalledWith("reservations", expect.objectContaining({ property_id: "prop-1", room_id: "room-1", guest_id: "guest-1", adults: 1, children: 0 })));
    fireEvent.click(await screen.findByRole("button", { name: "Check in" }));
    await waitFor(() => expect(context.run).toHaveBeenCalledWith("check_in", { id: "res-1", expected_version: 4 }));
  });

  it("uses guest and room codes instead of opaque identifiers in front-desk reads", async () => {
    const context = makeContext({ load: vi.fn(async (resource: string) => ({ rows: resource === "properties" ? [property] : resource === "rooms" ? [room] : resource === "guest_index" ? [guest] : resource === "reservations" ? [{ id: "res-1", property_id: "prop-1", code: "R-1", status: "confirmed", room_id: "room-1", version: 4 }] : [], total_count: 0, limit: 100, offset: 0, has_more: false })) });
    render(<HospitalityFrontDeskPanels context={context} view="front-desk" />);
    const reservationForm = (await screen.findByText("New reservation")).closest("section")!;
    fireEvent.change(within(reservationForm).getByLabelText("Property"), { target: { value: "prop-1" } });
    const guestSelect = within(reservationForm).getByLabelText("Guest safe record") as HTMLSelectElement;
    await waitFor(() => expect(guestSelect.options[1]?.textContent).toBe("G-001 · active"));
    const roomCodeHeader = await screen.findByRole("columnheader", { name: "room code" });
    const reservationTable = roomCodeHeader.closest("table")!;
    expect(within(reservationTable).getByText("101")).toBeTruthy();
    expect(within(reservationTable).queryByText("room-1")).toBeNull();
  });

  it("does not render inspection for a housekeeper but permits maintenance metadata", async () => {
    const context = makeContext({ bootstrap: { ...makeContext().bootstrap, role: "housekeeper", capabilities: { ...makeContext().bootstrap.capabilities, reservations: false, guest_private: false, maintenance: false } } });
    render(<HospitalityFrontDeskPanels context={context} view="rooms" />);
    await screen.findByText("Room board");
    expect(screen.queryByRole("button", { name: "Inspect" })).toBeNull();
  });

  it("sends event space, timing, capacity and reference fields", async () => {
    const space = { id: "space-1", property_id: "prop-1", name: "Palm Hall", capacity: 80, status: "active" };
    const context = makeContext({ load: vi.fn(async (resource: string) => ({ rows: resource === "properties" ? [property] : resource === "event_spaces" ? [space] : [], total_count: 0, limit: 100, offset: 0, has_more: false })) });
    render(<HospitalityFrontDeskPanels context={context} view="events" />);
    await screen.findByText("Event inquiry");
    fireEvent.change(screen.getByLabelText("Property scope"), { target: { value: "prop-1" } });
    fireEvent.change(screen.getByLabelText("Event space"), { target: { value: "space-1" } });
    fireEvent.change(screen.getByLabelText("Public event title"), { target: { value: "Team dinner" } });
    fireEvent.change(screen.getByLabelText("Starts"), { target: { value: "2030-02-01T18:00" } });
    fireEvent.change(screen.getByLabelText("Ends"), { target: { value: "2030-02-01T21:00" } });
    fireEvent.change(screen.getByLabelText("Quoted amount"), { target: { value: "100.00" } });
    fireEvent.change(screen.getByLabelText("Reference"), { target: { value: "quote-44" } });
    fireEvent.click(screen.getByRole("button", { name: "Save event inquiry" }));
    await waitFor(() => expect(context.save).toHaveBeenCalledWith("events", expect.objectContaining({ property_id: "prop-1", space_id: "space-1", attendees: 1, reference: "quote-44" })));
    const eventPayload = (context.save as ReturnType<typeof vi.fn>).mock.calls.find(call => call[0] === "events")?.[1];
    expect(eventPayload).not.toHaveProperty("idempotency_key");
  });
});


it("builds maintenance lifecycle transitions with a nonempty reference", () => {
  expect(maintenanceTransitionPayload({ id: "maint-1", version: 4 }, "verified", "maintenance-verification")).toEqual({ resource: "maintenance", row: { id: "maint-1", version: 4 }, to_state: "verified", data: { reference: "maintenance-verification" } });
});
