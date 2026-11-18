import { isUuid } from "./drive-context.ts";

const MAX_WORKSPACES = 20;
const MAX_ITEMS_PER_WORKSPACE = 8;
const MAX_ITEMS_TOTAL = 100;
const MAX_CONTEXT_CHARS = 12_000;
const INDUSTRIES = new Set([
  "government", "school", "university", "business", "accounting",
  "manufacturing", "healthcare-admin", "ngo", "hospitality", "institutions", "church",
]);

type RpcClient = {
  rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
};

export type SectorWorkItem = {
  workspaceName: string;
  industry: string;
  title: string;
  reference: string;
  stage: string;
  dueDate: string;
  updatedAt: string;
};

function safeText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const printable = Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? " " : character;
  }).join("");
  return printable.replace(/\s+/g, " ").trim().slice(0, max);
}

function safeDate(value: unknown): string {
  if (typeof value !== "string" || value.length > 40 || !Number.isFinite(Date.parse(value))) return "";
  return value;
}

/**
 * Reads only the signed-in member's generic industry work queue through the
 * membership-checked Office RPCs. It intentionally excludes notes, people IDs,
 * and all sector-specific protected records.
 */
export async function loadSectorWorkItems(
  client: RpcClient,
  enabledWorkspaces: Array<Record<string, unknown>>,
): Promise<SectorWorkItem[]> {
  const selected = enabledWorkspaces.slice(0, MAX_WORKSPACES);
  const batches = await Promise.all(selected.map(async (workspace) => {
    const workspaceId = String(workspace.workspace_id ?? "");
    if (!isUuid(workspaceId)) return [];
    const workspaceName = safeText(workspace.name, 80) || "Office workspace";
    const profile = await client.rpc("office_industry_get_space", { p_workspace_id: workspaceId });
    if (profile.error) {
      if ((profile.error as { code?: string }).code === "P0002") return [];
      throw new Error("An authorised industry workspace profile could not be read.");
    }
    const profileRows = Array.isArray(profile.data) ? profile.data : profile.data ? [profile.data] : [];
    const industry = safeText((profileRows[0] as Record<string, unknown> | undefined)?.industry_id, 40);
    if (!INDUSTRIES.has(industry)) return [];
    const result = await client.rpc("office_industry_list_work_items", {
      p_workspace_id: workspaceId,
      p_limit: MAX_ITEMS_PER_WORKSPACE,
    });
    if (result.error) throw new Error("An authorised industry work queue could not be read.");
    if (!Array.isArray(result.data)) throw new Error("The industry work queue returned an invalid response.");
    return result.data.slice(0, MAX_ITEMS_PER_WORKSPACE).flatMap((raw): SectorWorkItem[] => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const row = raw as Record<string, unknown>;
      const title = safeText(row.title, 120);
      const stage = safeText(row.stage, 60);
      if (!title || !stage || safeText(row.industry_id, 40) !== industry) return [];
      return [{
        workspaceName,
        industry,
        title,
        reference: safeText(row.reference, 80),
        stage,
        dueDate: safeDate(row.due_date),
        updatedAt: safeDate(row.updated_at),
      }];
    });
  }));
  const items = batches.flat().slice(0, MAX_ITEMS_TOTAL);
  let remaining = MAX_CONTEXT_CHARS;
  const bounded: SectorWorkItem[] = [];
  for (const item of items) {
    const cost = item.workspaceName.length + item.industry.length + item.title.length
      + item.reference.length + item.stage.length + item.dueDate.length + item.updatedAt.length + 48;
    if (cost > remaining) break;
    bounded.push(item);
    remaining -= cost;
  }
  return bounded;
}

export function formatSectorWorkItems(items: SectorWorkItem[]): string {
  return items.map((item, index) => [
    (index + 1) + ". " + item.title,
    "Workspace: " + item.workspaceName,
    "Industry: " + item.industry,
    "Stage: " + item.stage,
    item.reference ? "Reference: " + item.reference : "",
    item.dueDate ? "Due: " + item.dueDate : "",
    item.updatedAt ? "Updated: " + item.updatedAt : "",
  ].filter(Boolean).join(" · ")).join("\n").slice(0, MAX_CONTEXT_CHARS);
}


type SectorSummary = {
  workspaceName: string;
  industry: string;
  role: string;
  counts: Record<string, number>;
  records: Array<{ kind: string; name: string; code: string; status: string }>;
  state: string;
};

const SUMMARY_RPCS: Record<string, { name: string; args: (workspaceId: string) => Record<string, unknown> }> = {
  school: { name: "office_school_read", args: (id) => ({ p_workspace_id: id, p_resource: "bootstrap", p_filter: {}, p_limit: 20 }) },
  university: { name: "office_university_read", args: (id) => ({ p_workspace_id: id, p_resource: "bootstrap", p_filter: {}, p_limit: 20, p_offset: 0 }) },
  business: { name: "office_business_read", args: (id) => ({ p_workspace_id: id, p_resource: "bootstrap", p_filter: {}, p_limit: 20, p_offset: 0 }) },
  accounting: { name: "office_accounting_read", args: (id) => ({ w: id, resource: "bootstrap", f: {}, requested_limit: 20, requested_offset: 0 }) },
  manufacturing: { name: "office_manufacturing_read", args: (id) => ({ p_workspace_id: id, p_resource: "bootstrap", p_filter: {}, p_limit: 20, p_offset: 0 }) },
  "healthcare-admin": { name: "office_health_admin_read", args: (id) => ({ p_workspace_id: id, p_resource: "bootstrap", p_filter: {}, p_limit: 20, p_offset: 0, p_purpose_code: "aggregate_reporting" }) },
  ngo: { name: "office_ngo_read", args: (id) => ({ p_workspace_id: id, p_resource: "bootstrap", p_filter: {}, p_limit: 20, p_offset: 0 }) },
  hospitality: { name: "office_hospitality_read", args: (id) => ({ p_workspace_id: id, p_resource: "bootstrap", p_filter: {}, p_limit: 1, p_offset: 0 }) },
  institutions: { name: "office_institutions_read", args: (id) => ({ p_workspace_id: id, p_resource: "bootstrap", p_filter: {}, p_limit: 20, p_offset: 0 }) },
  church: { name: "office_institutions_read", args: (id) => ({ p_workspace_id: id, p_resource: "bootstrap", p_filter: {}, p_limit: 20, p_offset: 0 }) },
};

function safeSummaryValue(value: unknown): string {
  return safeText(value, 80);
}

function parseSectorSummary(raw: unknown, workspaceName: string, industry: string): SectorSummary {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("An industry summary returned an invalid response.");
  }
  const data = raw as Record<string, unknown>;
  const summary = data.summary && typeof data.summary === "object" && !Array.isArray(data.summary)
    ? data.summary as Record<string, unknown> : {};
  const counts: Record<string, number> = {};
  for (const [key, value] of Object.entries(summary)) {
    if (/^[a-z][a-z0-9_]{0,55}$/.test(key) && !/(?:private|secret|patient|student|beneficiar|safeguard|staff|user|person|member|payroll|salary|medical|clinical|amount|balance|revenue|expense|cost|payment|fee|tax|invoice|claim|billing|income|profit|debit|credit|bank)/i.test(key) && typeof value === "number"
      && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000) {
      counts[key] = value;
    }
  }
  const records: SectorSummary["records"] = [];
  for (const key of ["terms", "programmes", "courses", "classes", "subjects"]) {
    const items = data[key];
    if (!Array.isArray(items)) continue;
    for (const item of items.slice(0, 12)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      const name = safeSummaryValue(row.name ?? row.label ?? row.class_label ?? row.subject_label);
      const code = safeSummaryValue(row.code ?? row.subject_code);
      const status = safeSummaryValue(row.status);
      if (name || code) records.push({ kind: ({ terms: "term", programmes: "programme", courses: "course", classes: "class", subjects: "subject" } as const)[key as "terms" | "programmes" | "courses" | "classes" | "subjects"], name, code, status });
    }
  }
  const role = safeSummaryValue(data.role);
  const state = safeSummaryValue(typeof data.storage_review_state === "string" ? data.storage_review_state : data.initialized === true ? "initialized" : "");
  return { workspaceName, industry, role, counts, records: records.slice(0, 24), state };
}

/**
 * Fetches a bounded, role-filtered bootstrap from each supported sector's own
 * authenticated read RPC. It deliberately strips settings, key material,
 * people, beneficiaries, patients, financial payloads and arbitrary columns.
 */
export async function loadSectorWorkspaceSummaries(
  client: RpcClient,
  enabledWorkspaces: Array<Record<string, unknown>>,
): Promise<SectorSummary[]> {
  const selected = enabledWorkspaces.slice(0, MAX_WORKSPACES);
  const summaries = await Promise.all(selected.map(async (workspace): Promise<SectorSummary[]> => {
    const workspaceId = String(workspace.workspace_id ?? "");
    if (!isUuid(workspaceId)) return [];
    const profile = await client.rpc("office_industry_get_space", { p_workspace_id: workspaceId });
    if (profile.error) {
      if ((profile.error as { code?: string }).code === "P0002") return [];
      throw new Error("An authorised industry workspace profile could not be read.");
    }
    const profileRows = Array.isArray(profile.data) ? profile.data : profile.data ? [profile.data] : [];
    const industry = safeText((profileRows[0] as Record<string, unknown> | undefined)?.industry_id, 40);
    const contract = SUMMARY_RPCS[industry];
    if (!contract) return [];
    const result = await client.rpc(contract.name, contract.args(workspaceId));
    if (result.error) throw new Error("An authorised sector summary could not be read.");
    return [parseSectorSummary(result.data, safeText(workspace.name, 80) || "Office workspace", industry)];
  }));
  return summaries.flat().slice(0, MAX_WORKSPACES);
}

export function formatSectorWorkspaceSummaries(summaries: SectorSummary[]): string {
  return summaries.map((summary) => {
    const lines = [
      summary.workspaceName + " · " + summary.industry,
      summary.role ? "Member role: " + summary.role : "",
      summary.state ? "Workspace state: " + summary.state : "",
      ...Object.entries(summary.counts).map(([key, value]) => key.replaceAll("_", " ") + ": " + value),
      ...summary.records.map((record) => [record.kind, record.name, record.code, record.status].filter(Boolean).join(" · ")),
    ].filter(Boolean);
    return lines.join("\\n");
  }).join("\\n\\n").slice(0, MAX_CONTEXT_CHARS);
}
