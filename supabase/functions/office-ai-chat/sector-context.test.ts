import { describe, expect, it, vi } from "vitest";
import { formatSectorWorkItems, loadSectorWorkItems } from "./sector-context.ts";

const workspace = { workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "Synthetic School" };

describe("permission-aware industry work queue context", () => {
  it("reads only the membership-scoped work queue and omits notes and assignee identifiers", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ industry_id: "school" }], error: null })
      .mockResolvedValueOnce({ data: [{
        industry_id: "school",
        title: "Prepare term timetable",
        reference: "TERM-01",
        stage: "In progress",
        due_date: "2026-12-01",
        updated_at: "2026-11-12T10:00:00.000Z",
        notes: "private note must not be sent",
        assignee_user_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }], error: null });
    const items = await loadSectorWorkItems({ rpc }, [workspace]);
    expect(rpc).toHaveBeenNthCalledWith(1, "office_industry_get_space", { p_workspace_id: workspace.workspace_id });
    expect(rpc).toHaveBeenNthCalledWith(2, "office_industry_list_work_items", { p_workspace_id: workspace.workspace_id, p_limit: 8 });
    expect(items).toEqual([{
      workspaceName: "Synthetic School",
      industry: "school",
      title: "Prepare term timetable",
      reference: "TERM-01",
      stage: "In progress",
      dueDate: "2026-12-01",
      updatedAt: "2026-11-12T10:00:00.000Z",
    }]);
    const formatted = formatSectorWorkItems(items);
    expect(formatted).toContain("Prepare term timetable");
    expect(formatted).not.toContain("private note");
    expect(formatted).not.toContain("bbbbbbbb");
  });

  it("skips workspaces without a supported industry profile", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ industry_id: "unknown" }], error: null });
    expect(await loadSectorWorkItems({ rpc }, [workspace])).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the membership-checked work queue RPC fails", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ industry_id: "business" }], error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("denied") });
    await expect(loadSectorWorkItems({ rpc }, [workspace])).rejects.toThrow("authorised industry work queue");
  });
});
