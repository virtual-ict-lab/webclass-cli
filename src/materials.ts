import {parse} from 'node-html-parser';
import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,linkSync,unlinkSync,lstatSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {WebClassClient,verifyPage,type Page} from './http.ts';
import {fetchCourseList} from './commands.ts';
import {parseCourse,type Content} from './parsers/course.ts';
import {parseForm} from './forms.ts';
import {AttemptStore} from './attempt-store.ts';
import {stateDir} from './config.ts';
import {CliError,ParseError,UsageError,redactUrl} from './errors.ts';
import {isLoggedInPage} from './detect.ts';
import {normalizePath} from './urlpolicy.ts';

const DOCUMENT=/\.(?:pdf|docx?|docm|xlsx?|xlsm|pptx?|pptm|txt|csv|zip|epub|mp4|mp3|wav|png|jpe?g|gif)$/i;
export function parseMaterialLinks(body:string,url:URL,baseUrl:URL){
  const root=parse(body);const form=root.querySelector('form[name="TextbookForm"]');
  const base=new URL(root.querySelector('base[href]')?.getAttribute('href')??url.href,url);
  const courseRoot=normalizePath(baseUrl.pathname).replace(/\/$/,'')+'/data/course/';
  const container=form??root;const links:{url:string;label:string}[]=[];
  for(const el of container.querySelectorAll('a[href],iframe[src],frame[src],embed[src],object[data],img[src],video[src],audio[src],source[src]')){
    const raw=el.getAttribute('href')??el.getAttribute('src')??el.getAttribute('data');if(!raw)continue;
    let target:URL;try{target=new URL(raw,base);}catch{continue;}
    if(!['https:','http:'].includes(target.protocol))continue;
    const wrapper=target.pathname.endsWith('/loadit.php');
    const path=normalizePath(target.pathname);const courseAsset=path.startsWith(courseRoot);
    if(wrapper||target.origin!==baseUrl.origin||courseAsset&&(DOCUMENT.test(path)||el.tagName==='A'&&el.hasAttribute('download'))){
      if(!links.some(l=>l.url===target.href))links.push({url:target.href,label:el.structuredText.trim()||basename(target.pathname)});
    }
  }
  // Prefer the frame containing the actual download link, not the JS PDF viewer.
  const provide=links.find(l=>new URL(l.url).searchParams.get('action')==='providePDF');
  const controls=root.querySelectorAll('a[href],button[onclick]').filter(e=>!e.classList.contains('ui-disabled')&&!e.hasAttribute('disabled'));
  const next=controls.some(e=>/TextbookClient\.nextPage\(\)/.test((e.getAttribute('href')??'')+(e.getAttribute('onclick')??'')));
  const previous=controls.some(e=>/TextbookClient\.prevPage\(\)/.test((e.getAttribute('href')??'')+(e.getAttribute('onclick')??'')));
  const copy=parse((form??root.querySelector('[data-role="content"]'))?.outerHTML??'');copy.querySelectorAll('script,style,input,button,iframe,frame,embed,object').forEach(e=>e.remove());
  return {links:provide?[provide]:links,next,previous,text:copy.structuredText.trim(),form:form?parseForm(form,url):undefined,title:root.querySelector('.wcl_pageMainTitle')?.text.trim()??''};
}
export function safeFilename(raw:string):string {
  let name=raw.replaceAll('\\','/').split('/').pop()!.replace(/[\x00-\x1f\x7f-\x9f:*?"<>|]/g,'_').replace(/^[. ]+|[. ]+$/g,'');
  if(!name)name='document';while(Buffer.byteLength(name)>180)name=name.slice(0,-1);return name;
}
interface SavedFile {path:string;bytes:number;sha256:string;status:'saved'|'existing';}
function saveFile(dir:string,name:string,bytes:Uint8Array):SavedFile {
  const sha256=createHash('sha256').update(bytes).digest('hex');const safe=safeFilename(name);let path=join(dir,safe);
  const temp=join(dir,`.download-${randomUUID()}.tmp`);writeFileSync(temp,bytes,{mode:0o600,flag:'wx'});
  try{
    for(let attempt=0;attempt<2;attempt++){
      try{linkSync(temp,path);return {path,bytes:bytes.length,sha256,status:'saved'};}
      catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;const stat=lstatSync(path);
        if(stat.isFile()&&!stat.isSymbolicLink()&&createHash('sha256').update(readFileSync(path)).digest('hex')===sha256)return {path,bytes:bytes.length,sha256,status:'existing'};
        const dot=safe.lastIndexOf('.');path=join(dir,dot>0?`${safe.slice(0,dot)}-${sha256.slice(0,12)}${safe.slice(dot)}`:`${safe}-${sha256.slice(0,12)}`);
      }
    }
    throw new UsageError('Destination file names conflict');
  }finally{unlinkSync(temp);}
}
function privateDir(path:string){mkdirSync(path,{recursive:true,mode:0o700});if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory())throw new UsageError('Destination must be a regular directory');}
interface MaterialResult {id:string;name:string;files:SavedFile[];links:{url:string;label:string}[];pages:number;}
export class MaterialService {
  readonly store:AttemptStore;
  constructor(readonly client:WebClassClient,dir=join(stateDir(),'attempts'),private options:{progress?:(message:string)=>void}={}){this.store=new AttemptStore(dir);}
  private async coursePage(id:string){
    const list=await fetchCourseList(this.client,{year:'all',semester:'all'});const entry=list.entryLinks.get(id);if(!entry)throw new UsageError('Course not found');
    const page=await this.client.get(entry);return verifyPage(page,()=>{
      const parsed=parseCourse(page.body);if(parsed.course.id!==id)throw new ParseError('Received a different course');return {page,parsed};
    });
  }
  async list(courseId:string){const {parsed}=await this.coursePage(courseId);return {course_id:courseId,materials:parsed.folders.flatMap(f=>f.contents).filter(c=>c.category==='資料')};}
  async download(courseId:string,options:{id?:string;all?:boolean;out:string}){return this.store.locked(async()=>{
    if(this.store.list().some(a=>!['submitted','abandoned'].includes(a.status)))throw new UsageError('A content attempt is in progress. Finish it or check its status before downloading materials');
    if(Boolean(options.id)===Boolean(options.all))throw new UsageError('Specify either a content ID or --all');
    const {page,parsed}=await this.coursePage(courseId);const materials=parsed.folders.flatMap(f=>f.contents).filter(c=>c.category==='資料');
    const selected=options.all?materials.filter(c=>c.openable):materials.filter(c=>c.id===options.id&&c.openable);
    if(options.id&&!selected.length)throw new UsageError('The selected content is not a downloadable material');
    const root=resolve(options.out);privateDir(root);const courseDir=join(root,safeFilename(courseId));privateDir(courseDir);
    const results:MaterialResult[]=[];
    for(const item of selected){
      this.options.progress?.(`Downloading material: ${item.name}`);
      // Re-enter the course before opening the next item when finishing a material exits the course.
      const current=results.length?(await this.coursePage(courseId)).page:page;
      const link=parse(current.body).querySelectorAll('a[href]').find(a=>{try{return new URL(a.getAttribute('href')!,current.url).searchParams.get('set_contents_id')===item.id;}catch{return false;}});
      if(!link)throw new ParseError('No material link found');
      try{results.push(await this.downloadOne(item,new URL(link.getAttribute('href')!,current.url),courseDir));}
      catch(e){throw new CliError(e instanceof CliError?e.code:'MATERIAL_DOWNLOAD_FAILED',e instanceof CliError?e.message:'Failed to download or save the material',e instanceof CliError?e.exitCode:1,{completed:results,failed_id:item.id});}
    }
    return {course_id:courseId,materials:results,skipped:options.all?materials.filter(c=>!c.openable).map(c=>({id:c.id,name:c.name,reason:'unavailable'})):[]};
  });}
  private async navigate<T>(send:()=>Promise<Page>,verify:(page:Page)=>T):Promise<T>{
    return verifyPage(await send(),verify);
  }
  private materialRoot(page:Page,item:Content){
    const root=parse(page.body);
    if(root.querySelector('form[name="QuestionForm"]'))throw new ParseError('Received a test instead of a material');
    const contentIds=[page.url.searchParams.get('set_contents_id')];
    for(const cfg of root.querySelectorAll('script.js-config[type="application/json"]')){
      const id=JSON.parse(cfg.text).contents_id;if(id)contentIds.push(String(id));
    }
    if(contentIds.some(id=>id&&id!==item.id))throw new ParseError('Received a response for different content');
    return root;
  }
  private materialPage(page:Page,item:Content){
    this.materialRoot(page,item);
    const material=parseMaterialLinks(page.body,page.url,this.client.base);const form=material.form;
    if(!form)throw new ParseError('Unrecognized material content form');
    if(!material.links.length&&!material.text)throw new ParseError('No recognizable material text or attachments found');
    return {material,form,key:createHash('sha256').update(page.body).digest('hex')};
  }
  private async downloadOne(item:Content,url:URL,parent:string):Promise<MaterialResult>{
    const dir=join(parent,safeFilename(`${item.id}-${item.name}`));privateDir(dir);
    const opened=await this.navigate(()=>this.client.get(url),page=>{
      const root=this.materialRoot(page,item);
      if(root.querySelector('form[name="TextbookForm"]'))return {kind:'content' as const,content:this.materialPage(page,item)};
      if(root.querySelector('[data-role="header"] h1')?.text.trim()!=='資料')throw new ParseError('Could not verify the material start page');
      const f=root.querySelector('form');if(!f)throw new ParseError('No material start form found');const form=parseForm(f,page.url);const button=form.buttons.find(b=>b.name==='next'&&b.value==='開始');if(!button)throw new ParseError('No start button found');
      const data=new URLSearchParams(form.hidden);data.append(button.name,button.value);return {kind:'start' as const,form,data};
    });
    let current=opened.kind==='content'?opened.content:await this.navigate(()=>this.client.post(opened.form.action,opened.data),page=>this.materialPage(page,item));
    const result:MaterialResult={id:item.id,name:item.name,files:[],links:[],pages:0};const visited=new Set<string>();
    const rewind=new Set<string>();
    while(current.material.previous){
      if(rewind.size>=100)throw new ParseError('Could not return to the first material page');rewind.add(current.key);
      const body=new URLSearchParams(current.form.hidden);body.set('TxtbkSession[cmd]','prevPage');body.set('TxtbkSession[cmdData]','');
      current=await this.navigate(()=>this.client.post(current.form.action,body),page=>{
        const next=this.materialPage(page,item);
        if(rewind.has(next.key))throw new ParseError('Could not return to the first material page');return next;
      });
    }
    const seenPages=new Set<string>();
    while(true){
      const {material,form,key}=current;seenPages.add(key);result.pages++;
      for(const link of material.links)await this.fetchAttachment(new URL(link.url),link.label,dir,result,visited,0);
      if(!material.links.length&&material.text)result.files.push(saveFile(dir,`page-${result.pages}.txt`,new TextEncoder().encode(material.text)));
      const body=new URLSearchParams(form.hidden);body.set('TxtbkSession[cmd]',material.next?'nextPage':'finish');body.set('TxtbkSession[cmdData]','');
      if(!material.next){
        await this.navigate(()=>this.client.post(form.action,body,{stopAtLogin:true}),page=>{
          if(!page.stoppedAtLogin&&!isLoggedInPage(page.body))throw new ParseError('Files were saved, but material completion could not be verified');
        });
        break;
      }
      if(seenPages.size>=100)throw new ParseError('Could not verify material page navigation');
      current=await this.navigate(()=>this.client.post(form.action,body),page=>{
        const next=this.materialPage(page,item);
        if(seenPages.has(next.key))throw new ParseError('Could not verify material page navigation');return next;
      });
    }
    return result;
  }
  private async fetchAttachment(url:URL,label:string,dir:string,result:MaterialResult,seen:Set<string>,depth:number):Promise<void>{
    if(depth>5)throw new ParseError('Attachment nesting is too deep');if(seen.has(url.href))return;seen.add(url.href);
    if(url.origin!==this.client.base.origin){result.links.push({url:redactUrl(url),label});return;}
    const file=await this.client.getResource(url);
    if(!file.data){
      if(!url.pathname.endsWith('/loadit.php'))throw new ParseError('Received HTML instead of an attachment');
      const links=parseMaterialLinks(file.body,file.url,this.client.base).links;
      if(!links.length)throw new ParseError('No file links found in the PDF viewer');
      for(const link of links)await this.fetchAttachment(new URL(link.url),link.label,dir,result,seen,depth+1);return;
    }
    let name=basename(url.searchParams.get('file')??file.url.pathname);
    if((/\.pdf$/i.test(name)||file.contentType.includes("application/pdf"))&&new TextDecoder().decode(file.data.subarray(0,5))!=="%PDF-")throw new ParseError("Could not verify the PDF file format");
    const disposition=file.contentDisposition??'';const encoded=disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];const plain=disposition.match(/filename="([^"]+)"|filename=([^;]+)/i);
    try{name=encoded?decodeURIComponent(encoded):plain?.[1]??plain?.[2]??decodeURIComponent(name);}catch{/* retain path basename */}
    result.files.push(saveFile(dir,name,file.data));
  }
}
