// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import ManufacturingEvidencePanel, {
  manufacturingEvidenceAttachmentContext,
} from "./ManufacturingEvidencePanel";
import { ManufacturingOperationFormsProvider } from "./ManufacturingOperationForm";
import { encryptOfficeAttachment } from "./lib/officeEncryptedAttachments";

const ids = {
  user: "11111111-1111-4111-8111-111111111111",
  workspace: "22222222-2222-4222-8222-222222222222",
  target: "33333333-3333-4333-8333-333333333333",
  target2: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  file: "44444444-4444-4444-8444-444444444444",
  revision: "55555555-5555-4555-8555-555555555555",
  session: "66666666-6666-4666-8666-666666666666",
};
const targets = [
  { type: "lot" as const, id: ids.target, label: "Lot A" },
  { type: "lot" as const, id: ids.target2, label: "Lot B" },
];
const sha = async (bytes: Uint8Array) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  upload: vi.fn(),
  finalize: vi.fn(),
  getSyncState: vi.fn(),
  download: vi.fn(),
  create: vi.fn<(...args: unknown[]) => unknown>(),
  confirm: vi.fn(async () => true),
}));
vi.mock("./lib/officeCloudFiles", () => ({
  createOfficeCloudApi: (...args: unknown[]) => {
    mocks.create(...args);
    return mocks;
  },
  hashBytes: (bytes: Uint8Array) => sha(bytes),
}));
vi.mock("./FrostedConfirm", () => ({ useFrostedConfirm: () => mocks.confirm }));
const auth = {
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(() => ({
    data: { subscription: { unsubscribe: vi.fn() } },
  })),
};
const client = { auth } as never;
const baseSync = {
  fileId: ids.file,
  workspaceId: ids.workspace,
  displayName: "EV-BASE.cocce",
  currentRevisionId: ids.revision,
  revisionNumber: 1,
  sizeBytes: 100,
  sha256Hex: "a".repeat(64),
  updatedAt: new Date().toISOString(),
};
const rows = [
  {
    id: "evidence-row",
    evidence_code: "EV-BASE",
    target_type: "lot",
    target_id: ids.target,
    workspace_id: ids.workspace,
    file_id: ids.file,
    revision_id: ids.revision,
    size_bytes: 100,
    sha256_hex: "a".repeat(64),
    version: 1,
  },
];
let recordsKey: CryptoKey;
let latestSync: typeof baseSync;
let fileCounter = 0;
beforeEach(async () => {
  vi.clearAllMocks();
  latestSync = { ...baseSync };
  fileCounter = 0;
  recordsKey = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  auth.getSession.mockResolvedValue({
    data: {
      session: { user: { id: ids.user }, access_token: "never-forwarded" },
    },
    error: null,
  });
  mocks.reserve.mockImplementation(
    async (_workspace: string, displayName: string, envelope: Uint8Array) => {
      fileCounter += 1;
      latestSync = {
        ...baseSync,
        fileId:
          fileCounter === 1 ? ids.file : "77777777-7777-4777-8777-777777777777",
        displayName,
        sizeBytes: envelope.byteLength,
        sha256Hex: await sha(envelope),
      };
      return {
        status: "upload_pending",
        workspaceId: ids.workspace,
        fileId: latestSync.fileId,
        revisionId: ids.revision,
        uploadSessionId: ids.session,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        uploadUrl:
          "https://de-s3.storage.bunnycdn.com/cocce-kyc/office/v1/workspaces/x/files/y/revisions/z/payload",
        requiredHeaders: {},
      };
    },
  );
  mocks.getSyncState.mockImplementation(async () => latestSync);
  mocks.upload.mockResolvedValue(undefined);
  mocks.finalize.mockResolvedValue({ status: "finalized", fileId: ids.file });
});
afterEach(() => cleanup());
function mount(
  onCommand = vi.fn(async () => ({ id: ids.target, version: 2 })),
  extra: Partial<React.ComponentProps<typeof ManufacturingEvidencePanel>> = {},
) {
  return {
    onCommand,
    ...render(
      <ManufacturingEvidencePanel
        client={client}
        publicKey="public"
        workspaceId={ids.workspace}
        currentUserId={ids.user}
        recordsKey={recordsKey}
        canManage
        rows={rows}
        targets={targets}
        onCommand={onCommand}
        {...extra}
      />,
    ),
  };
}
async function chooseFile(name = "private.pdf", body = "secret") {
  fireEvent.change(screen.getByLabelText("Encrypted file"), {
    target: { files: [new File([body], name, { type: "application/pdf" })] },
  });
  fireEvent.click(screen.getByRole("button", { name: "Encrypt and upload" }));
  await waitFor(() => expect(mocks.reserve).toHaveBeenCalled());
}

describe("ManufacturingEvidencePanel", () => {
  it("encrypts locally, reserves with a unique EV UUID, uploads, finalizes, verifies exact metadata, then links", async () => {
    const { onCommand } = mount();
    await chooseFile("private-name.pdf", "secret");
    const reserve = mocks.reserve.mock.calls[0] as unknown as unknown[];
    expect(String(reserve[1])).toMatch(/^EV-[0-9a-f-]{36}\.cocce$/i);
    expect(String(reserve[1])).not.toContain("private-name");
    expect(reserve[2]).toBeInstanceOf(Uint8Array);
    expect((reserve[2] as Uint8Array).byteLength).toBe(latestSync.sizeBytes);
    expect(mocks.upload).toHaveBeenCalledWith(expect.anything(), reserve[2]);
    expect(mocks.finalize).toHaveBeenCalledWith(ids.session);
    await waitFor(() => expect(onCommand).toHaveBeenCalled());
    expect(
      (onCommand.mock.calls as unknown as unknown[][])[0][1],
    ).toMatchObject({ file_id: ids.file, revision_id: ids.revision });
  });
  it("creates two distinct uploads for two new files with the same target and size", async () => {
    const { onCommand } = mount();
    await chooseFile("one.pdf", "same");
    const firstCode = String(
      (
        (onCommand.mock.calls as unknown as unknown[][])[0][1] as Record<
          string,
          unknown
        >
      ).evidence_code,
    );
    const input = screen.getByLabelText("Encrypted file");
    fireEvent.change(input, {
      target: {
        files: [new File(["same"], "two.pdf", { type: "application/pdf" })],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Encrypt and upload" }));
    await waitFor(() => expect(mocks.reserve).toHaveBeenCalledTimes(2));
    expect(
      String(
        (
          (onCommand.mock.calls as unknown as unknown[][])[1][1] as Record<
            string,
            unknown
          >
        ).evidence_code,
      ),
    ).not.toBe(firstCode);
  });
  it("retains a failed link for retry without reuploading", async () => {
    const onCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("link unavailable"))
      .mockResolvedValueOnce({ id: ids.target, version: 3 });
    mount(onCommand);
    await chooseFile();
    await screen.findByText(/linking failed/);
    fireEvent.click(screen.getByRole("button", { name: "Retry link" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.upload).toHaveBeenCalledOnce();
    expect(
      (
        (onCommand.mock.calls as unknown as unknown[][])[0][1] as Record<
          string,
          unknown
        >
      ).idempotency_key,
    ).toBe(
      (
        (onCommand.mock.calls as unknown as unknown[][])[1][1] as Record<
          string,
          unknown
        >
      ).idempotency_key,
    );
  });
  it("rejects changed authenticated user before upload and never links or finalizes after an auth switch", async () => {
    let release!: (value: unknown) => void;
    let callback!: (event: string, session: { user: { id: string } }) => void;
    auth.onAuthStateChange.mockImplementation(((next: typeof callback) => {
      callback = next;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    }) as never);
    mocks.reserve.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const onCommand = vi.fn();
    mount(onCommand);
    await chooseFile();
    callback("SIGNED_IN", {
      user: { id: "99999999-9999-4999-8999-999999999999" },
    });
    release({
      status: "upload_pending",
      workspaceId: ids.workspace,
      fileId: ids.file,
      revisionId: ids.revision,
      uploadSessionId: ids.session,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      uploadUrl: "https://storage.example/upload",
      requiredHeaders: {},
    });
    await waitFor(() => expect(onCommand).not.toHaveBeenCalled());
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(screen.queryByText(/secret|private\.pdf/)).toBeNull();
  });
  it("refuses download when pinned revision changes", async () => {
    mocks.getSyncState.mockResolvedValue({
      ...baseSync,
      currentRevisionId: "77777777-7777-4777-8777-777777777777",
    });
    mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Download encrypted evidence" }),
    );
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toMatch(/revision changed/i);
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("fails decryption when the evidence row target changes and AAD no longer matches", async () => {
    const envelope = await encryptOfficeAttachment(
      recordsKey,
      {
        name: "x.pdf",
        type: "application/pdf",
        bytes: new TextEncoder().encode("x"),
      },
      manufacturingEvidenceAttachmentContext(
        ids.workspace,
        "EV-BASE",
        "lot",
        ids.target,
      ),
    );
    latestSync = {
      ...baseSync,
      sizeBytes: envelope.byteLength,
      sha256Hex: await sha(envelope),
    };
    mocks.download.mockResolvedValue(envelope);
    mount(undefined, {
      rows: [
        {
          ...rows[0],
          size_bytes: latestSync.sizeBytes,
          sha256_hex: latestSync.sha256Hex,
          target_id: ids.target2,
        },
      ],
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Download encrypted evidence" }),
    );
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toMatch(/decrypt/i);
  });
  it("clears file, URL, pending link, and file input when document is hidden", async () => {
    const onCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("link unavailable"));
    mount(onCommand);
    await chooseFile();
    await screen.findByText(/linking failed/);
    const url = screen.getByLabelText("External HTTPS evidence link");
    fireEvent.change(url, {
      target: { value: "https://example.org/evidence" },
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    fireEvent(document, new Event("visibilitychange"));
    expect(
      (screen.getByLabelText("Encrypted file") as HTMLInputElement).value,
    ).toBe("");
    expect((url as HTMLInputElement).value).toBe("");
    expect(screen.queryByRole("button", { name: "Retry link" })).toBeNull();
  });
  it("reuses the same external-link idempotency key after a failed save", async () => {
    const onCommand = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({ id: ids.target, version: 2 });
    mount(onCommand);
    const url = screen.getByLabelText("External HTTPS evidence link");
    fireEvent.change(url, {
      target: { value: "https://example.org/evidence" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save HTTPS link" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Save HTTPS link" }));
    await waitFor(() => expect(onCommand).toHaveBeenCalledTimes(2));
    expect(
      (
        (onCommand.mock.calls as unknown as unknown[][])[0][1] as Record<
          string,
          unknown
        >
      ).idempotency_key,
    ).toBe(
      (
        (onCommand.mock.calls as unknown as unknown[][])[1][1] as Record<
          string,
          unknown
        >
      ).idempotency_key,
    );
  });
  it("uses the remote paginated target provider and selected record context", async () => {
    const readPage = vi.fn(async () => ({
      rows: [{ id: ids.target, name: "Remote Lot", version: 1 }],
      total_count: 1,
      offset: 0,
      limit: 50,
      has_more: false,
    }));
    const provider = {
      data: {},
      pages: {},
      readPage,
      capabilities: null,
      refreshToken: 0,
    };
    const onCommand = vi.fn(async () => ({ id: ids.target, version: 2 }));
    render(
      <ManufacturingOperationFormsProvider value={provider}>
        <ManufacturingEvidencePanel
          client={client}
          publicKey="public"
          workspaceId={ids.workspace}
          currentUserId={ids.user}
          recordsKey={recordsKey}
          canManage
          rows={[]}
          targets={[]}
          onCommand={onCommand}
        />
      </ManufacturingOperationFormsProvider>,
    );
    await waitFor(() => expect(readPage).toHaveBeenCalledWith("lots", {}, 0));
    fireEvent.change(screen.getByLabelText("Evidence target"), {
      target: { value: ids.target },
    });
    await chooseFile();
    expect(onCommand).toHaveBeenCalledWith(
      "link_evidence",
      expect.objectContaining({ target_id: ids.target }),
      "Evidence linked.",
    );
  });
  it("requires reason and stops supersession if actor changes while confirmation is open", async () => {
    const confirmDeferred = new Promise<boolean>(() => undefined);
    mocks.confirm.mockReturnValue(confirmDeferred);
    let callback!: (event: string, session: { user: { id: string } }) => void;
    auth.onAuthStateChange.mockImplementation(((next: typeof callback) => {
      callback = next;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    }) as never);
    const onCommand = vi.fn();
    mount(onCommand);
    fireEvent.click(screen.getByRole("button", { name: "Supersede" }));
    expect(mocks.confirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText("Reason for supersession"), {
      target: { value: "duplicate evidence" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Supersede" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    callback("SIGNED_IN", {
      user: { id: "99999999-9999-4999-8999-999999999999" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCommand).not.toHaveBeenCalled();
  });
});
