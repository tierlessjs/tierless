import { PROGRAM, run, Suspend, serializeContinuation, deserializeContinuation, initialFrames, awaitable } from "./waso-core.mjs";
import { loadModule } from "./waso-tsc.mjs";
const J = (x) => JSON.stringify(x, (k,v)=> v===undefined?'U':v);
const cases = {
  "define/get on object": "function go(){ const o={}; Reflect.defineMetadata('role','admin',o); return [Reflect.getMetadata('role',o),Reflect.hasMetadata('role',o),Reflect.hasMetadata('x',o)]; }",
  "per-property metadata": "function go(){ const o={}; Reflect.defineMetadata('type','string',o,'name'); Reflect.defineMetadata('type','number',o,'age'); return [Reflect.getMetadata('type',o,'name'),Reflect.getMetadata('type',o,'age'),Reflect.getMetadata('type',o)]; }",
  "metadata keys": "function go(){ const o={}; Reflect.defineMetadata('a',1,o); Reflect.defineMetadata('b',2,o); return Reflect.getMetadataKeys(o).sort(); }",
  "delete metadata": "function go(){ const o={}; Reflect.defineMetadata('a',1,o); const had=Reflect.hasMetadata('a',o); Reflect.deleteMetadata('a',o); return [had,Reflect.hasMetadata('a',o)]; }",
  "metadata value is object": "function go(){ const o={}; Reflect.defineMetadata('opts',{path:'/users',method:'GET'},o,'list'); const m=Reflect.getMetadata('opts',o,'list'); return [m.path,m.method]; }",
};
let pass=0,fail=0;
for (const [name,src] of Object.entries(cases)) {
  for (const k in PROGRAM) delete PROGRAM[k];
  let got,ge=0;
  try { loadModule(PROGRAM,src,{entry:"go"}); got=run({id:"t"},initialFrames("go",[]),{deref:x=>x}).value; } catch(e){ge=1;got=e.message;}
  console.log(ge?"ERR ":"OK  ", name, ge?got:J(got));
}
// migration test
const src=`function go(){ const o={}; Reflect.defineMetadata('design:type','User',o,'profile'); return o; }
async function check(o){ await ckpt(0); return Reflect.getMetadata('design:type',o,'profile'); }`;
for (const k in PROGRAM) delete PROGRAM[k];
loadModule(PROGRAM, src, { entry:"check", resources:["ckpt"] });
// build o first
const o = run({id:"t2"}, initialFrames("go", []), {deref:x=>x}).value;
const tier={id:"client",has:n=>n==="ckpt",resources:{ckpt:a=>awaitable({v:a[0]})}};
let frames=initialFrames("check",[o]); const host={deref:x=>x};
while(true){let res;
  try{res=run(tier,frames,host);}catch(e){if(!(e instanceof Suspend))throw e;
    const wire=serializeContinuation({frames:e.frames,pending:e.pending},tier);
    const g=deserializeContinuation(JSON.parse(JSON.stringify(wire)));
    g.frames[g.frames.length-1].stack.push(g.pending.await.v); frames=g.frames; continue;}
  console.log("MIGRATED metadata survives:", JSON.stringify(res.value)); break;}
