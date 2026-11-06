const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JSON = 64 * 1024;
const MAX_ATTACHMENT = 3 * 1024 * 1024;
const MAX_TOTAL = 3 * 1024 * 1024;
const BUNNY_ORIGIN = 'https://de-s3.storage.bunnycdn.com';
const BUNNY_ZONE = 'cocce-kyc';
const ALLOWED_ORIGINS = new Set(['https://cocce-office.vercel.app', 'http://localhost:5173']);
type Env = Record<string, string | undefined> | ((name: string) => string | undefined);
type Fetcher = typeof fetch;
type Config = {
  supabaseUrl: string; anonKey: string;
  tenantId?: string; clientId?: string; clientSecret?: string; senderUpn?: string;
  cmisServiceUrl?: string; cmisRepositoryId?: string; cmisFolderId?: string;
  cmisBearerToken?: string; cmisUsername?: string; cmisPassword?: string;
};
type RpcError = Error & { status?: number };
class DefiniteError extends Error {}

function envRead(env: Env, name: string): string { const v = typeof env === 'function' ? env(name) : env[name]; return typeof v === 'string' ? v.trim() : ''; }
function getConfig(env: Env): Config | null {
  const supabaseUrl = envRead(env, 'SUPABASE_URL'); const anonKey = envRead(env, 'SUPABASE_ANON_KEY');
  if (!supabaseUrl || !anonKey) return null;
  try { if (new URL(supabaseUrl).protocol !== 'https:') return null; } catch { return null; }
  const cmisServiceUrl = envRead(env, 'OFFICE_GOV_CMIS_SERVICE_URL');
  if (cmisServiceUrl) { try { if (new URL(cmisServiceUrl).protocol !== 'https:') return null; } catch { return null; } }
  return {
    supabaseUrl, anonKey,
    tenantId: envRead(env, 'OFFICE_GOV_GRAPH_TENANT_ID') || undefined,
    clientId: envRead(env, 'OFFICE_GOV_GRAPH_CLIENT_ID') || undefined,
    clientSecret: envRead(env, 'OFFICE_GOV_GRAPH_CLIENT_SECRET') || undefined,
    senderUpn: envRead(env, 'OFFICE_GOV_GRAPH_SENDER_UPN') || undefined,
    cmisServiceUrl: cmisServiceUrl || undefined,
    cmisRepositoryId: envRead(env, 'OFFICE_GOV_CMIS_REPOSITORY_ID') || undefined,
    cmisFolderId: envRead(env, 'OFFICE_GOV_CMIS_FOLDER_ID') || undefined,
    cmisBearerToken: envRead(env, 'OFFICE_GOV_CMIS_BEARER_TOKEN') || undefined,
    cmisUsername: envRead(env, 'OFFICE_GOV_CMIS_USERNAME') || undefined,
    cmisPassword: envRead(env, 'OFFICE_GOV_CMIS_PASSWORD') || undefined,
  };
}
function graphConfigured(c: Config): boolean { return !!(c.tenantId && c.clientId && c.clientSecret); }
function graphReady(c: Config): boolean { return graphConfigured(c) && !!c.senderUpn; }
function cmisAuth(c: Config): boolean { return !!(c.cmisBearerToken || (c.cmisUsername && c.cmisPassword)); }
function cmisConfigured(c: Config): boolean { return !!(c.cmisServiceUrl && cmisAuth(c)); }
function cmisReady(c: Config): boolean { return cmisConfigured(c) && !!c.cmisRepositoryId && !!c.cmisFolderId; }
function uuid(v: unknown): v is string { return typeof v === 'string' && UUID_RE.test(v); }
function origin(request: Request): string | null { return request.headers.get('origin'); }
function cors(o: string | null): Headers { const h = new Headers({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' }); if (o && ALLOWED_ORIGINS.has(o)) { h.set('Access-Control-Allow-Origin', o); h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'); h.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info'); h.set('Access-Control-Max-Age', '600'); } return h; }
function json(o: string | null, status: number, value: Record<string, unknown>): Response { const h = cors(o); h.set('Content-Type', 'application/json; charset=utf-8'); return new Response(JSON.stringify(value), { status, headers: h }); }
function bearer(request: Request): string { const m = /^Bearer\s+([^\s]+)$/i.exec(request.headers.get('authorization') || ''); return m && m[1].length <= 8192 ? m[1] : ''; }
async function body(request: Request): Promise<Record<string, unknown> | null> { const len = request.headers.get('content-length'); if (len && /^\d+$/.test(len) && Number(len) > MAX_JSON) return null; const t = await request.text(); if (t.length > MAX_JSON) return null; try { const v: unknown = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; } }
function keys(v: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(v).every(k => allowed.includes(k)); }
function email(v: unknown): v is string { return typeof v === 'string' && v.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function text(v: unknown, max: number): v is string { return typeof v === 'string' && v.normalize('NFC').length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v); }
async function verify(c: Config, token: string, f: Fetcher): Promise<boolean> { if (!token) return false; try { const r = await f(`${c.supabaseUrl}/auth/v1/user`, { headers: { apikey: c.anonKey, Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(8000) }); await r.body?.cancel(); return r.ok; } catch { return false; } }
async function rpc(c: Config, token: string, name: string, payload: Record<string, unknown>, f: Fetcher): Promise<unknown> { if (!/^office_gov_(access_profile|outbound_begin|outbound_finish|archive_begin|archive_finish)$/.test(name)) throw new Error('RPC not allowed'); const r = await f(`${c.supabaseUrl}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: c.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(payload), redirect: 'error', signal: AbortSignal.timeout(10000) }); if (!r.ok) { await r.body?.cancel(); const e = new Error('Government database operation failed') as RpcError; e.status = r.status; throw e; } return r.status === 204 ? null : await r.json(); }
function obj(v: unknown): Record<string, unknown> | null { const x = Array.isArray(v) ? v[0] : v; return x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : null; }
async function requestHash(v: unknown): Promise<string> { return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(v))))); }
function hex(bytes: Uint8Array): string { return Array.from(bytes, x => x.toString(16).padStart(2, '0')).join(''); }
function safeBunnyUrl(raw: unknown, workspaceId: string, fileId: string, revisionId?: string): URL | null { if (typeof raw !== 'string') return null; try { const u = new URL(raw); const allowed = new Set(['X-Amz-Algorithm','X-Amz-Credential','X-Amz-Date','X-Amz-Expires','X-Amz-SignedHeaders','X-Amz-Signature','response-content-type','response-content-disposition','response-cache-control']); if (u.origin !== BUNNY_ORIGIN || u.protocol !== 'https:' || u.username || u.password || u.hash || [...u.searchParams.keys()].some(k => !allowed.has(k)) || [...allowed].some(k => u.searchParams.getAll(k).length > 1) || u.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || !u.searchParams.get('X-Amz-Credential') || !/^\d{8}T\d{6}Z$/.test(u.searchParams.get('X-Amz-Date') || '') || !/^[1-9]\d{0,2}$/.test(u.searchParams.get('X-Amz-Expires') || '') || Number(u.searchParams.get('X-Amz-Expires')) > 600 || u.searchParams.get('X-Amz-SignedHeaders') !== 'host' || !/^[0-9a-f]{64}$/i.test(u.searchParams.get('X-Amz-Signature') || '') || !u.searchParams.get('response-content-type') || !u.searchParams.get('response-content-disposition') || !u.searchParams.get('response-cache-control')) return null; const p = u.pathname.split('/').filter(Boolean); if (p.length !== 10 || p[0] !== BUNNY_ZONE || p[1] !== 'office' || p[2] !== 'v1' || p[3] !== 'workspaces' || p[4].toLowerCase() !== workspaceId.toLowerCase() || p[5] !== 'files' || p[6].toLowerCase() !== fileId.toLowerCase() || p[7] !== 'revisions' || !uuid(p[8]) || p[9] !== 'payload' || (revisionId && p[8].toLowerCase() !== revisionId.toLowerCase())) return null; return u; } catch { return null; } }
async function getBytes(c: Config, token: string, workspaceId: string, fileId: string, revisionId: string, size: number, digest: string, f: Fetcher): Promise<Uint8Array> {
  try {
    const link = await f(`${c.supabaseUrl}/functions/v1/office-cloud-files`, { method: 'POST', headers: { apikey: c.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'get_link', fileId, purpose: 'download' }), redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!link.ok) throw new DefiniteError('Attachment link unavailable');
    const data = obj(await link.json());
    const u = safeBunnyUrl(data?.url, workspaceId, fileId, revisionId);
    if (!u) throw new DefiniteError('Attachment link invalid');
    const r = await f(u.href, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(20000) });
    if (!r.ok) { await r.body?.cancel(); throw new DefiniteError('Attachment download failed'); }
    const cl = r.headers.get('content-length');
    if (cl && (!/^\d+$/.test(cl) || Number(cl) !== size || Number(cl) > MAX_ATTACHMENT)) { await r.body?.cancel(); throw new DefiniteError('Attachment size invalid'); }
    const reader = r.body?.getReader();
    if (!reader) throw new DefiniteError('Attachment download unavailable');
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > size || total > MAX_ATTACHMENT) { await reader.cancel(); throw new DefiniteError('Attachment too large'); }
        parts.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      if (error instanceof DefiniteError) throw error;
      throw new DefiniteError('Attachment download failed');
    }
    if (total !== size || total < 1) throw new DefiniteError('Attachment size invalid');
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    if (hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))) !== digest.toLowerCase()) throw new DefiniteError('Attachment integrity check failed');
    return bytes;
  } catch (error) {
    if (error instanceof DefiniteError) throw error;
    throw new DefiniteError('Attachment retrieval failed');
  }
}
function base64(bytes: Uint8Array): string { let out = ''; const chunk = 0x6000; for (let i = 0; i < bytes.length; i += chunk) out += btoa(String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)))); return out; }
async function graphToken(c: Config, f: Fetcher): Promise<string> { const r = await f(`https://login.microsoftonline.com/${encodeURIComponent(c.tenantId!)}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: c.clientId!, client_secret: c.clientSecret!, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' }), redirect: 'error', signal: AbortSignal.timeout(10000) }); if (!r.ok) { await r.body?.cancel(); throw new DefiniteError('Graph authentication failed'); } const x = await r.json() as { access_token?: unknown }; if (typeof x.access_token !== 'string' || !x.access_token) throw new DefiniteError('Graph authentication invalid'); return x.access_token; }
async function cmisHeaders(c: Config): Promise<Headers> { const h = new Headers({ Accept: 'application/json' }); if (c.cmisBearerToken) h.set('Authorization', `Bearer ${c.cmisBearerToken}`); else h.set('Authorization', `Basic ${btoa(`${c.cmisUsername}:${c.cmisPassword}`)}`); return h; }
async function cmisCreate(c: Config, name: string, bytes: Uint8Array, f: Fetcher): Promise<string> { const h = await cmisHeaders(c); const infoUrl = new URL(`${c.cmisServiceUrl!.replace(/\/$/, '')}/${encodeURIComponent(c.cmisRepositoryId!)}`); infoUrl.searchParams.set('cmisselector', 'repositoryInfo'); const info = await f(infoUrl.href, { headers: h, redirect: 'error', signal: AbortSignal.timeout(10000) }); if (!info.ok) { await info.body?.cancel(); throw info.status >= 500 ? new Error('CMIS discovery failed') : new DefiniteError('CMIS discovery failed'); } await info.body?.cancel(); const form = new FormData(); form.set('cmisaction', 'createDocument'); form.set('folderId', c.cmisFolderId!); form.set('propertyId[0]', 'cmis:name'); form.set('propertyValue[0]', name); form.set('propertyId[1]', 'cmis:objectTypeId'); form.set('propertyValue[1]', 'cmis:document'); form.set('content', new Blob([bytes]), name); const r = await f(c.cmisServiceUrl!, { method: 'POST', headers: h, body: form, redirect: 'error', signal: AbortSignal.timeout(20000) }); if (!r.ok) { await r.body?.cancel(); if (r.status >= 500) throw new Error('CMIS createDocument failed'); throw new DefiniteError('CMIS createDocument failed'); } const loc = r.headers.get('location'); let id = ''; try { const x = await r.json() as Record<string, unknown>; const p = x.properties as Record<string, unknown> | undefined; const q = p?.['cmis:objectId'] as Record<string, unknown> | undefined; id = typeof q?.value === 'string' ? q.value : typeof x['cmis:objectId'] === 'string' ? x['cmis:objectId'] as string : ''; } catch {} if (!id && loc) { try { id = new URL(loc).searchParams.get('objectId') || ''; } catch {} } if (!id || id.length > 1024) throw new Error('CMIS response missing object ID'); return id; }
function safeStatus(a: Record<string, unknown>, fallback = 'failed'): Record<string, unknown> { const out: Record<string, unknown> = { status: typeof a.status === 'string' ? a.status : fallback }; if (uuid(a.attempt_id)) out.attemptId = a.attempt_id; if ('delivery_verified' in a) out.deliveryVerified = a.delivery_verified; else if (out.status !== 'archived') out.deliveryVerified = false; if (typeof a.provider_object_id === 'string') out.providerObjectId = a.provider_object_id; if (Number.isInteger(a.http_status)) out.httpStatus = a.http_status; if (typeof a.error_code === 'string') out.errorCode = a.error_code; return out; }
async function finish(c: Config, token: string, name: string, payload: Record<string, unknown>, f: Fetcher): Promise<void> { await rpc(c, token, name, payload, f).catch(() => undefined); }
function isFinal(status: unknown): boolean { return ['accepted', 'archived', 'failed', 'unknown'].includes(String(status)); }
async function send(c: Config, token: string, b: Record<string, unknown>, f: Fetcher, o: string | null): Promise<Response> {
  if (!keys(b, ['workspaceId','correspondenceId','expectedRecordVersion','recipient','subject','body','attachmentIds','idempotencyKey','nonSensitiveConfirmed']) || !uuid(b.workspaceId) || !uuid(b.correspondenceId) || !uuid(b.idempotencyKey) || !Number.isSafeInteger(b.expectedRecordVersion) || (b.expectedRecordVersion as number) < 1 || !email(b.recipient) || !text(b.subject, 500) || !text(b.body, 100000) || !Array.isArray(b.attachmentIds) || b.attachmentIds.length > 3 || !b.attachmentIds.every(uuid) || b.nonSensitiveConfirmed !== true) return json(o, 400, { error: 'INVALID_REQUEST' });
  let a: Record<string, unknown>; try { a = obj(await rpc(c, token, 'office_gov_outbound_begin', { p_workspace_id:b.workspaceId, p_correspondence_id:b.correspondenceId, p_expected_record_version:b.expectedRecordVersion, p_idempotency_key:b.idempotencyKey, p_request_sha256_hex:await requestHash(b), p_attachment_ids:b.attachmentIds }, f)) || {}; } catch { return json(o, 502, { status:'failed', deliveryVerified:false, errorCode:'BEGIN_FAILED' }); }
  const at = uuid(a.attempt_id) ? a.attempt_id as string : '';
  if (!Object.prototype.hasOwnProperty.call(a, 'attachments')) { if (at && !isFinal(a.status)) await finish(c, token, 'office_gov_outbound_finish', {p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:'unknown',p_error_code:'AMBIGUOUS_PROVIDER_OUTCOME'}, f); return json(o, 200, safeStatus({...a, status: isFinal(a.status) ? a.status : 'unknown'}, 'unknown')); }
  if (!at) return json(o, 502, {status:'failed',deliveryVerified:false,errorCode:'INVALID_BEGIN_RESPONSE'});
  const attachments = Array.isArray(a.attachments) ? a.attachments : []; let total = 0; const files: Array<{name:string;bytes:Uint8Array}> = [];
  try { for (const raw of attachments) { const x=obj(raw); if (!x || !uuid(x.file_id) || !uuid(x.revision_id) || typeof x.display_name !== 'string' || !Number.isSafeInteger(x.size_bytes) || x.size_bytes < 1 || x.size_bytes > MAX_ATTACHMENT || typeof x.sha256_hex !== 'string' || !/^[0-9a-f]{64}$/i.test(x.sha256_hex)) throw new DefiniteError('Attachment metadata invalid'); const bytes=await getBytes(c,token,b.workspaceId as string,x.file_id,x.revision_id,x.size_bytes as number,x.sha256_hex,f); total+=bytes.byteLength; if(total>MAX_TOTAL) throw new DefiniteError('Total attachment size exceeded'); files.push({name:x.display_name,bytes}); } } catch { await finish(c,token,'office_gov_outbound_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:'failed',p_error_code:'ATTACHMENT_UNAVAILABLE'},f); return json(o,502,{status:'failed',attemptId:at,deliveryVerified:false,errorCode:'ATTACHMENT_UNAVAILABLE'}); }
  try { const access=await graphToken(c,f); const message={message:{subject:b.subject,body:{contentType:'Text',content:b.body},toRecipients:[{emailAddress:{address:b.recipient}}],attachments:await Promise.all(files.map(async x=>({'@odata.type':'#microsoft.graph.fileAttachment',name:x.name,contentType:'application/octet-stream',contentBytes:base64(x.bytes)})))},saveToSentItems:true}; const r=await f(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(c.senderUpn!)}/sendMail`,{method:'POST',headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},body:JSON.stringify(message),redirect:'error',signal:AbortSignal.timeout(20000)}); if(r.status!==202){await r.body?.cancel(); if(r.status>=500) throw new Error('Graph ambiguous'); await finish(c,token,'office_gov_outbound_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:'failed',p_http_status:r.status,p_error_code:'GRAPH_REJECTED'},f); return json(o,502,{status:'failed',attemptId:at,deliveryVerified:false,httpStatus:r.status,errorCode:'GRAPH_REJECTED'});} await rpc(c,token,'office_gov_outbound_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:'accepted',p_http_status:202},f); return json(o,200,{status:'accepted',attemptId:at,deliveryVerified:false,httpStatus:202}); } catch(error) { const definite=error instanceof DefiniteError; await finish(c,token,'office_gov_outbound_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:definite?'failed':'unknown',p_error_code:definite?'PROVIDER_REJECTED':'AMBIGUOUS_PROVIDER_OUTCOME'},f); return json(o,502,{status:definite?'failed':'unknown',attemptId:at,deliveryVerified:false,errorCode:definite?'PROVIDER_REJECTED':'AMBIGUOUS_PROVIDER_OUTCOME'}); }
}
async function archive(c: Config, token: string, b: Record<string, unknown>, f: Fetcher, o: string | null): Promise<Response> {
  if (!keys(b,['workspaceId','attachmentId','idempotencyKey']) || !uuid(b.workspaceId) || !uuid(b.attachmentId) || !uuid(b.idempotencyKey)) return json(o,400,{error:'INVALID_REQUEST'});
  let a: Record<string, unknown>; try { a=obj(await rpc(c,token,'office_gov_archive_begin',{p_workspace_id:b.workspaceId,p_attachment_id:b.attachmentId,p_idempotency_key:b.idempotencyKey,p_request_sha256_hex:await requestHash(b)},f))||{}; } catch { return json(o,502,{status:'failed',errorCode:'BEGIN_FAILED'}); }
  const at=uuid(a.attempt_id)?a.attempt_id as string:''; if(!Object.prototype.hasOwnProperty.call(a,'file_id')) { if(at&&!isFinal(a.status)) await finish(c,token,'office_gov_archive_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:'unknown',p_error_code:'AMBIGUOUS_PROVIDER_OUTCOME'},f); return json(o,200,safeStatus({...a,status:isFinal(a.status)?a.status:'unknown'},'unknown')); }
  const rev=uuid(a.revision_id)?a.revision_id as string:''; const file=uuid(a.file_id)?a.file_id as string:''; const name=typeof a.display_name==='string'?a.display_name:''; if(!at||!rev||!file||!name||!Number.isSafeInteger(a.size_bytes)||a.size_bytes<1||a.size_bytes>MAX_ATTACHMENT||typeof a.sha256_hex!=='string'||!/^[0-9a-f]{64}$/i.test(a.sha256_hex)) return json(o,502,{status:'failed',attemptId:at||undefined,errorCode:'INVALID_BEGIN_RESPONSE'});
  try { const bytes=await getBytes(c,token,b.workspaceId as string,file,rev,a.size_bytes as number,a.sha256_hex,f); const id=await cmisCreate(c,name,bytes,f); await rpc(c,token,'office_gov_archive_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:'archived',p_provider_object_id:id},f); return json(o,200,{status:'archived',attemptId:at,providerObjectId:id}); } catch(error) { const definite=error instanceof DefiniteError; await finish(c,token,'office_gov_archive_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:definite?'failed':'unknown',p_error_code:definite?'PROVIDER_REJECTED':'AMBIGUOUS_PROVIDER_OUTCOME'},f); return json(o,502,{status:definite?'failed':'unknown',attemptId:at,errorCode:definite?'PROVIDER_REJECTED':'AMBIGUOUS_PROVIDER_OUTCOME'}); }
}
export function createOfficeGovernmentHandler(options: {env?:Env;fetchImpl?:Fetcher}={}) { const env=options.env||((name:string)=>(globalThis as {Deno?:{env:{get(n:string):string|undefined}}}).Deno?.env.get(name)); const f=options.fetchImpl||fetch; return async(request:Request):Promise<Response>=>{ const o=origin(request); if(o&&!ALLOWED_ORIGINS.has(o))return json(null,403,{error:'ORIGIN_NOT_ALLOWED'}); if(request.method==='OPTIONS')return o?new Response(null,{status:204,headers:cors(o)}):json(null,403,{error:'ORIGIN_NOT_ALLOWED'}); const c=getConfig(env); const url=new URL(request.url); const path=url.pathname; if(request.method==='GET'&&path.endsWith('/status')){if(!c||!await verify(c,bearer(request),f))return json(o,401,{error:'AUTHENTICATION_REQUIRED'}); const workspaceId=url.searchParams.get('workspaceId')||''; if(!uuid(workspaceId))return json(o,400,{error:'INVALID_REQUEST'}); try { const profile=obj(await rpc(c,bearer(request),'office_gov_access_profile',{p_workspace_id:workspaceId},f)); const roles=Array.isArray(profile?.roles)?profile.roles:[]; const allowed=roles.some(role=>role==='records_manager'||role==='auditor'||role==='outbound_dispatcher'); if(profile?.is_admin!==true&&(!profile||allowed!==true))return json(o,403,{error:'WORKSPACE_ACCESS_DENIED'}); } catch { return json(o,403,{error:'WORKSPACE_ACCESS_DENIED'}); } return json(o,200,{graph:{configured:graphConfigured(c),senderConfigured:!!c.senderUpn},cmis:{configured:cmisConfigured(c),repositoryConfigured:!!c.cmisRepositoryId,folderConfigured:!!c.cmisFolderId}});} if(request.method!=='POST')return json(o,405,{error:'METHOD_NOT_ALLOWED'}); if(!c)return json(o,503,{error:'GOVERNMENT_CONNECTOR_NOT_CONFIGURED',message:'Configure Supabase and the required government connector settings.'}); if(!await verify(c,bearer(request),f))return json(o,401,{error:'AUTHENTICATION_REQUIRED'}); const b=await body(request); if(!b)return json(o,400,{error:'INVALID_REQUEST'}); const token=bearer(request); if(path.endsWith('/outbound/send')){if(!graphReady(c))return json(o,503,{error:'GOVERNMENT_CONNECTOR_NOT_CONFIGURED'});return send(c,token,b,f,o);} if(path.endsWith('/archive/file')){if(!cmisReady(c))return json(o,503,{error:'GOVERNMENT_CONNECTOR_NOT_CONFIGURED'});return archive(c,token,b,f,o);} return json(o,404,{error:'NOT_FOUND'}); }; }
