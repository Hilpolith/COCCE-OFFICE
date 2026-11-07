import type { SupabaseClient } from '@supabase/supabase-js';
import type { OfficeRecordsKeyConfig } from './officePrivateRecordsCrypto';

export type AccountingRole = 'accounting_admin' | 'engagement_manager' | 'accountant' | 'reviewer' | 'client_coordinator' | 'accounting_viewer' | 'unassigned';
export interface AccountingCapabilities extends Record<string, boolean> {
  clients: boolean; engagements: boolean; chart: boolean; periods: boolean;
  journals_prepare: boolean; journals_submit: boolean; journals_review: boolean;
  journals_post: boolean; journals_reverse: boolean; bank_reconcile: boolean;
  reports: boolean; evidence: boolean; findings: boolean; obligations: boolean;
  staff_assign: boolean; period_reopen: boolean; audit: boolean; private_records: boolean;
}
export type AccountingRecord = Record<string, unknown>;
export interface AccountingBootstrap {
  role: AccountingRole;
  capabilities: AccountingCapabilities;
  settings: AccountingRecord | null;
  key_config: OfficeRecordsKeyConfig;
  summary: AccountingRecord;
}
export interface AccountingReadPage<T extends AccountingRecord = AccountingRecord> {
  rows: T[]; total_count: number; offset: number; limit: number; has_more: boolean;
}
export interface AccountingRpcClient {
  rpc(name: string, params?: Record<string, unknown>): Promise<{data: unknown; error: {message: string} | null}>;
}
export const ACCOUNTING_RESOURCES = [
  'bootstrap','settings','staff_assignments','clients','client_private','engagements','chart_accounts','reporting_periods',
  'journals','journal_lines','postings','reversals','bank_accounts','bank_statements','bank_statement_lines',
  'trial_balance','general_ledger','profit_and_loss','balance_sheet','evidence_references','findings','obligations','audit',
] as const;
export type AccountingResource = (typeof ACCOUNTING_RESOURCES)[number];

export const ACCOUNTING_ACTIONS = [
  'save_accounting_settings','assign_client_staff','save_client','save_client_private','save_engagement','transition_engagement','configure_private_key',
  'save_chart_account','archive_chart_account','save_reporting_period','close_reporting_period','reopen_reporting_period',
  'save_journal','save_journal_line','delete_journal_line','submit_journal','return_journal','approve_journal','post_journal','reverse_posting',
  'save_bank_account','save_bank_statement','save_bank_statement_line','import_bank_statement_lines','match_statement_line','unmatch_statement_line','exclude_statement_line','lock_bank_statement',
  'save_evidence_reference','supersede_evidence_reference','save_finding','transition_finding','close_finding','save_obligation','record_filing_reference','transition_obligation',
] as const;
export type AccountingAction = (typeof ACCOUNTING_ACTIONS)[number];

const PRIVATE_CLIENT_KEYS = ['client_id','nonce','ciphertext','expected_version','idempotency_key'] as const;
const PRIVATE_CONFIG_KEYS = ['salt','nonce','ciphertext','idempotency_key'] as const;
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function integer(value: number, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}.`);
  return value;
}
function validatePrivateEnvelope(value: unknown, allowed: readonly string[], label: string): void {
  if (!isObject(value) || Object.keys(value).some((key) => !allowed.includes(key))) throw new Error(`${label} accepts encrypted fields only; plaintext personal data is not allowed.`);
}
async function rpc<T>(client: AccountingRpcClient | SupabaseClient, name: string, params: Record<string, unknown>): Promise<T> {
  const {data, error} = await (client as AccountingRpcClient).rpc(name, params);
  if (error) throw new Error(error.message);
  return data as T;
}
export function accountingRecordsContext(workspaceId: string): string {
  if (!workspaceId || workspaceId.length > 128 || workspaceId.trim() !== workspaceId) throw new Error('A valid Accounting workspace is required.');
  return `COCCE Accounting:${workspaceId}:v1`;
}
export function isAccountingReadPage<T extends AccountingRecord = AccountingRecord>(value: unknown): value is AccountingReadPage<T> {
  if (!isObject(value) || !Array.isArray(value.rows) || !value.rows.every(isObject) || typeof value.has_more !== 'boolean') return false;
  return Number.isSafeInteger(value.total_count) && (value.total_count as number) >= 0
    && Number.isSafeInteger(value.offset) && (value.offset as number) >= 0
    && Number.isSafeInteger(value.limit) && (value.limit as number) > 0 && (value.limit as number) <= 200;
}
export function isAccountingBootstrap(value: unknown): value is AccountingBootstrap {
  if (!isObject(value) || !isObject(value.capabilities) || !isObject(value.summary) || !isObject(value.key_config)) return false;
  const roles: AccountingRole[] = ['accounting_admin','engagement_manager','accountant','reviewer','client_coordinator','accounting_viewer','unassigned'];
  const capNames: (keyof AccountingCapabilities)[] = ['clients','engagements','chart','periods','journals_prepare','journals_submit','journals_review','journals_post','journals_reverse','bank_reconcile','reports','evidence','findings','obligations','staff_assign','period_reopen','audit','private_records'];
  const caps = value.capabilities as Record<string, unknown>;
  const counts = value.summary as Record<string, unknown>;
  if (!roles.includes(value.role as AccountingRole) || capNames.some((key) => typeof caps[key] !== 'boolean')) return false;
  const countNames = ['clients_count','active_engagements_count','draft_journals_count','awaiting_review_count','posted_journals_count','unreconciled_statement_lines_count','open_findings_count','due_obligations_count'];
  return countNames.every((key) => Number.isSafeInteger(counts[key]) && (counts[key] as number) >= 0)
    && (value.settings === null || isObject(value.settings));
}
export const officeAccountingManagementApi = {
  read<T extends AccountingRecord = AccountingRecord>(client: AccountingRpcClient | SupabaseClient, workspaceId: string, resource: AccountingResource, filter: Record<string, unknown> = {}, limit = 200, offset = 0): Promise<T[] | AccountingReadPage<T> | AccountingBootstrap> {
    if (!(ACCOUNTING_RESOURCES as readonly string[]).includes(resource)) return Promise.reject(new Error('Unknown Accounting resource.'));
    if (!isObject(filter)) return Promise.reject(new Error('Accounting filters must be an object.'));
    try { integer(limit, 1, 200, 'page size'); integer(offset, 0, 2147483647, 'page offset'); }
    catch (error) { return Promise.reject(error); }
    return rpc(client, 'office_accounting_read', {p_workspace_id: workspaceId, p_resource: resource, p_filter: filter, p_limit: limit, p_offset: offset});
  },
  command<T extends AccountingRecord = AccountingRecord>(client: AccountingRpcClient | SupabaseClient, workspaceId: string, action: AccountingAction, payload: Record<string, unknown>): Promise<T> {
    if (!(ACCOUNTING_ACTIONS as readonly string[]).includes(action)) return Promise.reject(new Error('Unknown Accounting action.'));
    if (!isObject(payload)) return Promise.reject(new Error('Accounting command data must be an object.'));
    try {
      if (action === 'save_client_private') validatePrivateEnvelope(payload, PRIVATE_CLIENT_KEYS, 'Private client record');
      if (action === 'configure_private_key') validatePrivateEnvelope(payload, PRIVATE_CONFIG_KEYS, 'Private-record key setup');
      if (action === 'save_evidence_reference' && payload.encrypted_memo !== undefined) {
        if (!isObject(payload.encrypted_memo) || Object.keys(payload.encrypted_memo).some((key) => !['nonce','ciphertext'].includes(key))) throw new Error('Evidence memo must be encrypted before transmission.');
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Accounting private-data validation failed.'));
    }
    if (typeof workspaceId !== 'string' || !workspaceId.trim() || workspaceId.length > 128) return Promise.reject(new Error('A valid Accounting workspace is required.'));
    return rpc(client, 'office_accounting_command', {p_workspace_id: workspaceId, p_action: action, p_payload: payload});
  },
};
