import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeNativeBoltPreload, prepareNativeBoltPreload, type NativeBoltPreloadPlan, type NativeBoltPreloadResult, type PreparedNativeBoltPreload } from './nativeBoltPreload.js';
import { analyzeNativeBoltPreload, verifyNativeBoltPrograms, type NativeBoltPrograms } from './nativeBoltPreloadRuntime.js';
import type { PyodideRuntime } from './runtime.js';
const read=(relative:string):string=>readFileSync(fileURLToPath(new URL(relative,import.meta.url)),'utf8');
const inputBytes=read('./nativeBoltPreload.input.fixture.json');
const actualResultBytes=read('./nativeBoltPreload.result.fixture.json');
const fixture:unknown=JSON.parse(actualResultBytes);
if(fixture===null||typeof fixture!=='object'||!('result' in fixture))throw Error('Invalid raw fixture');
const actualRaw:unknown=fixture.result;
let prepared:PreparedNativeBoltPreload,result:NativeBoltPreloadResult;
beforeAll(async()=>{prepared=await prepareNativeBoltPreload(JSON.parse(inputBytes),inputBytes);result=decodeNativeBoltPreload(actualRaw,prepared);});
describe('candidate dedicated native preload boundary (no new native solve)',()=>{
 it('binds exact native input bytes and independently known spring forces, separation, gap and unload',()=>{
  // Fixed four-node/two-Beam3d input; actual native RUN 20261027-082738, unmodified raw bytes.
  // Expectations below are independent: cb=10nm/N, cm=2.5nm/N, Fi=4000N, s=50um, N-Q=P.
  // Psep=s/cb=5000N; U=(cb*N*N+cm*Q*Q)/2. NASA TM-106943, outer-plane axial loading only.
  expect(createHash('sha256').update(actualResultBytes).digest('hex')).toBe('20f16f8df73e0c5352e0eb8f2cb5741ad3d07baf07b02c27750885400a406c66');
  expect(prepared.inputSha256).toBe('704aec1afdbdf7f5b4c486d4058a57b293608aa26af3b9dc5ad36b3a9f43785a');
  expect(result.states.map(s=>s.externalLoadN)).toEqual([0,1000,4999,5000,5001,0]);
  const expected=[[4000,4000],[4200,3200],[4999.8,.8],[5000,0],[5001,0],[4000,4000]];
  result.states.forEach((s,i)=>{expect(Math.abs(s.boltTensionN-expected[i][0])).toBeLessThan(1e-8);expect(Math.abs(s.memberCompressionN-expected[i][1])).toBeLessThan(1e-8);});
  expect(Math.abs(result.states[4].gapM-1e-8)).toBeLessThan(1e-12);expect(result.nativeContactSolver).toBe(false);expect(result.structuralCertification).toBe(false);
  expect(Object.isFrozen(prepared.plan.declaration)).toBe(true);
 });
 const badPlans:readonly [string,(p:NativeBoltPreloadPlan)=>unknown][]=[
  ['foreign version',p=>({...p,schema:'pointercad-native-bolt-preload-plan/2'})],
  ['unknown field',p=>({...p,torqueNm:1})],
  ['missing provenance',p=>({...p,declaration:{...p.declaration,threadCompliance:{...p.declaration.threadCompliance,source:{kind:'published',reference:'',condition:'test'}}}})],
  ['foreign bolt',p=>({...p,declaration:{...p.declaration,boltId:'foreign'}})],
  ['wrong units/shortening',p=>({...p,shorteningM:50})],
  ['nonfinite',p=>({...p,shorteningM:NaN})],
  ['unsupported member compliance',p=>({...p,declaration:{...p.declaration,memberCompliance:{...p.declaration.memberCompliance,value:5e-9}}})],
  ['wrong external order',p=>({...p,declaration:{...p.declaration,externalLoadsN:[5001,1000]}})],
  ['off-axis load',p=>({...p,boltPlan:{...p.boltPlan,contact:{...p.boltPlan.contact,nodes:p.boltPlan.contact.nodes.map((n,i)=>i===3?{...n,load:[1,1,0,0,0,0]}:n)}}})],
  ['sparse nodes',p=>({...p,boltPlan:{...p.boltPlan,contact:{...p.boltPlan.contact,nodes:Array(4)}}})],
 ];
 it.each(badPlans)('rejects input %s',async(_name,mutate)=>{await expect(prepareNativeBoltPreload(mutate(prepared.plan))).rejects.toThrow();});
 const badResults:readonly [string,(r:NativeBoltPreloadResult)=>unknown][]=[
  ['old result schema',r=>({...r,schema:'pointercad-joint-initial-strain-result/1'})],
  ['foreign input digest',r=>({...r,planSha256:'a'.repeat(64)})],
  ['unknown root field',r=>({...r,certified:true})],
  ['wrong lock',r=>({...r,lockAfterState:1})],
  ['wrong stage',r=>({...r,states:r.states.map((s,i)=>i===0?{...s,stage:'external'}:s)})],
  ['wrong bolt identity',r=>({...r,states:r.states.map((s,i)=>i===1?{...s,boltId:'other'}:s)})],
  ['nonfinite force',r=>({...r,states:r.states.map((s,i)=>i===1?{...s,boltTensionN:Infinity}:s)})],
  ['forged constitutive force',r=>({...r,states:r.states.map((s,i)=>i===1?{...s,boltTensionN:s.boltTensionN+1}:s)})],
  ['wrong energy',r=>({...r,states:r.states.map((s,i)=>i===1?{...s,memberEnergyJ:0}:s)})],
  ['foreign node',r=>({...r,contact:{...r.contact,states:r.contact.states.map((s,i)=>i===0?{...s,nodes:s.nodes.map((n,j)=>j===0?{...n,number:99}:n)}:s)}})],
  ['residual above original tolerance',r=>({...r,contact:{...r.contact,states:r.contact.states.map((s,i)=>i===1?{...s,equilibriumResidual:2e-9}:s)}})],
  ['unknown stage field',r=>({...r,states:r.states.map((s,i)=>i===1?{...s,torque:1}:s)})],
  ['unsupported native-contact claim',r=>({...r,nativeContactSolver:true})],
  ['wrong support reaction',r=>({...r,states:r.states.map((s,i)=>i===0?{...s,supportReactions:s.supportReactions.map((n,j)=>j===0?{...n,forceN:[1,0,0]}:n)}:s)})],
 ];
 it.each(badResults)('rejects result %s',(_name,mutate)=>{expect(()=>decodeNativeBoltPreload(mutate(result),prepared)).toThrow();});
 it('binds changed valid provenance into the input hash and refuses exact JSON for a different input',async()=>{
  const changed={...prepared.plan,declaration:{...prepared.plan.declaration,modelSource:{...prepared.plan.declaration.modelSource,reference:'Another explicit supported source'}}};
  const next=await prepareNativeBoltPreload(changed);expect(next.inputSha256).not.toBe(prepared.inputSha256);
  expect(()=>decodeNativeBoltPreload(actualRaw,next)).toThrow();await expect(prepareNativeBoltPreload(changed,inputBytes)).rejects.toThrow();
  expect(()=>decodeNativeBoltPreload(actualRaw,{...prepared})).toThrow();
 });
});
function programs():NativeBoltPrograms {
 const bytes=(name:string):Uint8Array=>new Uint8Array(readFileSync(fileURLToPath(new URL('../runtime/assets/'+name,import.meta.url))));
 const wheel='oofem-3.0-cp313-cp313-pyodide_2025_0_wasm32.whl';
 return {contactWrapper:bytes('beamContact.py'),boltWrapper:bytes('beamBoltContact.py'),weldWrapper:bytes('beamWeldContact.py'),jointWrapper:bytes('beamJointContact.py'),initialStrainWrapper:bytes('beamJointInitialStrain.py'),wheelBytes:bytes(wheel),wheelLocation:'https://pointercad.invalid/fem/assets/'+wheel};
}
it('candidate runtime uses only verified programs, a separate entry, exact bytes/hash and strict decoder (controlled gateway, not native)',async()=>{
 const files=new Map<string,string|Uint8Array>();const phases:string[]=[];
 const loadPackage=vi.fn(()=>Promise.resolve(undefined));
 const runtime:PyodideRuntime={version:'test-gateway',FS:{mkdirTree:vi.fn(),writeFile:(p,v)=>{files.set(p,v);}},loadPackage,runPython:vi.fn((source:string)=>{
  expect(source).toContain('run_beam_bolt_preload_stages()');expect(source).not.toContain('run_beam_joint_initial_strain()');
  const input=files.get('/pcad_fem/bolt-preload-native-input.json');if(typeof input!=='string')throw Error('Missing exact input');
  return JSON.stringify({...result,planSha256:createHash('sha256').update(input).digest('hex')});
 })};
 const token=await verifyNativeBoltPrograms(programs());const decoded=await analyzeNativeBoltPreload(runtime,prepared.plan,token,p=>phases.push(p));
 expect(decoded.states).toHaveLength(6);expect(phases).toEqual(['loading-packages','solving']);expect(files.size).toBe(6);
 expect(loadPackage).toHaveBeenCalledWith(token.wheelLocation,{checkIntegrity:true});
 const bad=programs();bad.contactWrapper[0]^=1;await expect(verifyNativeBoltPrograms(bad)).rejects.toThrow('asset-sha');
 await expect(analyzeNativeBoltPreload(runtime,prepared.plan,{wheelLocation:token.wheelLocation},()=>undefined)).rejects.toThrow('unverified-programs');
});
