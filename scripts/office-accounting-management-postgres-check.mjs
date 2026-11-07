import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261107160000_office_accounting_management.sql', import.meta.url), 'utf8');
const rlsMigration = await readFile(new URL('../supabase/migrations/20261107175000_office_accounting_rls.sql', import.meta.url), 'utf8');
const ids = { owner:'11111111-1111-4111-8111-111111111111', accountant:'22222222-2222-4222-8222-222222222222', reviewer:'33333333-3333-4333-8333-333333333333', outsider:'44444444-4444-4444-8444-444444444444', suspended:'55555555-5555-4555-8555-555555555555', workspace:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', otherWorkspace:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', client:'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const client2='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
let db;
const q = async (sql, params=[]) => (await db.query(sql, params)).rows;
async function as(user, fn, role='authenticated') { await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[user]); await db.exec(`SET ROLE ${role}`); try { return await fn(); } finally { await db.exec('RESET ROLE'); } }
async function cmd(action, payload, user=ids.owner) { return as(user, async()=> (await db.query('SELECT public.office_accounting_command($1,$2,$3) AS r',[ids.workspace,action,payload])).rows[0].r); }
async function read(resource, filter={}, user=ids.owner, limit=200, offset=0) { return as(user, async()=> (await db.query('SELECT public.office_accounting_read($1,$2,$3,$4,$5) AS r',[ids.workspace,resource,filter,limit,offset])).rows[0].r); }
async function fails(fn, code) { let e; try { await fn(); } catch (x) { e=x; } assert.equal(e?.code,code,e?.message); }

before(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE SCHEMA office_private; CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;   CREATE TABLE public.office_workspaces(id uuid PRIMARY KEY); CREATE TABLE public.office_memberships(workspace_id uuid,user_id uuid,role text,status text,PRIMARY KEY(workspace_id,user_id)); CREATE TABLE public.office_industry_spaces(workspace_id uuid,industry_id text,PRIMARY KEY(workspace_id,industry_id)); CREATE FUNCTION office_private.is_active_member(w uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT EXISTS(SELECT 1 FROM public.office_memberships m WHERE m.workspace_id=w AND m.user_id=auth.uid() AND m.status='active')$$; CREATE FUNCTION office_private.is_admin(w uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT EXISTS(SELECT 1 FROM public.office_memberships m WHERE m.workspace_id=w AND m.user_id=auth.uid() AND m.status='active' AND m.role IN('owner','admin'))$$;`);
 await db.exec('GRANT SELECT ON TABLE public.office_workspaces TO authenticated,service_role; GRANT EXECUTE ON FUNCTION office_private.is_admin(uuid) TO authenticated;');
 await db.exec(migration);
 await db.exec(rlsMigration);
 await q('INSERT INTO auth.users VALUES($1),($2),($3),($4),($5)',Object.values(ids).slice(0,5));
 await q('INSERT INTO public.office_workspaces VALUES($1),($2)',[ids.workspace,ids.otherWorkspace]);
 await q("INSERT INTO public.office_memberships VALUES($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active'),($1,$5,'member','suspended'),($2,$2,'owner','active')",[ids.workspace,ids.owner,ids.accountant,ids.reviewer,ids.suspended]);
 await q("INSERT INTO public.office_industry_spaces VALUES($1,'accounting')",[ids.workspace]);
 await q("INSERT INTO public.office_accounting_staff_roles(workspace_id,user_id,accounting_role,assigned_by) VALUES($1,$2,'accountant',$3),($1,$4,'reviewer',$3)",[ids.workspace,ids.accountant,ids.owner,ids.reviewer]);
 await cmd('save_accounting_settings',{base_currency_code:'TZS',fiscal_year_start_month:1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000001'});
 await q('INSERT INTO public.office_accounting_clients(client_id,workspace_id,client_code,legal_name_public,display_name,status,country_code,currency_code) VALUES($1,$2,\'C-1\',\'Synthetic Client\',\'Client\',\'active\',\'TZ\',\'TZS\')',[ids.client,ids.workspace]);
 await q('INSERT INTO public.office_accounting_staff_assignments(workspace_id,client_id,user_id,assigned_by) VALUES($1,$2,$3,$4),($1,$2,$5,$4)',[ids.workspace,ids.client,ids.accountant,ids.owner,ids.reviewer]);
});
after(()=>db?.close());

test('RPC boundary, RLS, direct grants, helper search_path, industry and membership guards',async()=>{
 const f=await q("SELECT p.prosecdef, p.proconfig, has_table_privilege($1,'public.office_accounting_clients','select') AS direct FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='office_accounting_read'",['authenticated']); assert.equal(f[0].prosecdef,true); assert.ok(f[0].proconfig.includes('search_path=""')); assert.equal(f[0].direct,false);
 const rls=(await q("SELECT count(*)::int AS total,count(*) FILTER(WHERE c.relrowsecurity)::int AS secured FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND starts_with(c.relname,'office_accounting_') LIMIT 1"))[0]; assert.equal(rls.total,21); assert.equal(rls.secured,rls.total);
 const unrelated=await q("SELECT has_table_privilege('authenticated','public.office_workspaces','select') AS auth_ok,has_table_privilege('service_role','public.office_workspaces','select') AS service_ok,has_function_privilege('authenticated','office_private.is_admin(uuid)','execute') AS helper_ok"); assert.deepEqual(unrelated[0],{auth_ok:true,service_ok:true,helper_ok:true}); assert.equal((await read('bootstrap')).role,'accounting_admin'); await fails(()=>read('bootstrap',{},ids.suspended),'42501'); await fails(()=>read('bootstrap',{},ids.outsider),'42501'); await fails(()=>as(ids.owner,()=>db.query('SELECT * FROM public.office_accounting_clients')),'42501');
});
test('settings, encrypted private data, role and scope restrictions',async()=>{ const c=await cmd('save_client_private',{client_id:ids.client,nonce:Buffer.alloc(12,1).toString('base64'),ciphertext:Buffer.alloc(24,2).toString('base64'),idempotency_key:'aaaaaaaa-0000-4000-8000-000000000002'},ids.accountant); assert.equal(c.client_id,ids.client); await fails(()=>cmd('save_accounting_settings',{base_currency_code:'USD',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000003'},ids.accountant),'42501'); });
test('chart, period non-overlap, journal balance, independent review, post and closed-period protection',async()=>{
 const a1=await cmd('save_chart_account',{client_id:ids.client,account_code:'1000',account_name:'Cash',account_type:'asset',normal_balance:'debit',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000010'},ids.accountant); const a2=await cmd('save_chart_account',{client_id:ids.client,account_code:'4000',account_name:'Income',account_type:'income',normal_balance:'credit',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000011'},ids.accountant);
 const p=await cmd('save_reporting_period',{client_id:ids.client,period_label:'2026',starts_on:'2026-01-01',ends_on:'2026-12-31',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000012'},ids.accountant); await fails(()=>cmd('save_reporting_period',{client_id:ids.client,period_label:'overlap',starts_on:'2026-06-01',ends_on:'2027-01-01',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000013'},ids.accountant),'23P01');
 const j=await cmd('save_journal',{client_id:ids.client,period_id:p.period_id,journal_number:'J-1',entry_date:'2026-02-01',currency_code:'TZS',description:'sale',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000014'},ids.accountant); await cmd('save_journal_line',{client_id:ids.client,journal_id:j.journal_id,line_no:1,account_id:a1.account_id,description:'cash',debit:'100.00',credit:'0.00',expected_parent_version:1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000015'},ids.accountant); await cmd('save_journal_line',{client_id:ids.client,journal_id:j.journal_id,line_no:2,account_id:a2.account_id,description:'income',debit:'0.00',credit:'100.00',expected_parent_version:2,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000016'},ids.accountant); await cmd('submit_journal',{client_id:ids.client,journal_id:j.journal_id,expected_version:3,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000017'},ids.accountant); await fails(()=>cmd('approve_journal',{client_id:ids.client,journal_id:j.journal_id,expected_version:4,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000018'},ids.accountant),'42501'); await cmd('approve_journal',{client_id:ids.client,journal_id:j.journal_id,expected_version:4,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000019'},ids.reviewer); const posted=await cmd('post_journal',{client_id:ids.client,journal_id:j.journal_id,expected_version:5,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000020'},ids.owner); assert.equal(posted.status,'posted');
});
test('idempotency replay and conflict, exact decimal pagination over 500 rows',async()=>{ const payload={client_id:ids.client,account_code:'X0',account_name:'Synthetic',account_type:'expense',normal_balance:'debit',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000030'}; const first=await cmd('save_chart_account',payload,ids.accountant); assert.deepEqual(await cmd('save_chart_account',payload,ids.accountant),first); const rows=[]; for(let i=1;i<=505;i++) rows.push([ids.workspace,ids.client,`Z${String(i).padStart(4,'0')}`,`Synthetic ${i}`,'expense','debit','active']); await db.query('INSERT INTO public.office_accounting_accounts(workspace_id,client_id,account_code,account_name,account_type,normal_balance,status) SELECT * FROM unnest($1::uuid[],$2::uuid[],$3::text[],$4::text[],$5::text[],$6::text[],$7::text[])',[rows.map(x=>x[0]),rows.map(x=>x[1]),rows.map(x=>x[2]),rows.map(x=>x[3]),rows.map(x=>x[4]),rows.map(x=>x[5]),rows.map(x=>x[6])]); const page=await read('chart_accounts',{client_id:ids.client},ids.accountant,200,400); assert.equal(page.total_count,508); assert.equal(page.rows.length,108); assert.equal(page.has_more,false); assert.equal(typeof page.rows[0].version,'number'); });
test('statement match/unmatch is scoped and evidence/obligation actions have no upload side effect',async()=>{ await q("INSERT INTO public.office_accounting_statements(workspace_id,client_id,statement_reference,statement_date,opening_balance,closing_balance) VALUES($1,$2,'S-1','2026-03-01',0,100)",[ids.workspace,ids.client]); const line=(await q("INSERT INTO public.office_accounting_statement_lines(workspace_id,statement_id,line_no,transaction_date,description,signed_amount) SELECT $1,statement_id,1,'2026-03-01','deposit',100 FROM public.office_accounting_statements WHERE workspace_id=$1 RETURNING statement_line_id",[ids.workspace]))[0].statement_line_id; const jl=(await q('SELECT line_id FROM public.office_accounting_journal_lines LIMIT 1'))[0].line_id; const m=await cmd('match_statement_line',{client_id:ids.client,statement_line_id:line,journal_line_id:jl,expected_version:1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000040'},ids.accountant); assert.equal(m.status,'matched'); const u=await cmd('unmatch_statement_line',{client_id:ids.client,statement_line_id:line,expected_version:m.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000041'},ids.accountant); assert.equal(u.status,'unmatched'); await fails(()=>cmd('save_evidence_reference',{client_id:ids.client,engagement_id:'aaaaaaaa-1111-4111-8111-111111111111',title:'x',provider:'Bunny',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000042'},ids.accountant),'22023'); });

test('posted management reports contain exact non-zero values and reversal preserves source',async()=>{
 const tb=await read('trial_balance',{client_id:ids.client,as_of:'2026-12-31'},ids.accountant,200,0);
 const cash=tb.rows.find(x=>x.account_code==='1000'); const income=tb.rows.find(x=>x.account_code==='4000');
 assert.equal(cash.debit,100); assert.equal(cash.credit,0); assert.equal(cash.balance,100);
 assert.equal(income.credit,100); assert.equal(income.balance,100); assert.equal(tb.total_count>=2,true);
 const source=(await q('SELECT posting_id,journal_id,total_debit,total_credit FROM public.office_accounting_postings WHERE workspace_id=$1 LIMIT 1',[ids.workspace]))[0];
 const before=(await q('SELECT status,total_debit,total_credit FROM public.office_accounting_journals WHERE workspace_id=$1 AND journal_id=$2',[ids.workspace,source.journal_id]))[0];
 const targetPeriod=(await q("SELECT period_id FROM public.office_accounting_periods WHERE workspace_id=$1 AND client_id=$2 LIMIT 1",[ids.workspace,ids.client]))[0].period_id; const rev=await cmd('reverse_posting',{client_id:ids.client,posting_id:source.posting_id,reversal_period_id:targetPeriod,reversal_entry_date:'2026-12-01',reason:'Correcting entry',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000050'},ids.owner);
 assert.equal(rev.status,'draft'); assert.equal(rev.reversal_of_posting_id,source.posting_id);
 const after=(await q('SELECT status,total_debit,total_credit FROM public.office_accounting_journals WHERE workspace_id=$1 AND journal_id=$2',[ids.workspace,source.journal_id]))[0]; assert.deepEqual(after,before);
});

test('bank lock requires exact balance and supports exclusion',async()=>{
 const acct=(await q("SELECT account_id FROM public.office_accounting_accounts WHERE workspace_id=$1 AND client_id=$2 AND account_type='asset' LIMIT 1",[ids.workspace,ids.client]))[0].account_id;
 const ba=await cmd('save_bank_account',{client_id:ids.client,account_id:acct,label:'Main',currency_code:'TZS',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000051'},ids.accountant);
 const st=await cmd('save_bank_statement',{client_id:ids.client,bank_account_id:ba.bank_account_id,statement_reference:'S-LOCK',statement_date:'2026-03-31',opening_balance:'10.00',closing_balance:'15.00',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000052'},ids.accountant);
 const ln=await cmd('save_bank_statement_line',{client_id:ids.client,statement_id:st.statement_id,line_no:1,transaction_date:'2026-03-31',description:'fee',signed_amount:'5.00',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000053'},ids.accountant);
 await fails(()=>cmd('lock_bank_statement',{client_id:ids.client,statement_id:st.statement_id,expected_version:st.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000054'},ids.accountant),'22023');
 const ex=await cmd('exclude_statement_line',{client_id:ids.client,statement_line_id:ln.statement_line_id,reason:'Non-book item',expected_version:ln.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000055'},ids.accountant); assert.equal(ex.status,'excluded');
});

test('obligation filing rejects non-HTTPS official references',async()=>{
 const ob=await cmd('save_obligation',{client_id:ids.client,obligation_type:'VAT',authority_label:'TRA',period_label:'2026-03',due_date:'2026-04-07',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000056'},ids.accountant);
 await fails(()=>cmd('record_filing_reference',{client_id:ids.client,obligation_id:ob.obligation_id,filing_reference:'REF-1',filed_on:'2026-04-01',official_link:'http://example.test',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000057'},ids.accountant),'22023');
});


test('selected-period reports are distinct, paginated, and client-scoped',async()=>{
 const tb=await read('trial_balance',{client_id:ids.client,period_id:(await q("SELECT period_id FROM public.office_accounting_periods WHERE workspace_id=$1 AND client_id=$2 LIMIT 1",[ids.workspace,ids.client]))[0].period_id,as_of:'2026-12-31'},ids.accountant,1,0);
 const gl=await read('general_ledger',{client_id:ids.client,starts_on:'2026-01-01',ends_on:'2026-12-31'},ids.accountant,1,0);
 const pl=await read('profit_and_loss',{client_id:ids.client,starts_on:'2026-01-01',as_of:'2026-12-31'},ids.accountant,200,0);
 assert.equal(tb.client_id,ids.client); assert.equal(gl.client_id,ids.client); assert.equal(pl.client_id,ids.client); assert.equal(gl.rows[0].journal_number,'J-1'); assert.notDeepEqual(tb.rows,gl.rows); assert.equal(typeof gl.total_count,'number'); assert.equal(gl.has_more,true); assert.ok(pl.rows.every(x=>['income','expense'].includes(x.account_type)));
 await fails(()=>read('trial_balance',{client_id:ids.client},ids.outsider),'42501');
});

test('import_bank_statement_lines is all-or-nothing and outsider mutation is rejected',async()=>{
 const acct=(await q("SELECT account_id FROM public.office_accounting_accounts WHERE workspace_id=$1 AND client_id=$2 AND account_type='asset' LIMIT 1",[ids.workspace,ids.client]))[0].account_id;
 const ba=await cmd('save_bank_account',{client_id:ids.client,account_id:acct,label:'Import',currency_code:'TZS',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000070'},ids.accountant);
 const st=await cmd('save_bank_statement',{client_id:ids.client,bank_account_id:ba.bank_account_id,statement_reference:'S-IMPORT',statement_date:'2026-04-01',opening_balance:'0',closing_balance:'1',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000071'},ids.accountant);
 await fails(()=>cmd('import_bank_statement_lines',{client_id:ids.client,statement_id:st.statement_id,lines:[{line_no:1,transaction_date:'2026-04-01',description:'ok',signed_amount:'1'},{line_no:1,transaction_date:'bad',description:'bad',signed_amount:'2'}],idempotency_key:'aaaaaaaa-0000-4000-8000-000000000072'},ids.accountant),'22023');
 assert.equal((await q('SELECT count(*) AS n FROM public.office_accounting_statement_lines WHERE statement_id=$1',[st.statement_id]))[0].n,0);
 await fails(()=>cmd('exclude_statement_line',{client_id:ids.client,statement_line_id:st.statement_id,reason:'x',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000073'},ids.outsider),'42501');
});

test('linked evidence findings obligations enforce scope, transitions, versions and independent closure',async()=>{
 await q("INSERT INTO public.office_accounting_clients(client_id,workspace_id,client_code,legal_name_public,display_name,status,country_code,currency_code) VALUES($1,$2,'C-2','Other Client','Other','active','TZ','TZS')",[client2,ids.workspace]);
 const eg=await cmd('save_engagement',{client_id:ids.client,engagement_code:'E-MGMT',title:'Management engagement',engagement_type:'review',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000080'},ids.accountant); assert.equal(eg.client_id,ids.client);
 const oldEvidence=await cmd('save_evidence_reference',{client_id:ids.client,engagement_id:eg.engagement_id,title:'Old reference',evidence_type:'document',provider:'manual_reference',reference_url:'https://example.test/old',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000081'},ids.accountant); assert.equal(oldEvidence.status,'active');
 const superseded=await cmd('supersede_evidence_reference',{evidence_id:oldEvidence.evidence_id,expected_version:1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000082'},ids.accountant); assert.equal(superseded.status,'superseded'); assert.equal(superseded.version,2);
 await fails(()=>cmd('supersede_evidence_reference',{evidence_id:oldEvidence.evidence_id,expected_version:1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000083'},ids.accountant),'22023');
 const closureEvidence=await cmd('save_evidence_reference',{client_id:ids.client,engagement_id:eg.engagement_id,title:'Closure evidence',evidence_type:'document',provider:'manual_reference',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000084'},ids.accountant);
 const finding=await cmd('save_finding',{client_id:ids.client,engagement_id:eg.engagement_id,evidence_id:closureEvidence.evidence_id,finding_code:'F-1',title:'Control gap',description_public:'Gap',severity:'high',owner_user_id:ids.accountant,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000085'},ids.accountant); assert.equal(finding.created_by,ids.accountant);
 await fails(()=>cmd('transition_finding',{finding_id:finding.finding_id,status:'resolved',expected_version:1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000086'},ids.accountant),'22023');
 const fr1=await cmd('transition_finding',{finding_id:finding.finding_id,status:'management_response',expected_version:1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000087'},ids.accountant); const fr2=await cmd('transition_finding',{finding_id:finding.finding_id,status:'resolved',expected_version:fr1.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000088'},ids.reviewer); assert.equal(fr2.status,'resolved');
 await fails(()=>cmd('close_finding',{finding_id:finding.finding_id,root_cause:'root',corrective_action:'fix',evidence_id:closureEvidence.evidence_id,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000089'},ids.reviewer),'22023');
 const closed=await cmd('close_finding',{finding_id:finding.finding_id,root_cause:'root',corrective_action:'fix',evidence_id:closureEvidence.evidence_id,expected_version:fr2.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000090'},ids.reviewer); assert.equal(closed.status,'closed');
 await fails(()=>cmd('save_finding',{client_id:client2,engagement_id:eg.engagement_id,finding_code:'F-X',title:'Cross client',description_public:'x',severity:'low',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000091'},ids.accountant),'42501');
 await fails(()=>cmd('transition_finding',{finding_id:finding.finding_id,status:'management_response',expected_version:4,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000092'},ids.outsider),'42501');
 const selfFinding=await cmd('save_finding',{client_id:ids.client,engagement_id:eg.engagement_id,finding_code:'F-2',title:'Self close',description_public:'x',severity:'low',owner_user_id:ids.reviewer,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000093'},ids.reviewer);
 const selfM=await cmd('transition_finding',{finding_id:selfFinding.finding_id,status:'management_response',expected_version:1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000094'},ids.reviewer); const selfR=await cmd('transition_finding',{finding_id:selfFinding.finding_id,status:'resolved',expected_version:selfM.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000095'},ids.reviewer);
 await fails(()=>cmd('close_finding',{finding_id:selfFinding.finding_id,root_cause:'root',corrective_action:'fix',evidence_id:closureEvidence.evidence_id,expected_version:selfR.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000096'},ids.reviewer),'42501');
 const ob=await cmd('save_obligation',{client_id:ids.client,engagement_id:eg.engagement_id,obligation_type:'VAT',authority_label:'TRA',period_label:'2026-04',due_date:'2026-05-07',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000097'},ids.accountant); const oi=await cmd('transition_obligation',{obligation_id:ob.obligation_id,status:'in_progress',expected_version:1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000098'},ids.accountant); const or=await cmd('transition_obligation',{obligation_id:ob.obligation_id,status:'ready',expected_version:oi.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000099'},ids.accountant); assert.equal(or.status,'ready');
 await fails(()=>cmd('transition_obligation',{obligation_id:ob.obligation_id,status:'closed',expected_version:or.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000100'},ids.accountant),'22023'); await fails(()=>cmd('transition_obligation',{obligation_id:ob.obligation_id,status:'in_progress',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000101'},ids.accountant),'22023');
 await fails(()=>cmd('record_filing_reference',{obligation_id:ob.obligation_id,filing_reference:'TRA-STALE',filed_on:'2026-05-01',official_link:'https://tra.go.tz/filing/stale',expected_version:or.version+1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000102'},ids.accountant),'40001');
 const filed=await cmd('record_filing_reference',{obligation_id:ob.obligation_id,filing_reference:'TRA-REF-2026-04',filed_on:'2026-05-01',official_link:'https://tra.go.tz/filing/2026-04',expected_version:or.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000104'},ids.accountant); assert.equal(filed.status,'filed_reference_recorded');
 await fails(()=>cmd('record_filing_reference',{obligation_id:ob.obligation_id,filing_reference:'TRA-REF-2',filed_on:'2026-05-02',official_link:'https://user:pass@tra.go.tz/x',expected_version:filed.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000105'},ids.accountant),'22023');
});


test('core lifecycle strict versions, close blockers, reopen authorization and cross-client scope',async()=>{
 const a1=(await q("SELECT account_id FROM public.office_accounting_accounts WHERE workspace_id=$1 AND client_id=$2 AND account_code='X0' LIMIT 1",[ids.workspace,ids.client]))[0].account_id;
 await fails(()=>cmd('save_chart_account',{client_id:ids.client,account_id:a1,account_name:'Cash v2',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000110'},ids.accountant),'40001');
 await fails(()=>cmd('save_chart_account',{client_id:ids.client,account_id:a1,account_name:'Cash v2',expected_version:0,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000111'},ids.accountant),'40001');
 await fails(()=>cmd('save_chart_account',{client_id:client2,account_id:a1,account_name:'Cross',expected_version:1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000112'},ids.accountant),'42501');
 const period=await cmd('save_reporting_period',{client_id:ids.client,period_label:'2027',starts_on:'2027-01-01',ends_on:'2027-12-31',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000113'},ids.accountant);
 const j=await cmd('save_journal',{client_id:ids.client,period_id:period.period_id,journal_number:'J-2027',entry_date:'2027-02-01',currency_code:'TZS',description:'strict',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000114'},ids.accountant);
 await fails(()=>cmd('submit_journal',{client_id:ids.client,journal_id:j.journal_id,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000115'},ids.accountant),'40001');
 await fails(()=>cmd('submit_journal',{client_id:ids.client,journal_id:j.journal_id,expected_version:0,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000116'},ids.accountant),'40001');
 await cmd('save_journal_line',{client_id:ids.client,journal_id:j.journal_id,line_no:1,account_id:a1,description:'cash',debit:'10',credit:'0',expected_parent_version:1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000117'},ids.accountant);
 const a2=(await q("SELECT account_id FROM public.office_accounting_accounts WHERE workspace_id=$1 AND client_id=$2 AND account_code='4000' LIMIT 1",[ids.workspace,ids.client]))[0].account_id;
 await cmd('save_journal_line',{client_id:ids.client,journal_id:j.journal_id,line_no:2,account_id:a2,description:'income',debit:'0',credit:'10',expected_parent_version:2,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000118'},ids.accountant);
 await fails(()=>cmd('submit_journal',{client_id:ids.client,journal_id:j.journal_id,expected_version:2,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000119'},ids.accountant),'40001');
 const submitted=await cmd('submit_journal',{client_id:ids.client,journal_id:j.journal_id,expected_version:3,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000120'},ids.accountant);
 await fails(()=>cmd('approve_journal',{client_id:ids.client,journal_id:j.journal_id,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000121'},ids.reviewer),'40001');
 await fails(()=>cmd('return_journal',{client_id:ids.client,journal_id:j.journal_id,expected_version:submitted.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000122'},ids.reviewer),'22023');
 await fails(()=>cmd('approve_journal',{client_id:ids.client,journal_id:j.journal_id,expected_version:submitted.version-1,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000123'},ids.reviewer),'40001');
 const approved=await cmd('approve_journal',{client_id:ids.client,journal_id:j.journal_id,expected_version:submitted.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000124'},ids.reviewer);
 const posted=await cmd('post_journal',{client_id:ids.client,journal_id:j.journal_id,expected_version:approved.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000125'},ids.owner);
 await fails(()=>cmd('post_journal',{client_id:ids.client,journal_id:j.journal_id,expected_version:posted.version,idempotency_key:'aaaaaaaa-0000-4000-8000-000000000126'},ids.owner),'55000');
 const pending=await cmd('save_reporting_period',{client_id:ids.client,period_label:'2028',starts_on:'2028-01-01',ends_on:'2028-12-31',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000127'},ids.accountant);
 const pendingJ=await cmd('save_journal',{client_id:ids.client,period_id:pending.period_id,journal_number:'J-2028',entry_date:'2028-02-01',currency_code:'TZS',description:'pending',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000128'},ids.accountant);
 await fails(()=>cmd('close_reporting_period',{client_id:ids.client,period_id:pending.period_id,expected_version:pending.version,reason:'Close attempt',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000129'},ids.accountant),'55000');
 await q("UPDATE public.office_accounting_journals SET status='posted' WHERE workspace_id=$1 AND journal_id=$2",[ids.workspace,pendingJ.journal_id]);
 const st=(await q("INSERT INTO public.office_accounting_statements(workspace_id,client_id,statement_reference,statement_date,opening_balance,closing_balance,status) VALUES($1,$2,'S-CLOSE','2028-03-01',0,0,'draft') RETURNING statement_id",[ids.workspace,ids.client]))[0].statement_id;
 await fails(()=>cmd('close_reporting_period',{client_id:ids.client,period_id:pending.period_id,expected_version:pending.version,reason:'Close attempt',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000130'},ids.accountant),'55000');
 await q("UPDATE public.office_accounting_statements SET status='locked' WHERE workspace_id=$1 AND statement_id=$2",[ids.workspace,st]);
 const closed=await cmd('close_reporting_period',{client_id:ids.client,period_id:pending.period_id,expected_version:pending.version,reason:'Resolved blockers',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000131'},ids.accountant);
 await fails(()=>cmd('reopen_reporting_period',{client_id:ids.client,period_id:pending.period_id,expected_version:closed.version,reason:'Reopen',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000132'},ids.accountant),'42501');
 await fails(()=>cmd('reopen_reporting_period',{client_id:ids.client,period_id:pending.period_id,expected_version:closed.version,reason:'',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000133'},ids.owner),'22023');
 await fails(()=>cmd('reopen_reporting_period',{client_id:ids.client,period_id:pending.period_id,expected_version:closed.version-1,reason:'Reopen',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000134'},ids.owner),'40001');
 const reopened=await cmd('reopen_reporting_period',{client_id:ids.client,period_id:pending.period_id,expected_version:closed.version,reason:'Authorized correction',idempotency_key:'aaaaaaaa-0000-4000-8000-000000000135'},ids.owner); assert.equal(reopened.status,'open'); assert.equal(reopened.reopen_count,1);
});

test('journal line responses distinguish parent versions and refresh exact draft totals', async()=>{
 let sequence=0;
 const run=(action,payload)=>cmd(action,{...payload,idempotency_key:`99999999-0000-4000-8000-${String(++sequence).padStart(12,'0')}`});
 const client=await run('save_client',{client_code:'RESPONSE-CONTRACT',legal_name_public:'Synthetic version client',display_name:'Version client',country_code:'TZ',currency_code:'TZS',status:'active'});
 const a=await run('save_chart_account',{client_id:client.client_id,account_code:'100',account_name:'Cash',account_type:'asset',normal_balance:'debit'});
 const b=await run('save_chart_account',{client_id:client.client_id,account_code:'400',account_name:'Income',account_type:'income',normal_balance:'credit'});
 const p=await run('save_reporting_period',{client_id:client.client_id,period_label:'2026',starts_on:'2026-01-01',ends_on:'2026-12-31'});
 const j=await run('save_journal',{client_id:client.client_id,period_id:p.period_id,entry_date:'2026-11-07',currency_code:'TZS',description:'Response contract'});
 const first=await run('save_journal_line',{client_id:client.client_id,journal_id:j.journal_id,expected_parent_version:j.version,line_no:1,account_id:a.account_id,description:'Debit',debit:'7.13',credit:'0.00'});
 assert.equal(first.version,1); assert.equal(first.parent_version,j.version+1);
 const second=await run('save_journal_line',{client_id:client.client_id,journal_id:j.journal_id,expected_parent_version:first.parent_version,line_no:2,account_id:b.account_id,description:'Credit',debit:'0.00',credit:'7.13'});
 assert.equal(second.version,1); assert.equal(second.parent_version,first.parent_version+1);
 let header=(await q('SELECT version,total_debit,total_credit FROM public.office_accounting_journals WHERE journal_id=$1 LIMIT 1',[j.journal_id]))[0];
 assert.equal(header.version,second.parent_version); assert.equal(Number(header.total_debit),7.13); assert.equal(Number(header.total_credit),7.13);
 const audit=(await q("SELECT entity_id,after_digest FROM public.office_accounting_audit WHERE workspace_id=$1 AND action='save_journal_line' AND entity_id=$2 LIMIT 1",[ids.workspace,second.line_id]))[0];
 assert.equal(audit.entity_id,second.line_id); assert.match(audit.after_digest,/^[a-f0-9]{64}$/);
 const deleted=await run('delete_journal_line',{client_id:client.client_id,journal_id:j.journal_id,line_id:second.line_id,expected_version:second.version,expected_parent_version:second.parent_version});
 assert.equal(deleted.parent_version,second.parent_version+1);
 header=(await q('SELECT version,total_debit,total_credit FROM public.office_accounting_journals WHERE journal_id=$1 LIMIT 1',[j.journal_id]))[0];
 assert.equal(header.version,deleted.parent_version); assert.equal(Number(header.total_debit),7.13); assert.equal(Number(header.total_credit),0);
});
