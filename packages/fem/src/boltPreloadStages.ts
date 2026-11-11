import type { PropertySource } from './analysisModel.js';
import { translateBeamJointInitialStrain } from './beamJointInitialStrain.js';

import type { BoltPreloadDeclaration } from '@pointercad/model/beam-analysis';
export type { BoltPreloadDeclaration } from '@pointercad/model/beam-analysis';
type SourcedNumber = BoltPreloadDeclaration['preloadN'];
export interface BoltPreloadState {
  readonly externalLoadN: number;
  readonly boltTensionN: number;
  readonly memberCompressionN: number;
  /** Signed member-port displacement from its uncompressed length; positive after separation. */
  readonly portDisplacementM: number;
  readonly gapM: number;
  readonly state: 'clamped' | 'separation' | 'separated';
  readonly elasticEnergyJ: number;
}
function fields(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new Error('preload-shape');
  }
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > limit || value.trim() !== value
    || [...value].some(c => c.charCodeAt(0) < 32)) throw new Error('preload-source');
  return value;
}
function source(value: unknown): PropertySource {
  const row = fields(value, ['kind', 'reference', 'condition']);
  if (row.kind !== 'user-supplied' && row.kind !== 'measured' && row.kind !== 'published') throw new Error('preload-source');
  return { kind: row.kind, reference: text(row.reference, 2048), condition: text(row.condition, 1024) };
}
function numeric(value: unknown, positive = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e30
    || (positive && value <= 0)) throw new Error('preload-number');
  return value === 0 ? 0 : value;
}
function sourced(value: unknown, positive = false): SourcedNumber {
  const row = fields(value, ['value', 'source']);
  return { value: numeric(row.value, positive), source: source(row.source) };
}
function declaration(value: unknown): BoltPreloadDeclaration {
  const row = fields(value, ['boltId', 'model', 'modelSource', 'shankSource', 'shorteningSource', 'preloadN',
    'threadCompliance', 'headCompliance', 'bearingCompliance', 'memberCompliance', 'externalLoadsN', 'loadSource']);
  if (row.model !== 'coaxial-outer-planes-series-bearing') throw new Error('preload-model');
  const loads = row.externalLoadsN;
  if (!Array.isArray(loads) || loads.length < 1 || loads.length > 32
    || Reflect.ownKeys(loads).length !== loads.length + 1
    || Array.from({ length: loads.length }, (_, i) => !Object.hasOwn(loads, i)).some(Boolean)) throw new Error('preload-load-count');
  return { boltId: text(row.boltId, 64), model: row.model, modelSource: source(row.modelSource),
    shankSource: source(row.shankSource), shorteningSource: source(row.shorteningSource),
    preloadN: sourced(row.preloadN), threadCompliance: sourced(row.threadCompliance),
    headCompliance: sourced(row.headCompliance), bearingCompliance: sourced(row.bearingCompliance),
    memberCompliance: sourced(row.memberCompliance, true), externalLoadsN: loads.map(v => numeric(v)),
    loadSource: source(row.loadSource) };
}

/** Analytic selected-bolt reduction, NOT an OOFEM/contact result or an adapter to its decoder.
 * The old joint input is validated and retained; only the identified shank geometry/E/A/shortening
 * feed this explicitly sourced reduction. Its weld/contact/beam system is NOT solved here.
 * Preparation prescribes stress-free shortening; tightening equilibrates at zero external load;
 * external steps retain that same shortening (no force-control reset on load or unload).
 */
export function calculateBoltPreloadStages(value: unknown, assumptions: unknown) {
  const prepared = translateBeamJointInitialStrain(value), declared = declaration(assumptions);
  const index = prepared.plan.joint.bolts.findIndex(bolt => bolt.id === declared.boltId);
  if (index < 0) throw new Error('preload-bolt-identity');
  const bolt = prepared.plan.joint.bolts[index];
  const a = prepared.plan.joint.contact.nodes[bolt.nodeA - 1].positionM;
  const b = prepared.plan.joint.contact.nodes[bolt.nodeB - 1].positionM;
  const lengthM = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const shankCompliance = numeric(lengthM / (bolt.youngPa * bolt.areaM2), true);
  const boltCompliance = numeric(shankCompliance + declared.threadCompliance.value
    + declared.headCompliance.value + declared.bearingCompliance.value, true);
  const memberCompliance = declared.memberCompliance.value;
  const totalCompliance = numeric(boltCompliance + memberCompliance, true);
  const shorteningM = prepared.plan.shortenings[index].shorteningM;
  const requiredShorteningM = numeric(declared.preloadN.value * totalCompliance, declared.preloadN.value > 0);
  // Input-consistency tolerance, not an accuracy acceptance relaxation or a fitted preload.
  if (requiredShorteningM >= lengthM
    || Math.abs(shorteningM - requiredShorteningM) > 1e-9 * Math.max(shorteningM, requiredShorteningM)) {
    throw new Error('preload-shortening-force-mismatch');
  }
  const equilibratedPreloadN = numeric(shorteningM / totalCompliance, shorteningM > 0);
  const separationLoadN = numeric(shorteningM / boltCompliance, shorteningM > 0);
  const loadFraction = numeric(memberCompliance / totalCompliance, true);
  function state(externalLoadN: number): BoltPreloadState {
    // Closed-form complementarity: N-Q=P, x=cb*N-s, Q=max(-x/cm,0).
    const closed = externalLoadN < separationLoadN;
    const memberCompressionN = closed ? numeric((separationLoadN - externalLoadN) * boltCompliance / totalCompliance) : 0;
    const boltTensionN = numeric(externalLoadN + memberCompressionN);
    const portDisplacementM = closed ? -memberCompliance * memberCompressionN
      : numeric(boltCompliance * (externalLoadN - separationLoadN));
    const elasticEnergyJ = numeric((boltCompliance * boltTensionN * boltTensionN
      + memberCompliance * memberCompressionN * memberCompressionN) / 2);
    if (!Number.isFinite(portDisplacementM)) throw new Error('preload-response');
    return { externalLoadN, boltTensionN, memberCompressionN, portDisplacementM,
      gapM: closed ? 0 : portDisplacementM,
      state: closed ? 'clamped' : externalLoadN === separationLoadN ? 'separation' : 'separated', elasticEnergyJ };
  }
  return { kind: 'analytic-selected-bolt-preload' as const, structuralCertification: false as const,
    input: prepared.input, declaration: declared, boltId: bolt.id,
    compliancesMPerN: { shank: shankCompliance, bolt: boltCompliance, member: memberCompliance },
    loadFraction, separationLoadN, equilibratedPreloadN,
    preparation: { kind: 'prescribed-shortening' as const, shorteningM, equilibriumSolved: false as const },
    tightening: state(0), external: declared.externalLoadsN.map(state) };
}
