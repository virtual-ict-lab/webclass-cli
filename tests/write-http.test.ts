import { expect, test } from "bun:test";
import { WebClassClient } from "../src/http.ts";
import { BASE, html, redirect } from "./helpers.ts";

function setup(reply: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: RequestInit[] = [];
  const client = new WebClassClient({ baseUrl: BASE, cookies: { S: "secret" }, access: "learning", sleep: async () => {},
    fetch: async (url, init) => { calls.push(init); return reply(url, init); } });
  return { client, calls };
}
test("POST form preserves repeated values and converts 303 to GET", async () => {
  const { client, calls } = setup((_url, init) => init.method === "POST" ? redirect("mbl.php/question_results", 303) : html("result"));
  const data = new URLSearchParams([["a[]", "1"], ["a[]", "2"]]);
  await client.post("show_info.php", data);
  expect(calls.map(c => c.method)).toEqual(["POST", "GET"]);
  expect(String(calls[0]!.body)).toBe("a%5B%5D=1&a%5B%5D=2");
  expect(calls[1]!.body).toBeUndefined();
});
test("multipart is passed without a manually set boundary", async () => {
  const {client,calls} = setup(() => html("ok"));
  const form = new FormData(); form.append("upload_file", new File(["hello"], "a.txt"));
  await client.post("mbl.php/questions/api?api=upload", form);
  expect(calls[0]!.body).toBe(form);
  expect(new Headers(calls[0]!.headers).get("Content-Type")).toBeNull();
});
for (const code of [300, 305, 306, 429, 500, 503, 307, 308]) test(`write HTTP ${code} never retries or resends`, async () => {
  const {client,calls} = setup(() => code < 400 ? redirect("show_info.php",code) : html("error",code));
  await expect(client.post("show_info.php", new URLSearchParams())).rejects.toMatchObject({code:"OPERATION_UNCERTAIN"});
  expect(calls).toHaveLength(1);
});
test("network loss and redirected login after submission are uncertain", async () => {
  for (const reply of [() => {throw new Error("secret");}, () => redirect("login.php")]) {
    const {client,calls}=setup(reply);
    const err=await client.post("show_info.php",new URLSearchParams()).catch(e=>e);
    expect(err.code).toBe("OPERATION_UNCERTAIN"); expect(err.message).not.toContain("secret"); expect(calls).toHaveLength(1);
  }
});
test("learning GET is not retried; origin and logout guards still apply", async () => {
  const {client,calls}=setup(()=>html("err",503));
  await expect(client.get("do_contents.php?set_contents_id=x")).rejects.toMatchObject({code:"OPERATION_UNCERTAIN"});
  expect(calls).toHaveLength(1);
  for(const url of ["logout.php","https://evil.test/webclass/show_info.php","unknown.php"])
    await expect(client.post(url,new URLSearchParams())).rejects.toMatchObject({code:"BLOCKED_URL"});
  expect(calls).toHaveLength(1);
});
test("default client still rejects POST without sending", async () => {
  let sent=false;
  const client=new WebClassClient({baseUrl:BASE,cookies:{},fetch:async()=>{sent=true;return html("bad");}});
  await expect(client.post("index.php",new URLSearchParams())).rejects.toMatchObject({code:"BLOCKED_URL"});
  expect(sent).toBe(false);
});
test('learning requests wait 2–3 seconds after completion, including each answer',async()=>{
 let clock=0;const gaps:number[]=[];let end=0;let n=0;
 const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'learning',minIntervalMs:1,now:()=>clock,random:()=>n++%2===0?0:1,sleep:async ms=>{clock+=ms;},fetch:async()=>{if(end)gaps.push(clock-end);clock+=100;end=clock;return html('ok');}});
 await Promise.all([1,2,3].map(()=>client.post('show_info.php',new URLSearchParams())));
 expect(gaps).toHaveLength(2);for(const gap of gaps){expect(gap).toBeGreaterThanOrEqual(2000);expect(gap).toBeLessThanOrEqual(3000);}
});
test('a small form with an onclick redirect is not treated as a jump page',async()=>{
 const body='<form method="post"><input name="x"><button onclick="location.href=\'logout.php\'">Exit</button></form>';
 const {client,calls}=setup(()=>html(body));const page=await client.get('show_info.php');expect(page.body).toBe(body);expect(calls).toHaveLength(1);
});
test('binary download preserves bytes and bounds response size',async()=>{
 const bytes=new Uint8Array([0,128,255,37,80,68,70]);
 const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'materials',sleep:async()=>{},maxResponseBytes:10,fetch:async()=>new Response(bytes,{headers:{'content-type':'application/pdf'}})});
 expect((await client.getBytes('data/course/00/c/file.pdf')).data).toEqual(bytes);
 const small=new WebClassClient({baseUrl:BASE,cookies:{},access:'materials',maxResponseBytes:2,fetch:async()=>new Response(bytes)});
 await expect(small.getBytes('data/course/00/c/file.pdf')).rejects.toMatchObject({code:'OPERATION_UNCERTAIN'});
});
test('HTML login response cannot be saved as a file',async()=>{
 const client=new WebClassClient({baseUrl:BASE,cookies:{},access:'materials',fetch:async()=>html('<html><form action="login.php"><input type="password"></form></html>')});
 await expect(client.getBytes('data/course/00/c/file.pdf')).rejects.toThrow();
});
