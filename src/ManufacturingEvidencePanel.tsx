import { useContext, useEffect, useRef, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { useFrostedConfirm } from "./FrostedConfirm";
import { ManufacturingRecordPicker } from "./ManufacturingOperationForm";
import { ManufacturingOperationFormsContext } from "./ManufacturingOperationForm";
import { createOfficeCloudApi, hashBytes } from "./lib/officeCloudFiles";
import type { CloudFile, CloudUploadGrant } from "./lib/officeCloudFiles";
import {
  decryptOfficeAttachment,
  encryptOfficeAttachment,
} from "./lib/officeEncryptedAttachments";
import type {
  ManufacturingAction,
  ManufacturingRecord,
  ManufacturingResource,
} from "./lib/officeManufacturingManagement";

export type ManufacturingEvidenceTarget = {
  type: "lot" | "production_order" | "maintenance_order" | "compliance_record";
  id: string;
  label: string;
};
export type ManufacturingEvidencePanelProps = {
  client: SupabaseClient;
  publicKey: string;
  workspaceId: string;
  currentUserId: string;
  recordsKey: CryptoKey | null;
  canManage: boolean;
  rows: ManufacturingRecord[];
  targets: ManufacturingEvidenceTarget[];
  busy?: boolean;
  onCommand: (
    action: ManufacturingAction,
    payload: ManufacturingRecord,
    success?: string,
  ) => Promise<ManufacturingRecord>;
  onError?: (message: string) => void;
};
type PendingLink = {
  payload: ManufacturingRecord;
  fileId: string;
  revisionId: string;
  displayName: string;
  sizeBytes: number;
  sha256Hex: string;
};
type Attempt = {
  target: ManufacturingEvidenceTarget;
  sourceFile: File;
  evidenceCode: string;
  envelope: Uint8Array;
  idempotencyKey: string;
  grant?: CloudUploadGrant;
  fileId?: string;
  revisionId?: string;
  payload?: PendingLink;
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeMessage = (e: unknown) => {
  const message = e instanceof Error ? e.message : "";
  return message && !/https?:|Bearer |access_token|signature=/i.test(message)
    ? message.slice(0, 350)
    : "The evidence operation could not be completed.";
};
const idempotency = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error("Secure request identifiers are unavailable.");
};
const text = (row: ManufacturingRecord, key: string) =>
  typeof row[key] === "string" ? (row[key] as string) : "";
const number = (row: ManufacturingRecord, key: string) =>
  typeof row[key] === "number" ? (row[key] as number) : NaN;
const isHttps = (value: string) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
};
const resourceFor = (
  type: ManufacturingEvidenceTarget["type"],
): ManufacturingResource =>
  ({
    lot: "lots",
    production_order: "production_orders",
    maintenance_order: "maintenance_orders",
    compliance_record: "compliance_records",
  })[type] as ManufacturingResource;
/** The exact authenticated-encryption context used for one evidence object. */
export function manufacturingEvidenceAttachmentContext(
  workspaceId: string,
  evidenceCode: string,
  targetType: string,
  targetId: string,
): string {
  const context = `manufacturing-evidence/${workspaceId}/${evidenceCode}/${targetType}/${targetId}`;
  if (new TextEncoder().encode(context).byteLength > 200)
    throw new Error("Evidence encryption context is too long.");
  return context;
}

export default function ManufacturingEvidencePanel(
  props: ManufacturingEvidencePanelProps,
) {
  const {
    client,
    publicKey,
    workspaceId,
    currentUserId,
    recordsKey,
    canManage,
    rows,
    targets,
    busy = false,
    onCommand,
    onError,
  } = props;
  const context = useContext(ManufacturingOperationFormsContext);
  const confirm = useFrostedConfirm();
  const [targetType, setTargetType] = useState<
    ManufacturingEvidenceTarget["type"]
  >(targets[0]?.type ?? "lot");
  const [target, setTarget] = useState(targets[0]?.id ?? "");
  const [selectedRecord, setSelectedRecord] = useState<
    ManufacturingRecord | undefined
  >();
  const [file, setFile] = useState<File | null>(null);
  const [externalUrl, setExternalUrl] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const mounted = useRef(true);
  const epoch = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const attempt = useRef<Attempt | null>(null);
  const externalAttempt = useRef<{
    target: string;
    url: string;
    key: string;
  } | null>(null);
  const availableTargets = context
    ? undefined
    : targets.filter((item) => item.type === targetType);
  const selectedTarget =
    availableTargets?.find((item) => item.id === target) ??
    (target && selectedRecord
      ? {
          type: targetType,
          id: target,
          label: String(selectedRecord.name ?? selectedRecord.id ?? target),
        }
      : undefined);
  const report = (message: string) => {
    if (mounted.current) {
      setError(message);
      onError?.(message);
    }
  };
  const clearContext = () => {
    epoch.current += 1;
    setFile(null);
    setPendingLink(null);
    attempt.current = null;
    externalAttempt.current = null;
    setExternalUrl("");
    setError("");
    setNotice("");
    if (fileInput.current) fileInput.current.value = "";
    if (urlInput.current) urlInput.current.value = "";
  };
  useEffect(() => {
    mounted.current = true;
    const hidden = () => {
      if (document.visibilityState === "hidden") clearContext();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      mounted.current = false;
      epoch.current += 1;
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  useEffect(() => {
    clearContext();
  }, [workspaceId, currentUserId, recordsKey, canManage]);
  useEffect(() => {
    if (
      !context &&
      !targets.some((item) => item.type === targetType && item.id === target)
    ) {
      const next =
        targets.find((item) => item.type === targetType) ?? targets[0];
      setTargetType(next?.type ?? "lot");
      setTarget(next?.id ?? "");
    }
  }, [targets, target, targetType, context]);
  useEffect(() => {
    const auth = client.auth.onAuthStateChange((_event, session) => {
      if (session?.user?.id?.toLowerCase() !== currentUserId.toLowerCase()) {
        clearContext();
        setError(
          "Your signed-in account changed. Reload the evidence context before continuing.",
        );
      }
    });
    return () => auth.data.subscription.unsubscribe();
  }, [client, currentUserId]);
  async function authorized() {
    const result = await client.auth.getSession();
    const id = result.data?.session?.user?.id;
    if (result.error || !id || id.toLowerCase() !== currentUserId.toLowerCase())
      throw new Error(
        "Your signed-in account is not authorized for this evidence action.",
      );
  }
  const current = (generation: number) =>
    mounted.current && epoch.current === generation;
  const chooseTarget = () => {
    const item =
      selectedTarget ??
      targets.find((entry) => entry.type === targetType && entry.id === target);
    if (!item) throw new Error("Choose a valid evidence target.");
    return item;
  };
  function handleFile(event: ChangeEvent<HTMLInputElement>) {
    setFile(event.target.files?.[0] ?? null);
    setError("");
    setNotice("");
  }
  async function linkExisting(pending: PendingLink, generation: number) {
    await authorized();
    if (!current(generation)) return;
    await onCommand("link_evidence", pending.payload, "Evidence linked.");
    if (!current(generation)) return;
    setPendingLink(null);
    attempt.current = null;
    setNotice("Encrypted evidence uploaded and linked.");
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (localBusy || busy) return;
    const generation = epoch.current;
    setLocalBusy(true);
    setError("");
    setNotice("");
    try {
      if (!canManage)
        throw new Error("You have read-only access to manufacturing evidence.");
      if (!recordsKey)
        throw new Error("Unlock the records key before uploading evidence.");
      await authorized();
      if (!current(generation)) return;
      const chosen = file;
      if (!chosen) throw new Error("Choose an evidence file first.");
      if (chosen.size > 20 * 1024 * 1024)
        throw new Error(
          "The plaintext evidence file exceeds the 20 MiB limit.",
        );
      const item = chooseTarget();
      const existing = attempt.current;
      if (
        !existing ||
        existing.target.id !== item.id ||
        existing.target.type !== item.type ||
        existing.sourceFile !== chosen
      ) {
        const code = `EV-${idempotency()}`;
        const bytes = new Uint8Array(await chosen.arrayBuffer());
        if (!current(generation)) return;
        const envelope = await encryptOfficeAttachment(
          recordsKey,
          { name: chosen.name, type: chosen.type, bytes },
          manufacturingEvidenceAttachmentContext(
            workspaceId,
            code,
            item.type,
            item.id,
          ),
        );
        attempt.current = {
          target: item,
          sourceFile: chosen,
          evidenceCode: code,
          envelope,
          idempotencyKey: idempotency(),
        };
      }
      const state = attempt.current as Attempt;
      const api = createOfficeCloudApi(client, publicKey, currentUserId);
      if (!current(generation)) return;
      if (!state.grant && !state.fileId) {
        try {
          const reservation = await api.reserve(
            workspaceId,
            `${state.evidenceCode}.cocce`,
            state.envelope,
            state.idempotencyKey,
          );
          if (!current(generation)) return;
          if (reservation.status === "finalized") {
            state.fileId = reservation.fileId;
          } else state.grant = reservation;
        } catch (reserveError) {
          try {
            const recovered = await api.resolveReservation({
              workspaceId,
              displayName: `${state.evidenceCode}.cocce`,
              sizeBytes: state.envelope.byteLength,
              sha256Hex: "",
              idempotencyKey: state.idempotencyKey,
            });
            if (recovered.status === "finalized")
              state.fileId = recovered.fileId;
            else throw reserveError;
          } catch {
            throw reserveError;
          }
        }
      }
      if (!current(generation)) return;
      if (state.grant) {
        await api.upload(state.grant, state.envelope);
        if (!current(generation)) return;
        await api.finalize(state.grant.uploadSessionId);
        if (!current(generation)) return;
        state.fileId = state.grant.fileId;
        state.revisionId = state.grant.revisionId;
        state.grant = undefined;
      }
      if (!state.fileId)
        throw new Error("The encrypted upload did not produce a file.");
      const sync = await api.getSyncState(state.fileId);
      if (!current(generation) || !sync)
        throw new Error(
          "The finalized evidence revision could not be verified.",
        );
      const envelopeHash = await hashBytes(state.envelope);
      if (
        sync.workspaceId.toLowerCase() !== workspaceId.toLowerCase() ||
        sync.displayName !== `${state.evidenceCode}.cocce` ||
        sync.sizeBytes !== state.envelope.byteLength ||
        sync.sha256Hex.toLowerCase() !== envelopeHash.toLowerCase()
      )
        throw new Error("The cloud copy does not match this encrypted upload.");
      if (state.revisionId && sync.currentRevisionId !== state.revisionId)
        throw new Error(
          "The finalized evidence revision could not be verified.",
        );
      state.revisionId = sync.currentRevisionId;
      const pending: PendingLink = {
        fileId: sync.fileId,
        revisionId: sync.currentRevisionId,
        displayName: sync.displayName,
        sizeBytes: sync.sizeBytes,
        sha256Hex: sync.sha256Hex,
        payload: {
          evidence_code: state.evidenceCode,
          target_type: item.type,
          target_id: item.id,
          file_id: sync.fileId,
          revision_id: sync.currentRevisionId,
          idempotency_key: idempotency(),
        },
      };
      state.payload = pending;
      if (!current(generation)) return;
      try {
        await linkExisting(pending, generation);
      } catch (linkError) {
        if (current(generation)) {
          setPendingLink(pending);
          report(
            `Upload succeeded, but linking failed: ${safeMessage(linkError)} Retry linking without re-uploading.`,
          );
        }
      }
    } catch (e) {
      if (current(generation)) report(safeMessage(e));
    } finally {
      if (current(generation)) setLocalBusy(false);
    }
  }
  async function retry() {
    if (!pendingLink || localBusy) return;
    const generation = epoch.current;
    setLocalBusy(true);
    setError("");
    try {
      await linkExisting(pendingLink, generation);
    } catch (e) {
      if (current(generation))
        report(`The evidence remains uploaded but unlinked: ${safeMessage(e)}`);
    } finally {
      if (current(generation)) setLocalBusy(false);
    }
  }
  async function addExternal(event: FormEvent) {
    event.preventDefault();
    if (localBusy || busy) return;
    const generation = epoch.current;
    setLocalBusy(true);
    setError("");
    setNotice("");
    try {
      if (!canManage)
        throw new Error("You have read-only access to manufacturing evidence.");
      await authorized();
      if (!isHttps(externalUrl))
        throw new Error(
          "Evidence links must use HTTPS without credentials, query parameters, or fragments.",
        );
      const item = chooseTarget();
      const previous = externalAttempt.current;
      const key =
        previous?.target === `${item.type}:${item.id}` &&
        previous.url === externalUrl
          ? previous.key
          : idempotency();
      externalAttempt.current = {
        target: `${item.type}:${item.id}`,
        url: externalUrl,
        key,
      };
      await onCommand(
        "link_evidence",
        {
          evidence_code: `EV-${key}`,
          target_type: item.type,
          target_id: item.id,
          external_url: externalUrl,
          idempotency_key: key,
        },
        "External evidence link saved.",
      );
      if (current(generation)) {
        externalAttempt.current = null;
        setExternalUrl("");
        setNotice("External evidence link saved.");
      }
    } catch (e) {
      if (current(generation)) report(safeMessage(e));
    } finally {
      if (current(generation)) setLocalBusy(false);
    }
  }
  async function download(row: ManufacturingRecord) {
    if (localBusy || busy) return;
    const generation = epoch.current;
    setLocalBusy(true);
    setError("");
    try {
      if (!recordsKey)
        throw new Error(
          "Unlock the Manufacturing records key before downloading evidence.",
        );
      await authorized();
      const fileId = text(row, "file_id");
      const pinned = text(row, "revision_id");
      const rowWorkspace = text(row, "workspace_id");
      const sizeBytes = number(row, "size_bytes");
      const sha256Hex = text(row, "sha256_hex");
      const targetType = text(row, "target_type");
      const targetId = text(row, "target_id");
      const code = text(row, "evidence_code");
      if (
        !UUID.test(fileId) ||
        !UUID.test(pinned) ||
        !UUID.test(rowWorkspace) ||
        rowWorkspace.toLowerCase() !== workspaceId.toLowerCase() ||
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes < 1 ||
        !/^[0-9a-f]{64}$/i.test(sha256Hex) ||
        !targetType ||
        !targetId ||
        !code
      )
        throw new Error(
          "This evidence is missing pinned integrity metadata; refresh before downloading.",
        );
      const api = createOfficeCloudApi(client, publicKey, currentUserId);
      const sync = await api.getSyncState(fileId);
      if (
        !sync ||
        sync.workspaceId.toLowerCase() !== workspaceId.toLowerCase() ||
        sync.currentRevisionId.toLowerCase() !== pinned.toLowerCase() ||
        sync.sizeBytes !== sizeBytes ||
        sync.sha256Hex.toLowerCase() !== sha256Hex.toLowerCase()
      )
        throw new Error(
          "This evidence metadata or revision changed. Refresh before downloading; no different revision was downloaded.",
        );
      if (!current(generation)) return;
      const cloudFile: CloudFile = {
        fileId: sync.fileId,
        workspaceId: sync.workspaceId,
        displayName: sync.displayName,
        sizeBytes: sync.sizeBytes,
        sha256Hex: sync.sha256Hex,
        createdAt: sync.updatedAt,
      };
      const envelope = await api.download(cloudFile);
      if (!current(generation)) return;
      const opened = await decryptOfficeAttachment(
        recordsKey,
        envelope,
        manufacturingEvidenceAttachmentContext(
          workspaceId,
          code,
          targetType,
          targetId,
        ),
      );
      if (!current(generation)) return;
      const url = URL.createObjectURL(
        new Blob([opened.bytes as BlobPart], {
          type: opened.type || "application/octet-stream",
        }),
      );
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = opened.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (e) {
      if (current(generation)) report(safeMessage(e));
    } finally {
      if (current(generation)) setLocalBusy(false);
    }
  }
  async function supersede(row: ManufacturingRecord) {
    if (!canManage || localBusy || busy) return;
    const reason = reasons[text(row, "id")]?.trim() ?? "";
    if (!reason) {
      report("Enter a non-empty supersession reason before confirming.");
      return;
    }
    const generation = epoch.current;
    if (
      !(await confirm({
        title: "Supersede evidence",
        description:
          "This marks the evidence record superseded. It does not delete the cloud copy.",
        confirmLabel: "Supersede evidence",
        destructive: true,
      }))
    )
      return;
    if (!current(generation)) return;
    setLocalBusy(true);
    try {
      await authorized();
      if (!current(generation)) return;
      await onCommand(
        "supersede_evidence",
        {
          id: text(row, "id"),
          expected_version: row.version,
          reason,
          idempotency_key: idempotency(),
        },
        "Evidence superseded.",
      );
    } catch (e) {
      if (current(generation)) report(safeMessage(e));
    } finally {
      if (current(generation)) setLocalBusy(false);
    }
  }
  const evidenceRows = rows.filter(
    (row) =>
      text(row, "evidence_code") ||
      text(row, "file_id") ||
      text(row, "external_url"),
  );
  return (
    <section
      className="manufacturing-evidence-panel"
      aria-labelledby="manufacturing-evidence-title"
    >
      <div className="manufacturing-card">
        <h2 id="manufacturing-evidence-title">Manufacturing evidence</h2>
        <p>
          Files are encrypted in this browser before cloud storage. Cloud
          storage sees only the evidence code and encrypted bytes.
        </p>
        <p role="status">
          Bunny transfers are not yet end-to-end verified while credits are
          unavailable.
        </p>
        {!canManage && (
          <p role="status">
            Read-only access: you can download authorized pinned evidence, but
            cannot add or supersede records.
          </p>
        )}
        {!recordsKey && (
          <p role="status">
            Unlock the records key to upload or download encrypted files.
          </p>
        )}
        {canManage && (
          <>
            <form
              className="manufacturing-form"
              onSubmit={(event) => void upload(event)}
            >
              <label htmlFor="manufacturing-evidence-type">
                Evidence target type
              </label>
              <select
                id="manufacturing-evidence-type"
                value={targetType}
                onChange={(event) => {
                  setTargetType(
                    event.target.value as ManufacturingEvidenceTarget["type"],
                  );
                  setTarget("");
                  setSelectedRecord(undefined);
                }}
                disabled={localBusy}
              >
                <option value="lot">Lot</option>
                <option value="production_order">Production order</option>
                <option value="maintenance_order">Maintenance order</option>
                <option value="compliance_record">Compliance record</option>
              </select>
              {context ? (
                <ManufacturingRecordPicker
                  resource={resourceFor(targetType)}
                  name="manufacturing-evidence-target"
                  label="Evidence target"
                  value={target}
                  onChange={(value, record) => {
                    setTarget(value);
                    setSelectedRecord(record);
                  }}
                  disabled={localBusy || !recordsKey}
                  required
                />
              ) : (
                <>
                  <label htmlFor="manufacturing-evidence-target">
                    Evidence target
                  </label>
                  <select
                    id="manufacturing-evidence-target"
                    value={target}
                    onChange={(event) => setTarget(event.target.value)}
                    disabled={localBusy || !availableTargets?.length}
                  >
                    <option value="">Select evidence target</option>
                    {availableTargets?.map((item) => (
                      <option key={`${item.type}:${item.id}`} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <label htmlFor="manufacturing-evidence-file">
                Encrypted file
              </label>
              <input
                ref={fileInput}
                id="manufacturing-evidence-file"
                type="file"
                onChange={handleFile}
                disabled={localBusy || !recordsKey}
              />
              <button
                type="submit"
                className="manufacturing-button primary"
                disabled={localBusy || busy || !recordsKey || !file || !target}
              >
                Encrypt and upload
              </button>
            </form>
            <form
              className="manufacturing-form"
              onSubmit={(event) => void addExternal(event)}
            >
              <label htmlFor="manufacturing-evidence-url">
                External HTTPS evidence link
              </label>
              <input
                ref={urlInput}
                id="manufacturing-evidence-url"
                type="url"
                inputMode="url"
                value={externalUrl}
                onChange={(event) => setExternalUrl(event.target.value)}
                placeholder="https://example.org/evidence"
                disabled={localBusy}
              />
              <button
                type="submit"
                className="manufacturing-button"
                disabled={localBusy || busy || !target || !externalUrl}
              >
                Save HTTPS link
              </button>
            </form>
          </>
        )}
        {pendingLink && (
          <div className="manufacturing-evidence-retry" role="alert">
            <p>
              Upload succeeded but linking is pending. It will not be uploaded
              again. Keep this view open until linking completes.
            </p>
            <button
              type="button"
              className="manufacturing-button"
              onClick={() => void retry()}
              disabled={localBusy || busy}
            >
              Retry link
            </button>
          </div>
        )}
        {error && (
          <p className="manufacturing-field-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
      </div>
      <div className="manufacturing-card">
        <h3>Evidence records</h3>
        {evidenceRows.length === 0 ? (
          <p className="manufacturing-empty">
            No evidence is linked to the available targets yet.
          </p>
        ) : (
          <ul className="manufacturing-evidence-list">
            {evidenceRows.map((row) => {
              const external = text(row, "external_url");
              const validFile =
                UUID.test(text(row, "file_id")) &&
                UUID.test(text(row, "revision_id"));
              return (
                <li key={text(row, "id") || text(row, "evidence_code")}>
                  <strong>{text(row, "evidence_code") || "Evidence"}</strong>
                  <span>{text(row, "status") || "active"}</span>
                  {external ? (
                    <a
                      href={external}
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      Open external evidence
                    </a>
                  ) : validFile ? (
                    <button
                      type="button"
                      className="manufacturing-button"
                      onClick={() => void download(row)}
                      disabled={localBusy || busy || !recordsKey}
                    >
                      Download encrypted evidence
                    </button>
                  ) : null}
                  {!recordsKey && validFile && (
                    <small>Unlock the records key to download.</small>
                  )}
                  {canManage && text(row, "status") !== "superseded" && (
                    <>
                      <input
                        aria-label={`Supersession reason for ${text(row, "evidence_code") || "evidence"}`}
                        value={reasons[text(row, "id")] ?? ""}
                        onChange={(event) =>
                          setReasons((old) => ({
                            ...old,
                            [text(row, "id")]: event.target.value,
                          }))
                        }
                        placeholder="Reason for supersession"
                        disabled={localBusy}
                      />
                      <button
                        type="button"
                        className="manufacturing-button"
                        onClick={() => void supersede(row)}
                        disabled={localBusy || busy}
                      >
                        Supersede
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
