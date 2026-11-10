-- Server-side, role-scoped University KPIs. No new tables or direct table grants.
CREATE OR REPLACE FUNCTION public.office_university_summary(p_workspace_id uuid)
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
  v_role := office_private.university_require(p_workspace_id, NULL);

  SELECT jsonb_build_object(
    'terms_count',
      (SELECT count(*)::integer FROM public.office_university_terms WHERE workspace_id = p_workspace_id),
    'programmes_count',
      (SELECT count(*)::integer FROM public.office_university_programmes WHERE workspace_id = p_workspace_id),
    'courses_count',
      (SELECT count(*)::integer FROM public.office_university_courses WHERE workspace_id = p_workspace_id),
    'admissions_count',
      CASE WHEN v_role IN ('university_admin','registrar') THEN
        (SELECT count(*)::integer FROM public.office_university_admissions WHERE workspace_id = p_workspace_id)
        ELSE 0 END,
    'active_admissions_count',
      CASE WHEN v_role IN ('university_admin','registrar') THEN
        (SELECT count(*)::integer FROM public.office_university_admissions
         WHERE workspace_id = p_workspace_id AND status IN ('submitted','reviewing','offered','waitlisted'))
        ELSE 0 END,
    'students_count',
      CASE WHEN v_role IN ('university_admin','registrar','lecturer','finance_officer') THEN
        (SELECT count(DISTINCT s.student_id)::integer
         FROM public.office_university_students s
         WHERE s.workspace_id = p_workspace_id
           AND (v_role <> 'lecturer' OR EXISTS (
             SELECT 1 FROM public.office_university_registrations g
             WHERE g.workspace_id = s.workspace_id AND g.student_id = s.student_id
               AND g.status = 'registered'
               AND office_private.university_course_allowed(g.workspace_id,g.course_id,g.term_id)
           )))
        ELSE 0 END,
    'registrations_count',
      CASE WHEN v_role IN ('university_admin','registrar','lecturer') THEN
        (SELECT count(*)::integer FROM public.office_university_registrations g
         WHERE g.workspace_id = p_workspace_id
           AND (v_role <> 'lecturer' OR office_private.university_course_allowed(g.workspace_id,g.course_id,g.term_id)))
        ELSE 0 END,
    'assessments_count',
      CASE WHEN v_role IN ('university_admin','registrar','lecturer') THEN
        (SELECT count(*)::integer FROM public.office_university_assessments a
         WHERE a.workspace_id = p_workspace_id
           AND (v_role <> 'lecturer' OR office_private.university_course_allowed(a.workspace_id,a.course_id,a.term_id)))
        ELSE 0 END,
    'draft_assessments_count',
      CASE WHEN v_role IN ('university_admin','registrar','lecturer') THEN
        (SELECT count(*)::integer FROM public.office_university_assessments a
         WHERE a.workspace_id = p_workspace_id AND a.status = 'draft'
           AND (v_role <> 'lecturer' OR office_private.university_course_allowed(a.workspace_id,a.course_id,a.term_id)))
        ELSE 0 END,
    'scores_count',
      CASE WHEN v_role IN ('university_admin','registrar','lecturer') THEN
        (SELECT count(*)::integer FROM public.office_university_result_scores s
         JOIN public.office_university_assessments a
           ON a.workspace_id = s.workspace_id AND a.assessment_id = s.assessment_id
         WHERE s.workspace_id = p_workspace_id
           AND (v_role <> 'lecturer' OR office_private.university_course_allowed(a.workspace_id,a.course_id,a.term_id)))
        ELSE 0 END,
    'assignments_count',
      CASE WHEN v_role IN ('university_admin','registrar','lecturer') THEN
        (SELECT count(*)::integer FROM public.office_university_course_assignments
         WHERE workspace_id = p_workspace_id AND active
           AND (v_role <> 'lecturer' OR user_id = auth.uid()))
        ELSE 0 END,
    'fees_count',
      CASE WHEN v_role IN ('university_admin','finance_officer') THEN
        (SELECT count(*)::integer FROM public.office_university_fees WHERE workspace_id = p_workspace_id)
        ELSE 0 END,
    'unpaid_fee_charges_count',
      CASE WHEN v_role IN ('university_admin','finance_officer') THEN
        (SELECT count(*)::integer FROM public.office_university_fees
         WHERE workspace_id = p_workspace_id AND amount_tzs > paid_tzs)
        ELSE 0 END,
    'receipts_count',
      CASE WHEN v_role IN ('university_admin','finance_officer') THEN
        (SELECT count(*)::integer FROM public.office_university_receipts WHERE workspace_id = p_workspace_id)
        ELSE 0 END,
    'funding_cases_count',
      CASE WHEN v_role IN ('university_admin','finance_officer') THEN
        (SELECT count(*)::integer FROM public.office_university_funding_cases WHERE workspace_id = p_workspace_id)
        ELSE 0 END,
    'transcript_requests_count',
      CASE WHEN v_role IN ('university_admin','registrar') THEN
        (SELECT count(*)::integer FROM public.office_university_transcript_requests WHERE workspace_id = p_workspace_id)
        ELSE 0 END,
    'pending_transcript_requests_count',
      CASE WHEN v_role IN ('university_admin','registrar') THEN
        (SELECT count(*)::integer FROM public.office_university_transcript_requests
         WHERE workspace_id = p_workspace_id AND status IN ('requested','processing'))
        ELSE 0 END,
    'research_projects_count',
      CASE WHEN v_role IN ('university_admin','research_coordinator') THEN
        (SELECT count(*)::integer FROM public.office_university_research_projects WHERE workspace_id = p_workspace_id)
        ELSE 0 END,
    'quality_cases_count',
      CASE WHEN v_role IN ('university_admin','quality_officer') THEN
        (SELECT count(*)::integer FROM public.office_university_quality_cases WHERE workspace_id = p_workspace_id)
        ELSE 0 END,
    'staff_roles_count',
      CASE WHEN v_role IN ('university_admin','registrar') THEN
        (SELECT count(*)::integer FROM public.office_university_staff_roles
         WHERE workspace_id = p_workspace_id AND active)
        ELSE 0 END
  ) INTO v_result;

  RETURN coalesce(v_result, '{}'::jsonb);
END;
$function$;

REVOKE ALL ON FUNCTION public.office_university_summary(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.office_university_summary(uuid) TO authenticated;
COMMENT ON FUNCTION public.office_university_summary(uuid) IS
  'Returns aggregate University KPIs over the complete role-authorized workspace scope; private applicant identity and direct table access are not exposed.';
