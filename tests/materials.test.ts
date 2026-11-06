import {expect,test} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebClassClient} from '../src/http.ts';
import {MaterialService,parseMaterialLinks,safeFilename} from '../src/materials.ts';
import {BASE,fixture,html,redirect} from './helpers.ts';
test('real textbook/viewer yields PDF and ignores disabled next navigation',()=>{
 const a=parseMaterialLinks(fixture('material-textbook.html'),new URL('mbl.php/textbooks/',BASE));expect(a.next).toBe(false);expect(a.links).toHaveLength(1);expect(a.links[0]!.url).toContain('loadit.php');
 const b=parseMaterialLinks(fixture('material-pdf-link.html'),new URL('loadit.php',BASE));expect(b.links[0]!.url).toEndWith('.pdf');
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
 const p=parseMaterialLinks('<form name="TextbookForm" method="post"><img src="/webclass/data/course/00/c/image.png"><video><source src="/webclass/data/course/00/c/video.mp4"></video><audio src="/webclass/data/course/00/c/audio.mp3"></audio></form><a href="javascript:TextbookClient.prevPage()">Previous</a>',new URL('mbl.php/textbooks/',BASE));expect(p.links).toHaveLength(3);expect(p.previous).toBe(true);
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
 try{await expect(new MaterialService(client,join(dir,'state')).download('00x_000001',{id:'d0000000000000000000000000000007',out:join(dir,'out')})).rejects.toThrow();}finally{rmSync(dir,{recursive:true,force:true});}
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
