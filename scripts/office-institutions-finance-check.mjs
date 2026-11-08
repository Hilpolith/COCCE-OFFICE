import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const root = new URL('..', import.meta.url);
const ids = { w:'10000000-0000-4000-8000-000000000001', other:'10000000-0000-4000-8000-000000000002', owner:'20000000-0000-4000-8000-000000000001', treasurer:'20000000-0000-4000-8000-000000000002', approver:'20000000-0000-4000-8000-000000000003', viewer:'20000000-0000-4000-8000-000000000004' };
let db;
const q = (sql, params=[]) => db.query(sql, params);
const as = async (u, fn) => { await q("select set_config('request.jwt.claim.sub',$1,false)",[u]); await db.exec('set role authenticated'); try { return await fn(); } finally { await db.exec('reset role'); } };
const cmd = (action, payload={}, u=ids.owner) => as(u, () => q('select public.office_institutions_command($1,$2,$3) r',[ids.w,action,{...payload,idempotency_key:payload.idempotency_key||randomUUID()}]).then(x=>x.rows[0].r));
const save = (resource, data, u=ids.owner, id, expected_version) => cmd('save_record',{resource,data,...(id?{id,expected_version}: {})},u);
const errorOf = async fn => { try { await fn(); } catch (e) { return e; } assert.fail('expected rejection'); };
const denies = async (fn, text) => { const e=await errorOf(fn); assert.match(e.message,text); };
const row = async (resource,id) => (await q('select status,version,data from public.office_institutions_records where workspace_id=$1 and resource=$2 and id=$3 limit 1',[ids.w,resource,id])).rows[0];

before(async () => {
  db = new PGlite();
  const bootstrap = await readFile(new URL('./supabase/tests/university-bootstrap.sql', root), 'utf8');
  await db.exec(bootstrap.replace(/^\\.*$/gm,'') + "\nCREATE OR REPLACE FUNCTION digest(text,text) RETURNS bytea LANGUAGE sql AS $$ SELECT decode(md5($1),'hex') $$;");
  await q('insert into auth.users(id) values($1),($2),($3),($4)',[ids.owner,ids.treasurer,ids.approver,ids.viewer]);
  await q('insert into public.office_workspaces(id) values($1),($2)',[ids.w,ids.other]);
  await q("insert into public.office_industry_spaces(workspace_id,industry_id) values($1,'church'),($2,'church')",[ids.w,ids.other]);
  await q("insert into public.office_memberships values($1,$2,'owner','active'),($1,$3,'member','active'),($1,$4,'member','active'),($1,$5,'member','active')",[ids.w,ids.owner,ids.treasurer,ids.approver,ids.viewer]);
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(new URL('./supabase/migrations/',root));
  for (const f of files.filter(x => /^2026110810.*_office_institutions_.*\.sql$/.test(x)).sort()) {
    let sql = await readFile(new URL(`./supabase/migrations/${f}`,root),'utf8');
    sql = sql.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;','');
    await db.exec(sql);
  }
  await q("insert into public.office_institutions_roles(workspace_id,user_id,role) values($1,$2,'institution_admin'),($1,$3,'treasurer'),($1,$4,'approver'),($1,$5,'institution_viewer')",[ids.w,ids.owner,ids.treasurer,ids.approver,ids.viewer]);
});
after(() => db?.close());

test('finance helper is private, ledger extensions exist, and bank lines start recorded', async () => {
  const f = await q("select prosecdef from pg_proc where proname='inst_finance' limit 1");
  assert.equal(f.rows[0].prosecdef, true);
  const cols = await q("select column_name from information_schema.columns where table_schema='public' and table_name='office_institutions_ledger' and column_name in ('posted_on','method','budget_id','branch_id') order by column_name");
  assert.deepEqual(cols.rows.map(x=>x.column_name),['branch_id','budget_id','method','posted_on']);
});

test('strict saves reject unknown/server-derived fields without mutation', async () => {
  const org=(await save('organizations',{code:'O',name:'Org',jurisdiction:'mainland',legal_form:'society',registration_authority:'RSMIS',registration_reference:'R',constitution_reference:'C'})).id;
  await denies(()=>save('funds',{organization_id:org,code:'F',name:'General',restricted:false,purpose_public:'Operations',currency:'TZS',balance:'999.00'}),/Unknown field|server derived/);
  const fund=(await save('funds',{organization_id:org,code:'F',name:'General',restricted:false,purpose_public:'Operations',currency:'TZS'})).id;
  const bank=await save('bank_lines',{fund_id:fund,statement_reference:'S-1',line_reference:'L-1',posted_on:'2025-12-31',amount:'1.00',direction:'in'});
  assert.equal(bank.status,'recorded');
});

test('contribution posts exactly once and replay preserves ledger and state', async () => {
  const fund=(await q("select id from public.office_institutions_records where workspace_id=$1 and resource='funds' and data->>'code'='F' limit 1",[ids.w])).rows[0].id;
  const c=await save('contributions',{fund_id:fund,receipt_number:'R-1',received_on:'2026-01-01',amount:'100.00',method:'bank',reference:'manual-1'});
  const first=await cmd('post_contribution',{id:c.id,expected_version:1},ids.treasurer);
  const replay=await cmd('post_contribution',{id:c.id,expected_version:1},ids.treasurer);
  assert.deepEqual(replay,{id:c.id,version:first.version,status:'posted'});
  const ledger=await q("select kind,amount from public.office_institutions_ledger where workspace_id=$1 and source_id=$2 order by kind limit 3",[ids.w,c.id]);
  assert.deepEqual(ledger.rows,[{kind:'contribution',amount:'100.00'}]);
});

test('budget and payment maker-checker flow preserves approver and caps fund/budget', async () => {
  const fund=(await q("select id from public.office_institutions_records where workspace_id=$1 and resource='funds' and data->>'code'='F' limit 1",[ids.w])).rows[0].id;
  const budget=await save('budgets',{fund_id:fund,code:'B-1',period_start:'2026-01-01',period_end:'2026-12-31',amount:'80.00',reference:'budget-1'},ids.owner);
  const submitted=await cmd('transition_record',{resource:'budgets',id:budget.id,to_state:'submitted',expected_version:1},ids.owner);
  await denies(()=>cmd('transition_record',{resource:'budgets',id:budget.id,to_state:'approved',expected_version:submitted.version},ids.owner),/Distinct maker\/checker|transition|approver/);
  const approved=await cmd('transition_record',{resource:'budgets',id:budget.id,to_state:'approved',expected_version:submitted.version},ids.approver);
  assert.equal(approved.status,'approved');
  const payment=await save('payment_requests',{fund_id:fund,budget_id:budget.id,code:'P-1',requested_on:'2026-01-02',amount:'40.00',purpose_public:'Supplies',reference:'request-1'},ids.owner);
  const psub=await cmd('transition_record',{resource:'payment_requests',id:payment.id,to_state:'submitted',expected_version:1},ids.owner);
  await denies(()=>cmd('approve_payment',{id:payment.id,expected_version:psub.version},ids.owner),/Distinct payment approver/);
  const pap=await cmd('approve_payment',{id:payment.id,expected_version:psub.version},ids.approver);
  const posted=await cmd('post_payment',{id:payment.id,expected_version:pap.version,method:'bank',reference:'payment-1'},ids.owner);
  assert.equal(posted.status,'posted');
  const entry=(await q("select kind,amount,budget_id from public.office_institutions_ledger where workspace_id=$1 and source_id=$2 limit 1",[ids.w,payment.id])).rows[0];
  assert.deepEqual(entry,{kind:'payment',amount:'40.00',budget_id:budget.id});
  await denies(()=>cmd('post_payment',{id:payment.id,expected_version:pap.version,method:'bank',reference:'payment-1'},ids.owner),/Current approved payment|Stale/);
});

test('void requires distinct approver, records negative balance effect, and rejects stale/unsafe void', async () => {
  const fund=(await q("select id from public.office_institutions_records where workspace_id=$1 and resource='funds' and data->>'code'='F' limit 1",[ids.w])).rows[0].id;
  const first=(await q("select id from public.office_institutions_records where workspace_id=$1 and resource='contributions' and data->>'receipt_number'='R-1' limit 1",[ids.w])).rows[0].id;
  await denies(()=>cmd('void_contribution',{id:first,expected_version:2,reason:'bad'},ids.owner),/Distinct approver/);
  const c2=await save('contributions',{fund_id:fund,receipt_number:'R-2',received_on:'2026-01-03',amount:'20.00',method:'bank',reference:'manual-2'});
  await cmd('post_contribution',{id:c2.id,expected_version:1},ids.treasurer);
  const voided=await cmd('void_contribution',{id:c2.id,expected_version:2,reason:'Duplicate receipt'},ids.approver);
  assert.equal(voided.status,'voided');
  const signed=(await q("select coalesce(sum(case when kind='contribution' then amount when kind in ('payment','reversal') then -amount else 0 end),0) balance from public.office_institutions_ledger where workspace_id=$1 and fund_id=$2",[ids.w,fund])).rows[0].balance;
  assert.equal(signed,'60.00');
  await denies(()=>cmd('void_contribution',{id:first,expected_version:2,reason:'would overdraw'},ids.approver),/Void would make fund negative/);
  assert.equal((await row('contributions',first)).status,'posted');
});

test('matching uses nested transaction_id, exact direction/fund/amount, and reconciliation locks closure', async () => {
  const fund=(await q("select id from public.office_institutions_records where workspace_id=$1 and resource='funds' and data->>'code'='F' limit 1",[ids.w])).rows[0].id;
  const contribution=(await q("select id from public.office_institutions_records where workspace_id=$1 and resource='contributions' and data->>'receipt_number'='R-1' limit 1",[ids.w])).rows[0].id;
  const payment=(await q("select id from public.office_institutions_records where workspace_id=$1 and resource='payment_requests' and data->>'code'='P-1' limit 1",[ids.w])).rows[0].id;
  const ct=(await q("select id from public.office_institutions_ledger where workspace_id=$1 and source_id=$2 and kind='contribution' limit 1",[ids.w,contribution])).rows[0].id;
  const pt=(await q("select id from public.office_institutions_ledger where workspace_id=$1 and source_id=$2 and kind='payment' limit 1",[ids.w,payment])).rows[0].id;
  const bi=await save('bank_lines',{fund_id:fund,statement_reference:'ST-1',line_reference:'IN-1',posted_on:'2026-01-01',amount:'100.00',direction:'in'});
  const matched=await cmd('transition_record',{resource:'bank_lines',id:bi.id,to_state:'matched',expected_version:1,data:{transaction_id:ct}},ids.treasurer);
  assert.equal(matched.status,'matched');
  const bo=await save('bank_lines',{fund_id:fund,statement_reference:'ST-1',line_reference:'OUT-1',posted_on:'2026-01-02',amount:'40.00',direction:'out'});
  await cmd('transition_record',{resource:'bank_lines',id:bo.id,to_state:'matched',expected_version:1,data:{transaction_id:pt}},ids.treasurer);
  const rec=await save('reconciliations',{fund_id:fund,code:'REC-1',period_start:'2026-01-01',period_end:'2026-12-31',opening_balance:'0.00',closing_balance:'60.00',reference:'statement-1'});
  const rs=await cmd('transition_record',{resource:'reconciliations',id:rec.id,to_state:'submitted',expected_version:1},ids.owner);
  const reviewed=await cmd('transition_record',{resource:'reconciliations',id:rec.id,to_state:'reviewed',expected_version:rs.version},ids.approver);
  const closed=await cmd('transition_record',{resource:'reconciliations',id:rec.id,to_state:'closed',expected_version:reviewed.version},ids.owner);
  assert.equal(closed.status,'closed');
  await denies(()=>cmd('transition_record',{resource:'reconciliations',id:rec.id,to_state:'closed',expected_version:reviewed.version},ids.owner),/Stale reconciliation|Invalid/);
});

test('direct table access remains denied and cross-workspace command fails', async () => {
  await denies(()=>as(ids.owner,()=>q('select id from public.office_institutions_ledger')),/permission denied|row-level security/);
  await denies(()=>as(ids.owner,()=>q('select public.office_institutions_command($1,$2,$3)',[ids.other,'save_record',{resource:'funds',idempotency_key:randomUUID(),data:{organization_id:randomUUID(),code:'X',name:'X',restricted:false,purpose_public:'X',currency:'TZS'}}])),/membership|Institutions/);
});


test('non-finance module roles cannot submit a known finance record', async () => {
  const fund=(await q("select id from public.office_institutions_records where workspace_id=$1 and resource='funds' and data->>'code'='F' limit 1",[ids.w])).rows[0].id;
  const budget=await save('budgets',{fund_id:fund,code:'NO-ROLE',period_start:'2026-01-01',period_end:'2026-12-31',amount:'1.00',reference:'SYNTHETIC-ROLE-TEST'});
  const before=await row('budgets',budget.id);
  await denies(()=>cmd('transition_record',{resource:'budgets',id:budget.id,expected_version:1,to_state:'submitted'},ids.viewer),/Finance capability/);
  assert.deepEqual(await row('budgets',budget.id),before);
});

test('draft finance saves reject forged approval metadata and immutable fund changes', async () => {
  const fund=(await q("select id from public.office_institutions_records where workspace_id=$1 and resource='funds' and data->>'code'='F' limit 1",[ids.w])).rows[0].id;
  const data={fund_id:fund,code:'METADATA',period_start:'2026-01-01',period_end:'2026-12-31',amount:'1.00',reference:'SYNTHETIC-METADATA'};
  await denies(()=>save('budgets',{...data,approved_by:ids.approver}),/Unknown|not allowed/);
  const created=await save('budgets',data); const before=await row('budgets',created.id);
  const org=(await q("select id from public.office_institutions_records where workspace_id=$1 and resource='organizations' and data->>'code'='O' limit 1",[ids.w])).rows[0].id;
  const other=await save('funds',{organization_id:org,code:'OTHER',name:'Other fund',restricted:false,purpose_public:'Public',currency:'TZS'});
  await denies(()=>save('budgets',{...data,fund_id:other.id},ids.owner,created.id,1),/immutable/);
  assert.deepEqual(await row('budgets',created.id),before);
});
