import { beforeAll, describe, expect, it } from 'vitest';
import { createEmptyPartDocument, createFunctionCurve, createFunctionSurface, type PartDocument } from '@pointercad/model';
import {
  createMathBackend,
  executeMathWorkRequest,
  type MathExecutionBackend,
} from '@pointercad/expression/math/worker';

import {
  CANDIDATE_MATH_BY_ID,
  decodeMathWorkReply,
} from '@pointercad/expression/math/contracts';

import type { MathWorkerClient } from '@pointercad/expression/math/client';
import { editFunctionField, functionDraftScope, evaluateFunctionPlotDraft as evaluateFunctionCurveDraft, functionPlotDraft as functionCurveDraft,
  type FunctionPlotDraft as FunctionCurveDraft } from './functionPlotDraft.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const client: Pick<MathWorkerClient, 'evaluate'> = { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
  result: decodeMathWorkReply(executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend), request,
    { operationsById: CANDIDATE_MATH_BY_ID, coefficientIds: new Set(request.coefficients.map(item => item.id)), declaredIds: new Set() }).result }) };
function filled(): FunctionCurveDraft {
  const draft = functionCurveDraft();
  const scalar = (source: string) => ({ source, angleUnit: 'degree' as const });
  return { ...draft, outputs: { ...draft.outputs, Y: editFunctionField(draft.outputs.Y, 'X^2') }, scalars: { ...draft.scalars,
    'X.min': scalar('-2'), 'X.max': scalar('2'), 'Y.min': scalar('-1'), 'Y.max': scalar('2'),
    'Z.min': scalar('-1'), 'Z.max': scalar('1') } };
}
const evaluate = (draft: FunctionCurveDraft, document = createEmptyPartDocument()) =>
  evaluateFunctionCurveDraft(document, 1, draft, client, new AbortController().signal, () => true);

describe('関数の専用画面ではXYZ全6境界を指定する', () => {
  it('新しい関数・等式・範囲は度で始まり、利用者が選んだラジアンは再編集でも変えない',async()=>{
    for(const geometry of ['curve','surface'] as const){
      const draft=functionCurveDraft(undefined,geometry);
      for(const input of [...Object.values(draft.outputs),draft.equation,...Object.values(draft.scalars)]) expect(input.angleUnit).toBe('degree');
    }
    const draft=filled(),result=await evaluate({...draft,outputs:{...draft.outputs,Y:{source:'sin(X)',angleUnit:'radian'}}});
    if(!result.ok) throw new Error(JSON.stringify([...result.fields]));
    const document=createEmptyPartDocument(),reopened=functionCurveDraft(createFunctionCurve(document.sketches[0],result.definition));
    expect(reopened.outputs.Y.angleUnit).toBe('radian');
    const reevaluated=await evaluate(reopened);
    if(!reevaluated.ok) throw new Error(JSON.stringify([...reevaluated.fields]));
    expect(reevaluated.definition.formula).toMatchObject({outputs:{Y:{source:'sin(X)',angleUnit:'radian'}}});
  });
  it('平面等式は固定座標と自由な2軸を分け、原式のまま再編集できる',async()=>{
    const initial=filled(),draft:FunctionCurveDraft={...initial,form:'implicit',fixedAxis:'X',equation:{source:'Y^2+Z^2-1',angleUnit:'radian'},
      scalars:{...initial.scalars,fixedCoordinate:{source:'0.5',angleUnit:'degree'}}};
    expect(functionDraftScope(draft)).toEqual({axes:['Y','Z'],parameters:[]});
    const result=await evaluate(draft);if(!result.ok) throw new Error(JSON.stringify([...result.fields]));
    expect(result.definition.formula).toMatchObject({kind:'implicit-curve',fixedAxis:'X',fixedCoordinate:{source:'0.5',value:0.5}});
    const document=createEmptyPartDocument(),reopened=functionCurveDraft(createFunctionCurve(document.sketches[0],result.definition));
    expect(reopened.form).toBe('implicit');expect(reopened.fixedAxis).toBe('X');expect(reopened.equation.source).toBe('Y^2+Z^2-1');
    expect(reopened.scalars.fixedCoordinate.source).toBe('0.5');expect((await evaluate(reopened)).ok).toBe(true);
    expect((await evaluate({...draft,equation:{source:'X+Y',angleUnit:'radian'}})).ok).toBe(false);
  });
  it.each(['X.min','X.max','Y.min','Y.max','Z.min','Z.max','fixedCoordinate'] as const)('平面等式でも%sを必須とし、固定軸の描画範囲も省略しない',async key=>{
    const initial=filled(),draft:FunctionCurveDraft={...initial,form:'implicit',fixedAxis:'Z',equation:{source:'X^2+Y^2-1',angleUnit:'radian'},
      scalars:{...initial.scalars,fixedCoordinate:{source:'0',angleUnit:'degree'}}};
    const result=await evaluate({...draft,scalars:{...draft.scalars,[key]:editFunctionField(draft.scalars[key],'')}});
    if(result.ok) throw new Error('Missing bound accepted');expect(result.fields.has(key)).toBe(true);
  });
  it('空間等式の入力は出力軸やUVと分け、全6境界を保持して再編集できる',async()=>{
    const initial=filled(),draft:FunctionCurveDraft={...initial,geometry:'surface',form:'implicit',equation:{source:'X^2+Y^2+Z^2-1',angleUnit:'radian'}};
    expect(functionDraftScope(draft)).toEqual({axes:['X','Y','Z'],parameters:[]});
    const result=await evaluate(draft);if(!result.ok) throw new Error(JSON.stringify([...result.fields]));
    expect(result.definition.formula).toMatchObject({kind:'implicit-surface',expression:{source:'X^2+Y^2+Z^2-1'}});
    const document=createEmptyPartDocument(),reopened=functionCurveDraft(createFunctionSurface(document,result.definition));
    expect(reopened.form).toBe('implicit');expect(reopened.equation.source).toBe(draft.equation.source);
    expect(reopened.scalars['Z.max'].source).toBe(initial.scalars['Z.max'].source);
    expect((await evaluate(reopened)).ok).toBe(true);
  });
  it.each(['X.min','X.max','Y.min','Y.max','Z.min','Z.max'] as const)('空間等式でも%sの欠落を許さず、式から範囲を自動補完しない',async key=>{
    const initial=filled(),result=await evaluate({...initial,geometry:'surface',form:'implicit',equation:{source:'X^2+Y^2+Z^2-1',angleUnit:'radian'},
      scalars:{...initial.scalars,[key]:editFunctionField(initial.scalars[key],'')}});
    if(result.ok) throw new Error('Missing XYZ accepted');expect(result.fields.has(key)).toBe(true);
  });
  it('空間等式の式が空・スコープ外・文書切替なら作成しない',async()=>{
    const initial=filled();
    for(const source of ['', 'T+X']) expect((await evaluate({...initial,geometry:'surface',form:'implicit',equation:{source,angleUnit:'radian'}})).ok).toBe(false);
    expect(await evaluateFunctionCurveDraft(createEmptyPartDocument(),1,{...initial,geometry:'surface',form:'implicit'},client,new AbortController().signal,()=>false))
      .toMatchObject({ok:false,cancelled:true});
  });
  it('新規画面の6境界は空で、初期値やTの範囲を代わりに使わない', async () => {
    const draft = functionCurveDraft(), result = await evaluate(draft);
    if (result.ok) throw new Error('Missing bounds accepted');
    for (const field of ['X.min', 'X.max', 'Y.min', 'Y.max', 'Z.min', 'Z.max']) expect(result.fields.has(field)).toBe(true);
  });
  it('6境界と関数を評価してから保存可能な定義を返す', async () => {
    const result = await evaluate(filled());
    if (!result.ok) throw new Error(JSON.stringify([...result.fields]));
    expect(result.definition.bounds.X.min.value).toBe(-2); expect(result.definition.bounds.Z.max.value).toBe(1);
    expect(result.definition.formula).toMatchObject({ kind: 'coordinate-curve', independent: 'X', outputs: { Y: { source: 'X^2' } } });
  });
  it.each(['infinity', '1/0', '-3'])('境界%sを有限・順序付きの範囲として受け付けない', async source => {
    const draft = filled(), result = await evaluate({ ...draft, scalars: { ...draft.scalars, 'Z.max': editFunctionField(draft.scalars['Z.max'], source) } });
    expect(result.ok).toBe(false);
  });
  it('Tの範囲とXYZ範囲を別々に保持する', async () => {
    const draft = filled(), result = await evaluate({ ...draft, form: 'parametric', outputs: {
      X: editFunctionField(draft.outputs.X, 'cos(T)'), Y: editFunctionField(draft.outputs.Y, 'sin(T)'), Z: editFunctionField(draft.outputs.Z, 'T'),
    }, scalars: { ...draft.scalars, 'T.min': editFunctionField(draft.scalars['T.min'], '0'),
      'T.max': editFunctionField(draft.scalars['T.max'], '4*pi') } });
    if (!result.ok) throw new Error(JSON.stringify([...result.fields]));
    expect(result.definition.bounds.Z.max.value).toBe(1);
    expect(result.definition.formula).toMatchObject({ kind: 'parametric-curve', T: { min: { value: 0 }, max: { value: 4 * Math.PI } } });
  });
  it('座標Xと係数Xを混同せず、採用前には元の文書へIDを書き込まない', async () => {
    const document: PartDocument = { ...createEmptyPartDocument(), parameters: [{ name: 'X', unit: 'mm', description: '',
      value: { source: '3', value: 999, display: '999' } }] }, before = JSON.stringify(document), draft = filled();
    const result = await evaluate({ ...draft, outputs: { ...draft.outputs, Y: editFunctionField(draft.outputs.Y, 'X+coef("X")') } }, document);
    if (!result.ok) throw new Error(JSON.stringify([...result.fields]));
    expect(result.prepared.parameters[0].mathId).toBeDefined(); expect(JSON.stringify(document)).toBe(before);
  });
  it('編集中に文書が切り替わったら未確定の式や範囲を返さない', async () => {
    let current = true;
    const result = await evaluateFunctionCurveDraft(createEmptyPartDocument(), 1, filled(), { evaluate: async (...args) => {
      const value = await client.evaluate(...args); current = false; return value;
    } }, new AbortController().signal, () => current);
    expect(result).toMatchObject({ ok: false, cancelled: true });
  });
  it('度の関数とラジアンの境界を直接書換えても単位を保持し、古い数学構造は破棄する', async () => {
    const document = createEmptyPartDocument(), draft = filled();
    const first = await evaluate({ ...draft, outputs: { ...draft.outputs, Y: { source: 'sin(X)', angleUnit: 'degree' } },
      scalars: { ...draft.scalars, 'Z.max': { source: 'cos(0)', angleUnit: 'radian' } } });
    if (!first.ok) throw new Error('First definition rejected');
    const reopened = functionCurveDraft(createFunctionCurve(document.sketches[0], first.definition));
    const y = editFunctionField(reopened.outputs.Y, '2*sin(X)'), z = editFunctionField(reopened.scalars['Z.max'], 'cos(pi/3)');
    expect(y.accepted).toBeUndefined(); expect(z.accepted).toBeUndefined();
    const result = await evaluate({ ...reopened, outputs: { ...reopened.outputs, Y: y }, scalars: { ...reopened.scalars, 'Z.max': z } });
    if (!result.ok) throw new Error(JSON.stringify([...result.fields]));
    expect(result.definition.formula).toMatchObject({ outputs: { Y: { source: '2*sin(X)', angleUnit: 'degree' } } });
    expect(result.definition.bounds.Z.max.value).toBeCloseTo(0.5, 12);
    expect(result.definition.bounds.Z.max.mathDefinition?.angleUnit).toBe('radian');
  });
});

describe('曲面にも必須XYZ範囲と独立したU・Vのスコープを適用する', () => {
  const surface = (): FunctionCurveDraft => { const draft = filled(); return { ...draft, geometry: 'surface',
    outputs: { ...draft.outputs, Z: editFunctionField(draft.outputs.Z, 'X+Y') } }; };
  it.each(['X.min', 'X.max', 'Y.min', 'Y.max', 'Z.min', 'Z.max'] as const)('%sが欠ければ曲面の定義を確定しない', async field => {
    const draft = surface(), result = await evaluate({ ...draft, scalars: { ...draft.scalars, [field]: editFunctionField(draft.scalars[field], '') } });
    if (result.ok) throw new Error('Incomplete XYZ bounds accepted');
    expect(result.fields.has(field)).toBe(true);
  });
  it('出力軸を変えると自由変数を切り替え、式・角度単位・6境界を再編集へ戻す', async () => {
    const draft = surface(), document = createEmptyPartDocument();
    const input = { ...draft, dependent: 'X' as const, outputs: { ...draft.outputs, X: { source: 'sin(Y)+Z', angleUnit: 'degree' as const } } };
    expect(functionDraftScope(input)).toEqual({ axes: ['Y', 'Z'], parameters: [] });
    const result = await evaluate(input, document);
    if (!result.ok) throw new Error(JSON.stringify([...result.fields]));
    const restored = functionCurveDraft(createFunctionSurface(document, result.definition));
    expect(restored).toMatchObject({ geometry: 'surface', dependent: 'X', outputs: { X: { source: 'sin(Y)+Z', angleUnit: 'degree' } } });
    for (const field of ['X.min', 'X.max', 'Y.min', 'Y.max', 'Z.min', 'Z.max'] as const) expect(restored.scalars[field].source).toBe(draft.scalars[field].source);
  });
  it('U・Vが指定されてもXYZを省略できず、独立の範囲として保存する', async () => {
    const draft = surface(), input: FunctionCurveDraft = { ...draft, form: 'parametric', outputs: {
      X: editFunctionField(draft.outputs.X, 'U'), Y: editFunctionField(draft.outputs.Y, 'V'), Z: editFunctionField(draft.outputs.Z, 'U*V'),
    }, scalars: { ...draft.scalars, 'U.min': { source: '-2', angleUnit: 'degree' }, 'U.max': { source: '2', angleUnit: 'degree' },
      'V.min': { source: '-3', angleUnit: 'degree' }, 'V.max': { source: '3', angleUnit: 'degree' } } };
    expect(functionDraftScope(input)).toEqual({ axes: [], parameters: ['U', 'V'] });
    expect((await evaluate({ ...input, scalars: { ...input.scalars, 'Z.max': editFunctionField(input.scalars['Z.max'], '') } })).ok).toBe(false);
    const result = await evaluate(input);
    if (!result.ok) throw new Error(JSON.stringify([...result.fields]));
    expect(result.definition.formula).toMatchObject({ kind: 'parametric-surface', U: { min: { value: -2 }, max: { value: 2 } }, V: { min: { value: -3 } } });
    expect(result.definition.bounds.Z.max.value).toBe(1);
    expect(functionCurveDraft(createFunctionSurface(createEmptyPartDocument(), result.definition)).scalars['V.min'].source).toBe('-3');
  });
  it.each(['Z+1', 'T', 'U'])('座標曲面の入力に出力軸や未宣言変数%sを混ぜない', async source => {
    const draft = surface(), result = await evaluate({ ...draft, outputs: { ...draft.outputs, Z: editFunctionField(draft.outputs.Z, source) } });
    expect(result.ok).toBe(false);
  });
});
