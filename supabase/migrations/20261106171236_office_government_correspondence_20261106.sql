-- Applied to COCCE Super App (nresyncmhdybucenhxbw) as migration version 20261106171236.
-- Source: owner-approved SQL, SHA-256 99ef4d0475b78c1a4c24aaba0507008fd44f52eaf48141e92920488560142381.
-- DDL body matches the approved source; only the four proposal-state header comments were replaced.
-- Migration name: office_government_correspondence_20261106.
-- Requires the already-installed office_industry_spaces profile schema.
-- Adds only office_gov_correspondence* objects and private helper functions.
-- No existing table, policy, Auth, Realtime, wallet, storage, or Bunny setting is changed.
-- No files are stored or transferred; no official reference is generated; dispatch is logged only.

BEGIN;

DO $preflight$
BEGIN
  IF to_regclass('public.office_workspaces') IS NULL
     OR to_regclass('public.office_memberships') IS NULL
     OR to_regclass('public.office_industry_spaces') IS NULL
     OR to_regprocedure('office_private.is_active_member(uuid)') IS NULL
     OR to_regprocedure('office_private.is_admin(uuid)') IS NULL THEN
    RAISE EXCEPTION 'Existing Office workspaces, memberships, industry profiles, and authorization helpers are required';
  END IF;
END;
$preflight$;

CREATE FUNCTION office_private.government_correspondence_statuses(p_direction text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = ''
AS $function$
  SELECT CASE p_direction
    WHEN 'incoming' THEN ARRAY[
      'received', 'registered', 'routed', 'in_progress',
      'review_requested', 'changes_requested', 'approved', 'closed', 'cancelled'
    ]::text[]
    WHEN 'outgoing' THEN ARRAY[
      'draft', 'review_requested', 'changes_requested', 'approved',
      'registered', 'dispatched', 'closed', 'cancelled'
    ]::text[]
    ELSE ARRAY[]::text[]
  END;
$function$;

CREATE TABLE public.office_gov_correspondence (
  correspondence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  industry_id text NOT NULL DEFAULT 'government'
    CHECK (industry_id = 'government'),
  idempotency_key uuid NOT NULL,
  direction text NOT NULL
    CHECK (direction IN ('incoming', 'outgoing')),
  record_type text NOT NULL
    CHECK (record_type IN ('letter', 'memo', 'circular', 'service_request', 'meeting_action', 'other')),
  subject text NOT NULL
    CHECK (char_length(btrim(subject)) BETWEEN 1 AND 140)
    CHECK (subject = btrim(subject))
    CHECK (subject !~ '[[:cntrl:]]'),
  summary text NOT NULL DEFAULT ''
    CHECK (char_length(summary) <= 2000)
    CHECK (summary !~ '[[:cntrl:]]'),
  official_reference text NOT NULL DEFAULT ''
    CHECK (char_length(official_reference) <= 100)
    CHECK (official_reference = btrim(official_reference))
    CHECK (official_reference !~ '[[:cntrl:]]'),
  source_unit text NOT NULL DEFAULT ''
    CHECK (char_length(source_unit) <= 100)
    CHECK (source_unit = btrim(source_unit))
    CHECK (source_unit !~ '[[:cntrl:]]'),
  destination_unit text NOT NULL DEFAULT ''
    CHECK (char_length(destination_unit) <= 100)
    CHECK (destination_unit = btrim(destination_unit))
    CHECK (destination_unit !~ '[[:cntrl:]]'),
  current_department text NOT NULL DEFAULT ''
    CHECK (char_length(current_department) <= 100)
    CHECK (current_department = btrim(current_department))
    CHECK (current_department !~ '[[:cntrl:]]'),
  assigned_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  received_date date,
  due_date date,
  related_incoming_id uuid,
  related_incoming_direction text GENERATED ALWAYS AS (
    CASE WHEN related_incoming_id IS NOT NULL THEN 'incoming'::text ELSE NULL::text END
  ) STORED,
  dispatch_method text
    CHECK (dispatch_method IS NULL OR dispatch_method IN ('email', 'courier', 'hand_delivery', 'other')),
  dispatch_reference text NOT NULL DEFAULT ''
    CHECK (char_length(dispatch_reference) <= 100)
    CHECK (dispatch_reference = btrim(dispatch_reference))
    CHECK (dispatch_reference !~ '[[:cntrl:]]'),
  dispatched_at timestamptz,
  status text NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_gov_correspondence_profile_fk
    FOREIGN KEY (workspace_id, industry_id)
    REFERENCES public.office_industry_spaces(workspace_id, industry_id)
    ON DELETE RESTRICT,
  CONSTRAINT office_gov_correspondence_related_fk
    FOREIGN KEY (related_incoming_id, workspace_id, related_incoming_direction)
    REFERENCES public.office_gov_correspondence(correspondence_id, workspace_id, direction)
    ON DELETE RESTRICT,
  CONSTRAINT office_gov_correspondence_workspace_idempotency_uq
    UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT office_gov_correspondence_id_workspace_uq
    UNIQUE (correspondence_id, workspace_id),
  CONSTRAINT office_gov_correspondence_id_workspace_direction_uq
    UNIQUE (correspondence_id, workspace_id, direction),
  CONSTRAINT office_gov_correspondence_status_ck
    CHECK (pg_catalog.array_position(
      office_private.government_correspondence_statuses(direction), status
    ) IS NOT NULL),
  CONSTRAINT office_gov_correspondence_direction_fields_ck
    CHECK (
      (direction = 'incoming' AND received_date IS NOT NULL AND related_incoming_id IS NULL
        AND dispatch_method IS NULL AND dispatched_at IS NULL AND dispatch_reference = '')
      OR
      (direction = 'outgoing' AND received_date IS NULL)
    ),
  CONSTRAINT office_gov_correspondence_dispatch_ck
    CHECK (
      (dispatch_method IS NULL AND dispatched_at IS NULL AND dispatch_reference = '')
      OR
      (direction = 'outgoing' AND dispatch_method IS NOT NULL AND dispatched_at IS NOT NULL
        AND status IN ('dispatched', 'closed'))
    )
);

COMMENT ON TABLE public.office_gov_correspondence IS
  'Office-only, non-sensitive Government correspondence metadata. Not an approved government records repository; stores no file bytes and generates no official references.';

CREATE UNIQUE INDEX office_gov_correspondence_workspace_reference_uq
  ON public.office_gov_correspondence (workspace_id, direction, pg_catalog.lower(official_reference))
  WHERE official_reference <> '';
CREATE INDEX office_gov_correspondence_workspace_created_idx
  ON public.office_gov_correspondence (workspace_id, created_at DESC, correspondence_id DESC);
CREATE INDEX office_gov_correspondence_workspace_status_idx
  ON public.office_gov_correspondence (workspace_id, direction, status, created_at DESC, correspondence_id DESC);
CREATE INDEX office_gov_correspondence_workspace_assignee_idx
  ON public.office_gov_correspondence (workspace_id, assigned_user_id, updated_at DESC, correspondence_id DESC);

CREATE TABLE public.office_gov_correspondence_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  correspondence_id uuid NOT NULL,
  actor_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_kind text NOT NULL
    CHECK (event_kind IN (
      'created', 'updated', 'registered', 'routed', 'work_started',
      'review_requested', 'approved', 'changes_requested', 'dispatched', 'closed', 'cancelled'
    )),
  record_version bigint NOT NULL CHECK (record_version > 0),
  from_status text,
  to_status text NOT NULL,
  changed_fields text[] NOT NULL DEFAULT ARRAY[]::text[]
    CHECK (changed_fields <@ ARRAY[
      'record_type', 'subject', 'summary', 'source_unit', 'destination_unit',
      'received_date', 'due_date', 'related_incoming_id', 'official_reference',
      'current_department', 'assigned_user_id', 'dispatch_method', 'dispatch_reference'
    ]::text[]),
  from_department text,
  to_department text,
  from_assignee_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  to_assignee_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT office_gov_correspondence_events_record_fk
    FOREIGN KEY (correspondence_id, workspace_id)
    REFERENCES public.office_gov_correspondence(correspondence_id, workspace_id)
    ON DELETE RESTRICT,
  CONSTRAINT office_gov_correspondence_events_record_version_uq
    UNIQUE (correspondence_id, record_version),
  CONSTRAINT office_gov_correspondence_events_shape_ck CHECK (
    ((event_kind = 'created' AND from_status IS NULL AND to_status IN ('received', 'draft')
        AND record_version = 1 AND cardinality(changed_fields) = 0)
      OR (event_kind <> 'created' AND from_status IS NOT NULL AND record_version > 1))
    AND
    ((event_kind = 'created' AND to_status IN ('received', 'draft'))
      OR (event_kind = 'updated' AND from_status = to_status
        AND from_status IN ('received', 'draft', 'changes_requested')
        AND cardinality(changed_fields) BETWEEN 1 AND 13)
      OR (event_kind = 'registered'
        AND ((from_status = 'received' AND to_status = 'registered')
          OR (from_status = 'approved' AND to_status = 'registered'))
        AND 'official_reference' = ANY(changed_fields))
      OR (event_kind = 'routed'
        AND (((from_status IN ('registered', 'routed', 'in_progress', 'changes_requested')) AND to_status = 'routed')
          OR (from_status IN ('draft', 'changes_requested') AND to_status = 'draft'))
        AND 'current_department' = ANY(changed_fields)
        AND 'assigned_user_id' = ANY(changed_fields))
      OR (event_kind = 'work_started' AND from_status IN ('routed', 'changes_requested') AND to_status = 'in_progress')
      OR (event_kind = 'review_requested'
        AND from_status IN ('in_progress', 'draft', 'changes_requested') AND to_status = 'review_requested')
      OR (event_kind = 'approved' AND from_status = 'review_requested' AND to_status = 'approved')
      OR (event_kind = 'changes_requested' AND from_status = 'review_requested' AND to_status = 'changes_requested')
      OR (event_kind = 'dispatched' AND from_status = 'registered' AND to_status = 'dispatched'
        AND 'dispatch_method' = ANY(changed_fields) AND 'dispatch_reference' = ANY(changed_fields))
      OR (event_kind = 'closed' AND from_status IN ('approved', 'dispatched') AND to_status = 'closed')
      OR (event_kind = 'cancelled' AND from_status NOT IN ('dispatched', 'closed', 'cancelled') AND to_status = 'cancelled'))
  )
);

COMMENT ON TABLE public.office_gov_correspondence_events IS
  'Append-only history for Government correspondence metadata and workflow actions. Does not store subject/summary contents or documents.';

CREATE INDEX office_gov_correspondence_events_record_time_idx
  ON public.office_gov_correspondence_events (workspace_id, correspondence_id, created_at DESC, event_id DESC);

CREATE FUNCTION office_private.government_correspondence_validate_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_version bigint;
  v_status text;
  v_previous_status text;
BEGIN
  SELECT c.version, c.status INTO v_version, v_status
  FROM public.office_gov_correspondence AS c
  WHERE c.workspace_id = NEW.workspace_id
    AND c.correspondence_id = NEW.correspondence_id;
  IF NOT FOUND OR v_version <> NEW.record_version OR v_status IS DISTINCT FROM NEW.to_status THEN
    RAISE EXCEPTION 'Correspondence event must match the current record version and status' USING ERRCODE = '23514';
  END IF;
  IF NEW.event_kind = 'created' THEN
    IF EXISTS (
      SELECT 1 FROM public.office_gov_correspondence_events AS e
      WHERE e.workspace_id = NEW.workspace_id AND e.correspondence_id = NEW.correspondence_id
    ) THEN
      RAISE EXCEPTION 'Created event must be the first history entry' USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT e.to_status INTO v_previous_status
    FROM public.office_gov_correspondence_events AS e
    WHERE e.workspace_id = NEW.workspace_id
      AND e.correspondence_id = NEW.correspondence_id
      AND e.record_version = NEW.record_version - 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Correspondence history versions must be contiguous' USING ERRCODE = '23514';
    END IF;
    IF v_previous_status IS DISTINCT FROM NEW.from_status THEN
      RAISE EXCEPTION 'Correspondence event from-status must match the previous history entry' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE FUNCTION office_private.government_correspondence_reject_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'Government correspondence history is append-only' USING ERRCODE = '42501';
  RETURN NULL;
END;
$function$;

CREATE TRIGGER office_gov_correspondence_events_validate_insert
  BEFORE INSERT ON public.office_gov_correspondence_events
  FOR EACH ROW EXECUTE FUNCTION office_private.government_correspondence_validate_event();
CREATE TRIGGER office_gov_correspondence_events_no_row_mutation
  BEFORE UPDATE OR DELETE ON public.office_gov_correspondence_events
  FOR EACH ROW EXECUTE FUNCTION office_private.government_correspondence_reject_event_mutation();
CREATE TRIGGER office_gov_correspondence_events_no_truncate
  BEFORE TRUNCATE ON public.office_gov_correspondence_events
  FOR EACH STATEMENT EXECUTE FUNCTION office_private.government_correspondence_reject_event_mutation();

ALTER TABLE public.office_gov_correspondence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.office_gov_correspondence_events ENABLE ROW LEVEL SECURITY;

-- Direct PostgREST/table access is denied, including service_role. RPCs are the only application data path.
REVOKE ALL ON TABLE public.office_gov_correspondence,
  public.office_gov_correspondence_events
  FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.office_gov_correspondence_create(
  p_workspace_id uuid,
  p_idempotency_key uuid,
  p_direction text,
  p_record_type text,
  p_subject text,
  p_summary text,
  p_source_unit text,
  p_destination_unit text,
  p_received_date date,
  p_due_date date,
  p_related_incoming_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_direction text := coalesce(p_direction, '');
  v_record_type text := coalesce(p_record_type, '');
  v_subject text := btrim(coalesce(p_subject, ''));
  v_summary text := coalesce(p_summary, '');
  v_source text := btrim(coalesce(p_source_unit, ''));
  v_destination text := btrim(coalesce(p_destination_unit, ''));
  v_initial_status text;
  v_record public.office_gov_correspondence%ROWTYPE;
  v_id uuid;
BEGIN
  IF v_actor IS NULL OR p_workspace_id IS NULL OR p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'Authentication, a workspace, and a retry key are required' USING ERRCODE = '42501';
  END IF;
  IF NOT office_private.is_active_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Active Office Team membership required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_industry_spaces AS s
    WHERE s.workspace_id = p_workspace_id AND s.industry_id = 'government'
  ) THEN
    RAISE EXCEPTION 'A Government industry profile is required for this team' USING ERRCODE = 'P0002';
  END IF;
  IF v_direction NOT IN ('incoming', 'outgoing') THEN
    RAISE EXCEPTION 'Direction must be incoming or outgoing' USING ERRCODE = '22023';
  END IF;
  IF v_record_type NOT IN ('letter', 'memo', 'circular', 'service_request', 'meeting_action', 'other') THEN
    RAISE EXCEPTION 'Unsupported correspondence type' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_subject) NOT BETWEEN 1 AND 140 OR v_subject ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Subject must be 1-140 printable characters' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_summary) > 2000 OR v_summary ~ '[[:cntrl:]]'
     OR char_length(v_source) > 100 OR v_source ~ '[[:cntrl:]]'
     OR char_length(v_destination) > 100 OR v_destination ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Summary or unit field is invalid or exceeds its allowed length' USING ERRCODE = '22023';
  END IF;
  IF v_direction = 'incoming' AND p_received_date IS NULL THEN
    RAISE EXCEPTION 'A received date is required for incoming correspondence' USING ERRCODE = '22023';
  END IF;
  IF v_direction = 'outgoing' AND p_received_date IS NOT NULL THEN
    RAISE EXCEPTION 'Outgoing correspondence cannot have a received date' USING ERRCODE = '22023';
  END IF;
  IF p_related_incoming_id IS NOT NULL THEN
    IF v_direction <> 'outgoing' THEN
      RAISE EXCEPTION 'Only outgoing correspondence can link to an incoming item' USING ERRCODE = '22023';
    END IF;
    SELECT c.* INTO v_record
    FROM public.office_gov_correspondence AS c
    WHERE c.workspace_id = p_workspace_id
      AND c.correspondence_id = p_related_incoming_id
      AND c.direction = 'incoming';
    IF NOT FOUND OR (NOT office_private.is_admin(p_workspace_id)
      AND v_record.created_by IS DISTINCT FROM v_actor
      AND v_record.assigned_user_id IS DISTINCT FROM v_actor) THEN
      RAISE EXCEPTION 'Related incoming correspondence is not available to this account' USING ERRCODE = '42501';
    END IF;
  END IF;
  v_initial_status := CASE v_direction WHEN 'incoming' THEN 'received' ELSE 'draft' END;

  INSERT INTO public.office_gov_correspondence (
    workspace_id, industry_id, idempotency_key, direction, record_type,
    subject, summary, source_unit, destination_unit, received_date, due_date,
    related_incoming_id, assigned_user_id, status, created_by, updated_by
  ) VALUES (
    p_workspace_id, 'government', p_idempotency_key, v_direction, v_record_type,
    v_subject, v_summary, v_source, v_destination, p_received_date, p_due_date,
    p_related_incoming_id, v_actor, v_initial_status, v_actor, v_actor
  )
  ON CONFLICT ON CONSTRAINT office_gov_correspondence_workspace_idempotency_uq DO NOTHING
  RETURNING correspondence_id INTO v_id;

  IF v_id IS NULL THEN
    SELECT c.* INTO v_record
    FROM public.office_gov_correspondence AS c
    WHERE c.workspace_id = p_workspace_id AND c.idempotency_key = p_idempotency_key;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Concurrent correspondence creation could not be resolved';
    END IF;
    IF v_record.created_by IS DISTINCT FROM v_actor
       AND NOT office_private.is_admin(p_workspace_id) THEN
      RAISE EXCEPTION 'Retry key belongs to another account' USING ERRCODE = '42501';
    END IF;
    IF ROW(v_record.direction, v_record.record_type, v_record.subject, v_record.summary,
           v_record.source_unit, v_record.destination_unit, v_record.received_date,
           v_record.due_date, v_record.related_incoming_id)
       IS DISTINCT FROM
       ROW(v_direction, v_record_type, v_subject, v_summary, v_source, v_destination,
           p_received_date, p_due_date, p_related_incoming_id) THEN
      RAISE EXCEPTION 'Retry key was already used for different correspondence' USING ERRCODE = '22023';
    END IF;
    RETURN v_record.correspondence_id;
  END IF;

  INSERT INTO public.office_gov_correspondence_events (
    workspace_id, correspondence_id, actor_id, event_kind, record_version,
    from_status, to_status, to_department, to_assignee_user_id
  ) VALUES (
    p_workspace_id, v_id, v_actor, 'created', 1,
    NULL, v_initial_status, '', v_actor
  );
  RETURN v_id;
END;
$function$;

CREATE FUNCTION public.office_gov_correspondence_list(
  p_workspace_id uuid,
  p_direction text DEFAULT NULL,
  p_status text DEFAULT NULL,
  p_limit integer DEFAULT 50,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_correspondence_id uuid DEFAULT NULL
)
RETURNS TABLE (
  correspondence_id uuid,
  workspace_id uuid,
  direction text,
  record_type text,
  subject text,
  summary text,
  official_reference text,
  source_unit text,
  destination_unit text,
  current_department text,
  assigned_user_id uuid,
  received_date date,
  due_date date,
  related_incoming_id uuid,
  dispatch_method text,
  dispatch_reference text,
  dispatched_at timestamptz,
  status text,
  version bigint,
  created_by uuid,
  created_at timestamptz,
  updated_by uuid,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
BEGIN
  IF v_actor IS NULL OR p_workspace_id IS NULL OR NOT office_private.is_active_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Active Office Team membership required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_industry_spaces AS s
    WHERE s.workspace_id = p_workspace_id AND s.industry_id = 'government'
  ) THEN
    RAISE EXCEPTION 'A Government industry profile is required for this team' USING ERRCODE = 'P0002';
  END IF;
  IF p_direction IS NOT NULL AND p_direction NOT IN ('incoming', 'outgoing') THEN
    RAISE EXCEPTION 'Direction filter is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN (
    'received', 'registered', 'routed', 'in_progress', 'review_requested',
    'changes_requested', 'approved', 'draft', 'dispatched', 'closed', 'cancelled'
  ) THEN
    RAISE EXCEPTION 'Status filter is invalid' USING ERRCODE = '22023';
  END IF;
  IF (p_before_created_at IS NULL) <> (p_before_correspondence_id IS NULL) THEN
    RAISE EXCEPTION 'Both correspondence cursor fields must be supplied together' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  SELECT c.correspondence_id, c.workspace_id, c.direction, c.record_type,
         c.subject, c.summary, c.official_reference, c.source_unit, c.destination_unit,
         c.current_department, c.assigned_user_id, c.received_date, c.due_date,
         c.related_incoming_id, c.dispatch_method, c.dispatch_reference, c.dispatched_at,
         c.status, c.version, c.created_by, c.created_at, c.updated_by, c.updated_at
  FROM public.office_gov_correspondence AS c
  WHERE c.workspace_id = p_workspace_id
    AND (p_direction IS NULL OR c.direction = p_direction)
    AND (p_status IS NULL OR c.status = p_status)
    AND (p_before_created_at IS NULL
      OR (c.created_at, c.correspondence_id) < (p_before_created_at, p_before_correspondence_id))
    AND (office_private.is_admin(p_workspace_id)
      OR c.created_by = v_actor OR c.assigned_user_id = v_actor)
  ORDER BY c.created_at DESC, c.correspondence_id DESC
  LIMIT v_limit;
END;
$function$;

CREATE FUNCTION public.office_gov_correspondence_update(
  p_workspace_id uuid,
  p_correspondence_id uuid,
  p_expected_version bigint,
  p_record_type text,
  p_subject text,
  p_summary text,
  p_source_unit text,
  p_destination_unit text,
  p_received_date date,
  p_due_date date,
  p_related_incoming_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_admin boolean;
  v_record public.office_gov_correspondence%ROWTYPE;
  v_record_type text := coalesce(p_record_type, '');
  v_subject text := btrim(coalesce(p_subject, ''));
  v_summary text := coalesce(p_summary, '');
  v_source text := btrim(coalesce(p_source_unit, ''));
  v_destination text := btrim(coalesce(p_destination_unit, ''));
  v_fields text[] := ARRAY[]::text[];
  v_new_version bigint;
BEGIN
  IF v_actor IS NULL OR p_workspace_id IS NULL OR p_correspondence_id IS NULL THEN
    RAISE EXCEPTION 'Authentication, workspace, and correspondence are required' USING ERRCODE = '42501';
  END IF;
  IF NOT office_private.is_active_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Active Office Team membership required' USING ERRCODE = '42501';
  END IF;
  v_admin := office_private.is_admin(p_workspace_id);

  SELECT c.* INTO v_record
  FROM public.office_gov_correspondence AS c
  WHERE c.workspace_id = p_workspace_id AND c.correspondence_id = p_correspondence_id
  FOR UPDATE;
  IF NOT FOUND OR (NOT v_admin AND v_record.created_by IS DISTINCT FROM v_actor
      AND v_record.assigned_user_id IS DISTINCT FROM v_actor) THEN
    RAISE EXCEPTION 'Correspondence record is not available to this account' USING ERRCODE = '42501';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 OR v_record.version <> p_expected_version THEN
    RAISE EXCEPTION 'Correspondence changed elsewhere; refresh before saving' USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (v_record.direction = 'incoming' AND v_record.status = 'received')
    OR (v_record.direction = 'outgoing' AND v_record.status IN ('draft', 'changes_requested'))
  ) THEN
    RAISE EXCEPTION 'Correspondence content is frozen after registration or review; use the workflow actions instead' USING ERRCODE = '22023';
  END IF;
  IF NOT v_admin AND v_record.created_by IS DISTINCT FROM v_actor THEN
    RAISE EXCEPTION 'Only the creator may edit an unregistered draft or received record' USING ERRCODE = '42501';
  END IF;
  IF v_record.direction = 'incoming' AND p_received_date IS NULL THEN
    RAISE EXCEPTION 'A received date is required for incoming correspondence' USING ERRCODE = '22023';
  END IF;
  IF v_record.direction = 'outgoing' AND p_received_date IS NOT NULL THEN
    RAISE EXCEPTION 'Outgoing correspondence cannot have a received date' USING ERRCODE = '22023';
  END IF;
  IF v_record.direction = 'incoming' AND p_related_incoming_id IS NOT NULL THEN
    RAISE EXCEPTION 'Incoming correspondence cannot link to another incoming item' USING ERRCODE = '22023';
  END IF;
  IF p_related_incoming_id IS NOT NULL THEN
    IF v_record.direction <> 'outgoing' THEN
      RAISE EXCEPTION 'Only outgoing correspondence can link to an incoming item' USING ERRCODE = '22023';
    END IF;
    PERFORM 1 FROM public.office_gov_correspondence AS related
    WHERE related.workspace_id = p_workspace_id
      AND related.correspondence_id = p_related_incoming_id
      AND related.direction = 'incoming'
      AND (v_admin OR related.created_by = v_actor OR related.assigned_user_id = v_actor);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Related incoming correspondence is not available to this account' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF v_record_type NOT IN ('letter', 'memo', 'circular', 'service_request', 'meeting_action', 'other')
     OR char_length(v_subject) NOT BETWEEN 1 AND 140 OR v_subject ~ '[[:cntrl:]]'
     OR char_length(v_summary) > 2000 OR v_summary ~ '[[:cntrl:]]'
     OR char_length(v_source) > 100 OR v_source ~ '[[:cntrl:]]'
     OR char_length(v_destination) > 100 OR v_destination ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'A correspondence field is invalid or exceeds its allowed length' USING ERRCODE = '22023';
  END IF;

  IF v_record.record_type IS DISTINCT FROM v_record_type THEN v_fields := array_append(v_fields, 'record_type'); END IF;
  IF v_record.subject IS DISTINCT FROM v_subject THEN v_fields := array_append(v_fields, 'subject'); END IF;
  IF v_record.summary IS DISTINCT FROM v_summary THEN v_fields := array_append(v_fields, 'summary'); END IF;
  IF v_record.source_unit IS DISTINCT FROM v_source THEN v_fields := array_append(v_fields, 'source_unit'); END IF;
  IF v_record.destination_unit IS DISTINCT FROM v_destination THEN v_fields := array_append(v_fields, 'destination_unit'); END IF;
  IF v_record.received_date IS DISTINCT FROM p_received_date THEN v_fields := array_append(v_fields, 'received_date'); END IF;
  IF v_record.due_date IS DISTINCT FROM p_due_date THEN v_fields := array_append(v_fields, 'due_date'); END IF;
  IF v_record.related_incoming_id IS DISTINCT FROM p_related_incoming_id THEN v_fields := array_append(v_fields, 'related_incoming_id'); END IF;
  IF cardinality(v_fields) = 0 THEN RETURN v_record.version; END IF;

  UPDATE public.office_gov_correspondence AS c
  SET record_type = v_record_type,
      subject = v_subject,
      summary = v_summary,
      source_unit = v_source,
      destination_unit = v_destination,
      received_date = p_received_date,
      due_date = p_due_date,
      related_incoming_id = p_related_incoming_id,
      version = c.version + 1,
      updated_by = v_actor,
      updated_at = now()
  WHERE c.workspace_id = p_workspace_id AND c.correspondence_id = p_correspondence_id
  RETURNING c.version INTO v_new_version;

  INSERT INTO public.office_gov_correspondence_events (
    workspace_id, correspondence_id, actor_id, event_kind, record_version,
    from_status, to_status, changed_fields
  ) VALUES (
    p_workspace_id, p_correspondence_id, v_actor, 'updated', v_new_version,
    v_record.status, v_record.status, v_fields
  );
  RETURN v_new_version;
END;
$function$;

CREATE FUNCTION public.office_gov_correspondence_register(
  p_workspace_id uuid,
  p_correspondence_id uuid,
  p_expected_version bigint,
  p_official_reference text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_record public.office_gov_correspondence%ROWTYPE;
  v_reference text := btrim(coalesce(p_official_reference, ''));
  v_new_version bigint;
BEGIN
  IF v_actor IS NULL OR p_workspace_id IS NULL OR NOT office_private.is_active_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Active Office Team membership required' USING ERRCODE = '42501';
  END IF;
  IF NOT office_private.is_admin(p_workspace_id) THEN
    RAISE EXCEPTION 'Owner or administrator access is required to register correspondence' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reference) NOT BETWEEN 1 AND 100 OR v_reference ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'Enter the institution-issued reference (1-100 printable characters)' USING ERRCODE = '22023';
  END IF;

  SELECT c.* INTO v_record
  FROM public.office_gov_correspondence AS c
  WHERE c.workspace_id = p_workspace_id AND c.correspondence_id = p_correspondence_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Correspondence record not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 OR v_record.version <> p_expected_version THEN
    RAISE EXCEPTION 'Correspondence changed elsewhere; refresh before registering' USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (v_record.direction = 'incoming' AND v_record.status = 'received')
    OR (v_record.direction = 'outgoing' AND v_record.status = 'approved')
  ) THEN
    RAISE EXCEPTION 'Only received incoming or approved outgoing correspondence can be registered' USING ERRCODE = '22023';
  END IF;

  UPDATE public.office_gov_correspondence AS c
  SET official_reference = v_reference,
      status = 'registered',
      version = c.version + 1,
      updated_by = v_actor,
      updated_at = now()
  WHERE c.workspace_id = p_workspace_id AND c.correspondence_id = p_correspondence_id
  RETURNING c.version INTO v_new_version;

  INSERT INTO public.office_gov_correspondence_events (
    workspace_id, correspondence_id, actor_id, event_kind, record_version,
    from_status, to_status, changed_fields
  ) VALUES (
    p_workspace_id, p_correspondence_id, v_actor, 'registered', v_new_version,
    v_record.status, 'registered', ARRAY['official_reference']::text[]
  );
  RETURN v_new_version;
END;
$function$;

CREATE FUNCTION public.office_gov_correspondence_route(
  p_workspace_id uuid,
  p_correspondence_id uuid,
  p_expected_version bigint,
  p_department text,
  p_assigned_user_id uuid
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_record public.office_gov_correspondence%ROWTYPE;
  v_department text := btrim(coalesce(p_department, ''));
  v_new_status text;
  v_new_version bigint;
BEGIN
  IF v_actor IS NULL OR p_workspace_id IS NULL OR NOT office_private.is_active_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Active Office Team membership required' USING ERRCODE = '42501';
  END IF;
  IF NOT office_private.is_admin(p_workspace_id) THEN
    RAISE EXCEPTION 'Owner or administrator access is required to route correspondence' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_department) NOT BETWEEN 1 AND 100 OR v_department ~ '[[:cntrl:]]' OR p_assigned_user_id IS NULL THEN
    RAISE EXCEPTION 'A department and active assignee are required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_memberships AS m
    WHERE m.workspace_id = p_workspace_id AND m.user_id = p_assigned_user_id AND m.status = 'active'
  ) THEN
    RAISE EXCEPTION 'Assignee must be an active member of this Office Team' USING ERRCODE = '42501';
  END IF;

  SELECT c.* INTO v_record
  FROM public.office_gov_correspondence AS c
  WHERE c.workspace_id = p_workspace_id AND c.correspondence_id = p_correspondence_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Correspondence record not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 OR v_record.version <> p_expected_version THEN
    RAISE EXCEPTION 'Correspondence changed elsewhere; refresh before routing' USING ERRCODE = '40001';
  END IF;
  IF (v_record.direction = 'incoming' AND v_record.status NOT IN ('registered', 'routed', 'in_progress', 'changes_requested'))
     OR (v_record.direction = 'outgoing' AND v_record.status NOT IN ('draft', 'changes_requested')) THEN
    RAISE EXCEPTION 'Correspondence is not at a routable or reassignable stage' USING ERRCODE = '22023';
  END IF;
  v_new_status := CASE WHEN v_record.direction = 'incoming' THEN 'routed' ELSE 'draft' END;
  IF v_record.current_department = v_department
     AND v_record.assigned_user_id = p_assigned_user_id
     AND v_record.status = v_new_status THEN
    RETURN v_record.version;
  END IF;

  UPDATE public.office_gov_correspondence AS c
  SET current_department = v_department,
      assigned_user_id = p_assigned_user_id,
      status = v_new_status,
      version = c.version + 1,
      updated_by = v_actor,
      updated_at = now()
  WHERE c.workspace_id = p_workspace_id AND c.correspondence_id = p_correspondence_id
  RETURNING c.version INTO v_new_version;

  INSERT INTO public.office_gov_correspondence_events (
    workspace_id, correspondence_id, actor_id, event_kind, record_version,
    from_status, to_status, changed_fields, from_department, to_department,
    from_assignee_user_id, to_assignee_user_id
  ) VALUES (
    p_workspace_id, p_correspondence_id, v_actor, 'routed', v_new_version,
    v_record.status, v_new_status, ARRAY['current_department', 'assigned_user_id']::text[],
    v_record.current_department, v_department, v_record.assigned_user_id, p_assigned_user_id
  );
  RETURN v_new_version;
END;
$function$;

CREATE FUNCTION public.office_gov_correspondence_transition(
  p_workspace_id uuid,
  p_correspondence_id uuid,
  p_expected_version bigint,
  p_action text,
  p_dispatch_method text DEFAULT NULL,
  p_dispatch_reference text DEFAULT ''
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_admin boolean;
  v_record public.office_gov_correspondence%ROWTYPE;
  v_new_status text;
  v_event_kind text;
  v_fields text[] := ARRAY[]::text[];
  v_dispatch_reference text := btrim(coalesce(p_dispatch_reference, ''));
  v_new_version bigint;
BEGIN
  IF v_actor IS NULL OR p_workspace_id IS NULL OR p_correspondence_id IS NULL THEN
    RAISE EXCEPTION 'Authentication, workspace, and correspondence are required' USING ERRCODE = '42501';
  END IF;
  IF NOT office_private.is_active_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Active Office Team membership required' USING ERRCODE = '42501';
  END IF;
  v_admin := office_private.is_admin(p_workspace_id);

  SELECT c.* INTO v_record
  FROM public.office_gov_correspondence AS c
  WHERE c.workspace_id = p_workspace_id AND c.correspondence_id = p_correspondence_id
  FOR UPDATE;
  IF NOT FOUND OR (NOT v_admin AND v_record.created_by IS DISTINCT FROM v_actor
      AND v_record.assigned_user_id IS DISTINCT FROM v_actor) THEN
    RAISE EXCEPTION 'Correspondence record is not available to this account' USING ERRCODE = '42501';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 OR v_record.version <> p_expected_version THEN
    RAISE EXCEPTION 'Correspondence changed elsewhere; refresh before acting' USING ERRCODE = '40001';
  END IF;
  IF p_action IS DISTINCT FROM 'dispatch'
     AND (p_dispatch_method IS NOT NULL OR coalesce(p_dispatch_reference, '') <> '') THEN
    RAISE EXCEPTION 'Dispatch details are accepted only for a dispatch action' USING ERRCODE = '22023';
  END IF;

  IF p_action = 'start_work' THEN
    IF v_record.direction <> 'incoming' OR v_record.status NOT IN ('routed', 'changes_requested') THEN
      RAISE EXCEPTION 'Only routed or returned incoming correspondence can start work' USING ERRCODE = '22023';
    END IF;
    IF NOT v_admin AND v_record.assigned_user_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Only the assigned member may start work' USING ERRCODE = '42501';
    END IF;
    v_new_status := 'in_progress';
    v_event_kind := 'work_started';
  ELSIF p_action = 'request_review' THEN
    IF (v_record.direction = 'incoming' AND v_record.status NOT IN ('in_progress', 'changes_requested'))
       OR (v_record.direction = 'outgoing' AND v_record.status NOT IN ('draft', 'changes_requested')) THEN
      RAISE EXCEPTION 'Correspondence is not ready to request review' USING ERRCODE = '22023';
    END IF;
    IF NOT v_admin AND v_record.created_by IS DISTINCT FROM v_actor
       AND v_record.assigned_user_id IS DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'Only the creator or assignee may request review' USING ERRCODE = '42501';
    END IF;
    v_new_status := 'review_requested';
    v_event_kind := 'review_requested';
  ELSIF p_action = 'approve' OR p_action = 'request_changes' THEN
    IF v_record.status <> 'review_requested' OR NOT v_admin THEN
      RAISE EXCEPTION 'Only an owner/admin may decide a review request' USING ERRCODE = '42501';
    END IF;
    IF v_record.created_by IS NOT DISTINCT FROM v_actor
       OR v_record.assigned_user_id IS NOT DISTINCT FROM v_actor THEN
      RAISE EXCEPTION 'The creator and assignee cannot review their own correspondence' USING ERRCODE = '42501';
    END IF;
    IF p_action = 'approve' THEN
      v_new_status := 'approved';
      v_event_kind := 'approved';
    ELSE
      v_new_status := 'changes_requested';
      v_event_kind := 'changes_requested';
    END IF;
  ELSIF p_action = 'dispatch' THEN
    IF v_record.direction <> 'outgoing' OR v_record.status <> 'registered' OR NOT v_admin THEN
      RAISE EXCEPTION 'Only an owner/admin may record dispatch of registered outgoing correspondence' USING ERRCODE = '42501';
    END IF;
    IF p_dispatch_method NOT IN ('email', 'courier', 'hand_delivery', 'other')
       OR char_length(v_dispatch_reference) > 100 OR v_dispatch_reference ~ '[[:cntrl:]]' THEN
      RAISE EXCEPTION 'Select a dispatch method and enter a valid optional dispatch reference' USING ERRCODE = '22023';
    END IF;
    v_new_status := 'dispatched';
    v_event_kind := 'dispatched';
    v_fields := ARRAY['dispatch_method', 'dispatch_reference']::text[];
  ELSIF p_action = 'close' THEN
    IF NOT v_admin
       OR NOT ((v_record.direction = 'incoming' AND v_record.status = 'approved')
         OR (v_record.direction = 'outgoing' AND v_record.status = 'dispatched')) THEN
      RAISE EXCEPTION 'Only an owner/admin may close approved incoming or dispatched outgoing correspondence' USING ERRCODE = '42501';
    END IF;
    v_new_status := 'closed';
    v_event_kind := 'closed';
  ELSIF p_action = 'cancel' THEN
    IF NOT v_admin OR v_record.status IN ('dispatched', 'closed', 'cancelled') THEN
      RAISE EXCEPTION 'Only an owner/admin may cancel correspondence that has not been dispatched or closed' USING ERRCODE = '42501';
    END IF;
    v_new_status := 'cancelled';
    v_event_kind := 'cancelled';
  ELSE
    RAISE EXCEPTION 'Unsupported correspondence action' USING ERRCODE = '22023';
  END IF;

  UPDATE public.office_gov_correspondence AS c
  SET status = v_new_status,
      dispatch_method = CASE WHEN p_action = 'dispatch' THEN p_dispatch_method ELSE c.dispatch_method END,
      dispatch_reference = CASE WHEN p_action = 'dispatch' THEN v_dispatch_reference ELSE c.dispatch_reference END,
      dispatched_at = CASE WHEN p_action = 'dispatch' THEN now() ELSE c.dispatched_at END,
      version = c.version + 1,
      updated_by = v_actor,
      updated_at = now()
  WHERE c.workspace_id = p_workspace_id AND c.correspondence_id = p_correspondence_id
  RETURNING c.version INTO v_new_version;

  INSERT INTO public.office_gov_correspondence_events (
    workspace_id, correspondence_id, actor_id, event_kind, record_version,
    from_status, to_status, changed_fields
  ) VALUES (
    p_workspace_id, p_correspondence_id, v_actor, v_event_kind, v_new_version,
    v_record.status, v_new_status, v_fields
  );
  RETURN v_new_version;
END;
$function$;

CREATE FUNCTION public.office_gov_correspondence_list_events(
  p_workspace_id uuid,
  p_correspondence_id uuid,
  p_limit integer DEFAULT 50,
  p_before_created_at timestamptz DEFAULT NULL,
  p_before_event_id uuid DEFAULT NULL
)
RETURNS TABLE (
  event_id uuid,
  correspondence_id uuid,
  actor_id uuid,
  event_kind text,
  record_version bigint,
  from_status text,
  to_status text,
  changed_fields text[],
  from_department text,
  to_department text,
  from_assignee_user_id uuid,
  to_assignee_user_id uuid,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 100));
BEGIN
  IF v_actor IS NULL OR p_workspace_id IS NULL OR NOT office_private.is_active_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Active Office Team membership required' USING ERRCODE = '42501';
  END IF;
  IF (p_before_created_at IS NULL) <> (p_before_event_id IS NULL) THEN
    RAISE EXCEPTION 'Both event cursor fields must be supplied together' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.office_gov_correspondence AS c
    WHERE c.workspace_id = p_workspace_id
      AND c.correspondence_id = p_correspondence_id
      AND (office_private.is_admin(p_workspace_id)
        OR c.created_by = v_actor OR c.assigned_user_id = v_actor)
  ) THEN
    RAISE EXCEPTION 'Correspondence record is not available to this account' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT e.event_id, e.correspondence_id, e.actor_id, e.event_kind, e.record_version,
         e.from_status, e.to_status, e.changed_fields, e.from_department, e.to_department,
         e.from_assignee_user_id, e.to_assignee_user_id, e.created_at
  FROM public.office_gov_correspondence_events AS e
  WHERE e.workspace_id = p_workspace_id
    AND e.correspondence_id = p_correspondence_id
    AND (p_before_created_at IS NULL
      OR (e.created_at, e.event_id) < (p_before_created_at, p_before_event_id))
  ORDER BY e.created_at DESC, e.event_id DESC
  LIMIT v_limit;
END;
$function$;

REVOKE ALL ON FUNCTION office_private.government_correspondence_statuses(text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION office_private.government_correspondence_validate_event()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION office_private.government_correspondence_reject_event_mutation()
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_gov_correspondence_create(uuid, uuid, text, text, text, text, text, text, date, date, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_gov_correspondence_list(uuid, text, text, integer, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_gov_correspondence_update(uuid, uuid, bigint, text, text, text, text, text, date, date, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_gov_correspondence_register(uuid, uuid, bigint, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_gov_correspondence_route(uuid, uuid, bigint, text, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_gov_correspondence_transition(uuid, uuid, bigint, text, text, text)
  FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.office_gov_correspondence_list_events(uuid, uuid, integer, timestamptz, uuid)
  FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.office_gov_correspondence_create(uuid, uuid, text, text, text, text, text, text, date, date, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_gov_correspondence_list(uuid, text, text, integer, timestamptz, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_gov_correspondence_update(uuid, uuid, bigint, text, text, text, text, text, date, date, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_gov_correspondence_register(uuid, uuid, bigint, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_gov_correspondence_route(uuid, uuid, bigint, text, uuid)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_gov_correspondence_transition(uuid, uuid, bigint, text, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_gov_correspondence_list_events(uuid, uuid, integer, timestamptz, uuid)
  TO authenticated;

COMMIT;
