import {parseArgs} from 'node:util';
import {createInterface} from 'node:readline/promises';
import {join} from 'node:path';
import {makeClient,fetchCourseList,course} from './commands.ts';
import {AttemptService,publicAttempt,validateDelay,type Action} from './attempts.ts';
import {AttemptStore} from './attempt-store.ts';
import {stateDir} from './config.ts';
import {UsageError} from './errors.ts';
import type {Answers} from './forms.ts';
type View=ReturnType<typeof publicAttempt>;
export interface PromptIO {ask:(prompt:string)=>Promise<string>;write:(text:string)=>void;}
const yes=(s:string)=>/^(y|yes|はい)$/i.test(s.trim());
const safe=(s:string)=>s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,'');
export function formatAttempt(a:View):string {
  const lines=[`${a.title??'Content'} — ${a.status}`,`Attempt ID: ${a.attempt_id}`];
  if(a.remaining_seconds!==undefined&&a.remaining_seconds>=0)lines.push(`Time remaining when fetched: ${a.remaining_seconds} seconds`);
  for(const q of a.questions??[]){lines.push(`\nQuestion ${q.id}\n${q.text}`);for(const image of q.images)lines.push(`[Image] ${image.alt} ${image.url}`);
    for(const f of q.fields){lines.push(`  ${f.name}: ${f.values.join(', ')}`);for(const o of f.options)lines.push(`    ${o.value}: ${o.label}`);}}
  if(a.summary)lines.push(a.summary);
  for(const f of a.uploads)lines.push(`Received: question ${f.question} / ${f.name}`);
  return safe(lines.join('\n'));
}
export async function runInteractive(service:AttemptService,courseId:string,contentId:string,io:PromptIO,options:{attemptId?:string;submitDelay?:number}={}):Promise<View>{
  let current:View;
  if(options.attemptId)current=service.show(options.attemptId,false);
  else {
    if(!yes(await io.ask('Open this content and start an attempt? [yes/no] ')))throw new UsageError('Start cancelled');
    current=await service.open(courseId,contentId);
  }
  if(current.status==='ready')current=await service.act(current.attempt_id,'start');
  while(current.status==='active'){
    io.write(formatAttempt(current));const answers:Answers={};
    for(const q of current.questions??[])for(const f of q.fields){
      if(f.type==='file'){
        const path=(await io.ask(`Question ${q.id} upload file (leave blank to skip): `)).trim();
        if(path&&yes(await io.ask(`Upload ${safe(path)}? [yes/no] `)))current=await service.upload(current.attempt_id,q.id,path);
        continue;
      }
      const value=await io.ask(`${f.label} (leave blank to keep the current value${f.type==='textarea'?', @filename to load text':''}${['checkbox','multiselect'].includes(f.type)?', comma-separated values for multiple selections, - to clear':''}): `);
      if(value)answers[f.name]=['checkbox','multiselect'].includes(f.type)?value==='-'?[]:value.split(',').map(v=>v.trim()):f.type==='textarea'&&value.startsWith('@')?await readFile(value.slice(1)):value;
    }
    io.write('Changes to send:\n'+safe(JSON.stringify(answers,null,2)));
    const action=(await io.ask('save / next / prev / submit (finish and grade) / quit: ')).trim();
    if(action==='quit')return current;
    if(!['save','next','prev','submit'].includes(action)){io.write('Choose an action');continue;}
    if(action==='submit'&&!yes(await io.ask('Submit the displayed answers and finish? [yes/no] ')))continue;
    try{current=await service.act(current.attempt_id,action as Action,answers,options.submitDelay??0);}catch(e){
      if(e instanceof UsageError){io.write(e.message);continue;}throw e;
    }
  }
  io.write(formatAttempt(current));return current;
}
async function readFile(path:string){try{return await Bun.file(path).text();}catch{throw new UsageError('Cannot read the input file');}}
async function readAnswers(path:string|undefined):Promise<Answers>{
  if(!path)return {};
  const raw=path==='-'?await new Response(Bun.stdin.stream()).text():await readFile(path);
  try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))throw 0;return value;}catch{throw new UsageError('The answers file must contain a JSON object');}
}
const HELP=`Learning operations:
  webclass quiz begin <course-id> <content-id> --yes  Start and retrieve all questions
  webclass quiz answer <attempt-id> --answers answers.json --yes [--submit-delay seconds]
  webclass quiz resume <attempt-id>             Resume interactive input
  webclass quiz run [course-id content-id]       Select, answer, and submit interactively
  webclass quiz open <course-id> <content-id> --yes
  webclass quiz start <attempt-id> --yes
  webclass quiz show <attempt-id> [--human]      Show cached state (no server request)
  webclass quiz save|next|prev <attempt-id> [--answers fields.json]
  webclass quiz submit <attempt-id> [--answers fields.json] --yes
  webclass quiz list                           List local attempts
  webclass quiz abandon <attempt-id> --yes      End local tracking only

  webclass report run [course-id content-id]    Submit text and files interactively
  webclass report open|start|show|save|submit|list|abandon ...
  webclass report text <attempt-id> --question N --text-file report.txt
  webclass report file <attempt-id> --question N --file report.pdf --yes

Batch answer JSON: {"1":"answer1","2":"answer2"} (arrays for multiple fields).
Saves and navigation requests are spaced 2-3 seconds apart.
--submit-delay seconds adds a wait after saving all answers and before submission (alias: --delay, range: 0-86400).
--answers - reads stdin; --pretty formats JSON; --human shows readable text.
Exit code 7 means the result is uncertain. Check WebClass before further action; do not automatically resend.
`;
export async function learningCommand(kind:string,args:string[]):Promise<{json:unknown;human:()=>string}|null>{
  const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{yes:{type:'boolean'},human:{type:'boolean'},pretty:{type:'boolean'},help:{type:'boolean',short:'h'},answers:{type:'string'},file:{type:'string'},'text-file':{type:'string'},question:{type:'string'},'submit-delay':{type:'string'},delay:{type:'string'}}});
  if(values.help||!positionals.length){console.log(HELP);return null;}
  const [action,id,content]=positionals;
  if(values.delay!==undefined&&values['submit-delay']!==undefined)throw new UsageError('Specify only one of --delay and --submit-delay');
  const delay=Number(values['submit-delay']??values.delay??0);validateDelay(delay);
  if((values.delay!==undefined||values['submit-delay']!==undefined)&&!['answer','submit','run','resume'].includes(action!))throw new UsageError('Submission delay is supported by answer, submit, run, and resume');
  if(!['begin','answer','resume','run','open','start','show','save','next','prev','submit','list','abandon','text','file'].includes(action!))throw new UsageError('Unknown learning action (see quiz --help)');
  if(kind!=='report'&&['text','file'].includes(action!))throw new UsageError('Use the report command for this action');
  if(['begin','answer','open','start','submit','file','abandon'].includes(action!)&&!values.yes)throw new UsageError('This action requires --yes');
  if(!['run','list'].includes(action!)&&!id)throw new UsageError('Provide an ID');
  const store=new AttemptStore(join(stateDir(),'attempts'));
  if(action==='show'){const r=publicAttempt(store.read(id!),true);return {json:r,human:()=>formatAttempt(r)};}
  if(action==='list'){const r=store.list().map(a=>publicAttempt(a));return {json:r,human:()=>r.map(formatAttempt).join('\n\n')};}
  if(action==='abandon'){const r=await store.locked(async()=>{const a=store.read(id!);a.status='abandoned';store.write(a);return publicAttempt(a);});return {json:r,human:()=>formatAttempt(r)};}
  if(['run','resume'].includes(action!)&&(!process.stdin.isTTY||!process.stderr.isTTY))throw new UsageError('run and resume require an interactive terminal. Use begin/answer or open/start/save/submit for automation');
  const service=new AttemptService(makeClient(process.env,{access:'learning'}),undefined,{progress:message=>console.error(message)});let r:View;
  if(action==='run'||action==='resume'){
    const rl=createInterface({input:process.stdin,output:process.stderr});
    const io:PromptIO={ask:q=>rl.question(safe(q)),write:s=>console.error(safe(s))};
    try{
      let cid=id;let ctid=content;
      if(action!=='resume'&&!cid){const list=await fetchCourseList(service.client);list.courses.forEach((c,i)=>io.write(`${i+1}. ${c.name}`));const index=Number(await io.ask('Course number: '))-1;cid=list.courses[index]?.id;if(!cid)throw new UsageError('Invalid course number');}
      if(action!=='resume'&&!ctid){const c=await course(service.client,cid!);const choices=c.folders.flatMap(f=>f.contents).filter(c=>c.openable&&/自習|テスト|レポート|アンケート/.test(c.category??''));choices.forEach((c,i)=>io.write(`${i+1}. ${c.name} [${c.category}]`));ctid=choices[Number(await io.ask('Content number: '))-1]?.id;if(!ctid)throw new UsageError('Invalid content number');}
      r=await runInteractive(service,cid??'',ctid??'',io,{attemptId:action==='resume'?id:undefined,submitDelay:delay});
    }finally{rl.close();}
  }else if(action==='begin'||action==='start'&&content){
    if(!content)throw new UsageError('Provide a course ID and content ID');r=await service.begin(id!,content);
  }else if(action==='answer'){
    if(!values.answers)throw new UsageError('Provide all answers as a JSON file with --answers');r=await service.answerAll(id!,await readAnswers(values.answers),delay);
  }else if(action==='open'){
    if(!content)throw new UsageError('Provide a course ID and content ID');r=await service.open(id!,content);
  }else if(action==='file'){
    if(!values.file||!values.question)throw new UsageError('--file and --question are required');r=await service.upload(id!,values.question,values.file);
  }else if(action==='text'){
    if(!values['text-file']||!values.question)throw new UsageError('--text-file and --question are required');
    const fields=service.show(id!).questions?.find(q=>q.id===values.question)?.fields.filter(f=>f.type==='textarea');
    if(fields?.length!==1)throw new UsageError('Cannot identify a single text submission field');r=await service.act(id!,'save',{[fields[0]!.name]:await readFile(values['text-file'])});
  }else r=await service.act(id!,action as Action,await readAnswers(values.answers),delay);
  return {json:r,human:()=>formatAttempt(r)};
}
