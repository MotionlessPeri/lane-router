import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

// Test-only: explicitly selected executables, fresh homes, synthetic tokens, loopback providers.
const executables=process.argv.slice(2);
if(!executables.length || executables.some(p=>!isAbsolute(p))) throw new Error('Supply absolute Codex executable paths.');
const base=await mkdtemp(join(tmpdir(),'lane-account-protocol-'));
const jwt=name=>`${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({jti:name,email:`${name==='refreshed'?'b':name}@fixture.invalid`,exp:Math.floor(Date.now()/1000)+3600,'https://api.openai.com/auth':{chatgpt_account_id:`fixture-${name==='refreshed'?'b':name}`,chatgpt_user_id:`user-${name==='refreshed'?'b':name}`,user_id:`user-${name==='refreshed'?'b':name}`,chatgpt_plan_type:'plus'}})).toString('base64url')}.fixture`;
const tokens={a:jwt('a'),b:jwt('b'),refreshed:jwt('refreshed')};
const observed=[];
const routes=[];
let failNext=false;
const handler=async(req,res)=>{
  try { for await(const _ of req) {} } catch { return; }
  if(req.url?.endsWith('/accounts/check')){
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({accounts:['a','b','refreshed'].map(name=>({id:`fixture-${name}`,workspace_backend_origin:'https://chatgpt.com',account_routing_override:'NO_CONSTRAINT'}))}));return;
  }
  if(!req.url?.endsWith('/responses')){routes.push(req.url);res.writeHead(404);res.end();return;}
  const label=Object.keys(tokens).find(k=>req.headers.authorization===`Bearer ${tokens[k]}`)??'missing';
  observed.push(label);
  if(failNext){failNext=false;res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture unauthorized',type:'invalid_request_error',code:'invalid_api_key'}}));return;}
  res.writeHead(200,{'content-type':'text/event-stream','connection':'close'});
  const item={id:'msg_fixture',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'fixture success',annotations:[]}]};
  for(const event of [
    {type:'response.created',response:{id:'resp_fixture',status:'in_progress',output:[]}},
    {type:'response.output_item.added',output_index:0,item:{...item,status:'in_progress',content:[]}},
    {type:'response.content_part.added',item_id:item.id,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}},
    {type:'response.output_text.delta',item_id:item.id,output_index:0,content_index:0,delta:'fixture success'},
    {type:'response.output_item.done',output_index:0,item},
    {type:'response.completed',response:{id:'resp_fixture',status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}
  ])res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
};
const server=createServer(handler),bootstrap=createServer(handler);
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
await new Promise(resolve=>bootstrap.listen(0,'127.0.0.1',resolve));
const url=`http://127.0.0.1:${server.address().port}/v1`;
const authUrl=`http://127.0.0.1:${bootstrap.address().port}/v1`;
const binaries=executables.map(executable=>{const result=spawnSync(executable,['--version'],{encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error('Executable version check failed');return [result.stdout.trim(),executable];});
const report=[];
for(const [version,executable] of binaries){
  const home=await mkdtemp(join(base,`synthetic-${version}-`));
  await mkdir(join(home,'workspace'));
  const args=['-c',`chatgpt_base_url="${authUrl}"`,'-c','model_provider="fixture"','-c',`model_providers.fixture={name="fixture",base_url="${url}",wire_api="responses",requires_openai_auth=true,supports_websockets=false}`,'-c','model="gpt-5.1-codex-mini"','-c','cli_auth_credentials_store="ephemeral"','app-server'];
  const child=spawn(executable,args,{cwd:join(home,'workspace'),env:{SystemRoot:process.env.SystemRoot,PATH:process.env.PATH,TEMP:process.env.TEMP,USERPROFILE:home,CODEX_HOME:home},windowsHide:true,stdio:['pipe','pipe','pipe']});
  child.stderr.resume();
  const lines=createInterface({input:child.stdout});
  const pending=new Map(), events=[];
  let id=0,refreshes=0,stage='initialize';
  const send=data=>child.stdin.write(JSON.stringify(data)+'\n');
  lines.on('line',line=>{
    let msg;try{msg=JSON.parse(line);}catch{return;}
    if(msg.method==='account/chatgptAuthTokens/refresh' && msg.id!==undefined){refreshes++;send({id:msg.id,result:{accessToken:tokens.refreshed,chatgptAccountId:msg.params.previousAccountId??'fixture-b',chatgptPlanType:'plus'}});return;}
    if(msg.id!==undefined && pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error(`rpc-${msg.error.code}: ${String(msg.error.message).slice(0,700)}`)):p.resolve(msg.result);}
    else if(msg.method)events.push(msg);
  });
  child.on('error',()=>{});child.stdin.on('error',()=>{});
  const request=(method,params)=>new Promise((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(new Error('timeout'));},15000);pending.set(key,{resolve,reject,timer});send({id:key,method,params});});
  const turn=async threadId=>{
    const result=await request('turn/start',{threadId,input:[{type:'text',text:'Reply with fixture success.',text_elements:[]}]});
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){const event=events.find(e=>e.method==='turn/completed' && e.params.turn.id===result.turn.id);if(event){assert.equal(event.params.turn.status,'completed',JSON.stringify(event.params.turn.error));return;}await new Promise(resolve=>setTimeout(resolve,50));}
    throw new Error('turn-timeout');
  };
  const startIndex=observed.length;
  try{
    await request('initialize',{clientInfo:{name:'account-switch-fixture',version:'1'},capabilities:{experimentalApi:true}});send({method:'initialized'});
    stage='login-a';await request('account/login/start',{type:'chatgptAuthTokens',accessToken:tokens.a,chatgptAccountId:'fixture-a',chatgptPlanType:'plus'});
    assert.equal((await request('account/read',{refreshToken:false})).account.email,'a@fixture.invalid');
    stage='thread-start';const t=await request('thread/start',{cwd:join(home,'workspace'),model:'gpt-5.1-codex-mini',modelProvider:'fixture',approvalPolicy:'never',sandbox:'read-only'});
    stage='turn-a';await turn(t.thread.id);
    stage='idle-api';assert.deepEqual((await request('thread/queue/list',{threadId:t.thread.id})).data,[]);
    assert.equal((await request('thread/goal/get',{threadId:t.thread.id})).goal,null);
    stage='login-b';await request('account/login/start',{type:'chatgptAuthTokens',accessToken:tokens.b,chatgptAccountId:'fixture-b',chatgptPlanType:'plus'});
    assert.equal((await request('account/read',{refreshToken:false})).account.email,'b@fixture.invalid');
    const status=await request('getAuthStatus',{includeToken:true,refreshToken:false});
    assert.equal(status.authToken,tokens.b,'legacy auth status must return external access token');
    stage='same-thread-b';await turn(t.thread.id);
    stage='refresh';failNext=true;await turn(t.thread.id);
    assert.deepEqual(observed.slice(startIndex),['a','b','b','refreshed']);assert.equal(refreshes,1);
    stage='legacy-auth-methods';
    for(const method of ['loginApiKey','loginChatGpt','logout']){
      await assert.rejects(()=>request(method,{apiKey:'synthetic-only'}), /rpc--3260[01]|unknown variant|Unknown method/i);
    }
    report.push({version,status:'pass',sameThreadAcrossAccounts:true,refreshRequests:refreshes,authorizationSequence:observed.slice(startIndex)});
  }catch(error){report.push({version,status:'fail',stage,error:error.message,refreshRequests:refreshes,authorizationSequence:observed.slice(startIndex)});}
  finally{for(const p of pending.values())clearTimeout(p.timer);lines.close();child.stdin.end();if(child.exitCode===null){await new Promise(done=>{child.once('close',done);child.kill();});}}
}
server.close();server.closeAllConnections();bootstrap.close();bootstrap.closeAllConnections();
const rel=relative(resolve(tmpdir()),resolve(base));
if(!rel.startsWith('lane-account-protocol-') || rel.includes('..') || isAbsolute(rel)) throw new Error('Unsafe fixture cleanup path');
await rm(base,{recursive:true,force:true,maxRetries:10,retryDelay:200});
console.log(JSON.stringify({report}));
process.exitCode=report.every(r=>r.status==='pass')?0:1;
