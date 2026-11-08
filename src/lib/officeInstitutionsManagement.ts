import type { SupabaseClient } from '@supabase/supabase-js';
import type { InstitutionsAction, InstitutionsBootstrap, InstitutionsDataResource, InstitutionsFilter, InstitutionsKeyConfigs, InstitutionsMutationResult, InstitutionsPage, InstitutionsRow, InstitutionsSaveResource } from './officeInstitutionsTypes';
import { INSTITUTIONS_ACTIONS, INSTITUTIONS_CAPABILITIES, INSTITUTIONS_RESOURCES, INSTITUTIONS_ROLES, INSTITUTIONS_SAVE_RESOURCES } from './officeInstitutionsTypes';

export type InstitutionsRpcClient = Pick<SupabaseClient, 'rpc'>;
type Dict = Record<string, unknown>;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const B64=/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/; const TS=/^\d{4}-\d{2}-\d{2}T/; const MONEY=/^(?:0|[1-9]\d{0,17})(?:\.\d{1,2})?$/; const CURRENCY=/^[A-Z]{3}$/;
const FILTERS=['id','q','status','branch_id','fund_id','event_id','purpose'] as const;
const PUBLIC_RESOURCES=[...INSTITUTIONS_RESOURCES] as readonly string[];
const PRIVATE=new Set(['people','attendance','safeguarding']);
const FIELDS:Record<InstitutionsSaveResource,readonly string[]>= {
 organizations:['code','name','jurisdiction','legal_form','registration_authority','registration_reference','constitution_reference','address_public','tin_reference'], branches:['organization_id','code','name','location_public'], bodies:['organization_id','code','name','quorum_required','eligible_count','branch_id','constitution_reference'], people:['code','lawful_basis','notice_reference','retention_until','nonce','ciphertext','branch_id'], appointments:['body_id','person_id','position','start_on','end_on','reference','branch_id'], meetings:['body_id','code','title_public','scheduled_at','eligible_count','quorum_required','branch_id','notice_reference'], resolutions:['meeting_id','code','title_public','decision_reference','branch_id'], funds:['organization_id','code','name','restricted','purpose_public','branch_id','currency'], budgets:['fund_id','code','period_start','period_end','amount','reference','branch_id'], contributions:['fund_id','receipt_number','received_on','amount','method','reference','branch_id','person_id','restriction_reference'], payment_requests:['fund_id','budget_id','code','requested_on','amount','purpose_public','reference','branch_id'], bank_lines:['fund_id','statement_reference','line_reference','posted_on','amount','direction','branch_id','transaction_id'], reconciliations:['fund_id','code','period_start','period_end','opening_balance','closing_balance','reference','branch_id'], facilities:['organization_id','code','name','facility_type','location_public','capacity','branch_id'], assets:['organization_id','code','name','asset_type','acquired_on','cost','custody_reference','branch_id','facility_id','title_reference','land_consent_reference'], asset_moves:['asset_id','code','move_type','requested_on','reason_public','branch_id','target_branch_id','target_facility_id','reference'], programmes:['organization_id','code','name','purpose_public','start_on','end_on','branch_id','fund_id'], events:['programme_id','facility_id','code','title_public','start_at','end_at','capacity','risk_reference','branch_id'], attendance:['event_id','code','lawful_basis','notice_reference','retention_until','nonce','ciphertext','branch_id'], staff_assignments:['person_id','code','position','assignment_type','start_on','end_on','reference','branch_id','facility_id'], credentials:['assignment_id','code','credential_type','issued_on','expires_on','evidence_reference','branch_id'], filings:['organization_id','code','filing_type','authority','jurisdiction','due_on','reference','branch_id','reporting_year','control_number','source_url'], evidence:['entity_resource','entity_id','description_public','branch_id','reference','source_url'], safeguarding:['code','lawful_basis','notice_reference','retention_until','nonce','ciphertext','branch_id'], privacy_requests:['code','request_type','received_on','due_on','reference','branch_id','person_id']
};
const TRANSITION:Record<InstitutionsSaveResource,readonly string[]>=Object.fromEntries(INSTITUTIONS_SAVE_RESOURCES.map(r=>[r,['reference','minutes_reference','attendance_count','attendance_reference','submitted_on','reason','returned_reason','acknowledgement_reference','rejected_reason','maintenance_reference','transaction_id']])) as unknown as Record<InstitutionsSaveResource,readonly string[]>;
function obj(v:unknown):v is Dict{return !!v&&typeof v==='object'&&!Array.isArray(v)} function uuid(v:unknown):v is string{return typeof v==='string'&&UUID.test(v)} function pos(v:unknown):v is number{return typeof v==='number'&&Number.isSafeInteger(v)&&v>0}
function exact(v:Dict,keys:readonly string[],label:string){for(const k of Object.keys(v))if(!keys.includes(k))throw new Error(`Unknown ${label} field: ${k}.`)}
function b64(v:unknown,label:string,min:number,max:number){if(typeof v!=='string'||!B64.test(v))throw new Error(`${label} must be canonical base64.`);let x='';try{x=atob(v)}catch{throw new Error(`${label} must be canonical base64.`)}if(x.length<min||x.length>max||btoa(x)!==v)throw new Error(`${label} must be canonical base64.`)}
function validateData(resource:InstitutionsSaveResource,data:unknown){
 if(!obj(data)) throw new Error('Institutions record data must be an object.');
 exact(data,FIELDS[resource],resource);
 for(const [k,v] of Object.entries(data)){
  if(k.endsWith('_id')&&v!==undefined&&!uuid(v)) throw new Error(`${k} must be a UUID.`);
  if(['retention_until','start_on','end_on','received_on','requested_on','period_start','period_end','acquired_on','issued_on','expires_on','due_on','submitted_on'].includes(k)&&v!==undefined&&(typeof v!=='string'||!DATE.test(v)||Number.isNaN(Date.parse(v+'T00:00:00Z')))) throw new Error(`${k} must be an ISO date.`);
  if(['scheduled_at','start_at','end_at'].includes(k)&&v!==undefined&&(typeof v!=='string'||!TS.test(v)||Number.isNaN(Date.parse(v)))) throw new Error(`${k} must be an ISO timestamp.`);
  if(['amount','cost','opening_balance','closing_balance'].includes(k)&&(typeof v!=='string'||!MONEY.test(v))) throw new Error(`${k} must be a nonnegative decimal string.`);
  if(k==='currency'&&(typeof v!=='string'||!CURRENCY.test(v))) throw new Error('Currency must be uppercase ISO-4217.');
  if(['quorum_required','eligible_count','capacity'].includes(k)&&v!==undefined&&(typeof v!=='number'||!Number.isSafeInteger(v)||v<0)) throw new Error(`${k} must be a nonnegative integer.`);
  if(k==='restricted'&&v!==undefined&&typeof v!=='boolean') throw new Error('restricted must be boolean.');
 }
 if(PRIVATE.has(resource)){
  for(const k of ['nonce','ciphertext']) if(data[k]===undefined) throw new Error(`${resource} requires encrypted ${k}.`);
  b64(data.nonce,'nonce',12,12); b64(data.ciphertext,'ciphertext',17,32768);
 }
}
function validateFilter(v:unknown):InstitutionsFilter{if(!obj(v))throw new Error('Institutions filters must be an object.');exact(v,FILTERS,'filter');for(const k of ['id','branch_id','fund_id','event_id'])if(v[k]!==undefined&&!uuid(v[k]))throw new Error(`${k} filter must be a UUID.`);if(v.purpose!==undefined&&!['administration','direct_service','record_correction','safeguarding_response','compliance_review'].includes(String(v.purpose)))throw new Error('Invalid read purpose.');return v as InstitutionsFilter}
function payload(action: InstitutionsAction, value: unknown): InstitutionsRow {
 if (!obj(value)) throw new Error('Institutions command payload must be an object.');
 const p = value;
 const fields: Record<InstitutionsAction, readonly string[]> = {
  initialize: [], configure_settings: ['expected_version','base_currency'],
  assign_role: ['user_id','role','branch_id','active','expected_version'],
  configure_private_key: ['kind','salt','nonce','ciphertext','expected_version'],
  record_storage_review: ['reference','expected_version'], review_storage: ['decision','reference','expected_version'],
  set_private_gate: ['enabled','expected_version'], save_record: ['resource','data','id','expected_version'],
  save_private: ['resource','data','id','expected_version'], transition_record: ['resource','id','expected_version','to_state','data'],
  post_contribution: ['id','expected_version'], void_contribution: ['id','expected_version','reason','reference'],
  approve_payment: ['id','expected_version'], post_payment: ['id','expected_version','method','reference'],
  close_reconciliation: ['id','expected_version'], post_asset_move: ['id','expected_version'],
  create_report: ['report_type','period_start','period_end','title','branch_id'], export_report: ['id','expected_version','purpose'],
 };
 exact(p, [...fields[action],'idempotency_key'], action);
 if (!uuid(p.idempotency_key)) throw new Error('A valid idempotency_key is required.');
 const requireVersion = () => { if (!pos(p.expected_version)) throw new Error('A positive expected_version is required.'); };
 const requireId = () => { if (!uuid(p.id)) throw new Error('An exact record UUID is required.'); };
 const requireText = (key: string) => { if (typeof p[key] !== 'string' || !p[key].trim() || p[key].length > 2000) throw new Error(`${key} must be non-empty text.`); };
 if (action === 'save_record' || action === 'save_private') {
  if (!INSTITUTIONS_SAVE_RESOURCES.includes(p.resource as InstitutionsSaveResource)) throw new Error('Unknown Institutions resource.');
  const resource = p.resource as InstitutionsSaveResource;
  validateData(resource, p.data);
  if (action === 'save_private') {
   if (!PRIVATE.has(resource)) throw new Error('save_private requires an encrypted resource.');
   requireId();
   if (p.expected_version !== undefined) requireVersion();
  } else {
   if (PRIVATE.has(resource)) throw new Error('Encrypted resources require save_private.');
   if (p.id !== undefined) { requireId(); requireVersion(); }
   else if (p.expected_version !== undefined) throw new Error('Creates cannot include an expected version.');
  }
 } else if (action === 'transition_record') {
  if (!INSTITUTIONS_SAVE_RESOURCES.includes(p.resource as InstitutionsSaveResource)) throw new Error('Unknown transition resource.');
  requireId(); requireVersion(); requireText('to_state');
  if (p.data !== undefined) {
   if (!obj(p.data)) throw new Error('Transition data must be an object.');
   exact(p.data, TRANSITION[p.resource as InstitutionsSaveResource], 'transition data');
   if (p.data.transaction_id !== undefined && !uuid(p.data.transaction_id)) throw new Error('A matching transaction UUID is required.');
  }
 } else if (action === 'assign_role') {
  if (!uuid(p.user_id) || !INSTITUTIONS_ROLES.includes(p.role as never) || typeof p.active !== 'boolean' || (p.branch_id !== undefined && !uuid(p.branch_id))) throw new Error('Malformed role assignment.');
  if (p.expected_version !== undefined) requireVersion();
 } else if (action === 'configure_private_key') {
  requireVersion();
  if (!['people','safeguarding'].includes(String(p.kind))) throw new Error('Unknown private key kind.');
  b64(p.salt,'Key salt',16,16); b64(p.nonce,'Key verifier nonce',12,12); b64(p.ciphertext,'Key verifier ciphertext',17,1024);
 } else if (action === 'configure_settings') {
  requireVersion(); if (typeof p.base_currency !== 'string' || !CURRENCY.test(p.base_currency)) throw new Error('Currency must be uppercase ISO-4217.');
 } else if (action === 'record_storage_review' || action === 'review_storage') {
  requireVersion(); requireText('reference');
  if (action === 'review_storage' && !['approved','rejected'].includes(String(p.decision))) throw new Error('Malformed storage review decision.');
 } else if (action === 'set_private_gate') {
  requireVersion(); if (typeof p.enabled !== 'boolean') throw new Error('An explicit private gate decision is required.');
 } else if (action === 'create_report') {
  if (!['finance','governance','compliance','assets','programmes'].includes(String(p.report_type))) throw new Error('Unknown report type.');
  requireText('title');
  for (const key of ['period_start','period_end']) if (typeof p[key] !== 'string' || !DATE.test(p[key])) throw new Error('ISO report dates are required.');
  if (String(p.period_end) < String(p.period_start)) throw new Error('Report period ends before it starts.');
  if (p.branch_id !== undefined && !uuid(p.branch_id)) throw new Error('A valid report branch is required.');
 } else if (action === 'export_report') {
  requireId(); requireVersion();
  if (!['internal_review','compliance_review'].includes(String(p.purpose))) throw new Error('An explicit report export purpose is required.');
 } else if (action !== 'initialize') {
  requireId(); requireVersion();
  if (action === 'post_payment') {
   if (!['cash','bank','mobile_money','other'].includes(String(p.method))) throw new Error('An actual payment method is required.');
   requireText('reference');
  }
  if (action === 'void_contribution') { requireText('reference'); requireText('reason'); }
 }
 return p;
}
function unwrap<T>(x:{data:T|null;error:{message:string;code?:string}|null}):T{if(x.error)throw new Error(x.error.message);if(x.data===null)throw new Error('Institutions RPC returned no result.');return x.data}
export function isInstitutionsPage(v:unknown):v is InstitutionsPage{return obj(v)&&Array.isArray(v.rows)&&v.rows.every(obj)&&Number.isSafeInteger((v as Dict).total_count)&&((v as Dict).total_count as number)>=0&&pos(v.limit)&&v.limit<=50&&Number.isSafeInteger(v.offset)&&(v.offset as number)>=0&&typeof v.has_more==='boolean'&&v.has_more===(v.offset as number)+v.rows.length<(v.total_count as number)}
export function isInstitutionsBootstrap(v:unknown):v is InstitutionsBootstrap{return obj(v)&&uuid(String(v.workspace_id))&&(v.role===null||INSTITUTIONS_ROLES.includes(v.role as never))&&obj(v.settings)&&typeof v.settings.initialized==='boolean'&&Number.isSafeInteger(v.settings.version)&&typeof v.settings.base_currency==='string'&&obj(v.capabilities)&&INSTITUTIONS_CAPABILITIES.every(k=>typeof (v.capabilities as Dict)[k]==='boolean')&&obj(v.summary)}
export function isInstitutionsKeyConfigs(v: unknown): v is InstitutionsKeyConfigs {
 if (!obj(v)) return false;
 return (['people','safeguarding'] as const).every(kind => {
  const config = v[kind]; if (!obj(config) || typeof config.configured !== 'boolean') return false;
  if (!config.configured) return config.salt === undefined && config.nonce === undefined && config.ciphertext === undefined;
  if (config.accessible === false) return config.salt === undefined && config.nonce === undefined && config.ciphertext === undefined;
  if (config.key_version !== 1 || config.derivation !== 'PBKDF2-HMAC-SHA-256/AES-256-GCM' || config.iterations !== 600000) return false;
  try { b64(config.salt,'Key salt',16,16); b64(config.nonce,'Verifier nonce',12,12); b64(config.ciphertext,'Verifier ciphertext',17,1024); return true; } catch { return false; }
 });
}
export const officeInstitutionsManagementApi={
 async bootstrap(c:InstitutionsRpcClient,w:string){if(!uuid(w))throw new Error('A valid workspace is required.');const x=unwrap(await c.rpc('office_institutions_read',{p_workspace_id:w,p_resource:'bootstrap',p_filter:{},p_limit:1,p_offset:0}));if(!isInstitutionsBootstrap(x))throw new Error('Malformed Institutions bootstrap response.');return x},
 async keys(c:InstitutionsRpcClient,w:string){if(!uuid(w))throw new Error('A valid workspace is required.');const x=unwrap(await c.rpc('office_institutions_read',{p_workspace_id:w,p_resource:'private_keys',p_filter:{},p_limit:1,p_offset:0}));if(!isInstitutionsKeyConfigs(x))throw new Error('Malformed Institutions key response.');return x},
 async page(c:InstitutionsRpcClient,w:string,r:InstitutionsDataResource,f:InstitutionsFilter={},o=0,l=50){if(!uuid(w)||!PUBLIC_RESOURCES.includes(r)||!Number.isSafeInteger(o)||o<0||!pos(l)||l>50)throw new Error('Malformed Institutions page request.');validateFilter(f);const x=unwrap(await c.rpc('office_institutions_read',{p_workspace_id:w,p_resource:r,p_filter:f,p_limit:l,p_offset:o}));if(!isInstitutionsPage(x))throw new Error('Malformed Institutions page response.');return x},
 async command(c:InstitutionsRpcClient,w:string,a:InstitutionsAction,p:InstitutionsRow){if(!uuid(w)||!INSTITUTIONS_ACTIONS.includes(a))throw new Error('Malformed Institutions command.');const q=payload(a,p);return unwrap(await c.rpc('office_institutions_command',{p_workspace_id:w,p_action:a,p_payload:q})) as InstitutionsMutationResult}
};
export const loadInstitutionsBootstrap=officeInstitutionsManagementApi.bootstrap; export const loadInstitutionsKeys=officeInstitutionsManagementApi.keys; export const loadInstitutionsPage=officeInstitutionsManagementApi.page; export const runInstitutionsCommand=officeInstitutionsManagementApi.command;
