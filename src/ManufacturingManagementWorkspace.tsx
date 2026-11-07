import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps, FormEvent, ReactNode } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  Activity,
  Boxes,
  ClipboardCheck,
  FileBarChart2,
  Factory,
  FileText,
  PackageCheck,
  Settings2,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import ManufacturingEvidencePanel from "./ManufacturingEvidencePanel";
import ManufacturingDocumentDownloads from "./ManufacturingDocumentDownloads";
import ManufacturingOperationForm, {
  ManufacturingOperationFormsProvider,
  ManufacturingRecordPicker,
} from "./ManufacturingOperationForm";
import ManufacturingSupplierPrivatePanel from "./ManufacturingSupplierPrivatePanel";
import { FrostedConfirmProvider, useFrostedConfirm } from "./FrostedConfirm";
import { officeTeamApi } from "./lib/officeTeamApi";
import {
  getOfficeTeamClient,
  resolveOfficeTeamConfig,
} from "./lib/officeTeamSupabase";
import {
  createOfficeRecordsKeyConfig,
  unlockOfficeRecordsKeyConfig,
} from "./lib/officePrivateRecordsCrypto";
import {
  MANUFACTURING_COMMAND_FIELDS,
  manufacturingRecordsContext,
  officeManufacturingManagementApi,
  type ManufacturingAction,
  type ManufacturingBootstrap,
  type ManufacturingCapabilities,
  type ManufacturingRecord,
  type ManufacturingResource,
} from "./lib/officeManufacturingManagement";
import "./manufacturingManagement.css";

type Props = {
  workspaceId: string;
  officeName?: string;
  country?: string;
  accent?: string;
  onOpenTeam?: () => void;
};
type Status =
  | "initial-loading"
  | "signed-out"
  | "not-member"
  | "unassigned"
  | "ready"
  | "error";
type Tab =
  | "overview"
  | "materials"
  | "stock"
  | "production"
  | "quality"
  | "maintenance"
  | "safety"
  | "evidence"
  | "reports"
  | "settings"
  | "audit";
type Page = {
  rows: ManufacturingRecord[];
  total_count: number;
  offset: number;
  limit: number;
  has_more: boolean;
};
const PAGE = 100;
const idempotency = () => {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  throw new Error(
    "Secure request identifiers are unavailable in this browser.",
  );
};
const val = (
  row: ManufacturingRecord | undefined,
  key: string,
  fallback = "—",
) =>
  row &&
  (typeof row[key] === "string" ||
    typeof row[key] === "number" ||
    typeof row[key] === "boolean")
    ? String(row[key])
    : fallback;
const friendly = (error: unknown) => {
  const m =
    error instanceof Error ? error.message : "Manufacturing request failed.";
  if (/permission|row-level|42501/i.test(m))
    return "Your active Office Team membership or Manufacturing role does not allow that action.";
  if (/office_manufacturing|function|not enabled/i.test(m))
    return "Manufacturing Management is not enabled in this deployment. No changes were saved.";
  return m;
};
const tabs: {
  id: Tab;
  label: string;
  icon: typeof Activity;
  capability?: keyof ManufacturingCapabilities;
}[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "materials", label: "Materials", icon: Boxes, capability: "masters" },
  {
    id: "stock",
    label: "Stock",
    icon: PackageCheck,
    capability: "inventory_move",
  },
  {
    id: "production",
    label: "Production",
    icon: Factory,
    capability: "production",
  },
  {
    id: "quality",
    label: "Quality",
    icon: ClipboardCheck,
    capability: "quality",
  },
  {
    id: "maintenance",
    label: "Maintenance",
    icon: Wrench,
    capability: "maintenance",
  },
  {
    id: "safety",
    label: "Safety & permits",
    icon: ShieldCheck,
    capability: "compliance",
  },
  { id: "evidence", label: "Evidence", icon: FileText, capability: "evidence" },
  {
    id: "reports",
    label: "Reports",
    icon: FileBarChart2,
    capability: "reports",
  },
  {
    id: "settings",
    label: "Settings",
    icon: Settings2,
    capability: "settings",
  },
];
const tabResources: Record<Tab, ManufacturingResource[]> = {
  overview: [],
  materials: ["items", "suppliers", "locations", "assets", "boms", "bom_lines"],
  stock: ["lots", "stock_balances", "stock_movements", "stock_counts"],
  production: [
    "boms",
    "bom_lines",
    "production_orders",
    "order_requirements",
    "allocations",
  ],
  quality: ["lots", "inspections"],
  maintenance: ["assets", "maintenance_orders", "maintenance_parts"],
  safety: ["compliance_records"],
  evidence: [
    "evidence",
    "lots",
    "production_orders",
    "maintenance_orders",
    "compliance_records",
  ],
  reports: [],
  settings: ["staff_roles"],
  audit: ["audit"],
};
tabs.push({ id: "audit", label: "Audit", icon: FileText, capability: "audit" });
const capabilityForAction: Partial<
  Record<ManufacturingAction, keyof ManufacturingCapabilities>
> = {
  save_settings: "settings",
  assign_staff_role: "staff",
  configure_private_key: "settings",
  save_supplier_private: "private_records",
  save_item: "masters",
  save_supplier: "masters",
  save_location: "masters",
  save_asset: "masters",
  save_bom: "masters",
  save_bom_line: "masters",
  delete_bom_line: "masters",
  activate_bom: "masters",
  retire_bom: "masters",
  receive_stock: "inventory_receive",
  transfer_stock: "inventory_move",
  dispatch_stock: "inventory_move",
  scrap_stock: "inventory_move",
  submit_stock_count: "stock_count",
  review_stock_count: "stock_approve",
  save_production_order: "planning",
  allocate_material: "planning",
  remove_allocation: "planning",
  release_production_order: "planning",
  start_production_order: "production",
  pause_production_order: "production",
  resume_production_order: "production",
  return_production_material: "production",
  record_production_output: "production",
  cancel_production_order: "planning",
  record_lot_inspection: "quality",
  hold_lot: "quality",
  save_maintenance_order: "maintenance",
  transition_maintenance_order: "maintenance",
  issue_maintenance_part: "maintenance",
  return_maintenance_part: "maintenance",
  save_compliance_record: "compliance",
  transition_compliance_record: "compliance",
  link_evidence: "evidence",
  supersede_evidence: "evidence",
};

function Notice({
  children,
  role = "alert",
}: {
  children: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <div className="manufacturing-alert" role={role}>
      {children}
    </div>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="manufacturing-field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Empty({ children }: { children: ReactNode }) {
  return <div className="manufacturing-empty">{children}</div>;
}
function Card({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
}) {
  return (
    <section className="manufacturing-card">
      <header className="manufacturing-card-head">
        {eyebrow && <span className="manufacturing-eyebrow">{eyebrow}</span>}
        <h3>{title}</h3>
      </header>
      {children}
    </section>
  );
}
function ActionButton({
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className="manufacturing-button" {...props}>
      {children}
    </button>
  );
}

export default function ManufacturingManagementWorkspace(props: Props) {
  return (
    <FrostedConfirmProvider key={props.workspaceId}>
      <Workspace {...props} />
    </FrostedConfirmProvider>
  );
}

function Workspace({
  workspaceId,
  officeName = "COCCE Office",
  country = "Tanzania",
  accent = "#69a995",
  onOpenTeam,
}: Props) {
  const config = useMemo(
    () =>
      resolveOfficeTeamConfig(
        import.meta.env as Parameters<typeof resolveOfficeTeamConfig>[0],
      ),
    [],
  );
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const clientRef = useRef(client);
  clientRef.current = client;
  const epoch = useRef(0);
  const listingEpoch = useRef(0);
  const resourceTickets = useRef<Record<string, number>>({});
  const confirmChange = useFrostedConfirm();
  const privateEpoch = useRef(0);
  const readCache = useRef(new Map<string, Promise<Page | null>>());
  const [refreshToken, setRefreshToken] = useState(0);
  const currentView = useRef<{ tab: Tab; query: string }>({
    tab: "overview",
    query: "",
  });
  const actor = useRef<string | null>(null);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const [status, setStatus] = useState<Status>("initial-loading");
  const [boot, setBoot] = useState<ManufacturingBootstrap | null>(null);
  const [data, setData] = useState<Record<string, ManufacturingRecord[]>>({});
  const [pages, setPages] = useState<Record<string, Page>>({});
  const [tab, setTab] = useState<Tab>("overview");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [recordsKey, setRecordsKey] = useState<CryptoKey | null>(null);
  const clearPrivate = useCallback(() => {
    privateEpoch.current += 1;
    setRecordsKey(null);
  }, []);
  const clear = useCallback(() => {
    epoch.current += 1;
    listingEpoch.current += 1;
    readCache.current.clear();
    setBusy(false);
    setBoot(null);
    setData({});
    setPages({});
    setFeedback("");
    clearPrivate();
    actor.current = null;
  }, [clearPrivate]);
  const read = useCallback(
    async (
      resource: ManufacturingResource,
      filter: ManufacturingRecord = {},
      offset = 0,
      fresh = false,
    ) => {
      const token = epoch.current;
      if (!clientRef.current)
        throw new Error("Office Team is not enabled in this deployment.");
      const cacheKey = JSON.stringify([token, resource, filter, offset]);
      const cached = readCache.current.get(cacheKey);
      if (!fresh && cached) return cached;
      const request = (async () => {
        const result = (await officeManufacturingManagementApi.read(
          clientRef.current as SupabaseClient,
          workspaceId,
          resource,
          filter,
          PAGE,
          offset,
        )) as Page;
        if (token !== epoch.current || workspaceRef.current !== workspaceId)
          return null;
        return result;
      })();
      if (!fresh) readCache.current.set(cacheKey, request);
      try {
        return await request;
      } catch (error) {
        if (!fresh) readCache.current.delete(cacheKey);
        throw error;
      }
    },
    [workspaceId],
  );
  const readReportPage = useCallback(
    (
      resource: ManufacturingResource,
      filter: ManufacturingRecord = {},
      offset = 0,
    ) => read(resource, filter, offset, true),
    [read],
  );
  const loadResources = useCallback(
    async (nextTab: Tab, nextQuery = "") => {
      const resources =
        nextTab === "settings" && !boot?.capabilities.staff
          ? []
          : tabResources[nextTab];
      if (!resources.length || status !== "ready") return true;
      const token = epoch.current,
        ticket = ++listingEpoch.current;
      resources.forEach((resource) => {
        resourceTickets.current[resource] = ticket;
      });
      const results = await Promise.all(
        resources.map(async (resource) => {
          try {
            return {
              resource,
              page: await read(resource, nextQuery ? { q: nextQuery } : {}, 0),
              error: null,
            };
          } catch (error) {
            return { resource, page: null, error };
          }
        }),
      );
      if (token !== epoch.current) return true;
      const nextData: Record<string, ManufacturingRecord[]> = {},
        nextPages: Record<string, Page> = {};
      let failure = "";
      results.forEach(({ resource, page, error }) => {
        if (resourceTickets.current[resource] !== ticket) return;
        if (error) failure ||= friendly(error);
        if (page) {
          nextData[resource] = page.rows;
          nextPages[resource] = page;
        }
      });
      setData((old) => ({ ...old, ...nextData }));
      setPages((old) => ({ ...old, ...nextPages }));
      if (failure) setFeedback(failure);
      return !failure;
    },
    [boot?.capabilities.staff, read, status],
  );

  const refresh = useCallback(async () => {
    const token = ++epoch.current;
    listingEpoch.current += 1;
    readCache.current.clear();
    clearPrivate();
    setStatus("initial-loading");
    setBusy(false);
    setData({});
    setPages({});
    setFeedback("");
    try {
      if (config.status !== "ready" || !clientRef.current)
        throw new Error("Office Team is not enabled in this deployment.");
      const auth = await clientRef.current.auth.getUser();
      if (token !== epoch.current) return;
      actor.current = auth.data.user?.id ?? null;
      if (!actor.current) {
        setStatus("signed-out");
        clearPrivate();
        return;
      }
      const spaces = await officeTeamApi.listWorkspaces(clientRef.current);
      if (token !== epoch.current || workspaceRef.current !== workspaceId)
        return;
      if (!spaces.some((space) => space?.workspace_id === workspaceId)) {
        setStatus("not-member");
        return;
      }
      const raw = await officeManufacturingManagementApi.read(
        clientRef.current,
        workspaceId,
        "bootstrap",
      );
      if (token !== epoch.current || workspaceRef.current !== workspaceId)
        return;
      const next = raw as ManufacturingBootstrap;
      if (next.role === "unassigned") {
        setBoot(next);
        setStatus("unassigned");
        return;
      }
      setBoot(next);
      setStatus("ready");
    } catch (error) {
      if (token === epoch.current) {
        setStatus("error");
        setFeedback(friendly(error));
      }
    }
  }, [clearPrivate, config.status, workspaceId]);
  useEffect(() => {
    void refresh();
    return () => clear();
  }, [clear, refresh]);
  useEffect(() => {
    if (!client) return undefined;
    const subscription = client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session?.user) {
        clear();
        setStatus("signed-out");
      } else if (
        ["SIGNED_IN", "USER_UPDATED", "TOKEN_REFRESHED"].includes(event)
      )
        queueMicrotask(() => void refresh());
    });
    return () => subscription.data.subscription.unsubscribe();
  }, [client, clear, refresh]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        clearPrivate();
      } else if (document.visibilityState === "visible" && status === "ready")
        void refresh();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [clearPrivate, refresh, status]);
  const command = useCallback(
    async (
      action: ManufacturingAction,
      payload: ManufacturingRecord,
      success = "Saved.",
    ) => {
      const token = epoch.current;
      const capability = capabilityForAction[action];
      if (capability && !boot?.capabilities[capability])
        throw new Error("Your Manufacturing role does not allow that action.");
      if (
        [
          "scrap_stock",
          "hold_lot",
          "retire_bom",
          "delete_bom_line",
          "cancel_production_order",
        ].includes(action)
      ) {
        if (
          !(await confirmChange({
            title: "Confirm operational change",
            description:
              "Check the selected record, quantities and reason. This change is recorded in the audit trail; stock disposal, batch holds and production cancellation can affect current operations.",
            destructive: true,
          }))
        )
          throw new Error("Manufacturing command cancelled.");
        if (token !== epoch.current || workspaceRef.current !== workspaceId)
          throw new Error(
            "The workspace or account changed. No command was submitted.",
          );
      }
      setBusy(true);
      setFeedback("");
      try {
        if (!clientRef.current)
          throw new Error("Office Team is not enabled in this deployment.");
        const result = await officeManufacturingManagementApi.command(
          clientRef.current,
          workspaceId,
          action,
          {
            ...payload,
            idempotency_key: payload.idempotency_key ?? idempotency(),
          },
        );
        if (token !== epoch.current || workspaceRef.current !== workspaceId)
          return result;
        readCache.current.clear();
        try {
          const next = (await officeManufacturingManagementApi.read(
            clientRef.current,
            workspaceId,
            "bootstrap",
          )) as ManufacturingBootstrap;
          if (token !== epoch.current || workspaceRef.current !== workspaceId)
            return result;
          setBoot(next);
          setRefreshToken((value) => value + 1);
          setFeedback(success);
          const refreshed = await loadResources(
            currentView.current.tab,
            currentView.current.query,
          );
          if (!refreshed && token === epoch.current)
            setFeedback(
              "The change was saved, but some records could not refresh. Use Refresh records before making another change; do not submit this change again.",
            );
        } catch {
          if (token === epoch.current) {
            clearPrivate();
            setFeedback(
              "The change was saved, but its confirmation view could not refresh. Use Refresh records; do not submit the same change again.",
            );
          }
        }
        return result;
      } catch (error) {
        if (token === epoch.current) setFeedback(friendly(error));
        throw error;
      } finally {
        if (token === epoch.current) setBusy(false);
      }
    },
    [boot, clearPrivate, confirmChange, loadResources, workspaceId],
  );

  const loadPage = useCallback(
    async (resource: ManufacturingResource, offset: number) => {
      const listing = ++listingEpoch.current;
      const token = epoch.current;
      resourceTickets.current[resource] = listing;
      try {
        const page = await read(resource, query ? { q: query } : {}, offset);
        if (
          !page ||
          resourceTickets.current[resource] !== listing ||
          token !== epoch.current
        )
          return;
        setData((old) => ({ ...old, [resource]: page.rows }));
        setPages((old) => ({ ...old, [resource]: page }));
      } catch (error) {
        if (
          resourceTickets.current[resource] === listing &&
          token === epoch.current
        )
          setFeedback(friendly(error));
      }
    },
    [query, read],
  );
  const visibleTabs = tabs.filter((item) => {
    const caps = boot?.capabilities;
    if (!item.capability) return true;
    if (!caps) return false;
    if (item.id === "materials")
      return caps.masters || caps.inventory_receive || caps.maintenance;
    if (item.id === "stock")
      return (
        caps.inventory_receive ||
        caps.inventory_move ||
        caps.stock_count ||
        caps.stock_approve
      );
    if (item.id === "production")
      return caps.planning || caps.production || caps.masters;
    return caps[item.capability];
  });
  const activeTab = visibleTabs.some((item) => item.id === tab)
    ? tab
    : "overview";
  currentView.current = { tab: activeTab, query };
  useEffect(() => {
    if (status === "ready") void loadResources(activeTab, query);
  }, [activeTab, loadResources, query, status]);
  const capturedPrivateEpoch = privateEpoch.current;
  const capturedActor = actor.current;
  const updateRecordsKey = (key: CryptoKey | null) => {
    if (!key) {
      clearPrivate();
      return;
    }
    if (
      capturedPrivateEpoch === privateEpoch.current &&
      capturedActor === actor.current &&
      workspaceRef.current === workspaceId &&
      !document.hidden
    )
      setRecordsKey(key);
  };
  const targets = useMemo(
    () =>
      [
        ...(data.lots ?? []),
        ...(data.production_orders ?? []),
        ...(data.maintenance_orders ?? []),
        ...(data.compliance_records ?? []),
      ].flatMap((row) => {
        const type = row.batch_code
          ? "lot"
          : row.order_code
            ? "production_order"
            : row.work_code
              ? "maintenance_order"
              : row.record_code
                ? "compliance_record"
                : null;
        return type
          ? [
              {
                type,
                id: val(row, "id"),
                label: val(
                  row,
                  "batch_code",
                  val(
                    row,
                    "order_code",
                    val(row, "work_code", val(row, "record_code")),
                  ),
                ),
              },
            ]
          : [];
      }) as {
        type:
          | "lot"
          | "production_order"
          | "maintenance_order"
          | "compliance_record";
        id: string;
        label: string;
      }[],
    [data],
  );
  const common = {
    data,
    pages,
    busy,
    command,
    loadPage,
    refresh,
    capabilities: boot?.capabilities ?? null,
    query,
    setQuery,
    readResource: read,
    readReportPage,
    refreshToken,
    identityToken: `${workspaceId}:${actor.current}:${epoch.current}:${refreshToken}`,
    settings: boot?.settings ?? null,
  };
  const rootStyle = { "--manufacturing-accent": accent } as React.CSSProperties;
  if (status === "initial-loading")
    return (
      <main className="manufacturing-workspace" style={rootStyle}>
        <Hero
          country={country}
          officeName="Loading Manufacturing Management"
          role="loading"
        />
        <Notice role="status">
          Checking Office Team membership and manufacturing records.
        </Notice>
      </main>
    );
  return (
    <main
      className="manufacturing-workspace"
      style={rootStyle}
      aria-label="Manufacturing Management workspace"
    >
      <Hero
        country={country}
        officeName={officeName}
        role={boot?.role?.replaceAll("_", " ") ?? status}
      />
      {status === "signed-out" && (
        <Notice>Sign in to access this Manufacturing workspace.</Notice>
      )}
      {status === "not-member" && (
        <Notice>
          You are not an active member of this Office Team workspace.{" "}
          {onOpenTeam && (
            <ActionButton onClick={onOpenTeam}>Open Office Team</ActionButton>
          )}
        </Notice>
      )}
      {status === "unassigned" && (
        <Notice>
          Your Office Team membership is active, but a Manufacturing role has
          not been assigned yet.
        </Notice>
      )}
      {status === "error" && (
        <Notice>
          {feedback || "Manufacturing Management could not be loaded."}
        </Notice>
      )}
      {feedback && status === "ready" && (
        <Notice role="status">{feedback}</Notice>
      )}
      {status === "ready" && boot && (
        <>
          <nav
            className="manufacturing-tabs"
            aria-label="Manufacturing sections"
            role="tablist"
          >
            {visibleTabs.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                role="tab"
                aria-selected={activeTab === id}
                className={activeTab === id ? "active" : ""}
                onClick={() => setTab(id)}
              >
                <Icon size={15} />
                {label}
              </button>
            ))}
          </nav>
          <div className="manufacturing-action-row">
            <ActionButton disabled={busy} onClick={() => void refresh()}>
              Refresh records
            </ActionButton>
          </div>
          <ManufacturingOperationFormsProvider
            value={{
              data: { ...data, settings: boot.settings ? [boot.settings] : [] },
              pages,
              readPage: read,
              readFreshPage: readReportPage,
              capabilities: boot.capabilities,
              refreshToken,
            }}
          >
            <div className="manufacturing-content">
              {activeTab === "overview" && (
                <>
                  <Overview boot={boot} />
                  {boot.capabilities.private_records &&
                    !boot.capabilities.evidence && (
                      <KeyPanel
                        keyConfig={boot.key_config}
                        recordsKey={recordsKey}
                        setRecordsKey={updateRecordsKey}
                        clearPrivate={clearPrivate}
                        workspaceId={workspaceId}
                        command={command}
                        busy={busy}
                        canConfigure={!!boot.capabilities.settings}
                        canAccess
                      />
                    )}
                </>
              )}
              {activeTab === "materials" && (
                <>
                  <Materials {...common} />
                  {boot.capabilities.private_records && (
                    <>
                      <KeyPanel
                        keyConfig={boot.key_config}
                        recordsKey={recordsKey}
                        setRecordsKey={updateRecordsKey}
                        clearPrivate={clearPrivate}
                        workspaceId={workspaceId}
                        command={command}
                        busy={busy}
                        canConfigure={!!boot.capabilities.settings}
                        canAccess
                      />
                      <ManufacturingSupplierPrivatePanel
                        workspaceId={workspaceId}
                        recordsKey={recordsKey}
                        canManage={boot.capabilities.private_records}
                        identityToken={`${workspaceId}:${actor.current}:${epoch.current}`}
                        readPage={read}
                        onCommand={command}
                        busy={busy}
                      />
                    </>
                  )}
                </>
              )}
              {activeTab === "stock" && <Stock {...common} />}
              {activeTab === "production" && <Production {...common} />}
              {activeTab === "quality" && <Quality {...common} />}
              {activeTab === "maintenance" && <Maintenance {...common} />}
              {activeTab === "safety" && <Safety {...common} />}
              {activeTab === "evidence" && (
                <>
                  <KeyPanel
                    keyConfig={boot.key_config}
                    recordsKey={recordsKey}
                    setRecordsKey={updateRecordsKey}
                    clearPrivate={clearPrivate}
                    workspaceId={workspaceId}
                    command={command}
                    busy={busy}
                    canConfigure={!!boot.capabilities.settings}
                    canAccess
                  />
                  <ManufacturingEvidencePanel
                    client={clientRef.current as SupabaseClient}
                    publicKey={config.status === "ready" ? config.anonKey : ""}
                    workspaceId={workspaceId}
                    currentUserId={actor.current ?? ""}
                    recordsKey={recordsKey}
                    canManage={!!boot.capabilities.evidence}
                    rows={data.evidence ?? []}
                    targets={targets}
                    busy={busy}
                    onCommand={command}
                    onError={setFeedback}
                  />
                </>
              )}
              {activeTab === "reports" && <Reports {...common} />}
              {activeTab === "audit" && (
                <Table
                  resource="audit"
                  rows={data.audit ?? []}
                  page={pages.audit}
                  loadPage={loadPage}
                  columns={[
                    "created_at",
                    "action",
                    "actor_id",
                    "entity_id",
                    "post_version",
                  ]}
                />
              )}
              {activeTab === "settings" && (
                <Settings
                  {...common}
                  keyConfig={boot.key_config}
                  recordsKey={recordsKey}
                  setRecordsKey={updateRecordsKey}
                  clearPrivate={clearPrivate}
                  workspaceId={workspaceId}
                />
              )}
            </div>
          </ManufacturingOperationFormsProvider>
          {activeTab !== "overview" && <Summary summary={boot.summary} />}
        </>
      )}
    </main>
  );
}
function Hero({
  country,
  officeName,
  role,
}: {
  country: string;
  officeName: string;
  role: string;
}) {
  return (
    <section className="manufacturing-hero">
      <div className="manufacturing-mark">
        <Factory size={25} />
      </div>
      <div>
        <span className="manufacturing-eyebrow">
          {country} · factory operations
        </span>
        <h2>{officeName}</h2>
        <p>
          Traceable materials, controlled production, independent quality and
          maintenance records.
        </p>
      </div>
      <span className="manufacturing-role">{role}</span>
    </section>
  );
}
function Summary({ summary }: { summary: Record<string, number> }) {
  return (
    <div className="manufacturing-summary" aria-label="Server summary">
      {Object.entries(summary).map(([key, value]) => (
        <div key={key}>
          <span>{key.replaceAll("_", " ")}</span>
          <strong>{String(value)}</strong>
        </div>
      ))}
    </div>
  );
}
function Overview({ boot }: { boot: ManufacturingBootstrap }) {
  return (
    <>
      <div className="manufacturing-stat-grid">
        {Object.entries(boot.summary).map(([key, value]) => (
          <div className="manufacturing-stat" key={key}>
            <span>{key.replaceAll("_", " ")}</span>
            <strong>{String(value)}</strong>
            <small>server count</small>
          </div>
        ))}
      </div>
      <Card title="Operating boundaries" eyebrow="Actual records only">
        <p className="manufacturing-muted">
          All stock and production changes are server-validated, version guarded
          and audited. Incoming and manufactured lots begin in quarantine;
          quality release is independent of production.
        </p>
        <p className="manufacturing-muted">
          Quantities and costs are exact decimal strings. Tanzania Mainland
          official portals are manual references only and are shown after
          jurisdiction is configured.
        </p>
      </Card>
    </>
  );
}
function Table({
  resource,
  rows,
  page,
  loadPage,
  columns,
}: {
  resource: ManufacturingResource;
  rows: ManufacturingRecord[];
  page?: Page;
  loadPage: (resource: ManufacturingResource, offset: number) => Promise<void>;
  columns: string[];
}) {
  return (
    <Card title={resource.replaceAll("_", " ")}>
      <div className="manufacturing-table-wrap">
        {rows.length ? (
          <table className="manufacturing-table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column}>{column.replaceAll("_", " ")}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={val(row, "id", String(index))}>
                  {columns.map((column) => (
                    <td key={column}>{val(row, column)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty>
            {page
              ? `No matching ${resource.replaceAll("_", " ")} records were returned.`
              : "Confirmed records have not loaded yet. Use Refresh records to retry if needed."}
          </Empty>
        )}
      </div>
      <Pager resource={resource} page={page} loadPage={loadPage} />
    </Card>
  );
}
function Pager({
  resource,
  page,
  loadPage,
}: {
  resource: ManufacturingResource;
  page?: Page;
  loadPage: (resource: ManufacturingResource, offset: number) => Promise<void>;
}) {
  if (!page || (page.offset === 0 && !page.has_more)) return null;
  return (
    <div className="manufacturing-pager">
      <ActionButton
        disabled={page.offset === 0}
        onClick={() =>
          void loadPage(resource, Math.max(0, page.offset - page.limit))
        }
      >
        Previous
      </ActionButton>
      <span>
        Rows {page.offset + 1}–{page.offset + page.rows.length} of{" "}
        {page.total_count}
      </span>
      <ActionButton
        disabled={!page.has_more}
        onClick={() => void loadPage(resource, page.offset + page.limit)}
      >
        Next
      </ActionButton>
    </div>
  );
}
function Search({
  query,
  setQuery,
}: {
  query: string;
  setQuery: (value: string) => void;
}) {
  return (
    <Field label="Search server records">
      <input
        value={query}
        maxLength={120}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by code, name or status"
      />
    </Field>
  );
}
function MasterForm(props: ComponentProps<typeof ManufacturingOperationForm>) {
  return <ManufacturingOperationForm {...props} />;
}
type Operation = {
  action: ManufacturingAction;
  title: string;
  fields: string[];
};
function OperationDeck({
  operations,
  command,
  busy,
  capabilities,
}: {
  operations: Operation[];
  command: ComponentProps<typeof ManufacturingOperationForm>["command"];
  busy: boolean;
  capabilities: ManufacturingCapabilities | null;
}) {
  const allowed = operations.filter(
    (op) =>
      !capabilityForAction[op.action] ||
      !!capabilities?.[capabilityForAction[op.action]!],
  );
  const [selected, setSelected] = useState<ManufacturingAction | null>(null);
  const operation = allowed.find((op) => op.action === selected) ?? allowed[0];
  if (!operation) return null;
  return (
    <section className="manufacturing-operation-deck">
      <Field label="Choose an operation">
        <select
          value={operation.action}
          onChange={(event) =>
            setSelected(event.target.value as ManufacturingAction)
          }
        >
          {allowed.map((op) => (
            <option key={op.action} value={op.action}>
              {op.title}
            </option>
          ))}
        </select>
      </Field>
      <MasterForm
        key={operation.action}
        {...operation}
        command={command}
        busy={busy}
      />
    </section>
  );
}

function Materials({
  data,
  pages,
  command,
  loadPage,
  busy,
  query,
  setQuery,
  capabilities,
}: any) {
  return (
    <>
      <Card title="Materials & master records" eyebrow="Reference labels only">
        <Search query={query} setQuery={setQuery} />
        <p className="manufacturing-muted">
          Keep names, contact details and identity numbers in the encrypted
          supplier panel, not public reference labels or operational notes.
        </p>
      </Card>
      <OperationDeck
        operations={[
          {
            action: "save_item",
            title: "Save material or product",
            fields: [...MANUFACTURING_COMMAND_FIELDS.save_item],
          },
          {
            action: "save_supplier",
            title: "Save supplier organization",
            fields: [...MANUFACTURING_COMMAND_FIELDS.save_supplier],
          },
          {
            action: "save_location",
            title: "Save stock location",
            fields: [...MANUFACTURING_COMMAND_FIELDS.save_location],
          },
          {
            action: "save_asset",
            title: "Save equipment asset",
            fields: [...MANUFACTURING_COMMAND_FIELDS.save_asset],
          },
        ]}
        command={command}
        busy={busy}
        capabilities={capabilities}
      />
      <div className="manufacturing-grid">
        <Table
          resource="items"
          rows={data.items ?? []}
          page={pages.items}
          loadPage={loadPage}
          columns={["sku", "name", "kind", "unit", "reorder_point", "status"]}
        />
        <Table
          resource="suppliers"
          rows={data.suppliers ?? []}
          page={pages.suppliers}
          loadPage={loadPage}
          columns={["supplier_code", "display_label", "status"]}
        />
        <Table
          resource="locations"
          rows={data.locations ?? []}
          page={pages.locations}
          loadPage={loadPage}
          columns={["code", "name", "status"]}
        />
        <Table
          resource="assets"
          rows={data.assets ?? []}
          page={pages.assets}
          loadPage={loadPage}
          columns={["asset_code", "name", "status", "next_service_date"]}
        />
      </div>
    </>
  );
}

function Stock({
  data,
  pages,
  command,
  loadPage,
  busy,
  query,
  setQuery,
  capabilities,
}: any) {
  return (
    <>
      <Card
        title="Stock control"
        eyebrow="Exact quantities · quarantine before use"
      >
        <Search query={query} setQuery={setQuery} />
        <p className="manufacturing-muted">
          Select actual lots and locations. Current stock versions are loaded
          automatically. Receipts require quality release; count approval must
          be independent of the counter.
        </p>
      </Card>
      <OperationDeck
        operations={[
          {
            action: "receive_stock",
            title: "Receive incoming stock",
            fields: [...MANUFACTURING_COMMAND_FIELDS.receive_stock],
          },
          {
            action: "transfer_stock",
            title: "Transfer between locations",
            fields: [...MANUFACTURING_COMMAND_FIELDS.transfer_stock],
          },
          {
            action: "dispatch_stock",
            title: "Dispatch released stock",
            fields: [...MANUFACTURING_COMMAND_FIELDS.dispatch_stock],
          },
          {
            action: "scrap_stock",
            title: "Record stock disposal",
            fields: [...MANUFACTURING_COMMAND_FIELDS.scrap_stock],
          },
          {
            action: "submit_stock_count",
            title: "Submit an independent stock count",
            fields: [...MANUFACTURING_COMMAND_FIELDS.submit_stock_count],
          },
          {
            action: "review_stock_count",
            title: "Review a submitted stock count",
            fields: [...MANUFACTURING_COMMAND_FIELDS.review_stock_count],
          },
        ]}
        command={command}
        busy={busy}
        capabilities={capabilities}
      />
      <div className="manufacturing-grid">
        <Table
          resource="stock_balances"
          rows={data.stock_balances ?? []}
          page={pages.stock_balances}
          loadPage={loadPage}
          columns={[
            "batch_code",
            "item_name",
            "location_name",
            "on_hand",
            "reserved",
            "available",
            "lot_status",
          ]}
        />
        <Table
          resource="stock_movements"
          rows={data.stock_movements ?? []}
          page={pages.stock_movements}
          loadPage={loadPage}
          columns={[
            "kind",
            "batch_code",
            "quantity",
            "reference",
            "reason",
            "created_at",
          ]}
        />
        <Table
          resource="stock_counts"
          rows={data.stock_counts ?? []}
          page={pages.stock_counts}
          loadPage={loadPage}
          columns={[
            "batch_code",
            "location_name",
            "expected_quantity",
            "counted_quantity",
            "status",
            "reason",
            "review_reason",
          ]}
        />
      </div>
    </>
  );
}

function Production({
  data,
  pages,
  command,
  loadPage,
  busy,
  query,
  setQuery,
  capabilities,
}: any) {
  const confirm = useFrostedConfirm();
  const [stage, setStage] = useState("planning");
  const groups = [
    { id: "recipes", label: "Recipes", allowed: capabilities?.masters },
    { id: "planning", label: "Planning", allowed: capabilities?.planning },
    { id: "floor", label: "Shop floor", allowed: capabilities?.production },
  ].filter((group) => group.allowed);
  const selected = groups.some((group) => group.id === stage)
    ? stage
    : groups[0]?.id;
  const guarded = async (
    action: ManufacturingAction,
    payload: ManufacturingRecord,
    success?: string,
  ) => {
    if (
      ["record_production_output", "start_production_order"].includes(action) &&
      !(await confirm({
        title: "Confirm production change",
        description:
          "This records a real production or inventory change. Check the selected order and quantities before continuing.",
        destructive: action === "cancel_production_order",
      }))
    )
      throw new Error("Production command cancelled.");
    return command(action, payload, success);
  };
  return (
    <>
      <Card
        title="Production control"
        eyebrow="Recipe → reserve → release → run → independent quality"
      >
        <Search query={query} setQuery={setQuery} />
        <p className="manufacturing-muted">
          Recipes are frozen on activation. Orders snapshot component
          requirements; actual issues, returns, scrap and costs remain
          traceable.
        </p>
      </Card>
      <nav className="manufacturing-tabs" aria-label="Production stages">
        {groups.map((group) => (
          <button
            key={group.id}
            className={selected === group.id ? "active" : ""}
            aria-pressed={selected === group.id}
            onClick={() => setStage(group.id)}
          >
            {group.label}
          </button>
        ))}
      </nav>
      {selected === "recipes" && (
        <>
          <OperationDeck
            operations={[
              {
                action: "save_bom",
                title: "Save a draft recipe revision",
                fields: [...MANUFACTURING_COMMAND_FIELDS.save_bom],
              },
              {
                action: "save_bom_line",
                title: "Save a recipe component",
                fields: [...MANUFACTURING_COMMAND_FIELDS.save_bom_line],
              },
              {
                action: "delete_bom_line",
                title: "Remove a draft recipe component",
                fields: [...MANUFACTURING_COMMAND_FIELDS.delete_bom_line],
              },
              {
                action: "activate_bom",
                title: "Activate a checked recipe",
                fields: [...MANUFACTURING_COMMAND_FIELDS.activate_bom],
              },
              {
                action: "retire_bom",
                title: "Retire an active recipe",
                fields: [...MANUFACTURING_COMMAND_FIELDS.retire_bom],
              },
            ]}
            command={command}
            busy={busy}
            capabilities={capabilities}
          />
          <div className="manufacturing-grid">
            <Table
              resource="boms"
              rows={data.boms ?? []}
              page={pages.boms}
              loadPage={loadPage}
              columns={[
                "bom_code",
                "revision",
                "kind",
                "product_name",
                "output_quantity",
                "status",
              ]}
            />
            <Table
              resource="bom_lines"
              rows={data.bom_lines ?? []}
              page={pages.bom_lines}
              loadPage={loadPage}
              columns={["bom_code", "sku", "item_name", "quantity", "unit"]}
            />
          </div>
        </>
      )}
      {selected === "planning" && (
        <>
          <OperationDeck
            operations={[
              {
                action: "save_production_order",
                title: "Save a planned production order",
                fields: [...MANUFACTURING_COMMAND_FIELDS.save_production_order],
              },
              {
                action: "allocate_material",
                title: "Reserve a component lot",
                fields: [...MANUFACTURING_COMMAND_FIELDS.allocate_material],
              },
              {
                action: "remove_allocation",
                title: "Remove a reserved allocation",
                fields: [...MANUFACTURING_COMMAND_FIELDS.remove_allocation],
              },
              {
                action: "release_production_order",
                title: "Release a fully reserved order",
                fields: [
                  ...MANUFACTURING_COMMAND_FIELDS.release_production_order,
                ],
              },
              {
                action: "cancel_production_order",
                title: "Cancel a production order",
                fields: [
                  ...MANUFACTURING_COMMAND_FIELDS.cancel_production_order,
                ],
              },
            ]}
            command={command}
            busy={busy}
            capabilities={capabilities}
          />
        </>
      )}
      {selected === "floor" && (
        <OperationDeck
          operations={[
            {
              action: "start_production_order",
              title: "Start a released order",
              fields: [...MANUFACTURING_COMMAND_FIELDS.start_production_order],
            },
            {
              action: "pause_production_order",
              title: "Pause an active order",
              fields: [...MANUFACTURING_COMMAND_FIELDS.pause_production_order],
            },
            {
              action: "resume_production_order",
              title: "Resume a paused order",
              fields: [...MANUFACTURING_COMMAND_FIELDS.resume_production_order],
            },
            {
              action: "return_production_material",
              title: "Return unused issued material",
              fields: [
                ...MANUFACTURING_COMMAND_FIELDS.return_production_material,
              ],
            },
            {
              action: "record_production_output",
              title: "Record finished output and scrap",
              fields: [
                ...MANUFACTURING_COMMAND_FIELDS.record_production_output,
              ],
            },
          ]}
          command={guarded}
          busy={busy}
          capabilities={capabilities}
        />
      )}
      {selected !== "recipes" && (
        <div className="manufacturing-grid">
          <Table
            resource="production_orders"
            rows={data.production_orders ?? []}
            page={pages.production_orders}
            loadPage={loadPage}
            columns={[
              "order_code",
              "product_name",
              "status",
              "target_quantity",
              "output_quantity",
              "scrap_quantity",
              "total_cost",
            ]}
          />
          <Table
            resource="order_requirements"
            rows={data.order_requirements ?? []}
            page={pages.order_requirements}
            loadPage={loadPage}
            columns={[
              "order_code",
              "sku",
              "required_quantity",
              "allocated_quantity",
              "issued_quantity",
            ]}
          />
          <Table
            resource="allocations"
            rows={data.allocations ?? []}
            page={pages.allocations}
            loadPage={loadPage}
            columns={[
              "order_code",
              "batch_code",
              "location_name",
              "quantity",
              "returned_quantity",
              "status",
            ]}
          />
        </div>
      )}
    </>
  );
}

function Quality({
  data,
  pages,
  command,
  loadPage,
  busy,
  query,
  setQuery,
  capabilities,
  readResource,
  refreshToken,
}: any) {
  const [lotId, setLotId] = useState("");
  const [genealogy, setGenealogy] = useState<Page | null>(null);
  const [error, setError] = useState("");
  const request = useRef(0);
  const loadGenealogy = useCallback(
    async (offset = 0) => {
      const token = ++request.current;
      if (!lotId) {
        setGenealogy(null);
        return;
      }
      try {
        const page = await readResource(
          "lot_genealogy",
          { lot_id: lotId },
          offset,
        );
        if (token === request.current) setGenealogy(page);
      } catch (value) {
        if (token === request.current) setError(friendly(value));
      }
    },
    [lotId, readResource],
  );
  useEffect(() => {
    setError("");
    setGenealogy(null);
    void loadGenealogy();
    return () => {
      request.current += 1;
    };
  }, [loadGenealogy, refreshToken]);
  return (
    <>
      <Card
        title="Independent quality review"
        eyebrow="Internal decisions, not regulator approval"
      >
        <Search query={query} setQuery={setQuery} />
        <p className="manufacturing-muted">
          Finished-batch release cannot be approved by the person who started
          production. Holds and failed inspections quarantine already-produced
          downstream lots, including completed batches.
        </p>
      </Card>
      <OperationDeck
        operations={[
          {
            action: "record_lot_inspection",
            title: "Record an inspection decision",
            fields: [...MANUFACTURING_COMMAND_FIELDS.record_lot_inspection],
          },
          {
            action: "hold_lot",
            title: "Hold a lot and its downstream batches",
            fields: [...MANUFACTURING_COMMAND_FIELDS.hold_lot],
          },
        ]}
        command={command}
        busy={busy}
        capabilities={capabilities}
      />
      <div className="manufacturing-grid">
        <Table
          resource="lots"
          rows={data.lots ?? []}
          page={pages.lots}
          loadPage={loadPage}
          columns={[
            "batch_code",
            "item_name",
            "status",
            "unit_cost",
            "expiry_date",
          ]}
        />
        <Table
          resource="inspections"
          rows={data.inspections ?? []}
          page={pages.inspections}
          loadPage={loadPage}
          columns={[
            "batch_code",
            "result",
            "standard_reference",
            "observations",
            "created_at",
          ]}
        />
      </div>
      <Card title="Batch genealogy">
        <ManufacturingRecordPicker
          resource="lots"
          name="genealogy_lot"
          label="Trace batch"
          value={lotId}
          onChange={setLotId}
          allowBlank
        />
        {error && <Notice>{error}</Notice>}
        {!lotId && (
          <Empty>
            Select an actual batch to inspect its material and output links.
          </Empty>
        )}
        {lotId && (
          <Table
            resource="lot_genealogy"
            rows={genealogy?.rows ?? []}
            page={genealogy ?? undefined}
            loadPage={(_resource, offset) => loadGenealogy(offset)}
            columns={[
              "relation",
              "batch_code",
              "linked_batch_code",
              "order_code",
              "quantity",
              "lot_status",
            ]}
          />
        )}
      </Card>
    </>
  );
}

function Maintenance({
  data,
  pages,
  command,
  loadPage,
  busy,
  query,
  setQuery,
  capabilities,
}: any) {
  return (
    <>
      <Card
        title="Equipment & maintenance"
        eyebrow="Critical jobs block production"
      >
        <Search query={query} setQuery={setQuery} />
        <p className="manufacturing-muted">
          Issue released components or consumables to an active job. Return
          unused parts before verification. A different authorized person
          verifies completion and may return the asset to service.
        </p>
      </Card>
      <OperationDeck
        operations={[
          {
            action: "save_maintenance_order",
            title: "Save a maintenance work order",
            fields: [...MANUFACTURING_COMMAND_FIELDS.save_maintenance_order],
          },
          {
            action: "transition_maintenance_order",
            title: "Update or verify a work order",
            fields: [
              ...MANUFACTURING_COMMAND_FIELDS.transition_maintenance_order,
            ],
          },
          {
            action: "issue_maintenance_part",
            title: "Issue a maintenance part",
            fields: [...MANUFACTURING_COMMAND_FIELDS.issue_maintenance_part],
          },
          {
            action: "return_maintenance_part",
            title: "Return an unused maintenance part",
            fields: [...MANUFACTURING_COMMAND_FIELDS.return_maintenance_part],
          },
        ]}
        command={command}
        busy={busy}
        capabilities={capabilities}
      />
      <div className="manufacturing-grid">
        <Table
          resource="maintenance_orders"
          rows={data.maintenance_orders ?? []}
          page={pages.maintenance_orders}
          loadPage={loadPage}
          columns={[
            "work_code",
            "asset_name",
            "kind",
            "priority",
            "due_date",
            "status",
            "parts_cost",
          ]}
        />
        <Table
          resource="maintenance_parts"
          rows={data.maintenance_parts ?? []}
          page={pages.maintenance_parts}
          loadPage={loadPage}
          columns={[
            "work_code",
            "batch_code",
            "item_name",
            "quantity",
            "returned_quantity",
            "unit_cost",
          ]}
        />
        <Table
          resource="assets"
          rows={data.assets ?? []}
          page={pages.assets}
          loadPage={loadPage}
          columns={["asset_code", "name", "status", "next_service_date"]}
        />
      </div>
    </>
  );
}

function Safety({
  data,
  pages,
  command,
  loadPage,
  busy,
  query,
  setQuery,
  capabilities,
  settings,
}: any) {
  const mainland = settings?.jurisdiction === "tanzania_mainland";
  return (
    <>
      <Card
        title="Safety, permits & corrective actions"
        eyebrow="Internal compliance register"
      >
        <Search query={query} setQuery={setQuery} />
        <p className="manufacturing-muted">
          Keep personal injury details and identity data in encrypted evidence,
          not the public operational register. Closure requires independent
          verification and a reference or active evidence.
        </p>
      </Card>
      <OperationDeck
        operations={[
          {
            action: "save_compliance_record",
            title: "Save a compliance record",
            fields: [...MANUFACTURING_COMMAND_FIELDS.save_compliance_record],
          },
          {
            action: "transition_compliance_record",
            title: "Update or verify a compliance record",
            fields: [
              ...MANUFACTURING_COMMAND_FIELDS.transition_compliance_record,
            ],
          },
        ]}
        command={command}
        busy={busy}
        capabilities={capabilities}
      />
      <Table
        resource="compliance_records"
        rows={data.compliance_records ?? []}
        page={pages.compliance_records}
        loadPage={loadPage}
        columns={[
          "record_code",
          "record_type",
          "authority",
          "title",
          "due_date",
          "severity",
          "status",
        ]}
      />
      <Card title="Official portals · manual access">
        {mainland ? (
          <>
            <p className="manufacturing-muted">
              Tanzania Mainland is configured. These are manual reference links
              only; no filing, certification, levy, product mark or regulator
              approval is performed by this workspace.
            </p>
            <div className="manufacturing-links">
              <a
                href="https://www.osha.go.tz/"
                target="_blank"
                rel="noreferrer"
              >
                OSHA Tanzania
              </a>
              <a href="https://www.tbs.go.tz/" target="_blank" rel="noreferrer">
                Tanzania Bureau of Standards
              </a>
              <a
                href="https://www.nemc.or.tz/"
                target="_blank"
                rel="noreferrer"
              >
                National Environment Management Council
              </a>
            </div>
          </>
        ) : (
          <p className="manufacturing-muted">
            {settings?.jurisdiction
              ? "Mainland guidance is not enabled for this jurisdiction. Maintain the applicable local requirements and their manual references in your records."
              : "An administrator must configure the factory jurisdiction before Mainland-specific portal guidance is shown."}
          </p>
        )}
      </Card>
    </>
  );
}

function Reports({
  query,
  setQuery,
  readResource,
  readReportPage,
  identityToken,
}: any) {
  const [report, setReport] = useState<"stock_report" | "production_report">(
    "stock_report",
  );
  const [from, setFrom] = useState(""),
    [to, setTo] = useState("");
  const [reportPage, setReportPage] = useState<Page | null>(null),
    [error, setError] = useState("");
  const ticket = useRef(0);
  const filter = useMemo(
    () => ({
      ...(query ? { q: query } : {}),
      ...(report === "production_report" && from ? { from_date: from } : {}),
      ...(report === "production_report" && to ? { to_date: to } : {}),
    }),
    [query, from, to, report],
  );
  const fetchPage = useCallback(
    async (offset = 0) => {
      const token = ++ticket.current;
      setError("");
      try {
        const page = await readResource(report, filter, offset);
        if (token === ticket.current) setReportPage(page);
      } catch (value) {
        if (token === ticket.current) setError(friendly(value));
      }
    },
    [readResource, report, filter],
  );
  useEffect(() => {
    setReportPage(null);
    void fetchPage();
    return () => {
      ticket.current += 1;
    };
  }, [fetchPage, identityToken]);
  const columns =
    report === "stock_report"
      ? [
          "sku",
          "name",
          "unit",
          "on_hand",
          "reserved",
          "available",
          "value_tzs",
          "low_stock",
        ]
      : [
          "order_code",
          "status",
          "due_date",
          "target_quantity",
          "output_quantity",
          "scrap_quantity",
          "material_cost",
          "labour_cost",
          "overhead_cost",
          "total_cost",
          "unit_cost",
        ];
  return (
    <>
      <Card
        title="Actual server reports"
        eyebrow="Whole-dataset calculations · exact decimals"
      >
        <div className="manufacturing-report-toolbar">
          <Field label="Report">
            <select
              value={report}
              onChange={(event) =>
                setReport(event.target.value as typeof report)
              }
            >
              <option value="stock_report">Stock report</option>
              <option value="production_report">Production report</option>
            </select>
          </Field>
          <Search query={query} setQuery={setQuery} />
          {report === "production_report" && (
            <>
              <Field label="Created from · Tanzania date">
                <input
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </Field>
              <Field label="Created to · Tanzania date">
                <input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(event) => setTo(event.target.value)}
                />
              </Field>
            </>
          )}
        </div>
        <p className="manufacturing-muted">
          The table is paginated. Downloads include every matching record, not
          just this page. Costs are operational estimates, not fiscal documents.
          Stock availability excludes held and expired lots.
        </p>
        <ManufacturingDocumentDownloads
          resource={report}
          columns={columns}
          filter={filter}
          readPage={readReportPage}
          identityToken={identityToken}
        />
        {error && <Notice>{error}</Notice>}
      </Card>
      <Table
        resource={report}
        rows={reportPage?.rows ?? []}
        page={reportPage ?? undefined}
        loadPage={(_resource, offset) => fetchPage(offset)}
        columns={columns}
      />
    </>
  );
}

function KeyPanel({
  command,
  busy,
  keyConfig,
  recordsKey,
  setRecordsKey,
  clearPrivate,
  workspaceId,
  canConfigure = false,
  canAccess = true,
}: any) {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [working, setWorking] = useState(false);
  const operation = useRef(0);
  const confirm = useFrostedConfirm();
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) {
        operation.current += 1;
        setPassphrase("");
        setError("");
        setWorking(false);
      }
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      operation.current += 1;
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [workspaceId]);
  const run = async () => {
    if (working || busy || !canAccess) return;
    const token = ++operation.current;
    setError("");
    setWorking(true);
    try {
      const context = manufacturingRecordsContext(workspaceId);
      if (keyConfig.configured) {
        const key = await unlockOfficeRecordsKeyConfig(
          passphrase,
          keyConfig,
          context,
        );
        if (token !== operation.current || document.hidden) return;
        setRecordsKey(key);
        setPassphrase("");
      } else {
        if (!canConfigure)
          throw new Error(
            "An administrator must configure the workspace key first.",
          );
        if (
          !(await confirm({
            title: "Configure the private records key",
            description:
              "There is no passphrase recovery. Keep the passphrase safe and share it only with authorized colleagues who need encrypted records. The app never stores it.",
          }))
        )
          return;
        if (token !== operation.current || document.hidden) return;
        const created = await createOfficeRecordsKeyConfig(passphrase, context);
        if (token !== operation.current || document.hidden) return;
        await command(
          "configure_private_key",
          created.payload,
          "Private records key configured.",
        );
        if (token !== operation.current || document.hidden) return;
        setRecordsKey(created.key);
        setPassphrase("");
      }
    } catch (value) {
      if (token === operation.current) setError(friendly(value));
    } finally {
      if (token === operation.current) setWorking(false);
    }
  };
  if (!canAccess) return null;
  return (
    <Card title="Private records key" eyebrow="AES-256-GCM · memory only">
      <p className="manufacturing-muted">
        The passphrase is never stored or sent to the server. Keys and private
        fields lock on sign-out, hidden tab, workspace change and user change. A
        lost passphrase cannot be recovered.
      </p>
      {recordsKey ? (
        <>
          <p role="status">Unlocked for this session.</p>
          <ActionButton
            onClick={() => {
              operation.current += 1;
              setPassphrase("");
              clearPrivate();
            }}
          >
            Lock private records
          </ActionButton>
        </>
      ) : !keyConfig.configured && !canConfigure ? (
        <Empty>
          A Manufacturing administrator must configure the workspace key before
          authorized staff can unlock evidence.
        </Empty>
      ) : (
        <form
          className="manufacturing-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <Field label="Workspace passphrase">
            <input
              type="password"
              autoComplete="off"
              minLength={12}
              required
              value={passphrase}
              disabled={working || busy}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </Field>
          <button
            type="submit"
            className="manufacturing-button primary"
            disabled={working || busy || passphrase.length < 12}
          >
            {working
              ? "Deriving secure key…"
              : keyConfig.configured
                ? "Unlock private records"
                : "Configure workspace key"}
          </button>
        </form>
      )}
      {error && (
        <p className="manufacturing-field-error" role="alert">
          {error}
        </p>
      )}
    </Card>
  );
}

function StaffRoles({ rows, command, busy }: any) {
  const active = (rows as ManufacturingRecord[]).filter(
    (row) =>
      val(row, "status", "active") === "active" &&
      !["owner", "admin"].includes(val(row, "team_role", "member")),
  );
  const [selected, setSelected] = useState("");
  const [role, setRole] = useState("unassigned");
  const [error, setError] = useState("");
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const member = active.find((row) => val(row, "user_id") === selected);
    if (!member) {
      setError("Choose an active Office Team member.");
      return;
    }
    const payload: ManufacturingRecord = { user_id: selected, role };
    const version = typeof member.version === "number" ? member.version : 0;
    if (version > 0) payload.expected_version = version;
    try {
      setError("");
      await command(
        "assign_staff_role",
        payload,
        "Manufacturing role assigned.",
      );
    } catch (value) {
      setError(friendly(value));
    }
  };
  if (!active.length)
    return (
      <Card title="Manufacturing staff roles">
        <Empty>
          Office Team owners and administrators already have Manufacturing
          administration access. Invite active Team members to assign specialist
          roles.
        </Empty>
      </Card>
    );
  return (
    <Card
      title="Manufacturing staff roles"
      eyebrow="Active Office Team members only"
    >
      <p className="manufacturing-muted">
        Assignments use safe short member references and Team roles; no new
        plaintext personal data is transmitted. Workspace owner/admin membership
        is immutable and remains Manufacturing administrator.
      </p>
      <form
        className="manufacturing-form"
        onSubmit={(event) => void submit(event)}
      >
        <Field label="Active member">
          <select
            value={selected}
            onChange={(event) => {
              setSelected(event.target.value);
              const member = active.find(
                (row) => val(row, "user_id") === event.target.value,
              );
              setRole(val(member, "role", "unassigned"));
            }}
            required
          >
            <option value="">Choose an active member</option>
            {active.map((member) => (
              <option
                key={val(member, "user_id")}
                value={val(member, "user_id")}
              >
                {val(member, "member_ref", val(member, "id", "member"))} ·{" "}
                {val(member, "team_role", "Team member")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Manufacturing role">
          <select
            value={role}
            onChange={(event) => setRole(event.target.value)}
          >
            {[
              "unassigned",
              "manufacturing_admin",
              "production_planner",
              "storekeeper",
              "production_operator",
              "quality_reviewer",
              "maintenance_engineer",
              "safety_officer",
              "manufacturing_viewer",
            ].map((item) => (
              <option key={item} value={item}>
                {item.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </Field>
        <ActionButton
          type="submit"
          className="primary"
          disabled={busy || !selected}
        >
          Save staff role
        </ActionButton>
        {error && (
          <div className="manufacturing-field-error" role="alert">
            {error}
          </div>
        )}
      </form>
    </Card>
  );
}
function Settings({
  data,
  command,
  busy,
  keyConfig,
  recordsKey,
  setRecordsKey,
  clearPrivate,
  workspaceId,
}: any) {
  return (
    <div className="manufacturing-grid">
      <Card title="Factory settings">
        <MasterForm
          action="save_settings"
          title="Factory settings"
          fields={["factory_name", "jurisdiction"]}
          command={command}
          busy={busy}
        />
        <p className="manufacturing-muted">
          Currency is fixed to TZS and timezone to Africa/Dar_es_Salaam by the
          server. Zanzibar and other jurisdictions do not inherit Mainland
          assumptions.
        </p>
      </Card>
      <StaffRoles rows={data.staff_roles ?? []} command={command} busy={busy} />
      <KeyPanel
        keyConfig={keyConfig}
        recordsKey={recordsKey}
        setRecordsKey={setRecordsKey}
        clearPrivate={clearPrivate}
        workspaceId={workspaceId}
        command={command}
        busy={busy}
        canConfigure
        canAccess
      />
    </div>
  );
}
