import { describe, expect, it, vi } from 'vitest';
import {
  MANUFACTURING_ACTIONS, MANUFACTURING_CAPABILITIES, MANUFACTURING_COMMAND_FIELDS,
  MANUFACTURING_SUMMARY_KEYS, isManufacturingBootstrap, isManufacturingPage,
  manufacturingRecordsContext, officeManufacturingManagementApi,
} from './officeManufacturingManagement';

const WORKSPACE = '10000000-0000-4000-8000-000000000001';
const ENTITY = '10000000-0000-4000-8000-000000000002';
const REQUEST = '10000000-0000-4000-8000-000000000003';
const page = (rows: Record<string, unknown>[] = []) => ({ rows, total_count: rows.length, limit: 100, offset: 0, has_more: false });
const clientFor = (data: unknown) => ({ rpc: vi.fn(async () => ({ data, error: null })) });
const bootstrap = () => ({
  role: 'manufacturing_admin', capabilities: Object.fromEntries(MANUFACTURING_CAPABILITIES.map((key) => [key, true])),
  settings: null, key_config: { configured: false }, summary: Object.fromEntries(MANUFACTURING_SUMMARY_KEYS.map((key) => [key, 0])),
});
const envelope = () => ({ nonce: btoa('n'.repeat(12)), ciphertext: btoa('c'.repeat(32)) });

describe('Manufacturing RPC contract', () => {
  it('uses only the intended role-gated read RPC and passes explicit pagination', async () => {
    const client = clientFor({ ...page(), offset: 300 });
    await officeManufacturingManagementApi.read(client, WORKSPACE, 'items', { q: 'steel' }, 100, 300);
    expect(client.rpc).toHaveBeenCalledWith('office_manufacturing_read', {
      p_workspace_id: WORKSPACE, p_resource: 'items', p_filter: { q: 'steel' }, p_limit: 100, p_offset: 300,
    });
  });
  it('validates bootstrap role, all capabilities and actual summary integers', async () => {
    const client = clientFor(bootstrap());
    expect(isManufacturingBootstrap(await officeManufacturingManagementApi.read(client, WORKSPACE, 'bootstrap'))).toBe(true);
    expect(isManufacturingBootstrap({ ...bootstrap(), role: 'owner_of_everything' })).toBe(false);
    expect(isManufacturingBootstrap({ ...bootstrap(), capabilities: {} })).toBe(false);
    expect(isManufacturingBootstrap({ ...bootstrap(), summary: { ...bootstrap().summary, held_lots_count: -1 } })).toBe(false);
    expect(isManufacturingBootstrap({ ...bootstrap(), key_config: {} })).toBe(false);
  });
  it('does not accept malformed rows or inconsistent has_more as a successful empty state', async () => {
    expect(isManufacturingPage({ ...page(), rows: [null] })).toBe(false);
    expect(isManufacturingPage({ ...page(), rows: [3] })).toBe(false);
    expect(isManufacturingPage({ ...page(), total_count: 2 })).toBe(false);
    expect(isManufacturingPage({ ...page(), limit: 201 })).toBe(false);
    await expect(officeManufacturingManagementApi.read(clientFor({}), WORKSPACE, 'items')).rejects.toThrow('pagination');
  });
  it('accepts exact decimal strings and rejects rounded JSON numeric values', async () => {
    const row = { id: ENTITY, reorder_point: '9007199254740993.000001' };
    await expect(officeManufacturingManagementApi.read(clientFor(page([row])), WORKSPACE, 'items')).resolves.toMatchObject({ rows: [row] });
    await expect(officeManufacturingManagementApi.read(clientFor(page([{ ...row, reorder_point: 0.1 }])), WORKSPACE, 'items')).rejects.toThrow('non-exact');
    await expect(officeManufacturingManagementApi.read(clientFor(page([{ ...row, reorder_point: '1e10' }])), WORKSPACE, 'items')).rejects.toThrow('non-exact');
  });
  it('requires decimal report fields rather than coercing missing values to zero', async () => {
    await expect(officeManufacturingManagementApi.read(clientFor(page([{ sku: 'A' }])), WORKSPACE, 'stock_report')).rejects.toThrow('non-exact');
  });
  it('rejects invalid workspace, unknown actions/resources and out-of-range pagination before the network', async () => {
    const client = clientFor(page());
    await expect(officeManufacturingManagementApi.read(client, 'other', 'items')).rejects.toThrow('workspace');
    await expect(officeManufacturingManagementApi.read(client, WORKSPACE, 'execute_sql' as never)).rejects.toThrow('resource');
    await expect(officeManufacturingManagementApi.read(client, WORKSPACE, 'items', {}, 201)).rejects.toThrow('pagination');
    await expect(officeManufacturingManagementApi.read(client, WORKSPACE, 'items', {}, 100, -1)).rejects.toThrow('pagination');
    await expect(officeManufacturingManagementApi.command(client, WORKSPACE, 'drop_tables' as never, {})).rejects.toThrow('action');
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it('passes exact action fields and stable idempotency key through the command RPC', async () => {
    const client = clientFor({ id: ENTITY, version: 2 });
    const payload = { id: ENTITY, expected_version: 1, idempotency_key: REQUEST };
    await officeManufacturingManagementApi.command(client, WORKSPACE, 'start_production_order', payload);
    expect(client.rpc).toHaveBeenCalledWith('office_manufacturing_command', { p_workspace_id: WORKSPACE, p_action: 'start_production_order', p_payload: payload });
  });
  it('has one explicit payload allowlist for every advertised action', () => {
    expect(MANUFACTURING_ACTIONS.length).toBeGreaterThan(30);
    for (const action of MANUFACTURING_ACTIONS) expect(MANUFACTURING_COMMAND_FIELDS[action].length).toBeGreaterThan(0);
  });
  it('rejects plaintext contacts and non-contractual action fields', async () => {
    const client = clientFor({ id: ENTITY, version: 1 });
    await expect(officeManufacturingManagementApi.command(client, WORKSPACE, 'save_supplier', {
      supplier_code: 'SUP-01', display_label: 'Supplier organization', phone: '+255123456789', idempotency_key: REQUEST,
    })).rejects.toThrow('unsupported fields');
    await expect(officeManufacturingManagementApi.command(client, WORKSPACE, 'save_supplier_private', {
      supplier_id: ENTITY, ...envelope(), expected_version: 0, name: 'Private person', idempotency_key: REQUEST,
    })).rejects.toThrow('unsupported fields');
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it('accepts only correctly-sized private envelopes and never a passphrase field', async () => {
    const client = clientFor({ id: ENTITY, version: 1 });
    await expect(officeManufacturingManagementApi.command(client, WORKSPACE, 'save_supplier_private', {
      supplier_id: ENTITY, ...envelope(), expected_version: 0, idempotency_key: REQUEST,
    })).resolves.toMatchObject({ version: 1 });
    await expect(officeManufacturingManagementApi.command(client, WORKSPACE, 'configure_private_key', {
      ...envelope(), salt: btoa('s'.repeat(16)), passphrase: 'not transmitted', idempotency_key: REQUEST,
    })).rejects.toThrow('unsupported fields');
    await expect(officeManufacturingManagementApi.command(client, WORKSPACE, 'save_supplier_private', {
      supplier_id: ENTITY, ...envelope(), nonce: btoa('short'), expected_version: 0, idempotency_key: REQUEST,
    })).rejects.toThrow('malformed encryption');
  });
  it.each([0, -1, 1.2, '1', Number.NaN])('rejects non-current or malformed optimistic version %j', async (expected_version) => {
    await expect(officeManufacturingManagementApi.command(clientFor({ id: ENTITY, version: 2 }), WORKSPACE, 'start_production_order', {
      id: ENTITY, expected_version, idempotency_key: REQUEST,
    })).rejects.toThrow('current record version');
  });
  it.each([0.1, '1e2', '-1', '0.0000001', '1000000000000000000'])('rejects non-exact/overflow operational quantity %j', async (quantity) => {
    await expect(officeManufacturingManagementApi.command(clientFor({ id: ENTITY, version: 1 }), WORKSPACE, 'receive_stock', {
      quantity, idempotency_key: REQUEST,
    })).rejects.toThrow('decimal strings');
  });
  it('requires a real UUID request key and a concrete versioned confirmation', async () => {
    await expect(officeManufacturingManagementApi.command(clientFor({ id: ENTITY, version: 1 }), WORKSPACE, 'hold_lot', {})).rejects.toThrow('request key');
    await expect(officeManufacturingManagementApi.command(clientFor({ ok: true }), WORKSPACE, 'hold_lot', { idempotency_key: REQUEST })).rejects.toThrow('save confirmation');
  });
  it('surfaces server errors without treating them as save success', async () => {
    const client = { rpc: vi.fn(async () => ({ data: null, error: { message: 'Stock changed. Refresh before retrying.' } })) };
    await expect(officeManufacturingManagementApi.command(client, WORKSPACE, 'hold_lot', { idempotency_key: REQUEST })).rejects.toThrow('Stock changed');
  });
  it('binds private records to a valid module/workspace context', () => {
    expect(manufacturingRecordsContext(WORKSPACE)).toBe(`COCCE Manufacturing:${WORKSPACE}:v1`);
    expect(() => manufacturingRecordsContext('')).toThrow('workspace');
  });
});

it('retains definite database SQLSTATE errors so ambiguous retries can be distinguished',async()=>{
 const client={rpc:vi.fn(async()=>({data:null,error:{message:'Record changed',code:'40001'}}))};
 await expect(officeManufacturingManagementApi.command(client,WORKSPACE,'save_item',{idempotency_key:REQUEST,sku:'RM-1',name:'Material',kind:'raw_material',unit:'kg',status:'active',reorder_point:'0.000000'})).rejects.toMatchObject({message:'Record changed',code:'40001'});
});
