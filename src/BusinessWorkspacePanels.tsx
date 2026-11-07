import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type {
  BusinessAction,
  BusinessCapabilities,
  BusinessRecord,
  BusinessResource,
} from "./lib/officeBusinessManagement";
import type { BusinessWorkspacePanelsProps } from "./lib/businessWorkspaceUi";
import BusinessDocumentDownloads from "./BusinessDocumentDownloads";
import BusinessReasonDialog from "./BusinessReasonDialog";
import "./businessWorkspacePanels.css";

type Row = BusinessRecord;
type FormMap = Record<string, string>;
type ReasonState = {
  action: BusinessAction;
  id: string;
  version: number;
  label: string;
} | null;

const empty = (): FormMap => ({});
const id = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
const text = (row: Row | undefined, key: string, fallback = "—") =>
  row?.[key] == null || row[key] === "" ? fallback : String(row[key]);
const status = (v: unknown) =>
  String(v ?? "recorded")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (x) => x.toUpperCase());
const RESOURCE_PK: Partial<Record<BusinessResource, string>> = {
  accounts: "account_id", opportunities: "opportunity_id", activities: "activity_id",
  quotations: "quote_id", quotation_lines: "line_id", sales_orders: "order_id",
  sales_order_lines: "order_line_id", deliveries: "delivery_id", delivery_lines: "delivery_line_id",
  invoices: "invoice_id", invoice_lines: "invoice_line_id", receipts: "receipt_id",
  suppliers: "supplier_id", purchase_orders: "supplier_order_id", purchase_order_lines: "po_line_id",
  receivings: "receiving_id", receiving_lines: "receiving_line_id", projects: "project_id",
  milestones: "milestone_id", service_cases: "case_id", compliance_followups: "followup_id",
};
const firstId = (row: Row, keys: string[]) => keys.map((k) => row[k]).find((v) => v != null) as string | undefined;
const dateTimeToIso = (value: string) => value && !/[zZ]|[+-]\d\d:\d\d$/.test(value) ? new Date(value).toISOString() : value;
const editableStatus = (resource: BusinessResource, row: Row) => {
  const state = String(row.status ?? "");
  if (["audit", "receipts", "staff", "sales_orders", "delivery_lines", "receiving_lines"].includes(resource)) return false;
  if (["issued", "accepted", "rejected", "cancelled", "expired", "void", "voided", "posted", "delivered", "received", "completed", "closed", "resolved", "won", "lost"].includes(state)) return false;
  return resource === "accounts" || resource === "opportunities" || resource === "activities" || resource === "quotations" || resource === "invoices" || resource === "suppliers" || resource === "purchase_orders" || resource === "receivings" || resource === "deliveries" || resource === "projects" || resource === "milestones" || resource === "service_cases" || resource === "compliance_followups";
};
const activeMembers = (members: BusinessWorkspacePanelsProps["members"]) =>
  members.filter((m) => m.status === "active");
const display = (row: Row) => {
  const names = ["display_name", "name", "title", "subject", "legal_name", "quote_number", "invoice_number", "order_number", "po_number", "delivery_number", "receiving_number", "case_number", "reference", "public_reference", "description"];
  for (const key of names) if (row[key] != null && String(row[key]).trim()) return String(row[key]);
  return row.action ? status(row.action) : "Record";
};
const money = (r: Row) =>
  r.grand_total ??
  r.line_total ??
  r.estimated_amount ??
  r.amount ??
  r.outstanding_total;

function Input({
  label,
  value,
  onChange,
  type = "text",
  required = false,
  step,
  min,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  required?: boolean;
  step?: string;
  min?: string;
}) {
  return (
    <label className="business-panel-field">
      {label}
      <input
        aria-label={label}
        type={type}
        required={required}
        step={step ?? (type === "number" ? "any" : undefined)}
        min={min}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
function Select({
  label,
  value,
  onChange,
  options,
  required = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: string[];
  required?: boolean;
}) {
  return (
    <label className="business-panel-field">
      {label}
      <select
        aria-label={label}
        required={required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose…</option>
        {options.map((x) => (
          <option key={x} value={x}>
            {status(x)}
          </option>
        ))}
      </select>
    </label>
  );
}
function Button({
  children,
  onClick,
  primary = false,
  disabled = false,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  primary?: boolean;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`business-panel-button ${primary ? "primary" : ""}`}
    >
      {children}
    </button>
  );
}

export default function BusinessWorkspacePanels(
  props: BusinessWorkspacePanelsProps,
) {
  const {
    tab,
    data,
    capabilities: cap,
    role,
    settings,
    members,
    busy,
    hasMore,
    loadingMore,
    loadMore,
    readRows,
    command,
    reportError,
    privateContacts,
    onNavigate,
    officeName,
  } = props;
  const [forms, setForms] = useState<Record<string, FormMap>>({});
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [lines, setLines] = useState<Record<string, Row[]>>({});
  const [lineForms, setLineForms] = useState<Record<string, FormMap>>({});
  const [reason, setReason] = useState<ReasonState>(null);
  const [query, setQuery] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const childEpoch = useRef<Record<string, number>>({});
  const editEpoch = useRef(0);
  const [loadingEdit, setLoadingEdit] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      editEpoch.current += 1;
      for (const key of Object.keys(childEpoch.current)) childEpoch.current[key] += 1;
    };
  }, []);
  const can = (name: keyof BusinessCapabilities) => !!cap[name];
  const write = (name: keyof BusinessCapabilities) =>
    can(name) && role !== "viewer";
  const defaultCurrency = text(settings ?? undefined, "default_currency_code", "TZS");
  const formDefaults: Record<string, FormMap> = {
    account: { account_type: "customer", status: "active" },
    opportunity: { currency_code: defaultCurrency, probability_percent: "0" },
    quote: { currency_code: defaultCurrency }, invoice: { currency_code: defaultCurrency },
    supplier: { status: "active" }, po: { currency_code: defaultCurrency },
    case: { priority: "normal" },
    settings: { display_label: text(settings ?? undefined, "display_label", officeName), default_currency_code: defaultCurrency, quote_validity_days: text(settings ?? undefined, "quote_validity_days", "30"), invoice_due_days: text(settings ?? undefined, "invoice_due_days", "30") },
  };
  const form = (name: string) => ({ ...formDefaults[name], ...forms[name] });
  const setForm = (name: string, patch: FormMap) =>
    setForms((previous) => {
      let base = previous[name] ?? {};
      const parent = name === "delivery" ? "order_id" : name === "receiving" ? "supplier_order_id" : null;
      if (parent && Object.hasOwn(patch, parent) && patch[parent] !== base[parent]) base = Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith("line_")));
      return { ...previous, [name]: { ...base, ...patch } };
    });
  const clearForm = (name: string) =>
    setForms((p) => ({ ...p, [name]: empty() }));
  const rows = (resource: BusinessResource, q = query[resource] ?? "") =>
    (data[resource] ?? []).filter(
      (r) =>
        !q ||
        Object.values(r).some((v) =>
          String(v ?? "")
            .toLowerCase()
            .includes(q.toLowerCase()),
        ),
    );
  const run = async (
    action: BusinessAction,
    payload: Row,
    success: string,
    reset?: string,
  ) => {
    setError("");
    try {
      const result = await command(
        action,
        { ...payload, idempotency_key: payload.idempotency_key ?? id() },
        success,
      );
      if (!mounted.current) return null;
      if (result) {
        setNotice(success);
        if (reset) clearForm(reset);
        return result;
      }
    } catch (e) {
      if (!mounted.current) return null;
      const message =
        e instanceof Error ? e.message : "Business action failed.";
      setError(message);
      reportError(message);
    }
    return null;
  };
  const save = async (
    e: FormEvent, action: BusinessAction, name: string, fields: string[], success: string,
    capName: keyof BusinessCapabilities, idKeys: string[] = [],
  ) => {
    e.preventDefault();
    if (!write(capName)) return;
    const f = form(name); const payload: Row = {};
    fields.forEach((key) => {
      if (f[key] !== undefined) payload[key] = key.endsWith("_at") ? dateTimeToIso(f[key]) : f[key];
    });
    const pk = idKeys[0];
    if (pk && f[pk]) payload[pk] = f[pk];
    if (action === "save_business_settings" && settings?.version != null) payload.expected_version = settings.version;
    if (action === "save_delivery") payload.lines = Object.entries(f).filter(([k, v]) => k.startsWith("line_") && v !== "").map(([k, v]) => ({ order_line_id: k.slice(5), quantity: v }));
    if (action === "save_receiving") payload.lines = Object.entries(f).filter(([k, v]) => k.startsWith("line_") && v !== "").map(([k, v]) => ({ po_line_id: k.slice(5), quantity: v }));
    if (f.expected_version) payload.expected_version = Number(f.expected_version);
    await run(action, payload, success, name);
  };
  const selectEdit = async (name: string, row: Row, fields: string[]) => {
    const epoch = ++editEpoch.current;
    const current = () => mounted.current && editEpoch.current === epoch;
    const patch: FormMap = { expected_version: String(row.version ?? "") };
    fields.forEach((key) => { patch[key] = row[key] == null ? "" : String(row[key]); });
    const resource = name as BusinessResource;
    const pk = RESOURCE_PK[resource];
    if (pk && row[pk] != null) patch[pk] = String(row[pk]);
    const formNames: Partial<Record<BusinessResource, string>> = { accounts: "account", opportunities: "opportunity", activities: "activity", quotations: "quote", invoices: "invoice", suppliers: "supplier", purchase_orders: "po", deliveries: "delivery", receivings: "receiving", projects: "project", milestones: "milestone", service_cases: "case", compliance_followups: "compliance" };
    for (const key of Object.keys(patch)) {
      if (key.endsWith("_at") && patch[key]) { const date = new Date(patch[key]); if (Number.isFinite(date.getTime())) patch[key] = new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0,16); }
    }
    const formName = formNames[resource] ?? name;
    const readAll = async (target: BusinessResource, key: string, value: string) => {
      const output: Row[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = await readRows(target, { [key]: value }, 200, offset);
        if (!current()) return null;
        output.push(...page);
        if (page.length < 200) return output;
      }
    };
    if (resource === "deliveries" || resource === "receivings") {
      setLoadingEdit(true); setError("");
      try {
        const isDelivery = resource === "deliveries";
        const sourceResource = isDelivery ? "sales_order_lines" : "purchase_order_lines";
        const sourceKey = isDelivery ? "order_id" : "supplier_order_id";
        const childResource = isDelivery ? "delivery_lines" : "receiving_lines";
        const childKey = isDelivery ? "delivery_id" : "receiving_id";
        const lineKey = isDelivery ? "order_line_id" : "po_line_id";
        const [source, children] = await Promise.all([readAll(sourceResource, sourceKey, String(row[sourceKey])), readAll(childResource, childKey, String(row[childKey]))]);
        if (!current() || !source || !children) return;
        for (const line of children) patch[`line_${String(line[lineKey])}`] = String(line.quantity);
        childEpoch.current[sourceResource] = (childEpoch.current[sourceResource] ?? 0) + 1;
        setLines(previous => ({ ...previous, [sourceResource]: source }));
        setSelected(previous => ({ ...previous, [sourceResource]: String(row[sourceKey]) }));
        setForms(previous => ({ ...previous, [formName]: patch }));
      } catch (error) {
        if (current()) { const message = error instanceof Error ? error.message : "Unable to load the saved quantities."; setError(message); reportError(message); }
      } finally { if (current()) setLoadingEdit(false); }
    } else { setLoadingEdit(false); setForms(previous => ({ ...previous, [formName]: patch })); }
    if (current() && pk && row[pk] != null) setSelected(previous => ({ ...previous, [name]: String(row[pk]) }));
  };
  const parentLines = async (
    resource: BusinessResource,
    key: string,
    value: string,
  ) => {
    const epoch = (childEpoch.current[resource] ?? 0) + 1;
    childEpoch.current[resource] = epoch;
    setSelected((p) => ({ ...p, [resource]: value }));
    setLines((p) => ({ ...p, [resource]: [] }));
    setLineForms((p) => ({ ...p, "quote-line": empty(), "invoice-line": empty(), "po-line": empty() }));
    if (!value) return;
    try {
      const result: Row[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = await readRows(resource, { [key]: value }, 200, offset);
        if (childEpoch.current[resource] !== epoch) return;
        result.push(...page);
        if (page.length < 200) break;
      }
      if (childEpoch.current[resource] === epoch) setLines((p) => ({ ...p, [resource]: result }));
    } catch (e) {
      if (!mounted.current || childEpoch.current[resource] !== epoch) return;
      reportError(
        e instanceof Error ? e.message : "Unable to load detail lines.",
      );
    }
  };
  const more = (resource: BusinessResource) => {
    if (hasMore[resource]) void loadMore(resource);
  };
  const action = (a: BusinessAction, row: Row, label: string, needsReason = false) => {
    const key = a.includes("quotation") ? "quote_id" : a.includes("invoice") ? "invoice_id" : a.includes("project") ? "project_id" : a.includes("milestone") ? "milestone_id" : a.includes("case") ? "case_id" : a.includes("followup") ? "followup_id" : a.includes("delivery") ? "delivery_id" : a.includes("receiving") ? "receiving_id" : "supplier_order_id";
    const entity = row[key]; if (!entity) return;
    const payload: Row = { [key]: entity, expected_version: row.version };
    if (needsReason) setReason({ action: a, id: String(entity), version: Number(row.version ?? 1), label });
    else void run(a, payload, `${label} completed.`);
  };
  const readOnlyDocument = (resource: BusinessResource, row: Row) => {
    const documents = { quotations: { kind: "quotation", child: "quotation_lines", key: "quote_id" }, invoices: { kind: "invoice", child: "invoice_lines", key: "invoice_id" }, purchase_orders: { kind: "purchase_order", child: "purchase_order_lines", key: "supplier_order_id" }, sales_orders: { kind: "sales_order" }, deliveries: { kind: "delivery" } } as const;
    const document = documents[resource as keyof typeof documents];
    if (!document) return null;
    return <><BusinessDocumentDownloads kind={document.kind} header={row} officeName={officeName} readRows={readRows} reportError={reportError}/>{"child" in document && <Button onClick={() => void parentLines(document.child, document.key, String(row[document.key]))}>Lines</Button>}</>;
  };
  const list = (
    resource: BusinessResource,
    title: string,
    capName?: keyof BusinessCapabilities,
    children?: (r: Row) => ReactNode,
  ) => (
    <section className="business-card business-panel-card">
      <header>
        <div>
          <span className="business-eyebrow">Loaded records</span>
          <h3>{title}</h3>
        </div>
        <div className="business-panel-tools">
          <input
            aria-label={`Search ${title}`}
            placeholder="Search loaded rows"
            value={query[resource] ?? ""}
            onChange={(e) =>
              setQuery((p) => ({ ...p, [resource]: e.target.value }))
            }
          />
          {hasMore[resource] && (
            <Button
              onClick={() => more(resource)}
              disabled={loadingMore[resource]}
            >
              Load more
            </Button>
          )}
        </div>
      </header>
      {rows(resource).length ? (
        <div className="business-panel-list">
          {rows(resource).map((r, i) => (
            <article
              className="business-panel-row"
              key={String(
                firstId(
                  r,
                  Object.keys(r).filter((k) => k.endsWith("_id")),
                ) ?? `${resource}-${i}`,
              )}
            >
              <div>
                <strong>{display(r)}</strong>
                <span>
                  {text(
                    r,
                    "public_reference",
                    text(
                      r,
                      "status",
                      text(r, "currency_code", "Operational record"),
                    ),
                  )}
                  {money(r) != null ? ` · ${String(money(r))}` : ""}
                </span>
              </div>
              <span className="business-status">{status(r.status)}</span>
              {capName && write(capName) && editableStatus(resource, r) && (
                <Button
                  onClick={() =>
                    selectEdit(
                      resource,
                      r,
                      Object.keys(r).filter(
                        (k) =>
                          !k.startsWith("created_") && !k.startsWith("updated_") && !["version", "idempotency_key"].includes(k),
                      ),
                    )
                  }
                >
                  {"Edit"}
                </Button>
              )}
              {!capName || write(capName) ? children?.(r) : readOnlyDocument(resource, r)}
            </article>
          ))}
        </div>
      ) : (
        <div className="business-empty">No {title.toLowerCase()} loaded.</div>
      )}
    </section>
  );
  const formCard = (
    name: string,
    title: string,
    actionName: BusinessAction,
    fields: ReactNode,
    keys: string[],
    capName: keyof BusinessCapabilities,
    natural: string[] = [],
  ) =>
    write(capName) ? (
      <section className="business-card business-panel-card">
        <header>
          <div>
            <span className="business-eyebrow">Workflow command</span>
            <h3>{title}</h3>
          </div>
        </header>
        <form
          className="business-panel-form"
          onSubmit={(e) =>
            void save(
              e,
              actionName,
              name,
              keys,
              `${title} saved.`,
              capName,
              natural,
            )
          }
        >
          <fieldset className="business-panel-form-fields" disabled={busy || loadingEdit}>
            {fields}
            <Button primary type="submit" disabled={busy || loadingEdit}>Save</Button>
          </fieldset>
        </form>
      </section>
    ) : null;
  const accountSelect = (name: string, label = "Account") => (
    <label className="business-panel-field">
      {label}
      <select
        aria-label={label}
        required={name !== "project" && name !== "compliance"}
        value={form(name).account_id ?? ""}
        onChange={(e) => setForm(name, { account_id: e.target.value })}
      >
        <option value="">Choose account…</option>
        {(data.accounts ?? []).map((r) => (
          <option key={String(r.account_id)} value={String(r.account_id)}>
            {display(r)} · {text(r, "public_reference", "internal")}
          </option>
        ))}
      </select>
    </label>
  );
  const memberSelect = (name: string, label: string, key = "owner_user_id") => (
    <label className="business-panel-field">
      {label}
      <select
        aria-label={label}
        value={form(name)[key] ?? ""}
        onChange={(e) => setForm(name, { [key]: e.target.value })}
      >
        <option value="">Unassigned</option>
        {activeMembers(members).map((m) => (
          <option key={String(m.user_id)} value={String(m.user_id)}>
            {m.display_name || m.username || m.user_id}
          </option>
        ))}
      </select>
    </label>
  );
  const lineEditor = (kind: "quote" | "invoice" | "po", parent: Row) => {
    const resource: BusinessResource = kind === "quote" ? "quotation_lines" : kind === "invoice" ? "invoice_lines" : "purchase_order_lines";
    const parentKey = kind === "quote" ? "quote_id" : kind === "invoice" ? "invoice_id" : "supplier_order_id";
    const parentId = String(parent[parentKey] ?? ""); const name = `${kind}-line`; const f = lineForms[name] ?? {};
    const current = lines[resource] ?? []; const capName = kind === "quote" ? "quotes" : kind === "invoice" ? "finance" : "procurement";
    const editable = parent.status === "draft" && write(capName);
    const saveLine = async (e: FormEvent) => { e.preventDefault(); if (!editable) return;
      const actionName: BusinessAction = kind === "quote" ? "save_quotation_line" : kind === "invoice" ? "save_invoice_line" : "save_purchase_order_line";
      const idKey = kind === "quote" ? "line_id" : kind === "invoice" ? "invoice_line_id" : "po_line_id";
      const payload: Row = { [parentKey]: parentId, line_no: f.line_no || String(Math.max(0, ...current.map(x => Number(x.line_no) || 0)) + 1), description: f.description ?? "", item_reference: f.item_reference ?? "", [kind === "po" ? "quantity_ordered" : "quantity"]: f.quantity ?? f.quantity_ordered ?? "", [kind === "po" ? "unit_cost" : "unit_price"]: f.unit_price ?? f.unit_cost ?? "", discount_amount: f.discount_amount ?? "0", expected_parent_version: parent.version };
      if (f[idKey]) { payload[idKey] = f[idKey]; payload.expected_version = f.expected_version ?? f.version; }
      const result = await run(actionName, payload, "Line saved."); if (result) { await parentLines(resource, parentKey, parentId); setLineForms(p => ({ ...p, [name]: empty() })); }
    };
    const deleteLine = async (r: Row) => { const actionName: BusinessAction = kind === "quote" ? "delete_quotation_line" : kind === "invoice" ? "delete_invoice_line" : "delete_purchase_order_line"; const idKey = kind === "quote" ? "line_id" : kind === "invoice" ? "invoice_line_id" : "po_line_id"; const result = await run(actionName, { [idKey]: r[idKey], [parentKey]: parentId, expected_version: r.version, expected_parent_version: parent.version }, "Line deleted."); if (result) await parentLines(resource, parentKey, parentId); };
    return <div className="business-panel-lines"><h4>Detail lines</h4>{current.map(r => <div className="business-panel-line" key={String(r["line_id"] ?? r["invoice_line_id"] ?? r["po_line_id"])}><span>{text(r,"description")} · {text(r,"quantity",text(r,"quantity_ordered"))} × {text(r,"unit_price",text(r,"unit_cost"))}</span>{editable && <span className="business-panel-actions"><Button onClick={() => setLineForms(p => ({ ...p, [name]: { ...r, expected_version: String(r.version ?? "") } as FormMap }))}>Edit</Button><Button onClick={() => void deleteLine(r)}>Delete</Button></span>}</div>)}{editable && <form className="business-panel-form compact" onSubmit={e => void saveLine(e)}><Input label="Line number" type="number" min="1" step="1" value={f.line_no ?? String(Math.max(0, ...current.map(row => Number(row.line_no) || 0)) + 1)} onChange={v => setLineForms(p => ({ ...p, [name]: { ...p[name], line_no: v } }))} required/><Input label="Line description" value={f.description ?? ""} onChange={v => setLineForms(p => ({ ...p, [name]: { ...p[name], description: v } }))} required/><Input label="Item reference" value={f.item_reference ?? ""} onChange={v => setLineForms(p => ({ ...p, [name]: { ...p[name], item_reference: v } }))}/><Input label={kind === "po" ? "Quantity ordered" : "Quantity"} type="number" min="0.0001" step="0.0001" value={f.quantity ?? f.quantity_ordered ?? ""} onChange={v => setLineForms(p => ({ ...p, [name]: { ...p[name], [kind === "po" ? "quantity_ordered" : "quantity"]: v } }))} required/><Input label={kind === "po" ? "Unit cost" : "Unit price"} type="number" min="0" step="0.01" value={f.unit_price ?? f.unit_cost ?? ""} onChange={v => setLineForms(p => ({ ...p, [name]: { ...p[name], [kind === "po" ? "unit_cost" : "unit_price"]: v } }))} required/>{kind !== "po" && <Input label="Discount" type="number" min="0" step="0.01" value={f.discount_amount ?? "0"} onChange={v => setLineForms(p => ({ ...p, [name]: { ...p[name], discount_amount: v } }))}/>}<Button primary type="submit">Save line</Button></form>}</div>;
  };
  const crm = (
    <div className="business-content">
      <div className="business-grid">
        {formCard(
          "account",
          "Account",
          "save_account",
          <>
            <Input
              label="Legal name"
              value={form("account").legal_name ?? ""}
              onChange={(v) => setForm("account", { legal_name: v })}
              required
            />
            <Input
              label="Display name"
              value={form("account").display_name ?? ""}
              onChange={(v) => setForm("account", { display_name: v })}
              required
            />
            <Select
              label="Account type"
              value={form("account").account_type ?? ""}
              onChange={(v) => setForm("account", { account_type: v })}
              options={["customer", "prospect", "partner", "other"]}
              required
            />
            <Select
              label="Status"
              value={form("account").status ?? "active"}
              onChange={(v) => setForm("account", { status: v })}
              options={["active", "inactive"]}
            />
            <Input
              label="Public reference"
              value={form("account").public_reference ?? ""}
              onChange={(v) => setForm("account", { public_reference: v })}
            />
          </>,
          [
            "legal_name",
            "display_name",
            "account_type",
            "status",
            "public_reference",
          ],
          "crm",
          ["account_id"],
        )}
        {formCard(
          "opportunity",
          "Opportunity",
          "save_opportunity",
          <>
            {accountSelect("opportunity")}
            <Input
              label="Title"
              value={form("opportunity").title ?? ""}
              onChange={(v) => setForm("opportunity", { title: v })}
              required
            />
            <Input
              label="Expected close"
              type="date"
              value={form("opportunity").expected_close_date ?? ""}
              onChange={(v) =>
                setForm("opportunity", { expected_close_date: v })
              }
            />
            <Input
              label="Currency"
              value={form("opportunity").currency_code ?? "TZS"}
              onChange={(v) =>
                setForm("opportunity", { currency_code: v.toUpperCase() })
              }
              required
            />
            <Input
              label="Estimated amount"
              type="number"
              value={form("opportunity").estimated_amount ?? ""}
              onChange={(v) => setForm("opportunity", { estimated_amount: v })}
              required
            />
            <Input
              label="Probability %"
              type="number"
              value={form("opportunity").probability_percent ?? "0"}
              onChange={(v) =>
                setForm("opportunity", { probability_percent: v })
              }
              required
            />
            {memberSelect("opportunity", "Owner")}
          </>,
          [
            "account_id",
            "title",
            "expected_close_date",
            "currency_code",
            "estimated_amount",
            "probability_percent",
            "owner_user_id",
          ],
          "crm",
          ["opportunity_id"],
        )}
        {formCard(
          "activity",
          "Activity",
          "save_activity",
          <>
            {accountSelect("activity")}
            <Input
              label="Subject"
              value={form("activity").subject ?? ""}
              onChange={(v) => setForm("activity", { subject: v })}
              required
            />
            <Select
              label="Activity type"
              value={form("activity").activity_type ?? ""}
              onChange={(v) => setForm("activity", { activity_type: v })}
              options={["call", "email", "meeting", "note", "task"]}
              required
            />
            <Input
              label="Due at"
              type="datetime-local"
              value={form("activity").due_at ?? ""}
              onChange={(v) => setForm("activity", { due_at: v })}
            />
            {memberSelect("activity", "Assigned to", "assigned_to")}
          </>,
          ["account_id", "subject", "activity_type", "due_at", "assigned_to"],
          "crm",
          ["activity_id"],
        )}
      </div>
      {list("accounts", "Accounts", "crm", (r) => (
        <Button
          onClick={() =>
            setSelected((p) => ({ ...p, account_id: String(r.account_id) }))
          }
        >
          Use
        </Button>
      ))}
      {list("opportunities", "Opportunities", "crm", (r) => (
        <>
          <Select
            label="Stage"
            value={
              form(`stage-${r.opportunity_id}`).stage ??
              String(r.stage ?? "lead")
            }
            onChange={(v) => setForm(`stage-${r.opportunity_id}`, { stage: v })}
            options={[
              "lead",
              "qualified",
              "proposal",
              "negotiation",
              "won",
              "lost",
              "paused",
            ]}
          />
          <Button
            onClick={() =>
              void run(
                "transition_opportunity",
                {
                  opportunity_id: r.opportunity_id,
                  expected_version: r.version,
                  stage: form(`stage-${r.opportunity_id}`).stage ?? r.stage,
                  ...(String(
                    form(`stage-${r.opportunity_id}`).stage ?? r.stage,
                  ) === "lost"
                    ? {
                        loss_reason:
                          form(`stage-${r.opportunity_id}`).loss_reason ??
                          "Reason recorded in workflow",
                      }
                    : {}),
                },
                "Opportunity stage updated.",
              )
            }
          >
            Transition
          </Button>
        </>
      ))}
      {list("activities", "Activities", "crm", (r) =>
        r.status === "open" && write("crm") ? (
          <Button
            onClick={() =>
              void run(
                "complete_activity",
                { activity_id: r.activity_id, expected_version: r.version },
                "Activity completed.",
              )
            }
          >
            Complete
          </Button>
        ) : null,
      )}
      {can("private_contacts") && (
        <section className="business-card business-panel-card private-card">
          <header>
            <h3>Private contacts</h3>
          </header>
          {privateContacts}
        </section>
      )}
    </div>
  );
  const sales = (
    <div className="business-content">
      <div className="business-grid">
        {formCard(
          "quote",
          "Quotation header",
          "save_quotation",
          <>
            {accountSelect("quote")}
            <Select
              label="Opportunity"
              value={form("quote").opportunity_id ?? ""}
              onChange={(v) => setForm("quote", { opportunity_id: v })}
              options={rows("opportunities").map((r) =>
                String(r.opportunity_id),
              )}
            />
            <Input
              label="Currency"
              value={form("quote").currency_code ?? "TZS"}
              onChange={(v) =>
                setForm("quote", { currency_code: v.toUpperCase() })
              }
              required
            />
            <Input
              label="Valid until"
              type="date"
              value={form("quote").valid_until ?? ""}
              onChange={(v) => setForm("quote", { valid_until: v })}
            />
          </>,
          ["account_id", "opportunity_id", "currency_code", "valid_until"],
          "quotes",
          ["quote_id"],
        )}
        {formCard(
          "delivery",
          "Delivery plan",
          "save_delivery",
          <>
            <Select
              label="Sales order"
              value={form("delivery").order_id ?? ""}
              onChange={(v) => {
                setForm("delivery", { order_id: v });
                void parentLines("sales_order_lines", "order_id", v);
              }}
              options={rows("sales_orders").map((r) => String(r.order_id))}
              required
            />
            <Input
              label="Dispatch date"
              type="date"
              value={form("delivery").dispatch_date ?? ""}
              onChange={(v) => setForm("delivery", { dispatch_date: v })}
            />
            <Input
              label="Carrier or method"
              value={form("delivery").carrier_or_method ?? ""}
              onChange={(v) => setForm("delivery", { carrier_or_method: v })}
            />
            <Input
              label="Tracking reference"
              value={form("delivery").tracking_reference ?? ""}
              onChange={(v) => setForm("delivery", { tracking_reference: v })}
            />
            <div className="business-panel-quantity-list">
              {(lines.sales_order_lines ?? []).map((l) => (
                <Input
                  key={String(l.order_line_id)}
                  label={`Quantity for ${text(l, "description")}`}
                  type="number"
                  value={
                    form("delivery")[`line_${String(l.order_line_id)}`] ?? ""
                  }
                  onChange={(v) =>
                    setForm("delivery", {
                      [`line_${String(l.order_line_id)}`]: v,
                    })
                  }
                />
              ))}
            </div>
          </>,
          [
            "order_id",
            "dispatch_date",
            "carrier_or_method",
            "tracking_reference",
          ],
          "delivery",
          ["delivery_id"],
        )}
      </div>
      {list("quotations", "Quotations", "quotes", (r) => (
        <>
          <BusinessDocumentDownloads kind="quotation" header={r} officeName={officeName} readRows={readRows} reportError={reportError} />
          <div className="business-panel-actions">
          <Button
              onClick={() =>
                void parentLines(
                  "quotation_lines",
                  "quote_id",
                  String(r.quote_id),
                )
              }
            >
              Lines
            </Button>
          {r.status === "draft" && (
            <Button onClick={() => action("issue_quotation", r, "Issue quote")}>
              Issue
            </Button>
          )}
          {r.status === "issued" && can("approve_sales") && (
            <Button
              onClick={() => action("accept_quotation", r, "Accept quote")}
            >
              Accept quote
            </Button>
          )}
          {r.status === "issued" && (
            <Button
              onClick={() =>
                setReason({
                  action: "reject_quotation",
                  id: String(r.quote_id),
                  version: Number(r.version),
                  label: "Reject quote",
                })
              }
            >
              Reject quote
            </Button>
          )}
          {["draft", "issued"].includes(String(r.status)) && (
            <Button
              onClick={() =>
                action("cancel_quotation", r, "Cancel quote", true)
              }
            >
              Cancel quote
            </Button>
          )}
          </div>
        </>
      ))}
      {selected.quotation_lines && (
        <section className="business-card business-panel-card">
          {lineEditor(
            "quote",
            rows("quotations").find(
              (r) => String(r.quote_id) === selected.quotation_lines,
            ) ?? {},
          )}
        </section>
      )}
      {list("sales_orders", "Sales orders", undefined, (r) => (
        <>
          <BusinessDocumentDownloads kind="sales_order" header={r} officeName={officeName} readRows={readRows} reportError={reportError} />
          <Button
          onClick={() =>
            void parentLines(
              "sales_order_lines",
              "order_id",
              String(r.order_id),
            )
          }
        >
          View lines
          </Button>
        </>
      ))}
      {list(
        "deliveries",
        "Deliveries",
        "delivery",
        (r) => (
          <>
            <BusinessDocumentDownloads kind="delivery" header={r} officeName={officeName} readRows={readRows} reportError={reportError} />
            {r.status === "planned" && <Button onClick={() => action("post_delivery", r, "Delivery posted")}>Post delivery</Button>}
          </>
        ),
      )}
    </div>
  );
  const receivables = (
    <div className="business-content">
      <div className="business-grid">
        {formCard(
          "invoice",
          "Invoice draft",
          "save_invoice",
          <>
            {accountSelect("invoice")}
            <Select
              label="Source order (optional)"
              value={form("invoice").order_id ?? ""}
              onChange={(v) => setForm("invoice", { order_id: v })}
              options={rows("sales_orders").map((r) => String(r.order_id))}
            />
            <Input
              label="Currency"
              value={form("invoice").currency_code ?? "TZS"}
              onChange={(v) =>
                setForm("invoice", { currency_code: v.toUpperCase() })
              }
              required
            />
            <Input
              label="Issue date"
              type="date"
              value={form("invoice").issue_date ?? ""}
              onChange={(v) => setForm("invoice", { issue_date: v })}
              required
            />
            <Input
              label="Due date"
              type="date"
              value={form("invoice").due_date ?? ""}
              onChange={(v) => setForm("invoice", { due_date: v })}
              required
            />
          </>,
          ["account_id", "order_id", "currency_code", "issue_date", "due_date"],
          "finance",
          ["invoice_id"],
        )}
        {formCard(
          "receipt",
          "Record receipt",
          "record_receipt" as BusinessAction,
          <>
            <Select
              label="Invoice"
              value={form("receipt").invoice_id ?? ""}
              onChange={(v) => setForm("receipt", { invoice_id: v })}
              options={rows("invoices")
                .filter((r) =>
                  ["issued", "partially_paid", "overdue"].includes(
                    String(r.status),
                  ),
                )
                .map((r) => String(r.invoice_id))}
              required
            />
            <Input
              label="Amount"
              type="number"
              value={form("receipt").amount ?? ""}
              onChange={(v) => setForm("receipt", { amount: v })}
              required
            />
            <Select
              label="Payment method"
              value={form("receipt").payment_method ?? ""}
              onChange={(v) => setForm("receipt", { payment_method: v })}
              options={["cash", "bank", "mobile_money", "cheque", "other"]}
              required
            />
            <Input
              label="Reference"
              value={form("receipt").reference ?? ""}
              onChange={(v) => setForm("receipt", { reference: v })}
              required
            />
            <Input
              label="Received at"
              type="datetime-local"
              value={form("receipt").received_at ?? ""}
              onChange={(v) => setForm("receipt", { received_at: v })}
              required
            />
          </>,
          [
            "invoice_id",
            "amount",
            "payment_method",
            "reference",
            "received_at",
          ],
          "finance",
        )}
      </div>
      {list("invoices", "Operational invoices", "finance", (r) => (
        <>
          <BusinessDocumentDownloads kind="invoice" header={r} officeName={officeName} readRows={readRows} reportError={reportError} />
          <div className="business-panel-actions">
          <Button
                onClick={() =>
                  void parentLines(
                    "invoice_lines",
                    "invoice_id",
                    String(r.invoice_id),
                  )
                }
              >
                Lines
              </Button>
          {r.status === "draft" && (<>
              <Button
                onClick={() => action("issue_invoice", r, "Issue invoice")}
              >
                Issue
              </Button>
            </>)}
          {["issued", "overdue"].includes(String(r.status)) && (
            <Button
              onClick={() =>
                setReason({
                  action: "void_invoice",
                  id: String(r.invoice_id),
                  version: Number(r.version),
                  label: "Void invoice",
                })
              }
            >
              Void
            </Button>
          )}
          </div>
        </>
      ))}
      {selected.invoice_lines && (
        <section className="business-card business-panel-card">
          {lineEditor(
            "invoice",
            rows("invoices").find(
              (r) => String(r.invoice_id) === selected.invoice_lines,
            ) ?? {},
          )}
        </section>
      )}
      {list("receipts", "Payment records", undefined)}
    </div>
  );
  const procurement = (
    <div className="business-content">
      <div className="business-grid">
        {formCard(
          "supplier",
          "Supplier",
          "save_supplier",
          <>
            <Input
              label="Supplier name"
              value={form("supplier").name ?? ""}
              onChange={(v) => setForm("supplier", { name: v })}
              required
            />
            <Select
              label="Status"
              value={form("supplier").status ?? "active"}
              onChange={(v) => setForm("supplier", { status: v })}
              options={["active", "inactive"]}
            />
            <Input
              label="Public reference"
              value={form("supplier").public_reference ?? ""}
              onChange={(v) => setForm("supplier", { public_reference: v })}
            />
          </>,
          ["name", "status", "public_reference"],
          "procurement",
          ["supplier_id"],
        )}
        {formCard(
          "po",
          "Purchase order",
          "save_purchase_order",
          <>
            <Select
              label="Supplier"
              value={form("po").supplier_id ?? ""}
              onChange={(v) => setForm("po", { supplier_id: v })}
              options={rows("suppliers").map((r) => String(r.supplier_id))}
              required
            />
            <Input
              label="Currency"
              value={form("po").currency_code ?? "TZS"}
              onChange={(v) =>
                setForm("po", { currency_code: v.toUpperCase() })
              }
              required
            />
          </>,
          ["supplier_id", "currency_code"],
          "procurement",
          ["supplier_order_id"],
        )}
        {formCard(
          "receiving",
          "Receiving plan",
          "save_receiving",
          <>
            <Select
              label="Purchase order"
              value={form("receiving").supplier_order_id ?? ""}
              onChange={(v) => {
                setForm("receiving", { supplier_order_id: v });
                void parentLines(
                  "purchase_order_lines",
                  "supplier_order_id",
                  v,
                );
              }}
              options={rows("purchase_orders")
                .filter((r) => r.status !== "received")
                .map((r) => String(r.supplier_order_id))}
              required
            />
            <Input
              label="Received at"
              type="datetime-local"
              value={form("receiving").received_at ?? ""}
              onChange={(v) => setForm("receiving", { received_at: v })}
              required
            />
            <Input
              label="Reference"
              value={form("receiving").reference ?? ""}
              onChange={(v) => setForm("receiving", { reference: v })}
              required
            />
            <div className="business-panel-quantity-list">
              {(lines.purchase_order_lines ?? []).map((l) => (
                <Input
                  key={String(l.po_line_id)}
                  label={`Quantity for ${text(l, "description")}`}
                  type="number"
                  value={
                    form("receiving")[`line_${String(l.po_line_id)}`] ?? ""
                  }
                  onChange={(v) =>
                    setForm("receiving", {
                      [`line_${String(l.po_line_id)}`]: v,
                    })
                  }
                />
              ))}
            </div>
          </>,
          ["supplier_order_id", "received_at", "reference"],
          "procurement",
          ["receiving_id"],
        )}
      </div>
      {list("suppliers", "Suppliers", "procurement")}
      {list("purchase_orders", "Purchase orders", "procurement", (r) => (
        <>
          <BusinessDocumentDownloads kind="purchase_order" header={r} officeName={officeName} readRows={readRows} reportError={reportError} />
          <div className="business-panel-actions">
          <Button
                onClick={() =>
                  void parentLines(
                    "purchase_order_lines",
                    "supplier_order_id",
                    String(r.supplier_order_id),
                  )
                }
              >
                Lines
              </Button>
          {r.status === "draft" && (<>
              <Button
                onClick={() =>
                  action("issue_purchase_order", r, "Issue purchase order")
                }
              >
                Issue
              </Button>
            </>)}
          </div>
        </>
      ))}
      {selected.purchase_order_lines && (
        <section className="business-card business-panel-card">
          {lineEditor(
            "po",
            rows("purchase_orders").find(
              (r) =>
                String(r.supplier_order_id) === selected.purchase_order_lines,
            ) ?? {},
          )}
        </section>
      )}
      {list(
        "receivings",
        "Receivings",
        "procurement",
        (r) =>
          r.status === "draft" && (
            <Button
              onClick={() => action("post_receiving", r, "Receiving posted")}
            >
              Post
            </Button>
          ),
      )}
    </div>
  );
  const projects = (
    <div className="business-content">
      <div className="business-grid">
        {formCard(
          "project",
          "Project",
          "save_project",
          <>
            <Input
              label="Project name"
              value={form("project").name ?? ""}
              onChange={(v) => setForm("project", { name: v })}
              required
            />
            {accountSelect("project")} {memberSelect("project", "Owner")}
            <Input
              label="Start date"
              type="date"
              value={form("project").start_date ?? ""}
              onChange={(v) => setForm("project", { start_date: v })}
            />
            <Input
              label="Target date"
              type="date"
              value={form("project").target_date ?? ""}
              onChange={(v) => setForm("project", { target_date: v })}
            />
          </>,
          ["name", "account_id", "owner_user_id", "start_date", "target_date"],
          "projects",
          ["project_id"],
        )}
        {formCard(
          "milestone",
          "Milestone",
          "save_milestone",
          <>
            <Select
              label="Project"
              value={form("milestone").project_id ?? ""}
              onChange={(v) => setForm("milestone", { project_id: v })}
              options={rows("projects").map((r) => String(r.project_id))}
              required
            />
            <Input
              label="Title"
              value={form("milestone").title ?? ""}
              onChange={(v) => setForm("milestone", { title: v })}
              required
            />
            <Input
              label="Due date"
              type="date"
              value={form("milestone").due_date ?? ""}
              onChange={(v) => setForm("milestone", { due_date: v })}
            />
            {memberSelect("milestone", "Owner")}
          </>,
          ["project_id", "title", "due_date", "owner_user_id"],
          "projects",
          ["milestone_id"],
        )}
        {formCard(
          "case",
          "Service case",
          "save_service_case",
          <>
            {accountSelect("case")}
            <Input
              label="Title"
              value={form("case").title ?? ""}
              onChange={(v) => setForm("case", { title: v })}
              required
            />
            <Select
              label="Priority"
              value={form("case").priority ?? "normal"}
              onChange={(v) => setForm("case", { priority: v })}
              options={["low", "normal", "high", "urgent"]}
              required
            />
            {memberSelect("case", "Assigned to", "assigned_to")}
          </>,
          ["account_id", "title", "priority", "assigned_to"],
          "projects",
        )}
      </div>
      {list("projects", "Projects", "projects", (r) => (
        <Select
          label="Project status"
          value={
            form(`project-status-${r.project_id}`).status ?? String(r.status)
          }
          onChange={(v) =>
            setForm(`project-status-${r.project_id}`, { status: v })
          }
          options={["planned", "active", "on_hold", "completed", "cancelled"]}
        />
      ))}
      {rows("projects").map((r) => (
        <Button
          key={`project-transition-${r.project_id}`}
          onClick={() =>
            void run(
              "transition_project",
              {
                project_id: r.project_id,
                expected_version: r.version,
                status:
                  form(`project-status-${r.project_id}`).status ?? r.status,
              },
              "Project status updated.",
            )
          }
        >
          Update project status
        </Button>
      ))}
      {list("milestones", "Milestones", "projects", (r) => (
        <Button
          onClick={() =>
            void run(
              "transition_milestone",
              {
                milestone_id: r.milestone_id,
                expected_version: r.version,
                status: "completed",
              },
              "Milestone updated.",
            )
          }
        >
          Complete
        </Button>
      ))}
      {list("service_cases", "Service cases", "projects", (r) => (
        <>
          <Select
            label="Case status"
            value={form(`case-status-${r.case_id}`).status ?? String(r.status)}
            onChange={(v) => setForm(`case-status-${r.case_id}`, { status: v })}
            options={[
              "open",
              "in_progress",
              "waiting_customer",
              "resolved",
              "closed",
              "cancelled",
            ]}
          />
          <Button
            onClick={() => { const next = form(`case-status-${r.case_id}`).status ?? r.status; if (["resolved", "closed"].includes(String(next))) setReason({ action: "transition_service_case", id: String(r.case_id), version: Number(r.version), label: "Resolve service case" }); else void run("transition_service_case", { case_id: r.case_id, expected_version: r.version, status: next }, "Case status updated."); }}
          >
            Update case
          </Button>
        </>
      ))}
    </div>
  );
  const compliance = (
    <div className="business-content">
      <div className="business-grid">
        {formCard(
          "compliance",
          "Compliance follow-up",
          "save_compliance_followup",
          <>
            <Input
              label="Title"
              value={form("compliance").title ?? ""}
              onChange={(v) => setForm("compliance", { title: v })}
              required
            />
            <Input
              label="Reference label"
              value={form("compliance").reference_label ?? ""}
              onChange={(v) => setForm("compliance", { reference_label: v })}
              required
            />
            {accountSelect("compliance")}
            <Input
              label="Due date"
              type="date"
              value={form("compliance").due_date ?? ""}
              onChange={(v) => setForm("compliance", { due_date: v })}
            />
            {memberSelect("compliance", "Owner")}
          </>,
          [
            "title",
            "reference_label",
            "account_id",
            "due_date",
            "owner_user_id",
          ],
          "compliance",
          ["followup_id"],
        )}
      </div>
      {list(
        "compliance_followups",
        "Compliance follow-ups",
        "compliance",
        (r) => (
          <>
            {r.status !== "complete" && (
              <Button
                onClick={() =>
                  void run(
                    "complete_compliance_followup",
                    { followup_id: r.followup_id, expected_version: r.version },
                    "Compliance follow-up completed.",
                  )
                }
              >
                Complete
              </Button>
            )}
          </>
        ),
      )}
      <section className="business-card business-panel-card">
        <header>
          <h3>Official manual references</h3>
        </header>
        <p className="business-note">
          These links are manual references only. COCCE does not submit, verify,
          or claim an official filing.
        </p>
        <div className="business-links">
          <a href="https://brela.go.tz/" target="_blank" rel="noreferrer">
            BRELA official portal
          </a>
          <a href="https://www.tra.go.tz/" target="_blank" rel="noreferrer">
            TRA official portal
          </a>
        </div>
        <button
          className="business-panel-button"
          onClick={() =>
            navigator.clipboard?.writeText(
              "BRELA: https://brela.go.tz/\nTRA: https://www.tra.go.tz/",
            )
          }
        >
          Copy manual links
        </button>
      </section>
    </div>
  );
  const settingsTab = (
    <div className="business-content">
      <section className="business-card business-panel-card">
        <header>
          <h3>Business settings</h3>
        </header>
        {role === "business_admin" ? (
          <form
            className="business-panel-form"
            onSubmit={(e) =>
              void save(
                e,
                "save_business_settings",
                "settings",
                [
                  "display_label",
                  "default_currency_code",
                  "quote_validity_days",
                  "invoice_due_days",
                ],
                "Settings saved.",
                "settings",
              )
            }
          >
            <Input
              label="Display label"
              value={
                form("settings").display_label ??
                text(settings ?? undefined, "display_label", officeName)
              }
              onChange={(v) => setForm("settings", { display_label: v })}
              required
            />
            <Input
              label="Default currency"
              value={
                form("settings").default_currency_code ??
                text(settings ?? undefined, "default_currency_code", "TZS")
              }
              onChange={(v) =>
                setForm("settings", { default_currency_code: v.toUpperCase() })
              }
              required
            />
            <Input
              label="Quote validity days"
              type="number"
              value={
                form("settings").quote_validity_days ??
                text(settings ?? undefined, "quote_validity_days", "30")
              }
              onChange={(v) => setForm("settings", { quote_validity_days: v })}
              required
            />
            <Input
              label="Invoice due days"
              type="number"
              value={
                form("settings").invoice_due_days ??
                text(settings ?? undefined, "invoice_due_days", "30")
              }
              onChange={(v) => setForm("settings", { invoice_due_days: v })}
              required
            />
            <Button primary type="submit">
              Save settings
            </Button>
          </form>
        ) : (
          <p className="business-note">
            Manager and staff can read these operational defaults; only the
            Business administrator can change them.
          </p>
        )}
      </section>
      {can("staff") && (
        <section className="business-card business-panel-card">
          <header>
            <h3>Office Team Business roles</h3>
          </header>
          {role === "business_admin" &&
            activeMembers(members).map((m) => (
              <form
                className="business-panel-role"
                key={String(m.user_id)}
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = form(`staff-${m.user_id}`);
                  void run(
                    "set_staff_role",
                    {
                      user_id: m.user_id,
                      business_role: f.business_role || "viewer",
                      active: f.active !== "false",
                    },
                    "Staff role updated.",
                  );
                }}
              >
                <strong>{m.display_name || m.username || m.user_id}</strong>
                <Select
                  label="Business role"
                  value={form(`staff-${m.user_id}`).business_role ?? "viewer"}
                  onChange={(v) =>
                    setForm(`staff-${m.user_id}`, { business_role: v })
                  }
                  options={[
                    "manager",
                    "sales",
                    "operations",
                    "finance",
                    "procurement",
                    "viewer",
                  ]}
                />
                <Select
                  label="Active"
                  value={form(`staff-${m.user_id}`).active ?? "true"}
                  onChange={(v) => setForm(`staff-${m.user_id}`, { active: v })}
                  options={["true", "false"]}
                />
                <Button primary type="submit">
                  Save role
                </Button>
              </form>
            ))}
        </section>
      )}
      {can("audit") && list("audit", "Audit history")}
    </div>
  );
  const overview = (
    <div className="business-content">
      <div className="business-grid">
        <section className="business-card"><span className="business-eyebrow">Sales desk</span><h3>From first enquiry to payment</h3><p className="business-note">Manage customer relationships, issue quotations, confirm orders and follow up outstanding operational invoices.</p><div className="business-panel-actions"><Button onClick={() => onNavigate("crm")}>Manage CRM</Button><Button onClick={() => onNavigate("receivables")}>Review receivables</Button></div></section>
        <section className="business-card"><span className="business-eyebrow">Operations desk</span><h3>Keep delivery and follow-ups moving</h3><p className="business-note">Track purchasing, partial receiving, project milestones and customer service cases using this office's shared records.</p><div className="business-panel-actions"><Button onClick={() => onNavigate("procurement")}>Open procurement</Button><Button onClick={() => onNavigate("projects")}>Review projects</Button></div></section>
      </div>
      {list("opportunities", "Pipeline")}
    </div>
  );
  const content =
    tab === "overview"
      ? overview
      : tab === "crm"
        ? crm
        : tab === "sales"
          ? sales
          : tab === "receivables"
            ? receivables
            : tab === "procurement"
              ? procurement
              : tab === "projects"
                ? projects
                : tab === "compliance"
                  ? compliance
                  : settingsTab;
  useEffect(() => {
    if (notice) {
      const t = window.setTimeout(() => setNotice(""), 4500);
      return () => window.clearTimeout(t);
    }
    return undefined;
  }, [notice]);
  return (
    <div className="business-panel-root">
      {loadingEdit && <div className="business-panel-alert" role="status">Loading the saved record and quantities… <Button onClick={() => { editEpoch.current += 1; setLoadingEdit(false); }}>Cancel loading</Button></div>}
      {(notice || error) && (
        <div
          className={`business-panel-alert ${error ? "error" : ""}`}
          role="status"
        >
          {error || notice}
        </div>
      )}

      {content}
      {reason && <BusinessReasonDialog label={reason.label} value={form("reason").reason ?? ""} busy={busy} onChange={value => setForm("reason", { reason: value })} onCancel={() => { setReason(null); clearForm("reason"); }} onConfirm={async () => {
        const note = form("reason").reason?.trim();
        if (!note) return false;
        const result = await run(reason.action, {
          [reason.action.includes("invoice") ? "invoice_id" : reason.action.includes("case") ? "case_id" : reason.action.includes("quotation") ? "quote_id" : "entity_id"]: reason.id,
          ...(reason.action === "transition_service_case" ? { status: form("case-status-" + reason.id).status ?? "resolved", resolution_note: note } : {}),
          expected_version: reason.version, reason: note,
        }, `${reason.label} completed.`);
        if (result && mounted.current) { setReason(null); clearForm("reason"); }
        return !!result;
      }} />}
    </div>
  );
}
