import { collectVariableNames, containsLengthUnit, evaluateExpression } from '@pointercad/expression';
import { analyzeParameters, type Parameter } from '@pointercad/model';
import type { MessageKey } from '../i18n/t.js';
import { t } from '../i18n/t.js';
import type { NumericField, NumericFieldResult } from '../sketch/numericInput.js';

export type BeamFieldName = 'young' | 'shear' | 'density' | 'area' | 'iy' | 'iz' | 'torsion' | 'shearFactor'
  | 'cx' | 'cy' | 'principalAngle' | 'startFx' | 'startFy' | 'startFz' | 'startMx' | 'startMy' | 'startMz'
  | 'endFx' | 'endFy' | 'endFz' | 'endMx' | 'endMy' | 'endMz';
type Quantity = 'stress' | 'density' | 'area' | 'inertia' | 'scalar' | 'length' | 'angle' | 'force' | 'moment' | 'time' | 'inverseTime';
interface FieldDefinition {
  readonly label: MessageKey;
  readonly unit: string;
  readonly quantity: Quantity;
  readonly positive: boolean;
}
const field = (label: MessageKey, unit: string, quantity: Quantity, positive = false): FieldDefinition => ({ label, unit, quantity, positive });
export const BEAM_FIELDS: Readonly<Record<BeamFieldName, FieldDefinition>> = {
  young: field('beam.young', 'MPa', 'stress', true), shear: field('beam.shear', 'MPa', 'stress', true),
  density: field('beam.density', 'kg/m³', 'density', true), area: field('beam.area', 'mm²', 'area', true),
  iy: field('beam.iy', 'mm⁴', 'inertia', true), iz: field('beam.iz', 'mm⁴', 'inertia', true),
  torsion: field('beam.torsion', 'mm⁴', 'inertia', true), shearFactor: field('beam.shearFactor', '—', 'scalar', true),
  cx: field('beam.cx', 'mm', 'length'), cy: field('beam.cy', 'mm', 'length'),
  principalAngle: field('beam.principalAngle', '°', 'angle'),
  startFx: field('beam.fx', 'N', 'force'), startFy: field('beam.fy', 'N', 'force'), startFz: field('beam.fz', 'N', 'force'),
  startMx: field('beam.mx', 'N·mm', 'moment'), startMy: field('beam.my', 'N·mm', 'moment'), startMz: field('beam.mz', 'N·mm', 'moment'),
  endFx: field('beam.fx', 'N', 'force'), endFy: field('beam.fy', 'N', 'force'), endFz: field('beam.fz', 'N', 'force'),
  endMx: field('beam.mx', 'N·mm', 'moment'), endMy: field('beam.my', 'N·mm', 'moment'), endMz: field('beam.mz', 'N·mm', 'moment'),
};

const suffixes: Readonly<Record<Quantity, readonly (readonly [string, string])[]>> = {
  stress: [['GPa', '1000'], ['MPa', '1'], ['kPa', '0.001'], ['Pa', '0.000001']],
  force: [['kN', '1000'], ['N', '1']],
  moment: [['kN·m', '1000000'], ['kNm', '1000000'], ['N·mm', '1'], ['Nmm', '1'], ['N·m', '1000'], ['Nm', '1000']],
  area: [['mm²', '1'], ['mm2', '1'], ['cm²', '100'], ['cm2', '100'], ['m²', '1000000'], ['m2', '1000000']],
  inertia: [['mm⁴', '1'], ['mm4', '1'], ['cm⁴', '10000'], ['cm4', '10000'], ['m⁴', '1000000000000'], ['m4', '1000000000000']],
  density: [['kg/m³', '1'], ['kg/m3', '1']], angle: [['°', '1'], ['deg', '1']], scalar: [], length: [],
  // Seconds are the stored unit; 'ms' is checked before 's'.
  time: [['ms', '0.001'], ['s', '1']],
  inverseTime: [['1/s', '1'], ['/s', '1']],
};

function canonical(source: string, quantity: Quantity): string {
  const trimmed = source.trim();
  for (const [suffix, factor] of suffixes[quantity]) {
    if (!trimmed.endsWith(suffix)) continue;
    const prefix = trimmed.slice(0, -suffix.length);
    // In 21/s the final 1 belongs to the coefficient; only a separated 1/s is a unit suffix.
    if (quantity === 'inverseTime' && suffix === '1/s' && !/[)\s]$/u.test(prefix)) continue;
    if (/[0-9.)\s]$/u.test(prefix)) return `(${prefix.trim()})*${factor}`;
  }
  return trimmed;
}

/** Signed global loads and centroid offsets are accepted; incompatible dimensions are rejected. */
export function readBeamField(name: BeamFieldName, source: string, parameters: readonly Parameter[]): NumericFieldResult {
  return readQuantity(name, BEAM_FIELDS[name], source, parameters);
}

function readQuantity(name: string, definition: FieldDefinition, source: string, parameters: readonly Parameter[]): NumericFieldResult {
  const fail = (message: string): NumericFieldResult => ({ key: name, value: null,
    error: { code: 'outOfRange', position: -1, message } });
  if (source.trim() === '' || source.length > 4096) return fail(t('beam.error.expression'));
  const expression = canonical(source, definition.quantity);
  if (definition.quantity !== 'length' && containsLengthUnit(expression)) return fail(t('beam.error.units'));
  const analysis = analyzeParameters(parameters, []);
  const kinds = new Map(parameters.map(parameter => [parameter.name, parameter.unit]));
  for (const name of collectVariableNames(expression)) {
    const unit = kinds.get(name);
    if ((unit === 'degree' && definition.quantity !== 'angle') || (definition.quantity !== 'length' && unit === 'mm')
      || analysis.circular.includes(name) || analysis.failures.some(failure => failure.name === name)) {
      return fail(t('beam.error.parameters'));
    }
  }
  const evaluated = evaluateExpression(expression, {
    exactVariables: analysis.exactVariables, nonLengthVariables: analysis.nonLengthVariables,
  });
  if (!evaluated.ok) return { key: name, value: null, error: evaluated.error };
  if (!Number.isFinite(evaluated.value.value) || (definition.positive && evaluated.value.value <= 0)) {
    return fail(t('beam.error.range'));
  }
  return { key: name, value: { ...evaluated.value, source }, error: null };
}

export function beamExpressionField(name: BeamFieldName, source: string, parameters: readonly Parameter[]): {
  readonly field: NumericField; readonly result: NumericFieldResult; readonly unitLabel: string;
  readonly inspectionSource: string; readonly inspectionParameters: readonly Parameter[];
} {
  const definition = BEAM_FIELDS[name];
  return {
    field: { key: name, labelKey: definition.label, tooltipKey: 'beam.expressionHelp',
      unit: definition.quantity === 'length' ? 'mm' : 'ratio', source, defaultSource: '', typed: true },
    result: readBeamField(name, source, parameters), unitLabel: definition.unit,
    inspectionSource: canonical(source, definition.quantity), inspectionParameters: parameters,
  };
}

/** Transient history fields: same expression, parameter and unit rules as the member fields, but kept
 * out of BEAM_FIELDS so they never become per-member values. Integers are checked by the caller. */
export type TransientFieldName = 'timeStep' | 'stepCount' | 'outputEvery' | 'sampleTime' | 'sampleFactor' | 'massCoefficientPerS' | 'stiffnessCoefficientS';
export const TRANSIENT_FIELDS: Readonly<Record<TransientFieldName, FieldDefinition>> = {
  massCoefficientPerS: field('beam.transientMassCoefficient', '1/s', 'inverseTime'),
  stiffnessCoefficientS: field('beam.transientStiffnessCoefficient', 's', 'time'),
  timeStep: field('beam.transientTimeStep', 's', 'time', true),
  stepCount: field('beam.transientStepCount', '—', 'scalar', true),
  outputEvery: field('beam.transientOutputEvery', '—', 'scalar', true),
  sampleTime: field('beam.transientSampleTime', 's', 'time'),
  sampleFactor: field('beam.transientSampleFactor', '—', 'scalar'),
};

export function readTransientField(name: TransientFieldName, key: string, source: string,
  parameters: readonly Parameter[]): NumericFieldResult {
  const result = readQuantity(key, TRANSIENT_FIELDS[name], source, parameters);
  if ((name === 'massCoefficientPerS' || name === 'stiffnessCoefficientS') && result.value !== null && result.value.value < 0) {
    return { key, value: null, error: { code: 'outOfRange', position: -1, message: t('beam.error.range') } };
  }
  return result;
}

export function transientExpressionField(name: TransientFieldName, key: string, source: string,
  parameters: readonly Parameter[]): ReturnType<typeof beamExpressionField> {
  const definition = TRANSIENT_FIELDS[name];
  return {
    field: { key, labelKey: definition.label, tooltipKey: 'beam.expressionHelp', unit: 'ratio', source,
      defaultSource: '', typed: true },
    result: readTransientField(name, key, source, parameters), unitLabel: definition.unit,
    inspectionSource: canonical(source, definition.quantity), inspectionParameters: parameters,
  };
}

/** Contact fields: the same expression, parameter and unit rules, kept out of BEAM_FIELDS. The initial gap is a
 * length in mm (other length units and mm parameters are accepted); direction components and load factors are plain
 * numbers. Nonnegative gaps are checked by the caller; directions, ranges and counts by the model reader. */
export type ContactFieldName = 'normalX' | 'normalY' | 'normalZ' | 'gap' | 'loadFactor';
export const CONTACT_FIELDS: Readonly<Record<ContactFieldName, FieldDefinition>> = {
  normalX: field('beam.contactNormalX', '—', 'scalar'),
  normalY: field('beam.contactNormalY', '—', 'scalar'),
  normalZ: field('beam.contactNormalZ', '—', 'scalar'),
  gap: field('beam.contactGap', 'mm', 'length'),
  loadFactor: field('beam.contactLoadFactor', '—', 'scalar'),
};

export function readContactField(name: ContactFieldName, key: string, source: string,
  parameters: readonly Parameter[]): NumericFieldResult {
  return readQuantity(key, CONTACT_FIELDS[name], source, parameters);
}

export function contactExpressionField(name: ContactFieldName, key: string, source: string,
  parameters: readonly Parameter[]): ReturnType<typeof beamExpressionField> {
  const definition = CONTACT_FIELDS[name];
  return {
    field: { key, labelKey: definition.label, tooltipKey: 'beam.expressionHelp',
      unit: definition.quantity === 'length' ? 'mm' : 'ratio', source, defaultSource: '', typed: true },
    result: readContactField(name, key, source, parameters), unitLabel: definition.unit,
    inspectionSource: canonical(source, definition.quantity), inspectionParameters: parameters,
  };
}

/** Elasto-plastic bar fields: the same expression, parameter and unit rules, kept out of BEAM_FIELDS. Stresses are
 * MPa (GPa/kPa/Pa suffixes accepted), lengths and end displacements mm, area mm². Integers and the plan's own
 * ranges are checked by readPlasticBarPlan. */
export type PlasticBarFieldName = 'length' | 'area' | 'young' | 'poisson' | 'yieldStress' | 'hardening' | 'knot'
  | 'stepsPerSegment';
export const PLASTIC_BAR_FIELDS: Readonly<Record<PlasticBarFieldName, FieldDefinition>> = {
  length: field('plasticBar.length', 'mm', 'length', true),
  area: field('plasticBar.area', 'mm²', 'area', true),
  young: field('plasticBar.young', 'MPa', 'stress', true),
  poisson: field('plasticBar.poisson', '—', 'scalar'),
  yieldStress: field('plasticBar.yieldStress', 'MPa', 'stress', true),
  hardening: field('plasticBar.hardening', 'MPa', 'stress'),
  knot: field('plasticBar.knot', 'mm', 'length'),
  stepsPerSegment: field('plasticBar.stepsPerSegment', '—', 'scalar', true),
};

export function readPlasticBarField(name: PlasticBarFieldName, key: string, source: string,
  parameters: readonly Parameter[]): NumericFieldResult {
  return readQuantity(key, PLASTIC_BAR_FIELDS[name], source, parameters);
}

export function plasticBarExpressionField(name: PlasticBarFieldName, key: string, source: string,
  parameters: readonly Parameter[]): ReturnType<typeof beamExpressionField> {
  const definition = PLASTIC_BAR_FIELDS[name];
  return {
    field: { key, labelKey: definition.label, tooltipKey: 'beam.expressionHelp',
      unit: definition.quantity === 'length' ? 'mm' : 'ratio', source, defaultSource: '', typed: true },
    result: readPlasticBarField(name, key, source, parameters), unitLabel: definition.unit,
    inspectionSource: canonical(source, definition.quantity), inspectionParameters: parameters,
  };
}

/** Fatigue curve fields: the same expression, parameter and unit rules, kept out of BEAM_FIELDS. Stresses are MPa
 * (GPa/kPa/Pa suffixes accepted); cycle counts, the slope and repeat counts are plain numbers. Integers, ranges and
 * the curve rules are checked by validateFatigueInput of @pointercad/fem. */
export type FatigueFieldName = 'referenceStress' | 'referenceCycles' | 'slope' | 'cutoff' | 'repeats';
export const FATIGUE_FIELDS: Readonly<Record<FatigueFieldName, FieldDefinition>> = {
  referenceStress: field('fatigue.referenceStress', 'MPa', 'stress', true),
  referenceCycles: field('fatigue.referenceCycles', '—', 'scalar', true),
  slope: field('fatigue.slope', '—', 'scalar', true),
  cutoff: field('fatigue.cutoff', 'MPa', 'stress', true),
  repeats: field('fatigue.repeats', '—', 'scalar', true),
};

export function readFatigueField(name: FatigueFieldName, key: string, source: string,
  parameters: readonly Parameter[]): NumericFieldResult {
  return readQuantity(key, FATIGUE_FIELDS[name], source, parameters);
}

export function fatigueExpressionField(name: FatigueFieldName, key: string, source: string,
  parameters: readonly Parameter[]): ReturnType<typeof beamExpressionField> {
  const definition = FATIGUE_FIELDS[name];
  return {
    field: { key, labelKey: definition.label, tooltipKey: 'beam.expressionHelp', unit: 'ratio', source,
      defaultSource: '', typed: true },
    result: readFatigueField(name, key, source, parameters), unitLabel: definition.unit,
    inspectionSource: canonical(source, definition.quantity), inspectionParameters: parameters,
  };
}
