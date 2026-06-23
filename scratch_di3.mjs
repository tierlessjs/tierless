import { PROGRAM, run, initialFrames } from "./waso-core.mjs";
import { loadModule } from "./waso-tsc.mjs";
const src=`const reg=new Set(); function Injectable(c){ reg.add(c); } @Injectable class Logger{ msg(){ return "log"; } } @Injectable class Repo{ constructor(l:Logger){ this.l=l; } find(){ return this.l.msg()+":data"; } } @Injectable class Svc{ constructor(repo:Repo){ this.repo=repo; } run(){ return this.repo.find(); } } function resolve(C){ const pts=Reflect.getMetadata("design:paramtypes",C)||[]; return new C(...pts.map(resolve)); } function go(){ return resolve(Svc).run(); }`;
try { loadModule(PROGRAM, src, { entry:"go" }); const v=run({id:"t"},initialFrames("go",[]),{deref:x=>x}).value; console.log("OK", JSON.stringify(v)); }
catch(e){ console.log("ERR:", e.constructor.name, e.message, e.value!==undefined?JSON.stringify(e.value):""); console.log(e.stack.split("\n").slice(0,8).join("\n")); }
