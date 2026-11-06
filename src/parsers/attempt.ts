import {parse} from 'node-html-parser';
import {ParseError,redactUrl} from '../errors.ts';
import {parseForm,type Form,type Field} from '../forms.ts';
export interface Question {id:string;text:string;images:{url:string;alt:string}[];fields:Field[];}
export interface AttemptPage {
  kind:'start'|'questions'|'result';title:string;form?:Form;questions:Question[];
  navigation?:{next:boolean;previous:boolean}; branching?:boolean;
  score?:number;total?:number;summary?:string;remaining_seconds?:number;page?:number;
}
export function parseAttempt(html:string,url:URL):AttemptPage {
  const root=parse(html);const title=root.querySelector('.wcl_pageMainTitle')?.text.trim()??'';
  const el=root.querySelector('form[name="QuestionForm"]');
  if(el){
    const form=parseForm(el,url);
    if(!form.hidden.some(([n])=>n==='QstnSession[s]'))throw new ParseError('No attempt session found');
    const questions:Question[]=[];
    for(const field of form.fields){
      const id=field.name.match(/^QuestionAnswer\[(\d+)\]/)?.[1];
      if(!id)throw new ParseError('An input field has no corresponding question');
      let q=questions.find(q=>q.id===id);
      if(!q){
        const input=el.querySelectorAll('[name]').find(e=>e.getAttribute('name')===field.name)!;
        const box=input.closest('.content')??input.closest('fieldset')??input.parentNode;
        const copy=parse(box?.outerHTML??'');copy.querySelectorAll('script,style,input,select,textarea,button').forEach(e=>e.remove());
        // Subscripts remain distinguishable from the preceding number in plain terminals.
        copy.querySelectorAll('sub').forEach(e=>{e.innerHTML=`[${e.text}]`;});
        q={id,text:copy.structuredText.trim(),images:(box?.querySelectorAll('img[src]')??[]).map(i=>({url:redactUrl(new URL(i.getAttribute('src')!,url)),alt:i.getAttribute('alt')??''})),fields:[]};questions.push(q);
      }
      q.fields.push(field);
    }
    for(const input of el.querySelectorAll('[name]')){
      const id=input.getAttribute('name')?.match(/^QuestionAnswer\[(\d+)\]/)?.[1];
      if(id&&!questions.some(q=>q.id===id))throw new ParseError('A question is unsupported or has no answer field');
    }
    if(!questions.length)throw new ParseError('No answerable questions found');
    const hidden=new URLSearchParams(form.hidden);
    const controls=root.querySelectorAll('a[href],input[onclick],button[onclick]').map(e=>(e.getAttribute('href')??'')+' '+(e.getAttribute('onclick')??'')).join(' ');
    const navigation={next:/QuestionClient\.nextPage\(\)/.test(controls),previous:/QuestionClient\.prevPage\(\)/.test(controls)};
    const branching=root.querySelectorAll('script.js-config[type="application/json"]').some(e=>JSON.parse(e.text).branch_mode===true);
    return {kind:'questions',title,form,questions,navigation,branching,remaining_seconds:Number(hidden.get('RemainSeconds')??-1),page:Number(hidden.get('QstnSession[page]')??1)};
  }
  for(const f of root.querySelectorAll('form')){
    if(f.querySelectorAll('input').some(i=>i.getAttribute('name')==='next'&&i.getAttribute('value')==='開始'))return {kind:'start',title,form:parseForm(f,url),questions:[]};
  }
  if(/\/mbl\.php\/question_results\/?$/.test(url.pathname)&&title&&root.querySelector('[data-role="header"] h1')?.text.trim()==='結果'){
    const summary=root.querySelector('h3')?.structuredText.trim()??'';
    const score=summary.match(/◇得点\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
    if(!summary)throw new ParseError('No result summary found');
    return {kind:'result',title,questions:[],summary,...(score?{score:Number(score[1]),total:Number(score[2])}:{})};
  }
  throw new ParseError('Unrecognized start, question, or result page structure');
}
