\set ON_ERROR_STOP on
INSERT INTO auth.users(id) VALUES('11111111-1111-4111-8111-111111111111'),('22222222-2222-4222-8222-222222222222'),('33333333-3333-4333-8333-333333333333'),('44444444-4444-4444-8444-444444444444');
INSERT INTO public.office_workspaces(id) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
INSERT INTO public.office_industry_spaces(workspace_id,industry_id) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','university'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','school');
INSERT INTO public.office_memberships(workspace_id,user_id,role) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','11111111-1111-4111-8111-111111111111','owner'),('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','22222222-2222-4222-8222-222222222222','member'),('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','33333333-3333-4333-8333-333333333333','member'),('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','11111111-1111-4111-8111-111111111111','owner');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
DO $$
DECLARE w uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; t uuid; p uuid;c uuid;c2 uuid;app uuid;sid uuid;ass uuid;charge uuid;fid uuid;req uuid;proj uuid;qa uuid; result jsonb; payload jsonb; original jsonb; ver bigint;
BEGIN
 PERFORM public.office_university_command(w,'setup_key',jsonb_build_object('salt',encode(decode(repeat('01',16),'hex'),'base64'),'nonce',encode(decode(repeat('02',12),'hex'),'base64'),'ciphertext',encode(decode(repeat('03',32),'hex'),'base64')));
 IF public.office_university_read(w,'key_config')->>'configured'<>'true' THEN RAISE EXCEPTION 'Key config failed';END IF;
 payload:=jsonb_build_object('label','Semester 1','academic_year','2026/2027','start_date','2026-10-01','end_date','2027-02-28','status','open','idempotency_key',gen_random_uuid());
 original:=public.office_university_command(w,'save_term',payload);t:=(original->>'term_id')::uuid;
 IF public.office_university_command(w,'save_term',payload)<>original THEN RAISE EXCEPTION 'Retry did not return original';END IF;
 BEGIN PERFORM public.office_university_command(w,'save_term',payload||'{"label":"changed"}');RAISE EXCEPTION 'Changed retry accepted';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 result:=public.office_university_command(w,'save_programme',jsonb_build_object('code','BSC','name','Synthetic Science','award','Bachelor','status','active','idempotency_key',gen_random_uuid()));p:=(result->>'programme_id')::uuid;
 BEGIN PERFORM public.office_university_command(w,'save_programme',jsonb_build_object('programme_id',p,'expected_version',99,'code','BSC','name','Stale','award','Bachelor','status','active'));RAISE EXCEPTION 'Stale version accepted';EXCEPTION WHEN SQLSTATE '40001' THEN NULL;END;
 result:=public.office_university_command(w,'save_course',jsonb_build_object('programme_id',p,'code','SCI101','name','Synthetic Course','credits',10,'status','active','idempotency_key',gen_random_uuid()));c:=(result->>'course_id')::uuid;
 result:=public.office_university_command(w,'save_course',jsonb_build_object('programme_id',p,'code','SCI102','name','Unassigned Course','credits',10,'status','active','idempotency_key',gen_random_uuid()));c2:=(result->>'course_id')::uuid;
 PERFORM public.office_university_command(w,'set_staff_role','{"user_id":"22222222-2222-4222-8222-222222222222","university_role":"lecturer","active":true}');
 PERFORM public.office_university_command(w,'set_staff_role','{"user_id":"33333333-3333-4333-8333-333333333333","university_role":"finance_officer","active":true}');
 PERFORM public.office_university_command(w,'assign_lecturer',jsonb_build_object('user_id','22222222-2222-4222-8222-222222222222','course_id',c,'term_id',t,'active',true));
 payload:=jsonb_build_object('term_id',t,'programme_id',p,'private_nonce',encode(decode(repeat('04',12),'hex'),'base64'),'private_ciphertext',encode(decode(repeat('05',64),'hex'),'base64'),'idempotency_key',gen_random_uuid());result:=public.office_university_command(w,'create_application',payload);app:=(result->>'application_id')::uuid;
 IF public.office_university_read(w,'private_person',jsonb_build_object('person_id',result->>'person_id'))->>'ciphertext' IS NULL THEN RAISE EXCEPTION 'Private ciphertext unavailable';END IF;
 BEGIN PERFORM public.office_university_command(w,'set_admission_status',jsonb_build_object('application_id',app,'expected_version',1,'status','confirmed'));RAISE EXCEPTION 'Invalid admission jump accepted';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 PERFORM public.office_university_command(w,'set_admission_status',jsonb_build_object('application_id',app,'expected_version',1,'status','reviewing'));
 PERFORM public.office_university_command(w,'set_admission_status',jsonb_build_object('application_id',app,'expected_version',2,'status','offered'));
 PERFORM public.office_university_command(w,'set_admission_status',jsonb_build_object('application_id',app,'expected_version',3,'status','accepted'));
 PERFORM public.office_university_command(w,'set_admission_status',jsonb_build_object('application_id',app,'expected_version',4,'status','confirmed'));
 payload:=jsonb_build_object('application_id',app,'expected_version',5,'idempotency_key',gen_random_uuid());original:=public.office_university_command(w,'register_student',payload);sid:=(original->>'student_id')::uuid;
 IF public.office_university_command(w,'register_student',payload)<>original THEN RAISE EXCEPTION 'Registration retry failed';END IF;
 PERFORM public.office_university_command(w,'register_course',jsonb_build_object('student_id',sid,'course_id',c,'term_id',t,'idempotency_key',gen_random_uuid()));
 result:=public.office_university_command(w,'save_assessment',jsonb_build_object('course_id',c,'term_id',t,'title','Synthetic examination','max_score',100,'idempotency_key',gen_random_uuid()));ass:=(result->>'assessment_id')::uuid;
 BEGIN PERFORM public.office_university_command(w,'set_score',jsonb_build_object('assessment_id',ass,'student_id',sid,'score',101,'expected_version',0));RAISE EXCEPTION 'Over-maximum score accepted';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 PERFORM public.office_university_command(w,'set_score',jsonb_build_object('assessment_id',ass,'student_id',sid,'score',82,'expected_version',0));
 PERFORM public.office_university_command(w,'set_assessment_status',jsonb_build_object('assessment_id',ass,'expected_version',2,'status','locked'));
 PERFORM public.office_university_command(w,'set_assessment_status',jsonb_build_object('assessment_id',ass,'expected_version',3,'status','approved'));
 BEGIN PERFORM public.office_university_command(w,'set_score',jsonb_build_object('assessment_id',ass,'student_id',sid,'score',80,'expected_version',1));RAISE EXCEPTION 'Locked score changed';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 PERFORM public.office_university_command(w,'save_assessment',jsonb_build_object('course_id',c2,'term_id',t,'title','Private other course','max_score',100,'idempotency_key',gen_random_uuid()));
 result:=public.office_university_command(w,'create_charge',jsonb_build_object('student_id',sid,'term_id',t,'category','Tuition','amount_tzs',100000,'due_date','2027-01-01','idempotency_key',gen_random_uuid()));charge:=(result->>'charge_id')::uuid;
 payload:=jsonb_build_object('charge_id',charge,'amount_tzs',60000,'payment_method','bank','reference','SYNTHETIC','idempotency_key',gen_random_uuid());original:=public.office_university_command(w,'record_receipt',payload);
 IF public.office_university_command(w,'record_receipt',payload)<>original THEN RAISE EXCEPTION 'Receipt retry failed';END IF;
 BEGIN PERFORM public.office_university_command(w,'record_receipt',payload||jsonb_build_object('amount_tzs',50000,'idempotency_key',gen_random_uuid()));RAISE EXCEPTION 'Overpayment accepted';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 result:=public.office_university_command(w,'save_funding',jsonb_build_object('student_id',sid,'provider','HESLB','academic_year','2026/2027','status','submitted','outcome','','follow_up_due','2027-01-01','idempotency_key',gen_random_uuid()));fid:=(result->>'funding_id')::uuid;
 PERFORM public.office_university_command(w,'save_funding',jsonb_build_object('funding_id',fid,'expected_version',1,'student_id',sid,'provider','HESLB','academic_year','2026/2027','status','document_check','outcome','Awaiting verified response','follow_up_due','2027-01-02'));
 result:=public.office_university_command(w,'save_transcript',jsonb_build_object('student_id',sid,'copies',1,'status','requested','due_date','2027-01-01','reference','SYNTHETIC','idempotency_key',gen_random_uuid()));req:=(result->>'request_id')::uuid;
 PERFORM public.office_university_command(w,'save_transcript',jsonb_build_object('request_id',req,'expected_version',1,'student_id',sid,'copies',2,'status','processing','due_date','2027-01-02','reference','SYNTHETIC'));
 payload:=jsonb_build_object('title','Synthetic research administration','proposal_status','draft','ethics_status','not_started','university_clearance_status','not_started','permit_status','not_required','ethics_reference','','clearance_reference','','permit_reference','','review_date','2027-01-01','expiry_date','2027-12-31','idempotency_key',gen_random_uuid());result:=public.office_university_command(w,'save_research',payload);proj:=(result->>'project_id')::uuid;
 PERFORM public.office_university_command(w,'save_research',payload||jsonb_build_object('project_id',proj,'expected_version',1,'proposal_status','submitted','idempotency_key',gen_random_uuid()));
 payload:=jsonb_build_object('programme_id',p,'title','Synthetic curriculum review','status','draft','review_query','','evidence_reference','','due_date','2027-01-01','idempotency_key',gen_random_uuid());result:=public.office_university_command(w,'save_quality',payload);qa:=(result->>'case_id')::uuid;
 PERFORM public.office_university_command(w,'save_quality',payload||jsonb_build_object('case_id',qa,'expected_version',1,'status','submitted','idempotency_key',gen_random_uuid()));
 result:=public.office_university_summary(w);
 IF (result->>'terms_count')::integer<>1 OR (result->>'programmes_count')::integer<>1 OR (result->>'courses_count')::integer<>2
   OR (result->>'admissions_count')::integer<>1 OR (result->>'students_count')::integer<>1
   OR (result->>'assessments_count')::integer<>2 OR (result->>'draft_assessments_count')::integer<>1
   OR (result->>'fees_count')::integer<>1 OR (result->>'unpaid_fee_charges_count')::integer<>1
 THEN RAISE EXCEPTION 'Administrator server KPI summary is incorrect: %',result;END IF;
 IF jsonb_array_length(public.office_university_read(w,'terms','{}',1,0))<>1 OR jsonb_array_length(public.office_university_read(w,'terms','{}',1,1))<>0 THEN RAISE EXCEPTION 'Pagination failed';END IF;
 PERFORM set_config('request.jwt.claim.sub','22222222-2222-4222-8222-222222222222',false);
 result:=public.office_university_summary(w);
 IF (result->>'students_count')::integer<>1 OR (result->>'assessments_count')::integer<>1
   OR (result->>'admissions_count')::integer<>0 OR (result->>'fees_count')::integer<>0
 THEN RAISE EXCEPTION 'Lecturer server KPI scope is incorrect: %',result;END IF;
 IF jsonb_array_length(public.office_university_read(w,'assessments'))<>1 THEN RAISE EXCEPTION 'Lecturer assessment scope failed';END IF;
 BEGIN PERFORM public.office_university_command(w,'save_assessment',jsonb_build_object('course_id',c2,'term_id',t,'title','Unauthorized','max_score',100,'idempotency_key',gen_random_uuid()));RAISE EXCEPTION 'Unassigned lecturer wrote assessment';EXCEPTION WHEN SQLSTATE '42501' THEN NULL;END;
 BEGIN PERFORM public.office_university_read(w,'private_person',jsonb_build_object('person_id',gen_random_uuid()));RAISE EXCEPTION 'Lecturer accessed private identity';EXCEPTION WHEN SQLSTATE '42501' THEN NULL;END;
 PERFORM set_config('request.jwt.claim.sub','33333333-3333-4333-8333-333333333333',false);
 result:=public.office_university_summary(w);
 IF (result->>'fees_count')::integer<>1 OR (result->>'students_count')::integer<>1
   OR (result->>'admissions_count')::integer<>0 OR (result->>'assessments_count')::integer<>0
 THEN RAISE EXCEPTION 'Finance server KPI scope is incorrect: %',result;END IF;
 IF jsonb_array_length(public.office_university_read(w,'fees'))<>1 THEN RAISE EXCEPTION 'Finance read failed';END IF;
 BEGIN PERFORM public.office_university_read(w,'admissions');RAISE EXCEPTION 'Finance read admissions';EXCEPTION WHEN SQLSTATE '42501' THEN NULL;END;
 PERFORM set_config('request.jwt.claim.sub','44444444-4444-4444-8444-444444444444',false);
 BEGIN PERFORM public.office_university_read(w,'bootstrap');RAISE EXCEPTION 'Nonmember access accepted';EXCEPTION WHEN SQLSTATE '42501' THEN NULL;END;
 BEGIN PERFORM public.office_university_summary(w);RAISE EXCEPTION 'Nonmember KPI summary access accepted';EXCEPTION WHEN SQLSTATE '42501' THEN NULL;END;
 PERFORM set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
 BEGIN PERFORM public.office_university_read('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','bootstrap');RAISE EXCEPTION 'Wrong industry accepted';EXCEPTION WHEN SQLSTATE '42501' THEN NULL;END;
 BEGIN PERFORM 1 FROM public.office_university_students;RAISE EXCEPTION 'Direct table access accepted';EXCEPTION WHEN SQLSTATE '42501' THEN NULL;END;
 RAISE NOTICE 'ALL UNIVERSITY WORKFLOW AND ROLE TESTS PASSED';
END $$;
RESET ROLE;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname LIKE 'office_university_%' AND c.relkind='r' AND (NOT c.relrowsecurity OR has_table_privilege('authenticated',c.oid,'SELECT') OR has_table_privilege('anon',c.oid,'SELECT') OR has_table_privilege('service_role',c.oid,'SELECT'))) THEN RAISE EXCEPTION 'Unsafe table privileges';END IF;
 IF has_function_privilege('anon','public.office_university_command(uuid,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'Anonymous RPC permission';END IF;
 BEGIN DELETE FROM public.office_university_audit;RAISE EXCEPTION 'Audit mutable';EXCEPTION WHEN SQLSTATE '42501' THEN NULL;END;
 BEGIN TRUNCATE public.office_university_receipts;RAISE EXCEPTION 'Receipts mutable';EXCEPTION WHEN SQLSTATE '42501' THEN NULL;END;
 RAISE NOTICE 'PRIVILEGE AND IMMUTABILITY TESTS PASSED';
END $$;

INSERT INTO public.office_workspaces(id) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
INSERT INTO public.office_industry_spaces(workspace_id,industry_id) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc','university');
INSERT INTO public.office_memberships(workspace_id,user_id,role) VALUES('cccccccc-cccc-4ccc-8ccc-cccccccccccc','11111111-1111-4111-8111-111111111111','owner');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','11111111-1111-4111-8111-111111111111',false);
DO $$ DECLARE w uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; other uuid:='cccccccc-cccc-4ccc-8ccc-cccccccccccc'; foreign_programme uuid; own_programme uuid;BEGIN
 foreign_programme:=(public.office_university_command(other,'save_programme',jsonb_build_object('code','OTHER','name','Other University','status','active','idempotency_key',gen_random_uuid()))->>'programme_id')::uuid;
 BEGIN PERFORM public.office_university_command(w,'save_course',jsonb_build_object('programme_id',foreign_programme,'code','LEAK','name','Wrong university','credits',10,'status','active','idempotency_key',gen_random_uuid()));RAISE EXCEPTION 'Cross-workspace programme accepted';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 own_programme:=(public.office_university_read(w,'programmes')->0->>'programme_id')::uuid;
 BEGIN PERFORM public.office_university_command(w,'save_quality',jsonb_build_object('programme_id',own_programme,'title','Invalid approval','status','approved','evidence_reference','','idempotency_key',gen_random_uuid()));RAISE EXCEPTION 'Evidence-free quality approval accepted';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 BEGIN PERFORM public.office_university_command(w,'save_research',jsonb_build_object('title','Invalid ethics approval','proposal_status','approved','ethics_status','approved','university_clearance_status','not_started','permit_status','not_required','ethics_reference','','idempotency_key',gen_random_uuid()));RAISE EXCEPTION 'Evidence-free ethics approval accepted';EXCEPTION WHEN SQLSTATE '22023' THEN NULL;END;
 RAISE NOTICE 'CROSS-WORKSPACE AND APPROVAL-EVIDENCE TESTS PASSED';
END $$;
RESET ROLE;
