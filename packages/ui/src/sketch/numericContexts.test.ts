import { describe, expect, it } from 'vitest';
import { analyzeParameters, createAssemblyDocument, WORK_PLANES, type Parameter, type ParameterUnit } from '@pointercad/model';
import { placementFromSources } from '../assembly/placeComponent.js';
import { parseCommandLine } from '../sketch/commandLine.js';
import { commitNumericInput, createNumericInput, evaluateNumericInput } from '../sketch/numericInput.js';

function parameter(name: string, source: string, unit: ParameterUnit = 'none'): Parameter {
  return { name, unit, description: '', value: { source, value: 0, display: '0' } };
}

describe('操作入口が数式の十進精度と量の種類を失わない（R04/R05/R08）', () => {
  const parameters = [parameter('a', '10^16+1'), parameter('n', '2'), parameter('w', '25.4', 'mm')];
  const context = analyzeParameters(parameters, []);

  it('数値入力のプレビューと決定で、大数の差が同じ1になる', () => {
    const initial = createNumericInput('point', 'point');
    const state = { ...initial, fields: initial.fields.map((field, index) => ({ ...field, typed: true, source: index === 0 ? 'a-10^16' : '0' })) };
    const preview = evaluateNumericInput(state, context.variables, context);
    expect(preview.canCommit).toBe(true);
    expect(preview.results[0].value?.value).toBe(1);
    const committed = commitNumericInput(state, context);
    expect(committed).toMatchObject({ kind: 'committed', commit: { kind: 'coordinate',
      coordinate: { mode: 'absolute', x: { source: 'a-10^16', value: 1 } } } });
  });

  it('inch表示の数値欄で無次元の倍率を長さへ換算しない', () => {
    const initial = createNumericInput('point', 'point');
    const state = { ...initial, fields: initial.fields.map((field, index) => ({ ...field, typed: true, source: index === 0 ? 'n*1' : '0' })) };
    const evaluated = evaluateNumericInput(state, context.variables, { ...context, lengthUnit: 'inch' });
    expect(evaluated.canCommit).toBe(true);
    expect(evaluated.results[0].value?.value).toBe(50.8);
  });

  it('吸着で入れた内部mmの値にはinch表示の換算を重ねない', () => {
    const initial = createNumericInput('point', 'point');
    const state = { ...initial, fields: initial.fields.map((field, index) => ({ ...field, typed: false, source: index === 0 ? '2' : '0' })) };
    const evaluated = evaluateNumericInput(state, context.variables, { ...context, lengthUnit: 'inch' });
    expect(evaluated.canCommit).toBe(true);
    expect(evaluated.results[0].value?.value).toBe(2);
  });

  it('コマンドラインは大数の差とinchの倍率を両方保持する', () => {
    const parsed = parseCommandLine('a-10^16,(n*1)in,0', { ...context, plane: null, hasPrevious: false });
    expect(parsed).toMatchObject({ kind: 'coordinate', value: { mode: 'absolute', x: { value: 1 }, y: { value: 50.8 } } });
  });

  it.each(['10^309,0', '-10^309,0'])('コマンドラインの公開座標が無限大になる%sを断る', (source) => {
    expect(parseCommandLine(source, { ...context, plane: WORK_PLANES.xy, hasPrevious: false }).kind).toBe('error');
  });

  it('アセンブリ配置でも同じ値を保存し、式の原文を残す', () => {
    const document = { ...createAssemblyDocument('数式の組立'), parameters };
    const result = placementFromSources(document, ['a-10^16', '(n*1)in', '(w+n)in']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.placement.position.map((value) => value.value)).toEqual([1, 50.8, 76.2]);
    expect(result.placement.position.map((value) => value.source)).toEqual(['a-10^16', '(n*1)in', '(w+n)in']);
  });

  it('アセンブリの不正な大数を配置へ漏らさない', () => {
    const result = placementFromSources(createAssemblyDocument('上限'), ['10^309', '0', '0']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe('notFinite');
  });
});
