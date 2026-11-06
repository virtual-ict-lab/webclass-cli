import {expect,test} from 'bun:test';
import {WebClassClient} from '../src/http.ts';
import {ParseError} from '../src/errors.ts';
import {BASE,html,redirect} from './helpers.ts';

for(const access of ['learning','materials'] as const){
  for(const reply of [()=>redirect('/webclass/login.php'),()=>html('<script>location.href="login.php"</script>'),()=>html('expired',401)]){
    test(`${access}: read-only discovery keeps session expiry distinct`,async()=>{
      const client=new WebClassClient({baseUrl:BASE,cookies:{},access,fetch:async()=>reply()});
      await expect(client.get('index.php')).rejects.toMatchObject({code:'SESSION_EXPIRED',exitCode:3});
    });
  }
  test(`${access}: read-only 404 and parser failures keep their error codes`,async()=>{
    const missing=new WebClassClient({baseUrl:BASE,cookies:{},access,fetch:async()=>html('missing',404)});
    await expect(missing.get('index.php')).rejects.toMatchObject({code:'HTTP_ERROR',exitCode:4});
    const invalid=new WebClassClient({baseUrl:BASE,cookies:{},access,fetch:async()=>{throw new ParseError('bad response');}});
    await expect(invalid.get('index.php')).rejects.toMatchObject({code:'PARSE_ERROR',exitCode:6});
  });
}
test('a redirect chain becomes uncertain only after a mutating GET is sent',async()=>{
  const paths:string[]=[];
  const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'learning',sleep:async()=>{},fetch:async input=>{
    const path=new URL(input).pathname;paths.push(path);
    return path.endsWith('index.php')?redirect('/webclass/%64o_contents.php?set_contents_id=dummy'):redirect('/webclass/login.php');
  }});
  await expect(client.get('index.php')).rejects.toMatchObject({code:'OPERATION_UNCERTAIN'});
  expect(paths).toHaveLength(2);
});
test('POST uncertainty survives a redirect to a read-only page',async()=>{
  const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'learning',sleep:async()=>{},fetch:async(_input,init)=>
    init.method==='POST'?redirect('/webclass/index.php',303):html('missing',404)});
  await expect(client.post('show_info.php',new URLSearchParams())).rejects.toMatchObject({code:'OPERATION_UNCERTAIN'});
});
test('a previous successful mutation does not taint a later independent read',async()=>{
  const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'learning',sleep:async()=>{},fetch:async(_input,init)=>
    init.method==='POST'?html('saved'):redirect('/webclass/login.php')});
  await client.post('show_info.php',new URLSearchParams());
  await expect(client.get('index.php')).rejects.toMatchObject({code:'SESSION_EXPIRED'});
});
test('blocked redirects before mutation retain BLOCKED_URL',async()=>{
  const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'learning',fetch:async()=>redirect('/webclass/logout.php')});
  await expect(client.get('index.php')).rejects.toMatchObject({code:'BLOCKED_URL'});
});
for(const access of ['read','learning','materials'] as const){
  test(`${access}: HTML responses are bounded by bytes and their stream is cancelled`,async()=>{
    let cancelled=false;let pulls=0;
    const client=new WebClassClient({baseUrl:BASE,cookies:{},access,maxResponseBytes:5,fetch:async()=>new Response(new ReadableStream({
      pull(c){pulls++;if(pulls===4)c.close();else c.enqueue(new TextEncoder().encode('éé'));},cancel(){cancelled=true;}
    }),{headers:{'content-type':'text/html','content-length':'1'}})});
    await expect(client.get('index.php')).rejects.toMatchObject({code:'HTTP_ERROR'});
    expect(cancelled).toBe(true);expect(pulls).toBeLessThanOrEqual(4);
  });
}
test('oversized HTML after a POST remains uncertain',async()=>{
  const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'learning',maxResponseBytes:5,fetch:async()=>html('123456')});
  await expect(client.post('show_info.php',new URLSearchParams())).rejects.toMatchObject({code:'OPERATION_UNCERTAIN'});
});
test('text exactly at the byte limit is decoded without corruption',async()=>{
  const client=new WebClassClient({baseUrl:BASE,cookies:{},maxResponseBytes:4,fetch:async()=>html('éé')});
  expect((await client.get('index.php')).body).toBe('éé');
});
