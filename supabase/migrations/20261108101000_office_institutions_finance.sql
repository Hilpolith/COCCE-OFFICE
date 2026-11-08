BEGIN;

ALTER TABLE public.office_institutions_ledger
  ADD COLUMN IF NOT EXISTS posted_on date,
  ADD COLUMN IF NOT EXISTS method text,
  ADD COLUMN IF NOT EXISTS budget_id uuid,
  ADD COLUMN IF NOT EXISTS branch_id uuid;
ALTER TABLE public.office_institutions_ledger
  DROP CONSTRAINT IF EXISTS office_institutions_ledger_kind_check;
ALTER TABLE public.office_institutions_ledger
  ADD CONSTRAINT office_institutions_ledger_kind_check CHECK (kind IN ('contribution','payment','reversal'));
ALTER TABLE public.office_institutions_ledger
  DROP CONSTRAINT IF EXISTS office_institutions_ledger_amount_scale;
ALTER TABLE public.office_institutions_ledger
  ADD CONSTRAINT office_institutions_ledger_amount_scale CHECK (amount >= 0 AND amount = round(amount,2));
CREATE UNIQUE INDEX IF NOT EXISTS office_inst_ledger_receipt_uq
  ON public.office_institutions_ledger(workspace_id,reference) WHERE kind='contribution';
CREATE UNIQUE INDEX IF NOT EXISTS office_inst_ledger_source_kind_uq
  ON public.office_institutions_ledger(workspace_id,source_id,kind);

CREATE OR REPLACE FUNCTION office_private.inst_finance_save(w uuid, action text, p jsonb)
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
  IF action LIKE 'save_%' THEN
    res:=CASE action WHEN 'save_fund' THEN 'funds' WHEN 'save_budget' THEN 'budgets'
      WHEN 'save_contribution' THEN 'contributions' WHEN 'save_payment_request' THEN 'payment_requests'
      WHEN 'save_bank_line' THEN 'bank_lines' WHEN 'save_reconciliation' THEN 'reconciliations' END;
    IF res IS NULL THEN RAISE EXCEPTION 'Unsupported finance save' USING ERRCODE='22023'; END IF;
    IF NOT office_private.inst_cap(w,'finance') THEN RAISE EXCEPTION 'Finance capability required' USING ERRCODE='42501'; END IF;
    d:=COALESCE(p->'data','{}'::jsonb);
    PERFORM office_private.inst_validate_data(w,res,d,false);
    FOR k IN SELECT jsonb_object_keys(d) LOOP
      IF (res='funds' AND k NOT IN ('organization_id','code','name','restricted','purpose_public','currency','branch_id'))
         OR (res='budgets' AND k NOT IN ('fund_id','code','period_start','period_end','amount','reference','branch_id'))
         OR (res='contributions' AND k NOT IN ('fund_id','receipt_number','received_on','amount','method','reference','person_id','restriction_reference','branch_id'))
         OR (res='payment_requests' AND k NOT IN ('fund_id','budget_id','code','requested_on','amount','purpose_public','reference','branch_id'))
         OR (res='bank_lines' AND k NOT IN ('fund_id','statement_reference','line_reference','posted_on','amount','direction','transaction_id','branch_id'))
         OR (res='reconciliations' AND k NOT IN ('fund_id','code','period_start','period_end','opening_balance','closing_balance','reference','branch_id')) THEN
        RAISE EXCEPTION 'Unknown field % for %',k,res USING ERRCODE='22023';
      END IF;
    END LOOP;
    branch:=NULLIF(d->>'branch_id','')::uuid; PERFORM office_private.inst_assert_scope(w,branch);
    IF action='save_fund' THEN
      IF NOT (d ? 'organization_id' AND d ? 'code' AND d ? 'name' AND d ? 'restricted' AND d ? 'purpose_public' AND d ? 'currency')
        OR d->>'currency' !~ '^[A-Z]{3}$' THEN RAISE EXCEPTION 'Invalid fund' USING ERRCODE='22023'; END IF;
      IF d ? 'balance' OR d ? 'ledger_balance' THEN RAISE EXCEPTION 'Fund balance is server derived' USING ERRCODE='22023'; END IF;
      PERFORM 1 FROM public.office_institutions_records o WHERE o.workspace_id=w AND o.resource='organizations' AND o.id=(d->>'organization_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'Fund organization relation invalid' USING ERRCODE='23503'; END IF;
    ELSIF action='save_budget' THEN
      IF NOT (d ? 'fund_id' AND d ? 'code' AND d ? 'period_start' AND d ? 'period_end' AND d ? 'amount' AND d ? 'reference')
        OR d->>'amount' !~ '^[0-9]+(\.[0-9]{1,2})?$' OR (d->>'amount')::numeric<=0
        OR (d->>'period_end')::date<(d->>'period_start')::date THEN RAISE EXCEPTION 'Invalid budget' USING ERRCODE='22023'; END IF;
      PERFORM 1 FROM public.office_institutions_records b0 WHERE b0.workspace_id=w AND b0.resource='funds' AND b0.id=(d->>'fund_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'Budget fund relation invalid' USING ERRCODE='23503'; END IF;
    ELSIF action='save_contribution' THEN
      IF NOT (d ? 'fund_id' AND d ? 'receipt_number' AND d ? 'received_on' AND d ? 'amount' AND d ? 'method' AND d ? 'reference')
        OR d->>'amount' !~ '^[0-9]+(\.[0-9]{1,2})?$' OR (d->>'amount')::numeric<=0
        OR d->>'method' NOT IN ('cash','bank','mobile','card_manual') THEN RAISE EXCEPTION 'Invalid contribution' USING ERRCODE='22023'; END IF;
      PERFORM 1 FROM public.office_institutions_records f0 WHERE f0.workspace_id=w AND f0.resource='funds' AND f0.id=(d->>'fund_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'Contribution fund relation invalid' USING ERRCODE='23503'; END IF;
    ELSIF action='save_payment_request' THEN
      IF NOT (d ? 'fund_id' AND d ? 'budget_id' AND d ? 'code' AND d ? 'requested_on' AND d ? 'amount' AND d ? 'purpose_public' AND d ? 'reference')
        OR d->>'amount' !~ '^[0-9]+(\.[0-9]{1,2})?$' OR (d->>'amount')::numeric<=0 THEN RAISE EXCEPTION 'Invalid payment request' USING ERRCODE='22023'; END IF;
      PERFORM 1 FROM public.office_institutions_records f1 WHERE f1.workspace_id=w AND f1.resource='funds' AND f1.id=(d->>'fund_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'Payment fund relation invalid' USING ERRCODE='23503'; END IF;
      PERFORM 1 FROM public.office_institutions_records b1 WHERE b1.workspace_id=w AND b1.resource='budgets' AND b1.id=(d->>'budget_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'Payment budget relation invalid' USING ERRCODE='23503'; END IF;
    ELSIF action='save_bank_line' THEN
      IF NOT (d ? 'fund_id' AND d ? 'statement_reference' AND d ? 'line_reference' AND d ? 'posted_on' AND d ? 'amount' AND d ? 'direction')
        OR d->>'amount' !~ '^[0-9]+(\.[0-9]{1,2})?$' OR (d->>'amount')::numeric<=0 OR d->>'direction' NOT IN ('in','out') THEN RAISE EXCEPTION 'Invalid bank line' USING ERRCODE='22023'; END IF;
      PERFORM 1 FROM public.office_institutions_records f2 WHERE f2.workspace_id=w AND f2.resource='funds' AND f2.id=(d->>'fund_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'Bank line fund relation invalid' USING ERRCODE='23503'; END IF;
    ELSIF action='save_reconciliation' THEN
      IF NOT (d ? 'fund_id' AND d ? 'code' AND d ? 'period_start' AND d ? 'period_end' AND d ? 'opening_balance' AND d ? 'closing_balance')
        OR d->>'opening_balance' !~ '^-?[0-9]+(\.[0-9]{1,2})?$' OR d->>'closing_balance' !~ '^-?[0-9]+(\.[0-9]{1,2})?$' THEN RAISE EXCEPTION 'Invalid reconciliation' USING ERRCODE='22023'; END IF;
      IF (d->>'period_end')::date<(d->>'period_start')::date THEN RAISE EXCEPTION 'Invalid reconciliation period' USING ERRCODE='22023'; END IF;
      PERFORM 1 FROM public.office_institutions_records f3 WHERE f3.workspace_id=w AND f3.resource='funds' AND f3.id=(d->>'fund_id')::uuid;
      IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation fund relation invalid' USING ERRCODE='23503'; END IF;
    END IF;
    rid:=NULLIF(p->>'id','')::uuid;
    IF rid IS NULL THEN
      IF p ? 'expected_version' THEN RAISE EXCEPTION 'Create cannot include expected_version' USING ERRCODE='22023'; END IF;
      rid:=gen_random_uuid(); status_out:=CASE WHEN res='funds' THEN 'active' WHEN res='bank_lines' THEN 'recorded' ELSE 'draft' END;
      INSERT INTO public.office_institutions_records(id,workspace_id,resource,data,status,created_by)
        VALUES(rid,w,res,d,status_out,uid); v:=1;
    ELSE
      IF expected IS NULL OR expected<1 THEN RAISE EXCEPTION 'Expected version required' USING ERRCODE='22023'; END IF;
      SELECT r0.version,r0.status,r0.data INTO v,st,supplied FROM public.office_institutions_records r0
        WHERE r0.workspace_id=w AND r0.resource=res AND r0.id=rid FOR UPDATE;
      IF NOT FOUND OR v<>expected THEN RAISE EXCEPTION 'Stale finance record' USING ERRCODE='40001'; END IF;
      IF st IN ('posted','voided','matched','reviewed','closed','approved') THEN RAISE EXCEPTION 'Immutable finance record' USING ERRCODE='55000'; END IF;
      FOR k IN SELECT unnest(ARRAY['branch_id','organization_id','fund_id','budget_id','currency']) LOOP
        IF supplied->k IS DISTINCT FROM d->k THEN RAISE EXCEPTION 'Finance relationship and scope are immutable' USING ERRCODE='22023'; END IF;
      END LOOP;
      UPDATE public.office_institutions_records r1 SET data=d,version=v+1,updated_at=now()
        WHERE r1.workspace_id=w AND r1.resource=res AND r1.id=rid; v:=v+1; status_out:=st;
    END IF;
    RETURN jsonb_build_object('id',rid,'version',v,'status',COALESCE(status_out,st));
  END IF;

  RAISE EXCEPTION 'Unsupported finance save' USING ERRCODE='22023';
END; $$;
REVOKE ALL ON FUNCTION office_private.inst_finance_save(uuid,text,jsonb) FROM PUBLIC,anon,authenticated;
COMMIT;
