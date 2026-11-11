import assert from 'node:assert/strict';
import type { BeamAnalysisDocument, Vector3 } from './analysisModel.js';
import { readBeamAnalysis, serializeBeamAnalysis } from './analysisValidation.js';
import { beamInputSha256, translateBeamAnalysis } from './analysisTranslation.js';
import { decodeBeamAnalysis } from './analysisResults.js';
import { findStrengthMaterial, STRENGTH_SOURCES } from '@pointercad/model';

const evidence={kind:'user-supplied',reference:'Independent analytic test constants; no material grade inference',condition:'Linear isotropic test material at a fixed reference condition'} as const;
export function cantilever(options:{readonly mode?:'axial'|'y'|'z'|'torsion';readonly rotated?:boolean;
  readonly millimetres?:boolean;readonly forceMultiplier?:number;readonly split?:boolean}={}):BeamAnalysisDocument{
  const unit=options.millimetres?1000:1;
  const x:Vector3=options.rotated?[0,1,0]:[1,0,0];
  const y:Vector3=options.rotated?[0,0,1]:[0,1,0];
  const z:Vector3=options.rotated?[1,0,0]:[0,0,1];
  const mode=options.mode??'y';
  const direction=mode==='axial'||mode==='torsion'?x:mode==='z'?z:y;
  const magnitude=(mode==='torsion'?200:4000)*(options.forceMultiplier??1);
  const force:Vector3=mode==='torsion'?[0,0,0]:[direction[0]*magnitude,direction[1]*magnitude,direction[2]*magnitude];
  const moment:Vector3=mode==='torsion'?[direction[0]*magnitude*unit,direction[1]*magnitude*unit,direction[2]*magnitude*unit]:[0,0,0];
  const member={id:'member-tip',componentId:'component-tip',occurrencePath:['assembly-a','component-tip'],startNodeId:options.split?'middle':'base',
    endNodeId:'tip',materialId:'elastic',sectionId:'section',localYHint:y};
  return {schema:'pointercad-beam/1',id:'analytic-cantilever',revision:0,
    source:{documentId:'cad-session-a',documentRevision:7,geometryRevision:'geometry-generation-12'},units:options.millimetres?'N-mm':'N-m',
    nodes:[{id:'tip',position:[2*x[0]*unit,2*x[1]*unit,2*x[2]*unit]},
      ...(options.split?[{id:'middle',position:[x[0]*unit,x[1]*unit,x[2]*unit] as Vector3}]:[]),{id:'base',position:[0,0,0]}],
    members:[member,...(options.split?[{...member,id:'member-base',componentId:'component-base',occurrencePath:['assembly-a','component-base'],startNodeId:'base',endNodeId:'middle'}]:[])],
    materials:[{id:'elastic',youngModulus:208e9/(unit*unit),shearModulus:80e9/(unit*unit),densityKgM3:7850,source:evidence}],
    sections:[{id:'section',area:0.003*unit**2,iy:2e-6*unit**4,iz:5e-6*unit**4,torsionConstant:3e-6*unit**4,shearFactor:5/6,source:evidence}],
    constraints:[{id:'clamp',kind:'fixed',nodeId:'base'}],loads:[{id:'tip-load',kind:'nodal',nodeId:'tip',force,moment}]};
}
export async function analysisInputChecks():Promise<string[]>{
  const base=cantilever(); const checks:string[]=[];
  function reject(label:string,value:unknown,code:string):void{
    const result=readBeamAnalysis(value); assert.equal(result.ok,false,label);
    if(!result.ok) assert.equal(result.issue.code,code,label);
    checks.push(label);
  }
  reject('unsupported units rejected',{...base,units:'kip-inch'},'unsupported-model');
  reject('non-finite coordinate rejected',{...base,nodes:[{id:'base',position:[NaN,0,0]},base.nodes[0]]},'number');
  reject('duplicate node id rejected',{...base,nodes:[...base.nodes,base.nodes[0]]},'duplicate-id');
  reject('duplicate member id rejected',{...base,members:[...base.members,base.members[0]]},'duplicate-id');
  reject('duplicate occurrence rejected',{...base,members:[...base.members,{...base.members[0],id:'another'}]},'duplicate-component');
  reject('duplicate load id rejected',{...base,loads:[...base.loads,base.loads[0]]},'duplicate-id');
  reject('missing node rejected',{...base,members:[{...base.members[0],endNodeId:'absent'}]},'missing-reference');
  reject('missing material rejected',{...base,members:[{...base.members[0],materialId:'absent'}]},'missing-reference');
  reject('coincident distinct nodes rejected as zero length',{...base,nodes:base.nodes.map(n=>({...n,position:[0,0,0]}))},'zero-length');
  reject('parallel local orientation rejected',{...base,members:[{...base.members[0],localYHint:[1,0,0]}]},'orientation');
  reject('unclamped component rejected',{...base,constraints:[]},'unconstrained-component');
  reject('duplicate clamp rejected',{...base,constraints:[...base.constraints,{...base.constraints[0],id:'another'}]},'duplicate-constraint');
  reject('zero-equation system explicitly refused',{...base,constraints:[...base.constraints,{id:'tip-clamp',kind:'fixed',nodeId:'tip'}]},'no-free-dofs');
  reject('unsupported release rejected',{...base,constraints:[{...base.constraints[0],kind:'pin'}]},'constraint');
  reject('unsupported distributed load rejected',{...base,loads:[{...base.loads[0],kind:'distributed'}]},'load');
  reject('inconsistent elastic constants rejected',{...base,materials:[{...base.materials[0],shearModulus:1}]},'isotropy');
  reject('missing material condition rejected',{...base,materials:[{...base.materials[0],source:{...evidence,condition:''}}]},'text');
  reject('nonpositive inertia rejected',{...base,sections:[{...base.sections[0],iy:0}]},'number');
  reject('unsupported shear factor rejected',{...base,sections:[{...base.sections[0],shearFactor:1e18}]},'shear-factor');
  reject('arbitrary solver program refused',{...base,python:'import os'},'shape');
  reject('coincident members are not auto welded',{...base,nodes:[...base.nodes,{id:'base2',position:[0,0,0]},{id:'tip2',position:[2,0,0]}],
    members:[...base.members,{...base.members[0],id:'member2',componentId:'component2',occurrencePath:['component2'],startNodeId:'base2',endNodeId:'tip2'}]},'unconstrained-component');
  const encoded=serializeBeamAnalysis(base);
  const roundTrip:unknown=JSON.parse(encoded);
  assert.equal(serializeBeamAnalysis(roundTrip),encoded);
  const first=translateBeamAnalysis(base),second=translateBeamAnalysis(roundTrip);
  assert.deepEqual(first.plan,second.plan);
  assert.equal(first.plan.nodes[0].id,'base');
  assert.equal(first.plan.nodes[1].id,'tip');
  const mm=translateBeamAnalysis(cantilever({millimetres:true}));
  assert.deepEqual(mm.plan.nodes,first.plan.nodes);
  for(const key of ['areaM2','iyM4','izM4','torsionM4','shearFactor'] as const){
    assert(Math.abs(mm.plan.sections[0][key]-first.plan.sections[0][key])<=1e-14*Math.abs(first.plan.sections[0][key]));
  }
  for(const key of ['youngPa','poisson','densityKgM3'] as const){
    assert(Math.abs(mm.plan.materials[0][key]-first.plan.materials[0][key])<=1e-14*Math.max(1,Math.abs(first.plan.materials[0][key])));
  }
  assert.deepEqual(mm.plan.members,first.plan.members);
  const caller=cantilever();const owned=translateBeamAnalysis(caller).document;
  assert.notEqual(owned.nodes,caller.nodes);assert.notEqual(owned.materials[0].source,caller.materials[0].source);
  checks.push('stable serialization, internal numeric associations, N-mm to SI equivalence and owned snapshot');
  const hash=await beamInputSha256(base);
  assert.notEqual(await beamInputSha256(cantilever({forceMultiplier:2})),hash);
  assert.throws(()=>decodeBeamAnalysis({schema:'pointercad-oofem-beam-result/1',nodes:[],elements:[]},base,hash));
  checks.push('changed load changes cryptographic input identity; empty native output rejected');
  await analysisCapacityChecks(checks);
  return checks;
}

async function analysisCapacityChecks(checks: string[]): Promise<void> {
  const rows = [
    ['ss400-plate-0-16', 245, 'jisf-g3101-draft', 16],
    ['ss400-plate-16-40', 235, 'jisf-g3101-draft', 40],
    ['ss400-plate-40-100', 215, 'jisf-g3101-draft', 100],
    ['s45c-normalized-reference', 345, 'tsubaki-s45c', null],
    ['s45c-quenched-tempered-reference', 490, 'tsubaki-s45c', null],
  ] as const;
  for (const [materialConditionId, yieldMPa, sourceId, thicknessMm] of rows) {
    const preset = findStrengthMaterial(materialConditionId); assert(preset);
    const capacity = { materialConditionId, yieldMPa, sourceId, thicknessMm, condition: preset.condition,
      evidence: STRENGTH_SOURCES[sourceId].evidence, basis: preset.yieldStress.basis };
    assert.equal(String(yieldMPa), preset.yieldStress.mpa);
    assert.equal(sourceId, preset.yieldStress.sourceId);
    for (const millimetres of [false, true]) {
      const base = cantilever({ millimetres });
      const value = { ...base, materials: base.materials.map(material => ({ ...material, capacity })) };
      const translated = translateBeamAnalysis(value), elastic = translateBeamAnalysis(base);
      assert.deepEqual(translated.plan.materials[0].capacity, capacity);
      assert.notEqual(translated.plan.materials[0].capacity, capacity);
      assert.notEqual(translated.plan.materials[0].capacity, translated.document.materials[0].capacity);
      assert.deepEqual(translated.plan.nodes, elastic.plan.nodes);
      assert.deepEqual(translated.plan.members, elastic.plan.members);
      assert.deepEqual(translated.plan.sections, elastic.plan.sections);
      const { capacity: carried, ...constants } = translated.plan.materials[0];
      assert.deepEqual(constants, elastic.plan.materials[0]);
      assert.equal(carried?.yieldMPa, yieldMPa);
      assert.equal(carried?.sourceId, sourceId);
      if (sourceId === 'tsubaki-s45c') {
        assert.equal(carried?.evidence, 'manufacturer-reference');
        assert.equal(carried?.basis, 'reference');
      }
      const reopened: unknown = JSON.parse(serializeBeamAnalysis(value));
      assert.deepEqual(translateBeamAnalysis(reopened).plan, translated.plan);
      assert.notEqual(await beamInputSha256(value), await beamInputSha256(base));
      for (const [invalid, code] of [
        [{ ...capacity, sourceId: undefined }, 'material-capacity-source-missing'],
        [{ ...capacity, condition: 'different treatment' }, 'material-capacity-condition-mismatch'],
        ...(thicknessMm === null ? [] : [[{ ...capacity, thicknessMm: 101 }, 'material-capacity-thickness-outside']] as const),
      ] as const) {
        const before = serializeBeamAnalysis(value);
        assert.throws(() => translateBeamAnalysis({ ...value,
          materials: value.materials.map(material => ({ ...material, capacity: invalid })) }), error => error instanceof Error && error.message.startsWith(code));
        assert.equal(serializeBeamAnalysis(value), before);
      }
    }
    checks.push(`yield/source preserved in both beam unit systems: ${materialConditionId}`);
  }
  for (const [thicknessMm, lowerId, lowerYield, upperId, upperYield] of [
    [16, 'ss400-plate-0-16', 245, 'ss400-plate-16-40', 235],
    [40, 'ss400-plate-16-40', 235, 'ss400-plate-40-100', 215],
  ] as const) {
    for (const millimetres of [false, true]) {
      const base = cantilever({ millimetres });
      const makeInput = (materialConditionId: string, yieldMPa: number, thickness: number) => {
        const preset = findStrengthMaterial(materialConditionId); assert(preset);
        return { ...base, materials: base.materials.map(material => ({ ...material,
          capacity: { materialConditionId, yieldMPa, sourceId: 'jisf-g3101-draft', thicknessMm: thickness,
            condition: preset.condition, evidence: 'standard-draft', basis: 'minimum' } })) };
      };
      const lower = makeInput(lowerId, lowerYield, thicknessMm);
      assert.equal(translateBeamAnalysis(lower).plan.materials[0].capacity?.yieldMPa, lowerYield);
      const rejected = makeInput(upperId, upperYield, thicknessMm), before = structuredClone(rejected);
      assert.throws(() => translateBeamAnalysis(rejected), error => error instanceof Error
        && error.message.startsWith('material-capacity-thickness-outside'));
      assert.deepEqual(rejected, before);
      const above = translateBeamAnalysis(makeInput(upperId, upperYield, thicknessMm + 0.001)).plan.materials[0].capacity;
      assert.equal(above?.yieldMPa, upperYield);
      assert.equal(above?.thicknessMm, thicknessMm + 0.001);
      assert.equal(above?.materialConditionId, upperId);
    }
    checks.push(`inclusive SS400 boundary and exclusive next band in both beam units: ${thicknessMm} mm`);
  }
  assert.equal(Object.hasOwn(translateBeamAnalysis(cantilever()).plan.materials[0], 'capacity'), false);
}
