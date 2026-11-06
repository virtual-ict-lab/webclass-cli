import {expect,test} from 'bun:test';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {makeClient} from '../src/commands.ts';
import {clearSession,loadSession,saveSession,sessionPath,updateSessionCookies} from '../src/session.ts';
import {AttemptService} from '../src/attempts.ts';
import {parseAttempt} from '../src/parsers/attempt.ts';
import {BASE,fixture,html} from './helpers.ts';

function setup(){
  const dir=mkdtempSync(join(tmpdir(),'wc-rotation-'));
  const env={XDG_STATE_HOME:join(dir,'state'),XDG_CONFIG_HOME:join(dir,'config'),WEBCLASS_BASE_URL:BASE};
  saveSession({WBT_Session:'original'},env);
  return {dir,env,done:()=>rmSync(dir,{recursive:true,force:true})};
}
test('server cookie rotation keeps an existing attempt usable across CLI processes',async()=>{
  const t=setup();
  try{
    // Existing session files have no identity metadata.
    writeFileSync(sessionPath(t.env),JSON.stringify({cookies:{WBT_Session:'original'},saved_at:'2026-01-01T00:00:00Z'}));
    const first=makeClient(t.env,{access:'learning',sleep:async()=>{},fetch:async()=>html('ok',200,{'set-cookie':'WBT_Session=rotated; Path=/webclass/'})});
    const service=new AttemptService(first,join(t.dir,'attempts'));const id=randomUUID();
    service.store.write({version:1,id,base:BASE,identity:first.sessionFingerprint,courseId:'00x_000001',contentId:'d000000000000000000000000000000e',status:'active',url:new URL('mbl.php/questions/',BASE).href,updatedAt:'',page:parseAttempt(fixture('quiz-saved.html'),new URL('mbl.php/questions/',BASE))});
    await first.get('index.php');
    expect(loadSession(t.env)?.cookies.WBT_Session).toBe('rotated');
    let sentCookie='';
    const second=makeClient(t.env,{access:'learning',sleep:async()=>{},fetch:async(_url,init)=>{sentCookie=new Headers(init.headers).get('Cookie')??'';return html(fixture('quiz-saved.html'));}});
    expect(second.sessionFingerprint).toBe(first.sessionFingerprint);
    const resumed=await new AttemptService(second,join(t.dir,'attempts')).act(id,'save',{'QuestionAnswer[1][value][0]':'example-1'});
    expect(resumed.status).toBe('active');expect(sentCookie).toContain('WBT_Session=rotated');
  }finally{t.done();}
});
test('manual login replacement never inherits a previous session identity',async()=>{
  const t=setup();try{
    const first=makeClient(t.env,{fetch:async()=>html('ok',200,{'set-cookie':'WBT_Session=rotated'})});
    await first.get('index.php');
    saveSession({WBT_Session:'rotated'},t.env);
    expect(makeClient(t.env).sessionFingerprint).not.toBe(first.sessionFingerprint);
    saveSession({WBT_Session:'another-login'},t.env);
    expect(makeClient(t.env).sessionFingerprint).not.toBe(first.sessionFingerprint);
  }finally{t.done();}
});
test('an old client cannot overwrite a newer manually saved session',async()=>{
  const t=setup();try{
    const old=makeClient(t.env,{fetch:async()=>html('ok',200,{'set-cookie':'WBT_Session=stale-rotation'})});
    saveSession({WBT_Session:'new-login'},t.env);
    await expect(old.get('index.php')).rejects.toMatchObject({code:'USAGE'});
    expect(loadSession(t.env)?.cookies.WBT_Session).toBe('new-login');
  }finally{t.done();}
});
test('removing the authentication cookie invalidates the saved attempt identity',async()=>{
  const t=setup();try{
    saveSession({WBT_Session:'original',WCAC:'Authenticated'},t.env);
    const old=makeClient(t.env,{fetch:async()=>html('ok',200,{'set-cookie':'WBT_Session=deleted; Max-Age=0'})});
    await old.get('index.php');
    expect(makeClient(t.env).sessionFingerprint).not.toBe(old.sessionFingerprint);
  }finally{t.done();}
});
test('environment cookies do not gain or persist a saved-session identity',async()=>{
  const t=setup();try{
    const env={...t.env,WEBCLASS_COOKIE:'WBT_Session=environment'};
    const client=makeClient(env,{fetch:async()=>html('ok',200,{'set-cookie':'WBT_Session=environment-rotated'})});
    await client.get('index.php');
    expect(loadSession(t.env)?.cookies.WBT_Session).toBe('original');
    expect(makeClient({...env,WEBCLASS_COOKIE:'WBT_Session=environment-rotated'}).sessionFingerprint).not.toBe(client.sessionFingerprint);
  }finally{t.done();}
});

type SessionOperation='save'|'update'|'clear';
function competingProcess(t:ReturnType<typeof setup>,operation:SessionOperation,identity:string){
  const child=Bun.spawnSync([process.execPath,'--eval',`
    const {saveSession,updateSessionCookies,clearSession}=await import(process.env.SESSION_MODULE);
    try {
      if(process.env.SESSION_OPERATION==='save')saveSession({WBT_Session:'competing-login'});
      else if(process.env.SESSION_OPERATION==='update')updateSessionCookies({WBT_Session:'stale-rotation'},{cookies:{WBT_Session:'original'},identity:process.env.SESSION_IDENTITY},process.env);
      else clearSession();
      console.log(JSON.stringify({code:'SUCCESS'}));
    } catch(error) {console.log(JSON.stringify({code:error.code,message:error.message}));}
  `],{env:{...t.env,SESSION_MODULE:join(import.meta.dir,'../src/session.ts'),SESSION_OPERATION:operation,SESSION_IDENTITY:identity},timeout:5000});
  expect(child.exitCode).toBe(0);expect(child.stderr.toString()).toBe('');
  return JSON.parse(child.stdout.toString()) as {code:string;message?:string};
}

for(const operation of ['save','update','clear'] as const)test(`a concurrent ${operation} cannot interrupt a server cookie update`,()=>{
  const t=setup();try{
    const original=loadSession(t.env)!;let competing:ReturnType<typeof competingProcess>|undefined;
    // Yield to a real process after the current session was read, before comparing and writing it.
    const expected={cookies:original.cookies,get identity(){
      if(!competing)competing=competingProcess(t,operation,original.identity!);
      return original.identity!;
    }};
    updateSessionCookies({WBT_Session:'server-rotated'},expected,t.env);
    expect(competing?.code).toBe('USAGE');
    expect(competing?.message).toContain('session.lock');
    expect(competing?.message).toContain('Retry');
    expect(loadSession(t.env)).toMatchObject({cookies:{WBT_Session:'server-rotated'},identity:original.identity});
    expect(existsSync(join(t.dir,'state','webclass','session.lock'))).toBe(false);
  }finally{t.done();}
});

test('manual login holds a private lock and its new credentials survive a stale client',()=>{
  const t=setup();try{
    const original=loadSession(t.env)!;let competing:ReturnType<typeof competingProcess>|undefined;
    let lockMode:number|undefined;let lockOwner:string|undefined;
    const lock=join(t.dir,'state','webclass','session.lock');
    saveSession({get WBT_Session(){
      if(!competing){
        if(existsSync(lock)){lockMode=statSync(lock).mode&0o777;lockOwner=readFileSync(lock,'utf8');}
        competing=competingProcess(t,'update',original.identity!);
      }
      return 'new-login';
    }},t.env);
    expect(competing?.code).toBe('USAGE');expect(lockMode).toBe(0o600);expect(lockOwner).toBe(String(process.pid));
    const current=loadSession(t.env)!;expect(current.cookies).toEqual({WBT_Session:'new-login'});expect(current.identity).not.toBe(original.identity);
    expect(()=>updateSessionCookies({WBT_Session:'stale-rotation'},{cookies:original.cookies,identity:original.identity!},t.env)).toThrow('saved session changed');
    expect(loadSession(t.env)).toEqual(current);expect(existsSync(lock)).toBe(false);
  }finally{t.done();}
});

for(const operation of ['save','update','clear'] as const)test(`a failed ${operation} releases its session lock`,()=>{
  const t=setup();try{
    const original=loadSession(t.env)!;
    if(operation==='save')expect(()=>saveSession({WBT_Session:'new'},t.env,new Date(NaN))).toThrow();
    else if(operation==='update')expect(()=>updateSessionCookies({WBT_Session:'new'},{cookies:{WBT_Session:'stale'},identity:original.identity!},t.env)).toThrow('saved session changed');
    else {
      rmSync(sessionPath(t.env));mkdirSync(sessionPath(t.env));
      expect(()=>clearSession(t.env)).toThrow();rmSync(sessionPath(t.env),{recursive:true});
    }
    expect(existsSync(join(t.dir,'state','webclass','session.lock'))).toBe(false);
    saveSession({WBT_Session:'after-error'},t.env);
    expect(loadSession(t.env)?.cookies.WBT_Session).toBe('after-error');
  }finally{t.done();}
});

test('a pre-existing session lock is retained until its owner is checked',()=>{
  const t=setup();try{
    const lock=join(t.dir,'state','webclass','session.lock');const before=loadSession(t.env)!;
    writeFileSync(lock,'999999999',{mode:0o600});
    for(const operation of [()=>saveSession({WBT_Session:'new'},t.env),()=>updateSessionCookies({WBT_Session:'new'},{cookies:before.cookies,identity:before.identity!},t.env),()=>clearSession(t.env)]){
      expect(operation).toThrow('confirm');expect(readFileSync(lock,'utf8')).toBe('999999999');expect(loadSession(t.env)).toEqual(before);
    }
  }finally{t.done();}
});
