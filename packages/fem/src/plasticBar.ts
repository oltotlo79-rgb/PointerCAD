import { createPrefixedError, createFiniteReader, isRecord } from './valueGuards.js';
/**
 * Uniaxial elasto-plastic member: plan, strict validation, native step schedule and an independent reference.
 *
 * Constitutive law: rate-independent J2 (von Mises) plasticity reduced to one stress component, with linear
 * isotropic hardening: yield stress sigmaY = sigma0 + H * kappa, where kappa is the cumulative plastic strain. This
 * is the law of OOFEM MisesMat with htype 0 (misesmat.C:193-220, 408), which the native runner uses through
 * truss1d / SimpleCS / StaticStructural. The reference below is written from the law itself, not from OOFEM code.
 *
 * Optional yield plateau (explicit input only): with material.plateauPlasticStrain = kp > 0 the yield stress is
 * sigmaY = sigma0 for kappa <= kp and sigma0 + H (kappa - kp) afterwards. Natively this is MisesMat htype 1 (user
 * defined piecewise-linear hardening, misesmat.C:76-86, 193-220, 379-445 of the shipped commit 214b161) with the exact
 * three-point table of plasticBarHardeningTable. Without the field the plan, its JSON and the htype 0 deck are unchanged.
 *
 * Scope: small strain, monotonic or cyclic end-displacement control along the member axis, no damage, no softening,
 * no kinematic hardening, no bending. Material constants are user-supplied with a stated source; nothing is derived
 * from a steel grade name.
 */
export const PLASTIC_BAR_PLAN_SCHEMA = 'pointercad-oofem-plastic-bar-plan/1';
export const PLASTIC_BAR_RESULT_SCHEMA = 'pointercad-oofem-plastic-bar-result/1';
export const PLASTIC_BAR_LIMITS = {
  maximumKnots: 64,
  maximumStepsPerSegment: 200,
  maximumSteps: 2000,
  /** Small-strain formulation: |end displacement| / length must not exceed this. */
  maximumStrain: 0.05,
  maximumReferenceLength: 500,
} as const;

export interface PlasticBarMaterial {
  readonly youngPa: number;
  readonly poisson: number;
  /** Initial uniaxial yield stress sigma0. */
  readonly yieldStressPa: number;
  /** Linear isotropic hardening modulus H (slope of sigmaY over cumulative plastic strain); 0 = perfectly plastic. */
  readonly hardeningModulusPa: number;
  /**
   * Optional cumulative plastic strain kp (fraction, 0 < kp <= 0.05) at the end of a yield plateau; hardening with H
   * starts after it. Absent = linear isotropic hardening from first yield (the original law).
   */
  readonly plateauPlasticStrain?: number;
  readonly source: { readonly kind: 'user-supplied'; readonly reference: string };
}
/** MisesMat htype 1 table: cumulative plastic strains h_eps and yield stresses h(eps) (Pa) of the same size. */
interface PlasticBarHardeningTable {
  readonly plasticStrain: readonly [number, number, number];
  readonly yieldStressPa: readonly [number, number, number];
}
export interface PlasticBarPlan {
  readonly schema: typeof PLASTIC_BAR_PLAN_SCHEMA;
  readonly lengthM: number;
  readonly areaM2: number;
  readonly material: PlasticBarMaterial;
  /** Piecewise-linear end-displacement knots along the member axis; the first knot is 0 (undeformed, at rest). */
  readonly endDisplacementM: readonly number[];
  /** Equal pseudo-time increments per segment between consecutive knots. */
  readonly stepsPerSegment: number;
}
export interface PlasticBarSample {
  readonly step: number;
  readonly endDisplacementM: number;
  readonly strain: number;
  readonly stressPa: number;
  readonly plasticStrain: number;
  readonly axialForceN: number;
}
export interface PlasticBarReferenceSample extends PlasticBarSample {
  readonly cumulativePlasticStrain: number;
  readonly yieldStressPa: number;
}

const fail: (message: string) => never = createPrefixedError('plastic-bar');
function record(value: unknown, names: readonly string[], path: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${path} must be an object`);
  const row = value;
  const keys = Object.keys(row);
  if (keys.length !== names.length || names.some(name => !Object.hasOwn(row, name))) {
    fail(`${path} must have exactly the fields ${names.join(', ')}`);
  }
  return row;
}
const finite = createFiniteReader(fail);
function positive(value: unknown, path: string): number {
  const number = finite(value, path);
  if (!(number > 0)) fail(`${path} must be positive`);
  return number;
}

/** The single TS decoder for the plan; plasticBarAnalysis.py mirrors the same acceptance and message prefixes. */
export function readPlasticBarPlan(value: unknown): PlasticBarPlan {
  const row = record(value, ['schema', 'lengthM', 'areaM2', 'material', 'endDisplacementM', 'stepsPerSegment'], 'plan');
  if (row.schema !== PLASTIC_BAR_PLAN_SCHEMA) fail('unsupported plan schema');
  const lengthM = positive(row.lengthM, 'lengthM');
  if (lengthM > PLASTIC_BAR_LIMITS.maximumReferenceLength) fail('lengthM exceeds 500 m');
  const areaM2 = positive(row.areaM2, 'areaM2');
  if (areaM2 > 1) fail('areaM2 exceeds 1 m2');
  const materialFields = ['youngPa', 'poisson', 'yieldStressPa', 'hardeningModulusPa', 'source'];
  const plateau = isRecord(row.material) && Object.hasOwn(row.material, 'plateauPlasticStrain');
  const m = record(row.material, plateau ? [...materialFields, 'plateauPlasticStrain'] : materialFields, 'material');
  const youngPa = positive(m.youngPa, 'material.youngPa');
  const poisson = finite(m.poisson, 'material.poisson');
  if (poisson < 0 || poisson >= 0.5) fail('material.poisson must be in [0, 0.5)');
  const yieldStressPa = positive(m.yieldStressPa, 'material.yieldStressPa');
  if (yieldStressPa >= youngPa) fail('material.yieldStressPa must be below material.youngPa (yield strain < 1)');
  const hardeningModulusPa = finite(m.hardeningModulusPa, 'material.hardeningModulusPa');
  // Negative H is softening: it makes the response mesh-dependent and is not supported here.
  if (hardeningModulusPa < 0) fail('material.hardeningModulusPa must not be negative (softening is not supported)');
  let plateauPlasticStrain: number | undefined;
  if (plateau) {
    // 0 is rejected rather than treated as "no plateau": one law has exactly one encoding (omit the field instead).
    plateauPlasticStrain = positive(m.plateauPlasticStrain, 'material.plateauPlasticStrain');
    if (plateauPlasticStrain > PLASTIC_BAR_LIMITS.maximumStrain) {
      fail(`material.plateauPlasticStrain must not exceed ${PLASTIC_BAR_LIMITS.maximumStrain} (small-strain formulation)`);
    }
  }
  const source = record(m.source, ['kind', 'reference'], 'material.source');
  if (source.kind !== 'user-supplied') fail('material.source.kind must be user-supplied');
  if (typeof source.reference !== 'string' || source.reference.trim() === '' || source.reference.length > 500) {
    fail('material.source.reference must be a non-empty statement of where the values come from (at most 500 characters)');
  }
  const knots = row.endDisplacementM;
  if (!Array.isArray(knots) || knots.length < 2 || knots.length > PLASTIC_BAR_LIMITS.maximumKnots) {
    fail(`endDisplacementM must have 2 to ${PLASTIC_BAR_LIMITS.maximumKnots} knots`);
  }
  for (let index = 0; index < knots.length; index += 1) {
    if (!Object.hasOwn(knots, index)) fail('endDisplacementM must not have holes');
  }
  const endDisplacementM = knots.map((knot: unknown, index: number) => finite(knot, `endDisplacementM[${index}]`));
  if (endDisplacementM[0] !== 0) fail('the first end-displacement knot must be 0');
  for (let index = 1; index < endDisplacementM.length; index += 1) {
    if (endDisplacementM[index] === endDisplacementM[index - 1]) fail('consecutive end-displacement knots must differ');
  }
  if (endDisplacementM.some(u => Math.abs(u) / lengthM > PLASTIC_BAR_LIMITS.maximumStrain)) {
    fail(`|end displacement| / length must not exceed ${PLASTIC_BAR_LIMITS.maximumStrain} (small-strain formulation)`);
  }
  const stepsPerSegment = row.stepsPerSegment;
  if (typeof stepsPerSegment !== 'number' || !Number.isSafeInteger(stepsPerSegment) || stepsPerSegment < 1
    || stepsPerSegment > PLASTIC_BAR_LIMITS.maximumStepsPerSegment) {
    fail(`stepsPerSegment must be an integer from 1 to ${PLASTIC_BAR_LIMITS.maximumStepsPerSegment}`);
  }
  if (stepsPerSegment * (endDisplacementM.length - 1) > PLASTIC_BAR_LIMITS.maximumSteps) {
    fail(`at most ${PLASTIC_BAR_LIMITS.maximumSteps} steps are allowed`);
  }
  // The optional field is added only when present, so a plan without it keeps its exact JSON (and input digest).
  const plan: PlasticBarPlan = { schema: PLASTIC_BAR_PLAN_SCHEMA, lengthM, areaM2,
    material: { youngPa, poisson, yieldStressPa, hardeningModulusPa,
      ...(plateauPlasticStrain === undefined ? {} : { plateauPlasticStrain }),
      source: { kind: 'user-supplied', reference: source.reference } },
    endDisplacementM, stepsPerSegment };
  // A plateau plan must give a finite native table (a huge finite H overflows its last stress); legacy plans skip this.
  if (plateauPlasticStrain !== undefined) plasticBarHardeningTable(plan);
  return plan;
}

/**
 * The htype 1 table that represents the plateau law exactly, or null without a plateau (htype 0 is used then).
 * h_eps = [0, kp, kmax], h(eps) = [sigma0, sigma0, sigma0 + H (kmax - kp)], kmax = kp + 2 max(kp, TV) with TV the total
 * variation of the prescribed strain (sum of |knot steps| / length). In 1D every step adds at most |strain increment|
 * to kappa (the previous stress never exceeds the current yield stress, which does not decrease), so kappa <= TV.
 * In doubles fl(kp + 2m) >= 2m >= 2 kp and >= 2 TV for m = max(kp, TV), so kmax > kp and kmax > TV also when TV is 0
 * or underflows: h_eps is strictly increasing and the native law never reaches its last entry, where MisesMat stops
 * (misesmat.C:383-384, 410-411, 433-434). For TV >= kp the numbers equal the earlier kp + 2 TV. A table whose numbers
 * are not finite (huge H) is refused. plasticBarAnalysis.py computes the same numbers in the same order.
 */
export function plasticBarHardeningTable(plan: PlasticBarPlan): PlasticBarHardeningTable | null {
  const { yieldStressPa: s0, hardeningModulusPa: H, plateauPlasticStrain: kp } = plan.material;
  if (kp === undefined) return null;
  let variation = 0;
  for (let index = 1; index < plan.endDisplacementM.length; index += 1) {
    variation += Math.abs(plan.endDisplacementM[index] - plan.endDisplacementM[index - 1]);
  }
  const totalVariation = variation / plan.lengthM;
  const kmax = kp + 2 * Math.max(kp, totalVariation);
  const last = s0 + H * (kmax - kp);
  if (!Number.isFinite(kmax) || !Number.isFinite(last)) {
    fail('the plateau hardening table must be finite (material.hardeningModulusPa is too large)');
  }
  return { plasticStrain: [0, kp, kmax], yieldStressPa: [s0, s0, last] };
}

/** Current yield stress of the plan's law at cumulative plastic strain kappa. */
 function plasticBarYieldStressPa(material: PlasticBarMaterial, kappa: number): number {
  const kp = material.plateauPlasticStrain ?? 0;
  return kappa <= kp ? material.yieldStressPa : material.yieldStressPa + material.hardeningModulusPa * (kappa - kp);
}

/** End-displacement target of every native step 1..N: the knots sit at pseudo-times 0, s, 2s, ... (deltat 1). */
export function plasticBarSchedule(plan: PlasticBarPlan): number[] {
  const targets: number[] = [];
  for (let segment = 1; segment < plan.endDisplacementM.length; segment += 1) {
    const from = plan.endDisplacementM[segment - 1], to = plan.endDisplacementM[segment];
    for (let i = 1; i <= plan.stepsPerSegment; i += 1) {
      targets.push(i === plan.stepsPerSegment ? to : from + (to - from) * i / plan.stepsPerSegment);
    }
  }
  return targets;
}

/**
 * Independent reference: backward-Euler return mapping of 1D plasticity with linear isotropic hardening.
 * Trial stress E (strain - plasticStrain); f = |trial| - (sigma0 + H kappa); for f > 0 the plastic multiplier is
 * f / (E + H), exact for linear hardening. A uniform bar has strain = end displacement / length.
 * With a plateau kp the increment solves |trial| - E dk = sigmaY(kappa + dk) exactly for the piecewise-linear law: it
 * is (|trial| - sigma0) / E while kappa + dk stays on the plateau, otherwise
 * (|trial| - sigma0 - H (kappa - kp)) / (E + H), which also covers a step that leaves the plateau. Without kp the
 * original linear-hardening arithmetic below is used unchanged.
 */
export function plasticBarReference(plan: PlasticBarPlan): PlasticBarReferenceSample[] {
  const { youngPa: E, yieldStressPa: s0, hardeningModulusPa: H, plateauPlasticStrain: kp } = plan.material;
  let plasticStrain = 0, kappa = 0;
  return plasticBarSchedule(plan).map((endDisplacementM, index) => {
    const strain = endDisplacementM / plan.lengthM;
    const trial = E * (strain - plasticStrain);
    let stressPa = trial;
    if (kp === undefined) {
      const f = Math.abs(trial) - (s0 + H * kappa);
      if (f > 0) {
        const multiplier = f / (E + H), sign = Math.sign(trial);
        kappa += multiplier;
        plasticStrain += multiplier * sign;
        stressPa = trial - E * multiplier * sign;
      }
      return { step: index + 1, endDisplacementM, strain, stressPa, plasticStrain, axialForceN: stressPa * plan.areaM2,
        cumulativePlasticStrain: kappa, yieldStressPa: s0 + H * kappa };
    }
    if (Math.abs(trial) > plasticBarYieldStressPa(plan.material, kappa)) {
      const onPlateau = (Math.abs(trial) - s0) / E;
      const multiplier = kappa < kp && kappa + onPlateau <= kp ? onPlateau
        : (Math.abs(trial) - s0 - H * (kappa - kp)) / (E + H);
      const sign = Math.sign(trial);
      kappa += multiplier;
      plasticStrain += multiplier * sign;
      stressPa = trial - E * multiplier * sign;
    }
    return { step: index + 1, endDisplacementM, strain, stressPa, plasticStrain, axialForceN: stressPa * plan.areaM2,
      cumulativePlasticStrain: kappa, yieldStressPa: plasticBarYieldStressPa(plan.material, kappa) };
  });
}

/** Largest relative differences between native samples and the reference, per quantity (for the native proof). */
export function comparePlasticBar(native: readonly PlasticBarSample[], reference: readonly PlasticBarReferenceSample[],
  plan: PlasticBarPlan): { readonly stress: number; readonly plasticStrain: number; readonly force: number; readonly displacement: number } {
  if (native.length !== reference.length) fail('native and reference sample counts differ');
  const stressScale = plan.material.yieldStressPa, strainScale = plan.material.yieldStressPa / plan.material.youngPa;
  const forceScale = stressScale * plan.areaM2, displacementScale = strainScale * plan.lengthM;
  let stress = 0, plasticStrain = 0, force = 0, displacement = 0;
  native.forEach((sample, index) => {
    const ref = reference[index];
    if (sample.step !== ref.step) fail(`sample ${index} has step ${sample.step}, expected ${ref.step}`);
    stress = Math.max(stress, Math.abs(sample.stressPa - ref.stressPa) / stressScale);
    plasticStrain = Math.max(plasticStrain, Math.abs(sample.plasticStrain - ref.plasticStrain) / strainScale);
    force = Math.max(force, Math.abs(sample.axialForceN - ref.axialForceN) / forceScale);
    displacement = Math.max(displacement, Math.abs(sample.endDisplacementM - ref.endDisplacementM) / displacementScale);
  });
  return { stress, plasticStrain, force, displacement };
}
