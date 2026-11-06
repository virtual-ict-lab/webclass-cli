import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,statSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {AttemptService} from '../src/attempts.ts';
import {WebClassClient} from '../src/http.ts';
import {BASE,fixture,html,redirect} from './helpers.ts';
function setup(){
 const dir=mkdtempSync(tmpdir()+'/wc-attempt-');const calls:{url:string;init:RequestInit}[]=[];let fail=false;
 const client=new WebClassClient({baseUrl:BASE,cookies:{WBT_Session:'private'},access:'learning',sleep:async()=>{},fetch:async(url,init)=>{
  calls.push({url,init});if(fail)throw new Error('lost');
  const u=new URL(url);
  if(u.pathname.endsWith('index.php'))return html(fixture('index.html'));
  if(u.pathname.includes('course.php'))return html(fixture('course.html').replaceAll('d000000000000000000000000000000f','d000000000000000000000000000000e'));
  if(u.pathname.endsWith('do_contents.php'))return html(fixture('quiz-start.html'));
  if(u.pathname.endsWith('show_info.php'))return redirect('mbl.php/questions/',303);
  if(u.pathname.endsWith('/questions/')){
   if(init.method==='POST'&&String(init.body).includes('finish'))return redirect('/webclass/mbl.php/question_results',303);
   return html(fixture('quiz-saved.html'));
  }
  if(u.pathname.endsWith('question_results'))return html(fixture('quiz-result.html'));
  return html('unknown',404);
 }});
 return {dir,calls,client,service:new AttemptService(client,dir),lose:()=>{fail=true;},done:()=>rmSync(dir,{recursive:true,force:true})};
}
const content='d000000000000000000000000000000e';
test('open/start/save/submit across service instances with private state',async()=>{
 const t=setup();try{
  const a=await t.service.open('00x_000001',content);expect(a.status).toBe('ready');
  expect(statSync(`${t.dir}/${a.attempt_id}.json`).mode&0o777).toBe(0o600);
  const started=await t.service.act(a.attempt_id,'start');expect(started.questions).toHaveLength(5);
  const service=new AttemptService(t.client,t.dir);
  const saved=await service.act(a.attempt_id,'save',{'QuestionAnswer[1][value][0]':'example-1'});expect(saved.status).toBe('active');
  const result=await service.act(a.attempt_id,'submit');expect(result.score).toBe(3);expect(result.status).toBe('submitted');
  const count=t.calls.length;await expect(service.act(a.attempt_id,'submit')).rejects.toThrow();expect(t.calls.length).toBe(count);
  expect(JSON.stringify(result)).not.toContain('acs_');expect(JSON.stringify(result)).not.toContain('private');
 }finally{t.done();}
});
test('uncertain operation is persisted and cannot be resent',async()=>{
 const t=setup();try{const a=await t.service.open('00x_000001',content);await t.service.act(a.attempt_id,'start');t.lose();
 await expect(t.service.act(a.attempt_id,'submit')).rejects.toMatchObject({code:'OPERATION_UNCERTAIN'});
 expect(t.service.show(a.attempt_id).status).toBe('uncertain');const count=t.calls.length;
 await expect(t.service.act(a.attempt_id,'submit')).rejects.toThrow();expect(t.calls.length).toBe(count);
 }finally{t.done();}
});
test('invalid input never changes status; active attempt prevents new open',async()=>{
 const t=setup();try{const a=await t.service.open('00x_000001',content);await t.service.act(a.attempt_id,'start');
 await expect(t.service.act(a.attempt_id,'save',{'hidden':'x'})).rejects.toThrow();expect(t.service.show(a.attempt_id).status).toBe('active');
 await expect(t.service.open('00x_000001',content)).rejects.toThrow();
 await expect(t.service.act('../secret','submit')).rejects.toThrow();
 }finally{t.done();}
});
test('pending state from a killed process cannot be resent',async()=>{
 const t=setup();try{const a=await t.service.open('00x_000001',content);const path=`${t.dir}/${a.attempt_id}.json`;
 const data=JSON.parse(readFileSync(path,'utf8'));data.status='pending';writeFileSync(path,JSON.stringify(data));
 await expect(t.service.act(a.attempt_id,'start')).rejects.toThrow();
 }finally{t.done();}
});
test('submit returning the same question page is uncertain, not a successful active attempt',async()=>{
 const t=setup();try{const a=await t.service.open('00x_000001',content);await t.service.act(a.attempt_id,'start');
 const client=new WebClassClient({baseUrl:BASE,cookies:{WBT_Session:'private'},access:'learning',sleep:async()=>{},fetch:async()=>html(fixture('quiz-saved.html'))});
 const service=new AttemptService(client,t.dir);await expect(service.act(a.attempt_id,'submit')).rejects.toMatchObject({code:'OPERATION_UNCERTAIN'});expect(service.show(a.attempt_id).status).toBe('uncertain');
 }finally{t.done();}
});
test('response for a different material is not accepted',async()=>{
 const t=setup();try{const a=await t.service.open('00x_000001',content);
 const client=new WebClassClient({baseUrl:BASE,cookies:{WBT_Session:'private'},access:'learning',sleep:async()=>{},fetch:async()=>html(fixture('quiz-questions.html').replaceAll('d000000000000000000000000000000e','other-material'))});
 const service=new AttemptService(client,t.dir);await expect(service.act(a.attempt_id,'start')).rejects.toMatchObject({code:'OPERATION_UNCERTAIN'});
 }finally{t.done();}
});
