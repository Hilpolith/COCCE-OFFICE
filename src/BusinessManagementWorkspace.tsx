import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Activity,
  BriefcaseBusiness,
  FileCheck2,
  KeyRound,
  Package,
  ShieldCheck,
  ShoppingCart,
  Users,
} from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import BusinessWorkspacePanels from "./BusinessWorkspacePanels";
import BusinessPrivateContacts from "./BusinessPrivateContacts";
import { officeTeamApi, type OfficeMember } from "./lib/officeTeamApi";
import {
  getOfficeTeamClient,
  resolveOfficeTeamConfig,
} from "./lib/officeTeamSupabase";
import {
  officeBusinessManagementApi,
  type BusinessBootstrap,
  type BusinessCapabilities,
  type BusinessCommandResult,
  type BusinessRecord,
  type BusinessResource,
  type BusinessRole,
} from "./lib/officeBusinessManagement";
import type {
  BusinessCommand,
  BusinessReadRows,
  BusinessTab,
} from "./lib/businessWorkspaceUi";
import type { OfficeRecordsKeyConfig } from "./lib/officePrivateRecordsCrypto";
import "./businessManagement.css";

type Row = BusinessRecord;
type WorkspaceStatus =
  | "initial-loading"
  | "signed-out"
  | "not-member"
  | "unassigned"
  | "ready"
  | "error";
type RetryState = { action: Parameters<BusinessCommand>[0]; payload: Row };
type Props = {
  workspaceId: string;
  officeName?: string;
  country?: string;
  accent?: string;
  onOpenTeam?: () => void;
};

const PAGE = 100;
const PUBLIC_INITIAL: BusinessResource[] = [
  "accounts",
  "opportunities",
  "activities",
  "quotations",
  "sales_orders",
  "deliveries",
  "invoices",
  "receipts",
  "suppliers",
  "purchase_orders",
  "receivings",
  "projects",
  "milestones",
  "service_cases",
  "compliance_followups",
];
const SUMMARY_KEYS = [
  "accounts_count",
  "opportunities_count",
  "open_quotations_count",
  "outstanding_invoices_count",
  "orders_awaiting_delivery_count",
  "purchase_orders_awaiting_receiving_count",
  "open_service_cases_count",
  "compliance_due_count",
] as const;
const CAP_KEYS: (keyof BusinessCapabilities)[] = [
  "crm",
  "quotes",
  "approve_sales",
  "delivery",
  "finance",
  "procurement",
  "projects",
  "compliance",
  "settings",
  "staff",
  "private_contacts",
  "audit",
];
const tabs: {
  id: BusinessTab;
  label: string;
  icon: typeof Activity;
  capability?: keyof BusinessCapabilities;
}[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "crm", label: "CRM", icon: Users, capability: "crm" },
  { id: "sales", label: "Sales", icon: ShoppingCart, capability: "quotes" },
  {
    id: "receivables",
    label: "Receivables",
    icon: FileCheck2,
    capability: "finance",
  },
  {
    id: "procurement",
    label: "Procurement",
    icon: Package,
    capability: "procurement",
  },
  {
    id: "projects",
    label: "Projects & service",
    icon: BriefcaseBusiness,
    capability: "projects",
  },
  {
    id: "compliance",
    label: "Compliance",
    icon: ShieldCheck,
    capability: "compliance",
  },
  { id: "settings", label: "Settings", icon: KeyRound, capability: "settings" },
];
const validRoles: BusinessRole[] = [
  "business_admin",
  "manager",
  "sales",
  "operations",
  "finance",
  "procurement",
  "viewer",
  "unassigned",
];

function isObject(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function isArray(value: unknown): value is Row[] {
  return Array.isArray(value) && value.every(isObject);
}
function friendlyError(value: unknown): string {
  const message =
    value instanceof Error
      ? value.message
      : "The Business request could not be completed.";
  if (/permission|row-level|42501/i.test(message))
    return "Your Office Team membership or Business role does not allow that action.";
  if (/office_business_(read|command)|PGRST202|function/i.test(message))
    return "Business Management is not enabled in this deployment. No changes were saved.";
  return message;
}
function isTransportError(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return /network|fetch|timeout|timed out|aborted|offline|failed to fetch|load failed/i.test(
    message,
  );
}
function validateBootstrap(value: unknown): BusinessBootstrap {
  if (!isObject(value))
    throw new Error(
      "Business bootstrap was malformed; no records were treated as empty.",
    );
  if (!validRoles.includes(value.role as BusinessRole))
    throw new Error("Business bootstrap returned an invalid role.");
  if (!(value.settings === null || isObject(value.settings)))
    throw new Error("Business bootstrap settings were malformed.");
  if (
    !isObject(value.key_config) ||
    typeof value.key_config.configured !== "boolean"
  )
    throw new Error("Business bootstrap key configuration was incomplete.");
  const caps = value.capabilities;
  if (!isObject(caps) || CAP_KEYS.some((key) => typeof caps[key] !== "boolean"))
    throw new Error("Business bootstrap capabilities were incomplete.");
  if (!isObject(value.summary))
    throw new Error("Business bootstrap summary was incomplete.");
  return value as unknown as BusinessBootstrap;
}
function summaryValue(summary: Row, key: string): string {
  return typeof summary[key] === "number" || typeof summary[key] === "string"
    ? String(summary[key])
    : "—";
}

export default function BusinessManagementWorkspace({
  workspaceId,
  officeName = "COCCE Office",
  country = "Business",
  accent = "#6b8fc4",
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
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const clientRef = useRef(client);
  clientRef.current = client;
  const scopeEpoch = useRef(0);
  const requestToken = useRef(0);
  const mounted = useRef(true);
  const actorRef = useRef<string | null>(null);
  const roleRef = useRef<BusinessRole>("unassigned");
  const dataRef = useRef<Record<string, Row[]>>({});
  const offsetsRef = useRef<Record<string, number>>({});
  const hasMoreRef = useRef<Record<string, boolean>>({});
  const loadingMoreRef = useRef<Record<string, boolean>>({});
  const mutationBusy = useRef(false);
  const retryRef = useRef<RetryState | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus>("initial-loading");
  const [role, setRole] = useState<BusinessRole>("unassigned");
  const [capabilities, setCapabilities] = useState<BusinessCapabilities | null>(
    null,
  );
  const [settings, setSettings] = useState<Row | null>(null);
  const [keyConfig, setKeyConfig] = useState<OfficeRecordsKeyConfig>({
    configured: false,
  });
  const [summary, setSummary] = useState<Row>({});
  const [data, setData] = useState<Record<string, Row[]>>({});
  const [hasMore, setHasMore] = useState<Record<string, boolean>>({});
  const [loadingMore, setLoadingMore] = useState<Record<string, boolean>>({});
  const [members, setMembers] = useState<OfficeMember[]>([]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [tab, setTab] = useState<BusinessTab>("overview");
  const [retry, setRetry] = useState<RetryState | null>(null);
  const [privacyVersion, setPrivacyVersion] = useState(0);

  const clearRecordData = useCallback(() => {
    dataRef.current = {};
    offsetsRef.current = {};
    hasMoreRef.current = {};
    setData({});
    setHasMore({});
  }, []);
  const clearPrivateBoundary = useCallback(() => {
    setPrivacyVersion((v) => v + 1);
  }, []);
  const invalidate = useCallback(() => {
    scopeEpoch.current += 1;
    requestToken.current += 1;
    clearRecordData();
    clearPrivateBoundary();
    setMembers([]);
    setCapabilities(null);
    setSettings(null);
    setSummary({});
    setKeyConfig({ configured: false });
    setRole("unassigned");
    roleRef.current = "unassigned";
  }, [clearPrivateBoundary, clearRecordData]);

  const readRows: BusinessReadRows = useCallback(
    async (resource, filter = {}, limit = PAGE, offset = 0) => {
      if (workspaceRef.current !== workspaceId)
        throw new Error("Business workspace changed; read discarded.");
      const epoch = scopeEpoch.current;
      const raw = await officeBusinessManagementApi.read(
        clientRef.current as SupabaseClient,
        workspaceId,
        resource,
        filter,
        limit,
        offset,
      );
      if (epoch !== scopeEpoch.current || workspaceRef.current !== workspaceId)
        return [];
      if (!isArray(raw))
        throw new Error(
          `${resource} returned malformed data; no records were treated as empty.`,
        );
      return raw;
    },
    [workspaceId],
  );

  const loadMore = useCallback(
    async (resource: BusinessResource) => {
      if (
        !hasMoreRef.current[resource] ||
        loadingMoreRef.current[resource] ||
        status !== "ready"
      )
        return;
      loadingMoreRef.current[resource] = true;
      setLoadingMore((p) => ({ ...p, [resource]: true }));
      const epoch = scopeEpoch.current;
      const offset = offsetsRef.current[resource] ?? 0;
      try {
        const result = await readRows(resource, {}, PAGE, offset);
        if (epoch !== scopeEpoch.current) return;
        const current = dataRef.current[resource] ?? [];
        const next = [...current, ...result];
        dataRef.current[resource] = next;
        offsetsRef.current[resource] = offset + result.length;
        hasMoreRef.current[resource] = result.length === PAGE;
        setData({ ...dataRef.current });
        setHasMore({ ...hasMoreRef.current });
      } catch (error) {
        if (epoch === scopeEpoch.current) setFeedback(friendlyError(error));
      } finally {
        loadingMoreRef.current[resource] = false;
        setLoadingMore((p) => ({ ...p, [resource]: false }));
      }
    },
    [readRows, status],
  );

  const refresh = useCallback(
    async (preserveFeedback = false) => {
      const token = ++requestToken.current;
      const epoch = ++scopeEpoch.current;
      clearRecordData();
      setMembers([]);
      setStatus("initial-loading");
      if (!preserveFeedback) setFeedback("");
      try {
        if (config.status !== "ready" || !clientRef.current)
          throw new Error("Office Team is not enabled in this deployment.");
        const auth = await clientRef.current.auth.getUser();
        if (token !== requestToken.current || epoch !== scopeEpoch.current)
          return;
        const actorId = auth.data.user?.id ?? null;
        if (!actorId) {
          actorRef.current = null;
          setStatus("signed-out");
          clearPrivateBoundary();
          return;
        }
        if (actorRef.current && actorRef.current !== actorId) {
          clearRecordData();
          clearPrivateBoundary();
        }
        actorRef.current = actorId;
        const spaces = await officeTeamApi.listWorkspaces(clientRef.current);
        if (token !== requestToken.current || epoch !== scopeEpoch.current)
          return;
        if (
          !Array.isArray(spaces) ||
          !spaces.some((space) => space?.workspace_id === workspaceId)
        ) {
          setStatus("not-member");
          return;
        }
        const boot = validateBootstrap(
          await officeBusinessManagementApi.read(
            clientRef.current,
            workspaceId,
            "bootstrap",
          ),
        );
        if (token !== requestToken.current || epoch !== scopeEpoch.current)
          return;
        roleRef.current = boot.role;
        setRole(boot.role);
        setCapabilities(boot.capabilities);
        setSettings(boot.settings);
        setKeyConfig(boot.key_config);
        setSummary(boot.summary);
        const team = await officeTeamApi.listMembers(
          clientRef.current,
          workspaceId,
        );
        if (
          !Array.isArray(team) ||
          team.some(
            (member) =>
              !member ||
              typeof member.user_id !== "string" ||
              !["active", "suspended"].includes(member.status),
          )
        )
          throw new Error("Office Team member data was malformed.");
        if (token !== requestToken.current || epoch !== scopeEpoch.current)
          return;
        setMembers(team);
        if (boot.role === "unassigned") {
          setStatus("unassigned");
          return;
        }
        const initialResults = await Promise.all(
          PUBLIC_INITIAL.map((resource) => readRows(resource, {}, PAGE, 0)),
        );
        if (token !== requestToken.current || epoch !== scopeEpoch.current)
          return;
        PUBLIC_INITIAL.forEach((resource, index) => {
          dataRef.current[resource] = initialResults[index];
          offsetsRef.current[resource] = initialResults[index].length;
          hasMoreRef.current[resource] = initialResults[index].length === PAGE;
        });
        if (boot.role === "business_admin" || boot.role === "manager") {
          const [staff, audit] = await Promise.all([
            readRows("staff", {}, PAGE, 0),
            readRows("audit", {}, PAGE, 0),
          ]);
          if (token !== requestToken.current || epoch !== scopeEpoch.current)
            return;
          dataRef.current.staff = staff;
          dataRef.current.audit = audit;
          offsetsRef.current.staff = staff.length;
          offsetsRef.current.audit = audit.length;
          hasMoreRef.current.staff = staff.length === PAGE;
          hasMoreRef.current.audit = audit.length === PAGE;
        }
        setData({ ...dataRef.current });
        setHasMore({ ...hasMoreRef.current });
        setStatus("ready");
      } catch (error) {
        if (token === requestToken.current && epoch === scopeEpoch.current) {
          setStatus("error");
          setFeedback(friendlyError(error));
        }
      }
    },
    [
      clearPrivateBoundary,
      clearRecordData,
      config.status,
      readRows,
      workspaceId,
    ],
  );

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      invalidate();
    };
  }, [invalidate, refresh]);
  useEffect(() => {
    if (!client) return undefined;
    const subscription = client.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session?.user) {
        invalidate();
        actorRef.current = null;
        retryRef.current = null;
        setRetry(null);
        setBusy(false);
        mutationBusy.current = false;
        setStatus("signed-out");
      } else if (
        event === "SIGNED_IN" ||
        event === "USER_UPDATED" ||
        event === "TOKEN_REFRESHED"
      )
        queueMicrotask(() => {
          if (mounted.current) void refresh(true);
        });
    });
    return () => subscription.data.subscription.unsubscribe();
  }, [client, invalidate, refresh]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") clearPrivateBoundary();
      else if (
        document.visibilityState === "visible" &&
        status !== "initial-loading"
      )
        void refresh(true);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [clearPrivateBoundary, refresh, status]);
  useEffect(() => {
    clearPrivateBoundary();
    retryRef.current = null;
    setRetry(null);
  }, [workspaceId, role, clearPrivateBoundary]);

  const reportError = useCallback(
    (message: string) => {
      if (/permission|row-level|42501/i.test(message)) clearPrivateBoundary();
      setFeedback(message);
    },
    [clearPrivateBoundary],
  );
  const command: BusinessCommand = useCallback(
    async (action, values, success = "Saved.") => {
      if (mutationBusy.current || !clientRef.current) return null;
      const payload = {
        ...values,
        idempotency_key:
          values.idempotency_key ?? globalThis.crypto.randomUUID(),
      };
      const snapshot = { action, payload };
      const epoch = scopeEpoch.current;
      mutationBusy.current = true;
      setBusy(true);
      setFeedback("");
      try {
        const result =
          await officeBusinessManagementApi.command<BusinessCommandResult>(
            clientRef.current,
            workspaceId,
            action,
            payload,
          );
        if (
          epoch !== scopeEpoch.current ||
          workspaceRef.current !== workspaceId
        )
          return null;
        retryRef.current = null;
        setRetry(null);
        setFeedback(success);
        void refresh(true).catch((error) => {
          if (epoch === scopeEpoch.current)
            setFeedback(`${success} Refresh issue: ${friendlyError(error)}`);
        });
        return result;
      } catch (error) {
        if (epoch === scopeEpoch.current) {
          if (isTransportError(error)) {
            retryRef.current = snapshot;
            setRetry(snapshot);
            setFeedback(
              "The request outcome is uncertain. Retry the exact action or discard it before starting another write.",
            );
          } else {
            retryRef.current = null;
            setRetry(null);
            setFeedback(friendlyError(error));
          }
        }
        return null;
      } finally {
        mutationBusy.current = false;
        setBusy(false);
      }
    },
    [refresh, workspaceId],
  );
  const retryExact = useCallback(() => {
    const pending = retryRef.current;
    if (pending)
      void command(pending.action, pending.payload, "Retry succeeded.");
  }, [command]);
  const discardRetry = useCallback(() => {
    retryRef.current = null;
    setRetry(null);
    setFeedback("Pending write discarded.");
  }, []);
  const visibleTabs = tabs.filter(
    (item) =>
      item.id !== "settings" ||
      !!capabilities?.settings ||
      !!capabilities?.staff ||
      !!capabilities?.audit,
  );
  const activeTab = visibleTabs.some((item) => item.id === tab) ? tab : "overview";
  const navigate = (next: BusinessTab) => {
    if (visibleTabs.some((item) => item.id === next)) setTab(next);
  };
  const privateAllowed =
    !!capabilities?.private_contacts &&
    ["business_admin", "manager", "sales"].includes(role);
  const privateContacts: ReactNode =
    privateAllowed && client ? (
      <BusinessPrivateContacts
        key={`${workspaceId}:${actorRef.current ?? "unknown"}:${role}:${privacyVersion}`}
        workspaceId={workspaceId}
        role={role}
        client={client}
        keyConfig={keyConfig}
        accounts={data.accounts ?? []}
        busy={busy}
        command={command}
        reportError={reportError}
      />
    ) : null;
  const connectionMessage = status === "error" && /not enabled/i.test(feedback);

  if (status === "initial-loading")
    return (
      <main
        className="business-workspace"
        style={{ "--business-accent": accent } as React.CSSProperties}
      >
        <section className="business-hero">
          <div className="business-hero-mark">
            <Activity size={22} />
          </div>
          <div>
            <span className="business-eyebrow">{country} operations</span>
            <h2>Loading Business Management</h2>
            <p>Checking Office Team access and workspace records.</p>
          </div>
        </section>
      </main>
    );
  return (
    <main
      className="business-workspace"
      style={{ "--business-accent": accent } as React.CSSProperties}
      aria-label="Business Management workspace"
    >
      <section className="business-hero">
        <div className="business-hero-mark">
          <BriefcaseBusiness size={23} />
        </div>
        <div>
          <span className="business-eyebrow">{country} operations</span>
          <h2>{officeName}</h2>
          <p>
            One workspace for customer, sales, delivery, procurement and
            internal compliance workflows.
          </p>
        </div>
        <span className="business-role">{role.replaceAll("_", " ")}</span>
      </section>
      {status === "signed-out" && (
        <div className="business-alert" role="alert">
          Sign in to access this Business workspace.
        </div>
      )}
      {status === "not-member" && (
        <div className="business-alert" role="alert">
          You are not an active member of this Office Team workspace.
          {onOpenTeam && (
            <button className="business-button secondary" onClick={onOpenTeam}>
              Open Office Team
            </button>
          )}
        </div>
      )}
      {status === "unassigned" && (
        <div className="business-alert" role="alert">
          Your Office Team membership is active, but a Business role has not
          been assigned yet.
          {onOpenTeam && (
            <button className="business-button secondary" onClick={onOpenTeam}>
              Open Office Team
            </button>
          )}
        </div>
      )}
      {status === "error" && (
        <div className="business-alert" role="alert">
          {feedback || "Business Management could not be loaded."}
          {connectionMessage && onOpenTeam && (
            <button className="business-button secondary" onClick={onOpenTeam}>
              Open Office Team
            </button>
          )}
        </div>
      )}
      {feedback && status === "ready" && (
        <div className="business-alert" role="status">
          {feedback}
          {retry && (
            <span className="business-alert-actions">
              <button className="business-button primary" onClick={retryExact}>
                Retry exact action
              </button>
              <button
                className="business-button secondary"
                onClick={discardRetry}
              >
                Discard
              </button>
            </span>
          )}
        </div>
      )}
      {status === "ready" && capabilities && (
        <>
          <nav
            className="business-tabs"
            aria-label="Business sections"
            role="tablist"
            onKeyDown={(event) => {
              const current = visibleTabs.findIndex((item) => item.id === activeTab);
              let next = current;
              if (event.key === "ArrowRight")
                next = (current + 1) % visibleTabs.length;
              if (event.key === "ArrowLeft")
                next = (current - 1 + visibleTabs.length) % visibleTabs.length;
              if (event.key === "Home") next = 0;
              if (event.key === "End") next = visibleTabs.length - 1;
              if (next !== current) {
                event.preventDefault();
                navigate(visibleTabs[next].id);
                (event.currentTarget.children[next] as HTMLElement)?.focus();
              }
            }}
          >
            {visibleTabs.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  role="tab"
                  aria-selected={activeTab === item.id}
                  tabIndex={activeTab === item.id ? 0 : -1}
                  className={activeTab === item.id ? "active" : ""}
                  onClick={() => navigate(item.id)}
                >
                  <Icon size={15} />
                  {item.label}
                </button>
              );
            })}
          </nav>
          <BusinessWorkspacePanels
            tab={activeTab}
            data={data}
            capabilities={capabilities}
            role={role}
            settings={settings}
            members={members}
            busy={busy || !!retry}
            hasMore={hasMore}
            loadingMore={loadingMore}
            loadMore={loadMore}
            readRows={readRows}
            command={command}
            reportError={reportError}
            privateContacts={privateContacts}
            onNavigate={navigate}
            officeName={officeName}
          />
          <section className="business-summary-note">
            Server summary counts are shown as provided; a dash means this
            deployment did not provide that aggregate. Operational invoices and
            payment records are internal workflow records, not fiscal receipts.
          </section>
          <div className="business-metric-dock" aria-label="Workspace summary">
            {SUMMARY_KEYS.map((key) => (
              <div className="business-metric" key={key}>
                <span>{key.replaceAll("_", " ")}</span>
                <strong>{summaryValue(summary, key)}</strong>
              </div>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
