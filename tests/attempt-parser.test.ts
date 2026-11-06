import {expect,test} from 'bun:test';
import {parseAttempt} from '../src/parsers/attempt.ts';
import {buildFormBody} from '../src/forms.ts';
import {fixture,BASE} from './helpers.ts';
const url=new URL('mbl.php/questions/?acs_=SECRET',BASE);
test('real start, five questions, saved answers and result',()=>{
 const start=parseAttempt(fixture('quiz-start.html'),new URL('show_info.php',BASE));expect(start.kind).toBe('start');
 const q=parseAttempt(fixture('quiz-questions.html'),url);expect(q.kind).toBe('questions');expect(q.questions).toHaveLength(5);expect(q.questions[0]!.fields[0]!.name).toBe('QuestionAnswer[1][value][0]');expect(q.questions[0]!.text).toContain('サンプル設問1');
 const saved=parseAttempt(fixture('quiz-saved.html'),url);expect(saved.questions[0]!.fields[0]!.values).toEqual(['example-1']);
 const result=parseAttempt(fixture('quiz-result.html'),new URL('mbl.php/question_results',BASE));expect(result.kind).toBe('result');expect(result.score).toBe(3);expect(result.total).toBe(5);
});
test('keep other answers and hidden state, reject tampering',()=>{
 const q=parseAttempt(fixture('quiz-saved.html'),url);
 const body=buildFormBody(q.form!,{'QuestionAnswer[1][value][0]':'0100'},'restart');
 expect(body.get('QuestionAnswer[2][value][0]')).toBe('example-2');expect(body.get('QstnSession[cmd]')).toBe('restart');
 expect(()=>buildFormBody(q.form!,{'QstnSession[s]':'999'},'finish')).toThrow();
 expect(()=>buildFormBody(q.form!,{'not-present':'x'},'finish')).toThrow();
});
const form=(body:string)=>`<h2 class="wcl_pageMainTitle">Synthetic report</h2><form name="QuestionForm" method="post"><input type="hidden" name="QstnSession[cmd]" value=""><input type="hidden" name="QstnSession[s]" value="1">${body}</form>`;
test('radio, checkbox, select and text constraints',()=>{
 const p=parseAttempt(form(`<div class="content"><input type="radio" name="QuestionAnswer[1][value]" value="a"><input type="radio" name="QuestionAnswer[1][value]" value="b" checked><input type="checkbox" name="QuestionAnswer[2][value][]" value="x" checked><input type="checkbox" name="QuestionAnswer[2][value][]" value="y"><select name="QuestionAnswer[3][value]"><option value="a">Alpha</option><option value="b" selected>Beta</option></select><textarea name="QuestionAnswer[4][text]" data-min-length="2" data-max-length="5">old</textarea></div>`),url);
 const b=buildFormBody(p.form!,{'QuestionAnswer[2][value][]':[]},'restart');expect(b.has('QuestionAnswer[2][value][]')).toBe(false);expect(b.get('QuestionAnswer[3][value]')).toBe('b');
 expect(()=>buildFormBody(p.form!,{'QuestionAnswer[1][value]':'invalid'},'finish')).toThrow();
 expect(()=>buildFormBody(p.form!,{'QuestionAnswer[4][text]':'too long'},'finish')).toThrow();
 expect(()=>buildFormBody(p.form!,{'QuestionAnswer[4][text]':'x'},'finish')).toThrow();
});
test('file limits from observed report JS DOM contract (synthetic)',()=>{
 const p=parseAttempt(form(`<fieldset class="reportStyle" data-qnum="1" data-size-limit="100" data-type-limit="PDF,Text"><input type="file" name="QuestionAnswer[1][file]"></fieldset>`),url);
 const f=p.questions[0]!.fields[0]!;expect(f.maxBytes).toBe(100);expect(f.allowedTypes).toEqual(['PDF','Text']);
});
test('unknown and login screens cannot be completion',()=>{
 for(const s of ['<html>OK</html>','<h1>結果</h1>','<form name="QuestionForm"><mobile-select-box></mobile-select-box></form>'])expect(()=>parseAttempt(s,url)).toThrow();
});
test('hidden-only question on mixed page cannot be silently submitted',()=>{
 expect(()=>parseAttempt(form(`<div class="content"><input name="QuestionAnswer[1][value]" value="x"></div><div class="content"><input type="hidden" name="QuestionAnswer[2][style]" value="dynamic"></div>`),url)).toThrow();
});

test('draft save may leave other required answers empty, final submit may not',()=>{
 const q=parseAttempt(form('<input name="QuestionAnswer[1][value]" required><input name="QuestionAnswer[2][value]" required>'),url);
 expect(()=>buildFormBody(q.form!,{'QuestionAnswer[1][value]':'A'},'restart')).not.toThrow();
 expect(()=>buildFormBody(q.form!,{},'nextPage')).not.toThrow();
 expect(()=>buildFormBody(q.form!,{'QuestionAnswer[1][value]':'A'},'finish')).toThrow();
});
