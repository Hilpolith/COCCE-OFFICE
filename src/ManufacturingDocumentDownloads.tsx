import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
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

export type ManufacturingDocumentDownloadsProps = {
  resource: "stock_report" | "production_report";
  columns: string[];
  filter: ManufacturingRecord;
  readPage: (
    resource: ManufacturingResource,
    filter?: ManufacturingRecord,
    offset?: number,
  ) => Promise<Page | null>;
  identityToken: string;
};

type PdfModule = typeof import("pdf-lib");

const CSV_DANGEROUS = /^\s*[=+\-@]/u;

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function cellValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return String(value);
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

export function csvCell(value: unknown): string {
  const raw = cellValue(value);
  const safe = CSV_DANGEROUS.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

export function buildManufacturingCsv(
  columns: string[],
  rows: ManufacturingRecord[],
): string {
  const header = columns.map((column) => csvCell(humanize(column))).join(",");
  const body = rows.map((row) =>
    columns.map((column) => csvCell(row[column])).join(","),
  );
  return `\uFEFF${[header, ...body].join("\r\n")}\r\n`;
}

function codePointNotation(character: string): string {
  return [...character]
    .map(
      (part) =>
        `[U+${part.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}]`,
    )
    .join("");
}

function pdfSafeText(
  font: { encodeText(text: string): unknown },
  text: string,
): string {
  let output = "";
  for (const character of text) {
    try {
      font.encodeText(character);
      output += character;
    } catch {
      output += codePointNotation(character);
    }
  }
  return output;
}

function wrapText(
  font: { widthOfTextAtSize(text: string, size: number): number },
  text: string,
  width: number,
  size: number,
): string[] {
  const lines: string[] = [];
  for (const paragraph of text
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .split("\n")) {
    let line = "";
    for (const character of paragraph) {
      if (line && font.widthOfTextAtSize(line + character, size) > width) {
        lines.push(line);
        line = "";
      }
      line += character;
    }
    lines.push(line);
  }
  return lines.length ? lines : [""];
}
export async function buildManufacturingPdf(
  columns: string[],
  rows: ManufacturingRecord[],
): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = (await import(
    "pdf-lib"
  )) as PdfModule;
  const document = await PDFDocument.create();
  const regular = await document.embedFont(StandardFonts.Helvetica),
    bold = await document.embedFont(StandardFonts.HelveticaBold);
  const width = 841.89,
    height = 595.28,
    margin = 30,
    footer = 30,
    lineHeight = 10,
    size = 7;
  const colWidth = (width - 2 * margin) / Math.max(columns.length, 1);
  const ink = rgb(0.12, 0.2, 0.18);
  let page = document.addPage([width, height]),
    y = height - margin;
  const draw = (
    text: string,
    x: number,
    at: number,
    font = regular,
    fontSize = size,
  ) => page.drawText(text, { x, y: at, font, size: fontSize, color: ink });
  const labels = columns.map((column) =>
    pdfSafeText(
      bold,
      humanize(column) +
        (column.includes("cost") || column === "value_tzs" ? " (TZS)" : ""),
    ),
  );
  const headers = labels.map((label) =>
    wrapText(bold, label, colWidth - 7, size),
  );
  const heading = () => {
    draw("Manufacturing operational report", margin, y, bold, 12);
    y -= 18;
    draw(
      `${rows.length} records · Costs in TZS · Not a fiscal invoice or regulator approval`,
      margin,
      y,
      regular,
      8,
    );
    y -= 16;
    const height =
      Math.max(...headers.map((parts) => parts.length), 1) * lineHeight;
    headers.forEach((parts, column) =>
      parts.forEach((line, index) =>
        draw(line, margin + column * colWidth, y - index * lineHeight, bold),
      ),
    );
    y -= height + 6;
    page.drawLine({
      start: { x: margin, y: y + 3 },
      end: { x: width - margin, y: y + 3 },
      thickness: 0.5,
      color: rgb(0.7, 0.77, 0.73),
    });
  };
  const newPage = () => {
    page = document.addPage([width, height]);
    y = height - margin;
    heading();
  };
  heading();
  for (const row of rows) {
    const cells = columns.map((column) =>
      wrapText(
        regular,
        pdfSafeText(regular, cellValue(row[column])),
        colWidth - 7,
        size,
      ),
    );
    const lines = Math.max(...cells.map((parts) => parts.length), 1);
    let offset = 0;
    while (offset < lines) {
      const room = Math.floor((y - footer - 18) / lineHeight);
      if (room < 1) {
        newPage();
        continue;
      }
      const count = Math.min(room, lines - offset);
      cells.forEach((parts, column) =>
        parts
          .slice(offset, offset + count)
          .forEach((line, index) =>
            draw(line, margin + column * colWidth, y - index * lineHeight),
          ),
      );
      y -= count * lineHeight;
      offset += count;
      if (offset < lines) newPage();
    }
    y -= 7;
  }
  const total = document.getPageCount();
  document.getPages().forEach((sheet, index) => {
    sheet.drawText(
      `[U+XXXX] notation marks unsupported characters; CSV preserves original Unicode.`,
      { x: margin, y: 14, font: regular, size: 6, color: rgb(0.4, 0.45, 0.43) },
    );
    sheet.drawText(`Page ${index + 1} of ${total}`, {
      x: width - margin - 70,
      y: 14,
      font: regular,
      size: 6,
      color: rgb(0.4, 0.45, 0.43),
    });
  });
  document.setTitle("Manufacturing operational report");
  return document.save();
}

function downloadBlob(
  content: string | Uint8Array,
  type: string,
  filename: string,
): void {
  if (
    typeof document === "undefined" ||
    typeof URL === "undefined" ||
    typeof Blob === "undefined"
  )
    throw new Error("Downloads are only available in a browser.");
  const blob =
    typeof content === "string"
      ? new Blob([content], { type })
      : new Blob([new Uint8Array(content)], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}

function reportKey(row: ManufacturingRecord): string | null {
  for (const key of ["id", "item_id", "order_id"]) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]) !== "")
      return `${key}:${String(row[key])}`;
  }
  return null;
}

async function readAllPages(
  props: ManufacturingDocumentDownloadsProps,
  isCurrent: () => boolean,
  onProgress: (count: number) => void,
): Promise<ManufacturingRecord[]> {
  const rows: ManufacturingRecord[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let expectedTotal: number | undefined;
  let expectedVersion: string | undefined;
  let previousCount = -1;
  for (;;) {
    if (!isCurrent())
      throw new DOMException("Download cancelled", "AbortError");
    const page = await props.readPage(
      props.resource as ManufacturingResource,
      props.filter,
      offset,
    );
    if (!isCurrent())
      throw new DOMException("Download cancelled", "AbortError");
    if (
      !page ||
      !Array.isArray(page.rows) ||
      !Number.isInteger(page.offset) ||
      !Number.isInteger(page.limit) ||
      page.limit <= 0 ||
      page.offset !== offset ||
      page.rows.length > page.limit ||
      !Number.isInteger(page.total_count) ||
      page.total_count < 0
    )
      throw new Error(
        "The report changed or returned an invalid page. Please retry.",
      );
    if (
      (page.has_more || offset > 0) &&
      typeof page.dataset_version !== "string"
    )
      throw new Error(
        "A consistent report snapshot could not be confirmed. Refresh and retry.",
      );
    if (expectedVersion === undefined) expectedVersion = page.dataset_version;
    if (expectedVersion !== page.dataset_version)
      throw new Error(
        "Records changed while the report was being read. Retry to download one consistent dataset.",
      );
    if (expectedTotal === undefined) expectedTotal = page.total_count;
    if (page.total_count !== expectedTotal)
      throw new Error(
        "The report changed while it was downloading. Please retry.",
      );
    if (page.rows.length === 0 && page.has_more)
      throw new Error(
        "The report returned an empty page while more rows were promised. Please retry.",
      );
    for (const row of page.rows) {
      const key = reportKey(row);
      if (key && seen.has(key))
        throw new Error(
          "The report returned duplicate rows while it was downloading. Please retry.",
        );
      if (key) seen.add(key);
      rows.push(row);
    }
    if (rows.length <= previousCount)
      throw new Error("The report page did not advance. Please retry.");
    previousCount = rows.length;
    onProgress(rows.length);
    if (!page.has_more) {
      if (rows.length !== expectedTotal)
        throw new Error(
          "The report was incomplete or changed while it was downloading. Please retry.",
        );
      return rows;
    }
    if (page.rows.length === 0 || offset + page.limit <= offset)
      throw new Error("The report pagination did not advance. Please retry.");
    offset += page.limit;
  }
}

function ErrorMessage({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="manufacturing-alert">
      {children}
    </div>
  );
}

export default function ManufacturingDocumentDownloads(
  props: ManufacturingDocumentDownloadsProps,
) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const mounted = useRef(true);
  const identityRef = useRef(props.identityToken);
  const signature = JSON.stringify([
    props.resource,
    props.filter,
    props.columns,
  ]);
  const signatureRef = useRef(signature);
  const previousContext = useRef([props.identityToken, signature]);
  identityRef.current = props.identityToken;
  signatureRef.current = signature;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);
  useEffect(() => {
    if (
      previousContext.current[0] !== props.identityToken ||
      previousContext.current[1] !== signature
    ) {
      previousContext.current = [props.identityToken, signature];
      identityRef.current = props.identityToken;
      signatureRef.current = signature;
      generation.current += 1;
      setBusy(false);
      setProgress(0);
      setError("");
    }
  }, [props.identityToken, signature]);
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        generation.current += 1;
        if (mounted.current) setBusy(false);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  const cancel = useCallback(() => {
    generation.current += 1;
    setBusy(false);
  }, []);
  const start = useCallback(
    async (format: "csv" | "pdf") => {
      const token = ++generation.current;
      const isCurrent = () =>
        mounted.current &&
        token === generation.current &&
        identityRef.current === props.identityToken &&
        signatureRef.current === signature &&
        document.visibilityState !== "hidden";
      setBusy(true);
      setProgress(0);
      setError("");
      try {
        const rows = await readAllPages(props, isCurrent, setProgress);
        if (!isCurrent()) return;
        if (format === "csv")
          downloadBlob(
            buildManufacturingCsv(props.columns, rows),
            "text/csv;charset=utf-8",
            `manufacturing-${props.resource === "stock_report" ? "stock" : "production"}-report.csv`,
          );
        else {
          const bytes = await buildManufacturingPdf(props.columns, rows);
          if (!isCurrent()) return;
          downloadBlob(
            bytes,
            "application/pdf",
            `manufacturing-${props.resource === "stock_report" ? "stock" : "production"}-report.pdf`,
          );
        }
      } catch (cause) {
        if (
          isCurrent() &&
          !(cause instanceof DOMException && cause.name === "AbortError")
        )
          setError(
            cause instanceof Error
              ? cause.message
              : "The report could not be downloaded. Please retry.",
          );
      } finally {
        if (isCurrent()) setBusy(false);
      }
    },
    [props, signature],
  );
  return (
    <section aria-label="Manufacturing report downloads">
      {error && <ErrorMessage>{error}</ErrorMessage>}
      {busy && (
        <div role="status">Preparing report: {progress} records read.</div>
      )}
      <button
        className="manufacturing-button"
        type="button"
        disabled={busy}
        onClick={() => void start("csv")}
      >
        {busy ? "Preparing…" : "Download CSV"}
      </button>
      <button
        className="manufacturing-button"
        type="button"
        disabled={busy}
        onClick={() => void start("pdf")}
      >
        {busy ? "Preparing…" : "Download PDF"}
      </button>
      {busy && (
        <button className="manufacturing-button" type="button" onClick={cancel}>
          Cancel
        </button>
      )}
    </section>
  );
}
