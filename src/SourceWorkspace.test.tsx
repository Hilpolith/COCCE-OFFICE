// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import SourceWorkspace from "./SourceWorkspace";

describe("dedicated HTML and Markdown workspaces", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });
  afterEach(() => cleanup());

  it("creates, edits and saves a Markdown file with a sandboxed preview", async () => {
    render(<SourceWorkspace format="markdown" workspaceId="workspace-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Create first file" }));
    const editor = await screen.findByRole("textbox", { name: "Markdown source editor" });
    fireEvent.change(editor, { target: { value: "# COCCE Office\n\n**Local draft**" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(window.localStorage.getItem("cocce-office-source-workspaces-v1")).toContain("COCCE Office"));
    const preview = screen.getByTitle("Markdown preview");
    expect(preview.getAttribute("sandbox")).toBe("");
    expect(preview.getAttribute("srcdoc")).toContain("<h1>COCCE Office</h1>");
  });

  it("keeps HTML drafts isolated by workspace and format", async () => {
    const first = render(<SourceWorkspace format="html" workspaceId="workspace-a" />);
    fireEvent.click(screen.getByRole("button", { name: "Create first file" }));
    const editor = await screen.findByRole("textbox", { name: "HTML source editor" });
    fireEvent.change(editor, { target: { value: "<main>Workspace A</main>" } });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() => expect(window.localStorage.getItem("cocce-office-source-workspaces-v1")).toContain("Workspace A"));
    first.unmount();
    render(<SourceWorkspace format="html" workspaceId="workspace-b" />);
    expect(await screen.findByText("No files yet")).toBeTruthy();
    cleanup();
    render(<SourceWorkspace format="html" workspaceId="workspace-a" />);
    expect(await screen.findByText("Untitled HTML")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "HTML source editor" }) as HTMLTextAreaElement).value).toBe("<main>Workspace A</main>");
  });
});
