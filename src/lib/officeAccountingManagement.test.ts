import { describe, expect, it, vi } from 'vitest';
import { ACCOUNTING_ACTIONS, ACCOUNTING_RESOURCES, accountingRecordsContext, isAccountingBootstrap, isAccountingReadPage, officeAccountingManagementApi } from './officeAccountingManagement';
import type { AccountingRpcClient } from './officeAccountingManagement';
const workspace = 'acct-team-001';
function makeClient(data: unknown = {ok:true}): AccountingRpcClient { return {rpc: vi.fn(async () => ({data,error:null}))}; }
const capabilities = Object.fromEntries(['clients','engagements','chart','periods','journals_prepare','journals_submit','journals_review','journals_post','journals_reverse','bank_reconcile','reports','evidence','findings','obligations','staff_assign','period_reopen','audit','private_records'].map((key) => [key,false]));
const summary = Object.fromEntries(['clients_count','active_engagements_count','draft_journals_count','awaiting_review_count','posted_journals_count','unreconciled_statement_lines_count','open_findings_count','due_obligations_count'].map((key) => [key,0]));

describe('Accounting API contract', () => {
  it('maintains stable explicit resource and action allowlists', () => {
    expect(ACCOUNTING_RESOURCES).toContain('trial_balance');
    expect(ACCOUNTING_RESOURCES).toContain('evidence_references');
    expect(ACCOUNTING_ACTIONS).toContain('reverse_posting');
    expect(ACCOUNTING_ACTIONS).toContain('record_filing_reference');
    expect(ACCOUNTING_ACTIONS).not.toContain('submit_tax_return' as never);
  });
  it('uses a workspace-specific crypto context and rejects unsafe workspace strings', () => {
    expect(accountingRecordsContext(workspace)).toBe(`COCCE Accounting:${workspace}:v1`);
    expect(() => accountingRecordsContext(' x ')).toThrow();
  });
  it('calls only the scoped accounting RPC with an allowlisted read and bounded pages', async () => {
    const client = makeClient({rows:[],total_count:0,offset:0,limit:200,has_more:false});
    const result = await officeAccountingManagementApi.read(client,workspace,'clients',{status:'active'},200,0);
    expect(isAccountingReadPage(result)).toBe(true);
    expect(client.rpc).toHaveBeenCalledWith('office_accounting_read',{p_workspace_id:workspace,p_resource:'clients',p_filter:{status:'active'},p_limit:200,p_offset:0});
    await expect(officeAccountingManagementApi.read(client,workspace,'fake' as never)).rejects.toThrow('Unknown');
    await expect(officeAccountingManagementApi.read(client,workspace,'clients',[] as never)).rejects.toThrow('filters');
    await expect(officeAccountingManagementApi.read(client,workspace,'clients',{},201,0)).rejects.toThrow('page size');
    await expect(officeAccountingManagementApi.read(client,workspace,'clients',{},10,-1)).rejects.toThrow('page offset');
  });
  it('allows normal scoped command payloads but rejects unapproved actions', async () => {
    const client = makeClient();
    await officeAccountingManagementApi.command(client,workspace,'save_journal',{client_id:'client-1',idempotency_key:'id-1'});
    expect(client.rpc).toHaveBeenCalledWith('office_accounting_command',{p_workspace_id:workspace,p_action:'save_journal',p_payload:{client_id:'client-1',idempotency_key:'id-1'}});
    await expect(officeAccountingManagementApi.command(client,workspace,'file_vat' as never,{})).rejects.toThrow('Unknown');
    await expect(officeAccountingManagementApi.command(client,workspace,'save_journal',[] as never)).rejects.toThrow('object');
  });
  it('never accepts plaintext fields for encrypted private client data or private key setup', async () => {
    const client = makeClient();
    await expect(officeAccountingManagementApi.command(client,workspace,'save_client_private',{client_id:'c1',legal_name:'Sensitive Corp',nonce:'x',ciphertext:'y',idempotency_key:'z'})).rejects.toThrow('encrypted fields only');
    await expect(officeAccountingManagementApi.command(client,workspace,'configure_private_key',{passphrase:'secret',salt:'s',nonce:'n',ciphertext:'c',idempotency_key:'z'})).rejects.toThrow('encrypted fields only');
    await officeAccountingManagementApi.command(client,workspace,'save_client_private',{client_id:'c1',nonce:'A'.repeat(16),ciphertext:'B'.repeat(32),idempotency_key:'z'});
    expect(client.rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects private evidence memos without an encrypted envelope', async () => {
    const client = makeClient();
    await expect(officeAccountingManagementApi.command(client,workspace,'save_evidence_reference',{client_id:'c1',title:'e',encrypted_memo:{plaintext:'do not send'}})).rejects.toThrow('encrypted');
  });
  it('distinguishes valid zero-data bootstrap and pagination from malformed responses', () => {
    expect(isAccountingBootstrap({role:'accounting_viewer',capabilities,settings:null,key_config:{configured:false},summary})).toBe(true);
    expect(isAccountingBootstrap({role:'accounting_viewer',capabilities,settings:null,key_config:{configured:false},summary:{...summary,clients_count:'0'}})).toBe(false);
    expect(isAccountingBootstrap({role:'accounting_viewer',capabilities,settings:null,key_config:{configured:false},summary:{}})).toBe(false);
    expect(isAccountingReadPage({rows:[],total_count:700,offset:600,limit:200,has_more:true})).toBe(true);
    expect(isAccountingReadPage({rows:['not-a-row'],total_count:1,offset:0,limit:200,has_more:false})).toBe(false);
    expect(isAccountingReadPage([])).toBe(false);
  });
});
