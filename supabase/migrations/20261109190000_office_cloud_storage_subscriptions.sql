-- Monthly, workspace-owned COCCE Office Cloud storage add-ons.
-- All wallet writes are made inside these SECURITY DEFINER RPCs using the
-- existing wallet.atomic_writer=v2 guard and immutable wallet_transactions ledger.
-- Existing base quotas and non-subscription purchased quota are preserved.

alter table public.office_cloud_workspace_quotas
  add column if not exists subscription_quota_bytes bigint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.office_cloud_workspace_quotas'::regclass
      and conname = 'office_cloud_workspace_quotas_subscription_quota_bytes_check'
  ) then
    alter table public.office_cloud_workspace_quotas
      add constraint office_cloud_workspace_quotas_subscription_quota_bytes_check
      check (subscription_quota_bytes >= 0);
  end if;
end
$$;

create table if not exists public.office_cloud_storage_plans (
  plan_code text primary key,
  display_name text not null check (char_length(display_name) between 1 and 80),
  quota_bytes bigint not null check (quota_bytes > 0),
  monthly_coins integer not null check (monthly_coins > 0),
  sort_order smallint not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.office_cloud_storage_plans
  (plan_code, display_name, quota_bytes, monthly_coins, sort_order)
values
  ('storage_5gb_monthly', '5 GB', 5000000000, 2000, 1),
  ('storage_25gb_monthly', '25 GB', 25000000000, 5000, 2),
  ('storage_100gb_monthly', '100 GB', 100000000000, 12000, 3),
  ('storage_250gb_monthly', '250 GB', 250000000000, 25000, 4),
  ('storage_1tb_monthly', '1 TB', 1000000000000, 60000, 5),
  ('storage_2tb_monthly', '2 TB', 2000000000000, 100000, 6)
on conflict (plan_code) do nothing;

create table if not exists public.office_cloud_storage_billing_config (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  price_approved_at timestamptz,
  wallet_security_approved_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.office_cloud_storage_billing_config (singleton, enabled)
values (true, false)
on conflict (singleton) do nothing;

create table if not exists public.office_cloud_storage_subscriptions (
  subscription_id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.office_workspaces(id) on delete restrict,
  billing_user_id uuid references auth.users(id) on delete set null,
  plan_code text not null references public.office_cloud_storage_plans(plan_code) on delete restrict,
  quota_bytes bigint not null check (quota_bytes > 0),
  monthly_coins integer not null check (monthly_coins > 0),
  status text not null default 'active'
    check (status in ('active', 'past_due', 'expired')),
  auto_renew boolean not null default false,
  cancel_at_period_end boolean not null default false,
  purchase_idempotency_key uuid not null,
  purchase_wallet_transaction_id uuid references public.wallet_transactions(id) on delete set null,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  next_billing_at timestamptz,
  grace_until timestamptz,
  last_billed_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint office_cloud_storage_subscription_period_check
    check (current_period_end > current_period_start),
  constraint office_cloud_storage_subscription_idempotency_key
    unique (billing_user_id, purchase_idempotency_key)
);

create index if not exists office_cloud_storage_subscriptions_due_idx
  on public.office_cloud_storage_subscriptions (next_billing_at, subscription_id)
  where status in ('active', 'past_due');

create index if not exists office_cloud_storage_subscriptions_workspace_idx
  on public.office_cloud_storage_subscriptions (workspace_id, created_at desc);

create table if not exists public.office_cloud_storage_subscription_events (
  event_id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.office_cloud_storage_subscriptions(subscription_id) on delete cascade,
  workspace_id uuid not null references public.office_workspaces(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in (
    'purchased', 'renewed', 'renewal_failed', 'auto_renew_enabled',
    'auto_renew_disabled', 'expired'
  )),
  plan_code text not null references public.office_cloud_storage_plans(plan_code) on delete restrict,
  coins integer not null default 0 check (coins >= 0),
  quota_bytes bigint not null check (quota_bytes > 0),
  period_start timestamptz,
  period_end timestamptz,
  wallet_transaction_id uuid references public.wallet_transactions(id) on delete set null,
  idempotency_key uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists office_cloud_storage_subscription_events_idempotency_idx
  on public.office_cloud_storage_subscription_events (subscription_id, event_type, idempotency_key)
  where idempotency_key is not null;

create index if not exists office_cloud_storage_subscription_events_workspace_idx
  on public.office_cloud_storage_subscription_events (workspace_id, created_at desc);

alter table public.office_cloud_storage_plans enable row level security;
alter table public.office_cloud_storage_subscriptions enable row level security;
alter table public.office_cloud_storage_subscription_events enable row level security;

revoke all on public.office_cloud_storage_plans from public, anon, authenticated, service_role;
revoke all on public.office_cloud_storage_subscriptions from public, anon, authenticated, service_role;
revoke all on public.office_cloud_storage_subscription_events from public, anon, authenticated, service_role;

create or replace function public.office_cloud_list_storage_plans(
  p_actor_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if p_actor_id is null or p_workspace_id is null then
    raise exception 'Invalid storage plan request' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.office_memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_actor_id
      and m.status = 'active'
  ) then
    raise exception 'Workspace access denied' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.office_cloud_storage_billing_config c
    where c.singleton and c.enabled
      and c.price_approved_at is not null
      and c.wallet_security_approved_at is not null
  ) then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'plan_code', p.plan_code,
      'display_name', p.display_name,
      'quota_bytes', p.quota_bytes,
      'monthly_coins', p.monthly_coins,
      'sort_order', p.sort_order
    ) order by p.sort_order)
    from public.office_cloud_storage_plans p
    where p.is_active
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.office_cloud_list_storage_subscriptions(
  p_actor_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if p_actor_id is null or p_workspace_id is null then
    raise exception 'Invalid storage subscription request' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.office_memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_actor_id
      and m.status = 'active'
      and m.role in ('owner', 'admin')
  ) then
    raise exception 'Workspace administrator access required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'subscription_id', s.subscription_id,
      'workspace_id', s.workspace_id,
      'plan_code', s.plan_code,
      'display_name', p.display_name,
      'quota_bytes', s.quota_bytes,
      'monthly_coins', s.monthly_coins,
      'status', s.status,
      'auto_renew', s.auto_renew,
      'cancel_at_period_end', s.cancel_at_period_end,
      'current_period_start', s.current_period_start,
      'current_period_end', s.current_period_end,
      'next_billing_at', s.next_billing_at,
      'grace_until', s.grace_until,
      'last_billed_at', s.last_billed_at,
      'created_at', s.created_at
    ) order by s.created_at desc)
    from public.office_cloud_storage_subscriptions s
    join public.office_cloud_storage_plans p on p.plan_code = s.plan_code
    where s.workspace_id = p_workspace_id
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.office_cloud_list_storage_history(
  p_actor_id uuid,
  p_workspace_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if p_actor_id is null or p_workspace_id is null then
    raise exception 'Invalid storage history request' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.office_memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_actor_id
      and m.status = 'active'
      and m.role in ('owner', 'admin')
  ) then
    raise exception 'Workspace administrator access required' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'event_id', e.event_id,
      'subscription_id', e.subscription_id,
      'event_type', e.event_type,
      'plan_code', e.plan_code,
      'display_name', p.display_name,
      'coins', e.coins,
      'quota_bytes', e.quota_bytes,
      'period_start', e.period_start,
      'period_end', e.period_end,
      'created_at', e.created_at
    ) order by e.created_at desc)
    from (
      select * from public.office_cloud_storage_subscription_events
      where workspace_id = p_workspace_id
      order by created_at desc
      limit 50
    ) e
    join public.office_cloud_storage_plans p on p.plan_code = e.plan_code
  ), '[]'::jsonb);
end;
$function$;

create or replace function public.office_cloud_purchase_storage_subscription(
  p_actor_id uuid,
  p_workspace_id uuid,
  p_plan_code text,
  p_idempotency_key uuid,
  p_auto_renew boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_plan public.office_cloud_storage_plans%rowtype;
  v_existing public.office_cloud_storage_subscriptions%rowtype;
  v_subscription_id uuid;
  v_wallet_transaction_id uuid;
  v_balance bigint;
  v_new_balance bigint;
  v_period_start timestamptz := clock_timestamp();
  v_period_end timestamptz;
begin
  if p_actor_id is null or p_workspace_id is null or p_plan_code is null or p_idempotency_key is null then
    raise exception 'Invalid storage purchase request' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.office_memberships m
    where m.workspace_id = p_workspace_id
      and m.user_id = p_actor_id
      and m.status = 'active'
      and m.role in ('owner', 'admin')
  ) then
    raise exception 'Workspace administrator access required' using errcode = '42501';
  end if;
  select * into v_plan
  from public.office_cloud_storage_plans
  where plan_code = p_plan_code and is_active;
  if not found then
    raise exception 'Storage plan unavailable' using errcode = '22023';
  end if;

  insert into public.office_cloud_workspace_quotas (workspace_id, tier_code, base_quota_bytes)
  select p_workspace_id, t.tier_code, t.default_quota_bytes
  from public.office_cloud_storage_tiers t
  where t.tier_code = 'small_office'
  on conflict (workspace_id) do nothing;

  perform 1 from public.office_cloud_workspace_quotas q
  where q.workspace_id = p_workspace_id
  for update;
  if not found then
    raise exception 'Workspace cloud quota unavailable' using errcode = '55000';
  end if;

  select * into v_existing
  from public.office_cloud_storage_subscriptions s
  where s.billing_user_id = p_actor_id
    and s.purchase_idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_existing.workspace_id <> p_workspace_id
       or v_existing.plan_code <> p_plan_code
       or v_existing.auto_renew <> coalesce(p_auto_renew, false) then
      raise exception 'Storage purchase idempotency key payload mismatch' using errcode = '22023';
    end if;
    select coalesce(w.balance, 0) into v_balance
    from public.wallet_transactions w
    where w.user_id = p_actor_id
    order by w.created_at desc, w.id desc
    limit 1;
    return jsonb_build_object(
      'subscription_id', v_existing.subscription_id,
      'plan_code', v_existing.plan_code,
      'quota_bytes', v_existing.quota_bytes,
      'monthly_coins', v_existing.monthly_coins,
      'status', v_existing.status,
      'auto_renew', v_existing.auto_renew,
      'current_period_end', v_existing.current_period_end,
      'balance', coalesce(v_balance, 0),
      'replayed', true
    );
  end if;

  if not exists (
    select 1 from public.office_cloud_storage_billing_config c
    where c.singleton and c.enabled
      and c.price_approved_at is not null
      and c.wallet_security_approved_at is not null
  ) then
    raise exception 'Office storage billing is not enabled' using errcode = '55000';
  end if;

  perform 1 from public.profiles p where p.id = p_actor_id for update;
  if not found then
    raise exception 'COCCE wallet unavailable' using errcode = 'P0002';
  end if;
  select coalesce((
    select w.balance from public.wallet_transactions w
    where w.user_id = p_actor_id
    order by w.created_at desc, w.id desc limit 1
  ), 0) into v_balance;
  if v_balance < v_plan.monthly_coins then
    raise exception 'Insufficient COCCE Coins' using errcode = 'P0001';
  end if;

  v_period_end := v_period_start + interval '1 month';
  insert into public.office_cloud_storage_subscriptions (
    workspace_id, billing_user_id, plan_code, quota_bytes, monthly_coins,
    auto_renew, cancel_at_period_end, purchase_idempotency_key,
    current_period_start, current_period_end, next_billing_at
  ) values (
    p_workspace_id, p_actor_id, v_plan.plan_code, v_plan.quota_bytes, v_plan.monthly_coins,
    coalesce(p_auto_renew, false), false, p_idempotency_key,
    v_period_start, v_period_end,
    case when coalesce(p_auto_renew, false) then v_period_end else null end
  ) on conflict (billing_user_id, purchase_idempotency_key) do nothing
  returning subscription_id into v_subscription_id;
  if v_subscription_id is null then
    select * into v_existing from public.office_cloud_storage_subscriptions s
    where s.billing_user_id = p_actor_id and s.purchase_idempotency_key = p_idempotency_key
    for update;
    if not found or v_existing.workspace_id <> p_workspace_id
       or v_existing.plan_code <> p_plan_code
       or v_existing.auto_renew <> coalesce(p_auto_renew, false) then
      raise exception 'Storage purchase idempotency key payload mismatch' using errcode = '22023';
    end if;
    select coalesce((
      select w.balance from public.wallet_transactions w
      where w.user_id = p_actor_id
      order by w.created_at desc, w.id desc limit 1
    ), 0) into v_balance;
    return jsonb_build_object(
      'subscription_id', v_existing.subscription_id,
      'plan_code', v_existing.plan_code,
      'quota_bytes', v_existing.quota_bytes,
      'monthly_coins', v_existing.monthly_coins,
      'status', v_existing.status,
      'auto_renew', v_existing.auto_renew,
      'current_period_end', v_existing.current_period_end,
      'balance', v_balance,
      'replayed', true
    );
  end if;

  perform set_config('wallet.atomic_writer', 'v2', true);
  insert into public.wallet_transactions (user_id, type, amount, description, related_id)
  values (
    p_actor_id,
    'purchase',
    -v_plan.monthly_coins,
    'Office Drive ' || v_plan.display_name || ' monthly storage',
    null
  )
  returning id, balance into v_wallet_transaction_id, v_new_balance;

  update public.office_cloud_storage_subscriptions
  set purchase_wallet_transaction_id = v_wallet_transaction_id,
      last_billed_at = v_period_start,
      updated_at = now()
  where subscription_id = v_subscription_id;

  update public.office_cloud_workspace_quotas
  set purchased_quota_bytes = purchased_quota_bytes + v_plan.quota_bytes,
      subscription_quota_bytes = subscription_quota_bytes + v_plan.quota_bytes,
      updated_at = now()
  where workspace_id = p_workspace_id;

  insert into public.office_cloud_storage_subscription_events (
    subscription_id, workspace_id, actor_id, event_type, plan_code,
    coins, quota_bytes, period_start, period_end, wallet_transaction_id, idempotency_key
  ) values (
    v_subscription_id, p_workspace_id, p_actor_id, 'purchased', v_plan.plan_code,
    v_plan.monthly_coins, v_plan.quota_bytes, v_period_start, v_period_end,
    v_wallet_transaction_id, p_idempotency_key
  );

  return jsonb_build_object(
    'subscription_id', v_subscription_id,
    'plan_code', v_plan.plan_code,
    'display_name', v_plan.display_name,
    'quota_bytes', v_plan.quota_bytes,
    'monthly_coins', v_plan.monthly_coins,
    'status', 'active',
    'auto_renew', coalesce(p_auto_renew, false),
    'current_period_start', v_period_start,
    'current_period_end', v_period_end,
    'wallet_transaction_id', v_wallet_transaction_id,
    'balance', v_new_balance,
    'replayed', false
  );
end;
$function$;

create or replace function public.office_cloud_renew_storage_subscription(
  p_actor_id uuid,
  p_subscription_id uuid,
  p_idempotency_key uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_workspace_id uuid;
  v_sub public.office_cloud_storage_subscriptions%rowtype;
  v_wallet_transaction_id uuid;
  v_balance bigint;
  v_new_balance bigint;
  v_period_start timestamptz;
  v_period_end timestamptz;
  v_existing_event public.office_cloud_storage_subscription_events%rowtype;
begin
  if p_actor_id is null or p_subscription_id is null or p_idempotency_key is null then
    raise exception 'Invalid storage renewal request' using errcode = '22023';
  end if;
  select s.workspace_id into v_workspace_id
  from public.office_cloud_storage_subscriptions s
  where s.subscription_id = p_subscription_id;
  if not found then raise exception 'Storage subscription unavailable' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.office_memberships m
    where m.workspace_id = v_workspace_id and m.user_id = p_actor_id
      and m.status = 'active' and m.role in ('owner', 'admin')
  ) then raise exception 'Workspace administrator access required' using errcode = '42501'; end if;

  perform 1 from public.office_cloud_workspace_quotas q
  where q.workspace_id = v_workspace_id for update;
  select * into v_sub from public.office_cloud_storage_subscriptions s
  where s.subscription_id = p_subscription_id and s.workspace_id = v_workspace_id for update;
  if not found or v_sub.status = 'expired' then
    raise exception 'Storage subscription is no longer renewable' using errcode = '55000';
  end if;

  select * into v_existing_event
  from public.office_cloud_storage_subscription_events e
  where e.subscription_id = p_subscription_id
    and e.event_type = 'renewed'
    and e.idempotency_key = p_idempotency_key;
  if found then
    select coalesce(w.balance, 0) into v_balance
    from public.wallet_transactions w
    where w.user_id = p_actor_id
    order by w.created_at desc, w.id desc limit 1;
    return jsonb_build_object(
      'subscription_id', v_sub.subscription_id,
      'status', v_sub.status,
      'current_period_end', v_sub.current_period_end,
      'balance', coalesce(v_balance, 0),
      'replayed', true
    );
  end if;

  if not exists (
    select 1 from public.office_cloud_storage_billing_config c
    where c.singleton and c.enabled
      and c.price_approved_at is not null
      and c.wallet_security_approved_at is not null
  ) then
    raise exception 'Office storage billing is not enabled' using errcode = '55000';
  end if;
  if v_sub.status = 'past_due' and v_sub.grace_until <= now() then
    raise exception 'Storage subscription grace period has ended' using errcode = '55000';
  end if;
  perform 1 from public.profiles p where p.id = p_actor_id for update;
  if not found then raise exception 'COCCE wallet unavailable' using errcode = 'P0002'; end if;
  select coalesce((
    select w.balance from public.wallet_transactions w
    where w.user_id = p_actor_id
    order by w.created_at desc, w.id desc limit 1
  ), 0) into v_balance;
  if v_balance < v_sub.monthly_coins then
    raise exception 'Insufficient COCCE Coins' using errcode = 'P0001';
  end if;

  v_period_start := greatest(v_sub.current_period_end, now());
  v_period_end := v_period_start + interval '1 month';
  perform set_config('wallet.atomic_writer', 'v2', true);
  insert into public.wallet_transactions (user_id, type, amount, description, related_id)
  values (
    p_actor_id, 'purchase', -v_sub.monthly_coins,
    'Office Drive ' || (select p.display_name from public.office_cloud_storage_plans p where p.plan_code = v_sub.plan_code) || ' monthly storage renewal',
    null
  )
  returning id, balance into v_wallet_transaction_id, v_new_balance;

  update public.office_cloud_storage_subscriptions
  set status = 'active',
      billing_user_id = p_actor_id,
      auto_renew = auto_renew,
      cancel_at_period_end = false,
      current_period_start = v_period_start,
      current_period_end = v_period_end,
      next_billing_at = case when auto_renew then v_period_end else null end,
      grace_until = null,
      last_billed_at = now(),
      updated_at = now()
  where subscription_id = p_subscription_id;

  insert into public.office_cloud_storage_subscription_events (
    subscription_id, workspace_id, actor_id, event_type, plan_code,
    coins, quota_bytes, period_start, period_end, wallet_transaction_id, idempotency_key
  ) values (
    p_subscription_id, v_workspace_id, p_actor_id, 'renewed', v_sub.plan_code,
    v_sub.monthly_coins, v_sub.quota_bytes, v_period_start, v_period_end,
    v_wallet_transaction_id, p_idempotency_key
  );

  return jsonb_build_object(
    'subscription_id', p_subscription_id,
    'status', 'active',
    'current_period_start', v_period_start,
    'current_period_end', v_period_end,
    'wallet_transaction_id', v_wallet_transaction_id,
    'balance', v_new_balance,
    'replayed', false
  );
end;
$function$;

create or replace function public.office_cloud_set_storage_subscription_auto_renew(
  p_actor_id uuid,
  p_subscription_id uuid,
  p_auto_renew boolean
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_workspace_id uuid;
  v_sub public.office_cloud_storage_subscriptions%rowtype;
  v_event text;
begin
  if p_actor_id is null or p_subscription_id is null or p_auto_renew is null then
    raise exception 'Invalid auto-renew request' using errcode = '22023';
  end if;
  select s.workspace_id into v_workspace_id
  from public.office_cloud_storage_subscriptions s
  where s.subscription_id = p_subscription_id;
  if not found then raise exception 'Storage subscription unavailable' using errcode = '42501'; end if;
  if not exists (
    select 1 from public.office_memberships m
    where m.workspace_id = v_workspace_id and m.user_id = p_actor_id
      and m.status = 'active' and m.role in ('owner', 'admin')
  ) then raise exception 'Workspace administrator access required' using errcode = '42501'; end if;

  perform 1 from public.office_cloud_workspace_quotas q
  where q.workspace_id = v_workspace_id for update;
  select * into v_sub from public.office_cloud_storage_subscriptions s
  where s.subscription_id = p_subscription_id and s.workspace_id = v_workspace_id for update;
  if not found or v_sub.status = 'expired' then
    raise exception 'Storage subscription is no longer active' using errcode = '55000';
  end if;
  if p_auto_renew and v_sub.current_period_end <= now() and
     (v_sub.status <> 'past_due' or v_sub.grace_until <= now()) then
    raise exception 'The storage subscription must be renewed before auto-renew can be enabled' using errcode = '55000';
  end if;

  if p_auto_renew and not exists (
    select 1 from public.office_cloud_storage_billing_config c
    where c.singleton and c.enabled
      and c.price_approved_at is not null
      and c.wallet_security_approved_at is not null
  ) then
    raise exception 'Office storage billing is not enabled' using errcode = '55000';
  end if;
  v_event := case when p_auto_renew then 'auto_renew_enabled' else 'auto_renew_disabled' end;
  update public.office_cloud_storage_subscriptions
  set billing_user_id = case when p_auto_renew then p_actor_id else billing_user_id end,
      auto_renew = p_auto_renew,
      cancel_at_period_end = not p_auto_renew,
      next_billing_at = case
        when p_auto_renew and status = 'past_due' then now()
        when p_auto_renew then current_period_end
        else null
      end,
      updated_at = now()
  where subscription_id = p_subscription_id;

  insert into public.office_cloud_storage_subscription_events (
    subscription_id, workspace_id, actor_id, event_type, plan_code,
    coins, quota_bytes, period_start, period_end
  ) values (
    p_subscription_id, v_workspace_id, p_actor_id, v_event, v_sub.plan_code,
    0, v_sub.quota_bytes, v_sub.current_period_start, v_sub.current_period_end
  );

  return jsonb_build_object(
    'subscription_id', p_subscription_id,
    'auto_renew', p_auto_renew,
    'cancel_at_period_end', not p_auto_renew,
    'current_period_end', v_sub.current_period_end
  );
end;
$function$;

create or replace function public.office_cloud_process_storage_renewals(
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_candidate record;
  v_sub public.office_cloud_storage_subscriptions%rowtype;
  v_balance bigint;
  v_wallet_transaction_id uuid;
  v_new_balance bigint;
  v_processed integer := 0;
  v_renewed integer := 0;
  v_failed integer := 0;
  v_expired integer := 0;
  v_period_end timestamptz;
  v_grace_until timestamptz;
  v_actor_is_admin boolean;
  v_billing_enabled boolean := false;
begin
  select exists (
    select 1 from public.office_cloud_storage_billing_config c
    where c.singleton and c.enabled
      and c.price_approved_at is not null
      and c.wallet_security_approved_at is not null
  ) into v_billing_enabled;
  if p_limit is null or p_limit not between 1 and 1000 then
    raise exception 'Invalid storage renewal batch size' using errcode = '22023';
  end if;

  for v_candidate in
    select s.subscription_id, s.workspace_id
    from public.office_cloud_storage_subscriptions s
    where
      (s.status = 'active' and (
        (s.auto_renew and s.next_billing_at <= now())
        or ((not s.auto_renew or s.cancel_at_period_end) and s.current_period_end <= now())
      ))
      or (s.status = 'past_due' and (
        (s.auto_renew and s.next_billing_at <= now())
        or s.grace_until <= now()
      ))
    order by coalesce(s.next_billing_at, s.grace_until, s.current_period_end), s.subscription_id
    limit p_limit
  loop
    if not pg_try_advisory_xact_lock(hashtext(v_candidate.workspace_id::text)) then
      continue;
    end if;
    perform 1 from public.office_cloud_workspace_quotas q
    where q.workspace_id = v_candidate.workspace_id for update;
    if not found then continue; end if;
    select * into v_sub
    from public.office_cloud_storage_subscriptions s
    where s.subscription_id = v_candidate.subscription_id
      and s.workspace_id = v_candidate.workspace_id
    for update;
    if not found or v_sub.status = 'expired' then continue; end if;

    if (v_sub.status = 'past_due' and v_sub.grace_until <= now())
       or (v_sub.status = 'active' and (not v_sub.auto_renew or v_sub.cancel_at_period_end)
           and v_sub.current_period_end <= now()) then
      update public.office_cloud_storage_subscriptions
      set status = 'expired', auto_renew = false, cancel_at_period_end = true,
          next_billing_at = null, grace_until = null, ended_at = now(), updated_at = now()
      where subscription_id = v_sub.subscription_id;
      update public.office_cloud_workspace_quotas
      set purchased_quota_bytes = greatest(0, purchased_quota_bytes - v_sub.quota_bytes),
          subscription_quota_bytes = greatest(0, subscription_quota_bytes - v_sub.quota_bytes),
          updated_at = now()
      where workspace_id = v_sub.workspace_id;
      insert into public.office_cloud_storage_subscription_events (
        subscription_id, workspace_id, actor_id, event_type, plan_code,
        coins, quota_bytes, period_start, period_end
      ) values (
        v_sub.subscription_id, v_sub.workspace_id, null, 'expired', v_sub.plan_code,
        0, v_sub.quota_bytes, v_sub.current_period_start, v_sub.current_period_end
      );
      v_expired := v_expired + 1;
      v_processed := v_processed + 1;
      continue;
    end if;

    if not v_billing_enabled then
      update public.office_cloud_storage_subscriptions
      set auto_renew = false, cancel_at_period_end = true, next_billing_at = null, updated_at = now()
      where subscription_id = v_sub.subscription_id;
      if v_sub.status = 'active' and v_sub.current_period_end <= now() then
        update public.office_cloud_storage_subscriptions
        set status = 'expired', ended_at = now(), updated_at = now()
        where subscription_id = v_sub.subscription_id;
        update public.office_cloud_workspace_quotas
        set purchased_quota_bytes = greatest(0, purchased_quota_bytes - v_sub.quota_bytes),
            subscription_quota_bytes = greatest(0, subscription_quota_bytes - v_sub.quota_bytes),
            updated_at = now()
        where workspace_id = v_sub.workspace_id;
        insert into public.office_cloud_storage_subscription_events (
          subscription_id, workspace_id, actor_id, event_type, plan_code,
          coins, quota_bytes, period_start, period_end
        ) values (
          v_sub.subscription_id, v_sub.workspace_id, null, 'expired', v_sub.plan_code,
          0, v_sub.quota_bytes, v_sub.current_period_start, v_sub.current_period_end
        );
        v_expired := v_expired + 1;
      end if;
      v_processed := v_processed + 1;
      continue;
    end if;

    select exists (
      select 1 from public.office_memberships m
      where m.workspace_id = v_sub.workspace_id
        and m.user_id = v_sub.billing_user_id
        and m.status = 'active'
        and m.role in ('owner', 'admin')
    ) into v_actor_is_admin;
    if not v_actor_is_admin then
      update public.office_cloud_storage_subscriptions
      set auto_renew = false, cancel_at_period_end = true, next_billing_at = null, updated_at = now()
      where subscription_id = v_sub.subscription_id;
      if v_sub.current_period_end <= now() then
        update public.office_cloud_storage_subscriptions
        set status = 'expired', ended_at = now(), updated_at = now()
        where subscription_id = v_sub.subscription_id;
        update public.office_cloud_workspace_quotas
        set purchased_quota_bytes = greatest(0, purchased_quota_bytes - v_sub.quota_bytes),
            subscription_quota_bytes = greatest(0, subscription_quota_bytes - v_sub.quota_bytes),
            updated_at = now()
        where workspace_id = v_sub.workspace_id;
        insert into public.office_cloud_storage_subscription_events (
          subscription_id, workspace_id, actor_id, event_type, plan_code,
          coins, quota_bytes, period_start, period_end
        ) values (
          v_sub.subscription_id, v_sub.workspace_id, null, 'expired', v_sub.plan_code,
          0, v_sub.quota_bytes, v_sub.current_period_start, v_sub.current_period_end
        );
        v_expired := v_expired + 1;
      end if;
      v_processed := v_processed + 1;
      continue;
    end if;

    perform 1 from public.profiles p where p.id = v_sub.billing_user_id for update;
    if not found then
      update public.office_cloud_storage_subscriptions
      set auto_renew = false, cancel_at_period_end = true, next_billing_at = null, updated_at = now()
      where subscription_id = v_sub.subscription_id;
      v_processed := v_processed + 1;
      continue;
    end if;
    select coalesce((
      select w.balance from public.wallet_transactions w
      where w.user_id = v_sub.billing_user_id
      order by w.created_at desc, w.id desc limit 1
    ), 0) into v_balance;

    if v_balance >= v_sub.monthly_coins then
      perform set_config('wallet.atomic_writer', 'v2', true);
      insert into public.wallet_transactions (user_id, type, amount, description, related_id)
      values (
        v_sub.billing_user_id, 'purchase', -v_sub.monthly_coins,
        'Office Drive ' || (select p.display_name from public.office_cloud_storage_plans p where p.plan_code = v_sub.plan_code) || ' monthly storage renewal',
        null
      )
      returning id, balance into v_wallet_transaction_id, v_new_balance;
      v_period_end := greatest(v_sub.current_period_end, now()) + interval '1 month';
      update public.office_cloud_storage_subscriptions
      set status = 'active', current_period_start = greatest(v_sub.current_period_end, now()),
          current_period_end = v_period_end, next_billing_at = v_period_end,
          grace_until = null, last_billed_at = now(), updated_at = now()
      where subscription_id = v_sub.subscription_id;
      insert into public.office_cloud_storage_subscription_events (
        subscription_id, workspace_id, actor_id, event_type, plan_code,
        coins, quota_bytes, period_start, period_end, wallet_transaction_id
      ) values (
        v_sub.subscription_id, v_sub.workspace_id, v_sub.billing_user_id, 'renewed',
        v_sub.plan_code, v_sub.monthly_coins, v_sub.quota_bytes,
        greatest(v_sub.current_period_end, now()), v_period_end, v_wallet_transaction_id
      );
      v_renewed := v_renewed + 1;
    else
      v_grace_until := coalesce(v_sub.grace_until, now() + interval '3 days');
      if v_grace_until <= now() then
        update public.office_cloud_storage_subscriptions
        set status = 'expired', auto_renew = false, cancel_at_period_end = true,
            next_billing_at = null, grace_until = null, ended_at = now(), updated_at = now()
        where subscription_id = v_sub.subscription_id;
        update public.office_cloud_workspace_quotas
        set purchased_quota_bytes = greatest(0, purchased_quota_bytes - v_sub.quota_bytes),
            subscription_quota_bytes = greatest(0, subscription_quota_bytes - v_sub.quota_bytes),
            updated_at = now()
        where workspace_id = v_sub.workspace_id;
        insert into public.office_cloud_storage_subscription_events (
          subscription_id, workspace_id, actor_id, event_type, plan_code,
          coins, quota_bytes, period_start, period_end
        ) values (
          v_sub.subscription_id, v_sub.workspace_id, null, 'expired', v_sub.plan_code,
          0, v_sub.quota_bytes, v_sub.current_period_start, v_sub.current_period_end
        );
        v_expired := v_expired + 1;
      else
        update public.office_cloud_storage_subscriptions
        set status = 'past_due', grace_until = v_grace_until,
            next_billing_at = least(now() + interval '1 day', v_grace_until),
            updated_at = now()
        where subscription_id = v_sub.subscription_id;
        if v_sub.status <> 'past_due' then
          insert into public.office_cloud_storage_subscription_events (
            subscription_id, workspace_id, actor_id, event_type, plan_code,
            coins, quota_bytes, period_start, period_end
          ) values (
            v_sub.subscription_id, v_sub.workspace_id, v_sub.billing_user_id, 'renewal_failed',
            v_sub.plan_code, 0, v_sub.quota_bytes,
            v_sub.current_period_start, v_sub.current_period_end
          );
        end if;
        v_failed := v_failed + 1;
      end if;
    end if;
    v_processed := v_processed + 1;
  end loop;

  return jsonb_build_object(
    'processed', v_processed,
    'renewed', v_renewed,
    'failed', v_failed,
    'expired', v_expired
  );
end;
$function$;

revoke all on function public.office_cloud_list_storage_plans(uuid, uuid) from public, anon, authenticated;
revoke all on function public.office_cloud_list_storage_subscriptions(uuid, uuid) from public, anon, authenticated;
revoke all on function public.office_cloud_list_storage_history(uuid, uuid) from public, anon, authenticated;
revoke all on function public.office_cloud_purchase_storage_subscription(uuid, uuid, text, uuid, boolean) from public, anon, authenticated;
revoke all on function public.office_cloud_renew_storage_subscription(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.office_cloud_set_storage_subscription_auto_renew(uuid, uuid, boolean) from public, anon, authenticated;
revoke all on function public.office_cloud_process_storage_renewals(integer) from public, anon, authenticated, service_role;

grant execute on function public.office_cloud_list_storage_plans(uuid, uuid) to service_role;
grant execute on function public.office_cloud_list_storage_subscriptions(uuid, uuid) to service_role;
grant execute on function public.office_cloud_list_storage_history(uuid, uuid) to service_role;
grant execute on function public.office_cloud_purchase_storage_subscription(uuid, uuid, text, uuid, boolean) to service_role;
grant execute on function public.office_cloud_renew_storage_subscription(uuid, uuid, uuid) to service_role;
grant execute on function public.office_cloud_set_storage_subscription_auto_renew(uuid, uuid, boolean) to service_role;

do $schedule$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule(
      'office-cloud-storage-renewals',
      '0 * * * *',
      'select public.office_cloud_process_storage_renewals(100);'
    );
  end if;
end
$schedule$;
