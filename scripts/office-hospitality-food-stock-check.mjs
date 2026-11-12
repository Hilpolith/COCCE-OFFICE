import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test, { before, after } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const base = await readFile(new URL('../supabase/migrations/20261108010000_office_hospitality_management.sql', import.meta.url), 'utf8');
const feature = await readFile(new URL('../supabase/migrations/20261108010120_office_hospitality_food_stock.sql', import.meta.url), 'utf8');
const ids = {
  owner: '11111111-1111-4111-8111-111111111111',
  workspace: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  property: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  item: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  menu: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  lot: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  order: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
  reservation: '99999999-9999-4999-8999-999999999999',
};
let db;
const q = async (sql, params = []) => (await db.query(sql, params)).rows;
const asOwner = async (fn) => {
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [ids.owner]);
  await db.exec('SET ROLE authenticated');
  try { return await fn(); } finally { await db.exec('RESET ROLE'); }
};
const action = (name, payload) => asOwner(async () => (await db.query(
  'SELECT office_private.hospitality_food_stock_action($1,$2,$3,$4) AS r',
  [ids.workspace, 'hotel_admin', name, payload],
)).rows[0].r);
const fails = async (fn, code) => {
  let error;
  try { await fn(); } catch (e) { error = e; }
  assert.equal(error?.code, code, error?.message);
};

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE SCHEMA office_private;
    CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE TABLE public.office_workspaces(id uuid PRIMARY KEY);
    CREATE TABLE public.office_memberships(workspace_id uuid,user_id uuid,role text,status text,PRIMARY KEY(workspace_id,user_id));
    CREATE TABLE public.office_industry_spaces(workspace_id uuid,industry_id text,PRIMARY KEY(workspace_id,industry_id));
    CREATE FUNCTION office_private.is_active_member(w uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT EXISTS(SELECT 1 FROM public.office_memberships WHERE workspace_id=w AND user_id=auth.uid() AND status='active')$$;
    CREATE FUNCTION office_private.is_admin(w uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$SELECT EXISTS(SELECT 1 FROM public.office_memberships WHERE workspace_id=w AND user_id=auth.uid() AND status='active' AND role IN('owner','admin'))$$;
    GRANT EXECUTE ON FUNCTION office_private.is_active_member(uuid),office_private.is_admin(uuid) TO authenticated;
    CREATE FUNCTION gen_random_uuid() RETURNS uuid LANGUAGE sql VOLATILE AS $$SELECT md5(clock_timestamp()::text || random()::text)::uuid$$;
  `);
  await db.exec(base.replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;', ''));
  await db.exec(feature);
  await db.exec('GRANT EXECUTE ON FUNCTION office_private.hospitality_food_stock_action(uuid,text,text,jsonb) TO authenticated');
  await q('INSERT INTO auth.users VALUES($1)', [ids.owner]);
  await q('INSERT INTO public.office_workspaces VALUES($1)', [ids.workspace]);
  await q("INSERT INTO public.office_memberships VALUES($1,$2,'owner','active')", [ids.workspace, ids.owner]);
  await q("INSERT INTO public.office_industry_spaces VALUES($1,'hospitality')", [ids.workspace]);
  await q(`INSERT INTO public.office_hospitality_properties(id,workspace_id,status,created_by,data) VALUES($1,$2,'active',$3,$4)`, [ids.property,ids.workspace,ids.owner,{code:'P-1',name:'Test property',jurisdiction:'mainland',currency:'TZS'}]);
  await q(`INSERT INTO public.office_hospitality_inventory_items(id,workspace_id,property_id,status,created_by,data) VALUES($1,$2,$3,'active',$4,$5)`, [ids.item,ids.workspace,ids.property,ids.owner,{property_id:ids.property,code:'RICE',name:'Rice',unit:'kg',reorder_level:'1'}]);
  await q(`INSERT INTO public.office_hospitality_menu_items(id,workspace_id,property_id,status,created_by,data) VALUES($1,$2,$3,'active',$4,$5)`, [ids.menu,ids.workspace,ids.property,ids.owner,{property_id:ids.property,code:'MEAL',name:'Meal',category:'food',unit_price:'10.00',tax_amount:'1.00',levy_amount:'0.50'}]);
  await q(`INSERT INTO public.office_hospitality_restaurant_orders(id,workspace_id,property_id,status,created_by,data) VALUES($1,$2,$3,'open',$4,$5)`, [ids.order,ids.workspace,ids.property,ids.owner,{property_id:ids.property,code:'O-1'}]);
  await q(`INSERT INTO public.office_hospitality_reservations(id,workspace_id,property_id,status,created_by,data) VALUES($1,$2,$3,'checked_in',$4,$5)`, [ids.reservation,ids.workspace,ids.property,ids.owner,{property_id:ids.property,code:'R-1'}]);
});

after(() => db?.close());

test('receiving creates an immutable lot and history, then issuing locks versions and rejects expiry/overdraw', async () => {
  const received = await action('receive_stock',{property_id:ids.property,item_id:ids.item,lot_code:'LOT-1',expires_on:'2099-12-31',quantity:'10.000',unit_cost:'2.50',reference:'GRN-1'});
  assert.equal(received.version,1); assert.equal(received.status,'active');
  const history = await q("SELECT data->>'direction' AS direction,data->>'reference' AS reference FROM public.office_hospitality_stock_moves WHERE workspace_id=$1 LIMIT 10",[ids.workspace]);
  assert.deepEqual(history,[{direction:'receive',reference:'GRN-1'}]);
  const issued = await action('issue_stock',{id:received.id,expected_version:1,quantity:'3.250',reference:'KITCHEN-1'});
  assert.equal(issued.version,2);
  const lot = (await q("SELECT version,data->>'quantity' AS quantity FROM public.office_hospitality_stock_lots WHERE id=$1 LIMIT 1",[received.id]))[0];
  assert.equal(Number(lot.version),2); assert.equal(lot.quantity,'6.750');
  await fails(()=>action('issue_stock',{id:received.id,expected_version:1,quantity:'1',reference:'stale'}),'40001');
  await fails(()=>action('issue_stock',{id:received.id,expected_version:2,quantity:'7',reference:'over'}),'22023');
  await q("UPDATE public.office_hospitality_stock_lots SET data=jsonb_set(data,'{expires_on}','\"2000-01-01\"') WHERE id=$1",[received.id]);
  await fails(()=>action('issue_stock',{id:received.id,expected_version:2,quantity:'1',reference:'expired'}),'22023');
});

test('order lines snapshot catalog values and advance the parent version', async () => {
  const added = await action('add_order_line',{id:ids.order,expected_version:1,item_id:ids.menu,quantity:'2.000'});
  assert.equal(added.id,ids.order); assert.equal(added.version,2); assert.equal(added.line_id !== undefined,true);
  await q("UPDATE public.office_hospitality_menu_items SET data=jsonb_set(data,'{unit_price}','\"99.00\"') WHERE id=$1",[ids.menu]);
  const line=(await q("SELECT data FROM public.office_hospitality_order_lines WHERE id=$1 LIMIT 1",[added.line_id]))[0].data;
  assert.equal(line.unit_price,10); assert.equal(line.tax_amount,2); assert.equal(line.levy_amount,1); assert.equal(line.total_amount,23);
  await q("UPDATE public.office_hospitality_restaurant_orders SET status='served' WHERE id=$1",[ids.order]);
  await fails(()=>action('add_order_line',{id:ids.order,expected_version:1,item_id:ids.menu,quantity:'1'}),'40001');
});

test('manual settlement records a finance-visible payment and advances order version', async () => {
  const settled = await action('settle_order',{id:ids.order,expected_version:2,method:'cash',reference:'CASH-7'});
  assert.deepEqual({id:settled.id,version:settled.version,status:settled.status},{id:ids.order,version:3,status:'settled'});
  const payment=(await q("SELECT property_id,data->>'order_id' AS order_id,data->>'method' AS method,data->>'reference' AS reference FROM public.office_hospitality_payments WHERE workspace_id=$1 LIMIT 10",[ids.workspace]))[0];
  assert.deepEqual(payment,{property_id:ids.property,order_id:ids.order,method:'cash',reference:'CASH-7'});
  await fails(()=>action('settle_order',{id:ids.order,expected_version:2,method:'cash',reference:'replay-stale'}),'40001');
});

test('room charge requires checked-in same-property reservation and posts snapshot totals', async () => {
  const order = '88888888-8888-4888-8888-888888888888';
  await q(`INSERT INTO public.office_hospitality_restaurant_orders(id,workspace_id,property_id,status,created_by,data) VALUES($1,$2,$3,'open',$4,$5)`, [order,ids.workspace,ids.property,ids.owner,{property_id:ids.property,code:'O-2'}]);
  const _added=await action('add_order_line',{id:order,expected_version:1,item_id:ids.menu,quantity:'1'});
  await q("UPDATE public.office_hospitality_restaurant_orders SET status='served' WHERE id=$1",[order]);
  const settled=await action('settle_order',{id:order,expected_version:2,method:'room_charge',reservation_id:ids.reservation,reference:'FOLIO-2'});
  assert.equal(settled.status,'settled'); assert.equal(settled.version,3);
  const folio=(await q("SELECT data->>'reservation_id' AS reservation_id,data->>'total_amount' AS total_amount,data->>'reference' AS reference FROM public.office_hospitality_folio_lines WHERE data->>'reference'='FOLIO-2' LIMIT 1"))[0];
  assert.deepEqual(folio,{reservation_id:ids.reservation,total_amount:'100.50',reference:'FOLIO-2'});
  const res=(await q("SELECT version FROM public.office_hospitality_reservations WHERE id=$1 LIMIT 1",[ids.reservation]))[0]; assert.equal(Number(res.version),2);
});
