import { describe, expect, it } from "vitest";
import { assetActivationPayload, assetMoveCompletionPayload, canUsePrivatePeople, privateAttendancePayload, transitionPayload } from "./InstitutionsOperationsPanels";

describe("institutions operations canonical payloads", () => {
  it("requires a RITA written-consent reference before activating Mainland trust land", () => {
    expect(assetActivationPayload({ id: "asset-1", version: 4 }, true, "rita-consent-2026-01")).toEqual({
      resource: "assets", id: "asset-1", expected_version: 4, to_state: "active", data: { land_consent_reference: "rita-consent-2026-01" },
    });
  });

  it("does not add consent data for non-Mainland-trust assets", () => {
    expect(assetActivationPayload({ id: "asset-2", version: 2 }, false, "")).toEqual({
      resource: "assets", id: "asset-2", expected_version: 2, to_state: "active", data: {},
    });
  });

  it("keeps transfer/disposal completion distinct and version checked", () => {
    expect(transitionPayload("asset_moves", { id: "move-1", version: 7 }, "approved", { reference: "review-7" })).toEqual({
      resource: "asset_moves", id: "move-1", expected_version: 7, to_state: "approved", data: { reference: "review-7" },
    });
    expect(assetMoveCompletionPayload({ id: "move-1", version: 8 }, "completion-ref-8")).toEqual({ id: "move-1", expected_version: 8, reference: "completion-ref-8" });
  });

  it("creates a private attendance envelope with client UUID and encrypted fields", () => {
    expect(privateAttendancePayload(
      { id: "event-1" },
      { code: "att-1", lawful_basis: "consent", notice_reference: "notice-1", retention_until: "2027-01-01", client_uuid: "client-uuid-1" },
      { nonce: "nonce", ciphertext: "cipher" },
    )).toEqual({
      resource: "attendance", id: "client-uuid-1", data: { event_id: "event-1", code: "att-1", lawful_basis: "consent", notice_reference: "notice-1", retention_until: "2027-01-01", nonce: "nonce", ciphertext: "cipher" },
    });
  });

  it("opens private people actions only when capability, approved review, gate, and key are all present", () => {
    const base = { workspaceId: "w", actorId: "a", busy: false, revision: 1, feedback: "", keyConfigs: { people: { configured: true }, safeguarding: { configured: false } }, unlocked: { people: false, safeguarding: false }, load: async () => ({ rows: [], total_count: 0, limit: 50, offset: 0, has_more: false }), save: async () => ({}), transition: async () => ({}), run: async () => ({}), unlock: async () => {}, configureKey: async () => {}, lock: () => {}, seal: async () => ({ nonce: "n", ciphertext: "c" }), decrypt: async () => ({}), notify: () => {} } as any;
    const context = (overrides: any = {}) => ({ ...base, ...overrides, bootstrap: { capabilities: { people: true }, settings: { storage_review_state: "approved", private_data_enabled: true }, ...(overrides.bootstrap ?? {}) } } as any);
    expect(canUsePrivatePeople(context({ unlocked: { people: true, safeguarding: false } }))).toBe(true);
    expect(canUsePrivatePeople(context({ unlocked: { people: false, safeguarding: false } }))).toBe(false);
    expect(canUsePrivatePeople(context({ bootstrap: { capabilities: { people: true }, settings: { storage_review_state: "pending", private_data_enabled: true } }, unlocked: { people: true, safeguarding: false } }))).toBe(false);
    expect(canUsePrivatePeople(context({ bootstrap: { capabilities: { people: false }, settings: { storage_review_state: "approved", private_data_enabled: true } }, unlocked: { people: true, safeguarding: false } }))).toBe(false);
  });
});
