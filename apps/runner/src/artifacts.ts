import * as tar from 'tar-stream';
import { CAPS } from '@arenacore/runtime-policy';

export async function packFiles(files:readonly {name:string;data:Buffer}[]):Promise<Buffer> {
  const pack=tar.pack();const chunks:Buffer[]=[];let size=0;
  const done=new Promise<Buffer>((resolve,reject)=>{pack.on('data',(b:Buffer)=>{size+=b.length;if(size>CAPS.artifactBytes){pack.destroy(new Error('ARTIFACT_LIMIT'));return;}chunks.push(b);});pack.once('end',()=>resolve(Buffer.concat(chunks)));pack.once('error',reject);});
  for(const file of files)pack.entry({name:file.name,type:'file',mode:0o644,uid:10001,gid:10001,size:file.data.length},file.data);
  pack.finalize();return done;
}
export async function normalizeJavaArtifacts(bytes:Buffer):Promise<Buffer> {
  if(bytes.length>CAPS.artifactBytes)throw new Error('ARTIFACT_LIMIT');
  const extract=tar.extract();const files:{name:string;data:Buffer}[]=[];const names=new Set<string>();let total=0;
  const finished=new Promise<void>((resolve,reject)=>{extract.once('finish',resolve);extract.once('error',()=>reject(new Error('INVALID_ARTIFACT_ARCHIVE')));});
  extract.on('entry',(header,stream,next)=>{
    stream.on('error',()=>{});
    const name=header.name.replace(/^\.\//,'');
    if(header.type==='directory' && (name==='' || name==='.' || /^(?:[A-Za-z_$][A-Za-z0-9_$]*\/)+$/.test(name))) {stream.resume();stream.once('end',next);return;}
    if(header.type!=='file'||! /^(?:[A-Za-z_$][A-Za-z0-9_$]*\/)*[A-Za-z_$][A-Za-z0-9_$]*\.class$/.test(name)||names.has(name)||header.size===undefined||header.size>CAPS.maxFileBytes||files.length>=CAPS.artifactFiles){stream.resume();extract.destroy(new Error('INVALID_ARTIFACT_ARCHIVE'));return;}
    names.add(name);const chunks:Buffer[]=[];
    stream.on('data',(b:Buffer)=>{total+=b.length;if(total>CAPS.artifactBytes)extract.destroy(new Error('ARTIFACT_LIMIT'));else chunks.push(b);});
    stream.once('end',()=>{files.push({name,data:Buffer.concat(chunks)});next();});stream.once('error',()=>extract.destroy(new Error('INVALID_ARTIFACT_ARCHIVE')));
  });
  extract.end(bytes);await finished;
  if(!names.has('Solution.class'))throw new Error('MISSING_ENTRYPOINT');
  return packFiles(files);
}
