import { beamJointContactInputSha256, translateBeamJointContact, type BeamJointContactInput, type BeamJointContactResult } from './beamJointContact.js';
import { beamJointContactResultMatches } from './beamJointContactBinding.js';
import { beamJointInitialStrainInputSha256, translateBeamJointInitialStrain, type BeamJointInitialStrainInput, type BeamJointInitialStrainResult } from './beamJointInitialStrain.js';
import { beamJointInitialStrainResultMatches } from './beamJointInitialStrainBinding.js';
import type { Vector3 } from './analysisModel.js';
import { beamWeldContactInputSha256, translateBeamWeldContact,
  type BeamWeldContactInput, type BeamWeldContactResult, type BeamWeldContactPlan, type WeldLayerGeometry, type WeldLayerWrench } from './beamWeldContact.js';
import { beamWeldContactResultMatches } from './beamWeldContactBinding.js';

function dot(a: Vector3, b: Vector3): number { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
function cross(a: Vector3, b: Vector3): Vector3 {
  return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
}
function sub(a: Vector3, b: Vector3): Vector3 { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
function finite(v: Vector3): boolean { return v.length === 3 && v.every(Number.isFinite); }

/** 既存の矩形弾性層の合力から局所応力を回復する。許容応力や安全判定は補わない。 */
export function recoverWeldPatchStress(w: WeldLayerGeometry, wrench: WeldLayerWrench,
  positionAM: Vector3, positionBM: Vector3) {
  const { normal: n, along: s } = w, q = cross(n, s);
  if (w.id !== wrench.id || ![n, s, w.centerM, positionAM, positionBM, wrench.forceOnAN,
    wrench.forceOnBN, wrench.momentOnANm, wrench.momentOnBNm].every(finite)
    || ![w.widthM, w.lengthM, w.thicknessM, w.youngPa].every(v => Number.isFinite(v) && v > 1e-30 && v <= 1e30)
    || !Number.isFinite(w.poisson) || w.poisson < 0 || w.poisson >= .5
    || Math.abs(dot(n, n)-1) > 2e-10 || Math.abs(dot(s, s)-1) > 2e-10 || Math.abs(dot(n, s)) > 1e-10) {
    throw new Error('weld-stress-input');
  }
  const moment = sub(wrench.momentOnANm, cross(sub(w.centerM, positionAM), wrench.forceOnAN));
  const momentB = sub(wrench.momentOnBNm, cross(sub(w.centerM, positionBM), wrench.forceOnBN));
  const area = w.widthM*w.lengthM, is = area*w.widthM*w.widthM/12, iq = area*w.lengthM*w.lengthM/12;
  const g = w.youngPa/(2*(1+w.poisson));
  const fn = dot(wrench.forceOnAN, n), fs = dot(wrench.forceOnAN, s), fq = dot(wrench.forceOnAN, q);
  const mn = dot(moment, n), ms = dot(moment, s), mq = dot(moment, q);
  const traction = (alongM: number, acrossM: number) => ({ alongM, acrossM,
    normalPa: fn/area + ms*acrossM/iq - mq*alongM/is,
    shearAlongPa: fs/area - mn*acrossM/(is+iq),
    shearAcrossPa: fq/area + mn*alongM/(is+iq) });
  const forceScale = Math.max(Math.hypot(...wrench.forceOnAN), Math.hypot(...wrench.forceOnBN), 1e-300);
  const momentScale = Math.max(Math.hypot(...moment), Math.hypot(...momentB), forceScale*Math.max(w.widthM, w.lengthM), 1e-300);
  if (wrench.forceOnAN.some((v, i) => Math.abs(v+wrench.forceOnBN[i]) > 1e-9*forceScale)
    || moment.some((v, i) => Math.abs(v+momentB[i]) > 1e-9*momentScale)) throw new Error('weld-stress-balance');
  const corners = [-1, 1].flatMap(i => [-1, 1].map(j => traction(i*w.widthM/2, j*w.lengthM/2)));
  const points = [-1, 1].flatMap(i => [-1, 1].map(j => traction(i*w.widthM/Math.sqrt(12), j*w.lengthM/Math.sqrt(12))));
  let force: Vector3 = [0, 0, 0], torque: Vector3 = [0, 0, 0], energy = 0;
  for (const p of points) {
    const component = (i: number) => p.normalPa*n[i] + p.shearAlongPa*s[i] + p.shearAcrossPa*q[i];
    const t: Vector3 = [component(0), component(1), component(2)];
    const r: Vector3 = [p.alongM*s[0]+p.acrossM*q[0], p.alongM*s[1]+p.acrossM*q[1], p.alongM*s[2]+p.acrossM*q[2]];
    const m = cross(r, t);
    force = [force[0]+t[0]*area/4, force[1]+t[1]*area/4, force[2]+t[2]*area/4];
    torque = [torque[0]+m[0]*area/4, torque[1]+m[1]*area/4, torque[2]+m[2]*area/4];
    energy += w.thicknessM*area/8*(p.normalPa*p.normalPa/w.youngPa
      + (p.shearAlongPa*p.shearAlongPa+p.shearAcrossPa*p.shearAcrossPa)/g);
  }
  if (![area, is, iq, g, energy, ...force, ...torque,
    ...corners.flatMap(p => [p.normalPa, p.shearAlongPa, p.shearAcrossPa])].every(Number.isFinite)
    || area <= 0 || is <= 0 || iq <= 0 || g <= 0) throw new Error('weld-stress-scale');
  if (!Number.isFinite(wrench.elasticEnergyJ) || wrench.elasticEnergyJ < 0
    || Math.abs(energy-wrench.elasticEnergyJ) > 1e-9*Math.max(energy, 1e-300)) throw new Error('weld-stress-energy');
  return { id: w.id, corners, integralForceOnAN: force, integralMomentAtCenterNm: torque,
    elasticEnergyJ: energy, structuralCertification: false as const };
}

/** 現入力と完全に一致した既存結果だけを使い、保存データやWorker応答の形は増やさない。 */
export async function recoverWeldThroatStress(input: BeamWeldContactInput, result: BeamWeldContactResult) {
  const prepared = translateBeamWeldContact(input), hash = await beamWeldContactInputSha256(prepared.input);
  if (!beamWeldContactResultMatches(result, prepared.input, hash)) throw new Error('weld-stress-stale-result');
  return recoverPreparedWeldStress(prepared.plan, result.states);
}

function recoverPreparedWeldStress(plan: Pick<BeamWeldContactPlan, 'contact' | 'welds'>, states: BeamWeldContactResult['states']) {
  return states.map(state => ({ loadFactor: state.loadFactor, welds: state.welds.map((wrench, i) => {
    const w = plan.welds[i];
    const a = plan.contact.nodes.find(node => node.number === w.nodeA);
    const b = plan.contact.nodes.find(node => node.number === w.nodeB);
    if (a === undefined || b === undefined) throw new Error('weld-stress-node');
    return recoverWeldPatchStress(w, wrench, a.positionM, b.positionM);
  }) }));
}

/** 併用入力そのもののdigestと完全な結果照合を使い、weld-onlyへ付け替えない。 */
export async function recoverJointWeldThroatStress(input: BeamJointContactInput, result: BeamJointContactResult) {
  const prepared = translateBeamJointContact(input), hash = await beamJointContactInputSha256(prepared.input);
  if (!beamJointContactResultMatches(result, prepared.input, hash)) throw new Error('weld-stress-stale-result');
  return recoverPreparedWeldStress(prepared.plan, result.states);
}

/** 初期縮みはボルトだけの定義。溶接は同時に解かれた実wrenchから回復する。 */
export async function recoverInitialStrainWeldThroatStress(input: BeamJointInitialStrainInput, result: BeamJointInitialStrainResult) {
  const prepared = translateBeamJointInitialStrain(input), hash = await beamJointInitialStrainInputSha256(prepared.input);
  if (!beamJointInitialStrainResultMatches(result, prepared.input, hash)) throw new Error('weld-stress-stale-result');
  return recoverPreparedWeldStress(prepared.plan.joint, result.states);
}
