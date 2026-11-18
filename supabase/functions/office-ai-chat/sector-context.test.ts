import { describe, expect, it, vi } from "vitest";
import { formatSectorWorkItems, formatSectorWorkspaceSummaries, loadSectorWorkItems, loadSectorWorkspaceSummaries } from "./sector-context.ts";

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


describe("authenticated sector bootstrap context", () => {
  it("retrieves real workspace bootstrap summaries through the industry's existing read RPC", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ industry_id: "accounting" }], error: null })
      .mockResolvedValueOnce({ data: {
        role: "accountant",
        summary: { clients_count: 3, posted_journals_count: 17, private_records_count: 1 },
        settings: { bank_account: "private" },
        key_config: { salt: "secret", ciphertext: "secret" },
      }, error: null });
    const summaries = await loadSectorWorkspaceSummaries({ rpc }, [workspace]);
    expect(rpc).toHaveBeenNthCalledWith(2, "office_accounting_read", {
      w: workspace.workspace_id, resource: "bootstrap", f: {}, requested_limit: 20, requested_offset: 0,
    });
    expect(summaries).toEqual([{
      workspaceName: "Synthetic School",
      industry: "accounting",
      role: "accountant",
      counts: { clients_count: 3, posted_journals_count: 17 },
      records: [],
      state: "",
    }]);
    const formatted = formatSectorWorkspaceSummaries(summaries);
    expect(formatted).toContain("posted journals count: 17");
    expect(formatted).not.toContain("private");
    expect(formatted).not.toContain("secret");
  });

  it("keeps only safe academic catalogue metadata from the university bootstrap", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ industry_id: "university" }], error: null })
      .mockResolvedValueOnce({ data: {
        role: "registrar",
        terms: [{ name: "Semester One", code: "2026-S1", status: "active", private_note: "secret" }],
        programmes: [{ name: "Computer Science", code: "CS", status: "active", student_email: "secret@example.com" }],
        courses: [{ name: "Database Systems", code: "CS204", status: "active" }],
        key_config: { ciphertext: "secret" },
      }, error: null });
    const summaries = await loadSectorWorkspaceSummaries({ rpc }, [workspace]);
    expect(summaries[0]?.records).toEqual([
      { kind: "term", name: "Semester One", code: "2026-S1", status: "active" },
      { kind: "programme", name: "Computer Science", code: "CS", status: "active" },
      { kind: "course", name: "Database Systems", code: "CS204", status: "active" },
    ]);
    const formatted = formatSectorWorkspaceSummaries(summaries);
    expect(formatted).not.toContain("secret");
    expect(formatted).not.toContain("example.com");
  });

  it("fails closed if a sector read RPC denies the authenticated member", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ industry_id: "ngo" }], error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("permission denied") });
    await expect(loadSectorWorkspaceSummaries({ rpc }, [workspace])).rejects.toThrow("authorised sector summary");
  });

  it("skips unsupported sector profiles without guessing a table or bypassing permissions", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: [{ industry_id: "unknown" }], error: null });
    expect(await loadSectorWorkspaceSummaries({ rpc }, [workspace])).toEqual([]);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});
