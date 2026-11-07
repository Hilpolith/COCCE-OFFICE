import { useEffect, useRef, useState } from 'react';
import { Download } from 'lucide-react';
import type { BusinessRecord, BusinessResource } from './lib/officeBusinessManagement';
import type { BusinessReadRows } from './lib/businessWorkspaceUi';
import { downloadBusinessDocument } from './lib/businessDocumentExport';
import type { BusinessDocumentExport, BusinessDocumentKind } from './lib/businessDocumentExport';

type Props = {
  kind: BusinessDocumentKind;
  header: BusinessRecord;
  officeName: string;
  readRows: BusinessReadRows;
  reportError: (message: string) => void;
};
const config: Record<BusinessDocumentKind, { resource: BusinessResource; lines: BusinessResource; id: string; reference: string; label: string }> = {
  quotation: { resource: 'quotations', lines: 'quotation_lines', id: 'quote_id', reference: 'quote_number', label: 'quotation' },
  sales_order: { resource: 'sales_orders', lines: 'sales_order_lines', id: 'order_id', reference: 'order_number', label: 'sales order' },
  invoice: { resource: 'invoices', lines: 'invoice_lines', id: 'invoice_id', reference: 'invoice_number', label: 'invoice' },
  purchase_order: { resource: 'purchase_orders', lines: 'purchase_order_lines', id: 'supplier_order_id', reference: 'po_number', label: 'purchase order' },
  delivery: { resource: 'deliveries', lines: 'delivery_lines', id: 'delivery_id', reference: 'delivery_number', label: 'delivery note' },
};
const asText = (value: unknown) => value == null ? '' : String(value);
const optionalText = (value: unknown) => value == null ? undefined : String(value);

export default function BusinessDocumentDownloads({ kind, header, officeName, readRows, reportError }: Props) {
  const settings = config[kind];
  const entityId = asText(header[settings.id]);
  const epoch = useRef(0);
  const inFlight = useRef(false);
  const [formatInFlight, setFormatInFlight] = useState<'pdf' | 'csv' | null>(null);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    epoch.current += 1;
    inFlight.current = false;
    setFormatInFlight(null);
    setNotice('');
    return () => { epoch.current += 1; inFlight.current = false; };
  }, [entityId, kind, readRows]);

  const prepare = async (format: 'pdf' | 'csv') => {
    if (!entityId || inFlight.current) return;
    const requestEpoch = epoch.current;
    const current = () => epoch.current === requestEpoch;
    inFlight.current = true;
    setFormatInFlight(format);
    setNotice('');
    const exact = async (resource: BusinessResource, key: string, value: string) => {
      const rows = await readRows(resource, { [key]: value }, 1, 0);
      if (!current()) throw new Error('The active Business workspace changed.');
      const row = rows.find((candidate) => asText(candidate[key]) === value);
      if (!row) throw new Error('This document or its linked organization is no longer available. Refresh the workspace.');
      return row;
    };
    const allLines = async (resource: BusinessResource, key: string, value: string) => {
      const output: BusinessRecord[] = [];
      for (let offset = 0; ; offset += 200) {
        const page = await readRows(resource, { [key]: value }, 200, offset);
        if (!current()) throw new Error('The active Business workspace changed.');
        output.push(...page);
        if (page.length < 200) return output;
      }
    };
    try {
      const snapshot = await exact(settings.resource, settings.id, entityId);
      const lineRows = await allLines(settings.lines, settings.id, entityId);
      let currency = asText(snapshot.currency_code);
      let partyId = asText(snapshot.account_id);
      let exportLines: BusinessDocumentExport['lines'];
      if (kind === 'delivery') {
        const orderId = asText(snapshot.order_id);
        const order = await exact('sales_orders', 'order_id', orderId);
        const orderLines = await allLines('sales_order_lines', 'order_id', orderId);
        currency = asText(order.currency_code);
        partyId = asText(order.account_id);
        exportLines = lineRows.map((line) => {
          const source = orderLines.find((candidate) => asText(candidate.order_line_id) === asText(line.order_line_id));
          if (!source) throw new Error('A delivery line is missing its source order line. Refresh before exporting.');
          return { description: asText(source.description), quantity: asText(line.quantity), unitPrice: '', lineTotal: '' };
        });
      } else {
        exportLines = lineRows.map((line) => ({
          description: asText(line.description),
          quantity: asText(line.quantity ?? line.quantity_ordered),
          unitPrice: asText(line.unit_price ?? line.unit_cost),
          lineTotal: asText(line.line_total),
          discount: optionalText(line.discount_amount),
        }));
      }
      let party: BusinessRecord;
      if (kind === 'purchase_order') party = await exact('suppliers', 'supplier_id', asText(snapshot.supplier_id));
      else party = await exact('accounts', 'account_id', partyId);
      const confirmed = await exact(settings.resource, settings.id, entityId);
      if (asText(confirmed.version) !== asText(snapshot.version)) throw new Error('The document changed while its download was being prepared. Try again to use the latest version.');
      if (!current()) return;
      const input: BusinessDocumentExport = {
        kind,
        reference: asText(snapshot[settings.reference]),
        status: asText(snapshot.status),
        organization: officeName,
        partyLabel: asText(party.legal_name ?? party.display_name ?? party.name),
        currency,
        date: optionalText(snapshot.issue_date ?? snapshot.dispatch_date ?? snapshot.issued_at),
        dueDate: optionalText(snapshot.due_date ?? snapshot.valid_until),
        lines: exportLines,
        ...(kind === 'delivery' ? {} : {
          subtotal: optionalText(snapshot.subtotal),
          discountTotal: optionalText(snapshot.discount_total),
          grandTotal: optionalText(snapshot.grand_total),
          receivedTotal: optionalText(snapshot.received_total),
          outstandingTotal: optionalText(snapshot.outstanding_total),
        }),
      };
      await downloadBusinessDocument(input, format, current);
      if (current()) setNotice('Local download prepared.');
    } catch (error) {
      if (current()) {
        const message = error instanceof Error ? error.message : 'Unable to prepare this Business document.';
        setNotice(message);
        reportError(message);
      }
    } finally {
      if (current()) { inFlight.current = false; setFormatInFlight(null); }
    }
  };

  return <div className="business-document-downloads">
    {(['pdf', 'csv'] as const).map((format) => <button key={format} type="button" className="business-panel-button" disabled={!entityId || formatInFlight !== null} title="Download locally; not an automatic cloud file sync" aria-label={`Download ${settings.label} ${asText(header[settings.reference])} ${format.toUpperCase()}`} onClick={() => void prepare(format)}><Download size={14} aria-hidden="true" />{formatInFlight === format ? 'Preparing…' : format.toUpperCase()}</button>)}
    {notice && <span role="status" aria-live="polite">{notice}</span>}
  </div>;
}
