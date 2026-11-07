-- University Management: new cloud records only; no local data import or external portal integration.
BEGIN;
DO $$ BEGIN
 IF to_regclass('public.office_workspaces') IS NULL OR to_regclass('public.office_memberships') IS NULL OR to_regclass('public.office_industry_spaces') IS NULL OR to_regprocedure('office_private.is_active_member(uuid)') IS NULL OR to_regprocedure('office_private.is_admin(uuid)') IS NULL THEN RAISE EXCEPTION 'Existing Office Team schemas are required'; END IF;
 IF to_regclass('public.office_university_terms') IS NOT NULL THEN RAISE EXCEPTION 'University objects already exist'; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS office_private;
CREATE TABLE public.office_university_staff_roles(workspace_id uuid NOT NULL,user_id uuid NOT NULL,university_role text NOT NULL CHECK(university_role IN('registrar','lecturer','finance_officer','research_coordinator','quality_officer','viewer')),active boolean NOT NULL DEFAULT true,assigned_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,user_id),FOREIGN KEY(workspace_id,user_id) REFERENCES public.office_memberships(workspace_id,user_id) ON DELETE CASCADE);
CREATE TABLE public.office_university_key_configs(workspace_id uuid PRIMARY KEY REFERENCES public.office_workspaces(id) ON DELETE CASCADE,key_version smallint NOT NULL DEFAULT 1 CHECK(key_version=1),derivation text NOT NULL DEFAULT 'PBKDF2-HMAC-SHA-256/AES-256-GCM' CHECK(derivation='PBKDF2-HMAC-SHA-256/AES-256-GCM'),iterations integer NOT NULL DEFAULT 600000 CHECK(iterations=600000),salt bytea NOT NULL CHECK(octet_length(salt)=16),verifier_nonce bytea NOT NULL CHECK(octet_length(verifier_nonce)=12),verifier_ciphertext bytea NOT NULL CHECK(octet_length(verifier_ciphertext) BETWEEN 16 AND 128),created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.office_university_terms(term_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,label text NOT NULL CHECK(char_length(btrim(label)) BETWEEN 1 AND 80 AND label=btrim(label) AND label!~'[[:cntrl:]]'),academic_year text NOT NULL CHECK(char_length(btrim(academic_year)) BETWEEN 4 AND 16 AND academic_year=btrim(academic_year)),start_date date NOT NULL,end_date date NOT NULL,status text NOT NULL DEFAULT 'open' CHECK(status IN('open','closed')),version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),CHECK(start_date<=end_date),UNIQUE(workspace_id,label,academic_year),UNIQUE(workspace_id,term_id));
CREATE TABLE public.office_university_programmes(programme_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,code text NOT NULL CHECK(char_length(btrim(code)) BETWEEN 1 AND 32 AND code=btrim(code) AND code!~'[[:cntrl:]]'),name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 160 AND name=btrim(name)),award text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'active' CHECK(status IN('active','archived')),version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,code),UNIQUE(workspace_id,programme_id));
CREATE TABLE public.office_university_courses(course_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,programme_id uuid NOT NULL,code text NOT NULL CHECK(char_length(btrim(code)) BETWEEN 1 AND 32 AND code=btrim(code)),name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 160 AND name=btrim(name)),credits numeric(6,2) NOT NULL CHECK(credits>0 AND credits<=100),status text NOT NULL DEFAULT 'active' CHECK(status IN('active','archived')),version bigint NOT NULL DEFAULT 1 CHECK(version>0),created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,course_id),UNIQUE(workspace_id,code),FOREIGN KEY(workspace_id,programme_id) REFERENCES public.office_university_programmes(workspace_id,programme_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_course_assignments(assignment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,course_id uuid NOT NULL,user_id uuid NOT NULL,term_id uuid NOT NULL,active boolean NOT NULL DEFAULT true,created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,course_id,user_id,term_id),FOREIGN KEY(workspace_id,course_id) REFERENCES public.office_university_courses(workspace_id,course_id) ON DELETE RESTRICT,FOREIGN KEY(workspace_id,user_id) REFERENCES public.office_memberships(workspace_id,user_id) ON DELETE RESTRICT,FOREIGN KEY(workspace_id,term_id) REFERENCES public.office_university_terms(workspace_id,term_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_people(person_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,person_ref text NOT NULL CHECK(char_length(person_ref) BETWEEN 8 AND 40),lifecycle text NOT NULL CHECK(lifecycle IN('applicant','student')),created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,person_ref),UNIQUE(workspace_id,person_id));
CREATE TABLE public.office_university_private_people(workspace_id uuid NOT NULL,person_id uuid NOT NULL,nonce bytea NOT NULL CHECK(octet_length(nonce)=12),ciphertext bytea NOT NULL CHECK(octet_length(ciphertext) BETWEEN 17 AND 32768),version bigint NOT NULL DEFAULT 1,updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,person_id),FOREIGN KEY(workspace_id,person_id) REFERENCES public.office_university_people(workspace_id,person_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_admissions(application_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,person_id uuid NOT NULL,application_code text NOT NULL,term_id uuid NOT NULL,programme_id uuid NOT NULL,status text NOT NULL DEFAULT 'submitted' CHECK(status IN('submitted','reviewing','offered','accepted','confirmed','waitlisted','rejected','withdrawn')),idempotency_key uuid NOT NULL,version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,application_code),UNIQUE(workspace_id,idempotency_key),UNIQUE(workspace_id,application_id),FOREIGN KEY(workspace_id,person_id) REFERENCES public.office_university_people(workspace_id,person_id) ON DELETE RESTRICT,FOREIGN KEY(workspace_id,term_id) REFERENCES public.office_university_terms(workspace_id,term_id) ON DELETE RESTRICT,FOREIGN KEY(workspace_id,programme_id) REFERENCES public.office_university_programmes(workspace_id,programme_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_students(student_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,person_id uuid NOT NULL,student_ref text NOT NULL,status text NOT NULL DEFAULT 'active' CHECK(status IN('active','withdrawn','completed')),version bigint NOT NULL DEFAULT 1,created_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,UNIQUE(workspace_id,student_id),UNIQUE(workspace_id,person_id),UNIQUE(workspace_id,student_ref),FOREIGN KEY(workspace_id,person_id) REFERENCES public.office_university_people(workspace_id,person_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_registrations(registration_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,student_id uuid NOT NULL,course_id uuid NOT NULL,term_id uuid NOT NULL,status text NOT NULL DEFAULT 'registered' CHECK(status IN('registered','dropped','completed')),version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,student_id,course_id,term_id),FOREIGN KEY(workspace_id,student_id) REFERENCES public.office_university_students(workspace_id,student_id) ON DELETE RESTRICT,FOREIGN KEY(workspace_id,course_id) REFERENCES public.office_university_courses(workspace_id,course_id) ON DELETE RESTRICT,FOREIGN KEY(workspace_id,term_id) REFERENCES public.office_university_terms(workspace_id,term_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_assessments(assessment_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,course_id uuid NOT NULL,term_id uuid NOT NULL,title text NOT NULL CHECK(char_length(btrim(title)) BETWEEN 1 AND 160),max_score numeric(8,2) NOT NULL CHECK(max_score>0),status text NOT NULL DEFAULT 'draft' CHECK(status IN('draft','locked','approved')),version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,assessment_id),FOREIGN KEY(workspace_id,course_id) REFERENCES public.office_university_courses(workspace_id,course_id) ON DELETE RESTRICT,FOREIGN KEY(workspace_id,term_id) REFERENCES public.office_university_terms(workspace_id,term_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_result_scores(workspace_id uuid NOT NULL,assessment_id uuid NOT NULL,student_id uuid NOT NULL,score numeric(8,2) NOT NULL CHECK(score>=0),version bigint NOT NULL DEFAULT 1,updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,assessment_id,student_id),FOREIGN KEY(workspace_id,assessment_id) REFERENCES public.office_university_assessments(workspace_id,assessment_id) ON DELETE RESTRICT,FOREIGN KEY(workspace_id,student_id) REFERENCES public.office_university_students(workspace_id,student_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_fees(charge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,student_id uuid NOT NULL,term_id uuid NOT NULL,category text NOT NULL CHECK(char_length(btrim(category)) BETWEEN 1 AND 80),amount_tzs numeric(14,2) NOT NULL CHECK(amount_tzs>0 AND amount_tzs<100000000000),paid_tzs numeric(14,2) NOT NULL DEFAULT 0 CHECK(paid_tzs>=0 AND paid_tzs<=amount_tzs),due_date date,version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,charge_id),FOREIGN KEY(workspace_id,student_id) REFERENCES public.office_university_students(workspace_id,student_id) ON DELETE RESTRICT,FOREIGN KEY(workspace_id,term_id) REFERENCES public.office_university_terms(workspace_id,term_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_receipts(receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,charge_id uuid NOT NULL,receipt_number text NOT NULL,amount_tzs numeric(14,2) NOT NULL CHECK(amount_tzs>0),payment_method text NOT NULL CHECK(payment_method IN('cash','bank','mobile_money','other')),reference text NOT NULL DEFAULT '',idempotency_key uuid NOT NULL,received_at timestamptz NOT NULL DEFAULT now(),created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,UNIQUE(workspace_id,receipt_number),UNIQUE(workspace_id,idempotency_key),FOREIGN KEY(workspace_id,charge_id) REFERENCES public.office_university_fees(workspace_id,charge_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_funding_cases(funding_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,student_id uuid NOT NULL,provider text NOT NULL,academic_year text NOT NULL,status text NOT NULL CHECK(status IN('not_started','submitted','document_check','allocated','appeal','disbursement_pending','reconciled','closed')),outcome text,follow_up_due date,version bigint NOT NULL DEFAULT 1,created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),FOREIGN KEY(workspace_id,student_id) REFERENCES public.office_university_students(workspace_id,student_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_transcript_requests(request_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,student_id uuid NOT NULL,copies integer NOT NULL CHECK(copies BETWEEN 1 AND 20),status text NOT NULL CHECK(status IN('requested','payment_pending','processing','ready','completed','declined')),due_date date,reference text,version bigint NOT NULL DEFAULT 1,idempotency_key uuid NOT NULL,created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,idempotency_key),FOREIGN KEY(workspace_id,student_id) REFERENCES public.office_university_students(workspace_id,student_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_research_projects(project_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,title text NOT NULL,proposal_status text NOT NULL CHECK(proposal_status IN('draft','submitted','approved','rejected')),ethics_status text NOT NULL CHECK(ethics_status IN('not_required','not_started','submitted','approved','expired')),university_clearance_status text NOT NULL CHECK(university_clearance_status IN('not_started','submitted','approved','expired')),permit_status text NOT NULL CHECK(permit_status IN('not_required','not_started','submitted','approved','expired')),ethics_reference text,clearance_reference text,permit_reference text,review_date date,expiry_date date,version bigint NOT NULL DEFAULT 1,idempotency_key uuid NOT NULL,created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,idempotency_key));
CREATE TABLE public.office_university_quality_cases(case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),workspace_id uuid NOT NULL,programme_id uuid NOT NULL,title text NOT NULL,status text NOT NULL CHECK(status IN('draft','submitted','queries','approved','renewal_due','closed')),review_query text,evidence_reference text,due_date date,version bigint NOT NULL DEFAULT 1,idempotency_key uuid NOT NULL,created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(workspace_id,idempotency_key),FOREIGN KEY(workspace_id,programme_id) REFERENCES public.office_university_programmes(workspace_id,programme_id) ON DELETE RESTRICT);
CREATE TABLE public.office_university_audit(entry_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,workspace_id uuid NOT NULL,actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,action text NOT NULL,entity_type text NOT NULL,entity_id uuid,payload jsonb NOT NULL DEFAULT '{}'::jsonb,created_at timestamptz NOT NULL DEFAULT now());

ALTER TABLE public.office_university_fees ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.office_university_students ADD COLUMN programme_id uuid NOT NULL,
 ADD COLUMN term_id uuid NOT NULL,
 ADD FOREIGN KEY(workspace_id,programme_id) REFERENCES public.office_university_programmes(workspace_id,programme_id),
 ADD FOREIGN KEY(workspace_id,term_id) REFERENCES public.office_university_terms(workspace_id,term_id);
CREATE INDEX office_university_assignment_lookup ON public.office_university_course_assignments(workspace_id,user_id,course_id,term_id) WHERE active;
CREATE INDEX office_university_registration_lookup ON public.office_university_registrations(workspace_id,course_id,term_id,student_id);
-- All helpers are private; only the two public RPCs are granted to authenticated.
CREATE FUNCTION office_private.university_require(w uuid, roles text[]) RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r text;
BEGIN
 IF auth.uid() IS NULL OR NOT office_private.is_active_member(w) OR NOT EXISTS(SELECT 1 FROM public.office_industry_spaces s WHERE s.workspace_id=w AND s.industry_id='university') THEN
  RAISE EXCEPTION 'Active University Office Team membership required' USING ERRCODE='42501';
 END IF;
 r:=CASE WHEN office_private.is_admin(w) THEN 'university_admin' ELSE coalesce((SELECT university_role FROM public.office_university_staff_roles WHERE workspace_id=w AND user_id=auth.uid() AND active),'unassigned') END;
 IF r<>'university_admin' AND roles IS NOT NULL AND NOT(r=ANY(roles)) THEN RAISE EXCEPTION 'University role does not allow this action' USING ERRCODE='42501'; END IF;
 RETURN r;
END $$;
CREATE FUNCTION office_private.university_text(value text,label text,max integer,required boolean DEFAULT true) RETURNS text
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
DECLARE v text:=btrim(coalesce(value,''));
BEGIN
 IF (required AND v='') OR char_length(v)>max OR v~'[[:cntrl:]]' THEN RAISE EXCEPTION '% is missing, too long or contains control characters',label USING ERRCODE='22023'; END IF;
 RETURN v;
END $$;
CREATE FUNCTION office_private.university_expect(actual bigint,expected text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $$
BEGIN IF actual IS NULL THEN RAISE EXCEPTION 'University record not found in this workspace' USING ERRCODE='42501'; END IF;
 IF expected IS NULL OR expected!~'^[0-9]+$' OR actual<>expected::bigint THEN RAISE EXCEPTION 'University record changed; refresh before retrying' USING ERRCODE='40001'; END IF;
END $$;
CREATE FUNCTION office_private.university_course_allowed(w uuid,c uuid,t uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT office_private.is_admin(w) OR EXISTS(SELECT 1 FROM public.office_university_staff_roles s WHERE s.workspace_id=w AND s.user_id=auth.uid() AND s.active AND s.university_role='registrar') OR EXISTS(SELECT 1 FROM public.office_university_course_assignments a JOIN public.office_university_staff_roles s ON s.workspace_id=a.workspace_id AND s.user_id=a.user_id AND s.active AND s.university_role='lecturer' WHERE a.workspace_id=w AND a.user_id=auth.uid() AND a.course_id=c AND a.term_id=t AND a.active)
$$;
CREATE FUNCTION public.office_university_read(p_workspace_id uuid,p_resource text,p_filter jsonb DEFAULT '{}'::jsonb,p_limit integer DEFAULT 100,p_offset integer DEFAULT 0) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE w uuid:=p_workspace_id;r text; q text; cols text; tbl text; extra text:=''; result jsonb; lim integer:=least(greatest(coalesce(p_limit,100),1),200); off integer:=greatest(coalesce(p_offset,0),0);
BEGIN
 r:=office_private.university_require(w,NULL);
 IF p_filter IS NULL OR jsonb_typeof(p_filter)<>'object' THEN RAISE EXCEPTION 'A filter object is required' USING ERRCODE='22023'; END IF;
 IF p_resource='bootstrap' THEN
  RETURN jsonb_build_object('role',r,'terms',public.office_university_read(w,'terms','{}',50,0),'programmes',public.office_university_read(w,'programmes','{}',50,0),'courses',public.office_university_read(w,'courses','{}',50,0));
 ELSIF p_resource='key_config' THEN
  PERFORM office_private.university_require(w,ARRAY['registrar']);
  SELECT jsonb_build_object('configured',true,'key_version',key_version,'derivation',derivation,'iterations',iterations,'salt',encode(salt,'base64'),'nonce',encode(verifier_nonce,'base64'),'ciphertext',encode(verifier_ciphertext,'base64')) INTO result FROM public.office_university_key_configs WHERE workspace_id=w;
  RETURN coalesce(result,jsonb_build_object('configured',false));
 ELSIF p_resource='private_person' THEN
  PERFORM office_private.university_require(w,ARRAY['registrar']);
  SELECT jsonb_build_object('person_id',person_id,'nonce',encode(nonce,'base64'),'ciphertext',encode(ciphertext,'base64'),'version',version) INTO result FROM public.office_university_private_people WHERE workspace_id=w AND person_id=nullif(p_filter->>'person_id','')::uuid;
  IF result IS NULL THEN RAISE EXCEPTION 'Private record not found' USING ERRCODE='42501'; END IF; RETURN result;
 END IF;
 CASE p_resource
 WHEN 'terms' THEN tbl:='terms';cols:='term_id,label,academic_year,start_date,end_date,status,version';
 WHEN 'programmes' THEN tbl:='programmes';cols:='programme_id,code,name,award,status,version';
 WHEN 'courses' THEN tbl:='courses';cols:='course_id,programme_id,code,name,credits,status,version';
 WHEN 'staff' THEN PERFORM office_private.university_require(w,ARRAY['registrar']);tbl:='staff_roles';cols:='user_id,university_role,active,updated_at';
 WHEN 'assignments' THEN PERFORM office_private.university_require(w,ARRAY['registrar','lecturer']);tbl:='course_assignments';cols:='assignment_id,course_id,term_id,user_id,active';IF r='lecturer' THEN extra:=' AND t.user_id=$4';END IF;
 WHEN 'admissions' THEN PERFORM office_private.university_require(w,ARRAY['registrar']);tbl:='admissions';cols:='application_id,person_id,application_code,term_id,programme_id,status,version,created_at';
 WHEN 'students' THEN PERFORM office_private.university_require(w,ARRAY['registrar','lecturer','finance_officer']);tbl:='students';cols:='student_id,person_id,student_ref,programme_id,term_id,status,version';IF r='lecturer' THEN extra:=' AND EXISTS(SELECT 1 FROM public.office_university_registrations g WHERE g.workspace_id=t.workspace_id AND g.student_id=t.student_id AND g.status=''registered'' AND office_private.university_course_allowed(g.workspace_id,g.course_id,g.term_id))';END IF;
 WHEN 'registrations' THEN PERFORM office_private.university_require(w,ARRAY['registrar','lecturer']);tbl:='registrations';cols:='registration_id,student_id,course_id,term_id,status,version';IF r='lecturer' THEN extra:=' AND office_private.university_course_allowed(t.workspace_id,t.course_id,t.term_id)';END IF;
 WHEN 'assessments' THEN PERFORM office_private.university_require(w,ARRAY['registrar','lecturer']);tbl:='assessments';cols:='assessment_id,course_id,term_id,title,max_score,status,version';IF r='lecturer' THEN extra:=' AND office_private.university_course_allowed(t.workspace_id,t.course_id,t.term_id)';END IF;
 WHEN 'scores' THEN PERFORM office_private.university_require(w,ARRAY['registrar','lecturer']);tbl:='result_scores';cols:='assessment_id,student_id,score,version';extra:=' AND ($5->>''assessment_id'' IS NULL OR t.assessment_id=($5->>''assessment_id'')::uuid)';IF r='lecturer' THEN extra:=extra||' AND EXISTS(SELECT 1 FROM public.office_university_assessments a WHERE a.workspace_id=t.workspace_id AND a.assessment_id=t.assessment_id AND office_private.university_course_allowed(a.workspace_id,a.course_id,a.term_id))';END IF;
 WHEN 'fees' THEN PERFORM office_private.university_require(w,ARRAY['finance_officer']);tbl:='fees';cols:='charge_id,student_id,term_id,category,amount_tzs,paid_tzs,due_date,version';
 WHEN 'receipts' THEN PERFORM office_private.university_require(w,ARRAY['finance_officer']);tbl:='receipts';cols:='receipt_id,charge_id,receipt_number,amount_tzs,payment_method,reference,received_at';extra:=' AND ($5->>''charge_id'' IS NULL OR t.charge_id=($5->>''charge_id'')::uuid)';
 WHEN 'funding' THEN PERFORM office_private.university_require(w,ARRAY['finance_officer']);tbl:='funding_cases';cols:='funding_id,student_id,provider,academic_year,status,outcome,follow_up_due,version';
 WHEN 'transcripts' THEN PERFORM office_private.university_require(w,ARRAY['registrar']);tbl:='transcript_requests';cols:='request_id,student_id,copies,status,due_date,reference,version';
 WHEN 'research' THEN PERFORM office_private.university_require(w,ARRAY['research_coordinator']);tbl:='research_projects';cols:='project_id,title,proposal_status,ethics_status,university_clearance_status,permit_status,ethics_reference,clearance_reference,permit_reference,review_date,expiry_date,version';
 WHEN 'quality' THEN PERFORM office_private.university_require(w,ARRAY['quality_officer']);tbl:='quality_cases';cols:='case_id,programme_id,title,status,review_query,evidence_reference,due_date,version';
 WHEN 'audit' THEN PERFORM office_private.university_require(w,ARRAY[]::text[]);tbl:='audit';cols:='entry_id,actor_id,action,entity_type,entity_id,payload,created_at';
 ELSE RAISE EXCEPTION 'Unknown University resource' USING ERRCODE='22023';
 END CASE;
 q:=format('SELECT coalesce(jsonb_agg(x),''[]''::jsonb) FROM (SELECT %s FROM public.%I t WHERE t.workspace_id=$1%s ORDER BY %s LIMIT $2 OFFSET $3)x',cols,'office_university_'||tbl,extra,split_part(cols,',',1));
 EXECUTE q INTO result USING w,lim,off,auth.uid(),p_filter;RETURN result;
END $$;
CREATE FUNCTION office_private.university_academic_command(w uuid,a text,p jsonb,r text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE id uuid; pid uuid; v bigint; st text; c uuid; t uuid; sid uuid; amount numeric; item record; oldscore numeric;
BEGIN
 IF a='setup_key' THEN
  PERFORM office_private.university_require(w,ARRAY[]::text[]);
  INSERT INTO public.office_university_key_configs(workspace_id,salt,verifier_nonce,verifier_ciphertext,created_by) VALUES(w,decode(p->>'salt','base64'),decode(p->>'nonce','base64'),decode(p->>'ciphertext','base64'),auth.uid()); RETURN jsonb_build_object('configured',true);
 ELSIF a='set_staff_role' THEN
  PERFORM office_private.university_require(w,ARRAY[]::text[]);id:=(p->>'user_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.office_memberships WHERE workspace_id=w AND user_id=id AND status='active') THEN RAISE EXCEPTION 'Choose an active team member' USING ERRCODE='22023';END IF;
  INSERT INTO public.office_university_staff_roles(workspace_id,user_id,university_role,active,assigned_by) VALUES(w,id,p->>'university_role',coalesce((p->>'active')::boolean,true),auth.uid()) ON CONFLICT(workspace_id,user_id) DO UPDATE SET university_role=excluded.university_role,active=excluded.active,assigned_by=auth.uid(),updated_at=now();RETURN jsonb_build_object('user_id',id);
 ELSIF a IN('save_term','save_programme','save_course') THEN
  PERFORM office_private.university_require(w,ARRAY['registrar']);
  IF a='save_term' THEN
   id:=nullif(p->>'term_id','')::uuid;
   IF (p->>'start_date')::date IS NULL OR (p->>'end_date')::date IS NULL OR (p->>'start_date')::date>(p->>'end_date')::date THEN RAISE EXCEPTION 'Valid period date range required' USING ERRCODE='22023';END IF;
   IF id IS NULL THEN INSERT INTO public.office_university_terms(workspace_id,label,academic_year,start_date,end_date,status,created_by) VALUES(w,office_private.university_text(p->>'label','Period label',80),office_private.university_text(p->>'academic_year','Academic year',16),(p->>'start_date')::date,(p->>'end_date')::date,coalesce(nullif(p->>'status',''),'open'),auth.uid()) RETURNING term_id,version INTO id,v;
   ELSE SELECT version INTO v FROM public.office_university_terms WHERE workspace_id=w AND term_id=id FOR UPDATE;PERFORM office_private.university_expect(v,p->>'expected_version');UPDATE public.office_university_terms SET label=office_private.university_text(p->>'label','Period label',80),academic_year=office_private.university_text(p->>'academic_year','Academic year',16),start_date=(p->>'start_date')::date,end_date=(p->>'end_date')::date,status=p->>'status',version=version+1,updated_at=now() WHERE workspace_id=w AND term_id=id RETURNING version INTO v;END IF;RETURN jsonb_build_object('term_id',id,'version',v);
  ELSIF a='save_programme' THEN
   id:=nullif(p->>'programme_id','')::uuid;
   IF id IS NULL THEN INSERT INTO public.office_university_programmes(workspace_id,code,name,award,status,created_by) VALUES(w,office_private.university_text(p->>'code','Programme code',32),office_private.university_text(p->>'name','Programme name',160),office_private.university_text(p->>'award','Award',80,false),coalesce(nullif(p->>'status',''),'active'),auth.uid()) RETURNING programme_id,version INTO id,v;
   ELSE SELECT version INTO v FROM public.office_university_programmes WHERE workspace_id=w AND programme_id=id FOR UPDATE;PERFORM office_private.university_expect(v,p->>'expected_version');UPDATE public.office_university_programmes SET code=office_private.university_text(p->>'code','Programme code',32),name=office_private.university_text(p->>'name','Programme name',160),award=office_private.university_text(p->>'award','Award',80,false),status=p->>'status',version=version+1,updated_at=now() WHERE workspace_id=w AND programme_id=id RETURNING version INTO v;END IF;RETURN jsonb_build_object('programme_id',id,'version',v);
  ELSE
   id:=nullif(p->>'course_id','')::uuid;pid:=(p->>'programme_id')::uuid;
   IF NOT EXISTS(SELECT 1 FROM public.office_university_programmes WHERE workspace_id=w AND programme_id=pid AND status='active') THEN RAISE EXCEPTION 'Active programme required' USING ERRCODE='22023';END IF;
   IF id IS NULL THEN INSERT INTO public.office_university_courses(workspace_id,programme_id,code,name,credits,status,created_by) VALUES(w,pid,office_private.university_text(p->>'code','Course code',32),office_private.university_text(p->>'name','Course name',160),(p->>'credits')::numeric,coalesce(nullif(p->>'status',''),'active'),auth.uid()) RETURNING course_id,version INTO id,v;
   ELSE SELECT version INTO v FROM public.office_university_courses WHERE workspace_id=w AND course_id=id FOR UPDATE;PERFORM office_private.university_expect(v,p->>'expected_version');UPDATE public.office_university_courses SET programme_id=pid,code=office_private.university_text(p->>'code','Course code',32),name=office_private.university_text(p->>'name','Course name',160),credits=(p->>'credits')::numeric,status=p->>'status',version=version+1,updated_at=now() WHERE workspace_id=w AND course_id=id RETURNING version INTO v;END IF;RETURN jsonb_build_object('course_id',id,'version',v);
  END IF;
 ELSIF a='assign_lecturer' THEN
  PERFORM office_private.university_require(w,ARRAY['registrar']);id:=(p->>'user_id')::uuid;c:=(p->>'course_id')::uuid;t:=(p->>'term_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.office_university_staff_roles s JOIN public.office_memberships m USING(workspace_id,user_id) WHERE s.workspace_id=w AND s.user_id=id AND s.active AND s.university_role='lecturer' AND m.status='active') THEN RAISE EXCEPTION 'Active assigned lecturer role required' USING ERRCODE='22023';END IF;
  INSERT INTO public.office_university_course_assignments(workspace_id,course_id,term_id,user_id,active,created_by) VALUES(w,c,t,id,coalesce((p->>'active')::boolean,true),auth.uid()) ON CONFLICT(workspace_id,course_id,user_id,term_id) DO UPDATE SET active=excluded.active RETURNING assignment_id INTO id;RETURN jsonb_build_object('assignment_id',id);
 ELSIF a='create_application' THEN
  PERFORM office_private.university_require(w,ARRAY['registrar']);t:=(p->>'term_id')::uuid;pid:=(p->>'programme_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.office_university_key_configs WHERE workspace_id=w) THEN RAISE EXCEPTION 'Configure encryption before applicant intake' USING ERRCODE='22023';END IF;
  IF NOT EXISTS(SELECT 1 FROM public.office_university_terms WHERE workspace_id=w AND term_id=t AND status='open') OR NOT EXISTS(SELECT 1 FROM public.office_university_programmes WHERE workspace_id=w AND programme_id=pid AND status='active') THEN RAISE EXCEPTION 'Open period and active programme required' USING ERRCODE='22023';END IF;
  INSERT INTO public.office_university_people(workspace_id,person_ref,lifecycle,created_by) VALUES(w,'P-'||gen_random_uuid()::text,'applicant',auth.uid()) RETURNING person_id INTO id;
  INSERT INTO public.office_university_private_people(workspace_id,person_id,nonce,ciphertext,updated_by) VALUES(w,id,decode(p->>'private_nonce','base64'),decode(p->>'private_ciphertext','base64'),auth.uid());
  INSERT INTO public.office_university_admissions(workspace_id,person_id,application_code,term_id,programme_id,idempotency_key,created_by) VALUES(w,id,'APP-'||gen_random_uuid()::text,t,pid,(p->>'idempotency_key')::uuid,auth.uid()) RETURNING application_id INTO pid;RETURN jsonb_build_object('application_id',pid,'person_id',id,'version',1);
 ELSIF a IN('set_admission_status','register_student') THEN
  PERFORM office_private.university_require(w,ARRAY['registrar']);id:=(p->>'application_id')::uuid;SELECT * INTO item FROM public.office_university_admissions WHERE workspace_id=w AND application_id=id FOR UPDATE;PERFORM office_private.university_expect(item.version,p->>'expected_version');
  IF EXISTS(SELECT 1 FROM public.office_university_students WHERE workspace_id=w AND person_id=item.person_id) THEN RAISE EXCEPTION 'Applicant is already registered' USING ERRCODE='22023';END IF;
  IF a='register_student' THEN
   IF item.status<>'confirmed' THEN RAISE EXCEPTION 'Confirmed admission required' USING ERRCODE='22023';END IF;
   INSERT INTO public.office_university_students(workspace_id,person_id,student_ref,programme_id,term_id,created_by) VALUES(w,item.person_id,'STU-'||gen_random_uuid()::text,item.programme_id,item.term_id,auth.uid()) RETURNING student_id INTO sid;
   UPDATE public.office_university_people SET lifecycle='student' WHERE workspace_id=w AND person_id=item.person_id;
   UPDATE public.office_university_admissions SET version=version+1,updated_at=now() WHERE workspace_id=w AND application_id=id;RETURN jsonb_build_object('student_id',sid,'version',1);
  END IF;
  st:=p->>'status';IF NOT((item.status='submitted' AND st IN('reviewing','withdrawn')) OR (item.status='reviewing' AND st IN('offered','waitlisted','rejected','withdrawn')) OR (item.status='waitlisted' AND st IN('reviewing','offered','rejected','withdrawn')) OR (item.status='offered' AND st IN('accepted','rejected','withdrawn')) OR (item.status='accepted' AND st IN('confirmed','withdrawn'))) THEN RAISE EXCEPTION 'Invalid admission transition' USING ERRCODE='22023';END IF;
  UPDATE public.office_university_admissions SET status=st,version=version+1,updated_at=now() WHERE workspace_id=w AND application_id=id RETURNING version INTO v;RETURN jsonb_build_object('application_id',id,'version',v);
 ELSIF a='register_course' THEN
  PERFORM office_private.university_require(w,ARRAY['registrar']);sid:=(p->>'student_id')::uuid;c:=(p->>'course_id')::uuid;t:=(p->>'term_id')::uuid;
  IF NOT EXISTS(SELECT 1 FROM public.office_university_students s JOIN public.office_university_courses c ON c.workspace_id=s.workspace_id AND c.programme_id=s.programme_id WHERE s.workspace_id=w AND s.student_id=sid AND s.status='active' AND c.course_id=(p->>'course_id')::uuid AND c.status='active') OR NOT EXISTS(SELECT 1 FROM public.office_university_terms WHERE workspace_id=w AND term_id=t AND status='open') THEN RAISE EXCEPTION 'Active student, matching programme course and open period required' USING ERRCODE='22023';END IF;
  INSERT INTO public.office_university_registrations(workspace_id,student_id,course_id,term_id,created_by) VALUES(w,sid,c,t,auth.uid()) RETURNING registration_id INTO id;RETURN jsonb_build_object('registration_id',id,'version',1);
 ELSIF a IN('save_assessment','set_score','set_assessment_status') THEN
  PERFORM office_private.university_require(w,ARRAY['registrar','lecturer']);id:=nullif(p->>'assessment_id','')::uuid;
  IF id IS NOT NULL THEN SELECT * INTO item FROM public.office_university_assessments WHERE workspace_id=w AND assessment_id=id FOR UPDATE;IF item.assessment_id IS NULL THEN RAISE EXCEPTION 'Assessment unavailable' USING ERRCODE='42501';END IF;c:=item.course_id;t:=item.term_id;ELSE c:=(p->>'course_id')::uuid;t:=(p->>'term_id')::uuid;END IF;
  IF NOT office_private.university_course_allowed(w,c,t) THEN RAISE EXCEPTION 'Lecturer is not assigned to this course and period' USING ERRCODE='42501';END IF;
  IF a='save_assessment' THEN
   amount:=(p->>'max_score')::numeric;IF amount IS NULL OR amount<=0 OR amount>1000000 THEN RAISE EXCEPTION 'Valid maximum score required' USING ERRCODE='22023';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.office_university_courses WHERE workspace_id=w AND course_id=c AND status='active') OR NOT EXISTS(SELECT 1 FROM public.office_university_terms WHERE workspace_id=w AND term_id=t AND status='open') THEN RAISE EXCEPTION 'Active course and open period required' USING ERRCODE='22023';END IF;
   IF id IS NULL THEN INSERT INTO public.office_university_assessments(workspace_id,course_id,term_id,title,max_score,created_by) VALUES(w,c,t,office_private.university_text(p->>'title','Assessment title',160),amount,auth.uid()) RETURNING assessment_id,version INTO id,v;
   ELSE PERFORM office_private.university_expect(item.version,p->>'expected_version');IF item.status<>'draft' OR c<>(p->>'course_id')::uuid OR t<>(p->>'term_id')::uuid OR EXISTS(SELECT 1 FROM public.office_university_result_scores WHERE workspace_id=w AND assessment_id=id AND score>amount) THEN RAISE EXCEPTION 'Only a compatible draft assessment can be edited' USING ERRCODE='22023';END IF;UPDATE public.office_university_assessments SET title=office_private.university_text(p->>'title','Assessment title',160),max_score=amount,version=version+1,updated_at=now() WHERE workspace_id=w AND assessment_id=id RETURNING version INTO v;END IF;RETURN jsonb_build_object('assessment_id',id,'version',v);
  ELSIF a='set_score' THEN
   IF item.status<>'draft' THEN RAISE EXCEPTION 'Scores are locked' USING ERRCODE='22023';END IF;sid:=(p->>'student_id')::uuid;amount:=(p->>'score')::numeric;
   IF amount IS NULL OR amount<0 OR amount>item.max_score OR NOT EXISTS(SELECT 1 FROM public.office_university_registrations WHERE workspace_id=w AND student_id=sid AND course_id=c AND term_id=t AND status='registered') THEN RAISE EXCEPTION 'Valid score and registered student required' USING ERRCODE='22023';END IF;
   SELECT version INTO v FROM public.office_university_result_scores WHERE workspace_id=w AND assessment_id=id AND student_id=sid FOR UPDATE;PERFORM office_private.university_expect(coalesce(v,0),p->>'expected_version');
   INSERT INTO public.office_university_result_scores(workspace_id,assessment_id,student_id,score,updated_by) VALUES(w,id,sid,amount,auth.uid()) ON CONFLICT(workspace_id,assessment_id,student_id) DO UPDATE SET score=excluded.score,version=public.office_university_result_scores.version+1,updated_by=auth.uid(),updated_at=now() RETURNING version INTO v;
   UPDATE public.office_university_assessments SET version=version+1,updated_at=now() WHERE workspace_id=w AND assessment_id=id;RETURN jsonb_build_object('assessment_id',id,'student_id',sid,'version',v);
  ELSE
   PERFORM office_private.university_expect(item.version,p->>'expected_version');st:=p->>'status';
   IF st='approved' THEN PERFORM office_private.university_require(w,ARRAY['registrar']);END IF;
   IF NOT((item.status='draft' AND st='locked') OR(item.status='locked' AND st='approved')) THEN RAISE EXCEPTION 'Invalid assessment transition' USING ERRCODE='22023';END IF;
   IF NOT EXISTS(SELECT 1 FROM public.office_university_result_scores WHERE workspace_id=w AND assessment_id=id) OR EXISTS(SELECT 1 FROM public.office_university_registrations g WHERE g.workspace_id=w AND g.course_id=c AND g.term_id=t AND g.status='registered' AND NOT EXISTS(SELECT 1 FROM public.office_university_result_scores s WHERE s.workspace_id=w AND s.assessment_id=id AND s.student_id=g.student_id)) THEN RAISE EXCEPTION 'Enter all registered student scores before locking' USING ERRCODE='22023';END IF;
   UPDATE public.office_university_assessments SET status=st,version=version+1,updated_at=now() WHERE workspace_id=w AND assessment_id=id RETURNING version INTO v;RETURN jsonb_build_object('assessment_id',id,'version',v);
  END IF;
 ELSE RAISE EXCEPTION 'Unknown academic command' USING ERRCODE='22023';END IF;
END $$;

CREATE OR REPLACE FUNCTION office_private.university_operations_command(
  w uuid,
  a text,
  p jsonb,
  r text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
#variable_conflict use_variable
DECLARE
  role_name text;
  entity_id uuid;
  student_id uuid;
  term_id uuid;
  programme_id uuid;
  charge_id uuid;
  request_id uuid;
  project_id uuid;
  case_id uuid;
  funding_id uuid;
  idem uuid;
  actual_version bigint;
  new_version bigint;
  amount numeric;
  charge_total numeric;
  paid numeric;
  copies integer;
  category text;
  provider text;
  outcome text;
  reference text;
  receipt_number text;
  review_date date;
  expiry_date date;
  due_date date;
  title text;
  status text;
  proposal_status text;
  ethics_status text;
  clearance_status text;
  permit_status text;
  review_query text;
  evidence_reference text;
  v_has_id boolean;
BEGIN
  IF p IS NULL OR jsonb_typeof(p) <> 'object' THEN
    RAISE EXCEPTION 'Payload must be a JSON object' USING ERRCODE = '22023';
  END IF;

  IF a NOT IN ('create_charge','record_receipt','save_funding','save_transcript','save_research','save_quality') THEN
    RAISE EXCEPTION 'Unknown University operation' USING ERRCODE = '22023';
  END IF;

  IF a IN ('create_charge','record_receipt','save_funding') THEN
    role_name := office_private.university_require(w, ARRAY['university_admin','finance_officer']);
  ELSIF a = 'save_transcript' THEN
    role_name := office_private.university_require(w, ARRAY['university_admin','registrar']);
  ELSIF a = 'save_research' THEN
    role_name := office_private.university_require(w, ARRAY['university_admin','research_coordinator']);
  ELSE
    role_name := office_private.university_require(w, ARRAY['university_admin','quality_officer']);
  END IF;

  IF a = 'create_charge' THEN
    BEGIN
      student_id := (p->>'student_id')::uuid;
      term_id := (p->>'term_id')::uuid;
      idem := (p->>'idempotency_key')::uuid;
      amount := (p->>'amount_tzs')::numeric;
      due_date := CASE WHEN nullif(p->>'due_date','') IS NULL THEN NULL ELSE (p->>'due_date')::date END;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Invalid charge identifier, amount, date, or idempotency key' USING ERRCODE = '22023';
    END;
    IF student_id IS NULL OR term_id IS NULL OR idem IS NULL OR amount IS NULL OR amount <= 0 OR amount <> amount OR amount::text IN ('Infinity','-Infinity','NaN') THEN
      RAISE EXCEPTION 'Charge requires a positive finite amount, student, term, and idempotency key' USING ERRCODE = '22023';
    END IF;
    category := office_private.university_text(p->>'category','category',80,true);
    IF due_date IS NOT NULL AND due_date < DATE '2000-01-01' THEN
      RAISE EXCEPTION 'Due date is outside the valid range' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.office_university_students s
      WHERE s.workspace_id=w AND s.student_id=student_id AND s.status='active'
    ) THEN
      RAISE EXCEPTION 'Active student is required' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.office_university_terms t
      WHERE t.workspace_id=w AND t.term_id=term_id AND t.status='open'
    ) THEN
      RAISE EXCEPTION 'Open term is required' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.office_university_fees
      (workspace_id,student_id,term_id,category,amount_tzs,due_date,created_by)
    VALUES (w,student_id,term_id,category,amount,due_date,auth.uid())
    RETURNING office_university_fees.charge_id,office_university_fees.version INTO entity_id,new_version;
    RETURN jsonb_build_object('charge_id',entity_id,'id',entity_id,'version',new_version);

  ELSIF a = 'record_receipt' THEN
    BEGIN
      charge_id := (p->>'charge_id')::uuid;
      idem := (p->>'idempotency_key')::uuid;
      amount := (p->>'amount_tzs')::numeric;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Invalid receipt identifier, amount, or idempotency key' USING ERRCODE = '22023';
    END;
    IF charge_id IS NULL OR idem IS NULL OR amount IS NULL OR amount <= 0 OR amount <> amount OR amount::text IN ('Infinity','-Infinity','NaN') THEN
      RAISE EXCEPTION 'Receipt requires a positive finite amount, charge, and idempotency key' USING ERRCODE = '22023';
    END IF;
    status := p->>'payment_method';
    IF status IS NULL OR status NOT IN ('cash','bank','mobile_money','other') THEN
      RAISE EXCEPTION 'Invalid payment method' USING ERRCODE = '22023';
    END IF;
    reference := office_private.university_text(p->>'reference','reference',160,false);
    SELECT f.amount_tzs,f.paid_tzs,f.version INTO charge_total,paid,actual_version
      FROM public.office_university_fees f
      WHERE f.workspace_id=w AND f.charge_id=charge_id
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Charge not found in workspace' USING ERRCODE = '22023';
    END IF;
    -- Re-read the submitted amount after locking the charge row.
    BEGIN
      amount := (p->>'amount_tzs')::numeric;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Invalid receipt amount' USING ERRCODE = '22023';
    END;
    IF amount > (charge_total - paid) THEN
      RAISE EXCEPTION 'Receipt exceeds the outstanding charge balance' USING ERRCODE = '22023';
    END IF;
    LOOP
      receipt_number := 'RCT-' || replace(gen_random_uuid()::text,'-','');
      BEGIN
        INSERT INTO public.office_university_receipts
          (workspace_id,charge_id,receipt_number,amount_tzs,payment_method,reference,idempotency_key,created_by)
        VALUES (w,charge_id,receipt_number,amount,status,reference,idem,auth.uid())
        RETURNING receipt_id INTO entity_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        -- A receipt number collision is retried; idempotency conflicts are surfaced.
        IF EXISTS (SELECT 1 FROM public.office_university_receipts x WHERE x.workspace_id=w AND x.idempotency_key=idem) THEN
          RAISE EXCEPTION 'Receipt idempotency key already exists' USING ERRCODE = '22023';
        END IF;
      END;
    END LOOP;
    UPDATE public.office_university_fees f
      SET paid_tzs=f.paid_tzs+amount, version=f.version+1, updated_at=now()
      WHERE f.workspace_id=w AND f.charge_id=charge_id
      RETURNING f.version INTO new_version;
    RETURN jsonb_build_object('receipt_id',entity_id,'id',entity_id,'version',new_version);

  ELSIF a = 'save_funding' THEN
    v_has_id := nullif(p->>'funding_id','') IS NOT NULL;
    BEGIN
      IF v_has_id THEN funding_id := (p->>'funding_id')::uuid; END IF;
      IF NOT v_has_id THEN idem := (p->>'idempotency_key')::uuid; END IF;
      student_id := (p->>'student_id')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'Invalid funding identifier, student, or idempotency key' USING ERRCODE = '22023';
    END;
    IF student_id IS NULL OR (NOT v_has_id AND idem IS NULL) THEN
      RAISE EXCEPTION 'Funding requires a student and idempotency key on create' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.office_university_students s WHERE s.workspace_id=w AND s.student_id=student_id) THEN
      RAISE EXCEPTION 'Student is not in this workspace' USING ERRCODE = '22023';
    END IF;
    provider := office_private.university_text(p->>'provider','provider',160,true);
    category := office_private.university_text(p->>'academic_year','academic_year',16,true);
    IF category !~ '^[0-9]{4}([/-][0-9]{2,4})?$' THEN
      RAISE EXCEPTION 'Invalid academic year' USING ERRCODE = '22023';
    END IF;
    status := p->>'status';
    IF status IS NULL OR status NOT IN ('not_started','submitted','document_check','allocated','appeal','disbursement_pending','reconciled','closed') THEN
      RAISE EXCEPTION 'Invalid funding status' USING ERRCODE = '22023';
    END IF;
    outcome := office_private.university_text(p->>'outcome','outcome',500,false);
    BEGIN due_date := CASE WHEN nullif(p->>'follow_up_due','') IS NULL THEN NULL ELSE (p->>'follow_up_due')::date END; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Invalid follow-up date' USING ERRCODE='22023'; END;
    IF v_has_id THEN
      SELECT version INTO actual_version FROM public.office_university_funding_cases z WHERE z.workspace_id=w AND z.funding_id=funding_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Funding case not found in workspace' USING ERRCODE='22023'; END IF;
      PERFORM office_private.university_expect(actual_version,p->>'expected_version');
      UPDATE public.office_university_funding_cases f SET student_id=student_id,provider=provider,academic_year=category,status=status,outcome=outcome,follow_up_due=due_date,version=f.version+1,updated_at=now() WHERE f.workspace_id=w AND f.funding_id=funding_id RETURNING f.version INTO new_version;
      entity_id:=funding_id;
    ELSE
      INSERT INTO public.office_university_funding_cases(workspace_id,student_id,provider,academic_year,status,outcome,follow_up_due,created_by) VALUES(w,student_id,provider,category,status,outcome,due_date,auth.uid()) RETURNING office_university_funding_cases.funding_id,office_university_funding_cases.version INTO entity_id,new_version;
    END IF;
    RETURN jsonb_build_object('funding_id',entity_id,'id',entity_id,'version',new_version);

  ELSIF a = 'save_transcript' THEN
    v_has_id := nullif(p->>'request_id','') IS NOT NULL;
    BEGIN
      IF v_has_id THEN request_id := (p->>'request_id')::uuid; END IF;
      IF NOT v_has_id THEN idem := (p->>'idempotency_key')::uuid; END IF;
      student_id := (p->>'student_id')::uuid;
      copies := (p->>'copies')::integer;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Invalid transcript identifier, student, copies, or idempotency key' USING ERRCODE='22023';
    END;
    IF student_id IS NULL OR copies IS NULL OR copies NOT BETWEEN 1 AND 20 OR (NOT v_has_id AND idem IS NULL) THEN RAISE EXCEPTION 'Transcript requires an active student, copies 1..20, and idempotency key on create' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.office_university_students s WHERE s.workspace_id=w AND s.student_id=student_id AND s.status='active') THEN RAISE EXCEPTION 'Active student is required' USING ERRCODE='22023'; END IF;
    status:=p->>'status'; IF status IS NULL OR status NOT IN ('requested','payment_pending','processing','ready','completed','declined') THEN RAISE EXCEPTION 'Invalid transcript status' USING ERRCODE='22023'; END IF;
    reference:=office_private.university_text(p->>'reference','reference',160,false);
    BEGIN due_date:=CASE WHEN nullif(p->>'due_date','') IS NULL THEN NULL ELSE (p->>'due_date')::date END; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Invalid transcript due date' USING ERRCODE='22023'; END;
    IF v_has_id THEN
      SELECT version INTO actual_version FROM public.office_university_transcript_requests z WHERE z.workspace_id=w AND z.request_id=request_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Transcript request not found in workspace' USING ERRCODE='22023'; END IF;
      PERFORM office_private.university_expect(actual_version,p->>'expected_version');
      UPDATE public.office_university_transcript_requests t SET student_id=student_id,copies=copies,status=status,due_date=due_date,reference=reference,version=t.version+1,updated_at=now() WHERE t.workspace_id=w AND t.request_id=request_id RETURNING t.version INTO new_version;
      entity_id:=request_id;
    ELSE
      INSERT INTO public.office_university_transcript_requests(workspace_id,student_id,copies,status,due_date,reference,idempotency_key,created_by) VALUES(w,student_id,copies,status,due_date,reference,idem,auth.uid()) RETURNING office_university_transcript_requests.request_id,office_university_transcript_requests.version INTO entity_id,new_version;
    END IF;
    RETURN jsonb_build_object('request_id',entity_id,'id',entity_id,'version',new_version);

  ELSIF a = 'save_research' THEN
    v_has_id := nullif(p->>'project_id','') IS NOT NULL;
    BEGIN IF v_has_id THEN project_id:=(p->>'project_id')::uuid; END IF; IF NOT v_has_id THEN idem:=(p->>'idempotency_key')::uuid; END IF; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Invalid research identifier or idempotency key' USING ERRCODE='22023'; END;
    IF NOT v_has_id AND idem IS NULL THEN RAISE EXCEPTION 'Research create requires idempotency key' USING ERRCODE='22023'; END IF;
    title:=office_private.university_text(p->>'title','title',240,true);
    proposal_status:=p->>'proposal_status'; ethics_status:=p->>'ethics_status'; clearance_status:=p->>'university_clearance_status'; permit_status:=p->>'permit_status';
    IF proposal_status NOT IN ('draft','submitted','approved','rejected') OR ethics_status NOT IN ('not_required','not_started','submitted','approved','expired') OR clearance_status NOT IN ('not_started','submitted','approved','expired') OR permit_status NOT IN ('not_required','not_started','submitted','approved','expired') THEN RAISE EXCEPTION 'Invalid research status' USING ERRCODE='22023'; END IF;
    reference:=office_private.university_text(p->>'ethics_reference','ethics_reference',160,false); evidence_reference:=office_private.university_text(p->>'clearance_reference','clearance_reference',160,false); review_query:=office_private.university_text(p->>'permit_reference','permit_reference',160,false);
    IF ethics_status='approved' AND nullif(reference,'') IS NULL THEN RAISE EXCEPTION 'Approved ethics requires a reference' USING ERRCODE='22023'; END IF;
    IF clearance_status='approved' AND nullif(evidence_reference,'') IS NULL THEN RAISE EXCEPTION 'Approved university clearance requires a reference' USING ERRCODE='22023'; END IF;
    IF permit_status='approved' AND nullif(review_query,'') IS NULL THEN RAISE EXCEPTION 'Approved permit requires a reference' USING ERRCODE='22023'; END IF;
    BEGIN review_date:=CASE WHEN nullif(p->>'review_date','') IS NULL THEN NULL ELSE (p->>'review_date')::date END; expiry_date:=CASE WHEN nullif(p->>'expiry_date','') IS NULL THEN NULL ELSE (p->>'expiry_date')::date END; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Invalid research date' USING ERRCODE='22023'; END;
    IF review_date IS NOT NULL AND (review_date<DATE '2000-01-01' OR review_date>DATE '2100-12-31') OR expiry_date IS NOT NULL AND (expiry_date<DATE '2000-01-01' OR expiry_date>DATE '2100-12-31') OR expiry_date IS NOT NULL AND review_date IS NOT NULL AND expiry_date<review_date THEN RAISE EXCEPTION 'Research dates are not sensible' USING ERRCODE='22023'; END IF;
    IF v_has_id THEN
      SELECT version INTO actual_version FROM public.office_university_research_projects z WHERE z.workspace_id=w AND z.project_id=project_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Research project not found in workspace' USING ERRCODE='22023'; END IF;
      PERFORM office_private.university_expect(actual_version,p->>'expected_version');
      UPDATE public.office_university_research_projects x SET title=title,proposal_status=proposal_status,ethics_status=ethics_status,university_clearance_status=clearance_status,permit_status=permit_status,ethics_reference=reference,clearance_reference=evidence_reference,permit_reference=review_query,review_date=review_date,expiry_date=expiry_date,version=x.version+1,updated_at=now() WHERE x.workspace_id=w AND x.project_id=project_id RETURNING x.version INTO new_version; entity_id:=project_id;
    ELSE
      INSERT INTO public.office_university_research_projects(workspace_id,title,proposal_status,ethics_status,university_clearance_status,permit_status,ethics_reference,clearance_reference,permit_reference,review_date,expiry_date,idempotency_key,created_by) VALUES(w,title,proposal_status,ethics_status,clearance_status,permit_status,reference,evidence_reference,review_query,review_date,expiry_date,idem,auth.uid()) RETURNING office_university_research_projects.project_id,office_university_research_projects.version INTO entity_id,new_version;
    END IF;
    RETURN jsonb_build_object('project_id',entity_id,'id',entity_id,'version',new_version);

  ELSE
    v_has_id:=nullif(p->>'case_id','') IS NOT NULL;
    BEGIN IF v_has_id THEN case_id:=(p->>'case_id')::uuid; END IF; IF NOT v_has_id THEN idem:=(p->>'idempotency_key')::uuid; END IF; programme_id:=(p->>'programme_id')::uuid; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Invalid quality identifier, programme, or idempotency key' USING ERRCODE='22023'; END;
    IF programme_id IS NULL OR (NOT v_has_id AND idem IS NULL) THEN RAISE EXCEPTION 'Quality case requires programme and idempotency key on create' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.office_university_programmes q WHERE q.workspace_id=w AND q.programme_id=programme_id) THEN RAISE EXCEPTION 'Programme is not in this workspace' USING ERRCODE='22023'; END IF;
    title:=office_private.university_text(p->>'title','title',240,true); status:=p->>'status'; IF status NOT IN ('draft','submitted','queries','approved','renewal_due','closed') THEN RAISE EXCEPTION 'Invalid quality status' USING ERRCODE='22023'; END IF;
    review_query:=office_private.university_text(p->>'review_query','review_query',2000,false); evidence_reference:=office_private.university_text(p->>'evidence_reference','evidence_reference',500,false); IF status='approved' AND nullif(evidence_reference,'') IS NULL THEN RAISE EXCEPTION 'Approved quality case requires evidence reference' USING ERRCODE='22023'; END IF;
    BEGIN due_date:=CASE WHEN nullif(p->>'due_date','') IS NULL THEN NULL ELSE (p->>'due_date')::date END; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Invalid quality due date' USING ERRCODE='22023'; END;
    IF v_has_id THEN SELECT version INTO actual_version FROM public.office_university_quality_cases z WHERE z.workspace_id=w AND z.case_id=case_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Quality case not found in workspace' USING ERRCODE='22023'; END IF; PERFORM office_private.university_expect(actual_version,p->>'expected_version'); UPDATE public.office_university_quality_cases x SET programme_id=programme_id,title=title,status=status,review_query=review_query,evidence_reference=evidence_reference,due_date=due_date,version=x.version+1 WHERE x.workspace_id=w AND x.case_id=case_id RETURNING x.version INTO new_version; entity_id:=case_id;
    ELSE INSERT INTO public.office_university_quality_cases(workspace_id,programme_id,title,status,review_query,evidence_reference,due_date,idempotency_key,created_by) VALUES(w,programme_id,title,status,review_query,evidence_reference,due_date,idem,auth.uid()) RETURNING office_university_quality_cases.case_id,office_university_quality_cases.version INTO entity_id,new_version; END IF;
    RETURN jsonb_build_object('case_id',entity_id,'id',entity_id,'version',new_version);
  END IF;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Invalid University operation payload' USING ERRCODE='22023';
END;
$function$;

REVOKE ALL ON FUNCTION office_private.university_operations_command(uuid,text,jsonb,text) FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.office_university_requests(
 workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
 idempotency_key uuid NOT NULL, actor_id uuid NOT NULL REFERENCES auth.users(id),
 action text NOT NULL, request_hash text NOT NULL, response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(workspace_id,idempotency_key)
);
CREATE FUNCTION public.office_university_command(p_workspace_id uuid,p_action text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE r text; k uuid; prior public.office_university_requests%ROWTYPE; result jsonb; required_key boolean; fields jsonb;
BEGIN
 r:=office_private.university_require(p_workspace_id,NULL);
 IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR octet_length(p_payload::text)>65536 THEN RAISE EXCEPTION 'A valid University command object is required' USING ERRCODE='22023';END IF;
 required_key:=p_action IN('create_application','register_student','register_course','create_charge','record_receipt') OR
  (p_action='save_term' AND nullif(p_payload->>'term_id','') IS NULL) OR
  (p_action='save_programme' AND nullif(p_payload->>'programme_id','') IS NULL) OR
  (p_action='save_course' AND nullif(p_payload->>'course_id','') IS NULL) OR
  (p_action='save_assessment' AND nullif(p_payload->>'assessment_id','') IS NULL) OR
  (p_action='save_funding' AND nullif(p_payload->>'funding_id','') IS NULL) OR
  (p_action='save_transcript' AND nullif(p_payload->>'request_id','') IS NULL) OR
  (p_action='save_research' AND nullif(p_payload->>'project_id','') IS NULL) OR
  (p_action='save_quality' AND nullif(p_payload->>'case_id','') IS NULL);
 k:=nullif(p_payload->>'idempotency_key','')::uuid;
 IF required_key AND k IS NULL THEN RAISE EXCEPTION 'A secure retry key is required' USING ERRCODE='22023';END IF;
 IF k IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_workspace_id::text||k::text,0));
  SELECT * INTO prior FROM public.office_university_requests WHERE workspace_id=p_workspace_id AND idempotency_key=k;
  IF FOUND THEN
   IF prior.actor_id<>auth.uid() OR prior.action<>p_action OR prior.request_hash<>md5(p_payload::text) THEN RAISE EXCEPTION 'Retry key was already used for a different request' USING ERRCODE='22023';END IF;
   RETURN prior.response;
  END IF;
 END IF;
 IF p_action IN('setup_key','set_staff_role','save_term','save_programme','save_course','assign_lecturer','create_application','set_admission_status','register_student','register_course','save_assessment','set_score','set_assessment_status') THEN
  result:=office_private.university_academic_command(p_workspace_id,p_action,p_payload,r);
 ELSIF p_action IN('create_charge','record_receipt','save_funding','save_transcript','save_research','save_quality') THEN
  result:=office_private.university_operations_command(p_workspace_id,p_action,p_payload,r);
 ELSE RAISE EXCEPTION 'Unknown University command' USING ERRCODE='22023';END IF;
 SELECT coalesce(jsonb_agg(key ORDER BY key),'[]'::jsonb) INTO fields FROM jsonb_object_keys(p_payload) AS key;
 INSERT INTO public.office_university_audit(workspace_id,actor_id,action,entity_type,payload) VALUES(p_workspace_id,auth.uid(),p_action,'university',jsonb_build_object('changed_fields',fields));
 IF k IS NOT NULL THEN INSERT INTO public.office_university_requests(workspace_id,idempotency_key,actor_id,action,request_hash,response) VALUES(p_workspace_id,k,auth.uid(),p_action,md5(p_payload::text),result);END IF;
 RETURN result;
END $$;
CREATE FUNCTION office_private.university_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$ BEGIN RAISE EXCEPTION 'University audit and receipt records are append-only' USING ERRCODE='42501';END $$;
CREATE TRIGGER office_university_audit_immutable BEFORE UPDATE OR DELETE ON public.office_university_audit FOR EACH ROW EXECUTE FUNCTION office_private.university_immutable();
CREATE TRIGGER office_university_audit_no_truncate BEFORE TRUNCATE ON public.office_university_audit FOR EACH STATEMENT EXECUTE FUNCTION office_private.university_immutable();
CREATE TRIGGER office_university_receipts_immutable BEFORE UPDATE OR DELETE ON public.office_university_receipts FOR EACH ROW EXECUTE FUNCTION office_private.university_immutable();
CREATE TRIGGER office_university_receipts_no_truncate BEFORE TRUNCATE ON public.office_university_receipts FOR EACH STATEMENT EXECUTE FUNCTION office_private.university_immutable();
DO $$ DECLARE item record;BEGIN
 FOR item IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname LIKE 'office_university_%' LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',item.relname);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC,anon,authenticated,service_role',item.relname);
 END LOOP;
 FOR item IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname='office_private' AND p.proname LIKE 'university_%') OR (n.nspname='public' AND p.proname LIKE 'office_university_%') LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',item.signature);
 END LOOP;
END $$;
REVOKE ALL ON SEQUENCE public.office_university_audit_entry_id_seq FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.office_university_read(uuid,text,jsonb,integer,integer),public.office_university_command(uuid,text,jsonb) TO authenticated;
COMMENT ON TABLE public.office_university_private_people IS 'Client-side AES-256-GCM ciphertext only. Passphrases and private identity plaintext are never submitted to the server.';
COMMENT ON TABLE public.office_university_receipts IS 'Append-only manual operational receipts, not a payment gateway, bank confirmation or statutory tax receipt.';
COMMENT ON TABLE public.office_university_funding_cases IS 'Human-entered funding follow-up; no HESLB connection or allocation authority.';
COMMIT;
