import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FormEvent, ReactNode } from "react";
import {
  type ManufacturingAction,
  type ManufacturingCapabilities,
  type ManufacturingRecord,
  type ManufacturingResource,
} from "./lib/officeManufacturingManagement";
import { normalizeMoney } from "./lib/officeMoney";
import { normalizeQuantity } from "./lib/officeQuantity";

type Page = {
  rows: ManufacturingRecord[];
  total_count: number;
  offset: number;
  limit: number;
  has_more: boolean;
};
export type ManufacturingOperationFormsContextValue = {
  data: Record<string, ManufacturingRecord[]>;
  pages: Record<string, Page>;
  readPage: (
    resource: ManufacturingResource,
    filter?: ManufacturingRecord,
    offset?: number,
  ) => Promise<Page | null>;
  readFreshPage?: (
    resource: ManufacturingResource,
    filter?: ManufacturingRecord,
    offset?: number,
  ) => Promise<Page | null>;
  capabilities: ManufacturingCapabilities | null;
  refreshToken: number;
};
export const ManufacturingOperationFormsContext =
  createContext<ManufacturingOperationFormsContextValue | null>(null);
export function ManufacturingOperationFormsProvider({
  value,
  children,
}: {
  value: ManufacturingOperationFormsContextValue;
  children: ReactNode;
}) {
  return (
    <ManufacturingOperationFormsContext.Provider value={value}>
      {children}
    </ManufacturingOperationFormsContext.Provider>
  );
}

export type ManufacturingOperationFormProps = {
  action: ManufacturingAction;
  title: string;
  fields: string[];
  command: (
    action: ManufacturingAction,
    payload: ManufacturingRecord,
    success?: string,
  ) => Promise<ManufacturingRecord>;
  busy: boolean;
};
export type ManufacturingRecordPickerProps = {
  resource: ManufacturingResource;
  name: string;
  label: string;
  value: string;
  onChange: (value: string, record?: ManufacturingRecord) => void;
  required?: boolean;
  filter?: ManufacturingRecord;
  disabled?: boolean;
  allowBlank?: boolean;
};

const capabilityForAction: Record<
  ManufacturingAction,
  keyof ManufacturingCapabilities
> = {
  save_settings: "settings",
  assign_staff_role: "staff",
  configure_private_key: "private_records",
  save_item: "masters",
  save_supplier: "masters",
  save_supplier_private: "private_records",
  save_location: "masters",
  save_asset: "masters",
  save_bom: "masters",
  save_bom_line: "masters",
  delete_bom_line: "masters",
  activate_bom: "masters",
  retire_bom: "masters",
  receive_stock: "inventory_receive",
  transfer_stock: "inventory_move",
  dispatch_stock: "inventory_move",
  scrap_stock: "inventory_move",
  submit_stock_count: "stock_count",
  review_stock_count: "stock_approve",
  save_production_order: "planning",
  allocate_material: "planning",
  remove_allocation: "planning",
  release_production_order: "planning",
  start_production_order: "production",
  pause_production_order: "production",
  resume_production_order: "production",
  return_production_material: "production",
  record_production_output: "production",
  cancel_production_order: "planning",
  record_lot_inspection: "quality",
  hold_lot: "quality",
  save_maintenance_order: "maintenance",
  transition_maintenance_order: "maintenance",
  issue_maintenance_part: "maintenance",
  return_maintenance_part: "maintenance",
  save_compliance_record: "compliance",
  transition_compliance_record: "compliance",
  link_evidence: "evidence",
  supersede_evidence: "evidence",
};

const idResource: Partial<Record<ManufacturingAction, ManufacturingResource>> =
  {
    save_settings: "settings",
    assign_staff_role: "staff_roles",
    save_item: "items",
    save_supplier: "suppliers",
    save_supplier_private: "supplier_private",
    save_location: "locations",
    save_asset: "assets",
    save_bom: "boms",
    save_bom_line: "bom_lines",
    delete_bom_line: "bom_lines",
    remove_allocation: "allocations",
    activate_bom: "boms",
    retire_bom: "boms",
    review_stock_count: "stock_counts",
    save_production_order: "production_orders",
    release_production_order: "production_orders",
    start_production_order: "production_orders",
    pause_production_order: "production_orders",
    resume_production_order: "production_orders",
    return_production_material: "allocations",
    record_production_output: "production_orders",
    cancel_production_order: "production_orders",
    record_lot_inspection: "lots",
    hold_lot: "lots",
    save_maintenance_order: "maintenance_orders",
    transition_maintenance_order: "maintenance_orders",
    return_maintenance_part: "maintenance_parts",
    save_compliance_record: "compliance_records",
    transition_compliance_record: "compliance_records",
    supersede_evidence: "evidence",
  };
const resourceForField: Partial<Record<string, ManufacturingResource>> = {
  item_id: "items",
  product_id: "items",
  bom_id: "boms",
  order_id: "production_orders",
  lot_id: "lots",
  location_id: "locations",
  from_location_id: "locations",
  to_location_id: "locations",
  output_location_id: "locations",
  asset_id: "assets",
  supplier_id: "suppliers",
  user_id: "staff_roles",
  maintenance_id: "maintenance_orders",
  target_id: "lots",
  target_idempotency: "lots",
};
const labels: Record<string, string> = {
  expected_version: "Current version",
  expected_parent_version: "Parent version",
  expected_balance_version: "Stock balance version",
  item_id: "Item",
  product_id: "Finished product",
  bom_id: "Bill of materials",
  order_id: "Production order",
  lot_id: "Lot",
  location_id: "Location",
  from_location_id: "From location",
  to_location_id: "To location",
  output_location_id: "Output location",
  maintenance_id: "Maintenance order",
  asset_id: "Asset",
  supplier_id: "Supplier",
  user_id: "Staff member",
  quantity: "Quantity",
  counted_quantity: "Counted quantity",
  output_quantity: "Output quantity",
  target_quantity: "Target quantity",
  reorder_point: "Reorder point",
  unit_cost: "Unit cost (TZS)",
  labour_cost: "Labour cost (TZS)",
  overhead_cost: "Overhead cost (TZS)",
  return_to_service: "Return asset to service",
  external_url: "HTTPS evidence URL",
};
const human = (key: string) =>
  labels[key] ??
  key.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Dar_es_Salaam" });
const uuid = () =>
  globalThis.crypto?.randomUUID?.() ?? "00000000-0000-4000-8000-000000000000";
const isVersion = (key: string) =>
  key === "expected_version" ||
  key === "expected_parent_version" ||
  key === "expected_balance_version";
const isMoney = (key: string) =>
  ["unit_cost", "labour_cost", "overhead_cost"].includes(key);
const isQuantity = (key: string) =>
  [
    "quantity",
    "counted_quantity",
    "output_quantity",
    "target_quantity",
    "scrap_quantity",
    "reorder_point",
  ].includes(key);
const isDate = (key: string) => key.endsWith("_date") || key === "due_date";
const optionalFields = new Set([
  "supplier_id",
  "supplier_lot",
  "expiry_date",
  "reference",
  "customer_reference",
  "waste_reference",
  "reason",
  "notes",
  "permit_reference",
  "external_reference",
  "action_notes",
  "standard_reference",
  "observations",
  "work_notes",
  "external_url",
  "file_id",
  "revision_id",
  "batch_code",
  "scrap_quantity",
  "asset_id",
  "next_service_date",
  "return_to_service",
  "id",
  "expected_version",
  "expected_parent_version",
  "expected_balance_version",
]);
function recordLabel(record: ManufacturingRecord) {
  return String(
    record.code ??
      record.sku ??
      record.asset_code ??
      record.order_code ??
      record.work_code ??
      record.bom_code ??
      record.batch_code ??
      record.supplier_code ??
      record.display_label ??
      record.name ??
      record.record_code ??
      record.evidence_code ??
      record.id ??
      "Record",
  );
}
function stableFilter(filter: ManufacturingRecord) {
  return JSON.stringify(filter ?? {});
}

export function ManufacturingRecordPicker({
  resource,
  name,
  label,
  value,
  onChange,
  required,
  filter = {},
  disabled,
  allowBlank = false,
}: ManufacturingRecordPickerProps) {
  const context = useContext(ManufacturingOperationFormsContext);
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [rows, setRows] = useState<ManufacturingRecord[]>([]);
  const [page, setPage] = useState<Page | null>(null);
  const [selected, setSelected] = useState<ManufacturingRecord>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const notified = useRef("");
  const filterKey = stableFilter(filter);
  const load = useCallback(
    async (nextOffset = 0, q = query) => {
      if (!context) return;
      const token = ++epoch.current;
      setLoading(true);
      setError("");
      try {
        const result = await (context.readFreshPage ?? context.readPage)(
          resource,
          { ...filter, ...(q.trim() ? { q: q.trim() } : {}) },
          nextOffset,
        );
        if (token !== epoch.current || !result) return;
        setPage(result);
        setRows(result.rows);
        setOffset(result.offset);
      } catch (caught) {
        if (token === epoch.current)
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load records.",
          );
      } finally {
        if (token === epoch.current) setLoading(false);
      }
    },
    [context, filterKey, query, resource],
  );
  useEffect(() => {
    void load(0, "");
    return () => {
      epoch.current += 1;
    };
  }, [context?.refreshToken, resource, filterKey]);
  useEffect(() => {
    if (!value || !context) {
      setSelected(undefined);
      return;
    }
    const local =
      rows.find((row) => String(row.id) === value) ??
      context.data[resource]?.find((row) => String(row.id) === value);
    if (local) setSelected(local);
    let live = true;
    void (context.readFreshPage ?? context.readPage)(resource, { id: value }, 0)
      .then((result) => {
        if (live && (result?.rows[0] ?? local)) {
          const record = result?.rows[0] ?? local!;
          setSelected(record);
          const signature = `${value}:${String(record.version ?? "")}`;
          if (notified.current !== signature) {
            notified.current = signature;
            onChange(value, record);
          }
        }
      })
      .catch((caught) => {
        if (live)
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load the selected record.",
          );
      });
    return () => {
      live = false;
    };
  }, [context, context?.refreshToken, resource, value, rows]);
  return (
    <div className="manufacturing-field">
      <label htmlFor={`${name}-picker`}>
        {label}
        {required ? " *" : ""}
      </label>
      <div className="manufacturing-action-row">
        <input
          aria-label={`${label} search`}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={`Search ${label.toLowerCase()}`}
          disabled={disabled || loading}
        />
        <button
          type="button"
          className="manufacturing-button"
          onClick={() => void load(0)}
          disabled={disabled || loading}
        >
          Search
        </button>
      </div>
      <select
        id={`${name}-picker`}
        name={name}
        aria-label={label}
        value={value}
        required={required}
        disabled={disabled || loading}
        onChange={(event) => {
          const next = rows.find(
            (row) => String(row.id) === event.currentTarget.value,
          );
          setSelected(next);
          onChange(event.currentTarget.value, next);
        }}
      >
        <option value="">
          {allowBlank
            ? `No ${label.toLowerCase()}`
            : `Select ${label.toLowerCase()}`}
        </option>
        {value && !rows.some((row) => String(row.id) === value) && selected && (
          <option value={value}>
            {recordLabel(selected)} · current selection
          </option>
        )}
        {rows.map((row) => (
          <option key={String(row.id)} value={String(row.id)}>
            {recordLabel(row)}
            {row.status ? ` · ${String(row.status)}` : ""}
          </option>
        ))}
      </select>
      {error && (
        <small className="manufacturing-alert" role="alert">
          {error}
        </small>
      )}
      <small className="manufacturing-muted">
        {loading
          ? "Loading records…"
          : page && page.total_count > page.limit
            ? `${page.offset + 1}–${page.offset + rows.length} of ${page.total_count}`
            : selected
              ? `Selected: ${recordLabel(selected)}`
              : ""}
      </small>
      {page && page.total_count > page.limit && (
        <span className="manufacturing-action-row">
          <button
            type="button"
            className="manufacturing-button"
            disabled={loading || offset === 0}
            onClick={() => void load(Math.max(0, offset - page.limit))}
          >
            Previous
          </button>
          <button
            type="button"
            className="manufacturing-button"
            disabled={loading || !page.has_more}
            onClick={() => void load(offset + page.limit)}
          >
            Next
          </button>
        </span>
      )}
    </div>
  );
}

function defaultValue(action: ManufacturingAction, field: string) {
  if (field === "status") {
    if (["save_item", "save_supplier", "save_location"].includes(action))
      return "active";
    if (action === "save_asset") return "operational";
    if (action === "save_bom") return "draft";
    return "";
  }
  if (field === "kind") {
    if (action === "save_item") return "raw_material";
    if (action === "save_bom") return "standard";
    if (action === "save_maintenance_order") return "preventive";
  }
  if (field === "priority") return "routine";
  if (
    field === "reorder_point" ||
    field === "unit_cost" ||
    field === "labour_cost" ||
    field === "overhead_cost" ||
    field === "scrap_quantity" ||
    field === "downtime_minutes"
  )
    return "0";
  if (field === "received_date") return today();
  return "";
}
function choicesFor(
  action: ManufacturingAction,
  field: string,
  current?: string,
) {
  const fixed: Record<string, string[]> = {
    jurisdiction: ["tanzania_mainland", "zanzibar", "other"],
    role: [
      "manufacturing_admin",
      "production_planner",
      "storekeeper",
      "production_operator",
      "quality_reviewer",
      "maintenance_engineer",
      "safety_officer",
      "manufacturing_viewer",
      "unassigned",
    ],
    kind:
      action === "save_item"
        ? ["raw_material", "component", "finished_good", "consumable"]
        : action === "save_bom"
          ? ["standard", "rework"]
          : ["preventive", "corrective"],
    status:
      action === "save_asset"
        ? ["operational", "maintenance", "out_of_service"]
        : ["active", "archived"],
    decision: ["approve", "reject"],
    result: ["pass", "hold", "reject", "rework"],
    priority: ["routine", "high", "critical"],
    authority: ["OSHA", "TBS", "NEMC", "BRELA", "TRA_ETS", "internal", "other"],
    severity: ["routine", "high", "critical"],
    record_type: [
      "permit",
      "certificate",
      "inspection",
      "risk",
      "incident",
      "waste_action",
    ],
    target_type: [
      "lot",
      "production_order",
      "maintenance_order",
      "compliance_record",
    ],
  };
  if (field === "status" && action === "transition_maintenance_order") {
    const transitions: Record<string, string[]> = {
      open: ["scheduled", "in_progress", "cancelled"],
      scheduled: ["in_progress", "cancelled"],
      in_progress: ["awaiting_parts", "completed"],
      awaiting_parts: ["in_progress"],
      completed: ["verified", "in_progress"],
    };
    return transitions[current ?? ""] ?? [];
  }
  if (field === "status" && action === "transition_compliance_record") {
    const transitions: Record<string, string[]> = {
      open: ["in_progress", "closed"],
      in_progress: ["pending_verification", "closed"],
      pending_verification: ["closed", "in_progress"],
      closed: ["in_progress"],
    };
    return transitions[current ?? ""] ?? [];
  }
  return fixed[field];
}
function idForAction(action: ManufacturingAction) {
  return idResource[action];
}
function parentSpec(
  action: ManufacturingAction,
): { field: string; resource: ManufacturingResource } | null {
  if (action === "save_bom_line") return { field: "bom_id", resource: "boms" };
  if (action === "allocate_material")
    return { field: "order_id", resource: "production_orders" };
  if (action === "issue_maintenance_part")
    return { field: "maintenance_id", resource: "maintenance_orders" };
  return null;
}
function parentFromChild(
  action: ManufacturingAction,
  child: ManufacturingRecord,
): { field: string; resource: ManufacturingResource; id: unknown } | null {
  if (action === "delete_bom_line")
    return { field: "bom_id", resource: "boms", id: child.bom_id };
  if (action === "remove_allocation" || action === "return_production_material")
    return {
      field: "order_id",
      resource: "production_orders",
      id: child.order_id,
    };
  if (action === "return_maintenance_part")
    return {
      field: "maintenance_id",
      resource: "maintenance_orders",
      id: child.maintenance_id,
    };
  return null;
}

export default function ManufacturingOperationForm({
  action,
  title,
  fields,
  command,
  busy,
}: ManufacturingOperationFormProps) {
  const context = useContext(ManufacturingOperationFormsContext);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      fields
        .filter((field) => !isVersion(field) && field !== "id")
        .map((field) => [field, defaultValue(action, field)]),
    ),
  );
  const [selectedRecords, setSelectedRecords] = useState<
    Record<string, ManufacturingRecord>
  >({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const epoch = useRef(0);
  const attempt = useRef<{ signature: string; key: string } | undefined>(
    undefined,
  );
  const mounted = useRef(true);
  const actionFields = useMemo(
    () => fields.filter((field) => field !== "id" && !isVersion(field)),
    [fields],
  );
  const capability = capabilityForAction[action];
  const allowed =
    context !== null &&
    context.capabilities !== null &&
    context.capabilities[capability] === true;
  const setValue = (field: string, value: string) => {
    setValues((old) => {
      if (old[field] === value) return old;
      epoch.current += 1;
      attempt.current = undefined;
      return { ...old, [field]: value };
    });
  };
  useEffect(() => {
    epoch.current += 1;
    setValues(
      Object.fromEntries(
        fields
          .filter((field) => field !== "id" && !isVersion(field))
          .map((field) => [field, defaultValue(action, field)]),
      ),
    );
    setSelectedRecords({});
    setMessage("");
    setError("");
    attempt.current = undefined;
  }, [action, fields.join("|")]);
  useEffect(() => {
    if (action !== "save_settings" || !context) return;
    const settings = context.data.settings?.[0];
    if (!settings) return;
    setSelectedRecords((old) => ({ ...old, id: settings }));
    setValues((old) => ({
      ...old,
      id: settings.id === undefined ? "" : String(settings.id),
      ...Object.fromEntries(
        actionFields.map((field) => [
          field,
          settings[field] === undefined || settings[field] === null
            ? (old[field] ?? "")
            : String(settings[field]),
        ]),
      ),
    }));
  }, [action, actionFields, context]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      epoch.current += 1;
      attempt.current = undefined;
    };
  }, []);
  const hydrate = useCallback(
    (field: string, id: string, record?: ManufacturingRecord) => {
      setValue(field, id);
      if (record) {
        setSelectedRecords((old) => ({ ...old, [field]: record }));
        if (field === "id") {
          setValues((old) => {
            if (old.id === id && selectedRecords.id) return old;
            return {
              ...old,
              ...Object.fromEntries(
                actionFields.map((key) => [
                  key,
                  record[key] === undefined || record[key] === null
                    ? ""
                    : String(record[key]),
                ]),
              ),
              id,
            };
          });
        }
      }
    },
    [actionFields, selectedRecords],
  );
  const parent = parentSpec(action);
  const parentId = parent ? values[parent.field] : "";
  useEffect(() => {
    if (!parent || !parentId || !context) return;
    const record = selectedRecords[parent.field];
    if (record?.version !== undefined)
      setValues((old) =>
        old.expected_parent_version === String(record.version)
          ? old
          : { ...old, expected_parent_version: String(record.version) },
      );
  }, [action, context, parent?.field, parentId, selectedRecords]);
  if (!allowed) return null;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = ++epoch.current;
    setError("");
    setMessage("");
    setSending(true);
    try {
      if (!context) throw new Error("Manufacturing access is unavailable.");
      const read = context.readFreshPage ?? context.readPage;
      const form = new FormData(event.currentTarget);
      const payload: ManufacturingRecord = {};
      for (const field of fields) {
        const value = String(form.get(field) ?? "").trim();
        if (field === "id" || isVersion(field) || value === "") continue;
        payload[field] = isQuantity(field)
          ? normalizeQuantity(value)
          : isMoney(field)
            ? normalizeMoney(value)
            : field === "downtime_minutes"
              ? Number(value)
              : field === "return_to_service"
                ? value === "true"
                : value;
      }
      const logicalSignature = JSON.stringify(payload);
      const requestKey =
        attempt.current?.signature === logicalSignature
          ? attempt.current.key
          : uuid();
      attempt.current = { signature: logicalSignature, key: requestKey };
      payload.idempotency_key = requestKey;
      if (action === "record_lot_inspection" || action === "hold_lot") {
        const lotId = String(payload.lot_id ?? "");
        const lotPage = await read("lots", { id: lotId }, 0);
        const lot = lotPage?.rows[0];
        if (!lot || !Number.isSafeInteger(lot.version))
          throw new Error(
            "The current lot is not loaded. Refresh and select it again.",
          );
        payload.expected_version = Number(lot.version);
      }
      const selectedId = values.id;
      if (selectedId) {
        let record: ManufacturingRecord | undefined = selectedRecords.id;
        if (!record?.version || !Number.isSafeInteger(record.version)) {
          const resource = idForAction(action);
          if (!resource)
            throw new Error("This action cannot edit a selected record.");
          const page = await read(resource, { id: selectedId }, 0);
          record = page?.rows.find((row) => String(row.id) === selectedId);
        }
        if (token !== epoch.current) return;
        if (
          !record ||
          !Number.isSafeInteger(record.version) ||
          Number(record.version) < 1
        )
          throw new Error(
            "Refresh and select the current record before editing it.",
          );
        payload.id = selectedId;
        payload.expected_version = Number(record.version);
      }
      const childId = values.id;
      if (childId && !parentSpec(action)) {
        const childResource = idForAction(action);
        if (
          childResource &&
          [
            "delete_bom_line",
            "remove_allocation",
            "return_production_material",
            "return_maintenance_part",
          ].includes(action)
        ) {
          const childPage = await read(childResource, { id: childId }, 0);
          const child = childPage?.rows[0];
          const relation = child ? parentFromChild(action, child) : null;
          if (!relation?.id)
            throw new Error(
              "The selected child record is not loaded. Refresh and select it again.",
            );
          const parentPage = await read(
            relation.resource,
            { id: String(relation.id) },
            0,
          );
          const parent = parentPage?.rows[0];
          if (!parent || !Number.isSafeInteger(parent.version))
            throw new Error(
              "The current parent record is not loaded. Refresh and select it again.",
            );
          payload.expected_parent_version = Number(parent.version);
        }
      }
      const spec = parentSpec(action);
      if (spec) {
        const id = values[spec.field];
        let parent: ManufacturingRecord | undefined =
          selectedRecords[spec.field];
        if (!parent?.version && id) {
          const page = await read(spec.resource, { id }, 0);
          parent = page?.rows[0];
        }
        if (!parent || !Number.isSafeInteger(parent.version))
          throw new Error(
            "The current parent record is still loading. Select it again before submitting.",
          );
        payload.expected_parent_version = Number(parent.version);
      }
      if (
        [
          "allocate_material",
          "issue_maintenance_part",
          "transfer_stock",
          "dispatch_stock",
          "scrap_stock",
          "submit_stock_count",
        ].includes(action)
      ) {
        const lot = String(payload.lot_id ?? "");
        const location =
          action === "transfer_stock"
            ? String(payload.from_location_id ?? "")
            : String(payload.location_id ?? "");
        if (!lot || !location)
          throw new Error(
            "Select the lot and stock location before submitting.",
          );
        const page = await read(
          "stock_balances",
          { lot_id: lot, location_id: location },
          0,
        );
        const balance = page?.rows[0];
        if (!balance || !Number.isSafeInteger(balance.version))
          throw new Error(
            "The current stock balance is not loaded. Refresh and select it again.",
          );
        payload.expected_balance_version = Number(balance.version);
      }
      if (token !== epoch.current) return;
      const result = await command(action, payload, `${title} saved.`);
      if (token !== epoch.current) return;
      attempt.current = undefined;
      if (result && result.id !== undefined && result.version !== undefined) {
        const id = String(result.id);
        setValues((old) => ({ ...old, id }));
        setSelectedRecords((old) => ({
          ...old,
          id: { ...(old.id ?? {}), id, version: result.version },
        }));
      }
      setMessage(`${title} saved.`);
    } catch (caught) {
      const code =
        typeof caught === "object" && caught !== null && "code" in caught
          ? String((caught as { code?: unknown }).code ?? "")
          : "";
      if (/^(22|23|42|P0|55|425)/.test(code)) attempt.current = undefined;
      if (token === epoch.current)
        setError(
          caught instanceof Error
            ? caught.message
            : "Manufacturing request failed.",
        );
    } finally {
      if (token === epoch.current && mounted.current) setSending(false);
    }
  };
  return (
    <section
      className="manufacturing-card"
      aria-labelledby={`manufacturing-${action}`}
    >
      <header className="manufacturing-card-head">
        <h3 id={`manufacturing-${action}`}>{title}</h3>
      </header>
      {error && (
        <div className="manufacturing-alert" role="alert">
          {error}
        </div>
      )}
      {message && (
        <div className="manufacturing-alert" role="status">
          {message}
        </div>
      )}
      <form className="manufacturing-form" onSubmit={submit}>
        {fields.includes("id") && (
          <ManufacturingRecordPicker
            resource={idForAction(action) ?? "items"}
            name="id"
            label="Existing record"
            value={values.id ?? ""}
            onChange={(value, record) => hydrate("id", value, record)}
            allowBlank={action.startsWith("save_")}
            disabled={busy || sending}
          />
        )}
        {actionFields.map((field) => {
          const resource = resourceForField[field];
          const required = !optionalFields.has(field);
          if (resource)
            return (
              <ManufacturingRecordPicker
                key={field}
                resource={resource}
                name={field}
                label={human(field)}
                value={values[field] ?? ""}
                onChange={(value, record) => hydrate(field, value, record)}
                required={required}
                disabled={busy || sending}
              />
            );
          const choices = choicesFor(
            action,
            field,
            String(selectedRecords.id?.status ?? values.status ?? ""),
          );
          const isBool = field === "return_to_service";
          return (
            <label className="manufacturing-field" key={field}>
              <span>
                {human(field)}
                {required ? " *" : ""}
              </span>
              {choices ? (
                <select
                  name={field}
                  value={values[field] ?? ""}
                  required={required}
                  disabled={busy || sending}
                  onChange={(event) =>
                    setValue(field, event.currentTarget.value)
                  }
                >
                  <option value="">Select {human(field).toLowerCase()}</option>
                  {choices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice.replaceAll("_", " ")}
                    </option>
                  ))}
                </select>
              ) : isBool ? (
                <select
                  name={field}
                  value={values[field] ?? ""}
                  disabled={busy || sending}
                  onChange={(event) =>
                    setValue(field, event.currentTarget.value)
                  }
                >
                  <option value="">Not specified</option>
                  <option value="true">Yes</option>
                  <option value="false">No</option>
                </select>
              ) : (
                <input
                  name={field}
                  type={isDate(field) ? "date" : "text"}
                  inputMode={
                    isQuantity(field) || isMoney(field) ? "decimal" : undefined
                  }
                  value={values[field] ?? ""}
                  required={required}
                  disabled={busy || sending}
                  onChange={(event) =>
                    setValue(field, event.currentTarget.value)
                  }
                />
              )}
            </label>
          );
        })}
        <button
          type="submit"
          className="manufacturing-button primary"
          disabled={busy || sending}
        >
          {busy || sending ? "Saving…" : title}
        </button>
      </form>
    </section>
  );
}
