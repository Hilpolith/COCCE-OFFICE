import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, beforeEach, afterEach, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

// Disposable in-memory PostgreSQL only. No network, credentials, real identities or files.
const migration = await readFile(new URL('../docs/proposals/office-school-management-20261106.sql', import.meta.url), 'utf8');
const paginationMigration = await readFile(new URL('../supabase/migrations/20261109152012_office_school_read_offset_pagination.sql', import.meta.url), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111';
const teacher = '22222222-2222-4222-8222-222222222222';
const registrar = '33333333-3333-4333-8333-333333333333';
const bursar = '44444444-4444-4444-8444-444444444444';
const suspended = '55555555-5555-4555-8555-555555555555';
const outsider = '66666666-6666-4666-8666-666666666666';
const school = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherSchool = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const business = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
let db;

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE SCHEMA office_private;
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    CREATE TABLE public.office_workspaces (id uuid PRIMARY KEY);
    CREATE TABLE public.office_memberships (
      workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id),
      user_id uuid NOT NULL REFERENCES auth.users(id), role text NOT NULL CHECK (role IN ('owner','admin','member')),
      status text NOT NULL CHECK (status IN ('active','suspended')),
      PRIMARY KEY (workspace_id,user_id)
    );
    CREATE TABLE public.office_industry_spaces (
      workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id),
      industry_id text NOT NULL, office_name text NOT NULL, country text NOT NULL,
      PRIMARY KEY (workspace_id,industry_id)
    );
    CREATE FUNCTION office_private.is_active_member(p_workspace_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.office_memberships m WHERE m.workspace_id=p_workspace_id
        AND m.user_id=auth.uid() AND m.status='active')
    $$;
    CREATE FUNCTION office_private.is_admin(p_workspace_id uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
      SELECT EXISTS (SELECT 1 FROM public.office_memberships m WHERE m.workspace_id=p_workspace_id
        AND m.user_id=auth.uid() AND m.status='active' AND m.role IN ('owner','admin'))
    $$;
  `);
  await db.exec(migration);
  await db.exec(paginationMigration);
  await db.query('INSERT INTO auth.users(id) VALUES ($1),($2),($3),($4),($5),($6)', [owner,teacher,registrar,bursar,suspended,outsider]);
  await db.query('INSERT INTO public.office_workspaces(id) VALUES ($1),($2),($3)', [school,otherSchool,business]);
  await db.query(`INSERT INTO public.office_memberships(workspace_id,user_id,role,status) VALUES
    ($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active'),($1,$5,'member','active'),
    ($1,$6,'member','suspended'),($7,$2,'owner','active'),($8,$2,'owner','active')`,
    [school,owner,teacher,registrar,bursar,suspended,otherSchool,business]);
  await db.query(`INSERT INTO public.office_industry_spaces(workspace_id,industry_id,office_name,country) VALUES
    ($1,'school','Synthetic School A','TZ'),($2,'school','Synthetic School B','TZ'),($3,'business','Synthetic Business','TZ')`,
    [school,otherSchool,business]);
  await db.query(`INSERT INTO public.office_school_staff_roles(workspace_id,user_id,school_role,assigned_by)
    VALUES ($1,$2,'teacher',$3),($1,$4,'registrar',$3),($1,$5,'bursar',$3)`,
    [school,teacher,owner,registrar,bursar]);
});
beforeEach(async () => { await db.exec('BEGIN'); });
afterEach(async () => { await db.exec('ROLLBACK'); });
after(async () => { await db?.close(); });

async function as(userId, operation) {
  await db.exec('SAVEPOINT actor_scope');
  const previous = (await db.query("SELECT coalesce(current_setting('request.jwt.claim.sub',true),'') AS value")).rows[0].value;
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [userId]);
  await db.exec('SET LOCAL ROLE authenticated');
  try {
    const result = await operation();
    await db.exec('RESET ROLE');
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [previous]);
    await db.exec('RELEASE SAVEPOINT actor_scope');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK TO SAVEPOINT actor_scope; RELEASE SAVEPOINT actor_scope');
    throw error;
  }
}
async function read(resource, who = owner, filter = {}, limit = 100, offset = 0) {
  const pageFilter = offset > 0 ? { ...filter, offset } : filter;
  return as(who, async () => (await db.query('SELECT public.office_school_read($1,$2,$3,$4) AS result',
    [school,resource,pageFilter,limit])).rows[0].result);
}
async function command(action, payload, who = owner) {
  return as(who, async () => (await db.query('SELECT public.office_school_command($1,$2,$3) AS result',
    [school,action,payload])).rows[0].result);
}
async function expectSqlState(operation, code) {
  await db.exec('SAVEPOINT expected_error');
  let caught;
  try { await operation(); } catch (error) { caught = error; }
  await db.exec('ROLLBACK TO SAVEPOINT expected_error; RELEASE SAVEPOINT expected_error');
  assert.equal(caught?.code, code, caught?.message);
  return caught;
}

test('integrated SMS proposal applies cleanly and exposes only the authenticated RPC boundary', async () => {
  const rows = await db.query(`SELECT p.proname, p.prosecdef, coalesce(p.proconfig,'{}') AS config
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('office_school_read','office_school_command') ORDER BY p.proname`);
  assert.equal(rows.rows.length, 2);
  for (const fn of rows.rows) {
    assert.equal(fn.prosecdef, true);
    assert.ok(fn.config.some((item) => item === 'search_path=""'));
  }
  const tables = await db.query(`SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p') AND c.relname LIKE 'office_school_%'`);
  assert.ok(tables.rows.length >= 20);
  assert.ok(tables.rows.every((row) => row.relrowsecurity));
  assert.ok(migration.includes('CREATE TABLE public.office_school_timetable_entries'));
  assert.ok(migration.includes('school_timetable_validate_catalog'));
});

test('School operational reads support deterministic bounded offset pagination', async () => {
  for (let index = 1; index <= 5; index += 1) {
    await command('save_term', {
      academic_year: '2026/2027',
      term_label: `Pagination term ${index}`,
      start_date: `2026-0${index}-01`,
      end_date: `2026-0${index}-28`,
    });
  }
  const first = await read('terms', owner, {}, 2, 0);
  const second = await read('terms', owner, {}, 2, 2);
  const third = await read('terms', owner, {}, 2, 4);
  const ids = [...first, ...second, ...third].map((row) => row.term_id);
  assert.equal(first.length, 2);
  assert.equal(second.length, 2);
  assert.equal(third.length, 1);
  assert.equal(new Set(ids).size, 5);
  assert.ok(first[0].start_date > first[1].start_date);
  assert.ok(first[1].start_date > second[0].start_date);
  assert.ok(second[1].start_date > third[0].start_date);
  await expectSqlState(() => read('terms', owner, { offset: -1 }, 2), '22023');
  await expectSqlState(() => read('terms', owner, { offset: 100001 }, 2), '22023');
});

test('owner can bootstrap, create term/class/subject, and assign an active teacher', async () => {
  const bootstrap = await read('bootstrap');
  assert.equal(bootstrap.role, 'school_admin');
  const term = await command('save_term', { academic_year:'2026/2027',term_label:'Term 1',start_date:'2026-01-01',end_date:'2026-04-30' });
  const klass = await command('save_class', { class_label:'Form 1A',level_label:'Form 1',stream_label:'A',capacity:40 });
  const subject = await command('save_subject', { subject_code:'MATH',subject_label:'Mathematics' });
  assert.ok(term.term_id && klass.class_id && subject.subject_id);
  const assigned = await command('assign_class_staff', { class_id:klass.class_id,subject_id:subject.subject_id,user_id:teacher,assignment_kind:'subject_teacher' });
  assert.ok(assigned.assignment_id);
  assert.equal((await read('classes',teacher)).length,1);
});

test('integrated timetable uses managed open terms/classes/subjects and preserves conflict, audit and membership rules', async () => {
  const term = await command('save_term',{academic_year:'2026/2027',term_label:'Term 1',start_date:'2026-01-01',end_date:'2026-04-30'});
  const classA = await command('save_class',{class_label:'Form 1A'});
  await command('save_class',{class_label:'Form 1B'});
  await command('save_class',{class_label:'Form 1C'});
  const subject = await command('save_subject',{subject_code:'MATH',subject_label:'Mathematics'});
  await command('assign_class_staff',{class_id:classA.class_id,subject_id:subject.subject_id,user_id:teacher,assignment_kind:'subject_teacher'});
  const createSlot = async (key,classLabel,teacherId,room,start,end) => as(owner,async()=>
    (await db.query(`SELECT public.office_school_timetable_create(
      $1::uuid,$2::uuid,$3::text,$4::text,$5::text,$6::text,$7::uuid,$8::text,$9::smallint,$10::smallint,$11::smallint) AS entry_id`,
      [school,key,'2026/2027','Term 1',classLabel,'Mathematics',teacherId,room,1,start,end])).rows[0].entry_id);
  const entry = await createSlot('aaaaaaaa-0000-4000-8000-000000000101','Form 1A',teacher,'Room 4',480,525);
  assert.equal(await createSlot('aaaaaaaa-0000-4000-8000-000000000101','Form 1A',teacher,'Room 4',480,525),entry);
  await expectSqlState(()=>createSlot('aaaaaaaa-0000-4000-8000-000000000102','Form 1A',registrar,'Room 5',510,540),'23P01');
  await expectSqlState(()=>createSlot('aaaaaaaa-0000-4000-8000-000000000103','Form 1B',teacher,'Room 6',510,540),'23P01');
  await expectSqlState(()=>createSlot('aaaaaaaa-0000-4000-8000-000000000104','Form 1C',registrar,'Room 4',510,540),'23P01');
  await expectSqlState(()=>createSlot('aaaaaaaa-0000-4000-8000-000000000105','Form 1C',outsider,'Room 9',550,580),'22023');
  const adjacent = await createSlot('aaaaaaaa-0000-4000-8000-000000000106','Form 1A',teacher,'Room 4',525,570);
  assert.ok(adjacent);
  const newVersion = await as(owner,async()=>(await db.query(`SELECT public.office_school_timetable_update(
    $1::uuid,$2::uuid,$3::bigint,$4::text,$5::text,$6::text,$7::text,$8::uuid,$9::text,$10::smallint,$11::smallint,$12::smallint) AS version`,
    [school,entry,1,'2026/2027','Term 1','Form 1A','Mathematics',teacher,'Room 5',1,480,525])).rows[0].version);
  assert.equal(Number(newVersion),2);
  await expectSqlState(()=>as(owner,async()=>db.query(`SELECT public.office_school_timetable_update(
    $1::uuid,$2::uuid,$3::bigint,$4::text,$5::text,$6::text,$7::text,$8::uuid,$9::text,$10::smallint,$11::smallint,$12::smallint)`,
    [school,entry,1,'2026/2027','Term 1','Form 1A','Mathematics',teacher,'Room 6',1,480,525])),'40001');
  const cancelled = await as(owner,async()=>(await db.query('SELECT public.office_school_timetable_cancel($1::uuid,$2::uuid,2) AS version',[school,entry])).rows[0].version);
  assert.equal(Number(cancelled),3);
  const replayedCancel = await as(owner,async()=>(await db.query('SELECT public.office_school_timetable_cancel($1::uuid,$2::uuid,3) AS version',[school,entry])).rows[0].version);
  assert.equal(Number(replayedCancel),3);
  const events = await as(owner,async()=>(await db.query('SELECT * FROM public.office_school_timetable_list_events($1::uuid,$2::uuid,50)',[school,entry])).rows);
  assert.equal(events.length,3);
  const updateEvent=events.find((event)=>Number(event.schedule_version)===2);
  const cancelEvent=events.find((event)=>Number(event.schedule_version)===3);
  assert.equal(updateEvent.before_state.room_label,'Room 4');
  assert.equal(updateEvent.after_state.room_label,'Room 5');
  assert.equal(cancelEvent.before_state.room_label,'Room 5');
  assert.equal(cancelEvent.after_state.status,'cancelled');
  await expectSqlState(()=>createSlot('aaaaaaaa-0000-4000-8000-000000000107','Form 1C',outsider,'Room 8',600,640),'22023');
  await expectSqlState(()=>createSlot('aaaaaaaa-0000-4000-8000-000000000108','Form 1C',registrar,'Room 8',600,640),'22023');
  const otherSchoolRows = await as(owner,async()=>(await db.query('SELECT * FROM public.office_school_timetable_list($1::uuid,NULL,NULL,100)',[otherSchool])).rows);
  assert.equal(otherSchoolRows.length,0);
  await expectSqlState(()=>as(owner,async()=>db.query('SELECT * FROM public.office_school_timetable_list($1::uuid,NULL,NULL,100)',[business])),'42501');
  await expectSqlState(()=>as(owner,async()=>db.query('SELECT * FROM public.office_school_timetable_entries')),'42501');
  assert.ok(term.term_id && classA.class_id && subject.subject_id);
});

test('student identity data is encrypted, admissions are role-restricted, and enrollment is auditable', async () => {
  const salt = Buffer.alloc(16, 1).toString('base64');
  const nonce = Buffer.alloc(12, 2).toString('base64');
  const verifier = Buffer.alloc(32, 3).toString('base64');
  await command('setup_key',{salt,nonce,ciphertext:verifier});
  const term = await command('save_term',{academic_year:'2026/2027',term_label:'Term 1',start_date:'2026-01-01',end_date:'2026-04-30'});
  const klass = await command('save_class',{class_label:'Form 1A'});
  const app = await command('create_application',{term_id:term.term_id,class_id:klass.class_id,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000001',nonce,ciphertext:Buffer.alloc(32,21).toString('base64')},registrar);
  assert.match(app.application_code,/^ADM-/);
  const stored = await db.query('SELECT encode(ciphertext,\'base64\') AS ciphertext FROM public.office_school_private_people WHERE workspace_id=$1 AND person_id=$2',[school,app.person_id]);
  assert.equal(Buffer.from(stored.rows[0].ciphertext,'base64').length, 32);
  assert.equal(JSON.stringify(await read('admissions',registrar)).includes('synthetic encrypted identity'), false);
  await expectSqlState(() => read('private_person',teacher,{id:app.person_id}), '42501');
  await command('set_application_status',{application_id:app.application_id,status:'reviewing'},registrar);
  await command('set_application_status',{application_id:app.application_id,status:'offered'},registrar);
  await command('set_application_status',{application_id:app.application_id,status:'accepted'},registrar);
  const enrolled = await command('enroll_student',{application_id:app.application_id},registrar);
  assert.match(enrolled.student_code,/^STU-/);
  assert.ok((await read('students',registrar)).some((row)=>row.student_id===enrolled.student_id));
  const audit = await read('audit');
  assert.ok(audit.some((row)=>row.module==='identity' && row.event_kind==='sensitive_read') === false);
  assert.ok(audit.some((row)=>row.module==='admissions' && row.event_kind==='created'));
  assert.equal(JSON.stringify(audit).includes('synthetic encrypted identity'),false);
});

test('teacher records attendance and grades only for assigned classes; grade locks prevent further edits', async () => {
  const term = await command('save_term',{academic_year:'2026/2027',term_label:'Term 1',start_date:'2026-01-01',end_date:'2026-04-30'});
  const klass = await command('save_class',{class_label:'Form 2A'});
  const subject = await command('save_subject',{subject_code:'ENG',subject_label:'English'});
  await command('assign_class_staff',{class_id:klass.class_id,subject_id:subject.subject_id,user_id:teacher,assignment_kind:'subject_teacher'});
  const keyArgs = {salt:Buffer.alloc(16,4).toString('base64'),nonce:Buffer.alloc(12,5).toString('base64'),ciphertext:Buffer.alloc(32,6).toString('base64')};
  await command('setup_key',keyArgs);
  const app = await command('create_application',{term_id:term.term_id,class_id:klass.class_id,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000002',nonce:keyArgs.nonce,ciphertext:Buffer.alloc(32,22).toString('base64')},registrar);
  await command('set_application_status',{application_id:app.application_id,status:'reviewing'},registrar);
  await command('set_application_status',{application_id:app.application_id,status:'offered'},registrar);
  await command('set_application_status',{application_id:app.application_id,status:'accepted'},registrar);
  const student = await command('enroll_student',{application_id:app.application_id},registrar);
  const attendance = await command('take_attendance',{class_id:klass.class_id,term_id:term.term_id,session_date:'2026-02-01',slot_label:'Daily',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000003',marks:[{student_id:student.student_id,attendance_status:'present'}]},teacher);
  assert.equal(attendance.saved_marks,1);
  const assessment = await command('create_assessment',{class_id:klass.class_id,subject_id:subject.subject_id,term_id:term.term_id,assessment_type:'quiz',title:'Quiz 1',maximum_score:20},teacher);
  assert.equal(assessment.status,'draft');
  const saved = await command('save_scores',{assessment_id:assessment.assessment_id,scores:[{student_id:student.student_id,score:17}]},teacher);
  assert.equal(saved.saved_scores,1);
  await expectSqlState(() => command('lock_assessment',{assessment_id:assessment.assessment_id},teacher), '42501');
  await command('lock_assessment',{assessment_id:assessment.assessment_id});
  await expectSqlState(() => command('save_scores',{assessment_id:assessment.assessment_id,scores:[{student_id:student.student_id,score:18}]},teacher), '55000');
  const attendanceRows = await read('attendance',teacher,{class_id:klass.class_id});
  assert.equal(attendanceRows[0].marks[0].attendance_status,'present');
  const grades = await read('gradebook',teacher,{class_id:klass.class_id});
  assert.equal(grades[0].scores[0].score,17);
});

test('bursar receipt ledger prevents overpayment, stays idempotent, and does not expose private identity', async () => {
  const term = await command('save_term',{academic_year:'2026/2027',term_label:'Term 1',start_date:'2026-01-01',end_date:'2026-04-30'});
  const klass = await command('save_class',{class_label:'Form 3A'});
  const keyArgs = {salt:Buffer.alloc(16,7).toString('base64'),nonce:Buffer.alloc(12,8).toString('base64'),ciphertext:Buffer.alloc(32,9).toString('base64')};
  await command('setup_key',keyArgs);
  const app = await command('create_application',{term_id:term.term_id,class_id:klass.class_id,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000004',nonce:keyArgs.nonce,ciphertext:Buffer.alloc(32,23).toString('base64')},registrar);
  await command('set_application_status',{application_id:app.application_id,status:'reviewing'},registrar);
  await command('set_application_status',{application_id:app.application_id,status:'offered'},registrar);
  await command('set_application_status',{application_id:app.application_id,status:'accepted'},registrar);
  const student = await command('enroll_student',{application_id:app.application_id},registrar);
  const charge = await command('create_fee_charge',{student_id:student.student_id,term_id:term.term_id,fee_category:'tuition',amount_tzs:500000,due_date:'2026-02-15',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000005'},bursar);
  const receipt = await command('record_fee_receipt',{charge_id:charge.charge_id,amount_tzs:200000,payment_method:'cash',external_reference:'cash-book-1',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000006'},bursar);
  const replay = await command('record_fee_receipt',{charge_id:charge.charge_id,amount_tzs:200000,payment_method:'cash',external_reference:'cash-book-1',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000006'},bursar);
  assert.equal(replay.receipt_id,receipt.receipt_id);
  await expectSqlState(() => command('record_fee_receipt',{charge_id:charge.charge_id,amount_tzs:300001,payment_method:'bank',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000007'},bursar), '22023');
  const fees = await read('fees',bursar);
  assert.equal(Number(fees[0].paid_tzs),200000);
  assert.equal(Number(fees[0].amount_tzs)-Number(fees[0].paid_tzs),300000);
  await expectSqlState(() => read('fees',teacher), '42501');
  await expectSqlState(() => read('private_person',bursar,{id:app.person_id}), '42501');
});

test('class-wide encrypted parent notice is approved but never represented as sent', async () => {
  const term = await command('save_term',{academic_year:'2026/2027',term_label:'Term 1',start_date:'2026-01-01',end_date:'2026-04-30'});
  const klass = await command('save_class',{class_label:'Form 4A'});
  const keyArgs = {salt:Buffer.alloc(16,10).toString('base64'),nonce:Buffer.alloc(12,11).toString('base64'),ciphertext:Buffer.alloc(32,12).toString('base64')};
  await command('setup_key',keyArgs);
  await command('assign_class_staff',{class_id:klass.class_id,subject_id:null,user_id:teacher,assignment_kind:'class_teacher'});
  const notice = await command('create_notice',{term_id:term.term_id,class_id:klass.class_id,notice_kind:'exam_notice',nonce:keyArgs.nonce,ciphertext:Buffer.alloc(32,24).toString('base64')},teacher);
  const approved = await command('approve_notice',{notice_id:notice.notice_id});
  assert.equal(approved.delivery,'manual_only');
  const notices = await read('notices',teacher,{class_id:klass.class_id});
  assert.equal(notices[0].status,'approved');
  assert.equal(Buffer.from(notices[0].body_ciphertext,'base64').length,32);
  assert.equal(JSON.stringify(notices).includes('delivery'),false);
});

test('cross-workspace, suspended, unassigned-role, and direct-table access are denied', async () => {
  await expectSqlState(() => db.query('SELECT public.office_school_read($1,$2,$3,$4)',[otherSchool,'bootstrap',{},10]), '42501');
  await expectSqlState(() => as(suspended,()=>db.query('SELECT public.office_school_read($1,$2,$3,$4)',[school,'bootstrap',{},10])), '42501');
  await expectSqlState(() => db.query('SELECT public.office_school_read($1,$2,$3,$4)',[business,'bootstrap',{},10]), '42501');
  await expectSqlState(() => as(teacher,()=>db.query('SELECT * FROM public.office_school_private_people')), '42501');
  await expectSqlState(() => as(teacher,()=>db.query('INSERT INTO public.office_school_classes(workspace_id,class_label) VALUES ($1,$2)',[school,'No direct write'])), '42501');
  const serviceGrants = await db.query(`SELECT has_table_privilege('service_role','public.office_school_private_people','SELECT') AS can_select,
    has_table_privilege('service_role','public.office_school_private_people','INSERT') AS can_insert`);
  assert.deepEqual(serviceGrants.rows[0],{can_select:false,can_insert:false});
});
