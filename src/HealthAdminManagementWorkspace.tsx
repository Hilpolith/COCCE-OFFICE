import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import {
  Activity,
  BedDouble,
  CalendarClock,
  ClipboardCheck,
  FileBarChart2,
  FlaskConical,
  LockKeyhole,
  Package,
  Pill,
  ShieldCheck,
  Stethoscope,
  Users,
  WalletCards,
} from "lucide-react";
import { FrostedConfirmProvider, useFrostedConfirm } from "./FrostedConfirm";
import { officeTeamApi } from "./lib/officeTeamApi";
import { getOfficeTeamClient, resolveOfficeTeamConfig } from "./lib/officeTeamSupabase";
import { HEALTH_ADMIN_CAPABILITIES, officeHealthAdminApi, officeHealthAdminResidencyApi, type HealthAdminAccessPurpose, type HealthAdminAction, type HealthAdminBootstrap, type HealthAdminCapabilities, type HealthAdminClient, type HealthAdminPage, type HealthAdminRecord, type HealthAdminResource, type HealthAdminRole, type HealthAdminResidencyAction, type HealthAdminResidencyPayload, type HealthAdminSettings } from "./lib/officeHealthAdminManagement";
import { createOfficeHealthAdminKeyConfig, unlockOfficeHealthAdminKeys, openHealthAdminPrivateRecord, sealHealthAdminPrivateRecord, makeHealthAdminBlindIndex } from "./lib/officeHealthAdminCrypto";
import type { HealthAdminIndexKind, HealthAdminPanelId, HealthAdminPanelProps, HealthAdminPrivateScope, HealthAdminWorkspaceContext } from "./healthAdminWorkspaceTypes";
import HealthAdminClinicalPanels from "./HealthAdminClinicalPanels";
import HealthAdminOperationsPanels from "./HealthAdminOperationsPanels";
import "./healthAdminManagement.css";

type Props = { workspaceId: string; officeName?: string; country?: string; accent?: string; onOpenTeam?: () => void };
type Status = "loading" | "signed-out" | "not-member" | "suspended" | "unassigned" | "ready" | "error";

type Panel = { id: HealthAdminPanelId; label: string; icon: typeof Activity; capability?: keyof HealthAdminWorkspaceContext["capabilities"] };
const panels: Panel[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "patients", label: "Patient desk", icon: Users, capability: "patient_registration" },
  { id: "appointments", label: "Appointments & triage", icon: CalendarClock, capability: "appointments" },
  { id: "encounters", label: "Encounters & notes", icon: Stethoscope, capability: "encounters" },
  { id: "diagnostics", label: "Diagnostics", icon: FlaskConical, capability: "diagnostic_orders" },
  { id: "inpatient", label: "Inpatient & procedures", icon: BedDouble, capability: "inpatient" },
  { id: "pharmacy", label: "Pharmacy", icon: Pill, capability: "pharmacy_dispense" },
  { id: "billing", label: "Billing & claims", icon: WalletCards, capability: "billing" },
  { id: "facilities", label: "Facilities & workforce", icon: ClipboardCheck, capability: "facility_admin" },
  { id: "assets", label: "Assets & supplies", icon: Package, capability: "asset_admin" },
  { id: "privacy", label: "Privacy & integrations", icon: ShieldCheck, capability: "privacy_ops" },
  { id: "reports", label: "Reports & audit", icon: FileBarChart2, capability: "reports" },
];
const PAGE_SIZE = 100;
const genericError = "Health Administration could not complete that request. Nothing was changed.";
const requestId = () => globalThis.crypto?.randomUUID?.() ?? "";
const roleCapabilityMap: Record<HealthAdminRole, readonly (keyof HealthAdminCapabilities)[]> = {
  health_admin: ["settings", "facility_admin", "staff_roles", "reports", "audit", "export"],
  facility_manager: ["settings", "facility_admin", "licenses", "asset_admin", "inventory", "reports"],
  registration_clerk: ["settings", "patient_registration", "patient_identity_read", "appointments", "encounters"],
  triage_nurse: ["settings", "patient_identity_read", "triage", "appointments", "encounters"],
  clinician: ["settings", "patient_registration", "patient_identity_read", "clinical_notes", "diagnostic_orders", "diagnostic_results", "medication_orders", "procedures", "discharge", "encounters", "inpatient"],
  lab_staff: ["settings", "patient_identity_read", "diagnostic_orders", "diagnostic_results"],
  pharmacist: ["settings", "patient_identity_read", "pharmacy_dispense", "inventory", "medication_orders"],
  ward_nurse: ["settings", "patient_identity_read", "inpatient", "medication_admin"],
  billing_clerk: ["settings", "patient_identity_read", "billing", "claims"],
  credentialing_officer: ["settings", "credentialing", "staff_roles"],
  privacy_officer: ["settings", "privacy_ops", "audit", "evidence"],
  health_auditor: ["settings", "audit", "reports"],
  health_viewer: ["settings", "reports"],
  unassigned: [],
};
export const HEALTH_ADMIN_ROLE_CAPABILITIES = roleCapabilityMap;
const capabilitiesForRole = (role: HealthAdminRole): HealthAdminCapabilities => {
  const capabilities = Object.fromEntries(HEALTH_ADMIN_CAPABILITIES.map((key) => [key, false])) as HealthAdminCapabilities;
  for (const capability of roleCapabilityMap[role]) capabilities[capability] = true;
  return capabilities;
};

export function isHealthAdminStorageReady(bootstrap: HealthAdminBootstrap | null): boolean {
  return bootstrap?.clinical_data_enabled === true && bootstrap.storage_review_state === "approved";
}

export function makeHealthAdminPrivateKeyPayload(keyConfig: NonNullable<HealthAdminBootstrap["key_config"]>, expectedVersion: number): HealthAdminRecord {
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error("A current Health Administration settings version is required.");
  return { key_config: keyConfig, expected_version: expectedVersion };
}

export function makeHealthAdminAuditExportPayload(resource: HealthAdminResource, entityIds: string[], format: "csv" | "pdf" | "print", purpose: HealthAdminAccessPurpose): HealthAdminRecord {
  return { resource, entity_ids: entityIds, format, purpose_code: purpose };
}

function Notice({ children, role = "alert" }: { children: ReactNode; role?: "alert" | "status" }) { return <div className="health-admin-alert" role={role}>{children}</div>; }
function Button(props: React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button type="button" className="health-admin-button" {...props} />; }

export default function HealthAdminManagementWorkspace(props: Props) {
  return <FrostedConfirmProvider key={props.workspaceId}><Workspace {...props} /></FrostedConfirmProvider>;
}

function Workspace({ workspaceId, officeName = "COCCE Office", country = "Tanzania", accent = "#65aaa1", onOpenTeam }: Props) {
  const config = useMemo(() => resolveOfficeTeamConfig(import.meta.env as Parameters<typeof resolveOfficeTeamConfig>[0]), []);
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const clientRef = useRef(client); clientRef.current = client;
  const epoch = useRef(0);
  const workspaceRef = useRef(workspaceId); workspaceRef.current = workspaceId;
  const activityTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [bootstrap, setBootstrap] = useState<HealthAdminBootstrap | null>(null);
  const [settings, setSettings] = useState<HealthAdminRecord | null>(null);
  const [userId, setUserId] = useState("");
  const [panel, setPanel] = useState<HealthAdminPanelId>("overview");
  const [recordsKey, setRecordsKey] = useState<CryptoKey | null>(null);
  const [indexKey, setIndexKey] = useState<CryptoKey | null>(null);
  const [data, setData] = useState<Partial<Record<HealthAdminResource, HealthAdminRecord[]>>>({});
  const [pages, setPages] = useState<Partial<Record<HealthAdminResource, HealthAdminPage>>>({});
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const confirm = useFrostedConfirm();

  const clearPrivate = useCallback(() => { setRecordsKey(null); setIndexKey(null); }, []);
  const reset = useCallback(() => { epoch.current += 1; clearPrivate(); setBootstrap(null); setSettings(null); setUserId(""); setData({}); setPages({}); setFeedback(""); setBusy(false); setPanel("overview"); }, [clearPrivate]);
  const fail = useCallback((error: unknown) => { console.error(genericError); setFeedback(error instanceof Error && /storage|location|review/i.test(error.message) ? "Clinical storage is not approved for this deployment. PHI reads, writes, uploads and exports remain blocked." : genericError); }, []);

  const refresh = useCallback(async () => {
    const token = ++epoch.current; reset(); epoch.current = token; setStatus("loading");
    try {
      if (config.status !== "ready" || !clientRef.current) throw new Error("deployment unavailable");
      const auth = await clientRef.current.auth.getUser(); const actor = auth.data.user?.id;
      if (!actor) { setStatus("signed-out"); return; }
      setUserId(actor);
      const spaces = await officeTeamApi.listWorkspaces(clientRef.current);
      const membership = spaces.find((space) => space.workspace_id === workspaceId);
      if (!membership) { setStatus("not-member"); return; }
      if ((membership as Record<string, unknown>).status === "suspended") { setStatus("suspended"); return; }
      const next = await officeHealthAdminApi.read(clientRef.current as HealthAdminClient, workspaceId, "bootstrap") as HealthAdminBootstrap;
      if (token !== epoch.current) return;
      setBootstrap(next);
      if (next.role === "unassigned") { setSettings(null); setStatus("unassigned"); return; }
      const settingsPage = await officeHealthAdminApi.read(clientRef.current as HealthAdminClient, workspaceId, "settings", {}, PAGE_SIZE, 0, "aggregate_reporting") as HealthAdminPage;
      if (token !== epoch.current) return;
      setSettings(settingsPage?.rows[0] ?? null); setStatus("ready");
    } catch (error) { if (token === epoch.current) { fail(error); setStatus("error"); } }
  }, [clientRef, config.status, fail, reset, workspaceId]);

  useEffect(() => { void refresh(); return reset; }, [refresh, reset]);
  useEffect(() => { const subscription = client?.auth.onAuthStateChange((event, session) => { if (event === "SIGNED_OUT" || !session?.user) { reset(); setStatus("signed-out"); } else if (["SIGNED_IN", "USER_UPDATED"].includes(event)) void refresh(); }); return () => subscription?.data.subscription.unsubscribe(); }, [client, refresh, reset]);
  useEffect(() => { const onVisibility = () => { if (document.visibilityState === "hidden") { reset(); setStatus("signed-out"); } else if (document.visibilityState === "visible") void refresh(); }; document.addEventListener("visibilitychange", onVisibility); return () => document.removeEventListener("visibilitychange", onVisibility); }, [refresh, reset]);
  useEffect(() => { const onActivity = () => { if (activityTimer.current) clearTimeout(activityTimer.current); activityTimer.current = setTimeout(() => { reset(); setStatus("signed-out"); }, 15 * 60 * 1000); }; ["pointerdown", "keydown", "touchstart"].forEach((event) => window.addEventListener(event, onActivity)); onActivity(); return () => { if (activityTimer.current) clearTimeout(activityTimer.current); ["pointerdown", "keydown", "touchstart"].forEach((event) => window.removeEventListener(event, onActivity)); }; }, [reset]);

  const read = useCallback(async (resource: HealthAdminResource, filter: HealthAdminRecord = {}, offset = 0, purpose?: Parameters<HealthAdminWorkspaceContext["read"]>[3]) => {
    if (!isHealthAdminStorageReady(bootstrap) && resource !== "bootstrap") throw new Error("storage gate");
    if (status !== "ready") throw new Error("not ready");
    const page = await officeHealthAdminApi.read(clientRef.current as HealthAdminClient, workspaceId, resource, filter, PAGE_SIZE, offset, purpose) as HealthAdminPage;
    setData((old) => ({ ...old, [resource]: page.rows })); setPages((old) => ({ ...old, [resource]: page })); return page;
  }, [bootstrap, status, workspaceId]);
  const command = useCallback(async (action: HealthAdminAction, payload: HealthAdminRecord) => {
    if (!isHealthAdminStorageReady(bootstrap) && action !== "configure_private_key") throw new Error("storage gate");
    if (status !== "ready") throw new Error("not ready");
    if (action === "configure_private_key" && bootstrap?.role !== "health_admin") throw new Error("Health Administration owner capability required");
    if (action !== "configure_private_key" && !(await confirm({ title: "Confirm Health Administration action", description: "This action is recorded in the immutable audit trail. Continue only after reviewing the selected records.", destructive: false }))) throw new Error("Action cancelled.");
    setBusy(true); try { const result = await officeHealthAdminApi.command(clientRef.current as HealthAdminClient, workspaceId, action, { ...payload, idempotency_key: requestId() }); return result; } catch (error) { fail(error); throw new Error(genericError); } finally { setBusy(false); }
  }, [bootstrap, confirm, fail, status, workspaceId]);
  const residencyCommand = useCallback(async (action: HealthAdminResidencyAction, payload: HealthAdminResidencyPayload) => {
    if (status !== "ready" || !bootstrap?.role || !(bootstrap.role === "health_admin" || bootstrap.role === "privacy_officer")) throw new Error("Health admin or privacy officer capability required");
    setBusy(true); try { return await officeHealthAdminResidencyApi.command(clientRef.current as HealthAdminClient, workspaceId, action, payload); } catch (error) { fail(error); throw new Error(genericError); } finally { setBusy(false); }
  }, [bootstrap?.role, fail, status, workspaceId]);
  const lockPrivate = useCallback(() => { clearPrivate(); setData({}); setPages({}); }, [clearPrivate]);
  const setFeedbackSafe = useCallback((message: string) => setFeedback(message), []);
  const sealPrivate = useCallback(<T extends Record<string, unknown>>(recordId: string, scope: HealthAdminPrivateScope, value: T) => { if (!recordsKey) return Promise.reject(new Error("Private records are locked.")); return sealHealthAdminPrivateRecord(recordsKey, workspaceId, recordId, scope, value); }, [recordsKey, workspaceId]);
  const openPrivate = useCallback(<T extends Record<string, unknown>>(recordId: string, scope: HealthAdminPrivateScope, payload: { nonce: string; ciphertext: string }) => { if (!recordsKey) return Promise.reject(new Error("Private records are locked.")); return openHealthAdminPrivateRecord<T>(recordsKey, workspaceId, recordId, scope, payload); }, [recordsKey, workspaceId]);
  const settingsKeyConfig = settings?.key_config as HealthAdminWorkspaceContext["keyConfig"] | undefined;
  const typedSettings = settings as HealthAdminSettings | null;
  const context = useMemo<HealthAdminWorkspaceContext>(() => ({ workspaceId, officeName, country, userId, role: bootstrap?.role ?? "unassigned", capabilities: capabilitiesForRole(bootstrap?.role ?? "unassigned"), storageReady: isHealthAdminStorageReady(bootstrap), storageState: bootstrap?.storage_review_state ?? "unverified", settings: typedSettings, keyConfig: settingsKeyConfig ?? { configured: false }, recordsKey, indexKey, busy, data, pages, read, command, residencyCommand, sealPrivate, openPrivate, makeBlindIndex: (kind: HealthAdminIndexKind, value: string) => { if (!indexKey) return Promise.reject(new Error("Private records are locked.")); return makeHealthAdminBlindIndex(indexKey, workspaceId, kind, value); }, findPatient: async (kind, value, purpose) => { if (!indexKey) throw new Error("Private records are locked."); const page = await read("patient_matches" as HealthAdminResource, { index_type: kind, digest: (await makeHealthAdminBlindIndex(indexKey, workspaceId, kind, value)).digest }, 0, purpose); return page?.rows ?? []; }, auditExport: async (resource, entityIds, format, purpose) => { if (!isHealthAdminStorageReady(bootstrap)) throw new Error("storage gate"); await command("audit_sensitive_export" as HealthAdminAction, makeHealthAdminAuditExportPayload(resource, entityIds, format, purpose)); }, refresh, lockPrivate, setFeedback: setFeedbackSafe }), [bootstrap, busy, command, country, data, indexKey, officeName, openPrivate, pages, read, recordsKey, refresh, residencyCommand, sealPrivate, setFeedbackSafe, settingsKeyConfig, typedSettings, userId, workspaceId]);

  const unlock = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const passphrase = String(new FormData(event.currentTarget).get("passphrase") ?? ""); try { if (!passphrase) throw new Error("passphrase"); const result = settingsKeyConfig?.configured ? { keys: await unlockOfficeHealthAdminKeys(passphrase, settingsKeyConfig as never, workspaceId), config: settingsKeyConfig } : await createOfficeHealthAdminKeyConfig(passphrase, workspaceId); if (!settingsKeyConfig?.configured) await command("configure_private_key", makeHealthAdminPrivateKeyPayload(result.config, Number(settings?.version ?? NaN))); setRecordsKey(result.keys.recordsKey); setIndexKey(result.keys.indexKey); setFeedbackSafe("Private records key unlocked in memory only."); } catch (error) { fail(error); } };
  const visiblePanels = panels.filter((item) => !item.capability || capabilitiesForRole(bootstrap?.role ?? "unassigned")[item.capability]);
  const activePanel = visiblePanels.some((item) => item.id === panel) ? panel : "overview";
  const rootStyle = { "--health-admin-accent": accent } as CSSProperties;
  const panelProps: HealthAdminPanelProps = { context };

  return <main className="health-admin-workspace" style={rootStyle} aria-label="Health Administration workspace">
    <header className="health-admin-hero"><div className="health-admin-mark"><Activity size={24} aria-hidden="true" /></div><div><span className="health-admin-eyebrow">{country} · Pearl Light Glass HIMS</span><h1>{officeName}</h1><p>Facility-level records, routing and administration. Clinical decisions remain with authorized people.</p></div><span className="health-admin-role">{bootstrap?.role?.replaceAll("_", " ") ?? status}</span></header>
    {status === "loading" && <Notice role="status">Checking your Office membership and Health Administration access.</Notice>}
    {status === "signed-out" && <Notice>Sign in to access this workspace. Decrypted rows and private keys are cleared.</Notice>}
    {status === "not-member" && <Notice>You are not an active member of this Office workspace. {onOpenTeam && <Button onClick={onOpenTeam}>Open Office Team</Button>}</Notice>}
    {status === "suspended" && <Notice>Your Office membership is suspended. Health Administration is unavailable.</Notice>}
    {status === "unassigned" && <Notice>Your membership has no assigned Health Administration role yet.</Notice>}
    {status === "error" && <Notice>{feedback || genericError}</Notice>}
    {status === "ready" && bootstrap && !isHealthAdminStorageReady(bootstrap) && <Notice><strong>Clinical storage location is not approved.</strong> PHI reads, writes, attachment uploads and exports are blocked until the owner-controlled deployment review enables an approved location.</Notice>}
    {feedback && status === "ready" && <Notice role="status">{feedback}</Notice>}
    {status === "ready" && <>
      <nav className="health-admin-tabs" aria-label="Health Administration sections">{visiblePanels.map((item) => <button key={item.id} className={activePanel === item.id ? "active" : ""} aria-current={activePanel === item.id ? "page" : undefined} onClick={() => { lockPrivate(); setPanel(item.id); }}><item.icon size={16} aria-hidden="true" />{item.label}</button>)}</nav>
      <section className="health-admin-key-panel" aria-label="Private records key"><div><span className="health-admin-eyebrow">Private records</span><strong>{recordsKey ? "Unlocked in memory" : "Locked"}</strong><p>Keys and decrypted clinical text never enter browser storage.</p></div>{recordsKey ? <Button onClick={() => { lockPrivate(); setFeedbackSafe("Private records locked and decrypted rows cleared."); }}><LockKeyhole size={15} /> Lock</Button> : <form className="health-admin-unlock-form" onSubmit={unlock}><label>Passphrase<input type="password" name="passphrase" autoComplete="off" required /></label><Button className="primary" disabled={busy}><LockKeyhole size={15} /> Unlock</Button></form>}</section>
      <section className="health-admin-content" aria-live="polite">{activePanel === "overview" || ["patients", "appointments", "encounters", "diagnostics", "inpatient", "pharmacy", "billing"].includes(activePanel) ? <HealthAdminClinicalPanels {...panelProps} /> : <HealthAdminOperationsPanels {...panelProps} area={activePanel === "assets" ? "assets" : activePanel === "facilities" ? "facilities" : activePanel === "privacy" ? "privacy" : "reports"} />}</section>
    </>}
  </main>;
}
