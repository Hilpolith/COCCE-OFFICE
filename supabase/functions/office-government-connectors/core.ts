const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JSON = 64 * 1024, MAX_ATTACHMENT = 3 * 1024 * 1024, MAX_TOTAL = 3 * 1024 * 1024;
const BUNNY_ORIGIN = 'https://de-s3.storage.bunnycdn.com', BUNNY_ZONE = 'cocce-kyc';
const ALLOWED_ORIGINS = new Set(['https://cocce-office.vercel.app', 'http://localhost:5173']);
type Env = Record<string, string | undefined> | ((name: string) => string | undefined);
type Fetcher = typeof fetch;
type Config = { supabaseUrl: string; anonKey: string; serverKey: string };
type Connector = { provider: 'graph'|'cmis'; tenantId?: string; clientId?: string; clientSecret?: string; senderUpn?: string; serviceUrl?: string; repositoryId?: string; folderId?: string; authMode?: 'bearer'|'basic'; bearerToken?: string; username?: string; password?: string };
type RpcError = Error & { status?: number };
class DefiniteError extends Error {}
function envRead(env: Env, name: string): string { const v = typeof env === 'function' ? env(name) : env[name]; return typeof v === 'string' ? v.trim() : ''; }
function getConfig(env: Env): Config | null { const supabaseUrl=envRead(env,'SUPABASE_URL'), anonKey=envRead(env,'SUPABASE_ANON_KEY'); if(!supabaseUrl||!anonKey)return null; try{if(new URL(supabaseUrl).protocol!=='https:')return null;}catch{return null;} let serverKey=envRead(env,'SUPABASE_SERVICE_ROLE_KEY'); const raw=envRead(env,'SUPABASE_SECRET_KEYS'); if(raw){try{const x=JSON.parse(raw); if(typeof x?.default==='string'&&x.default.trim())serverKey=x.default.trim();}catch{}} return serverKey?{supabaseUrl,anonKey,serverKey}:null; }
function uuid(v: unknown): v is string { return typeof v==='string'&&UUID_RE.test(v); }
function email(v: unknown): v is string { return typeof v==='string'&&v.length<=320&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }
function text(v: unknown,max:number):v is string{return typeof v==='string'&&v.normalize('NFC').length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);}
function keys(v:Record<string,unknown>,allowed:string[]){return Object.keys(v).every(k=>allowed.includes(k));}
function origin(r:Request){return r.headers.get('origin');}
function cors(o:string|null){const h=new Headers({'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Vary':'Origin'});if(o&&ALLOWED_ORIGINS.has(o)){h.set('Access-Control-Allow-Origin',o);h.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');h.set('Access-Control-Allow-Headers','authorization, apikey, content-type, x-client-info');h.set('Access-Control-Max-Age','600');}return h;}
function json(o:string|null,status:number,v:Record<string,unknown>){const h=cors(o);h.set('Content-Type','application/json; charset=utf-8');return new Response(JSON.stringify(v),{status,headers:h});}
function bearer(r:Request){const m=/^Bearer\s+([^\s]+)$/i.exec(r.headers.get('authorization')||'');return m&&m[1].length<=8192?m[1]:'';}
async function body(r:Request){const l=r.headers.get('content-length');if(l&&/^\d+$/.test(l)&&Number(l)>MAX_JSON)return null;const t=await r.text();if(t.length>MAX_JSON)return null;try{const v=JSON.parse(t);return v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:null;}catch{return null;}}
function obj(v:unknown){const x=Array.isArray(v)?v[0]:v;return x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;}
function safeBunnyUrl(raw:unknown,w:string,fid:string,rid?:string){if(typeof raw!=='string')return null;try{const u=new URL(raw),a=new Set(['X-Amz-Algorithm','X-Amz-Credential','X-Amz-Date','X-Amz-Expires','X-Amz-SignedHeaders','X-Amz-Signature','response-content-type','response-content-disposition','response-cache-control']);if(u.origin!==BUNNY_ORIGIN||u.protocol!=='https:'||u.username||u.password||u.hash||[...u.searchParams.keys()].some(k=>!a.has(k))||[...a].some(k=>u.searchParams.getAll(k).length>1)||u.searchParams.get('X-Amz-Algorithm')!=='AWS4-HMAC-SHA256'||!u.searchParams.get('X-Amz-Credential')||!/^[0-9]{8}T[0-9]{6}Z$/.test(u.searchParams.get('X-Amz-Date')||'')||!/^[1-9]\d{0,2}$/.test(u.searchParams.get('X-Amz-Expires')||'')||Number(u.searchParams.get('X-Amz-Expires'))>600||u.searchParams.get('X-Amz-SignedHeaders')!=='host'||!/^[0-9a-f]{64}$/i.test(u.searchParams.get('X-Amz-Signature')||'')||!u.searchParams.get('response-content-type')||!u.searchParams.get('response-content-disposition')||!u.searchParams.get('response-cache-control'))return null;const p=u.pathname.split('/').filter(Boolean);if(p.length!==10||p[0]!==BUNNY_ZONE||p[1]!=='office'||p[2]!=='v1'||p[3]!=='workspaces'||p[4].toLowerCase()!==w.toLowerCase()||p[5]!=='files'||p[6].toLowerCase()!==fid.toLowerCase()||p[7]!=='revisions'||!uuid(p[8])||p[9]!=='payload'||(rid&&p[8].toLowerCase()!==rid.toLowerCase()))return null;return u;}catch{return null;}}
function hex(b:Uint8Array){return Array.from(b,x=>x.toString(16).padStart(2,'0')).join('');}
async function hash(v:unknown){return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v)))));}
async function verify(c: Config, t: string, f: Fetcher): Promise<string | null> {
  if (!t) return null;
  try {
    const r = await f(`${c.supabaseUrl}/auth/v1/user`, {
      headers: { apikey: c.anonKey, Authorization: `Bearer ${t}` },
      redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { await r.body?.cancel(); return null; }
    const user = obj(await r.json().catch(() => null));
    return uuid(user?.id) ? user.id as string : null;
  } catch { return null; }
}
const USER_RPC=/^office_gov_(access_profile|outbound_begin|outbound_finish|archive_begin|archive_finish)$/;
const SERVER_RPC=/^office_gov_connector_(config_store|config_get|config_status|config_test_update|config_delete)$/;
async function rpc(c:Config,t:string,n:string,p:Record<string,unknown>,f:Fetcher,server=false){if(server?!SERVER_RPC.test(n):!USER_RPC.test(n))throw new Error('RPC not allowed');const key=server?c.serverKey:c.anonKey;const r=await f(`${c.supabaseUrl}/rest/v1/rpc/${n}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`, 'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(p),redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok){await r.body?.cancel();const e=new Error('Government database operation failed') as RpcError;e.status=r.status;throw e;}return r.status===204?null:await r.json();}
async function profile(c:Config,t:string,w:string,f:Fetcher){return obj(await rpc(c,t,'office_gov_access_profile',{p_workspace_id:w},f));}
function admin(p:Record<string,unknown>|null){return p?.is_admin===true;}
function roles(p:Record<string,unknown>|null){return Array.isArray(p?.roles)?p.roles:[];}
function publicConfig(x:unknown):Connector|null{const a=obj(x);const p=String(a?.provider||'');const q=obj(a?.public_config)||a;if(p==='graph'||(q?.tenantId&&q?.clientId))return {provider:'graph',tenantId:typeof q?.tenantId==='string'?q.tenantId:undefined,clientId:typeof q?.clientId==='string'?q.clientId:undefined,senderUpn:typeof q?.senderUpn==='string'?q.senderUpn:undefined,clientSecret:typeof obj(a?.secret_config)?.clientSecret==='string'?obj(a?.secret_config)?.clientSecret as string:undefined};if(p==='cmis'||q?.serviceUrl)return {provider:'cmis',serviceUrl:typeof q?.serviceUrl==='string'?q.serviceUrl:undefined,repositoryId:typeof q?.repositoryId==='string'?q.repositoryId:undefined,folderId:typeof q?.folderId==='string'?q.folderId:undefined,authMode:q?.authMode==='basic'||q?.authMode==='bearer'?q.authMode:undefined,bearerToken:typeof obj(a?.secret_config)?.bearerToken==='string'?obj(a?.secret_config)?.bearerToken as string:undefined,username:typeof obj(a?.secret_config)?.username==='string'?obj(a?.secret_config)?.username as string:undefined,password:typeof obj(a?.secret_config)?.password==='string'?obj(a?.secret_config)?.password as string:undefined};return null;}
async function getConnector(c: Config, w: string, p: 'graph' | 'cmis', f: Fetcher): Promise<Connector | null> {
  const value = obj(await rpc(c, '', 'office_gov_connector_config_get', { p_workspace_id: w, p_provider: p }, f, true));
  if (!value || value.state === 'unconfigured') return null;
  const connector = publicConfig(value);
  if (!connector) throw new Error('Connector configuration is invalid');
  return connector;
}
async function updateConnectorTest(c: Config, w: string, p: 'graph' | 'cmis', state: 'healthy' | 'error', errorCode: string, actor: string, f: Fetcher) {
  return rpc(c, '', 'office_gov_connector_config_test_update', {
    p_workspace_id: w, p_provider: p, p_state: state, p_error_code: errorCode, p_actor_user_id: actor,
  }, f, true);
}
async function graphToken(cn:Connector,f:Fetcher){if(!cn.tenantId||!cn.clientId||!cn.clientSecret)throw new DefiniteError('Graph authentication failed');const r=await f(`https://login.microsoftonline.com/${encodeURIComponent(cn.tenantId)}/oauth2/v2.0/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:cn.clientId,client_secret:cn.clientSecret,scope:'https://graph.microsoft.com/.default',grant_type:'client_credentials'}),redirect:'error',signal:AbortSignal.timeout(10000)});if(!r.ok){await r.body?.cancel();throw new DefiniteError('Graph authentication failed');}const x=await r.json();if(typeof x?.access_token!=='string'||!x.access_token)throw new DefiniteError('Graph authentication invalid');return x.access_token as string;}
function cmisHeaders(cn: Connector) {
  const h = new Headers({ Accept: 'application/json' });
  if (cn.authMode === 'bearer' && cn.bearerToken) h.set('Authorization', `Bearer ${cn.bearerToken}`);
  else if (cn.username && cn.password) h.set('Authorization', `Basic ${b64(new TextEncoder().encode(`${cn.username}:${cn.password}`))}`);
  else throw new DefiniteError('CMIS authentication failed');
  return h;
}
async function cmisProbe(cn: Connector, f: Fetcher) {
  if (!cn.serviceUrl || !cn.repositoryId || !cn.folderId) throw new DefiniteError('CMIS not configured');
  const h = cmisHeaders(cn), base = cn.serviceUrl.replace(/\/+$/, ''), repositoryUrl = new URL(`${base}/${encodeURIComponent(cn.repositoryId)}`);
  repositoryUrl.searchParams.set('cmisselector', 'repositoryInfo');
  const repositoryResponse = await f(repositoryUrl.href, { headers: h, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!repositoryResponse.ok) { await repositoryResponse.body?.cancel(); throw new DefiniteError('CMIS repository unavailable'); }
  const repositoryInfo = obj(await repositoryResponse.json().catch(() => null));
  if (!repositoryInfo || (typeof repositoryInfo.repositoryId === 'string' && repositoryInfo.repositoryId !== cn.repositoryId)) throw new DefiniteError('CMIS repository invalid');
  const folderUrl = new URL(`${base}/${encodeURIComponent(cn.repositoryId)}`);
  folderUrl.searchParams.set('cmisselector', 'object');
  folderUrl.searchParams.set('objectId', cn.folderId);
  const folderResponse = await f(folderUrl.href, { headers: h, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (!folderResponse.ok) { await folderResponse.body?.cancel(); throw new DefiniteError('CMIS folder unavailable'); }
  const folder = obj(await folderResponse.json().catch(() => null));
  const properties = obj(folder?.properties);
  if (!folder || !properties) throw new DefiniteError('CMIS folder invalid');
  const idValue = obj(properties['cmis:objectId'])?.value;
  const baseType = obj(properties['cmis:baseTypeId'])?.value;
  if ((typeof idValue === 'string' && idValue !== cn.folderId) || (typeof baseType === 'string' && baseType !== 'cmis:folder')) throw new DefiniteError('CMIS folder invalid');
}
async function getBytes(c:Config,t:string,w:string,fid:string,rid:string,size:number,digest:string,f:Fetcher){try{const l=await f(`${c.supabaseUrl}/functions/v1/office-cloud-files`,{method:'POST',headers:{apikey:c.anonKey,Authorization:`Bearer ${t}`,'Content-Type':'application/json'},body:JSON.stringify({action:'get_link',fileId:fid,purpose:'download'}),redirect:'error',signal:AbortSignal.timeout(10000)});if(!l.ok)throw new DefiniteError('Attachment link unavailable');const u=safeBunnyUrl(obj(await l.json())?.url,w,fid,rid);if(!u)throw new DefiniteError('Attachment link invalid');const r=await f(u.href,{redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok)throw new DefiniteError('Attachment download failed');const reader=r.body?.getReader();if(!reader)throw new DefiniteError('Attachment unavailable');const ps:Uint8Array[]=[];let total=0;while(true){const z=await reader.read();if(z.done)break;total+=z.value.byteLength;if(total>size||total>MAX_ATTACHMENT){await reader.cancel();throw new DefiniteError('Attachment too large');}ps.push(z.value);}if(total!==size||total<1)throw new DefiniteError('Attachment size invalid');const b=new Uint8Array(total);let n=0;for(const x of ps){b.set(x,n);n+=x.length;}if(hex(new Uint8Array(await crypto.subtle.digest('SHA-256',b)))!==digest.toLowerCase())throw new DefiniteError('Attachment integrity failed');return b;}catch(e){if(e instanceof DefiniteError)throw e;throw new DefiniteError('Attachment retrieval failed');}}
function b64(b:Uint8Array){let s='';for(let i=0;i<b.length;i+=0x6000)s+=btoa(String.fromCharCode(...b.subarray(i,Math.min(i+0x6000,b.length))));return s;}
function safeStatus(a:Record<string,unknown>,fallback='failed'){const o:Record<string,unknown>={status:typeof a.status==='string'?a.status:fallback};if(uuid(a.attempt_id))o.attemptId=a.attempt_id;if('delivery_verified'in a)o.deliveryVerified=a.delivery_verified;else if(o.status!=='archived')o.deliveryVerified=false;if(typeof a.provider_object_id==='string')o.providerObjectId=a.provider_object_id;if(Number.isInteger(a.http_status))o.httpStatus=a.http_status;if(typeof a.error_code==='string')o.errorCode=a.error_code;return o;}
async function finish(c:Config,t:string,n:string,p:Record<string,unknown>,f:Fetcher){await rpc(c,t,n,p,f).catch(()=>undefined);}
function final(s:unknown){return ['accepted','archived','failed','unknown'].includes(String(s));}
async function cmisCreate(cn:Connector,name:string,b:Uint8Array,f:Fetcher){const h=cmisHeaders(cn),form=new FormData();form.set('cmisaction','createDocument');form.set('folderId',cn.folderId!);form.set('propertyId[0]','cmis:name');form.set('propertyValue[0]',name);form.set('propertyId[1]','cmis:objectTypeId');form.set('propertyValue[1]','cmis:document');form.set('content',new Blob([new Uint8Array(b)]),name);const r=await f(cn.serviceUrl!,{method:'POST',headers:h,body:form,redirect:'error',signal:AbortSignal.timeout(20000)});if(!r.ok){await r.body?.cancel();if(r.status>=500)throw new Error('CMIS create failed');throw new DefiniteError('CMIS create failed');}const x=await r.json().catch(()=>({})),p=obj(x?.properties),q=obj(p?.['cmis:objectId']);const id=typeof q?.value==='string'?q.value:typeof x?.['cmis:objectId']==='string'?x['cmis:objectId']:'';if(!id)throw new Error('CMIS response invalid');return id;}
async function send(c:Config,t:string,b:Record<string,unknown>,f:Fetcher,o:string|null,cn:Connector,access:string){if(!keys(b,['workspaceId','correspondenceId','expectedRecordVersion','recipient','subject','body','attachmentIds','idempotencyKey','nonSensitiveConfirmed'])||!uuid(b.workspaceId)||!uuid(b.correspondenceId)||!uuid(b.idempotencyKey)||!Number.isSafeInteger(b.expectedRecordVersion)||(b.expectedRecordVersion as number)<1||!email(b.recipient)||!text(b.subject,500)||!text(b.body,100000)||!Array.isArray(b.attachmentIds)||b.attachmentIds.length>3||!b.attachmentIds.every(uuid)||b.nonSensitiveConfirmed!==true)return json(o,400,{error:'INVALID_REQUEST'});let a:Record<string,unknown>;try{a=obj(await rpc(c,t,'office_gov_outbound_begin',{p_workspace_id:b.workspaceId,p_correspondence_id:b.correspondenceId,p_expected_record_version:b.expectedRecordVersion,p_idempotency_key:b.idempotencyKey,p_request_sha256_hex:await hash(b),p_attachment_ids:b.attachmentIds},f))||{};}catch{return json(o,502,{status:'failed',deliveryVerified:false,errorCode:'BEGIN_FAILED'});}const at=uuid(a.attempt_id)?a.attempt_id as string:'';if(!Object.prototype.hasOwnProperty.call(a,'attachments')){if(at&&!final(a.status))await finish(c,t,'office_gov_outbound_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:'unknown',p_error_code:'AMBIGUOUS_PROVIDER_OUTCOME'},f);return json(o,200,safeStatus({...a,status:final(a.status)?a.status:'unknown'},'unknown'));}if(!at)return json(o,502,{status:'failed',deliveryVerified:false,errorCode:'INVALID_BEGIN_RESPONSE'});const files:Array<{name:string;bytes:Uint8Array}>=[];let total=0;try{for(const raw of a.attachments as unknown[]){const x=obj(raw);if(!x||!uuid(x.file_id)||!uuid(x.revision_id)||typeof x.display_name!=='string'||!Number.isSafeInteger(x.size_bytes)||(x.size_bytes as number)<1||(x.size_bytes as number)>MAX_ATTACHMENT||typeof x.sha256_hex!=='string'||!/^[0-9a-f]{64}$/i.test(x.sha256_hex))throw new DefiniteError('Attachment metadata invalid');const bytes=await getBytes(c,t,b.workspaceId as string,x.file_id,x.revision_id,x.size_bytes as number,x.sha256_hex,f);total+=bytes.length;if(total>MAX_TOTAL)throw new DefiniteError('Total attachment size exceeded');files.push({name:x.display_name,bytes});}}catch{await finish(c,t,'office_gov_outbound_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:'failed',p_error_code:'ATTACHMENT_UNAVAILABLE'},f);return json(o,502,{status:'failed',attemptId:at,deliveryVerified:false,errorCode:'ATTACHMENT_UNAVAILABLE'});}try{const message={message:{subject:b.subject,body:{contentType:'Text',content:b.body},toRecipients:[{emailAddress:{address:b.recipient}}],attachments:await Promise.all(files.map(async x=>({'@odata.type':'#microsoft.graph.fileAttachment',name:x.name,contentType:'application/octet-stream',contentBytes:b64(x.bytes)})))},saveToSentItems:true},r=await f(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(cn.senderUpn!)}/sendMail`,{method:'POST',headers:{Authorization:`Bearer ${access}`,'Content-Type':'application/json'},body:JSON.stringify(message),redirect:'error',signal:AbortSignal.timeout(20000)});if(r.status!==202){await r.body?.cancel();if(r.status>=500)throw new Error('Graph ambiguous');await finish(c,t,'office_gov_outbound_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:'failed',p_http_status:r.status,p_error_code:'GRAPH_REJECTED'},f);return json(o,502,{status:'failed',attemptId:at,deliveryVerified:false,httpStatus:r.status,errorCode:'GRAPH_REJECTED'});}await rpc(c,t,'office_gov_outbound_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:'accepted',p_http_status:202},f);return json(o,200,{status:'accepted',attemptId:at,deliveryVerified:false,httpStatus:202});}catch(e){const d=e instanceof DefiniteError;await finish(c,t,'office_gov_outbound_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:d?'failed':'unknown',p_error_code:d?'PROVIDER_REJECTED':'AMBIGUOUS_PROVIDER_OUTCOME'},f);return json(o,502,{status:d?'failed':'unknown',attemptId:at,deliveryVerified:false,errorCode:d?'PROVIDER_REJECTED':'AMBIGUOUS_PROVIDER_OUTCOME'});}}
async function archive(c:Config,t:string,b:Record<string,unknown>,f:Fetcher,o:string|null,cn:Connector){if(!keys(b,['workspaceId','attachmentId','idempotencyKey'])||!uuid(b.workspaceId)||!uuid(b.attachmentId)||!uuid(b.idempotencyKey))return json(o,400,{error:'INVALID_REQUEST'});let a:Record<string,unknown>;try{a=obj(await rpc(c,t,'office_gov_archive_begin',{p_workspace_id:b.workspaceId,p_attachment_id:b.attachmentId,p_idempotency_key:b.idempotencyKey,p_request_sha256_hex:await hash(b)},f))||{};}catch{return json(o,502,{status:'failed',errorCode:'BEGIN_FAILED'});}const at=uuid(a.attempt_id)?a.attempt_id as string:'';if(!Object.prototype.hasOwnProperty.call(a,'file_id')){if(at&&!final(a.status))await finish(c,t,'office_gov_archive_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:'unknown',p_error_code:'AMBIGUOUS_PROVIDER_OUTCOME'},f);return json(o,200,safeStatus({...a,status:final(a.status)?a.status:'unknown'},'unknown'));}const rev=uuid(a.revision_id)?a.revision_id as string:'',file=uuid(a.file_id)?a.file_id as string:'',name=typeof a.display_name==='string'?a.display_name:'';if(!at||!rev||!file||!name||!Number.isSafeInteger(a.size_bytes)||(a.size_bytes as number)<1||(a.size_bytes as number)>MAX_ATTACHMENT||typeof a.sha256_hex!=='string'||!/^[0-9a-f]{64}$/i.test(a.sha256_hex))return json(o,502,{status:'failed',errorCode:'INVALID_BEGIN_RESPONSE'});try{const bytes=await getBytes(c,t,b.workspaceId as string,file,rev,a.size_bytes as number,a.sha256_hex,f),id=await cmisCreate(cn,name,bytes,f);await rpc(c,t,'office_gov_archive_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:'archived',p_provider_object_id:id},f);return json(o,200,{status:'archived',attemptId:at,providerObjectId:id});}catch(e){const d=e instanceof DefiniteError;await finish(c,t,'office_gov_archive_finish',{p_workspace_id:b.workspaceId,p_attempt_id:at,p_status:d?'failed':'unknown',p_error_code:d?'PROVIDER_REJECTED':'AMBIGUOUS_PROVIDER_OUTCOME'},f);return json(o,502,{status:d?'failed':'unknown',attemptId:at,errorCode:d?'PROVIDER_REJECTED':'AMBIGUOUS_PROVIDER_OUTCOME'});}}
function validUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > 2048) return false;
  try {
    const u = new URL(v), host = u.hostname.toLowerCase(), labels = host.split('.');
    const ipLiteral = host.includes(':') || host.startsWith('[') || /^\d+(?:\.\d+)*$/.test(host);
    const blockedSuffixes = ['localhost', 'local', 'internal', 'home.arpa', 'test', 'invalid', 'example', 'onion'];
    return u.protocol === 'https:' && !u.username && !u.password && !u.hash && !u.search && !u.port && !ipLiteral && labels.length >= 2 &&
      labels.every((label) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) &&
      !blockedSuffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  } catch { return false; }
}
async function setup(c: Config, t: string, b: Record<string, unknown>, f: Fetcher, o: string | null, p: 'graph' | 'cmis', actor: string) {
  const w = b.workspaceId;
  if (!uuid(w)) return json(o, 400, { error: 'INVALID_REQUEST' });
  let pr: Record<string, unknown> | null;
  try { pr = await profile(c, t, w, f); } catch { return json(o, 403, { error: 'WORKSPACE_ACCESS_DENIED' }); }
  if (!admin(pr)) return json(o, 403, { error: 'ADMIN_REQUIRED' });
  if (p === 'graph') {
    const tenantOk = typeof b.tenantId === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/.test(b.tenantId) && !b.tenantId.includes('..');
    if (!keys(b, ['workspaceId', 'tenantId', 'clientId', 'clientSecret', 'senderUpn']) || !tenantOk || !uuid(b.clientId) || !text(b.clientSecret, 4096) || !b.clientSecret || !email(b.senderUpn)) return json(o, 400, { error: 'INVALID_REQUEST' });
    try {
      const cn: Connector = { provider: 'graph', tenantId: b.tenantId as string, clientId: b.clientId as string, clientSecret: b.clientSecret as string, senderUpn: b.senderUpn as string };
      await graphToken(cn, f);
      await rpc(c, '', 'office_gov_connector_config_store', {
        p_workspace_id: w, p_provider: 'graph',
        p_public_config: { tenantId: cn.tenantId, clientId: cn.clientId, senderUpn: cn.senderUpn },
        p_secret: { clientSecret: cn.clientSecret }, p_actor_user_id: actor,
      }, f, true);
      await updateConnectorTest(c, w, 'graph', 'healthy', '', actor, f).catch(() => undefined);
      return status(c, w, f, o);
    } catch { return json(o, 502, { error: 'PROVIDER_UNAVAILABLE' }); }
  }
  if (!keys(b, ['workspaceId', 'serviceUrl', 'repositoryId', 'folderId', 'authMode', 'bearerToken', 'username', 'password']) ||
      !validUrl(b.serviceUrl) || !text(b.repositoryId, 512) || !b.repositoryId || !text(b.folderId, 512) || !b.folderId ||
      (b.authMode !== 'bearer' && b.authMode !== 'basic') ||
      (b.authMode === 'bearer' ? !text(b.bearerToken, 8192) || !b.bearerToken || b.username !== '' || b.password !== '' :
        !text(b.username, 512) || !b.username || b.username.includes(':') || !text(b.password, 8192) || !b.password || b.bearerToken !== '')) return json(o, 400, { error: 'INVALID_REQUEST' });
  const cn: Connector = {
    provider: 'cmis', serviceUrl: b.serviceUrl as string, repositoryId: b.repositoryId as string, folderId: b.folderId as string,
    authMode: b.authMode as 'bearer' | 'basic', bearerToken: b.bearerToken as string,
    username: b.username as string, password: b.password as string,
  };
  const secret = cn.authMode === 'bearer' ? { bearerToken: cn.bearerToken } : { username: cn.username, password: cn.password };
  try {
    await cmisProbe(cn, f);
    await rpc(c, '', 'office_gov_connector_config_store', {
      p_workspace_id: w, p_provider: 'cmis',
      p_public_config: { serviceUrl: cn.serviceUrl, repositoryId: cn.repositoryId, folderId: cn.folderId, authMode: cn.authMode },
      p_secret: secret, p_actor_user_id: actor,
    }, f, true);
    await updateConnectorTest(c, w, 'cmis', 'healthy', '', actor, f).catch(() => undefined);
    return status(c, w, f, o);
  } catch { return json(o, 502, { error: 'PROVIDER_UNAVAILABLE' }); }
}
async function status(c: Config, w: string, f: Fetcher, o: string | null) {
  let result: Record<string, unknown> | null;
  try { result = obj(await rpc(c, '', 'office_gov_connector_config_status', { p_workspace_id: w }, f, true)); }
  catch { return json(o, 503, { error: 'CONNECTOR_CONFIG_UNAVAILABLE' }); }
  const graph = obj(result?.graph), cmis = obj(result?.cmis);
  if (!graph || !cmis) return json(o, 503, { error: 'CONNECTOR_CONFIG_UNAVAILABLE' });
  const state = (item: Record<string, unknown>) => item.configured !== true ? 'not_configured' : item.state === 'healthy' ? 'ready' : 'needs_attention';
  const code = (item: Record<string, unknown>) => typeof item.error_code === 'string' && /^[A-Za-z0-9_.:-]{1,48}$/.test(item.error_code) ? item.error_code : null;
  const timestamp = (item: Record<string, unknown>) => typeof item.last_tested_at === 'string' && !Number.isNaN(Date.parse(item.last_tested_at)) ? item.last_tested_at : null;
  return json(o, 200, {
    graph: { state: state(graph), configured: graph.configured === true, senderConfigured: graph.sender_configured === true, lastCheckedAt: timestamp(graph), errorCode: code(graph) },
    cmis: { state: state(cmis), configured: cmis.configured === true, binding: cmis.binding === 'browser' ? 'browser' : null, repositoryConfigured: cmis.repository_configured === true, folderConfigured: cmis.folder_configured === true, lastCheckedAt: timestamp(cmis), errorCode: code(cmis) },
  });
}
async function probeStatus(c: Config, w: string, f: Fetcher, o: string | null, actor: string) {
  let g: Connector | null, m: Connector | null;
  try { [g, m] = await Promise.all([getConnector(c, w, 'graph', f), getConnector(c, w, 'cmis', f)]); }
  catch { return json(o, 503, { error: 'CONNECTOR_CONFIG_UNAVAILABLE' }); }
  if (g && g.tenantId && g.clientId && g.clientSecret) {
    try { await graphToken(g, f); await updateConnectorTest(c, w, 'graph', 'healthy', '', actor, f); }
    catch { await updateConnectorTest(c, w, 'graph', 'error', 'AUTH_FAILED', actor, f).catch(() => undefined); }
  }
  if (m && m.serviceUrl && m.repositoryId && m.folderId) {
    try { await cmisProbe(m, f); await updateConnectorTest(c, w, 'cmis', 'healthy', '', actor, f); }
    catch { await updateConnectorTest(c, w, 'cmis', 'error', 'PROBE_FAILED', actor, f).catch(() => undefined); }
  }
  return status(c, w, f, o);
}
export function createOfficeGovernmentHandler(options: { env?: Env; fetchImpl?: Fetcher } = {}) {
  const env = options.env || ((name: string) => (globalThis as { Deno?: { env: { get(name: string): string | undefined } } }).Deno?.env.get(name));
  const f = options.fetchImpl || fetch;
  return async (r: Request): Promise<Response> => {
    const o = origin(r);
    if (o && !ALLOWED_ORIGINS.has(o)) return json(null, 403, { error: 'ORIGIN_NOT_ALLOWED' });
    if (r.method === 'OPTIONS') return o ? new Response(null, { status: 204, headers: cors(o) }) : json(null, 403, { error: 'ORIGIN_NOT_ALLOWED' });
    const c = getConfig(env);
    if (!c) return json(o, 503, { error: 'GOVERNMENT_CONNECTOR_NOT_CONFIGURED' });
    const t = bearer(r), actor = await verify(c, t, f);
    if (!actor) return json(o, 401, { error: 'AUTHENTICATION_REQUIRED' });
    const u = new URL(r.url), path = u.pathname, b = r.method === 'POST' ? await body(r) : null;
    if (r.method === 'GET' && path.endsWith('/status')) {
      const w = u.searchParams.get('workspaceId') || '';
      if (!uuid(w)) return json(o, 400, { error: 'INVALID_REQUEST' });
      try { if (!await profile(c, t, w, f)) return json(o, 403, { error: 'WORKSPACE_ACCESS_DENIED' }); }
      catch { return json(o, 403, { error: 'WORKSPACE_ACCESS_DENIED' }); }
      return status(c, w, f, o);
    }
    if (r.method !== 'POST') return json(o, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (!b) return json(o, 400, { error: 'INVALID_REQUEST' });
    if (path.endsWith('/connections/check')) {
      if (!keys(b, ['workspaceId']) || !uuid(b.workspaceId)) return json(o, 400, { error: 'INVALID_REQUEST' });
      try { if (!admin(await profile(c, t, b.workspaceId, f))) return json(o, 403, { error: 'ADMIN_REQUIRED' }); }
      catch { return json(o, 403, { error: 'WORKSPACE_ACCESS_DENIED' }); }
      return probeStatus(c, b.workspaceId, f, o, actor);
    }
    if (path.endsWith('/connections/graph/test-and-save')) return setup(c, t, b, f, o, 'graph', actor);
    if (path.endsWith('/connections/cmis/test-and-save')) return setup(c, t, b, f, o, 'cmis', actor);
    if (path.endsWith('/connections/disconnect')) {
      if (!keys(b, ['workspaceId', 'provider']) || !uuid(b.workspaceId) || (b.provider !== 'graph' && b.provider !== 'cmis')) return json(o, 400, { error: 'INVALID_REQUEST' });
      try {
        if (!admin(await profile(c, t, b.workspaceId, f))) return json(o, 403, { error: 'ADMIN_REQUIRED' });
        await rpc(c, '', 'office_gov_connector_config_delete', { p_workspace_id: b.workspaceId, p_provider: b.provider, p_actor_user_id: actor }, f, true);
        return status(c, b.workspaceId, f, o);
      } catch { return json(o, 502, { error: 'CONNECTOR_UPDATE_FAILED' }); }
    }
    if (path.endsWith('/outbound/send')) {
      if (!uuid(b.workspaceId)) return json(o, 400, { error: 'INVALID_REQUEST' });
      const p = await profile(c, t, b.workspaceId, f).catch(() => null);
      if (!p || (!admin(p) && !roles(p).includes('outbound_dispatcher'))) return json(o, 403, { error: 'WORKSPACE_ACCESS_DENIED' });
      let cn: Connector | null;
      try { cn = await getConnector(c, b.workspaceId, 'graph', f); } catch { return json(o, 503, { error: 'CONNECTOR_CONFIG_UNAVAILABLE' }); }
      if (!cn || !cn.senderUpn) return json(o, 503, { error: 'GOVERNMENT_CONNECTOR_NOT_CONFIGURED' });
      let access = '';
      try { access = await graphToken(cn, f); await updateConnectorTest(c, b.workspaceId, 'graph', 'healthy', '', actor, f).catch(() => undefined); }
      catch { await updateConnectorTest(c, b.workspaceId, 'graph', 'error', 'AUTH_FAILED', actor, f).catch(() => undefined); return json(o, 502, { error: 'PROVIDER_UNAVAILABLE' }); }
      return send(c, t, b, f, o, cn, access);
    }
    if (path.endsWith('/archive/file')) {
      if (!uuid(b.workspaceId)) return json(o, 400, { error: 'INVALID_REQUEST' });
      const p = await profile(c, t, b.workspaceId, f).catch(() => null);
      if (!p || (!admin(p) && !roles(p).includes('records_manager'))) return json(o, 403, { error: 'WORKSPACE_ACCESS_DENIED' });
      let cn: Connector | null;
      try { cn = await getConnector(c, b.workspaceId, 'cmis', f); } catch { return json(o, 503, { error: 'CONNECTOR_CONFIG_UNAVAILABLE' }); }
      if (!cn || !cn.serviceUrl || !cn.repositoryId || !cn.folderId) return json(o, 503, { error: 'GOVERNMENT_CONNECTOR_NOT_CONFIGURED' });
      try { await cmisProbe(cn, f); await updateConnectorTest(c, b.workspaceId, 'cmis', 'healthy', '', actor, f).catch(() => undefined); }
      catch { await updateConnectorTest(c, b.workspaceId, 'cmis', 'error', 'PROBE_FAILED', actor, f).catch(() => undefined); return json(o, 502, { error: 'PROVIDER_UNAVAILABLE' }); }
      return archive(c, t, b, f, o, cn);
    }
    return json(o, 404, { error: 'NOT_FOUND' });
  };
}
