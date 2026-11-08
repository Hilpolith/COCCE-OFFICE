BEGIN;
CREATE OR REPLACE FUNCTION office_private.inst_workflow(w uuid, action text, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  r text:=p->>'resource'; rid uuid:=NULLIF(p->>'id','')::uuid; expected bigint:=NULLIF(p->>'expected_version','')::bigint;
  ns text:=p->>'to_state'; v bigint; st text; d jsonb; extra jsonb:=COALESCE(p->'data','{}'::jsonb);
  maker uuid; cap text; branch uuid; qn bigint; ac integer; pid uuid; fid uuid; start_at timestamptz; end_at timestamptz; k text;
  source_snapshot jsonb; source_asset_version bigint; source_asset_status text; source_org uuid; source_branch uuid; target_branch uuid; target_facility uuid; move_type text; approval_ref text;
BEGIN
  IF action='post_asset_move' THEN
    r:='asset_moves';
    IF r<>'asset_moves' OR rid IS NULL OR expected IS NULL OR expected<1 THEN RAISE EXCEPTION 'Invalid asset move post' USING ERRCODE='22023'; END IF;
    PERFORM office_private.inst_require(w);
    IF NOT office_private.inst_cap(w,'facilities') THEN RAISE EXCEPTION 'Asset move capability denied' USING ERRCODE='42501'; END IF;
    SELECT version,status,data,created_by INTO v,st,d,maker FROM public.office_institutions_records WHERE workspace_id=w AND resource=r AND id=rid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Asset move is missing' USING ERRCODE='40001'; END IF;
    IF v<>expected THEN RAISE EXCEPTION 'Asset move version is stale: actual %, expected %',v,expected USING ERRCODE='40001'; END IF;
    IF st<>'approved' THEN RAISE EXCEPTION 'Asset move is not approved' USING ERRCODE='40001'; END IF;
    move_type:=d->>'move_type';
    IF move_type NOT IN ('transfer','disposal') THEN RAISE EXCEPTION 'Asset move type must be transfer or disposal' USING ERRCODE='22023'; END IF;
    source_asset_version:=NULLIF(d->>'asset_version','')::bigint;
    SELECT version,status,data INTO qn,source_asset_status,source_snapshot FROM public.office_institutions_records WHERE workspace_id=w AND resource='assets' AND id=(d->>'asset_id')::uuid FOR UPDATE;
    IF NOT FOUND OR source_asset_status<>'active' OR source_asset_version IS NULL OR source_asset_version<>qn THEN RAISE EXCEPTION 'Asset move source is stale or not active' USING ERRCODE='40001'; END IF;
    source_org:=NULLIF(source_snapshot->>'organization_id','')::uuid; source_branch:=NULLIF(source_snapshot->>'branch_id','')::uuid;
    PERFORM office_private.inst_assert_scope(w,source_branch);
    IF (d->>'source_branch_id') IS DISTINCT FROM source_snapshot->>'branch_id' THEN RAISE EXCEPTION 'Asset move source branch is stale' USING ERRCODE='40001'; END IF;
    IF move_type='transfer' THEN
      target_branch:=NULLIF(d->>'target_branch_id','')::uuid; target_facility:=NULLIF(d->>'target_facility_id','')::uuid;
      IF target_branch IS NULL OR target_facility IS NULL OR target_branch=source_branch THEN RAISE EXCEPTION 'Transfer requires a distinct target branch and facility' USING ERRCODE='22023'; END IF;
      IF NOT EXISTS (SELECT 1 FROM public.office_institutions_records b WHERE b.workspace_id=w AND b.resource='branches' AND b.id=target_branch AND b.status='active' AND (b.data->>'organization_id')::uuid=source_org) THEN RAISE EXCEPTION 'Target branch is not active in the asset organization' USING ERRCODE='22023'; END IF;
      IF NOT EXISTS (SELECT 1 FROM public.office_institutions_records f WHERE f.workspace_id=w AND f.resource='facilities' AND f.id=target_facility AND f.status='active' AND (f.data->>'organization_id')::uuid=source_org AND (f.data->>'branch_id')::uuid=target_branch) THEN RAISE EXCEPTION 'Target facility is not active in the target branch' USING ERRCODE='22023'; END IF;
      PERFORM office_private.inst_assert_scope(w,target_branch);
      UPDATE public.office_institutions_records SET data=data||jsonb_build_object('facility_id',target_facility,'branch_id',target_branch),version=version+1,updated_at=now() WHERE workspace_id=w AND resource='assets' AND id=(d->>'asset_id')::uuid AND version=source_asset_version AND status='active';
    ELSE
      UPDATE public.office_institutions_records SET status='disposed',version=version+1,updated_at=now() WHERE workspace_id=w AND resource='assets' AND id=(d->>'asset_id')::uuid AND version=source_asset_version AND status='active';
    END IF;
    IF NOT FOUND THEN RAISE EXCEPTION 'Asset side effect was not applied' USING ERRCODE='40001'; END IF;
    UPDATE public.office_institutions_records SET status='completed',version=v+1,updated_at=now() WHERE workspace_id=w AND resource=r AND id=rid AND version=v;
    IF NOT FOUND THEN RAISE EXCEPTION 'Asset move completion was not applied' USING ERRCODE='40001'; END IF;
    RETURN jsonb_build_object('id',rid,'version',v+1,'status','completed','asset_id',d->'asset_id');
  END IF;
  IF action<>'transition_record' OR r IS NULL OR rid IS NULL OR expected IS NULL OR expected<1 OR ns IS NULL THEN
    RAISE EXCEPTION 'Unsupported workflow action' USING ERRCODE='22023';
  END IF;
  cap:=office_private.inst_cap_for_resource(r);
  IF cap IS NULL OR (NOT office_private.inst_cap(w,cap) AND NOT (ns='approved' AND office_private.inst_cap(w,'approve'))) THEN
    RAISE EXCEPTION 'Transition capability denied' USING ERRCODE='42501';
  END IF;
  FOR k IN SELECT jsonb_object_keys(extra) LOOP
    IF k NOT IN ('reference','minutes_reference','attendance_count','attendance_reference','submitted_on','reason','returned_reason','acknowledgement_reference','rejected_reason','maintenance_reference','approval_reference') THEN
      RAISE EXCEPTION 'Invalid transition field %',k USING ERRCODE='22023';
    END IF;
  END LOOP;
  SELECT version,status,data,created_by INTO v,st,d,maker FROM public.office_institutions_records
   WHERE workspace_id=w AND resource=r AND id=rid FOR UPDATE;
  IF NOT FOUND OR v<>expected THEN RAISE EXCEPTION 'Stale or missing record' USING ERRCODE='40001'; END IF;
  IF r='appointments' AND NOT ((st='proposed' AND ns='approved') OR (st='approved' AND ns='active') OR (st='active' AND ns='ended')) THEN RAISE EXCEPTION 'Invalid appointment transition' USING ERRCODE='22023'; END IF;
  IF r='meetings' AND NOT ((st='draft' AND ns='circulated') OR (st='circulated' AND ns='held') OR (st='held' AND ns='minutes_pending') OR (st='minutes_pending' AND ns='approved') OR (st='approved' AND ns='archived')) THEN RAISE EXCEPTION 'Invalid meeting transition' USING ERRCODE='22023'; END IF;
  IF r='resolutions' AND NOT ((st='draft' AND ns='proposed') OR (st='proposed' AND ns='approved') OR (st='approved' AND ns='implemented') OR (st='implemented' AND ns='archived')) THEN RAISE EXCEPTION 'Invalid resolution transition' USING ERRCODE='22023'; END IF;
  IF r='facilities' AND NOT ((st='active' AND ns='out_of_service') OR (st='out_of_service' AND ns='active')) THEN RAISE EXCEPTION 'Invalid facility transition' USING ERRCODE='22023'; END IF;
  IF r='assets' AND NOT ((st='draft' AND ns='active') OR (st='active' AND ns='maintenance') OR (st='maintenance' AND ns='active')) THEN RAISE EXCEPTION 'Invalid asset transition' USING ERRCODE='22023'; END IF;
  IF r='asset_moves' AND NOT ((st='draft' AND ns='submitted') OR (st='submitted' AND ns='approved')) THEN RAISE EXCEPTION 'Asset completion requires post_asset_move' USING ERRCODE='22023'; END IF;
  IF r='programmes' AND NOT ((st='draft' AND ns='approved') OR (st='approved' AND ns='active') OR (st='active' AND ns='completed') OR (st='completed' AND ns='closed')) THEN RAISE EXCEPTION 'Invalid programme transition' USING ERRCODE='22023'; END IF;
  IF r='events' AND NOT ((st='draft' AND ns='confirmed') OR (st='confirmed' AND ns='in_progress') OR (st='in_progress' AND ns='completed') OR (st='completed' AND ns='closed')) THEN RAISE EXCEPTION 'Invalid event transition' USING ERRCODE='22023'; END IF;
  IF r='staff_assignments' AND NOT ((st='proposed' AND ns='approved') OR (st='approved' AND ns='active') OR (st='active' AND ns IN ('suspended','ended'))) THEN RAISE EXCEPTION 'Invalid staff transition' USING ERRCODE='22023'; END IF;
  IF r='credentials' AND NOT ((st='recorded' AND ns='verified') OR (st='verified' AND ns IN ('expired','revoked'))) THEN RAISE EXCEPTION 'Invalid credential transition' USING ERRCODE='22023'; END IF;
  IF r='filings' AND NOT ((st='draft' AND ns='submitted') OR (st='submitted' AND ns IN ('returned','accepted','rejected')) OR (st='returned' AND ns='resubmitted') OR (st='resubmitted' AND ns IN ('accepted','rejected'))) THEN RAISE EXCEPTION 'Invalid filing transition' USING ERRCODE='22023'; END IF;
  IF r='people' AND NOT ((st='active' AND ns='inactive') OR (st='inactive' AND ns='active')) THEN RAISE EXCEPTION 'Invalid people transition' USING ERRCODE='22023'; END IF;
  IF r='safeguarding' AND NOT ((st='reported' AND ns='triaged') OR (st='triaged' AND ns='investigating') OR (st='investigating' AND ns='referred') OR (st='referred' AND ns='closed')) THEN RAISE EXCEPTION 'Invalid safeguarding transition' USING ERRCODE='22023'; END IF;
  IF r='privacy_requests' AND NOT ((st='open' AND ns='reviewed') OR (st='reviewed' AND ns IN ('fulfilled','refused'))) THEN RAISE EXCEPTION 'Invalid privacy transition' USING ERRCODE='22023'; END IF;
  IF r NOT IN ('appointments','meetings','resolutions','facilities','assets','asset_moves','programmes','events','staff_assignments','credentials','filings','people','safeguarding','privacy_requests') THEN RAISE EXCEPTION 'This resource has no transition operation' USING ERRCODE='22023'; END IF;
  branch:=NULLIF(d->>'branch_id','')::uuid; PERFORM office_private.inst_assert_scope(w,branch);
  IF r IN ('people','safeguarding','privacy_requests') AND (NOT EXISTS (SELECT 1 FROM public.office_institutions_settings ss WHERE ss.workspace_id=w AND ss.private_data_enabled AND ss.storage_review_state='approved') OR NOT EXISTS (SELECT 1 FROM public.office_institutions_keys kk WHERE kk.workspace_id=w AND kk.kind=CASE WHEN r='safeguarding' THEN 'safeguarding' ELSE 'people' END AND kk.configured)) THEN RAISE EXCEPTION 'Private transition gate closed' USING ERRCODE='55000'; END IF;
  IF r='privacy_requests' AND ns IN ('fulfilled','refused') AND NULLIF(btrim(extra->>'reference'),'') IS NULL THEN RAISE EXCEPTION 'Privacy outcome requires a real reference' USING ERRCODE='22023'; END IF;
  IF ns IN ('approved','verified','reviewed') AND maker=auth.uid() THEN RAISE EXCEPTION 'Distinct maker/checker required' USING ERRCODE='42501'; END IF;
  IF r='meetings' AND ns='held' THEN qn:=COALESCE((d->>'quorum_required')::integer,0); ac:=COALESCE((extra->>'attendance_count')::integer,0); IF ac<qn OR NULLIF(extra->>'attendance_reference','') IS NULL THEN RAISE EXCEPTION 'Held meeting requires quorum and attendance reference' USING ERRCODE='22023'; END IF; END IF;
  IF r='meetings' AND ns='approved' AND NULLIF(extra->>'minutes_reference','') IS NULL THEN RAISE EXCEPTION 'Approved meeting requires minutes reference' USING ERRCODE='22023'; END IF;
  IF r='resolutions' AND ns='approved' AND NOT EXISTS (SELECT 1 FROM public.office_institutions_records m WHERE m.workspace_id=w AND m.resource='meetings' AND m.id=(d->>'meeting_id')::uuid AND m.status='approved') THEN RAISE EXCEPTION 'Resolution requires approved meeting' USING ERRCODE='22023'; END IF;
  IF r='assets' AND ns='active' AND d->>'asset_type'='land' AND NULLIF(d->>'land_consent_reference','') IS NULL AND EXISTS (SELECT 1 FROM public.office_institutions_records o WHERE o.workspace_id=w AND o.resource='organizations' AND o.id=(d->>'organization_id')::uuid AND o.data->>'jurisdiction'='mainland' AND o.data->>'legal_form'='trust') THEN RAISE EXCEPTION 'Mainland trust land requires written RITA consent before active' USING ERRCODE='42501'; END IF;
  IF r='asset_moves' AND ns='submitted' THEN
    move_type:=d->>'move_type';
    IF move_type NOT IN ('transfer','disposal') THEN RAISE EXCEPTION 'Asset move type must be transfer or disposal' USING ERRCODE='22023'; END IF;
    SELECT version,status,data INTO source_asset_version,source_asset_status,source_snapshot FROM public.office_institutions_records WHERE workspace_id=w AND resource='assets' AND id=(d->>'asset_id')::uuid FOR UPDATE;
    IF NOT FOUND OR source_asset_status<>'active' THEN RAISE EXCEPTION 'Move source asset missing or inactive' USING ERRCODE='22023'; END IF;
    source_org:=NULLIF(source_snapshot->>'organization_id','')::uuid; source_branch:=NULLIF(source_snapshot->>'branch_id','')::uuid;
    IF (d->>'branch_id') IS DISTINCT FROM source_snapshot->>'branch_id' THEN RAISE EXCEPTION 'Asset move source branch mismatch' USING ERRCODE='22023'; END IF;
    PERFORM office_private.inst_assert_scope(w,source_branch);
    IF move_type='transfer' THEN
      target_branch:=NULLIF(d->>'target_branch_id','')::uuid; target_facility:=NULLIF(d->>'target_facility_id','')::uuid;
      IF target_branch IS NULL OR target_facility IS NULL OR target_branch=source_branch THEN RAISE EXCEPTION 'Transfer requires a distinct target branch and facility' USING ERRCODE='22023'; END IF;
      IF NOT EXISTS (SELECT 1 FROM public.office_institutions_records b WHERE b.workspace_id=w AND b.resource='branches' AND b.id=target_branch AND b.status='active' AND (b.data->>'organization_id')::uuid=source_org) THEN RAISE EXCEPTION 'Target branch is not active in the asset organization' USING ERRCODE='22023'; END IF;
      IF NOT EXISTS (SELECT 1 FROM public.office_institutions_records f WHERE f.workspace_id=w AND f.resource='facilities' AND f.id=target_facility AND f.status='active' AND (f.data->>'organization_id')::uuid=source_org AND (f.data->>'branch_id')::uuid=target_branch) THEN RAISE EXCEPTION 'Target facility is not active in the target branch' USING ERRCODE='22023'; END IF;
    END IF;
    d:=d||jsonb_build_object('asset_version',source_asset_version,'source_branch_id',source_branch,'source_snapshot',source_snapshot);
  ELSIF r='asset_moves' AND ns='approved' THEN
    extra:=(extra-'reference')||jsonb_build_object('approval_reference',COALESCE(extra->'approval_reference',extra->'reference'));
    IF NOT office_private.inst_cap(w,'approve') THEN RAISE EXCEPTION 'Asset move approval requires approver role' USING ERRCODE='42501'; END IF;
    move_type:=d->>'move_type';
    IF move_type NOT IN ('transfer','disposal') OR NULLIF(btrim(extra->>'approval_reference'),'') IS NULL THEN RAISE EXCEPTION 'Asset approval requires move type and approval reference' USING ERRCODE='22023'; END IF;
    SELECT version,status,data INTO source_asset_version,source_asset_status,source_snapshot FROM public.office_institutions_records WHERE workspace_id=w AND resource='assets' AND id=(d->>'asset_id')::uuid FOR UPDATE;
    IF NOT FOUND OR source_asset_status<>'active' OR source_asset_version<>(d->>'asset_version')::bigint OR source_snapshot IS DISTINCT FROM d->'source_snapshot' THEN RAISE EXCEPTION 'Asset move approval is stale' USING ERRCODE='40001'; END IF;
    source_branch:=NULLIF(source_snapshot->>'branch_id','')::uuid; PERFORM office_private.inst_assert_scope(w,source_branch);
    IF maker=auth.uid() THEN RAISE EXCEPTION 'Distinct maker/checker required' USING ERRCODE='42501'; END IF;
    IF move_type='transfer' THEN
      target_branch:=NULLIF(d->>'target_branch_id','')::uuid; target_facility:=NULLIF(d->>'target_facility_id','')::uuid;
      IF target_branch IS NULL OR target_facility IS NULL OR target_branch=source_branch OR NOT EXISTS (SELECT 1 FROM public.office_institutions_records b WHERE b.workspace_id=w AND b.resource='branches' AND b.id=target_branch AND b.status='active' AND (b.data->>'organization_id')::uuid=(source_snapshot->>'organization_id')::uuid) OR NOT EXISTS (SELECT 1 FROM public.office_institutions_records f WHERE f.workspace_id=w AND f.resource='facilities' AND f.id=target_facility AND f.status='active' AND (f.data->>'organization_id')::uuid=(source_snapshot->>'organization_id')::uuid AND (f.data->>'branch_id')::uuid=target_branch) THEN RAISE EXCEPTION 'Asset move target is invalid or stale' USING ERRCODE='22023'; END IF;
    END IF;
  END IF;
  IF r='events' AND ns='confirmed' THEN start_at:=(d->>'start_at')::timestamptz; end_at:=(d->>'end_at')::timestamptz; pid:=(d->>'programme_id')::uuid; fid:=(d->>'facility_id')::uuid; IF end_at<=start_at OR NOT EXISTS (SELECT 1 FROM public.office_institutions_records z WHERE z.workspace_id=w AND z.resource='programmes' AND z.id=pid AND z.status='active') OR NOT EXISTS (SELECT 1 FROM public.office_institutions_records z WHERE z.workspace_id=w AND z.resource='facilities' AND z.id=fid AND z.status='active' AND (d->>'capacity')::integer<=(z.data->>'capacity')::integer) THEN RAISE EXCEPTION 'Event prerequisite or capacity invalid' USING ERRCODE='22023'; END IF; IF EXISTS (SELECT 1 FROM public.office_institutions_records z WHERE z.workspace_id=w AND z.resource='events' AND z.id<>rid AND z.status IN ('confirmed','in_progress') AND z.data->>'facility_id'=d->>'facility_id' AND (z.data->>'start_at')::timestamptz<end_at AND (z.data->>'end_at')::timestamptz>start_at) THEN RAISE EXCEPTION 'Facility event overlap conflict' USING ERRCODE='23P01'; END IF; END IF;
  IF ns='approved' THEN extra:=extra||jsonb_build_object('approved_by',auth.uid()); ELSIF ns='reviewed' THEN extra:=extra||jsonb_build_object('reviewed_by',auth.uid()); ELSIF ns='verified' THEN extra:=extra||jsonb_build_object('verified_by',auth.uid()); END IF;
  UPDATE public.office_institutions_records SET status=ns,version=v+1,data=d||extra,updated_at=now() WHERE workspace_id=w AND resource=r AND id=rid AND version=v;
  RETURN jsonb_build_object('id',rid,'version',v+1,'status',ns);
END $$;

REVOKE ALL ON FUNCTION office_private.inst_workflow(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
-- The canonical public RPCs are defined in 20261108100100 and deliberately remain
-- the only idempotency/audit boundary. This migration contains no wrapper stack.
REVOKE ALL ON FUNCTION office_private.inst_workflow(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.office_institutions_read(uuid,text,jsonb,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_institutions_command(uuid,text,jsonb) TO authenticated;
COMMIT;
