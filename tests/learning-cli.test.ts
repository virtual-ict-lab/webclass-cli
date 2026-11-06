import {expect,test} from 'bun:test';
import {runInteractive} from '../src/learning-cli.ts';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebClassClient} from '../src/http.ts';
import {AttemptService} from '../src/attempts.ts';
import {parseAttempt} from '../src/parsers/attempt.ts';
import {randomUUID} from 'node:crypto';
const synthetic=`<h2 class="wcl_pageMainTitle">Mock report</h2><form name="QuestionForm" method="post"><input type="hidden" name="QstnSession[s]" value="1"><input type="hidden" name="QstnSession[cmd]" value=""><fieldset class="textStyle"><textarea name="QuestionAnswer[1][text]" data-max-length="20">old</textarea></fieldset><fieldset class="reportStyle" data-qnum="2" data-size-limit="1000" data-type-limit="Text"><input type="file" name="QuestionAnswer[2][file]"></fieldset></form>`;
test('report text and multipart file through actual local HTTP server',async()=>{
 const dir=mkdtempSync(tmpdir()+'/wc-report-');const received:{type:string,fields:[string,string][]}[]=[];
 const server=Bun.serve({port:0,fetch:async req=>{const form=await req.formData();received.push({type:req.headers.get('content-type')!,fields:await Promise.all([...form].map(async([k,v])=>[k,typeof v==='string'?v:await v.text()] as [string,string]))});
 if(new URL(req.url).pathname.endsWith('/api'))return Response.json({status:'OK',file:{name:'report.txt'}});
 return new Response(synthetic.replace('>old</textarea>','>'+String(form.get('QuestionAnswer[1][text]')??'old')+'</textarea>'),{headers:{'content-type':'text/html'}});}});
 try{const base=`http://localhost:${server.port}/webclass/`;const client=new WebClassClient({baseUrl:base,cookies:{WBT_Session:'local'},access:'learning',sleep:async()=>{}});const service=new AttemptService(client,dir);const id=randomUUID();
 service.store.write({version:1,id,base,identity:client.sessionFingerprint,courseId:'c',contentId:'x',status:'active',url:base+'mbl.php/questions/',page:parseAttempt(synthetic,new URL(base+'mbl.php/questions/')),updatedAt:''});
 await service.act(id,'save',{'QuestionAnswer[1][text]':'Hello\nworld'});
 await Bun.write(join(dir,'report.txt'),'report content');await service.upload(id,'2',join(dir,'report.txt'));
 expect(received[0]!.fields).toContainEqual(['QuestionAnswer[1][text]','Hello\nworld']);expect(received[1]!.type).toContain('multipart/form-data; boundary=');expect(received[1]!.fields).toContainEqual(['upload_file','report content']);expect(service.show(id).uploads).toEqual([{question:'2',name:'report.txt'}]);
 const n=received.length;await Bun.write(join(dir,'bad.pdf'),'bad');await expect(service.upload(id,'2',join(dir,'bad.pdf'))).rejects.toThrow();expect(received.length).toBe(n);
 }finally{server.stop(true);rmSync(dir,{recursive:true,force:true});}
});
test('interactive start, answer review, then submit confirmation',async()=>{
 const events:string[]=[];const answers=['yes','100','submit','yes'];const question={attempt_id:'id',status:'active',title:'Q',uploads:[],questions:[{id:'1',text:'Convert 4 to binary',images:[],fields:[{name:'answer',label:'answer',type:'text',values:[],options:[]}]}]};
 const service={open:async()=>{events.push('open');return {...question,status:'ready',questions:[]};},act:async(_id:string,action:string,data?:unknown)=>{events.push(action);if(action==='submit'){expect(data).toEqual({answer:'100'});return {...question,status:'submitted',score:1,total:1};}return question;}};
 const result=await runInteractive(service as never,'course','content',{ask:async()=>answers.shift()!,write:()=>{}});expect(result.status).toBe('submitted');expect(events).toEqual(['open','start','submit']);
});
test('CLI mutation requires explicit yes before authentication or network',async()=>{
 const p=Bun.spawn(['bun','src/cli.ts','quiz','submit','some-id'],{env:{...process.env,WEBCLASS_COOKIE:''},stdout:'pipe',stderr:'pipe'});const err=await new Response(p.stderr).text();expect(await p.exited).toBe(2);expect(err).toContain('--yes');
});
test('agent CLI accepts question-number JSON, saves then submits with paced requests',async()=>{
 const dir=mkdtempSync(tmpdir()+'/wc-agent-cli-');let saved='';const times:number[]=[];const commands:string[]=[];
 const single=(value:string)=>`<h2 class="wcl_pageMainTitle">Mock</h2><form name="QuestionForm" method="post"><input type="hidden" name="QstnSession[s]" value="1"><input type="hidden" name="QstnSession[cmd]" value=""><div class="content">Question<input name="QuestionAnswer[1][value]" value="${value}"></div></form>`;
 const server=Bun.serve({port:0,fetch:()=>new Response('initializing')});
 server.reload({fetch:async req=>{
  if(req.method==='GET')return new Response(`<div data-role="header"><h1>結果</h1></div><h2 class="wcl_pageMainTitle">Mock</h2><h3>◇得点 1/1</h3>`);
  const data=await req.formData();times.push(Date.now());const cmd=String(data.get('QstnSession[cmd]'));commands.push(cmd);saved=String(data.get('QuestionAnswer[1][value]'));
  return cmd==='finish'?Response.redirect(`http://localhost:${server.port}/webclass/mbl.php/question_results`,303):new Response(single(saved));
 }});
 try{const base=`http://localhost:${server.port}/webclass/`;const client=new WebClassClient({baseUrl:base,cookies:{WBT_Session:'local'},access:'learning'});const service=new AttemptService(client,join(dir,'webclass','attempts'));const id=randomUUID();
 service.store.write({version:1,id,base,identity:client.sessionFingerprint,courseId:'c',contentId:'x',status:'active',url:base+'mbl.php/questions/',page:parseAttempt(single(''),new URL(base+'mbl.php/questions/')),updatedAt:''});
 const p=Bun.spawn(['bun','src/cli.ts','quiz','answer',id,'--answers','-','--yes','--submit-delay','0.05'],{env:{...process.env,XDG_STATE_HOME:dir,WEBCLASS_BASE_URL:base,WEBCLASS_COOKIE:'WBT_Session=local'},stdin:'pipe',stdout:'pipe',stderr:'pipe'});p.stdin.write('{"1":"A"}');p.stdin.end();
 const output=await new Response(p.stdout).text();const error=await new Response(p.stderr).text();expect(await p.exited).toBe(0);expect(JSON.parse(output).status).toBe('submitted');expect(commands).toEqual(['restart','finish']);expect(saved).toBe('A');expect(times[1]!-times[0]!).toBeGreaterThanOrEqual(2000);expect(error).toContain('0.05 seconds');
 }finally{server.stop(true);rmSync(dir,{recursive:true,force:true});}
},15000);
