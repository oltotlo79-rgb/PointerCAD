import { describe, expect, it } from 'vitest';
import { createFatigueStrainSavedInput, readFatigueStrainSavedProblem } from '@pointercad/model/beam-analysis';
import { analyzeStrainHistory, validateStrainHistoryInput } from './fatigueStrainHistory.js';

/* Reader parity between the saved model format and the solver input. Every case states its expected verdict by hand
 * ('accepted' or the path of the first refused field, relative to the problem root); both readers must return exactly
 * that verdict, so a drift of either copy (bounds, signs, check order, paths) fails here. Coefficients are manufactured
 * test values (not SS400, S45C or any real material); strains are multiples of u = 2 ** -8. */
const u = 2 ** -8;
const source = { kind: 'user-supplied', reference: 'synthetic test only', condition: 'manufactured strain-life coefficients' };
const material = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ id: 'manufactured', stressUnit: 'MPa',
  elasticModulusMpa: 200_000, fatigueStrengthCoefficientMpa: 1000, fatigueStrengthExponent: -0.5,
  fatigueDuctilityCoefficient: 0.995, fatigueDuctilityExponent: -0.5, calibration: { minimumCycles: 1, maximumCycles: 1e6 },
  source, ...change });
const history = (change: Record<string, unknown> = {}, id = 'h1'): Record<string, unknown> => ({ id,
  strainMeasure: 'local-total-strain', strainUnit: 'dimensionless', derivation: 'measured', strain: [-2 * u, 2 * u],
  sequence: 'repeated-periodic', repeats: 10, source, ...change });
const problem = (change: Record<string, unknown> = {}): Record<string, unknown> => ({ schema: 'pointercad-strain-history/1',
  meanStress: 'assumed-zero', material: material(), histories: [history()], ...change });

function modelVerdict(value: unknown): string {
  try {
    readFatigueStrainSavedProblem(value, 'input');
    return 'accepted';
  } catch (error) {
    if (!(error instanceof Error) || !('path' in error) || typeof error.path !== 'string') throw error;
    const path = error.path.replace(/^input\.?/u, '');
    return path === '' ? '$' : path;
  }
}
function solverVerdict(value: unknown): string {
  const checked = validateStrainHistoryInput(value);
  return checked.ok ? 'accepted' : checked.path;
}

describe('saved strain-life problem and solver input readers agree', () => {
  const tooMany = Array.from({ length: 65 }, (_, index) => history({}, `h${index}`));
  const cases: [string, unknown, string][] = [
    ['valid', problem(), 'accepted'],
    ['calibration at its widest limits', problem({ material: material({ calibration: { minimumCycles: 0.5, maximumCycles: 1e12 } }) }), 'accepted'],
    ['strain of magnitude 1', problem({ histories: [history({ strain: [0, -1] })] }), 'accepted'],
    ['64 histories', problem({ histories: tooMany.slice(0, 64) }), 'accepted'],
    ['not a record', null, '$'],
    ['extra key', { ...problem(), damage: 0 }, '$'],
    ['schema', problem({ schema: 'pointercad-strain-history/2' }), 'schema'],
    ['Morrow', problem({ meanStress: 'morrow' }), 'meanStress'],
    ['mean-stress key holding undefined', problem({ meanStress: undefined }), 'meanStress'],
    ['material missing', problem({ material: null }), 'material'],
    ['material injection', problem({ material: material({ grade: 'invented' }) }), 'material'],
    ['material id', problem({ material: material({ id: '' }) }), 'material.id'],
    ['stress unit', problem({ material: material({ stressUnit: 'GPa' }) }), 'material.stressUnit'],
    ['modulus in GPa', problem({ material: material({ elasticModulusMpa: 206 }) }), 'material.elasticModulusMpa'],
    ['modulus in Pa', problem({ material: material({ elasticModulusMpa: 2.06e11 }) }), 'material.elasticModulusMpa'],
    ['strength coefficient below 1 MPa', problem({ material: material({ fatigueStrengthCoefficientMpa: 0.5 }) }),
      'material.fatigueStrengthCoefficientMpa'],
    ['zero exponent', problem({ material: material({ fatigueStrengthExponent: 0 }) }), 'material.fatigueStrengthExponent'],
    ['negative zero exponent', problem({ material: material({ fatigueStrengthExponent: -0 }) }), 'material.fatigueStrengthExponent'],
    ['too steep exponent', problem({ material: material({ fatigueStrengthExponent: -3 }) }), 'material.fatigueStrengthExponent'],
    ['too flat exponent', problem({ material: material({ fatigueDuctilityExponent: -1e-4 }) }), 'material.fatigueDuctilityExponent'],
    ['ductility above 10', problem({ material: material({ fatigueDuctilityCoefficient: 11 }) }), 'material.fatigueDuctilityCoefficient'],
    ['calibration reversed', problem({ material: material({ calibration: { minimumCycles: 1e6, maximumCycles: 1 } }) }),
      'material.calibration.maximumCycles'],
    ['calibration empty', problem({ material: material({ calibration: { minimumCycles: 10, maximumCycles: 10 } }) }),
      'material.calibration.maximumCycles'],
    ['calibration below one reversal', problem({ material: material({ calibration: { minimumCycles: 0.25, maximumCycles: 1e6 } }) }),
      'material.calibration.minimumCycles'],
    ['calibration shape', problem({ material: material({ calibration: { minimumCycles: 1 } }) }), 'material.calibration'],
    ['material source blank', problem({ material: material({ source: { ...source, reference: ' ' } }) }), 'material.source'],
    ['material source injection', problem({ material: material({ source: { ...source, grade: 'invented' } }) }), 'material.source'],
    ['no history', problem({ histories: [] }), 'histories'],
    ['sparse histories', problem({ histories: new Array(1) }), 'histories'],
    ['65 histories', problem({ histories: tooMany }), 'histories'],
    ['stress history injected', problem({ histories: [history({ stressMpa: [150, 250] })] }), 'histories[0]'],
    ['history source missing', problem({ histories: [{ ...history(), source: undefined }] }), 'histories[0].source'],
    ['elastic stress as strain', problem({ histories: [history({ strainMeasure: 'elastic-stress-over-modulus' })] }),
      'histories[0].strainMeasure'],
    ['linear-elastic derivation', problem({ histories: [history({ derivation: 'linear-elastic' })] }), 'histories[0].derivation'],
    ['strain in percent', problem({ histories: [history({ strainUnit: 'percent' })] }), 'histories[0].strainUnit'],
    ['sparse strain', problem({ histories: [history({ strain: new Array(2) })] }), 'histories[0].strain'],
    ['too long strain', problem({ histories: [history({ strain: new Array<number>(100_001).fill(0) })] }), 'histories[0].strain'],
    ['nonfinite strain', problem({ histories: [history({ strain: [0, Number.NaN] })] }), 'histories[0].strain[1]'],
    ['strain beyond 1', problem({ histories: [history({ strain: [0, -1.000000001] })] }), 'histories[0].strain[1]'],
    ['sequence', problem({ histories: [history({ sequence: 'twice' })] }), 'histories[0].sequence'],
    ['too many repeats', problem({ histories: [history({ repeats: 1e9 + 1 })] }), 'histories[0].repeats'],
    ['duplicate history id', problem({ histories: [history(), history()] }), 'histories[1].id'],
  ];
  it.each(cases)('%s', (_label, value, expected) => {
    expect([modelVerdict(value), solverVerdict(value)]).toEqual([expected, expected]);
  });

  it('analyses a saved problem directly with the closed-form damage of its constant-amplitude block', () => {
    // b = c = -0.5 and A + B = 1000 / 200000 + 0.995 = 1: amplitude 2u lives 1 / (8 u ** 2) = 8192 cycles, so 10
    // periods of one full cycle damage 10 / 8192.
    const saved = createFatigueStrainSavedInput('owner', problem());
    const analysis = analyzeStrainHistory(JSON.parse(JSON.stringify(saved.input)));
    if (!analysis.ok) throw new Error(`${analysis.code} at ${analysis.path}`);
    expect(Math.abs(analysis.result.damage - 10 / 8192)).toBeLessThanOrEqual(1e-9 * (10 / 8192));
  });
});
