import { FATIGUE_RESULT_SCHEMA, FATIGUE_REVERSED_MEAN_TOLERANCE, validateFatigueInput, type FatigueAnalysis, type FatigueCycle,
  type FatigueHistoryResult, type FatigueLife, type FatigueSequence, type FatigueSnCurve, type FatigueStressHistory } from './fatigueModel.js';
import { FATIGUE_CORRECTED_RESULT_SCHEMA, validateFatigueMeanStressCorrection, type FatigueCorrectedAnalysis,
  type FatigueCorrectedHistoryResult, type FatigueMeanStressCorrection } from './fatigueModel.js';

/** A reversal (turning point) of a history: its value and the index of the first sample of its plateau. */
export interface FatigueReversal { readonly value: number; readonly index: number }

/** Equal consecutive samples collapse to the first one (plateau start); the order of samples is never changed. */
function plateaus(stress: readonly number[]): FatigueReversal[] {
  const points: FatigueReversal[] = [];
  for (const [index, value] of stress.entries()) {
    if (points.at(-1)?.value !== value) points.push({ value, index });
  }
  return points;
}
/** Keeps both endpoints and every interior point where the direction changes; neighbours are never equal here. */
function turningPoints(points: readonly FatigueReversal[]): FatigueReversal[] {
  return points.filter((point, at) => {
    const before = points[at - 1], after = points[at + 1];
    return before === undefined || after === undefined
      || Math.sign(point.value - before.value) !== Math.sign(after.value - point.value);
  });
}

/** Reversals for one chronological pass ('once'). */
export function onceReversals(stress: readonly number[]): FatigueReversal[] {
  return turningPoints(plateaus(stress));
}
/** Reversals for closed-loop counting of one period ('repeated-periodic'): the last sample is followed by the first,
 * so the cycle is restarted at its first largest value and closed by repeating it. Fewer than two distinct values
 * give no reversal pair (no cycle). */
export function periodicReversals(stress: readonly number[]): FatigueReversal[] {
  const points = plateaus(stress);
  const first = points[0], last = points.at(-1);
  if (points.length > 1 && first !== undefined && last !== undefined && first.value === last.value) points.pop();
  if (points.length < 2) return points.slice(0, 1);
  let start = 0;
  for (const [at, point] of points.entries()) {
    const best = points[start];
    if (best !== undefined && point.value > best.value) start = at;
  }
  const peak = points[start];
  if (peak === undefined) return [];
  return turningPoints([...points.slice(start), ...points.slice(0, start), peak]);
}

const cycleOf = (count: 0.5 | 1, a: FatigueReversal, b: FatigueReversal): FatigueCycle =>
  ({ count, rangeMpa: Math.abs(b.value - a.value), meanMpa: (a.value + b.value) / 2, fromIndex: a.index, toIndex: b.index });

/**
 * Three-point stack rainflow procedure: with Y the range between the third- and second-last stacked reversals and
 * X the range between the last two, nothing is counted while X < Y. Otherwise Y is a half cycle when it contains the
 * first stacked reversal (that reversal is then discarded) and a full cycle otherwise (both its reversals are
 * discarded). Every range left on the stack at the end is a half cycle. Cycles are listed in counting order.
 * This is the commonly described procedure; conformance with a particular standard text is not claimed here.
 */
export function countRainflow(reversals: readonly FatigueReversal[]): FatigueCycle[] {
  const cycles: FatigueCycle[] = [];
  const stack: FatigueReversal[] = [];
  for (const point of reversals) {
    stack.push(point);
    for (;;) {
      const c = stack[stack.length - 3], b = stack[stack.length - 2], a = stack[stack.length - 1];
      if (a === undefined || b === undefined || c === undefined) break;
      if (Math.abs(a.value - b.value) < Math.abs(b.value - c.value)) break;
      if (stack.length === 3) {
        cycles.push(cycleOf(0.5, c, b));
        stack.shift();
      } else {
        cycles.push(cycleOf(1, c, b));
        stack.splice(stack.length - 3, 2);
      }
    }
  }
  for (let at = 0; at + 1 < stack.length; at += 1) {
    const a = stack[at], b = stack[at + 1];
    if (a !== undefined && b !== undefined) cycles.push(cycleOf(0.5, a, b));
  }
  return cycles;
}

/** Rainflow cycles of one validated history (finite values within the input bounds). */
export function rainflowCycles(stress: readonly number[], sequence: FatigueSequence): FatigueCycle[] {
  return countRainflow(sequence === 'once' ? onceReversals(stress) : periodicReversals(stress));
}

/**
 * The cycles that one more application of a history adds when the whole spectrum is applied repeatedly (the life is a
 * count of such applications). A 'repeated-periodic' history is already counted closed-loop: its own cycles are
 * returned unchanged. A 'once' event can occur again only after its stress has returned to its first value, so each
 * recurrence is counted closed-loop as well: the residual half cycles of one chronological pass are not the cycles of a
 * recurring event (0 -> 100 MPa once is half a cycle of range 100; recurring, it is one full cycle per occurrence).
 * Closing the record is the least that a recurrence adds; a further excursion between occurrences is not in the record
 * and is not counted. The single-pass cycles and damage of the event are reported unchanged.
 */
export function recurrenceCycles(history: FatigueStressHistory, cycles: readonly FatigueCycle[]): readonly FatigueCycle[] {
  return history.sequence === 'once' ? countRainflow(periodicReversals(history.stressMpa)) : cycles;
}

/** The curve's stress for one counted cycle: its range, or half of it for an amplitude curve. */
export function curveStressMpa(curve: Pick<FatigueSnCurve, 'stressDefinition'>, cycle: Pick<FatigueCycle, 'rangeMpa'>): number {
  return curve.stressDefinition === 'range' ? cycle.rangeMpa : cycle.rangeMpa / 2;
}
/** True when the cycle enters Miner's sum: a positive curve stress at or above the cut-off (if any). */
function damaging(curve: FatigueSnCurve, stress: number): boolean {
  return stress > 0 && (curve.cutoffStressMpa === null || stress >= curve.cutoffStressMpa);
}
/** n / N with N = referenceCycles * (referenceStress / S) ** slope, written as n * (S / referenceStress) ** slope /
 * referenceCycles so that small stresses underflow towards 0 instead of overflowing N. */
function cycleDamage(curve: FatigueSnCurve, cycle: FatigueCycle): number {
  const stress = curveStressMpa(curve, cycle);
  return damaging(curve, stress) ? cycle.count * (stress / curve.referenceStressMpa) ** curve.slope / curve.referenceCycles : 0;
}
/** Index of the first cycle that is not fully reversed relative to the history's largest |stress|, or -1. */
export function firstNonzeroMean(history: FatigueStressHistory, cycles: readonly FatigueCycle[]): number {
  // A loop, not Math.max(...values): up to 100000 arguments may exceed the engine's argument limit.
  let largest = 0;
  for (const point of history.stressMpa) largest = Math.max(largest, Math.abs(point));
  return cycles.findIndex(cycle => Math.abs(cycle.meanMpa) > FATIGUE_REVERSED_MEAN_TOLERANCE * largest);
}
/** The spectrum life from the damage of one repeated application. `singlePassUnderflow` keeps a damaging single-pass
 * sum that underflowed to 0 a typed underflow, as before; without a 'once' history `repeated` equals the single sum. */
export function spectrumLife(anyDamaging: boolean, singlePassUnderflow: boolean, repeated: number): FatigueLife {
  const repetitions = 1 / repeated;
  return !anyDamaging ? { kind: 'no-damaging-cycle' }
    : singlePassUnderflow || repeated === 0 ? { kind: 'not-representable', reason: 'damage-underflow' }
      : Number.isFinite(repetitions) ? { kind: 'finite', spectrumRepetitions: repetitions }
        : { kind: 'not-representable', reason: 'life-overflow' };
}

/** Validates unknown input, counts every history and sums Miner damage. Typed refusals, never a thrown TypeError.
 * `damage` is one application of the input; `life` counts repeated applications (recurrenceCycles). */
export function analyzeFatigue(value: unknown): FatigueAnalysis {
  const checked = validateFatigueInput(value);
  if (!checked.ok) return checked;
  const { curve, histories } = checked.input;
  const results: FatigueHistoryResult[] = [];
  let total = 0, repeated = 0, anyDamaging = false, anyRecurrenceDamaging = false;
  for (const [at, history] of histories.entries()) {
    const reversals = history.sequence === 'once' ? onceReversals(history.stressMpa) : periodicReversals(history.stressMpa);
    const cycles = countRainflow(reversals), recurring = recurrenceCycles(history, cycles);
    if (curve.meanStressAssumption === 'fully-reversed-only') {
      const refused = firstNonzeroMean(history, cycles);
      if (refused >= 0) return { ok: false, code: 'fatigue-mean', path: `histories[${at}].cycles[${refused}]` };
      // The life must not rest on a recurring cycle outside the curve's stated applicability either.
      const recurringRefused = recurring === cycles ? -1 : firstNonzeroMean(history, recurring);
      if (recurringRefused >= 0) return { ok: false, code: 'fatigue-mean', path: `histories[${at}].recurrenceCycles[${recurringRefused}]` };
    }
    let damage = 0;
    for (const cycle of cycles) {
      damage += cycleDamage(curve, cycle);
      if (damaging(curve, curveStressMpa(curve, cycle))) anyDamaging = true;
    }
    damage *= history.repeats;
    if (!Number.isFinite(damage)) return { ok: false, code: 'fatigue-overflow', path: `histories[${at}]` };
    let recurringDamage = damage;
    if (recurring !== cycles) {
      // A 'once' history has repeats 1.
      recurringDamage = 0;
      for (const cycle of recurring) {
        recurringDamage += cycleDamage(curve, cycle);
        if (damaging(curve, curveStressMpa(curve, cycle))) anyRecurrenceDamaging = true;
      }
      if (!Number.isFinite(recurringDamage)) return { ok: false, code: 'fatigue-overflow', path: `histories[${at}]` };
    }
    total += damage;
    repeated += recurringDamage;
    results.push({ id: history.id, sequence: history.sequence, repeats: history.repeats, reversals: reversals.length, cycles, damage });
  }
  if (!Number.isFinite(total) || !Number.isFinite(repeated)) return { ok: false, code: 'fatigue-overflow', path: 'histories' };
  const life = spectrumLife(anyDamaging || anyRecurrenceDamaging, anyDamaging && total === 0, repeated);
  return { ok: true, result: { schema: FATIGUE_RESULT_SCHEMA, method: 'rainflow-three-point-stack/1+miner-linear-single-slope/1',
    scope: 'uniaxial-scalar-stress-history-linear-damage-estimate', codeCompliance: false, structuralCertification: false,
    curveId: curve.id, stressDefinition: curve.stressDefinition, meanStressAssumption: curve.meanStressAssumption,
    histories: results, damage: total, life } };
}

/** One cycle on the Goodman-corrected curve axis, or null outside the stated domain (amplitude at/above yield, or a
 * damaging life shorter than the stated minimum). The inverse life is per full cycle. */
function goodmanTerm(curve: FatigueSnCurve, correction: FatigueMeanStressCorrection, cycle: FatigueCycle):
  { readonly stress: number; readonly contributes: boolean; readonly inverseLife: number } | null {
  const denominator = 1 - Math.max(cycle.meanMpa, 0) / correction.ultimateTensileStrengthMpa;
  // Correct on the curve axis directly: range/2*2 would erase the smallest subnormal range.
  const stress = curveStressMpa(curve, cycle) / denominator;
  const amplitude = curve.stressDefinition === 'range' ? stress / 2 : stress;
  if (!(denominator > 0) || !Number.isFinite(amplitude) || amplitude >= correction.yieldStrengthMpa) return null;
  // The inverse life per full cycle is evaluated without forming an overflowing N.
  const contributes = damaging(curve, stress);
  const inverseLife = contributes ? (stress / curve.referenceStressMpa) ** curve.slope / curve.referenceCycles : 0;
  if (!Number.isFinite(inverseLife) || inverseLife > 1 / correction.minimumCycles) return null;
  return { stress, contributes, inverseLife };
}

/** Opt-in uniaxial elastic Goodman estimate on a fully reversed curve. The legacy analyzeFatigue is unchanged.
 * Sa,eq = Sa / (1 - max(Sm, 0)/Su): compressive mean stress receives no beneficial correction.
 * Primary formula/convention: https://help.altair.com/ss/en_us/topics/simsolid/analysis/fatigue_mean_stress_test_r.htm
 * Symmetric yield and the supplied S-N life lower bound delimit this implementation, not a material certification.
 * Real stresses and equivalent amplitudes must remain strictly below yield; no plastic/low-cycle extrapolation.
 * Original signed means, ranges, counts and indices are retained; the curve-axis equivalent stress is separate.
 * As in analyzeFatigue, `life` counts repeated applications: each recurrence of a 'once' history is counted closed-loop
 * and every recurring cycle must satisfy the same domain.
 */
export function analyzeFatigueWithMeanStressCorrection(value: unknown, correctionValue: unknown): FatigueCorrectedAnalysis {
  const checked = validateFatigueInput(value);
  if (!checked.ok) return checked;
  const corrected = validateFatigueMeanStressCorrection(correctionValue);
  if (!corrected.ok) return corrected;
  const { curve, histories } = checked.input, { correction } = corrected;
  if (curve.meanStressAssumption !== 'fully-reversed-only') {
    return { ok: false, code: 'fatigue-correction-curve', path: 'curve.meanStressAssumption' };
  }
  const results: FatigueCorrectedHistoryResult[] = [];
  let total = 0, repeated = 0, anyDamaging = false, anyRecurrenceDamaging = false;
  for (const [at, history] of histories.entries()) {
    for (const [index, stress] of history.stressMpa.entries()) {
      if (Math.abs(stress) >= correction.yieldStrengthMpa) {
        return { ok: false, code: 'fatigue-correction-domain', path: `histories[${at}].stressMpa[${index}]` };
      }
    }
    const reversals = history.sequence === 'once' ? onceReversals(history.stressMpa) : periodicReversals(history.stressMpa);
    const cycles = countRainflow(reversals), equivalentStressMpa: number[] = [];
    let damage = 0;
    for (const [index, cycle] of cycles.entries()) {
      const term = goodmanTerm(curve, correction, cycle);
      if (term === null) return { ok: false, code: 'fatigue-correction-domain', path: `histories[${at}].cycles[${index}]` };
      equivalentStressMpa.push(term.stress);
      if (term.contributes) { damage += cycle.count * term.inverseLife; anyDamaging = true; }
    }
    damage *= history.repeats;
    if (!Number.isFinite(damage)) return { ok: false, code: 'fatigue-overflow', path: `histories[${at}]` };
    const recurring = recurrenceCycles(history, cycles);
    let recurringDamage = damage;
    if (recurring !== cycles) {
      recurringDamage = 0;
      for (const [index, cycle] of recurring.entries()) {
        const term = goodmanTerm(curve, correction, cycle);
        if (term === null) return { ok: false, code: 'fatigue-correction-domain', path: `histories[${at}].recurrenceCycles[${index}]` };
        if (term.contributes) { recurringDamage += cycle.count * term.inverseLife; anyRecurrenceDamaging = true; }
      }
      if (!Number.isFinite(recurringDamage)) return { ok: false, code: 'fatigue-overflow', path: `histories[${at}]` };
    }
    total += damage;
    repeated += recurringDamage;
    results.push({ id: history.id, sequence: history.sequence, repeats: history.repeats, reversals: reversals.length,
      cycles, equivalentStressMpa, damage });
  }
  if (!Number.isFinite(total) || !Number.isFinite(repeated)) return { ok: false, code: 'fatigue-overflow', path: 'histories' };
  const life = spectrumLife(anyDamaging || anyRecurrenceDamaging, anyDamaging && total === 0, repeated);
  return { ok: true, result: { schema: FATIGUE_CORRECTED_RESULT_SCHEMA,
    method: 'rainflow-three-point-stack/1+goodman-tension-only/1+miner-linear-single-slope/1',
    scope: 'uniaxial-scalar-stress-history-linear-damage-estimate', codeCompliance: false, structuralCertification: false,
    curveId: curve.id, stressDefinition: curve.stressDefinition, meanStressAssumption: curve.meanStressAssumption,
    correction, histories: results, damage: total, life } };
}
