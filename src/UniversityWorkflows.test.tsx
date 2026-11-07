// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import UniversityManagementWorkspace from "./UniversityManagementWorkspace";
import { FrostedConfirmProvider } from "./FrostedConfirm";

const { read, command, getUser, listWorkspaces, listMembers, getSpace, unlock, decrypt } =
  vi.hoisted(() => ({
    read: vi.fn(),
    command: vi.fn(),
    getUser: vi.fn(),
    listWorkspaces: vi.fn(),
    listMembers: vi.fn(),
    getSpace: vi.fn(),
    unlock: vi.fn(),
    decrypt: vi.fn(),
  }));
let seededRole = "university_admin";

vi.mock("./lib/officeUniversityManagement", () => ({
  officeUniversityManagementApi: { read, command },
  createUniversityKeyConfig: vi.fn(),
  unlockUniversityKey: unlock,
  encryptUniversityPrivatePerson: vi.fn().mockResolvedValue({ nonce: "n", ciphertext: "c" }),
  decryptUniversityPrivatePerson: decrypt,
}));
vi.mock("./lib/officeTeamSupabase", () => ({
  resolveOfficeTeamConfig: () => ({ status: "ready" }),
  getOfficeTeamClient: () => ({ auth: { getUser } }),
}));
vi.mock("./lib/officeTeamApi", () => ({ officeTeamApi: { listWorkspaces, listMembers } }));
vi.mock("./lib/officeIndustryTasks", () => ({ officeIndustryTasksApi: { getSpace } }));

import { officeTeamApi } from "./lib/officeTeamApi";

const props = {
  workspaceId: "ws-1",
  officeName: "Synthetic University",
  country: "Tanzania",
  accent: "#77a9ff",
};

const rows = {
  terms: [{ term_id: "term-1", label: "2026 Semester 1" }],
  programmes: [{ programme_id: "prog-1", code: "BSC-CS", name: "Computer Science" }],
  courses: [{ course_id: "course-1", code: "CS101", name: "Foundations" }],
  students: [{ student_id: "student-1", student_ref: "STU-001", name: "Asha Student" }],
  fees: [{ charge_id: "charge-1", label: "Tuition charge", version: 3 }],
  funding: [{ funding_id: "funding-1", label: "HESLB case", student_id: "student-1", provider: "HESLB", academic_year: 2026, status: "submitted", version: 4 }],
  admissions: [{ application_id: "app-1", application_code: "APP-001", person_id: "person-1", status: "accepted", version: 7, programme_id: "prog-1" }],
  transcripts: [{ request_id: "request-1", student_id: "student-1", copies: 1, status: "requested", due_date: "2026-12-01", reference: "TR-001", version: 2 }],
  research: [{ project_id: "project-1", title: "Health study", proposal_status: "draft", ethics_status: "not_started", university_clearance_status: "not_started", permit_status: "not_required", version: 5 }],
  quality: [{ case_id: "case-1", programme_id: "prog-1", title: "TCU review", status: "draft", review_query: "Evidence", due_date: "2026-12-15", version: 6 }],
};

function bootstrap(role: string) {
  return { role, terms: rows.terms, programmes: rows.programmes, courses: rows.courses };
}

function panel(title: string) {
  return screen.getByRole("heading", { name: title }).closest("section") as HTMLElement;
}
function field(root: HTMLElement, label: string) {
  return within(root).getByLabelText(label, { exact: true });
}
function submit(root: HTMLElement) {
  fireEvent.submit(root.querySelector("form")!);
}
function choose(root: HTMLElement, label: string, value: string) {
  fireEvent.change(field(root, label), { target: { value } });
}
function fill(root: HTMLElement, label: string, value: string) {
  fireEvent.change(field(root, label), { target: { value } });
}
function renderWorkspace(role = "university_admin") {
  seededRole = role;
  return render(
    <FrostedConfirmProvider>
      <UniversityManagementWorkspace {...props} />
    </FrostedConfirmProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
  listWorkspaces.mockResolvedValue([{ workspace_id: "ws-1" }]);
  listMembers.mockResolvedValue([
    { user_id: "active-1", display_name: "Active member", status: "active" },
    { user_id: "inactive-1", display_name: "Inactive member", status: "suspended" },
  ]);
  getSpace.mockResolvedValue({ industry_id: "university" });
  unlock.mockResolvedValue({});
  decrypt.mockResolvedValue({ legal_name: "Revealed Person", email: "person@example.test" });
  command.mockResolvedValue({ entity_id: "new-1", version: 1 });
  read.mockImplementation(async (_client: unknown, _workspace: string, resource: string) => {
    if (resource === "bootstrap") return bootstrap(seededRole);
    if (resource === "key_config") return { configured: true };
    return rows[resource as keyof typeof rows] ?? [];
  });
});
afterEach(() => cleanup());

describe("University Management workflow commands", () => {
  it("submits finance charge, manual receipt, and funding with referenced IDs", async () => {
    renderWorkspace();
    await screen.findByRole("heading", { name: "University Management" });
    fireEvent.click(screen.getByRole("tab", { name: "Finance & funding" }));

    const charge = panel("Fee charge");
    choose(charge, "student id", "student-1");
    choose(charge, "term id", "term-1");
    fill(charge, "category", "tuition");
    fill(charge, "amount tzs", "250000");
    fill(charge, "due date", "2026-12-20");
    submit(charge);
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "create_charge", expect.objectContaining({ student_id: "student-1", term_id: "term-1", category: "tuition", amount_tzs: "250000", due_date: "2026-12-20", idempotency_key: expect.any(String) })));

    const receipt = panel("Manual receipt");
    choose(receipt, "charge id", "charge-1");
    fill(receipt, "amount tzs", "100000");
    choose(receipt, "payment method", "bank");
    fill(receipt, "reference", "BANK-001");
    submit(receipt);
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "record_receipt", expect.objectContaining({ charge_id: "charge-1", amount_tzs: "100000", payment_method: "bank", reference: "BANK-001" })));

    const funding = panel("HESLB funding case");
    fireEvent.change(within(funding).getByLabelText("Edit existing record"), { target: { value: "funding-1" } });
    expect((field(funding, "provider") as HTMLInputElement).value).toBe("HESLB");
    expect((field(funding, "academic year") as HTMLInputElement).value).toBe("2026");
    submit(funding);
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "save_funding", expect.objectContaining({ funding_id: "funding-1", student_id: "student-1", provider: "HESLB", academic_year: "2026", status: "submitted", expected_version: 4 })));
  });

  it("submits research and quality workflows with IDs and expected versions on edit", async () => {
    renderWorkspace();
    await screen.findByRole("heading", { name: "University Management" });
    fireEvent.click(screen.getByRole("tab", { name: "Research" }));
    const research = panel("Research proposal & clearance chain");
    fireEvent.change(within(research).getByLabelText("Edit existing record"), { target: { value: "project-1" } });
    expect((field(research, "title") as HTMLInputElement).value).toBe("Health study");
    fill(research, "title", "Updated health study");
    submit(research);
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "save_research", expect.objectContaining({ project_id: "project-1", title: "Updated health study", proposal_status: "draft", expected_version: 5 })));

    fireEvent.click(screen.getByRole("tab", { name: "Quality" }));
    const quality = panel("Quality / TCU case");
    fireEvent.change(within(quality).getByLabelText("Edit existing record"), { target: { value: "case-1" } });
    expect((field(quality, "programme id") as HTMLSelectElement).value).toBe("prog-1");
    submit(quality);
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "save_quality", expect.objectContaining({ case_id: "case-1", programme_id: "prog-1", title: "TCU review", status: "draft", expected_version: 6 })));
  });

  it("submits an edited transcript with the referenced student and version", async () => {
    renderWorkspace("registrar");
    await screen.findByRole("heading", { name: "University Management" });
    fireEvent.click(screen.getByRole("tab", { name: "Students & results" }));
    const transcript = panel("Transcript request tracking");
    fireEvent.change(within(transcript).getByLabelText("Edit existing record"), { target: { value: "request-1" } });
    expect((field(transcript, "student id") as HTMLSelectElement).value).toBe("student-1");
    fill(transcript, "reference", "TR-UPDATED");
    submit(transcript);
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "save_transcript", expect.objectContaining({ request_id: "request-1", student_id: "student-1", copies: "1", status: "requested", due_date: "2026-12-01", reference: "TR-UPDATED", expected_version: 2 })));
  });

  it("confirms admission transition and student registration with IDs and versions", async () => {
    let admissionStatus = "accepted";
    read.mockImplementation(async (_client: unknown, _workspace: string, resource: string) => {
      if (resource === "bootstrap") return bootstrap("registrar");
      if (resource === "key_config") return { configured: true };
      if (resource === "admissions") return [{ ...rows.admissions[0], status: admissionStatus }];
      return rows[resource as keyof typeof rows] ?? [];
    });
    command.mockImplementation(async (_client: unknown, _workspace: string, action: string) => {
      if (action === "set_admission_status") admissionStatus = "confirmed";
      return { entity_id: "new-1", version: 1 };
    });
    renderWorkspace("registrar");
    await screen.findByRole("heading", { name: "University Management" });
    fireEvent.click(screen.getByRole("tab", { name: "Admissions" }));
    fireEvent.click(screen.getByRole("button", { name: "confirmed" }));
    fireEvent.click(await screen.findByRole("button", { name: "Set confirmed" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "set_admission_status", { application_id: "app-1", expected_version: 7, status: "confirmed" }));

    fireEvent.click(await screen.findByRole("button", { name: "Register student" }));
    fireEvent.click(await within(await screen.findByRole("alertdialog")).findByRole("button", { name: "Register student" }));
    await waitFor(() => expect(command).toHaveBeenCalledWith(expect.anything(), "ws-1", "register_student", expect.objectContaining({ application_id: "app-1", expected_version: 7, idempotency_key: expect.any(String) })));
  });

  it("reveals private_person only on demand after unlocking, using the person ID", async () => {
    read.mockImplementation(async (_client: unknown, _workspace: string, resource: string, filter?: Record<string, string>) => {
      if (resource === "bootstrap") return bootstrap("registrar");
      if (resource === "key_config") return { configured: true };
      if (resource === "private_person") {
        expect(filter).toEqual({ person_id: "person-1" });
        return { nonce: "cipher-nonce", ciphertext: "cipher-text" };
      }
      return rows[resource as keyof typeof rows] ?? [];
    });
    renderWorkspace("registrar");
    await screen.findByRole("heading", { name: "University Management" });
    const pass = screen.getByLabelText("Records passphrase");
    fireEvent.change(pass, { target: { value: "correct horse battery staple" } });
    fireEvent.submit(pass.closest("form")!);
    await waitFor(() => expect(screen.getByText("Private records unlocked in memory.")).toBeTruthy());
    fireEvent.click(screen.getByRole("tab", { name: "Admissions" }));
    expect(screen.queryByText("Revealed Person")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reveal" }));
    await waitFor(() => expect(screen.getByText("Revealed Person · person@example.test")).toBeTruthy());
    expect(decrypt).toHaveBeenCalledWith(expect.anything(), { nonce: "cipher-nonce", ciphertext: "cipher-text" });
  });

  it("supports keyboard tab focus movement and role-specific visibility", async () => {
    read.mockImplementation(async (_client: unknown, _workspace: string, resource: string) => {
      if (resource === "bootstrap") return bootstrap("lecturer");
      return [];
    });
    renderWorkspace("lecturer");
    await screen.findByRole("heading", { name: "University Management" });
    expect(screen.getByRole("tab", { name: "Academics" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Students & results" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Admissions" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Finance & funding" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Research" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Quality" })).toBeNull();
    const overview = screen.getByRole("tab", { name: "Overview" });
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Academics" })));
    fireEvent.keyDown(screen.getByRole("tab", { name: "Academics" }), { key: "End" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Students & results" })));
  });

  it("loads only active team members for the admin staff selector", async () => {
    renderWorkspace();
    await screen.findByRole("heading", { name: "University Management" });
    expect(officeTeamApi.listMembers).toHaveBeenCalledWith(expect.anything(), "ws-1");
    fireEvent.click(screen.getByRole("tab", { name: "Academics" }));
    const assignment = panel("Lecturer assignment");
    expect(await within(assignment).findByRole("option", { name: /Active member/ })).toBeTruthy();
    expect(within(assignment).queryByRole("option", { name: /Inactive member/ })).toBeNull();
  });
});
