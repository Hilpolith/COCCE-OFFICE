import OfficeSuiteAiAction from './OfficeSuiteAiAction';
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FormEvent, ReactNode } from "react";
import {
  Activity,
  BookOpen,
  Check,
  ClipboardCheck,
  CreditCard,
  FileKey,
  GraduationCap,
  KeyRound,
  LockKeyhole,
  Plus,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { useFrostedConfirm } from "./FrostedConfirm";
import { downloadOfficeCsv } from "./lib/officeCsvExport";
import { officeTeamApi } from "./lib/officeTeamApi";
import { officeIndustryTasksApi } from "./lib/officeIndustryTasks";
import {
  getOfficeTeamClient,
  resolveOfficeTeamConfig,
} from "./lib/officeTeamSupabase";
import {
  createUniversityKeyConfig,
  decryptUniversityPrivatePerson,
  encryptUniversityPrivatePerson,
  officeUniversityManagementApi,
  unlockUniversityKey,
} from "./lib/officeUniversityManagement";
import type {
  UniversityKeyConfig,
  UniversityPrivatePersonRecord,
  UniversityRole,
} from "./lib/officeUniversityManagement";
import "./industrySuites.css";
import "./universityManagement.css";

type Row = Record<string, unknown>;
type Tab =
  | "overview"
  | "academics"
  | "admissions"
  | "students"
  | "finance"
  | "research"
  | "quality";
type Resource =
  | "terms"
  | "programmes"
  | "courses"
  | "staff"
  | "assignments"
  | "admissions"
  | "students"
  | "registrations"
  | "assessments"
  | "scores"
  | "fees"
  | "receipts"
  | "funding"
  | "transcripts"
  | "research"
  | "quality";
type FormValues = Record<string, string>;
type ModuleProps = {
  data: Record<string, Row[]>;
  busy: boolean;
  command: (action: string, payload: Row, success: string) => Promise<boolean>;
  onMore: (resource: Resource) => void;
};
const PAGE = 50;
const emptyPerson: UniversityPrivatePersonRecord = {
  legal_name: "",
  preferred_name: "",
  date_of_birth: "",
  email: "",
  phone: "",
  national_reference: "",
};
const roleOptions: UniversityRole[] = [
  "registrar",
  "lecturer",
  "finance_officer",
  "research_coordinator",
  "quality_officer",
  "viewer",
];
const tabs: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: "overview", label: "Overview", icon: Activity },
  { id: "academics", label: "Academics", icon: BookOpen },
  { id: "admissions", label: "Admissions", icon: ClipboardCheck },
  { id: "students", label: "Students & results", icon: GraduationCap },
  { id: "finance", label: "Finance & funding", icon: CreditCard },
  { id: "research", label: "Research", icon: FileKey },
  { id: "quality", label: "Quality", icon: Check },
];
function rows(v: unknown): Row[] {
  return Array.isArray(v)
    ? v.filter(
        (x): x is Row => !!x && typeof x === "object" && !Array.isArray(x),
      )
    : [];
}
function record(v: unknown): Row {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};
}
function text(r: Row, k: string, f = "—"): string {
  const v = r[k];
  return v === null || v === undefined || v === "" ? f : String(v);
}
function roleValue(v: unknown): UniversityRole {
  return ["university_admin", ...roleOptions, "unassigned"].includes(String(v))
    ? (v as UniversityRole)
    : "unassigned";
}
function randomKey() {
  if (!globalThis.crypto?.randomUUID)
    throw new Error("This browser cannot create a secure retry key.");
  return globalThis.crypto.randomUUID();
}
function errorText(e: unknown) {
  const m =
    e instanceof Error
      ? e.message
      : "The University request could not be completed.";
  if (
    /office_university_(read|command)|PGRST202|could not find the function/i.test(
      m,
    )
  )
    return "University Management is not enabled in this deployment. No changes were saved.";
  if (/permission|row-level|42501/i.test(m))
    return "Your Office Team membership or University role does not allow that action.";
  return m;
}
function dateText(v: string) {
  if (!v) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
      new Date(`${v.slice(0, 10)}T12:00:00`),
    );
  } catch {
    return v;
  }
}
function admissionOptions(s: string) {
  if (s === "submitted") return ["reviewing", "withdrawn"];
  if (s === "reviewing")
    return ["offered", "waitlisted", "rejected", "withdrawn"];
  if (s === "waitlisted")
    return ["reviewing", "offered", "rejected", "withdrawn"];
  if (s === "offered") return ["accepted", "rejected", "withdrawn"];
  if (s === "accepted") return ["confirmed", "withdrawn"];
  return [];
}
function labelFor(r: Row) {
  for (const field of ["title", "label", "term_label", "name", "display_name", "username", "code", "student_ref", "application_code", "receipt_number", "category", "provider", "user_id"]) {
    const label = text(r, field, "");
    if (label) return label;
  }
  return "Record";
}

export default function UniversityManagementWorkspace({
  workspaceId,
  officeName,
  country,
  accent,
}: {
  workspaceId: string;
  officeName: string;
  country: string;
  accent: string;
}) {
  const config = useMemo(
    () =>
      resolveOfficeTeamConfig(
        import.meta.env as unknown as Parameters<
          typeof resolveOfficeTeamConfig
        >[0],
      ),
    [],
  );
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const confirm = useFrostedConfirm();
  const [status, setStatus] = useState<
    | "loading"
    | "signed-out"
    | "not-member"
    | "setup-required"
    | "profile-conflict"
    | "ready"
    | "error"
  >("loading");
  const [role, setRole] = useState<UniversityRole>("unassigned");
  const [tab, setTab] = useState<Tab>("overview");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [data, setData] = useState<Record<string, Row[]>>({});
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const generation = useRef(0);
  const workspaceRef = useRef(workspaceId);
  workspaceRef.current = workspaceId;
  const secretEpoch = useRef(0);
  const busyRef = useRef(false);
  const pagingRef = useRef(new Set<string>());
  const applicantRetry = useRef<{signature:string; payload:Row}|null>(null);
  const [keyConfig, setKeyConfig] = useState<UniversityKeyConfig>({
    configured: false,
  });
  const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [person, setPerson] = useState(emptyPerson);
  const [revealed, setRevealed] = useState<
    Record<string, UniversityPrivatePersonRecord>
  >({});
  const isAdmin = role === "university_admin",
    canReg = isAdmin || role === "registrar",
    canLect = isAdmin || role === "lecturer",
    canFin = isAdmin || role === "finance_officer",
    canResearch = isAdmin || role === "research_coordinator",
    canQuality = isAdmin || role === "quality_officer";
  const visibleTabs = useMemo(
    () =>
      tabs.filter(
        ({ id }) =>
          id === "overview" ||
          (id === "academics" && (isAdmin || canReg || canLect)) ||
          (id === "admissions" && canReg) ||
          (id === "students" && (canReg || canLect)) ||
          (id === "finance" && canFin) ||
          (id === "research" && canResearch) ||
          (id === "quality" && canQuality),
      ),
    [canFin, canLect, canQuality, canReg, canResearch, isAdmin],
  );
  const currentTab = visibleTabs.some((x) => x.id === tab) ? tab : "overview";
  const clearSecrets = useCallback(() => {
    secretEpoch.current++;
    applicantRetry.current = null;
    setPass("");
    setPass2("");
    setPerson(emptyPerson);
    setPrivateKey(null);
    setRevealed({});
  }, []);
  const load = useCallback(
    async (resource: Resource, fresh = false): Promise<Row[]> => {
      if (!client) return [];
      const token = generation.current;
      const targetWorkspace = workspaceId;
      const offset = fresh ? 0 : (offsets[resource] ?? 0);
      const result = rows(
        await officeUniversityManagementApi.read(
          client,
          targetWorkspace,
          resource,
          {},
          PAGE,
          offset,
        ),
      );
      if (
        token !== generation.current ||
        workspaceRef.current !== targetWorkspace
      )
        return [];
      setData((p) => ({
        ...p,
        [resource]: fresh ? result : [...(p[resource] ?? []), ...result],
      }));
      setOffsets((p) => ({ ...p, [resource]: offset + result.length }));
      return result;
    },
    [client, offsets, workspaceId],
  );
  const refresh = useCallback(async () => {
    const token = ++generation.current;
    workspaceRef.current = workspaceId;
    clearSecrets();
    setStatus("loading");
    setFeedback("");
    try {
      if (config.status !== "ready" || !client) {
        setStatus("error");
        setFeedback("Office Team is not enabled in this deployment.");
        return;
      }
      const auth = await client.auth.getUser();
      if (token !== generation.current || workspaceRef.current !== workspaceId)
        return;
      if (!auth.data.user) {
        setStatus("signed-out");
        return;
      }
      const spaces = await officeTeamApi.listWorkspaces(client);
      if (token !== generation.current || workspaceRef.current !== workspaceId)
        return;
      if (!spaces.some((x) => x.workspace_id === workspaceId)) {
        setStatus("not-member");
        return;
      }
      const space = await officeIndustryTasksApi.getSpace(client, workspaceId);
      if (token !== generation.current) return;
      if (!space) {
        setStatus("setup-required");
        return;
      }
      if (space.industry_id !== "university") {
        setStatus("profile-conflict");
        return;
      }
      const boot = record(
        await officeUniversityManagementApi.read(
          client,
          workspaceId,
          "bootstrap",
        ),
      );
      if (token !== generation.current) return;
      const freshRole = roleValue(boot.role);
      setRole(freshRole);
      const initial = {
        terms: rows(boot.terms),
        programmes: rows(boot.programmes),
        courses: rows(boot.courses),
      };
      setData(initial);
      setOffsets(
        Object.fromEntries(
          Object.entries(initial).map(([k, v]) => [k, v.length]),
        ),
      );
      const reads: Resource[] = [];
      if (freshRole === "university_admin" || freshRole === "registrar")
        reads.push("admissions", "staff", "assignments", "transcripts");
      if (
        freshRole === "university_admin" ||
        freshRole === "registrar" ||
        freshRole === "lecturer"
      )
        reads.push("students", "registrations", "assessments", "scores");
      if (freshRole === "university_admin" || freshRole === "finance_officer")
        reads.push("fees", "receipts", "funding");
      if (freshRole === "finance_officer") reads.push("students");
      if (
        freshRole === "university_admin" ||
        freshRole === "research_coordinator"
      )
        reads.push("research");
      if (freshRole === "university_admin" || freshRole === "quality_officer")
        reads.push("quality");
      await Promise.all(
        reads.map(async (r) => {
          const value = rows(
            await officeUniversityManagementApi.read(
              client,
              workspaceId,
              r,
              {},
              PAGE,
              0,
            ),
          );
          if (token !== generation.current) return;
          setData((p) => ({ ...p, [r]: value }));
          setOffsets((p) => ({ ...p, [r]: value.length }));
        }),
      );
      if (
        freshRole === "university_admin" &&
        typeof officeTeamApi.listMembers === "function"
      ) {
        const members = rows(
          await officeTeamApi.listMembers(client, workspaceId),
        );
        if (token !== generation.current) return;
        setData((p) => ({
          ...p,
          members: members.filter((m) => m.status === "active"),
        }));
      }
      if (freshRole === "university_admin" || freshRole === "registrar") {
        const key = record(
          await officeUniversityManagementApi.read(
            client,
            workspaceId,
            "key_config",
          ),
        );
        if (token !== generation.current) return;
        setKeyConfig(key as UniversityKeyConfig);
      }
      if (token === generation.current) setStatus("ready");
    } catch (e) {
      if (token === generation.current) {
        setStatus("error");
        setFeedback(errorText(e));
      }
    }
  }, [clearSecrets, client, config.status, workspaceId]);
  useEffect(() => {
    void refresh();
    return () => {
      generation.current++;
      clearSecrets();
    };
  }, [refresh, clearSecrets]);
  useEffect(() => {
    const subscription = client?.auth.onAuthStateChange?.((event) => {
      if (event === "SIGNED_OUT") {
        generation.current++;
        clearSecrets();
        setData({});
        setRole("unassigned");
        setStatus("signed-out");
      } else if (event === "SIGNED_IN") {
        queueMicrotask(() => void refresh());
      }
    });
    return () => subscription?.data.subscription.unsubscribe();
  }, [client, clearSecrets, refresh]);
  useEffect(() => {
    const timer = privateKey ? window.setTimeout(clearSecrets, 900000) : undefined;
    const hidden = () => {
      if (document.visibilityState === "hidden") clearSecrets();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, [privateKey, clearSecrets]);
  useEffect(() => {
    clearSecrets();
  }, [workspaceId, role, clearSecrets]);
  const command = useCallback(
    async (action: string, payload: Row, success: string) => {
      if (!client || busyRef.current) return false;
      const targetWorkspace = workspaceId;
      const token = generation.current;
      busyRef.current = true;
      setBusy(true);
      try {
        await officeUniversityManagementApi.command(
          client,
          workspaceId,
          action,
          payload,
        );
        if (token !== generation.current || workspaceRef.current !== targetWorkspace) return false;
        await refresh();
        if (workspaceRef.current !== targetWorkspace) return false;
        setFeedback(success);
        return true;
      } catch (e) {
        if (workspaceRef.current === targetWorkspace && token === generation.current) setFeedback(errorText(e));
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [busy, client, refresh, workspaceId],
  );
  const more = useCallback(
    async (resource: Resource) => {
      if (busyRef.current || pagingRef.current.has(resource)) return;
      pagingRef.current.add(resource);
      try {
        await load(resource);
      } catch (e) {
        setFeedback(errorText(e));
      } finally { pagingRef.current.delete(resource); }
    },
    [load],
  );
  const setupProfile = async () => {
    if (profileBusy || !client) return;
    setProfileBusy(true);
    try {
      await officeIndustryTasksApi.registerSpace(client, {
        workspaceId,
        industryId: "university",
        officeName,
        country,
      });
      setFeedback("Empty University profile created.");
      await refresh();
    } catch (e) {
      setFeedback(errorText(e));
    } finally {
      setProfileBusy(false);
    }
  };
  const setupKey = async (e: FormEvent) => {
    e.preventDefault();
    if (pass !== pass2) {
      setFeedback("Passphrases do not match.");
      return;
    }
    try {
      const targetWorkspace = workspaceId;
      const created = await createUniversityKeyConfig(pass);
      if (workspaceRef.current !== targetWorkspace || document.visibilityState === "hidden") return;
      if (
        await command(
          "setup_key",
          created.payload,
          "Private-record key configured.",
        )
      ) {
        clearSecrets();
        if (workspaceRef.current === targetWorkspace && !document.hidden) setPrivateKey(created.key);
      }
    } catch (e) {
      setFeedback(errorText(e));
    }
  };
  const unlock = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const epoch = secretEpoch.current;
      const token = generation.current;
      const key = await unlockUniversityKey(pass, keyConfig);
      if (epoch !== secretEpoch.current || token !== generation.current || document.visibilityState === "hidden") return;
      setPrivateKey(key);
      setPass("");
      setFeedback("Private records unlocked in memory.");
    } catch (e) {
      setFeedback(errorText(e));
    }
  };
  const createApplicant = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!privateKey) {
      setFeedback("Unlock private records before creating an applicant.");
      return;
    }
    try {
      const values = new FormData(form);
      const epoch = secretEpoch.current;
      const term_id = String(values.get("term_id") || "");
      const programme_id = String(values.get("programme_id") || "");
      const signature = JSON.stringify({person,term_id,programme_id});
      if (applicantRetry.current?.signature !== signature) {
        const cipher = await encryptUniversityPrivatePerson(privateKey, person);
        if (epoch !== secretEpoch.current) return;
        applicantRetry.current = {signature,payload:{term_id,programme_id,private_nonce:cipher.nonce,private_ciphertext:cipher.ciphertext,idempotency_key:randomKey()}};
      }
      const ok = await command(
        "create_application",
        applicantRetry.current.payload,
        "Applicant created with encrypted identity.",
      );
      if (ok) {
        setPerson(emptyPerson);
        form.reset();
      }
    } catch (e) {
      setFeedback(errorText(e));
    }
  };
  const reveal = async (row: Row) => {
    if (!privateKey) {
      setFeedback("Unlock private records to reveal an identity.");
      return;
    }
    try {
      const pid = text(row, "person_id", "");
      const epoch = secretEpoch.current;
      const token = generation.current;
      const p = record(
        await officeUniversityManagementApi.read(
          client!,
          workspaceId,
          "private_person",
          { person_id: pid },
          1,
          0,
        ),
      );
      if (!p.ciphertext)
        throw new Error(
          "Private identity ciphertext is not available for this person.",
        );
      const identity = await decryptUniversityPrivatePerson(privateKey, {
        nonce: text(p, "nonce", ""),
        ciphertext: text(p, "ciphertext", ""),
      });
      if (epoch !== secretEpoch.current || token !== generation.current || document.visibilityState === "hidden") return;
      setRevealed((v) => ({ ...v, [pid]: identity }));
    } catch (e) {
      setFeedback(errorText(e));
    }
  };
  const decide = async (row: Row, next: string) => {
    if (
      await confirm({
        title: "Confirm admission decision",
        description: `Move ${text(row, "application_code", "this application")} to ${next}?`,
        confirmLabel: `Set ${next}`,
      })
    )
      await command(
        "set_admission_status",
        {
          application_id: row.application_id,
          expected_version: Number(row.version ?? 0),
          status: next,
        },
        "Admission decision saved.",
      );
  };
  const registerStudent = async (row: Row) => {
    if (
      await confirm({
        title: "Register confirmed applicant",
        description:
          "This atomically creates the student record and random student reference. Continue?",
        confirmLabel: "Register student",
      })
    )
      await command(
        "register_student",
        {
          application_id: row.application_id,
          expected_version: Number(row.version ?? 0),
          idempotency_key: randomKey(),
        },
        "Student registered atomically.",
      );
  };
  const lockAssessment = async (row: Row, next: "locked" | "approved") => {
    if (
      await confirm({
        title: `${next === "locked" ? "Lock" : "Approve"} assessment`,
        description: `Scores become immutable after ${next}. Continue?`,
        confirmLabel: next === "locked" ? "Lock results" : "Approve results",
      })
    )
      await command(
        "set_assessment_status",
        {
          assessment_id: row.assessment_id,
          expected_version: Number(row.version ?? 0),
          status: next,
        },
        `Assessment ${next}.`,
      );
  };
  const showState = (title: string, body: string, action?: ReactNode) => (
    <section className="university-state">
      <ShieldAlert size={21} />
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </section>
  );
  if (status === "loading")
    return showState(
      "Loading secure University workspace…",
      "Checking Office Team membership and university access.",
    );
  if (status === "signed-out" || status === "not-member")
    return showState(
      "Office Team access required",
      "Sign in with an active Office Team membership to load University records.",
    );
  if (status === "setup-required")
    return showState(
      "Connect this team to University Management",
      "This creates an empty cloud profile only.",
      <button
        className="button-primary"
        disabled={profileBusy}
        onClick={() => void setupProfile()}
      >
        <Plus size={15} />
        Create empty University profile
      </button>,
    );
  if (status === "profile-conflict")
    return showState(
      "Industry profile conflict",
      "This Office Team is not configured for a university.",
    );
  if (status === "error")
    return showState(
      "University workspace unavailable",
      feedback || "The secure University workspace could not be loaded.",
      <button className="button-secondary" onClick={() => void refresh()}>
        <RefreshCw size={14} />
        Try again
      </button>,
    );
  return (
    <div
      className="university-workspace"
      style={{ "--industry-accent": accent } as CSSProperties}
    >
      <header className="university-hero">
        <div className="university-mark">
          <GraduationCap />
        </div>
        <div>
          <span className="eyebrow">
            {officeName.toUpperCase()} · {country.toUpperCase()} · SHARED TEAM
          </span>
          <h2>University Management</h2>
          <p>
            Versioned academic operations. External TCU, HESLB, UDSM, NIMR and
            COSTECH workflows remain manual and unconnected.
          </p>
        </div>
        <button className="button-secondary" onClick={() => void refresh()}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </header>
      <div className="university-boundary">
        <LockKeyhole size={16} />
        <span>
          Private identities use client-side AES-256-GCM. Keys, passphrases and
          decrypted identity remain memory-only.
        </span>
      </div>
      {feedback && (
        <div className="university-feedback" role="status">
          {feedback}
        </div>
      )}
      <div className="office-suite-ai-toolbar"><OfficeSuiteAiAction workspaceId={workspaceId} suiteLabel="Universities" tabLabel={currentTab.replaceAll("_", " ")} /></div>
      <nav
        className="university-tabs"
        role="tablist"
        aria-label="University office modules"
      >
        {visibleTabs.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={currentTab === item.id}
            tabIndex={currentTab === item.id ? 0 : -1}
            className={currentTab === item.id ? "is-active" : ""}
            onClick={() => setTab(item.id)}
            onKeyDown={(e) => {
              if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(e.key))
                return;
              e.preventDefault();
              const next =
                e.key === "Home"
                  ? 0
                  : e.key === "End"
                    ? visibleTabs.length - 1
                    : (index +
                        (e.key === "ArrowRight" ? 1 : -1) +
                        visibleTabs.length) %
                      visibleTabs.length;
              setTab(visibleTabs[next].id);
              requestAnimationFrame(() =>
                document
                  .querySelector<HTMLButtonElement>(
                    `[role="tab"][data-tab="${visibleTabs[next].id}"]`,
                  )
                  ?.focus(),
              );
            }}
            data-tab={item.id}
          >
            <item.icon size={14} />
            {item.label}
          </button>
        ))}
      </nav>
      {currentTab === "overview" && <Overview data={data} role={role} />}{" "}
      {currentTab === "academics" && (
        <Academics
          canAdmin={isAdmin}
          data={data}
          canWrite={isAdmin || canReg}
          busy={busy}
          command={command}
          onMore={more}
        />
      )}{" "}
      {currentTab === "admissions" && (
        <Admissions
          data={data}
          person={person}
          setPerson={setPerson}
          privateReady={!!privateKey}
          onCreate={createApplicant}
          onReveal={reveal}
          revealed={revealed}
          onDecision={decide}
          onRegister={registerStudent}
          canRegister={canReg}
          busy={busy}
          onMore={more}
        />
      )}{" "}
      {currentTab === "students" && (
        <Students
          data={data}
          role={role}
          busy={busy}
          command={command}
          onLock={lockAssessment}
          onMore={more}
        />
      )}{" "}
      {currentTab === "finance" && (
        <Finance data={data} busy={busy} command={command} onMore={more} />
      )}{" "}
      {currentTab === "research" && (
        <Research data={data} busy={busy} command={command} onMore={more} />
      )}{" "}
      {currentTab === "quality" && (
        <Quality data={data} busy={busy} command={command} onMore={more} />
      )}{" "}
      {(canReg || isAdmin) && (
        <KeyPanel
          isAdmin={isAdmin}
          keyConfig={keyConfig}
          privateKey={privateKey}
          pass={pass}
          pass2={pass2}
          setPass={setPass}
          setPass2={setPass2}
          setupKey={setupKey}
          unlock={unlock}
          clear={clearSecrets}
        />
      )}
    </div>
  );
}
function Overview({
  data,
  role,
}: {
  data: Record<string, Row[]>;
  role: UniversityRole;
}) {
  const cards = [
    ["terms", "Academic periods"],
    ["programmes", "Programmes"],
    ["courses", "Courses"],
    ["admissions", "Applications"],
    ["students", "Students"],
    ["research", "Research cases"],
  ];
  const visibleCards = cards.filter(
    ([k]) => k !== "admissions" || role === "university_admin" || role === "registrar",
  );
  const exportRows = [
    ...visibleCards.map(([key, label]) => [label, (data[key] ?? []).length, "Loaded records"]),
    ...(role === "university_admin" || role === "registrar"
      ? [["Admissions in active decision states", (data.admissions ?? []).filter((item) => ["submitted", "reviewing", "offered", "waitlisted"].includes(text(item, "status", ""))).length, "Loaded records"]]
      : []),
    ["Draft assessments", (data.assessments ?? []).filter((item) => text(item, "status", "") === "draft").length, "Loaded records"],
  ];
  return (
    <>
      <section className="university-metrics">
        {visibleCards.map(([k, l]) => (
            <div className="university-metric" key={k}>
              <span>{l}</span>
              <strong>{(data[k] ?? []).length}</strong>
              <small>Loaded records</small>
            </div>
          ))}
      </section>
      <button type="button" className="button-secondary" onClick={() => downloadOfficeCsv("university-overview-loaded.csv", ["Metric", "Value", "Scope"], exportRows)}>Export loaded academic overview CSV</button>
      <section className="university-grid">
        <Panel title="Operational snapshot">
          <p>
            {
              (data.admissions ?? []).filter((x) =>
                ["submitted", "reviewing", "offered", "waitlisted"].includes(
                  text(x, "status", ""),
                ),
              ).length
            }{" "}
            admissions in active decision states.{" "}
            {
              (data.assessments ?? []).filter(
                (x) => text(x, "status", "") === "draft",
              ).length
            }{" "}
            assessments remain draft.
          </p>
        </Panel>
        <Panel title="Official manual services">
          <a href="https://tcu.go.tz/services/admissions-coordination-and-database-management/admission-guidebooks/undergraduate" target="_blank" rel="noreferrer">TCU admission guidebooks · manual reference</a>
          <a href="https://www.heslb.go.tz/" target="_blank" rel="noreferrer">HESLB funding follow-up · manual / unconnected</a>
          <a
            href="https://www.udsm.ac.tz/aris-3-transcript-request-procedures"
            target="_blank"
            rel="noreferrer"
          >
            UDSM ARIS 3 transcript request procedures · manual reference
          </a>
          <a href="https://nimr.or.tz/health-research-regulations/" target="_blank" rel="noreferrer">NIMR health-research regulations · manual reference</a>
          <a href="https://www.costech.or.tz/" target="_blank" rel="noreferrer">COSTECH research permits · manual reference</a>
          <p className="muted">
            TCU, HESLB, NIMR and COSTECH workflows are not initiated or verified
            here.
          </p>
        </Panel>
      </section>
    </>
  );
}
function Academics({
  canAdmin,
  data,
  canWrite,
  busy,
  command,
  onMore,
}: ModuleProps & { canWrite: boolean; canAdmin: boolean }) {
  return (
    <>
      <section className="university-grid">
        <EntityEditor
          title="Academic period"
          action="save_term"
          fields={[
            "label",
            "academic_year",
            "start_date",
            "end_date",
            "status",
          ]}
          options={{ status: ["open", "closed"] }}
          records={data.terms}
          canWrite={canWrite}
          busy={busy}
          command={command}
        />
        <EntityEditor
          title="Programme"
          action="save_programme"
          fields={["code", "name", "award", "status"]}
          options={{ status: ["active", "archived"] }}
          records={data.programmes}
          canWrite={canWrite}
          busy={busy}
          command={command}
        />
        <EntityEditor
          title="Course"
          action="save_course"
          fields={["programme_id", "code", "name", "credits", "status"]}
          options={{ status: ["active", "archived"] }}
          references={{ programme_id: data.programmes }}
          records={data.courses}
          canWrite={canWrite}
          busy={busy}
          command={command}
        />
        <EntityEditor
          title="Lecturer assignment"
          action="assign_lecturer"
          fields={["course_id", "term_id", "user_id", "active"]}
          options={{ active: ["true", "false"] }}
          references={{
            course_id: data.courses,
            term_id: data.terms,
            user_id: data.members ?? data.staff,
          }}
          canWrite={canWrite}
          busy={busy}
          command={command}
        />
        {canAdmin && (
          <StaffRoleEditor data={data} busy={busy} command={command} />
        )}
      </section>
      <ResourceList
        title="Periods"
        resource="terms"
        data={data}
        onMore={onMore}
      />
      <ResourceList
        title="Programmes"
        resource="programmes"
        data={data}
        onMore={onMore}
      />
      <ResourceList
        title="Courses"
        resource="courses"
        data={data}
        onMore={onMore}
      />
      <ResourceList
        title="Lecturer assignments"
        resource="assignments"
        data={data}
        onMore={onMore}
      />
    </>
  );
}
function StaffRoleEditor({
  data,
  busy,
  command,
}: {
  data: Record<string, Row[]>;
  busy: boolean;
  command: ModuleProps["command"];
}) {
  return (
    <EntityEditor
      title="Staff role assignment (admin only)"
      action="set_staff_role"
      fields={["user_id", "university_role", "active"]}
      options={{ university_role: roleOptions, active: ["true", "false"] }}
      references={{ user_id: data.members ?? data.staff }}
      canWrite
      busy={busy}
      command={command}
    />
  );
}
function Admissions({
  data,
  person,
  setPerson,
  privateReady,
  onCreate,
  onReveal,
  revealed,
  onDecision,
  onRegister,
  canRegister,
  busy,
  onMore,
}: {
  data: Record<string, Row[]>;
  person: UniversityPrivatePersonRecord;
  setPerson: (p: UniversityPrivatePersonRecord) => void;
  privateReady: boolean;
  onCreate: (e: FormEvent<HTMLFormElement>) => void;
  onReveal: (r: Row) => void;
  revealed: Record<string, UniversityPrivatePersonRecord>;
  onDecision: (r: Row, n: string) => void;
  onRegister: (r: Row) => void;
  canRegister: boolean;
  busy: boolean;
  onMore: (r: Resource) => void;
}) {
  return (
    <>
      <section className="university-grid">
        <Panel title="Encrypted applicant intake">
          <form className="university-form" onSubmit={onCreate}>
            <SelectField
              label="Term"
              name="term_id"
              options={(data.terms ?? []).map((r) => [
                text(r, "term_id"),
                text(r, "label", text(r, "term_label")),
              ])}
              required
            />
            <SelectField
              label="Programme"
              name="programme_id"
              options={(data.programmes ?? []).map((r) => [
                text(r, "programme_id"),
                `${text(r, "code")} · ${text(r, "name")}`,
              ])}
              required
            />
            {(
              [
                "legal_name",
                "preferred_name",
                "date_of_birth",
                "email",
                "phone",
                "national_reference",
              ] as const
            ).map((f) => (
              <label key={f}>
                {f.replaceAll("_", " ")}
                <input
                  type={f === "date_of_birth" ? "date" : "text"}
                  value={person[f]}
                  onChange={(e) =>
                    setPerson({ ...person, [f]: e.target.value })
                  }
                  required={f === "legal_name"}
                />
              </label>
            ))}
            <button className="button-primary" disabled={busy || !privateReady}>
              <Plus size={14} />
              Create encrypted applicant
            </button>
          </form>
          {!privateReady && (
            <p className="muted">
              Unlock the identity key before entering or revealing private
              identity.
            </p>
          )}
        </Panel>
        <Panel title="Admissions decisions">
          {(data.admissions ?? []).length === 0 ? (
            <Empty text="No applications loaded." />
          ) : (
            (data.admissions ?? []).map((r) => (
              <div className="university-row" key={text(r, "application_id")}>
                <div>
                  <strong>{text(r, "application_code")}</strong>
                  <span>
                    {text(r, "status")} ·{" "}
                    {text(r, "programme_name", text(r, "programme_id"))}
                  </span>
                  {revealed[text(r, "person_id", "")] && (
                    <small>
                      {revealed[text(r, "person_id", "")].legal_name} ·{" "}
                      {revealed[text(r, "person_id", "")].email}
                    </small>
                  )}
                </div>
                <div className="row-actions">
                  {privateReady && (
                    <button
                      className="button-secondary"
                      onClick={() => onReveal(r)}
                    >
                      Reveal
                    </button>
                  )}
                  {admissionOptions(text(r, "status", "")).map((n) => (
                    <button
                      key={n}
                      className="button-secondary"
                      disabled={busy}
                      onClick={() => onDecision(r, n)}
                    >
                      {n}
                    </button>
                  ))}
                  {text(r, "status") === "confirmed" && canRegister && (
                    <button
                      className="button-primary"
                      disabled={busy}
                      onClick={() => onRegister(r)}
                    >
                      Register student
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
        </Panel>
      </section>
      <ResourceList
        title="Application queue"
        resource="admissions"
        data={data}
        onMore={onMore}
      />
    </>
  );
}
function Students({
  data,
  role,
  busy,
  command,
  onLock,
  onMore,
}: ModuleProps & {
  role: UniversityRole;
  onLock: (r: Row, n: "locked" | "approved") => void;
}) {
  const writable =
    role === "university_admin" || role === "registrar" || role === "lecturer";
  return (
    <>
      <section className="university-grid">
        <EntityEditor
          title="Course registration"
          action="register_course"
          fields={["student_id", "course_id", "term_id"]}
          references={{
            student_id: data.students,
            course_id: data.courses,
            term_id: data.terms,
          }}
          canWrite={role === "university_admin" || role === "registrar"}
          busy={busy}
          command={command}
        />
        <EntityEditor
          title="Assessment"
          action="save_assessment"
          fields={[
            "assessment_id",
            "course_id",
            "term_id",
            "title",
            "max_score",
          ]}
          references={{
            assessment_id: data.assessments,
            course_id: data.courses,
            term_id: data.terms,
          }}
          records={data.assessments}
          canWrite={writable}
          busy={busy}
          command={command}
        />
        <EntityEditor
          title="Score entry"
          action="set_score"
          fields={["assessment_id", "student_id", "score"]}
          references={{
            assessment_id: data.assessments,
            student_id: data.students,
          }}
          records={data.scores}
          canWrite={writable}
          busy={busy}
          command={command}
        />
        <EntityEditor
          title="Transcript request tracking"
          action="save_transcript"
          fields={[
            "request_id",
            "student_id",
            "copies",
            "status",
            "due_date",
            "reference",
          ]}
          options={{
            status: [
              "requested",
              "payment_pending",
              "processing",
              "ready",
              "completed",
              "declined",
            ],
          }}
          references={{
            request_id: data.transcripts,
            student_id: data.students,
          }}
          records={data.transcripts}
          canWrite={role === "university_admin" || role === "registrar"}
          busy={busy}
          command={command}
        />
      </section>
      <ResourceList
        title="Students"
        resource="students"
        data={data}
        onMore={onMore}
      />
      <ResourceList
        title="Registrations"
        resource="registrations"
        data={data}
        onMore={onMore}
      />
      <ResourceList
        title="Assessments"
        resource="assessments"
        data={data}
        onMore={onMore}
        rowAction={(r) =>
          text(r, "status") === "draft" ? (
            <button
              className="button-secondary"
              disabled={busy}
              onClick={() => onLock(r, "locked")}
            >
              Lock
            </button>
          ) : text(r, "status") === "locked" &&
            (role === "university_admin" || role === "registrar") ? (
            <button
              className="button-primary"
              disabled={busy}
              onClick={() => onLock(r, "approved")}
            >
              Approve
            </button>
          ) : null
        }
      />
      <ResourceList
        title="Scores"
        resource="scores"
        data={data}
        onMore={onMore}
      />
      <ResourceList
        title="Transcript requests"
        resource="transcripts"
        data={data}
        onMore={onMore}
      />
    </>
  );
}
function Finance({ data, busy, command, onMore }: ModuleProps) {
  return (
    <>
      <section className="university-grid">
        <EntityEditor
          title="Fee charge"
          action="create_charge"
          fields={[
            "student_id",
            "term_id",
            "category",
            "amount_tzs",
            "due_date",
          ]}
          references={{ student_id: data.students, term_id: data.terms }}
          canWrite
          busy={busy}
          command={command}
        />
        <EntityEditor
          title="Manual receipt"
          action="record_receipt"
          fields={["charge_id", "amount_tzs", "payment_method", "reference"]}
          options={{
            payment_method: ["cash", "bank", "mobile_money", "other"],
          }}
          references={{ charge_id: data.fees }}
          canWrite
          busy={busy}
          command={command}
        />
        <EntityEditor
          title="HESLB funding case"
          action="save_funding"
          fields={[
            "funding_id",
            "student_id",
            "provider",
            "academic_year",
            "status",
            "outcome",
            "follow_up_due",
          ]}
          options={{
            status: [
              "not_started",
              "submitted",
              "document_check",
              "allocated",
              "appeal",
              "disbursement_pending",
              "reconciled",
              "closed",
            ],
          }}
          references={{ funding_id: data.funding, student_id: data.students }}
          records={data.funding}
          canWrite
          busy={busy}
          command={command}
        />
      </section>
      <ResourceList
        title="Fee charges"
        resource="fees"
        data={data}
        onMore={onMore}
      />
      <ResourceList
        title="Receipts"
        resource="receipts"
        data={data}
        onMore={onMore}
      />
      <ResourceList
        title="Funding cases"
        resource="funding"
        data={data}
        onMore={onMore}
      />
    </>
  );
}
function Research({ data, busy, command, onMore }: ModuleProps) {
  return (
    <>
      <EntityEditor
        title="Research proposal & clearance chain"
        action="save_research"
        fields={[
          "project_id",
          "title",
          "proposal_status",
          "ethics_status",
          "university_clearance_status",
          "permit_status",
          "ethics_reference",
          "clearance_reference",
          "permit_reference",
          "review_date",
          "expiry_date",
        ]}
        options={{
          proposal_status: ["draft", "submitted", "approved", "rejected"],
          ethics_status: [
            "not_required",
            "not_started",
            "submitted",
            "approved",
            "expired",
          ],
          university_clearance_status: [
            "not_started",
            "submitted",
            "approved",
            "expired",
          ],
          permit_status: [
            "not_required",
            "not_started",
            "submitted",
            "approved",
            "expired",
          ],
        }}
        records={data.research}
        canWrite
        busy={busy}
        command={command}
      />
      <ResourceList
        title="Research projects"
        resource="research"
        data={data}
        onMore={onMore}
      />
    </>
  );
}
function Quality({ data, busy, command, onMore }: ModuleProps) {
  return (
    <>
      <EntityEditor
        title="Quality / TCU case"
        action="save_quality"
        fields={[
          "case_id",
          "programme_id",
          "title",
          "status",
          "review_query",
          "evidence_reference",
          "due_date",
        ]}
        options={{
          status: [
            "draft",
            "submitted",
            "queries",
            "approved",
            "renewal_due",
            "closed",
          ],
        }}
        references={{ programme_id: data.programmes, case_id: data.quality }}
        records={data.quality}
        canWrite
        busy={busy}
        command={command}
      />
      <ResourceList
        title="Quality cases"
        resource="quality"
        data={data}
        onMore={onMore}
      />
    </>
  );
}
function EntityEditor({
  title,
  action,
  fields,
  options = {},
  references = {},
  records = [],
  canWrite = true,
  busy,
  command,
}: {
  title: string;
  action: string;
  fields: string[];
  options?: Record<string, string[]>;
  references?: Record<string, Row[]>;
  records?: Row[];
  canWrite?: boolean;
  busy: boolean;
  command: ModuleProps["command"];
}) {
  const [values, setValues] = useState<FormValues>({});
  const [selected, setSelected] = useState("");
  const keyRef = useRef<{signature:string;key:string}|null>(null);

  const pick = (id: string) => {
    setSelected(id);
    if (!id) { setValues({}); return; }
    const row = records.find((r) => text(r, idField(action), "") === id);
    if (row) {
      const next: FormValues = {};
      fields.forEach((f) => {
        if (row[f] !== undefined) next[f] = String(row[f]);
      });
      setValues(next);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const payload: Row = { ...values };
    if (selected) {
      const existing = records.find(r => text(r,idField(action),"") === selected);
      payload[idField(action)] = selected;
      payload.expected_version = Number(existing?.version ?? 0);
    }
    for (const k of Object.keys(payload))
      if (payload[k] === "") delete payload[k];
    if (!["set_score", "set_staff_role", "assign_lecturer"].includes(action)) {
      const fullSignature = JSON.stringify(payload);
      if (!keyRef.current || keyRef.current.signature !== fullSignature)
        keyRef.current = {signature:fullSignature,key:randomKey()};
      payload.idempotency_key = keyRef.current.key;
    }
    if (action === "set_score") {
      const previous = records.find(row => row.assessment_id === payload.assessment_id && row.student_id === payload.student_id);
      payload.expected_version = Number(previous?.version ?? 0);
    }
    if (action === "assign_lecturer" || action === "set_staff_role")
      payload.active = payload.active !== "false";
    if (await command(action, payload, `${title} saved.`)) {
      setValues({});
      setSelected("");
      keyRef.current = null;
    }
  };
  if (!canWrite) return null;
  return (
    <Panel title={title}>
      <form className="university-form" onSubmit={submit}>
        {records.length > 0 && action.startsWith("save_") && (
          <label className="record-selector">
            Edit existing record
            <select value={selected} onChange={(e) => pick(e.target.value)}>
              <option value="">Create new record</option>
              {records.map((r) => {
                const id = text(r, idField(action), "");
                return id ? (
                  <option key={id} value={id}>
                    {labelFor(r)} · v{text(r, "version", "0")}
                  </option>
                ) : null;
              })}
            </select>
          </label>
        )}
        {fields.map((f) => {
          if (["expected_version", "idempotency_key"].includes(f)) return null;
          if (action.startsWith("save_") && f === idField(action)) return null;
          const ref = references[f];
          if (options[f])
            return (
              <label key={f}>
                {f.replaceAll("_", " ")}
                <select
                  value={values[f] ?? ""}
                  onChange={(e) =>
                    setValues({ ...values, [f]: e.target.value })
                  }
                  required
                >
                  <option value="">Choose…</option>
                  {options[f].map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </label>
            );
          if (ref)
            return (
              <label key={f}>
                {f.replaceAll("_", " ")}
                <select
                  value={values[f] ?? ""}
                  onChange={(e) =>
                    setValues({ ...values, [f]: e.target.value })
                  }
                  required
                >
                  <option value="">Choose…</option>
                  {ref.map((r) => {
                    const id = text(r, idFieldFor(f), "");
                    return id ? (
                      <option key={id} value={id}>
                        {labelFor(r)} · {id.slice(0, 8)}
                      </option>
                    ) : null;
                  })}
                </select>
              </label>
            );
          return (
            <label key={f}>
              {f.replaceAll("_", " ")}
              <input
                type={
                  f.includes("date")
                    ? "date"
                    : [
                          "amount_tzs",
                          "credits",
                          "copies",
                          "max_score",
                          "score",
                        ].includes(f)
                      ? "number"
                      : "text"
                }
                value={values[f] ?? ""}
                onChange={(e) => setValues({ ...values, [f]: e.target.value })}
                step={["amount_tzs","credits","max_score","score"].includes(f) ? "0.01" : undefined}
                required={
                  ![
                    "award", "outcome", "reference", "review_query", "evidence_reference", "ethics_reference", "clearance_reference", "permit_reference", "due_date", "follow_up_due", "review_date", "expiry_date",
                    "term_id",
                    "programme_id",
                    "assessment_id",
                    "request_id",
                    "funding_id",
                    "project_id",
                    "case_id",
                  ].includes(f)
                }
              />
            </label>
          );
        })}
        <button className="button-primary" disabled={!canWrite || busy}>
          <Plus size={14} />
          {selected ? "Update" : "Create"} {title}
        </button>
      </form>
      {!canWrite && (
        <p className="muted">
          Your role can view this workflow but cannot change it.
        </p>
      )}
    </Panel>
  );
}
function idField(action: string) {
  return action === "save_term"
    ? "term_id"
    : action === "save_programme"
      ? "programme_id"
      : action === "save_course"
        ? "course_id"
        : action === "save_assessment"
          ? "assessment_id"
          : action === "save_transcript"
            ? "request_id"
            : action === "save_funding"
              ? "funding_id"
              : action === "save_research"
                ? "project_id"
                : action === "save_quality"
                  ? "case_id"
                  : action === "record_receipt"
                    ? "charge_id"
                    : "id";
}
function idFieldFor(f: string) {
  return f.endsWith("_id") ? f : f === "user_id" ? "user_id" : "id";
}
function SelectField({
  label,
  name,
  options,
  required,
}: {
  label: string;
  name: string;
  options: string[][];
  required?: boolean;
}) {
  return (
    <label>
      {label}
      <select name={name} defaultValue="" required={required}>
        <option value="">Choose…</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
function ResourceList({
  title,
  resource,
  data,
  onMore,
  rowAction,
}: {
  title: string;
  resource: Resource;
  data: Record<string, Row[]>;
  onMore: (r: Resource) => void;
  rowAction?: (r: Row) => ReactNode;
}) {
  if (!(resource in data)) return null;
  const list = data[resource] ?? [];
  return (
    <section className="university-panel university-resource">
      <div className="panel-heading">
        <h3>{title}</h3>
        <span>{list.length} loaded</span>
      </div>
      {!list.length ? (
        <Empty text={`No ${title.toLowerCase()} loaded.`} />
      ) : (
        list.map((r, i) => (
          <div
            className="university-row"
            key={`${resource}-${text(r, "id", text(r, `${resource.slice(0, -1)}_id`, String(i)))}`}
          >
            <div>
              <strong>{labelFor(r)}</strong>
              <span>{details(r, resource)}</span>
            </div>
            <div className="row-actions">{rowAction?.(r)}</div>
          </div>
        ))
      )}
      {list.length > 0 && (
        <button
          className="button-secondary load-more"
          onClick={() => onMore(resource)}
        >
          Load more
        </button>
      )}
    </section>
  );
}
function details(r: Row, resource: Resource) {
  const parts = [text(r, "status", "")];
  if (["fees", "receipts", "funding"].includes(resource))
    parts.push(
      `Amount ${text(r, "amount_tzs", text(r, "balance_tzs", "—"))} TZS`,
    );
  if (resource === "scores")
    parts.push(`Score ${text(r, "score")} / ${text(r, "max_score")}`);
  if (["research", "quality"].includes(resource))
    parts.push(
      text(
        r,
        "review_query",
        text(r, "evidence_reference", text(r, "ethics_reference", "")),
      ),
    );
  if (r.due_date) parts.push(dateText(text(r, "due_date")));
  return parts.filter(Boolean).join(" · ");
}
function KeyPanel({
  isAdmin,
  keyConfig,
  privateKey,
  pass,
  pass2,
  setPass,
  setPass2,
  setupKey,
  unlock,
  clear,
}: {
  isAdmin: boolean;
  keyConfig: UniversityKeyConfig;
  privateKey: CryptoKey | null;
  pass: string;
  pass2: string;
  setPass: (v: string) => void;
  setPass2: (v: string) => void;
  setupKey: (e: FormEvent) => void;
  unlock: (e: FormEvent) => void;
  clear: () => void;
}) {
  return (
    <section className="university-key-panel">
      <div>
        <KeyRound size={17} />
        <strong>Private identity key</strong>
        <span>
          {privateKey
            ? "Unlocked in memory"
            : keyConfig.configured
              ? "Locked"
              : "Not configured"}{" "}
          · admin configures once; registrar unlocks
        </span>
      </div>
      {isAdmin && !keyConfig.configured ? (
        <form onSubmit={setupKey}>
          <input
            aria-label="New records passphrase"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="New passphrase (12+ characters)"
          />
          <input
            aria-label="Confirm records passphrase"
            type="password"
            value={pass2}
            onChange={(e) => setPass2(e.target.value)}
            placeholder="Confirm passphrase"
          />
          <button className="button-secondary">Configure</button>
        </form>
      ) : !privateKey ? (
        <form onSubmit={unlock}>
          <input
            aria-label="Records passphrase"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            placeholder="Records passphrase"
          />
          <button className="button-secondary">Unlock</button>
        </form>
      ) : (
        <button className="button-secondary" onClick={clear}>
          Lock now
        </button>
      )}
    </section>
  );
}
function Empty({ text: message }: { text: string }) {
  return <div className="university-empty">{message}</div>;
}
function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="university-panel">
      <h3>{title}</h3>
      {children}
    </section>
  );
}
