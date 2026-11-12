-- Durable, per-account lockout for Office storage spending authorization.
-- The RPC is callable only by the service role; the browser never reads this table.
create table if not exists public.office_cloud_wallet_pin_attempts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  window_started_at timestamptz not null,
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.office_cloud_wallet_pin_attempts enable row level security;
revoke all on table public.office_cloud_wallet_pin_attempts from public, anon, authenticated;
grant all on table public.office_cloud_wallet_pin_attempts to service_role;

create or replace function public.office_cloud_wallet_pin_attempt(
  p_actor_id uuid,
  p_succeeded boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_started timestamptz;
  v_count integer;
  v_locked_until timestamptz;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise insufficient_privilege using message = 'Service role required';
  end if;
  if p_actor_id is null or p_succeeded is null then
    raise invalid_parameter_value using message = 'Invalid wallet PIN attempt';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_actor_id::text, 0)
  );

  if p_succeeded then
    delete from public.office_cloud_wallet_pin_attempts
    where user_id = p_actor_id;
    return pg_catalog.jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
  end if;

  select window_started_at, attempt_count, locked_until
    into v_started, v_count, v_locked_until
  from public.office_cloud_wallet_pin_attempts
  where user_id = p_actor_id
  for update;

  if found and v_locked_until is not null and v_locked_until > v_now then
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_locked_until - v_now)))::integer)
    );
  end if;

  if not found then
    insert into public.office_cloud_wallet_pin_attempts
      (user_id, window_started_at, attempt_count, locked_until, updated_at)
    values (p_actor_id, v_now, 1, null, v_now);
    return pg_catalog.jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
  end if;

  if v_started <= v_now - interval '15 minutes' or v_locked_until is not null then
    update public.office_cloud_wallet_pin_attempts
       set window_started_at = v_now, attempt_count = 1,
           locked_until = null, updated_at = v_now
     where user_id = p_actor_id;
    return pg_catalog.jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
  end if;

  v_count := least(v_count + 1, 5);
  update public.office_cloud_wallet_pin_attempts
     set attempt_count = v_count,
         locked_until = case when v_count >= 5 then v_now + interval '15 minutes' else null end,
         updated_at = v_now
   where user_id = p_actor_id;

  return pg_catalog.jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
end;
$function$;

revoke all on function public.office_cloud_wallet_pin_attempt(uuid, boolean) from public, anon, authenticated;
grant execute on function public.office_cloud_wallet_pin_attempt(uuid, boolean) to service_role;
