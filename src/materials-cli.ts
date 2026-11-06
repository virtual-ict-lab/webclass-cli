import {parseArgs} from 'node:util';
import {makeClient} from './commands.ts';
import {MaterialService} from './materials.ts';
import {UsageError} from './errors.ts';
const HELP=`Course materials:
  webclass materials list <course-id> [--human]
  webclass materials download <course-id> <content-id> [--out directory]
  webclass materials download <course-id> --all [--out directory]

Default destination: ./downloads/webclass. Only materials are downloaded; unavailable items are skipped.
PDF viewer attachments are included. Identical files are reused; changed files receive a different name.
Opening materials may update viewing history. External links are listed in the result.
--pretty: format JSON / --human: readable text
`;
export async function materialsCommand(args:string[]){
 const {values,positionals}=parseArgs({args,allowPositionals:true,strict:true,options:{all:{type:'boolean'},out:{type:'string'},pretty:{type:'boolean'},human:{type:'boolean'},help:{type:'boolean',short:'h'}}});
 const [action,courseId,id]=positionals;
 if(values.help||!action){console.log(HELP);return null;}
 if(!['list','download'].includes(action)||!courseId)throw new UsageError('Use materials list/download <course-id>');
 if(action==='download'&&Boolean(id)===Boolean(values.all))throw new UsageError('Specify either a content ID or --all');
 const service=new MaterialService(makeClient(process.env,{access:'materials'}),undefined,{progress:s=>console.error(s.replace(/[\x00-\x1f\x7f-\x9f]/g,''))});
 if(action==='list'){const r=await service.list(courseId);return {json:r,human:()=>r.materials.map(m=>`${m.id}\t${m.name}${m.openable?'':' (unavailable)'}`).join('\n')};}
 const r=await service.download(courseId,{id,all:values.all,out:values.out??'downloads/webclass'});
 return {json:r,human:()=>r.materials.map(m=>[m.name,...m.files.map(f=>`  ${f.status}: ${f.path} (${f.bytes} bytes)`),...m.links.map(l=>`  External link: ${l.url}`)].join('\n')).join('\n')};
}
