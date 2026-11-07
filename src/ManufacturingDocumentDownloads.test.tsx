// @vitest-environment happy-dom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import ManufacturingDocumentDownloads, {
  buildManufacturingCsv,
  buildManufacturingPdf,
} from "./ManufacturingDocumentDownloads";
import type {
  ManufacturingRecord,
  ManufacturingResource,
} from "./lib/officeManufacturingManagement";

type Page = {
  rows: ManufacturingRecord[];
  total_count: number;
  offset: number;
  limit: number;
  has_more: boolean;
  dataset_version?: string;
};
const columns = ["id", "description", "amount", "note"];
const page = (
  rows: ManufacturingRecord[],
  offset: number,
  total: number,
  has_more: boolean,
): Page => ({
  rows,
  offset,
  total_count: total,
  limit: 100,
  has_more,
  dataset_version: "7",
});
const records = Array.from({ length: 205 }, (_, index) => ({
  id: `row-${index}`,
  description: `Description ${index}\nwith newline`,
  amount: `900719925474099312345.${String(index).padStart(2, "0")}`,
  note: `note, "quoted" ${index}`,
}));

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe("ManufacturingDocumentDownloads", () => {
  it("reads and exports every filtered page, retaining exact large decimal strings", async () => {
    const readPage = vi.fn(
      async (
        _resource: ManufacturingResource,
        _filter?: ManufacturingRecord,
        offset = 0,
      ) =>
        page(
          records.slice(offset, offset + 100),
          offset,
          records.length,
          offset + 100 < records.length,
        ),
    );
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    render(
      <ManufacturingDocumentDownloads
        resource="stock_report"
        columns={columns}
        filter={{ location_id: "loc-1" }}
        readPage={readPage}
        identityToken="identity-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledOnce());
    expect(readPage).toHaveBeenNthCalledWith(
      3,
      "stock_report",
      { location_id: "loc-1" },
      200,
    );
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const text = await blob.text();
    expect(text.startsWith("\uFEFF")).toBe(true);
    expect(text).toContain(records[204].amount);
    expect(text).toContain('"note, ""quoted"" 204"');
    expect(text).toContain('"Description 0\nwith newline"');
  });

  it("neutralizes spreadsheet formulas while preserving RFC 4180 quoting", () => {
    const csv = buildManufacturingCsv(columns, [
      {
        id: "1",
        description: "=SUM(A1:A2)",
        amount: "\t-10",
        note: 'line\r\nnext, "quoted"',
      },
    ]);
    expect(csv).toContain('"\'=SUM(A1:A2)"');
    expect(csv).toContain('"\'\t-10"');
    expect(csv).toContain('"line\r\nnext, ""quoted"""');
  });

  it("rejects malformed or inconsistent pagination without downloading", async () => {
    const readPage = vi.fn(
      async (
        _resource: ManufacturingResource,
        _filter?: ManufacturingRecord,
        offset = 0,
      ) =>
        offset === 0
          ? page(records.slice(0, 100), 0, 205, true)
          : page(records.slice(100, 200), 50, 205, true),
    );
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test");
    render(
      <ManufacturingDocumentDownloads
        resource="production_report"
        columns={columns}
        filter={{}}
        readPage={readPage}
        identityToken="identity-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /invalid page|pagination/i,
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("invalidates an in-flight request when identity changes", async () => {
    let resolve!: (result: Page) => void;
    const readPage = vi.fn(
      () =>
        new Promise<Page>((done) => {
          resolve = done;
        }),
    );
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test");
    const view = render(
      <ManufacturingDocumentDownloads
        resource="stock_report"
        columns={columns}
        filter={{}}
        readPage={readPage}
        identityToken="identity-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    view.rerender(
      <ManufacturingDocumentDownloads
        resource="stock_report"
        columns={columns}
        filter={{}}
        readPage={readPage}
        identityToken="identity-2"
      />,
    );
    resolve(page([], 0, 0, false));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Download CSV",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it("creates real PDF bytes and multiple pages with all records", async () => {
    const bytes = await buildManufacturingPdf(columns, records);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBeGreaterThan(1);
  });
  it("rejects changed business data even when the total record count stays identical", async () => {
    const readPage = vi.fn(
      async (
        _resource: ManufacturingResource,
        _filter?: ManufacturingRecord,
        offset = 0,
      ) => ({
        ...page(
          records.slice(offset, offset + 100),
          offset,
          records.length,
          offset + 100 < records.length,
        ),
        dataset_version: offset === 0 ? "7" : "8",
      }),
    );
    const createObjectURL = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:test");
    render(
      <ManufacturingDocumentDownloads
        resource="stock_report"
        columns={columns}
        filter={{}}
        readPage={readPage}
        identityToken="identity-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /records changed/i,
    );
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it("continues a single very long record across real PDF pages without truncation", async () => {
    const bytes = await buildManufacturingPdf(
      ["note", "amount"],
      [{ note: "W".repeat(30000), amount: "900719925474099312345.99" }],
    );
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(3);
  });
});
