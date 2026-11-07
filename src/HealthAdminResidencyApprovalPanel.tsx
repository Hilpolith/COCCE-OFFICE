import { useState } from "react";
import { useFrostedConfirm } from "./FrostedConfirm";
import type { HealthAdminPanelProps } from "./healthAdminWorkspaceTypes";
import type { HealthAdminResidencyAction, HealthAdminResidencyPayload, HealthAdminSettings } from "./lib/officeHealthAdminManagement";

const idempotency = () => globalThis.crypto?.randomUUID?.() ?? "00000000-0000-4000-8000-000000000001";
const asSettings = (settings: HealthAdminSettings | null) => settings;
const text = (value: unknown) => value ? String(value) : "Not recorded";

export default function HealthAdminResidencyApprovalPanel({ context }: HealthAdminPanelProps) {
  const settings = asSettings(context.settings);
  const [reference, setReference] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const confirm = useFrostedConfirm();
  const status = settings?.residency_approval_status ?? "unrecorded";
  const recordedBy = settings?.residency_approval_recorded_by;
  const verifiedBy = settings?.residency_approval_verified_by;
  const distinctReviewers = Boolean(recordedBy && verifiedBy && recordedBy !== verifiedBy);
  const canEnable = settings?.storage_review_state === "approved" && status === "approved" && Boolean(settings?.residency_approval_reference) && distinctReviewers && context.keyConfig.configured;
  const expectedVersion = Number(settings?.version);
  const run = async (action: HealthAdminResidencyAction, payload: HealthAdminResidencyPayload) => { setBusy(true); setFeedback(""); try { await context.residencyCommand(action, payload); setFeedback("Residency setting recorded. Refreshing current settings."); await context.refresh(); } catch (error) { setFeedback(error instanceof Error ? error.message : "Residency setting was not changed."); } finally { setBusy(false); } };
  const record = async (event: React.FormEvent) => { event.preventDefault(); if (!reference.trim() || !Number.isSafeInteger(expectedVersion)) return; await run("record_approval", { reference: reference.trim(), expected_version: expectedVersion, idempotency_key: idempotency() }); setReference(""); };
  const verify = async () => { if (!Number.isSafeInteger(expectedVersion)) return; await run("verify_approval", { decision, expected_version: expectedVersion, idempotency_key: idempotency() }); };
  const toggle = async () => { if (!Number.isSafeInteger(expectedVersion)) return; const enabled = !settings?.clinical_data_enabled; if (enabled && !(await confirm({ title: "Explicitly open clinical storage", description: "Enable only after confirming the competent-authority approval, two-person review, approved storage review, and configured key. Patient queues and clinical reads/writes will remain blocked if this is cancelled.", confirmLabel: "Enable clinical gate", destructive: true, allowBackdropClose: false }))) return; await run("set_clinical_gate", { enabled, expected_version: expectedVersion, idempotency_key: idempotency() }); };
  return <section className="health-admin-card" aria-labelledby="health-residency-title">
    <h3 id="health-residency-title">Clinical data residency and approval</h3>
    <p className="health-admin-muted">Clinical data region: <strong>Singapore (ap-southeast-1)</strong>. Tanzania health data requires documented competent-authority approval; the document reference must point to a real approval. No approval document has been supplied, so this panel does not pre-fill or invent one.</p>
    {!settings && <div className="health-admin-alert" role="status">No Health Administration settings row exists yet. The residency controls are closed and the clinical gate remains disabled.</div>}
    <dl><div><dt>Approval state</dt><dd>{text(status)}</dd></div><div><dt>Approval reference</dt><dd>{text(settings?.residency_approval_reference)}</dd></div><div><dt>Recorded by / at</dt><dd>{text(recordedBy)} · {text(settings?.residency_approval_recorded_at)}</dd></div><div><dt>Verified by / at</dt><dd>{text(verifiedBy)} · {text(settings?.residency_approval_verified_at)}</dd></div><div><dt>Clinical gate</dt><dd>{settings?.clinical_data_enabled === true ? "Open" : "Closed"}</dd></div></dl>
    {context.capabilities.privacy_ops && (context.role === "health_admin" || context.role === "privacy_officer") && <>
      <form onSubmit={(event) => void record(event)}><label><span>Real competent-authority document reference</span><input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Enter only a supplied reference" maxLength={500} /></label><button type="submit" className="health-admin-button" disabled={busy || !reference.trim() || !Number.isSafeInteger(expectedVersion)}>Record approval reference</button></form>
      <div><label><span>Independent evidence decision</span><select value={decision} onChange={(event) => setDecision(event.target.value as "approved" | "rejected")}><option value="approved">Approve recorded evidence</option><option value="rejected">Reject recorded evidence</option></select></label><button type="button" className="health-admin-button" onClick={() => void verify()} disabled={busy || !Number.isSafeInteger(expectedVersion) || !settings?.residency_approval_reference || recordedBy === context.userId}>Record independent decision</button></div>
      <button type="button" className="health-admin-button" onClick={() => void toggle()} disabled={busy || !Number.isSafeInteger(expectedVersion) || !settings || (settings.clinical_data_enabled !== true && !canEnable)}>{settings?.clinical_data_enabled === true ? "Disable clinical gate" : "Enable clinical gate"}</button>
      {!canEnable && settings?.clinical_data_enabled !== true && <p className="health-admin-muted">Enable remains unavailable until storage review is approved, evidence is approved with a reference, the recorded and verifying actors differ, and key configuration is complete.</p>}
    </>}
    {feedback && <div className="health-admin-alert" role="status">{feedback}</div>}
  </section>;
}
