// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import AccountingManagementWorkspace from "./AccountingManagementWorkspace";

vi.mock("./FrostedConfirm", () => ({ useFrostedConfirm: () => vi.fn(async () => true) }));

const rpc = vi.fn();
const client = { auth: { getUser: vi.fn(), onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })) }, rpc };
const caps = Object.fromEntries(["clients","engagements","chart","periods","journals_prepare","journals_submit","journals_review","journals_post","journals_reverse","bank_reconcile","reports","evidence","findings","obligations","staff_assign","period_reopen","audit","private_records"].map((key) => [key, true]));
const boot = { role: "accountant" as const, capabilities: caps, settings: { base_currency_code: "TZS" }, key_config: { configured: false }, summary: { clients_count: 0, active_engagements_count: 0, draft_journals_count: 0, awaiting_review_count: 0, posted_journals_count: 0, unreconciled_statement_lines_count: 0, open_findings_count: 0, due_obligations_count: 0 } };
const emptyPage = { rows: [], total_count: 0, offset: 0, limit: 100, has_more: false };
let apiCommand: any; let apiRead: any;
vi.mock("./lib/officeTeamSupabase", () => ({ resolveOfficeTeamConfig: () => ({ status: "ready" }), getOfficeTeamClient: () => client }));
vi.mock("./lib/officeTeamApi", () => ({ officeTeamApi: { listWorkspaces: vi.fn(async () => [{ workspace_id: "ws-1" }]) } }));
vi.mock("./lib/officeAccountingManagement", async () => { const actual = await vi.importActual<typeof import("./lib/officeAccountingManagement")>("./lib/officeAccountingManagement"); return { ...actual, officeAccountingManagementApi: { read: vi.fn(async (_client: unknown, _ws: string, resource: string) => resource === "bootstrap" ? boot : emptyPage), command: vi.fn(async (_client: unknown, _ws: string, action: string, payload: Record<string, unknown>) => {
      const forbidden = ["evidence_reference_id", "to_status", "authority", "period", "official_ref", "official_url", "expected_statement_line_version", "ready_to_file", "filed"];
      if (forbidden.some((key) => key in payload)) throw new Error(`Obsolete RPC alias rejected: ${action}`);
      return {};
    }) } }; });

describe("AccountingManagementWorkspace", () => {
  afterEach(() => cleanup());
  beforeEach(async () => { vi.clearAllMocks(); client.auth.getUser.mockResolvedValue({ data: { user: { id: "user-1" } } }); const api = await import("./lib/officeAccountingManagement"); apiCommand = api.officeAccountingManagementApi.command; apiRead = api.officeAccountingManagementApi.read; vi.mocked(api.officeAccountingManagementApi.read).mockImplementation(async (_client, _ws, resource) => resource === "bootstrap" ? boot as any : emptyPage); });
  it("renders truthful zero-data metrics and switches functional tabs", async () => {
    render(<AccountingManagementWorkspace workspaceId="ws-1" />);
    await screen.findByText("COCCE Office");
    fireEvent.click(screen.getByRole("tab", { name: /Clients \+ engagements/i }));
    expect(await screen.findByText("No organization clients yet.")).toBeTruthy();
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("tab", { name: /Internal reports/i }));
    expect(await screen.findByText(/No rows for the selected report/i)).toBeTruthy();
  });
  it("does not show restricted actions", async () => {
    const restricted = { ...boot, role: "accountant" as const, capabilities: { ...caps, journals_post: false, journals_prepare: false } };
    const api = await import("./lib/officeAccountingManagement");
    vi.mocked(api.officeAccountingManagementApi.read).mockImplementation(async (_client, _ws, resource) => resource === "bootstrap" ? restricted as any : emptyPage);
    render(<AccountingManagementWorkspace workspaceId="ws-1" />);
    await screen.findByText("COCCE Office");
    expect(screen.queryByRole("tab", { name: /Journal workflow/i })).toBeNull();
  });
  it("shows a safe error instead of empty metrics when bootstrap is malformed", async () => {
    const api = await import("./lib/officeAccountingManagement");
    vi.mocked(api.officeAccountingManagementApi.read).mockRejectedValue(new Error("office_accounting_read unavailable"));
    render(<AccountingManagementWorkspace workspaceId="ws-1" />);
    expect(await screen.findByText(/not enabled|could not be loaded/i)).toBeTruthy();
  });

  it("creates a manual evidence reference without a file input and links only same-client engagements", async () => {
    const api = await import("./lib/officeAccountingManagement");
    const command = vi.mocked(api.officeAccountingManagementApi.command);
    const rows: Record<string, unknown> = {
      clients: { rows: [{ client_id: "client-a", display_name: "Acme", client_code: "AC" }], total_count: 1, offset: 0, limit: 100, has_more: false },
      engagements: { rows: [{ engagement_id: "eng-a", client_id: "client-a", title: "Review", engagement_code: "REV" }, { engagement_id: "eng-b", client_id: "client-b", title: "Other", engagement_code: "OTH" }], total_count: 2, offset: 0, limit: 100, has_more: false },
    };
    vi.mocked(api.officeAccountingManagementApi.read).mockImplementation(async (_client, _ws, resource) => resource === "bootstrap" ? boot as any : (rows[resource] ?? emptyPage) as any);
    render(<AccountingManagementWorkspace workspaceId="ws-1" />);
    await screen.findByText("COCCE Office"); fireEvent.click(screen.getByRole("tab", { name: "Quality" }));
    fireEvent.change(screen.getAllByLabelText("Client")[0], { target: { value: "client-a" } });
    fireEvent.change(screen.getAllByLabelText("Engagement")[0], { target: { value: "eng-a" } });
    fireEvent.change(screen.getAllByLabelText("Title")[0], { target: { value: "Signed review" } });
    fireEvent.click(screen.getByRole("button", { name: "Index evidence reference" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "save_evidence_reference", expect.objectContaining({ client_id: "client-a", engagement_id: "eng-a", provider: "manual_reference", title: "Signed review", confidentiality: "confidential" })));
    expect(document.querySelector('input[type="file"]')).toBeNull();
  });

  it("creates a finding and sends expected_version for a selected finding transition", async () => {
    const api = await import("./lib/officeAccountingManagement"); const command = vi.mocked(api.officeAccountingManagementApi.command);
    const rows: Record<string, unknown> = { clients: { rows: [{ client_id: "client-a", display_name: "Acme", client_code: "AC" }], total_count: 1, offset: 0, limit: 100, has_more: false }, engagements: { rows: [{ engagement_id: "eng-a", client_id: "client-a", title: "Review", engagement_code: "REV" }], total_count: 1, offset: 0, limit: 100, has_more: false }, findings: { rows: [{ finding_id: "find-a", client_id: "client-a", engagement_id: "eng-a", finding_code: "F-1", title: "Old", status: "open", version: 4 }], total_count: 1, offset: 0, limit: 100, has_more: false } };
    vi.mocked(api.officeAccountingManagementApi.read).mockImplementation(async (_client, _ws, resource) => resource === "bootstrap" ? boot as any : (rows[resource] ?? emptyPage) as any);
    render(<AccountingManagementWorkspace workspaceId="ws-1" />); await screen.findByText("COCCE Office"); fireEvent.click(screen.getByRole("tab", { name: "Quality" }));
    fireEvent.change(screen.getAllByLabelText("Client")[1], { target: { value: "client-a" } }); fireEvent.change(screen.getAllByLabelText("Engagement")[1], { target: { value: "eng-a" } });
    fireEvent.change(screen.getByLabelText("Code"), { target: { value: "F-2" } }); fireEvent.change(screen.getAllByLabelText("Title")[1], { target: { value: "New finding" } }); fireEvent.change(screen.getByLabelText("Public description"), { target: { value: "Public description" } });
    fireEvent.click(screen.getByRole("button", { name: "Create finding" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "save_finding", expect.objectContaining({ client_id: "client-a", engagement_id: "eng-a", finding_code: "F-2", evidence_id: undefined })));
    fireEvent.change(screen.getByLabelText("Existing finding"), { target: { value: "find-a" } }); fireEvent.click(screen.getByRole("button", { name: "Move to management response" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "transition_finding", expect.objectContaining({ finding_id: "find-a", expected_version: 4, status: "management_response" })));
  });

  it("creates an obligation with an official manual portal and records filing history after confirmation", async () => {
    const api = await import("./lib/officeAccountingManagement"); const command = vi.mocked(api.officeAccountingManagementApi.command);
    const rows: Record<string, unknown> = { clients: { rows: [{ client_id: "client-a", display_name: "Acme", client_code: "AC" }], total_count: 1, offset: 0, limit: 100, has_more: false }, obligations: { rows: [{ obligation_id: "obl-a", client_id: "client-a", status: "ready", version: 2, obligation_type: "annual_return" }], total_count: 1, offset: 0, limit: 100, has_more: false } };
    vi.mocked(api.officeAccountingManagementApi.read).mockImplementation(async (_client, _ws, resource) => resource === "bootstrap" ? boot as any : (rows[resource] ?? emptyPage) as any);
    render(<AccountingManagementWorkspace workspaceId="ws-1" />); await screen.findByText("COCCE Office"); fireEvent.click(screen.getByRole("tab", { name: "Compliance" }));
    fireEvent.change(screen.getByLabelText("Client"), { target: { value: "client-a" } }); fireEvent.change(screen.getByLabelText("Period"), { target: { value: "2026" } }); fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2026-12-31" } }); fireEvent.click(screen.getByRole("button", { name: "Create obligation" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "save_obligation", expect.objectContaining({ client_id: "client-a", authority_label: "NBAA", period_label: "2026" })));
    expect(screen.getByRole("link", { name: /Open official NBAA portal/i }).getAttribute("href")).toBe("https://www.nbaa.go.tz/"); fireEvent.change(screen.getByLabelText("Existing obligation"), { target: { value: "obl-a" } }); fireEvent.change(screen.getByLabelText("Official reference"), { target: { value: "NBAA-2026-1" } }); fireEvent.change(screen.getByLabelText("Filed date"), { target: { value: "2026-11-07" } }); fireEvent.click(screen.getByRole("button", { name: "Record external filing reference" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "record_filing_reference", expect.objectContaining({ obligation_id: "obl-a", expected_version: 2, filing_reference: "NBAA-2026-1", official_link: "https://www.nbaa.go.tz/" })));
  });

  it("hides quality actions when the role capability is absent", async () => {
    const api = await import("./lib/officeAccountingManagement"); const restricted = { ...boot, capabilities: { ...caps, evidence: false, findings: false, obligations: false } }; vi.mocked(api.officeAccountingManagementApi.read).mockImplementation(async (_client, _ws, resource) => resource === "bootstrap" ? restricted as any : emptyPage);
    render(<AccountingManagementWorkspace workspaceId="ws-1" />); await screen.findByText("COCCE Office"); expect(screen.queryByRole("tab", { name: "Quality" })).toBeNull(); expect(screen.queryByRole("tab", { name: "Compliance" })).toBeNull();
  });

  it("keeps a server command error visible", async () => {
    const api = await import("./lib/officeAccountingManagement"); const rows = { clients: { rows: [{ client_id: "client-a", display_name: "Acme", client_code: "AC" }], total_count: 1, offset: 0, limit: 100, has_more: false }, engagements: { rows: [{ engagement_id: "eng-a", client_id: "client-a", title: "Review", engagement_code: "REV" }], total_count: 1, offset: 0, limit: 100, has_more: false } }; vi.mocked(api.officeAccountingManagementApi.read).mockImplementation(async (_client, _ws, resource) => resource === "bootstrap" ? boot as any : (rows[resource as keyof typeof rows] ?? emptyPage) as any); vi.mocked(api.officeAccountingManagementApi.command).mockRejectedValue(new Error("server validation failed"));
    render(<AccountingManagementWorkspace workspaceId="ws-1" />); await screen.findByText("COCCE Office"); fireEvent.click(screen.getByRole("tab", { name: "Quality" })); fireEvent.change(screen.getAllByLabelText("Client")[0], { target: { value: "client-a" } }); fireEvent.change(screen.getAllByLabelText("Engagement")[0], { target: { value: "eng-a" } }); fireEvent.change(screen.getAllByLabelText("Title")[0], { target: { value: "Evidence" } }); fireEvent.click(screen.getByRole("button", { name: "Index evidence reference" })); expect(await screen.findByText("server validation failed")).toBeTruthy();
  });


  const stateful = (initial: Record<string, any[]>) => {
    const data: Record<string, unknown[]> = Object.fromEntries(Object.entries(initial).map(([key, value]) => [key, value.map((row) => ({ ...row }))]));
    const page = (resource: string) => ({ rows: data[resource] ?? [], total_count: (data[resource] ?? []).length, offset: 0, limit: 100, has_more: false });
    const find = (resource: string, key: string, id: string) => (data[resource] ?? []).find((row: any) => row[key] === id) as Record<string, any>;
    const command = vi.mocked(apiCommand);
    vi.mocked(apiRead).mockImplementation(async (_client: any, _ws: any, resource: any) => resource === "bootstrap" ? boot as any : page(resource));
    command.mockImplementation(async (_client: any, _ws: any, action: any, payload: any) => {
      const p = payload as Record<string, any>;
      if (action === "transition_finding" || action === "close_finding") { const row = find("findings", "finding_id", p.finding_id); row.status = action === "close_finding" ? "closed" : p.status; row.version += 1; return { ...row }; }
      if (action === "transition_obligation") { const row = find("obligations", "obligation_id", p.obligation_id); row.status = p.status; row.version += 1; return { ...row }; }
      if (action === "record_filing_reference") { const row = find("obligations", "obligation_id", p.obligation_id); Object.assign(row, { filing_reference: p.filing_reference, official_link: p.official_link, status: "filed_reference_recorded" }); row.version += 1; return { ...row }; }
      if (action === "save_journal") { const row = { journal_id: "j-1", journal_number: "J-1", client_id: "client-a", status: "draft", total_debit: "10.00", total_credit: "10.00", version: 1, description: "Draft" }; data.journals = [row]; return { ...row }; }
      if (action === "save_journal_line") { const row = find("journals", "journal_id", "j-1"); row.version += 1; return { line_id: `line-${p.line_no}`, version: 1, parent_version: row.version, journal_id: "j-1" }; }
      if (action === "submit_journal" || action === "approve_journal" || action === "post_journal") { const row = find("journals", "journal_id", p.journal_id); row.status = action === "submit_journal" ? "submitted" : action === "approve_journal" ? "approved" : "posted"; row.prepared_by = action === "submit_journal" ? "other-preparer" : row.prepared_by; row.version += 1; return { ...row }; }
      if (action === "match_statement_line") { const row = find("bank_statement_lines", "statement_line_id", p.statement_line_id); row.status = "matched"; row.version += 1; const statement = find("bank_statements", "statement_id", row.statement_id); Object.assign(statement, { matched_lines: 1, unmatched_lines: 0, difference: "0.00", is_balanced: true }); return { ...row }; }
      if (action === "supersede_evidence_reference") { const row = find("evidence_references", "evidence_id", p.evidence_id); row.status = "superseded"; row.version += 1; return { ...row }; }
      if (action === "save_obligation") return { obligation_id: "obl-new", ...p, status: "planned", version: 1 };
      return {};
    });
    return { data, command };
  };

  it("keeps the selected finding current through every lifecycle transition and close", async () => {
    const { command } = stateful({ clients: [{ client_id: "client-a", display_name: "Acme" }], engagements: [{ engagement_id: "eng-a", client_id: "client-a", title: "Review" }], evidence_references: [{ evidence_id: "ev-1", client_id: "client-a", engagement_id: "eng-a", title: "Evidence", status: "active", version: 1 }], findings: [{ finding_id: "find-a", client_id: "client-a", engagement_id: "eng-a", code: "F-1", title: "Finding", status: "open", version: 4 }] });
    render(<AccountingManagementWorkspace workspaceId="ws-1" />); await screen.findByText("COCCE Office"); fireEvent.click(screen.getByRole("tab", { name: "Quality" })); fireEvent.change(screen.getByLabelText("Existing finding"), { target: { value: "find-a" } }); fireEvent.click(screen.getByRole("button", { name: "Move to management response" })); await waitFor(() => expect(command).toHaveBeenLastCalledWith(expect.anything(), "ws-1", "transition_finding", expect.objectContaining({ finding_id: "find-a", status: "management_response", expected_version: 4 })));
    fireEvent.click(await screen.findByRole("button", { name: "Move to resolved" })); await waitFor(() => expect(command).toHaveBeenLastCalledWith(expect.anything(), "ws-1", "transition_finding", expect.objectContaining({ finding_id: "find-a", status: "resolved", expected_version: 5 }))); fireEvent.change(screen.getByLabelText("Root cause"), { target: { value: "Cause" } }); fireEvent.change(screen.getByLabelText("Corrective action"), { target: { value: "Fix" } }); fireEvent.change(screen.getByLabelText("Same-engagement closure evidence"), { target: { value: "ev-1" } }); fireEvent.click(await screen.findByRole("button", { name: "Close with reviewer evidence" })); await waitFor(() => expect(command).toHaveBeenLastCalledWith(expect.anything(), "ws-1", "close_finding", expect.objectContaining({ finding_id: "find-a", evidence_id: "ev-1", expected_version: 6 })));
  });

  it("keeps obligation selection current through planning, readiness, and filing", async () => {
    const { command } = stateful({ clients: [{ client_id: "client-a", display_name: "Acme" }], obligations: [{ obligation_id: "obl-a", client_id: "client-a", obligation_type: "annual_return", status: "planned", version: 2 }] }); render(<AccountingManagementWorkspace workspaceId="ws-1" />); await screen.findByText("COCCE Office"); fireEvent.click(screen.getByRole("tab", { name: "Compliance" })); fireEvent.change(screen.getByLabelText("Existing obligation"), { target: { value: "obl-a" } }); fireEvent.click(screen.getByRole("button", { name: "Move to in progress" })); await waitFor(() => expect(command).toHaveBeenLastCalledWith(expect.anything(), "ws-1", "transition_obligation", expect.objectContaining({ status: "in_progress", expected_version: 2 }))); fireEvent.click(await screen.findByRole("button", { name: "Move to ready" })); await waitFor(() => expect(command).toHaveBeenLastCalledWith(expect.anything(), "ws-1", "transition_obligation", expect.objectContaining({ status: "ready", expected_version: 3 }))); fireEvent.change(screen.getByLabelText("Official reference"), { target: { value: "NBAA-1" } }); fireEvent.change(screen.getByLabelText("Filed date"), { target: { value: "2026-11-07" } }); fireEvent.click(screen.getByRole("button", { name: "Record external filing reference" })); await waitFor(() => expect(command).toHaveBeenLastCalledWith(expect.anything(), "ws-1", "record_filing_reference", expect.objectContaining({ obligation_id: "obl-a", expected_version: 4, filing_reference: "NBAA-1", official_link: "https://www.nbaa.go.tz/" }))); expect(command.mock.calls.some((call: any[]) => call[3] && "authority" in (call[3] as any))).toBe(false);
  });

  it("chains journal line parent versions and posts the refreshed journal without reselecting", async () => {
    const { command } = stateful({ clients: [{ client_id: "client-a", display_name: "Acme" }], reporting_periods: [{ period_id: "p-1", client_id: "client-a", period_label: "2026", status: "open" }], chart_accounts: [{ account_id: "a-1", client_id: "client-a", account_code: "100", account_name: "Cash", status: "active" }, { account_id: "a-2", client_id: "client-a", account_code: "200", account_name: "Income", status: "active" }], journals: [] }); render(<AccountingManagementWorkspace workspaceId="ws-1" />); await screen.findByText("COCCE Office"); fireEvent.click(screen.getByRole("tab", { name: "Journal workflow" })); fireEvent.change(screen.getAllByLabelText("Client")[0], { target: { value: "client-a" } }); fireEvent.change(screen.getByLabelText("Reporting period"), { target: { value: "p-1" } }); fireEvent.change(screen.getByLabelText("Entry date"), { target: { value: "2026-11-07" } }); fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Draft" } }); fireEvent.change(screen.getByLabelText("Line 1 account"), { target: { value: "a-1" } }); fireEvent.change(screen.getByLabelText("Line 1 description"), { target: { value: "Cash" } }); fireEvent.change(screen.getByLabelText("Line 1 debit"), { target: { value: "10" } }); fireEvent.change(screen.getByLabelText("Line 2 account"), { target: { value: "a-2" } }); fireEvent.change(screen.getByLabelText("Line 2 description"), { target: { value: "Income" } }); fireEvent.change(screen.getByLabelText("Line 2 credit"), { target: { value: "10" } }); fireEvent.click(screen.getByRole("button", { name: "Save draft and lines" })); await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "save_journal_line", expect.objectContaining({ expected_parent_version: 1, line_no: 1 }))); expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "save_journal_line", expect.objectContaining({ expected_parent_version: 2, line_no: 2 })); fireEvent.change(await screen.findByLabelText("Saved draft or returned journal"), { target: { value: "j-1" } }); fireEvent.click(await screen.findByRole("button", { name: "Submit balanced journal" })); await waitFor(() => expect(command).toHaveBeenLastCalledWith(expect.anything(), "ws-1", "submit_journal", expect.objectContaining({ expected_version: 3 }))); await waitFor(() => expect((screen.getByLabelText("Submitted journal for review") as HTMLSelectElement).value).toBe("j-1")); fireEvent.click(screen.getByRole("button", { name: "Approve" })); await waitFor(() => expect(command).toHaveBeenLastCalledWith(expect.anything(), "ws-1", "approve_journal", expect.objectContaining({ expected_version: 4 }))); fireEvent.click(await screen.findByRole("button", { name: "Post approved journal" })); await waitFor(() => expect(command).toHaveBeenLastCalledWith(expect.anything(), "ws-1", "post_journal", expect.objectContaining({ expected_version: 5 })));
  });

  it("uses the refreshed statement line version and displays the refreshed server summary", async () => {
    const { command } = stateful({ clients: [{ client_id: "client-a", display_name: "Acme" }], bank_statements: [{ statement_id: "st-1", client_id: "client-a", statement_reference: "S-1", status: "draft", version: 7, total_lines: 1, matched_lines: 0, excluded_lines: 0, unmatched_lines: 1, difference: "10.00", is_balanced: false }], bank_statement_lines: [{ statement_line_id: "sl-1", statement_id: "st-1", status: "unmatched", version: 3, line_no: 1, description: "Deposit", signed_amount: "10.00" }], journals: [{ journal_id: "j-posted", client_id: "client-a", status: "posted" }], journal_lines: [{ line_id: "jl-1", journal_id: "j-posted", client_id: "client-a", description: "Cash", debit: "10.00", credit: "0.00" }] }); render(<AccountingManagementWorkspace workspaceId="ws-1" />); await screen.findByText("COCCE Office"); fireEvent.click(screen.getByRole("tab", { name: "Bank reconciliation" })); fireEvent.change(screen.getAllByLabelText("Client")[0], { target: { value: "client-a" } }); fireEvent.change(screen.getByLabelText("Selected statement"), { target: { value: "st-1" } }); fireEvent.change(screen.getByLabelText("Statement line to match"), { target: { value: "sl-1" } }); fireEvent.change(screen.getByLabelText("Posted journal line"), { target: { value: "jl-1" } }); expect(screen.getByText(/lines 1 · matched 0 · excluded 0 · unmatched 1 · delta 10.00 · balanced false/)).toBeTruthy(); fireEvent.click(screen.getByRole("button", { name: "Match line" })); await waitFor(() => expect(command).toHaveBeenLastCalledWith(expect.anything(), "ws-1", "match_statement_line", { client_id: "client-a", statement_line_id: "sl-1", journal_line_id: "jl-1", expected_version: 3, idempotency_key: expect.any(String) })); await waitFor(() => expect(screen.getByText(/matched 1 · excluded 0 · unmatched 0 · delta 0.00 · balanced true/)).toBeTruthy());
  });

  it("supersedes evidence with the stable ID and clears the old active selection", async () => {
    const { command } = stateful({ clients: [{ client_id: "client-a", display_name: "Acme" }], evidence_references: [{ evidence_id: "ev-1", client_id: "client-a", title: "Old", status: "active", version: 4 }] }); render(<AccountingManagementWorkspace workspaceId="ws-1" />); await screen.findByText("COCCE Office"); fireEvent.click(screen.getByRole("tab", { name: "Quality" })); fireEvent.change(screen.getByLabelText("Existing reference"), { target: { value: "ev-1" } }); fireEvent.click(screen.getByRole("button", { name: /Supersede selected reference/ })); await waitFor(() => expect(command).toHaveBeenLastCalledWith(expect.anything(), "ws-1", "supersede_evidence_reference", expect.objectContaining({ evidence_id: "ev-1", expected_version: 4 }))); await waitFor(() => expect(screen.queryByRole("button", { name: /Supersede selected reference/ })).toBeNull());
  });

});
