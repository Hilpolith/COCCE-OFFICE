-- Add bounded offset pagination to School operational reads without changing existing RPC callers.
-- The caller's workspace membership and School role checks remain unchanged.
CREATE OR REPLACE FUNCTION public.office_school_read(
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
  v_offset integer := coalesce(nullif(p_filter->>'offset', '')::integer, 0);
  v_class_id uuid := nullif(p_filter->>'class_id', '')::uuid;
  v_term_id uuid := nullif(p_filter->>'term_id', '')::uuid;
  v_id uuid := nullif(p_filter->>'id', '')::uuid;
  v_result jsonb;
BEGIN
  v_role := office_private.school_role(p_workspace_id);
  IF v_limit < 1 OR v_limit > 200 THEN
    RAISE EXCEPTION 'Page size must be between 1 and 200' USING ERRCODE = '22023';
  END IF;
  IF v_offset < 0 OR v_offset > 100000 THEN
    RAISE EXCEPTION 'Page offset must be between 0 and 100000' USING ERRCODE = '22023';
  END IF;

  CASE p_resource
    WHEN 'bootstrap' THEN
      v_result := jsonb_build_object(
        'role', v_role,
        'terms', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.start_date DESC), '[]'::jsonb)
          FROM (SELECT term_id, academic_year, term_label, start_date, end_date, status, version
            FROM public.office_school_terms WHERE workspace_id = p_workspace_id ORDER BY start_date DESC, term_id DESC LIMIT v_limit OFFSET v_offset) AS x),
        'classes', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.class_label), '[]'::jsonb)
          FROM (SELECT c.class_id, c.class_label, c.level_label, c.stream_label, c.capacity, c.status, c.version
            FROM public.office_school_classes AS c WHERE c.workspace_id = p_workspace_id AND c.status = 'active'
              AND (v_role <> 'teacher' OR EXISTS (SELECT 1 FROM public.office_school_class_staff AS a
                WHERE a.workspace_id = c.workspace_id AND a.class_id = c.class_id AND a.user_id = auth.uid() AND a.active))
            ORDER BY c.class_label, c.class_id LIMIT v_limit OFFSET v_offset) AS x),
        'subjects', (SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.subject_label), '[]'::jsonb)
          FROM (SELECT subject_id, subject_code, subject_label, status FROM public.office_school_subjects
            WHERE workspace_id = p_workspace_id AND status = 'active' ORDER BY subject_label, subject_id LIMIT v_limit OFFSET v_offset) AS x),
        'key_configured', EXISTS (SELECT 1 FROM public.office_school_key_configs WHERE workspace_id = p_workspace_id)
      );

    WHEN 'terms' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher','bursar','viewer']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.start_date DESC), '[]'::jsonb) INTO v_result
      FROM (SELECT term_id, academic_year, term_label, start_date, end_date, status, version
        FROM public.office_school_terms WHERE workspace_id = p_workspace_id ORDER BY start_date DESC, term_id DESC LIMIT v_limit OFFSET v_offset) AS x;

    WHEN 'classes' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher','bursar','viewer']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.class_label), '[]'::jsonb) INTO v_result
      FROM (SELECT c.class_id, c.class_label, c.level_label, c.stream_label, c.capacity, c.status, c.version
        FROM public.office_school_classes AS c WHERE c.workspace_id = p_workspace_id
          AND (v_role <> 'teacher' OR EXISTS (SELECT 1 FROM public.office_school_class_staff AS a
            WHERE a.workspace_id = c.workspace_id AND a.class_id = c.class_id AND a.user_id = auth.uid() AND a.active))
        ORDER BY c.class_label, c.class_id LIMIT v_limit OFFSET v_offset) AS x;

    WHEN 'subjects' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher','bursar','viewer']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.subject_label), '[]'::jsonb) INTO v_result
      FROM (SELECT subject_id, subject_code, subject_label, status FROM public.office_school_subjects
        WHERE workspace_id = p_workspace_id ORDER BY subject_label, subject_id LIMIT v_limit OFFSET v_offset) AS x;

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
        ORDER BY m.user_id LIMIT v_limit OFFSET v_offset) AS x;

    WHEN 'class_staff' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher','bursar','viewer']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.class_id, x.user_id), '[]'::jsonb) INTO v_result
      FROM (SELECT assignment_id, class_id, subject_id, user_id, assignment_kind, active
        FROM public.office_school_class_staff WHERE workspace_id = p_workspace_id
          AND (v_role <> 'teacher' OR user_id = auth.uid()) ORDER BY class_id, user_id LIMIT v_limit OFFSET v_offset) AS x;

    WHEN 'admissions' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_result
      FROM (SELECT a.application_id, a.person_id, a.application_code, a.term_id, t.academic_year, t.term_label,
          a.requested_class_id, c.class_label, a.status, a.version, a.created_at
        FROM public.office_school_admissions AS a
        JOIN public.office_school_terms AS t ON t.workspace_id = a.workspace_id AND t.term_id = a.term_id
        JOIN public.office_school_classes AS c ON c.workspace_id = a.workspace_id AND c.class_id = a.requested_class_id
        WHERE a.workspace_id = p_workspace_id ORDER BY a.created_at DESC, a.application_id DESC LIMIT v_limit OFFSET v_offset) AS x;

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
        ORDER BY s.student_code, s.student_id LIMIT v_limit OFFSET v_offset) AS x;

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
        ORDER BY s.session_date DESC, s.created_at DESC, s.session_id DESC LIMIT v_limit OFFSET v_offset) AS x;
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
        ORDER BY a.created_at DESC, a.assessment_id DESC LIMIT v_limit OFFSET v_offset) AS x;
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
        ORDER BY ch.due_date, ch.created_at DESC, ch.charge_id DESC LIMIT v_limit OFFSET v_offset) AS x;
      INSERT INTO public.office_school_audit_events(workspace_id, actor_id, module, event_kind, changed_fields)
        VALUES (p_workspace_id, auth.uid(), 'fees', 'sensitive_read', ARRAY[]::text[]);

    WHEN 'notices' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY['registrar','teacher']);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC), '[]'::jsonb) INTO v_result
      FROM (SELECT notice_id, term_id, class_id, notice_kind, encode(nonce, 'base64') AS nonce,
          encode(body_ciphertext, 'base64') AS body_ciphertext, status, created_by, approved_by, created_at
        FROM public.office_school_notices WHERE workspace_id = p_workspace_id
          AND (v_class_id IS NULL OR class_id = v_class_id OR class_id IS NULL)
        ORDER BY created_at DESC, notice_id DESC LIMIT v_limit OFFSET v_offset) AS x;

    WHEN 'audit' THEN
      PERFORM office_private.school_require_role(p_workspace_id, ARRAY[]::text[]);
      SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC, x.event_id DESC), '[]'::jsonb) INTO v_result
      FROM (SELECT event_id, actor_id, module, event_kind, entity_id, changed_fields, created_at
        FROM public.office_school_audit_events WHERE workspace_id = p_workspace_id
        ORDER BY created_at DESC, event_id DESC LIMIT v_limit OFFSET v_offset) AS x;

    ELSE
      RAISE EXCEPTION 'Unknown School data resource' USING ERRCODE = '22023';
  END CASE;

  RETURN coalesce(v_result, '[]'::jsonb);
END;
$function$;
