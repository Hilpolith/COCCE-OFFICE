BEGIN;

CREATE OR REPLACE FUNCTION office_private.inst_role(w uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT r.role FROM public.office_institutions_roles r
  WHERE r.workspace_id=w AND r.user_id=auth.uid() AND r.active
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION office_private.inst_cap(w uuid,c text) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE r text:=office_private.inst_role(w); BEGIN
  RETURN CASE c
    WHEN 'manage' THEN r='institution_admin'
    WHEN 'people' THEN r IN ('institution_admin','registrar','hr_officer','privacy_officer')
    WHEN 'governance' THEN r IN ('institution_admin','governance_secretary','approver')
    WHEN 'finance' THEN r IN ('institution_admin','treasurer','approver')
    WHEN 'approve' THEN r='approver'
    WHEN 'facilities' THEN r IN ('institution_admin','facility_manager')
    WHEN 'programmes' THEN r IN ('institution_admin','programme_coordinator')
    WHEN 'staff' THEN r IN ('institution_admin','hr_officer')
    WHEN 'safeguarding' THEN r IN ('safeguarding_officer','privacy_officer')
    WHEN 'privacy' THEN r IN ('institution_admin','privacy_officer')
    WHEN 'reports' THEN r IS NOT NULL
    WHEN 'audit' THEN r='institution_admin'
    ELSE false END;
END $$;

CREATE OR REPLACE FUNCTION office_private.inst_assert_scope(w uuid,branch uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE rb uuid; BEGIN
  IF office_private.inst_role(w)='institution_admin' THEN RETURN; END IF;
  IF branch IS NULL THEN
    IF EXISTS (SELECT 1 FROM public.office_institutions_roles WHERE workspace_id=w AND user_id=auth.uid() AND active AND branch_id IS NOT NULL) THEN RAISE EXCEPTION 'Branch scope required' USING ERRCODE='42501'; END IF;
    RETURN;
  END IF;
  SELECT branch_id INTO rb FROM public.office_institutions_roles
   WHERE workspace_id=w AND user_id=auth.uid() AND active;
  IF rb IS NOT NULL AND rb<>branch THEN RAISE EXCEPTION 'Branch scope denied' USING ERRCODE='42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION office_private.inst_require(w uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.office_memberships m JOIN public.office_industry_spaces s ON s.workspace_id=m.workspace_id
    WHERE m.workspace_id=w AND m.user_id=auth.uid() AND m.status='active' AND s.industry_id='church')
  THEN RAISE EXCEPTION 'Institutions membership required' USING ERRCODE='42501'; END IF;
  IF office_private.inst_role(w) IS NULL THEN RAISE EXCEPTION 'Institutions module role required' USING ERRCODE='42501'; END IF;
END $$;

CREATE OR REPLACE FUNCTION office_private.inst_cap_for_resource(r text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE
 WHEN r IN ('organizations','branches','bodies','appointments','meetings','resolutions') THEN 'governance'
 WHEN r IN ('funds','budgets','contributions','payment_requests','bank_lines','reconciliations') THEN 'finance'
 WHEN r IN ('facilities','assets','asset_moves') THEN 'facilities'
 WHEN r IN ('programmes','events') THEN 'programmes'
 WHEN r IN ('staff_assignments','credentials') THEN 'staff'
 WHEN r IN ('people','attendance') THEN 'people'
 WHEN r='safeguarding' THEN 'safeguarding'
 WHEN r IN ('filings','evidence','privacy_requests') THEN 'privacy'
 ELSE NULL END $$;

CREATE OR REPLACE FUNCTION office_private.inst_allowed_field(r text,k text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE r
 WHEN 'organizations' THEN k IN ('code','name','jurisdiction','legal_form','registration_authority','registration_reference','constitution_reference','address_public','tin_reference','branch_id')
 WHEN 'branches' THEN k IN ('organization_id','code','name','location_public','branch_id')
 WHEN 'bodies' THEN k IN ('organization_id','code','name','quorum_required','eligible_count','constitution_reference','branch_id')
 WHEN 'people' THEN k IN ('code','lawful_basis','notice_reference','retention_until','nonce','ciphertext','branch_id')
 WHEN 'appointments' THEN k IN ('body_id','person_id','position','start_on','end_on','reference','branch_id','approved_by')
 WHEN 'meetings' THEN k IN ('body_id','code','title_public','scheduled_at','eligible_count','quorum_required','notice_reference','attendance_count','attendance_reference','minutes_reference','approved_by','branch_id')
 WHEN 'resolutions' THEN k IN ('meeting_id','code','title_public','decision_reference','reference','approved_by','branch_id')
 WHEN 'funds' THEN k IN ('organization_id','code','name','restricted','purpose_public','currency','branch_id')
 WHEN 'budgets' THEN k IN ('fund_id','code','period_start','period_end','amount','reference','approved_by','branch_id')
 WHEN 'contributions' THEN k IN ('fund_id','receipt_number','received_on','amount','method','reference','person_id','restriction_reference','branch_id')
 WHEN 'payment_requests' THEN k IN ('fund_id','budget_id','code','requested_on','amount','purpose_public','reference','method','approved_by','branch_id')
 WHEN 'bank_lines' THEN k IN ('fund_id','statement_reference','line_reference','posted_on','amount','direction','transaction_id','branch_id')
 WHEN 'reconciliations' THEN k IN ('fund_id','code','period_start','period_end','opening_balance','closing_balance','reference','branch_id','reviewed_by')
 WHEN 'facilities' THEN k IN ('organization_id','code','name','facility_type','location_public','capacity','maintenance_reference','branch_id')
 WHEN 'assets' THEN k IN ('organization_id','code','name','asset_type','acquired_on','cost','custody_reference','facility_id','title_reference','land_consent_reference','maintenance_reference','branch_id')
 WHEN 'asset_moves' THEN k IN ('asset_id','code','move_type','requested_on','reason_public','target_branch_id','target_facility_id','reference','approved_by','branch_id')
 WHEN 'programmes' THEN k IN ('organization_id','code','name','purpose_public','start_on','end_on','fund_id','approved_by','reference','branch_id')
 WHEN 'events' THEN k IN ('programme_id','facility_id','code','title_public','start_at','end_at','capacity','risk_reference','reference','branch_id')
 WHEN 'attendance' THEN k IN ('event_id','code','lawful_basis','notice_reference','retention_until','nonce','ciphertext','branch_id')
 WHEN 'staff_assignments' THEN k IN ('person_id','code','position','assignment_type','start_on','end_on','reference','approved_by','facility_id','branch_id')
 WHEN 'credentials' THEN k IN ('assignment_id','code','credential_type','issued_on','expires_on','evidence_reference','verified_by','branch_id')
 WHEN 'filings' THEN k IN ('organization_id','code','filing_type','authority','jurisdiction','due_on','reference','submitted_on','returned_reason','acknowledgement_reference','rejected_reason','reporting_year','control_number','source_url','branch_id')
 WHEN 'evidence' THEN k IN ('entity_resource','entity_id','description_public','reference','source_url','branch_id')
 WHEN 'safeguarding' THEN k IN ('code','lawful_basis','notice_reference','retention_until','nonce','ciphertext','branch_id')
 WHEN 'privacy_requests' THEN k IN ('code','request_type','received_on','due_on','reference','person_id','branch_id')
 ELSE false END $$;


CREATE OR REPLACE FUNCTION office_private.inst_assert_relations(w uuid,r text,d jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE org uuid; br uuid; parent_org uuid; parent_br uuid; facility_org uuid; facility_br uuid; asset_org uuid; asset_br uuid;
BEGIN
  br:=NULLIF(d->>'branch_id','')::uuid;
  IF br IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.office_institutions_records x WHERE x.workspace_id=w AND x.resource='branches' AND x.id=br) THEN RAISE EXCEPTION 'Unknown branch relation' USING ERRCODE='22023'; END IF;
  IF r IN ('branches','bodies','facilities','assets','programmes','funds','filings') THEN org:=NULLIF(d->>'organization_id','')::uuid;
  ELSIF r IN ('budgets','contributions','payment_requests','bank_lines','reconciliations') THEN
    SELECT (f.data->>'organization_id')::uuid,(f.data->>'branch_id')::uuid INTO parent_org,parent_br FROM public.office_institutions_records f WHERE f.workspace_id=w AND f.resource='funds' AND f.id=(d->>'fund_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Fund parent not found' USING ERRCODE='22023'; END IF;
    IF br IS NOT NULL AND parent_br IS DISTINCT FROM br THEN RAISE EXCEPTION 'Fund branch mismatch' USING ERRCODE='22023'; END IF;
    IF r='payment_requests' AND d ? 'budget_id' AND NOT EXISTS (SELECT 1 FROM public.office_institutions_records b WHERE b.workspace_id=w AND b.resource='budgets' AND b.id=(d->>'budget_id')::uuid AND (b.data->>'fund_id')::uuid=(d->>'fund_id')::uuid) THEN RAISE EXCEPTION 'Payment budget fund mismatch' USING ERRCODE='22023'; END IF;
    IF r='contributions' AND d ? 'person_id' AND NOT EXISTS (SELECT 1 FROM public.office_institutions_records person WHERE person.workspace_id=w AND person.resource='people' AND person.id=(d->>'person_id')::uuid) THEN RAISE EXCEPTION 'Contribution person not found' USING ERRCODE='22023'; END IF;
    RETURN;
  ELSIF r='events' THEN
    SELECT (x.data->>'organization_id')::uuid,(x.data->>'branch_id')::uuid INTO parent_org,parent_br FROM public.office_institutions_records x WHERE x.workspace_id=w AND x.resource='programmes' AND x.id=(d->>'programme_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Programme parent not found' USING ERRCODE='22023'; END IF;
    SELECT (x.data->>'organization_id')::uuid,(x.data->>'branch_id')::uuid INTO facility_org,facility_br FROM public.office_institutions_records x WHERE x.workspace_id=w AND x.resource='facilities' AND x.id=(d->>'facility_id')::uuid;
    IF NOT FOUND OR facility_org<>parent_org OR (parent_br IS DISTINCT FROM facility_br) OR (br IS NOT NULL AND br IS DISTINCT FROM parent_br) THEN RAISE EXCEPTION 'Event parent branch or organization mismatch' USING ERRCODE='22023'; END IF;
    RETURN;
  ELSIF r='asset_moves' THEN
    SELECT (x.data->>'organization_id')::uuid,(x.data->>'branch_id')::uuid INTO asset_org,asset_br FROM public.office_institutions_records x WHERE x.workspace_id=w AND x.resource='assets' AND x.id=(d->>'asset_id')::uuid;
    IF NOT FOUND THEN RAISE EXCEPTION 'Asset parent not found' USING ERRCODE='22023'; END IF;
    IF br IS NOT NULL AND br IS DISTINCT FROM asset_br THEN RAISE EXCEPTION 'Asset move source branch mismatch' USING ERRCODE='22023'; END IF;
    IF d ? 'target_branch_id' AND NOT EXISTS (SELECT 1 FROM public.office_institutions_records x WHERE x.workspace_id=w AND x.resource='branches' AND x.id=(d->>'target_branch_id')::uuid AND (x.data->>'organization_id')::uuid=asset_org) THEN RAISE EXCEPTION 'Target branch organization mismatch' USING ERRCODE='22023'; END IF;
    IF d ? 'target_facility_id' AND NOT EXISTS (SELECT 1 FROM public.office_institutions_records x WHERE x.workspace_id=w AND x.resource='facilities' AND x.id=(d->>'target_facility_id')::uuid AND (x.data->>'organization_id')::uuid=asset_org) THEN RAISE EXCEPTION 'Target facility organization mismatch' USING ERRCODE='22023'; END IF;
    RETURN;
  ELSE RETURN; END IF;
  IF org IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.office_institutions_records x WHERE x.workspace_id=w AND x.resource='organizations' AND x.id=org) THEN RAISE EXCEPTION 'Organization parent not found' USING ERRCODE='22023'; END IF;
  IF org IS NOT NULL AND br IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.office_institutions_records b WHERE b.workspace_id=w AND b.resource='branches' AND b.id=br AND (b.data->>'organization_id')::uuid=org) THEN RAISE EXCEPTION 'Branch organization mismatch' USING ERRCODE='22023'; END IF;
  IF r='assets' AND d ? 'facility_id' THEN
    SELECT (x.data->>'organization_id')::uuid,(x.data->>'branch_id')::uuid INTO facility_org,facility_br FROM public.office_institutions_records x WHERE x.workspace_id=w AND x.resource='facilities' AND x.id=(d->>'facility_id')::uuid;
    IF NOT FOUND OR facility_org<>org OR (br IS NOT NULL AND facility_br IS DISTINCT FROM br) THEN RAISE EXCEPTION 'Asset facility relation mismatch' USING ERRCODE='22023'; END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION office_private.inst_validate_data(w uuid,r text,d jsonb,is_private boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE k text; branch uuid; BEGIN
  IF jsonb_typeof(d)<>'object' THEN RAISE EXCEPTION 'Record data must be an object' USING ERRCODE='22023'; END IF;
  FOR k IN SELECT jsonb_object_keys(d) LOOP
    IF NOT office_private.inst_allowed_field(r,k) THEN RAISE EXCEPTION 'Unknown field % for %',k,r USING ERRCODE='22023'; END IF;
  END LOOP;
  IF d ? 'branch_id' THEN BEGIN branch:=(d->>'branch_id')::uuid; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'Invalid branch_id' USING ERRCODE='22023'; END; END IF;
  PERFORM office_private.inst_assert_scope(w,branch);
  PERFORM office_private.inst_assert_relations(w,r,d);
  IF is_private AND NOT (d ? 'nonce' AND d ? 'ciphertext' AND octet_length(decode(d->>'nonce','base64'))=12 AND octet_length(decode(d->>'ciphertext','base64')) BETWEEN 17 AND 32768) THEN RAISE EXCEPTION 'Encrypted private payload required' USING ERRCODE='22023'; END IF;
  IF d ? 'source_url' AND (d->>'source_url' !~ '^https://') THEN RAISE EXCEPTION 'Evidence source_url must be HTTPS' USING ERRCODE='22023'; END IF;
  IF d ? 'amount' AND (d->>'amount' !~ '^[0-9]+(\.[0-9]{1,2})?$' OR (d->>'amount')::numeric<0) THEN RAISE EXCEPTION 'Invalid money amount' USING ERRCODE='22023'; END IF;
  IF d ? 'capacity' AND ((d->>'capacity')::numeric<1 OR (d->>'capacity')::numeric<>trunc((d->>'capacity')::numeric)) THEN RAISE EXCEPTION 'Invalid capacity' USING ERRCODE='22023'; END IF;
  -- Every resource has a strict create/update contract; updates remain full replacements.
  IF r='organizations' AND NOT (d ? 'code' AND d ? 'name' AND d ? 'jurisdiction' AND d ? 'legal_form') THEN RAISE EXCEPTION 'Required organization fields missing' USING ERRCODE='22023'; END IF;
  IF r IN ('branches','bodies','facilities','programmes','events','funds','budgets','payment_requests','reconciliations','appointments','meetings','resolutions','staff_assignments','credentials','filings','evidence','privacy_requests','asset_moves','assets') AND NOT (d ? 'code') THEN RAISE EXCEPTION 'Required code field missing for %',r USING ERRCODE='22023'; END IF;
  IF r='contributions' AND NOT (d ? 'receipt_number') THEN RAISE EXCEPTION 'Required receipt_number field missing for contributions' USING ERRCODE='22023'; END IF;
  IF r='bank_lines' AND NOT (d ? 'line_reference') THEN RAISE EXCEPTION 'Required line_reference field missing for bank_lines' USING ERRCODE='22023'; END IF;
  IF r IN ('organizations','branches','bodies','facilities','programmes','funds') AND NOT (d ? 'name') THEN RAISE EXCEPTION 'Required name field missing for %',r USING ERRCODE='22023'; END IF;
  IF r='branches' AND NOT (d ? 'organization_id') THEN RAISE EXCEPTION 'Branch organization relation required' USING ERRCODE='22023'; END IF;
  IF r IN ('facilities','assets') AND NOT (d ? 'organization_id') THEN RAISE EXCEPTION 'Organization relation required' USING ERRCODE='22023'; END IF;
  IF r IN ('programmes','events') AND NOT (d ? CASE WHEN r='programmes' THEN 'organization_id' ELSE 'programme_id' END) THEN RAISE EXCEPTION 'Parent relation required for %',r USING ERRCODE='22023'; END IF;
  IF r='events' AND NOT (d ? 'facility_id') THEN RAISE EXCEPTION 'Event facility relation required' USING ERRCODE='22023'; END IF;
  IF r IN ('funds','budgets','contributions','payment_requests','bank_lines','reconciliations') AND NOT (d ? 'fund_id' OR r='funds') THEN RAISE EXCEPTION 'Fund relation required for %',r USING ERRCODE='22023'; END IF;
  IF d ? 'amount' AND (jsonb_typeof(d->'amount') NOT IN ('string','number') OR (d->>'amount') !~ '^[0-9]+(\.[0-9]{1,2})?$') THEN RAISE EXCEPTION 'Invalid money amount' USING ERRCODE='22023'; END IF;
  IF d ? 'capacity' AND ((d->>'capacity') !~ '^[0-9]+$' OR (d->>'capacity')::integer<1) THEN RAISE EXCEPTION 'Invalid count' USING ERRCODE='22023'; END IF;
  IF d ? 'restricted' AND jsonb_typeof(d->'restricted')<>'boolean' THEN RAISE EXCEPTION 'Invalid boolean' USING ERRCODE='22023'; END IF;
  IF d ? 'source_url' AND (d->>'source_url' !~ '^https://') THEN RAISE EXCEPTION 'Evidence source_url must be HTTPS' USING ERRCODE='22023'; END IF;
  IF r='people' OR r='attendance' OR r='safeguarding' THEN IF NOT is_private THEN RAISE EXCEPTION 'Private resource requires save_private' USING ERRCODE='42501'; END IF; END IF;
END $$;

REVOKE ALL ON FUNCTION office_private.inst_assert_relations(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION office_private.inst_role(uuid),office_private.inst_cap(uuid,text),office_private.inst_assert_scope(uuid,uuid),office_private.inst_require(uuid),office_private.inst_cap_for_resource(text),office_private.inst_allowed_field(text,text),office_private.inst_validate_data(uuid,text,jsonb,boolean) FROM PUBLIC,anon,authenticated;
COMMIT;
