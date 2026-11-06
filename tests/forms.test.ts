import {expect,test} from 'bun:test';
import {parse} from 'node-html-parser';
import {buildFormBody,parseForm} from '../src/forms.ts';

const url=new URL('https://example.test/webclass/mbl.php/questions/');
// These forms are synthetic and contain no captured server data.
function textareaForm(content:string,blockText=false) {
  const options=blockText?{blockTextElements:{script:true,noscript:true,style:true,pre:true,textarea:true}}:undefined;
  return parseForm(parse(`<form method="post"><textarea name="report">${content}</textarea><input name="other" value="old"></form>`,options).querySelector('form')!,url);
}

test.each([
  ['literal LF','\nanswer','answer'],
  ['literal CRLF','\r\nanswer','answer'],
  ['literal CR','\ranswer','answer'],
  ['numeric LF reference','&#10;answer','answer'],
  ['hexadecimal LF reference','&#xA;answer','answer'],
  ['named LF reference','&NewLine;answer','answer'],
  ['two leading newlines','\n\nanswer','\nanswer'],
  ['space before a newline',' \nanswer',' \nanswer'],
  ['referenced CR','&#13;answer','\nanswer'],
  ['literal CR followed by referenced LF','\r&#10;answer','\nanswer'],
  ['referenced CR followed by literal CRLF','&#13;\r\nanswer','\nanswer'],
])('textarea initial newline handling: %s',(_name,content,expected)=>{
  expect(textareaForm(content).fields[0]!.values).toEqual([expected]);
});

test('textarea values normalize internal CRLF and CR without trimming whitespace',()=>{
  const form=textareaForm(' first\r\nsecond\rthird\nfourth \r\n');
  expect(form.fields[0]!.values).toEqual([' first\nsecond\nthird\nfourth \n']);
});

test('textarea values decode escaped markup and entities exactly once',()=>{
  const form=textareaForm('\n&lt;b&gt;A&amp;B&lt;/b&gt; &amp;lt; &#13;C');
  expect(form.fields[0]!.values).toEqual(['<b>A&B</b> &lt; \nC']);
});

test('textarea block text preserves literal markup, comments, and entities',()=>{
  const form=textareaForm('\r\n<!-- note --><b>A&amp;B</b><input name="literal">\rnext',true);
  expect(form.fields).toHaveLength(2);
  expect(form.fields[0]!.values).toEqual(['<!-- note --><b>A&B</b><input name="literal">\nnext']);
});

test('saving another answer preserves the parsed textarea value',()=>{
  const form=textareaForm('\r\nfirst\r\nsecond\rthird');
  const body=buildFormBody(form,{other:'new'},'restart');
  expect(body.get('report')).toBe('first\nsecond\nthird');
  expect(body.get('other')).toBe('new');
});

test('explicit textarea answers preserve their leading newline',()=>{
  const form=textareaForm('\nold');
  const body=buildFormBody(form,{report:'\nanswer\r\nnext'},'restart');
  expect(body.get('report')).toBe('\nanswer\r\nnext');
});
