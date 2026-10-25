import { describe, expect, it } from 'vitest';
import { createEmptyPartDocument, DEFAULT_WORK_PLANE_ID, type PartDocument } from '@pointercad/model';
import { countAffectedFeatures, countParameterUsageSites, inspectInputExpression, matchesMathParameterBindings } from './expressionInspectionContext.js';

describe('入力中の式の読み取り', () => {
  it('元の入力位置と既存の単位計算を保つ', () => {
    const variables = new Map([['板厚', 3]]);
    const repeated = inspectInputExpression('板厚+板厚', { variables }, null);
    expect(repeated?.references.map(reference => [reference.name, reference.start, reference.end, reference.value, reference.circular]))
      .toEqual([['板厚', 0, 2, 3, false], ['板厚', 3, 5, 3, false]]);
    expect(inspectInputExpression('板厚*2', { variables }, null)?.inspection.result).toMatchObject({ ok: true, value: { value: 6 } });
    expect(inspectInputExpression('30*2', {}, null)?.inspection.result).toMatchObject({ ok: true, value: { value: 60 } });
    expect(inspectInputExpression('1in*2', {}, null)?.inspection.result).toMatchObject({ ok: true, value: { value: 50.8 } });
  });

  it('同じエラーだけを元の平文sourceに示し、末尾位置を残す', () => {
    const unknown = inspectInputExpression('未知+1', {}, { code: 'unknownVariable', message: '未知', position: 0 });
    expect(unknown?.errorPosition).toBe(0);
    expect(unknown?.references.map(reference => reference.name)).toEqual(['未知']);
    const missing = inspectInputExpression('板厚+', {}, { code: 'unexpectedEnd', message: '末尾', position: 3 });
    expect(missing?.errorPosition).toBe(3);
    expect(missing?.references).toEqual([]);
    expect(inspectInputExpression('1+', {}, { code: 'outOfRange', message: '範囲外', position: -1 })?.errorPosition).toBeNull();
  });

  it('長さが変わる正規化候補を誤って参照しない', () => {
    const inspection = inspectInputExpression('𝑤+1', {}, { code: 'unexpectedCharacter', message: '使えない文字', position: 0 });
    expect(inspection?.references).toEqual([]);
    expect(inspection?.errorPosition).toBe(0);
  });

  it('既存の循環解析に載る名前だけを循環として表示へ渡す', () => {
    const context = inspectInputExpression('A+1', {}, { code: 'unknownVariable', message: '未解決', position: 0 }, ['A']);
    expect(context?.references).toMatchObject([{ name: 'A', circular: true }]);
  });

  it('公開owner探索で同じownerの別式と別sketchの同じIDを別の使用箇所に数える', () => {
    const base = createEmptyPartDocument();
    const first = base.sketches[0];
    if (first === undefined) throw new Error('既定スケッチがありません');
    const sourceValue = { source: '板厚', value: 3, display: '3' };
    const zero = { source: '0', value: 0, display: '0' };
    const point = (id: string, x: string, y: string) => ({
      id, name: id, kind: 'point' as const, planeId: DEFAULT_WORK_PLANE_ID,
      at: { mode: 'absolute' as const, x: x === '板厚' ? sourceValue : zero,
        y: y === '板厚' ? sourceValue : zero, z: zero },
    });
    const document: PartDocument = { ...base,
      parameters: [{ name: '板厚', value: { source: '3', value: 3, display: '3' }, unit: 'mm', description: '' }],
      sketches: [{ ...first, features: [point('same', '板厚', '板厚')] },
        { ...first, id: 'other-sketch', features: [point('same', '板厚', '0')] }],
    };
    const before = JSON.stringify(document);
    expect(countParameterUsageSites(document).get('板厚')).toBe(3);
    expect(JSON.stringify(document)).toBe(before);
  });

  it('影響するフィーチャー数は直接・パラメータ経由の間接参照を重複なく数え、数えられない時だけ未確認にする', () => {
    const base = createEmptyPartDocument();
    const first = base.sketches[0];
    if (first === undefined) throw new Error('既定スケッチがありません');
    const value = (source: string, number: number) => ({ source, value: number, display: String(number) });
    const point = (id: string, x: string, y: string) => ({
      id, name: id, kind: 'point' as const, planeId: DEFAULT_WORK_PLANE_ID,
      at: { mode: 'absolute' as const, x: value(x, 0), y: value(y, 0), z: value('0', 0) },
    });
    const parameter = (name: string, source: string, number: number) => ({
      name, value: value(source, number), unit: 'mm' as const, description: '',
    });
    const document: PartDocument = { ...base,
      parameters: [parameter('板厚', '3', 3), parameter('厚み2', '板厚*2', 6), parameter('孤立', '1', 1), parameter('角', '30', 30)],
      sketches: [{ ...first, features: [point('a', '厚み2', '板厚'), point('b', '厚み2', '0'), point('c', '孤立', '0'), point('d', '0', '0')] }],
    };
    expect(countAffectedFeatures(document, ['板厚'])).toBe(2);
    expect(countAffectedFeatures(document, ['厚み2'])).toBe(2);
    expect(countAffectedFeatures(document, ['板厚', '孤立'])).toBe(3);
    expect(countAffectedFeatures(document, ['角'])).toBe(0);
    expect(countAffectedFeatures(document, ['存在しない名前'])).toBeUndefined();
    expect(countAffectedFeatures(document, ['板厚'], ['厚み2'])).toBeUndefined();
    expect(countAffectedFeatures(document, ['孤立'], ['厚み2'])).toBe(1);
  });

  it('構造式の係数は表示名ではなく保存されたIDの結び付けで数える', () => {
    const document: PartDocument = { ...createEmptyPartDocument(),
      parameters: [{ name: '板厚', mathId: 'coefficient:1', unit: 'mm', description: '',
        value: { source: '3', value: 3, display: '3' } }],
      unresolvedMathProblems: [{ id: 'problem-1', name: '関係式', status: 'unresolved',
        definition: { format: 'pointercad-math/1', source: 'coef("別名")', inputNotation: 'text', angleUnit: 'degree',
          expression: { kind: 'symbol', reference: { role: 'coefficient', id: 'coefficient:1', label: '別名' } } } }],
    };
    expect(countParameterUsageSites(document).get('板厚')).toBe(1);
  });

  it('数学画面では局所記号の同名をパラメータと誤表示しない', () => {
    const parameters = [{ name: 'A', mathId: 'coefficient:1', unit: 'mm' as const, description: '',
      value: { source: '3', value: 3, display: '3' } }];
    const context = inspectInputExpression('A+1', { variables: new Map([['A', 3]]) }, null);
    if (context === null) throw new Error('検査候補がありません');
    const bound = { format: 'pointercad-math/1' as const, source: 'A+1', inputNotation: 'text' as const,
      angleUnit: 'degree' as const,
      expression: { kind: 'symbol' as const,
        reference: { role: 'coefficient' as const, id: 'coefficient:1', label: 'A' } } };
    expect(matchesMathParameterBindings(context, bound, parameters)).toBe(true);
    expect(matchesMathParameterBindings(context, { ...bound, expression: {
      kind: 'symbol', reference: { role: 'declared', id: 'local:1', label: 'A' },
    } }, parameters)).toBe(false);
    expect(matchesMathParameterBindings(context, { ...bound, source: 'B+1' }, parameters)).toBe(false);
  });
});
