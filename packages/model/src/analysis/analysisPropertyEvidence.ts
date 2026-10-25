import { findStrengthMaterial } from '../measure/strengthMaterials.js';
import { InputIssue, text } from './analysisValidation.js';

export type AnalysisPropertyKind = 'hardening' | 'sn' | 'rayleigh' | 'rate-law';
export interface AnalysisPropertyRange {
  readonly lower: number;
  readonly upper: number;
  readonly unit: string;
}
/** Authored evidence, never a material-name lookup or a claim that the cited document was retrieved.
 * A verified status means this contract agrees with the supplied series, not independent physical validation.
 * Temperature is explicitly supplied in degrees Celsius; the catalogue's unspecified temperature is not a default.
 */
export interface AnalysisPropertyEvidence {
  readonly property: AnalysisPropertyKind;
  readonly sourceId: string;
  readonly sourceKind: 'standard-draft' | 'manufacturer-reference' | 'user-provided';
  readonly citation: string;
  readonly materialConditionId: string;
  /** Exact condition vocabulary of the selected strength-material row; no treatment is inferred from a grade. */
  readonly heatTreatment: string;
  readonly temperatureC: number;
  readonly temperatureRange: AnalysisPropertyRange;
  readonly units: Readonly<Record<string, string>>;
  readonly testConditions: { readonly description: string; readonly parameters: Readonly<Record<string, string>> };
  /** Inclusive intervals for every supplied coefficient, using the same keys as units and the series values. */
  readonly validRange: Readonly<Record<string, AnalysisPropertyRange>>;
}
/** The caller supplies actual values and their authoritative units, independently of the evidence being checked.
 * Rate-law callers must also supply the law identifier/conditions and every coefficient; no law is implemented here.
 */
export interface AnalysisPropertySeries {
  readonly kind: AnalysisPropertyKind;
  readonly values: Readonly<Record<string, { readonly value: number; readonly unit: string }>>;
  readonly conditions: Readonly<Record<string, string>>;
}
export type AnalysisPropertyEvidenceStatus =
  | { readonly status: 'unverified'; readonly reason: '出典未取得' }
  | { readonly status: 'verified'; readonly evidence: AnalysisPropertyEvidence };

function fail(code: string, path: string, detail: string): never {
  throw new InputIssue(`property-evidence-${code}`, path, detail);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (!record(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor === undefined || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value');
  })) fail('shape', path, 'Expected exactly the stated own evidence fields');
  return value;
}
function finite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('number', path, 'Expected a finite evidence value');
  return value;
}
function range(value: unknown, unit: string, path: string): AnalysisPropertyRange {
  const row = exact(value, ['lower', 'upper', 'unit'], path);
  if (row.unit !== unit) fail('unit-mismatch', `${path}.unit`, 'Evidence range and series units must match exactly');
  const lower = finite(row.lower, `${path}.lower`), upper = finite(row.upper, `${path}.upper`);
  if (lower > upper) fail('range', path, 'The lower bound must not exceed the upper bound');
  return { lower, upper, unit };
}
function inside(value: number, interval: AnalysisPropertyRange, path: string): void {
  if (value < interval.lower || value > interval.upper) fail('outside-range', path, 'Value is outside the cited valid range');
}

/** Preserve absence in old files, but do not silently drop an explicitly supplied invalid evidence field. */
export function analysisPropertyEvidenceKeys(value: unknown, key: string): string[] {
  return record(value) && Object.hasOwn(value, key) ? [key] : [];
}
export function readOptionalAnalysisPropertyEvidence(row: Record<string, unknown>, key: string,
  series: AnalysisPropertySeries, path: string): AnalysisPropertyEvidence | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(row, key);
  if (descriptor === undefined) return undefined;
  if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('shape', `${path}.${key}`, 'Expected a saved evidence field');
  return readAnalysisPropertyEvidence(row[key], series, `${path}.${key}`);
}

export function readAnalysisPropertyEvidence(value: unknown, series: AnalysisPropertySeries,
  path = 'propertyEvidence'): AnalysisPropertyEvidence {
  const row = exact(value, ['property', 'sourceId', 'sourceKind', 'citation', 'materialConditionId', 'heatTreatment',
    'temperatureC', 'temperatureRange', 'units', 'testConditions', 'validRange'], path);
  if (!['hardening', 'sn', 'rayleigh', 'rate-law'].includes(series.kind) || row.property !== series.kind) {
    fail('series-mismatch', `${path}.property`, 'Evidence must describe the selected property series');
  }
  const sourceId = text(row.sourceId, `${path}.sourceId`);
  const sourceKind = row.sourceKind;
  if (sourceKind !== 'standard-draft' && sourceKind !== 'manufacturer-reference' && sourceKind !== 'user-provided') {
    fail('source-kind', `${path}.sourceKind`, 'Expected an explicit supported source classification');
  }
  const citation = text(row.citation, `${path}.citation`, 2048);
  const materialConditionId = text(row.materialConditionId, `${path}.materialConditionId`);
  const heatTreatment = text(row.heatTreatment, `${path}.heatTreatment`, 1024);
  const material = findStrengthMaterial(materialConditionId);
  if (material === undefined || heatTreatment !== material.condition) {
    fail('condition-mismatch', `${path}.heatTreatment`, 'Heat treatment must match the stated material condition ID');
  }
  const temperatureC = finite(row.temperatureC, `${path}.temperatureC`);
  const temperatureRange = range(row.temperatureRange, 'degC', `${path}.temperatureRange`);
  if (temperatureRange.lower < -273.15) fail('range', `${path}.temperatureRange`, 'Temperature is below absolute zero');
  inside(temperatureC, temperatureRange, `${path}.temperatureC`);
  const names = Object.keys(series.values);
  if (names.length === 0 || names.length > 32) fail('series', path, 'Expected 1 to 32 explicit coefficients');
  const unitRow = exact(row.units, names, `${path}.units`);
  const rangeRow = exact(row.validRange, names, `${path}.validRange`);
  const units: Record<string, string> = {};
  const validRange: Record<string, AnalysisPropertyRange> = {};
  for (const name of names) {
    text(name, `${path}.units`, 128);
    if (name === '__proto__' || name === 'constructor' || name === 'prototype') fail('series', path, 'Unsupported coefficient name');
    const actual = series.values[name];
    const unit = text(actual.unit, `${path}.units.${name}`, 64);
    if (unitRow[name] !== unit) fail('unit-mismatch', `${path}.units.${name}`, 'Evidence and series units must match exactly');
    const interval = range(rangeRow[name], unit, `${path}.validRange.${name}`);
    inside(finite(actual.value, `${path}.${name}`), interval, `${path}.${name}`);
    units[name] = unit;
    validRange[name] = interval;
  }
  const conditions = exact(row.testConditions, ['description', 'parameters'], `${path}.testConditions`);
  const description = text(conditions.description, `${path}.testConditions.description`, 2048);
  const conditionNames = Object.keys(series.conditions);
  if (conditionNames.length === 0 || conditionNames.length > 16) fail('series', path, 'Explicit law and test conditions are required');
  const parameterRow = exact(conditions.parameters, conditionNames, `${path}.testConditions.parameters`);
  const parameters = Object.fromEntries(conditionNames.map(name => {
    text(name, `${path}.testConditions.parameters`, 128);
    const parameter = text(parameterRow[name], `${path}.testConditions.parameters.${name}`, 512);
    if (parameter !== series.conditions[name]) fail('test-condition-mismatch', `${path}.testConditions.parameters.${name}`,
      'Evidence test conditions must match the selected law and stress definition');
    return [name, parameter];
  }));
  return { property: series.kind, sourceId, sourceKind, citation, materialConditionId, heatTreatment, temperatureC,
    temperatureRange, units, testConditions: { description, parameters }, validRange };
}

/** Derive, never persist, the status. Free-text legacy references alone cannot confer verified status. */
export function analysisPropertyEvidenceStatus(evidence: unknown, series: AnalysisPropertySeries): AnalysisPropertyEvidenceStatus {
  return evidence === undefined ? { status: 'unverified', reason: '出典未取得' }
    : { status: 'verified', evidence: readAnalysisPropertyEvidence(evidence, series) };
}

export function hardeningPropertySeries(value: { readonly yieldStressMPa: number; readonly hardeningModulusMPa: number }): AnalysisPropertySeries {
  return { kind: 'hardening', values: { yieldStressMPa: { value: value.yieldStressMPa, unit: 'MPa' },
    hardeningModulusMPa: { value: value.hardeningModulusMPa, unit: 'MPa' } }, conditions: { law: 'linear-isotropic' } };
}
export function fatiguePropertySeries(value: { readonly referenceStressMpa: number; readonly referenceCycles: number;
  readonly slope: number; readonly cutoffStressMpa: number | null; readonly stressDefinition: string;
  readonly meanStressAssumption: string }): AnalysisPropertySeries {
  return { kind: 'sn', values: { referenceStressMpa: { value: value.referenceStressMpa, unit: 'MPa' },
    referenceCycles: { value: value.referenceCycles, unit: 'cycle' }, slope: { value: value.slope, unit: '1' },
    ...(value.cutoffStressMpa === null ? {} : { cutoffStressMpa: { value: value.cutoffStressMpa, unit: 'MPa' } }) },
  conditions: { law: 'single-slope', stressDefinition: value.stressDefinition, meanStressAssumption: value.meanStressAssumption } };
}
export function rayleighPropertySeries(value: { readonly massCoefficientPerS: number; readonly stiffnessCoefficientS: number }): AnalysisPropertySeries {
  return { kind: 'rayleigh', values: { massCoefficientPerS: { value: value.massCoefficientPerS, unit: '1/s' },
    stiffnessCoefficientS: { value: value.stiffnessCoefficientS, unit: 's' } }, conditions: { law: 'C=alpha*M+beta*K' } };
}
