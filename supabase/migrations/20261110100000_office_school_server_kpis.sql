-- Server-side, role-scoped School KPIs. No new tables or direct table grants.
CREATE OR REPLACE FUNCTION public.office_school_summary(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_role text;
  v_result jsonb;
BEGIN
  v_role := office_private.school_role(p_workspace_id);
  PERFORM office_private.school_require_role(
    p_workspace_id,
    ARRAY['registrar','teacher','bursar','viewer']
  );

  SELECT jsonb_build_object(
    'terms_count',
      (SELECT count(*)::integer FROM public.office_school_terms WHERE workspace_id = p_workspace_id),
    'classes_count',
      (SELECT count(*)::integer FROM public.office_school_classes c
       WHERE c.workspace_id = p_workspace_id AND c.status = 'active'
         AND (v_role <> 'teacher' OR EXISTS (
           SELECT 1 FROM public.office_school_class_staff a
           WHERE a.workspace_id = c.workspace_id AND a.class_id = c.class_id
             AND a.user_id = auth.uid() AND a.active
         ))),
    'subjects_count',
      (SELECT count(*)::integer FROM public.office_school_subjects
       WHERE workspace_id = p_workspace_id AND status = 'active'),
    'students_count',
      CASE WHEN v_role IN ('school_admin','registrar','teacher','bursar') THEN
        (SELECT count(DISTINCT s.student_id)::integer
         FROM public.office_school_students s
         LEFT JOIN public.office_school_enrollments e
           ON e.workspace_id = s.workspace_id AND e.student_id = s.student_id AND e.status = 'active'
         WHERE s.workspace_id = p_workspace_id AND s.status = 'active'
           AND (v_role <> 'teacher' OR EXISTS (
             SELECT 1 FROM public.office_school_class_staff a
             WHERE a.workspace_id = s.workspace_id AND a.class_id = e.class_id
               AND a.user_id = auth.uid() AND a.active
           )))
        ELSE 0 END,
    'applications_count',
      CASE WHEN v_role IN ('school_admin','registrar') THEN
        (SELECT count(*)::integer FROM public.office_school_admissions WHERE workspace_id = p_workspace_id)
        ELSE 0 END,
    'active_applications_count',
      CASE WHEN v_role IN ('school_admin','registrar') THEN
        (SELECT count(*)::integer FROM public.office_school_admissions
         WHERE workspace_id = p_workspace_id AND status IN ('submitted','reviewing','offered','waitlisted'))
        ELSE 0 END,
    'attendance_sessions_count',
      CASE WHEN v_role IN ('school_admin','registrar','teacher') THEN
        (SELECT count(*)::integer FROM public.office_school_attendance_sessions s
         WHERE s.workspace_id = p_workspace_id
           AND (v_role <> 'teacher' OR EXISTS (
             SELECT 1 FROM public.office_school_class_staff a
             WHERE a.workspace_id = s.workspace_id AND a.class_id = s.class_id
               AND a.user_id = auth.uid() AND a.active
           )))
        ELSE 0 END,
    'open_attendance_sessions_count',
      CASE WHEN v_role IN ('school_admin','registrar','teacher') THEN
        (SELECT count(*)::integer FROM public.office_school_attendance_sessions s
         WHERE s.workspace_id = p_workspace_id AND s.status = 'open'
           AND (v_role <> 'teacher' OR EXISTS (
             SELECT 1 FROM public.office_school_class_staff a
             WHERE a.workspace_id = s.workspace_id AND a.class_id = s.class_id
               AND a.user_id = auth.uid() AND a.active
           )))
        ELSE 0 END,
    'attendance_present_count',
      CASE WHEN v_role IN ('school_admin','registrar','teacher') THEN
        (SELECT count(*)::integer FROM public.office_school_attendance_marks m
         JOIN public.office_school_attendance_sessions s
           ON s.workspace_id = m.workspace_id AND s.session_id = m.session_id
         WHERE s.workspace_id = p_workspace_id AND m.attendance_status = 'present'
           AND (v_role <> 'teacher' OR EXISTS (
             SELECT 1 FROM public.office_school_class_staff a
             WHERE a.workspace_id = s.workspace_id AND a.class_id = s.class_id
               AND a.user_id = auth.uid() AND a.active
           )))
        ELSE 0 END,
    'attendance_late_count',
      CASE WHEN v_role IN ('school_admin','registrar','teacher') THEN
        (SELECT count(*)::integer FROM public.office_school_attendance_marks m
         JOIN public.office_school_attendance_sessions s
           ON s.workspace_id = m.workspace_id AND s.session_id = m.session_id
         WHERE s.workspace_id = p_workspace_id AND m.attendance_status = 'late'
           AND (v_role <> 'teacher' OR EXISTS (
             SELECT 1 FROM public.office_school_class_staff a
             WHERE a.workspace_id = s.workspace_id AND a.class_id = s.class_id
               AND a.user_id = auth.uid() AND a.active
           )))
        ELSE 0 END,
    'attendance_absent_count',
      CASE WHEN v_role IN ('school_admin','registrar','teacher') THEN
        (SELECT count(*)::integer FROM public.office_school_attendance_marks m
         JOIN public.office_school_attendance_sessions s
           ON s.workspace_id = m.workspace_id AND s.session_id = m.session_id
         WHERE s.workspace_id = p_workspace_id AND m.attendance_status = 'absent'
           AND (v_role <> 'teacher' OR EXISTS (
             SELECT 1 FROM public.office_school_class_staff a
             WHERE a.workspace_id = s.workspace_id AND a.class_id = s.class_id
               AND a.user_id = auth.uid() AND a.active
           )))
        ELSE 0 END,
    'attendance_excused_count',
      CASE WHEN v_role IN ('school_admin','registrar','teacher') THEN
        (SELECT count(*)::integer FROM public.office_school_attendance_marks m
         JOIN public.office_school_attendance_sessions s
           ON s.workspace_id = m.workspace_id AND s.session_id = m.session_id
         WHERE s.workspace_id = p_workspace_id AND m.attendance_status = 'excused'
           AND (v_role <> 'teacher' OR EXISTS (
             SELECT 1 FROM public.office_school_class_staff a
             WHERE a.workspace_id = s.workspace_id AND a.class_id = s.class_id
               AND a.user_id = auth.uid() AND a.active
           )))
        ELSE 0 END,
    'assessments_count',
      CASE WHEN v_role IN ('school_admin','registrar','teacher') THEN
        (SELECT count(*)::integer FROM public.office_school_assessments a
         WHERE a.workspace_id = p_workspace_id
           AND (v_role <> 'teacher' OR EXISTS (
             SELECT 1 FROM public.office_school_class_staff s
             WHERE s.workspace_id = a.workspace_id AND s.class_id = a.class_id
               AND s.user_id = auth.uid() AND s.active
           )))
        ELSE 0 END,
    'draft_assessments_count',
      CASE WHEN v_role IN ('school_admin','registrar','teacher') THEN
        (SELECT count(*)::integer FROM public.office_school_assessments a
         WHERE a.workspace_id = p_workspace_id AND a.status = 'draft'
           AND (v_role <> 'teacher' OR EXISTS (
             SELECT 1 FROM public.office_school_class_staff s
             WHERE s.workspace_id = a.workspace_id AND s.class_id = a.class_id
               AND s.user_id = auth.uid() AND s.active
           )))
        ELSE 0 END,
    'fee_charges_count',
      CASE WHEN v_role IN ('school_admin','bursar') THEN
        (SELECT count(*)::integer FROM public.office_school_fee_charges
         WHERE workspace_id = p_workspace_id)
        ELSE 0 END,
    'unpaid_fee_charges_count',
      CASE WHEN v_role IN ('school_admin','bursar') THEN
        (SELECT count(*)::integer FROM public.office_school_fee_charges ch
         WHERE ch.workspace_id = p_workspace_id AND ch.status = 'active'
           AND ch.amount_tzs > coalesce((
             SELECT sum(r.amount_tzs) FROM public.office_school_fee_receipts r
             WHERE r.workspace_id = ch.workspace_id AND r.charge_id = ch.charge_id
           ), 0))
        ELSE 0 END,
    'notices_count',
      CASE WHEN v_role IN ('school_admin','registrar','teacher') THEN
        (SELECT count(*)::integer FROM public.office_school_notices WHERE workspace_id = p_workspace_id)
        ELSE 0 END,
    'staff_roles_count',
      CASE WHEN v_role = 'school_admin' THEN
        (SELECT count(*)::integer FROM public.office_school_staff_roles
         WHERE workspace_id = p_workspace_id AND active)
        ELSE 0 END,
    'class_staff_assignments_count',
      CASE WHEN v_role = 'school_admin' THEN
        (SELECT count(*)::integer FROM public.office_school_class_staff
         WHERE workspace_id = p_workspace_id AND active)
        ELSE 0 END
  ) INTO v_result;

  RETURN coalesce(v_result, '{}'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.office_school_summary(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.office_school_summary(uuid) TO authenticated;
COMMENT ON FUNCTION public.office_school_summary(uuid) IS
  'Returns aggregate School KPIs over the complete role-authorized workspace scope; no private identity, guardian, notice plaintext, or direct table access is exposed.';
