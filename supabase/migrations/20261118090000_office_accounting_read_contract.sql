BEGIN;

-- Repair the Accounting RPC contract without changing the underlying ledger,
-- role tables, encrypted payloads, or existing command workflow.
CREATE OR REPLACE FUNCTION public.office_accounting_read(
  w uuid,
  resource text,
  f jsonb DEFAULT '{}'::jsonb,
  requested_limit integer DEFAULT 200,
  requested_offset integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  lim integer := least(greatest(coalesce(requested_limit, 200), 1), 200);
  off integer := coalesce(requested_offset, 0);
  client_scope uuid;
  accounting_role text;
  allowed_roles text[];
  total bigint := 0;
  result_rows jsonb := '[]'::jsonb;
  source_sql text;
  client_expr text;
  row_expr text;
  status_filter text;
  as_of_date date;
  period_start date;
  period_end date;
  period_id_value uuid;
  currency_value text;
  capabilities jsonb;
  summary jsonb;
  key_config jsonb;
BEGIN
  IF jsonb_typeof(coalesce(f, '{}'::jsonb)) <> 'object'
     OR off < 0
     OR off > 2147483647
     OR lim < 1
     OR lim > 200 THEN
    RAISE EXCEPTION 'Invalid Accounting pagination or filter' USING ERRCODE = '22023';
  END IF;

  client_scope := NULLIF(f->>'client_id', '')::uuid;
  status_filter := NULLIF(f->>'status', '');
  IF status_filter IS NOT NULL AND (length(status_filter) > 40 OR status_filter !~ '^[a-zA-Z0-9_-]+$') THEN
    RAISE EXCEPTION 'Invalid Accounting status filter' USING ERRCODE = '22023';
  END IF;

  accounting_role := office_private.accounting_require(w, NULL, client_scope);

  IF resource = 'bootstrap' THEN
    capabilities := jsonb_build_object(
      'clients', accounting_role IN ('accounting_admin','engagement_manager'),
      'engagements', accounting_role IN ('accounting_admin','engagement_manager','accountant','client_coordinator'),
      'chart', accounting_role IN ('accounting_admin','engagement_manager','accountant'),
      'periods', accounting_role IN ('accounting_admin','engagement_manager','accountant'),
      'journals_prepare', accounting_role IN ('accounting_admin','engagement_manager','accountant'),
      'journals_submit', accounting_role IN ('accounting_admin','engagement_manager','accountant'),
      'journals_review', accounting_role IN ('accounting_admin','engagement_manager','reviewer'),
      'journals_post', accounting_role IN ('accounting_admin','engagement_manager','reviewer'),
      'journals_reverse', accounting_role IN ('accounting_admin','engagement_manager'),
      'bank_reconcile', accounting_role IN ('accounting_admin','engagement_manager','accountant','reviewer'),
      'reports', accounting_role IN ('accounting_admin','engagement_manager','accountant','reviewer','accounting_viewer'),
      'evidence', accounting_role IN ('accounting_admin','engagement_manager','accountant'),
      'findings', accounting_role IN ('accounting_admin','engagement_manager','accountant'),
      'obligations', accounting_role IN ('accounting_admin','engagement_manager','accountant'),
      'staff_assign', accounting_role = 'accounting_admin',
      'period_reopen', accounting_role IN ('accounting_admin','engagement_manager'),
      'audit', accounting_role IN ('accounting_admin','reviewer','accounting_viewer'),
      'private_records', accounting_role IN ('accounting_admin','engagement_manager','accountant')
    );

    SELECT jsonb_build_object(
      'clients_count', count(*)::integer,
      'active_engagements_count', (
        SELECT count(*)::integer FROM public.office_accounting_engagements e
        WHERE e.workspace_id = w AND e.status = 'active'
          AND (accounting_role = 'accounting_admin' OR EXISTS (
            SELECT 1 FROM public.office_accounting_staff_assignments a
            WHERE a.workspace_id = w AND a.client_id = e.client_id AND a.user_id = auth.uid() AND a.active
          ))
      ),
      'draft_journals_count', (
        SELECT count(*)::integer FROM public.office_accounting_journals j
        WHERE j.workspace_id = w AND j.status IN ('draft','returned')
          AND (accounting_role = 'accounting_admin' OR EXISTS (
            SELECT 1 FROM public.office_accounting_staff_assignments a
            WHERE a.workspace_id = w AND a.client_id = j.client_id AND a.user_id = auth.uid() AND a.active
          ))
      ),
      'awaiting_review_count', (
        SELECT count(*)::integer FROM public.office_accounting_journals j
        WHERE j.workspace_id = w AND j.status = 'submitted'
          AND (accounting_role = 'accounting_admin' OR EXISTS (
            SELECT 1 FROM public.office_accounting_staff_assignments a
            WHERE a.workspace_id = w AND a.client_id = j.client_id AND a.user_id = auth.uid() AND a.active
          ))
      ),
      'posted_journals_count', (
        SELECT count(*)::integer FROM public.office_accounting_journals j
        WHERE j.workspace_id = w AND j.status = 'posted'
          AND (accounting_role = 'accounting_admin' OR EXISTS (
            SELECT 1 FROM public.office_accounting_staff_assignments a
            WHERE a.workspace_id = w AND a.client_id = j.client_id AND a.user_id = auth.uid() AND a.active
          ))
      ),
      'unreconciled_statement_lines_count', (
        SELECT count(*)::integer FROM public.office_accounting_statement_lines l
        JOIN public.office_accounting_statements s ON s.workspace_id = l.workspace_id AND s.statement_id = l.statement_id
        WHERE l.workspace_id = w AND l.status = 'unmatched'
          AND (accounting_role = 'accounting_admin' OR EXISTS (
            SELECT 1 FROM public.office_accounting_staff_assignments a
            WHERE a.workspace_id = w AND a.client_id = s.client_id AND a.user_id = auth.uid() AND a.active
          ))
      ),
      'open_findings_count', (
        SELECT count(*)::integer FROM public.office_accounting_findings x
        WHERE x.workspace_id = w AND x.status IN ('open','management_response')
          AND (accounting_role = 'accounting_admin' OR EXISTS (
            SELECT 1 FROM public.office_accounting_staff_assignments a
            WHERE a.workspace_id = w AND a.client_id = x.client_id AND a.user_id = auth.uid() AND a.active
          ))
      ),
      'due_obligations_count', (
        SELECT count(*)::integer FROM public.office_accounting_obligations x
        WHERE x.workspace_id = w AND x.due_date <= current_date
          AND x.status NOT IN ('filed_reference_recorded','closed')
          AND (accounting_role = 'accounting_admin' OR EXISTS (
            SELECT 1 FROM public.office_accounting_staff_assignments a
            WHERE a.workspace_id = w AND a.client_id = x.client_id AND a.user_id = auth.uid() AND a.active
          ))
      )
    )
    INTO summary
    FROM public.office_accounting_clients c
    WHERE c.workspace_id = w
      AND (accounting_role = 'accounting_admin' OR EXISTS (
        SELECT 1 FROM public.office_accounting_staff_assignments a
        WHERE a.workspace_id = w AND a.client_id = c.client_id AND a.user_id = auth.uid() AND a.active
      ));

    SELECT CASE WHEN k.workspace_id IS NULL THEN jsonb_build_object('configured', false)
      ELSE jsonb_build_object(
        'configured', true, 'key_version', 1,
        'derivation', 'PBKDF2-HMAC-SHA-256/AES-256-GCM', 'iterations', 600000,
        'salt', encode(k.salt, 'base64'), 'nonce', encode(k.nonce, 'base64'),
        'ciphertext', encode(k.ciphertext, 'base64')
      ) END
    INTO key_config
    FROM (SELECT w AS workspace_id) seed
    LEFT JOIN public.office_accounting_key_configs k ON k.workspace_id = seed.workspace_id;

    RETURN jsonb_build_object(
      'role', accounting_role,
      'capabilities', capabilities,
      'settings', (SELECT to_jsonb(s) FROM public.office_accounting_settings s WHERE s.workspace_id = w),
      'key_config', coalesce(key_config, jsonb_build_object('configured', false)),
      'summary', coalesce(summary, jsonb_build_object(
        'clients_count',0,'active_engagements_count',0,'draft_journals_count',0,
        'awaiting_review_count',0,'posted_journals_count',0,'unreconciled_statement_lines_count',0,
        'open_findings_count',0,'due_obligations_count',0
      ))
    );
  END IF;

  IF resource = 'settings' THEN
    PERFORM office_private.accounting_require(w, ARRAY['accounting_admin'], NULL);
    RETURN coalesce((SELECT to_jsonb(s) FROM public.office_accounting_settings s WHERE s.workspace_id = w), '{}'::jsonb);
  END IF;

  IF resource = 'client_private' THEN
    IF client_scope IS NULL THEN RAISE EXCEPTION 'client_id required' USING ERRCODE = '22023'; END IF;
    PERFORM office_private.accounting_require(w, ARRAY['accounting_admin','engagement_manager','accountant'], client_scope);
    RETURN coalesce((
      SELECT jsonb_build_object(
        'workspace_id', p.workspace_id, 'client_id', p.client_id,
        'nonce', encode(p.nonce, 'base64'), 'ciphertext', encode(p.ciphertext, 'base64'),
        'version', p.version
      )
      FROM public.office_accounting_client_private p
      WHERE p.workspace_id = w AND p.client_id = client_scope
    ), '{}'::jsonb);
  END IF;

  IF resource IN ('trial_balance','general_ledger','profit_and_loss','balance_sheet') THEN
    IF client_scope IS NULL THEN RAISE EXCEPTION 'client_id required' USING ERRCODE = '22023'; END IF;
    PERFORM office_private.accounting_require(w, ARRAY['accounting_admin','engagement_manager','accountant','reviewer','accounting_viewer'], client_scope);
    as_of_date := coalesce(NULLIF(f->>'as_of','')::date, current_date);
    currency_value := (SELECT x.currency_code FROM public.office_accounting_clients x WHERE x.workspace_id = w AND x.client_id = client_scope);

    IF resource = 'general_ledger' THEN
      IF f ? 'period_id' THEN
        SELECT p.starts_on, p.ends_on INTO period_start, period_end
        FROM public.office_accounting_periods p
        WHERE p.workspace_id = w AND p.period_id = (f->>'period_id')::uuid AND p.client_id = client_scope;
        IF period_start IS NULL THEN RAISE EXCEPTION 'Valid client reporting period required' USING ERRCODE = '22023'; END IF;
      ELSE
        period_start := coalesce(NULLIF(f->>'starts_on','')::date, '0001-01-01'::date);
        period_end := coalesce(NULLIF(f->>'ends_on','')::date, as_of_date);
      END IF;
      SELECT count(*) INTO total
      FROM public.office_accounting_journal_lines l
      JOIN public.office_accounting_journals j ON j.workspace_id=l.workspace_id AND j.journal_id=l.journal_id
      WHERE l.workspace_id=w AND j.client_id=client_scope AND j.status='posted'
        AND j.entry_date BETWEEN period_start AND period_end;
      SELECT coalesce(jsonb_agg(x.row_data ORDER BY x.entry_date, x.journal_number, x.line_no),'[]'::jsonb)
      INTO result_rows
      FROM (
        SELECT to_jsonb(l) || jsonb_build_object(
          'client_id', j.client_id, 'entry_date', j.entry_date,
          'journal_number', j.journal_number, 'currency_code', j.currency_code
        ) AS row_data, j.entry_date, j.journal_number, l.line_no
        FROM public.office_accounting_journal_lines l
        JOIN public.office_accounting_journals j ON j.workspace_id=l.workspace_id AND j.journal_id=l.journal_id
        WHERE l.workspace_id=w AND j.client_id=client_scope AND j.status='posted'
          AND j.entry_date BETWEEN period_start AND period_end
        ORDER BY j.entry_date,j.journal_number,l.line_no LIMIT lim OFFSET off
      ) x;
    ELSE
      SELECT p.starts_on,p.ends_on,p.period_id INTO period_start,period_end,period_id_value
      FROM public.office_accounting_periods p
      WHERE p.workspace_id=w AND p.period_id=NULLIF(f->>'period_id','')::uuid AND p.client_id=client_scope;
      IF f ? 'period_id' AND period_start IS NULL THEN RAISE EXCEPTION 'Valid client reporting period required' USING ERRCODE='22023'; END IF;
      IF resource='profit_and_loss' THEN
        period_start:=coalesce(period_start,coalesce(NULLIF(f->>'starts_on','')::date,date_trunc('year',as_of_date)::date));
        period_end:=coalesce(period_end,as_of_date);
        SELECT count(*) INTO total FROM public.office_accounting_accounts a
        WHERE a.workspace_id=w AND a.client_id=client_scope AND a.account_type IN ('income','expense');
      ELSE
        period_end:=coalesce(period_end,as_of_date);
        SELECT count(*) INTO total FROM public.office_accounting_accounts a
        WHERE a.workspace_id=w AND a.client_id=client_scope;
      END IF;
      SELECT coalesce(jsonb_agg(x.row_data ORDER BY x.account_code),'[]'::jsonb) INTO result_rows
      FROM (
        SELECT jsonb_build_object(
          'client_id',a.client_id,'account_id',a.account_id,'account_code',a.account_code,
          'account_name',a.account_name,'account_type',a.account_type,
          'debit',v.debit,'credit',v.credit,
          'balance',CASE WHEN a.account_type IN ('liability','equity','income') THEN v.credit-v.debit ELSE v.debit-v.credit END,
          'currency_code',currency_value
        ) AS row_data, a.account_code
        FROM public.office_accounting_accounts a
        CROSS JOIN LATERAL (
          SELECT
            coalesce(sum(l.debit),0) AS debit,
            coalesce(sum(l.credit),0) AS credit
          FROM public.office_accounting_journal_lines l
          JOIN public.office_accounting_journals j ON j.workspace_id=l.workspace_id AND j.journal_id=l.journal_id
          WHERE l.workspace_id=w AND l.account_id=a.account_id AND j.client_id=client_scope
            AND j.status='posted' AND j.entry_date<=period_end
            AND (resource<>'profit_and_loss' OR j.entry_date>=period_start)
        ) v
        WHERE a.workspace_id=w AND a.client_id=client_scope
          AND (resource<>'profit_and_loss' OR a.account_type IN ('income','expense'))
        ORDER BY a.account_code LIMIT lim OFFSET off
      ) x;
    END IF;
    RETURN jsonb_build_object(
      'report','internal_'||resource,'client_id',client_scope,'rows',coalesce(result_rows,'[]'::jsonb),
      'total_count',total,'limit',lim,'offset',off,
      'has_more',off+jsonb_array_length(coalesce(result_rows,'[]'::jsonb))<total,'as_of',as_of_date
    );
  END IF;

  allowed_roles := CASE resource
    WHEN 'clients' THEN ARRAY['accounting_admin','engagement_manager','accountant','reviewer','client_coordinator','accounting_viewer']
    WHEN 'staff_assignments' THEN ARRAY['accounting_admin','engagement_manager']
    WHEN 'engagements' THEN ARRAY['accounting_admin','engagement_manager','accountant','reviewer','client_coordinator','accounting_viewer']
    WHEN 'chart_accounts' THEN ARRAY['accounting_admin','engagement_manager','accountant','reviewer','accounting_viewer']
    WHEN 'reporting_periods' THEN ARRAY['accounting_admin','engagement_manager','accountant','reviewer','accounting_viewer']
    WHEN 'journals' THEN ARRAY['accounting_admin','engagement_manager','accountant','reviewer','accounting_viewer']
    WHEN 'journal_lines' THEN ARRAY['accounting_admin','engagement_manager','accountant','reviewer','accounting_viewer']
    WHEN 'postings' THEN ARRAY['accounting_admin','accountant','reviewer','accounting_viewer']
    WHEN 'reversals' THEN ARRAY['accounting_admin','accountant','reviewer','accounting_viewer']
    WHEN 'bank_accounts' THEN ARRAY['accounting_admin','accountant','accounting_viewer']
    WHEN 'bank_statements' THEN ARRAY['accounting_admin','accountant','accounting_viewer']
    WHEN 'bank_statement_lines' THEN ARRAY['accounting_admin','accountant','accounting_viewer']
    WHEN 'evidence_references' THEN ARRAY['accounting_admin','engagement_manager','accountant','reviewer','client_coordinator','accounting_viewer']
    WHEN 'findings' THEN ARRAY['accounting_admin','engagement_manager','accountant','reviewer','client_coordinator','accounting_viewer']
    WHEN 'obligations' THEN ARRAY['accounting_admin','engagement_manager','accountant','reviewer','client_coordinator','accounting_viewer']
    WHEN 'audit' THEN ARRAY['accounting_admin','reviewer','accounting_viewer']
    ELSE NULL
  END;
  IF allowed_roles IS NULL THEN RAISE EXCEPTION 'Unknown Accounting resource' USING ERRCODE='22023'; END IF;
  PERFORM office_private.accounting_require(w, allowed_roles, client_scope);

  CASE resource
    WHEN 'clients' THEN
      source_sql := 'public.office_accounting_clients t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    WHEN 'staff_assignments' THEN
      source_sql := 'public.office_accounting_staff_assignments t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    WHEN 'engagements' THEN
      source_sql := 'public.office_accounting_engagements t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    WHEN 'chart_accounts' THEN
      source_sql := 'public.office_accounting_accounts t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    WHEN 'reporting_periods' THEN
      source_sql := 'public.office_accounting_periods t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    WHEN 'journals' THEN
      source_sql := 'public.office_accounting_journals t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    WHEN 'journal_lines' THEN
      source_sql := 'public.office_accounting_journal_lines t JOIN public.office_accounting_journals j ON j.workspace_id=t.workspace_id AND j.journal_id=t.journal_id';
      client_expr := 'j.client_id';
      row_expr := 'to_jsonb(t) || jsonb_build_object(''client_id'',j.client_id)';
    WHEN 'postings' THEN
      source_sql := 'public.office_accounting_postings t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    WHEN 'reversals' THEN
      source_sql := 'public.office_accounting_reversals t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    WHEN 'bank_accounts' THEN
      source_sql := 'public.office_accounting_bank_accounts t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    WHEN 'bank_statements' THEN
      source_sql := 'public.office_accounting_statements t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t) || jsonb_build_object(
        ''total_lines'',(SELECT count(*) FROM public.office_accounting_statement_lines l WHERE l.workspace_id=t.workspace_id AND l.statement_id=t.statement_id),
        ''matched_lines'',(SELECT count(*) FROM public.office_accounting_statement_lines l WHERE l.workspace_id=t.workspace_id AND l.statement_id=t.statement_id AND l.status=''matched''),
        ''excluded_lines'',(SELECT count(*) FROM public.office_accounting_statement_lines l WHERE l.workspace_id=t.workspace_id AND l.statement_id=t.statement_id AND l.status=''excluded''),
        ''unmatched_lines'',(SELECT count(*) FROM public.office_accounting_statement_lines l WHERE l.workspace_id=t.workspace_id AND l.statement_id=t.statement_id AND l.status=''unmatched''),
        ''difference'',t.opening_balance+coalesce((SELECT sum(l.signed_amount) FROM public.office_accounting_statement_lines l WHERE l.workspace_id=t.workspace_id AND l.statement_id=t.statement_id),0)-t.closing_balance,
        ''is_balanced'',(t.opening_balance+coalesce((SELECT sum(l.signed_amount) FROM public.office_accounting_statement_lines l WHERE l.workspace_id=t.workspace_id AND l.statement_id=t.statement_id),0)=t.closing_balance AND (SELECT count(*) FROM public.office_accounting_statement_lines l WHERE l.workspace_id=t.workspace_id AND l.statement_id=t.statement_id AND l.status=''unmatched'')=0 AND (SELECT count(*) FROM public.office_accounting_statement_lines l WHERE l.workspace_id=t.workspace_id AND l.statement_id=t.statement_id)>0)
      )';
    WHEN 'bank_statement_lines' THEN
      source_sql := 'public.office_accounting_statement_lines t JOIN public.office_accounting_statements j ON j.workspace_id=t.workspace_id AND j.statement_id=t.statement_id';
      client_expr := 'j.client_id';
      row_expr := 'to_jsonb(t) || jsonb_build_object(''client_id'',j.client_id)';
    WHEN 'evidence_references' THEN
      source_sql := 'public.office_accounting_evidence t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    WHEN 'findings' THEN
      source_sql := 'public.office_accounting_findings t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    WHEN 'obligations' THEN
      source_sql := 'public.office_accounting_obligations t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    WHEN 'audit' THEN
      source_sql := 'public.office_accounting_audit t';
      client_expr := 't.client_id';
      row_expr := 'to_jsonb(t)';
    ELSE
      RAISE EXCEPTION 'Unknown Accounting resource' USING ERRCODE='22023';
  END CASE;

  EXECUTE format(
    'SELECT count(*) FROM %s WHERE t.workspace_id=$1
      AND ($2 IS NULL OR %s=$2)
      AND ($3=''accounting_admin'' OR EXISTS (
        SELECT 1 FROM public.office_accounting_staff_assignments a
        WHERE a.workspace_id=$1 AND a.client_id=%s AND a.user_id=$4 AND a.active
      ))
      AND ($5 IS NULL OR to_jsonb(t)->>''status''=$5)',
    source_sql, client_expr, client_expr
  ) INTO total USING w, client_scope, accounting_role, auth.uid(), status_filter;

  EXECUTE format(
    'SELECT coalesce(jsonb_agg(x.row_data ORDER BY x.sort_key DESC),''[]''::jsonb)
     FROM (
       SELECT %s AS row_data,
         coalesce(to_jsonb(t)->>''updated_at'',to_jsonb(t)->>''created_at'',to_jsonb(t)->>''occurred_at'','''') AS sort_key
       FROM %s
       WHERE t.workspace_id=$1
         AND ($2 IS NULL OR %s=$2)
         AND ($3=''accounting_admin'' OR EXISTS (
           SELECT 1 FROM public.office_accounting_staff_assignments a
           WHERE a.workspace_id=$1 AND a.client_id=%s AND a.user_id=$4 AND a.active
         ))
         AND ($5 IS NULL OR to_jsonb(t)->>''status''=$5)
       ORDER BY sort_key DESC
       LIMIT $6 OFFSET $7
     ) x',
    row_expr, source_sql, client_expr, client_expr
  ) INTO result_rows USING w, client_scope, accounting_role, auth.uid(), status_filter, lim, off;

  RETURN jsonb_build_object(
    'rows',coalesce(result_rows,'[]'::jsonb),
    'total_count',coalesce(total,0),
    'limit',lim,'offset',off,
    'has_more',off+jsonb_array_length(coalesce(result_rows,'[]'::jsonb))<coalesce(total,0)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.office_accounting_read(uuid,text,jsonb,integer,integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.office_accounting_read(uuid,text,jsonb,integer,integer) TO authenticated;

COMMIT;
