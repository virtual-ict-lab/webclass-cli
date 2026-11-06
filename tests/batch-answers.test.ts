import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {AttemptService} from '../src/attempts.ts';
import {WebClassClient} from '../src/http.ts';
import {BASE,fixture,html,redirect} from './helpers.ts';
const content='d000000000000000000000000000000e';
const page=(n:number,value='')=>`<h2 class="wcl_pageMainTitle">Multi page test</h2><form name="QuestionForm" method="post"><input type="hidden" name="QstnSession[s]" value="1"><input type="hidden" name="QstnSession[cmd]" value=""><input type="hidden" name="QstnSession[page]" value="${n}"><h2 class="wcl_sectionTitle">Question ${n}</h2><div class="content">Question ${n}<input name="QuestionAnswer[${n}][value]" value="${value}"></div>${n===1?'<a href="javascript:QuestionClient.nextPage()">Next</a>':'<a href="javascript:QuestionClient.prevPage()">Previous</a><a href="javascript:QuestionClient.finish()">Grade</a>'}</form>`;
function setup(options:{sleep?:(ms:number)=>Promise<void>;initialPage?:number}={}){
 const dir=mkdtempSync(tmpdir()+'/wc-batch-');let current=options.initialPage??1;let lose=false;const saved:Record<string,string>={};const sends:{cmd:string;entries:[string,string][]}[]=[];
 const client=new WebClassClient({baseUrl:BASE,cookies:{WBT_Session:'batch'},access:'learning',sleep:async()=>{},fetch:async(url,init)=>{
  const path=new URL(url).pathname;
  if(path.endsWith('index.php'))return html(fixture('index.html'));
  if(path.includes('course.php'))return html(fixture('course.html').replaceAll('d000000000000000000000000000000f',content));
  if(path.endsWith('do_contents.php'))return html(fixture('quiz-start.html'));
  if(path.endsWith('show_info.php'))return redirect('/webclass/mbl.php/questions/',303);
  if(path.endsWith('question_results'))return html(fixture('quiz-result.html'));
  if(init.method==='POST'){
   const data=new URLSearchParams(String(init.body));const cmd=data.get('QstnSession[cmd]')!;sends.push({cmd,entries:[...data]});
   saved[String(current)]=data.get(`QuestionAnswer[${current}][value]`)??'';
   if(lose&&cmd==='finish')throw new Error('lost');
   if(cmd==='nextPage')current++;else if(cmd==='prevPage')current--;else if(cmd==='finish')return redirect('/webclass/mbl.php/question_results',303);
  }
  return html(page(current,saved[String(current)]));
 }});
 return {service:new AttemptService(client,dir,options),sends,saved,lose:()=>{lose=true;},done:()=>rmSync(dir,{recursive:true,force:true})};
}
test('begin returns all pages, answerAll sends each page in sequence then finishes',async()=>{
 const t=setup();try{const a=await t.service.begin('00x_000001',content);expect(a.questions?.map(q=>q.id)).toEqual(['1','2']);expect(a.page).toBe(1);
 const before=t.sends.length;const r=await t.service.answerAll(a.attempt_id,{'1':'one','2':'two'});expect(r.status).toBe('submitted');
 expect(t.sends.slice(before).map(s=>s.cmd)).toEqual(['restart','nextPage','restart','finish']);expect(t.saved).toEqual({'1':'one','2':'two'});
 expect(t.sends[before]!.entries).not.toContainEqual(['QuestionAnswer[2][value]','two']);
 }finally{t.done();}
});
test('all answers validated before sending, no missing/unknown questions allowed',async()=>{
 const t=setup();try{const a=await t.service.begin('00x_000001',content);const n=t.sends.length;
 for(const answers of [{'1':'one'},{'1':'one','2':'two','3':'extra'},{'1':42,'2':'two'}])await expect(t.service.answerAll(a.attempt_id,answers)).rejects.toThrow();expect(t.sends.length).toBe(n);
 }finally{t.done();}
});
test('batch interruption is persisted and cannot replay earlier answers',async()=>{
 const t=setup();try{const a=await t.service.begin('00x_000001',content);t.lose();await expect(t.service.answerAll(a.attempt_id,{'1':'one','2':'two'})).rejects.toMatchObject({code:'OPERATION_UNCERTAIN'});
 const n=t.sends.length;await expect(t.service.answerAll(a.attempt_id,{'1':'one','2':'two'})).rejects.toThrow();expect(t.sends.length).toBe(n);
 }finally{t.done();}
});

test('submit delay happens once, after all answers and before finish',async()=>{
 const waits:number[]=[];const t=setup({sleep:async ms=>{waits.push(ms);expect(t.sends.at(-1)!.cmd).toBe('restart');expect(t.saved).toEqual({'1':'one','2':'two'});}});
 try{const a=await t.service.begin('00x_000001',content);await t.service.answerAll(a.attempt_id,{'1':'one','2':'two'},12);expect(waits).toEqual([12000]);expect(t.sends.at(-1)!.cmd).toBe('finish');}finally{t.done();}
});
test('invalid submit delay is rejected before any answer is sent',async()=>{
 const t=setup();try{const a=await t.service.begin('00x_000001',content);const n=t.sends.length;for(const d of [-1,NaN,Infinity,86401])await expect(t.service.answerAll(a.attempt_id,{'1':'one','2':'two'},d)).rejects.toThrow();expect(t.sends.length).toBe(n);}finally{t.done();}
});

test('begin resumes from page 2 by rewinding before collecting all questions',async()=>{
 const t=setup({initialPage:2});try{const a=await t.service.begin('00x_000001',content);expect(a.questions?.map(q=>q.id)).toEqual(['1','2']);expect(a.page).toBe(1);}finally{t.done();}
});
