import type { SupabaseClient } from "@supabase/supabase-js";
import type { OfficeRecordsKeyConfig } from "./officePrivateRecordsCrypto";

export const MANUFACTURING_ROLES = [
  "manufacturing_admin",
  "production_planner",
  "storekeeper",
  "production_operator",
  "quality_reviewer",
  "maintenance_engineer",
  "safety_officer",
  "manufacturing_viewer",
  "unassigned",
] as const;
export type ManufacturingRole = (typeof MANUFACTURING_ROLES)[number];
export const MANUFACTURING_CAPABILITIES = [
  "settings",
  "staff",
  "masters",
  "inventory_receive",
  "inventory_move",
  "stock_count",
  "stock_approve",
  "planning",
  "production",
  "quality",
  "maintenance",
  "compliance",
  "evidence",
  "reports",
  "audit",
  "private_records",
] as const;
export type ManufacturingCapabilities = Record<
  (typeof MANUFACTURING_CAPABILITIES)[number],
  boolean
>;
export type ManufacturingRecord = Record<string, unknown>;
export interface ManufacturingBootstrap {
  role: ManufacturingRole;
  capabilities: ManufacturingCapabilities;
  settings: ManufacturingRecord | null;
  key_config: OfficeRecordsKeyConfig;
  summary: Record<(typeof MANUFACTURING_SUMMARY_KEYS)[number], number>;
}
export interface ManufacturingPage<
  T extends ManufacturingRecord = ManufacturingRecord,
> {
  rows: T[];
  total_count: number;
  offset: number;
  limit: number;
  has_more: boolean;
}
export interface ManufacturingRpcClient {
  rpc(
    name: string,
    params?: Record<string, unknown>,
  ): Promise<{
    data: unknown;
    error: { message: string; code?: string } | null;
  }>;
}
export const MANUFACTURING_SUMMARY_KEYS = [
  "items_count",
  "open_orders_count",
  "held_lots_count",
  "low_stock_items_count",
  "open_maintenance_count",
  "overdue_compliance_count",
  "pending_counts_count",
  "active_reservations_count",
] as const;
export const MANUFACTURING_RESOURCES = [
  "bootstrap",
  "settings",
  "staff_roles",
  "items",
  "suppliers",
  "supplier_private",
  "locations",
  "assets",
  "boms",
  "bom_lines",
  "lots",
  "stock_balances",
  "stock_movements",
  "stock_counts",
  "production_orders",
  "order_requirements",
  "allocations",
  "inspections",
  "maintenance_orders",
  "maintenance_parts",
  "compliance_records",
  "evidence",
  "lot_genealogy",
  "stock_report",
  "production_report",
  "audit",
] as const;
export type ManufacturingResource = (typeof MANUFACTURING_RESOURCES)[number];

/** The same field contract is enforced again by the server. Never add speculative actions here. */
export const MANUFACTURING_COMMAND_FIELDS = {
  save_settings: ["id", "expected_version", "factory_name", "jurisdiction"],
  assign_staff_role: ["user_id", "role", "expected_version"],
  configure_private_key: ["salt", "nonce", "ciphertext"],
  save_item: [
    "id",
    "expected_version",
    "sku",
    "name",
    "kind",
    "unit",
    "reorder_point",
    "status",
  ],
  save_supplier: [
    "id",
    "expected_version",
    "supplier_code",
    "display_label",
    "status",
  ],
  save_supplier_private: [
    "supplier_id",
    "nonce",
    "ciphertext",
    "expected_version",
  ],
  save_location: ["id", "expected_version", "code", "name", "status"],
  save_asset: [
    "id",
    "expected_version",
    "asset_code",
    "name",
    "status",
    "next_service_date",
  ],
  save_bom: [
    "id",
    "expected_version",
    "bom_code",
    "revision",
    "kind",
    "product_id",
    "output_quantity",
  ],
  save_bom_line: [
    "id",
    "expected_version",
    "bom_id",
    "item_id",
    "quantity",
    "expected_parent_version",
  ],
  delete_bom_line: ["id", "expected_version", "expected_parent_version"],
  activate_bom: ["id", "expected_version"],
  retire_bom: ["id", "expected_version"],
  receive_stock: [
    "item_id",
    "batch_code",
    "supplier_id",
    "supplier_lot",
    "quantity",
    "unit_cost",
    "location_id",
    "received_date",
    "expiry_date",
    "reference",
  ],
  transfer_stock: [
    "lot_id",
    "from_location_id",
    "to_location_id",
    "quantity",
    "expected_balance_version",
    "reference",
  ],
  dispatch_stock: [
    "lot_id",
    "location_id",
    "quantity",
    "expected_balance_version",
    "reference",
    "customer_reference",
  ],
  scrap_stock: [
    "lot_id",
    "location_id",
    "quantity",
    "expected_balance_version",
    "reason",
    "waste_reference",
  ],
  submit_stock_count: [
    "lot_id",
    "location_id",
    "counted_quantity",
    "expected_balance_version",
    "reason",
  ],
  review_stock_count: ["id", "expected_version", "decision", "reason"],
  save_production_order: [
    "id",
    "expected_version",
    "order_code",
    "bom_id",
    "target_quantity",
    "due_date",
    "asset_id",
    "output_location_id",
  ],
  allocate_material: [
    "order_id",
    "expected_parent_version",
    "lot_id",
    "location_id",
    "quantity",
  ],
  remove_allocation: ["id", "expected_version", "expected_parent_version"],
  release_production_order: ["id", "expected_version"],
  start_production_order: ["id", "expected_version"],
  pause_production_order: ["id", "expected_version", "reason"],
  resume_production_order: ["id", "expected_version"],
  return_production_material: [
    "id",
    "expected_version",
    "expected_parent_version",
    "quantity",
    "reason",
  ],
  record_production_output: [
    "id",
    "expected_version",
    "batch_code",
    "output_quantity",
    "scrap_quantity",
    "labour_cost",
    "overhead_cost",
    "expiry_date",
    "reason",
    "downtime_minutes",
  ],
  cancel_production_order: ["id", "expected_version", "reason"],
  record_lot_inspection: [
    "lot_id",
    "expected_version",
    "result",
    "standard_reference",
    "observations",
  ],
  hold_lot: ["lot_id", "expected_version", "reason"],
  save_maintenance_order: [
    "id",
    "expected_version",
    "work_code",
    "asset_id",
    "kind",
    "priority",
    "due_date",
    "work_notes",
    "permit_reference",
  ],
  transition_maintenance_order: [
    "id",
    "expected_version",
    "status",
    "notes",
    "return_to_service",
  ],
  issue_maintenance_part: [
    "maintenance_id",
    "expected_parent_version",
    "lot_id",
    "location_id",
    "quantity",
    "expected_balance_version",
  ],
  return_maintenance_part: [
    "id",
    "expected_version",
    "expected_parent_version",
    "quantity",
    "reason",
  ],
  save_compliance_record: [
    "id",
    "expected_version",
    "record_code",
    "record_type",
    "authority",
    "title",
    "due_date",
    "severity",
    "external_reference",
    "action_notes",
  ],
  transition_compliance_record: ["id", "expected_version", "status", "notes"],
  link_evidence: [
    "evidence_code",
    "target_type",
    "target_id",
    "file_id",
    "revision_id",
    "external_url",
  ],
  supersede_evidence: ["id", "expected_version", "reason"],
} as const;
export type ManufacturingAction = keyof typeof MANUFACTURING_COMMAND_FIELDS;
export const MANUFACTURING_ACTIONS = Object.keys(
  MANUFACTURING_COMMAND_FIELDS,
) as ManufacturingAction[];

const QUANTITY_FIELDS: Partial<
  Record<ManufacturingResource, readonly string[]>
> = {
  items: ["reorder_point"],
  boms: ["output_quantity"],
  bom_lines: ["quantity"],
  lots: ["unit_cost"],
  stock_balances: ["on_hand", "reserved", "available", "unit_cost"],
  stock_movements: ["quantity", "unit_cost"],
  stock_counts: ["expected_quantity", "counted_quantity"],
  production_orders: [
    "target_quantity",
    "output_quantity",
    "scrap_quantity",
    "labour_cost",
    "overhead_cost",
    "material_cost",
    "total_cost",
  ],
  order_requirements: [
    "required_quantity",
    "allocated_quantity",
    "issued_quantity",
    "returned_quantity",
  ],
  allocations: ["quantity", "returned_quantity"],
  maintenance_orders: ["parts_cost"],
  maintenance_parts: ["quantity", "returned_quantity", "unit_cost"],
  lot_genealogy: ["quantity"],
  stock_report: [
    "on_hand",
    "reserved",
    "available",
    "value_tzs",
    "reorder_point",
  ],
  production_report: [
    "target_quantity",
    "output_quantity",
    "scrap_quantity",
    "material_cost",
    "labour_cost",
    "overhead_cost",
    "total_cost",
    "unit_cost",
  ],
};
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DECIMAL = /^(?:0|[1-9]\d{0,59})(?:\.\d{1,6})?$/;
const isRecord = (v: unknown): v is ManufacturingRecord =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const nonnegativeInteger = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;

export function manufacturingRecordsContext(workspaceId: string): string {
  if (!UUID.test(workspaceId))
    throw new Error("A valid Manufacturing workspace is required.");
  return `COCCE Manufacturing:${workspaceId}:v1`;
}
export function isManufacturingPage<
  T extends ManufacturingRecord = ManufacturingRecord,
>(value: unknown): value is ManufacturingPage<T> {
  if (
    !isRecord(value) ||
    !Array.isArray(value.rows) ||
    !value.rows.every(isRecord)
  )
    return false;
  if (
    !nonnegativeInteger(value.total_count) ||
    !nonnegativeInteger(value.offset) ||
    !nonnegativeInteger(value.limit)
  )
    return false;
  return (
    value.limit > 0 &&
    value.limit <= 200 &&
    value.rows.length <= value.limit &&
    typeof value.has_more === "boolean" &&
    value.has_more === value.offset + value.rows.length < value.total_count
  );
}
export function isManufacturingBootstrap(
  value: unknown,
): value is ManufacturingBootstrap {
  if (
    !isRecord(value) ||
    !MANUFACTURING_ROLES.includes(value.role as ManufacturingRole) ||
    !isRecord(value.capabilities) ||
    !isRecord(value.summary) ||
    !isRecord(value.key_config) ||
    typeof value.key_config.configured !== "boolean" ||
    !(value.settings === null || isRecord(value.settings))
  )
    return false;
  const caps = value.capabilities;
  const summary = value.summary;
  return (
    MANUFACTURING_CAPABILITIES.every((key) => typeof caps[key] === "boolean") &&
    MANUFACTURING_SUMMARY_KEYS.every((key) => nonnegativeInteger(summary[key]))
  );
}
function checkWorkspace(workspaceId: string): void {
  if (typeof workspaceId !== "string" || !UUID.test(workspaceId))
    throw new Error("A valid Manufacturing workspace is required.");
}
function checkPrivatePayload(
  payload: ManufacturingRecord,
  action: ManufacturingAction,
): void {
  if (action !== "configure_private_key" && action !== "save_supplier_private")
    return;
  for (const field of [
    "nonce",
    "ciphertext",
    ...(action === "configure_private_key" ? ["salt"] : []),
  ]) {
    if (
      typeof payload[field] !== "string" ||
      !(payload[field] as string).length ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        payload[field] as string,
      )
    ) {
      throw new Error(
        "Private Manufacturing records require a valid encrypted envelope, never plaintext.",
      );
    }
    const length = atob(payload[field] as string).length;
    if (
      (field === "nonce" && length !== 12) ||
      (field === "salt" && length !== 16) ||
      (field === "ciphertext" && (length < 16 || length > 32768))
    ) {
      throw new Error(
        "Private Manufacturing records have malformed encryption parameters.",
      );
    }
  }
}
async function rpc(
  client: ManufacturingRpcClient | SupabaseClient,
  name: string,
  params: ManufacturingRecord,
): Promise<unknown> {
  const result = await (client as ManufacturingRpcClient).rpc(name, params);
  if (result.error) {
    const error = Object.assign(new Error(result.error.message), {
      code: result.error.code,
    });
    throw error;
  }
  return result.data;
}
export const officeManufacturingManagementApi = {
  async read<T extends ManufacturingRecord = ManufacturingRecord>(
    client: ManufacturingRpcClient | SupabaseClient,
    workspaceId: string,
    resource: ManufacturingResource,
    filter: ManufacturingRecord = {},
    limit = 100,
    offset = 0,
  ): Promise<ManufacturingPage<T> | ManufacturingBootstrap> {
    checkWorkspace(workspaceId);
    if (!(MANUFACTURING_RESOURCES as readonly string[]).includes(resource))
      throw new Error("Unknown Manufacturing resource.");
    if (!isRecord(filter))
      throw new Error("Manufacturing filters must be an object.");
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 200 ||
      !nonnegativeInteger(offset) ||
      offset > 2147483647
    ) {
      throw new Error("Invalid Manufacturing pagination.");
    }
    const data = await rpc(client, "office_manufacturing_read", {
      p_workspace_id: workspaceId,
      p_resource: resource,
      p_filter: filter,
      p_limit: limit,
      p_offset: offset,
    });
    if (resource === "bootstrap") {
      if (!isManufacturingBootstrap(data))
        throw new Error(
          "Manufacturing returned malformed access data. No records were treated as empty.",
        );
      return data;
    }
    if (
      !isManufacturingPage<T>(data) ||
      data.limit !== limit ||
      data.offset !== offset
    ) {
      throw new Error("Manufacturing returned malformed record pagination.");
    }
    const fields = QUANTITY_FIELDS[resource] ?? [];
    if (
      data.rows.some((row) =>
        fields.some(
          (field) =>
            typeof row[field] !== "string" ||
            !DECIMAL.test(row[field] as string),
        ),
      )
    ) {
      throw new Error(
        "Manufacturing returned a non-exact quantity or cost. No rounded data was accepted.",
      );
    }
    return data;
  },
  async command<T extends ManufacturingRecord = ManufacturingRecord>(
    client: ManufacturingRpcClient | SupabaseClient,
    workspaceId: string,
    action: ManufacturingAction,
    payload: ManufacturingRecord,
  ): Promise<T> {
    checkWorkspace(workspaceId);
    if (
      !Object.prototype.hasOwnProperty.call(
        MANUFACTURING_COMMAND_FIELDS,
        action,
      )
    )
      throw new Error("Unknown Manufacturing action.");
    if (!isRecord(payload))
      throw new Error("Manufacturing command data must be an object.");
    const allowed: readonly string[] = [
      ...MANUFACTURING_COMMAND_FIELDS[action],
      "idempotency_key",
    ];
    if (Object.keys(payload).some((key) => !allowed.includes(key))) {
      throw new Error(
        "Manufacturing command has unsupported fields. Private identity fields must be encrypted.",
      );
    }
    if (
      typeof payload.idempotency_key !== "string" ||
      !UUID.test(payload.idempotency_key)
    )
      throw new Error("A valid Manufacturing request key is required.");
    checkPrivatePayload(payload, action);
    for (const [field, value] of Object.entries(payload)) {
      if (field.startsWith("expected_") && field.endsWith("_version")) {
        const minimum =
          action === "save_supplier_private" && field === "expected_version"
            ? 0
            : 1;
        if (!Number.isSafeInteger(value) || (value as number) < minimum)
          throw new Error("A valid current record version is required.");
      }
      if (
        [
          "reorder_point",
          "output_quantity",
          "quantity",
          "counted_quantity",
          "target_quantity",
          "unit_cost",
          "scrap_quantity",
          "labour_cost",
          "overhead_cost",
        ].includes(field)
      ) {
        const pattern = ["labour_cost", "overhead_cost"].includes(field)
          ? /^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/
          : /^(?:0|[1-9]\d{0,17})(?:\.\d{1,6})?$/;
        if (typeof value !== "string" || !pattern.test(value))
          throw new Error(
            "Manufacturing quantities and costs must be exact nonnegative decimal strings.",
          );
      }
    }
    const result = await rpc(client, "office_manufacturing_command", {
      p_workspace_id: workspaceId,
      p_action: action,
      p_payload: payload,
    });
    if (
      !isRecord(result) ||
      typeof result.id !== "string" ||
      !UUID.test(result.id) ||
      !Number.isSafeInteger(result.version) ||
      (result.version as number) < 1
    ) {
      throw new Error(
        "Manufacturing returned a malformed save confirmation. Refresh before trying again.",
      );
    }
    return result as T;
  },
};
