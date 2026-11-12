import { isUuid } from "./drive-context.ts";

const MAX_WORKSPACES = 20;
const MAX_ITEMS_PER_WORKSPACE = 8;
const MAX_ITEMS_TOTAL = 100;
const MAX_CONTEXT_CHARS = 12_000;
const INDUSTRIES = new Set([
  "government", "school", "university", "business", "accounting",
  "manufacturing", "healthcare-admin", "ngo", "hospitality", "church",
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
