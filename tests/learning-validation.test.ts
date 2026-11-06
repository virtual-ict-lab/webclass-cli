import {expect,test} from 'bun:test';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {AttemptService} from '../src/attempts.ts';
import {WebClassClient} from '../src/http.ts';
import {parseAttempt} from '../src/parsers/attempt.ts';

const cli=join(import.meta.dir,'../src/cli.ts');
const attemptId='11111111-1111-4111-8111-111111111111';

async function runCli(dir:string,args:string[],extraEnv:Record<string,string>={}){
 const child=Bun.spawn([process.execPath,cli,...args],{
  env:{XDG_STATE_HOME:join(dir,'state'),XDG_CONFIG_HOME:join(dir,'config'),WEBCLASS_COOKIE:'',WEBCLASS_BASE_URL:'http://localhost:1/webclass/',...extraEnv},
  stdin:'ignore',stdout:'pipe',stderr:'pipe',
 });
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
 return {stdout,stderr,code};
}

const invalidArities:[string,number[]][]=[
 ['begin',[0,1,3]],['open',[0,1,3]],['list',[1]],['run',[1,3]],
 ...['answer','resume','start','show','save','next','prev','submit','abandon','text','file'].map(action=>[action,[0,2]] as [string,number[]]),
];
for(const kind of ['quiz','report'])for(const [action,counts] of invalidArities){
 if(kind==='quiz'&&['text','file'].includes(action))continue;
 for(const count of counts)test(`${kind} ${action} rejects ${count} arguments before state or authentication`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'wc-learning-arity-'));
  try{
   const result=await runCli(dir,[kind,action,...[attemptId,'content','extra'].slice(0,count),'--yes']);
   expect(result.code).toBe(2);
   expect(JSON.parse(result.stderr)).toMatchObject({error:{code:'USAGE',message:expect.stringContaining(`Usage: webclass ${kind} ${action}`)}});
   expect(result.stdout).toBe('');
   expect(existsSync(join(dir,'state'))).toBe(false);
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
}

// Synthetic pages model a collected two-page report with page 2 currently active.
function reportPage(question:number,value='old'){
 return `<h2 class="wcl_pageMainTitle">Synthetic report</h2><form name="QuestionForm" method="post"><input type="hidden" name="QstnSession[s]" value="1"><input type="hidden" name="QstnSession[page]" value="${question}"><input type="hidden" name="QstnSession[cmd]" value=""><fieldset class="textStyle"><textarea name="QuestionAnswer[${question}][text]">${value}</textarea></fieldset></form>`;
}

test('report text requires navigation for an off-page catalog question and saves the current question',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'wc-report-page-'));
 const requests:{command:string|null,answer:string|null,otherAnswer:string|null}[]=[];
 const server=Bun.serve({port:0,fetch:async req=>{
  const form=await req.formData();
  requests.push({command:form.get('QstnSession[cmd]') as string|null,answer:form.get('QuestionAnswer[2][text]') as string|null,otherAnswer:form.get('QuestionAnswer[1][text]') as string|null});
  return new Response(reportPage(2,String(form.get('QuestionAnswer[2][text]')??'old')),{headers:{'content-type':'text/html'}});
 }});
 try{
  const base=`http://localhost:${server.port}/webclass/`;
  const client=new WebClassClient({baseUrl:base,cookies:{WBT_Session:'local'},access:'learning'});
  const service=new AttemptService(client,join(dir,'state','webclass','attempts'));
  const id=randomUUID();const url=new URL('mbl.php/questions/',base);
  const first=parseAttempt(reportPage(1),url);const current=parseAttempt(reportPage(2),url);
  service.store.write({version:1,id,base,identity:client.sessionFingerprint,courseId:'course',contentId:'content',status:'active',url:url.href,page:current,catalog:[first,current],batch:'done',updatedAt:''});
  const statePath=join(service.store.dir,`${id}.json`);const before=readFileSync(statePath,'utf8');
  const textFile=join(dir,'report.txt');await Bun.write(textFile,'Current page text');
  const env={WEBCLASS_BASE_URL:base,WEBCLASS_COOKIE:'WBT_Session=local'};
  const offPage=await runCli(dir,['report','text',id,'--question','1','--text-file',textFile],env);
  expect(offPage.code).toBe(2);
  const error=JSON.parse(offPage.stderr).error;
  expect(error.code).toBe('USAGE');
  expect(error.message).toContain('current page');
  expect(error.message).toContain('next');
  expect(error.message).toContain('prev');
  expect(requests).toEqual([]);
  expect(readFileSync(statePath,'utf8')).toBe(before);
  const saved=await runCli(dir,['report','text',id,'--question','2','--text-file',textFile],env);
  expect(saved.stderr).toBe('');expect(saved.code).toBe(0);
  expect(JSON.parse(saved.stdout)).toMatchObject({status:'active',questions:[{id:'2',fields:[{values:['Current page text']}]}]});
  expect(requests).toEqual([{command:'restart',answer:'Current page text',otherAnswer:null}]);
 }finally{server.stop(true);rmSync(dir,{recursive:true,force:true});}
});
