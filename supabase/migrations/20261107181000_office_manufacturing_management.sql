BEGIN;
SET LOCAL lock_timeout='15s';
SET LOCAL statement_timeout='90s';
CREATE SCHEMA IF NOT EXISTS office_private;
DO $mfg_prerequisites$
BEGIN
 IF to_regclass('public.office_workspaces') IS NULL
 OR to_regclass('public.office_memberships') IS NULL
 OR to_regclass('public.office_industry_spaces') IS NULL
 OR to_regclass('public.office_cloud_files') IS NULL
 OR to_regclass('public.office_cloud_revisions') IS NULL
 OR to_regprocedure('office_private.is_active_member(uuid)') IS NULL
 OR to_regprocedure('office_private.is_admin(uuid)') IS NULL THEN
  RAISE EXCEPTION 'Existing Office Team, industry registration and cloud file metadata schemas are required';
 END IF;
END $mfg_prerequisites$;

-- Manufacturing source: 00-schema.sql
CREATE TABLE public.office_manufacturing_staff_roles
  (id UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid() UNIQUE,
                                                         workspace_id UUID NOT NULL,
                                                                           user_id UUID NOT NULL,
                                                                                        manufacturing_role text NOT NULL CHECK(manufacturing_role IN('manufacturing_admin', 'production_planner', 'storekeeper', 'production_operator', 'quality_reviewer', 'maintenance_engineer', 'safety_officer', 'manufacturing_viewer')),
                                                                                                                         active boolean NOT NULL DEFAULT TRUE,
                                                                                                                                                         assigned_by UUID REFERENCES auth.users(id) ON DELETE
   SET NULL,
       VERSION integer NOT NULL DEFAULT 1 CHECK(VERSION>0),
                                          created_at timestamptz NOT NULL DEFAULT now(),
                                                                                  updated_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                          PRIMARY KEY(workspace_id,
                                                                                                                                      user_id),
   FOREIGN KEY(workspace_id, user_id) REFERENCES public.office_memberships(workspace_id, user_id) ON DELETE CASCADE);


CREATE TABLE public.office_manufacturing_settings
  (id UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid() UNIQUE,
                                                         workspace_id UUID PRIMARY KEY REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
                                                                                                                                         factory_name text NOT NULL CHECK(char_length(btrim(factory_name)) BETWEEN 1 AND 160),
                                                                                                                                                                    jurisdiction text NOT NULL CHECK(jurisdiction IN('tanzania_mainland', 'zanzibar', 'other')),
                                                                                                                                                                                               currency_code text NOT NULL DEFAULT 'TZS' CHECK(currency_code='TZS'),
                                                                                                                                                                                                                                         timezone_name text NOT NULL DEFAULT 'Africa/Dar_es_Salaam' CHECK(timezone_name='Africa/Dar_es_Salaam'),
                                                                                                                                                                                                                                                                                                    VERSION integer NOT NULL DEFAULT 1 CHECK(VERSION>0),
                                                                                                                                                                                                                                                                                                                                       created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                                                                                                                                               updated_at timestamptz NOT NULL DEFAULT now());


CREATE TABLE public.office_manufacturing_key_configs
  (workspace_id UUID PRIMARY KEY REFERENCES public.office_workspaces(id) ON DELETE CASCADE,
                                                                                   salt BYTEA NOT NULL CHECK(octet_length(salt)=16),
                                                                                                       nonce BYTEA NOT NULL CHECK(octet_length(nonce)=12),
                                                                                                                            ciphertext BYTEA NOT NULL CHECK(octet_length(ciphertext) BETWEEN 17 AND 32768),
                                                                                                                                                      created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                              created_by UUID REFERENCES auth.users(id) ON DELETE
   SET NULL);


CREATE TABLE public.office_manufacturing_items
  (id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                               workspace_id UUID NOT NULL,
                                                 sku text NOT NULL,
                                                          name text NOT NULL,
                                                                    kind text NOT NULL CHECK(kind IN('raw_material', 'component', 'finished_good', 'consumable')),
                                                                                       unit text NOT NULL,
                                                                                                 reorder_point numeric(24, 6) NOT NULL DEFAULT 0 CHECK(reorder_point>=0),
                                                                                                                                                 status text NOT NULL CHECK(status IN('active', 'archived')),
                                                                                                                                                                      VERSION integer NOT NULL DEFAULT 1,
                                                                                                                                                                                                       created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                               updated_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                                                       UNIQUE(workspace_id, id),
                                                                                                                                                                                                                                                                                       UNIQUE(workspace_id, sku),
   FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE);


CREATE TABLE public.office_manufacturing_suppliers
  (id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                               workspace_id UUID NOT NULL,
                                                 supplier_code text NOT NULL,
                                                                    display_label text NOT NULL,
                                                                                       status text NOT NULL CHECK(status IN('active', 'archived')),
                                                                                                            VERSION integer NOT NULL DEFAULT 1,
                                                                                                                                             created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                     updated_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                             UNIQUE(workspace_id, id),
                                                                                                                                                                                                                             UNIQUE(workspace_id, supplier_code),
   FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE);


CREATE TABLE public.office_manufacturing_supplier_private
  (workspace_id UUID NOT NULL,
                     supplier_id UUID NOT NULL,
                                      nonce BYTEA NOT NULL CHECK(octet_length(nonce)=12),
                                                           ciphertext BYTEA NOT NULL CHECK(octet_length(ciphertext) BETWEEN 17 AND 32768),
                                                                                     VERSION integer NOT NULL DEFAULT 1,
                                                                                                                      updated_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                              PRIMARY KEY(workspace_id,
                                                                                                                                                                          supplier_id),
   FOREIGN KEY(workspace_id, supplier_id) REFERENCES public.office_manufacturing_suppliers(workspace_id, id) ON DELETE RESTRICT);


CREATE TABLE public.office_manufacturing_locations
  (id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                               workspace_id UUID NOT NULL,
                                                 code text NOT NULL,
                                                           name text NOT NULL,
                                                                     status text NOT NULL CHECK(status IN('active', 'archived')),
                                                                                          VERSION integer NOT NULL DEFAULT 1,
                                                                                                                           created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                   updated_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                           UNIQUE(workspace_id, id),
                                                                                                                                                                                                           UNIQUE(workspace_id, code),
   FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE);


CREATE TABLE public.office_manufacturing_assets
  (id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                               workspace_id UUID NOT NULL,
                                                 asset_code text NOT NULL,
                                                                 name text NOT NULL,
                                                                           status text NOT NULL CHECK(status IN('operational', 'maintenance', 'out_of_service')),
                                                                                                next_service_date date,VERSION integer NOT NULL DEFAULT 1,
                                                                                                                                                        created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                updated_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                        UNIQUE(workspace_id, id),
                                                                                                                                                                                                                                        UNIQUE(workspace_id, asset_code),
   FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON DELETE CASCADE);


CREATE TABLE public.office_manufacturing_boms
  (id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                               workspace_id UUID NOT NULL,
                                                 bom_code text NOT NULL,
                                                               revision text NOT NULL,
                                                                             kind text NOT NULL CHECK(kind IN('standard', 'rework')),
                                                                                                product_id UUID NOT NULL,
                                                                                                                output_quantity numeric(24, 6) NOT NULL CHECK(output_quantity>0),
                                                                                                                                                        status text NOT NULL CHECK(status IN('draft', 'active', 'retired')),
                                                                                                                                                                             VERSION integer NOT NULL DEFAULT 1,
                                                                                                                                                                                                              created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                      updated_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                                                              UNIQUE(workspace_id, id),
                                                                                                                                                                                                                                                                                              UNIQUE(workspace_id, bom_code, revision),
   FOREIGN KEY(workspace_id, product_id) REFERENCES public.office_manufacturing_items(workspace_id, id) ON DELETE RESTRICT);


CREATE TABLE public.office_manufacturing_bom_lines
  (id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                               workspace_id UUID NOT NULL,
                                                 bom_id UUID NOT NULL,
                                                             item_id UUID NOT NULL,
                                                                          quantity numeric(24, 6) NOT NULL CHECK(quantity>0),
                                                                                                           VERSION integer NOT NULL DEFAULT 1,
                                                                                                                                            created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                    updated_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                            UNIQUE(workspace_id, id),
                                                                                                                                                                                                                            UNIQUE(workspace_id, bom_id, item_id),
   FOREIGN KEY(workspace_id, bom_id) REFERENCES public.office_manufacturing_boms(workspace_id, id) ON DELETE CASCADE,
   FOREIGN KEY(workspace_id, item_id) REFERENCES public.office_manufacturing_items(workspace_id, id) ON DELETE RESTRICT);


CREATE TABLE public.office_manufacturing_lots
  (id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                               workspace_id UUID NOT NULL,
                                                 item_id UUID NOT NULL,
                                                              batch_code text NOT NULL,
                                                                              supplier_id UUID,
                                                                                          supplier_lot text,source_order_id UUID,
                                                                                                                            received_date date NOT NULL,
                                                                                                                                               expiry_date date,status text NOT NULL CHECK(status IN('quarantine', 'released', 'rejected', 'rework')),
                                                                                                                                                                                     unit_cost numeric(24, 6) NOT NULL CHECK(unit_cost>=0),
                                                                                                                                                                                                                       VERSION integer NOT NULL DEFAULT 1,
                                                                                                                                                                                                                                                        created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                                                                updated_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                                                                                                        UNIQUE(workspace_id, id),
                                                                                                                                                                                                                                                                                                                                        UNIQUE(workspace_id, batch_code),
   FOREIGN KEY(workspace_id, item_id) REFERENCES public.office_manufacturing_items(workspace_id, id) ON DELETE RESTRICT,
   FOREIGN KEY(workspace_id, supplier_id) REFERENCES public.office_manufacturing_suppliers(workspace_id, id) ON DELETE RESTRICT);


CREATE TABLE public.office_manufacturing_stock_balances
  (id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                               workspace_id UUID NOT NULL,
                                                 lot_id UUID NOT NULL,
                                                             item_id UUID NOT NULL,
                                                                          location_id UUID NOT NULL,
                                                                                           on_hand numeric(24, 6) NOT NULL DEFAULT 0 CHECK(on_hand>=0),
                                                                                                                                     reserved numeric(24, 6) NOT NULL DEFAULT 0 CHECK(reserved>=0
                                                                                                                                                                                      AND reserved<=on_hand),
                                                                                                                                                                                VERSION integer NOT NULL DEFAULT 1,
                                                                                                                                                                                                                 UNIQUE(workspace_id, lot_id, location_id),
   FOREIGN KEY(workspace_id, lot_id) REFERENCES public.office_manufacturing_lots(workspace_id, id) ON DELETE RESTRICT,
   FOREIGN KEY(workspace_id, item_id) REFERENCES public.office_manufacturing_items(workspace_id, id) ON DELETE RESTRICT,
   FOREIGN KEY(workspace_id, location_id) REFERENCES public.office_manufacturing_locations(workspace_id, id) ON DELETE RESTRICT);


CREATE TABLE public.office_manufacturing_stock_movements
  (id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                               workspace_id UUID NOT NULL,
                                                 kind text NOT NULL,
                                                           lot_id UUID NOT NULL,
                                                                       from_location_id UUID,
                                                                                        to_location_id UUID,
                                                                                                       quantity numeric(24, 6) NOT NULL CHECK(quantity>0),
                                                                                                                                        unit_cost numeric(24, 6) NOT NULL,
                                                                                                                                                                 reference text NOT NULL,
                                                                                                                                                                                reason text NOT NULL,
                                                                                                                                                                                            order_id UUID,
                                                                                                                                                                                                     maintenance_id UUID,
                                                                                                                                                                                                                    created_by UUID REFERENCES auth.users(id) ON DELETE
   SET NULL,
       created_at timestamptz NOT NULL DEFAULT now(),
   FOREIGN KEY(workspace_id, lot_id) REFERENCES public.office_manufacturing_lots(workspace_id, id) ON DELETE RESTRICT);


CREATE TABLE public.office_manufacturing_production_orders(id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                                                                                       workspace_id UUID NOT NULL,
                                                                                                         order_code text NOT NULL,
                                                                                                                         bom_id UUID NOT NULL,
                                                                                                                                     product_id UUID NOT NULL,
                                                                                                                                                     bom_kind text NOT NULL,
                                                                                                                                                                   target_quantity numeric(24, 6) NOT NULL CHECK(target_quantity>0),
                                                                                                                                                                                                           due_date date NOT NULL,
                                                                                                                                                                                                                         asset_id UUID,
                                                                                                                                                                                                                                  output_location_id UUID NOT NULL,
                                                                                                                                                                                                                                                          status text NOT NULL CHECK(status IN('planned', 'released', 'in_progress', 'paused', 'awaiting_quality', 'quality_hold', 'completed', 'rejected', 'cancelled')),
                                                                                                                                                                                                                                                                               started_by UUID,
                                                                                                                                                                                                                                                                                          output_lot_id UUID,
                                                                                                                                                                                                                                                                                                        output_quantity numeric(24, 6) NOT NULL DEFAULT 0,
                                                                                                                                                                                                                                                                                                                                                        scrap_quantity numeric(24, 6) NOT NULL DEFAULT 0,
                                                                                                                                                                                                                                                                                                                                                                                                       labour_cost numeric(48, 6) NOT NULL DEFAULT 0,
                                                                                                                                                                                                                                                                                                                                                                                                                                                   overhead_cost numeric(48, 6) NOT NULL DEFAULT 0,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 material_cost numeric(48, 6) NOT NULL DEFAULT 0,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               total_cost numeric(48, 6) NOT NULL DEFAULT 0,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          VERSION integer NOT NULL DEFAULT 1,
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   updated_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           UNIQUE(workspace_id, id),
                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           UNIQUE(workspace_id, order_code),
                                                           FOREIGN KEY(workspace_id, bom_id) REFERENCES public.office_manufacturing_boms(workspace_id, id),
                                                           FOREIGN KEY(workspace_id, product_id) REFERENCES public.office_manufacturing_items(workspace_id, id),
                                                           FOREIGN KEY(workspace_id, asset_id) REFERENCES public.office_manufacturing_assets(workspace_id, id),
                                                           FOREIGN KEY(workspace_id, output_location_id) REFERENCES public.office_manufacturing_locations(workspace_id, id));


CREATE TABLE public.office_manufacturing_order_requirements
  (id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                               workspace_id UUID NOT NULL,
                                                 order_id UUID NOT NULL,
                                                               item_id UUID NOT NULL,
                                                                            required_quantity numeric(24, 6) NOT NULL,
                                                                                                             allocated_quantity numeric(24, 6) NOT NULL DEFAULT 0,
                                                                                                                                                                issued_quantity numeric(24, 6) NOT NULL DEFAULT 0,
                                                                                                                                                                                                                returned_quantity numeric(24, 6) NOT NULL DEFAULT 0,
                                                                                                                                                                                                                                                                  UNIQUE(workspace_id, id),
   FOREIGN KEY(workspace_id, order_id) REFERENCES public.office_manufacturing_production_orders(workspace_id, id) ON DELETE CASCADE,
   FOREIGN KEY(workspace_id, item_id) REFERENCES public.office_manufacturing_items(workspace_id, id));


CREATE TABLE public.office_manufacturing_allocations
  (id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                               workspace_id UUID NOT NULL,
                                                 order_id UUID NOT NULL,
                                                               item_id UUID NOT NULL,
                                                                            lot_id UUID NOT NULL,
                                                                                        location_id UUID NOT NULL,
                                                                                                         quantity numeric(24, 6) NOT NULL,
                                                                                                                                 returned_quantity numeric(24, 6) NOT NULL DEFAULT 0,
                                                                                                                                                                                   status text NOT NULL CHECK(status IN('reserved', 'issued', 'released')),
                                                                                                                                                                                                        VERSION integer NOT NULL DEFAULT 1,
   FOREIGN KEY(workspace_id, order_id) REFERENCES public.office_manufacturing_production_orders(workspace_id, id) ON DELETE CASCADE,
   FOREIGN KEY(workspace_id, item_id) REFERENCES public.office_manufacturing_items(workspace_id, id),
   FOREIGN KEY(workspace_id, lot_id, location_id) REFERENCES public.office_manufacturing_stock_balances(workspace_id, lot_id, location_id));


CREATE TABLE public.office_manufacturing_inspections(id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                                                                                 workspace_id UUID NOT NULL,
                                                                                                   lot_id UUID NOT NULL,
                                                                                                               RESULT text NOT NULL CHECK(RESULT IN('pass', 'hold', 'reject', 'rework')),
                                                                                                                                    standard_reference text NOT NULL,
                                                                                                                                                            observations text NOT NULL,
                                                                                                                                                                              created_by UUID REFERENCES auth.users(id),
                                                                                                                                                                                                         created_at timestamptz NOT NULL DEFAULT now(),
                                                     FOREIGN KEY(workspace_id, lot_id) REFERENCES public.office_manufacturing_lots(workspace_id, id));


CREATE TABLE public.office_manufacturing_maintenance_orders(id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                                                                                        workspace_id UUID NOT NULL,
                                                                                                          work_code text NOT NULL,
                                                                                                                         asset_id UUID NOT NULL,
                                                                                                                                       kind text NOT NULL CHECK(kind IN('preventive', 'corrective')),
                                                                                                                                                          priority text NOT NULL CHECK(priority IN('routine', 'high', 'critical')),
                                                                                                                                                                                 due_date date NOT NULL,
                                                                                                                                                                                               status text NOT NULL CHECK(status IN('open', 'scheduled', 'in_progress', 'awaiting_parts', 'completed', 'verified', 'cancelled')),
                                                                                                                                                                                                                    work_notes text NOT NULL,
                                                                                                                                                                                                                                    completion_notes text,permit_reference text,completed_by UUID,
                                                                                                                                                                                                                                                                                             parts_cost numeric(48, 6) NOT NULL DEFAULT 0,
                                                                                                                                                                                                                                                                                                                                        VERSION integer NOT NULL DEFAULT 1,
                                                                                                                                                                                                                                                                                                                                                                         created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                                                                                                                                                                                 updated_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                                                                                                                                                                                                                         UNIQUE(workspace_id, id),
                                                                                                                                                                                                                                                                                                                                                                                                                                                         UNIQUE(workspace_id, work_code),
                                                            FOREIGN KEY(workspace_id, asset_id) REFERENCES public.office_manufacturing_assets(workspace_id, id));


CREATE TABLE public.office_manufacturing_maintenance_parts(id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                                                                                       workspace_id UUID NOT NULL,
                                                                                                         maintenance_id UUID NOT NULL,
                                                                                                                             lot_id UUID NOT NULL,
                                                                                                                                         location_id UUID NOT NULL,
                                                                                                                                                          quantity numeric(24, 6) NOT NULL,
                                                                                                                                                                                  returned_quantity numeric(24, 6) NOT NULL DEFAULT 0,
                                                                                                                                                                                                                                    unit_cost numeric(24, 6) NOT NULL,
                                                                                                                                                                                                                                                             VERSION integer NOT NULL DEFAULT 1,
                                                           FOREIGN KEY(workspace_id, maintenance_id) REFERENCES public.office_manufacturing_maintenance_orders(workspace_id, id),
                                                           FOREIGN KEY(workspace_id, lot_id, location_id) REFERENCES public.office_manufacturing_stock_balances(workspace_id, lot_id, location_id));


CREATE TABLE public.office_manufacturing_compliance_records(id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                                                                                        workspace_id UUID NOT NULL,
                                                                                                          record_code text NOT NULL,
                                                                                                                           record_type text NOT NULL CHECK(record_type IN('permit', 'certificate', 'inspection', 'risk', 'incident', 'waste_action')),
                                                                                                                                                     authority text NOT NULL CHECK(authority IN('OSHA', 'TBS', 'NEMC', 'BRELA', 'TRA_ETS', 'internal', 'other')),
                                                                                                                                                                             title text NOT NULL,
                                                                                                                                                                                        due_date date NOT NULL,
                                                                                                                                                                                                      severity text NOT NULL CHECK(severity IN('routine', 'high', 'critical')),
                                                                                                                                                                                                                             external_reference text,status text NOT NULL CHECK(status IN('open', 'in_progress', 'pending_verification', 'closed')),
                                                                                                                                                                                                                                                                          action_notes text NOT NULL,
                                                                                                                                                                                                                                                                                            resolution_notes text,submitted_by UUID,
                                                                                                                                                                                                                                                                                                                               VERSION integer NOT NULL DEFAULT 1,
                                                                                                                                                                                                                                                                                                                                                                created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                                                                                                                                                                        updated_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                                                                                                                                                                                                                UNIQUE(workspace_id, id),
                                                                                                                                                                                                                                                                                                                                                                                                                                                UNIQUE(workspace_id, record_code),
                                                            FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id));


CREATE TABLE public.office_manufacturing_evidence(id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                                                                              workspace_id UUID NOT NULL,
                                                                                                evidence_code text NOT NULL,
                                                                                                                   target_type text NOT NULL CHECK(target_type IN('lot', 'production_order', 'maintenance_order', 'compliance_record')),
                                                                                                                                             target_id UUID NOT NULL,
                                                                                                                                                            file_id UUID,
                                                                                                                                                                    revision_id UUID,
                                                                                                                                                                                size_bytes bigint,sha256_hex text,external_url text,status text NOT NULL DEFAULT 'active' CHECK(status IN('active', 'superseded')),
                                                                                                                                                                                                                                                                          VERSION integer NOT NULL DEFAULT 1,
                                                                                                                                                                                                                                                                                                           created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                                                                                                                                                                                   UNIQUE(workspace_id, id),
                                                                                                                                                                                                                                                                                                                                                   UNIQUE(workspace_id, evidence_code),
                                                  FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id));


CREATE TABLE public.office_manufacturing_stock_counts(id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                                                                                  workspace_id UUID NOT NULL,
                                                                                                    lot_id UUID NOT NULL,
                                                                                                                location_id UUID NOT NULL,
                                                                                                                                 expected_quantity numeric(24, 6) NOT NULL,
                                                                                                                                                                  counted_quantity numeric(24, 6) NOT NULL,
                                                                                                                                                                                                  balance_version integer NOT NULL,
                                                                                                                                                                                                                          status text NOT NULL CHECK(status IN('submitted', 'approved', 'rejected')),
                                                                                                                                                                                                                                               reason text NOT NULL,
                                                                                                                                                                                                                                                           submitted_by UUID NOT NULL,
                                                                                                                                                                                                                                                                             reviewed_by UUID,
                                                                                                                                                                                                                                                                                         VERSION integer NOT NULL DEFAULT 1,
                                                                                                                                                                                                                                                                                                                          created_at timestamptz NOT NULL DEFAULT now(),
                                                      FOREIGN KEY(workspace_id, lot_id, location_id) REFERENCES public.office_manufacturing_stock_balances(workspace_id, lot_id, location_id));


CREATE TABLE public.office_manufacturing_requests(workspace_id UUID NOT NULL,
                                                                    idempotency_key UUID NOT NULL,
                                                                                         actor_id UUID NOT NULL,
                                                                                                       action text NOT NULL,
                                                                                                                   request_hash text NOT NULL,
                                                                                                                                     response JSONB NOT NULL,
                                                                                                                                                    created_at timestamptz NOT NULL DEFAULT now(),
                                                                                                                                                                                            PRIMARY KEY(workspace_id,
                                                                                                                                                                                                        idempotency_key));


CREATE TABLE public.office_manufacturing_audit(id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
                                                                           workspace_id UUID NOT NULL,
                                                                                             actor_user_id UUID,
                                                                                                           action text NOT NULL,
                                                                                                                       entity_type text NOT NULL,
                                                                                                                                        entity_id UUID,
                                                                                                                                                  payload_hash text NOT NULL,
                                                                                                                                                                    created_at timestamptz NOT NULL DEFAULT now());

-- Composite tenant keys protect every operational edge, including nullable references.

ALTER TABLE public.office_manufacturing_lots ADD UNIQUE(workspace_id, id, item_id);


ALTER TABLE public.office_manufacturing_lots ADD UNIQUE(workspace_id, source_order_id);


ALTER TABLE public.office_manufacturing_lots ADD
FOREIGN KEY(workspace_id, source_order_id) REFERENCES public.office_manufacturing_production_orders(workspace_id, id);


ALTER TABLE public.office_manufacturing_lots ADD CHECK(expiry_date IS NULL
                                                       OR expiry_date >= received_date);


ALTER TABLE public.office_manufacturing_production_orders ADD
FOREIGN KEY(workspace_id, output_lot_id, product_id) REFERENCES public.office_manufacturing_lots(workspace_id, id, item_id);


ALTER TABLE public.office_manufacturing_production_orders ADD
FOREIGN KEY(started_by) REFERENCES auth.users(id) ON
DELETE
SET NULL;


ALTER TABLE public.office_manufacturing_production_orders ADD COLUMN downtime_minutes integer NOT NULL DEFAULT 0 CHECK(downtime_minutes>=0);


ALTER TABLE public.office_manufacturing_production_orders ADD COLUMN production_reason text NOT NULL DEFAULT '';


ALTER TABLE public.office_manufacturing_production_orders ADD COLUMN bom_snapshot JSONB NOT NULL DEFAULT '[]'::JSONB;


ALTER TABLE public.office_manufacturing_production_orders ADD CHECK(output_quantity>=0
                                                                    AND scrap_quantity>=0
                                                                    AND labour_cost>=0
                                                                    AND overhead_cost>=0
                                                                    AND material_cost>=0
                                                                    AND total_cost>=0);


ALTER TABLE public.office_manufacturing_stock_balances ADD UNIQUE(workspace_id, id);


ALTER TABLE public.office_manufacturing_stock_balances ADD
FOREIGN KEY(workspace_id, lot_id, item_id) REFERENCES public.office_manufacturing_lots(workspace_id, id, item_id);


ALTER TABLE public.office_manufacturing_stock_balances ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();


ALTER TABLE public.office_manufacturing_stock_balances ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();


ALTER TABLE public.office_manufacturing_stock_movements ADD
FOREIGN KEY(workspace_id, from_location_id) REFERENCES public.office_manufacturing_locations(workspace_id, id);


ALTER TABLE public.office_manufacturing_stock_movements ADD
FOREIGN KEY(workspace_id, to_location_id) REFERENCES public.office_manufacturing_locations(workspace_id, id);


ALTER TABLE public.office_manufacturing_stock_movements ADD
FOREIGN KEY(workspace_id, order_id) REFERENCES public.office_manufacturing_production_orders(workspace_id, id);


ALTER TABLE public.office_manufacturing_stock_movements ADD
FOREIGN KEY(workspace_id, maintenance_id) REFERENCES public.office_manufacturing_maintenance_orders(workspace_id, id);


ALTER TABLE public.office_manufacturing_stock_movements ADD COLUMN customer_reference text;


ALTER TABLE public.office_manufacturing_stock_movements ADD COLUMN waste_reference text;


ALTER TABLE public.office_manufacturing_stock_movements ADD CHECK(unit_cost>=0);


ALTER TABLE public.office_manufacturing_order_requirements ADD UNIQUE(workspace_id, order_id, item_id);


ALTER TABLE public.office_manufacturing_order_requirements ADD CHECK(required_quantity>0
                                                                     AND allocated_quantity>=0
                                                                     AND issued_quantity>=0
                                                                     AND returned_quantity>=0
                                                                     AND returned_quantity<=issued_quantity);


ALTER TABLE public.office_manufacturing_order_requirements ADD COLUMN VERSION integer NOT NULL DEFAULT 1 CHECK(VERSION>0);


ALTER TABLE public.office_manufacturing_allocations ADD UNIQUE(workspace_id, id);


ALTER TABLE public.office_manufacturing_allocations ADD
FOREIGN KEY(workspace_id, lot_id, item_id) REFERENCES public.office_manufacturing_lots(workspace_id, id, item_id);


ALTER TABLE public.office_manufacturing_allocations ADD CHECK(quantity>0
                                                              AND returned_quantity>=0
                                                              AND returned_quantity<=quantity);


ALTER TABLE public.office_manufacturing_allocations ADD COLUMN issued_at timestamptz;


ALTER TABLE public.office_manufacturing_allocations ADD CHECK(status<>'issued'
                                                              OR issued_at IS NOT NULL);


ALTER TABLE public.office_manufacturing_allocations ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();


ALTER TABLE public.office_manufacturing_allocations ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();


ALTER TABLE public.office_manufacturing_maintenance_orders ADD COLUMN verified_by UUID REFERENCES auth.users(id) ON
DELETE
SET NULL;


ALTER TABLE public.office_manufacturing_maintenance_orders ADD CHECK(parts_cost>=0);


ALTER TABLE public.office_manufacturing_maintenance_parts ADD UNIQUE(workspace_id, id);


ALTER TABLE public.office_manufacturing_maintenance_parts ADD CHECK(quantity>0
                                                                    AND returned_quantity>=0
                                                                    AND returned_quantity<=quantity
                                                                    AND unit_cost>=0);


ALTER TABLE public.office_manufacturing_maintenance_parts ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();


ALTER TABLE public.office_manufacturing_stock_counts ADD UNIQUE(workspace_id, id);


ALTER TABLE public.office_manufacturing_stock_counts ADD COLUMN review_reason text;


ALTER TABLE public.office_manufacturing_stock_counts ADD CHECK(expected_quantity>=0
                                                               AND counted_quantity>=0
                                                               AND balance_version>0);


ALTER TABLE public.office_manufacturing_stock_counts ADD
FOREIGN KEY(submitted_by) REFERENCES auth.users(id);


ALTER TABLE public.office_manufacturing_stock_counts ADD
FOREIGN KEY(reviewed_by) REFERENCES auth.users(id);


ALTER TABLE public.office_manufacturing_evidence ADD
FOREIGN KEY(file_id, workspace_id) REFERENCES public.office_cloud_files(file_id, workspace_id) ON
DELETE RESTRICT;


ALTER TABLE public.office_manufacturing_evidence ADD
FOREIGN KEY(revision_id, workspace_id, file_id) REFERENCES public.office_cloud_revisions(revision_id, workspace_id, file_id) ON
DELETE RESTRICT;


ALTER TABLE public.office_manufacturing_evidence ADD CHECK((external_url IS NOT NULL
                                                            AND file_id IS NULL
                                                            AND revision_id IS NULL)
                                                           OR (external_url IS NULL
                                                               AND file_id IS NOT NULL
                                                               AND revision_id IS NOT NULL
                                                               AND size_bytes>0
                                                               AND sha256_hex ~ '^[a-f0-9]{64}$'));


ALTER TABLE public.office_manufacturing_requests ADD
FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON
DELETE CASCADE;


ALTER TABLE public.office_manufacturing_audit ADD
FOREIGN KEY(workspace_id) REFERENCES public.office_workspaces(id) ON
DELETE CASCADE;


CREATE UNIQUE INDEX office_manufacturing_bom_active ON public.office_manufacturing_boms(workspace_id, product_id, kind)
WHERE status='active';


CREATE INDEX office_manufacturing_orders_status ON public.office_manufacturing_production_orders(workspace_id, status, due_date);


CREATE INDEX office_manufacturing_lots_item ON public.office_manufacturing_lots(workspace_id, item_id, status);


CREATE INDEX office_manufacturing_allocations_order ON public.office_manufacturing_allocations(workspace_id, order_id, status);


CREATE INDEX office_manufacturing_allocations_lot ON public.office_manufacturing_allocations(workspace_id, lot_id, status);


CREATE INDEX office_manufacturing_movements_date ON public.office_manufacturing_stock_movements(workspace_id, created_at);


ALTER TABLE public.office_manufacturing_evidence ADD COLUMN supersede_reason text;


ALTER TABLE public.office_manufacturing_evidence ADD COLUMN superseded_by UUID;


ALTER TABLE public.office_manufacturing_evidence ADD COLUMN superseded_at timestamptz;


CREATE INDEX office_manufacturing_evidence_target ON public.office_manufacturing_evidence(workspace_id, target_type, target_id);


CREATE INDEX office_manufacturing_audit_date ON public.office_manufacturing_audit(workspace_id, created_at);

-- Only these module-owned tables are touched by the RLS/ACL loop.
DO $mfg_tables$
DECLARE t record;
BEGIN
 FOR t IN SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname='public' AND tablename LIKE 'office_manufacturing_%' LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t.tablename);
  EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',t.tablename);
 END LOOP;
END $mfg_tables$;

-- Manufacturing source: 10-helpers.sql
CREATE OR REPLACE FUNCTION office_private.manufacturing_role(p_workspace_id uuid)
RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $mfg$
DECLARE v_role text;
BEGIN
 IF auth.uid() IS NULL OR NOT office_private.is_active_member(p_workspace_id)
    OR NOT EXISTS(SELECT 1 FROM public.office_industry_spaces s WHERE s.workspace_id=p_workspace_id AND s.industry_id='manufacturing') THEN
  RAISE EXCEPTION 'Active Manufacturing Office Team membership is required' USING ERRCODE='42501';
 END IF;
 IF office_private.is_admin(p_workspace_id) THEN RETURN 'manufacturing_admin'; END IF;
 SELECT r.manufacturing_role INTO v_role FROM public.office_manufacturing_staff_roles r
 WHERE r.workspace_id=p_workspace_id AND r.user_id=auth.uid() AND r.active;
 RETURN coalesce(v_role,'unassigned');
END $mfg$;

CREATE OR REPLACE FUNCTION office_private.manufacturing_can(p_workspace_id uuid,p_cap text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $mfg$
 SELECT CASE office_private.manufacturing_role(p_workspace_id)
 WHEN 'manufacturing_admin' THEN true
 WHEN 'production_planner' THEN p_cap IN('masters','planning','evidence','reports','private_records')
 WHEN 'storekeeper' THEN p_cap IN('inventory_receive','inventory_move','stock_count','evidence','reports','private_records')
 WHEN 'production_operator' THEN p_cap IN('production','evidence','reports')
 WHEN 'quality_reviewer' THEN p_cap IN('quality','stock_approve','evidence','reports')
 WHEN 'maintenance_engineer' THEN p_cap IN('maintenance','evidence','reports')
 WHEN 'safety_officer' THEN p_cap IN('compliance','evidence','reports')
 WHEN 'manufacturing_viewer' THEN p_cap='reports'
 ELSE false END
$mfg$;

CREATE OR REPLACE FUNCTION office_private.mfg_text(p jsonb,k text,required boolean DEFAULT true,max_length integer DEFAULT 4000)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $mfg$
DECLARE v text;
BEGIN
 IF NOT (p ? k) OR p->k='null'::jsonb THEN
  IF required THEN RAISE EXCEPTION 'Required field: %',k USING ERRCODE='22023'; END IF;
  RETURN NULL;
 END IF;
 IF jsonb_typeof(p->k)<>'string' THEN RAISE EXCEPTION 'Text field required: %',k USING ERRCODE='22023'; END IF;
 v:=btrim(p->>k);
 IF (required AND v='') OR char_length(v)>max_length OR v ~ '[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]' THEN
  RAISE EXCEPTION 'Invalid or overlong field: %',k USING ERRCODE='22023';
 END IF;
 RETURN nullif(v,'');
END $mfg$;

CREATE OR REPLACE FUNCTION office_private.mfg_decimal(p text,p_nonnegative boolean DEFAULT true)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $mfg$
DECLARE v numeric;
BEGIN
 IF p IS NULL OR char_length(p)>28 OR p !~ '^-?(0|[1-9][0-9]{0,17})(\.[0-9]{1,6})?$' THEN
  RAISE EXCEPTION 'A plain exact decimal with at most six decimal places is required' USING ERRCODE='22023';
 END IF;
 v:=p::numeric;
 IF abs(v)>=1000000000000000000 OR (p_nonnegative AND v<0) THEN
  RAISE EXCEPTION 'Manufacturing quantity/cost is outside the supported range' USING ERRCODE='22003';
 END IF;
 RETURN v;
END $mfg$;

CREATE OR REPLACE FUNCTION office_private.mfg_qty(p jsonb,k text,positive boolean DEFAULT false)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $mfg$
DECLARE v numeric;
BEGIN
 IF jsonb_typeof(p->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Exact decimal string required: %',k USING ERRCODE='22023'; END IF;
 v:=office_private.mfg_decimal(p->>k);
 IF positive AND v<=0 THEN RAISE EXCEPTION 'Positive quantity required: %',k USING ERRCODE='22023'; END IF;
 RETURN v;
END $mfg$;

CREATE OR REPLACE FUNCTION office_private.mfg_date(p jsonb,k text,required boolean DEFAULT true)
RETURNS date LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $mfg$
DECLARE v text; d date;
BEGIN
 v:=office_private.mfg_text(p,k,required,10);
 IF v IS NULL THEN RETURN NULL; END IF;
 IF v !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN RAISE EXCEPTION 'ISO date required: %',k USING ERRCODE='22007'; END IF;
 d:=v::date;
 IF to_char(d,'YYYY-MM-DD')<>v THEN RAISE EXCEPTION 'Invalid calendar date: %',k USING ERRCODE='22007'; END IF;
 RETURN d;
END $mfg$;

CREATE OR REPLACE FUNCTION office_private.mfg_version(p jsonb,k text,actual integer)
RETURNS void LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $mfg$
BEGIN
 IF actual IS NULL THEN RAISE EXCEPTION 'Manufacturing record not found in this workspace' USING ERRCODE='P0002'; END IF;
 IF jsonb_typeof(p->k) IS DISTINCT FROM 'number' OR (p->>k) !~ '^[1-9][0-9]*$'
    OR (p->>k)::numeric>2147483647 OR (p->>k)::numeric<>actual THEN
  RAISE EXCEPTION 'Record version changed. Refresh before retrying: %',k USING ERRCODE='40001';
 END IF;
END $mfg$;

CREATE OR REPLACE FUNCTION office_private.mfg_today()
RETURNS date LANGUAGE sql STABLE SET search_path='' AS $mfg$
 SELECT (now() AT TIME ZONE 'Africa/Dar_es_Salaam')::date
$mfg$;

CREATE OR REPLACE FUNCTION office_private.mfg_exact_json(p jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $mfg$
DECLARE k text; v jsonb; result jsonb:=p;
BEGIN
 FOR k,v IN SELECT key,value FROM jsonb_each(p) LOOP
  IF jsonb_typeof(v)='number' AND k=ANY(ARRAY[
   'quantity','reorder_point','output_quantity','target_quantity','scrap_quantity','unit_cost',
   'on_hand','reserved','available','expected_quantity','counted_quantity',
   'required_quantity','allocated_quantity','issued_quantity','returned_quantity',
   'labour_cost','overhead_cost','material_cost','total_cost','parts_cost','value_tzs'
  ]) THEN
   IF k=ANY(ARRAY['labour_cost','overhead_cost','material_cost','total_cost','parts_cost','value_tzs']) THEN
    result:=jsonb_set(result,ARRAY[k],to_jsonb(round((v#>>'{}')::numeric,2)::text));
   ELSE
    result:=jsonb_set(result,ARRAY[k],to_jsonb(((v#>>'{}')::numeric(48,6))::text));
   END IF;
  END IF;
 END LOOP;
 RETURN result;
END $mfg$;

CREATE OR REPLACE FUNCTION office_private.mfg_descendant_lots(p_workspace_id uuid,p_lot_id uuid)
RETURNS TABLE(lot_id uuid) LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $mfg$
 WITH RECURSIVE descendants(lot_id) AS (
  SELECT l.id FROM public.office_manufacturing_lots l WHERE l.workspace_id=p_workspace_id AND l.id=p_lot_id
  UNION
  SELECT o.output_lot_id FROM descendants d
  JOIN public.office_manufacturing_allocations a ON a.workspace_id=p_workspace_id AND a.lot_id=d.lot_id AND a.status='issued' AND a.quantity>a.returned_quantity
  JOIN public.office_manufacturing_production_orders o ON o.workspace_id=a.workspace_id AND o.id=a.order_id
  WHERE o.output_lot_id IS NOT NULL
 ) SELECT d.lot_id FROM descendants d
$mfg$;

CREATE OR REPLACE FUNCTION office_private.mfg_require_asset(p_workspace_id uuid,p_asset_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $mfg$
DECLARE s text;
BEGIN
 IF p_asset_id IS NULL THEN RETURN; END IF;
 SELECT a.status INTO s FROM public.office_manufacturing_assets a WHERE a.workspace_id=p_workspace_id AND a.id=p_asset_id FOR UPDATE;
 IF s IS DISTINCT FROM 'operational' OR EXISTS(
  SELECT 1 FROM public.office_manufacturing_maintenance_orders m WHERE m.workspace_id=p_workspace_id AND m.asset_id=p_asset_id AND m.priority='critical' AND m.status NOT IN('verified','cancelled')
 ) THEN RAISE EXCEPTION 'The selected equipment is unavailable or awaiting critical maintenance verification' USING ERRCODE='55000'; END IF;
END $mfg$;

-- Manufacturing source: 20-inventory-bom.sql
CREATE OR REPLACE FUNCTION office_private.mfg_inventory_command(p_workspace_id uuid,p_action text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE
 v_role text; v_cap text; v_uid uuid:=auth.uid(); v_id uuid; v2 uuid; v_item uuid; v_lot uuid; v_loc uuid; v_dest uuid; v_bom uuid; v_line uuid;
 v_ver integer; v_parent integer; v_expected integer; v_qty numeric; v_cost numeric; v_count numeric; v_diff numeric; v_reserved numeric; v_on numeric; v_avail numeric;
 v_date date; v_exp date; v_status text; v_kind text; v_product uuid; v_bom_kind text; v_result jsonb; v_hash text; v_old jsonb; v_ref text; v_reason text;
 v_item_kind text; v_loc_status text; v_supplier_status text; v_lot_status text; v_decision text; v_submitter uuid;
BEGIN
 IF v_uid IS NULL THEN RAISE EXCEPTION 'Manufacturing authentication required' USING ERRCODE='42501'; END IF;
 -- This domain handler is intentionally restricted to the assigned action set.
 IF p_action NOT IN ('save_bom','save_bom_line','delete_bom_line','activate_bom','retire_bom','receive_stock','transfer_stock','dispatch_stock','scrap_stock','submit_stock_count','review_stock_count') THEN
   RAISE EXCEPTION 'Unknown Manufacturing inventory action: %',p_action USING ERRCODE='22023';
 END IF;
 v_role:=office_private.manufacturing_role(p_workspace_id);
 v_cap:=CASE WHEN p_action IN('save_bom','save_bom_line','delete_bom_line','activate_bom','retire_bom') THEN 'masters'
             WHEN p_action='receive_stock' THEN 'inventory_receive'
             WHEN p_action IN('transfer_stock','dispatch_stock','scrap_stock') THEN 'inventory_move'
             WHEN p_action='submit_stock_count' THEN 'stock_count' ELSE 'stock_approve' END;
 IF NOT office_private.manufacturing_can(p_workspace_id,v_cap) THEN RAISE EXCEPTION 'Manufacturing capability required: %',v_cap USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR jsonb_typeof(p_payload->'idempotency_key') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'A valid idempotency_key is required' USING ERRCODE='22023'; END IF;
 v_hash:=encode(pg_catalog.sha256(convert_to(p_action||':'||p_payload::text,'UTF8')),'hex');

 IF p_action='save_bom' THEN
   v_bom:=NULLIF(office_private.mfg_text(p_payload,'id',false,80),'')::uuid;
   v_item:=office_private.mfg_text(p_payload,'product_id')::uuid; v_qty:=office_private.mfg_qty(p_payload,'output_quantity',true);
   v_kind:=office_private.mfg_text(p_payload,'kind'); IF v_kind NOT IN('standard','rework') THEN RAISE EXCEPTION 'Invalid BOM kind' USING ERRCODE='22023'; END IF;
   SELECT kind,status INTO v_item_kind,v_status FROM public.office_manufacturing_items WHERE workspace_id=p_workspace_id AND id=v_item FOR SHARE;
   IF v_item_kind IS NULL THEN RAISE EXCEPTION 'Product not found in this workspace' USING ERRCODE='P0002'; END IF;
   IF v_item_kind<>'finished_good' OR v_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'BOM product must be a finished_good' USING ERRCODE='22023'; END IF;
   IF v_bom IS NULL THEN
     INSERT INTO public.office_manufacturing_boms(workspace_id,bom_code,revision,kind,product_id,output_quantity,status) VALUES(p_workspace_id,office_private.mfg_text(p_payload,'bom_code'),office_private.mfg_text(p_payload,'revision'),v_kind,v_item,v_qty,'draft') RETURNING id,version INTO v_bom,v_ver;
   ELSE
     SELECT version,status INTO v_ver,v_status FROM public.office_manufacturing_boms WHERE workspace_id=p_workspace_id AND id=v_bom FOR UPDATE;
     PERFORM office_private.mfg_version(p_payload,'expected_version',v_ver);
     IF v_status IS NULL THEN RAISE EXCEPTION 'BOM not found in this workspace' USING ERRCODE='P0002'; END IF;
     IF v_status<>'draft' THEN RAISE EXCEPTION 'Only draft BOMs are editable' USING ERRCODE='55000'; END IF;
     UPDATE public.office_manufacturing_boms SET bom_code=office_private.mfg_text(p_payload,'bom_code'),revision=office_private.mfg_text(p_payload,'revision'),kind=v_kind,product_id=v_item,output_quantity=v_qty,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v_bom RETURNING version INTO v_ver;
   END IF;
   v_result:=jsonb_build_object('id',v_bom,'version',v_ver,'status',CASE WHEN v_bom IS NOT NULL AND EXISTS(SELECT 1 FROM public.office_manufacturing_boms WHERE workspace_id=p_workspace_id AND id=v_bom AND status='draft') THEN 'draft' ELSE v_status END);

 ELSIF p_action IN('save_bom_line','delete_bom_line') THEN
   IF p_action='save_bom_line' THEN
     v_bom:=office_private.mfg_text(p_payload,'bom_id')::uuid; v_item:=office_private.mfg_text(p_payload,'item_id')::uuid; v_qty:=office_private.mfg_qty(p_payload,'quantity',true);
     SELECT b.version,b.status,b.kind,b.product_id INTO v_parent,v_status,v_bom_kind,v_product FROM public.office_manufacturing_boms b WHERE b.workspace_id=p_workspace_id AND b.id=v_bom FOR UPDATE;
     IF v_status IS NULL THEN RAISE EXCEPTION 'BOM not found in this workspace' USING ERRCODE='P0002'; END IF;
     PERFORM office_private.mfg_version(p_payload,'expected_parent_version',v_parent); IF v_status<>'draft' THEN RAISE EXCEPTION 'Only draft BOMs are editable' USING ERRCODE='55000'; END IF;
     SELECT kind,status INTO v_item_kind,v_status FROM public.office_manufacturing_items WHERE workspace_id=p_workspace_id AND id=v_item FOR SHARE;
     IF v_item_kind IS NULL OR v_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'BOM component must be an active item in this workspace' USING ERRCODE='22023'; END IF;
     IF v_bom_kind='standard' AND v_item=v_product THEN RAISE EXCEPTION 'Standard BOM cannot consume its own finished good' USING ERRCODE='22023'; END IF;
     v_line:=NULLIF(office_private.mfg_text(p_payload,'id',false,80),'')::uuid;
     IF v_line IS NULL THEN
       INSERT INTO public.office_manufacturing_bom_lines(workspace_id,bom_id,item_id,quantity) VALUES(p_workspace_id,v_bom,v_item,v_qty) RETURNING id,version INTO v_line,v_ver;
     ELSE
       SELECT version,bom_id INTO v_ver,v2 FROM public.office_manufacturing_bom_lines WHERE workspace_id=p_workspace_id AND id=v_line FOR UPDATE;
       IF v2 IS NULL OR v2<>v_bom THEN RAISE EXCEPTION 'BOM line not found in this workspace' USING ERRCODE='P0002'; END IF;
       PERFORM office_private.mfg_version(p_payload,'expected_version',v_ver);
       UPDATE public.office_manufacturing_bom_lines SET item_id=v_item,quantity=v_qty,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v_line RETURNING version INTO v_ver;
     END IF;
     UPDATE public.office_manufacturing_boms SET version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v_bom RETURNING version INTO v_parent;
     v_result:=jsonb_build_object('id',v_line,'version',v_ver,'parent_version',v_parent);
   ELSE
     v_line:=office_private.mfg_text(p_payload,'id')::uuid;
     SELECT version,bom_id INTO v_ver,v_bom FROM public.office_manufacturing_bom_lines WHERE workspace_id=p_workspace_id AND id=v_line FOR UPDATE;
     IF v_bom IS NULL THEN RAISE EXCEPTION 'BOM line not found in this workspace' USING ERRCODE='P0002'; END IF;
     PERFORM office_private.mfg_version(p_payload,'expected_version',v_ver);
     SELECT version,status INTO v_parent,v_status FROM public.office_manufacturing_boms WHERE workspace_id=p_workspace_id AND id=v_bom FOR UPDATE;
     PERFORM office_private.mfg_version(p_payload,'expected_parent_version',v_parent); IF v_status<>'draft' THEN RAISE EXCEPTION 'Only draft BOMs are editable' USING ERRCODE='55000'; END IF;
     DELETE FROM public.office_manufacturing_bom_lines WHERE workspace_id=p_workspace_id AND id=v_line;
     UPDATE public.office_manufacturing_boms SET version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v_bom RETURNING version INTO v_parent;
     v_result:=jsonb_build_object('id',v_line,'version',v_ver,'parent_version',v_parent);
   END IF;

 ELSIF p_action IN('activate_bom','retire_bom') THEN
   v_bom:=office_private.mfg_text(p_payload,'id')::uuid; SELECT version,status,product_id,kind INTO v_ver,v_status,v_product,v_bom_kind FROM public.office_manufacturing_boms WHERE workspace_id=p_workspace_id AND id=v_bom FOR UPDATE;
   IF v_status IS NULL THEN RAISE EXCEPTION 'BOM not found in this workspace' USING ERRCODE='P0002'; END IF; PERFORM office_private.mfg_version(p_payload,'expected_version',v_ver);
   IF p_action='retire_bom' THEN
     IF v_status<>'active' THEN RAISE EXCEPTION 'Only active BOMs can be retired' USING ERRCODE='55000'; END IF;
     UPDATE public.office_manufacturing_boms SET status='retired',version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v_bom RETURNING version INTO v_ver;
   ELSE
     IF v_status<>'draft' THEN RAISE EXCEPTION 'Only draft BOMs can be activated' USING ERRCODE='55000'; END IF;
     IF NOT EXISTS(SELECT 1 FROM public.office_manufacturing_bom_lines l WHERE l.workspace_id=p_workspace_id AND l.bom_id=v_bom) OR EXISTS(SELECT 1 FROM public.office_manufacturing_bom_lines l JOIN public.office_manufacturing_items i ON i.workspace_id=l.workspace_id AND i.id=l.item_id WHERE l.workspace_id=p_workspace_id AND l.bom_id=v_bom AND i.status<>'active') OR NOT EXISTS(SELECT 1 FROM public.office_manufacturing_items i WHERE i.workspace_id=p_workspace_id AND i.id=v_product AND i.status='active') THEN RAISE EXCEPTION 'An active BOM requires at least one active component' USING ERRCODE='22023'; END IF;
     IF v_bom_kind='standard' AND EXISTS(SELECT 1 FROM public.office_manufacturing_bom_lines WHERE workspace_id=p_workspace_id AND bom_id=v_bom AND item_id=v_product) THEN RAISE EXCEPTION 'Standard BOM cannot consume its own product' USING ERRCODE='22023'; END IF;
     WITH retired AS (UPDATE public.office_manufacturing_boms SET status='retired',version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND product_id=v_product AND kind=v_bom_kind AND status='active' AND id<>v_bom RETURNING id)
     INSERT INTO public.office_manufacturing_audit(workspace_id,actor_user_id,action,entity_type,entity_id,payload_hash) SELECT p_workspace_id,v_uid,'retire_bom_superseded','bom',id,v_hash FROM retired;
     UPDATE public.office_manufacturing_boms SET status='active',version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v_bom RETURNING version INTO v_ver;
   END IF;
   v_result:=jsonb_build_object('id',v_bom,'version',v_ver,'status',CASE WHEN p_action='retire_bom' THEN 'retired' ELSE 'active' END);

 ELSIF p_action='receive_stock' THEN
   v_item:=office_private.mfg_text(p_payload,'item_id')::uuid; v_loc:=office_private.mfg_text(p_payload,'location_id')::uuid; v_qty:=office_private.mfg_qty(p_payload,'quantity',true); v_cost:=office_private.mfg_qty(p_payload,'unit_cost',false); v_date:=office_private.mfg_date(p_payload,'received_date'); v_exp:=office_private.mfg_date(p_payload,'expiry_date',false);
   IF v_date>office_private.mfg_today() THEN RAISE EXCEPTION 'A physical receipt cannot be dated in the future' USING ERRCODE='22007'; END IF;
   IF v_exp IS NOT NULL AND v_exp<v_date THEN RAISE EXCEPTION 'Expiry must be on or after received date' USING ERRCODE='22007'; END IF;
   SELECT status INTO v_status FROM public.office_manufacturing_items WHERE workspace_id=p_workspace_id AND id=v_item; IF v_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'Item is not active in this workspace' USING ERRCODE='22023'; END IF;
   SELECT status INTO v_loc_status FROM public.office_manufacturing_locations WHERE workspace_id=p_workspace_id AND id=v_loc; IF v_loc_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'Location is not active in this workspace' USING ERRCODE='22023'; END IF;
   IF p_payload ? 'supplier_id' AND p_payload->>'supplier_id' IS NOT NULL THEN SELECT status INTO v_supplier_status FROM public.office_manufacturing_suppliers WHERE workspace_id=p_workspace_id AND id=(p_payload->>'supplier_id')::uuid; IF v_supplier_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'Supplier is not active in this workspace' USING ERRCODE='22023'; END IF; END IF;
   INSERT INTO public.office_manufacturing_lots(workspace_id,item_id,batch_code,supplier_id,supplier_lot,received_date,expiry_date,status,unit_cost) VALUES(p_workspace_id,v_item,office_private.mfg_text(p_payload,'batch_code'),NULLIF(p_payload->>'supplier_id','')::uuid,office_private.mfg_text(p_payload,'supplier_lot',false),v_date,v_exp,'quarantine',v_cost) RETURNING id,version INTO v_lot,v_ver;
   INSERT INTO public.office_manufacturing_stock_balances(workspace_id,lot_id,item_id,location_id,on_hand,reserved) VALUES(p_workspace_id,v_lot,v_item,v_loc,v_qty,0) RETURNING id,version INTO v2,v_expected;
   INSERT INTO public.office_manufacturing_stock_movements(workspace_id,kind,lot_id,to_location_id,quantity,unit_cost,reference,reason,created_by) VALUES(p_workspace_id,'receipt',v_lot,v_loc,v_qty,v_cost,office_private.mfg_text(p_payload,'reference'),'warehouse receipt',v_uid);
   v_result:=jsonb_build_object('id',v_lot,'version',v_ver,'lot_id',v_lot,'balance_id',v2,'balance_version',v_expected,'quantity',v_qty::text);

 ELSIF p_action IN('transfer_stock','dispatch_stock','scrap_stock') THEN
   v_lot:=office_private.mfg_text(p_payload,'lot_id')::uuid; v_loc:=office_private.mfg_text(p_payload,'location_id',p_action<>'transfer_stock')::uuid; IF p_action='transfer_stock' THEN v_loc:=office_private.mfg_text(p_payload,'from_location_id')::uuid; v_dest:=office_private.mfg_text(p_payload,'to_location_id')::uuid; IF v_loc=v_dest THEN RAISE EXCEPTION 'Transfer locations must differ' USING ERRCODE='22023'; END IF; END IF;
   v_qty:=office_private.mfg_qty(p_payload,'quantity',true); v_expected:=(p_payload->>'expected_balance_version')::integer;
   SELECT l.status,l.expiry_date,l.unit_cost INTO v_lot_status,v_exp,v_cost FROM public.office_manufacturing_lots l WHERE l.workspace_id=p_workspace_id AND l.id=v_lot FOR UPDATE;
   IF v_lot_status IS NULL THEN RAISE EXCEPTION 'Lot not found in this workspace' USING ERRCODE='P0002'; END IF; IF v_lot_status='rejected' AND p_action='transfer_stock' THEN RAISE EXCEPTION 'Rejected stock may only be explicitly scrapped, not transferred' USING ERRCODE='55000'; END IF;
   IF p_action IN('dispatch_stock','scrap_stock') AND (v_lot_status<>'released' AND p_action='dispatch_stock') THEN RAISE EXCEPTION 'Only released stock may be dispatched' USING ERRCODE='55000'; END IF;
   IF p_action='dispatch_stock' AND v_exp IS NOT NULL AND v_exp<office_private.mfg_today() THEN RAISE EXCEPTION 'Expired stock cannot be dispatched' USING ERRCODE='55000'; END IF;
   SELECT b.id,b.on_hand,b.reserved,b.version INTO v2,v_on,v_reserved,v_ver FROM public.office_manufacturing_stock_balances b WHERE b.workspace_id=p_workspace_id AND b.lot_id=v_lot AND b.location_id=v_loc FOR UPDATE;
   IF v2 IS NULL THEN RAISE EXCEPTION 'Stock balance not found in this workspace' USING ERRCODE='P0002'; END IF; PERFORM office_private.mfg_version(p_payload,'expected_balance_version',v_ver); v_avail:=v_on-v_reserved; IF v_qty>v_avail THEN RAISE EXCEPTION 'Insufficient available stock' USING ERRCODE='22003'; END IF;
   UPDATE public.office_manufacturing_stock_balances SET on_hand=on_hand-v_qty,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=v2 RETURNING version INTO v_ver;
   IF p_action='transfer_stock' THEN
     SELECT status INTO v_loc_status FROM public.office_manufacturing_locations WHERE workspace_id=p_workspace_id AND id=v_dest FOR SHARE; IF v_loc_status IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'Destination location is not active' USING ERRCODE='22023'; END IF;
     INSERT INTO public.office_manufacturing_stock_balances(workspace_id,lot_id,item_id,location_id,on_hand,reserved) SELECT p_workspace_id,v_lot,item_id,v_dest,v_qty,0 FROM public.office_manufacturing_lots WHERE workspace_id=p_workspace_id AND id=v_lot ON CONFLICT(workspace_id,lot_id,location_id) DO UPDATE SET on_hand=public.office_manufacturing_stock_balances.on_hand+excluded.on_hand,version=public.office_manufacturing_stock_balances.version+1,updated_at=now();
   END IF;
   v_ref:=CASE WHEN p_action='scrap_stock' THEN coalesce(office_private.mfg_text(p_payload,'waste_reference',false,160),'SCRAP-'||pg_catalog.gen_random_uuid()::text) ELSE office_private.mfg_text(p_payload,'reference',true,160) END;
   INSERT INTO public.office_manufacturing_stock_movements(workspace_id,kind,lot_id,from_location_id,to_location_id,quantity,unit_cost,reference,reason,created_by,customer_reference,waste_reference)
   VALUES(p_workspace_id,CASE p_action WHEN 'transfer_stock' THEN 'transfer' WHEN 'dispatch_stock' THEN 'dispatch' ELSE 'scrap' END,v_lot,v_loc,CASE WHEN p_action='transfer_stock' THEN v_dest ELSE NULL END,v_qty,v_cost,v_ref,
    office_private.mfg_text(p_payload,CASE WHEN p_action='scrap_stock' THEN 'reason' ELSE 'reference' END),v_uid,
    CASE WHEN p_action='dispatch_stock' THEN office_private.mfg_text(p_payload,'customer_reference',true,160) ELSE NULL END,
    CASE WHEN p_action='scrap_stock' THEN office_private.mfg_text(p_payload,'waste_reference',false,160) ELSE NULL END);
   v_result:=jsonb_build_object('id',v2,'version',v_ver,'quantity',v_qty::text,'balance_version',v_ver);

 ELSIF p_action='submit_stock_count' THEN
   v_lot:=office_private.mfg_text(p_payload,'lot_id')::uuid; v_loc:=office_private.mfg_text(p_payload,'location_id')::uuid; v_count:=office_private.mfg_qty(p_payload,'counted_quantity',false); v_expected:=(p_payload->>'expected_balance_version')::integer;
   SELECT id,on_hand,reserved,version INTO v2,v_on,v_reserved,v_ver FROM public.office_manufacturing_stock_balances WHERE workspace_id=p_workspace_id AND lot_id=v_lot AND location_id=v_loc FOR UPDATE; IF v2 IS NULL THEN RAISE EXCEPTION 'Stock balance not found in this workspace' USING ERRCODE='P0002'; END IF; PERFORM office_private.mfg_version(p_payload,'expected_balance_version',v_ver);
   INSERT INTO public.office_manufacturing_stock_counts(workspace_id,lot_id,location_id,expected_quantity,counted_quantity,balance_version,status,reason,submitted_by) VALUES(p_workspace_id,v_lot,v_loc,v_on,v_count,v_ver,'submitted',office_private.mfg_text(p_payload,'reason'),v_uid) RETURNING id,version INTO v_id,v_ver;
   v_result:=jsonb_build_object('id',v_id,'version',v_ver,'expected_quantity',v_on::text,'counted_quantity',v_count::text,'status','submitted');

 ELSIF p_action='review_stock_count' THEN
   v_id:=office_private.mfg_text(p_payload,'id')::uuid; v_decision:=office_private.mfg_text(p_payload,'decision'); IF v_decision NOT IN('approve','reject') THEN RAISE EXCEPTION 'Invalid count decision' USING ERRCODE='22023'; END IF;
   SELECT version,status,lot_id,location_id,balance_version,counted_quantity,submitted_by INTO v_ver,v_status,v_lot,v_loc,v_expected,v_count,v_submitter FROM public.office_manufacturing_stock_counts WHERE workspace_id=p_workspace_id AND id=v_id FOR UPDATE;
   IF v_status IS NULL THEN RAISE EXCEPTION 'Stock count not found in this workspace' USING ERRCODE='P0002'; END IF; PERFORM office_private.mfg_version(p_payload,'expected_version',v_ver); IF v_status<>'submitted' THEN RAISE EXCEPTION 'Stock count is already reviewed' USING ERRCODE='55000'; END IF; IF v_submitter=v_uid THEN RAISE EXCEPTION 'Stock count requires an independent reviewer' USING ERRCODE='42501'; END IF;
   IF v_decision='approve' THEN
     SELECT on_hand,reserved,version INTO v_on,v_reserved,v_ver FROM public.office_manufacturing_stock_balances WHERE workspace_id=p_workspace_id AND lot_id=v_lot AND location_id=v_loc FOR UPDATE; IF v_ver<>v_expected THEN RAISE EXCEPTION 'Stock balance changed since count snapshot' USING ERRCODE='40001'; END IF; IF v_count<v_reserved THEN RAISE EXCEPTION 'Counted quantity cannot be below reserved quantity' USING ERRCODE='22023'; END IF; v_diff:=v_count-v_on;
     IF v_diff<>0 THEN INSERT INTO public.office_manufacturing_stock_movements(workspace_id,kind,lot_id,from_location_id,to_location_id,quantity,unit_cost,reference,reason,created_by) SELECT p_workspace_id,'count_adjustment',v_lot,CASE WHEN v_diff<0 THEN v_loc ELSE NULL END,CASE WHEN v_diff>0 THEN v_loc ELSE NULL END,abs(v_diff),l.unit_cost,'COUNT-'||v_id::text,office_private.mfg_text(p_payload,'reason'),v_uid FROM public.office_manufacturing_lots l WHERE l.workspace_id=p_workspace_id AND l.id=v_lot; END IF;
     UPDATE public.office_manufacturing_stock_balances SET on_hand=v_count,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND lot_id=v_lot AND location_id=v_loc;
   END IF;
   UPDATE public.office_manufacturing_stock_counts SET status=CASE WHEN v_decision='approve' THEN 'approved' ELSE 'rejected' END,reviewed_by=v_uid,version=version+1,review_reason=office_private.mfg_text(p_payload,'reason') WHERE workspace_id=p_workspace_id AND id=v_id RETURNING version INTO v_ver;
   v_result:=jsonb_build_object('id',v_id,'version',v_ver,'status',CASE WHEN v_decision='approve' THEN 'approved' ELSE 'rejected' END);
 END IF;
 RETURN v_result;
END $fn$;

-- Manufacturing source: 30-production.sql
CREATE OR REPLACE FUNCTION office_private.mfg_production_command(p_workspace_id uuid,p_action text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $mfg$
DECLARE
 r text; v integer; pv integer; id uuid; q numeric; q2 numeric; target numeric; due date;
 oid uuid; stockid uuid; bid uuid; item uuid; lotid uuid; locid uuid; asset uuid; product uuid; outloc uuid;
 st text; kind text; bomout numeric; req numeric; alloc numeric; issued numeric; net numeric;
 o public.office_manufacturing_production_orders%rowtype;
 a public.office_manufacturing_allocations%rowtype;
 b public.office_manufacturing_stock_balances%rowtype;
 l public.office_manufacturing_lots%rowtype;
 line record; rr record; result jsonb; d date; good numeric; scrap numeric; labour numeric; overhead numeric; mat numeric; total numeric; unit numeric; batch text; reason text; mins integer;
BEGIN
 r:=office_private.manufacturing_role(p_workspace_id);
 IF p_action IN('save_production_order','allocate_material','remove_allocation','release_production_order','cancel_production_order') THEN
  IF NOT office_private.manufacturing_can(p_workspace_id,'planning') THEN RAISE EXCEPTION 'Planning access required' USING ERRCODE='42501'; END IF;
 ELSE
  IF NOT office_private.manufacturing_can(p_workspace_id,'production') THEN RAISE EXCEPTION 'Production access required' USING ERRCODE='42501'; END IF;
 END IF;
 IF p_action NOT IN ('save_production_order','allocate_material','remove_allocation','release_production_order','start_production_order','pause_production_order','resume_production_order','return_production_material','record_production_output','cancel_production_order') THEN RAISE EXCEPTION 'Unknown production action' USING ERRCODE='22023'; END IF;
 IF p_action='save_production_order' THEN
  IF jsonb_typeof(p_payload->'target_quantity') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'Exact decimal string required: target_quantity' USING ERRCODE='22023'; END IF;
  target:=office_private.mfg_qty(p_payload,'target_quantity',true); due:=office_private.mfg_date(p_payload,'due_date'); bid:=(office_private.mfg_text(p_payload,'bom_id'))::uuid; outloc:=(office_private.mfg_text(p_payload,'output_location_id'))::uuid; asset:=NULLIF(office_private.mfg_text(p_payload,'asset_id',false),'')::uuid;
  SELECT * INTO line FROM public.office_manufacturing_boms x WHERE x.workspace_id=p_workspace_id AND x.id=bid FOR UPDATE;
  IF NOT FOUND OR line.status<>'active' THEN RAISE EXCEPTION 'Active BOM required' USING ERRCODE='55000'; END IF;
  SELECT * INTO rr FROM public.office_manufacturing_items x WHERE x.workspace_id=p_workspace_id AND x.id=line.product_id AND x.kind='finished_good' AND x.status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active finished product required' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.office_manufacturing_locations x WHERE x.workspace_id=p_workspace_id AND x.id=outloc AND x.status='active') THEN RAISE EXCEPTION 'Active output location required' USING ERRCODE='55000'; END IF;
  IF asset IS NOT NULL THEN PERFORM office_private.mfg_require_asset(p_workspace_id,asset); END IF;
  id:=NULLIF(office_private.mfg_text(p_payload,'id',false),'')::uuid;
  IF id IS NULL THEN
   INSERT INTO public.office_manufacturing_production_orders(workspace_id,order_code,bom_id,product_id,bom_kind,target_quantity,due_date,asset_id,output_location_id,status) VALUES(p_workspace_id,office_private.mfg_text(p_payload,'order_code'),bid,line.product_id,line.kind,target,due,asset,outloc,'planned') RETURNING * INTO o;
   FOR line IN SELECT bl.item_id,ceil((bl.quantity*target/line.output_quantity)*1000000)/1000000 AS rq FROM public.office_manufacturing_bom_lines bl WHERE bl.workspace_id=p_workspace_id AND bl.bom_id=bid ORDER BY bl.item_id LOOP
    INSERT INTO public.office_manufacturing_order_requirements(workspace_id,order_id,item_id,required_quantity) VALUES(p_workspace_id,o.id,line.item_id,line.rq);
   END LOOP;
  ELSE
   SELECT * INTO o FROM public.office_manufacturing_production_orders x WHERE x.workspace_id=p_workspace_id AND x.id=(p_payload->>'id')::uuid FOR UPDATE;
   PERFORM office_private.mfg_version(p_payload,'expected_version',o.version);
   IF o.status<>'planned' THEN RAISE EXCEPTION 'Only planned orders are editable' USING ERRCODE='55000'; END IF;
   IF EXISTS(SELECT 1 FROM public.office_manufacturing_allocations x WHERE x.workspace_id=p_workspace_id AND x.order_id=o.id AND x.status='reserved') THEN RAISE EXCEPTION 'Remove allocations before changing a planned order' USING ERRCODE='55000'; END IF;
   UPDATE public.office_manufacturing_production_orders AS po SET order_code=office_private.mfg_text(p_payload,'order_code'),bom_id=bid,product_id=line.product_id,bom_kind=line.kind,target_quantity=target,due_date=due,asset_id=asset,output_location_id=outloc,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=o.id RETURNING * INTO o;
   DELETE FROM public.office_manufacturing_order_requirements WHERE workspace_id=p_workspace_id AND order_id=o.id;
   FOR line IN SELECT bl.item_id,ceil((bl.quantity*target/line.output_quantity)*1000000)/1000000 AS rq FROM public.office_manufacturing_bom_lines bl WHERE bl.workspace_id=p_workspace_id AND bl.bom_id=bid ORDER BY bl.item_id LOOP INSERT INTO public.office_manufacturing_order_requirements(workspace_id,order_id,item_id,required_quantity) VALUES(p_workspace_id,o.id,line.item_id,line.rq); END LOOP;
  END IF;
  RETURN jsonb_build_object('id',o.id,'version',o.version,'status',o.status,'target_quantity',o.target_quantity::text);
 ELSIF p_action='allocate_material' THEN
  oid:=office_private.mfg_text(p_payload,'order_id')::uuid; PERFORM office_private.mfg_qty(p_payload,'quantity',true); q:=office_private.mfg_qty(p_payload,'quantity',true); locid:=office_private.mfg_text(p_payload,'location_id')::uuid; lotid:=office_private.mfg_text(p_payload,'lot_id')::uuid;
  SELECT * INTO o FROM public.office_manufacturing_production_orders x WHERE x.workspace_id=p_workspace_id AND x.id=oid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_parent_version',o.version);
  IF o.status<>'planned' THEN RAISE EXCEPTION 'Only planned orders accept allocations' USING ERRCODE='55000'; END IF;
  SELECT bl.item_id INTO item FROM public.office_manufacturing_bom_lines bl WHERE bl.workspace_id=p_workspace_id AND bl.bom_id=o.bom_id AND bl.item_id=(SELECT z.item_id FROM public.office_manufacturing_lots z WHERE z.workspace_id=p_workspace_id AND z.id=lotid);
  IF item IS NULL THEN RAISE EXCEPTION 'Lot item is not a BOM component' USING ERRCODE='23503'; END IF;
  SELECT * INTO l FROM public.office_manufacturing_lots z WHERE z.workspace_id=p_workspace_id AND z.id=lotid FOR UPDATE;
  IF NOT FOUND OR l.expiry_date IS NOT NULL AND l.expiry_date<office_private.mfg_today() OR (l.status<>'released' AND NOT(o.bom_kind='rework' AND l.status='rework' AND l.item_id=o.product_id)) THEN RAISE EXCEPTION 'Lot is not eligible for production allocation' USING ERRCODE='55000'; END IF;
  SELECT * INTO b FROM public.office_manufacturing_stock_balances z WHERE z.workspace_id=p_workspace_id AND z.lot_id=lotid AND z.location_id=locid FOR UPDATE;
  IF NOT FOUND OR b.item_id<>item OR b.on_hand-b.reserved<q THEN RAISE EXCEPTION 'Insufficient available stock' USING ERRCODE='40001'; END IF;
  SELECT required_quantity-allocated_quantity INTO req FROM public.office_manufacturing_order_requirements z WHERE z.workspace_id=p_workspace_id AND z.order_id=o.id AND z.item_id=item FOR UPDATE;
  IF req IS NULL OR q>req THEN RAISE EXCEPTION 'Allocation exceeds component requirement' USING ERRCODE='22003'; END IF;
  UPDATE public.office_manufacturing_stock_balances AS sb SET reserved=reserved+q,version=version+1 WHERE sb.id=b.id;
  INSERT INTO public.office_manufacturing_allocations(workspace_id,order_id,item_id,lot_id,location_id,quantity,status) VALUES(p_workspace_id,o.id,item,lotid,locid,q,'reserved') RETURNING * INTO a;
  UPDATE public.office_manufacturing_order_requirements SET allocated_quantity=allocated_quantity+q WHERE workspace_id=p_workspace_id AND order_id=o.id AND item_id=item;
  UPDATE public.office_manufacturing_production_orders AS po SET version=version+1,updated_at=now() WHERE po.id=o.id RETURNING version INTO pv;
  RETURN jsonb_build_object('id',a.id,'version',a.version,'parent_version',pv,'quantity',q::text);
 ELSIF p_action='remove_allocation' THEN
  id:=office_private.mfg_text(p_payload,'id')::uuid; SELECT * INTO a FROM public.office_manufacturing_allocations x WHERE x.workspace_id=p_workspace_id AND x.id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',a.version);
  SELECT * INTO o FROM public.office_manufacturing_production_orders x WHERE x.workspace_id=p_workspace_id AND x.id=a.order_id FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_parent_version',o.version);
  IF o.status<>'planned' OR a.status<>'reserved' THEN RAISE EXCEPTION 'Only reserved planned allocations can be removed' USING ERRCODE='55000'; END IF;
  SELECT * INTO b FROM public.office_manufacturing_stock_balances x WHERE x.workspace_id=p_workspace_id AND x.lot_id=a.lot_id AND x.location_id=a.location_id FOR UPDATE;
  UPDATE public.office_manufacturing_stock_balances AS sb SET reserved=reserved-a.quantity,version=version+1 WHERE sb.id=b.id;
  UPDATE public.office_manufacturing_order_requirements SET allocated_quantity=allocated_quantity-a.quantity WHERE workspace_id=p_workspace_id AND order_id=o.id AND item_id=a.item_id;
  UPDATE public.office_manufacturing_allocations AS al SET status='released',version=version+1 WHERE al.id=a.id RETURNING version INTO v;
  UPDATE public.office_manufacturing_production_orders AS po SET version=version+1,updated_at=now() WHERE po.id=o.id RETURNING version INTO pv;
  RETURN jsonb_build_object('id',a.id,'version',v,'parent_version',pv);
 ELSIF p_action='release_production_order' THEN
  id:=office_private.mfg_text(p_payload,'id')::uuid; SELECT * INTO o FROM public.office_manufacturing_production_orders x WHERE x.workspace_id=p_workspace_id AND x.id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',o.version);
  IF o.status<>'planned' THEN RAISE EXCEPTION 'Only planned orders can be released' USING ERRCODE='55000'; END IF; IF o.asset_id IS NOT NULL THEN PERFORM office_private.mfg_require_asset(p_workspace_id,o.asset_id); END IF;
  IF EXISTS(SELECT 1 FROM public.office_manufacturing_order_requirements x WHERE x.workspace_id=p_workspace_id AND x.order_id=o.id AND x.allocated_quantity<>x.required_quantity) THEN RAISE EXCEPTION 'Exact component requirements must be fully reserved' USING ERRCODE='55000'; END IF;
  FOR a IN SELECT * FROM public.office_manufacturing_allocations x WHERE x.workspace_id=p_workspace_id AND x.order_id=o.id AND x.status='reserved' ORDER BY x.lot_id,x.location_id FOR UPDATE LOOP SELECT * INTO l FROM public.office_manufacturing_lots x WHERE x.workspace_id=p_workspace_id AND x.id=a.lot_id FOR UPDATE; IF l.expiry_date IS NOT NULL AND l.expiry_date<office_private.mfg_today() OR (l.status<>'released' AND NOT(o.bom_kind='rework' AND l.status='rework' AND l.item_id=o.product_id)) THEN RAISE EXCEPTION 'Reserved lot is no longer valid' USING ERRCODE='55000'; END IF; END LOOP;
  UPDATE public.office_manufacturing_production_orders AS po SET status='released',version=version+1,updated_at=now(),bom_id=o.bom_id WHERE po.id=o.id RETURNING version INTO v;
  RETURN jsonb_build_object('id',o.id,'version',v,'status','released','bom_snapshot',jsonb_build_object('bom_id',o.bom_id,'kind',o.bom_kind,'product_id',o.product_id,'target_quantity',o.target_quantity::text));
 ELSIF p_action='start_production_order' THEN
  id:=office_private.mfg_text(p_payload,'id')::uuid; SELECT * INTO o FROM public.office_manufacturing_production_orders x WHERE x.workspace_id=p_workspace_id AND x.id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',o.version); IF o.status<>'released' THEN RAISE EXCEPTION 'Only released orders can start' USING ERRCODE='55000'; END IF; IF o.asset_id IS NOT NULL THEN PERFORM office_private.mfg_require_asset(p_workspace_id,o.asset_id); END IF;
  FOR a IN SELECT * FROM public.office_manufacturing_allocations x WHERE x.workspace_id=p_workspace_id AND x.order_id=o.id AND x.status='reserved' ORDER BY x.lot_id,x.location_id FOR UPDATE LOOP SELECT * INTO b FROM public.office_manufacturing_stock_balances x WHERE x.workspace_id=p_workspace_id AND x.lot_id=a.lot_id AND x.location_id=a.location_id FOR UPDATE; SELECT * INTO l FROM public.office_manufacturing_lots x WHERE x.workspace_id=p_workspace_id AND x.id=a.lot_id FOR UPDATE; IF b.reserved<a.quantity OR l.status<>'released' AND NOT(o.bom_kind='rework' AND l.status='rework') OR l.expiry_date IS NOT NULL AND l.expiry_date<office_private.mfg_today() THEN RAISE EXCEPTION 'Input lot failed start validation' USING ERRCODE='55000'; END IF; UPDATE public.office_manufacturing_stock_balances AS sb SET on_hand=on_hand-a.quantity,reserved=reserved-a.quantity,version=version+1 WHERE sb.id=b.id; INSERT INTO public.office_manufacturing_stock_movements(workspace_id,kind,lot_id,from_location_id,quantity,unit_cost,reference,reason,order_id,created_by) VALUES(p_workspace_id,'issue',a.lot_id,a.location_id,a.quantity,l.unit_cost,o.order_code,'production issue',o.id,auth.uid()); UPDATE public.office_manufacturing_order_requirements SET issued_quantity=issued_quantity+a.quantity WHERE workspace_id=p_workspace_id AND order_id=o.id AND item_id=a.item_id; UPDATE public.office_manufacturing_allocations AS al SET status='issued',issued_at=now(),version=version+1,updated_at=now() WHERE al.id=a.id; END LOOP;
  UPDATE public.office_manufacturing_production_orders AS po SET status='in_progress',started_by=auth.uid(),version=version+1,updated_at=now() WHERE po.id=o.id RETURNING version INTO v; RETURN jsonb_build_object('id',o.id,'version',v,'status','in_progress');
 ELSIF p_action IN ('pause_production_order','resume_production_order') THEN
  id:=office_private.mfg_text(p_payload,'id')::uuid; SELECT * INTO o FROM public.office_manufacturing_production_orders x WHERE x.workspace_id=p_workspace_id AND x.id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',o.version);
  IF p_action='pause_production_order' THEN IF o.status<>'in_progress' THEN RAISE EXCEPTION 'Only in-progress orders can pause' USING ERRCODE='55000'; END IF; reason:=office_private.mfg_text(p_payload,'reason'); st:='paused'; ELSE IF o.status<>'paused' THEN RAISE EXCEPTION 'Only paused orders can resume' USING ERRCODE='55000'; END IF; IF o.asset_id IS NOT NULL THEN PERFORM office_private.mfg_require_asset(p_workspace_id,o.asset_id); END IF; st:='in_progress'; END IF;
  UPDATE public.office_manufacturing_production_orders AS po SET status=st,version=version+1,updated_at=now() WHERE po.id=o.id RETURNING version INTO v; RETURN jsonb_build_object('id',o.id,'version',v,'status',st);
 ELSIF p_action='return_production_material' THEN
  id:=office_private.mfg_text(p_payload,'id')::uuid; q:=office_private.mfg_qty(p_payload,'quantity',true); reason:=office_private.mfg_text(p_payload,'reason'); SELECT * INTO a FROM public.office_manufacturing_allocations x WHERE x.workspace_id=p_workspace_id AND x.id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',a.version); SELECT * INTO o FROM public.office_manufacturing_production_orders x WHERE x.workspace_id=p_workspace_id AND x.id=a.order_id FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_parent_version',o.version); IF o.status NOT IN('in_progress','paused') OR a.status<>'issued' OR o.output_quantity>0 THEN RAISE EXCEPTION 'Material returns are no longer permitted' USING ERRCODE='55000'; END IF; net:=a.quantity-a.returned_quantity; IF q>net THEN RAISE EXCEPTION 'Return exceeds net issued quantity' USING ERRCODE='22003'; END IF; SELECT * INTO b FROM public.office_manufacturing_stock_balances x WHERE x.workspace_id=p_workspace_id AND x.lot_id=a.lot_id AND x.location_id=a.location_id FOR UPDATE; SELECT * INTO l FROM public.office_manufacturing_lots x WHERE x.workspace_id=p_workspace_id AND x.id=a.lot_id; UPDATE public.office_manufacturing_stock_balances AS sb SET on_hand=on_hand+q,version=version+1 WHERE sb.id=b.id; INSERT INTO public.office_manufacturing_stock_movements(workspace_id,kind,lot_id,to_location_id,quantity,unit_cost,reference,reason,order_id,created_by) VALUES(p_workspace_id,'return',a.lot_id,a.location_id,q,l.unit_cost,o.order_code,reason,o.id,auth.uid()); UPDATE public.office_manufacturing_allocations AS al SET returned_quantity=returned_quantity+q,version=version+1 WHERE al.id=a.id RETURNING version INTO v; UPDATE public.office_manufacturing_order_requirements SET returned_quantity=returned_quantity+q WHERE workspace_id=p_workspace_id AND order_id=o.id AND item_id=a.item_id; UPDATE public.office_manufacturing_production_orders AS po SET version=version+1,updated_at=now() WHERE po.id=o.id RETURNING version INTO pv; RETURN jsonb_build_object('id',a.id,'version',v,'parent_version',pv,'quantity',q::text);
 ELSIF p_action='record_production_output' THEN
  id:=office_private.mfg_text(p_payload,'id')::uuid; good:=office_private.mfg_qty(p_payload,'output_quantity',true); scrap:=office_private.mfg_qty(p_payload,'scrap_quantity'); labour:=office_private.mfg_qty(p_payload,'labour_cost'); overhead:=office_private.mfg_qty(p_payload,'overhead_cost'); mins:=coalesce((p_payload->>'downtime_minutes')::integer,0); IF mins<0 THEN RAISE EXCEPTION 'Downtime cannot be negative' USING ERRCODE='22023'; END IF; batch:=office_private.mfg_text(p_payload,'batch_code'); d:=office_private.mfg_date(p_payload,'expiry_date',false); SELECT * INTO o FROM public.office_manufacturing_production_orders x WHERE x.workspace_id=p_workspace_id AND x.id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',o.version); IF o.status<>'in_progress' OR good+scrap>o.target_quantity THEN RAISE EXCEPTION 'Invalid production output state or quantity' USING ERRCODE='55000'; END IF; IF good+scrap<>o.target_quantity THEN PERFORM office_private.mfg_text(p_payload,'reason'); END IF;
  FOR rr IN SELECT item_id,required_quantity FROM public.office_manufacturing_order_requirements WHERE workspace_id=p_workspace_id AND order_id=o.id ORDER BY item_id LOOP SELECT coalesce(sum(x.quantity-x.returned_quantity),0) INTO issued FROM public.office_manufacturing_allocations AS x WHERE x.workspace_id=p_workspace_id AND x.order_id=o.id AND x.item_id=rr.item_id AND x.status='issued'; req:=ceil((rr.required_quantity*good/o.target_quantity)*1000000)/1000000; IF issued<req THEN RAISE EXCEPTION 'Net issued material is insufficient for actual output' USING ERRCODE='55000'; END IF; END LOOP;
  mat:=0; FOR rr IN SELECT x.quantity-x.returned_quantity AS nq,y.unit_cost FROM public.office_manufacturing_allocations AS x JOIN public.office_manufacturing_lots AS y ON y.workspace_id=x.workspace_id AND y.id=x.lot_id WHERE x.workspace_id=p_workspace_id AND x.order_id=o.id AND x.status='issued' LOOP mat:=mat+rr.nq*rr.unit_cost; END LOOP; total:=round(mat+labour+overhead,6); unit:=round(total/good,6);
  INSERT INTO public.office_manufacturing_lots(workspace_id,item_id,batch_code,received_date,expiry_date,status,unit_cost,source_order_id) VALUES(p_workspace_id,o.product_id,batch,office_private.mfg_today(),d,'quarantine',unit,o.id) RETURNING * INTO l; INSERT INTO public.office_manufacturing_stock_balances(workspace_id,lot_id,item_id,location_id,on_hand) VALUES(p_workspace_id,l.id,o.product_id,o.output_location_id,good) RETURNING office_manufacturing_stock_balances.id INTO stockid; INSERT INTO public.office_manufacturing_stock_movements(workspace_id,kind,lot_id,to_location_id,quantity,unit_cost,reference,reason,order_id,created_by) VALUES(p_workspace_id,'production_output',l.id,o.output_location_id,good,unit,o.order_code,'production output',o.id,auth.uid()); UPDATE public.office_manufacturing_production_orders AS po SET status='awaiting_quality',output_lot_id=l.id,output_quantity=good,scrap_quantity=scrap,labour_cost=labour,overhead_cost=overhead,material_cost=mat,total_cost=total,version=version+1,updated_at=now() WHERE po.id=o.id RETURNING version INTO v; RETURN jsonb_build_object('id',o.id,'version',v,'status','awaiting_quality','output_lot_id',l.id,'output_quantity',good::text,'scrap_quantity',scrap::text,'material_cost',mat::text,'total_cost',total::text,'unit_cost',unit::text);
 ELSIF p_action='cancel_production_order' THEN
  id:=office_private.mfg_text(p_payload,'id')::uuid; reason:=office_private.mfg_text(p_payload,'reason'); SELECT * INTO o FROM public.office_manufacturing_production_orders x WHERE x.workspace_id=p_workspace_id AND x.id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',o.version); IF o.status IN('awaiting_quality','quality_hold','completed','rejected','cancelled') THEN RAISE EXCEPTION 'Order cannot be cancelled after output' USING ERRCODE='55000'; END IF; FOR a IN SELECT * FROM public.office_manufacturing_allocations x WHERE x.workspace_id=p_workspace_id AND x.order_id=o.id AND x.status='reserved' FOR UPDATE LOOP SELECT * INTO b FROM public.office_manufacturing_stock_balances x WHERE x.workspace_id=p_workspace_id AND x.lot_id=a.lot_id AND x.location_id=a.location_id FOR UPDATE; UPDATE public.office_manufacturing_stock_balances AS sb SET reserved=reserved-a.quantity,version=version+1 WHERE sb.id=b.id; UPDATE public.office_manufacturing_allocations AS al SET status='released',version=version+1 WHERE al.id=a.id; END LOOP; UPDATE public.office_manufacturing_production_orders AS po SET status='cancelled',version=version+1,updated_at=now() WHERE po.id=o.id RETURNING version INTO v; RETURN jsonb_build_object('id',o.id,'version',v,'status','cancelled');
 END IF;
 RETURN NULL;
END $mfg$;

-- Manufacturing source: 40-operations.sql
-- Manufacturing quality, maintenance, compliance and evidence operations only.
CREATE OR REPLACE FUNCTION office_private.mfg_guard_evidence_file_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  IF NEW.current_revision_id IS DISTINCT FROM OLD.current_revision_id
     AND EXISTS (SELECT 1 FROM public.office_manufacturing_evidence e WHERE e.workspace_id=OLD.workspace_id AND e.file_id=OLD.file_id AND e.status='active') THEN
    RAISE EXCEPTION 'An active Manufacturing evidence pin cannot be replaced' USING ERRCODE='55000';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at AND NEW.deleted_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.office_manufacturing_evidence e WHERE e.workspace_id=OLD.workspace_id AND e.file_id=OLD.file_id AND e.status='active') THEN
    RAISE EXCEPTION 'A file with active Manufacturing evidence cannot be deleted' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS mfg_evidence_file_pin_guard ON public.office_cloud_files;
CREATE TRIGGER mfg_evidence_file_pin_guard BEFORE UPDATE OF current_revision_id,deleted_at ON public.office_cloud_files
FOR EACH ROW EXECUTE FUNCTION office_private.mfg_guard_evidence_file_update();

CREATE OR REPLACE FUNCTION office_private.mfg_guard_evidence_revision_update()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  IF (NEW.state IS DISTINCT FROM OLD.state OR NEW.verified_size_bytes IS DISTINCT FROM OLD.verified_size_bytes
      OR NEW.verified_sha256_hex IS DISTINCT FROM OLD.verified_sha256_hex OR NEW.object_key IS DISTINCT FROM OLD.object_key)
     AND EXISTS (SELECT 1 FROM public.office_manufacturing_evidence e WHERE e.workspace_id=OLD.workspace_id AND e.file_id=OLD.file_id AND e.revision_id=OLD.revision_id AND e.status='active') THEN
    RAISE EXCEPTION 'A pinned Manufacturing evidence revision is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS mfg_evidence_revision_pin_guard ON public.office_cloud_revisions;
CREATE TRIGGER mfg_evidence_revision_pin_guard BEFORE UPDATE OF state,verified_size_bytes,verified_sha256_hex,object_key ON public.office_cloud_revisions
FOR EACH ROW EXECUTE FUNCTION office_private.mfg_guard_evidence_revision_update();

CREATE OR REPLACE FUNCTION office_private.mfg_hold_recalled_lots(p_workspace_id uuid,p_lot_id uuid,p_reason text,p_include_root boolean DEFAULT true)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $recall$
DECLARE l public.office_manufacturing_lots%rowtype; affected integer:=0;
BEGIN
 FOR l IN SELECT x.* FROM public.office_manufacturing_lots x
 JOIN office_private.mfg_descendant_lots(p_workspace_id,p_lot_id) d ON d.lot_id=x.id
 WHERE x.workspace_id=p_workspace_id AND (p_include_root OR x.id<>p_lot_id) ORDER BY x.id FOR UPDATE OF x LOOP
  UPDATE public.office_manufacturing_lots x SET status='quarantine',version=x.version+1,updated_at=now() WHERE x.workspace_id=p_workspace_id AND x.id=l.id;
  UPDATE public.office_manufacturing_production_orders o SET status='quality_hold',version=o.version+1,updated_at=now() WHERE o.workspace_id=p_workspace_id AND o.output_lot_id=l.id AND o.status<>'cancelled';
  INSERT INTO public.office_manufacturing_inspections(workspace_id,lot_id,result,standard_reference,observations,created_by)
  VALUES(p_workspace_id,l.id,'hold','Internal batch recall',p_reason,auth.uid());
  affected:=affected+1;
 END LOOP;
 RETURN affected;
END $recall$;

CREATE OR REPLACE FUNCTION office_private.mfg_operations_command(p_workspace_id uuid,p_action text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE
  r text; v jsonb; idem uuid; ent uuid; ver integer; parentver integer;
  lot record; ord public.office_manufacturing_production_orders%rowtype; mo record; cp record; bal record; part record; ev record; rev record; fil record;
  q numeric; q2 numeric; d date; asset uuid; newstatus text; notes text; reason text; target text; k text;
  allowed text[]; n int; impacted uuid;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION 'Command payload must be an object' USING ERRCODE='22023'; END IF;
  r:=office_private.manufacturing_role(p_workspace_id);
  IF p_action NOT IN ('record_lot_inspection','hold_lot','save_maintenance_order','transition_maintenance_order','issue_maintenance_part','return_maintenance_part','save_compliance_record','transition_compliance_record','link_evidence','supersede_evidence') THEN
    RAISE EXCEPTION 'Unknown Manufacturing operations action' USING ERRCODE='22023';
  END IF;
  IF p_payload->>'idempotency_key' IS NULL OR p_payload->>'idempotency_key' !~ '^[0-9a-fA-F-]{36}$' THEN RAISE EXCEPTION 'A valid request key is required' USING ERRCODE='22023'; END IF;
  idem:=(p_payload->>'idempotency_key')::uuid;
  IF p_action='record_lot_inspection' THEN allowed:=ARRAY['lot_id','expected_version','result','standard_reference','observations','idempotency_key'];
  ELSIF p_action='hold_lot' THEN allowed:=ARRAY['lot_id','expected_version','reason','idempotency_key'];
  ELSIF p_action='save_maintenance_order' THEN allowed:=ARRAY['id','expected_version','work_code','asset_id','kind','priority','due_date','work_notes','permit_reference','idempotency_key'];
  ELSIF p_action='transition_maintenance_order' THEN allowed:=ARRAY['id','expected_version','status','notes','return_to_service','idempotency_key'];
  ELSIF p_action='issue_maintenance_part' THEN allowed:=ARRAY['maintenance_id','expected_parent_version','lot_id','location_id','quantity','expected_balance_version','idempotency_key'];
  ELSIF p_action='return_maintenance_part' THEN allowed:=ARRAY['id','expected_version','expected_parent_version','quantity','reason','idempotency_key'];
  ELSIF p_action='save_compliance_record' THEN allowed:=ARRAY['id','expected_version','record_code','record_type','authority','title','due_date','severity','external_reference','action_notes','idempotency_key'];
  ELSIF p_action='transition_compliance_record' THEN allowed:=ARRAY['id','expected_version','status','notes','idempotency_key'];
  ELSIF p_action='link_evidence' THEN allowed:=ARRAY['evidence_code','target_type','target_id','file_id','revision_id','external_url','idempotency_key'];
  ELSE allowed:=ARRAY['id','expected_version','reason','idempotency_key']; END IF;
  FOR k IN SELECT jsonb_object_keys(p_payload) LOOP IF NOT k=ANY(allowed) THEN RAISE EXCEPTION 'Unsupported field: %',k USING ERRCODE='22023'; END IF; END LOOP;

  IF p_action='record_lot_inspection' THEN
    IF NOT office_private.manufacturing_can(p_workspace_id,'quality') THEN RAISE EXCEPTION 'Quality access required' USING ERRCODE='42501'; END IF;
    SELECT * INTO lot FROM public.office_manufacturing_lots WHERE workspace_id=p_workspace_id AND id=(p_payload->>'lot_id')::uuid FOR UPDATE;
    PERFORM office_private.mfg_version(p_payload,'expected_version',lot.version);
    target:=office_private.mfg_text(p_payload,'result'); IF target NOT IN('pass','hold','reject','rework') THEN RAISE EXCEPTION 'Invalid inspection result' USING ERRCODE='22023'; END IF;
    notes:=office_private.mfg_text(p_payload,'observations'); PERFORM office_private.mfg_text(p_payload,'standard_reference');
    IF lot.status IN ('quarantine','released') AND target IN('hold','reject','rework') IS FALSE AND lot.source_order_id IS NULL THEN NULL; END IF;
    IF target='pass' AND lot.expiry_date IS NOT NULL AND lot.expiry_date<office_private.mfg_today() THEN RAISE EXCEPTION 'An expired batch cannot be released' USING ERRCODE='55000'; END IF;
    IF lot.source_order_id IS NOT NULL THEN
      SELECT * INTO ord FROM public.office_manufacturing_production_orders WHERE workspace_id=p_workspace_id AND id=lot.source_order_id FOR UPDATE;
      IF target='pass' AND ord.started_by=auth.uid() THEN RAISE EXCEPTION 'Independent inspection is required' USING ERRCODE='42501'; END IF;
      IF target='pass' AND EXISTS (
        SELECT 1 FROM public.office_manufacturing_allocations a JOIN public.office_manufacturing_lots il ON il.workspace_id=a.workspace_id AND il.id=a.lot_id
        WHERE a.workspace_id=p_workspace_id AND a.order_id=ord.id AND a.status='issued' AND a.quantity>a.returned_quantity
          AND (il.status IN('quarantine','rejected') OR (il.expiry_date IS NOT NULL AND il.expiry_date<(a.issued_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date))
      ) THEN RAISE EXCEPTION 'Consumed input remains held, rejected or expired' USING ERRCODE='55000'; END IF;
    END IF;
    INSERT INTO public.office_manufacturing_inspections(workspace_id,lot_id,result,standard_reference,observations,created_by) VALUES(p_workspace_id,lot.id,target,p_payload->>'standard_reference',notes,auth.uid());
    UPDATE public.office_manufacturing_lots SET status=CASE target WHEN 'pass' THEN 'released' WHEN 'hold' THEN 'quarantine' WHEN 'reject' THEN 'rejected' ELSE 'rework' END,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=lot.id RETURNING id,version INTO ent,ver;
    IF ord.id IS NOT NULL THEN UPDATE public.office_manufacturing_production_orders SET status=CASE target WHEN 'pass' THEN 'completed' WHEN 'hold' THEN 'quality_hold' ELSE 'rejected' END,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=ord.id; END IF;
    v:=jsonb_build_object('id',ent,'version',ver,'status',CASE target WHEN 'pass' THEN 'released' WHEN 'hold' THEN 'quarantine' WHEN 'reject' THEN 'rejected' ELSE 'rework' END);
    IF target<>'pass' THEN n:=office_private.mfg_hold_recalled_lots(p_workspace_id,lot.id,notes,false); v:=v||jsonb_build_object('downstream_held_count',n); END IF;
  ELSIF p_action='hold_lot' THEN
    IF NOT office_private.manufacturing_can(p_workspace_id,'quality') THEN RAISE EXCEPTION 'Quality access required' USING ERRCODE='42501'; END IF;
    SELECT version INTO ver FROM public.office_manufacturing_lots WHERE workspace_id=p_workspace_id AND id=(p_payload->>'lot_id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',ver); reason:=office_private.mfg_text(p_payload,'reason');
    n:=office_private.mfg_hold_recalled_lots(p_workspace_id,(p_payload->>'lot_id')::uuid,reason,true);
    SELECT id,version INTO ent,ver FROM public.office_manufacturing_lots WHERE workspace_id=p_workspace_id AND id=(p_payload->>'lot_id')::uuid;
    v:=jsonb_build_object('id',ent,'version',ver,'status','quarantine');
  ELSIF p_action='save_maintenance_order' THEN
    IF NOT office_private.manufacturing_can(p_workspace_id,'maintenance') THEN RAISE EXCEPTION 'Maintenance access required' USING ERRCODE='42501'; END IF;
    asset:=office_private.mfg_text(p_payload,'asset_id')::uuid; d:=office_private.mfg_date(p_payload,'due_date'); PERFORM office_private.mfg_text(p_payload,'work_code'); PERFORM office_private.mfg_text(p_payload,'kind'); PERFORM office_private.mfg_text(p_payload,'priority'); PERFORM office_private.mfg_text(p_payload,'work_notes');
    IF p_payload ? 'id' THEN SELECT * INTO mo FROM public.office_manufacturing_maintenance_orders WHERE workspace_id=p_workspace_id AND id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',mo.version); IF mo.status NOT IN('open','scheduled') THEN RAISE EXCEPTION 'Only open or scheduled maintenance orders are editable' USING ERRCODE='55000'; END IF;
      UPDATE public.office_manufacturing_maintenance_orders SET work_code=p_payload->>'work_code',asset_id=asset,kind=p_payload->>'kind',priority=p_payload->>'priority',due_date=d,work_notes=p_payload->>'work_notes',permit_reference=office_private.mfg_text(p_payload,'permit_reference',false),version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=mo.id RETURNING id,version INTO ent,ver;
    ELSE INSERT INTO public.office_manufacturing_maintenance_orders(workspace_id,work_code,asset_id,kind,priority,due_date,status,work_notes,permit_reference) VALUES(p_workspace_id,p_payload->>'work_code',asset,p_payload->>'kind',p_payload->>'priority',d,'open',p_payload->>'work_notes',office_private.mfg_text(p_payload,'permit_reference',false)) RETURNING id,version INTO ent,ver; END IF;
    IF p_payload->>'priority'='critical' THEN UPDATE public.office_manufacturing_assets SET status='maintenance',version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=asset AND status<>'out_of_service'; END IF;
    v:=jsonb_build_object('id',ent,'version',ver);
  ELSIF p_action='transition_maintenance_order' THEN
    IF NOT office_private.manufacturing_can(p_workspace_id,'maintenance') THEN RAISE EXCEPTION 'Maintenance access required' USING ERRCODE='42501'; END IF;
    SELECT * INTO mo FROM public.office_manufacturing_maintenance_orders WHERE workspace_id=p_workspace_id AND id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',mo.version); newstatus:=office_private.mfg_text(p_payload,'status'); notes:=office_private.mfg_text(p_payload,'notes');
    IF NOT ((mo.status='open' AND newstatus IN('scheduled','in_progress','cancelled')) OR (mo.status='scheduled' AND newstatus IN('in_progress','cancelled')) OR (mo.status='in_progress' AND newstatus IN('awaiting_parts','completed')) OR (mo.status='awaiting_parts' AND newstatus='in_progress') OR (mo.status='completed' AND newstatus IN('verified','in_progress')) ) THEN RAISE EXCEPTION 'Invalid maintenance state transition' USING ERRCODE='22023'; END IF;
    IF newstatus='completed' AND notes='' THEN RAISE EXCEPTION 'Completion notes are required' USING ERRCODE='22023'; END IF;
    IF newstatus='verified' THEN IF mo.completed_by IS NULL OR mo.completed_by=auth.uid() THEN RAISE EXCEPTION 'Independent verification is required' USING ERRCODE='42501'; END IF; END IF;
    UPDATE public.office_manufacturing_maintenance_orders SET status=newstatus,completion_notes=CASE WHEN newstatus='completed' THEN notes ELSE completion_notes END,completed_by=CASE WHEN newstatus='completed' THEN auth.uid() ELSE completed_by END,verified_by=CASE WHEN newstatus='verified' THEN auth.uid() ELSE verified_by END,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=mo.id RETURNING id,version INTO ent,ver;
    IF newstatus='verified' AND coalesce((p_payload->>'return_to_service')::boolean,false) THEN IF EXISTS(SELECT 1 FROM public.office_manufacturing_maintenance_orders x WHERE x.workspace_id=p_workspace_id AND x.asset_id=mo.asset_id AND x.priority='critical' AND x.status NOT IN('verified','cancelled')) THEN RAISE EXCEPTION 'Other critical maintenance remains unverified' USING ERRCODE='55000'; END IF; UPDATE public.office_manufacturing_assets SET status='operational',version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=mo.asset_id; END IF;
    v:=jsonb_build_object('id',ent,'version',ver,'status',newstatus);
  ELSIF p_action='issue_maintenance_part' THEN
    IF NOT office_private.manufacturing_can(p_workspace_id,'maintenance') THEN RAISE EXCEPTION 'Maintenance access required' USING ERRCODE='42501'; END IF;
    SELECT * INTO mo FROM public.office_manufacturing_maintenance_orders WHERE workspace_id=p_workspace_id AND id=(p_payload->>'maintenance_id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_parent_version',mo.version); IF mo.status NOT IN('open','scheduled','in_progress','awaiting_parts') THEN RAISE EXCEPTION 'Maintenance order is not active' USING ERRCODE='55000'; END IF;
    q:=office_private.mfg_qty(p_payload,'quantity',true); SELECT b.*,l.status AS lot_status,l.expiry_date,l.unit_cost AS lot_unit_cost INTO bal FROM public.office_manufacturing_stock_balances b JOIN public.office_manufacturing_lots l ON l.workspace_id=b.workspace_id AND l.id=b.lot_id WHERE b.workspace_id=p_workspace_id AND b.lot_id=(p_payload->>'lot_id')::uuid AND b.location_id=(p_payload->>'location_id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_balance_version',bal.version); IF bal.lot_status<>'released' OR (bal.expiry_date IS NOT NULL AND bal.expiry_date<office_private.mfg_today()) OR (bal.on_hand-bal.reserved)<q THEN RAISE EXCEPTION 'Part lot is unavailable, expired or insufficient' USING ERRCODE='55000'; END IF;
    IF NOT EXISTS(SELECT 1 FROM public.office_manufacturing_items i WHERE i.workspace_id=p_workspace_id AND i.id=bal.item_id AND i.kind IN('component','consumable') AND i.status='active') THEN RAISE EXCEPTION 'Maintenance issues require an active component or consumable item' USING ERRCODE='22023'; END IF;
    UPDATE public.office_manufacturing_stock_balances SET on_hand=on_hand-q,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=bal.id; INSERT INTO public.office_manufacturing_maintenance_parts(workspace_id,maintenance_id,lot_id,location_id,quantity,unit_cost) VALUES(p_workspace_id,mo.id,bal.lot_id,bal.location_id,q,bal.lot_unit_cost) RETURNING id,version INTO ent,ver; UPDATE public.office_manufacturing_maintenance_orders SET parts_cost=parts_cost+q*bal.lot_unit_cost,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=mo.id RETURNING version INTO parentver; INSERT INTO public.office_manufacturing_stock_movements(workspace_id,kind,lot_id,from_location_id,quantity,unit_cost,reference,reason,maintenance_id,created_by) VALUES(p_workspace_id,'maintenance_issue',bal.lot_id,bal.location_id,q,bal.lot_unit_cost,mo.work_code,'maintenance part',mo.id,auth.uid()); v:=jsonb_build_object('id',ent,'version',ver,'parent_version',parentver);
  ELSIF p_action='return_maintenance_part' THEN
    IF NOT office_private.manufacturing_can(p_workspace_id,'maintenance') THEN RAISE EXCEPTION 'Maintenance access required' USING ERRCODE='42501'; END IF;
    SELECT p.*,m.status AS maintenance_status,m.version AS parent_actual,m.work_code INTO part FROM public.office_manufacturing_maintenance_parts p JOIN public.office_manufacturing_maintenance_orders m ON m.workspace_id=p.workspace_id AND m.id=p.maintenance_id JOIN public.office_manufacturing_stock_balances b ON b.workspace_id=p.workspace_id AND b.lot_id=p.lot_id AND b.location_id=p.location_id WHERE p.workspace_id=p_workspace_id AND p.id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',part.version); PERFORM office_private.mfg_version(p_payload,'expected_parent_version',part.parent_actual); IF part.maintenance_status IN('verified','cancelled') THEN RAISE EXCEPTION 'Parts cannot be returned after verification or cancellation' USING ERRCODE='55000'; END IF; q:=office_private.mfg_qty(p_payload,'quantity',true); IF q>part.quantity-part.returned_quantity THEN RAISE EXCEPTION 'Return exceeds net issued quantity' USING ERRCODE='22023'; END IF;
    UPDATE public.office_manufacturing_maintenance_parts SET returned_quantity=returned_quantity+q,version=version+1 WHERE workspace_id=p_workspace_id AND id=part.id RETURNING version INTO ver; UPDATE public.office_manufacturing_maintenance_orders SET parts_cost=parts_cost-q*part.unit_cost,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=part.maintenance_id RETURNING version INTO parentver; UPDATE public.office_manufacturing_stock_balances SET on_hand=on_hand+q,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND lot_id=part.lot_id AND location_id=part.location_id; INSERT INTO public.office_manufacturing_stock_movements(workspace_id,kind,lot_id,to_location_id,quantity,unit_cost,reference,reason,maintenance_id,created_by) VALUES(p_workspace_id,'maintenance_return',part.lot_id,part.location_id,q,part.unit_cost,part.work_code,office_private.mfg_text(p_payload,'reason'),part.maintenance_id,auth.uid()); v:=jsonb_build_object('id',part.id,'version',ver,'parent_version',parentver);
  ELSIF p_action='save_compliance_record' THEN
    IF NOT office_private.manufacturing_can(p_workspace_id,'compliance') THEN RAISE EXCEPTION 'Compliance access required' USING ERRCODE='42501'; END IF;
    d:=office_private.mfg_date(p_payload,'due_date'); PERFORM office_private.mfg_text(p_payload,'record_code'); PERFORM office_private.mfg_text(p_payload,'record_type'); PERFORM office_private.mfg_text(p_payload,'authority'); PERFORM office_private.mfg_text(p_payload,'title'); PERFORM office_private.mfg_text(p_payload,'severity'); PERFORM office_private.mfg_text(p_payload,'action_notes');
    IF p_payload ? 'id' THEN SELECT * INTO cp FROM public.office_manufacturing_compliance_records WHERE workspace_id=p_workspace_id AND id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',cp.version); IF cp.status NOT IN('open','in_progress') THEN RAISE EXCEPTION 'Only open or in-progress compliance records are editable' USING ERRCODE='55000'; END IF; UPDATE public.office_manufacturing_compliance_records SET record_code=p_payload->>'record_code',record_type=p_payload->>'record_type',authority=p_payload->>'authority',title=p_payload->>'title',due_date=d,severity=p_payload->>'severity',external_reference=office_private.mfg_text(p_payload,'external_reference',false),action_notes=p_payload->>'action_notes',version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=cp.id RETURNING id,version INTO ent,ver;
    ELSE INSERT INTO public.office_manufacturing_compliance_records(workspace_id,record_code,record_type,authority,title,due_date,severity,external_reference,status,action_notes) VALUES(p_workspace_id,p_payload->>'record_code',p_payload->>'record_type',p_payload->>'authority',p_payload->>'title',d,p_payload->>'severity',office_private.mfg_text(p_payload,'external_reference',false),'open',p_payload->>'action_notes') RETURNING id,version INTO ent,ver; END IF; v:=jsonb_build_object('id',ent,'version',ver);
  ELSIF p_action='transition_compliance_record' THEN
    IF NOT office_private.manufacturing_can(p_workspace_id,'compliance') THEN RAISE EXCEPTION 'Compliance access required' USING ERRCODE='42501'; END IF;
    SELECT * INTO cp FROM public.office_manufacturing_compliance_records WHERE workspace_id=p_workspace_id AND id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',cp.version); newstatus:=office_private.mfg_text(p_payload,'status'); notes:=office_private.mfg_text(p_payload,'notes');
    IF newstatus='closed' THEN IF cp.status<>'pending_verification' THEN RAISE EXCEPTION 'Only pending verification records can close' USING ERRCODE='22023'; END IF; IF cp.submitted_by IS NULL OR cp.submitted_by=auth.uid() THEN RAISE EXCEPTION 'Independent compliance closure is required' USING ERRCODE='42501'; END IF; IF notes='' OR (cp.external_reference IS NULL AND NOT EXISTS(SELECT 1 FROM public.office_manufacturing_evidence e WHERE e.workspace_id=p_workspace_id AND e.target_type='compliance_record' AND e.target_id=cp.id AND e.status='active')) THEN RAISE EXCEPTION 'Resolution notes and official reference or active evidence are required' USING ERRCODE='22023'; END IF;
    ELSIF newstatus='pending_verification' THEN IF cp.status NOT IN('open','in_progress') THEN RAISE EXCEPTION 'Invalid compliance transition' USING ERRCODE='22023'; END IF;
    ELSIF newstatus='in_progress' THEN IF cp.status NOT IN('open','pending_verification','closed') THEN RAISE EXCEPTION 'Invalid compliance transition' USING ERRCODE='22023'; END IF; IF cp.status='closed' AND notes='' THEN RAISE EXCEPTION 'Reopen reason is required' USING ERRCODE='22023'; END IF;
    ELSE RAISE EXCEPTION 'Invalid compliance transition' USING ERRCODE='22023'; END IF;
    UPDATE public.office_manufacturing_compliance_records SET status=newstatus,resolution_notes=CASE WHEN newstatus='closed' OR cp.status='closed' THEN notes ELSE resolution_notes END,submitted_by=CASE WHEN newstatus='pending_verification' THEN auth.uid() ELSE submitted_by END,version=version+1,updated_at=now() WHERE workspace_id=p_workspace_id AND id=cp.id RETURNING id,version INTO ent,ver; v:=jsonb_build_object('id',ent,'version',ver,'status',newstatus);
  ELSIF p_action='link_evidence' THEN
    IF NOT office_private.manufacturing_can(p_workspace_id,'evidence') THEN RAISE EXCEPTION 'Evidence access required' USING ERRCODE='42501'; END IF;
    IF office_private.mfg_text(p_payload,'evidence_code',true,64) !~ '^[A-Za-z0-9_-]{1,64}$' THEN RAISE EXCEPTION 'Evidence requires a non-personal reference code using letters, numbers, dash or underscore' USING ERRCODE='22023'; END IF;
    target:=office_private.mfg_text(p_payload,'target_type'); IF target NOT IN('lot','production_order','maintenance_order','compliance_record') THEN RAISE EXCEPTION 'Invalid evidence target' USING ERRCODE='22023'; END IF;
    IF NOT EXISTS (SELECT 1 FROM public.office_manufacturing_lots WHERE workspace_id=p_workspace_id AND id=(p_payload->>'target_id')::uuid) AND target='lot' THEN RAISE EXCEPTION 'Evidence target is not in this workspace' USING ERRCODE='42501'; END IF;
    IF target='production_order' AND NOT EXISTS(SELECT 1 FROM public.office_manufacturing_production_orders WHERE workspace_id=p_workspace_id AND id=(p_payload->>'target_id')::uuid) THEN RAISE EXCEPTION 'Evidence target is not in this workspace' USING ERRCODE='42501'; END IF;
    IF target='maintenance_order' AND NOT EXISTS(SELECT 1 FROM public.office_manufacturing_maintenance_orders WHERE workspace_id=p_workspace_id AND id=(p_payload->>'target_id')::uuid) THEN RAISE EXCEPTION 'Evidence target is not in this workspace' USING ERRCODE='42501'; END IF;
    IF target='compliance_record' AND NOT EXISTS(SELECT 1 FROM public.office_manufacturing_compliance_records WHERE workspace_id=p_workspace_id AND id=(p_payload->>'target_id')::uuid) THEN RAISE EXCEPTION 'Evidence target is not in this workspace' USING ERRCODE='42501'; END IF;
    IF p_payload ? 'external_url' AND p_payload->>'external_url' IS NOT NULL THEN IF office_private.mfg_text(p_payload,'external_url',true,2048) !~ '^https://[^[:space:]/?#@]+([/?#][^[:space:]]*)?$' OR position(chr(92) in p_payload->>'external_url')>0 OR position('?' in p_payload->>'external_url')>0 OR position('#' in p_payload->>'external_url')>0 THEN RAISE EXCEPTION 'Only credential-free HTTPS evidence links are allowed' USING ERRCODE='22023'; END IF; INSERT INTO public.office_manufacturing_evidence(workspace_id,evidence_code,target_type,target_id,external_url) VALUES(p_workspace_id,p_payload->>'evidence_code',target,(p_payload->>'target_id')::uuid,p_payload->>'external_url') RETURNING id,version INTO ent,ver;
    ELSE IF NOT (p_payload ? 'file_id' AND p_payload ? 'revision_id') THEN RAISE EXCEPTION 'A finalized file revision or HTTPS URL is required' USING ERRCODE='22023'; END IF; SELECT * INTO fil FROM public.office_cloud_files WHERE workspace_id=p_workspace_id AND file_id=(p_payload->>'file_id')::uuid AND deleted_at IS NULL FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'Evidence file is not available in this workspace' USING ERRCODE='42501'; END IF; IF fil.created_by<>auth.uid() AND NOT office_private.manufacturing_can(p_workspace_id,'settings') THEN RAISE EXCEPTION 'Only the uploader or a Manufacturing administrator can pin this file' USING ERRCODE='42501'; END IF; SELECT * INTO rev FROM public.office_cloud_revisions WHERE workspace_id=p_workspace_id AND file_id=fil.file_id AND revision_id=(p_payload->>'revision_id')::uuid AND state='available' FOR UPDATE; IF NOT FOUND OR fil.current_revision_id IS DISTINCT FROM rev.revision_id THEN RAISE EXCEPTION 'Evidence requires the finalized current cloud revision' USING ERRCODE='55000'; END IF; IF fil.display_name<>(p_payload->>'evidence_code')||'.cocce' THEN RAISE EXCEPTION 'Encrypted evidence file name must be derived from evidence code' USING ERRCODE='22023'; END IF; INSERT INTO public.office_manufacturing_evidence(workspace_id,evidence_code,target_type,target_id,file_id,revision_id,size_bytes,sha256_hex) VALUES(p_workspace_id,p_payload->>'evidence_code',target,(p_payload->>'target_id')::uuid,fil.file_id,rev.revision_id,rev.verified_size_bytes,rev.verified_sha256_hex) RETURNING id,version INTO ent,ver; END IF; v:=jsonb_build_object('id',ent,'version',ver);
  ELSE
    IF NOT office_private.manufacturing_can(p_workspace_id,'evidence') THEN RAISE EXCEPTION 'Evidence access required' USING ERRCODE='42501'; END IF;
    SELECT * INTO ev FROM public.office_manufacturing_evidence WHERE workspace_id=p_workspace_id AND id=(p_payload->>'id')::uuid FOR UPDATE; PERFORM office_private.mfg_version(p_payload,'expected_version',ev.version); IF ev.status<>'active' THEN RAISE EXCEPTION 'Only active evidence can be superseded' USING ERRCODE='55000'; END IF; reason:=office_private.mfg_text(p_payload,'reason'); UPDATE public.office_manufacturing_evidence SET status='superseded',version=version+1,supersede_reason=reason,superseded_by=auth.uid(),superseded_at=now() WHERE workspace_id=p_workspace_id AND id=ev.id RETURNING id,version INTO ent,ver; v:=jsonb_build_object('id',ent,'version',ver,'status','superseded');
  END IF;
  RETURN v;
END $fn$;
REVOKE ALL ON FUNCTION office_private.mfg_operations_command(uuid,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Manufacturing source: 50-core.sql
CREATE OR REPLACE FUNCTION office_private.mfg_envelope_field(p jsonb,k text,min_bytes integer,max_bytes integer)
RETURNS bytea LANGUAGE plpgsql IMMUTABLE SET search_path='' AS $mfg$
DECLARE v text; b bytea;
BEGIN
 v:=office_private.mfg_text(p,k,true,45000);
 IF v !~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' THEN
  RAISE EXCEPTION 'A canonical encrypted envelope is required: %',k USING ERRCODE='22023';
 END IF;
 b:=decode(v,'base64');
 IF octet_length(b)<min_bytes OR octet_length(b)>max_bytes OR replace(encode(b,'base64'),E'\n','')<>v THEN
  RAISE EXCEPTION 'Invalid encrypted envelope size or encoding: %',k USING ERRCODE='22023';
 END IF;
 RETURN b;
END $mfg$;

CREATE OR REPLACE FUNCTION office_private.mfg_core_command(p_workspace_id uuid,p_action text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $mfg$
DECLARE
 p jsonb:=p_payload;
 i public.office_manufacturing_items%rowtype;
 s public.office_manufacturing_suppliers%rowtype;
 l public.office_manufacturing_locations%rowtype;
 a public.office_manufacturing_assets%rowtype;
 settings public.office_manufacturing_settings%rowtype;
 staff public.office_manufacturing_staff_roles%rowtype;
 secret public.office_manufacturing_supplier_private%rowtype;
 v_id uuid; v_user uuid; v_role text; v_member_role text; v_active boolean;
 v_nonce bytea; v_ciphertext bytea; v_salt bytea; v_expected integer; v_in_use boolean;
BEGIN
 IF p_action IN('save_item','save_supplier','save_location','save_asset') AND NOT(p ? 'id') AND p ? 'expected_version' THEN
  RAISE EXCEPTION 'New master records must not supply an update version' USING ERRCODE='40001';
 END IF;
 CASE p_action
 WHEN 'save_settings' THEN
  PERFORM 1 FROM public.office_workspaces w WHERE w.id=p_workspace_id FOR UPDATE;
  SELECT * INTO settings FROM public.office_manufacturing_settings x WHERE x.workspace_id=p_workspace_id FOR UPDATE;
  IF FOUND THEN
   PERFORM office_private.mfg_version(p,'expected_version',settings.version);
   IF p ? 'id' AND (p->>'id')::uuid<>settings.id THEN RAISE EXCEPTION 'Settings record does not match this workspace' USING ERRCODE='P0002'; END IF;
   UPDATE public.office_manufacturing_settings x SET
    factory_name=office_private.mfg_text(p,'factory_name',true,160),
    jurisdiction=office_private.mfg_text(p,'jurisdiction',true,32),version=x.version+1,updated_at=now()
   WHERE x.workspace_id=p_workspace_id RETURNING * INTO settings;
  ELSE
   IF p ? 'id' OR p ? 'expected_version' THEN RAISE EXCEPTION 'Settings record not found' USING ERRCODE='P0002'; END IF;
   INSERT INTO public.office_manufacturing_settings(workspace_id,factory_name,jurisdiction)
   VALUES(p_workspace_id,office_private.mfg_text(p,'factory_name',true,160),office_private.mfg_text(p,'jurisdiction',true,32)) RETURNING * INTO settings;
  END IF;
  RETURN jsonb_build_object('id',settings.id,'version',settings.version);
 WHEN 'assign_staff_role' THEN
  v_user:=office_private.mfg_text(p,'user_id',true,36)::uuid;
  v_role:=office_private.mfg_text(p,'role',true,40);
  IF v_role NOT IN('manufacturing_admin','production_planner','storekeeper','production_operator','quality_reviewer','maintenance_engineer','safety_officer','manufacturing_viewer','unassigned') THEN
   RAISE EXCEPTION 'Unknown Manufacturing staff role' USING ERRCODE='22023';
  END IF;
  SELECT m.role INTO v_member_role FROM public.office_memberships m
  WHERE m.workspace_id=p_workspace_id AND m.user_id=v_user AND m.status='active' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Staff must be an active member of this Office Team' USING ERRCODE='42501'; END IF;
  IF v_member_role IN('owner','admin') AND v_role<>'manufacturing_admin' THEN
   RAISE EXCEPTION 'Office Team owners and administrators retain module administration. Change their Team role first.' USING ERRCODE='55000';
  END IF;
  SELECT * INTO staff FROM public.office_manufacturing_staff_roles r WHERE r.workspace_id=p_workspace_id AND r.user_id=v_user FOR UPDATE;
  v_active:=v_role<>'unassigned';
  IF FOUND THEN
   PERFORM office_private.mfg_version(p,'expected_version',staff.version);
   UPDATE public.office_manufacturing_staff_roles r SET manufacturing_role=CASE WHEN v_active THEN v_role ELSE r.manufacturing_role END,
    active=v_active,assigned_by=auth.uid(),version=r.version+1,updated_at=now()
   WHERE r.workspace_id=p_workspace_id AND r.user_id=v_user RETURNING * INTO staff;
  ELSE
   IF p ? 'expected_version' THEN RAISE EXCEPTION 'Staff assignment changed. Refresh before retrying.' USING ERRCODE='40001'; END IF;
   INSERT INTO public.office_manufacturing_staff_roles(workspace_id,user_id,manufacturing_role,active,assigned_by)
   VALUES(p_workspace_id,v_user,CASE WHEN v_active THEN v_role ELSE 'manufacturing_viewer' END,v_active,auth.uid()) RETURNING * INTO staff;
  END IF;
  RETURN jsonb_build_object('id',staff.id,'version',staff.version,'user_id',staff.user_id,'role',v_role);
 WHEN 'configure_private_key' THEN
  PERFORM 1 FROM public.office_workspaces w WHERE w.id=p_workspace_id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM public.office_manufacturing_key_configs k WHERE k.workspace_id=p_workspace_id) THEN
   RAISE EXCEPTION 'The Manufacturing records key is already configured. Unlock it; replacing it would orphan encrypted records.' USING ERRCODE='55000';
  END IF;
  v_salt:=office_private.mfg_envelope_field(p,'salt',16,16);
  v_nonce:=office_private.mfg_envelope_field(p,'nonce',12,12);
  v_ciphertext:=office_private.mfg_envelope_field(p,'ciphertext',17,32768);
  INSERT INTO public.office_manufacturing_key_configs(workspace_id,salt,nonce,ciphertext,created_by)
  VALUES(p_workspace_id,v_salt,v_nonce,v_ciphertext,auth.uid());
  RETURN jsonb_build_object('id',p_workspace_id,'version',1);
 WHEN 'save_supplier_private' THEN
  v_id:=office_private.mfg_text(p,'supplier_id',true,36)::uuid;
  PERFORM 1 FROM public.office_manufacturing_suppliers x WHERE x.workspace_id=p_workspace_id AND x.id=v_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found in this workspace' USING ERRCODE='P0002'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.office_manufacturing_key_configs k WHERE k.workspace_id=p_workspace_id) THEN RAISE EXCEPTION 'Configure the records key before saving private contacts' USING ERRCODE='55000'; END IF;
  v_nonce:=office_private.mfg_envelope_field(p,'nonce',12,12);
  v_ciphertext:=office_private.mfg_envelope_field(p,'ciphertext',17,32768);
  SELECT * INTO secret FROM public.office_manufacturing_supplier_private x WHERE x.workspace_id=p_workspace_id AND x.supplier_id=v_id FOR UPDATE;
  IF FOUND THEN
   PERFORM office_private.mfg_version(p,'expected_version',secret.version);
   UPDATE public.office_manufacturing_supplier_private x SET nonce=v_nonce,ciphertext=v_ciphertext,version=x.version+1,updated_at=now()
   WHERE x.workspace_id=p_workspace_id AND x.supplier_id=v_id RETURNING * INTO secret;
  ELSE
   IF jsonb_typeof(p->'expected_version') IS DISTINCT FROM 'number' OR p->>'expected_version'<>'0' THEN RAISE EXCEPTION 'New private contacts require version zero' USING ERRCODE='40001'; END IF;
   INSERT INTO public.office_manufacturing_supplier_private(workspace_id,supplier_id,nonce,ciphertext)
   VALUES(p_workspace_id,v_id,v_nonce,v_ciphertext) RETURNING * INTO secret;
  END IF;
  RETURN jsonb_build_object('id',v_id,'version',secret.version);
 WHEN 'save_item' THEN
  IF p ? 'id' THEN
   SELECT * INTO i FROM public.office_manufacturing_items x WHERE x.workspace_id=p_workspace_id AND x.id=(p->>'id')::uuid FOR UPDATE;
   PERFORM office_private.mfg_version(p,'expected_version',i.version);
   v_in_use:=EXISTS(SELECT 1 FROM public.office_manufacturing_lots x WHERE x.workspace_id=p_workspace_id AND x.item_id=i.id)
    OR EXISTS(SELECT 1 FROM public.office_manufacturing_bom_lines x WHERE x.workspace_id=p_workspace_id AND x.item_id=i.id)
    OR EXISTS(SELECT 1 FROM public.office_manufacturing_boms x WHERE x.workspace_id=p_workspace_id AND x.product_id=i.id);
   IF v_in_use AND (i.unit IS DISTINCT FROM p->>'unit' OR i.kind IS DISTINCT FROM p->>'kind' OR i.sku IS DISTINCT FROM p->>'sku') THEN
    RAISE EXCEPTION 'Used item SKU, kind and base unit are immutable. Create a new item for a different specification.' USING ERRCODE='55000';
   END IF;
   IF p->>'status'='archived' AND (
    EXISTS(SELECT 1 FROM public.office_manufacturing_stock_balances b WHERE b.workspace_id=p_workspace_id AND b.item_id=i.id AND (b.on_hand>0 OR b.reserved>0))
    OR EXISTS(SELECT 1 FROM public.office_manufacturing_production_orders o WHERE o.workspace_id=p_workspace_id AND o.status NOT IN('completed','rejected','cancelled') AND (o.product_id=i.id OR EXISTS(SELECT 1 FROM public.office_manufacturing_order_requirements r WHERE r.workspace_id=o.workspace_id AND r.order_id=o.id AND r.item_id=i.id)))
    OR EXISTS(SELECT 1 FROM public.office_manufacturing_boms b WHERE b.workspace_id=p_workspace_id AND b.status='active' AND (b.product_id=i.id OR EXISTS(SELECT 1 FROM public.office_manufacturing_bom_lines bl WHERE bl.workspace_id=b.workspace_id AND bl.bom_id=b.id AND bl.item_id=i.id)))
   ) THEN RAISE EXCEPTION 'Stock, an active BOM or open production still uses this item' USING ERRCODE='55000'; END IF;
   UPDATE public.office_manufacturing_items x SET sku=office_private.mfg_text(p,'sku',true,64),name=office_private.mfg_text(p,'name',true,160),kind=office_private.mfg_text(p,'kind',true,24),unit=office_private.mfg_text(p,'unit',true,24),
    reorder_point=office_private.mfg_qty(p,'reorder_point'),status=office_private.mfg_text(p,'status',true,16),version=x.version+1,updated_at=now()
   WHERE x.workspace_id=p_workspace_id AND x.id=i.id RETURNING * INTO i;
  ELSE
   INSERT INTO public.office_manufacturing_items(workspace_id,sku,name,kind,unit,reorder_point,status)
   VALUES(p_workspace_id,office_private.mfg_text(p,'sku',true,64),office_private.mfg_text(p,'name',true,160),office_private.mfg_text(p,'kind',true,24),office_private.mfg_text(p,'unit',true,24),office_private.mfg_qty(p,'reorder_point'),office_private.mfg_text(p,'status',true,16)) RETURNING * INTO i;
  END IF;
  RETURN jsonb_build_object('id',i.id,'version',i.version,'status',i.status);
 WHEN 'save_supplier' THEN
  IF p ? 'id' THEN
   SELECT * INTO s FROM public.office_manufacturing_suppliers x WHERE x.workspace_id=p_workspace_id AND x.id=(p->>'id')::uuid FOR UPDATE;
   PERFORM office_private.mfg_version(p,'expected_version',s.version);
   UPDATE public.office_manufacturing_suppliers x SET supplier_code=office_private.mfg_text(p,'supplier_code',true,64),display_label=office_private.mfg_text(p,'display_label',true,120),status=office_private.mfg_text(p,'status',true,16),version=x.version+1,updated_at=now()
   WHERE x.workspace_id=p_workspace_id AND x.id=s.id RETURNING * INTO s;
  ELSE
   INSERT INTO public.office_manufacturing_suppliers(workspace_id,supplier_code,display_label,status)
   VALUES(p_workspace_id,office_private.mfg_text(p,'supplier_code',true,64),office_private.mfg_text(p,'display_label',true,120),office_private.mfg_text(p,'status',true,16)) RETURNING * INTO s;
  END IF;
  RETURN jsonb_build_object('id',s.id,'version',s.version,'status',s.status);
 WHEN 'save_location' THEN
  IF p ? 'id' THEN
   SELECT * INTO l FROM public.office_manufacturing_locations x WHERE x.workspace_id=p_workspace_id AND x.id=(p->>'id')::uuid FOR UPDATE;
   PERFORM office_private.mfg_version(p,'expected_version',l.version);
   IF p->>'status'='archived' AND (
    EXISTS(SELECT 1 FROM public.office_manufacturing_stock_balances b WHERE b.workspace_id=p_workspace_id AND b.location_id=l.id AND (b.on_hand>0 OR b.reserved>0))
    OR EXISTS(SELECT 1 FROM public.office_manufacturing_production_orders o WHERE o.workspace_id=p_workspace_id AND o.output_location_id=l.id AND o.status NOT IN('completed','rejected','cancelled'))
   ) THEN RAISE EXCEPTION 'Stock or open production still uses this location' USING ERRCODE='55000'; END IF;
   UPDATE public.office_manufacturing_locations x SET code=office_private.mfg_text(p,'code',true,64),name=office_private.mfg_text(p,'name',true,160),status=office_private.mfg_text(p,'status',true,16),version=x.version+1,updated_at=now()
   WHERE x.workspace_id=p_workspace_id AND x.id=l.id RETURNING * INTO l;
  ELSE
   INSERT INTO public.office_manufacturing_locations(workspace_id,code,name,status)
   VALUES(p_workspace_id,office_private.mfg_text(p,'code',true,64),office_private.mfg_text(p,'name',true,160),office_private.mfg_text(p,'status',true,16)) RETURNING * INTO l;
  END IF;
  RETURN jsonb_build_object('id',l.id,'version',l.version,'status',l.status);
 WHEN 'save_asset' THEN
  IF p ? 'id' THEN
   SELECT * INTO a FROM public.office_manufacturing_assets x WHERE x.workspace_id=p_workspace_id AND x.id=(p->>'id')::uuid FOR UPDATE;
   PERFORM office_private.mfg_version(p,'expected_version',a.version);
   IF p->>'status'='operational' AND EXISTS(SELECT 1 FROM public.office_manufacturing_maintenance_orders m WHERE m.workspace_id=p_workspace_id AND m.asset_id=a.id AND m.priority='critical' AND m.status NOT IN('verified','cancelled')) THEN
    RAISE EXCEPTION 'Critical maintenance still requires independent verification' USING ERRCODE='55000';
   END IF;
   UPDATE public.office_manufacturing_assets x SET asset_code=office_private.mfg_text(p,'asset_code',true,64),name=office_private.mfg_text(p,'name',true,160),status=office_private.mfg_text(p,'status',true,24),next_service_date=office_private.mfg_date(p,'next_service_date',false),version=x.version+1,updated_at=now()
   WHERE x.workspace_id=p_workspace_id AND x.id=a.id RETURNING * INTO a;
  ELSE
   INSERT INTO public.office_manufacturing_assets(workspace_id,asset_code,name,status,next_service_date)
   VALUES(p_workspace_id,office_private.mfg_text(p,'asset_code',true,64),office_private.mfg_text(p,'name',true,160),office_private.mfg_text(p,'status',true,24),office_private.mfg_date(p,'next_service_date',false)) RETURNING * INTO a;
  END IF;
  RETURN jsonb_build_object('id',a.id,'version',a.version,'status',a.status);
 ELSE
  RAISE EXCEPTION 'Unknown Manufacturing core action' USING ERRCODE='22023';
 END CASE;
END $mfg$;

-- Manufacturing source: 60-read.sql
CREATE OR REPLACE FUNCTION public.office_manufacturing_read(
 p_workspace_id uuid,p_resource text,p_filter jsonb DEFAULT '{}'::jsonb,p_limit integer DEFAULT 100,p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $mfg$
DECLARE v_role text; v_sql text; v_filter jsonb:=p_filter; v_result jsonb; v_caps jsonb; v_summary jsonb;
 v_settings jsonb; v_key jsonb; k text; v_text text; v_date date;
BEGIN
 v_role:=office_private.manufacturing_role(p_workspace_id);
 IF v_role='unassigned' THEN RAISE EXCEPTION 'Ask your Office Team administrator to assign a Manufacturing role' USING ERRCODE='42501'; END IF;
 IF p_limit IS NULL OR p_limit<1 OR p_limit>200 OR p_offset IS NULL OR p_offset<0 THEN RAISE EXCEPTION 'Invalid Manufacturing pagination' USING ERRCODE='22023'; END IF;
 IF jsonb_typeof(v_filter) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Manufacturing filters must be an object' USING ERRCODE='22023'; END IF;
 FOR k IN SELECT jsonb_object_keys(v_filter) LOOP
  IF k NOT IN('id','q','status','item_id','supplier_id','location_id','asset_id','bom_id','lot_id','order_id','maintenance_id','target_id','target_type','from_date','to_date') THEN
   RAISE EXCEPTION 'Unknown Manufacturing filter: %',k USING ERRCODE='22023';
  END IF;
  IF jsonb_typeof(v_filter->k) NOT IN('string','null') THEN RAISE EXCEPTION 'Text filter required: %',k USING ERRCODE='22023'; END IF;
  IF k='q' AND char_length(v_filter->>k)>120 THEN RAISE EXCEPTION 'Search text is limited to 120 characters' USING ERRCODE='22023'; END IF;
  IF (k='id' OR k LIKE '%_id') AND nullif(v_filter->>k,'') IS NOT NULL THEN
   v_filter:=jsonb_set(v_filter,ARRAY[k],to_jsonb(((v_filter->>k)::uuid)::text));
  END IF;
  IF k IN('from_date','to_date') AND nullif(v_filter->>k,'') IS NOT NULL THEN v_date:=office_private.mfg_date(v_filter,k); END IF;
 END LOOP;
 IF nullif(v_filter->>'from_date','') IS NOT NULL AND nullif(v_filter->>'to_date','') IS NOT NULL
    AND (v_filter->>'from_date')::date>(v_filter->>'to_date')::date THEN RAISE EXCEPTION 'The reporting date range is reversed' USING ERRCODE='22023'; END IF;
 IF p_resource='supplier_private' THEN
  IF NOT office_private.manufacturing_can(p_workspace_id,'private_records') THEN RAISE EXCEPTION 'Private supplier record access is required' USING ERRCODE='42501'; END IF;
  IF nullif(v_filter->>'supplier_id','') IS NULL THEN RAISE EXCEPTION 'A supplier must be selected before reading private records' USING ERRCODE='22023'; END IF;
 END IF;
 IF p_resource='staff_roles' AND NOT office_private.manufacturing_can(p_workspace_id,'staff') THEN RAISE EXCEPTION 'Staff administration is required' USING ERRCODE='42501'; END IF;
 IF p_resource='audit' AND NOT office_private.manufacturing_can(p_workspace_id,'audit') THEN RAISE EXCEPTION 'Audit administration is required' USING ERRCODE='42501'; END IF;
 IF p_resource='lot_genealogy' AND nullif(v_filter->>'lot_id','') IS NULL THEN RAISE EXCEPTION 'Select a batch for genealogy' USING ERRCODE='22023'; END IF;
 IF p_resource='bootstrap' THEN
  SELECT jsonb_object_agg(c,office_private.manufacturing_can(p_workspace_id,c)) INTO v_caps
  FROM unnest(ARRAY['settings','staff','masters','inventory_receive','inventory_move','stock_count','stock_approve','planning','production','quality','maintenance','compliance','evidence','reports','audit','private_records']) c;
  SELECT to_jsonb(s) INTO v_settings FROM public.office_manufacturing_settings s WHERE s.workspace_id=p_workspace_id;
  SELECT jsonb_build_object('configured',true,'key_version',1,'derivation','PBKDF2-HMAC-SHA-256/AES-256-GCM','iterations',600000,'salt',replace(encode(c.salt,'base64'),E'\n',''),
   'nonce',replace(encode(c.nonce,'base64'),E'\n',''),'ciphertext',replace(encode(c.ciphertext,'base64'),E'\n','')) INTO v_key
  FROM public.office_manufacturing_key_configs c WHERE c.workspace_id=p_workspace_id;
  SELECT jsonb_build_object(
   'items_count',(SELECT count(*) FROM public.office_manufacturing_items i WHERE i.workspace_id=p_workspace_id AND i.status='active'),
   'open_orders_count',(SELECT count(*) FROM public.office_manufacturing_production_orders o WHERE o.workspace_id=p_workspace_id AND o.status NOT IN('completed','rejected','cancelled')),
   'held_lots_count',(SELECT count(*) FROM public.office_manufacturing_lots l WHERE l.workspace_id=p_workspace_id AND l.status<>'released' AND EXISTS(SELECT 1 FROM public.office_manufacturing_stock_balances b WHERE b.workspace_id=l.workspace_id AND b.lot_id=l.id AND b.on_hand>0)),
   'low_stock_items_count',(SELECT count(*) FROM public.office_manufacturing_items i WHERE i.workspace_id=p_workspace_id AND i.status='active' AND i.reorder_point>coalesce((SELECT sum(b.on_hand-b.reserved) FROM public.office_manufacturing_stock_balances b JOIN public.office_manufacturing_lots l ON l.workspace_id=b.workspace_id AND l.id=b.lot_id WHERE b.workspace_id=i.workspace_id AND b.item_id=i.id AND l.status='released' AND (l.expiry_date IS NULL OR l.expiry_date>=office_private.mfg_today())),0)),
   'open_maintenance_count',(SELECT count(*) FROM public.office_manufacturing_maintenance_orders m WHERE m.workspace_id=p_workspace_id AND m.status NOT IN('verified','cancelled')),
   'overdue_compliance_count',(SELECT count(*) FROM public.office_manufacturing_compliance_records c WHERE c.workspace_id=p_workspace_id AND c.status<>'closed' AND c.due_date<office_private.mfg_today()),
   'pending_counts_count',(SELECT count(*) FROM public.office_manufacturing_stock_counts c WHERE c.workspace_id=p_workspace_id AND c.status='submitted'),
   'active_reservations_count',(SELECT count(*) FROM public.office_manufacturing_allocations a WHERE a.workspace_id=p_workspace_id AND a.status='reserved')
  ) INTO v_summary;
  RETURN jsonb_build_object('role',v_role,'capabilities',v_caps,'settings',v_settings,'key_config',coalesce(v_key,'{"configured":false}'::jsonb),'summary',v_summary);
 END IF;
 CASE p_resource
 WHEN 'settings' THEN v_sql:=$resource$SELECT to_jsonb(r) AS j FROM public.office_manufacturing_settings r WHERE r.workspace_id=$1$resource$;
 WHEN 'items' THEN v_sql:=$resource$SELECT to_jsonb(r) AS j FROM public.office_manufacturing_items r WHERE r.workspace_id=$1$resource$;
 WHEN 'suppliers' THEN v_sql:=$resource$SELECT to_jsonb(r) AS j FROM public.office_manufacturing_suppliers r WHERE r.workspace_id=$1$resource$;
 WHEN 'locations' THEN v_sql:=$resource$SELECT to_jsonb(r) AS j FROM public.office_manufacturing_locations r WHERE r.workspace_id=$1$resource$;
 WHEN 'assets' THEN v_sql:=$resource$SELECT to_jsonb(r) AS j FROM public.office_manufacturing_assets r WHERE r.workspace_id=$1$resource$;
 WHEN 'boms' THEN v_sql:=$resource$SELECT to_jsonb(r) || jsonb_build_object('product_name',i.name,'product_sku',i.sku) AS j FROM public.office_manufacturing_boms r JOIN public.office_manufacturing_items i ON i.workspace_id=r.workspace_id AND i.id=r.product_id WHERE r.workspace_id=$1$resource$;
 WHEN 'bom_lines' THEN v_sql:=$resource$SELECT to_jsonb(r) || jsonb_build_object('bom_code',b.bom_code,'revision',b.revision,'sku',i.sku,'item_name',i.name,'unit',i.unit) AS j FROM public.office_manufacturing_bom_lines r JOIN public.office_manufacturing_boms b ON b.workspace_id=r.workspace_id AND b.id=r.bom_id JOIN public.office_manufacturing_items i ON i.workspace_id=r.workspace_id AND i.id=r.item_id WHERE r.workspace_id=$1$resource$;
 WHEN 'lots' THEN v_sql:=$resource$SELECT to_jsonb(r) || jsonb_build_object('sku',i.sku,'item_name',i.name,'unit',i.unit) AS j FROM public.office_manufacturing_lots r JOIN public.office_manufacturing_items i ON i.workspace_id=r.workspace_id AND i.id=r.item_id WHERE r.workspace_id=$1$resource$;
 WHEN 'stock_movements' THEN v_sql:=$resource$SELECT to_jsonb(r) || jsonb_build_object('batch_code',l.batch_code,'item_name',i.name,'unit',i.unit) AS j FROM public.office_manufacturing_stock_movements r JOIN public.office_manufacturing_lots l ON l.workspace_id=r.workspace_id AND l.id=r.lot_id JOIN public.office_manufacturing_items i ON i.workspace_id=l.workspace_id AND i.id=l.item_id WHERE r.workspace_id=$1$resource$;
 WHEN 'stock_counts' THEN v_sql:=$resource$SELECT to_jsonb(r) || jsonb_build_object('batch_code',l.batch_code,'location_name',loc.name,'item_name',i.name) AS j FROM public.office_manufacturing_stock_counts r JOIN public.office_manufacturing_lots l ON l.workspace_id=r.workspace_id AND l.id=r.lot_id JOIN public.office_manufacturing_locations loc ON loc.workspace_id=r.workspace_id AND loc.id=r.location_id JOIN public.office_manufacturing_items i ON i.workspace_id=l.workspace_id AND i.id=l.item_id WHERE r.workspace_id=$1$resource$;
 WHEN 'production_orders' THEN v_sql:=$resource$SELECT to_jsonb(r) || jsonb_build_object('product_name',i.name,'sku',i.sku,'output_location_name',loc.name) AS j FROM public.office_manufacturing_production_orders r JOIN public.office_manufacturing_items i ON i.workspace_id=r.workspace_id AND i.id=r.product_id JOIN public.office_manufacturing_locations loc ON loc.workspace_id=r.workspace_id AND loc.id=r.output_location_id WHERE r.workspace_id=$1$resource$;
 WHEN 'allocations' THEN v_sql:=$resource$SELECT to_jsonb(r) || jsonb_build_object('order_code',o.order_code,'batch_code',l.batch_code,'item_name',i.name,'sku',i.sku,'location_name',loc.name) AS j FROM public.office_manufacturing_allocations r JOIN public.office_manufacturing_production_orders o ON o.workspace_id=r.workspace_id AND o.id=r.order_id JOIN public.office_manufacturing_lots l ON l.workspace_id=r.workspace_id AND l.id=r.lot_id JOIN public.office_manufacturing_items i ON i.workspace_id=r.workspace_id AND i.id=r.item_id JOIN public.office_manufacturing_locations loc ON loc.workspace_id=r.workspace_id AND loc.id=r.location_id WHERE r.workspace_id=$1$resource$;
 WHEN 'inspections' THEN v_sql:=$resource$SELECT to_jsonb(r) || jsonb_build_object('batch_code',l.batch_code,'item_name',i.name) AS j FROM public.office_manufacturing_inspections r JOIN public.office_manufacturing_lots l ON l.workspace_id=r.workspace_id AND l.id=r.lot_id JOIN public.office_manufacturing_items i ON i.workspace_id=l.workspace_id AND i.id=l.item_id WHERE r.workspace_id=$1$resource$;
 WHEN 'maintenance_orders' THEN v_sql:=$resource$SELECT to_jsonb(r) || jsonb_build_object('asset_name',a.name,'asset_code',a.asset_code) AS j FROM public.office_manufacturing_maintenance_orders r JOIN public.office_manufacturing_assets a ON a.workspace_id=r.workspace_id AND a.id=r.asset_id WHERE r.workspace_id=$1$resource$;
 WHEN 'maintenance_parts' THEN v_sql:=$resource$SELECT to_jsonb(r) || jsonb_build_object('work_code',m.work_code,'batch_code',l.batch_code,'item_name',i.name,'location_name',loc.name) AS j FROM public.office_manufacturing_maintenance_parts r JOIN public.office_manufacturing_maintenance_orders m ON m.workspace_id=r.workspace_id AND m.id=r.maintenance_id JOIN public.office_manufacturing_lots l ON l.workspace_id=r.workspace_id AND l.id=r.lot_id JOIN public.office_manufacturing_items i ON i.workspace_id=l.workspace_id AND i.id=l.item_id JOIN public.office_manufacturing_locations loc ON loc.workspace_id=r.workspace_id AND loc.id=r.location_id WHERE r.workspace_id=$1$resource$;
 WHEN 'compliance_records' THEN v_sql:=$resource$SELECT to_jsonb(r) AS j FROM public.office_manufacturing_compliance_records r WHERE r.workspace_id=$1$resource$;
 WHEN 'evidence' THEN v_sql:=$resource$SELECT to_jsonb(r) AS j FROM public.office_manufacturing_evidence r WHERE r.workspace_id=$1$resource$;
 WHEN 'audit' THEN v_sql:=$resource$SELECT to_jsonb(r) AS j FROM public.office_manufacturing_audit r WHERE r.workspace_id=$1$resource$;
 WHEN 'staff_roles' THEN v_sql:=$resource$SELECT to_jsonb(x) AS j FROM (
 SELECT coalesce(r.id,m.user_id) AS id,m.workspace_id,m.user_id,
 CASE WHEN m.role IN('owner','admin') THEN 'manufacturing_admin' WHEN r.active THEN r.manufacturing_role ELSE 'unassigned' END AS role,
 'Member '||upper(substr(replace(m.user_id::text,'-',''),1,8)) AS member_ref,coalesce(r.version,0) AS version,m.role AS team_role,m.status,r.created_at,r.updated_at
 FROM public.office_memberships m LEFT JOIN public.office_manufacturing_staff_roles r ON r.workspace_id=m.workspace_id AND r.user_id=m.user_id
 WHERE m.workspace_id=$1 AND m.status='active'
) x$resource$;
 WHEN 'supplier_private' THEN v_sql:=$resource$SELECT jsonb_build_object('id',r.supplier_id,'supplier_id',r.supplier_id,'workspace_id',r.workspace_id,
 'nonce',replace(encode(r.nonce,'base64'),E'\n',''),'ciphertext',replace(encode(r.ciphertext,'base64'),E'\n',''),
 'version',r.version,'updated_at',r.updated_at) AS j
 FROM public.office_manufacturing_supplier_private r WHERE r.workspace_id=$1$resource$;
 WHEN 'stock_balances' THEN v_sql:=$resource$SELECT to_jsonb(x) AS j FROM (
 SELECT b.*,l.batch_code,l.status AS lot_status,l.expiry_date,l.unit_cost,i.name AS item_name,i.unit,loc.name AS location_name,
 b.on_hand-b.reserved AS available
 FROM public.office_manufacturing_stock_balances b
 JOIN public.office_manufacturing_lots l ON l.workspace_id=b.workspace_id AND l.id=b.lot_id
 JOIN public.office_manufacturing_items i ON i.workspace_id=b.workspace_id AND i.id=b.item_id
 JOIN public.office_manufacturing_locations loc ON loc.workspace_id=b.workspace_id AND loc.id=b.location_id WHERE b.workspace_id=$1
) x$resource$;
 WHEN 'order_requirements' THEN v_sql:=$resource$SELECT to_jsonb(x) || jsonb_build_object('order_code',o.order_code,'sku',i.sku,'item_name',i.name,'unit',i.unit) AS j FROM (
 SELECT r.id,r.workspace_id,r.order_id,r.item_id,r.required_quantity,r.version,
 coalesce(sum(a.quantity) FILTER(WHERE a.status='reserved'),0)::numeric AS allocated_quantity,
 coalesce(sum(a.quantity) FILTER(WHERE a.status='issued'),0)::numeric AS issued_quantity,
 coalesce(sum(a.returned_quantity) FILTER(WHERE a.status='issued'),0)::numeric AS returned_quantity
 FROM public.office_manufacturing_order_requirements r
 LEFT JOIN public.office_manufacturing_allocations a ON a.workspace_id=r.workspace_id AND a.order_id=r.order_id AND a.item_id=r.item_id
 WHERE r.workspace_id=$1 GROUP BY r.id,r.workspace_id,r.order_id,r.item_id,r.required_quantity,r.version
) x JOIN public.office_manufacturing_production_orders o ON o.workspace_id=x.workspace_id AND o.id=x.order_id JOIN public.office_manufacturing_items i ON i.workspace_id=x.workspace_id AND i.id=x.item_id$resource$;
 WHEN 'stock_report' THEN v_sql:=$resource$SELECT to_jsonb(x) AS j FROM (
 SELECT i.id AS item_id,i.workspace_id,i.sku,i.name,i.unit,i.status,i.reorder_point,
 coalesce(sum(b.on_hand),0)::numeric AS on_hand,coalesce(sum(b.reserved),0)::numeric AS reserved,
 coalesce(sum(CASE WHEN l.status='released' AND (l.expiry_date IS NULL OR l.expiry_date>=office_private.mfg_today()) THEN b.on_hand-b.reserved ELSE 0 END),0)::numeric AS available,
 round(coalesce(sum(b.on_hand*l.unit_cost),0),2)::numeric AS value_tzs,
 (i.status='active' AND coalesce(sum(CASE WHEN l.status='released' AND (l.expiry_date IS NULL OR l.expiry_date>=office_private.mfg_today()) THEN b.on_hand-b.reserved ELSE 0 END),0)<i.reorder_point) AS low_stock
 FROM public.office_manufacturing_items i
 LEFT JOIN public.office_manufacturing_stock_balances b ON b.workspace_id=i.workspace_id AND b.item_id=i.id
 LEFT JOIN public.office_manufacturing_lots l ON l.workspace_id=b.workspace_id AND l.id=b.lot_id
 WHERE i.workspace_id=$1 GROUP BY i.id,i.workspace_id,i.sku,i.name,i.unit,i.status,i.reorder_point
) x$resource$;
 WHEN 'production_report' THEN v_sql:=$resource$SELECT to_jsonb(x) AS j FROM (
 SELECT o.id,o.id AS order_id,o.workspace_id,o.order_code,o.status,o.created_at,o.due_date,
 o.target_quantity,o.output_quantity,o.scrap_quantity,o.material_cost,o.labour_cost,o.overhead_cost,o.total_cost,
 CASE WHEN o.output_quantity>0 THEN round(o.total_cost/o.output_quantity,6) ELSE 0::numeric END AS unit_cost
 FROM public.office_manufacturing_production_orders o WHERE o.workspace_id=$1
) x$resource$;
 WHEN 'lot_genealogy' THEN v_sql:=$resource$WITH RECURSIVE ancestors(lot_id) AS (
 SELECT l.id FROM public.office_manufacturing_lots l WHERE l.workspace_id=$1 AND l.id=($2->>'lot_id')::uuid
 UNION
 SELECT a.lot_id FROM ancestors an JOIN public.office_manufacturing_production_orders o ON o.workspace_id=$1 AND o.output_lot_id=an.lot_id
 JOIN public.office_manufacturing_allocations a ON a.workspace_id=o.workspace_id AND a.order_id=o.id AND a.status='issued' AND a.quantity>a.returned_quantity
), descendants AS (SELECT d.lot_id FROM office_private.mfg_descendant_lots($1,($2->>'lot_id')::uuid) d)
SELECT to_jsonb(x) AS j FROM (
 SELECT a.id,$1::uuid AS workspace_id,'input'::text AS relation,($2->>'lot_id')::uuid AS lot_id,a.lot_id AS linked_lot_id,
 o.id AS order_id,o.order_code,root.batch_code,l.batch_code AS linked_batch_code,(a.quantity-a.returned_quantity)::numeric AS quantity,l.status AS lot_status,i.unit,a.issued_at AS created_at
 FROM public.office_manufacturing_production_orders o JOIN ancestors an ON an.lot_id=o.output_lot_id
 JOIN public.office_manufacturing_lots root ON root.workspace_id=o.workspace_id AND root.id=o.output_lot_id
 JOIN public.office_manufacturing_allocations a ON a.workspace_id=o.workspace_id AND a.order_id=o.id AND a.status='issued' AND a.quantity>a.returned_quantity
 JOIN public.office_manufacturing_lots l ON l.workspace_id=a.workspace_id AND l.id=a.lot_id
 JOIN public.office_manufacturing_items i ON i.workspace_id=l.workspace_id AND i.id=l.item_id WHERE o.workspace_id=$1
 UNION ALL
 SELECT a.id,$1::uuid,'output'::text,($2->>'lot_id')::uuid,o.output_lot_id,o.id,o.order_code,root.batch_code,l.batch_code,o.output_quantity,l.status,i.unit,o.updated_at
 FROM public.office_manufacturing_allocations a JOIN descendants d ON d.lot_id=a.lot_id
 JOIN public.office_manufacturing_lots root ON root.workspace_id=a.workspace_id AND root.id=a.lot_id
 JOIN public.office_manufacturing_production_orders o ON o.workspace_id=a.workspace_id AND o.id=a.order_id AND o.output_lot_id IS NOT NULL
 JOIN public.office_manufacturing_lots l ON l.workspace_id=o.workspace_id AND l.id=o.output_lot_id
 JOIN public.office_manufacturing_items i ON i.workspace_id=l.workspace_id AND i.id=l.item_id
 WHERE a.workspace_id=$1 AND a.status='issued' AND a.quantity>a.returned_quantity
 UNION ALL
 SELECT m.id,$1::uuid,'dispatch'::text,($2->>'lot_id')::uuid,m.lot_id,m.order_id,m.reference,l.batch_code,l.batch_code,m.quantity,l.status,i.unit,m.created_at
 FROM public.office_manufacturing_stock_movements m JOIN descendants d ON d.lot_id=m.lot_id
 JOIN public.office_manufacturing_lots l ON l.workspace_id=m.workspace_id AND l.id=m.lot_id
 JOIN public.office_manufacturing_items i ON i.workspace_id=l.workspace_id AND i.id=l.item_id WHERE m.workspace_id=$1 AND m.kind='dispatch'
) x$resource$;
 ELSE RAISE EXCEPTION 'Unknown Manufacturing resource' USING ERRCODE='22023';
 END CASE;
 v_sql:='WITH base AS ('||v_sql||$query$), filtered AS (
 SELECT office_private.mfg_exact_json(b.j) AS j FROM base b WHERE
 (nullif($2->>'q','') IS NULL OR strpos(lower(b.j::text),lower($2->>'q'))>0)
 AND (nullif($2->>'id','') IS NULL OR coalesce(b.j->>'id',b.j->>'supplier_id',b.j->>'item_id')=$2->>'id')
 AND (nullif($2->>'status','') IS NULL OR b.j->>'status'=$2->>'status')
 AND (nullif($2->>'item_id','') IS NULL OR coalesce(b.j->>'item_id',b.j->>'product_id',b.j->>'id')=$2->>'item_id')
 AND (nullif($2->>'supplier_id','') IS NULL OR coalesce(b.j->>'supplier_id',b.j->>'id')=$2->>'supplier_id')
 AND (nullif($2->>'location_id','') IS NULL OR coalesce(b.j->>'location_id',b.j->>'id')=$2->>'location_id' OR b.j->>'from_location_id'=$2->>'location_id' OR b.j->>'to_location_id'=$2->>'location_id')
 AND (nullif($2->>'asset_id','') IS NULL OR coalesce(b.j->>'asset_id',b.j->>'id')=$2->>'asset_id')
 AND (nullif($2->>'bom_id','') IS NULL OR coalesce(b.j->>'bom_id',b.j->>'id')=$2->>'bom_id')
 AND (nullif($2->>'lot_id','') IS NULL OR coalesce(b.j->>'lot_id',b.j->>'id')=$2->>'lot_id')
 AND (nullif($2->>'order_id','') IS NULL OR coalesce(b.j->>'order_id',b.j->>'id')=$2->>'order_id')
 AND (nullif($2->>'maintenance_id','') IS NULL OR coalesce(b.j->>'maintenance_id',b.j->>'id')=$2->>'maintenance_id')
 AND (nullif($2->>'target_id','') IS NULL OR b.j->>'target_id'=$2->>'target_id')
 AND (nullif($2->>'target_type','') IS NULL OR b.j->>'target_type'=$2->>'target_type')
 AND (nullif($2->>'from_date','') IS NULL OR ((b.j->>'created_at')::timestamptz AT TIME ZONE 'Africa/Dar_es_Salaam')::date>=($2->>'from_date')::date)
 AND (nullif($2->>'to_date','') IS NULL OR ((b.j->>'created_at')::timestamptz AT TIME ZONE 'Africa/Dar_es_Salaam')::date<=($2->>'to_date')::date)
 ), page AS (
 SELECT f.j FROM filtered f ORDER BY coalesce(f.j->>'created_at','') DESC,coalesce(f.j->>'sku',f.j->>'order_code',f.j->>'code',f.j->>'id',f.j->>'item_id','') ASC,f.j::text ASC LIMIT $3 OFFSET $4
 ), totals AS (SELECT count(*) AS n FROM filtered), result AS (SELECT coalesce(jsonb_agg(p.j),'[]'::jsonb) AS rows FROM page p)
 SELECT jsonb_build_object('rows',r.rows,'total_count',t.n,'offset',$4,'limit',$3,'has_more',t.n>$4+jsonb_array_length(r.rows),'dataset_version',(SELECT count(*)::text FROM public.office_manufacturing_audit WHERE workspace_id=$1)) FROM totals t CROSS JOIN result r$query$;
 EXECUTE v_sql INTO v_result USING p_workspace_id,v_filter,p_limit,p_offset;
 RETURN v_result;
END $mfg$;

-- Manufacturing source: 90-rpc-acl.sql
CREATE OR REPLACE FUNCTION public.office_manufacturing_command(p_workspace_id uuid,p_action text,p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $mfg$
DECLARE
 v_role text; v_cap text; v_allowed jsonb; k text; v_key uuid; v_inserted boolean;
 v_hash text; v_result jsonb; v_entity_type text;
 request public.office_manufacturing_requests%rowtype;
BEGIN
 v_role:=office_private.manufacturing_role(p_workspace_id);
 IF v_role='unassigned' THEN RAISE EXCEPTION 'A Manufacturing staff role is required' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p_payload) IS DISTINCT FROM 'object' OR pg_column_size(p_payload)>131072 THEN RAISE EXCEPTION 'A bounded Manufacturing command object is required' USING ERRCODE='22023'; END IF;
 v_allowed:=$fields${"save_settings":["id","expected_version","factory_name","jurisdiction"],"assign_staff_role":["user_id","role","expected_version"],"configure_private_key":["salt","nonce","ciphertext"],"save_item":["id","expected_version","sku","name","kind","unit","reorder_point","status"],"save_supplier":["id","expected_version","supplier_code","display_label","status"],"save_supplier_private":["supplier_id","nonce","ciphertext","expected_version"],"save_location":["id","expected_version","code","name","status"],"save_asset":["id","expected_version","asset_code","name","status","next_service_date"],"save_bom":["id","expected_version","bom_code","revision","kind","product_id","output_quantity"],"save_bom_line":["id","expected_version","bom_id","item_id","quantity","expected_parent_version"],"delete_bom_line":["id","expected_version","expected_parent_version"],"activate_bom":["id","expected_version"],"retire_bom":["id","expected_version"],"receive_stock":["item_id","batch_code","supplier_id","supplier_lot","quantity","unit_cost","location_id","received_date","expiry_date","reference"],"transfer_stock":["lot_id","from_location_id","to_location_id","quantity","expected_balance_version","reference"],"dispatch_stock":["lot_id","location_id","quantity","expected_balance_version","reference","customer_reference"],"scrap_stock":["lot_id","location_id","quantity","expected_balance_version","reason","waste_reference"],"submit_stock_count":["lot_id","location_id","counted_quantity","expected_balance_version","reason"],"review_stock_count":["id","expected_version","decision","reason"],"save_production_order":["id","expected_version","order_code","bom_id","target_quantity","due_date","asset_id","output_location_id"],"allocate_material":["order_id","expected_parent_version","lot_id","location_id","quantity"],"remove_allocation":["id","expected_version","expected_parent_version"],"release_production_order":["id","expected_version"],"start_production_order":["id","expected_version"],"pause_production_order":["id","expected_version","reason"],"resume_production_order":["id","expected_version"],"return_production_material":["id","expected_version","expected_parent_version","quantity","reason"],"record_production_output":["id","expected_version","batch_code","output_quantity","scrap_quantity","labour_cost","overhead_cost","expiry_date","reason","downtime_minutes"],"cancel_production_order":["id","expected_version","reason"],"record_lot_inspection":["lot_id","expected_version","result","standard_reference","observations"],"hold_lot":["lot_id","expected_version","reason"],"save_maintenance_order":["id","expected_version","work_code","asset_id","kind","priority","due_date","work_notes","permit_reference"],"transition_maintenance_order":["id","expected_version","status","notes","return_to_service"],"issue_maintenance_part":["maintenance_id","expected_parent_version","lot_id","location_id","quantity","expected_balance_version"],"return_maintenance_part":["id","expected_version","expected_parent_version","quantity","reason"],"save_compliance_record":["id","expected_version","record_code","record_type","authority","title","due_date","severity","external_reference","action_notes"],"transition_compliance_record":["id","expected_version","status","notes"],"link_evidence":["evidence_code","target_type","target_id","file_id","revision_id","external_url"],"supersede_evidence":["id","expected_version","reason"]}$fields$::jsonb->p_action;
 v_cap:=$caps${"save_settings":"settings","configure_private_key":"settings","assign_staff_role":"staff","save_item":"masters","save_supplier":"masters","save_location":"masters","save_asset":"masters","save_bom":"masters","save_bom_line":"masters","delete_bom_line":"masters","activate_bom":"masters","retire_bom":"masters","save_supplier_private":"private_records","receive_stock":"inventory_receive","transfer_stock":"inventory_move","dispatch_stock":"inventory_move","scrap_stock":"inventory_move","submit_stock_count":"stock_count","review_stock_count":"stock_approve","save_production_order":"planning","allocate_material":"planning","remove_allocation":"planning","release_production_order":"planning","cancel_production_order":"planning","start_production_order":"production","pause_production_order":"production","resume_production_order":"production","return_production_material":"production","record_production_output":"production","record_lot_inspection":"quality","hold_lot":"quality","save_maintenance_order":"maintenance","transition_maintenance_order":"maintenance","issue_maintenance_part":"maintenance","return_maintenance_part":"maintenance","save_compliance_record":"compliance","transition_compliance_record":"compliance","link_evidence":"evidence","supersede_evidence":"evidence"}$caps$::jsonb->>p_action;
 IF v_allowed IS NULL OR v_cap IS NULL THEN RAISE EXCEPTION 'Unknown Manufacturing action' USING ERRCODE='22023'; END IF;
 IF NOT office_private.manufacturing_can(p_workspace_id,v_cap) THEN RAISE EXCEPTION 'Your Manufacturing role cannot perform this action: %',v_cap USING ERRCODE='42501'; END IF;
 FOR k IN SELECT jsonb_object_keys(p_payload) LOOP
  IF k<>'idempotency_key' AND NOT(v_allowed ? k) THEN RAISE EXCEPTION 'Unknown Manufacturing command field: %',k USING ERRCODE='22023'; END IF;
  IF k LIKE 'expected_%_version' OR k='expected_version' THEN
   IF jsonb_typeof(p_payload->k) IS DISTINCT FROM 'number' OR (p_payload->>k) !~ '^(0|[1-9][0-9]*)$'
    OR (p_payload->>k)::numeric>2147483647 OR (p_payload->>k)::numeric<(CASE WHEN p_action='save_supplier_private' AND k='expected_version' THEN 0 ELSE 1 END) THEN
    RAISE EXCEPTION 'A valid current record version is required: %',k USING ERRCODE='40001';
   END IF;
  END IF;
  IF k='id' OR k LIKE '%_id' THEN
   IF p_payload->k='null'::jsonb AND k IN('supplier_id','asset_id','file_id','revision_id') THEN CONTINUE; END IF;
   IF jsonb_typeof(p_payload->k) IS DISTINCT FROM 'string' OR nullif(p_payload->>k,'') IS NULL THEN RAISE EXCEPTION 'A valid record identifier is required: %',k USING ERRCODE='22023'; END IF;
   PERFORM (p_payload->>k)::uuid;
  END IF;
  IF k IN('reorder_point','output_quantity','quantity','counted_quantity','target_quantity','unit_cost','scrap_quantity','labour_cost','overhead_cost') THEN
   PERFORM office_private.mfg_qty(p_payload,k);
   IF k IN('labour_cost','overhead_cost') AND (p_payload->>k) !~ '^(0|[1-9][0-9]{0,17})(\.[0-9]{1,2})?$' THEN RAISE EXCEPTION 'TZS labour and overhead costs support at most two decimal places' USING ERRCODE='22023'; END IF;
  END IF;
  IF k IN('received_date','due_date','expiry_date','next_service_date') THEN PERFORM office_private.mfg_date(p_payload,k,k IN('received_date','due_date')); END IF;
  IF k='return_to_service' AND jsonb_typeof(p_payload->k) IS DISTINCT FROM 'boolean' THEN RAISE EXCEPTION 'Return-to-service must be a boolean' USING ERRCODE='22023'; END IF;
  IF k='downtime_minutes' AND (jsonb_typeof(p_payload->k) IS DISTINCT FROM 'number' OR (p_payload->>k) !~ '^[0-9]+$' OR (p_payload->>k)::numeric>2147483647) THEN RAISE EXCEPTION 'Downtime must be a nonnegative whole number of minutes' USING ERRCODE='22023'; END IF;
 END LOOP;
 IF jsonb_typeof(p_payload->'idempotency_key') IS DISTINCT FROM 'string' OR nullif(p_payload->>'idempotency_key','') IS NULL THEN RAISE EXCEPTION 'A request idempotency key is required' USING ERRCODE='22023'; END IF;
 v_key:=(p_payload->>'idempotency_key')::uuid;
 v_hash:=encode(pg_catalog.sha256(pg_catalog.convert_to(p_action||':'||p_payload::text,'UTF8')),'hex');
 INSERT INTO public.office_manufacturing_requests(workspace_id,idempotency_key,actor_id,action,request_hash,response)
 VALUES(p_workspace_id,v_key,auth.uid(),p_action,v_hash,'{}'::jsonb)
 ON CONFLICT(workspace_id,idempotency_key) DO NOTHING RETURNING true INTO v_inserted;
 SELECT * INTO request FROM public.office_manufacturing_requests r WHERE r.workspace_id=p_workspace_id AND r.idempotency_key=v_key FOR UPDATE;
 IF NOT coalesce(v_inserted,false) THEN
  IF request.actor_id<>auth.uid() THEN RAISE EXCEPTION 'This request key belongs to a different team member' USING ERRCODE='42501'; END IF;
  IF request.request_hash<>v_hash OR request.action<>p_action THEN RAISE EXCEPTION 'Idempotency key was already used for a different request' USING ERRCODE='23505'; END IF;
  RETURN request.response;
 END IF;
 CASE
 WHEN p_action IN('save_settings','assign_staff_role','configure_private_key','save_item','save_supplier','save_supplier_private','save_location','save_asset') THEN v_result:=office_private.mfg_core_command(p_workspace_id,p_action,p_payload);
 WHEN p_action IN('save_bom','save_bom_line','delete_bom_line','activate_bom','retire_bom','receive_stock','transfer_stock','dispatch_stock','scrap_stock','submit_stock_count','review_stock_count') THEN v_result:=office_private.mfg_inventory_command(p_workspace_id,p_action,p_payload);
 WHEN p_action IN('save_production_order','allocate_material','remove_allocation','release_production_order','start_production_order','pause_production_order','resume_production_order','return_production_material','record_production_output','cancel_production_order') THEN v_result:=office_private.mfg_production_command(p_workspace_id,p_action,p_payload);
 WHEN p_action IN('record_lot_inspection','hold_lot','save_maintenance_order','transition_maintenance_order','issue_maintenance_part','return_maintenance_part','save_compliance_record','transition_compliance_record','link_evidence','supersede_evidence') THEN v_result:=office_private.mfg_operations_command(p_workspace_id,p_action,p_payload);
 ELSE RAISE EXCEPTION 'Unknown Manufacturing action' USING ERRCODE='22023';
 END CASE;
 v_result:=office_private.mfg_exact_json(v_result);
 IF jsonb_typeof(v_result) IS DISTINCT FROM 'object' OR jsonb_typeof(v_result->'id') IS DISTINCT FROM 'string'
  OR jsonb_typeof(v_result->'version') IS DISTINCT FROM 'number' OR (v_result->>'version') !~ '^[1-9][0-9]*$' THEN
  RAISE EXCEPTION 'Manufacturing returned an invalid save result; no changes were committed' USING ERRCODE='XX000';
 END IF;
 PERFORM (v_result->>'id')::uuid;
 v_entity_type:=$entities${"save_settings":"settings","assign_staff_role":"staff_assignment","configure_private_key":"records_key","save_supplier_private":"supplier_private","save_item":"item","save_supplier":"supplier","save_location":"location","save_asset":"asset","save_bom":"bom","activate_bom":"bom","retire_bom":"bom","save_bom_line":"bom_line","delete_bom_line":"bom_line","receive_stock":"lot","record_lot_inspection":"lot","hold_lot":"lot","transfer_stock":"stock_balance","dispatch_stock":"stock_balance","scrap_stock":"stock_balance","submit_stock_count":"stock_count","review_stock_count":"stock_count","save_production_order":"production_order","release_production_order":"production_order","start_production_order":"production_order","pause_production_order":"production_order","resume_production_order":"production_order","record_production_output":"production_order","cancel_production_order":"production_order","allocate_material":"allocation","remove_allocation":"allocation","return_production_material":"allocation","save_maintenance_order":"maintenance_order","transition_maintenance_order":"maintenance_order","issue_maintenance_part":"maintenance_part","return_maintenance_part":"maintenance_part","save_compliance_record":"compliance_record","transition_compliance_record":"compliance_record","link_evidence":"evidence","supersede_evidence":"evidence"}$entities$::jsonb->>p_action;
 INSERT INTO public.office_manufacturing_audit(workspace_id,actor_user_id,action,entity_type,entity_id,payload_hash)
 VALUES(p_workspace_id,auth.uid(),p_action,v_entity_type,(v_result->>'id')::uuid,v_hash);
 UPDATE public.office_manufacturing_requests r SET response=v_result WHERE r.workspace_id=p_workspace_id AND r.idempotency_key=v_key;
 RETURN v_result;
EXCEPTION WHEN deadlock_detected THEN
 RAISE EXCEPTION 'Another team operation changed related stock. Refresh the workspace before retrying.' USING ERRCODE='40001';
END $mfg$;

-- Revoke only functions created by this module, never unrelated Office helpers.
DO $mfg_acl$
DECLARE f record;
BEGIN
 FOR f IN SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) AS args
 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('public','office_private') AND p.proname=ANY(ARRAY['manufacturing_can','manufacturing_role','mfg_core_command','mfg_date','mfg_decimal','mfg_descendant_lots','mfg_envelope_field','mfg_exact_json','mfg_guard_evidence_file_update','mfg_guard_evidence_revision_update','mfg_inventory_command','mfg_operations_command','mfg_production_command','mfg_qty','mfg_require_asset','mfg_text','mfg_today','mfg_version','office_manufacturing_command','office_manufacturing_read']) LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC, anon, authenticated, service_role',f.nspname,f.proname,f.args);
 END LOOP;
END $mfg_acl$;
GRANT EXECUTE ON FUNCTION public.office_manufacturing_read(uuid,text,jsonb,integer,integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.office_manufacturing_command(uuid,text,jsonb) TO authenticated;

COMMIT;
