import {mkdirSync,writeFileSync,readFileSync,renameSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {UsageError} from './errors.ts';
import type {AttemptPage} from './parsers/attempt.ts';
export interface Attempt {
  version:1; id:string; base:string; identity:string; courseId:string; contentId:string;
  status:'ready'|'active'|'pending'|'uncertain'|'submitted'|'abandoned';
  catalog?:AttemptPage[]; batch?:"collecting"|"answering"|"waiting"|"done";
  url:string; page?:AttemptPage; updatedAt:string; uploads?:{question:string;name:string}[];
}
export class AttemptStore {
  constructor(readonly dir:string){mkdirSync(dir,{recursive:true,mode:0o700});}
  private path(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new UsageError('Invalid attempt ID');return join(this.dir,`${id}.json`);}
  read(id:string):Attempt {
    const path=this.path(id);let a:Attempt;
    try{a=JSON.parse(readFileSync(path,'utf8'));}catch{throw new UsageError('Saved attempt is missing or corrupt');}
    if(a.version!==1||a.id!==id)throw new UsageError('Invalid attempt data format');return a;
  }
  write(a:Attempt){const path=this.path(a.id);const temp=`${path}.${process.pid}.tmp`;a.updatedAt=new Date().toISOString();writeFileSync(temp,JSON.stringify(a),{mode:0o600});renameSync(temp,path);}
  list(){return readdirSync(this.dir).filter(f=>/^[a-f0-9-]{36}\.json$/.test(f)).map(f=>this.read(f.slice(0,-5)));}
  async locked<T>(fn:()=>Promise<T>):Promise<T>{
    const path=join(this.dir,'operation.lock');
    try{writeFileSync(path,String(process.pid),{flag:'wx',mode:0o600});}
    catch{throw new UsageError('Another learning operation is running. After a crash, confirm the process has stopped before removing operation.lock');}
    try{return await fn();}finally{rmSync(path,{force:true});}
  }
}
