import { beforeAll, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMathBackend } from './createMathBackend.js';
import { executeMathWorkRequest, type MathExecutionBackend } from './mathWorkExecution.js';
import { createFunctionMathSource } from './functionMathSource.js';
import { createFunctionCurveWorkEnvelope, type FunctionCurveWorkRequest } from './functionCurveWorkRequest.js';
import { decodeFunctionCurveWorkReply } from './functionCurveWorkReply.js';
import { executePreparedFunctionWork } from './functionWorkPreparation.js';
import { prepareOdeFunctions } from './odeFunctionPreparation.js';
import { createFunctionCurveEvaluator } from './functionCurveEvaluation.js';
import type { ExactMathEngine } from './exactMathWorkExecution.js';
import { createCurvePointWorkEnvelope } from './curvePointWorkEnvelope.js';
import { decodeCurvePointWorkReply } from './curvePointWorkReply.js';
import { saveCurvePointInput, type CurvePointWorkRequest } from './curvePointWorkRequest.js';
import { createCurvePointContinuationWorkEnvelope, decodeCurvePointContinuationWorkReply } from './curvePointContinuationWork.js';

let backend: MathExecutionBackend;
beforeAll(() => { backend = createMathBackend(); });
const linear = 'component(odeat(odesolve([diff(y,x,x)=0],x,[y],[[y,0,2],[y,2,6]]),1,[],T),1)';
function request(y = linear, coefficients: FunctionCurveWorkRequest['coefficients'] = [], angleUnit: 'degree' | 'radian' = 'radian'): FunctionCurveWorkRequest {
  const definition = (source: string) => createFunctionMathSource(source, 'text', angleUnit, { axes: [], parameters: ['T'], coefficients }, backend);
  return { identity: { documentId: 'ode-curve', documentVersion: 1, editorId: 'curve', inputRevision: 1 },
    independent: 'T', outputs: [definition('T'), definition(y), definition('0')], lower: -2, upper: 2,
    minimum: [-10, -10, -10], maximum: [10, 10, 10], tolerance: 0.001, coefficients };
}
function engine() {
  const evaluateMany = vi.fn<NonNullable<ExactMathEngine['evaluateMany']>>(inputs => {
    const file = fileURLToPath(new URL('./exactRuntime/cas_ode_test.py', import.meta.url));
    const result = spawnSync('python', ['-B', '-X', 'utf8', file, '--batch'], {
      input: JSON.stringify(inputs), encoding: 'utf8', timeout: 120_000, maxBuffer: 2_000_000,
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1' },
    });
    if (result.error !== undefined || result.status !== 0) throw new Error('解曲線の実計算に失敗しました。\n' + result.stderr + (result.error?.message ?? ''));
    const values: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(values)) throw new Error('解曲線の返信が一覧ではありません。');
    return Promise.resolve<readonly unknown[]>(values);
  });
  return { evaluateMany, evaluate: vi.fn<ExactMathEngine['evaluate']>(() => { throw new Error('一つの依頼の準備はまとめて行います。'); }) };
}
async function prepared(input: FunctionCurveWorkRequest, exact = engine()) {
  const current = await prepareOdeFunctions(input.outputs.map(definition => ({ definition, inputs: [input.independent], coefficients: input.coefficients })),
    { backend, engine: exact, shouldStop: () => undefined });
  return { exact, evaluator: createFunctionCurveEvaluator(input.outputs, input.independent, input.coefficients, { backend: current, shouldStop: () => undefined }) };
}
describe('微分方程式の原式を曲線・点・方向へ共通に接続する', () => {
  it('通常の関数入力から適用でき、保存した原式のまま両端条件の直線を描く', async () => {
    const input = request(), before = JSON.stringify(input);
    const edited = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request: { identity: input.identity,
      source: linear, notation: 'text', angleUnit: 'radian', coefficients: [], functionScope: { axes: [], parameters: ['T'] } } }, backend);
    expect(edited.evaluation).toMatchObject({ status: 'value', kind: 'function' });
    const raw = await executePreparedFunctionWork(createFunctionCurveWorkEnvelope(1, input), { backend, engine: engine(), shouldStop: () => undefined });
    const reply = decodeFunctionCurveWorkReply(raw, input);
    if (reply.result.status !== 'ready') throw new Error(JSON.stringify(reply));
    for (const row of reply.result.components.flat()) expect(row.point).toEqual([row.parameter, 2 + 2 * row.parameter, 0]);
    expect(reply.result.components.flat().length).toBeGreaterThan(1);
    expect(JSON.stringify(input)).toBe(before);
  }, 130_000);
  it.each(['degree', 'radian'] as const)('%sでも二階の式の解を元の微分規約どおりsin(T)として使う', async angle => {
    const input = request('component(odeat(odesolve([diff(y,x,x)=-y],x,[y],[[y,0,0],[diff(y,x),0,1]]),1,[],T),1)', [], angle);
    const { evaluator, exact } = await prepared(input);
    for (const x of [-1, 0, 0.5, 1]) expect(evaluator.point(x)?.[1]).toBeCloseTo(Math.sin(x), 12);
    expect(exact.evaluateMany).toHaveBeenCalledOnce();
  }, 130_000);
  it('同じ連続した二つの式を複数の座標から使っても一度だけ解く', async () => {
    const problem = 'odesolve([diff(y,x)=z,diff(z,x)=-y],x,[y,z],[[y,0,0],[z,0,1]])';
    const base = request(`component(odeat(${problem},1,[],T),1)`);
    const input = { ...base, outputs: [createFunctionMathSource(`component(odeat(${problem},1,[],T),2)`, 'text', 'radian',
      { axes: [], parameters: ['T'], coefficients: [] }, backend), base.outputs[1], base.outputs[2]] as const };
    const { evaluator, exact } = await prepared(input);
    for (let index = 0; index < 100; index++) {
      const x = index / 100, point = evaluator.point(x);
      expect(point?.[0]).toBeCloseTo(Math.cos(x), 12); expect(point?.[1]).toBeCloseTo(Math.sin(x), 12);
    }
    expect(exact.evaluateMany).toHaveBeenCalledOnce(); expect(exact.evaluateMany.mock.calls[0][0]).toHaveLength(1);
  }, 130_000);
  it('係数変更では同じ原式から解き直し、保存の往復で条件と答えを保持する', async () => {
    const source = 'component(odeat(odesolve([diff(y,x)=coef("a")],x,[y],[[y,0,1]]),1,[],T),1)';
    const first = request(source, [{ id: 'a', label: 'a', decimal: '2' }]);
    const second = { ...first, coefficients: [{ id: 'a', label: 'a', decimal: '3' }] };
    expect((await prepared(first)).evaluator.point(2)).toEqual([2, 5, 0]);
    expect((await prepared(JSON.parse(JSON.stringify(second)) as FunctionCurveWorkRequest)).evaluator.point(2)).toEqual([2, 7, 0]);
    expect(first.outputs[1].source).toBe(source);
  }, 130_000);
  it.each(['0*(1/x)', '0*(x/x)', '0*ln(x)'])('元の%sで使えない位置を、整理後の直線でつながない', async operand => {
    const input = request(`component(odeat(odesolve([diff(y,x)+${operand}=1],x,[y],[[y,1,2]]),1,[],T),1)`);
    const { evaluator } = await prepared(input);
    expect(evaluator.point(0)).toBeNull(); expect(evaluator.point(-1)).toEqual([-1, 0, 0]); expect(evaluator.point(1)).toEqual([1, 2, 0]);
    expect(evaluator.enclosure(-1, 1).some(value => !value.continuous)).toBe(true);
  }, 130_000);
  it('自由定数を勝手に補わず、位置に依存する定数も拒否する', async () => {
    for (const constants of ['[]', '[T]']) {
      const input = request(`component(odeat(odesolve([diff(y,x)=2],x,[y],[]),1,${constants},T),1)`);
      const reply = await executePreparedFunctionWork(createFunctionCurveWorkEnvelope(1, input), { backend, engine: engine(), shouldStop: () => undefined });
      expect(decodeFunctionCurveWorkReply(reply, input).result.status).toBe('invalid');
    }
    expect((await prepared(request('component(odeat(odesolve([diff(y,x)=2],x,[y],[]),1,[5],T),1)'))).evaluator.point(1)).toEqual([1, 7, 0]);
  }, 130_000);
  it('曲線上の点から接線・法線を求める入口にも同じ準備を使う', async () => {
    const quadratic = 'component(odeat(odesolve([diff(y,x)=2*x],x,[y],[[y,0,1]]),1,[],T),1)';
    const input: CurvePointWorkRequest = { ...request(quadratic), kind: 'curve', known: [{ axis: 'X', value: 1 }], tolerance: 1e-7 };
    const exact = engine(), options = { backend, engine: exact, shouldStop: () => undefined };
    const first = decodeCurvePointWorkReply(await executePreparedFunctionWork(createCurvePointWorkEnvelope(1, input), options), input);
    if (first.result.status !== 'ready') throw new Error(JSON.stringify(first));
    expect(first.result.candidates[0].point).toEqual([1, 2, 0]);
    for (const kind of ['tangent', 'normal'] as const) {
      const saved = saveCurvePointInput(input), current = { identity: input.identity, previous: saved, current: saved,
        anchor: first.result.candidates[0].location, direction: { kind, length: Math.sqrt(5), reverse: false } };
      const reply = decodeCurvePointContinuationWorkReply(await executePreparedFunctionWork(createCurvePointContinuationWorkEnvelope(2, current), options), current);
      if (reply.result.status !== 'ready' || reply.result.endpoint === undefined) throw new Error(JSON.stringify(reply));
      const [x, y, z] = reply.result.endpoint.point;
      expect(z).toBe(0); expect(Math.hypot(x - 1, y - 2)).toBeCloseTo(Math.sqrt(5), 6);
      if (kind === 'tangent') expect((y - 2) / (x - 1)).toBeCloseTo(2, 6);
      else expect((x - 1) + 2 * (y - 2)).toBeCloseTo(0, 6);
    }
    // 直線には一意な主法線がない。曲線の確認へ替えても、この拒否を保持する。
    const straight: CurvePointWorkRequest = { ...request(), kind: 'curve', known: [{ axis: 'X', value: 1 }], tolerance: 1e-7 };
    const straightPoint = decodeCurvePointWorkReply(await executePreparedFunctionWork(createCurvePointWorkEnvelope(3, straight), options), straight);
    if (straightPoint.result.status !== 'ready') throw new Error(JSON.stringify(straightPoint));
    const saved = saveCurvePointInput(straight), normal = { identity: straight.identity, previous: saved, current: saved,
      anchor: straightPoint.result.candidates[0].location, direction: { kind: 'normal' as const, length: 1, reverse: false } };
    const refused = decodeCurvePointContinuationWorkReply(await executePreparedFunctionWork(createCurvePointContinuationWorkEnvelope(4, normal), options), normal);
    expect(refused.result.status).toBe('invalid');
  }, 130_000);
  it('保存した独立座標の点と主法線を、初期条件の編集と取り消しに追従させる', async () => {
    function pointInput(initial: number): CurvePointWorkRequest {
      const curve=request(), scope={axes:['X' as const],parameters:[],coefficients:[]};
      const source=`component(odeat(odesolve([diff(y,x)=2*x],x,[y],[[y,0,${initial}]]),1,[],X),1)`;
      const definition=(value:string)=>createFunctionMathSource(value,'text','radian',scope,backend);
      return {...curve,kind:'curve',independent:'X',known:[{axis:'X',value:1}],tolerance:1e-7,
        minimum:[-2,-10,-10],maximum:[2,10,10],outputs:[definition('X'),definition(source),definition('0')]};
    }
    const before=pointInput(1),after=pointInput(2),options={backend,engine:engine(),shouldStop:()=>undefined};
    const first=decodeCurvePointWorkReply(await executePreparedFunctionWork(createCurvePointWorkEnvelope(1,before),options),before);
    if(first.result.status!=='ready') throw new Error(JSON.stringify(first));
    expect(first.result.candidates[0].point).toEqual([1,2,0]);
    const saved:unknown=JSON.parse(JSON.stringify(before));
    const current={identity:before.identity,previous:saveCurvePointInput(saved),current:saveCurvePointInput(after),
      anchor:first.result.candidates[0].location,direction:{kind:'normal' as const,length:Math.sqrt(5),reverse:false}};
    const result=decodeCurvePointContinuationWorkReply(await executePreparedFunctionWork(createCurvePointContinuationWorkEnvelope(2,current),options),current);
    if(result.result.status!=='ready' || result.result.endpoint===undefined) throw new Error(JSON.stringify(result));
    expect(result.result.candidate.point).toEqual([1,3,0]);
    const endpoint=result.result.endpoint.point;
    [-1,4,0].forEach((value,index)=>expect(endpoint[index]).toBeCloseTo(value,6));
    const undo={...current,previous:current.current,current:current.previous,anchor:result.result.candidate.location};
    const restored=decodeCurvePointContinuationWorkReply(await executePreparedFunctionWork(createCurvePointContinuationWorkEnvelope(3,undo),options),undo);
    expect(restored.result).toMatchObject({status:'ready',candidate:{point:[1,2,0]}});
  },130_000);
  it('中止済みの入力と改変された保存内容は計算部を起動しない', async () => {
    const input = request(), exact = engine();
    const result = await executePreparedFunctionWork(createFunctionCurveWorkEnvelope(1, input), { backend, engine: exact, shouldStop: () => 'cancelled' });
    expect(decodeFunctionCurveWorkReply(result, input).result).toMatchObject({ status: 'stopped', reason: 'cancelled' });
    const changed = { ...input, outputs: [{ ...input.outputs[0], source: '0' }, input.outputs[1], input.outputs[2]] };
    const invalid = await executePreparedFunctionWork({ kind: 'sample-function-curve', serial: 2, request: changed }, { backend, engine: exact, shouldStop: () => undefined });
    expect(decodeFunctionCurveWorkReply(invalid, input).result.status).toBe('invalid');
    expect(exact.evaluateMany).not.toHaveBeenCalled();
  });
});
