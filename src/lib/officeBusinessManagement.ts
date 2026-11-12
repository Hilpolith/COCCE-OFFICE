import type { SupabaseClient } from "@supabase/supabase-js";
import type { OfficeRecordsKeyConfig } from "./officePrivateRecordsCrypto";\nimport { hasControlCharacters } from "./textSafety";

export type BusinessRole =
  | "business_admin"
  | "manager"
  | "sales"
  | "operations"
  | "finance"
  | "procurement"
  | "viewer"
  | "unassigned";
export type BusinessCapabilities = Record<
  | "crm"
  | "quotes"
  | "approve_sales"
  | "delivery"
  | "finance"
  | "procurement"
  | "projects"
  | "compliance"
  | "settings"
  | "staff"
  | "private_contacts"
  | "audit",
  boolean
>;
export type BusinessRecord = Record<string, unknown>;
export interface BusinessPrivateContact extends Record<string, unknown> {
  contact_name: string;
  email: string;
  phone: string;
  address: string;
  tax_or_registration_reference: string;
}
export function normalizeBusinessPrivateContact(
  value: Record<string, unknown>,
): BusinessPrivateContact {
  const fields = {
    contact_name: 120,
    email: 160,
    phone: 40,
    address: 500,
    tax_or_registration_reference: 120,
  } as const;
  const result = {} as BusinessPrivateContact;
  for (const [field, max] of Object.entries(fields)) {
    const text = value[field] ?? "";
    if (
      typeof text !== "string" ||
      text.length > max ||
      /[\u0000-\u001f\u007f]/.test(text)
    )
      throw new Error("Private contact fields are invalid or too long.");
    result[field] = text.trim();
  }
  if (result.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email))
    throw new Error("Enter a valid private contact email address.");
  return result;
}
export interface BusinessBootstrap {
  role: BusinessRole;
  settings: BusinessRecord | null;
  key_config: OfficeRecordsKeyConfig;
  capabilities: BusinessCapabilities;
  summary: Record<string, unknown>;
}
export interface BusinessCommandResult extends Record<string, unknown> {
  entity_id: string | null;
  version: number | null;
}
export interface BusinessRpcClient {
  rpc(
    name: string,
    params?: Record<string, unknown>,
  ): Promise<{ data: unknown; error: { message: string } | null }>;
}
export const BUSINESS_RESOURCES = [
  "bootstrap",
  "settings",
  "key_config",
  "account_private",
  "accounts",
  "opportunities",
  "activities",
  "quotations",
  "quotation_lines",
  "sales_orders",
  "sales_order_lines",
  "deliveries",
  "delivery_lines",
  "invoices",
  "invoice_lines",
  "receipts",
  "suppliers",
  "purchase_orders",
  "purchase_order_lines",
  "receivings",
  "receiving_lines",
  "projects",
  "milestones",
  "service_cases",
  "compliance_followups",
  "staff",
  "audit",
] as const;
export type BusinessResource = (typeof BUSINESS_RESOURCES)[number];
export const BUSINESS_ACTIONS = [
  "configure_contact_key",
  "save_account_private",
  "save_business_settings",
  "set_staff_role",
  "save_account",
  "save_opportunity",
  "transition_opportunity",
  "save_activity",
  "complete_activity",
  "save_quotation",
  "save_quotation_line",
  "delete_quotation_line",
  "issue_quotation",
  "accept_quotation",
  "reject_quotation",
  "cancel_quotation",
  "expire_quotation",
  "save_delivery",
  "post_delivery",
  "save_invoice",
  "save_invoice_line",
  "delete_invoice_line",
  "issue_invoice",
  "void_invoice",
  "record_receipt",
  "save_supplier",
  "save_purchase_order",
  "save_purchase_order_line",
  "delete_purchase_order_line",
  "issue_purchase_order",
  "save_receiving",
  "post_receiving",
  "save_project",
  "transition_project",
  "save_milestone",
  "transition_milestone",
  "save_service_case",
  "transition_service_case",
  "save_compliance_followup",
  "complete_compliance_followup",
] as const;
export type BusinessAction = (typeof BUSINESS_ACTIONS)[number];
export function businessRecordsContext(workspaceId: string): string {
  if (
    !workspaceId ||
    workspaceId.length > 128 ||
    workspaceId.trim() !== workspaceId
  )
    throw new Error("A valid Business workspace is required.");
  return `COCCE Business:${workspaceId}:v1`;
}
function jsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function rpc<T>(
  client: BusinessRpcClient | SupabaseClient,
  name: string,
  params: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await (client as BusinessRpcClient).rpc(name, params);
  if (error) throw new Error(error.message);
  return data as T;
}
export const officeBusinessManagementApi = {
  read<T = unknown>(
    client: BusinessRpcClient | SupabaseClient,
    workspaceId: string,
    resource: BusinessResource,
    filter: Record<string, unknown> = {},
    limit = 100,
    offset = 0,
  ): Promise<T> {
    if (!(BUSINESS_RESOURCES as readonly string[]).includes(resource))
      return Promise.reject(new Error("Unknown Business resource."));
    if (!jsonObject(filter))
      return Promise.reject(new Error("Business filters must be an object."));
    return rpc<T>(client, "office_business_read", {
      p_workspace_id: workspaceId,
      p_resource: resource,
      p_filter: filter,
      p_limit: Number.isFinite(limit)
        ? Math.max(1, Math.min(200, Math.trunc(limit)))
        : 100,
      p_offset: Number.isFinite(offset)
        ? Math.max(0, Math.min(2147483647, Math.trunc(offset)))
        : 0,
    });
  },
  command<T extends Record<string, unknown> = BusinessCommandResult>(
    client: BusinessRpcClient | SupabaseClient,
    workspaceId: string,
    action: BusinessAction,
    payload: Record<string, unknown>,
  ): Promise<T> {
    if (!(BUSINESS_ACTIONS as readonly string[]).includes(action))
      return Promise.reject(new Error("Unknown Business action."));
    if (!jsonObject(payload))
      return Promise.reject(
        new Error("Business command data must be an object."),
      );
    if (
      action === "save_account_private" ||
      action === "configure_contact_key"
    ) {
      const allowed =
        action === "save_account_private"
          ? [
              "account_id",
              "nonce",
              "ciphertext",
              "expected_version",
              "idempotency_key",
            ]
          : ["salt", "nonce", "ciphertext", "idempotency_key"];
      if (Object.keys(payload).some((key) => !allowed.includes(key)))
        return Promise.reject(
          new Error(
            "Only encrypted private-contact data may be sent to the Business service.",
          ),
        );
    }
    return rpc<T>(client, "office_business_command", {
      p_workspace_id: workspaceId,
      p_action: action,
      p_payload: payload,
    });
  },
};
