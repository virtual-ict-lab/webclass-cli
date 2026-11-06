import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {AttemptService} from '../src/attempts.ts';
import {MaterialService} from '../src/materials.ts';
import {WebClassClient,type FetchLike} from '../src/http.ts';
import {parseAttempt} from '../src/parsers/attempt.ts';
import {BASE,fixture,html,redirect} from './helpers.ts';
const content='d000000000000000000000000000000e';
const field='QuestionAnswer[1][text]';
const url=new URL('mbl.php/questions/',BASE);
const report=(value:string,other='unchanged')=>`<form name="QuestionForm" method="post"><input type="hidden" name="QstnSession[s]" value="1"><textarea name="${field}">\n${value}</textarea><textarea name="QuestionAnswer[2][text]">\n${other}</textarea></form>`;
const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
function setup(fetch:FetchLike,options:{sleep?:(ms:number)=>Promise<void>;access?:'learning'|'materials'}={}){
  const dir=mkdtempSync(tmpdir()+'/wc-boundary-');
  const client=new WebClassClient({baseUrl:BASE,cookies:{WBT_Session:'synthetic-boundary'},access:options.access??'learning',fetch,sleep:async()=>{}});
  const service=new AttemptService(client,dir,options);
  const seed=(body=report('initial'))=>{
    const id=randomUUID();service.store.write({version:1,id,base:BASE,identity:client.sessionFingerprint,courseId:'00x_000001',contentId:content,status:'active',url:url.href,page:parseAttempt(body,url),updatedAt:''});return id;
  };
  return {dir,client,service,seed,done:()=>rmSync(dir,{recursive:true,force:true})};
}

test('textarea round trips keep values and compare normalized newlines without losing intentional leading LF',async()=>{
  const sent:URLSearchParams[]=[];
  const t=setup(async(_url,init)=>{
    const data=new URLSearchParams(String(init.body));sent.push(data);
    return html(report(escape(data.get(field)!.replace(/\r\n?/g,'\n')),escape(data.get('QuestionAnswer[2][text]')!)));
  });
  try{
    const id=t.seed(report('initial','line1\r\nA&amp;B'));
    const answer='\nline1\r\nA&B\rline3';
    for(let i=0;i<3;i++)expect((await t.service.act(id,'save',{[field]:answer})).status).toBe('active');
    expect(t.service.show(id).questions?.[0]?.fields[0]?.values).toEqual(['\nline1\nA&B\nline3']);
    expect(sent.map(s=>s.get('QuestionAnswer[2][text]'))).toEqual(Array(3).fill('line1\nA&B'));
  }finally{t.done();}
});
test('textarea markup remains literal in the full attempt parser',()=>{
  const page=parseAttempt(report('<b>literal</b><!-- comment -->&amp;lt;'),url);
  expect(page.questions[0]?.fields[0]?.values).toEqual(['<b>literal</b><!-- comment -->&lt;']);
});
test('a real textarea mismatch after saving still blocks replay',async()=>{
  const t=setup(async()=>html(report('different')));try{
    const id=t.seed();await expect(t.service.act(id,'save',{[field]:'intended'})).rejects.toMatchObject({code:'OPERATION_UNCERTAIN'});
    expect(t.service.show(id).status).toBe('uncertain');expect(t.client.mutationCount).toBe(1);
  }finally{t.done();}
});
test('blocked form action preserves an active attempt without sending',async()=>{
  const t=setup(async()=>{throw new Error('unexpected fetch');});try{
    const id=t.seed();const a=t.service.store.read(id);a.page!.form!.action='https://outside.example.test/write';t.service.store.write(a);
    await expect(t.service.act(id,'save')).rejects.toMatchObject({code:'BLOCKED_URL'});
    expect(t.service.show(id).status).toBe('active');expect(t.client.requestCount).toBe(0);
  }finally{t.done();}
});
test('a cancelled submit wait preserves the last confirmed state and error',async()=>{
  const stopped=new Error('wait cancelled');const t=setup(async()=>html(report('initial')),{sleep:async()=>{throw stopped;}});
  try{
    const id=t.seed();await expect(t.service.act(id,'submit',{},1)).rejects.toBe(stopped);
    expect(t.service.show(id).status).toBe('active');expect(t.client.requestCount).toBe(0);
  }finally{t.done();}
});
test('an unsent blocked open does not leave an uncertain attempt behind',async()=>{
  const t=setup(async(target)=>new URL(target).pathname.endsWith('index.php')?html(fixture('index.html')):html(`<a href="https://outside.example.test/do_contents.php?set_contents_id=${content}">Open</a>`));
  try{
    await expect(t.service.open('00x_000001',content)).rejects.toMatchObject({code:'BLOCKED_URL'});
    expect(t.service.list()).toEqual([]);expect(t.client.mutationCount).toBe(0);
  }finally{t.done();}
});
for(const mode of ['learning','materials'] as const)test(`${mode} discovery reports expired sessions without creating an attempt`,async()=>{
  const t=setup(async()=>html(fixture('pagejump-expired.html')),{access:mode});try{
    const operation=mode==='learning'?t.service.open('00x_000001',content):new MaterialService(t.client,t.dir).list('00x_000001');
    await expect(operation).rejects.toMatchObject({code:'SESSION_EXPIRED',exitCode:3});
    expect(t.service.list()).toEqual([]);expect(t.client.mutationCount).toBe(0);
  }finally{t.done();}
});
for(const mode of ['learning','materials'] as const)test(`${mode} discovery redirected through a mutating GET preserves uncertainty during parsing`,async()=>{
  const t=setup(async(target)=>new URL(target).pathname.endsWith('index.php')?redirect('/webclass/do_contents.php'):html('<p>unexpected response</p>'),{access:mode});
  try{
    const operation=mode==='learning'?t.service.open('00x_000001',content):new MaterialService(t.client,t.dir).list('00x_000001');
    await expect(operation).rejects.toMatchObject({code:'OPERATION_UNCERTAIN',exitCode:7});
    expect(t.client.mutationCount).toBe(1);
  }finally{t.done();}
});

test('unsupported batch traversal keeps its confirmed page available for manual work',async()=>{
  let current=1;const sent:string[]=[];
  const page=()=>`<form name="QuestionForm" method="post" action="${url.href}"><input type="hidden" name="QstnSession[s]" value="1"><input type="hidden" name="QstnSession[page]" value="${current}"><input name="QuestionAnswer[${current}][value]" value="">${current===1?'<a href="javascript:QuestionClient.nextPage()">Next</a>':''}</form>`;
  const t=setup(async(target,init)=>{
    if(new URL(target).pathname.endsWith('index.php'))return html(fixture('index.html'));
    if(target.includes('course.php'))return html(`<a href="/webclass/do_contents.php?set_contents_id=${content}">Open</a>`);
    if(init.method==='POST'){const command=new URLSearchParams(String(init.body)).get('QstnSession[cmd]')!;sent.push(command);if(command==='nextPage')current=2;}
    return html(page());
  });
  try{
    await expect(t.service.begin('00x_000001',content)).rejects.toMatchObject({code:'PARSE_ERROR'});
    const a=t.service.list()[0]!;expect(a.status).toBe('active');expect(a.page).toBe(2);expect(a.batch_state).toBeUndefined();
    expect(t.service.store.read(a.attempt_id).catalog).toBeUndefined();
    const before=t.client.requestCount;
    await expect(t.service.answerAll(a.attempt_id,{'2':'two'})).rejects.toMatchObject({code:'USAGE'});
    expect(t.client.requestCount).toBe(before);
    expect((await t.service.act(a.attempt_id,'save')).status).toBe('active');expect(sent).toEqual(['nextPage','restart']);
  }finally{t.done();}
});
test('a batch cancelled before final submission retains saved answers and permits manual submit',async()=>{
  const stopped=new Error('wait cancelled');const t=setup(async(_url,init)=>{
    const data=new URLSearchParams(String(init.body));return html(report(escape(data.get(field)!),escape(data.get('QuestionAnswer[2][text]')!)));
  },{sleep:async()=>{throw stopped;}});
  try{
    const id=t.seed();await expect(t.service.answerAll(id,{'1':'one','2':'two'},1)).rejects.toBe(stopped);
    expect(t.service.show(id).status).toBe('active');expect(t.service.show(id).batch_state).toBeUndefined();
    expect(t.service.show(id).questions?.map(q=>q.fields[0]!.values)).toEqual([['one'],['two']]);
    expect(t.client.mutationCount).toBe(2);
  }finally{t.done();}
});
