import {randomUUID} from 'node:crypto';
import {join,basename} from 'node:path';
import {parse} from 'node-html-parser';
import {stateDir} from './config.ts';
import {fetchCourseList} from './commands.ts';
import {CliError,ExitCode,OperationUncertainError,UsageError,ParseError} from './errors.ts';
import {type Page,WebClassClient} from './http.ts';
import {buildFormBody,type Answers} from './forms.ts';
import {parseAttempt,type AttemptPage} from './parsers/attempt.ts';
import {AttemptStore,type Attempt} from './attempt-store.ts';
export type Action='start'|'save'|'next'|'prev'|'submit';
export function publicAttempt(a:Attempt,includeCatalog=false){
  const {form,...page}:Partial<AttemptPage>=a.page??{questions:[]};
  return {attempt_id:a.id,course_id:a.courseId,content_id:a.contentId,status:a.status,updated_at:a.updatedAt,...page,questions:includeCatalog&&a.status!=='submitted'?a.catalog?.flatMap(p=>p.questions)??page.questions:page.questions,batch_state:a.batch,uploads:a.uploads??[]};
}
export class AttemptService {
  readonly store:AttemptStore;
  constructor(readonly client:WebClassClient,dir=join(stateDir(),'attempts'),private options:{sleep?:(ms:number)=>Promise<void>;progress?:(message:string)=>void}={}){this.store=new AttemptStore(dir);}
  show(id:string,all=true){return publicAttempt(this.store.read(id),all);}
  list(){return this.store.list().map(a=>publicAttempt(a));}
  async abandon(id:string){return this.store.locked(async()=>{const a=this.store.read(id);a.status='abandoned';this.store.write(a);return publicAttempt(a);});}
  private checked(id:string,internal=false){
    const a=this.store.read(id);
    if(a.base!==this.client.base.href||a.identity!==this.client.sessionFingerprint)throw new UsageError('The server or session differs from the one used for this attempt');
    if(!internal&&a.batch&&a.batch!=='done')throw new UsageError('The batch operation was interrupted. Check its status in WebClass');
    if(!['ready','active'].includes(a.status))throw new UsageError('This attempt cannot be submitted in its current state. Check its status in WebClass');
    return a;
  }
  async open(courseId:string,contentId:string){return this.store.locked(()=>this.openLocked(courseId,contentId));}
  private async openLocked(courseId:string,contentId:string){
    if(this.store.list().some(a=>!['submitted','abandoned'].includes(a.status)))throw new UsageError('An unfinished attempt exists. Check it with list/show, then continue or abandon it');
    const list=await fetchCourseList(this.client,{year:'all',semester:'all'});
    const entry=list.entryLinks.get(courseId);if(!entry)throw new UsageError('Course is not in the list');
    const course=await this.client.get(entry);
    const root=parse(course.body);
    const link=root.querySelectorAll('a[href]').find(el=>{
      try{const u=new URL(el.getAttribute('href')!,course.url);return u.pathname.endsWith('/do_contents.php')&&u.searchParams.get('set_contents_id')===contentId;}catch{return false;}
    });
    if(!link)throw new UsageError('Content is missing or unavailable');
    const a:Attempt={version:1,id:randomUUID(),base:this.client.base.href,identity:this.client.sessionFingerprint,courseId,contentId,status:'pending',url:new URL(link.getAttribute('href')!,course.url).href,updatedAt:''};
    this.store.write(a);
    return this.perform(a,()=>this.client.get(a.url));
  }
  async act(id:string,action:Action,answers:Answers={},delay=0){return this.store.locked(()=>this.actLocked(id,action,answers,false,delay));}
  private async actLocked(id:string,action:Action,answers:Answers={},internal=false,delay=0){
    validateDelay(delay);
    const a=this.checked(id,internal);const form=a.page?.form;if(!form)throw new UsageError('No form is available for submission');
    let body:URLSearchParams;
    if(action==='start'){
      if(a.status!=='ready')throw new UsageError('This attempt has already started');
      const next=form.buttons.find(b=>b.name==='next'&&b.value==='開始');if(!next)throw new ParseError('No start button found');
      body=new URLSearchParams(form.hidden);body.append(next.name,next.value);
    }else{
      if(a.status!=='active')throw new UsageError('Start the attempt with start');
      const command={save:'restart',next:'nextPage',prev:'prevPage',submit:'finish'}[action];
      body=buildFormBody(form,answers,command);
    }
    return this.perform(a,async()=>{if(action==='submit')await this.waitForSubmit(delay);return this.client.post(form.action,body);}, action, answers);
  }
  private async perform(a:Attempt,send:()=>Promise<Page>, action?:Action, answers:Answers={}){
    a.status='pending';this.store.write(a);
    try{
      const page=await send();
      const ids=[page.url.searchParams.get('set_contents_id')];
      for(const config of parse(page.body).querySelectorAll('script.js-config[type="application/json"]')) {
        const data=JSON.parse(config.text);if(data.contents_id)ids.push(String(data.contents_id));
      }
      if(ids.some(id=>id&&id!==a.contentId))throw new ParseError('Received a response for different content');
      const parsed=parseAttempt(page.body,page.url);
      if(action==='submit'&&parsed.kind!=='result'||action==='start'&&parsed.kind!=='questions')throw new ParseError('Could not verify the page after the operation');
      if(action==='save'){
        if(parsed.kind!=='questions')throw new ParseError('Could not verify the question page after saving');
        for(const [name,value] of Object.entries(answers)){
          const field=parsed.form?.fields.find(f=>f.name===name);const values=Array.isArray(value)?value:[value];
          if(!field||JSON.stringify([...field.values].sort())!==JSON.stringify([...values].sort()))throw new ParseError('Could not verify that the saved answers match');
        }
      }
      if(a.catalog&&parsed.kind==='questions'){const i=a.catalog.findIndex(p=>p.page===parsed.page);if(i>=0)a.catalog[i]=parsed;}
      a.url=page.url.href;a.page=parsed;a.status=parsed.kind==='start'?'ready':parsed.kind==='result'?'submitted':'active';this.store.write(a);
      return publicAttempt(a);
    }catch(e){a.status='uncertain';this.store.write(a);throw e instanceof OperationUncertainError?e:new OperationUncertainError();}
  }
  private async waitForSubmit(seconds:number){
    if(seconds>0){this.options.progress?.(`Answers saved. Waiting ${seconds} seconds before submission.`);await (this.options.sleep??Bun.sleep)(seconds*1000);}
  }
  async begin(courseId:string,contentId:string){return this.store.locked(async()=>{
    let view=await this.openLocked(courseId,contentId);
    if(view.status==='ready')view=await this.actLocked(view.attempt_id,'start');
    let a=this.checked(view.attempt_id);
    if(a.page?.branching)throw new UsageError('Branching content cannot be fetched in a batch. Proceed individually with next/save');
    a.batch='collecting';a.catalog=[];this.store.write(a);
    try{
      const previousPages=new Set<number>();
      while(this.store.read(a.id).page?.navigation?.previous){
        const page=this.store.read(a.id).page!;
        if(previousPages.has(page.page!)||previousPages.size>=100)throw new ParseError('Could not return to the first page');
        previousPages.add(page.page!);await this.actLocked(a.id,'prev',{},true);
      }
      const seen=new Set<string>();
      while(true){
        a=this.store.read(a.id);const page=a.page;
        if(page?.kind!=='questions'||page.branching)throw new ParseError('This question page cannot be fetched in a batch');
        const key=String(page.page);if(seen.has(key)||seen.size>=100)throw new ParseError('Could not verify question page navigation');seen.add(key);
        const ids=new Set(a.catalog!.flatMap(p=>p.questions.map(q=>q.id)));
        if(page.questions.some(q=>ids.has(q.id)))throw new ParseError('Question IDs are duplicated across pages');
        a.catalog!.push(page);this.store.write(a);
        if(!page.navigation?.next)break;
        await this.actLocked(a.id,'next',{},true);
      }
      for(let i=a.catalog!.length-1;i>0;i--){
        if(!this.store.read(a.id).page?.navigation?.previous)throw new ParseError('This content does not allow returning to the first page');
        await this.actLocked(a.id,'prev',{},true);
      }
      a=this.store.read(a.id);
      if(a.page?.page!==a.catalog![0]!.page)throw new ParseError('Could not verify the first page');
      a.batch='done';this.store.write(a);return publicAttempt(a,true);
    }catch{a=this.store.read(a.id);a.status='uncertain';this.store.write(a);throw new OperationUncertainError();}
  });}
  async answerAll(id:string,input:Record<string,unknown>,delay=0){return this.store.locked(async()=>{
    validateDelay(delay);let a=this.checked(id);
    if(a.status!=='active'||!a.page?.form)throw new UsageError('Fetch the question list with begin');
    if(!input||typeof input!=='object'||Array.isArray(input))throw new UsageError('Answers must be a JSON object keyed by question ID');
    const pages=a.catalog??[a.page];
    if(!a.catalog&&a.page.navigation?.next)throw new UsageError('Use begin to fetch all questions in content with multiple pages');
    if(a.page.branching||a.page.page!==pages[0]!.page)throw new UsageError('Submit batch answers from the first page of non-branching content');
    const questions=pages.flatMap(p=>p.questions);
    if(Object.keys(input).length!==questions.length||questions.some(q=>!Object.hasOwn(input,q.id)))throw new UsageError('Provide every question ID and answer (questions are missing or extra)');
    const all:Record<string,Answers>={};
    for(const q of questions){
      if(q.fields.some(f=>f.type==='file'))throw new UsageError('Use report file for file submissions');
      const value=input[q.id];let values:unknown[];
      if(q.fields.length===1)values=[value];
      else if(Array.isArray(value)&&value.length===q.fields.length)values=value;
      else throw new UsageError(`For question ${q.id}, provide an array of ${q.fields.length} values in answer field order`);
      const mapped:Answers={};q.fields.forEach((f,i)=>{mapped[f.name]=values[i] as string|string[];});all[q.id]=mapped;
    }
    // Validate the entire answer set before the first network operation.
    for(const page of pages)buildFormBody(page.form!,Object.assign({},...page.questions.map(q=>all[q.id])),'finish');
    a.batch='answering';this.store.write(a);
    try{
      for(let i=0;i<pages.length;i++){
        const expected=pages[i]!;const current=this.store.read(id).page;
        if(!current||current.page!==expected.page||JSON.stringify(current.questions.map(q=>q.id))!==JSON.stringify(expected.questions.map(q=>q.id)))throw new ParseError('The question order has changed');
        for(const q of expected.questions){
          this.options.progress?.(`Saving the answer to question ${q.id}.`);
          await this.actLocked(id,'save',all[q.id],true);
        }
        if(i<pages.length-1){
          if(!this.store.read(id).page?.navigation?.next)throw new ParseError('No next page available');
          await this.actLocked(id,'next',{},true);
        }
      }
      a=this.store.read(id);a.batch='waiting';this.store.write(a);
      await this.actLocked(id,'submit',{},true,delay);
      a=this.store.read(id);a.batch='done';this.store.write(a);return publicAttempt(a);
    }catch{a=this.store.read(id);a.status='uncertain';this.store.write(a);throw new OperationUncertainError();}
  });}
  async upload(id:string,question:string,path:string){return this.store.locked(async()=>{
    const a=this.checked(id);if(a.status!=='active')throw new UsageError('Start the attempt first');
    const field=a.page?.questions.find(q=>q.id===question)?.fields.find(f=>f.type==='file');
    if(!field)throw new UsageError('The specified question has no file upload field');
    const file=Bun.file(path);if(!await file.exists())throw new UsageError('File not found');
    const name=basename(path);const size=file.size;
    if(!size||field.maxBytes!==null&&size>field.maxBytes)throw new UsageError('File size does not meet the submission limits');
    const ext=name.split('.').pop()?.toLowerCase()??'';
    const types:Record<string,string>={doc:'Word',docx:'Word',docm:'Word',xls:'Excel',xlsx:'Excel',xlsm:'Excel',ppt:'PowerPoint',pptx:'PowerPoint',pptm:'PowerPoint',pdf:'PDF',txt:'Text'};
    if(field.allowedTypes.length&&!field.allowedTypes.includes(types[ext]??''))throw new UsageError('File type is not allowed');
    if(['doc','docx','xls','xlsx','ppt','pptx'].includes(ext)&&size<1000)throw new UsageError('Office file is too small');
    const data=new FormData();data.append('set_contents_id',a.contentId);data.append('question_no',question);data.append('upload_file',file,name);
    const url=new URL('mbl.php/questions/api',this.client.base);url.searchParams.set('api','upload');url.searchParams.set('set_contents_id',a.contentId);
    a.status='pending';this.store.write(a);
    try{
      const response=await this.client.post(url,data);const receipt=JSON.parse(response.body);
      if(receipt.status!=='OK'||typeof receipt.file?.name!=='string')throw new ParseError('Could not verify file receipt');
      a.uploads=[...(a.uploads??[]).filter(f=>f.question!==question),{question,name:receipt.file.name}];a.status='active';this.store.write(a);return publicAttempt(a);
    }catch{a.status='uncertain';this.store.write(a);throw new OperationUncertainError();}
  });}
}

export function validateDelay(seconds:number):void {
  if(!Number.isFinite(seconds)||seconds<0||seconds>86400)throw new UsageError('Submission delay must be between 0 and 86400 seconds');
}
