import type { AnalysisMaterialCapacity, BeamAnalysisDocument, BeamFrame, Vector3, Vector6 } from './analysisModel.js';
import { beamFrame, readBeamAnalysis, scale, serializeBeamAnalysis } from './analysisValidation.js';

export interface OofemBeamPlan {
  readonly schema: 'pointercad-oofem-beam-plan/1';
  readonly nodes: readonly { readonly number: number; readonly id: string; readonly positionM: Vector3;
    readonly fixed: boolean; readonly load: Vector6 }[];
  readonly materials: readonly { readonly number: number; readonly youngPa: number; readonly poisson: number; readonly densityKgM3: number;
    readonly capacity?: AnalysisMaterialCapacity }[];
  readonly sections: readonly { readonly number: number; readonly areaM2: number; readonly iyM4: number; readonly izM4: number;
    readonly torsionM4: number; readonly shearFactor: number }[];
  readonly members: readonly { readonly number: number; readonly id: string; readonly componentId: string;
    readonly occurrencePath: readonly string[]; readonly nodes: readonly [number,number]; readonly material: number;
    readonly section: number; readonly frame: BeamFrame }[];
}
function finitePositive(value: number): number {
  if (!Number.isFinite(value) || value <= 1e-30 || value > 1e30) throw new Error('numeric-range: unsupported normalized stiffness/section scale');
  return value;
}
/** Sorted numeric ids are generated internally. No user text becomes Python or an input keyword. */
export function translateBeamAnalysis(value: unknown): { readonly document: BeamAnalysisDocument; readonly plan: OofemBeamPlan } {
  const checked=readBeamAnalysis(value);
  if(!checked.ok) throw new Error(checked.issue.code+': '+checked.issue.path+': '+checked.issue.message);
  const document=checked.document;
  const length=document.units==='N-mm'?0.001:1;
  const area=length*length, inertia=area*area;
  const order=<T extends {readonly id:string}>(values:readonly T[]):T[]=>[...values].sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  const nodeOrder=order(document.nodes), materialOrder=order(document.materials), sectionOrder=order(document.sections);
  const nodeNumber=new Map(nodeOrder.map((v,i)=>[v.id,i+1]));
  const materialNumber=new Map(materialOrder.map((v,i)=>[v.id,i+1]));
  const sectionNumber=new Map(sectionOrder.map((v,i)=>[v.id,i+1]));
  const nodeMap=new Map(nodeOrder.map(v=>[v.id,v]));
  const clamped=new Set(document.constraints.map(c=>c.nodeId));
  const plan:OofemBeamPlan={schema:'pointercad-oofem-beam-plan/1',nodes:nodeOrder.map((node,i)=>{
    const positionM=scale(node.position,length);
    if(positionM.some(v=>!Number.isFinite(v)||Math.abs(v)>1e9)) throw new Error('numeric-range: coordinates exceed supported metre range');
    const loads=document.loads.filter(load=>load.nodeId===node.id);
    const sum=(index:number):number=>loads.reduce((total,item)=>total+(index<3?item.force[index]:item.moment[index-3]*length),0);
    const load:Vector6=[sum(0),sum(1),sum(2),sum(3),sum(4),sum(5)];
    if(load.some(v=>!Number.isFinite(v)||Math.abs(v)>1e30)) throw new Error('numeric-range: combined load exceeds supported range');
    return {number:i+1,id:node.id,positionM,fixed:clamped.has(node.id),load};
  }),materials:materialOrder.map((m,i)=>{
    finitePositive(m.shearModulus/area);
    return {number:i+1,youngPa:finitePositive(m.youngModulus/area),
      poisson:m.youngModulus/(2*m.shearModulus)-1,densityKgM3:finitePositive(m.densityKgM3),
      ...(m.capacity === undefined ? {} : { capacity: { ...m.capacity } })};
  }),
  sections:sectionOrder.map((s,i)=>({number:i+1,areaM2:finitePositive(s.area*area),iyM4:finitePositive(s.iy*inertia),
    izM4:finitePositive(s.iz*inertia),torsionM4:finitePositive(s.torsionConstant*inertia),shearFactor:finitePositive(s.shearFactor)})),
  members:order(document.members).map((member,i)=>{
    const a=nodeMap.get(member.startNodeId),b=nodeMap.get(member.endNodeId);
    const na=nodeNumber.get(member.startNodeId),nb=nodeNumber.get(member.endNodeId),
      material=materialNumber.get(member.materialId),section=sectionNumber.get(member.sectionId);
    if(!a||!b||na===undefined||nb===undefined||material===undefined||section===undefined) throw new Error('Missing validated reference');
    return {number:i+1,id:member.id,componentId:member.componentId,occurrencePath:[...member.occurrencePath],nodes:[na,nb],
      material,section,frame:beamFrame(a.position,b.position,member.localYHint,length)};
  })};
  return {document,plan};
}
export async function beamInputSha256(value: unknown): Promise<string> {
  const bytes=new TextEncoder().encode(serializeBeamAnalysis(value));
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
