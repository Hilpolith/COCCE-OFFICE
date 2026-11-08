BEGIN;
CREATE OR REPLACE FUNCTION office_private.inst_finance(w uuid, action text, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  uid uuid:=auth.uid(); rid uuid; fid uuid; bid uuid; branch uuid; expected bigint;
  v bigint; st text; res text; status_out text; maker uuid; role text;
  d jsonb; supplied jsonb; ref text; method text; reason text; dir text;
  p_amount numeric; bal numeric; spent numeric; opening numeric; closing numeric;
  fr record; br record; cr record; pr record; rr record; x record; led record; z record;
  candidate_count integer; txid uuid; period_start date; period_end date; k text;
BEGIN
  PERFORM office_private.inst_require(w);
  uid:=auth.uid(); role:=office_private.inst_role(w);
  IF NOT office_private.inst_cap(w,'finance') THEN RAISE EXCEPTION 'Finance capability required' USING ERRCODE='42501'; END IF;
  IF action IS NULL OR jsonb_typeof(p)<>'object' THEN
    RAISE EXCEPTION 'Invalid finance request' USING ERRCODE='22023';
  END IF;
  expected:=NULLIF(p->>'expected_version','')::bigint;
  rid:=NULLIF(p->>'id','')::uuid;
  IF action LIKE 'save_%' THEN RETURN office_private.inst_finance_save(w,action,p); END IF;

  IF rid IS NULL THEN RAISE EXCEPTION 'Finance id required' USING ERRCODE='22023'; END IF;
  IF action IN ('submit_budget','approve_budget','submit_payment','approve_payment','post_payment','submit_reconciliation','review_reconciliation','close_reconciliation','match_bank_line','post_contribution','void_contribution') AND expected IS NULL THEN
    RAISE EXCEPTION 'Expected version required' USING ERRCODE='22023';
  END IF;

  IF action IN ('submit_budget','approve_budget','submit_payment','submit_reconciliation') THEN
    res:=CASE WHEN action IN ('submit_budget','approve_budget') THEN 'budgets' WHEN action='submit_payment' THEN 'payment_requests' ELSE 'reconciliations' END;
    SELECT r2.version,r2.status,r2.data,r2.created_by INTO v,st,d,maker FROM public.office_institutions_records r2
      WHERE r2.workspace_id=w AND r2.resource=res AND r2.id=rid FOR UPDATE;
    IF NOT FOUND OR v<>expected THEN RAISE EXCEPTION 'Stale finance transition' USING ERRCODE='40001'; END IF;
    branch:=NULLIF(d->>'branch_id','')::uuid; PERFORM office_private.inst_assert_scope(w,branch);
    IF action='submit_budget' AND st='draft' THEN status_out:='submitted';
    ELSIF action='approve_budget' AND st='submitted' AND office_private.inst_cap(w,'approve') AND maker<>uid THEN
      status_out:='approved'; d:=d||jsonb_build_object('approved_by',uid);
    ELSIF action='submit_payment' AND st='draft' THEN status_out:='submitted';
    ELSIF action='submit_reconciliation' AND st='draft' THEN status_out:='submitted';
    ELSE RAISE EXCEPTION 'Invalid finance transition' USING ERRCODE='22023'; END IF;
    UPDATE public.office_institutions_records r3 SET status=status_out,data=d,version=v+1,updated_at=now()
      WHERE r3.workspace_id=w AND r3.resource=res AND r3.id=rid;
    RETURN jsonb_build_object('id',rid,'version',v+1,'status',status_out);
  ELSIF action='post_contribution' THEN
    IF NOT office_private.inst_cap(w,'finance') THEN RAISE EXCEPTION 'Finance capability required' USING ERRCODE='42501'; END IF;
    SELECT r4.* INTO cr FROM public.office_institutions_records r4 WHERE r4.workspace_id=w AND r4.resource='contributions' AND r4.id=rid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Contribution not found' USING ERRCODE='23503'; END IF;
    IF cr.status='posted' THEN RETURN jsonb_build_object('id',rid,'version',cr.version,'status','posted'); END IF;
    IF cr.status<>'draft' OR cr.version<>expected THEN RAISE EXCEPTION 'Contribution is not a postable draft' USING ERRCODE='40001'; END IF;
    d:=cr.data; fid:=(d->>'fund_id')::uuid; branch:=NULLIF(d->>'branch_id','')::uuid; PERFORM office_private.inst_assert_scope(w,branch);
    SELECT f4.* INTO fr FROM public.office_institutions_records f4 WHERE f4.workspace_id=w AND f4.resource='funds' AND f4.id=fid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Fund missing' USING ERRCODE='23503'; END IF;
    ref:=d->>'receipt_number'; p_amount:=(d->>'amount')::numeric;
    IF EXISTS(SELECT 1 FROM public.office_institutions_ledger l0 WHERE l0.workspace_id=w AND l0.kind='contribution' AND l0.source_id=rid) THEN
      UPDATE public.office_institutions_records SET status='posted' WHERE workspace_id=w AND resource='contributions' AND id=rid;
      RETURN jsonb_build_object('id',rid,'version',cr.version,'status','posted');
    END IF;
    INSERT INTO public.office_institutions_ledger(workspace_id,fund_id,kind,amount,reference,source_id,posted_on,method,branch_id)
      VALUES(w,fid,'contribution',p_amount,ref,rid,(d->>'received_on')::date,d->>'method',branch);
    UPDATE public.office_institutions_records SET status='posted',version=cr.version+1,updated_at=now() WHERE workspace_id=w AND resource='contributions' AND id=rid;
    RETURN jsonb_build_object('id',rid,'version',cr.version+1,'status','posted');
  ELSIF action='void_contribution' THEN
    IF NOT office_private.inst_cap(w,'approve') OR role='institution_admin' THEN RAISE EXCEPTION 'Distinct approver required' USING ERRCODE='42501'; END IF;
    SELECT r5.* INTO cr FROM public.office_institutions_records r5 WHERE r5.workspace_id=w AND r5.resource='contributions' AND r5.id=rid FOR UPDATE;
    IF NOT FOUND OR cr.version<>expected OR cr.status<>'posted' OR cr.created_by=uid THEN RAISE EXCEPTION 'Contribution cannot be voided by this actor' USING ERRCODE='42501'; END IF;
    reason:=NULLIF(p->>'reason',''); IF reason IS NULL THEN RAISE EXCEPTION 'Void reason required' USING ERRCODE='22023'; END IF;
    d:=cr.data; fid:=(d->>'fund_id')::uuid; branch:=NULLIF(d->>'branch_id','')::uuid; PERFORM office_private.inst_assert_scope(w,branch);
    SELECT l1.* INTO led FROM public.office_institutions_ledger l1 WHERE l1.workspace_id=w AND l1.fund_id=fid AND l1.kind='contribution' AND l1.source_id=rid FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Contribution ledger entry missing' USING ERRCODE='23503'; END IF;
    SELECT f5.* INTO fr FROM public.office_institutions_records f5 WHERE f5.workspace_id=w AND f5.resource='funds' AND f5.id=fid FOR UPDATE;
    IF EXISTS(SELECT 1 FROM public.office_institutions_ledger l2 WHERE l2.workspace_id=w AND l2.kind='reversal' AND l2.source_id=rid) THEN RAISE EXCEPTION 'Contribution already voided' USING ERRCODE='23505'; END IF;
    bal:=COALESCE((SELECT sum(CASE WHEN l3.kind='contribution' THEN l3.amount WHEN l3.kind IN ('payment','reversal') THEN -l3.amount ELSE 0 END) FROM public.office_institutions_ledger l3 WHERE l3.workspace_id=w AND l3.fund_id=fid),0);
    IF bal-led.amount<0 THEN RAISE EXCEPTION 'Void would make fund negative' USING ERRCODE='23514'; END IF;
    INSERT INTO public.office_institutions_ledger(workspace_id,fund_id,kind,amount,reference,source_id,posted_on,method,branch_id)
      VALUES(w,fid,'reversal',led.amount,reason,rid,current_date,d->>'method',branch);
    UPDATE public.office_institutions_records SET status='voided',version=cr.version+1,updated_at=now(),data=d||jsonb_build_object('void_reason',reason)
      WHERE workspace_id=w AND resource='contributions' AND id=rid;
    RETURN jsonb_build_object('id',rid,'version',cr.version+1,'status','voided');
  ELSIF action='approve_payment' THEN
    SELECT r6.* INTO pr FROM public.office_institutions_records r6 WHERE r6.workspace_id=w AND r6.resource='payment_requests' AND r6.id=rid FOR UPDATE;
    IF NOT FOUND OR pr.version<>expected OR pr.status<>'submitted' OR pr.created_by=uid OR NOT office_private.inst_cap(w,'approve') THEN RAISE EXCEPTION 'Distinct payment approver required' USING ERRCODE='42501'; END IF;
    d:=pr.data; branch:=NULLIF(d->>'branch_id','')::uuid; PERFORM office_private.inst_assert_scope(w,branch); fid:=(d->>'fund_id')::uuid; bid:=(d->>'budget_id')::uuid;
    SELECT b2.* INTO br FROM public.office_institutions_records b2 WHERE b2.workspace_id=w AND b2.resource='budgets' AND b2.id=bid FOR UPDATE;
    IF NOT FOUND OR br.status<>'approved' OR (br.data->>'fund_id')::uuid<>fid OR (d->>'requested_on')::date NOT BETWEEN (br.data->>'period_start')::date AND (br.data->>'period_end')::date THEN RAISE EXCEPTION 'Current approved budget required' USING ERRCODE='23514'; END IF;
    d:=d||jsonb_build_object('approved_by',uid);
    UPDATE public.office_institutions_records SET status='approved',data=d,version=pr.version+1,updated_at=now() WHERE workspace_id=w AND resource='payment_requests' AND id=rid;
    RETURN jsonb_build_object('id',rid,'version',pr.version+1,'status','approved');
  ELSIF action='post_payment' THEN
    IF NOT office_private.inst_cap(w,'finance') THEN RAISE EXCEPTION 'Finance capability required' USING ERRCODE='42501'; END IF;
    SELECT r7.* INTO pr FROM public.office_institutions_records r7 WHERE r7.workspace_id=w AND r7.resource='payment_requests' AND r7.id=rid FOR UPDATE;
    IF NOT FOUND OR pr.version<>expected OR pr.status<>'approved' THEN RAISE EXCEPTION 'Current approved payment required' USING ERRCODE='40001'; END IF;
    method:=NULLIF(p->>'method',''); ref:=NULLIF(p->>'reference',''); IF method IS NULL OR method NOT IN ('cash','bank','mobile','card_manual') OR ref IS NULL THEN RAISE EXCEPTION 'Manual payment method and reference required' USING ERRCODE='22023'; END IF;
    d:=pr.data; fid:=(d->>'fund_id')::uuid; bid:=(d->>'budget_id')::uuid; branch:=NULLIF(d->>'branch_id','')::uuid; PERFORM office_private.inst_assert_scope(w,branch); p_amount:=(d->>'amount')::numeric;
    SELECT f6.* INTO fr FROM public.office_institutions_records f6 WHERE f6.workspace_id=w AND f6.resource='funds' AND f6.id=fid FOR UPDATE;
    SELECT b3.* INTO br FROM public.office_institutions_records b3 WHERE b3.workspace_id=w AND b3.resource='budgets' AND b3.id=bid FOR UPDATE;
    IF NOT FOUND OR br.status<>'approved' OR (br.data->>'fund_id')::uuid<>fid OR (d->>'requested_on')::date NOT BETWEEN (br.data->>'period_start')::date AND (br.data->>'period_end')::date THEN RAISE EXCEPTION 'Payment outside approved budget period' USING ERRCODE='23514'; END IF;
    spent:=COALESCE((SELECT sum(l4.amount) FROM public.office_institutions_ledger l4 WHERE l4.workspace_id=w AND l4.budget_id=bid AND l4.kind='payment'),0);
    IF spent+p_amount>(br.data->>'amount')::numeric THEN RAISE EXCEPTION 'Budget unavailable' USING ERRCODE='23514'; END IF;
    bal:=COALESCE((SELECT sum(CASE WHEN l5.kind='contribution' THEN l5.amount WHEN l5.kind IN ('payment','reversal') THEN -l5.amount ELSE 0 END) FROM public.office_institutions_ledger l5 WHERE l5.workspace_id=w AND l5.fund_id=fid),0);
    IF bal<p_amount THEN RAISE EXCEPTION 'Fund balance unavailable' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM public.office_institutions_ledger l6 WHERE l6.workspace_id=w AND l6.kind='payment' AND l6.source_id=rid) THEN RETURN jsonb_build_object('id',rid,'version',pr.version,'status','posted'); END IF;
    INSERT INTO public.office_institutions_ledger(workspace_id,fund_id,budget_id,kind,amount,reference,source_id,posted_on,method,branch_id)
      VALUES(w,fid,bid,'payment',p_amount,ref,rid,(d->>'requested_on')::date,method,branch);
    UPDATE public.office_institutions_records SET status='posted',version=pr.version+1,updated_at=now() WHERE workspace_id=w AND resource='payment_requests' AND id=rid;
    RETURN jsonb_build_object('id',rid,'version',pr.version+1,'status','posted');
  ELSIF action='match_bank_line' THEN
    IF NOT office_private.inst_cap(w,'finance') THEN RAISE EXCEPTION 'Finance capability required' USING ERRCODE='42501'; END IF;
    SELECT r8.* INTO x FROM public.office_institutions_records r8 WHERE r8.workspace_id=w AND r8.resource='bank_lines' AND r8.id=rid FOR UPDATE;
    IF NOT FOUND OR x.version<>expected OR x.status<>'recorded' THEN RAISE EXCEPTION 'Bank line is not matchable' USING ERRCODE='40001'; END IF;
    d:=x.data; fid:=(d->>'fund_id')::uuid; dir:=d->>'direction'; p_amount:=(d->>'amount')::numeric; branch:=NULLIF(d->>'branch_id','')::uuid; PERFORM office_private.inst_assert_scope(w,branch);
    supplied:=COALESCE(p->'data','{}'::jsonb); txid:=NULLIF(supplied->>'transaction_id','')::uuid;
    IF txid IS NOT NULL THEN
      SELECT l7.* INTO led FROM public.office_institutions_ledger l7 WHERE l7.workspace_id=w AND l7.id=txid AND l7.fund_id=fid AND l7.amount=p_amount AND l7.kind=CASE WHEN dir='in' THEN 'contribution' ELSE 'payment' END AND l7.branch_id IS NOT DISTINCT FROM branch FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Ledger transaction does not match bank line' USING ERRCODE='23514'; END IF;
    ELSE
      SELECT count(*) INTO candidate_count FROM public.office_institutions_ledger l8 WHERE l8.workspace_id=w AND l8.fund_id=fid AND l8.amount=p_amount AND l8.kind=CASE WHEN dir='in' THEN 'contribution' ELSE 'payment' END AND l8.branch_id IS NOT DISTINCT FROM branch;
      IF candidate_count<>1 THEN RAISE EXCEPTION 'No unambiguous ledger match' USING ERRCODE='23514'; END IF;
      SELECT l9.* INTO led FROM public.office_institutions_ledger l9 WHERE l9.workspace_id=w AND l9.fund_id=fid AND l9.amount=p_amount AND l9.kind=CASE WHEN dir='in' THEN 'contribution' ELSE 'payment' END AND l9.branch_id IS NOT DISTINCT FROM branch LIMIT 1 FOR UPDATE;
    END IF;
    IF EXISTS(SELECT 1 FROM public.office_institutions_records m0 WHERE m0.workspace_id=w AND m0.resource='bank_lines' AND m0.status='matched' AND m0.data->>'transaction_id'=led.id::text) THEN RAISE EXCEPTION 'Transaction already matched' USING ERRCODE='23505'; END IF;
    UPDATE public.office_institutions_records SET status='matched',version=x.version+1,updated_at=now(),data=d||jsonb_build_object('transaction_id',led.id)
      WHERE workspace_id=w AND resource='bank_lines' AND id=rid;
    RETURN jsonb_build_object('id',rid,'version',x.version+1,'status','matched');
  ELSIF action IN ('review_reconciliation','close_reconciliation') THEN
    SELECT r9.* INTO rr FROM public.office_institutions_records r9 WHERE r9.workspace_id=w AND r9.resource='reconciliations' AND r9.id=rid FOR UPDATE;
    IF NOT FOUND OR rr.version<>expected THEN RAISE EXCEPTION 'Stale reconciliation' USING ERRCODE='40001'; END IF;
    d:=rr.data; fid:=(d->>'fund_id')::uuid; branch:=NULLIF(d->>'branch_id','')::uuid; PERFORM office_private.inst_assert_scope(w,branch);
    SELECT f7.* INTO fr FROM public.office_institutions_records f7 WHERE f7.workspace_id=w AND f7.resource='funds' AND f7.id=fid FOR UPDATE;
    period_start:=(d->>'period_start')::date; period_end:=(d->>'period_end')::date;
    IF action='review_reconciliation' THEN
      IF rr.status<>'submitted' OR NOT office_private.inst_cap(w,'approve') OR rr.created_by=uid THEN RAISE EXCEPTION 'Distinct reconciliation reviewer required' USING ERRCODE='42501'; END IF;
      IF EXISTS(SELECT 1 FROM public.office_institutions_records bl WHERE bl.workspace_id=w AND bl.resource='bank_lines' AND (bl.data->>'fund_id')=fid::text AND (bl.data->>'posted_on')::date BETWEEN period_start AND period_end AND bl.status<>'matched') THEN RAISE EXCEPTION 'All period bank lines must be matched' USING ERRCODE='23514'; END IF;
      opening:=(d->>'opening_balance')::numeric; closing:=(d->>'closing_balance')::numeric;
      bal:=COALESCE((SELECT sum(CASE WHEN l10.kind='contribution' THEN l10.amount WHEN l10.kind IN ('payment','reversal') THEN -l10.amount ELSE 0 END) FROM public.office_institutions_ledger l10 WHERE l10.workspace_id=w AND l10.fund_id=fid AND l10.posted_on BETWEEN period_start AND period_end),0);
      IF closing<>opening+bal THEN RAISE EXCEPTION 'Reconciliation arithmetic does not close' USING ERRCODE='23514'; END IF;
      IF EXISTS(SELECT 1 FROM public.office_institutions_records q0 WHERE q0.workspace_id=w AND q0.resource='reconciliations' AND q0.id<>rid AND q0.data->>'fund_id'=fid::text AND q0.status IN ('submitted','reviewed','closed') AND daterange((q0.data->>'period_start')::date,(q0.data->>'period_end')::date,'[]') && daterange(period_start,period_end,'[]')) THEN RAISE EXCEPTION 'Reconciliation period overlaps' USING ERRCODE='23514'; END IF;
      UPDATE public.office_institutions_records SET status='reviewed',version=rr.version+1,updated_at=now(),data=d||jsonb_build_object('reviewed_by',uid) WHERE workspace_id=w AND resource='reconciliations' AND id=rid;
      RETURN jsonb_build_object('id',rid,'version',rr.version+1,'status','reviewed');
    ELSE
      IF rr.status<>'reviewed' OR NOT office_private.inst_cap(w,'finance') THEN RAISE EXCEPTION 'Reconciliation cannot close' USING ERRCODE='42501'; END IF;
      PERFORM 1 FROM public.office_institutions_ledger l11 WHERE l11.workspace_id=w AND l11.fund_id=fid AND l11.posted_on BETWEEN period_start AND period_end FOR UPDATE;
      UPDATE public.office_institutions_records SET status='closed',version=rr.version+1,updated_at=now() WHERE workspace_id=w AND resource='reconciliations' AND id=rid;
      RETURN jsonb_build_object('id',rid,'version',rr.version+1,'status','closed');
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported finance action' USING ERRCODE='22023';
  END IF;
END $$;

REVOKE ALL ON FUNCTION office_private.inst_finance(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
COMMIT;
