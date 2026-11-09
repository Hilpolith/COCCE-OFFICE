import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, beforeEach, afterEach, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const foundation = await readFile(new URL('../supabase/migrations/20261104080000_office_cloud_files.sql', import.meta.url), 'utf8');
const migration = await readFile(new URL('../supabase/migrations/20261109190000_office_cloud_storage_subscriptions.sql', import.meta.url), 'utf8');
const owner='11111111-1111-4111-8111-111111111111';
const member='22222222-2222-4222-8222-222222222222';
const low='33333333-3333-4333-8333-333333333333';
const workspace='44444444-4444-4444-8444-444444444444';
const lowWorkspace='55555555-5555-4555-8555-555555555555';
let db;

before(async()=>{
 db=new PGlite();
 const setup=[
  'CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;',
  'CREATE SCHEMA auth;',
  'CREATE TABLE auth.users(id uuid PRIMARY KEY);',
  "CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;",
  'CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id),cocce_coins integer NOT NULL DEFAULT 0,wallet_pin_hash text);',
  "CREATE TABLE public.wallet_transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,type text NOT NULL CHECK(type IN ('purchase','campaign','transfer_sent','transfer_received','vip_purchase')),amount integer NOT NULL,description text,related_id uuid REFERENCES public.profiles(id),created_at timestamptz DEFAULT now(),balance bigint DEFAULT 0,hidden_by_owner boolean NOT NULL DEFAULT false);",
  "CREATE FUNCTION public.test_wallet_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF coalesce(current_setting('wallet.atomic_writer',true),'')<>'v2' THEN RAISE EXCEPTION 'wallet writes require atomic operation' USING ERRCODE='42501'; END IF; RETURN NEW; END; $$;",
  "CREATE FUNCTION public.test_wallet_balance() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE v bigint; BEGIN PERFORM 1 FROM public.profiles WHERE id=NEW.user_id FOR UPDATE; SELECT balance INTO v FROM public.wallet_transactions WHERE user_id=NEW.user_id ORDER BY created_at DESC,id DESC LIMIT 1; NEW.balance:=coalesce(v,0)+NEW.amount; IF NEW.balance<0 THEN RAISE EXCEPTION 'insufficient wallet coins' USING ERRCODE='P0001'; END IF; UPDATE public.profiles SET cocce_coins=NEW.balance WHERE id=NEW.user_id; RETURN NEW; END; $$;",
  'CREATE TRIGGER test_wallet_guard BEFORE INSERT ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION public.test_wallet_guard();',
  'CREATE TRIGGER test_wallet_balance BEFORE INSERT ON public.wallet_transactions FOR EACH ROW EXECUTE FUNCTION public.test_wallet_balance();',
  'CREATE TABLE public.office_workspaces(id uuid PRIMARY KEY,name text NOT NULL,created_by uuid NOT NULL REFERENCES auth.users(id));',
  "CREATE TABLE public.office_memberships(workspace_id uuid NOT NULL REFERENCES public.office_workspaces(id),user_id uuid NOT NULL REFERENCES auth.users(id),role text NOT NULL CHECK(role IN ('owner','admin','member')),status text NOT NULL CHECK(status IN ('active','suspended','removed')),PRIMARY KEY(workspace_id,user_id));"
 ].join('\n');
 await db.exec(setup);
 await db.exec(foundation);
 await db.query('INSERT INTO auth.users(id) VALUES ($1),($2),($3)',[owner,member,low]);
 await db.query('INSERT INTO public.profiles(id) VALUES ($1),($2),($3)',[owner,member,low]);
 await db.query('INSERT INTO public.office_workspaces(id,name,created_by) VALUES ($1,$2,$3),($4,$5,$6)',[workspace,'Synthetic workspace',owner,lowWorkspace,'Low balance workspace',low]);
 await db.query("INSERT INTO public.office_memberships VALUES ($1,$2,'owner','active'),($1,$3,'member','active'),($4,$5,'owner','active')",[workspace,owner,member,lowWorkspace,low]);
 await db.exec("SELECT set_config('wallet.atomic_writer','v2',false)");
 await db.query("INSERT INTO public.wallet_transactions(user_id,type,amount,description) VALUES ($1,'purchase',100000,'synthetic funding'),($2,'purchase',3000,'synthetic funding')",[owner,low]);
 await db.exec(migration);
});
beforeEach(async()=>{await db.exec('BEGIN');});
afterEach(async()=>{await db.exec('ROLLBACK');});
after(async()=>{await db?.close();});

async function rpc(name,args){
 const params=args.map((_,i)=>'$'+(i+1)).join(',');
 return (await db.query('SELECT public.'+name+'('+params+') AS result',args)).rows[0].result;
}
async function expectError(work,code){
 await db.exec('SAVEPOINT expected_error'); let error;
 try{await work();}catch(e){error=e;}
 await db.exec('ROLLBACK TO SAVEPOINT expected_error; RELEASE SAVEPOINT expected_error');
 assert.equal(error?.code,code,error?.message); return error;
}
async function balance(user){
 return Number((await db.query('SELECT cocce_coins FROM public.profiles WHERE id=$1',[user])).rows[0].cocce_coins);
}
async function quota(workspaceId){
 return (await db.query('SELECT base_quota_bytes,purchased_quota_bytes,subscription_quota_bytes,quota_bytes FROM public.office_cloud_workspace_quotas WHERE workspace_id=$1',[workspaceId])).rows[0];
}
async function enableBilling(){ await db.exec("UPDATE public.office_cloud_storage_billing_config SET enabled=true,price_approved_at=now(),wallet_security_approved_at=now() WHERE singleton=true"); }
async function purchase(user,space,plan,key,auto=false){
 return rpc('office_cloud_purchase_storage_subscription',[user,space,plan,key,auto]);
}

test('seeds the six approved monthly plans and exposes them only through the membership-checked API',async()=>{
 const disabledPlans=await rpc('office_cloud_list_storage_plans',[owner,workspace]);
 assert.deepEqual(disabledPlans,[]);
 await enableBilling();
 const plans=await rpc('office_cloud_list_storage_plans',[owner,workspace]);
 assert.deepEqual(plans.map(p=>[p.display_name,p.quota_bytes,p.monthly_coins]),[
  ['5 GB',5_000_000_000,2000],['25 GB',25_000_000_000,5000],
  ['100 GB',100_000_000_000,12000],['250 GB',250_000_000_000,25000],
  ['1 TB',1_000_000_000_000,60000],['2 TB',2_000_000_000_000,100000]
 ]);
 assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='public.office_cloud_storage_subscriptions'::regclass")).rows[0].relrowsecurity,true);
 assert.equal((await db.query("SELECT has_table_privilege('authenticated','public.office_cloud_storage_subscriptions','SELECT') AS ok")).rows[0].ok,false);
});

test('requires workspace owner/admin and purchase is idempotent, atomic, and additive',async()=>{
 await expectError(()=>purchase(member,workspace,'storage_5gb_monthly','66666666-6666-4666-8666-666666666666'),'42501');
 await expectError(()=>rpc('office_cloud_list_storage_subscriptions',[member,workspace]),'42501');
 await db.query('INSERT INTO public.office_cloud_workspace_quotas(workspace_id,tier_code,base_quota_bytes,purchased_quota_bytes) VALUES ($1,$2,$3,$4)',[workspace,'small_office',5_000_000_000,1234]);
 const before=await balance(owner), key='77777777-7777-4777-8777-777777777777';
 const first=await purchase(owner,workspace,'storage_25gb_monthly',key,false);
 assert.equal(first.monthly_coins,5000); assert.equal(first.auto_renew,false);
 assert.equal(Number(first.balance),before-5000);
 const replay=await purchase(owner,workspace,'storage_25gb_monthly',key,false);
 assert.equal(replay.subscription_id,first.subscription_id); assert.equal(replay.replayed,true);
 assert.equal(await balance(owner),before-5000);
 await expectError(()=>purchase(owner,workspace,'storage_5gb_monthly',key,false),'22023');
 const q=await quota(workspace);
 assert.equal(Number(q.purchased_quota_bytes),25_000_001_234);
 assert.equal(Number(q.subscription_quota_bytes),25_000_000_000);
 assert.equal(Number(q.quota_bytes),30_000_001_234);
 const tx=(await db.query('SELECT type,amount,balance FROM public.wallet_transactions WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1',[owner])).rows[0];
 assert.equal(tx.type,'purchase'); assert.equal(tx.amount,-5000); assert.equal(Number(tx.balance),before-5000);
});

test('insufficient coins roll back the subscription, quota row and ledger debit',async()=>{
 await enableBilling();
 const before=await balance(low);
 await expectError(()=>purchase(low,lowWorkspace,'storage_25gb_monthly','88888888-8888-4888-8888-888888888888',false),'P0001');
 assert.equal(await balance(low),before);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM public.office_cloud_storage_subscriptions WHERE workspace_id=$1',[lowWorkspace])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM public.office_cloud_workspace_quotas WHERE workspace_id=$1',[lowWorkspace])).rows[0].n,0);
});

test('manual renewal extends a period once and records purchase plus renewal history',async()=>{
 await enableBilling();
 const bought=await purchase(owner,workspace,'storage_5gb_monthly','99999999-9999-4999-8999-999999999999',false);
 const before=await balance(owner), key='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
 const first=await rpc('office_cloud_renew_storage_subscription',[owner,bought.subscription_id,key]);
 const afterFirst=await balance(owner);
 assert.equal(afterFirst,before-2000);
 const replay=await rpc('office_cloud_renew_storage_subscription',[owner,bought.subscription_id,key]);
 assert.equal(replay.replayed,true); assert.equal(await balance(owner),afterFirst);
 const history=await rpc('office_cloud_list_storage_history',[owner,workspace]);
 assert.ok(history.some(e=>e.event_type==='purchased')); assert.ok(history.some(e=>e.event_type==='renewed'));
 assert.equal(first.status,'active');
});

test('auto-renew charges the wallet once when due and preserves the subscription quota',async()=>{
 await enableBilling();
 const bought=await purchase(owner,workspace,'storage_5gb_monthly','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
 const before=await balance(owner);
 await db.query("UPDATE public.office_cloud_storage_subscriptions SET current_period_end=now()-interval '1 hour',next_billing_at=now()-interval '1 hour' WHERE subscription_id=$1",[bought.subscription_id]);
 const result=await rpc('office_cloud_process_storage_renewals',[100]);
 assert.equal(result.renewed,1); assert.equal(await balance(owner),before-2000);
 assert.equal(Number((await quota(workspace)).subscription_quota_bytes),5_000_000_000);
});

test('failed auto-renew gets a three-day grace, then expires only its quota without deleting files',async()=>{
 await enableBilling();
 const bought=await purchase(low,lowWorkspace,'storage_5gb_monthly','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
 await db.query("UPDATE public.office_cloud_storage_subscriptions SET current_period_end=now()-interval '1 hour',next_billing_at=now()-interval '1 hour' WHERE subscription_id=$1",[bought.subscription_id]);
 const failed=await rpc('office_cloud_process_storage_renewals',[100]);
 assert.equal(failed.failed,1);
 let sub=(await db.query('SELECT status,grace_until FROM public.office_cloud_storage_subscriptions WHERE subscription_id=$1',[bought.subscription_id])).rows[0];
 assert.equal(sub.status,'past_due'); assert.ok(Date.parse(sub.grace_until)>Date.now());
 assert.equal(Number((await quota(lowWorkspace)).subscription_quota_bytes),5_000_000_000);
 await db.query("UPDATE public.office_cloud_storage_subscriptions SET grace_until=now()-interval '1 second',next_billing_at=now()-interval '1 second' WHERE subscription_id=$1",[bought.subscription_id]);
 const expired=await rpc('office_cloud_process_storage_renewals',[100]);
 assert.equal(expired.expired,1);
 sub=(await db.query('SELECT status FROM public.office_cloud_storage_subscriptions WHERE subscription_id=$1',[bought.subscription_id])).rows[0];
 assert.equal(sub.status,'expired');
 assert.equal(Number((await quota(lowWorkspace)).subscription_quota_bytes),0);
});

test('auto-renew opt-out cancels at period end without another debit',async()=>{
 await enableBilling();
 const bought=await purchase(owner,workspace,'storage_5gb_monthly','dddddddd-dddd-4ddd-8ddd-dddddddddddd',true);
 await rpc('office_cloud_set_storage_subscription_auto_renew',[owner,bought.subscription_id,false]);
 const before=await balance(owner);
 await db.query("UPDATE public.office_cloud_storage_subscriptions SET current_period_end=now()-interval '1 hour' WHERE subscription_id=$1",[bought.subscription_id]);
 const result=await rpc('office_cloud_process_storage_renewals',[100]);
 assert.equal(result.expired,1); assert.equal(await balance(owner),before);
 assert.equal(Number((await quota(workspace)).subscription_quota_bytes),0);
});

test('billing RPCs and subscription tables remain unavailable to browser roles',async()=>{
 for(const role of ['anon','authenticated','service_role']){
  const allowed=(await db.query('SELECT has_table_privilege($1,$2,$3) AS ok',[role,'public.office_cloud_storage_subscriptions','SELECT'])).rows[0].ok;
  assert.equal(allowed,false);
 }
 assert.equal((await db.query("SELECT has_function_privilege('authenticated','public.office_cloud_purchase_storage_subscription(uuid,uuid,text,uuid,boolean)','EXECUTE') AS ok")).rows[0].ok,false);
 assert.equal((await db.query("SELECT has_function_privilege('service_role','public.office_cloud_purchase_storage_subscription(uuid,uuid,text,uuid,boolean)','EXECUTE') AS ok")).rows[0].ok,true);
 assert.equal((await db.query("SELECT has_function_privilege('service_role','public.office_cloud_process_storage_renewals(integer)','EXECUTE') AS ok")).rows[0].ok,false);
});


test('wallet PIN attempt guard is private and progressively locks after repeated failures',async()=>{
 const initial=await rpc('office_cloud_wallet_pin_guard',[owner,null]);
 assert.equal(initial.allowed,true);
 for(let attempt=1;attempt<=5;attempt++){
  const result=await rpc('office_cloud_wallet_pin_guard',[owner,false]);
  if(attempt<5) assert.equal(result.allowed,true);
  else assert.equal(result.allowed,false);
 }
 const locked=await rpc('office_cloud_wallet_pin_guard',[owner,null]);
 assert.equal(locked.allowed,false);
 assert.equal((await db.query("SELECT has_function_privilege('authenticated','public.office_cloud_wallet_pin_guard(uuid,boolean)','EXECUTE') AS ok")).rows[0].ok,false);
});

test('server-side billing remains disabled until both owner approval flags are set',async()=>{
 const plans=await rpc('office_cloud_list_storage_plans',[owner,workspace]);
 assert.deepEqual(plans,[]);
 await expectError(()=>purchase(owner,workspace,'storage_5gb_monthly','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',false),'55000');
 assert.equal((await db.query("SELECT enabled,price_approved_at,wallet_security_approved_at FROM public.office_cloud_storage_billing_config WHERE singleton=true")).rows[0].enabled,false);
});
