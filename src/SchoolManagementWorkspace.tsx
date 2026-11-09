import OfficeSuiteAiAction from './OfficeSuiteAiAction';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import {
  Activity, BookOpenCheck, CalendarDays, Check, CircleAlert, ClipboardCheck,
  CreditCard, FileText, GraduationCap, KeyRound, LockKeyhole, Plus, RefreshCw, ShieldAlert,
  ShieldCheck, Users, WalletCards,
} from 'lucide-react';
import { officeTeamApi } from './lib/officeTeamApi';
import type { OfficeMember, OfficeWorkspace } from './lib/officeTeamApi';
import { officeIndustryTasksApi } from './lib/officeIndustryTasks';
import {
  createSchoolKeyConfig, decryptSchoolNotice, decryptSchoolPrivatePerson,
  encryptSchoolNotice, encryptSchoolPrivatePerson, officeSchoolManagementApi, unlockSchoolKey,
} from './lib/officeSchoolManagement';
import type {
  SchoolPrivatePersonRecord, SchoolRole,
} from './lib/officeSchoolManagement';
import { getOfficeTeamClient, resolveOfficeTeamConfig } from './lib/officeTeamSupabase';
import type { OfficeTeamEnvironment } from './lib/officeTeamSupabase';
import SchoolTimetableWorkspace from './SchoolTimetableWorkspace';
import './industrySuites.css';
import './schoolManagement.css';

const emptyIdentity: SchoolPrivatePersonRecord = {
  legal_name: '', preferred_name: '', date_of_birth: '', guardians: [{ name: '', relationship: 'parent', phone: '', email: '' }],
};
const today = () => new Date().toISOString().slice(0, 10);
type TabId = 'overview' | 'admissions' | 'students' | 'attendance' | 'grades' | 'fees' | 'classes' | 'communications' | 'timetable';
type Row = Record<string, unknown>;
type Term = { term_id: string; academic_year: string; term_label: string; start_date: string; end_date: string; status: string };
type ClassRow = { class_id: string; class_label: string; level_label: string; stream_label: string; capacity: number | null; status: string };
type Subject = { subject_id: string; subject_code: string; subject_label: string; status: string };
type Student = { student_id: string; person_id: string; student_code: string; status: string; class_id: string | null; class_label: string | null; term_id: string | null; academic_year: string | null; term_label: string | null };
type Application = { application_id: string; person_id: string; application_code: string; term_id: string; academic_year: string; term_label: string; requested_class_id: string; class_label: string; status: string; version: number; created_at: string };
type Assessment = { assessment_id: string; class_id: string; class_label: string; subject_id: string; subject_label: string; term_id: string; term_label: string; assessment_type: string; title: string; maximum_score: number; status: string; scores: { student_id: string; student_code: string; score: number; version: number }[] };
type Fee = { charge_id: string; student_id: string; student_code: string; term_id: string; academic_year: string; term_label: string; fee_category: string; amount_tzs: number; paid_tzs: number; due_date: string; receipts: { receipt_id: string; receipt_number: string; amount_tzs: number; payment_method: string; received_at: string }[] };
type Notice = { notice_id: string; term_id: string; class_id: string | null; notice_kind: string; nonce: string; body_ciphertext: string; status: string; created_at: string };
type AttendanceSession = { session_id: string; class_id: string; class_label: string; term_id: string; session_date: string; slot_label: string; status: string; marks: { student_id: string; student_code: string; attendance_status: string }[] };
type StaffRoleRow = { user_id: string; school_role: string; active: boolean };
type ClassStaffRow = { assignment_id: string; class_id: string; subject_id: string | null; user_id: string; assignment_kind: string; active: boolean };
type ScreenStatus = 'loading' | 'signed-out' | 'not-member' | 'setup-required' | 'profile-conflict' | 'ready' | 'error';
type NoticeKey = { configured: boolean; key_version?: number; derivation?: string; iterations?: number; salt?: string; nonce?: string; ciphertext?: string };

const tabDetails: { id: TabId; label: string; icon: typeof BookOpenCheck }[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'admissions', label: 'Admissions', icon: ClipboardCheck },
  { id: 'students', label: 'Students', icon: GraduationCap },
  { id: 'attendance', label: 'Attendance', icon: Check },
  { id: 'grades', label: 'Grades', icon: BookOpenCheck },
  { id: 'fees', label: 'Fees', icon: WalletCards },
  { id: 'classes', label: 'Classes & staff', icon: Users },
  { id: 'communications', label: 'Communications', icon: FileText },
  { id: 'timetable', label: 'Timetable', icon: CalendarDays },
];

function asRows<T>(value: unknown): T[] { return Array.isArray(value) ? value as T[] : []; }
function asRecord(value: unknown): Row { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {}; }
function roleValue(value: unknown): SchoolRole {
  return ['school_admin','registrar','teacher','bursar','viewer','unassigned'].includes(String(value)) ? value as SchoolRole : 'unassigned';
}
function randomKey() {
  if (!globalThis.crypto?.randomUUID) throw new Error('This browser cannot create a secure retry key. Use a current browser.');
  return globalThis.crypto.randomUUID();
}
function memberName(member: OfficeMember | undefined) {
  return member?.display_name?.trim() || (member?.username ? `@${member.username}` : 'Team member');
}
function errorText(error: unknown) {
  const message = error instanceof Error ? error.message : 'The School request could not be completed.';
  if (/office_school_(?:read|command)|PGRST202|could not find the function/i.test(message)) {
    return 'The School Management service is not enabled in this deployment. No School changes were saved.';
  }
  if (/row-level security|permission denied|42501/i.test(message)) return 'Your Office Team membership or School role does not allow that action.';
  return message;
}
function optionsForAdmission(status: string) {
  if (status === 'submitted') return ['reviewing', 'offered', 'waitlisted', 'rejected', 'withdrawn'];
  if (status === 'reviewing') return ['offered', 'waitlisted', 'rejected', 'withdrawn'];
  if (status === 'offered') return ['accepted', 'waitlisted', 'withdrawn'];
  if (status === 'waitlisted') return ['offered', 'rejected', 'withdrawn'];
  return [];
}
function dateText(value: string) {
  if (!value) return '—';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${value.slice(0, 10)}T12:00:00`));
}

export default function SchoolManagementWorkspace({
  workspaceId, officeName, country, accent,
}: { workspaceId: string; officeName: string; country: string; accent: string }) {
  const config = useMemo(() => resolveOfficeTeamConfig(import.meta.env as unknown as OfficeTeamEnvironment), []);
  const client = useMemo(() => getOfficeTeamClient(config), [config]);
  const [status, setStatus] = useState<ScreenStatus>('loading');
  const [workspace, setWorkspace] = useState<OfficeWorkspace | null>(null);
  const [members, setMembers] = useState<OfficeMember[]>([]);
  const [role, setRole] = useState<SchoolRole>('unassigned');
  const [terms, setTerms] = useState<Term[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [staffRoles, setStaffRoles] = useState<StaffRoleRow[]>([]);
  const [classStaff, setClassStaff] = useState<ClassStaffRow[]>([]);
  const [applications, setApplications] = useState<Application[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [attendance, setAttendance] = useState<AttendanceSession[]>([]);
  const [assessments, setAssessments] = useState<Assessment[]>([]);
  const [fees, setFees] = useState<Fee[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [keyConfig, setKeyConfig] = useState<NoticeKey>({ configured: false });
  const [privateKey, setPrivateKey] = useState<CryptoKey | null>(null);
  const [privateKeyState, setPrivateKeyState] = useState<'unavailable' | 'locked' | 'unlocked'>('unavailable');
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [keyPassphraseConfirm, setKeyPassphraseConfirm] = useState('');
  const [identity, setIdentity] = useState<SchoolPrivatePersonRecord>(emptyIdentity);
  const [applicationTermId, setApplicationTermId] = useState('');
  const [applicationClassId, setApplicationClassId] = useState('');
  const [revealedPeople, setRevealedPeople] = useState<Record<string, SchoolPrivatePersonRecord>>({});
  const [revealedNotices, setRevealedNotices] = useState<Record<string, string>>({});
  const [applicationStatusDraft, setApplicationStatusDraft] = useState<Record<string, string>>({});
  const [selectedClassId, setSelectedClassId] = useState('');
  const [selectedTermId, setSelectedTermId] = useState('');
  const [attendanceDate, setAttendanceDate] = useState(today);
  const [attendanceSlot, setAttendanceSlot] = useState('Daily');
  const [attendanceDraft, setAttendanceDraft] = useState<Record<string, string>>({});
  const [assessmentClassId, setAssessmentClassId] = useState('');
  const [assessmentTermId, setAssessmentTermId] = useState('');
  const [assessmentSubjectId, setAssessmentSubjectId] = useState('');
  const [assessmentId, setAssessmentId] = useState('');
  const [scoreDraft, setScoreDraft] = useState<Record<string, string>>({});
  const [feeStudentId, setFeeStudentId] = useState('');
  const [feeTermId, setFeeTermId] = useState('');
  const [receiptChargeId, setReceiptChargeId] = useState('');
  const [receiptAmount, setReceiptAmount] = useState('');
  const [receiptMethod, setReceiptMethod] = useState('cash');
  const [receiptReference, setReceiptReference] = useState('');
  const [noticeTermId, setNoticeTermId] = useState('');
  const [noticeClassId, setNoticeClassId] = useState('');
  const [noticeKind, setNoticeKind] = useState('general');
  const [noticeBody, setNoticeBody] = useState('');
  const [classForm, setClassForm] = useState({ class_label: '', level_label: '', stream_label: '', capacity: '' });
  const [subjectForm, setSubjectForm] = useState({ subject_code: '', subject_label: '' });
  const [termForm, setTermForm] = useState({ academic_year: '', term_label: '', start_date: '', end_date: '' });
  const [roleForm, setRoleForm] = useState({ user_id: '', school_role: 'teacher' });
  const [assignmentForm, setAssignmentForm] = useState({ user_id: '', class_id: '', subject_id: '', assignment_kind: 'class_teacher' });
  const generationRef = useRef(0);
  const lockTimerRef = useRef<number | null>(null);

  const isAdmin = role === 'school_admin';
  const canRegistrar = isAdmin || role === 'registrar';
  const canTeacher = isAdmin || role === 'teacher';
  const canBursar = isAdmin || role === 'bursar';
  const activeMembers = useMemo(() => members.filter((member) => member.status === 'active'), [members]);
  const staffRoleById = useMemo(() => new Map(staffRoles.map((item) => [item.user_id, item])), [staffRoles]);
  const visibleTabs = useMemo(() => tabDetails.filter(({ id }) => {
    if (id === 'overview' || id === 'timetable') return true;
    if (id === 'admissions') return canRegistrar;
    if (id === 'students') return canRegistrar || canTeacher || canBursar;
    if (id === 'attendance' || id === 'grades') return canTeacher;
    if (id === 'fees') return canBursar;
    if (id === 'classes') return isAdmin;
    if (id === 'communications') return canRegistrar || canTeacher;
    return false;
  }), [canBursar, canRegistrar, canTeacher, isAdmin]);
  const selectedTab: TabId = visibleTabs.some((item) => item.id === activeTab) ? activeTab : 'overview';
  const loadedCounts = useMemo(() => [
    { id: 'terms', label: 'Academic terms', value: terms.length, detail: 'Loaded records', icon: CalendarDays, tone: 'cyan' },
    { id: 'classes', label: 'Classes & streams', value: classes.length, detail: 'Loaded records', icon: Users, tone: 'teal' },
    ...(canRegistrar || canTeacher || canBursar ? [{ id: 'students', label: 'Learner records', value: students.length, detail: 'Loaded · max 200', icon: GraduationCap, tone: 'blue' }] : []),
    ...(canRegistrar ? [{ id: 'admissions', label: 'Applications', value: applications.length, detail: 'Loaded · max 200', icon: ClipboardCheck, tone: 'orange' }] : []),
    ...(canTeacher ? [{ id: 'attendance', label: 'Attendance sessions', value: attendance.length, detail: 'Loaded · max 100', icon: Check, tone: 'teal' }, { id: 'grades', label: 'Assessments', value: assessments.length, detail: 'Loaded · max 100', icon: BookOpenCheck, tone: 'violet' }] : []),
    ...(canBursar ? [{ id: 'fees', label: 'Fee charges', value: fees.length, detail: 'Loaded · max 200', icon: WalletCards, tone: 'orange' }] : []),
  ], [applications.length, assessments.length, attendance.length, canBursar, canRegistrar, canTeacher, classes.length, fees.length, students.length, terms.length]);
  const attendanceActivity = useMemo(() => {
    const totals = attendance.reduce((acc, session) => {
      session.marks.forEach((mark) => { acc[mark.attendance_status] = (acc[mark.attendance_status] ?? 0) + 1; });
      return acc;
    }, {} as Record<string, number>);
    const total = Object.values(totals).reduce((sum, value) => sum + value, 0);
    return ['present', 'late', 'absent', 'excused'].map((label) => ({ label, value: totals[label] ?? 0, width: total ? Math.round(((totals[label] ?? 0) / total) * 100) : 0 }));
  }, [attendance]);
  const nextActions = useMemo(() => {
    const actions: { label: string; detail: string; tab: TabId }[] = [];
    const pendingAdmissions = applications.filter((item) => ['submitted', 'reviewing', 'offered', 'waitlisted'].includes(item.status)).length;
    const openAttendance = attendance.filter((item) => item.status === 'open').length;
    const draftAssessments = assessments.filter((item) => item.status === 'draft').length;
    const unpaidCharges = fees.filter((item) => Number(item.amount_tzs) > Number(item.paid_tzs)).length;
    if (pendingAdmissions) actions.push({ label: 'Review admissions queue', detail: `${pendingAdmissions} active application${pendingAdmissions === 1 ? '' : 's'} loaded`, tab: 'admissions' });
    if (openAttendance) actions.push({ label: 'Lock open attendance', detail: `${openAttendance} session${openAttendance === 1 ? '' : 's'} awaiting review`, tab: 'attendance' });
    if (draftAssessments) actions.push({ label: 'Complete grade entry', detail: `${draftAssessments} draft assessment${draftAssessments === 1 ? '' : 's'} loaded`, tab: 'grades' });
    if (unpaidCharges) actions.push({ label: 'Review fee balances', detail: `${unpaidCharges} charge${unpaidCharges === 1 ? '' : 's'} with a balance`, tab: 'fees' });
    return actions.slice(0, 4);
  }, [applications, assessments, attendance, fees]);
  const selectTab = (tab: TabId) => setActiveTab(visibleTabs.some((item) => item.id === tab) ? tab : 'overview');
  const handleTabKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? visibleTabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length;
    const next = visibleTabs[nextIndex];
    selectTab(next.id);
    window.setTimeout(() => document.getElementById(`school-tab-${next.id}`)?.focus(), 0);
  };

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    const current = () => generation === generationRef.current;
    if (config.status !== 'ready' || !config.schemaReady || !client) {
      setStatus('error');
      setFeedback(config.status === 'ready' ? 'Office Team is not enabled in this deployment.' : `Office connection issue: ${config.status}.`);
      return;
    }
    setStatus((old) => old === 'ready' ? old : 'loading');
    try {
      const { data: authData, error: authError } = await client.auth.getUser();
      if (!current()) return;
      if (authError) throw authError;
      if (!authData.user) { setStatus('signed-out'); return; }
      const workspaces = await officeTeamApi.listWorkspaces(client);
      if (!current()) return;
      const selectedWorkspace = workspaces.find((item) => item.workspace_id === workspaceId);
      if (!selectedWorkspace) { setStatus('not-member'); return; }
      const [teamMembers, sharedSpace] = await Promise.all([
        officeTeamApi.listMembers(client, workspaceId),
        officeIndustryTasksApi.getSpace(client, workspaceId),
      ]);
      if (!current()) return;
      setWorkspace(selectedWorkspace);
      setMembers(teamMembers);
      if (!sharedSpace) { setStatus('setup-required'); return; }
      if (sharedSpace.industry_id !== 'school') { setStatus('profile-conflict'); return; }
      const bootstrap = asRecord(await officeSchoolManagementApi.read(client, workspaceId, 'bootstrap'));
      if (!current()) return;
      const nextRole = roleValue(bootstrap.role);
      const nextIsAdmin = nextRole === 'school_admin';
      setRole(nextRole);
      const nextTerms = asRows<Term>(bootstrap.terms);
      const nextClasses = asRows<ClassRow>(bootstrap.classes);
      const nextSubjects = asRows<Subject>(bootstrap.subjects);
      setTerms(nextTerms); setClasses(nextClasses); setSubjects(nextSubjects);
      const requests: Promise<void>[] = [];
      if (nextIsAdmin || nextRole === 'registrar') {
        requests.push((async () => { setApplications(asRows<Application>(await officeSchoolManagementApi.read(client, workspaceId, 'admissions'))); })());
        requests.push((async () => {
          const configRow = asRecord(await officeSchoolManagementApi.read(client, workspaceId, 'key_config')) as NoticeKey;
          setKeyConfig(configRow);
          setPrivateKeyState((old) => old === 'unlocked' && privateKey ? 'unlocked' : configRow.configured ? 'locked' : 'unavailable');
        })());
      } else { setApplications([]); }
      if (nextIsAdmin) {
        requests.push((async () => { setStaffRoles(asRows<StaffRoleRow>(await officeSchoolManagementApi.read(client, workspaceId, 'staff'))); })());
        requests.push((async () => { setClassStaff(asRows<ClassStaffRow>(await officeSchoolManagementApi.read(client, workspaceId, 'class_staff'))); })());
      } else { setStaffRoles([]); setClassStaff([]); }
      if (nextIsAdmin || ['registrar','teacher','bursar'].includes(nextRole)) {
        requests.push((async () => { setStudents(asRows<Student>(await officeSchoolManagementApi.read(client, workspaceId, 'students', {}, 200))); })());
      } else { setStudents([]); }
      if (nextIsAdmin || nextRole === 'teacher' || nextRole === 'registrar') {
        requests.push((async () => { setAttendance(asRows<AttendanceSession>(await officeSchoolManagementApi.read(client, workspaceId, 'attendance', {}, 100))); })());
        requests.push((async () => { setAssessments(asRows<Assessment>(await officeSchoolManagementApi.read(client, workspaceId, 'gradebook', {}, 100))); })());
      } else { setAttendance([]); setAssessments([]); }
      if (nextIsAdmin || nextRole === 'bursar') {
        requests.push((async () => { setFees(asRows<Fee>(await officeSchoolManagementApi.read(client, workspaceId, 'fees', {}, 200))); })());
      } else { setFees([]); }
      if (nextIsAdmin || nextRole === 'registrar' || nextRole === 'teacher') {
        requests.push((async () => { setNotices(asRows<Notice>(await officeSchoolManagementApi.read(client, workspaceId, 'notices', {}, 100))); })());
      } else { setNotices([]); }
      await Promise.all(requests);
      if (!current()) return;
      setStatus('ready');
      setFeedback('');
    } catch (error) {
      if (!current()) return;
      setStatus('error');
      setFeedback(errorText(error));
    }
  }, [client, config, privateKey, workspaceId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => { window.clearTimeout(timer); generationRef.current += 1; };
  }, [refresh]);
  useEffect(() => {
    if (!privateKey) return undefined;
    lockTimerRef.current = window.setTimeout(() => { setPrivateKey(null); setPrivateKeyState('locked'); }, 15 * 60 * 1000);
    const hide = () => { if (document.visibilityState === 'hidden') { setPrivateKey(null); setPrivateKeyState('locked'); } };
    document.addEventListener('visibilitychange', hide);
    return () => { if (lockTimerRef.current) window.clearTimeout(lockTimerRef.current); document.removeEventListener('visibilitychange', hide); };
  }, [privateKey]);

  const runCommand = async (action: string, payload: Record<string, unknown>, success: string) => {
    if (!client || busy) return;
    setBusy(true); setFeedback('');
    try {
      await officeSchoolManagementApi.command(client, workspaceId, action, payload);
      setFeedback(success);
      await refresh();
    } catch (error) { setFeedback(errorText(error)); }
    finally { setBusy(false); }
  };

  const createProfile = async () => {
    if (!client || !workspace || profileBusy) return;
    setProfileBusy(true);
    try {
      await officeIndustryTasksApi.registerSpace(client, {
        workspaceId, industryId: 'school', officeName, country,
      });
      setFeedback('An empty School profile was created. Device-local items were not imported.');
      await refresh();
    } catch (error) { setFeedback(errorText(error)); }
    finally { setProfileBusy(false); }
  };

  const setupKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (keyPassphrase !== keyPassphraseConfirm) { setFeedback('The two passphrases do not match.'); return; }
    setBusy(true);
    try {
      const created = await createSchoolKeyConfig(keyPassphrase);
      await officeSchoolManagementApi.command(client!, workspaceId, 'setup_key', created.payload);
      setFeedback('School private-record encryption is configured on this device. Keep the passphrase safely; it is never stored here.');
      await refresh();
      setPrivateKey(created.key); setPrivateKeyState('unlocked');
      setKeyConfig({ configured: true, key_version: 1, iterations: 600000, ...created.payload });
      setKeyPassphrase(''); setKeyPassphraseConfirm('');
    } catch (error) { setFeedback(errorText(error)); }
    finally { setBusy(false); }
  };

  const unlockKey = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true);
    try {
      const key = await unlockSchoolKey(keyPassphrase, keyConfig);
      setPrivateKey(key); setPrivateKeyState('unlocked'); setKeyPassphrase(''); setFeedback('School private records are unlocked in memory on this device.');
    } catch (error) { setFeedback(errorText(error)); }
    finally { setBusy(false); }
  };

  const revealPerson = async (personId: string) => {
    if (!client || !privateKey) return;
    try {
      const result = asRecord(await officeSchoolManagementApi.read(client, workspaceId, 'private_person', { id: personId })) as Row & { nonce: string; ciphertext: string };
      const details = await decryptSchoolPrivatePerson(privateKey, { nonce: result.nonce, ciphertext: result.ciphertext });
      setRevealedPeople((old) => ({ ...old, [personId]: details }));
    } catch (error) { setFeedback(errorText(error)); }
  };

  const revealNotice = async (notice: Notice) => {
    if (!privateKey) return;
    try {
      const text = await decryptSchoolNotice(privateKey, { nonce: notice.nonce, ciphertext: notice.body_ciphertext });
      setRevealedNotices((old) => ({ ...old, [notice.notice_id]: text }));
    } catch (error) { setFeedback(errorText(error)); }
  };

  const createApplication = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!privateKey) { setFeedback('Unlock School private records before registering an applicant.'); return; }
    if (!applicationTermId || !applicationClassId) { setFeedback('Choose an academic term and requested class.'); return; }
    setBusy(true);
    try {
      const cipher = await encryptSchoolPrivatePerson(privateKey, identity);
      await officeSchoolManagementApi.command(client!, workspaceId, 'create_application', {
        term_id: applicationTermId, class_id: applicationClassId, idempotency_key: randomKey(),
        nonce: cipher.nonce, ciphertext: cipher.ciphertext,
      });
      setIdentity(emptyIdentity); setFeedback('Encrypted applicant record and admission entry saved.'); await refresh();
    } catch (error) { setFeedback(errorText(error)); }
    finally { setBusy(false); }
  };

  const handleIdentityField = (key: keyof Omit<SchoolPrivatePersonRecord, 'guardians'>, value: string) => {
    setIdentity((old) => ({ ...old, [key]: value }));
  };
  const updateGuardian = (index: number, field: keyof SchoolPrivatePersonRecord['guardians'][number], value: string) => {
    setIdentity((old) => ({ ...old, guardians: old.guardians.map((guardian, i) => i === index ? { ...guardian, [field]: value } : guardian) }));
  };

  const changeAdmissionStatus = async (applicationId: string) => {
    await runCommand('set_application_status', { application_id: applicationId, status: applicationStatusDraft[applicationId] }, 'Admission status updated.');
  };
  const enrollApplicant = async (applicationId: string) => await runCommand('enroll_student', { application_id: applicationId }, 'Accepted applicant enrolled as a student.');

  const saveAttendance = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const roster = students.filter((student) => student.class_id === selectedClassId && student.term_id === selectedTermId);
    if (!roster.length) { setFeedback('There are no active enrolled students in this class and term yet.'); return; }
    await runCommand('take_attendance', {
      class_id: selectedClassId, term_id: selectedTermId, session_date: attendanceDate,
      slot_label: attendanceSlot, idempotency_key: randomKey(),
      marks: roster.map((student) => ({ student_id: student.student_id, attendance_status: attendanceDraft[student.student_id] ?? 'present' })),
    }, 'Attendance saved for this class session.');
  };

  const createAssessment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await runCommand('create_assessment', {
      class_id: assessmentClassId, term_id: assessmentTermId, subject_id: assessmentSubjectId,
      assessment_type: String(form.get('assessment_type') ?? 'quiz'), title: String(form.get('title') ?? '').trim(),
      maximum_score: Number(form.get('maximum_score')),
    }, 'Assessment created as a draft.');
    formElement.reset();
  };
  const saveScores = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const chosen = assessments.find((item) => item.assessment_id === assessmentId);
    if (!chosen) { setFeedback('Choose a draft assessment.'); return; }
    const roster = students.filter((student) => student.class_id === chosen.class_id && student.term_id === chosen.term_id);
    const scores = roster.filter((student) => scoreDraft[student.student_id] !== undefined && scoreDraft[student.student_id] !== '')
      .map((student) => ({ student_id: student.student_id, score: Number(scoreDraft[student.student_id]) }));
    if (!scores.length) { setFeedback('Enter at least one score.'); return; }
    await runCommand('save_scores', { assessment_id: assessmentId, scores }, 'Draft scores saved.');
  };

  const createCharge = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement);
    await runCommand('create_fee_charge', {
      student_id: feeStudentId, term_id: feeTermId, fee_category: String(form.get('fee_category') ?? 'tuition'),
      amount_tzs: Number(form.get('amount_tzs')), due_date: String(form.get('due_date') ?? ''), idempotency_key: randomKey(),
    }, 'Fee charge recorded.');
    formElement.reset();
  };
  const recordReceipt = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await runCommand('record_fee_receipt', {
      charge_id: receiptChargeId, amount_tzs: Number(receiptAmount), payment_method: receiptMethod,
      external_reference: receiptReference.trim(), idempotency_key: randomKey(),
    }, 'Manual receipt recorded. No payment was initiated or verified.');
    setReceiptAmount(''); setReceiptReference('');
  };

  const createNotice = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!privateKey) { setFeedback('Unlock School records to create a notice.'); return; }
    setBusy(true);
    try {
      const encrypted = await encryptSchoolNotice(privateKey, noticeBody);
      await officeSchoolManagementApi.command(client!, workspaceId, 'create_notice', {
        term_id: noticeTermId, class_id: noticeClassId || null, notice_kind: noticeKind,
        nonce: encrypted.nonce, ciphertext: encrypted.ciphertext,
      });
      setNoticeBody(''); setFeedback('Encrypted notice saved as a draft. It has not been sent.'); await refresh();
    } catch (error) { setFeedback(errorText(error)); }
    finally { setBusy(false); }
  };

  const keyPanel = (canSet = isAdmin) => <section className="school-sms-key-card glass-card" aria-labelledby="school-key-title">
    <div className="school-sms-panel-heading"><span className="school-sms-icon is-violet"><KeyRound size={17} /></span><div><span className="eyebrow">PRIVATE RECORDS</span><h3 id="school-key-title">Student & guardian encryption</h3></div></div>
    {privateKeyState === 'unlocked' && privateKey
      ? <div className="school-sms-key-ready"><ShieldCheck size={16} /><span>Unlocked in memory on this device. Nothing is saved to browser storage.</span><button type="button" className="button-secondary" onClick={() => { setPrivateKey(null); setPrivateKeyState('locked'); setRevealedPeople({}); setRevealedNotices({}); }}>Lock now</button></div>
      : !keyConfig.configured
        ? canSet
          ? <form className="school-sms-form-grid" onSubmit={setupKey}>
            <p className="school-sms-help school-sms-span">Set a shared School records passphrase (12+ characters). The app sends only a random salt and encrypted verifier; staff must share the passphrase out-of-band. If it is lost, encrypted records cannot be recovered.</p>
            <label>Passphrase<input type="password" minLength={12} autoComplete="new-password" value={keyPassphrase} onChange={(e) => setKeyPassphrase(e.target.value)} required /></label>
            <label>Confirm passphrase<input type="password" minLength={12} autoComplete="new-password" value={keyPassphraseConfirm} onChange={(e) => setKeyPassphraseConfirm(e.target.value)} required /></label>
            <button type="submit" className="button-primary" disabled={busy}><LockKeyhole size={14} />Set passphrase</button>
          </form>
          : <p className="school-sms-help">A School records passphrase has not been configured. Ask the Office Team owner/admin to set it before entering student or guardian details.</p>
        : <form className="school-sms-unlock-form" onSubmit={unlockKey}>
          <p className="school-sms-help">Private records are encrypted with AES-256-GCM before leaving this device. The app never stores the passphrase or derived key.</p>
          <label>School records passphrase<input type="password" autoComplete="current-password" value={keyPassphrase} onChange={(e) => setKeyPassphrase(e.target.value)} required /></label>
          <button type="submit" className="button-primary" disabled={busy}><KeyRound size={14} />Unlock records</button>
        </form>}
  </section>;

  const shell = <div className="industry-shared-workspace school-sms-workspace" style={{ '--industry-accent': accent } as React.CSSProperties}>
    <div className="school-sms-title glass-card"><div className="school-sms-title-mark"><GraduationCap size={22} /></div><div><span className="eyebrow">SCHOOL MANAGEMENT · {country.toUpperCase()}</span><p className="school-sms-office-name">{officeName}</p><p>Admissions, classes, learners and school operations · Shared Office Team</p></div><button type="button" className="button-secondary" onClick={() => void refresh()} disabled={status === 'loading'}><RefreshCw size={14} />Refresh</button></div>
    <div className="school-sms-privacy" role="note"><ShieldAlert size={17} /><div><strong>Student privacy boundary</strong><span>Only operational codes, class, attendance, grades and fee ledger are stored as server data. Student/guardian names, dates of birth, contact details and parent notice text are encrypted in this browser before upload. Do not enter medical, safeguarding, government-ID or address details. No local records are imported.</span></div></div>
    {feedback && <div className="industry-shared-feedback" role={/not saved|could not|denied|not enabled|does not|doesn't|did not|malformed|lost/i.test(feedback) ? 'alert' : 'status'}><CircleAlert size={15} /><span>{feedback}</span><button type="button" aria-label="Dismiss message" onClick={() => setFeedback('')}>×</button></div>}
    {status === 'loading' && <div className="industry-shared-state"><RefreshCw size={16} /><div><strong>Loading School workspace</strong><span>Verifying Office Team membership and School module access.</span></div></div>}
    {status === 'signed-out' && <div className="industry-shared-state is-alert" role="alert"><LockKeyhole size={16} /><div><strong>Sign in to continue</strong><span>School records are available only to an authenticated Office Team member.</span></div></div>}
    {status === 'not-member' && <div className="industry-shared-state is-alert" role="alert"><ShieldAlert size={16} /><div><strong>Not available to this account</strong><span>This School workspace is not linked to your active Office Team memberships.</span></div></div>}
    {status === 'profile-conflict' && <div className="industry-shared-state is-alert" role="alert"><CircleAlert size={16} /><div><strong>Workspace industry mismatch</strong><span>This team already has a different industry profile, so the School module was not opened.</span></div></div>}
    {status === 'error' && <div className="industry-shared-state is-alert" role="alert"><CircleAlert size={16} /><div><strong>School workspace unavailable</strong><span>{feedback || 'Check the Office Team connection and try again.'}</span></div></div>}
    {status === 'setup-required' && <section className="industry-shared-setup glass-card"><span className="industry-shared-setup-icon"><GraduationCap size={18} /></span><div><h2>Connect this team to Schools</h2><p>This creates an empty School profile only. It does not import device-local entries or school data.</p></div>{workspace && ['owner','admin'].includes(workspace.role) ? <button className="button-primary" type="button" disabled={profileBusy} onClick={() => void createProfile()}><Plus size={14} />Create empty School profile</button> : <p>Ask an Office Team owner/admin to create the School profile.</p>}</section>}
    {status === 'ready' && <>
      <div className="office-suite-ai-toolbar"><OfficeSuiteAiAction workspaceId={workspaceId} suiteLabel="Schools" tabLabel={selectedTab.replaceAll("_", " ")} /></div>
      <div className="school-sms-module-tabs" role="tablist" aria-label="School Management modules">{visibleTabs.map(({ id, label, icon: Icon }, index) => <button type="button" role="tab" id={`school-tab-${id}`} aria-controls={`school-panel-${id}`} tabIndex={selectedTab === id ? 0 : -1} aria-selected={selectedTab === id} className={activeTab === id ? 'is-active' : ''} key={id} onClick={() => selectTab(id)} onKeyDown={(event) => handleTabKeyDown(event, index)}><Icon size={14} />{label}</button>)}</div>
      {role === 'unassigned' && <div className="school-sms-unassigned" role="note"><ShieldAlert size={15} />This account is an active Office Team member, but has no School role yet. Ask the Office Team owner/admin to assign Registrar, Teacher, Bursar or Viewer access.</div>}
      {selectedTab === 'overview' && <section id="school-panel-overview" role="tabpanel" className="school-sms-overview-grid">
        <div className="school-sms-overview-intro"><div><span className="eyebrow">SCHOOL OPERATIONS</span><h1>{workspace?.name || officeName}</h1><p>Role-filtered workspace for the records currently loaded from Office Team.</p></div><span className="school-sms-role-badge"><ShieldCheck size={14} />{role.replace('_', ' ')}</span></div>
        <div className="school-sms-stat-grid">{loadedCounts.map(({ id, label, value, detail, icon: Icon, tone }) => <article className="school-sms-stat glass-card" key={id}><span className={`school-sms-icon is-${tone}`}><Icon size={17} /></span><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>)}</div>
        {canTeacher && <section className="school-sms-panel glass-card school-sms-activity"><div className="school-sms-panel-heading"><span className="school-sms-icon is-teal"><Activity size={17} /></span><div><span className="eyebrow">LOADED ATTENDANCE ACTIVITY</span><h3>Marks by status</h3></div><span className="school-sms-badge">{attendance.length} sessions · max 100</span></div>{attendance.length === 0 ? <p className="school-sms-empty">No attendance sessions are loaded yet.</p> : <div className="school-sms-bars">{attendanceActivity.map((item) => <div className="school-sms-bar-row" key={item.label}><span>{item.label}</span><div><i style={{ width: `${item.width}%` }} /></div><strong>{item.value}</strong></div>)}</div>}<p className="school-sms-help">Counts are derived from attendance marks currently loaded for your role; they are not school-wide rates.</p></section>}
        <section className="school-sms-panel glass-card school-sms-next"><div className="school-sms-panel-heading"><span className="school-sms-icon is-orange"><ClipboardCheck size={17} /></span><div><span className="eyebrow">NEXT ACTIONS</span><h3>Keep work moving</h3></div></div>{nextActions.length ? <div className="school-sms-action-queue">{nextActions.map((item) => <button type="button" className="school-sms-queue-item" key={item.label} onClick={() => selectTab(item.tab)}><span><strong>{item.label}</strong><small>{item.detail}</small></span><span aria-hidden="true">→</span></button>)}</div> : <p className="school-sms-empty">No follow-up items from the records currently loaded.</p>}</section>
        <section className="school-sms-panel glass-card school-sms-services"><div className="school-sms-panel-heading"><span className="school-sms-icon is-blue"><FileText size={17} /></span><div><span className="eyebrow">OFFICIAL MANUAL SERVICES</span><h3>Open government portals</h3></div></div><p className="school-sms-help">These links open official services for manual use. COCCE has no data synchronization or verified API connection to them.</p><div className="school-sms-service-links"><a href="https://esmis.moe.go.tz/" target="_blank" rel="noreferrer">ESMIS <small>Manual link · unconnected</small></a><a href="https://sqas.moe.go.tz/" target="_blank" rel="noreferrer">SQAS <small>Manual link · unconnected</small></a><a href="https://www.necta.go.tz/" target="_blank" rel="noreferrer">NECTA <small>Manual link · unconnected</small></a></div></section>
        <section className="school-sms-overview-note glass-card"><div className="school-sms-panel-heading"><span className="school-sms-icon is-violet"><LockKeyhole size={17} /></span><div><span className="eyebrow">PRIVACY BY DEFAULT</span><h3>Operational view only</h3></div></div><p>The overview shows aggregates and internal codes only. Student or guardian names, dates of birth, contact details and decrypted notice text stay out of this dashboard.</p><p>Your shared School workspace starts empty and does not import device-local records automatically.</p></section>
      </section>}

      {selectedTab === 'classes' && <section className="school-sms-panels-grid">
        <form className="school-sms-panel glass-card" onSubmit={(e) => { e.preventDefault(); void runCommand('save_term',termForm,'Academic term saved.'); }}><div className="school-sms-panel-heading"><span className="school-sms-icon is-cyan"><CalendarDays size={17} /></span><div><span className="eyebrow">ACADEMIC CALENDAR</span><h3>Add term</h3></div></div><div className="school-sms-form-grid"><label>Academic year<input value={termForm.academic_year} onChange={(e)=>setTermForm({...termForm,academic_year:e.target.value})} placeholder="2026/2027" required /></label><label>Term name<input value={termForm.term_label} onChange={(e)=>setTermForm({...termForm,term_label:e.target.value})} placeholder="Term 1" required /></label><label>Start date<input type="date" value={termForm.start_date} onChange={(e)=>setTermForm({...termForm,start_date:e.target.value})} required /></label><label>End date<input type="date" value={termForm.end_date} onChange={(e)=>setTermForm({...termForm,end_date:e.target.value})} required /></label><button className="button-primary" type="submit" disabled={busy}><Plus size={14} />Save term</button></div></form>
        <form className="school-sms-panel glass-card" onSubmit={(e)=>{e.preventDefault();void runCommand('save_class',{...classForm,capacity:classForm.capacity||null},'Class or stream saved.');}}><div className="school-sms-panel-heading"><span className="school-sms-icon is-teal"><Users size={17} /></span><div><span className="eyebrow">CLASS REGISTER</span><h3>Add class or stream</h3></div></div><div className="school-sms-form-grid"><label>Class / stream<input value={classForm.class_label} onChange={(e)=>setClassForm({...classForm,class_label:e.target.value})} maxLength={80} required /></label><label>Level<input value={classForm.level_label} onChange={(e)=>setClassForm({...classForm,level_label:e.target.value})} maxLength={40} /></label><label>Stream<input value={classForm.stream_label} onChange={(e)=>setClassForm({...classForm,stream_label:e.target.value})} maxLength={40} /></label><label>Capacity<input type="number" min="1" max="1000" value={classForm.capacity} onChange={(e)=>setClassForm({...classForm,capacity:e.target.value})} /></label><button className="button-primary" type="submit" disabled={busy}><Plus size={14} />Save class</button></div></form>
        <form className="school-sms-panel glass-card" onSubmit={(e)=>{e.preventDefault();void runCommand('save_subject',subjectForm,'Subject saved.');}}><div className="school-sms-panel-heading"><span className="school-sms-icon is-blue"><BookOpenCheck size={17} /></span><div><span className="eyebrow">CURRICULUM</span><h3>Add subject</h3></div></div><div className="school-sms-form-grid"><label>Subject code<input value={subjectForm.subject_code} onChange={(e)=>setSubjectForm({...subjectForm,subject_code:e.target.value})} maxLength={24} required /></label><label>Subject name<input value={subjectForm.subject_label} onChange={(e)=>setSubjectForm({...subjectForm,subject_label:e.target.value})} maxLength={80} required /></label><button className="button-primary" type="submit" disabled={busy}><Plus size={14} />Save subject</button></div></form>
        <form className="school-sms-panel glass-card" onSubmit={(e)=>{e.preventDefault();void runCommand('set_staff_role',roleForm,'School role assigned.');}}><div className="school-sms-panel-heading"><span className="school-sms-icon is-violet"><ShieldCheck size={17} /></span><div><span className="eyebrow">TEAM ACCESS</span><h3>Assign a School role</h3></div></div><div className="school-sms-form-grid"><label>Active Office Team member<select value={roleForm.user_id} onChange={(e)=>setRoleForm({...roleForm,user_id:e.target.value})} required><option value="">Choose member</option>{activeMembers.map((member)=><option key={member.user_id} value={member.user_id}>{memberName(member)}</option>)}</select></label><label>School role<select value={roleForm.school_role} onChange={(e)=>setRoleForm({...roleForm,school_role:e.target.value})}><option value="registrar">Registrar</option><option value="teacher">Teacher</option><option value="bursar">Bursar</option><option value="viewer">Viewer</option></select></label><button className="button-primary" type="submit" disabled={busy}><ShieldCheck size={14} />Assign role</button></div></form>
        <form className="school-sms-panel glass-card" onSubmit={(e)=>{e.preventDefault();void runCommand('assign_class_staff',assignmentForm,'Teacher assignment saved.');}}><div className="school-sms-panel-heading"><span className="school-sms-icon is-orange"><Users size={17} /></span><div><span className="eyebrow">TEACHING ASSIGNMENTS</span><h3>Assign teacher to class</h3></div></div><div className="school-sms-form-grid"><label>Teacher<select value={assignmentForm.user_id} onChange={(e)=>setAssignmentForm({...assignmentForm,user_id:e.target.value})} required><option value="">Choose teacher</option>{activeMembers.filter((m)=>staffRoleById.get(m.user_id)?.school_role==='teacher'&&staffRoleById.get(m.user_id)?.active).map((m)=><option key={m.user_id} value={m.user_id}>{memberName(m)}</option>)}</select></label><label>Class<select value={assignmentForm.class_id} onChange={(e)=>setAssignmentForm({...assignmentForm,class_id:e.target.value})} required><option value="">Choose class</option>{classes.map((c)=><option key={c.class_id} value={c.class_id}>{c.class_label}</option>)}</select></label><label>Assignment<select value={assignmentForm.assignment_kind} onChange={(e)=>setAssignmentForm({...assignmentForm,assignment_kind:e.target.value})}><option value="class_teacher">Class teacher</option><option value="subject_teacher">Subject teacher</option><option value="assistant">Assistant</option></select></label>{assignmentForm.assignment_kind==='subject_teacher'&&<label>Subject<select value={assignmentForm.subject_id} onChange={(e)=>setAssignmentForm({...assignmentForm,subject_id:e.target.value})} required><option value="">Choose subject</option>{subjects.map((s)=><option key={s.subject_id} value={s.subject_id}>{s.subject_label}</option>)}</select></label>}<button className="button-primary" type="submit" disabled={busy}><Plus size={14} />Save assignment</button></div></form>
        <section className="school-sms-panel glass-card school-sms-span-two"><div className="school-sms-panel-heading"><span className="school-sms-icon is-cyan"><Activity size={17} /></span><div><span className="eyebrow">CURRENT SETUP</span><h3>Terms, classes and subjects</h3></div></div><div className="school-sms-compact-lists"><div><strong>Terms</strong>{terms.length?terms.map((t)=><span key={t.term_id}>{t.academic_year} · {t.term_label} · {t.status}</span>):<small>No terms yet.</small>}</div><div><strong>Classes</strong>{classes.length?classes.map((c)=><span key={c.class_id}>{c.class_label}{c.level_label?` · ${c.level_label}`:''}</span>):<small>No classes yet.</small>}</div><div><strong>Subjects</strong>{subjects.length?subjects.map((s)=><span key={s.subject_id}>{s.subject_code} · {s.subject_label}</span>):<small>No subjects yet.</small>}</div><div><strong>School roles</strong>{staffRoles.length?staffRoles.map((r)=><span key={r.user_id}>{memberName(activeMembers.find((m)=>m.user_id===r.user_id))} · {r.active?r.school_role:'inactive'}</span>):<small>No assigned roles yet.</small>}</div><div><strong>Teaching assignments</strong>{classStaff.length?classStaff.map((a)=><span key={a.assignment_id}>{classes.find((c)=>c.class_id===a.class_id)?.class_label??'Class'} · {memberName(activeMembers.find((m)=>m.user_id===a.user_id))}{a.subject_id?` · ${subjects.find((s)=>s.subject_id===a.subject_id)?.subject_label??'Subject'}`:''}</span>):<small>No class assignments yet.</small>}</div></div></section>
      </section>}

      {selectedTab === 'admissions' && <section className="school-sms-panels-grid">
        {keyPanel()}
        <form className="school-sms-panel glass-card" onSubmit={(e)=>void createApplication(e)}><div className="school-sms-panel-heading"><span className="school-sms-icon is-cyan"><ClipboardCheck size={17} /></span><div><span className="eyebrow">ADMISSIONS</span><h3>Register applicant</h3></div></div><p className="school-sms-help">Applicant and guardian details are encrypted in memory before the server call. No health, safeguarding, address or government-ID details are collected here.</p><div className="school-sms-form-grid"><label>Legal name<input value={identity.legal_name} onChange={(e)=>handleIdentityField('legal_name',e.target.value)} maxLength={120} required disabled={!privateKey} /></label><label>Preferred name<input value={identity.preferred_name} onChange={(e)=>handleIdentityField('preferred_name',e.target.value)} maxLength={120} disabled={!privateKey} /></label><label>Date of birth<input type="date" value={identity.date_of_birth} onChange={(e)=>handleIdentityField('date_of_birth',e.target.value)} disabled={!privateKey} /></label><label>Academic term<select value={applicationTermId} onChange={(e)=>setApplicationTermId(e.target.value)} required><option value="">Choose term</option>{terms.filter((t)=>t.status==='open').map((t)=><option key={t.term_id} value={t.term_id}>{t.academic_year} · {t.term_label}</option>)}</select></label><label>Requested class<select value={applicationClassId} onChange={(e)=>setApplicationClassId(e.target.value)} required><option value="">Choose class</option>{classes.map((c)=><option key={c.class_id} value={c.class_id}>{c.class_label}</option>)}</select></label>{identity.guardians.map((g,index)=><fieldset className="school-sms-guardian" key={index}><legend>Parent / guardian</legend><label>Name<input value={g.name} onChange={(e)=>updateGuardian(index,'name',e.target.value)} maxLength={120} required disabled={!privateKey} /></label><label>Relationship<select value={g.relationship} onChange={(e)=>updateGuardian(index,'relationship',e.target.value as SchoolPrivatePersonRecord['guardians'][number]['relationship'])} disabled={!privateKey}><option value="parent">Parent</option><option value="guardian">Guardian</option><option value="other">Other</option></select></label><label>Phone<input value={g.phone} onChange={(e)=>updateGuardian(index,'phone',e.target.value)} maxLength={32} disabled={!privateKey} /></label><label>Email<input type="email" value={g.email} onChange={(e)=>updateGuardian(index,'email',e.target.value)} maxLength={160} disabled={!privateKey} /></label></fieldset>)}<button className="button-primary" type="submit" disabled={busy||!privateKey}><Plus size={14} />Encrypt & save application</button></div></form>
        <section className="school-sms-panel glass-card school-sms-span-two"><div className="school-sms-panel-heading"><span className="school-sms-icon is-blue"><ClipboardCheck size={17} /></span><div><span className="eyebrow">APPLICATION REGISTER</span><h3>Recent applications</h3></div><span className="school-sms-badge">Up to 200</span></div>{applications.length===0?<p className="school-sms-empty">No admission applications yet.</p>:<div className="school-sms-table-wrap"><table className="school-sms-table"><thead><tr><th>Application</th><th>Term / class</th><th>Status</th><th>Private details</th><th>Workflow</th></tr></thead><tbody>{applications.map((app)=><tr key={app.application_id}><td>{app.application_code}</td><td>{app.academic_year} · {app.term_label}<br />{app.class_label}</td><td><span className={`school-sms-status is-${app.status}`}>{app.status}</span></td><td>{revealedPeople[app.person_id]?<span>{revealedPeople[app.person_id].legal_name}{revealedPeople[app.person_id].preferred_name?` (${revealedPeople[app.person_id].preferred_name})`:''}<br /><small>{revealedPeople[app.person_id].guardians.map((g)=>`${g.name} · ${g.phone}`).join('; ')}</small></span>:<button type="button" className="button-secondary" disabled={!privateKey} onClick={()=>void revealPerson(app.person_id)}><LockKeyhole size={13} />Reveal</button>}</td><td>{optionsForAdmission(app.status).length>0?<div className="school-sms-inline-actions"><select aria-label={`Next status for ${app.application_code}`} value={applicationStatusDraft[app.application_id]??optionsForAdmission(app.status)[0]} onChange={(e)=>setApplicationStatusDraft((old)=>({...old,[app.application_id]:e.target.value}))}>{optionsForAdmission(app.status).map((s)=><option key={s} value={s}>{s}</option>)}</select><button className="button-secondary" type="button" disabled={busy} onClick={()=>void changeAdmissionStatus(app.application_id)}>Update</button></div>:app.status==='accepted'?<button className="button-primary" type="button" disabled={busy} onClick={()=>void enrollApplicant(app.application_id)}>Enroll</button>:<span>Closed</span>}</td></tr>)}</tbody></table></div>}</section>
      </section>}

      {selectedTab === 'students' && <section className="school-sms-panel glass-card"><div className="school-sms-panel-heading"><span className="school-sms-icon is-teal"><GraduationCap size={17} /></span><div><span className="eyebrow">STUDENT REGISTER</span><h3>Enrolled learners</h3></div><span className="school-sms-badge">Showing up to 200</span></div>{canRegistrar&&keyPanel()}<p className="school-sms-help">This list contains internal student codes and enrollment details. PII is only revealed after an explicit request while the School records key is unlocked.</p>{students.length===0?<p className="school-sms-empty">No enrolled students yet. Accept and enroll an applicant first.</p>:<div className="school-sms-table-wrap"><table className="school-sms-table"><thead><tr><th>Student code</th><th>Class</th><th>Term</th><th>Private identity</th></tr></thead><tbody>{students.map((student)=><tr key={`${student.student_id}-${student.term_id}`}><td>{student.student_code}</td><td>{student.class_label??'No current class'}</td><td>{student.academic_year?`${student.academic_year} · ${student.term_label}`:'—'}</td><td>{canRegistrar?(revealedPeople[student.person_id]?<span>{revealedPeople[student.person_id].legal_name}<br/><small>{revealedPeople[student.person_id].guardians.map((g)=>`${g.name} · ${g.phone}`).join('; ')}</small></span>:<button type="button" className="button-secondary" disabled={!privateKey} onClick={()=>void revealPerson(student.person_id)}><LockKeyhole size={13}/>Reveal</button>):<span>Restricted to Registrar</span>}</td></tr>)}</tbody></table></div>}</section>}

      {selectedTab === 'attendance' && <section className="school-sms-panels-grid"><section className="school-sms-panel glass-card"><div className="school-sms-panel-heading"><span className="school-sms-icon is-teal"><Check size={17}/></span><div><span className="eyebrow">DAILY ATTENDANCE</span><h3>Take class attendance</h3></div></div><form onSubmit={(e)=>void saveAttendance(e)} className="school-sms-form-grid"><label>Class<select value={selectedClassId} onChange={(e)=>setSelectedClassId(e.target.value)} required><option value="">Choose class</option>{classes.map((c)=><option key={c.class_id} value={c.class_id}>{c.class_label}</option>)}</select></label><label>Term<select value={selectedTermId} onChange={(e)=>setSelectedTermId(e.target.value)} required><option value="">Choose term</option>{terms.map((t)=><option key={t.term_id} value={t.term_id}>{t.academic_year} · {t.term_label}</option>)}</select></label><label>Date<input type="date" value={attendanceDate} onChange={(e)=>setAttendanceDate(e.target.value)} required/></label><label>Session label<input value={attendanceSlot} onChange={(e)=>setAttendanceSlot(e.target.value)} maxLength={32} required/></label><div className="school-sms-roster school-sms-span">{students.filter((s)=>s.class_id===selectedClassId&&s.term_id===selectedTermId).map((student)=><label key={student.student_id}>{student.student_code}<select value={attendanceDraft[student.student_id]??'present'} onChange={(e)=>setAttendanceDraft((old)=>({...old,[student.student_id]:e.target.value}))}><option value="present">Present</option><option value="absent">Absent</option><option value="late">Late</option><option value="excused">Excused</option></select></label>)}</div><button type="submit" className="button-primary" disabled={busy||!selectedClassId||!selectedTermId}><Check size={14}/>Save attendance</button></form></section><section className="school-sms-panel glass-card"><div className="school-sms-panel-heading"><span className="school-sms-icon is-blue"><Activity size={17}/></span><div><span className="eyebrow">RECENT SESSIONS</span><h3>Attendance history</h3></div></div>{attendance.length===0?<p className="school-sms-empty">No attendance sessions saved yet.</p>:attendance.map((s)=><article className="school-sms-record" key={s.session_id}><div><strong>{s.class_label} · {dateText(s.session_date)}</strong><span>{s.slot_label} · {s.marks.length} marks · {s.status}</span></div>{isAdmin&&s.status==='open'&&<button className="button-secondary" type="button" disabled={busy} onClick={()=>void runCommand('lock_attendance',{session_id:s.session_id},'Attendance session locked.')}>Lock</button>}<ul>{s.marks.slice(0,12).map((m)=><li key={m.student_id}>{m.student_code} · {m.attendance_status}</li>)}</ul></article>)}</section></section>}

      {selectedTab === 'grades' && <section className="school-sms-panels-grid"><form className="school-sms-panel glass-card" onSubmit={(e)=>void createAssessment(e)}><div className="school-sms-panel-heading"><span className="school-sms-icon is-blue"><BookOpenCheck size={17}/></span><div><span className="eyebrow">ASSESSMENTS</span><h3>Create gradebook assessment</h3></div></div><div className="school-sms-form-grid"><label>Class<select value={assessmentClassId} onChange={(e)=>setAssessmentClassId(e.target.value)} required><option value="">Choose class</option>{classes.map((c)=><option key={c.class_id} value={c.class_id}>{c.class_label}</option>)}</select></label><label>Subject<select value={assessmentSubjectId} onChange={(e)=>setAssessmentSubjectId(e.target.value)} required><option value="">Choose subject</option>{subjects.map((s)=><option key={s.subject_id} value={s.subject_id}>{s.subject_label}</option>)}</select></label><label>Term<select value={assessmentTermId} onChange={(e)=>setAssessmentTermId(e.target.value)} required><option value="">Choose term</option>{terms.map((t)=><option key={t.term_id} value={t.term_id}>{t.academic_year} · {t.term_label}</option>)}</select></label><label>Assessment type<select name="assessment_type"><option value="quiz">Quiz</option><option value="assignment">Assignment</option><option value="continuous_assessment">Continuous assessment</option><option value="exam">Exam</option><option value="practical">Practical</option><option value="other">Other</option></select></label><label>Title<input name="title" maxLength={100} required /></label><label>Maximum score<input name="maximum_score" type="number" min="0.01" step="0.01" required /></label><button type="submit" className="button-primary" disabled={busy}><Plus size={14}/>Create draft</button></div><p className="school-sms-help">Do not include learner names or personal details in assessment titles.</p></form><section className="school-sms-panel glass-card"><div className="school-sms-panel-heading"><span className="school-sms-icon is-violet"><BookOpenCheck size={17}/></span><div><span className="eyebrow">GRADE ENTRY</span><h3>Scores</h3></div></div><label>Assessment<select value={assessmentId} onChange={(e)=>{setAssessmentId(e.target.value);setScoreDraft({});}}><option value="">Choose assessment</option>{assessments.map((a)=><option key={a.assessment_id} value={a.assessment_id}>{a.class_label} · {a.subject_label} · {a.title} ({a.status})</option>)}</select></label>{(()=>{const selected=assessments.find((a)=>a.assessment_id===assessmentId);if(!selected)return <p className="school-sms-empty">Choose an assessment to enter scores.</p>;const roster=students.filter((s)=>s.class_id===selected.class_id&&s.term_id===selected.term_id);return <><p className="school-sms-help">Maximum score: {selected.maximum_score}. Saved scores are versioned; locking is final in this release.</p><form onSubmit={(e)=>void saveScores(e)}><div className="school-sms-roster">{roster.map((student)=>{const existing=selected.scores.find((s)=>s.student_id===student.student_id);return <label key={student.student_id}>{student.student_code}<input type="number" min="0" max={selected.maximum_score} step="0.01" value={scoreDraft[student.student_id]??(existing?.score??'')} onChange={(e)=>setScoreDraft((old)=>({...old,[student.student_id]:e.target.value}))} disabled={selected.status==='locked'} /></label>;})}</div><div className="school-sms-action-row">{selected.status==='draft'&&<button className="button-primary" type="submit" disabled={busy}><Check size={14}/>Save scores</button>}{isAdmin&&selected.status==='draft'&&<button className="button-secondary" type="button" disabled={busy} onClick={()=>void runCommand('lock_assessment',{assessment_id:selected.assessment_id},'Gradebook locked. Scores can no longer be edited.')}>Lock grades</button>}<span className={`school-sms-status is-${selected.status}`}>{selected.status}</span></div></form></>;})()}</section></section>}

      {selectedTab === 'fees' && <section className="school-sms-panels-grid"><form className="school-sms-panel glass-card" onSubmit={(e)=>void createCharge(e)}><div className="school-sms-panel-heading"><span className="school-sms-icon is-orange"><CreditCard size={17}/></span><div><span className="eyebrow">FEE REGISTER</span><h3>Add fee charge</h3></div></div><div className="school-sms-form-grid"><label>Student<select value={feeStudentId} onChange={(e)=>setFeeStudentId(e.target.value)} required><option value="">Choose student code</option>{students.map((s)=><option key={s.student_id} value={s.student_id}>{s.student_code} · {s.class_label??'No class'}</option>)}</select></label><label>Term<select value={feeTermId} onChange={(e)=>setFeeTermId(e.target.value)} required><option value="">Choose term</option>{terms.map((t)=><option key={t.term_id} value={t.term_id}>{t.academic_year} · {t.term_label}</option>)}</select></label><label>Category<select name="fee_category"><option value="tuition">Tuition</option><option value="examination">Examination</option><option value="transport">Transport</option><option value="meals">Meals</option><option value="boarding">Boarding</option><option value="other">Other</option></select></label><label>Amount (TZS)<input name="amount_tzs" type="number" min="1" step="1" required /></label><label>Due date<input name="due_date" type="date" required /></label><button type="submit" className="button-primary" disabled={busy}><Plus size={14}/>Record charge</button></div><p className="school-sms-help">TZS is used for this release. This is a manual ledger and does not collect or verify payments.</p></form><form className="school-sms-panel glass-card" onSubmit={(e)=>void recordReceipt(e)}><div className="school-sms-panel-heading"><span className="school-sms-icon is-teal"><WalletCards size={17}/></span><div><span className="eyebrow">RECEIPTS</span><h3>Record manual receipt</h3></div></div><div className="school-sms-form-grid"><label>Fee charge<select value={receiptChargeId} onChange={(e)=>setReceiptChargeId(e.target.value)} required><option value="">Choose charge</option>{fees.filter((f)=>Number(f.amount_tzs)>Number(f.paid_tzs)).map((f)=><option key={f.charge_id} value={f.charge_id}>{f.student_code} · {f.fee_category} · balance TZS {Number(f.amount_tzs)-Number(f.paid_tzs)}</option>)}</select></label><label>Amount (TZS)<input type="number" min="1" step="1" value={receiptAmount} onChange={(e)=>setReceiptAmount(e.target.value)} required /></label><label>Method<select value={receiptMethod} onChange={(e)=>setReceiptMethod(e.target.value)}><option value="cash">Cash</option><option value="bank">Bank</option><option value="mobile_money">Mobile money</option><option value="cheque">Cheque</option><option value="other">Other</option></select></label><label>External reference<input value={receiptReference} onChange={(e)=>setReceiptReference(e.target.value)} maxLength={80} /></label><button type="submit" className="button-primary" disabled={busy||!receiptChargeId}><Check size={14}/>Record receipt</button></div><p className="school-sms-help">Receipt entries are append-only in this release. Confirm the physical/bank/mobile-money payment outside COCCE before recording it.</p></form><section className="school-sms-panel glass-card school-sms-span-two"><div className="school-sms-panel-heading"><span className="school-sms-icon is-blue"><WalletCards size={17}/></span><div><span className="eyebrow">BALANCES</span><h3>Charges and receipts</h3></div></div>{fees.length===0?<p className="school-sms-empty">No fee charges recorded yet.</p>:<div className="school-sms-table-wrap"><table className="school-sms-table"><thead><tr><th>Student</th><th>Term</th><th>Category</th><th>Charge (TZS)</th><th>Paid (TZS)</th><th>Balance</th><th>Receipts</th></tr></thead><tbody>{fees.map((fee)=><tr key={fee.charge_id}><td>{fee.student_code}</td><td>{fee.academic_year} · {fee.term_label}</td><td>{fee.fee_category}</td><td>{Number(fee.amount_tzs).toLocaleString()}</td><td>{Number(fee.paid_tzs).toLocaleString()}</td><td>{(Number(fee.amount_tzs)-Number(fee.paid_tzs)).toLocaleString()}</td><td>{fee.receipts.map((r)=><span key={r.receipt_id}>{r.receipt_number} · TZS {Number(r.amount_tzs).toLocaleString()}<br/></span>)}</td></tr>)}</tbody></table></div>}</section></section>}

      {selectedTab === 'communications' && <section className="school-sms-panels-grid">{keyPanel()}<form className="school-sms-panel glass-card" onSubmit={(e)=>void createNotice(e)}><div className="school-sms-panel-heading"><span className="school-sms-icon is-blue"><FileText size={17}/></span><div><span className="eyebrow">PARENT / CLASS COMMUNICATION</span><h3>Create encrypted notice</h3></div></div><p className="school-sms-help">Notice text is encrypted before upload. Use whole-class or whole-school information only; do not include individual learner names, private fee balances or contact details.</p><div className="school-sms-form-grid"><label>Term<select value={noticeTermId} onChange={(e)=>setNoticeTermId(e.target.value)} required><option value="">Choose term</option>{terms.map((t)=><option key={t.term_id} value={t.term_id}>{t.academic_year} · {t.term_label}</option>)}</select></label><label>Audience<select value={noticeClassId} onChange={(e)=>setNoticeClassId(e.target.value)}><option value="">Whole school</option>{classes.map((c)=><option key={c.class_id} value={c.class_id}>{c.class_label}</option>)}</select></label><label>Notice category<select value={noticeKind} onChange={(e)=>setNoticeKind(e.target.value)}><option value="general">General</option><option value="schedule_change">Schedule change</option><option value="exam_notice">Exam notice</option><option value="fees_reminder">Fees reminder</option><option value="meeting">Meeting</option></select></label><label className="school-sms-span">Message<textarea value={noticeBody} onChange={(e)=>setNoticeBody(e.target.value)} maxLength={8000} rows={5} required disabled={!privateKey}/></label><button className="button-primary" type="submit" disabled={busy||!privateKey}><LockKeyhole size={14}/>Encrypt & save draft</button></div></form><section className="school-sms-panel glass-card school-sms-span-two"><div className="school-sms-panel-heading"><span className="school-sms-icon is-violet"><FileText size={17}/></span><div><span className="eyebrow">NOTICE APPROVAL</span><h3>Drafts and approved notices</h3></div></div><p className="school-sms-help">Approval is an internal check only. Notices are not sent by email, SMS or WhatsApp in this release.</p>{notices.length===0?<p className="school-sms-empty">No notices prepared.</p>:notices.map((notice)=><article className="school-sms-record" key={notice.notice_id}><div><strong>{notice.notice_kind.replace('_',' ')}</strong><span>{notice.class_id?classes.find((c)=>c.class_id===notice.class_id)?.class_label??'Class notice':'Whole school'} · {dateText(notice.created_at)} · {notice.status}</span>{revealedNotices[notice.notice_id]&&<p className="school-sms-decrypted-notice">{revealedNotices[notice.notice_id]}</p>}</div><div className="school-sms-inline-actions"><button className="button-secondary" type="button" disabled={!privateKey} onClick={()=>void revealNotice(notice)}><LockKeyhole size={13}/>{revealedNotices[notice.notice_id]?'Reveal again':'Decrypt'}</button>{canRegistrar&&notice.status==='draft'&&<button className="button-primary" type="button" disabled={busy} onClick={()=>void runCommand('approve_notice',{notice_id:notice.notice_id},'Notice approved for manual delivery only; nothing was sent.')}>Approve</button>}</div></article>)}</section></section>}

      {selectedTab === 'timetable' && <SchoolTimetableWorkspace key={`school-sms-timetable-${workspaceId}`} workspaceId={workspaceId} officeName={officeName} country={country} accent={accent} catalog={{ terms, classes, subjects, classStaff }}/>}
    </>}
  </div>;

  return shell;
}
