import { describe, expect, it } from "vitest";
import {
  deleteSourceWorkspaceDocument,
  readSourceWorkspaceDocuments,
  saveSourceWorkspaceDocument,
} from "./sourceWorkspaceStore";

function memoryStorage(seed?: string) {
  let value = seed ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    value: () => value,
  };
}
const doc = (overrides: Record<string, unknown> = {}) => ({
  id: "doc-1", workspaceId: "workspace-a", format: "html" as const,
  title: "Landing page", source: "<main>Hello</main>",
  createdAt: "2026-11-18T00:00:00.000Z", updatedAt: "2026-11-18T00:00:00.000Z",
  ...overrides,
});

describe("source workspace persistence", () => {
  it("scopes documents by local workspace and editor format", () => {
    const storage = memoryStorage();
    saveSourceWorkspaceDocument(storage, doc());
    saveSourceWorkspaceDocument(storage, doc({ id: "md-1", format: "markdown", title: "Notes" }));
    saveSourceWorkspaceDocument(storage, doc({ id: "other-1", workspaceId: "workspace-b" }));
    expect(readSourceWorkspaceDocuments(storage, "workspace-a", "html").map((item) => item.id)).toEqual(["doc-1"]);
    expect(readSourceWorkspaceDocuments(storage, "workspace-a", "markdown").map((item) => item.id)).toEqual(["md-1"]);
    expect(readSourceWorkspaceDocuments(storage, null, "html")).toEqual([]);
  });

  it("updates by stable id and deletes only the selected document", () => {
    const storage = memoryStorage();
    saveSourceWorkspaceDocument(storage, doc());
    saveSourceWorkspaceDocument(storage, doc({ title: "Updated", source: "<h1>Updated</h1>" }));
    expect(readSourceWorkspaceDocuments(storage, "workspace-a", "html")[0].title).toBe("Updated");
    deleteSourceWorkspaceDocument(storage, "doc-1");
    expect(readSourceWorkspaceDocuments(storage, "workspace-a", "html")).toEqual([]);
  });

  it("does not allow an existing source document to move across workspace or format scopes", () => {
    const storage = memoryStorage();
    saveSourceWorkspaceDocument(storage, doc());
    expect(() => saveSourceWorkspaceDocument(storage, doc({ workspaceId: "workspace-b" }))).toThrow(/cannot be moved/);
    expect(() => saveSourceWorkspaceDocument(storage, doc({ format: "markdown" }))).toThrow(/cannot be moved/);
    expect(readSourceWorkspaceDocuments(storage, "workspace-a", "html")).toHaveLength(1);
  });

  it("preserves corrupt or unsupported data instead of overwriting it", () => {
    const storage = memoryStorage("{bad json");
    expect(() => saveSourceWorkspaceDocument(storage, doc())).toThrow(/preserved/);
    expect(storage.value()).toBe("{bad json");
    const unsupported = memoryStorage(JSON.stringify({ version: 2, documents: [] }));
    expect(() => saveSourceWorkspaceDocument(unsupported, doc())).toThrow(/unsupported version/);
  });

  it("rejects invalid formats, oversized source and malformed timestamps", () => {
    const storage = memoryStorage();
    expect(() => saveSourceWorkspaceDocument(storage, doc({ format: "docx" }))).toThrow(/invalid/);
    expect(() => saveSourceWorkspaceDocument(storage, doc({ source: "x".repeat(1_000_001) }))).toThrow(/1 MB/);
    expect(() => saveSourceWorkspaceDocument(storage, doc({ updatedAt: "not-a-date" }))).toThrow(/invalid/);
  });

  it("keeps the previous value when browser writes fail", () => {
    const storage = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
    expect(() => saveSourceWorkspaceDocument(storage, doc())).toThrow(/storage is full/);
  });
});
