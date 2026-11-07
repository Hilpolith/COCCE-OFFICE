// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import BusinessWorkspacePanels from './BusinessWorkspacePanels';
import type { BusinessWorkspacePanelsProps } from './lib/businessWorkspaceUi';
const caps = { crm:true, quotes:true, approve_sales:true, delivery:true, finance:true, procurement:true, projects:true, compliance:true, settings:true, staff:true, private_contacts:true, audit:true };
const order = { order_id:'order-1', order_number:'ORD-1', status:'confirmed', version:2 };
const purchase = { supplier_order_id:'po-1', po_number:'PO-1', status:'issued', version:3 };
function setup(tab: BusinessWorkspacePanelsProps['tab'], extra: Partial<BusinessWorkspacePanelsProps> = {}) {
  const command = vi.fn().mockResolvedValue({ entity_id:'saved', version:3 });
  const props: BusinessWorkspacePanelsProps = { tab, data:{}, capabilities:caps, role:'business_admin', settings:null, members:[], busy:false, hasMore:{}, loadingMore:{}, loadMore:vi.fn(), readRows:vi.fn().mockResolvedValue([]), command, reportError:vi.fn(), privateContacts:null, onNavigate:vi.fn(), officeName:'Test office', ...extra };
  render(<BusinessWorkspacePanels {...props}/>);return {command:props.command,props};
}
afterEach(cleanup);
describe('Business saved fulfillment and detail reads', () => {
  it('edits a planned delivery with its saved order-line quantities and expected version', async () => {
    const readRows = vi.fn().mockImplementation(async resource => resource==='sales_order_lines' ? [{order_line_id:'ol-1',description:'Widget',quantity_ordered:'5',quantity_delivered:'0'}] : [{order_line_id:'ol-1',quantity:'1.5'}]);
    const {command} = setup('sales',{data:{sales_orders:[order],deliveries:[{delivery_id:'d-1',delivery_number:'DEL-1',order_id:'order-1',status:'planned',dispatch_date:'2026-11-07',version:4}]},readRows});
    fireEvent.click(within(screen.getByText('DEL-1').closest('article')!).getByRole('button',{name:'Edit'}));
    const quantity = await screen.findByLabelText('Quantity for Widget');expect((quantity as HTMLInputElement).value).toBe('1.5');
    fireEvent.change(quantity,{target:{value:'2.25'}});fireEvent.submit(quantity.closest('form')!);
    await waitFor(()=>expect(command).toHaveBeenCalledWith('save_delivery',expect.objectContaining({delivery_id:'d-1',order_id:'order-1',expected_version:4,lines:[{order_line_id:'ol-1',quantity:'2.25'}]}),expect.any(String)));
  });
  it('edits a draft receiving with its saved purchase-order-line quantities', async () => {
    const readRows = vi.fn().mockImplementation(async resource => resource==='purchase_order_lines' ? [{po_line_id:'pol-1',description:'Paper',quantity_ordered:'10',quantity_received:'0'}] : [{po_line_id:'pol-1',quantity:'2'}]);
    const {command} = setup('procurement',{data:{purchase_orders:[purchase],receivings:[{receiving_id:'r-1',receiving_number:'REC-1',supplier_order_id:'po-1',status:'draft',received_at:'2026-11-07T10:00:00Z',version:5}]},readRows});
    fireEvent.click(within(screen.getByText('REC-1').closest('article')!).getByRole('button',{name:'Edit'}));
    const quantity = await screen.findByLabelText('Quantity for Paper');expect((quantity as HTMLInputElement).value).toBe('2');
    fireEvent.submit(quantity.closest('form')!);
    await waitFor(()=>expect(command).toHaveBeenCalledWith('save_receiving',expect.objectContaining({receiving_id:'r-1',supplier_order_id:'po-1',expected_version:5,lines:[{po_line_id:'pol-1',quantity:'2'}]}),expect.any(String)));
  });
  it('does not apply a late edit read after its loading operation is canceled', async () => {
    let resolve!: (rows: never[])=>void;const deferred = new Promise<never[]>(done=>{resolve=done;});
    setup('sales',{data:{sales_orders:[order],deliveries:[{delivery_id:'d-1',delivery_number:'DEL-1',order_id:'order-1',status:'planned',version:4}]},readRows:vi.fn().mockReturnValue(deferred)});
    fireEvent.click(within(screen.getByText('DEL-1').closest('article')!).getByRole('button',{name:'Edit'}));
    fireEvent.click(screen.getByRole('button',{name:'Cancel loading'}));
    await act(async()=>{resolve([]);});
    expect((screen.getByLabelText('Sales order') as HTMLSelectElement).value).toBe('');
    expect(screen.queryByRole('button',{name:'Cancel loading'})).toBeNull();
  });
  it('reads beyond the first 200 detail lines without enabling edits on an issued quotation', async () => {
    const first = Array.from({length:200},(_,i)=>({line_id:`line-${i}`,description:`Item ${i}`,quantity:'1',unit_price:'1',line_no:i+1}));
    const readRows=vi.fn().mockImplementation(async (_resource,_filter,_limit,offset)=>offset===0?first:[{line_id:'last',description:'Last item',quantity:'1',unit_price:'1',line_no:201}]);
    setup('sales',{data:{quotations:[{quote_id:'q-1',quote_number:'Q-1',status:'issued',version:2}]},readRows});
    fireEvent.click(screen.getByRole('button',{name:'Lines'}));
    await screen.findByText(/Last item/);
    expect(readRows).toHaveBeenCalledWith('quotation_lines',{quote_id:'q-1'},200,200);
    expect(screen.queryByRole('button',{name:'Save line'})).toBeNull();
  });
});
