import { evaluateExpression } from '@pointercad/expression';
import type { AssemblyDocument, MechanismCamCoupling } from '../types.js';
import { assemblyExpressionContext } from '../resolveAssembly.js';
import type { CamFollowerCoupling, CamFollowerFailure } from './camFollower.js';

/** Evaluate authored cam dimensions (ExpressionValue) exactly like evaluateMechanismCouplings evaluates the gear
 * ratio/phase; never fall back to stale cached numbers. Structural/geometric admission stays in prepareCamFollowers. */
export function evaluateCamCouplings(assembly: AssemblyDocument): CamFollowerFailure | {
  readonly ok: true; readonly couplings: readonly CamFollowerCoupling[];
} {
  const context = assemblyExpressionContext(assembly), couplings: CamFollowerCoupling[] = [];
  const read = (value: MechanismCamCoupling['discRadiusMm']): number | null => {
    const evaluated = evaluateExpression(value.source, context);
    return evaluated.ok && Number.isFinite(evaluated.value.value) ? evaluated.value.value : null;
  };
  for (const c of assembly.camCouplings ?? []) {
    const discRadiusMm = read(c.discRadiusMm), eccentricityMm = read(c.eccentricityMm);
    const rollerRadiusMm = read(c.rollerRadiusMm), phaseDeg = read(c.phaseDeg);
    if (discRadiusMm === null || eccentricityMm === null || rollerRadiusMm === null)
      return { ok: false, couplingId: c.id, reason: 'invalidCamDimensions' };
    if (phaseDeg === null) return { ok: false, couplingId: c.id, reason: 'invalidPhase' };
    couplings.push({ id: c.id, kind: 'cam', camJointId: c.camJointId, followerJointId: c.followerJointId,
      discRadiusMm, eccentricityMm, rollerRadiusMm, phaseDeg, referenceAngleCam: c.referenceAngleCam, suppressed: c.suppressed });
  }
  return { ok: true, couplings };
}
