import { describe, expect, it } from 'vitest';
import { createFatigueLocalCycleSavedInput, readFatigueLocalCycleSavedProblem } from '@pointercad/model/beam-analysis';
import { analyzeLocalCycle, validateLocalCycleInput } from './fatigueLocalCycle.js';

/* Reader parity between the saved local-cycle model format and the solver input. Every case states its expected verdict
 * by hand ('accepted' or the path of the first refused field, relative to the problem root); both readers must return
 * exactly that verdict. Coefficients are manufactured test values (not SS400, S45C or any real material). Domain limits
 * (Morrow sigma_m < sigma_f', SWT sigma_max > 0, calibrated life) are analysis refusals, accepted by both readers. */
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured local cycle' };
const material = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'manufactured', stressUnit: 'MPa',
  elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000, fatigueStrengthExponent: -0.5,
  fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5, calibration: { minimumCycles: 1, maximumCycles: 1e6 },
  source, ...change });
const cycle = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ strainMeasure: 'local-total-strain',
  strainUnit: 'dimensionless', stressUnit: 'MPa', derivation: 'measured', strainMax: 0.01, strainMin: -0.01, stressMax: 500,
  stressMin: -300, source, ...change });
const problem = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ schema: 'pointercad-strain-life-local-cycle/1',
  correction: 'swt', material: material(), cycle: cycle(), ...change });

function modelVerdict(value: unknown): string {
  try {
    readFatigueLocalCycleSavedProblem(value, 'input');
    return 'accepted';
  } catch (error) {
    if (!(error instanceof Error) || !('path' in error) || typeof error.path !== 'string') throw error;
    const path = error.path.replace(/^input\.?/u, '');
    return path === '' ? '$' : path;
  }
}
function solverVerdict(value: unknown): string {
  const checked = validateLocalCycleInput(value);
  return checked.ok ? 'accepted' : checked.path;
}

describe('saved local-cycle problem and solver input readers agree', () => {
  const cases: [string, unknown, string][] = [
    ['valid SWT', problem(), 'accepted'],
    ['valid Morrow', problem({ correction: 'morrow' }), 'accepted'],
    ['SWT with non-positive maximum stress (analysis refusal)', problem({ cycle: cycle({ stressMax: -10, stressMin: -500 }) }), 'accepted'],
    ['Morrow mean at sigma_f\' (analysis refusal)', problem({ correction: 'morrow', cycle: cycle({ stressMax: 1100, stressMin: 900 }) }), 'accepted'],
    ['not a record', null, '$'],
    ['extra key', { ...problem(), cyclesToFailure: 100 }, '$'],
    ['schema', problem({ schema: 'pointercad-strain-life-local-cycle/2' }), 'schema'],
    ['unknown correction', problem({ correction: 'goodman' }), 'correction'],
    ['correction holding undefined', problem({ correction: undefined }), 'correction'],
    ['material missing', problem({ material: null }), 'material'],
    ['material grade injection', problem({ material: material({ grade: 'invented' }) }), 'material'],
    ['modulus in GPa', problem({ material: material({ elasticModulusMpa: 206 }) }), 'material.elasticModulusMpa'],
    ['positive exponent', problem({ material: material({ fatigueStrengthExponent: 0.1 }) }), 'material.fatigueStrengthExponent'],
    ['calibration reversed', problem({ material: material({ calibration: { minimumCycles: 1e6, maximumCycles: 1 } }) }),
      'material.calibration.maximumCycles'],
    ['calibration holding undefined', problem({ material: material({ calibration: { minimumCycles: 1, maximumCycles: undefined } }) }),
      'material.calibration.maximumCycles'],
    ['material source blank', problem({ material: material({ source: { ...source, reference: ' ' } }) }), 'material.source'],
    ['cycle missing', problem({ cycle: null }), 'cycle'],
    ['extra cycle field', problem({ cycle: { ...cycle(), stressAmplitude: 400 } }), 'cycle'],
    ['elastic stress as strain', problem({ cycle: cycle({ strainMeasure: 'elastic-stress-over-modulus' }) }), 'cycle.strainMeasure'],
    ['linear-elastic derivation', problem({ cycle: cycle({ derivation: 'linear-elastic' }) }), 'cycle.derivation'],
    ['strain in percent', problem({ cycle: cycle({ strainUnit: 'percent' }) }), 'cycle.strainUnit'],
    ['stress in GPa', problem({ cycle: cycle({ stressUnit: 'GPa' }) }), 'cycle.stressUnit'],
    ['strain max holding undefined', problem({ cycle: cycle({ strainMax: undefined }) }), 'cycle.strainMax'],
    ['stress max infinite', problem({ cycle: cycle({ stressMax: Number.POSITIVE_INFINITY }) }), 'cycle.stressMax'],
    ['stress min text', problem({ cycle: cycle({ stressMin: '-300' }) }), 'cycle.stressMin'],
    ['strain beyond 1', problem({ cycle: cycle({ strainMax: 1.5 }) }), 'cycle.strainMax'],
    ['stress beyond 1e4 MPa', problem({ cycle: cycle({ stressMax: 2e4 }) }), 'cycle.stressMax'],
    ['equal strain extrema', problem({ cycle: cycle({ strainMin: 0.01 }) }), 'cycle.strainMin'],
    ['reversed stress extrema', problem({ cycle: cycle({ stressMax: -300, stressMin: 500 }) }), 'cycle.stressMin'],
    ['cycle source blank', problem({ cycle: cycle({ source: { ...source, condition: '' } }) }), 'cycle.source'],
  ];
  it.each(cases)('%s', (_label, value, expected) => {
    expect([modelVerdict(value), solverVerdict(value)]).toEqual([expected, expected]);
  });

  it('analyses a saved problem directly with the closed-form SWT life', () => {
    // b = c = -0.5: sigma_f'^2/E + sigma_f' eps_f' = 5 + 995 = 1000, sigma_max eps_a = 500 * 0.01 = 5, so 2N = 200, N = 100.
    const saved = createFatigueLocalCycleSavedInput('owner', problem());
    const analysis = analyzeLocalCycle(JSON.parse(JSON.stringify(saved.input)));
    if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
    expect(Math.abs(analysis.result.cyclesToFailure - 100)).toBeLessThanOrEqual(1e-9 * 100);
  });
});
