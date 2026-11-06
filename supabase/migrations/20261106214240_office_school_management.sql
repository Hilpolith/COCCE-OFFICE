-- School Management System (SMS) — integrated Office migration.
-- Version: 20261106214240_office_school_management_20261106
-- This integrated migration supersedes the timetable-only draft. It does not import local data.
-- Sensitive student/guardian identity and parent-notice text are client-encrypted before
-- RPC submission. No encryption key or plaintext identity is stored by the server.
-- No NECTA/MoEST connection, external messaging, payment gateway, document attachment,
-- Bunny upload, statutory-compliance claim, or real-data rollout approval is included.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.office_workspaces') IS NULL
     OR to_regclass('public.office_memberships') IS NULL
     OR to_regclass('public.office_industry_spaces') IS NULL
     OR to_regprocedure('office_private.is_active_member(uuid)') IS NULL
     OR to_regprocedure('office_private.is_admin(uuid)') IS NULL THEN
    RAISE EXCEPTION 'The existing Office Team and shared industry schemas are required';
  END IF;

  IF to_regclass('public.office_school_staff_roles') IS NOT NULL
     OR to_regclass('public.office_school_timetable_entries') IS NOT NULL THEN
    RAISE EXCEPTION 'School SMS objects already exist; inspect before applying';
  END IF;
END;
$preflight$;

CREATE TABLE public.office_school_staff_roles (
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  school_role text NOT NULL CHECK (school_role IN ('registrar', 'teacher', 'bursar', 'viewer')),
  active boolean NOT NULL DEFAULT true,
  assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES public.office_memberships(workspace_id, user_id) ON DELETE CASCADE
);

CREATE TABLE public.office_school_terms (
  term_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  academic_year text NOT NULL CHECK (char_length(btrim(academic_year)) BETWEEN 4 AND 16)
    CHECK (academic_year = btrim(academic_year) AND academic_year !~ '[[:cntrl:]]'),
  term_label text NOT NULL CHECK (char_length(btrim(term_label)) BETWEEN 1 AND 32)
    CHECK (term_label = btrim(term_label) AND term_label !~ '[[:cntrl:]]'),
  start_date date NOT NULL,
  end_date date NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (start_date <= end_date),
  FOREIGN KEY (workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, academic_year, term_label),
  UNIQUE (term_id, workspace_id)
);

CREATE TABLE public.office_school_classes (
  class_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  class_label text NOT NULL CHECK (char_length(btrim(class_label)) BETWEEN 1 AND 80)
    CHECK (class_label = btrim(class_label) AND class_label !~ '[[:cntrl:]]'),
  level_label text NOT NULL DEFAULT '' CHECK (char_length(level_label) <= 40)
    CHECK (level_label = btrim(level_label) AND level_label !~ '[[:cntrl:]]'),
  stream_label text NOT NULL DEFAULT '' CHECK (char_length(stream_label) <= 40)
    CHECK (stream_label = btrim(stream_label) AND stream_label !~ '[[:cntrl:]]'),
  capacity integer CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 1000),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, class_id),
  UNIQUE (workspace_id, class_label)
);

CREATE TABLE public.office_school_subjects (
  subject_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  subject_code text NOT NULL CHECK (char_length(btrim(subject_code)) BETWEEN 1 AND 24)
    CHECK (subject_code = btrim(subject_code) AND subject_code !~ '[[:cntrl:]]'),
  subject_label text NOT NULL CHECK (char_length(btrim(subject_label)) BETWEEN 1 AND 80)
    CHECK (subject_label = btrim(subject_label) AND subject_label !~ '[[:cntrl:]]'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, subject_id),
  UNIQUE (workspace_id, subject_code),
  UNIQUE (workspace_id, subject_label)
);

CREATE TABLE public.office_school_class_staff (
  assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  class_id uuid NOT NULL,
  subject_id uuid,
  user_id uuid NOT NULL,
  assignment_kind text NOT NULL CHECK (assignment_kind IN ('class_teacher', 'subject_teacher', 'assistant')),
  active boolean NOT NULL DEFAULT true,
  assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, class_id) REFERENCES public.office_school_classes(workspace_id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, subject_id) REFERENCES public.office_school_subjects(workspace_id, subject_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, user_id) REFERENCES public.office_memberships(workspace_id, user_id) ON DELETE RESTRICT,
  CHECK ((assignment_kind = 'subject_teacher' AND subject_id IS NOT NULL)
      OR (assignment_kind <> 'subject_teacher' AND subject_id IS NULL)),
  UNIQUE NULLS NOT DISTINCT (workspace_id, class_id, subject_id, user_id, assignment_kind)
);

-- Operational identifiers are random and non-identifying. All direct student/guardian
-- details, including guardian contacts, are encrypted together in private_ciphertext.
CREATE TABLE public.office_school_people (
  person_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  person_code text NOT NULL CHECK (char_length(person_code) BETWEEN 6 AND 24)
    CHECK (person_code !~ '[[:cntrl:]]'),
  lifecycle text NOT NULL CHECK (lifecycle IN ('applicant', 'student')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
  UNIQUE (workspace_id, person_id),
  UNIQUE (workspace_id, person_code)
);

CREATE TABLE public.office_school_key_configs (
  workspace_id uuid PRIMARY KEY REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
  key_version smallint NOT NULL DEFAULT 1 CHECK (key_version = 1),
  derivation text NOT NULL DEFAULT 'PBKDF2-HMAC-SHA-256/AES-256-GCM' CHECK (derivation = 'PBKDF2-HMAC-SHA-256/AES-256-GCM'),
  iterations integer NOT NULL DEFAULT 600000 CHECK (iterations = 600000),
  salt bytea NOT NULL CHECK (octet_length(salt) = 16),
  verifier_nonce bytea NOT NULL CHECK (octet_length(verifier_nonce) = 12),
  verifier_ciphertext bytea NOT NULL CHECK (octet_length(verifier_ciphertext) BETWEEN 16 AND 128),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.office_school_private_people (
  workspace_id uuid NOT NULL,
  person_id uuid NOT NULL,
  schema_version smallint NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext bytea NOT NULL CHECK (octet_length(ciphertext) BETWEEN 17 AND 32768),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, person_id),
  FOREIGN KEY (workspace_id, person_id) REFERENCES public.office_school_people(workspace_id, person_id) ON DELETE RESTRICT
);

CREATE TABLE public.office_school_admissions (
  application_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  person_id uuid NOT NULL,
  application_code text NOT NULL CHECK (char_length(application_code) BETWEEN 8 AND 32),
  term_id uuid NOT NULL,
  requested_class_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'reviewing', 'offered', 'accepted', 'waitlisted', 'rejected', 'withdrawn')),
  idempotency_key uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, person_id) REFERENCES public.office_school_people(workspace_id, person_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, term_id) REFERENCES public.office_school_terms(workspace_id, term_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, requested_class_id) REFERENCES public.office_school_classes(workspace_id, class_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, application_code),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (application_id, workspace_id),
  UNIQUE (workspace_id, person_id)
);

CREATE TABLE public.office_school_students (
  student_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  person_id uuid NOT NULL,
  student_code text NOT NULL CHECK (char_length(student_code) BETWEEN 8 AND 32),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn', 'completed')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  FOREIGN KEY (workspace_id, person_id) REFERENCES public.office_school_people(workspace_id, person_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, student_id),
  UNIQUE (workspace_id, student_code),
  UNIQUE (workspace_id, person_id)
);

CREATE TABLE public.office_school_enrollments (
  enrollment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  student_id uuid NOT NULL,
  class_id uuid NOT NULL,
  term_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'withdrawn')),
  enrolled_at date NOT NULL DEFAULT current_date,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, student_id) REFERENCES public.office_school_students(workspace_id, student_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, class_id) REFERENCES public.office_school_classes(workspace_id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, term_id) REFERENCES public.office_school_terms(workspace_id, term_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, student_id, term_id),
  UNIQUE (enrollment_id, workspace_id)
);

CREATE UNIQUE INDEX office_school_one_active_enrollment_idx
  ON public.office_school_enrollments (workspace_id, student_id) WHERE status = 'active';

CREATE TABLE public.office_school_attendance_sessions (
  session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  class_id uuid NOT NULL,
  term_id uuid NOT NULL,
  session_date date NOT NULL,
  slot_label text NOT NULL DEFAULT 'Daily' CHECK (char_length(btrim(slot_label)) BETWEEN 1 AND 32)
    CHECK (slot_label = btrim(slot_label) AND slot_label !~ '[[:cntrl:]]'),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked')),
  idempotency_key uuid NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, class_id) REFERENCES public.office_school_classes(workspace_id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, term_id) REFERENCES public.office_school_terms(workspace_id, term_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, session_id),
  UNIQUE (workspace_id, class_id, term_id, session_date, slot_label),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE public.office_school_attendance_marks (
  workspace_id uuid NOT NULL,
  session_id uuid NOT NULL,
  student_id uuid NOT NULL,
  attendance_status text NOT NULL CHECK (attendance_status IN ('present', 'absent', 'late', 'excused')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  marked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, session_id, student_id),
  FOREIGN KEY (workspace_id, session_id) REFERENCES public.office_school_attendance_sessions(workspace_id, session_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, student_id) REFERENCES public.office_school_students(workspace_id, student_id) ON DELETE RESTRICT
);

CREATE TABLE public.office_school_assessments (
  assessment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  class_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  term_id uuid NOT NULL,
  assessment_type text NOT NULL CHECK (assessment_type IN ('quiz', 'assignment', 'continuous_assessment', 'exam', 'practical', 'other')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 100)
    CHECK (title = btrim(title) AND title !~ '[[:cntrl:]]'),
  maximum_score numeric(8,2) NOT NULL CHECK (maximum_score > 0 AND maximum_score <= 1000000),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'locked')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, class_id) REFERENCES public.office_school_classes(workspace_id, class_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, subject_id) REFERENCES public.office_school_subjects(workspace_id, subject_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, term_id) REFERENCES public.office_school_terms(workspace_id, term_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, assessment_id)
);

CREATE TABLE public.office_school_assessment_scores (
  workspace_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  score numeric(8,2) NOT NULL CHECK (score >= 0 AND score <= 1000000),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, assessment_id, student_id),
  FOREIGN KEY (workspace_id, assessment_id) REFERENCES public.office_school_assessments(workspace_id, assessment_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, student_id) REFERENCES public.office_school_students(workspace_id, student_id) ON DELETE RESTRICT
);

CREATE TABLE public.office_school_fee_charges (
  charge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  student_id uuid NOT NULL,
  term_id uuid NOT NULL,
  fee_category text NOT NULL CHECK (fee_category IN ('tuition', 'examination', 'transport', 'meals', 'boarding', 'other')),
  amount_tzs bigint NOT NULL CHECK (amount_tzs BETWEEN 1 AND 1000000000000),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'void')),
  idempotency_key uuid NOT NULL,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, student_id) REFERENCES public.office_school_students(workspace_id, student_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, term_id) REFERENCES public.office_school_terms(workspace_id, term_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, charge_id),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE public.office_school_fee_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  charge_id uuid NOT NULL,
  receipt_number text NOT NULL CHECK (char_length(receipt_number) BETWEEN 10 AND 40),
  amount_tzs bigint NOT NULL CHECK (amount_tzs BETWEEN 1 AND 1000000000000),
  payment_method text NOT NULL CHECK (payment_method IN ('cash', 'bank', 'mobile_money', 'cheque', 'other')),
  external_reference text NOT NULL DEFAULT '' CHECK (char_length(external_reference) <= 80)
    CHECK (external_reference = btrim(external_reference) AND external_reference !~ '[[:cntrl:]]'),
  received_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key uuid NOT NULL,
  received_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, charge_id) REFERENCES public.office_school_fee_charges(workspace_id, charge_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, receipt_id),
  UNIQUE (workspace_id, receipt_number),
  UNIQUE (workspace_id, idempotency_key)
);

CREATE TABLE public.office_school_notices (
  notice_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  term_id uuid NOT NULL,
  class_id uuid,
  notice_kind text NOT NULL CHECK (notice_kind IN ('general', 'schedule_change', 'exam_notice', 'fees_reminder', 'meeting')),
  nonce bytea NOT NULL CHECK (octet_length(nonce) = 12),
  body_ciphertext bytea NOT NULL CHECK (octet_length(body_ciphertext) BETWEEN 17 AND 8192),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'cancelled')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, term_id) REFERENCES public.office_school_terms(workspace_id, term_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, class_id) REFERENCES public.office_school_classes(workspace_id, class_id) ON DELETE RESTRICT,
  UNIQUE (workspace_id, notice_id)
);

CREATE TABLE public.office_school_audit_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  module text NOT NULL CHECK (module IN ('setup', 'identity', 'admissions', 'students', 'attendance', 'grades', 'fees', 'communications', 'timetable', 'access')),
  event_kind text NOT NULL CHECK (event_kind IN ('created', 'updated', 'status_changed', 'sensitive_read', 'role_changed', 'receipt_recorded', 'attendance_saved', 'grades_saved')),
  entity_id uuid,
  changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (cardinality(changed_fields) <= 20 AND changed_fields <@ ARRAY[
      'academic_year', 'term_label', 'start_date', 'end_date', 'status', 'class_label', 'level_label',
      'stream_label', 'capacity', 'subject_code', 'subject_label', 'teacher_assignment', 'application_status',
      'student_enrollment', 'attendance_statuses', 'assessment', 'scores', 'fee_charge', 'fee_receipt',
      'notice_status', 'private_ciphertext', 'staff_role', 'key_config'
    ]::text[]),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX office_school_audit_cursor_idx ON public.office_school_audit_events (workspace_id, created_at DESC, event_id DESC);
CREATE INDEX office_school_admissions_status_idx ON public.office_school_admissions (workspace_id, status, created_at DESC);
CREATE INDEX office_school_students_status_idx ON public.office_school_students (workspace_id, status, created_at DESC);
CREATE INDEX office_school_enrollment_roster_idx ON public.office_school_enrollments (workspace_id, class_id, term_id, status, student_id);
CREATE INDEX office_school_attendance_date_idx ON public.office_school_attendance_sessions (workspace_id, class_id, session_date DESC, session_id);
CREATE INDEX office_school_assessment_idx ON public.office_school_assessments (workspace_id, class_id, term_id, created_at DESC);
CREATE INDEX office_school_fee_student_idx ON public.office_school_fee_charges (workspace_id, student_id, term_id, status, due_date);

COMMENT ON TABLE public.office_school_people IS 'Pseudonymous School person index. No names, contact details, addresses, government IDs, health or safeguarding fields.';
COMMENT ON TABLE public.office_school_private_people IS 'Client-encrypted identity payload only; guardian records are nested in the encrypted payload. Server stores nonce/ciphertext, never plaintext or keys.';
COMMENT ON TABLE public.office_school_notices IS 'Client-encrypted draft/approved class or school notice. Approval is for manual delivery only; no email/SMS/WhatsApp integration is provided.';
COMMENT ON TABLE public.office_school_fee_receipts IS 'Append-only manual receipt records; this does not initiate or verify an external payment.';

-- All School tables are private RPC-backed records. RLS is enabled and direct table
-- access is revoked, including from service_role; SECURITY DEFINER RPCs are the data path.
DO $rls$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'office_school_staff_roles', 'office_school_terms', 'office_school_classes',
    'office_school_subjects', 'office_school_class_staff', 'office_school_people',
    'office_school_key_configs', 'office_school_private_people', 'office_school_admissions',
    'office_school_students', 'office_school_enrollments', 'office_school_attendance_sessions',
    'office_school_attendance_marks', 'office_school_assessments', 'office_school_assessment_scores',
    'office_school_fee_charges', 'office_school_fee_receipts', 'office_school_notices',
    'office_school_audit_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role', v_table);
  END LOOP;
END;
$rls$;

CREATE FUNCTION office_private.school_role(p_workspace_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_role text;
BEGIN
  IF p_workspace_id IS NULL OR auth.uid() IS NULL
     OR NOT office_private.is_active_member(p_workspace_id)
     OR NOT EXISTS (SELECT 1 FROM public.office_industry_spaces AS s
       WHERE s.workspace_id = p_workspace_id AND s.industry_id = 'school') THEN
    RAISE EXCEPTION 'Active School Office Team membership is required' USING ERRCODE = '42501';
  END IF;
  IF office_private.is_admin(p_workspace_id) THEN RETURN 'school_admin'; END IF;
  SELECT r.school_role INTO v_role
  FROM public.office_school_staff_roles AS r
  WHERE r.workspace_id = p_workspace_id AND r.user_id = auth.uid() AND r.active;
  RETURN coalesce(v_role, 'unassigned');
END;
$function$;

CREATE FUNCTION office_private.school_require_role(
  p_workspace_id uuid,
  p_allowed_roles text[],
  p_class_id uuid DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE v_role text;
BEGIN
  v_role := office_private.school_role(p_workspace_id);
  IF v_role = 'school_admin' THEN RETURN v_role; END IF;
  IF NOT (v_role = ANY(coalesce(p_allowed_roles, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'This School module is not available to the assigned role' USING ERRCODE = '42501';
  END IF;
  IF p_class_id IS NOT NULL AND v_role = 'teacher' AND NOT EXISTS (
    SELECT 1 FROM public.office_school_class_staff AS a
    WHERE a.workspace_id = p_workspace_id AND a.class_id = p_class_id
      AND a.user_id = auth.uid() AND a.active
  ) THEN
    RAISE EXCEPTION 'The teacher is not assigned to this class' USING ERRCODE = '42501';
  END IF;
  RETURN v_role;
END;
$function$;

CREATE FUNCTION office_private.school_audit(
  p_workspace_id uuid, p_module text, p_event_kind text,
  p_entity_id uuid DEFAULT NULL, p_changed_fields text[] DEFAULT ARRAY[]::text[]
)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = ''
AS $function$
  INSERT INTO public.office_school_audit_events(workspace_id, actor_id, module, event_kind, entity_id, changed_fields)
  VALUES (p_workspace_id, auth.uid(), p_module, p_event_kind, p_entity_id, coalesce(p_changed_fields, ARRAY[]::text[]))
$function$;

REVOKE ALL ON FUNCTION office_private.school_role(uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION office_private.school_require_role(uuid, text[], uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION office_private.school_audit(uuid, text, text, uuid, text[]) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION office_private.school_audit_immutable()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'School audit events are append-only';
END;
$function$;
REVOKE ALL ON FUNCTION office_private.school_audit_immutable() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER office_school_audit_immutable_trg BEFORE UPDATE OR DELETE ON public.office_school_audit_events
  FOR EACH ROW EXECUTE FUNCTION office_private.school_audit_immutable();
CREATE TRIGGER office_school_audit_no_truncate_trg BEFORE TRUNCATE ON public.office_school_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION office_private.school_audit_immutable();

CREATE FUNCTION public.office_school_read(
  p_workspace_id uuid,
  p_resource text,
  p_filter jsonb DEFAULT '{}'::jsonb,
  p_limit integer DEFAULT 100
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role text;
  v_limit integer := coalesce(p_limit, 100);
  v_class_id uuid := nullif(p_filter->>'class_id', '')::uuid;
  v_term_id uuid := nullif(p_filter->>'term_id', '')::uuid;
  v_id uuid := nullif(p_filter->>'id', '')::uuid;
  v_result jsonb;
BEGIN
  v_role := office_private.school_role(p_workspace_id);
  IF v_limit < 1 OR v_limit > 200 THEN
    RAISE EXCEPTION 'Page size must be between 1 and 200' USING ERRCODE = '22023';
  END IF;

  CASE p_resource
    WHEN 'bootstrap' THEN
      v_result := jsonb_build_object(
        'role', v_role,
        'terms', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.start_date DESC), '[]'::jsonb)
          FROM (SELECT term_id, academic_year, term_label, start_date, end_date, status, version
            FROM public.office_school_terms WHERE workspace_id = p_workspace_id ORDER BY start_date DESC LIMIT v_limit) AS x),
        'classes', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.class_label), '[]'::jsonb)
          FROM (SELECT c.class_id, c.class_label, c.level_label, c.stream_label, c.capacity, c.status, c.version
            FROM public.office_school_classes AS c WHERE c.workspace_id = p_workspace_id AND c.status = 'active'
              AND (v_role <> 'teacher' OR EXISTS (SELECT 1 FROM public.office_school_class_staff AS a
                WHERE a.workspace_id = c.workspace_id AND a.class_id = c.class_id AND a.user_id = auth.uid() AND a.active))
            ORDER BY c.class_label LIMIT v_limit) AS x),
        'subjects', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.subject_label), '[]'::jsonb)
          FROM (SELECT subject_id, subject_code, subject_label, status FROM public.office_school_subjects
            WHERE workspace_id = p_workspace_id AND status = 'active' ORDER BY subject_label LIMIT v_limit) AS x),
        'key_configured', EXISTS (SELECT 1 FROM public.office_school_key_configs WHERE workspace_id = p_workspace_id)
      );

    WHEN 'terms' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher','bursar','viewer']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.start_date DESC), '[]'::jsonb) INTO v_result
      FROM (SELECT term_id, academic_year, term_label, start_date, end_date, status, version
        FROM public.office_school_terms WHERE workspace_id = p_workspace_id ORDER BY start_date DESC LIMIT v_limit) AS x;

    WHEN 'classes' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher','bursar','viewer']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.class_label), '[]'::jsonb) INTO v_result
      FROM (SELECT c.class_id, c.class_label, c.level_label, c.stream_label, c.capacity, c.status, c.version
        FROM public.office_school_classes AS c WHERE c.workspace_id = p_workspace_id
          AND (v_role <> 'teacher' OR EXISTS (SELECT 1 FROM public.office_school_class_staff AS a
            WHERE a.workspace_id = c.workspace_id AND a.class_id = c.class_id AND a.user_id = auth.uid() AND a.active))
        ORDER BY c.class_label LIMIT v_limit) AS x;

    WHEN 'subjects' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher','bursar','viewer']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.subject_label), '[]'::jsonb) INTO v_result
      FROM (SELECT subject_id, subject_code, subject_label, status FROM public.office_school_subjects
        WHERE workspace_id = p_workspace_id ORDER BY subject_label LIMIT v_limit) AS x;

    WHEN 'key_config' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar']);
      SELECT jsonb_build_object('configured', true, 'key_version', key_version, 'derivation', derivation,
          'iterations', iterations, 'salt', encode(salt,'base64'), 'nonce', encode(verifier_nonce,'base64'),
          'ciphertext', encode(verifier_ciphertext,'base64'))
        INTO v_result FROM public.office_school_key_configs WHERE workspace_id=p_workspace_id;
      IF v_result IS NULL THEN v_result := jsonb_build_object('configured', false); END IF;

    WHEN 'staff' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY[]::text[]);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.user_id), '[]'::jsonb) INTO v_result
      FROM (SELECT m.user_id, coalesce(r.school_role, 'unassigned') AS school_role, coalesce(r.active, false) AS active
        FROM public.office_memberships AS m
        LEFT JOIN public.office_school_staff_roles AS r ON r.workspace_id = m.workspace_id AND r.user_id = m.user_id
        WHERE m.workspace_id = p_workspace_id AND m.status = 'active'
        ORDER BY m.user_id LIMIT v_limit) AS x;

    WHEN 'class_staff' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher','bursar','viewer']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.class_id, x.user_id), '[]'::jsonb) INTO v_result
      FROM (SELECT assignment_id, class_id, subject_id, user_id, assignment_kind, active
        FROM public.office_school_class_staff WHERE workspace_id = p_workspace_id
          AND (v_role <> 'teacher' OR user_id = auth.uid()) ORDER BY class_id, user_id LIMIT v_limit) AS x;

    WHEN 'admissions' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_result
      FROM (SELECT a.application_id, a.person_id, a.application_code, a.term_id, t.academic_year, t.term_label,
          a.requested_class_id, c.class_label, a.status, a.version, a.created_at
        FROM public.office_school_admissions AS a
        JOIN public.office_school_terms AS t ON t.workspace_id = a.workspace_id AND t.term_id = a.term_id
        JOIN public.office_school_classes AS c ON c.workspace_id = a.workspace_id AND c.class_id = a.requested_class_id
        WHERE a.workspace_id = p_workspace_id ORDER BY a.created_at DESC LIMIT v_limit) AS x;

    WHEN 'students' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher','bursar']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.student_code), '[]'::jsonb) INTO v_result
      FROM (SELECT s.student_id, s.person_id, s.student_code, s.status, e.class_id, c.class_label, e.term_id, t.academic_year, t.term_label
        FROM public.office_school_students AS s
        LEFT JOIN public.office_school_enrollments AS e ON e.workspace_id = s.workspace_id AND e.student_id = s.student_id AND e.status = 'active'
        LEFT JOIN public.office_school_classes AS c ON c.workspace_id = e.workspace_id AND c.class_id = e.class_id
        LEFT JOIN public.office_school_terms AS t ON t.workspace_id = e.workspace_id AND t.term_id = e.term_id
        WHERE s.workspace_id = p_workspace_id AND s.status = 'active'
          AND (v_role <> 'teacher' OR EXISTS (SELECT 1 FROM public.office_school_class_staff AS a
            WHERE a.workspace_id = s.workspace_id AND a.class_id = e.class_id AND a.user_id = auth.uid() AND a.active))
          AND (v_class_id IS NULL OR e.class_id = v_class_id)
          AND (v_term_id IS NULL OR e.term_id = v_term_id)
        ORDER BY s.student_code LIMIT v_limit) AS x;

    WHEN 'private_person' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar']);
      IF v_id IS NULL THEN RAISE EXCEPTION 'A person record is required' USING ERRCODE = '22023'; END IF;
      INSERT INTO public.office_school_audit_events(workspace_id, actor_id, module, event_kind, entity_id, changed_fields)
        VALUES (p_workspace_id, auth.uid(), 'identity', 'sensitive_read', v_id, ARRAY[]::text[]);
      SELECT jsonb_build_object('person_id', pp.person_id, 'schema_version', pp.schema_version,
          'version', pp.version, 'nonce', encode(pp.nonce, 'base64'), 'ciphertext', encode(pp.ciphertext, 'base64'),
          'key_salt', encode(k.salt, 'base64'), 'key_nonce', encode(k.verifier_nonce, 'base64'),
          'key_verifier', encode(k.verifier_ciphertext, 'base64'), 'key_iterations', k.iterations)
        INTO v_result
        FROM public.office_school_private_people AS pp
        JOIN public.office_school_key_configs AS k ON k.workspace_id = pp.workspace_id
        WHERE pp.workspace_id = p_workspace_id AND pp.person_id = v_id;
      IF v_result IS NULL THEN RAISE EXCEPTION 'Encrypted person record is not available' USING ERRCODE = '42501'; END IF;

    WHEN 'attendance' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher'], v_class_id);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.session_date DESC, x.created_at DESC), '[]'::jsonb) INTO v_result
      FROM (SELECT s.session_id, s.class_id, c.class_label, s.term_id, t.academic_year, t.term_label,
          s.session_date, s.slot_label, s.status, s.created_at,
          coalesce((SELECT jsonb_agg(jsonb_build_object('student_id', m.student_id, 'student_code', st.student_code,
              'attendance_status', m.attendance_status, 'version', m.version) ORDER BY st.student_code)
            FROM public.office_school_attendance_marks AS m JOIN public.office_school_students AS st
              ON st.workspace_id = m.workspace_id AND st.student_id = m.student_id
            WHERE m.workspace_id = s.workspace_id AND m.session_id = s.session_id), '[]'::jsonb) AS marks
        FROM public.office_school_attendance_sessions AS s
        JOIN public.office_school_classes AS c ON c.workspace_id = s.workspace_id AND c.class_id = s.class_id
        JOIN public.office_school_terms AS t ON t.workspace_id = s.workspace_id AND t.term_id = s.term_id
        WHERE s.workspace_id = p_workspace_id AND (v_class_id IS NULL OR s.class_id = v_class_id)
          AND (v_term_id IS NULL OR s.term_id = v_term_id)
          AND (v_role <> 'teacher' OR EXISTS (SELECT 1 FROM public.office_school_class_staff AS a
            WHERE a.workspace_id = s.workspace_id AND a.class_id = s.class_id AND a.user_id = auth.uid() AND a.active))
        ORDER BY s.session_date DESC, s.created_at DESC LIMIT v_limit) AS x;
      INSERT INTO public.office_school_audit_events(workspace_id, actor_id, module, event_kind, changed_fields)
        VALUES (p_workspace_id, auth.uid(), 'attendance', 'sensitive_read', ARRAY[]::text[]);

    WHEN 'gradebook' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher'], v_class_id);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_result
      FROM (SELECT a.assessment_id, a.class_id, c.class_label, a.subject_id, s.subject_label,
          a.term_id, t.academic_year, t.term_label, a.assessment_type, a.title,
          a.maximum_score, a.status, a.version, a.created_at,
          coalesce((SELECT jsonb_agg(jsonb_build_object('student_id', g.student_id, 'student_code', st.student_code,
              'score', g.score, 'version', g.version) ORDER BY st.student_code)
            FROM public.office_school_assessment_scores AS g JOIN public.office_school_students AS st
              ON st.workspace_id = g.workspace_id AND st.student_id = g.student_id
            WHERE g.workspace_id = a.workspace_id AND g.assessment_id = a.assessment_id), '[]'::jsonb) AS scores
        FROM public.office_school_assessments AS a
        JOIN public.office_school_classes AS c ON c.workspace_id = a.workspace_id AND c.class_id = a.class_id
        JOIN public.office_school_subjects AS s ON s.workspace_id = a.workspace_id AND s.subject_id = a.subject_id
        JOIN public.office_school_terms AS t ON t.workspace_id = a.workspace_id AND t.term_id = a.term_id
        WHERE a.workspace_id = p_workspace_id AND (v_class_id IS NULL OR a.class_id = v_class_id)
          AND (v_term_id IS NULL OR a.term_id = v_term_id)
          AND (v_role <> 'teacher' OR EXISTS (SELECT 1 FROM public.office_school_class_staff AS a2
            WHERE a2.workspace_id = a.workspace_id AND a2.class_id = a.class_id AND a2.user_id = auth.uid() AND a2.active))
        ORDER BY a.created_at DESC LIMIT v_limit) AS x;
      INSERT INTO public.office_school_audit_events(workspace_id, actor_id, module, event_kind, changed_fields)
        VALUES (p_workspace_id, auth.uid(), 'grades', 'sensitive_read', ARRAY[]::text[]);

    WHEN 'fees' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['bursar']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.due_date, x.created_at DESC), '[]'::jsonb) INTO v_result
      FROM (SELECT ch.charge_id, ch.student_id, st.student_code, ch.term_id, t.academic_year, t.term_label,
          ch.fee_category, ch.amount_tzs, ch.due_date, ch.status, ch.created_at,
          coalesce((SELECT sum(r.amount_tzs) FROM public.office_school_fee_receipts AS r
            WHERE r.workspace_id = ch.workspace_id AND r.charge_id = ch.charge_id), 0) AS paid_tzs,
          coalesce((SELECT jsonb_agg(jsonb_build_object('receipt_id', r.receipt_id, 'receipt_number', r.receipt_number,
            'amount_tzs', r.amount_tzs, 'payment_method', r.payment_method, 'external_reference', r.external_reference,
            'received_at', r.received_at) ORDER BY r.received_at DESC)
            FROM public.office_school_fee_receipts AS r WHERE r.workspace_id = ch.workspace_id AND r.charge_id = ch.charge_id), '[]'::jsonb) AS receipts
        FROM public.office_school_fee_charges AS ch
        JOIN public.office_school_students AS st ON st.workspace_id = ch.workspace_id AND st.student_id = ch.student_id
        JOIN public.office_school_terms AS t ON t.workspace_id = ch.workspace_id AND t.term_id = ch.term_id
        WHERE ch.workspace_id = p_workspace_id AND (v_term_id IS NULL OR ch.term_id = v_term_id)
          AND (v_id IS NULL OR ch.student_id = v_id)
        ORDER BY ch.due_date, ch.created_at DESC LIMIT v_limit) AS x;
      INSERT INTO public.office_school_audit_events(workspace_id, actor_id, module, event_kind, changed_fields)
        VALUES (p_workspace_id, auth.uid(), 'fees', 'sensitive_read', ARRAY[]::text[]);

    WHEN 'notices' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_result
      FROM (SELECT notice_id, term_id, class_id, notice_kind, encode(nonce, 'base64') AS nonce,
          encode(body_ciphertext, 'base64') AS body_ciphertext, status, created_by, approved_by, created_at
        FROM public.office_school_notices WHERE workspace_id = p_workspace_id
          AND (v_class_id IS NULL OR class_id = v_class_id OR class_id IS NULL)
        ORDER BY created_at DESC LIMIT v_limit) AS x;

    WHEN 'audit' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY[]::text[]);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC, x.event_id DESC), '[]'::jsonb) INTO v_result
      FROM (SELECT event_id, actor_id, module, event_kind, entity_id, changed_fields, created_at
        FROM public.office_school_audit_events WHERE workspace_id = p_workspace_id
        ORDER BY created_at DESC, event_id DESC LIMIT v_limit) AS x;

    ELSE
      RAISE EXCEPTION 'Unknown School data resource' USING ERRCODE = '22023';
  END CASE;

  RETURN coalesce(v_result, '[]'::jsonb);
END;
$function$;

CREATE FUNCTION public.office_school_command(
  p_workspace_id uuid,
  p_action text,
  p_payload jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role text;
  v_id uuid;
  v_person_id uuid;
  v_class_id uuid;
  v_subject_id uuid;
  v_term_id uuid;
  v_student_id uuid;
  v_application public.office_school_admissions%ROWTYPE;
  v_assessment public.office_school_assessments%ROWTYPE;
  v_session public.office_school_attendance_sessions%ROWTYPE;
  v_charge public.office_school_fee_charges%ROWTYPE;
  v_status text;
  v_code text;
  v_nonce bytea;
  v_cipher bytea;
  v_amount bigint;
  v_total_paid bigint;
  v_rows integer := 0;
  v_item jsonb;
  v_now timestamptz := now();
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'A School command object is required' USING ERRCODE = '22023';
  END IF;
  v_role := office_private.school_role(p_workspace_id);

  CASE p_action
    WHEN 'setup_key' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY[]::text[]);
      IF NOT office_private.is_admin(p_workspace_id) THEN
        RAISE EXCEPTION 'Only the Office Team owner/admin can set the School records passphrase' USING ERRCODE = '42501';
      END IF;
      INSERT INTO public.office_school_key_configs(workspace_id, salt, verifier_nonce, verifier_ciphertext, created_by)
      VALUES (p_workspace_id,
        decode(p_payload->>'salt', 'base64'), decode(p_payload->>'nonce', 'base64'),
        decode(p_payload->>'ciphertext', 'base64'), auth.uid());
      PERFORM office_private.school_audit(p_workspace_id, 'setup', 'created', NULL, ARRAY['key_config']);
      RETURN jsonb_build_object('configured', true, 'key_version', 1);

    WHEN 'set_staff_role' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY[]::text[]);
      IF NOT office_private.is_admin(p_workspace_id) THEN RAISE EXCEPTION 'Only an Office Team owner/admin can assign School roles' USING ERRCODE = '42501'; END IF;
      v_person_id := nullif(p_payload->>'user_id', '')::uuid;
      v_status := p_payload->>'school_role';
      IF v_person_id IS NULL OR v_status NOT IN ('registrar','teacher','bursar','viewer') OR NOT EXISTS (
        SELECT 1 FROM public.office_memberships AS m WHERE m.workspace_id = p_workspace_id AND m.user_id = v_person_id AND m.status = 'active'
      ) THEN RAISE EXCEPTION 'Choose an active Office Team member and a supported School role' USING ERRCODE = '22023'; END IF;
      INSERT INTO public.office_school_staff_roles(workspace_id,user_id,school_role,active,assigned_by,assigned_at,updated_at)
      VALUES (p_workspace_id,v_person_id,v_status,true,auth.uid(),v_now,v_now)
      ON CONFLICT (workspace_id,user_id) DO UPDATE SET school_role=excluded.school_role,active=true,assigned_by=auth.uid(),assigned_at=v_now,updated_at=v_now;
      PERFORM office_private.school_audit(p_workspace_id,'access','role_changed',v_person_id,ARRAY['staff_role']);
      RETURN jsonb_build_object('user_id',v_person_id,'school_role',v_status,'active',true);

    WHEN 'save_term' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY[]::text[]);
      IF NOT office_private.is_admin(p_workspace_id) THEN RAISE EXCEPTION 'Only an Office Team owner/admin can manage School terms' USING ERRCODE = '42501'; END IF;
      v_id := nullif(p_payload->>'term_id','')::uuid;
      IF nullif(btrim(p_payload->>'academic_year'),'') IS NULL OR nullif(btrim(p_payload->>'term_label'),'') IS NULL
         OR (p_payload->>'start_date')::date > (p_payload->>'end_date')::date THEN RAISE EXCEPTION 'Enter a valid academic year, term and date range' USING ERRCODE = '22023'; END IF;
      IF v_id IS NULL THEN
        INSERT INTO public.office_school_terms(workspace_id,academic_year,term_label,start_date,end_date,created_by)
        VALUES(p_workspace_id,btrim(p_payload->>'academic_year'),btrim(p_payload->>'term_label'),(p_payload->>'start_date')::date,(p_payload->>'end_date')::date,auth.uid())
        RETURNING term_id INTO v_id;
        PERFORM office_private.school_audit(p_workspace_id,'setup','created',v_id,ARRAY['academic_year','term_label','start_date','end_date']);
      ELSE
        UPDATE public.office_school_terms SET academic_year=btrim(p_payload->>'academic_year'),term_label=btrim(p_payload->>'term_label'),
          start_date=(p_payload->>'start_date')::date,end_date=(p_payload->>'end_date')::date,
          status=coalesce(nullif(p_payload->>'status',''),'open'),version=version+1,updated_at=v_now
        WHERE workspace_id=p_workspace_id AND term_id=v_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Term is not available in this School' USING ERRCODE = '42501'; END IF;
        PERFORM office_private.school_audit(p_workspace_id,'setup','updated',v_id,ARRAY['academic_year','term_label','start_date','end_date','status']);
      END IF;
      RETURN jsonb_build_object('term_id',v_id);

    WHEN 'save_class' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY[]::text[]);
      IF NOT office_private.is_admin(p_workspace_id) THEN RAISE EXCEPTION 'Only an Office Team owner/admin can manage classes' USING ERRCODE = '42501'; END IF;
      v_id := nullif(p_payload->>'class_id','')::uuid;
      IF nullif(btrim(p_payload->>'class_label'),'') IS NULL THEN RAISE EXCEPTION 'A class or stream name is required' USING ERRCODE = '22023'; END IF;
      IF v_id IS NULL THEN
        INSERT INTO public.office_school_classes(workspace_id,class_label,level_label,stream_label,capacity,created_by)
        VALUES(p_workspace_id,btrim(p_payload->>'class_label'),btrim(coalesce(p_payload->>'level_label','')),btrim(coalesce(p_payload->>'stream_label','')),
          nullif(p_payload->>'capacity','')::integer,auth.uid()) RETURNING class_id INTO v_id;
        PERFORM office_private.school_audit(p_workspace_id,'setup','created',v_id,ARRAY['class_label','level_label','stream_label','capacity']);
      ELSE
        UPDATE public.office_school_classes SET class_label=btrim(p_payload->>'class_label'),level_label=btrim(coalesce(p_payload->>'level_label','')),
          stream_label=btrim(coalesce(p_payload->>'stream_label','')),capacity=nullif(p_payload->>'capacity','')::integer,
          status=coalesce(nullif(p_payload->>'status',''),'active'),version=version+1,updated_at=v_now
        WHERE workspace_id=p_workspace_id AND class_id=v_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Class is not available in this School' USING ERRCODE = '42501'; END IF;
        PERFORM office_private.school_audit(p_workspace_id,'setup','updated',v_id,ARRAY['class_label','level_label','stream_label','capacity','status']);
      END IF;
      RETURN jsonb_build_object('class_id',v_id);

    WHEN 'save_subject' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY[]::text[]);
      IF NOT office_private.is_admin(p_workspace_id) THEN RAISE EXCEPTION 'Only an Office Team owner/admin can manage subjects' USING ERRCODE = '42501'; END IF;
      v_id := nullif(p_payload->>'subject_id','')::uuid;
      IF nullif(btrim(p_payload->>'subject_code'),'') IS NULL OR nullif(btrim(p_payload->>'subject_label'),'') IS NULL THEN RAISE EXCEPTION 'A subject code and name are required' USING ERRCODE = '22023'; END IF;
      IF v_id IS NULL THEN
        INSERT INTO public.office_school_subjects(workspace_id,subject_code,subject_label,created_by)
        VALUES(p_workspace_id,btrim(p_payload->>'subject_code'),btrim(p_payload->>'subject_label'),auth.uid()) RETURNING subject_id INTO v_id;
        PERFORM office_private.school_audit(p_workspace_id,'setup','created',v_id,ARRAY['subject_code','subject_label']);
      ELSE
        UPDATE public.office_school_subjects SET subject_code=btrim(p_payload->>'subject_code'),subject_label=btrim(p_payload->>'subject_label'),
          status=coalesce(nullif(p_payload->>'status',''),'active'),updated_at=v_now
        WHERE workspace_id=p_workspace_id AND subject_id=v_id;
        IF NOT FOUND THEN RAISE EXCEPTION 'Subject is not available in this School' USING ERRCODE = '42501'; END IF;
        PERFORM office_private.school_audit(p_workspace_id,'setup','updated',v_id,ARRAY['subject_code','subject_label','status']);
      END IF;
      RETURN jsonb_build_object('subject_id',v_id);

    WHEN 'assign_class_staff' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY[]::text[]);
      IF NOT office_private.is_admin(p_workspace_id) THEN RAISE EXCEPTION 'Only an Office Team owner/admin can assign teachers' USING ERRCODE = '42501'; END IF;
      v_class_id := nullif(p_payload->>'class_id','')::uuid;
      v_subject_id := nullif(p_payload->>'subject_id','')::uuid;
      v_person_id := nullif(p_payload->>'user_id','')::uuid;
      v_status := p_payload->>'assignment_kind';
      IF v_class_id IS NULL OR v_person_id IS NULL OR v_status NOT IN ('class_teacher','subject_teacher','assistant') OR NOT EXISTS (
        SELECT 1 FROM public.office_school_staff_roles AS r JOIN public.office_memberships AS m ON m.workspace_id=r.workspace_id AND m.user_id=r.user_id
        WHERE r.workspace_id=p_workspace_id AND r.user_id=v_person_id AND r.active AND r.school_role='teacher' AND m.status='active'
      ) THEN RAISE EXCEPTION 'Choose an active School teacher and a valid class assignment' USING ERRCODE = '22023'; END IF;
      INSERT INTO public.office_school_class_staff(workspace_id,class_id,subject_id,user_id,assignment_kind,active,assigned_by)
      VALUES(p_workspace_id,v_class_id,v_subject_id,v_person_id,v_status,true,auth.uid())
      ON CONFLICT (workspace_id,class_id,subject_id,user_id,assignment_kind) DO UPDATE SET active=true,assigned_by=auth.uid();
      v_id := (SELECT assignment_id FROM public.office_school_class_staff WHERE workspace_id=p_workspace_id AND class_id=v_class_id AND subject_id IS NOT DISTINCT FROM v_subject_id AND user_id=v_person_id AND assignment_kind=v_status);
      PERFORM office_private.school_audit(p_workspace_id,'access','updated',v_id,ARRAY['teacher_assignment']);
      RETURN jsonb_build_object('assignment_id',v_id);

    WHEN 'create_application' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar']);
      IF NOT EXISTS (SELECT 1 FROM public.office_school_key_configs WHERE workspace_id=p_workspace_id) THEN RAISE EXCEPTION 'Set up the School records passphrase before adding personal data' USING ERRCODE = '55000'; END IF;
      v_term_id := nullif(p_payload->>'term_id','')::uuid;
      v_class_id := nullif(p_payload->>'class_id','')::uuid;
      IF nullif(p_payload->>'idempotency_key','') IS NULL OR octet_length(decode(p_payload->>'nonce','base64')) <> 12
        OR octet_length(decode(p_payload->>'ciphertext','base64')) NOT BETWEEN 17 AND 32768 THEN
        RAISE EXCEPTION 'An encrypted identity payload and retry key are required' USING ERRCODE = '22023';
      END IF;
      IF EXISTS (SELECT 1 FROM public.office_school_admissions WHERE workspace_id=p_workspace_id AND idempotency_key=(p_payload->>'idempotency_key')::uuid) THEN
        SELECT application_id, person_id, application_code INTO v_id, v_person_id, v_code FROM public.office_school_admissions
          WHERE workspace_id=p_workspace_id AND idempotency_key=(p_payload->>'idempotency_key')::uuid;
        RETURN jsonb_build_object('application_id',v_id,'person_id',v_person_id,'application_code',v_code,'replayed',true);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM public.office_school_terms WHERE workspace_id=p_workspace_id AND term_id=v_term_id AND status='open')
         OR NOT EXISTS (SELECT 1 FROM public.office_school_classes WHERE workspace_id=p_workspace_id AND class_id=v_class_id AND status='active') THEN
        RAISE EXCEPTION 'Choose an open term and an active class in this School' USING ERRCODE = '22023';
      END IF;
      v_person_id := gen_random_uuid();
      v_code := 'APP-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
      INSERT INTO public.office_school_people(person_id,workspace_id,person_code,lifecycle,created_by)
        VALUES(v_person_id,p_workspace_id,v_code,'applicant',auth.uid());
      INSERT INTO public.office_school_private_people(workspace_id,person_id,nonce,ciphertext,updated_by)
        VALUES(p_workspace_id,v_person_id,decode(p_payload->>'nonce','base64'),decode(p_payload->>'ciphertext','base64'),auth.uid());
      v_code := 'ADM-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10));
      INSERT INTO public.office_school_admissions(workspace_id,person_id,application_code,term_id,requested_class_id,idempotency_key,created_by)
        VALUES(p_workspace_id,v_person_id,v_code,v_term_id,v_class_id,(p_payload->>'idempotency_key')::uuid,auth.uid())
        RETURNING application_id INTO v_id;
      PERFORM office_private.school_audit(p_workspace_id,'admissions','created',v_id,ARRAY['application_status','private_ciphertext']);
      RETURN jsonb_build_object('application_id',v_id,'person_id',v_person_id,'application_code',v_code,'replayed',false);

    WHEN 'save_private_person' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar']);
      v_person_id := nullif(p_payload->>'person_id','')::uuid;
      IF v_person_id IS NULL OR octet_length(decode(p_payload->>'nonce','base64')) <> 12
        OR octet_length(decode(p_payload->>'ciphertext','base64')) NOT BETWEEN 17 AND 32768 THEN RAISE EXCEPTION 'A valid encrypted identity payload is required' USING ERRCODE = '22023'; END IF;
      UPDATE public.office_school_private_people SET nonce=decode(p_payload->>'nonce','base64'),ciphertext=decode(p_payload->>'ciphertext','base64'),
        version=version+1,updated_by=auth.uid(),updated_at=v_now WHERE workspace_id=p_workspace_id AND person_id=v_person_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'Encrypted identity record is not available' USING ERRCODE = '42501'; END IF;
      PERFORM office_private.school_audit(p_workspace_id,'identity','updated',v_person_id,ARRAY['private_ciphertext']);
      RETURN jsonb_build_object('person_id',v_person_id,'saved',true);

    WHEN 'set_application_status' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar']);
      v_id := nullif(p_payload->>'application_id','')::uuid;
      v_status := p_payload->>'status';
      SELECT * INTO v_application FROM public.office_school_admissions WHERE workspace_id=p_workspace_id AND application_id=v_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Admission record is not available' USING ERRCODE = '42501'; END IF;
      IF v_status NOT IN ('reviewing','offered','accepted','waitlisted','rejected','withdrawn') OR v_application.status IN ('accepted','rejected','withdrawn') THEN
        RAISE EXCEPTION 'This admission status transition is not allowed' USING ERRCODE = '22023';
      END IF;
      IF NOT ((v_application.status='submitted' AND v_status IN ('reviewing','offered','waitlisted','rejected','withdrawn'))
        OR (v_application.status='reviewing' AND v_status IN ('offered','waitlisted','rejected','withdrawn'))
        OR (v_application.status='offered' AND v_status IN ('accepted','waitlisted','withdrawn'))
        OR (v_application.status='waitlisted' AND v_status IN ('offered','rejected','withdrawn'))) THEN
        RAISE EXCEPTION 'This admission status transition is not allowed' USING ERRCODE = '22023';
      END IF;
      UPDATE public.office_school_admissions SET status=v_status,version=version+1,updated_at=v_now WHERE application_id=v_id AND workspace_id=p_workspace_id;
      PERFORM office_private.school_audit(p_workspace_id,'admissions','status_changed',v_id,ARRAY['application_status']);
      RETURN jsonb_build_object('application_id',v_id,'status',v_status);

    WHEN 'enroll_student' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar']);
      v_id := nullif(p_payload->>'application_id','')::uuid;
      SELECT * INTO v_application FROM public.office_school_admissions WHERE workspace_id=p_workspace_id AND application_id=v_id FOR UPDATE;
      IF NOT FOUND OR v_application.status <> 'accepted' THEN RAISE EXCEPTION 'Only an accepted application can be enrolled' USING ERRCODE = '22023'; END IF;
      IF EXISTS (SELECT 1 FROM public.office_school_students WHERE workspace_id=p_workspace_id AND person_id=v_application.person_id) THEN
        SELECT student_id INTO v_student_id FROM public.office_school_students WHERE workspace_id=p_workspace_id AND person_id=v_application.person_id;
        RETURN jsonb_build_object('student_id',v_student_id,'already_enrolled',true);
      END IF;
      INSERT INTO public.office_school_students(workspace_id,person_id,student_code,created_by)
        VALUES(p_workspace_id,v_application.person_id,'STU-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,10)),auth.uid())
        RETURNING student_id INTO v_student_id;
      UPDATE public.office_school_people SET lifecycle='student' WHERE workspace_id=p_workspace_id AND person_id=v_application.person_id;
      INSERT INTO public.office_school_enrollments(workspace_id,student_id,class_id,term_id,created_by)
        VALUES(p_workspace_id,v_student_id,v_application.requested_class_id,v_application.term_id,auth.uid());
      PERFORM office_private.school_audit(p_workspace_id,'students','created',v_student_id,ARRAY['student_enrollment']);
      RETURN jsonb_build_object('student_id',v_student_id,'student_code',(SELECT student_code FROM public.office_school_students WHERE student_id=v_student_id));

    WHEN 'take_attendance' THEN
      v_class_id := nullif(p_payload->>'class_id','')::uuid;
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['teacher'], v_class_id);
      IF v_class_id IS NULL OR jsonb_typeof(p_payload->'marks') <> 'array' OR jsonb_array_length(p_payload->'marks') > 200
        OR nullif(p_payload->>'idempotency_key','') IS NULL THEN RAISE EXCEPTION 'Choose a class and a bounded attendance roster' USING ERRCODE = '22023'; END IF;
      v_term_id := nullif(p_payload->>'term_id','')::uuid;
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || v_class_id::text || ':' || (p_payload->>'session_date'),0));
      INSERT INTO public.office_school_attendance_sessions(workspace_id,class_id,term_id,session_date,slot_label,idempotency_key,created_by)
      VALUES(p_workspace_id,v_class_id,v_term_id,(p_payload->>'session_date')::date,coalesce(nullif(btrim(p_payload->>'slot_label'),''),'Daily'),
        (p_payload->>'idempotency_key')::uuid,auth.uid())
      ON CONFLICT (workspace_id,class_id,term_id,session_date,slot_label) DO UPDATE SET session_id=public.office_school_attendance_sessions.session_id
      RETURNING * INTO v_session;
      IF v_session.status='locked' THEN RAISE EXCEPTION 'This attendance session is locked' USING ERRCODE = '55000'; END IF;
      FOR v_item IN SELECT value FROM jsonb_array_elements(p_payload->'marks') LOOP
        v_student_id := nullif(v_item->>'student_id','')::uuid;
        v_status := v_item->>'attendance_status';
        IF v_status NOT IN ('present','absent','late','excused') OR NOT EXISTS (
          SELECT 1 FROM public.office_school_enrollments AS e WHERE e.workspace_id=p_workspace_id AND e.student_id=v_student_id
            AND e.class_id=v_class_id AND e.term_id=v_term_id AND e.status='active'
        ) THEN RAISE EXCEPTION 'Attendance includes an invalid status or student outside this class roster' USING ERRCODE = '22023'; END IF;
        INSERT INTO public.office_school_attendance_marks(workspace_id,session_id,student_id,attendance_status,marked_by)
        VALUES(p_workspace_id,v_session.session_id,v_student_id,v_status,auth.uid())
        ON CONFLICT (workspace_id,session_id,student_id) DO UPDATE SET attendance_status=excluded.attendance_status,
          version=public.office_school_attendance_marks.version+1,marked_by=auth.uid(),marked_at=v_now;
        v_rows := v_rows + 1;
      END LOOP;
      PERFORM office_private.school_audit(p_workspace_id,'attendance','attendance_saved',v_session.session_id,ARRAY['attendance_statuses']);
      RETURN jsonb_build_object('session_id',v_session.session_id,'saved_marks',v_rows);

    WHEN 'lock_attendance' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY[]::text[]);
      IF NOT office_private.is_admin(p_workspace_id) THEN RAISE EXCEPTION 'Only an Office Team owner/admin can lock attendance' USING ERRCODE = '42501'; END IF;
      v_id := nullif(p_payload->>'session_id','')::uuid;
      UPDATE public.office_school_attendance_sessions SET status='locked'
        WHERE workspace_id=p_workspace_id AND session_id=v_id AND status='open';
      IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM public.office_school_attendance_sessions WHERE workspace_id=p_workspace_id AND session_id=v_id AND status='locked') THEN
        RAISE EXCEPTION 'Attendance session is not available' USING ERRCODE = '42501';
      END IF;
      PERFORM office_private.school_audit(p_workspace_id,'attendance','status_changed',v_id,ARRAY['status']);
      RETURN jsonb_build_object('session_id',v_id,'status','locked');

    WHEN 'create_assessment' THEN
      v_class_id := nullif(p_payload->>'class_id','')::uuid;
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['teacher'], v_class_id);
      v_subject_id := nullif(p_payload->>'subject_id','')::uuid;
      v_term_id := nullif(p_payload->>'term_id','')::uuid;
      IF v_class_id IS NULL OR v_subject_id IS NULL OR v_term_id IS NULL
        OR nullif(btrim(p_payload->>'title'),'') IS NULL THEN RAISE EXCEPTION 'Complete the class, subject, term and assessment title' USING ERRCODE = '22023'; END IF;
      IF v_role='teacher' AND NOT EXISTS (SELECT 1 FROM public.office_school_class_staff AS a
        WHERE a.workspace_id=p_workspace_id AND a.class_id=v_class_id AND a.user_id=auth.uid() AND a.active
          AND (a.subject_id IS NULL OR a.subject_id=v_subject_id)) THEN RAISE EXCEPTION 'Teacher is not assigned to this subject' USING ERRCODE = '42501'; END IF;
      INSERT INTO public.office_school_assessments(workspace_id,class_id,subject_id,term_id,assessment_type,title,maximum_score,created_by)
      VALUES(p_workspace_id,v_class_id,v_subject_id,v_term_id,p_payload->>'assessment_type',btrim(p_payload->>'title'),(p_payload->>'maximum_score')::numeric,auth.uid())
      RETURNING assessment_id INTO v_id;
      PERFORM office_private.school_audit(p_workspace_id,'grades','created',v_id,ARRAY['assessment']);
      RETURN jsonb_build_object('assessment_id',v_id,'status','draft');

    WHEN 'save_scores' THEN
      v_id := nullif(p_payload->>'assessment_id','')::uuid;
      SELECT * INTO v_assessment FROM public.office_school_assessments WHERE workspace_id=p_workspace_id AND assessment_id=v_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Assessment is not available' USING ERRCODE = '42501'; END IF;
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['teacher'], v_assessment.class_id);
      IF v_assessment.status <> 'draft' OR jsonb_typeof(p_payload->'scores') <> 'array' OR jsonb_array_length(p_payload->'scores') > 200 THEN
        RAISE EXCEPTION 'Only a draft assessment with a bounded score list can be changed' USING ERRCODE = '55000'; END IF;
      IF v_role='teacher' AND NOT EXISTS (SELECT 1 FROM public.office_school_class_staff AS a
        WHERE a.workspace_id=p_workspace_id AND a.class_id=v_assessment.class_id AND a.user_id=auth.uid() AND a.active
          AND (a.subject_id IS NULL OR a.subject_id=v_assessment.subject_id)) THEN RAISE EXCEPTION 'Teacher is not assigned to this subject' USING ERRCODE = '42501'; END IF;
      FOR v_item IN SELECT value FROM jsonb_array_elements(p_payload->'scores') LOOP
        v_student_id := nullif(v_item->>'student_id','')::uuid;
        IF NOT EXISTS (SELECT 1 FROM public.office_school_enrollments AS e WHERE e.workspace_id=p_workspace_id
          AND e.student_id=v_student_id AND e.class_id=v_assessment.class_id AND e.term_id=v_assessment.term_id AND e.status='active')
          OR (v_item->>'score')::numeric < 0 OR (v_item->>'score')::numeric > v_assessment.maximum_score THEN
          RAISE EXCEPTION 'Score is outside the assessment maximum or student roster' USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.office_school_assessment_scores(workspace_id,assessment_id,student_id,score,updated_by)
        VALUES(p_workspace_id,v_id,v_student_id,(v_item->>'score')::numeric,auth.uid())
        ON CONFLICT (workspace_id,assessment_id,student_id) DO UPDATE SET score=excluded.score,
          version=public.office_school_assessment_scores.version+1,updated_by=auth.uid(),updated_at=v_now;
        v_rows := v_rows + 1;
      END LOOP;
      PERFORM office_private.school_audit(p_workspace_id,'grades','grades_saved',v_id,ARRAY['scores']);
      RETURN jsonb_build_object('assessment_id',v_id,'saved_scores',v_rows);

    WHEN 'lock_assessment' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY[]::text[]);
      IF NOT office_private.is_admin(p_workspace_id) THEN RAISE EXCEPTION 'Only an Office Team owner/admin can lock grades' USING ERRCODE = '42501'; END IF;
      v_id := nullif(p_payload->>'assessment_id','')::uuid;
      UPDATE public.office_school_assessments SET status='locked',version=version+1,updated_at=v_now
        WHERE workspace_id=p_workspace_id AND assessment_id=v_id AND status='draft';
      IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM public.office_school_assessments WHERE workspace_id=p_workspace_id AND assessment_id=v_id AND status='locked') THEN
        RAISE EXCEPTION 'Assessment is not available' USING ERRCODE = '42501';
      END IF;
      PERFORM office_private.school_audit(p_workspace_id,'grades','status_changed',v_id,ARRAY['status']);
      RETURN jsonb_build_object('assessment_id',v_id,'status','locked');

    WHEN 'create_fee_charge' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['bursar']);
      v_student_id := nullif(p_payload->>'student_id','')::uuid;
      v_term_id := nullif(p_payload->>'term_id','')::uuid;
      IF nullif(p_payload->>'idempotency_key','') IS NULL OR v_student_id IS NULL OR v_term_id IS NULL THEN RAISE EXCEPTION 'Student, term and retry key are required' USING ERRCODE = '22023'; END IF;
      INSERT INTO public.office_school_fee_charges(workspace_id,student_id,term_id,fee_category,amount_tzs,due_date,idempotency_key,created_by)
      VALUES(p_workspace_id,v_student_id,v_term_id,p_payload->>'fee_category',(p_payload->>'amount_tzs')::bigint,(p_payload->>'due_date')::date,
        (p_payload->>'idempotency_key')::uuid,auth.uid()) ON CONFLICT (workspace_id,idempotency_key) DO NOTHING RETURNING charge_id INTO v_id;
      IF v_id IS NULL THEN SELECT charge_id INTO v_id FROM public.office_school_fee_charges WHERE workspace_id=p_workspace_id AND idempotency_key=(p_payload->>'idempotency_key')::uuid; END IF;
      PERFORM office_private.school_audit(p_workspace_id,'fees','created',v_id,ARRAY['fee_charge']);
      RETURN jsonb_build_object('charge_id',v_id);

    WHEN 'record_fee_receipt' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['bursar']);
      v_id := nullif(p_payload->>'charge_id','')::uuid;
      IF nullif(p_payload->>'idempotency_key','') IS NULL THEN RAISE EXCEPTION 'Receipt retry key is required' USING ERRCODE = '22023'; END IF;
      PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text || ':' || v_id::text,0));
      SELECT * INTO v_charge FROM public.office_school_fee_charges WHERE workspace_id=p_workspace_id AND charge_id=v_id AND status='active' FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Active fee charge is not available' USING ERRCODE = '42501'; END IF;
      IF EXISTS (SELECT 1 FROM public.office_school_fee_receipts WHERE workspace_id=p_workspace_id AND idempotency_key=(p_payload->>'idempotency_key')::uuid) THEN
        SELECT receipt_id,receipt_number INTO v_id,v_code FROM public.office_school_fee_receipts WHERE workspace_id=p_workspace_id AND idempotency_key=(p_payload->>'idempotency_key')::uuid;
        RETURN jsonb_build_object('receipt_id',v_id,'receipt_number',v_code,'replayed',true);
      END IF;
      v_amount := (p_payload->>'amount_tzs')::bigint;
      SELECT coalesce(sum(r.amount_tzs),0) INTO v_total_paid FROM public.office_school_fee_receipts AS r
        WHERE r.workspace_id=p_workspace_id AND r.charge_id=v_charge.charge_id;
      IF v_amount < 1 OR v_amount > v_charge.amount_tzs-v_total_paid THEN RAISE EXCEPTION 'Receipt exceeds the remaining fee balance' USING ERRCODE = '22023'; END IF;
      v_code := 'RCT-' || upper(substr(replace(gen_random_uuid()::text,'-',''),1,16));
      INSERT INTO public.office_school_fee_receipts(workspace_id,charge_id,receipt_number,amount_tzs,payment_method,external_reference,idempotency_key,received_by)
      VALUES(p_workspace_id,v_charge.charge_id,v_code,v_amount,p_payload->>'payment_method',btrim(coalesce(p_payload->>'external_reference','')),
        (p_payload->>'idempotency_key')::uuid,auth.uid()) RETURNING receipt_id INTO v_id;
      PERFORM office_private.school_audit(p_workspace_id,'fees','receipt_recorded',v_id,ARRAY['fee_receipt']);
      RETURN jsonb_build_object('receipt_id',v_id,'receipt_number',v_code,'replayed',false);

    WHEN 'create_notice' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher'], nullif(p_payload->>'class_id','')::uuid);
      IF NOT EXISTS (SELECT 1 FROM public.office_school_key_configs WHERE workspace_id=p_workspace_id)
        OR octet_length(decode(p_payload->>'nonce','base64')) <> 12
        OR octet_length(decode(p_payload->>'ciphertext','base64')) NOT BETWEEN 17 AND 8192 THEN RAISE EXCEPTION 'An encrypted notice body and School records key are required' USING ERRCODE = '22023'; END IF;
      INSERT INTO public.office_school_notices(workspace_id,term_id,class_id,notice_kind,nonce,body_ciphertext,created_by)
      VALUES(p_workspace_id,(p_payload->>'term_id')::uuid,nullif(p_payload->>'class_id','')::uuid,p_payload->>'notice_kind',
        decode(p_payload->>'nonce','base64'),decode(p_payload->>'ciphertext','base64'),auth.uid()) RETURNING notice_id INTO v_id;
      PERFORM office_private.school_audit(p_workspace_id,'communications','created',v_id,ARRAY['notice_status']);
      RETURN jsonb_build_object('notice_id',v_id,'status','draft');

    WHEN 'approve_notice' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar']);
      v_id := nullif(p_payload->>'notice_id','')::uuid;
      UPDATE public.office_school_notices SET status='approved',approved_by=auth.uid(),updated_at=v_now
        WHERE workspace_id=p_workspace_id AND notice_id=v_id AND status='draft';
      IF NOT FOUND AND NOT EXISTS (SELECT 1 FROM public.office_school_notices WHERE workspace_id=p_workspace_id AND notice_id=v_id AND status='approved') THEN
        RAISE EXCEPTION 'Notice is not available' USING ERRCODE = '42501';
      END IF;
      PERFORM office_private.school_audit(p_workspace_id,'communications','status_changed',v_id,ARRAY['notice_status']);
      RETURN jsonb_build_object('notice_id',v_id,'status','approved','delivery','manual_only');

    ELSE
      RAISE EXCEPTION 'Unknown School command' USING ERRCODE = '22023';
  END CASE;
END;
$function$;

REVOKE ALL ON FUNCTION public.office_school_read(uuid, text, jsonb, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_school_command(uuid, text, jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.office_school_read(uuid, text, jsonb, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_school_command(uuid, text, jsonb) TO authenticated;
COMMENT ON FUNCTION public.office_school_read(uuid, text, jsonb, integer) IS 'Reads one allowlisted School resource after workspace membership, School profile, and module-role checks; logs sensitive reads.';
COMMENT ON FUNCTION public.office_school_command(uuid, text, jsonb) IS 'Runs allowlisted School workflows through fixed-search-path RPCs; sensitive identity and notice text must arrive client-encrypted.';

-- The timetable-only proposal is folded into this migration without copying its
-- stand-alone BEGIN/COMMIT or its stale scope preflight.

CREATE TABLE public.office_school_timetable_entries (
  entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  industry_id text NOT NULL DEFAULT 'school' CHECK (industry_id = 'school'),
  idempotency_key uuid NOT NULL,
  academic_year text NOT NULL
    CHECK (char_length(btrim(academic_year)) BETWEEN 1 AND 16)
    CHECK (academic_year = btrim(academic_year))
    CHECK (academic_year !~ '[[:cntrl:]]'),
  term_label text NOT NULL
    CHECK (char_length(btrim(term_label)) BETWEEN 1 AND 32)
    CHECK (term_label = btrim(term_label))
    CHECK (term_label !~ '[[:cntrl:]]'),
  class_label text NOT NULL
    CHECK (char_length(btrim(class_label)) BETWEEN 1 AND 80)
    CHECK (class_label = btrim(class_label))
    CHECK (class_label !~ '[[:cntrl:]]'),
  subject_label text NOT NULL
    CHECK (char_length(btrim(subject_label)) BETWEEN 1 AND 80)
    CHECK (subject_label = btrim(subject_label))
    CHECK (subject_label !~ '[[:cntrl:]]'),
  teacher_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  room_label text NOT NULL DEFAULT ''
    CHECK (char_length(room_label) <= 80)
    CHECK (room_label = btrim(room_label))
    CHECK (room_label !~ '[[:cntrl:]]'),
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_minute smallint NOT NULL CHECK (start_minute BETWEEN 0 AND 1439),
  end_minute smallint NOT NULL CHECK (end_minute BETWEEN 1 AND 1440),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_school_timetable_minutes_ck CHECK (start_minute < end_minute),
  CONSTRAINT office_school_timetable_space_fk
    FOREIGN KEY (workspace_id, industry_id)
    REFERENCES public.office_industry_spaces(workspace_id, industry_id)
    ON DELETE RESTRICT,
  CONSTRAINT office_school_timetable_idempotency_uq UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT office_school_timetable_entry_space_uq UNIQUE (entry_id, workspace_id)
);

COMMENT ON TABLE public.office_school_timetable_entries IS
  'Office Team School weekly timetable. Contains no learner or guardian records; this is not an official education or NECTA system.';

CREATE INDEX office_school_timetable_week_idx
  ON public.office_school_timetable_entries
    (workspace_id, academic_year, term_label, day_of_week, start_minute, entry_id)
  WHERE status = 'scheduled';
CREATE INDEX office_school_timetable_created_idx
  ON public.office_school_timetable_entries (workspace_id, created_at DESC, entry_id DESC);

CREATE TABLE public.office_school_timetable_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('created', 'updated', 'cancelled')),
  schedule_version bigint NOT NULL CHECK (schedule_version > 0),
  changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (changed_fields <@ ARRAY[
      'academic_year', 'term_label', 'class_label', 'subject_label',
      'teacher_user_id', 'room_label', 'day_of_week', 'start_minute',
      'end_minute', 'status'
    ]::text[]),
  before_state jsonb,
  after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_school_timetable_event_entry_fk
    FOREIGN KEY (entry_id, workspace_id)
    REFERENCES public.office_school_timetable_entries(entry_id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT office_school_timetable_event_version_uq
    UNIQUE (workspace_id, entry_id, schedule_version),
  CONSTRAINT office_school_timetable_event_shape_ck CHECK (
    (event_kind = 'created' AND schedule_version = 1 AND cardinality(changed_fields) = 0)
    OR (event_kind = 'updated' AND schedule_version > 1 AND cardinality(changed_fields) BETWEEN 1 AND 9)
    OR (event_kind = 'cancelled' AND schedule_version > 1 AND changed_fields = ARRAY['status']::text[])
  ),
  CONSTRAINT office_school_timetable_event_snapshot_ck CHECK (
    jsonb_typeof(after_state) = 'object'
    AND ((event_kind = 'created' AND before_state IS NULL)
      OR (event_kind IN ('updated', 'cancelled') AND jsonb_typeof(before_state) = 'object'))
  )
);

COMMENT ON TABLE public.office_school_timetable_events IS
  'Append-only schedule audit events with tightly scoped before/after timetable snapshots; contains no learner or guardian data.';

CREATE INDEX office_school_timetable_events_cursor_idx
  ON public.office_school_timetable_events (workspace_id, entry_id, created_at DESC, event_id DESC);

ALTER TABLE public.office_school_timetable_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_school_timetable_events ENABLE ROW LEVEL SECURITY;

-- No direct PostgREST/table access, including service_role. The authenticated,
-- SECURITY DEFINER RPCs below are the only intended data path.
REVOKE ALL ON TABLE public.office_school_timetable_entries,
  public.office_school_timetable_events
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION office_private.school_timetable_authorize(
  p_workspace_id uuid,
  p_write boolean
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_workspace_id IS NULL OR auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication and a school workspace are required' USING ERRCODE = '42501';
  END IF;
  IF NOT office_private.is_active_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Active Office Team membership is required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_industry_spaces AS s
    WHERE s.workspace_id = p_workspace_id AND s.industry_id = 'school'
  ) THEN
    RAISE EXCEPTION 'This Office Team does not have a School profile' USING ERRCODE = '42501';
  END IF;
  IF p_write AND NOT office_private.is_admin(p_workspace_id) THEN
    RAISE EXCEPTION 'Only an active workspace owner or administrator can change the timetable' USING ERRCODE = '42501';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION office_private.school_timetable_authorize(uuid, boolean)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION office_private.school_timetable_assert_teacher(
  p_workspace_id uuid,
  p_teacher_user_id uuid
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF p_teacher_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id
      AND m.user_id = p_teacher_user_id
      AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Choose an active member of this Office Team as the teacher' USING ERRCODE = '22023';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION office_private.school_timetable_assert_teacher(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION office_private.school_timetable_assert_no_conflict(
  p_workspace_id uuid,
  p_academic_year text,
  p_term_label text,
  p_class_label text,
  p_teacher_user_id uuid,
  p_room_label text,
  p_day_of_week smallint,
  p_start_minute smallint,
  p_end_minute smallint,
  p_exclude_entry_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_conflict text;
BEGIN
  SELECT CASE
    WHEN pg_catalog.lower(e.class_label) = pg_catalog.lower(p_class_label) THEN 'class'
    WHEN e.teacher_user_id = p_teacher_user_id THEN 'teacher'
    ELSE 'room'
  END
  INTO v_conflict
  FROM public.office_school_timetable_entries AS e
  WHERE e.workspace_id = p_workspace_id
    AND pg_catalog.lower(e.academic_year) = pg_catalog.lower(p_academic_year)
    AND pg_catalog.lower(e.term_label) = pg_catalog.lower(p_term_label)
    AND e.day_of_week = p_day_of_week
    AND e.status = 'scheduled'
    AND e.entry_id IS DISTINCT FROM p_exclude_entry_id
    AND p_start_minute < e.end_minute
    AND p_end_minute > e.start_minute
    AND (
      pg_catalog.lower(e.class_label) = pg_catalog.lower(p_class_label)
      OR e.teacher_user_id = p_teacher_user_id
      OR (p_room_label <> '' AND pg_catalog.lower(e.room_label) = pg_catalog.lower(p_room_label))
    )
  ORDER BY CASE
    WHEN pg_catalog.lower(e.class_label) = pg_catalog.lower(p_class_label) THEN 1
    WHEN e.teacher_user_id = p_teacher_user_id THEN 2
    ELSE 3
  END
  LIMIT 1;

  IF v_conflict IS NOT NULL THEN
    RAISE EXCEPTION 'Timetable conflict: this % is already scheduled during that interval', v_conflict
      USING ERRCODE = '23P01';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION office_private.school_timetable_assert_no_conflict(
  uuid, text, text, text, uuid, text, smallint, smallint, smallint, uuid
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION office_private.school_timetable_audit_guard()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_entry public.office_school_timetable_entries%ROWTYPE;
  v_expected_after jsonb;
  v_prior_after jsonb;
BEGIN
  SELECT e.* INTO v_entry
  FROM public.office_school_timetable_entries AS e
  WHERE e.entry_id = NEW.entry_id AND e.workspace_id = NEW.workspace_id;
  IF NOT FOUND OR NEW.schedule_version <> v_entry.version THEN
    RAISE EXCEPTION 'Timetable audit version does not match the saved schedule';
  END IF;

  v_expected_after := pg_catalog.jsonb_build_object(
    'academic_year', v_entry.academic_year,
    'term_label', v_entry.term_label,
    'class_label', v_entry.class_label,
    'subject_label', v_entry.subject_label,
    'teacher_user_id', v_entry.teacher_user_id,
    'room_label', v_entry.room_label,
    'day_of_week', v_entry.day_of_week,
    'start_minute', v_entry.start_minute,
    'end_minute', v_entry.end_minute,
    'status', v_entry.status
  );
  IF NEW.after_state IS DISTINCT FROM v_expected_after THEN
    RAISE EXCEPTION 'Timetable audit snapshot does not match the saved schedule';
  END IF;

  IF NEW.event_kind = 'created' THEN
    IF v_entry.version <> 1 OR v_entry.status <> 'scheduled' THEN
      RAISE EXCEPTION 'Invalid initial timetable audit event';
    END IF;
  ELSE
    SELECT prior.after_state INTO v_prior_after
    FROM public.office_school_timetable_events AS prior
      WHERE prior.workspace_id = NEW.workspace_id
        AND prior.entry_id = NEW.entry_id
        AND prior.schedule_version = NEW.schedule_version - 1;
    IF NOT FOUND OR NEW.before_state IS DISTINCT FROM v_prior_after THEN
      RAISE EXCEPTION 'Timetable audit versions must be continuous';
    END IF;
    IF NEW.event_kind = 'updated' AND v_entry.status <> 'scheduled' THEN
      RAISE EXCEPTION 'Only a scheduled timetable entry can be updated';
    END IF;
    IF NEW.event_kind = 'cancelled' AND v_entry.status <> 'cancelled' THEN
      RAISE EXCEPTION 'Cancelled timetable audit state does not match the entry';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION office_private.school_timetable_audit_guard()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER office_school_timetable_audit_guard_trg
  BEFORE INSERT ON public.office_school_timetable_events
  FOR EACH ROW EXECUTE FUNCTION office_private.school_timetable_audit_guard();

CREATE FUNCTION office_private.school_timetable_reject_event_mutation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'School timetable audit events are append-only';
END;
$function$;

REVOKE ALL ON FUNCTION office_private.school_timetable_reject_event_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER office_school_timetable_events_immutable_trg
  BEFORE UPDATE OR DELETE ON public.office_school_timetable_events
  FOR EACH ROW EXECUTE FUNCTION office_private.school_timetable_reject_event_mutation();
CREATE TRIGGER office_school_timetable_events_no_truncate_trg
  BEFORE TRUNCATE ON public.office_school_timetable_events
  FOR EACH STATEMENT EXECUTE FUNCTION office_private.school_timetable_reject_event_mutation();

CREATE FUNCTION public.office_school_timetable_list(
  p_workspace_id uuid,
  p_academic_year text DEFAULT NULL,
  p_term_label text DEFAULT NULL,
  p_limit integer DEFAULT 100,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_entry_id uuid DEFAULT NULL
)
RETURNS TABLE (
  entry_id uuid,
  workspace_id uuid,
  academic_year text,
  term_label text,
  class_label text,
  subject_label text,
  teacher_user_id uuid,
  room_label text,
  day_of_week smallint,
  start_minute smallint,
  end_minute smallint,
  status text,
  version bigint,
  created_by uuid,
  created_at timestamptz,
  updated_by uuid,
  updated_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_limit integer := coalesce(p_limit, 100);
BEGIN
  PERFORM office_private.school_timetable_authorize(p_workspace_id, false);
  IF v_limit < 1 OR v_limit > 100 THEN
    RAISE EXCEPTION 'Page size must be between 1 and 100' USING ERRCODE = '22023';
  END IF;
  IF (p_before_created_at IS NULL) <> (p_before_entry_id IS NULL) THEN
    RAISE EXCEPTION 'Both timetable cursor values are required' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT e.entry_id, e.workspace_id, e.academic_year, e.term_label,
    e.class_label, e.subject_label, e.teacher_user_id, e.room_label,
    e.day_of_week, e.start_minute, e.end_minute, e.status, e.version,
    e.created_by, e.created_at, e.updated_by, e.updated_at
  FROM public.office_school_timetable_entries AS e
  WHERE e.workspace_id = p_workspace_id
    AND (p_academic_year IS NULL OR pg_catalog.lower(e.academic_year) = pg_catalog.lower(pg_catalog.btrim(p_academic_year)))
    AND (p_term_label IS NULL OR pg_catalog.lower(e.term_label) = pg_catalog.lower(pg_catalog.btrim(p_term_label)))
    AND (p_before_created_at IS NULL OR (e.created_at, e.entry_id) < (p_before_created_at, p_before_entry_id))
  ORDER BY e.created_at DESC, e.entry_id DESC
  LIMIT v_limit;
END;
$function$;

CREATE FUNCTION public.office_school_timetable_create(
  p_workspace_id uuid,
  p_idempotency_key uuid,
  p_academic_year text,
  p_term_label text,
  p_class_label text,
  p_subject_label text,
  p_teacher_user_id uuid,
  p_room_label text,
  p_day_of_week smallint,
  p_start_minute smallint,
  p_end_minute smallint
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_academic_year text := pg_catalog.btrim(coalesce(p_academic_year, ''));
  v_term_label text := pg_catalog.btrim(coalesce(p_term_label, ''));
  v_class_label text := pg_catalog.btrim(coalesce(p_class_label, ''));
  v_subject_label text := pg_catalog.btrim(coalesce(p_subject_label, ''));
  v_room_label text := pg_catalog.btrim(coalesce(p_room_label, ''));
  v_existing public.office_school_timetable_entries%ROWTYPE;
  v_entry_id uuid;
BEGIN
  PERFORM office_private.school_timetable_authorize(p_workspace_id, true);
  PERFORM office_private.school_timetable_assert_teacher(p_workspace_id, p_teacher_user_id);
  IF p_idempotency_key IS NULL
     OR pg_catalog.char_length(v_academic_year) NOT BETWEEN 1 AND 16
     OR pg_catalog.char_length(v_term_label) NOT BETWEEN 1 AND 32
     OR pg_catalog.char_length(v_class_label) NOT BETWEEN 1 AND 80
     OR pg_catalog.char_length(v_subject_label) NOT BETWEEN 1 AND 80
     OR pg_catalog.char_length(v_room_label) > 80
     OR v_academic_year ~ '[[:cntrl:]]'
     OR v_term_label ~ '[[:cntrl:]]'
     OR v_class_label ~ '[[:cntrl:]]'
     OR v_subject_label ~ '[[:cntrl:]]'
     OR v_room_label ~ '[[:cntrl:]]'
     OR p_day_of_week NOT BETWEEN 1 AND 7
     OR p_start_minute NOT BETWEEN 0 AND 1439
     OR p_end_minute NOT BETWEEN 1 AND 1440
     OR p_start_minute >= p_end_minute THEN
    RAISE EXCEPTION 'Enter valid school year, term, class, subject, teacher, day and time values' USING ERRCODE = '22023';
  END IF;

  -- Coarse per-workspace lock deliberately serializes schedule writes so a
  -- concurrent create/update cannot pass the same conflict check.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text, 0));

  SELECT e.* INTO v_existing
  FROM public.office_school_timetable_entries AS e
  WHERE e.workspace_id = p_workspace_id AND e.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF FOUND THEN
    IF v_existing.academic_year IS DISTINCT FROM v_academic_year
       OR v_existing.term_label IS DISTINCT FROM v_term_label
       OR v_existing.class_label IS DISTINCT FROM v_class_label
       OR v_existing.subject_label IS DISTINCT FROM v_subject_label
       OR v_existing.teacher_user_id IS DISTINCT FROM p_teacher_user_id
       OR v_existing.room_label IS DISTINCT FROM v_room_label
       OR v_existing.day_of_week IS DISTINCT FROM p_day_of_week
       OR v_existing.start_minute IS DISTINCT FROM p_start_minute
       OR v_existing.end_minute IS DISTINCT FROM p_end_minute THEN
      RAISE EXCEPTION 'This retry key was already used with different timetable details' USING ERRCODE = '23505';
    END IF;
    RETURN v_existing.entry_id;
  END IF;

  PERFORM office_private.school_timetable_assert_no_conflict(
    p_workspace_id, v_academic_year, v_term_label, v_class_label,
    p_teacher_user_id, v_room_label, p_day_of_week, p_start_minute,
    p_end_minute, NULL
  );

  INSERT INTO public.office_school_timetable_entries (
    workspace_id, industry_id, idempotency_key, academic_year, term_label,
    class_label, subject_label, teacher_user_id, room_label, day_of_week,
    start_minute, end_minute, created_by, updated_by
  ) VALUES (
    p_workspace_id, 'school', p_idempotency_key, v_academic_year, v_term_label,
    v_class_label, v_subject_label, p_teacher_user_id, v_room_label, p_day_of_week,
    p_start_minute, p_end_minute, auth.uid(), auth.uid()
  ) RETURNING public.office_school_timetable_entries.entry_id INTO v_entry_id;

  INSERT INTO public.office_school_timetable_events (
    workspace_id, entry_id, actor_id, event_kind, schedule_version,
    changed_fields, before_state, after_state
  )
  SELECT e.workspace_id, e.entry_id, auth.uid(), 'created', e.version,
    ARRAY[]::text[], NULL,
    pg_catalog.jsonb_build_object(
      'academic_year', e.academic_year, 'term_label', e.term_label,
      'class_label', e.class_label, 'subject_label', e.subject_label,
      'teacher_user_id', e.teacher_user_id, 'room_label', e.room_label,
      'day_of_week', e.day_of_week, 'start_minute', e.start_minute,
      'end_minute', e.end_minute, 'status', e.status
    )
  FROM public.office_school_timetable_entries AS e
  WHERE e.workspace_id = p_workspace_id AND e.entry_id = v_entry_id;

  RETURN v_entry_id;
END;
$function$;

CREATE FUNCTION public.office_school_timetable_update(
  p_workspace_id uuid,
  p_entry_id uuid,
  p_expected_version bigint,
  p_academic_year text,
  p_term_label text,
  p_class_label text,
  p_subject_label text,
  p_teacher_user_id uuid,
  p_room_label text,
  p_day_of_week smallint,
  p_start_minute smallint,
  p_end_minute smallint
)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_academic_year text := pg_catalog.btrim(coalesce(p_academic_year, ''));
  v_term_label text := pg_catalog.btrim(coalesce(p_term_label, ''));
  v_class_label text := pg_catalog.btrim(coalesce(p_class_label, ''));
  v_subject_label text := pg_catalog.btrim(coalesce(p_subject_label, ''));
  v_room_label text := pg_catalog.btrim(coalesce(p_room_label, ''));
  v_existing public.office_school_timetable_entries%ROWTYPE;
  v_changed_fields text[];
  v_before_state jsonb;
BEGIN
  PERFORM office_private.school_timetable_authorize(p_workspace_id, true);
  PERFORM office_private.school_timetable_assert_teacher(p_workspace_id, p_teacher_user_id);
  IF p_entry_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 1
     OR pg_catalog.char_length(v_academic_year) NOT BETWEEN 1 AND 16
     OR pg_catalog.char_length(v_term_label) NOT BETWEEN 1 AND 32
     OR pg_catalog.char_length(v_class_label) NOT BETWEEN 1 AND 80
     OR pg_catalog.char_length(v_subject_label) NOT BETWEEN 1 AND 80
     OR pg_catalog.char_length(v_room_label) > 80
     OR v_academic_year ~ '[[:cntrl:]]'
     OR v_term_label ~ '[[:cntrl:]]'
     OR v_class_label ~ '[[:cntrl:]]'
     OR v_subject_label ~ '[[:cntrl:]]'
     OR v_room_label ~ '[[:cntrl:]]'
     OR p_day_of_week NOT BETWEEN 1 AND 7
     OR p_start_minute NOT BETWEEN 0 AND 1439
     OR p_end_minute NOT BETWEEN 1 AND 1440
     OR p_start_minute >= p_end_minute THEN
    RAISE EXCEPTION 'Enter valid school year, term, class, subject, teacher, day and time values' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text, 0));
  SELECT e.* INTO v_existing
  FROM public.office_school_timetable_entries AS e
  WHERE e.workspace_id = p_workspace_id AND e.entry_id = p_entry_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Timetable entry is not available in this workspace' USING ERRCODE = '42501';
  END IF;
  IF v_existing.version <> p_expected_version THEN
    RAISE EXCEPTION 'Timetable entry changed elsewhere; refresh before saving' USING ERRCODE = '40001';
  END IF;
  IF v_existing.status <> 'scheduled' THEN
    RAISE EXCEPTION 'A cancelled timetable entry cannot be edited' USING ERRCODE = '22023';
  END IF;

  v_changed_fields := pg_catalog.array_remove(ARRAY[
    CASE WHEN v_existing.academic_year IS DISTINCT FROM v_academic_year THEN 'academic_year' END,
    CASE WHEN v_existing.term_label IS DISTINCT FROM v_term_label THEN 'term_label' END,
    CASE WHEN v_existing.class_label IS DISTINCT FROM v_class_label THEN 'class_label' END,
    CASE WHEN v_existing.subject_label IS DISTINCT FROM v_subject_label THEN 'subject_label' END,
    CASE WHEN v_existing.teacher_user_id IS DISTINCT FROM p_teacher_user_id THEN 'teacher_user_id' END,
    CASE WHEN v_existing.room_label IS DISTINCT FROM v_room_label THEN 'room_label' END,
    CASE WHEN v_existing.day_of_week IS DISTINCT FROM p_day_of_week THEN 'day_of_week' END,
    CASE WHEN v_existing.start_minute IS DISTINCT FROM p_start_minute THEN 'start_minute' END,
    CASE WHEN v_existing.end_minute IS DISTINCT FROM p_end_minute THEN 'end_minute' END
  ]::text[], NULL);

  IF pg_catalog.cardinality(v_changed_fields) = 0 THEN
    RETURN v_existing.version;
  END IF;

  PERFORM office_private.school_timetable_assert_no_conflict(
    p_workspace_id, v_academic_year, v_term_label, v_class_label,
    p_teacher_user_id, v_room_label, p_day_of_week, p_start_minute,
    p_end_minute, p_entry_id
  );

  v_before_state := pg_catalog.jsonb_build_object(
    'academic_year', v_existing.academic_year,
    'term_label', v_existing.term_label,
    'class_label', v_existing.class_label,
    'subject_label', v_existing.subject_label,
    'teacher_user_id', v_existing.teacher_user_id,
    'room_label', v_existing.room_label,
    'day_of_week', v_existing.day_of_week,
    'start_minute', v_existing.start_minute,
    'end_minute', v_existing.end_minute,
    'status', v_existing.status
  );

  UPDATE public.office_school_timetable_entries AS e
  SET academic_year = v_academic_year,
      term_label = v_term_label,
      class_label = v_class_label,
      subject_label = v_subject_label,
      teacher_user_id = p_teacher_user_id,
      room_label = v_room_label,
      day_of_week = p_day_of_week,
      start_minute = p_start_minute,
      end_minute = p_end_minute,
      version = e.version + 1,
      updated_by = auth.uid(),
      updated_at = now()
  WHERE e.workspace_id = p_workspace_id AND e.entry_id = p_entry_id
  RETURNING e.* INTO v_existing;

  INSERT INTO public.office_school_timetable_events (
    workspace_id, entry_id, actor_id, event_kind, schedule_version,
    changed_fields, before_state, after_state
  ) VALUES (
    p_workspace_id, p_entry_id, auth.uid(), 'updated', v_existing.version,
    v_changed_fields, v_before_state,
    pg_catalog.jsonb_build_object(
      'academic_year', v_existing.academic_year,
      'term_label', v_existing.term_label,
      'class_label', v_existing.class_label,
      'subject_label', v_existing.subject_label,
      'teacher_user_id', v_existing.teacher_user_id,
      'room_label', v_existing.room_label,
      'day_of_week', v_existing.day_of_week,
      'start_minute', v_existing.start_minute,
      'end_minute', v_existing.end_minute,
      'status', v_existing.status
    )
  );

  RETURN v_existing.version;
END;
$function$;

CREATE FUNCTION public.office_school_timetable_cancel(
  p_workspace_id uuid,
  p_entry_id uuid,
  p_expected_version bigint
)
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_existing public.office_school_timetable_entries%ROWTYPE;
  v_before_state jsonb;
BEGIN
  PERFORM office_private.school_timetable_authorize(p_workspace_id, true);
  IF p_entry_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'A timetable entry and current version are required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_workspace_id::text, 0));
  SELECT e.* INTO v_existing
  FROM public.office_school_timetable_entries AS e
  WHERE e.workspace_id = p_workspace_id AND e.entry_id = p_entry_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Timetable entry is not available in this workspace' USING ERRCODE = '42501';
  END IF;
  IF v_existing.version <> p_expected_version THEN
    RAISE EXCEPTION 'Timetable entry changed elsewhere; refresh before cancelling' USING ERRCODE = '40001';
  END IF;
  IF v_existing.status = 'cancelled' THEN
    RETURN v_existing.version;
  END IF;

  v_before_state := pg_catalog.jsonb_build_object(
    'academic_year', v_existing.academic_year,
    'term_label', v_existing.term_label,
    'class_label', v_existing.class_label,
    'subject_label', v_existing.subject_label,
    'teacher_user_id', v_existing.teacher_user_id,
    'room_label', v_existing.room_label,
    'day_of_week', v_existing.day_of_week,
    'start_minute', v_existing.start_minute,
    'end_minute', v_existing.end_minute,
    'status', v_existing.status
  );

  UPDATE public.office_school_timetable_entries AS e
  SET status = 'cancelled',
      version = e.version + 1,
      updated_by = auth.uid(),
      updated_at = now()
  WHERE e.workspace_id = p_workspace_id AND e.entry_id = p_entry_id
  RETURNING e.* INTO v_existing;

  INSERT INTO public.office_school_timetable_events (
    workspace_id, entry_id, actor_id, event_kind, schedule_version,
    changed_fields, before_state, after_state
  ) VALUES (
    p_workspace_id, p_entry_id, auth.uid(), 'cancelled', v_existing.version,
    ARRAY['status']::text[], v_before_state,
    pg_catalog.jsonb_build_object(
      'academic_year', v_existing.academic_year,
      'term_label', v_existing.term_label,
      'class_label', v_existing.class_label,
      'subject_label', v_existing.subject_label,
      'teacher_user_id', v_existing.teacher_user_id,
      'room_label', v_existing.room_label,
      'day_of_week', v_existing.day_of_week,
      'start_minute', v_existing.start_minute,
      'end_minute', v_existing.end_minute,
      'status', v_existing.status
    )
  );

  RETURN v_existing.version;
END;
$function$;

CREATE FUNCTION public.office_school_timetable_list_events(
  p_workspace_id uuid,
  p_entry_id uuid,
  p_limit integer DEFAULT 50,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_event_id uuid DEFAULT NULL
)
RETURNS TABLE (
  event_id uuid,
  entry_id uuid,
  actor_id uuid,
  event_kind text,
  schedule_version bigint,
  changed_fields text[],
  before_state jsonb,
  after_state jsonb,
  created_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_limit integer := coalesce(p_limit, 50);
BEGIN
  PERFORM office_private.school_timetable_authorize(p_workspace_id, false);
  IF p_entry_id IS NULL OR v_limit < 1 OR v_limit > 100 THEN
    RAISE EXCEPTION 'A timetable entry and page size between 1 and 100 are required' USING ERRCODE = '22023';
  END IF;
  IF (p_before_created_at IS NULL) <> (p_before_event_id IS NULL) THEN
    RAISE EXCEPTION 'Both audit cursor values are required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_school_timetable_entries AS e
    WHERE e.workspace_id = p_workspace_id AND e.entry_id = p_entry_id
  ) THEN
    RAISE EXCEPTION 'Timetable entry is not available in this workspace' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT ev.event_id, ev.entry_id, ev.actor_id, ev.event_kind,
    ev.schedule_version, ev.changed_fields, ev.before_state, ev.after_state, ev.created_at
  FROM public.office_school_timetable_events AS ev
  WHERE ev.workspace_id = p_workspace_id
    AND ev.entry_id = p_entry_id
    AND (p_before_created_at IS NULL OR (ev.created_at, ev.event_id) < (p_before_created_at, p_before_event_id))
  ORDER BY ev.created_at DESC, ev.event_id DESC
  LIMIT v_limit;
END;
$function$;

REVOKE ALL ON FUNCTION public.office_school_timetable_list(uuid, text, text, integer, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_school_timetable_create(uuid, uuid, text, text, text, text, uuid, text, smallint, smallint, smallint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_school_timetable_update(uuid, uuid, bigint, text, text, text, text, uuid, text, smallint, smallint, smallint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_school_timetable_cancel(uuid, uuid, bigint)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_school_timetable_list_events(uuid, uuid, integer, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.office_school_timetable_list(uuid, text, text, integer, timestamptz, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_school_timetable_create(uuid, uuid, text, text, text, text, uuid, text, smallint, smallint, smallint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_school_timetable_update(uuid, uuid, bigint, text, text, text, text, uuid, text, smallint, smallint, smallint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_school_timetable_cancel(uuid, uuid, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_school_timetable_list_events(uuid, uuid, integer, timestamptz, uuid) TO authenticated;

COMMENT ON FUNCTION public.office_school_timetable_list(uuid, text, text, integer, timestamptz, uuid) IS
  'Lists a workspace School timetable with keyset pagination. Any active member may read.';
COMMENT ON FUNCTION public.office_school_timetable_create(uuid, uuid, text, text, text, text, uuid, text, smallint, smallint, smallint) IS
  'Creates an idempotent weekly timetable entry; only active workspace owners/admins may write.';
COMMENT ON FUNCTION public.office_school_timetable_update(uuid, uuid, bigint, text, text, text, text, uuid, text, smallint, smallint, smallint) IS
  'Optimistically updates one schedule entry after server-side class/teacher/room conflict checks.';
COMMENT ON FUNCTION public.office_school_timetable_cancel(uuid, uuid, bigint) IS
  'Soft-cancels a schedule entry and retains its audit history.';
COMMENT ON FUNCTION public.office_school_timetable_list_events(uuid, uuid, integer, timestamptz, uuid) IS
  'Lists append-only timetable audit events for active workspace members.';


CREATE FUNCTION office_private.school_timetable_validate_catalog()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.office_school_terms AS t
    WHERE t.workspace_id = NEW.workspace_id AND t.status = 'open'
      AND pg_catalog.lower(t.academic_year) = pg_catalog.lower(NEW.academic_year)
      AND pg_catalog.lower(t.term_label) = pg_catalog.lower(NEW.term_label)) THEN
    RAISE EXCEPTION 'Choose an open managed School term before scheduling' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.office_school_classes AS c
    WHERE c.workspace_id = NEW.workspace_id AND c.status = 'active'
      AND pg_catalog.lower(c.class_label) = pg_catalog.lower(NEW.class_label)) THEN
    RAISE EXCEPTION 'Choose an active managed School class before scheduling' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.office_school_subjects AS s
    WHERE s.workspace_id = NEW.workspace_id AND s.status = 'active'
      AND pg_catalog.lower(s.subject_label) = pg_catalog.lower(NEW.subject_label)) THEN
    RAISE EXCEPTION 'Choose an active managed School subject before scheduling' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_school_classes AS c
    JOIN public.office_school_subjects AS s ON s.workspace_id = c.workspace_id
    JOIN public.office_school_class_staff AS a ON a.workspace_id = c.workspace_id AND a.class_id = c.class_id
    JOIN public.office_memberships AS m ON m.workspace_id = a.workspace_id AND m.user_id = a.user_id
    WHERE c.workspace_id = NEW.workspace_id
      AND c.status = 'active' AND s.status = 'active' AND a.active AND m.status = 'active'
      AND pg_catalog.lower(c.class_label) = pg_catalog.lower(NEW.class_label)
      AND pg_catalog.lower(s.subject_label) = pg_catalog.lower(NEW.subject_label)
      AND a.user_id = NEW.teacher_user_id
      AND (a.assignment_kind = 'class_teacher'
        OR (a.assignment_kind = 'subject_teacher' AND a.subject_id = s.subject_id))
  ) THEN
    RAISE EXCEPTION 'Assign this active team member as class teacher or subject teacher before scheduling' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION office_private.school_timetable_validate_catalog() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER office_school_timetable_catalog_trg
  BEFORE INSERT OR UPDATE OF academic_year, term_label, class_label, subject_label, teacher_user_id, workspace_id
  ON public.office_school_timetable_entries
  FOR EACH ROW EXECUTE FUNCTION office_private.school_timetable_validate_catalog();

COMMIT;
