import { describe, expect, it } from 'vitest';
import { evaluateExpression, expressionValueFromNumber, mathScalarExpression,
  type ExpressionValue, type StoredMathExpression } from '@pointercad/expression';
import type { MathEvaluation } from '@pointercad/expression/math/contracts';
import { densityMaterialFor } from '../appearance/materialPresets.js';
import { densityGPerCm3ToKgM3, findDensityMaterial } from '../appearance/densityMaterials.js';
import { massFromVolume } from '../measure/massProperties.js';
import { findStrengthMaterial } from '../measure/strengthMaterials.js';
import { checkStrengthMaterialCondition } from '../measure/strengthMaterialTypes.js';
import { createEmptyPartDocument } from '../part/createPartDocument.js';
import { prepareDocumentMathIdentity } from '../part/documentMathIdentity.js';
import type { PartDocument } from '../part/types.js';
import type { Parameter } from '../parameters/types.js';
import { absoluteCoordinate, createEmptySketchDocument, createPointFeature } from '../sketch/createSketchDocument.js';
import { resolveSketch } from '../sketch/resolveSketch.js';
import { formatDisplayLength, fromDisplayLength, parseDisplayInput } from './length.js';

function entered(source: string): ExpressionValue {
  const result = evaluateExpression(parseDisplayInput(source, 'inch'));
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function strength(id: string) {
  const material = findStrengthMaterial(id);
  if (material === undefined) throw new Error(`missing strength condition ${id}`);
  return material;
}

function row(name: string, value = expressionValueFromNumber(1)): Parameter {
  return { name, value, unit: 'mm', description: '' };
}

function retiredReference(id: string): StoredMathExpression {
  return { format: 'pointercad-math/1', source: 'coef("retired")', inputNotation: 'text', angleUnit: 'degree',
    expression: { kind: 'symbol', reference: { role: 'coefficient', id, label: 'retired' } } };
}

describe('shared concepts at material, unit, error and identity boundaries', () => {
  it.each([
    ['5/8', 15.875, 'ss400-plate-0-16', 'ss400-plate-16-40'],
    ['3/4', 19.05, 'ss400-plate-16-40', 'ss400-plate-0-16'],
  ] as const)('uses the unrounded %sin thickness to check a separately selected steel condition', (source, mm, accepted, refused) => {
    // 5/8 * 127/5 = 15.875; 3/4 * 127/5 = 19.05. Both are the same density, not the same strength condition.
    const thickness = entered(source);
    expect(thickness.source).toBe(`(${source})in`);
    expect(thickness.value).toBe(mm);
    const appearanceDensity = densityMaterialFor('steel', null);
    expect(appearanceDensity).toBe('steel');
    expect(strength(accepted).densityMaterialId).toBe(appearanceDensity);
    expect(strength(refused).densityMaterialId).toBe(appearanceDensity);
    expect(checkStrengthMaterialCondition(strength(accepted), thickness.value)).toEqual({ ok: true });
    expect(checkStrengthMaterialCondition(strength(refused), thickness.value)).toEqual({ ok: false, reason: 'thickness-outside' });
    expect(findStrengthMaterial('steel')).toBeUndefined();
  });

  it('keeps the density/SI/mass meaning of one international-inch steel cube', () => {
    const id = densityMaterialFor('steel', null);
    const material = id === null ? undefined : findDensityMaterial(id);
    if (material === undefined) throw new Error('missing density association');
    const side = entered('1');
    expect(side.value).toBe(25.4);
    // 1 g = .001 kg; 1 cm³ = .000001 m³. 1 in³ = 16.387064 cm³, hence 128.6384524 g at 7.85 g/cm³.
    expect(densityGPerCm3ToKgM3(material.density)).toBe(7850);
    expect(massFromVolume(side.value ** 3, material.density)).toBeCloseTo(128.6384524, 10);
    expect(side.source).toBe('(1)in');
  });

  it('does not feed display rounding back into the stored formula or internal millimetres', () => {
    // (1/7) inch is 127/35 mm; three display digits are .143 in, whose re-entry would instead be 3.6322 mm.
    const value = entered('1/7');
    const before = structuredClone(value);
    expect(value.source).toBe('(1/7)in');
    expect(value.value).toBe(127 / 35);
    expect(formatDisplayLength(value.value, 'inch')).toBe('0.143 in');
    expect(fromDisplayLength(0.143, 'inch')).toBeCloseTo(3.6322, 12);
    expect(value.value).not.toBe(fromDisplayLength(0.143, 'inch'));
    expect(value).toEqual(before);
  });

  it.each([
    ['1in+2', 'unitMismatch'], ['missing', 'unknownVariable'], ['1/0', 'divisionByZero'],
  ] as const)('retains the cause %s at the display-input/expression boundary', (input, code) => {
    const result = evaluateExpression(parseDisplayInput(input, 'inch'));
    expect(result).toMatchObject({ ok: false, error: { code } });
  });

  const definition: StoredMathExpression = { format: 'pointercad-math/1', source: '7/2', inputNotation: 'text',
    angleUnit: 'degree', expression: { kind: 'operation', operation: 'divide',
      operands: [{ kind: 'number', decimal: '7' }, { kind: 'number', decimal: '2' }] } };

  it('uses a finite unique mathematical value as a coordinate while retaining its original formula', () => {
    const scalar = mathScalarExpression({ definition, evaluation: { status: 'value', kind: 'real', exact: null,
      decimal: '3.5', coordinate: 3.5, approximation: null } });
    if (!scalar.ok) throw new Error(scalar.message);
    expect(scalar.value.source).toBe('7/2');
    const sketch = createEmptySketchDocument();
    const point = createPointFeature(sketch, { ...absoluteCoordinate(0, 0, 0), x: scalar.value });
    expect(resolveSketch({ ...sketch, features: [point] }).points.map(value => value.position)).toEqual([[3.5, 0, 0]]);
  });

  // These are already typed semantic results, not Worker reply fixtures or claims about a symbolic engine.
  const refused: readonly MathEvaluation[] = [
    { status: 'unresolved', reason: 'unknown-symbol', names: ['missing'] },
    { status: 'invalid', reason: 'unit', detail: 'length and angle have different dimensions' },
    { status: 'multiple', candidates: [{ kind: 'number', decimal: '1' }, { kind: 'number', decimal: '2' }], exhaustive: true },
    { status: 'stopped', reason: 'cancelled' },
    { status: 'stopped', reason: 'deadline' },
    { status: 'stopped', reason: 'budget' },
    { status: 'value', kind: 'complex', expression: { kind: 'constant', name: 'imaginary-unit' } },
  ];
  it.each(refused)('does not turn the distinct $status result into a coordinate', evaluation => {
    const before = structuredClone(evaluation);
    const scalar = mathScalarExpression({ definition, evaluation });
    expect(scalar.ok).toBe(false);
    expect(scalar).not.toHaveProperty('value');
    if (evaluation.status === 'invalid') expect(scalar).toEqual({ ok: false, message: evaluation.detail });
    expect(evaluation).toEqual(before);
  });

  function documentReferencing(site: 'parameter' | 'sketch' | 'configuration', id: string): PartDocument {
    const document = createEmptyPartDocument();
    const mathDefinition = retiredReference(id);
    const value = { source: mathDefinition.source, value: Number.NaN, display: '', mathDefinition };
    const parameters = [row('new', site === 'parameter' ? value : expressionValueFromNumber(1))];
    if (site === 'parameter') return { ...document, parameters };
    if (site === 'configuration') return { ...document, parameters,
      configurations: document.configurations.map(config => ({ ...config, mathDefinitions: { retired: mathDefinition } })) };
    const sketch = document.sketches[0];
    return { ...document, parameters, sketches: [{ ...sketch,
      features: [createPointFeature(sketch, { ...absoluteCoordinate(0, 0, 0), x: value })] }] };
  }

  it.each([
    ['parameter', 'coefficient:19', 'coefficient:20', 20],
    ['sketch', 'coefficient:31', 'coefficient:32', 32],
    ['configuration', 'coefficient:50', 'coefficient:51', 51],
  ] as const)('reserves a deleted coefficient still referenced by a legacy %s before allocating a new identity', (site, retired, next, serial) => {
    const document = documentReferencing(site, retired);
    const before = structuredClone(document);
    expect(document).not.toHaveProperty('mathParameterSerial');
    const prepared = prepareDocumentMathIdentity(document);
    expect(prepared.parameters[0].mathId).toBe(next);
    expect(prepared.mathParameterSerial).toBe(serial);
    expect(document).toEqual(before);
    expect(prepareDocumentMathIdentity(prepared)).toBe(prepared);
  });

  it('refuses an unsafe retired reference serial before publishing an identity migration', () => {
    const document = documentReferencing('sketch', 'coefficient:9007199254740992');
    const before = structuredClone(document);
    expect(() => prepareDocumentMathIdentity(document)).toThrow('係数の参照番号が上限を超えています。');
    expect(document).toEqual(before);
  });
});
