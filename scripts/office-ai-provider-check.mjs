import assert from 'node:assert/strict';
import test from 'node:test';
import { createOfficeAiProviderHandler } from '../api/office-ai-provider.js';

const URL = 'https://nresyncmhdybucenhxbw.supabase.co';
const OR = 'https://openrouter.ai/api/v1/chat/completions';
const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'synthetic-cocce-user-token';
const KEY = 'synthetic-server-only-openrouter-key';
function response() { return { statusCode: 0, body: null, headers: {}, setHeader(k,v){this.headers[k.toLowerCase()]=v;}, status(s){this.statusCode=s;return this;}, json(b){this.body=b;return this;} }; }
function harness({ key=KEY, auth=200, member=true, ai=true, provider=200, model='nvidia/nemotron-3-ultra-550b-a55b:free', cost=0 }={}) {
  const calls=[];
  const env={ OPENROUTER_API_KEY:key, VITE_COCCE_SUPABASE_URL:URL, VITE_COCCE_SUPABASE_ANON_KEY:'sb_publishable_test_key' };
  const fetchImpl=async (url,init={})=>{
    calls.push({url:String(url),init});
    if(String(url)===URL+'/auth/v1/user') return {ok:auth===200,status:auth,json:async()=>({id:'synthetic-user'})};
    if(String(url)===URL+'/rest/v1/rpc/office_list_workspaces') return {ok:true,status:200,json:async()=>member?[{workspace_id:WORKSPACE}]:[]};
    if(String(url)===URL+'/rest/v1/rpc/office_get_workspace_ai_enabled') return {ok:true,status:200,json:async()=>ai};
    if(String(url)===OR) return {ok:provider===200,status:provider,json:async()=>provider===200?{model,usage:{cost},choices:[{message:{content:'Synthetic answer'}}]}:{error:{code:'no_available_provider'}}};
    throw new Error('Unexpected URL ' + url);
  };
  const handler=createOfficeAiProviderHandler({envProvider:()=>env,fetchImpl,now:()=>1000});
  return {handler,calls};
}
async function invoke(handler,{method='POST',token=TOKEN,body}={}) {
  const req={method,headers:token?{authorization:'Bearer '+token}:{},body};
  const res=response(); await handler(req,res); return res;
}

test('status reports only configuration state and never exposes the provider key',async()=>{
 const {handler}=harness(); const res=await invoke(handler,{method:'GET'});
 assert.equal(res.statusCode,200); assert.deepEqual(res.body,{configured:true,model:'openrouter/free'});
 assert.equal(JSON.stringify(res.body).includes(KEY),false); assert.equal(res.headers['cache-control'],'no-store, max-age=0');
});
test('chat uses openrouter/free, checks account and workspace AI permissions, and returns zero-cost free model',async()=>{
 const {handler,calls}=harness();
 const res=await invoke(handler,{body:{workspaceId:WORKSPACE,messages:[{role:'system',content:'System'},{role:'user',content:'Hello'}]}});
 assert.equal(res.statusCode,200); assert.deepEqual(res.body,{text:'Synthetic answer',model:'nvidia/nemotron-3-ultra-550b-a55b:free',cost:0});
 const call=calls.find(x=>x.url===OR); assert.ok(call);
 assert.equal(call.init.headers.Authorization,'Bearer '+KEY);
 const payload=JSON.parse(call.init.body); assert.equal(payload.model,'openrouter/free'); assert.equal(Object.hasOwn(payload,'models'),false);
 assert.equal(Object.hasOwn(payload,'provider'),false); assert.equal(payload.messages[1].content,'Hello');
 assert.equal(JSON.stringify(res.body).includes(KEY),false);
});
test('rejects missing auth, non-members, and disabled workspace before provider call',async()=>{
 const missing=harness(); assert.equal((await invoke(missing.handler,{token:'',body:{workspaceId:WORKSPACE,messages:[{role:'user',content:'x'}]}})).statusCode,401);
 const outsider=harness({member:false}); assert.equal((await invoke(outsider.handler,{body:{workspaceId:WORKSPACE,messages:[{role:'user',content:'x'}]}})).statusCode,403);
 const disabled=harness({ai:false}); assert.equal((await invoke(disabled.handler,{body:{workspaceId:WORKSPACE,messages:[{role:'user',content:'x'}]}})).statusCode,403);
 assert.equal(missing.calls.some(x=>x.url===OR),false); assert.equal(outsider.calls.some(x=>x.url===OR),false); assert.equal(disabled.calls.some(x=>x.url===OR),false);
});
test('fails closed for malformed payloads, paid model responses, and provider errors',async()=>{
 const bad=harness(); assert.equal((await invoke(bad.handler,{body:{workspaceId:WORKSPACE,messages:[{role:'user',content:'x'}],model:'paid/model'}})).statusCode,400);
 const paid=harness({model:'openai/gpt-5'}); assert.equal((await invoke(paid.handler,{body:{workspaceId:WORKSPACE,messages:[{role:'user',content:'x'}]}})).statusCode,503);
 const charged=harness({cost:0.01}); assert.equal((await invoke(charged.handler,{body:{workspaceId:WORKSPACE,messages:[{role:'user',content:'x'}]}})).statusCode,503);
 const unavailable=harness({provider:429}); assert.equal((await invoke(unavailable.handler,{body:{workspaceId:WORKSPACE,messages:[{role:'user',content:'x'}]}})).statusCode,503);
});
test('fails with a clear configuration error when the server key is absent',async()=>{
 const {handler}=harness({key:''}); const res=await invoke(handler,{body:{workspaceId:WORKSPACE,messages:[{role:'user',content:'x'}]}});
 assert.equal(res.statusCode,503); assert.equal(res.body.error,'AI_NOT_CONFIGURED');
});
