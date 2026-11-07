// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BusinessDocumentDownloads from './BusinessDocumentDownloads';
import { downloadBusinessDocument } from './lib/businessDocumentExport';
import type { BusinessReadRows } from './lib/businessWorkspaceUi';
import type { BusinessRecord } from './lib/officeBusinessManagement';
vi.mock('./lib/businessDocumentExport', () => ({ downloadBusinessDocument: vi.fn().mockResolvedValue(undefined) }));
const download = vi.mocked(downloadBusinessDocument);
const quote = { quote_id: 'q1', account_id: 'a1', quote_number: 'QUO-1', status: 'issued', currency_code: 'TZS', subtotal: '201.00', discount_total: '0.00', grand_total: '201.00', version: 3 };
const account = { account_id: 'a1', legal_name: 'Synthetic Customer', contact_email: 'do-not-export@example.invalid' };
const makeReader = (lines: BusinessRecord[] = [{ line_id: 'l1', description: 'Synthetic service', quantity: '1', unit_price: '1.00', line_total: '1.00' }]) => vi.fn<BusinessReadRows>(async (resource, _filter, limit = 200, offset = 0) => {
  if (resource === 'quotations') return [quote];
  if (resource === 'accounts') return [account];
  if (resource === 'quotation_lines') return lines.slice(offset, offset + limit);
  return [];
});
afterEach(cleanup);
beforeEach(() => vi.clearAllMocks());
describe('Business document downloads', () => {
  it('loads every filtered line page and exports only allowlisted public document fields', async () => {
    const lines = Array.from({ length: 201 }, (_, i) => ({ line_id: `l${i}`, description: `Synthetic service ${i}`, quantity: '1', unit_price: '1.00', line_total: '1.00' }));
    const readRows = makeReader(lines);
    render(<BusinessDocumentDownloads kind="quotation" header={quote} officeName="Synthetic Business" readRows={readRows} reportError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Download quotation QUO-1 PDF' }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(readRows).toHaveBeenCalledWith('quotation_lines', { quote_id: 'q1' }, 200, 200);
    const [input, format, current] = download.mock.calls[0];
    expect(input.lines).toHaveLength(201);
    expect(input.partyLabel).toBe('Synthetic Customer');
    expect(JSON.stringify(input)).not.toContain('do-not-export');
    expect(input.grandTotal).toBe('201.00');
    expect(format).toBe('pdf');
    expect(current?.()).toBe(true);
    expect(await screen.findByText('Local download prepared.')).toBeTruthy();
  });
  it('rejects an inconsistent document rather than exporting mismatched lines and totals', async () => {
    const readRows = makeReader(); let reads = 0;
    readRows.mockImplementation(async (resource) => resource === 'quotations' ? [{ ...quote, version: ++reads === 1 ? 3 : 4 }] : resource === 'accounts' ? [account] : [{ description: 'Line', quantity: '1', unit_price: '1', line_total: '1' }]);
    const reportError = vi.fn();
    render(<BusinessDocumentDownloads kind="quotation" header={quote} officeName="Synthetic Business" readRows={readRows} reportError={reportError} />);
    fireEvent.click(screen.getByRole('button', { name: /CSV$/ }));
    await waitFor(() => expect(reportError).toHaveBeenCalledWith(expect.stringContaining('changed while')));
    expect(download).not.toHaveBeenCalled();
  });
  it('discards an old document request immediately after its component scope changes', async () => {
    let resolve!: (rows: BusinessRecord[]) => void;
    const readRows = vi.fn<BusinessReadRows>(() => new Promise((done) => { resolve = done; }));
    const reportError = vi.fn();
    const view = render(<BusinessDocumentDownloads kind="quotation" header={quote} officeName="Synthetic Business" readRows={readRows} reportError={reportError} />);
    fireEvent.click(screen.getByRole('button', { name: /PDF$/ }));
    view.rerender(<BusinessDocumentDownloads kind="quotation" header={{ ...quote, quote_id: 'other' }} officeName="Synthetic Business" readRows={readRows} reportError={reportError} />);
    resolve([quote]);
    await waitFor(() => expect((screen.getByRole('button', { name: /PDF$/ }) as HTMLButtonElement).disabled).toBe(false));
    expect(download).not.toHaveBeenCalled();
    expect(reportError).not.toHaveBeenCalled();
  });
  it('uses actual dispatched quantities without inventing money on delivery notes', async () => {
    const delivery = { delivery_id: 'd1', order_id: 'o1', delivery_number: 'DN-1', status: 'delivered', version: 2 };
    const readRows = vi.fn<BusinessReadRows>(async (resource) => resource === 'deliveries' ? [delivery] : resource === 'delivery_lines' ? [{ order_line_id: 'ol1', quantity: '2.5000' }] : resource === 'sales_orders' ? [{ order_id: 'o1', account_id: 'a1', currency_code: 'TZS' }] : resource === 'sales_order_lines' ? [{ order_line_id: 'ol1', description: 'Delivered goods', unit_price: '5.00' }] : [account]);
    render(<BusinessDocumentDownloads kind="delivery" header={delivery} officeName="Synthetic Business" readRows={readRows} reportError={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /CSV$/ }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(download.mock.calls[0][0]).toMatchObject({ kind: 'delivery', lines: [{ description: 'Delivered goods', quantity: '2.5000', unitPrice: '', lineTotal: '' }] });
    expect(download.mock.calls[0][0].grandTotal).toBeUndefined();
  });
  it('reports a real read failure and re-enables the download controls', async () => {
    const readRows = vi.fn<BusinessReadRows>().mockRejectedValue(new Error('Access expired.'));
    const reportError = vi.fn();
    render(<BusinessDocumentDownloads kind="quotation" header={quote} officeName="Synthetic Business" readRows={readRows} reportError={reportError} />);
    fireEvent.click(screen.getByRole('button', { name: /CSV$/ }));
    await waitFor(() => expect(reportError).toHaveBeenCalledWith('Access expired.'));
    expect(download).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: /CSV$/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
