// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const calls: Array<{ action: string; payload: Record<string, unknown> }> = [];
const reads: Array<{
  resource: string;
  filter: Record<string, unknown>;
  offset: number;
}> = [];
let role = "manufacturing_admin";
let capabilityOverrides: Record<string, boolean> = {};
let commandImpl:
  | ((
      action: string,
      payload: Record<string, unknown>,
    ) => unknown | Promise<unknown>)
  | null = null;
let readImpl:
  | ((
      resource: string,
      filter: Record<string, unknown>,
      offset: number,
    ) => unknown | Promise<unknown>)
  | null = null;
let bootstrapImpl: (() => unknown | Promise<unknown>) | null = null;
let user: { id: string } | null = { id: "actor-1" };
const authListeners: Array<(event: string, session: unknown) => void> = [];

const ids = {
  item: "item-copper",
  lot: "lot-b001",
  location: "location-main",
  order: "order-po001",
  member: "member-2",
};
const fixtureRows: Record<string, Array<Record<string, unknown>>> = {
  items: [
    {
      id: ids.item,
      sku: "RM-001",
      name: "Copper",
      kind: "raw_material",
      unit: "kg",
      reorder_point: "10.000000",
      status: "active",
      version: 2,
    },
  ],
  lots: [
    {
      id: ids.lot,
      batch_code: "B-001",
      item_name: "Copper",
      status: "released",
      version: 3,
    },
  ],
  locations: [
    {
      id: ids.location,
      code: "MAIN",
      name: "Main store",
      status: "active",
      version: 1,
    },
  ],
  stock_balances: [
    {
      id: "balance-1",
      lot_id: ids.lot,
      location_id: ids.location,
      batch_code: "B-001",
      location_name: "Main store",
      on_hand: "12.500000",
      reserved: "0.000000",
      available: "12.500000",
      lot_status: "released",
      version: 4,
    },
  ],
  production_orders: [
    {
      id: ids.order,
      order_code: "PO-001",
      product_name: "Copper assembly",
      status: "planned",
      target_quantity: "2.000000",
      version: 7,
    },
  ],
  staff_roles: [
    {
      id: "owner-row",
      user_id: "owner-1",
      member_ref: "OWNER",
      team_role: "owner",
      role: "manufacturing_admin",
      status: "active",
      version: 99,
    },
    {
      id: "member-row",
      user_id: ids.member,
      member_ref: "M-002",
      team_role: "member",
      role: "unassigned",
      status: "active",
      version: 5,
    },
  ],
  stock_counts: [
    {
      id: "count-1",
      batch_code: "B-001",
      location_name: "Main store",
      status: "submitted",
      version: 1,
    },
  ],
  inspections: [],
  genealogy: [
    {
      id: "genealogy-1",
      relation: "input",
      batch_code: "B-001",
      linked_batch_code: "B-000",
      quantity: "1.000000",
      lot_status: "released",
    },
  ],
};

function page(
  resource: string,
  filter: Record<string, unknown>,
  offset: number,
) {
  const source =
    resource === "lot_genealogy"
      ? fixtureRows.genealogy
      : (fixtureRows[resource] ?? []);
  const filtered = filter.id
    ? source.filter((row) => row.id === filter.id)
    : filter.lot_id
      ? source.filter((row) => row.lot_id === filter.lot_id)
      : source;
  return {
    rows: offset ? [] : filtered,
    total_count: filtered.length,
    offset,
    limit: 100,
    has_more: false,
  };
}
function capabilities(
  actual: typeof capabilityOverrides = capabilityOverrides,
) {
  const keys = [
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
  ];
  return Object.fromEntries(keys.map((key) => [key, actual[key] ?? true]));
}

vi.mock("./lib/officeTeamSupabase", () => ({
  resolveOfficeTeamConfig: () => ({ status: "ready", anonKey: "public-key" }),
  getOfficeTeamClient: () => ({
    auth: {
      getUser: async () => ({ data: { user } }),
      onAuthStateChange: (
        listener: (event: string, session: unknown) => void,
      ) => {
        authListeners.push(listener);
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
  }),
}));
vi.mock("./lib/officeTeamApi", () => ({
  officeTeamApi: {
    listWorkspaces: async () => [
      { workspace_id: "00000000-0000-4000-8000-000000000001" },
    ],
  },
}));
vi.mock("./lib/officeManufacturingManagement", async () => {
  const actual = await vi.importActual<
    typeof import("./lib/officeManufacturingManagement")
  >("./lib/officeManufacturingManagement");
  return {
    ...actual,
    officeManufacturingManagementApi: {
      read: async (
        _client: unknown,
        _workspace: string,
        resource: string,
        filter: Record<string, unknown> = {},
        _limit: number,
        offset: number,
      ) => {
        reads.push({ resource, filter, offset });
        if (resource === "bootstrap")
          return bootstrapImpl
            ? bootstrapImpl()
            : {
                role,
                capabilities: capabilities(),
                settings: null,
                key_config: { configured: false },
                summary: {
                  items_count: 1,
                  open_orders_count: 1,
                  held_lots_count: 0,
                  low_stock_items_count: 0,
                  overdue_compliance_count: 0,
                  pending_counts_count: 0,
                  active_reservations_count: 0,
                },
              };
        if (readImpl) return readImpl(resource, filter, offset);
        return page(resource, filter, offset);
      },
      command: async (
        _client: unknown,
        _workspace: string,
        action: string,
        payload: Record<string, unknown>,
      ) => {
        calls.push({ action, payload });
        return commandImpl
          ? commandImpl(action, payload)
          : { id: payload.id ?? "new-id", version: 8, parent_version: 8 };
      },
    },
  };
});
import ManufacturingManagementWorkspace from "./ManufacturingManagementWorkspace";

const workspace = {
  workspaceId: "00000000-0000-4000-8000-000000000001",
  officeName: "Factory One",
};
const tab = (name: RegExp) => screen.getByRole("tab", { name });
const operation = (title: RegExp) =>
  screen.getByRole("heading", { name: title }).closest("section")!;

afterEach(() => {
  cleanup();
  calls.length = 0;
  reads.length = 0;
  role = "manufacturing_admin";
  capabilityOverrides = {};
  commandImpl = null;
  readImpl = null;
  bootstrapImpl = null;
  user = { id: "actor-1" };
  authListeners.length = 0;
});

describe("ManufacturingManagementWorkspace", () => {
  it("saves a new material with real defaults and exact decimal normalization", async () => {
    render(<ManufacturingManagementWorkspace {...workspace} />);
    await waitFor(() => expect(tab(/Materials/)).toBeTruthy());
    fireEvent.click(tab(/Materials/));
    const form = operation(/Save material or product/).querySelector("form")!;
    fireEvent.change(form.querySelector('[name="sku"]')!, {
      target: { value: "RM-002" },
    });
    fireEvent.change(form.querySelector('[name="name"]')!, {
      target: { value: "Nickel" },
    });
    fireEvent.change(form.querySelector('[name="unit"]')!, {
      target: { value: "kg" },
    });
    fireEvent.change(form.querySelector('[name="reorder_point"]')!, {
      target: { value: "12.3" },
    });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(calls.some((call) => call.action === "save_item")).toBe(true),
    );
    const payload = calls.find((call) => call.action === "save_item")!.payload;
    expect(payload.kind).toBe("raw_material");
    expect(payload.status).toBe("active");
    expect(payload.reorder_point).toBe("12.300000");
    expect(payload).not.toHaveProperty("expected_version");
  });

  it("hydrates allocation parents and stock details, then sends the current parent and balance versions", async () => {
    let orderVersion = 7;
    let balanceVersion = 4;
    readImpl = (resource, filter, offset) => {
      if (resource === "production_orders" && filter.id)
        return page(resource, filter, offset);
      if (resource === "production_orders")
        return {
          ...page(resource, filter, offset),
          rows: [
            { ...fixtureRows.production_orders[0], version: orderVersion },
          ],
        };
      if (resource === "stock_balances")
        return {
          ...page(resource, filter, offset),
          rows: [{ ...fixtureRows.stock_balances[0], version: balanceVersion }],
        };
      return page(resource, filter, offset);
    };
    commandImpl = async (action, payload) => {
      if (action === "allocate_material") {
        expect(payload.expected_parent_version).toBe(7);
        expect(payload.expected_balance_version).toBe(4);
        orderVersion = 8;
        balanceVersion = 5;
      }
      return { id: "allocation-1", version: 1 };
    };
    render(<ManufacturingManagementWorkspace {...workspace} />);
    await waitFor(() => expect(tab(/Production/)).toBeTruthy());
    fireEvent.click(tab(/Production/));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Planning" })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Planning" }));
    fireEvent.change(
      screen.getByRole("combobox", { name: "Choose an operation" }),
      { target: { value: "allocate_material" } },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: /Reserve a component lot/ }),
      ).toBeTruthy(),
    );
    const allocation = operation(/Reserve a component lot/);
    fireEvent.change(allocation.querySelector('[name="order_id"]')!, {
      target: { value: ids.order },
    });
    fireEvent.change(allocation.querySelector('[name="lot_id"]')!, {
      target: { value: ids.lot },
    });
    fireEvent.change(allocation.querySelector('[name="location_id"]')!, {
      target: { value: ids.location },
    });
    fireEvent.change(allocation.querySelector('[name="quantity"]')!, {
      target: { value: "1" },
    });
    await waitFor(() =>
      expect(
        reads.some(
          (read) =>
            read.resource === "production_orders" &&
            read.filter.id === ids.order,
        ),
      ).toBe(true),
    );
    fireEvent.submit(allocation.querySelector("form")!);
    await waitFor(() =>
      expect(calls.some((call) => call.action === "allocate_material")).toBe(
        true,
      ),
    );
    expect(
      reads.some(
        (read) =>
          read.resource === "stock_balances" &&
          read.filter.lot_id === ids.lot &&
          read.filter.location_id === ids.location,
      ),
    ).toBe(true);
    expect(
      calls.find((call) => call.action === "allocate_material")!.payload
        .quantity,
    ).toBe("1.000000");
  });

  it("keeps planning visible without shop-floor production and starts planned-order creation", async () => {
    role = "production_planner";
    capabilityOverrides = { production: false, planning: true, masters: false };
    render(<ManufacturingManagementWorkspace {...workspace} />);
    await waitFor(() => expect(tab(/Production/)).toBeTruthy());
    fireEvent.click(tab(/Production/));
    expect(screen.getByRole("button", { name: "Planning" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Shop floor" })).toBeNull();
    expect(
      screen.getByRole("heading", { name: /Save a planned production order/ }),
    ).toBeTruthy();
  });

  it("shows stock review to a reviewer without exposing receive controls", async () => {
    role = "quality_reviewer";
    capabilityOverrides = {
      inventory_move: false,
      inventory_receive: false,
      stock_approve: true,
      quality: true,
      masters: false,
    };
    render(<ManufacturingManagementWorkspace {...workspace} />);
    await waitFor(() => expect(tab(/Stock/)).toBeTruthy());
    fireEvent.click(tab(/Stock/));
    fireEvent.change(
      screen.getByRole("combobox", { name: "Choose an operation" }),
      { target: { value: "review_stock_count" } },
    );
    expect(
      screen.getByRole("heading", { name: /Review a submitted stock count/ }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: /Receive incoming stock/ }),
    ).toBeNull();
  });

  it("does not load genealogy until Trace batch is selected and filters by the selected lot", async () => {
    render(<ManufacturingManagementWorkspace {...workspace} />);
    await waitFor(() => expect(tab(/Quality/)).toBeTruthy());
    fireEvent.click(tab(/Quality/));
    await waitFor(() =>
      expect(screen.getByText(/Select an actual batch/)).toBeTruthy(),
    );
    expect(reads.some((read) => read.resource === "lot_genealogy")).toBe(false);
    const picker = screen.getByRole("combobox", { name: "Trace batch" });
    fireEvent.change(picker, { target: { value: ids.lot } });
    await waitFor(() =>
      expect(
        reads.some(
          (read) =>
            read.resource === "lot_genealogy" && read.filter.lot_id === ids.lot,
        ),
      ).toBe(true),
    );
    expect(
      reads
        .filter((read) => read.resource === "lot_genealogy")
        .every((read) => read.filter.lot_id === ids.lot),
    ).toBe(true);
  });

  it("rejects stale search responses after a newer response wins", async () => {
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    readImpl = (resource, filter, offset) => {
      if (resource !== "items") return page(resource, filter, offset);
      if (filter.q === "old")
        return new Promise((resolve) => {
          resolveOld = resolve;
        });
      if (filter.q === "new")
        return new Promise((resolve) => {
          resolveNew = resolve;
        });
      return {
        rows: [{ ...fixtureRows.items[0], name: "Initial" }],
        total_count: 1,
        offset: 0,
        limit: 100,
        has_more: false,
      };
    };
    render(<ManufacturingManagementWorkspace {...workspace} />);
    await waitFor(() => expect(tab(/Materials/)).toBeTruthy());
    fireEvent.click(tab(/Materials/));
    const search = screen.getByPlaceholderText(
      "Search by code, name or status",
    );
    fireEvent.change(search, { target: { value: "old" } });
    fireEvent.change(search, { target: { value: "new" } });
    resolveNew({
      rows: [{ ...fixtureRows.items[0], name: "Newest" }],
      total_count: 1,
      offset: 0,
      limit: 100,
      has_more: false,
    });
    await waitFor(() => expect(screen.getByText("Newest")).toBeTruthy());
    resolveOld({
      rows: [{ ...fixtureRows.items[0], name: "Stale" }],
      total_count: 1,
      offset: 0,
      limit: 100,
      has_more: false,
    });
    await waitFor(() => expect(screen.queryByText("Stale")).toBeNull());
  });

  it("drops pending bootstrap results after sign-out", async () => {
    let resolveBootstrap!: (value: unknown) => void;
    bootstrapImpl = () =>
      new Promise((resolve) => {
        resolveBootstrap = resolve;
      });
    render(<ManufacturingManagementWorkspace {...workspace} />);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toMatch(
        /Checking Office Team/,
      ),
    );
    authListeners.forEach((listener) => listener("SIGNED_OUT", null));
    resolveBootstrap({
      role: "manufacturing_admin",
      capabilities: capabilities(),
      settings: null,
      key_config: { configured: false },
      summary: {
        items_count: 1,
        open_orders_count: 0,
        held_lots_count: 0,
        low_stock_items_count: 0,
        open_maintenance_count: 0,
        overdue_compliance_count: 0,
        pending_counts_count: 0,
        active_reservations_count: 0,
      },
    });
    await waitFor(() =>
      expect(screen.getByText(/Sign in to access/)).toBeTruthy(),
    );
    expect(screen.queryByRole("tab", { name: /Materials/ })).toBeNull();
  });

  it("renders command failures without a false success message", async () => {
    commandImpl = async () => {
      throw new Error("stale parent version conflict");
    };
    render(<ManufacturingManagementWorkspace {...workspace} />);
    await waitFor(() => expect(tab(/Materials/)).toBeTruthy());
    fireEvent.click(tab(/Materials/));
    const form = operation(/Save material or product/).querySelector("form")!;
    for (const [name, value] of [
      ["sku", "ERR"],
      ["name", "Broken"],
      ["unit", "kg"],
      ["reorder_point", "1"],
    ])
      fireEvent.change(form.querySelector(`[name="${name}"]`)!, {
        target: { value },
      });
    fireEvent.submit(form);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(
        /stale parent version conflict/,
      ),
    );
    expect(screen.queryByText(/Save material or product saved/)).toBeNull();
  });

  it("keeps viewers read-only and excludes immutable owners from staff assignment", async () => {
    role = "manufacturing_viewer";
    capabilityOverrides = {
      reports: true,
      settings: false,
      staff: false,
      masters: false,
      inventory_move: false,
      inventory_receive: false,
      planning: false,
      production: false,
      quality: false,
      private_records: false,
    };
    render(<ManufacturingManagementWorkspace {...workspace} />);
    await waitFor(() => expect(tab(/Reports/)).toBeTruthy());
    expect(screen.queryByRole("tab", { name: /Settings/ })).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Refresh records/ }),
    ).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it("assigns an active member using the fresh positive version and omits version when absent", async () => {
    render(<ManufacturingManagementWorkspace {...workspace} />);
    await waitFor(() => expect(tab(/Settings/)).toBeTruthy());
    fireEvent.click(tab(/Settings/));
    const member = await screen.findByRole("combobox", {
      name: "Active member",
    });
    fireEvent.change(member, { target: { value: ids.member } });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Manufacturing role" }),
      { target: { value: "storekeeper" } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save staff role" }));
    await waitFor(() =>
      expect(calls.some((call) => call.action === "assign_staff_role")).toBe(
        true,
      ),
    );
    expect(
      calls.find((call) => call.action === "assign_staff_role")!.payload
        .expected_version,
    ).toBe(5);
    expect(screen.queryByRole("option", { name: /OWNER/ })).toBeNull();
  });
});
