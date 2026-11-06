import {TextNode,type HTMLElement} from 'node-html-parser';
import {ParseError, UsageError} from './errors.ts';

export interface Field {
  name:string; type:string; label:string; values:string[];
  options:{value:string;label:string}[];
  required:boolean; minLength:number|null; maxLength:number|null;
  maxBytes:number|null; allowedTypes:string[];
}
export interface Form {
  action:string; hidden:[string,string][]; fields:Field[];
  buttons:{name:string;value:string}[];
}
export type Answers=Record<string,string|string[]>;
const num=(v:string|undefined):number|null=>v!==undefined&&/^\d+$/.test(v)?Number(v):null;
export function normalizeTextareaValue(value:string):string {
  return value.replace(/\r\n?/g,'\n');
}
function parseTextareaValue(input:HTMLElement):string {
  // HTML normalizes source newlines before decoding references and skipping one initial LF token.
  const text=new TextNode(normalizeTextareaValue(input.rawText)).text;
  return normalizeTextareaValue(text.startsWith('\n')?text.slice(1):text);
}
export function parseForm(el:HTMLElement,url:URL):Form {
  if((el.getAttribute('method')??'get').toLowerCase()!=='post')throw new ParseError('No POST form found');
  if(el.querySelector('mobile-select-box'))throw new ParseError('Dynamic choice questions are not supported');
  const form:Form={action:new URL(el.getAttribute('action')||url.href,url).href,hidden:[],fields:[],buttons:[]};
  for(const input of el.querySelectorAll('input,textarea,select,button')){
    if(input.hasAttribute('disabled')||input.closest('fieldset[disabled]'))continue;
    const name=input.getAttribute('name');if(!name)continue;
    const tag=input.tagName.toLowerCase();const type=(input.getAttribute('type')??(tag==='button'?'submit':tag==='input'?'text':tag)).toLowerCase();
    const value=input.getAttribute('value')??'';
    if(type==='hidden'){form.hidden.push([name,value]);continue;}
    if(type==='submit'){form.buttons.push({name,value});continue;}
    if(['button','reset'].includes(type))continue;
    if(!['text','textarea','radio','checkbox','select','file','number','email','url'].includes(type))throw new ParseError(`Unsupported input type: ${type}`);
    let field=form.fields.find(f=>f.name===name);
    if(field&&!['checkbox','radio'].includes(type))throw new ParseError('Cannot distinguish input fields with the same name');
    const id=input.getAttribute('id');
    const label=el.querySelectorAll('label').find(l=>l.getAttribute('for')===id&&id)?.structuredText.trim()||input.getAttribute('aria-label')||name;
    const group=input.closest('fieldset');
    if(!field){field={name,type,label,values:[],options:[],required:input.hasAttribute('required'),
      minLength:num(input.getAttribute('data-min-length')??input.getAttribute('minlength')),
      maxLength:num(input.getAttribute('data-max-length')??input.getAttribute('maxlength')),
      maxBytes:num(group?.getAttribute('data-size-limit')),allowedTypes:(group?.getAttribute('data-type-limit')??'').split(',').filter(Boolean)};form.fields.push(field);}
    if(type==='checkbox'||type==='radio'){
      const v=input.getAttribute('value')??'on';field.options.push({value:v,label});if(input.hasAttribute('checked'))field.values.push(v);
    }else if(type==='select'){
      const options=input.querySelectorAll('option').filter(o=>!o.hasAttribute('disabled'));
      field.options=options.map(o=>({value:o.getAttribute('value')??o.text,label:o.structuredText.trim()}));
      field.values=options.filter(o=>o.hasAttribute('selected')).map(o=>o.getAttribute('value')??o.text);
      if(!input.hasAttribute('multiple')&&field.values.length===0&&field.options[0])field.values=[field.options[0].value];
      if(input.hasAttribute('multiple'))field.type='multiselect';
    }else if(type!=='file')field.values=[type==='textarea'?parseTextareaValue(input):value];
  }
  return form;
}
export function buildFormBody(form:Form,answers:Answers,command:string):URLSearchParams {
  if(!answers||typeof answers!=='object'||Array.isArray(answers))throw new UsageError('Answers must be a JSON object keyed by field name');
  for(const name of Object.keys(answers))if(!form.fields.some(f=>f.name===name&&f.type!=='file'))throw new UsageError(`Answer field cannot be changed: ${name}`);
  const body=new URLSearchParams(form.hidden);
  for(const field of form.fields){
    if(field.type==='file')continue;
    const v=Object.hasOwn(answers,field.name)?answers[field.name]:field.values;
    const values=Array.isArray(v)?v:[v];
    if(!values.every(s=>typeof s==='string'))throw new UsageError('Answer values must be strings or arrays of strings');
    if(!['checkbox','multiselect'].includes(field.type)&&values.length>1)throw new UsageError(`Provide a single answer: ${field.name}`);
    if(command==='finish'&&field.required&&(!values.length||values.every(s=>!s)))throw new UsageError(`Required answer is empty: ${field.name}`);
    for(const value of values as string[]){
      if(field.options.length&&!field.options.some(o=>o.value===value))throw new UsageError(`Value is not among the available options: ${field.name}`);
      const length=value.replace(/\r\n/g,'\n').length;
      if(field.maxLength!==null&&length>field.maxLength||field.minLength!==null&&length>0&&length<field.minLength)throw new UsageError(`Answer does not meet the length limits: ${field.name}`);
      body.append(field.name,value);
    }
  }
  body.set('QstnSession[cmd]',command);body.set('QstnSession[cmdData]','');
  return body;
}
