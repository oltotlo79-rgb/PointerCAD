import { describe, expect, it } from 'vitest';
import type { Vector3, Vector6 } from './analysisModel.js';
import { modalFixture } from './modal.testSupport.js';
import { prepareWeldSpan } from './beamWeldSpan.js';
import { beamWeldSpanContactInputSha256, decodeBeamWeldSpanContact,
  type BeamWeldSpanContactInput } from './beamWeldSpanContact.js';
import { recoverBeamWeldSpanStress } from './beamWeldSpanStress.js';

type WeldSpanPlan = Parameters<typeof prepareWeldSpan>[0];

// Fixtures below are the unchanged independent fractions/geometry from beamWeldSpanContact.test.ts and beamWeldSpan.test.ts.
function input(segments = 1): BeamWeldSpanContactInput {
  const base = modalFixture({ free: true, modes: 1, segments });
  return { schema: 'pointercad-weld-span/1', contact: { schema: 'pointercad-beam-contact/1',
    geometry: { ...base, nodes: [0, 2, 0, 2].map((x, i) => ({ id: `n${i}`, position: [x, 0, 0] })),
      members: ['a', 'b'].map((id, i) => ({ ...base.members[0], id, componentId: id, occurrencePath: [id],
        startNodeId: `n${2*i}`, endNodeId: `n${2*i+1}` })),
      materials: [{ ...base.materials[0], youngModulus: 1000, shearModulus: 400, densityKgM3: 1 }],
      sections: [{ ...base.sections[0], area: 1, iy: .1, iz: .1, torsionConstant: .1, shearFactor: 1 }] },
    supports: [0, 1, 2, 3].map(i => ({ nodeId: `n${i}`, restrained: [i%2 === 0, true, true, true, true, true] })),
    referenceLoads: [{ id: 'load', kind: 'nodal', nodeId: 'n3', force: [1, 0, 0], moment: [0, 0, 0] }],
    contacts: [{ id: 'stop', kind: 'node-plane', nodeId: 'n3', normal: [-1, 0, 0], gapM: .01 }], loadFactors: [1] },
    patches: [{ id: 'layer', centerM: [1, 0, 0], normal: [0, 1, 0], along: [1, 0, 0], widthM: 2, lengthM: 1,
      thicknessM: .2, youngPa: 1000, poisson: .25, first: { kind: 'member-span', memberId: 'a' },
      second: { kind: 'member-span', memberId: 'b' } }] };
}
/** Independent axial coupled-system fractions, not kernel output or a native execution record.
 * K=500,C=4000/3 (one element); two-element K/C are the explicit 2x2 integral matrices. */
function raw(segments = 1) {
  const displacements = segments === 1 ? [0, 8/9500, 0, 11/9500] : [0, 76/97000, 0, 118/97000, 47/97000, 50/97000];
  const force = segments === 1 ? 12/19 : 48/97;
  const nodal = segments === 1 ? [4/19, 8/19, 0, 0] : [1/97, 29/97, 0, 0, 18/97, 0];
  const opposite = segments === 1 ? [0, 0, -4/19, -8/19] : [0, 0, -1/97, -29/97, 0, -18/97];
  const rows = displacements.map((x, i) => ({ number: i+1, displacementM: [x, 0, 0], rotationRad: [0, 0, 0] }));
  return { schema: 'pointercad-weld-span-result/1',
    contact: { schema: 'pointercad-oofem-contact-result/1', method: 'murty-least-index-lcp-on-native-beam3d-stiffness',
      freeDofs: segments === 1 ? 2 : 14, meshNodes: displacements.length, meshElements: 2*segments,
      momentLengthM: 2/segments, pivotLimit: 20,
      states: [{ loadFactor: 1, pivots: 0, forceScaleN: 1, gapScaleM: .01, equilibriumResidual: 0,
        penetration: 0, tension: 0, complementarity: 0, nodes: structuredClone(rows.slice(0, 4)),
        contacts: [{ id: 'stop', state: 'open', normalReactionN: 0, gapM: .01-displacements[3] }] }] },
    states: [{ loadFactor: 1, meshNodes: rows, welds: [{ id: 'layer',
      first: nodal.map(f => [f, 0, 0, 0, 0, 0]), second: opposite.map(f => [f, 0, 0, 0, 0, 0]),
      forceOnFirstN: [force, 0, 0], momentAtCenterNm: [0, 0, 0], energyJ: segments === 1 ? 3/45125 : 159/2352250,
      structuralCertification: false }] }] };
}
function fixture(): WeldSpanPlan {
  return { mesh: { originalNodeCount: 4,
    nodes: [0, 2, 0, 2].map((x, i) => ({ number: i+1, positionM: [x, 0, 0],
      restrained: [false, false, false, false, false, false], load: [0, 0, 0, 0, 0, 0] })),
    members: ['a', 'b'].map((id, i) => ({ number: i+1, id, componentId: id, occurrencePath: [id],
      nodes: [i*2+1, i*2+2], material: 1, section: 1,
      frame: { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], lengthM: 2 } })),
    materials: [{ number: 1, youngPa: 1000, poisson: .25, densityKgM3: 1 }],
    sections: [{ number: 1, areaM2: 1, iyM4: .1, izM4: .1, torsionM4: .1, shearFactor: 1 }],
  }, patches: [{ id: 'physical-bead', first: { kind: 'span', memberId: 'a' }, second: { kind: 'span', memberId: 'b' },
    centerM: [1, 0, 0], normal: [0, 1, 0], along: [1, 0, 0], widthM: 2, lengthM: 1,
    thicknessM: .2, youngPa: 1000, poisson: .25 }] };
}
function motions(plan: WeldSpanPlan, f: (p: Vector3, i: number) => Vector6): Vector6[] {
  return plan.mesh.nodes.map((n, i) => f(n.positionM, i));
}
const zero: Vector6 = [0, 0, 0, 0, 0, 0];
const close = (a: number, e: number, scale = Math.abs(e)) => expect(Math.abs(a-e)).toBeLessThanOrEqual(1e-9*Math.max(scale, 1e-12));
type Samples = ReturnType<ReturnType<typeof prepareWeldSpan>['evaluateStress']>[number];
// For this independent fixture n=+y, s=+x, q=-z. Area integration is in m^2; Pa*m^2=N.
function integrate(w: Samples) {
  let fx = 0, fy = 0, fz = 0, mz = 0, energy = 0;
  for (const p of w.points) {
    const a = p.areaWeightM2;
    fx += p.shearAlongPa*a; fy += p.normalPa*a; fz -= p.shearAcrossPa*a;
    mz += ((p.positionM[0]-1)*p.normalPa-p.positionM[1]*p.shearAlongPa)*a;
    energy += .2*a/2*(p.normalPa**2/1000+(p.shearAlongPa**2+p.shearAcrossPa**2)/400);
  }
  return { fx, fy, fz, mz, energy };
}

describe('elastic-layer stress at the actual long-weld quadrature points', () => {
  it.each(['normal', 'along', 'across'] as const)('uses E/t or G/t for uniform %s and preserves force/energy/schema', direction => {
    const p = fixture(), before = structuredClone(p), k = prepareWeldSpan(p);
    const q = motions(p, (_x, i) => i < 2 ? zero : [direction === 'along' ? .001 : 0, direction === 'normal' ? .001 : 0, direction === 'across' ? -.001 : 0, 0, 0, 0]);
    const old = k.evaluate(q)[0], sampled = k.evaluateStress(q)[0], integral = integrate(sampled);
    expect(sampled.points).toHaveLength(8); expect(sampled.sampling).toBe('gauss-4x2-per-cell');
    expect(sampled.structuralCertification).toBe(false);
    sampled.points.forEach(s => {
      close(s.normalPa, direction === 'normal' ? 5 : 0);
      close(s.shearAlongPa, direction === 'along' ? 2 : 0);
      close(s.shearAcrossPa, direction === 'across' ? 2 : 0);
    });
    close(sampled.points.reduce((a,s) => a+s.areaWeightM2, 0), 2);
    close(integral.fx, direction === 'along' ? 4 : 0); close(integral.fy, direction === 'normal' ? 10 : 0);
    close(integral.fz, direction === 'across' ? -4 : 0); close(integral.energy, direction === 'normal' ? 1/200 : 1/500);
    close(old.energyJ, integral.energy); expect(p).toEqual(before);
    expect(Object.keys(old)).toEqual(['id','first','second','forceOnFirstN','momentAtCenterNm','energyJ','structuralCertification']);
  });
  it.each([0, -1])('retains exact zero or reversed traction for factor %i', factor => {
    const p = fixture(), s = prepareWeldSpan(p).evaluateStress(motions(p, (_x,i) => i < 2 ? zero : [0,.001*factor,0,0,0,0]))[0];
    s.points.forEach(v => close(v.normalPa, 5*factor)); close(integrate(s).energy, factor*factor/200);
  });
  it('recovers the quadratic curvature field, not a linear wrench interpolation or an exact maximum', () => {
    const p = fixture(), k = prepareWeldSpan(p), q = motions(p, (x,i) => i < 2 ? zero : [0,.0005*x[0]**2,0,0,0,.001*x[0]]);
    const s = k.evaluateStress(q)[0], r = integrate(s);
    s.points.forEach(v => close(v.normalPa, 2.5*v.positionM[0]**2));
    close(r.fy, 20/3); close(r.mz, 10/3); close(r.energy, 1/250);
    expect(Math.max(...s.points.map(v => v.normalPa))).toBeLessThan(10);
    close(k.evaluate(q)[0].energyJ, 1/250);
  });
  it('has zero stress for an arbitrary common rigid motion at eccentric world points', () => {
    const p = fixture(); Object.assign(p.patches[0], { centerM:[1,.2,0] });
    const s = prepareWeldSpan(p).evaluateStress(motions(p,x => [.003+.002*x[2]+.004*x[1],-.001-.004*x[0]-.003*x[2],.005+.003*x[1]-.002*x[0],.003,.002,-.004]))[0];
    s.points.forEach(v => [v.normalPa,v.shearAlongPa,v.shearAcrossPa].forEach(n => close(n,0,.001)));
  });
  it('uses the actual section/span map and owns returned positions and the prepared input', () => {
    const p = fixture(); Object.assign(p.patches[0], { first:{kind:'section',node:1} });
    const k = prepareWeldSpan(p), q = motions(p,(_x,i) => i < 2 ? zero : [0,.001,0,0,0,0]);
    const s = k.evaluateStress(q)[0], expectedPosition = [...s.points[0].positionM];
    Object.assign(p.patches[0], { youngPa:1 }); Object.assign(s.points[0].positionM, { 0:99 });
    expect(k.evaluateStress(q)[0].points[0].positionM).toEqual(expectedPosition);
    close(integrate(k.evaluateStress(q)[0]).fy,10); close(k.evaluate(q)[0].first[0][5],10);
  });
  it('retains irregular physical gaps without invented sample area', () => {
    const p = fixture(), base = p.patches[0];
    Object.assign(p,{patches:[{...base,id:'left',widthM:.4,centerM:[.2,0,0]},{...base,id:'right',widthM:1.1,centerM:[1.45,0,0]}]});
    const s = prepareWeldSpan(p).evaluateStress(motions(p,(_x,i) => i < 2 ? zero : [0,.001,0,0,0,0]));
    close(s.flatMap(w=>w.points).reduce((a,v)=>a+v.areaWeightM2,0),1.5);
    close(s.reduce((a,w)=>a+integrate(w).fy,0),7.5); close(s.reduce((a,w)=>a+integrate(w).energy,0),3/800);
    expect(s.flatMap(w=>w.points).some(v=>v.positionM[0]>.4 && v.positionM[0]<.9)).toBe(false);
  });
  it('refuses missing, nonfinite and supported motion, including executable accessors', () => {
    const p = fixture(); Object.assign(p.mesh.nodes[0],{restrained:[true,false,false,false,false,false]});
    const k=prepareWeldSpan(p),q=motions(p,()=>zero);
    expect(()=>k.evaluateStress(q.slice(1))).toThrow();
    const invalid=motions(p,()=>[NaN,0,0,0,0,0]);expect(()=>k.evaluateStress(invalid)).toThrow();
    const supported=motions(p,()=>[.001,0,0,0,0,0]);expect(()=>k.evaluateStress(supported)).toThrow();
    let reads=0;Object.defineProperty(q,'0',{get(){reads++;return zero;}});expect(()=>k.evaluateStress(q)).toThrow();expect(reads).toBe(0);
  });
});

describe('input-bound long-weld stress presentation data (pure, no native execution)',()=>{
  it.each([1,2])('recovers the independent %i-element axial solution at every actual sample',async segments=>{
    const source=input(segments),hash=await beamWeldSpanContactInputSha256(source);
    const result=await decodeBeamWeldSpanContact(raw(segments),source,hash),before=structuredClone(result);
    const stress=await recoverBeamWeldSpanStress(source,result),s=stress.states[0].welds[0];
    expect(stress.inputSha256).toBe(hash);expect(stress.states[0].loadFactor).toBe(1);expect(s.points).toHaveLength(segments===1?8:16);
    for(const p of s.points){
      const x=p.positionM[0];
      // d(x)=3x/19000 (one element); 3x/97000 then (39x-36)/97000 (two elements).
      const delta=segments===1?3*x/19000:(x<1?3*x:39*x-36)/97000;
      close(p.relativeDisplacementM[0],delta);close(p.shearAlongPa,2000*delta);close(p.normalPa,0);
    }
    const sum=integrate(s);close(sum.fx,segments===1?12/19:48/97);close(sum.energy,segments===1?3/45125:159/2352250);
    expect(result).toEqual(before);
  });
  it('owns both input and full result before asynchronous digest work',async()=>{
    const source=input(2),hash=await beamWeldSpanContactInputSha256(source),result=await decodeBeamWeldSpanContact(raw(2),source,hash);
    const pending=recoverBeamWeldSpanStress(source,result);
    Object.assign(source.patches[0],{thicknessM:.3});result.states[0].meshNodes.pop();
    close(integrate((await pending).states[0].welds[0]).energy,159/2352250);
  });
  it('keeps actual factor order and reverses traction only once for a complete positive/zero/negative result',async()=>{
    const source=input(),reply=raw();Object.assign(source.contact,{loadFactors:[1,0,-1]});
    const first=reply.states[0],contact=reply.contact.states[0];
    reply.states=[1,0,-1].map(factor=>({...first,loadFactor:factor,
      meshNodes:first.meshNodes.map(n=>({...n,displacementM:n.displacementM.map(x=>x*factor),rotationRad:[0,0,0]})),
      welds:first.welds.map(w=>({...w,first:w.first.map(n=>n.map(x=>x*factor)),second:w.second.map(n=>n.map(x=>x*factor)),
        forceOnFirstN:w.forceOnFirstN.map(x=>x*factor),momentAtCenterNm:[0,0,0],energyJ:3/45125*factor*factor}))}));
    reply.contact.states=[1,0,-1].map(factor=>({...contact,loadFactor:factor,
      nodes:contact.nodes.map(n=>({...n,displacementM:n.displacementM.map(x=>x*factor),rotationRad:[0,0,0]})),
      contacts:[{...contact.contacts[0],gapM:.01-factor*11/9500}]}));
    const decoded=await decodeBeamWeldSpanContact(reply,source,await beamWeldSpanContactInputSha256(source));
    const stress=await recoverBeamWeldSpanStress(source,decoded);
    expect(stress.states.map(s=>s.loadFactor)).toEqual([1,0,-1]);
    stress.states.forEach(s=>{close(integrate(s.welds[0]).fx,s.loadFactor*12/19);close(integrate(s.welds[0]).energy,s.loadFactor**2*3/45125);});
  });
  it.each(['thickness','revision','hash','internal','factor','force','energy','extra','accessor','sparse','nan'])('rejects %s mismatch without untrusted stress',async kind=>{
    const source=input(2),hash=await beamWeldSpanContactInputSha256(source),decoded=await decodeBeamWeldSpanContact(raw(2),source,hash);
    // Negative fixtures are deliberately mutable data; the decoder's readonly vectors stay intact.
    const result={...decoded,states:decoded.states.map(s=>({...s,
      meshNodes:s.meshNodes.map(n=>({...n,displacementM:[...n.displacementM],rotationRad:[...n.rotationRad]})),
      welds:s.welds.map(w=>({...w,forceOnFirstN:[...w.forceOnFirstN]}))}))};
    let reads=0;
    switch(kind){
      case 'thickness':Object.assign(source.patches[0],{thicknessM:.3});break;
      case 'revision':Object.assign(source.contact.geometry,{revision:99});break;
      case 'hash':result.inputSha256='0'.repeat(64);break;
      case 'internal':result.states[0].meshNodes[4].displacementM[0]=0;break;
      case 'factor':result.states[0].loadFactor=2;break;
      case 'force':result.states[0].welds[0].forceOnFirstN[0]=0;break;
      case 'energy':result.states[0].welds[0].energyJ=0;break;
      case 'extra':Object.assign(result,{extra:0});break;
      case 'accessor':Object.defineProperty(result.states[0],'meshNodes',{get(){reads++;return [];},enumerable:true});break;
      case 'sparse':Reflect.deleteProperty(result.states[0].meshNodes,'4');break;
      case 'nan':result.states[0].meshNodes[4].displacementM[0]=NaN;break;
    }
    await expect(recoverBeamWeldSpanStress(source,result)).rejects.toThrow();expect(reads).toBe(0);
  });
});
