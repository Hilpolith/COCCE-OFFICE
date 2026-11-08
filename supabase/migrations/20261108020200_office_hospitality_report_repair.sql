BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='120s';

-- Apply 20261108020100_office_hospitality_finance_settlement_repair.sql before
-- this migration when that migration exists.  This migration deliberately
-- preserves the then-current finance implementation under a private name and
-- leaves the sole public RPC unchanged.  The wrapper delegates every action
-- except create_report, so a later finance repair can replace this wrapper only
-- by explicitly ordering itself before this migration.
ALTER FUNCTION office_private.hospitality_finance_action(uuid,text,text,jsonb)
  RENAME TO hospitality_finance_action_pre_report_repair;

CREATE OR REPLACE FUNCTION office_private.hospitality_report_create(
  p_workspace_id uuid,
  p_role text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
DECLARE
  pid uuid;
  report_id uuid;
  v bigint;
  period_start date;
  period_end date;
  report_type text;
  title text;
  snapshot jsonb;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'Report payload must be an object' USING ERRCODE='22023';
  END IF;
  IF p_role IS NULL OR p_role NOT IN
      ('hotel_admin','cashier','compliance_officer','front_desk','hotel_viewer') THEN
    RAISE EXCEPTION 'Invalid hospitality role' USING ERRCODE='42501';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_payload) k
             WHERE k NOT IN ('property_id','period_start','period_end','title','report_type')) THEN
    RAISE EXCEPTION 'Unknown report field' USING ERRCODE='22023';
  END IF;
  PERFORM office_private.hospitality_require_cap(p_role,'reports','create_report');

  pid := office_private.hospitality_uuid(p_payload->>'property_id','property_id');
  period_start := office_private.hospitality_date(p_payload->>'period_start');
  period_end := office_private.hospitality_date(p_payload->>'period_end');
  IF period_end < period_start THEN
    RAISE EXCEPTION 'Invalid report period' USING ERRCODE='22023';
  END IF;
  report_type := p_payload->>'report_type';
  IF report_type NOT IN ('occupancy','revenue','compliance','inventory') THEN
    RAISE EXCEPTION 'Invalid report type' USING ERRCODE='22023';
  END IF;
  title := btrim(coalesce(p_payload->>'title',''));
  IF title='' OR length(title)>200 THEN
    RAISE EXCEPTION 'Report title required' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_hospitality_properties p
     WHERE p.workspace_id=p_workspace_id AND p.id=pid AND p.status='active'
  ) THEN
    RAISE EXCEPTION 'Active same-workspace property required' USING ERRCODE='42501';
  END IF;

  /*
   * Reservation nights use [stay_start,stay_end) intersected with the
   * inclusive report period [period_start,period_end].  A report day is
   * therefore represented as [day,day+1).  Only checked-in/checked-out
   * reservations count.  provisional, confirmed, cancelled and no_show rows
   * are intentionally excluded.  The schema currently has no transition
   * event table; if explicit actual_check_in_on/actual_check_out_on values are
   * recorded in reservation data, they clamp the scheduled interval.  Missing
   * event values are not fabricated and the basis is stated in the snapshot.
   */
  SELECT jsonb_build_object(
    'property_id',pid::text,
    'period_start',period_start::text,
    'period_end',period_end::text,
    'report_type',report_type,
    'occupancy_basis',jsonb_build_object(
      'eligible_statuses',jsonb_build_array('checked_in','checked_out'),
      'scheduled_fields',jsonb_build_array('check_in_on','check_out_on'),
      'actual_bound_fields',jsonb_build_array('actual_check_in_on','actual_check_out_on'),
      'period_semantics','inclusive calendar dates; stay interval is half-open',
      'event_data_available',EXISTS (
        SELECT 1 FROM public.office_hospitality_reservations er
         WHERE er.workspace_id=p_workspace_id AND er.property_id=pid
           AND (er.data ? 'actual_check_in_on' OR er.data ? 'actual_check_out_on')
         LIMIT 1
      )
    ),
    'metrics',jsonb_build_object(
      'reservation_count',(
        SELECT count(*) FROM public.office_hospitality_reservations r
         WHERE r.workspace_id=p_workspace_id AND r.property_id=pid
           AND r.status IN ('checked_in','checked_out')
           AND office_private.hospitality_date(r.data->>'check_in_on') < period_end + 1
           AND office_private.hospitality_date(r.data->>'check_out_on') > period_start
      ),
      'occupied_room_nights',(
        SELECT coalesce(sum(GREATEST(0,
          LEAST(
            CASE WHEN r.data ? 'actual_check_out_on'
                 THEN office_private.hospitality_date(r.data->>'actual_check_out_on')
                 ELSE office_private.hospitality_date(r.data->>'check_out_on') END,
            period_end + 1
          ) - GREATEST(
            period_start,
            CASE WHEN r.data ? 'actual_check_in_on'
                 THEN office_private.hospitality_date(r.data->>'actual_check_in_on')
                 ELSE office_private.hospitality_date(r.data->>'check_in_on') END
          )
        )),0)
        FROM public.office_hospitality_reservations r
         WHERE r.workspace_id=p_workspace_id AND r.property_id=pid
           AND r.status IN ('checked_in','checked_out')
           AND office_private.hospitality_date(r.data->>'check_in_on') < period_end + 1
           AND office_private.hospitality_date(r.data->>'check_out_on') > period_start
      ),
      'room_revenue_total',(
        SELECT coalesce(sum(
          GREATEST(0,
            LEAST(
              CASE WHEN r.data ? 'actual_check_out_on'
                   THEN office_private.hospitality_date(r.data->>'actual_check_out_on')
                   ELSE office_private.hospitality_date(r.data->>'check_out_on') END,
              period_end + 1
            ) - GREATEST(
              period_start,
              CASE WHEN r.data ? 'actual_check_in_on'
                   THEN office_private.hospitality_date(r.data->>'actual_check_in_on')
                   ELSE office_private.hospitality_date(r.data->>'check_in_on') END
            )
          ) * coalesce((r.data->>'nightly_rate')::numeric,0)
        ),0)
        FROM public.office_hospitality_reservations r
         WHERE r.workspace_id=p_workspace_id AND r.property_id=pid
           AND r.status IN ('checked_in','checked_out')
           AND office_private.hospitality_date(r.data->>'check_in_on') < period_end + 1
           AND office_private.hospitality_date(r.data->>'check_out_on') > period_start
      ),
      'guest_charge_total',coalesce((
        SELECT sum((l.data->>'total_amount')::numeric)
          FROM public.office_hospitality_folio_lines l
         WHERE l.workspace_id=p_workspace_id AND l.property_id=pid
           AND l.status='posted'
           AND office_private.hospitality_date(coalesce(l.data->>'posted_on',to_char(l.created_at AT TIME ZONE 'Africa/Dar_es_Salaam','YYYY-MM-DD'))) BETWEEN period_start AND period_end
      ),0),
      'revenue_total',coalesce((
        SELECT sum((l.data->>'total_amount')::numeric)
          FROM public.office_hospitality_folio_lines l
         WHERE l.workspace_id=p_workspace_id AND l.property_id=pid
           AND l.status='posted'
           AND office_private.hospitality_date(coalesce(l.data->>'posted_on',to_char(l.created_at AT TIME ZONE 'Africa/Dar_es_Salaam','YYYY-MM-DD'))) BETWEEN period_start AND period_end
      ),0),
      'inventory_item_count',(SELECT count(*) FROM public.office_hospitality_inventory_items i WHERE i.workspace_id=p_workspace_id AND i.property_id=pid),
      'compliance_close_count',(SELECT count(*) FROM public.office_hospitality_daily_closes c WHERE c.workspace_id=p_workspace_id AND c.property_id=pid AND office_private.hospitality_date(c.data->>'close_on') BETWEEN period_start AND period_end)
    )
  ) INTO snapshot;

  INSERT INTO public.office_hospitality_reports(id,workspace_id,property_id,status,created_by,data)
    VALUES(gen_random_uuid(),p_workspace_id,pid,'created',auth.uid(),
      jsonb_build_object('property_id',pid::text,'period_start',period_start::text,
        'period_end',period_end::text,'title',title,'report_type',report_type,'snapshot',snapshot))
    RETURNING id,version INTO report_id,v;

  RETURN jsonb_build_object('id',report_id,'version',v,'status','created','row',
    jsonb_build_object('id',report_id,'workspace_id',p_workspace_id,'property_id',pid,
      'status','created','version',v,'data',jsonb_build_object('period_start',period_start,
        'period_end',period_end,'title',title,'report_type',report_type,'snapshot',snapshot)));
END;
$$;

CREATE OR REPLACE FUNCTION office_private.hospitality_finance_action(
  p_workspace_id uuid,
  p_role text,
  p_action text,
  p_payload jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=''
AS $$
BEGIN
  IF p_action='create_report' THEN
    RETURN office_private.hospitality_report_create(p_workspace_id,p_role,p_payload);
  END IF;
  RETURN office_private.hospitality_finance_action_pre_report_repair(p_workspace_id,p_role,p_action,p_payload);
END;
$$;

REVOKE ALL ON FUNCTION office_private.hospitality_report_create(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION office_private.hospitality_finance_action_pre_report_repair(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION office_private.hospitality_finance_action(uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
COMMIT;
