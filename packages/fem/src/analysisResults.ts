import type { BeamAnalysisDocument, BeamAnalysisResult, BeamElementResult, BeamFrame, BeamNodeResult, Vector3, Vector6 } from './analysisModel.js';
import { cross, subtract } from './analysisValidation.js';
import { translateBeamAnalysis } from './analysisTranslation.js';

function record(v: unknown): v is Record<string,unknown> { return v!==null&&typeof v==='object'&&!Array.isArray(v); }
function numeric(v: unknown): v is number { return typeof v==='number'&&Number.isFinite(v); }
function numbers(v: unknown, count: number): v is number[] { return Array.isArray(v)&&v.length===count&&v.every(numeric); }
function vec3(v: unknown): v is Vector3 { return numbers(v,3); }
function vec6(v: unknown): v is Vector6 { return numbers(v,6); }
function first(v: readonly number[], offset=0): Vector3 { return [v[offset],v[offset+1],v[offset+2]]; }
function six(v: readonly number[], offset=0): Vector6 { return [v[offset],v[offset+1],v[offset+2],v[offset+3],v[offset+4],v[offset+5]]; }
function globalVector(local: Vector3, frame: BeamFrame): Vector3 {
  const component=(index:number):number=>frame.x[index]*local[0]+frame.y[index]*local[1]+frame.z[index]*local[2];
  return [component(0),component(1),component(2)];
}
function frame(v: unknown): v is BeamFrame {
  return record(v)&&vec3(v.x)&&vec3(v.y)&&vec3(v.z)&&numeric(v.lengthM)&&v.lengthM>0;
}
function source(v: unknown): boolean {
  return record(v)&&typeof v.documentId==='string'&&typeof v.geometryRevision==='string'
    &&numeric(v.documentRevision)&&Number.isSafeInteger(v.documentRevision)&&v.documentRevision>=0;
}
export function isBeamAnalysisResult(value: unknown): value is BeamAnalysisResult {
  if(!record(value)||value.kind!=='oofem-linear-beam-3d'||value.model!=='linear-timoshenko-isotropic'
    ||value.structuralCertification!==false||typeof value.analysisId!=='string'||!numeric(value.analysisRevision)
    ||!Number.isSafeInteger(value.analysisRevision)||value.analysisRevision<0||!source(value.source)
    ||typeof value.inputSha256!=='string'||!/^[0-9a-f]{64}$/u.test(value.inputSha256)
    ||!Array.isArray(value.nodes)||value.nodes.length<2||value.nodes.length>256
    ||!Array.isArray(value.elements)||value.elements.length===0||value.elements.length>512
    ||!record(value.balance)||!vec3(value.balance.referenceM)||!vec3(value.balance.forceN)||!vec3(value.balance.momentNm)
    ||!numeric(value.balance.maximumFreeResidual)||value.balance.maximumFreeResidual<0) return false;
  return value.nodes.every(n=>record(n)&&typeof n.nodeId==='string'&&numeric(n.solverNode)&&Number.isSafeInteger(n.solverNode)
    &&vec3(n.displacementM)&&vec3(n.rotationRad)&&vec3(n.reactionN)&&vec3(n.reactionNm)&&typeof n.constrained==='boolean')
    &&value.elements.every(e=>record(e)&&typeof e.memberId==='string'&&typeof e.componentId==='string'
      &&Array.isArray(e.occurrencePath)&&e.occurrencePath.every(p=>typeof p==='string')
      &&numeric(e.solverElement)&&Number.isSafeInteger(e.solverElement)&&Array.isArray(e.nodeIds)
      &&e.nodeIds.length===2&&e.nodeIds.every(id=>typeof id==='string')&&frame(e.frame)&&vec6(e.start)&&vec6(e.end));
}
/** Native forces are assembled, never recomputed with a second FE stiffness solver. */
export function decodeBeamAnalysis(raw: unknown, document: BeamAnalysisDocument, inputSha256: string): BeamAnalysisResult {
  if(!/^[0-9a-f]{64}$/u.test(inputSha256)) throw new Error('Invalid input digest');
  const {plan}=translateBeamAnalysis(document);
  if(!record(raw)||raw.schema!=='pointercad-oofem-beam-result/1'||!Array.isArray(raw.nodes)||!Array.isArray(raw.elements)
    ||raw.nodes.length!==plan.nodes.length||raw.elements.length!==plan.members.length) throw new Error('Invalid OOFEM result size/schema');
  const unknowns=new Map<number,Vector6>();
  for(const row of raw.nodes){
    if(!record(row)||!numeric(row.number)||!Number.isSafeInteger(row.number)||unknowns.has(row.number)
      ||!plan.nodes.some(n=>n.number===row.number)||!vec6(row.unknowns)) throw new Error('Invalid OOFEM node association/unknowns');
    unknowns.set(row.number,row.unknowns);
  }
  const forces=new Map<number,number[]>(plan.nodes.map(n=>[n.number,[0,0,0,0,0,0]]));
  const seen=new Set<number>();
  const elements:BeamElementResult[]=[];
  for(const row of raw.elements){
    if(!record(row)||!numeric(row.number)||seen.has(row.number)||!numbers(row.nodes,2)||!numbers(row.localEndForces,12)) throw new Error('Invalid OOFEM element output');
    const member=plan.members.find(m=>m.number===row.number);
    if(!member||row.nodes[0]!==member.nodes[0]||row.nodes[1]!==member.nodes[1]) throw new Error('OOFEM element connectivity differs');
    seen.add(row.number);
    const start=six(row.localEndForces),end=six(row.localEndForces,6);
    for(const [index,local] of [[0,start],[1,end]] as const){
      const total=forces.get(member.nodes[index]);
      if(!total) throw new Error('Missing native node assembly');
      const force=globalVector(first(local),member.frame),moment=globalVector(first(local,3),member.frame);
      for(let axis=0;axis<3;axis++){total[axis]+=force[axis];total[axis+3]+=moment[axis];}
    }
    const a=plan.nodes.find(n=>n.number===member.nodes[0]),b=plan.nodes.find(n=>n.number===member.nodes[1]);
    if(!a||!b) throw new Error('Missing translated node');
    elements.push({memberId:member.id,componentId:member.componentId,occurrencePath:member.occurrencePath,
      solverElement:member.number,nodeIds:[a.id,b.id],frame:member.frame,start,end});
  }
  elements.sort((a,b)=>a.solverElement-b.solverElement);
  const referenceM=plan.nodes[0].positionM;
  const span=Math.max(1e-9,...plan.nodes.map(n=>Math.hypot(...subtract(n.positionM,referenceM))));
  const forceScale=Math.max(1,plan.nodes.reduce((s,n)=>s+Math.hypot(...first(n.load))+Math.hypot(...first(n.load,3))/span,0));
  const momentScale=Math.max(1,plan.nodes.reduce((s,n)=>s+Math.hypot(...first(n.load,3))+Math.hypot(...first(n.load))*span,0));
  const balanceForce=[0,0,0],balanceMoment=[0,0,0];
  let maximumFreeResidual=0;
  const nodes:BeamNodeResult[]=plan.nodes.map(node=>{
    const native=forces.get(node.number),u=unknowns.get(node.number);
    if(!native||!u) throw new Error('Missing native node result');
    const residual=native.map((v,i)=>v-node.load[i]);
    if(residual.some(v=>!Number.isFinite(v))) throw new Error('Non-finite reaction assembly');
    if(node.fixed){
      if(u.some(v=>v!==0)) throw new Error('OOFEM fixed constraint was not satisfied');
    }else{
      const error=Math.max(Math.hypot(...first(residual))/forceScale,Math.hypot(...first(residual,3))/momentScale);
      maximumFreeResidual=Math.max(maximumFreeResidual,error);
      if(error>1e-7) throw new Error('OOFEM free-node equilibrium residual exceeds relative tolerance');
    }
    const effectiveForce=first(node.load).map((v,i)=>v+(node.fixed?residual[i]:0));
    const effectiveMoment=first(node.load,3).map((v,i)=>v+(node.fixed?residual[i+3]:0));
    const armMoment=cross(subtract(node.positionM,referenceM),first(effectiveForce));
    for(let i=0;i<3;i++){balanceForce[i]+=effectiveForce[i];balanceMoment[i]+=effectiveMoment[i]+armMoment[i];}
    return {nodeId:node.id,solverNode:node.number,displacementM:first(u),rotationRad:first(u,3),
      reactionN:first(residual),reactionNm:first(residual,3),constrained:node.fixed};
  });
  if(Math.hypot(...balanceForce)>1e-7*forceScale||Math.hypot(...balanceMoment)>1e-7*momentScale) throw new Error('OOFEM reaction/load balance failed');
  return {kind:'oofem-linear-beam-3d',model:'linear-timoshenko-isotropic',analysisId:document.id,
    analysisRevision:document.revision,source:document.source,inputSha256,nodes,elements,
    balance:{referenceM,forceN:first(balanceForce),momentNm:first(balanceMoment),maximumFreeResidual},structuralCertification:false};
}
/** Check provenance, input digest, native association and independently reassembled balance at the receiving boundary. */
export function beamResultMatches(value: unknown, document: BeamAnalysisDocument, inputSha256: string): value is BeamAnalysisResult {
  if(!isBeamAnalysisResult(value)) return false;
  try{
    const expected=translateBeamAnalysis(document).plan;
    const raw={schema:'pointercad-oofem-beam-result/1',nodes:value.nodes.map(n=>({number:n.solverNode,unknowns:[...n.displacementM,...n.rotationRad]})),
      elements:value.elements.map(e=>{
        const member=expected.members.find(m=>m.number===e.solverElement);
        return {number:e.solverElement,nodes:member?.nodes,localEndForces:[...e.start,...e.end]};
      })};
    return JSON.stringify(value)===JSON.stringify(decodeBeamAnalysis(raw,document,inputSha256));
  }catch{return false;}
}
