import { beamWeldSpanContactInputSha256, translateBeamWeldSpanContact,
  type BeamWeldSpanContactInput } from './beamWeldSpanContact.js';
import { beamWeldSpanContactResultMatches, isBeamWeldSpanContactResult } from './beamWeldSpanContactBinding.js';
import { prepareWeldSpan } from './beamWeldSpan.js';
import type { Vector6 } from './analysisModel.js';

/** Own plain result data before the first await, without executing an accessor.
 * Limits match the existing complete-result binding; no raw reply shape is extended. */
function snapshotResult(value: unknown): unknown {
  let budget = 4_000_000;
  function check(v: unknown, depth: number): void {
    if (--budget < 0 || depth > 24) throw new Error('weld-span-stress-data');
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || Math.abs(v) > 1e30) throw new Error('weld-span-stress-data');
      return;
    }
    if (typeof v !== 'object') throw new Error('weld-span-stress-data');
    if (Array.isArray(v)) {
      if (Object.getPrototypeOf(v) !== Array.prototype || v.length > 4096 || Reflect.ownKeys(v).length !== v.length+1) {
        throw new Error('weld-span-stress-data');
      }
      for (let i = 0; i < v.length; i++) {
        const d = Object.getOwnPropertyDescriptor(v, i);
        if (d === undefined || !('value' in d) || !d.enumerable) throw new Error('weld-span-stress-data');
        check(d.value, depth+1);
      }
      return;
    }
    if (Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error('weld-span-stress-data');
    for (const key of Reflect.ownKeys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (typeof key !== 'string' || d === undefined || !('value' in d) || !d.enumerable) throw new Error('weld-span-stress-data');
      check(d.value, depth+1);
    }
  }
  check(value, 0);
  return structuredClone(value);
}

/** Input-bound elastic-layer Gauss samples in Pa; not a toe/surface maximum, allowable stress or safety factor.
 * The UI must still invalidate an awaited result on document/owner/generation changes. */
export async function recoverBeamWeldSpanStress(value: BeamWeldSpanContactInput, result: unknown) {
  const prepared = translateBeamWeldSpanContact(value), owned = snapshotResult(result);
  const hash = await beamWeldSpanContactInputSha256(prepared.input);
  if (!isBeamWeldSpanContactResult(owned) || !await beamWeldSpanContactResultMatches(owned, prepared.input, hash)) {
    throw new Error('weld-span-stress-stale-result');
  }
  const { nodes, members, materials, sections, originalNodeCount } = prepared.plan.contact;
  const kernel = prepareWeldSpan({ mesh: { nodes, members, materials, sections, originalNodeCount }, patches: prepared.plan.patches });
  return { inputSha256: hash, structuralCertification: false as const, states: owned.states.map(state => {
    const motions: Vector6[] = state.meshNodes.map(n => [...n.displacementM, ...n.rotationRad]);
    return { loadFactor: state.loadFactor, welds: kernel.evaluateStress(motions) };
  }) };
}

export type BeamWeldSpanStressResult = Awaited<ReturnType<typeof recoverBeamWeldSpanStress>>;
