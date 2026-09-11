import { evaluateExpression, exactExpressionValueFromNumber, renameVariable } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';
import { evaluateSheetField, mapSheetMetalExpressions, resolveSheetRule, sheetFeatureDependencies, sheetPanelId } from './featureInputs.js';
import type { SheetMetalFeature, SheetMetalRule } from './types.js';

const n = exactExpressionValueFromNumber;
const rule: SheetMetalRule = { thickness: n(2), innerRadius: n(3), kFactor: n(0.4) };
const profile = { sketchId: 'sketch', faceFeatureId: 'outer' };
const identity = { id: 'feature', name: '板金', suppressed: false };
const features: readonly SheetMetalFeature[] = [
  { ...identity, kind: 'sheetBase', profile, holes: [{ ...profile, faceFeatureId: 'hole' }], reversed: false, rule },
  { ...identity, kind: 'sheetFlange', targetFeatureId: 'base', edges: [{ panelId: 'panel', boundaryId: 'edge' }],
    length: n(20), angle: n(90), startOffset: n(0), endOffset: n(1), lengthBasis: 'outer',
    rule: { innerRadius: n(4), kFactor: n(0.3) }, profile: { face: profile, baselineId: 'baseline', holes: [] } },
  { ...identity, kind: 'sheetBend', targetFeatureId: 'base', panelId: 'panel', line: { sketchId: 'sketch', lineFeatureId: 'line' },
    fixedSide: 'left', angle: n(-45), rule: { innerRadius: null, kFactor: null } },
  { ...identity, kind: 'sheetRelief', targetFeatureId: 'bend', boundary: { panelId: 'panel', boundaryId: 'edge' },
    position: n(5), width: n(2), depth: n(5), shape: 'slot' },
];

describe('P10の式・単位・参照（FR-202、FR-811、R04/R05）', () => {
  it('inchの長さだけ単位を補い、Kと角度は同じ無次元・度の値を保つ', () => {
    expect(evaluateSheetField('1/8', 'length', 'inch')).toMatchObject({ ok: true, value: { source: '(1/8)in', value: 3.175 } });
    expect(evaluateSheetField('0.4', 'ratio', 'inch')).toMatchObject({ ok: true, value: { source: '0.4', value: 0.4 } });
    expect(evaluateSheetField('90', 'angle', 'inch')).toMatchObject({ ok: true, value: { source: '90', value: 90 } });
    expect(evaluateSheetField('2mm', 'length', 'inch')).toMatchObject({ ok: true, value: { source: '2mm', value: 2 } });
    expect(evaluateSheetField('2mm', 'ratio', 'inch').ok).toBe(false);
    expect(evaluateSheetField('1/0', 'length', 'mm').ok).toBe(false);
  });
  it('表示で丸められた変数もexact値で計算し、Kの変数を長さへ変換しない', () => {
    const options = { variables: new Map([['長さ', 10000000000000000], ['差', 10000000000000000], ['係数', 0.4]]),
      exactVariables: new Map([['長さ', '10000000000000000.1'], ['差', '10000000000000000'], ['係数', '0.4']]),
      nonLengthVariables: new Set(['係数']) };
    expect(evaluateSheetField('長さ-差', 'length', 'mm', options)).toMatchObject({ ok: true, value: { value: 0.1 } });
    expect(evaluateSheetField('係数', 'ratio', 'inch', options)).toMatchObject({ ok: true, value: { value: 0.4 } });
    expect(evaluateSheetField('係数', 'length', 'inch', options)).toMatchObject({ ok: true, value: { value: 10.16 } });
  });
  it('すべての式を改名して再評価し、無変更・既定継承のnull・参照・元の定義を維持する', () => {
    const counts = [3, 6, 1, 3];
    for (const [index, feature] of features.entries()) {
      expect(mapSheetMetalExpressions(feature, (value) => value)).toBe(feature);
      let count = 0;
      const withVariable = mapSheetMetalExpressions(feature, (value) => { count++; return { ...value, source: `板厚+${value.source}` }; });
      expect(count).toBe(counts[index]);
      const renamed = mapSheetMetalExpressions(withVariable, (value) => ({ ...value, source: renameVariable(value.source, '板厚', '素材厚') }));
      const evaluated = mapSheetMetalExpressions(renamed, (value) => {
        const result = evaluateExpression(value.source, { variables: new Map([['素材厚', 1]]) });
        if (!result.ok) throw new Error(result.error.message); return result.value;
      });
      const originalValues: number[] = [], newValues: number[] = [];
      mapSheetMetalExpressions(feature, (value) => { originalValues.push(value.value); return value; });
      mapSheetMetalExpressions(evaluated, (value) => { newValues.push(value.value); expect(value.source).toContain('素材厚'); return value; });
      expect(newValues).toEqual(originalValues.map((value) => value + 1));
      expect(sheetFeatureDependencies(evaluated)).toEqual(sheetFeatureDependencies(feature));
      if (evaluated.kind === 'sheetBend') expect(evaluated.rule).toEqual({ innerRadius: null, kFactor: null });
    }
  });
  it('板厚を継承し、局所R/Kだけ上書きする。有限でも不正な製造条件は拒否する', () => {
    expect(resolveSheetRule(rule, { innerRadius: n(5), kFactor: n(0.2) })).toEqual({ ok: true, rule: { thickness: 2, radius: 5, kFactor: 0.2 } });
    expect(resolveSheetRule(rule, { innerRadius: null, kFactor: null })).toEqual({ ok: true, rule: { thickness: 2, radius: 3, kFactor: 0.4 } });
    for (const k of [-0.1, 0.6, Infinity]) expect(resolveSheetRule({ ...rule, kFactor: { ...rule.kFactor, value: k } }).ok).toBe(false);
    expect(resolveSheetRule({ ...rule, thickness: n(0) }).ok).toBe(false);
    expect(resolveSheetRule(rule, { innerRadius: n(-1), kFactor: null }).ok).toBe(false);
  });
  it('外周・穴・曲げ線の依存を保持し、IDの区切り文字が同じでもパネルを混同しない', () => {
    expect(sheetFeatureDependencies(features[0])).toEqual({ bodyIds: [], sketchItems: [{ sketchId: 'sketch', featureId: 'outer' }, { sketchId: 'sketch', featureId: 'hole' }] });
    expect(sheetFeatureDependencies(features[2])).toEqual({ bodyIds: ['base'], sketchItems: [{ sketchId: 'sketch', featureId: 'line' }] });
    expect(sheetPanelId('a#b', 'c')).not.toBe(sheetPanelId('a', 'b#c'));
    expect(sheetPanelId('a', null)).not.toBe(sheetPanelId('a', 'null'));
  });
});
