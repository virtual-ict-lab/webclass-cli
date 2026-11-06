import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebClassClient} from '../src/http.ts';
import {MaterialService,parseMaterialLinks,safeFilename} from '../src/materials.ts';
import {BASE,fixture,html,redirect} from './helpers.ts';
test('real textbook/viewer yields PDF and ignores disabled next navigation',()=>{
 const a=parseMaterialLinks(fixture('material-textbook.html'),new URL('mbl.php/textbooks/',BASE),new URL(BASE));expect(a.next).toBe(false);expect(a.links).toHaveLength(1);expect(a.links[0]!.url).toContain('loadit.php');
 const b=parseMaterialLinks(fixture('material-pdf-link.html'),new URL('loadit.php',BASE),new URL(BASE));expect(b.links[0]!.url).toEndWith('.pdf');
});
test('download binary PDF through actual captured wrapper chain and close material',async()=>{
 const dir=mkdtempSync(tmpdir()+'/wc-material-');let pdf=new Uint8Array([37,80,68,70,45,49,46,55,10,0,128,255]);const calls:string[]=[];
 const client=new WebClassClient({baseUrl:BASE,cookies:{WBT_Session:'local'},access:'materials',sleep:async()=>{},fetch:async(url,init)=>{
  const u=new URL(url);calls.push(u.pathname);
  if(u.pathname.endsWith('index.php'))return html(fixture('index.html'));
  if(u.pathname.includes('course.php'))return html(fixture('course.html'));
  if(u.pathname.endsWith('do_contents.php'))return html(fixture('material-start.html'));
  if(u.pathname.endsWith('show_info.php'))return redirect('/webclass/mbl.php/textbooks/',303);
  if(u.pathname.endsWith('loadit.php'))return html(fixture(u.searchParams.has('action')?'material-pdf-link.html':'material-loadit.html'));
  if(u.pathname.endsWith('.pdf'))return new Response(pdf,{headers:{'content-type':'application/pdf','content-disposition':'attachment; filename="../../bad.pdf"'}});
  if(u.pathname.endsWith('/textbooks/'))return init.method==='POST'?html('<script>location.href="login.php"</script>'):html(fixture('material-textbook.html'));
  return html('unknown',404);
 }});
 try{const service=new MaterialService(client,join(dir,'state'));const r=await service.download('00x_000001',{id:'d0000000000000000000000000000007',out:join(dir,'out')});expect(r.materials[0]!.files).toHaveLength(1);const file=r.materials[0]!.files[0]!;expect(new Uint8Array(readFileSync(file.path))).toEqual(pdf);expect(file.path).toStartWith(join(dir,'out'));expect(file.path).not.toContain('/../');
 const again=await service.download('00x_000001',{id:'d0000000000000000000000000000007',out:join(dir,'out')});expect(again.materials[0]!.files[0]!.status).toBe('existing');
 const original=readFileSync(file.path);pdf=new Uint8Array([...pdf,1]);const changed=await service.download('00x_000001',{id:'d0000000000000000000000000000007',out:join(dir,'out')});expect(changed.materials[0]!.files[0]!.path).not.toBe(file.path);expect(readFileSync(file.path)).toEqual(original);
 await expect(service.download('00x_000001',{id:'d000000000000000000000000000000f',out:dir})).rejects.toThrow();
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('filenames cannot escape destination',()=>{for(const s of ['../../a.pdf','..\\..\\x.pdf','/tmp/file.pdf','\u001b[31m.pdf'])expect(safeFilename(s)).not.toMatch(/[\\/\x00-\x1f]/);expect(safeFilename('..')).not.toBe('..');});
test('materials cannot access quiz pages or arbitrary files',async()=>{
 let calls=0;const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'materials',fetch:async()=>{calls++;return html('bad');}});
 for(const path of ['qstn_frame.php','mbl.php/questions/','data/course/../../secret','loadit.php?file=/etc/passwd'])await expect(client.get(path)).rejects.toMatchObject({code:'BLOCKED_URL'});expect(calls).toBe(0);
});
test('bulk downloads only open materials, lists external links, and skips unpublished items',async()=>{
 const dir=mkdtempSync(tmpdir()+'/wc-material-bulk-');const opened:string[]=[];let id='';
 const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'materials',sleep:async()=>{},fetch:async(url,init)=>{
  const u=new URL(url);if(u.pathname.endsWith('index.php'))return html(fixture('index.html'));
  if(u.pathname.includes('course.php'))return html(fixture('course.html'));
  if(u.pathname.endsWith('do_contents.php')){id=u.searchParams.get('set_contents_id')!;opened.push(id);return html(`<h2 class="wcl_pageMainTitle">Material</h2><form name="TextbookForm" action="/webclass/mbl.php/textbooks/" method="post"><input type="hidden" name="TxtbkSession[cmd]" value=""><a href="/webclass/data/course/00/c/${id}.pdf">PDF</a><a href="https://external.example/lecture">Website</a></form>`);}
  if(u.pathname.endsWith('/textbooks/'))return html('<script>location.href="login.php"</script>');
  if(u.pathname.endsWith('.pdf'))return new Response('%PDF-1.7\nmock',{headers:{'content-type':'application/pdf'}});
  throw new Error('unexpected route');
 }});
 try{const r=await new MaterialService(client,join(dir,'state')).download('00x_000001',{all:true,out:join(dir,'out')});expect(r.materials.length).toBeGreaterThan(1);expect(opened).not.toContain('d000000000000000000000000000000f');expect(r.skipped.length).toBeGreaterThan(0);expect(r.materials.every(m=>m.files.length===1&&m.links.length===1)).toBe(true);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('embedded image/audio/video sources and previous-page control are recognized',()=>{
 const p=parseMaterialLinks('<form name="TextbookForm" method="post"><img src="/webclass/data/course/00/c/image.png"><video><source src="/webclass/data/course/00/c/video.mp4"></video><audio src="/webclass/data/course/00/c/audio.mp3"></audio></form><a href="javascript:TextbookClient.prevPage()">Previous</a>',new URL('mbl.php/textbooks/',BASE),new URL(BASE));expect(p.links).toHaveLength(3);expect(p.previous).toBe(true);
});
test('material links exclude incidental media outside the configured course asset root',()=>{
 const base=new URL('https://webclass.example.test/campus/lms/');
 const body=`<base href="/campus/lms/data/course/00/c/"><form name="TextbookForm" method="post">
  <img src="/campus/lms/images/loading.png"><audio src="/campus/lms/images/sound.mp3"></audio>
  <video src="/campus/lms/images/intro.mp4"><source src="/campus/lms/images/clip.mp4"></video>
  <object data="/campus/lms/images/icon.pdf"></object><embed src="/campus/lms/images/icon.pdf">
  <img src="/campus/lms/%69mages/encoded.png"><img src="/campus/lms/data/course/%252e%252e/%252e%252e/images/escaped.png">
  <img src="/campus/lms/data/course-other/00/c/image.png"><img src="/webclass/data/course/00/c/image.png">
  <img src="image.png"><audio src="audio.mp3"></audio><video src="video.mp4"><source src="clip.mp4"></video>
  <object data="object.pdf"></object><embed src="embedded.pdf"><a href="document.pdf">Document</a>
  <a download href="attachment">Download</a><img src="%69mage%2epng"><a href="https://external.example/lecture">Website</a>
 </form>`;
 const material=parseMaterialLinks(body,new URL('mbl.php/textbooks/',base),base);
 expect(material.links.map(link=>link.url)).toEqual([
  'https://webclass.example.test/campus/lms/data/course/00/c/image.png',
  'https://webclass.example.test/campus/lms/data/course/00/c/audio.mp3',
  'https://webclass.example.test/campus/lms/data/course/00/c/video.mp4',
  'https://webclass.example.test/campus/lms/data/course/00/c/clip.mp4',
  'https://webclass.example.test/campus/lms/data/course/00/c/object.pdf',
  'https://webclass.example.test/campus/lms/data/course/00/c/embedded.pdf',
  'https://webclass.example.test/campus/lms/data/course/00/c/document.pdf',
  'https://webclass.example.test/campus/lms/data/course/00/c/attachment',
  'https://webclass.example.test/campus/lms/data/course/00/c/%69mage%2epng',
  'https://external.example/lecture',
 ]);
});
test('an icon-only material does not produce attachment candidates',()=>{
 const material=parseMaterialLinks('<form name="TextbookForm" method="post"><img src="/webclass/images/loading.png"></form>',new URL('mbl.php/textbooks/',BASE),new URL(BASE));
 expect(material.links).toEqual([]);expect(material.text).toBe('');
});
test('download saves the course PDF despite incidental UI images without fetching them',async()=>{
 const dir=mkdtempSync(tmpdir()+'/wc-ui-image-');const base='https://webclass.example.test/campus/lms/';const calls:string[]=[];
 const client=new WebClassClient({baseUrl:base,cookies:{},access:'materials',sleep:async()=>{},fetch:async(url,init)=>{
  const u=new URL(url);calls.push(u.pathname);
  if(u.pathname.endsWith('index.php'))return html(fixture('index.html').replaceAll('/webclass/','/campus/lms/'));
  if(u.pathname.includes('course.php'))return html(fixture('course.html').replaceAll('/webclass/','/campus/lms/'));
  if(u.pathname.endsWith('do_contents.php'))return html('<base href="/campus/lms/data/course/00/c/"><form name="TextbookForm" action="/campus/lms/mbl.php/textbooks/" method="post"><img src="/campus/lms/images/loading.png"><a href="lecture.pdf">Lecture</a></form>');
  if(u.pathname.endsWith('/data/course/00/c/lecture.pdf'))return new Response('%PDF-1.7\nlecture',{headers:{'content-type':'application/pdf'}});
  if(u.pathname.endsWith('/textbooks/')&&init.method==='POST')return html('<script>location.href="login.php"</script>');
  throw new Error('unexpected route');
 }});
 try{
  const result=await new MaterialService(client,join(dir,'state')).download('00x_000001',{id:'d0000000000000000000000000000007',out:join(dir,'out')});
  expect(result.materials[0]!.files).toHaveLength(1);expect(readFileSync(result.materials[0]!.files[0]!.path,'utf8')).toBe('%PDF-1.7\nlecture');
  expect(calls).toContain('/campus/lms/data/course/00/c/lecture.pdf');expect(calls.some(path=>path.includes('/images/'))).toBe(false);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('loadit may return a binary attachment directly (synthetic DOCX)',async()=>{
 const dir=mkdtempSync(tmpdir()+'/wc-direct-file-');const bytes=new Uint8Array([80,75,3,4,0,255,128]);
 const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'materials',sleep:async()=>{},fetch:async(url,init)=>{
 const u=new URL(url);if(u.pathname.endsWith('index.php'))return html(fixture('index.html'));if(u.pathname.includes('course.php'))return html(fixture('course.html'));
 if(u.pathname.endsWith('do_contents.php'))return html('<form name="TextbookForm" action="/webclass/mbl.php/textbooks/" method="post"><a href="/webclass/loadit.php?file=/webclass/data/course/00/c/report.docx">Download</a></form>');
 if(u.pathname.endsWith('loadit.php'))return new Response(bytes,{headers:{'content-type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}});
 return html('<script>location.href="login.php"</script>');}});
 try{const r=await new MaterialService(client,join(dir,'state')).download('00x_000001',{id:'d0000000000000000000000000000007',out:join(dir,'out')});const f=r.materials[0]!.files[0]!;expect(f.path).toEndWith('.docx');expect(new Uint8Array(readFileSync(f.path))).toEqual(bytes);}finally{rmSync(dir,{recursive:true,force:true});}
});
test('material finish must be confirmed instead of accepting the same form',async()=>{
 const dir=mkdtempSync(tmpdir()+'/wc-close-material-');const form='<form name="TextbookForm" action="/webclass/mbl.php/textbooks/" method="post"><p>Material text</p></form>';
 const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'materials',sleep:async()=>{},fetch:async(url)=>{
 const u=new URL(url);if(u.pathname.endsWith('index.php'))return html(fixture('index.html'));if(u.pathname.includes('course.php'))return html(fixture('course.html'));return html(form);}});
 try{await expect(new MaterialService(client,join(dir,'state')).download('00x_000001',{id:'d0000000000000000000000000000007',out:join(dir,'out')})).rejects.toMatchObject({code:'OPERATION_UNCERTAIN'});}finally{rmSync(dir,{recursive:true,force:true});}
});
test.each([
 ['open','unrecognized'],['open','wrong content'],['start','unrecognized'],['start','unsupported form'],
 ['previous','wrong content'],['previous','unrecognized'],['next','wrong content'],['next','unsupported form'],['next','unrecognized'],
])('material %s with %s response is uncertain',async(stage,problem)=>{
 const dir=mkdtempSync(tmpdir()+'/wc-material-navigation-');const commands:string[]=[];
 const form='<form name="TextbookForm" action="/webclass/mbl.php/textbooks/" method="post"><p>Material text</p></form>';
 const invalid=problem==='wrong content'?form+'<script class="js-config" type="application/json">{"contents_id":"different"}</script>':problem==='unsupported form'?form.replace('<p>','<input type="password" name="unsupported"><p>'):'<p>Unknown response</p>';
 const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'materials',sleep:async()=>{},fetch:async(url,init)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('index.php'))return html(fixture('index.html'));
  if(u.pathname.includes('course.php'))return html(fixture('course.html'));
  if(u.pathname.endsWith('do_contents.php')){
   if(stage==='open')return html(invalid);
   if(stage==='start')return html(fixture('material-start.html'));
   return html(form+`<a href="javascript:TextbookClient.${stage==='previous'?'prevPage':'nextPage'}()">Navigate</a>`);
  }
  if(init.method==='POST'){commands.push(new URLSearchParams(String(init.body)).get('TxtbkSession[cmd]')??'start');return html(invalid);}
  throw new Error('unexpected route');
 }});
 try{
  await expect(new MaterialService(client,join(dir,'state')).download('00x_000001',{id:'d0000000000000000000000000000007',out:join(dir,'out')})).rejects.toMatchObject({code:'OPERATION_UNCERTAIN'});
  expect(commands).toEqual(stage==='open'?[]:[stage==='previous'?'prevPage':stage==='next'?'nextPage':'start']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test.each([
 ['404','HTTP_ERROR'],['oversize','HTTP_ERROR'],['invalid PDF','PARSE_ERROR'],['local save','MATERIAL_DOWNLOAD_FAILED'],
])('material attachment %s retains its error after confirmed navigation',async(problem,code)=>{
 const dir=mkdtempSync(tmpdir()+'/wc-material-attachment-error-');const commands:string[]=[];
 const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'materials',maxResponseBytes:25000,sleep:async()=>{},fetch:async(url,init)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('index.php'))return html(fixture('index.html'));
  if(u.pathname.includes('course.php'))return html(fixture('course.html'));
  if(u.pathname.endsWith('do_contents.php'))return html('<form name="TextbookForm" action="/webclass/mbl.php/textbooks/" method="post"><p>First chapter</p></form><a href="javascript:TextbookClient.nextPage()">Next</a>');
  if(init.method==='POST'){commands.push(new URLSearchParams(String(init.body)).get('TxtbkSession[cmd]')!);return html('<form name="TextbookForm" action="/webclass/mbl.php/textbooks/" method="post"><a href="/webclass/data/course/00/c/lecture.pdf">Lecture</a></form>');}
  if(u.pathname.endsWith('/lecture.pdf')){
   if(problem==='404')return html('Missing',404);
   if(problem==='oversize')return new Response(new Uint8Array(25001),{headers:{'content-type':'application/pdf'}});
   if(problem==='local save'){
    const courseDir=join(dir,'out','00x_000001');const materialDir=join(courseDir,readdirSync(courseDir)[0]!);
    rmSync(materialDir,{recursive:true});writeFileSync(materialDir,'occupied');
   }
   return new Response(problem==='invalid PDF'?'invalid':'%PDF-1.7\nlecture',{headers:{'content-type':'application/pdf'}});
  }
  throw new Error('unexpected route');
 }});
 try{
  await expect(new MaterialService(client,join(dir,'state')).download('00x_000001',{id:'d0000000000000000000000000000007',out:join(dir,'out')})).rejects.toMatchObject({code});
  expect(commands).toEqual(['nextPage']);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('safe course discovery parse failures do not become uncertain',async()=>{
 const dir=mkdtempSync(tmpdir()+'/wc-material-discovery-error-');
 const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'materials',sleep:async()=>{},fetch:async(url)=>new URL(url).pathname.endsWith('index.php')?html(fixture('index.html')):html('<p>Unknown course</p>')});
 try{
  await expect(new MaterialService(client,join(dir,'state')).download('00x_000001',{id:'d0000000000000000000000000000007',out:join(dir,'out')})).rejects.toMatchObject({code:'PARSE_ERROR'});
  expect(client.mutationCount).toBe(0);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test.each(['unrecognized','wrong course'])('course discovery redirected through a mutation with %s response is uncertain',async(problem)=>{
 const dir=mkdtempSync(tmpdir()+'/wc-material-course-redirect-');
 const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'materials',sleep:async()=>{},fetch:async(url)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('index.php'))return html(fixture('index.html'));
  if(u.pathname.includes('course.php'))return redirect('/webclass/show_frame.php');
  return html(problem==='unrecognized'?'<p>Unknown course</p>':fixture('course.html').replaceAll('00x_000001','different'));
 }});
 try{
  await expect(new MaterialService(client,join(dir,'state')).download('00x_000001',{id:'d0000000000000000000000000000007',out:join(dir,'out')})).rejects.toMatchObject({code:'OPERATION_UNCERTAIN'});
  expect(client.mutationCount).toBe(1);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('multi-page material rewinds to the first page and saves every chapter',async()=>{
 const dir=mkdtempSync(tmpdir()+'/wc-chapters-');let chapter=2;const commands:string[]=[];
 const body=()=>`<form name="TextbookForm" action="/webclass/mbl.php/textbooks/" method="post"><input type="hidden" name="TxtbkSession[cmd]" value=""><p>Chapter ${chapter}</p></form><a href="javascript:TextbookClient.prevPage()" class="${chapter===1?'ui-disabled':''}">Previous</a><a href="javascript:TextbookClient.nextPage()" class="${chapter===2?'ui-disabled':''}">Next</a>`;
 const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'materials',sleep:async()=>{},fetch:async(url,init)=>{
 const u=new URL(url);if(u.pathname.endsWith('index.php'))return html(fixture('index.html'));if(u.pathname.includes('course.php'))return html(fixture('course.html'));
 if(init.method==='POST'){const cmd=new URLSearchParams(String(init.body)).get('TxtbkSession[cmd]')!;commands.push(cmd);if(cmd==='finish')return html('<script>location.href="login.php"</script>');chapter+=cmd==='nextPage'?1:-1;}
 return html(body());}});
 try{const r=await new MaterialService(client,join(dir,'state')).download('00x_000001',{id:'d0000000000000000000000000000007',out:join(dir,'out')});expect(r.materials[0]!.pages).toBe(2);expect(r.materials[0]!.files.map(f=>readFileSync(f.path,'utf8'))).toEqual(['Chapter 1','Chapter 2']);expect(commands).toEqual(['prevPage','nextPage','finish']);}finally{rmSync(dir,{recursive:true,force:true});}
});
