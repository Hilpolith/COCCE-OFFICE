// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ManufacturingOperationForm, {
  ManufacturingOperationFormsProvider,
  type ManufacturingOperationFormProps,
} from "./ManufacturingOperationForm";
import type {
  ManufacturingCapabilities,
  ManufacturingRecord,
  ManufacturingResource,
} from "./lib/officeManufacturingManagement";

afterEach(cleanup);

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const capabilities = Object.fromEntries(
  [
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
  ].map((key) => [key, true]),
) as ManufacturingCapabilities;
function renderForm(
  action: Parameters<typeof ManufacturingOperationForm>[0]["action"],
  fields: string[],
  command: ReturnType<typeof vi.fn>,
  rows: Partial<Record<ManufacturingResource, ManufacturingRecord[]>> = {},
) {
  const readPage = vi.fn(
    async (
      resource: ManufacturingResource,
      filter: ManufacturingRecord = {},
    ) => {
      const source = rows[resource] ?? [];
      const result = source.filter(
        (row) => !filter.id || String(row.id) === String(filter.id),
      );
      return {
        rows: result,
        total_count: result.length,
        offset: 0,
        limit: 100,
        has_more: false,
      };
    },
  );
  render(
    <ManufacturingOperationFormsProvider
      value={{
        data: rows as Record<string, ManufacturingRecord[]>,
        pages: {},
        readPage,
        capabilities,
        refreshToken: 0,
      }}
    >
      <ManufacturingOperationForm
        action={action}
        title="Save"
        fields={fields}
        command={
          command as (
            action: ManufacturingOperationFormProps["action"],
            payload: ManufacturingRecord,
            success?: string,
          ) => Promise<ManufacturingRecord>
        }
        busy={false}
      />
    </ManufacturingOperationFormsProvider>,
  );
  return readPage;
}

function fill(label: string, value: string) {
  fireEvent.change(
    screen.getByRole("textbox", { name: new RegExp(`^${label}`) }),
    { target: { value } },
  );
}

function page(rows: ManufacturingRecord[]) {
  return {
    rows,
    total_count: rows.length,
    offset: 0,
    limit: 100,
    has_more: false,
  };
}

function renderWithProvider(
  action: Parameters<typeof ManufacturingOperationForm>[0]["action"],
  fields: string[],
  command: ReturnType<typeof vi.fn>,
  value: {
    data: Record<string, ManufacturingRecord[]>;
    readPage: ManufacturingOperationFormProps extends never
      ? never
      : (
          resource: ManufacturingResource,
          filter?: ManufacturingRecord,
          offset?: number,
        ) => Promise<ReturnType<typeof page>>;
    readFreshPage?: (
      resource: ManufacturingResource,
      filter?: ManufacturingRecord,
      offset?: number,
    ) => Promise<ReturnType<typeof page>>;
    refreshToken: number;
  },
) {
  const result = render(
    <ManufacturingOperationFormsProvider
      value={{ ...value, pages: {}, capabilities }}
    >
      <ManufacturingOperationForm
        action={action}
        title="Save"
        fields={fields}
        command={command as ManufacturingOperationFormProps["command"]}
        busy={false}
      />
    </ManufacturingOperationFormsProvider>,
  );
  return result;
}

describe("ManufacturingOperationForm", () => {
  it("does not render a mutation form when context or capability is unavailable", () => {
    const { container } = render(
      <ManufacturingOperationFormsProvider
        value={{
          data: {},
          pages: {},
          readPage: vi.fn(),
          capabilities: null,
          refreshToken: 0,
        }}
      >
        <ManufacturingOperationForm
          action="save_item"
          title="Save item"
          fields={["sku"]}
          command={vi.fn()}
          busy={false}
        />
      </ManufacturingOperationFormsProvider>,
    );
    expect(container.querySelector("form")).toBeNull();
  });

  it("creates a new item without id or version and applies exact defaults/normalization", async () => {
    const command = vi.fn().mockResolvedValue({ id: id(9), version: 1 });
    renderForm(
      "save_item",
      ["sku", "name", "kind", "unit", "reorder_point", "status"],
      command,
    );
    fill("Sku", "RM-1");
    fill("Name", "Steel");
    fill("Unit", "kg");
    fill("Reorder point", "1.2");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    const payload = command.mock.calls[0][1] as ManufacturingRecord;
    expect(payload).toMatchObject({
      sku: "RM-1",
      name: "Steel",
      kind: "raw_material",
      unit: "kg",
      reorder_point: "1.200000",
      status: "active",
    });
    expect(payload).not.toHaveProperty("id");
    expect(payload).not.toHaveProperty("expected_version");
  });

  it("hydrates the selected supplier and sends its current version on edit", async () => {
    const supplier = {
      id: id(2),
      supplier_code: "SUP-2",
      display_label: "Selected supplier",
      status: "active",
      version: 7,
    };
    const command = vi.fn().mockResolvedValue({ id: supplier.id, version: 8 });
    renderForm(
      "save_supplier",
      ["id", "supplier_code", "display_label", "status"],
      command,
      { suppliers: [supplier] },
    );
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /SUP-2/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Existing record"), {
      target: { value: supplier.id },
    });
    await waitFor(() =>
      expect(
        (
          document.querySelector(
            'input[name="supplier_code"]',
          ) as HTMLInputElement
        ).value,
      ).toBe("SUP-2"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command.mock.calls[0][1]).toMatchObject({
      id: supplier.id,
      expected_version: 7,
      supplier_code: "SUP-2",
    });
  });

  it("uses the BOM parent version rather than the child version for a BOM line", async () => {
    const bom = { id: id(3), bom_code: "BOM-3", version: 12, status: "draft" };
    const item = {
      id: id(4),
      sku: "RM-4",
      kind: "raw_material",
      status: "active",
      version: 2,
    };
    const command = vi
      .fn()
      .mockResolvedValue({ id: id(5), version: 1, parent_version: 13 });
    renderForm("save_bom_line", ["bom_id", "item_id", "quantity"], command, {
      boms: [bom],
      items: [item],
    });
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /BOM-3/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Bill of materials"), {
      target: { value: bom.id },
    });
    fireEvent.change(screen.getByLabelText("Item"), {
      target: { value: item.id },
    });
    fill("Quantity", "2");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command.mock.calls[0][1]).toMatchObject({
      bom_id: bom.id,
      item_id: item.id,
      quantity: "2.000000",
      expected_parent_version: 12,
    });
  });

  it("hydrates transfer balance version from the from-location, not the destination", async () => {
    const lot = { id: id(6), batch_code: "LOT-6", version: 4 };
    const from = { id: id(7), code: "FROM", version: 1 };
    const to = { id: id(8), code: "TO", version: 1 };
    const command = vi.fn().mockResolvedValue({ id: lot.id, version: 5 });
    const readPage = renderForm(
      "transfer_stock",
      ["lot_id", "from_location_id", "to_location_id", "quantity"],
      command,
      {
        lots: [lot],
        locations: [from, to],
        stock_balances: [
          { id: id(10), lot_id: lot.id, location_id: from.id, version: 21 },
        ],
      },
    );
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /LOT-6/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Lot"), {
      target: { value: lot.id },
    });
    fireEvent.change(screen.getByLabelText("From location"), {
      target: { value: from.id },
    });
    fireEvent.change(screen.getByLabelText("To location"), {
      target: { value: to.id },
    });
    fill("Quantity", "1");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(readPage).toHaveBeenCalledWith(
      "stock_balances",
      { lot_id: lot.id, location_id: from.id },
      0,
    );
    expect(command.mock.calls[0][1]).toMatchObject({
      expected_balance_version: 21,
      quantity: "1.000000",
    });
  });

  it("completes a pending command after a refresh-token rerender and leaves no Saving state", async () => {
    let resolve!: (value: ManufacturingRecord) => void;
    const command = vi.fn(
      () => new Promise<ManufacturingRecord>((done) => (resolve = done)),
    );
    const readPage = vi.fn(async () => page([]));
    const view = renderWithProvider("save_item", ["sku"], command, {
      data: {},
      readPage,
      refreshToken: 0,
    });
    fill("Sku", "PENDING-1");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(
      (screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    view.rerender(
      <ManufacturingOperationFormsProvider
        value={{ data: {}, pages: {}, readPage, capabilities, refreshToken: 1 }}
      >
        <ManufacturingOperationForm
          action="save_item"
          title="Save"
          fields={["sku"]}
          command={command}
          busy={false}
        />
      </ManufacturingOperationFormsProvider>,
    );
    resolve({ id: id(40), version: 2 });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Save saved."),
    );
    expect(
      (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("preserves dirty edit fields and the originally selected version across background row-version changes", async () => {
    const supplier = {
      id: id(41),
      supplier_code: "SUP-41",
      display_label: "Original",
      status: "active",
      version: 3,
    };
    const command = vi.fn().mockResolvedValue({ id: supplier.id, version: 4 });
    const readPage = vi.fn(
      async (
        resource: ManufacturingResource,
        filter: ManufacturingRecord = {},
      ) =>
        page(
          resource === "suppliers"
            ? filter.id
              ? [{ ...supplier }]
              : [supplier]
            : [],
        ),
    );
    renderWithProvider(
      "save_supplier",
      ["id", "supplier_code", "display_label", "status"],
      command,
      {
        data: { suppliers: [supplier] },
        readPage,
        refreshToken: 0,
      },
    );
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /SUP-41/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Existing record"), {
      target: { value: supplier.id },
    });
    await waitFor(() =>
      expect(
        (screen.getByDisplayValue("Original") as HTMLInputElement).value,
      ).toBe("Original"),
    );
    fireEvent.change(screen.getByDisplayValue("Original"), {
      target: { value: "Dirty label" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command.mock.calls[0][1]).toMatchObject({
      id: supplier.id,
      expected_version: 3,
      display_label: "Dirty label",
    });
  });

  it("derives a fresh lot version for inspection without rewriting the lot id", async () => {
    const lot = { id: id(42), batch_code: "LOT-42", version: 2 };
    const command = vi.fn().mockResolvedValue({ id: id(43), version: 1 });
    const readPage = vi.fn(
      async (
        resource: ManufacturingResource,
        filter: ManufacturingRecord = {},
      ) =>
        page(
          resource === "lots"
            ? [{ ...lot, ...(filter.id ? { version: 9 } : {}) }]
            : [],
        ),
    );
    renderWithProvider(
      "record_lot_inspection",
      ["lot_id", "result", "observations"],
      command,
      {
        data: { lots: [lot] },
        readPage,
        refreshToken: 0,
      },
    );
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /LOT-42/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Lot"), {
      target: { value: lot.id },
    });
    fireEvent.change(document.querySelector('select[name="result"]')!, {
      target: { value: "pass" },
    });
    fill("Observations", "Fresh check");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command.mock.calls[0][1]).toMatchObject({
      lot_id: lot.id,
      expected_version: 9,
      observations: "Fresh check",
    });
    expect(command.mock.calls[0][1]).not.toHaveProperty("id");
  });

  it("removes an allocation using the allocation child and a fresh production-order parent version", async () => {
    const allocation = {
      id: id(44),
      order_id: id(45),
      item_id: id(46),
      version: 2,
    };
    const order = { id: id(45), order_code: "PO-45", version: 11 };
    const calls: Array<
      [ManufacturingResource, ManufacturingRecord | undefined]
    > = [];
    const command = vi
      .fn()
      .mockResolvedValue({ id: allocation.id, version: 3 });
    const readPage = vi.fn(
      async (
        resource: ManufacturingResource,
        filter: ManufacturingRecord = {},
      ) => {
        calls.push([resource, filter]);
        if (resource === "allocations") return page([allocation]);
        if (resource === "production_orders") return page([order]);
        return page([]);
      },
    );
    renderWithProvider(
      "remove_allocation",
      ["id", "expected_version", "expected_parent_version"],
      command,
      {
        data: {
          allocations: [allocation],
          production_orders: [order],
          items: [{ id: id(46), sku: "ITEM" }],
        },
        readPage,
        refreshToken: 0,
      },
    );
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /PO-45|44/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Existing record"), {
      target: { value: allocation.id },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(
      calls.some(
        ([resource, filter]) =>
          resource === "allocations" && filter?.id === allocation.id,
      ),
    ).toBe(true);
    expect(
      calls.some(
        ([resource, filter]) =>
          resource === "production_orders" && filter?.id === order.id,
      ),
    ).toBe(true);
    expect(command.mock.calls[0][1]).toMatchObject({
      id: allocation.id,
      expected_version: 2,
      expected_parent_version: 11,
    });
  });

  it("prefills singleton settings and submits its expected version without an existing-record picker", async () => {
    const settings = {
      id: id(47),
      factory_name: "Factory A",
      jurisdiction: "zanzibar",
      version: 6,
    };
    const command = vi.fn().mockResolvedValue({ id: settings.id, version: 7 });
    const readPage = vi.fn(async () => page([]));
    renderWithProvider(
      "save_settings",
      ["factory_name", "jurisdiction"],
      command,
      {
        data: { settings: [settings] },
        readPage,
        refreshToken: 0,
      },
    );
    await waitFor(() =>
      expect(screen.getByDisplayValue("Factory A")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("Existing record")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    expect(command.mock.calls[0][1]).toMatchObject({
      id: settings.id,
      expected_version: 6,
      factory_name: "Factory A",
      jurisdiction: "zanzibar",
    });
  });

  it("uses the returned version for the next edit after its own successful save", async () => {
    const record = {
      id: id(48),
      sku: "ITEM-48",
      name: "Before",
      kind: "raw_material",
      unit: "kg",
      version: 1,
    };
    const command = vi
      .fn()
      .mockResolvedValueOnce({ id: record.id, version: 2 })
      .mockResolvedValueOnce({ id: record.id, version: 3 });
    const readPage = vi.fn(async (resource: ManufacturingResource) =>
      page(resource === "items" ? [record] : []),
    );
    renderWithProvider(
      "save_item",
      ["id", "sku", "name", "kind", "unit"],
      command,
      {
        data: { items: [record] },
        readPage,
        refreshToken: 0,
      },
    );
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /ITEM-48/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Existing record"), {
      target: { value: record.id },
    });
    await waitFor(() =>
      expect(screen.getByDisplayValue("Before")).toBeTruthy(),
    );
    fill("Name", "After first");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(command).toHaveBeenCalledOnce());
    fill("Name", "After second");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(command).toHaveBeenCalledTimes(2));
    expect(command.mock.calls[1][1]).toMatchObject({
      id: record.id,
      expected_version: 2,
      name: "After second",
    });
  });

  it("uses readFreshPage for picker hydration and selected-detail lifecycle", async () => {
    const item = { id: id(49), sku: "FRESH-49", version: 5 };
    const readPage = vi.fn(async () => page([]));
    const readFreshPage = vi.fn(
      async (
        resource: ManufacturingResource,
        filter: ManufacturingRecord = {},
      ) => (resource === "items" && filter.id ? page([item]) : page([item])),
    );
    const command = vi.fn().mockResolvedValue({ id: item.id, version: 6 });
    renderWithProvider(
      "save_item",
      ["id", "sku", "name", "kind", "unit"],
      command,
      {
        data: {},
        readPage,
        readFreshPage,
        refreshToken: 0,
      },
    );
    await waitFor(() =>
      expect(screen.getByRole("option", { name: /FRESH-49/ })).toBeTruthy(),
    );
    fireEvent.change(screen.getByLabelText("Existing record"), {
      target: { value: item.id },
    });
    await waitFor(() =>
      expect(readFreshPage).toHaveBeenCalledWith("items", { id: item.id }, 0),
    );
    expect(readPage).not.toHaveBeenCalled();
  });
});
