/**
 * GR-06 段階再計算(`scratchpad/claude/plans/geomref-plan.md` §4(d)、§5.2 GR-06、付録C・付録D、利用者の回答 Q7=O1)。
 *
 * 形は実際の OCCT(`loadOcctForNode`)、係数の式は実際の数学の計算部で計算する。測った値で係数を決め、その係数で
 * 別の形を作る流れ(付録D)、深さ2と上限8段の連なり、循環・順序違反の理由、段の中の取消、`recomputeSolids` の
 * 呼出し回数、参照先を切った文書、途中の段の失敗、関数作図の係数を確かめる。段取り(`planMathGeometryStages`)は
 * OCCT を使わない純関数として確かめる。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { expressionValueFromNumber, mathScalarExpression, type ExpressionValue } from '@pointercad/expression';
import { createFunctionMathSource, createMathBackend, executeFunctionCurveWorkRequest, executeFunctionImplicitCurveWorkRequest,
  executeMathWorkRequest, type MathExecutionBackend } from '@pointercad/expression/math/worker';
import { CANDIDATE_MATH_BY_ID, decodeMathWorkReply } from '@pointercad/expression/math/contracts';
import type { MathWorkRequest } from '@pointercad/expression/math/client';
import { createKernelApi } from '@pointercad/kernel';
import { loadOcctForNode } from '../../../kernel/src/occt/loadOcct.node.js';
import { FUNCTION_DEFINITION_FORMAT } from '../functionGeometry/functionDefinitionTypes.js';
import type { FunctionRecomputeContext } from '../functionGeometry/recomputeFunctionCurves.js';
import { createDirectKernelBridge } from '../kernelBridge.js';
import type { Parameter } from '../parameters/types.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature } from '../part/createPartDocument.js';
import type { DocumentMathContext } from '../part/evaluateDocumentMath.js';
import { recomputePart, type PartRecomputeResult } from '../part/recomputePart.js';
import type { ResolvedPart } from '../part/resolvePart.js';
import { documentUpTo } from '../part/timelineOrder.js';
import type { PartDocument } from '../part/types.js';
import { absoluteCoordinate } from '../sketch/createSketchDocument.js';
import { FREE_WORK_PLANE_ID } from '../sketch/planeMath.js';
import { sampleSpline } from '../sketch/splineMath.js';
import type { SketchFunctionCurveFeature, SketchLineFeature } from '../sketch/types.js';
import { mathGeometryOperationMessage, mathGeometryUnresolvedMessage } from './mathGeometryCoefficients.js';
import { MATH_GEOMETRY_MAX_STAGES, mathGeometryCycleMessage, mathGeometryOrderMessage,
  mathGeometryTooDeepMessage } from './mathGeometryDependencies.js';
import { DEFAULT_MATH_GEOMETRY_TOLERANCE, mathGeometryCoefficientId, mathGeometryDefinitionIdOf } from './mathGeometryIdentity.js';
import { isMathGeometryValue, planMathGeometryStages, unmeasuredMathGeometryOutcomes } from './mathGeometryStages.js';
import type { MathGeometryDefinition, MathGeometryOutcome, MathGeometryQuantity, MathSubShapeReference } from './mathGeometryTypes.js';

const createBridge = () => createDirectKernelBridge(createKernelApi(loadOcctForNode));
let backend: MathExecutionBackend, bridge: ReturnType<typeof createBridge>;
beforeAll(async () => {
  backend = createMathBackend(); await loadOcctForNode(); bridge = createBridge();
}, 180_000);
afterEach(() => { vi.restoreAllMocks(); });

// ---------------------------------------------------------------------------
// 文書の組み立て
// ---------------------------------------------------------------------------

const EMPTY = createEmptyPartDocument();
const DOCUMENT_ID = EMPTY.id;
const ev = expressionValueFromNumber;
const identity = { documentId: DOCUMENT_ID, documentVersion: 1, editorId: 'test', inputRevision: 1 };
type Coefficient = MathWorkRequest['coefficients'][number];
/** measure() の「参照する現在の図形を確認できません」(mathGeometry.ts の missing)。 */
const MISSING_MESSAGE = '参照する現在の図形を確認できません。参照先を選び直してください。';
/** measure() の「参照先の形を正しく計算できませんでした」(mathGeometry.ts の body)。 */
const FAILED_SHAPE_MESSAGE = '参照先の形を正しく計算できませんでした。';

function calculate(request: MathWorkRequest) {
  const raw = executeMathWorkRequest({ kind: 'evaluate-math', serial: 1, request }, backend);
  return decodeMathWorkReply(raw, request, { operationsById: CANDIDATE_MATH_BY_ID,
    coefficientIds: new Set(request.coefficients.map(coefficient => coefficient.id)), declaredIds: new Set() }).result;
}
/** 係数の式を実際の数学の計算部で読み、保存される形(原文・数学定義・そのときの値)にする。 */
function math(source: string, inputs: readonly Coefficient[] = []): ExpressionValue {
  const result = mathScalarExpression(calculate({ identity, source, notation: 'text', angleUnit: 'degree', coefficients: inputs }));
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
/** 編集画面が式を読むときに渡した図形の測定値。保存される値にしか効かず、再計算では使われない(古い値のまま)。 */
function measuredInput(definitionId: string, label: string, decimal: string): Coefficient {
  return { id: mathGeometryCoefficientId(definitionId), label, decimal };
}
function coefficient(name: string, serial: number, value: ExpressionValue, unit: Parameter['unit'] = 'mm'): Parameter {
  return { name, mathId: `coefficient:${String(serial)}`, unit, description: '', value };
}
/** 係数を名前で使う寸法欄(旧式の式)。保存された値(既定1)は再計算で使われてはならない。 */
function named(source: string, stale = 1): ExpressionValue {
  return { source, value: stale, display: String(stale) };
}
/** 箱(基本形状)を履歴の末尾へ足す。id・名前は `box-N`・`箱N`。 */
function appendBox(document: PartDocument, sizeX: ExpressionValue, sizeY: ExpressionValue = ev(30),
  sizeZ: ExpressionValue = ev(40), x = 0): PartDocument {
  const feature = createPrimitiveFeature(document, 'box');
  return appendSolid(document, { ...feature, origin: { kind: 'coordinate', value: absoluteCoordinate(x, 0, 0) },
    shape: { kind: 'box', sizeX, sizeY, sizeZ } });
}
function definition(id: string, name: string, quantity: MathGeometryQuantity): MathGeometryDefinition {
  return { id, documentId: DOCUMENT_ID, name, quantity, tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
}
function volumeOf(id: string, name: string, featureId: string): MathGeometryDefinition {
  return definition(id, name, { kind: 'volume', body: { kind: 'body', featureId } });
}

/** 付録D: 箱1(横 sizeX1・奥行30・高さ40)、箱2(横=幅B・奥行10・高さ10、位置(100,0,0))、幅B = coef("箱1体積")/1000。 */
function appendixD(sizeX1 = 20): PartDocument {
  const boxes = appendBox(appendBox(EMPTY, ev(sizeX1)), named('幅B', 10), ev(10), ev(10), 100);
  return { ...boxes,
    // 編集した時点の値(10000 → 幅B=10)は古い値。再計算は測った値だけを使う。
    parameters: [coefficient('幅B', 1, math('coef("箱1体積")/1000', [measuredInput('g-box1', '箱1体積', '10000')]))],
    mathGeometry: [volumeOf('g-box1', '箱1体積', 'box-1'), volumeOf('g-box2', '箱2体積', 'box-2')] };
}
/** 付録D の幅Bを、図形の測定値を使わない係数に置き換えた文書。 */
function withPlainWidth(value: ExpressionValue, sizeX1 = 20): PartDocument {
  return { ...appendixD(sizeX1), parameters: [coefficient('幅B', 1, value)] };
}

/** 実際の数学の計算部につないだ依頼口。送られた依頼を記録し、必要なら依頼ごとに口を挟む。 */
function mathContext(document: PartDocument, onRequest?: (request: MathWorkRequest) => void) {
  const requests: MathWorkRequest[] = [];
  const context: DocumentMathContext = { identity: { documentId: document.id, documentVersion: 1 }, isCurrent: () => true,
    client: { evaluate: request => {
      requests.push(request);
      const result = calculate(request);
      onRequest?.(request);
      return Promise.resolve({ status: 'result', identity: request.identity, result });
    } } };
  return { context, requests };
}
/** 依頼が図形の測定値(`math-geometry:` の識別番号)を係数として持つか。 */
function readsMeasured(request: MathWorkRequest): boolean {
  return request.coefficients.some(item => mathGeometryDefinitionIdOf(item.id) !== null);
}
/** 最後の段の測定結果: 定義ID → 値、未解決なら `unresolved:理由`。 */
function measured(result: PartRecomputeResult): ReadonlyMap<string, number | boolean | string> {
  return new Map((result.mathGeometry ?? []).map(outcome =>
    [outcome.id, outcome.status === 'value' ? outcome.value : `unresolved:${outcome.reason}`]));
}
function numberOf(value: number | boolean | string | undefined): number {
  if (typeof value !== 'number') throw new Error(`Expected a measured number, got ${String(value)}`);
  return value;
}
function volumes(result: PartRecomputeResult): ReadonlyMap<string, number> {
  return new Map(result.bodies.map(body => [body.featureId, body.volume]));
}
function messageOf(result: PartRecomputeResult, featureId: string): string | undefined {
  return result.errors.find(error => error.featureId === featureId)?.message;
}
/** これから形の計算部へ頼む段(立体の id の並び)を、呼んだ順に記録する(前の記録は消す)。 */
function recordSolidCalls() {
  const spy = vi.spyOn(bridge, 'recomputeSolids');
  spy.mockClear();
  return () => spy.mock.calls.map(([steps]) => steps.map(step => step.featureId));
}
/**
 * 箱1(横 sizeX)の X 方向の辺 4 本のうち、Y・Z が最も小さい 1 本を今の形の指紋で参照する
 * (箱は原点を中心に置かれるので、辺の中点は Y・Z が ±半分の位置にある)。
 */
async function xEdgeOf(sizeX: number): Promise<MathSubShapeReference<'edge'>> {
  const body = (await recomputePart(appendBox(EMPTY, ev(sizeX)), bridge)).bodies[0];
  const edges = body.edges.filter(candidate => Math.abs(candidate.length - sizeX) < 1e-9
    && candidate.axis !== null && Math.abs(Math.abs(candidate.axis[0]) - 1) < 1e-9);
  expect(edges).toHaveLength(4);
  const edge = [...edges].sort((a, b) => a.midpoint[1] - b.midpoint[1] || a.midpoint[2] - b.midpoint[2])[0];
  if (edge === undefined) throw new Error('The X edge of the box is expected');
  return { bodyFeatureId: body.featureId, index: edge.index, fingerprint: { kind: 'edge', curveKind: edge.curveKind,
    length: edge.length, position: edge.midpoint, axis: edge.axis, radius: edge.radius } };
}
/** 深さ2: 箱1の辺の長さ → P=2倍 → 箱2(横P) → 箱2体積 → Q=/1000 → 箱3(横Q)。箱3体積はどの係数も使わない。 */
function depthTwo(sizeX1: number, edge: MathSubShapeReference<'edge'>): PartDocument {
  const boxes = appendBox(appendBox(appendBox(EMPTY, ev(sizeX1)), named('P'), ev(10), ev(10), 100), named('Q'), ev(10), ev(10), 200);
  return { ...boxes,
    parameters: [coefficient('P', 1, math('coef("Aの辺")*2', [measuredInput('g-edge', 'Aの辺', '1')])),
      coefficient('Q', 2, math('coef("箱2体積")/1000', [measuredInput('g-box2', '箱2体積', '1')]))],
    mathGeometry: [definition('g-edge', 'Aの辺', { kind: 'length', curve: { kind: 'edge', reference: edge } }),
      volumeOf('g-box2', '箱2体積', 'box-2'), volumeOf('g-box3', '箱3体積', 'box-3')] };
}
/** 箱1の奥行きに、箱1を測った幅Bを使う(循環)。箱2は独立。 */
function cyclic(): PartDocument {
  const boxes = appendBox(appendBox(EMPTY, ev(20), named('幅B', 30)), ev(10), ev(10), ev(10), 100);
  return { ...boxes, parameters: [coefficient('幅B', 1, math('coef("箱1体積")/1000', [measuredInput('g-box1', '箱1体積', '30000')]))],
    mathGeometry: [volumeOf('g-box1', '箱1体積', 'box-1')] };
}
/** 箱1の横に、後ろの箱2を測った幅Bを使う(Q7=O1 の順序違反)。 */
function usesLater(): PartDocument {
  const boxes = appendBox(appendBox(EMPTY, named('幅B', 24), ev(10), ev(10)), ev(20), ev(30), ev(40), 100);
  return { ...boxes, parameters: [coefficient('幅B', 1, math('coef("箱2体積")/1000', [measuredInput('g-box2', '箱2体積', '24000')]))],
    mathGeometry: [volumeOf('g-box2', '箱2体積', 'box-2')] };
}
/** 9段の連なり: 箱k を測った P_k=体積/100 で箱k+1 の横を決める(どの箱も 240×10×10 か 20×30×40 で体積24000)。 */
function nineStages(): PartDocument {
  let document = appendBox(EMPTY, ev(20));
  const parameters: Parameter[] = [], mathGeometry: MathGeometryDefinition[] = [];
  for (let stage = 1; stage <= 9; stage += 1) {
    const k = String(stage);
    mathGeometry.push(volumeOf(`g${k}`, `体積${k}`, `box-${k}`));
    parameters.push(coefficient(`P${k}`, stage, math(`coef("体積${k}")/100`, [measuredInput(`g${k}`, `体積${k}`, '100')])));
    document = appendBox(document, named(`P${k}`), ev(10), ev(10), 300 * stage);
  }
  return { ...document, parameters, mathGeometry };
}

// ---------------------------------------------------------------------------

describe('段取り(planMathGeometryStages。OCCT を使わない)', () => {
  it('図形由来の係数が無い文書は null(係数の式が無い・式はあるが測定値を使わない・定義だけある)', () => {
    expect(planMathGeometryStages(EMPTY)).toBeNull();
    expect(planMathGeometryStages(withPlainWidth(ev(24)))).toBeNull();
    expect(planMathGeometryStages(withPlainWidth(math('24')))).toBeNull();
    // 係数の式が読めない文書も null(その式は数式の評価が今までどおり理由付きで断る)。
    const broken = math('coef("箱1体積")+coef("箱1体積")', [measuredInput('g-box1', '箱1体積', '1')]);
    const definitionOf = broken.mathDefinition;
    if (definitionOf === undefined) throw new Error('A math definition is expected');
    expect(planMathGeometryStages({ ...appendixD(), parameters: [coefficient('幅B', 1, { ...broken,
      mathDefinition: { ...definitionOf, expression: { kind: 'operation', operation: 'add', operands: [
        { kind: 'symbol', reference: { role: 'coefficient', id: mathGeometryCoefficientId('g-box1'), label: '箱1体積' } },
        { kind: 'symbol', reference: { role: 'coefficient', id: mathGeometryCoefficientId('g-box1'), label: '別名' } }] } } })] }))
      .toBeNull();
  });

  it('深さ1・深さ2: 段ごとに測る定義は文書の並びで、どの係数も使わない定義(箱2体積・箱3体積)は途中で測らない', () => {
    const one = planMathGeometryStages(appendixD());
    expect(one?.stages.map(stage => stage.map(item => item.id))).toEqual([['g-box1']]);
    expect(one?.blocked.size).toBe(0);
    const edge: MathSubShapeReference<'edge'> = { bodyFeatureId: 'box-1', index: 0, fingerprint: { kind: 'edge', curveKind: 'line',
      length: 20, position: [10, 0, 0], axis: [1, 0, 0], radius: null } };
    const two = planMathGeometryStages(depthTwo(20, edge));
    expect(two?.stages.map(stage => stage.map(item => item.id))).toEqual([['g-edge'], ['g-box2']]);
    expect(two?.blocked.size).toBe(0);
  });

  it('循環・順序違反・段数超過の係数は blocked に入り、その係数だけが使う定義は途中の段で測らない', () => {
    const cycle = planMathGeometryStages(cyclic());
    expect(cycle?.stages).toEqual([]);
    expect(cycle?.blocked).toEqual(new Map([['幅B', mathGeometryCycleMessage('幅B', '箱1体積', '箱1')]]));
    const order = planMathGeometryStages(usesLater());
    expect(order?.stages).toEqual([[]]);
    expect(order?.blocked).toEqual(new Map([['幅B', mathGeometryOrderMessage('箱1', '箱2', '箱2体積', '幅B')]]));
    const deep = planMathGeometryStages(nineStages());
    expect(deep?.stages.map(stage => stage.map(item => item.id))).toEqual(
      Array.from({ length: MATH_GEOMETRY_MAX_STAGES }, (_, index) => [`g${String(index + 1)}`]));
    expect(deep?.blocked).toEqual(new Map([['P9', mathGeometryTooDeepMessage()]]));
  });

  it('係数へ入る値は有限の実数だけで、段の失敗で測れなかった定義は理由付きの未解決(failed-geometry)になる', () => {
    const base = { id: 'g', documentId: DOCUMENT_ID, generation: 7 } as const;
    const real: MathGeometryOutcome = { ...base, status: 'value', kind: 'real', value: 24_000, unit: 'mm3',
      representation: 'geometry-double', tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE };
    expect(isMathGeometryValue(real)).toBe(true);
    expect(isMathGeometryValue({ ...real, value: Number.NaN })).toBe(false);
    expect(isMathGeometryValue({ ...base, status: 'value', kind: 'boolean', value: true, representation: 'geometry-double',
      tolerance: DEFAULT_MATH_GEOMETRY_TOLERANCE })).toBe(false);
    expect(isMathGeometryValue({ ...base, status: 'unresolved', reason: 'missing-reference', message: MISSING_MESSAGE })).toBe(false);
    expect(unmeasuredMathGeometryOutcomes([volumeOf('g-box1', '箱1体積', 'box-1')], DOCUMENT_ID, 7, '立体を作れませんでした: 切断'))
      .toEqual([{ id: 'g-box1', documentId: DOCUMENT_ID, generation: 7, status: 'unresolved', reason: 'failed-geometry',
        message: '立体を作れませんでした: 切断' }]);
  });
});

describe('段階再計算(実際の OCCT と数学の計算部)', () => {
  it('付録D: 箱1を測って幅Bを決め箱2を作る(箱2体積2400)。箱1の横25で幅B=30・箱2体積3000。最後の段は値を代入した文書と同じ形', async () => {
    for (const [sizeX1, volume1, width, volume2] of [[20, 24_000, 24, 2_400], [25, 30_000, 30, 3_000]] as const) {
      const document = appendixD(sizeX1), calls = recordSolidCalls(), onResolved = vi.fn<(resolved: ResolvedPart) => void>();
      const { context, requests } = mathContext(document);
      const started = performance.now();
      const result = await recomputePart(document, bridge, { math: context, onResolved });
      const elapsed = performance.now() - started;
      expect(result.cancelled).toBe(false);
      expect(result.errors).toEqual([]);
      const values = measured(result);
      expect(numberOf(values.get('g-box1'))).toBeCloseTo(volume1, 6);
      expect(numberOf(values.get('g-box2'))).toBeCloseTo(volume2, 6);
      expect(result.parameterAnalysis?.variables.get('幅B')).toBeCloseTo(width, 9);
      expect(volumes(result).get('box-2')).toBeCloseTo(volume2, 6);
      // 段1は箱1だけ(箱2は幅B待ち)、最後の段で両方。表示の登録は最後の段が決める。
      expect(calls()).toEqual([['box-1'], ['box-1', 'box-2']]);
      expect(onResolved).toHaveBeenCalledTimes(1);
      expect(onResolved.mock.calls[0]?.[0].steps.map(step => step.featureId)).toEqual(['box-1', 'box-2']);
      // 測った値は最後の段で1回だけ、最短の十進表記・厳密な原式なしで数学の計算部へ渡る(計算待ちの間は送らない)。
      expect(requests.filter(readsMeasured).map(request => request.coefficients))
        .toEqual([[{ id: mathGeometryCoefficientId('g-box1'), label: '箱1体積', decimal: String(values.get('g-box1')) }]]);
      expect(result.parameterAnalysis?.mathCoefficients?.get('幅B')).not.toHaveProperty('exactExpression');
      // 測った値をそのまま書いた文書(図形由来の係数なし)と同じ段の鍵・形になる。
      const plainResolved = vi.fn<(resolved: ResolvedPart) => void>();
      const plain = await recomputePart(withPlainWidth({ source: String(result.parameterAnalysis?.variables.get('幅B')),
        value: 0, display: '0' }, sizeX1), bridge, { onResolved: plainResolved });
      expect(plainResolved.mock.calls[0]?.[0].steps.map(step => [step.featureId, step.key]))
        .toEqual(onResolved.mock.calls[0]?.[0].steps.map(step => [step.featureId, step.key]));
      expect(volumes(plain)).toEqual(volumes(result));
      console.log(`[実測] 付録Dの段階再計算(横${String(sizeX1)}): ${elapsed.toFixed(1)}ms`);
    }
  });

  it('図形由来の係数が無い文書は今までと同じ1回だけの経路(段取り null、recomputeSolids 1回、測定は最後に1回)', async () => {
    for (const value of [ev(24), math('24')]) {
      const document = withPlainWidth(value), calls = recordSolidCalls(), onResolved = vi.fn();
      const read = vi.spyOn(bridge, 'readCachedBodies'), measure = vi.spyOn(bridge, 'measure');
      expect(planMathGeometryStages(document)).toBeNull();
      const started = performance.now();
      const result = await recomputePart(document, bridge, { math: mathContext(document).context, onResolved });
      const elapsed = performance.now() - started;
      expect(result.errors).toEqual([]);
      expect(calls()).toEqual([['box-1', 'box-2']]);
      expect(read).not.toHaveBeenCalled();
      expect(measure).not.toHaveBeenCalled();
      expect(onResolved).toHaveBeenCalledTimes(1);
      expect(numberOf(measured(result).get('g-box1'))).toBeCloseTo(24_000, 6);
      expect(numberOf(measured(result).get('g-box2'))).toBeCloseTo(2_400, 6);
      console.log(`[実測] 図形由来の係数が無い同じ形の再計算(${value.source}): ${elapsed.toFixed(1)}ms`);
    }
  });

  it('深さ2: 測った辺の2倍で箱2、箱2の体積で箱3を作り(4000・400)、箱1の横25に追従する(5000・500)。recomputeSolids 3回', async () => {
    const edge = await xEdgeOf(20);
    for (const [sizeX1, p, volume2, q, volume3] of [[20, 40, 4_000, 4, 400], [25, 50, 5_000, 5, 500]] as const) {
      const document = depthTwo(sizeX1, edge), calls = recordSolidCalls();
      const result = await recomputePart(document, bridge, { math: mathContext(document).context });
      expect(result.errors).toEqual([]);
      const values = measured(result);
      expect(numberOf(values.get('g-edge'))).toBeCloseTo(sizeX1, 9);
      expect(numberOf(values.get('g-box2'))).toBeCloseTo(volume2, 6);
      expect(numberOf(values.get('g-box3'))).toBeCloseTo(volume3, 6);
      expect(result.parameterAnalysis?.variables.get('P')).toBeCloseTo(p, 9);
      expect(result.parameterAnalysis?.variables.get('Q')).toBeCloseTo(q, 9);
      expect(calls()).toEqual([['box-1'], ['box-1', 'box-2'], ['box-1', 'box-2', 'box-3']]);
    }
  });

  it('循環: 形を作る前に付録Cの文で係数を止め、数学の計算部へ送らず、測る形も作らないので値を出さない', async () => {
    const document = cyclic(), calls = recordSolidCalls(), { context, requests } = mathContext(document);
    const result = await recomputePart(document, bridge, { math: context });
    expect(messageOf(result, '幅B')).toBe(
      '係数「幅B」は図形の測定値「箱1体積」を使っていますが、その測る形「箱1」が「幅B」を使って作られているため循環しています。');
    expect(messageOf(result, 'box-1')).toBeDefined();
    expect(result.bodies.map(body => body.featureId)).toEqual(['box-2']);
    expect(measured(result)).toEqual(new Map([['g-box1', 'unresolved:failed-geometry']]));
    expect(result.parameterAnalysis?.variables.has('幅B')).toBe(false);
    expect(requests.filter(readsMeasured)).toEqual([]);
    // 途中の段は無い(循環の値を待つ段を回さない)。
    expect(calls()).toEqual([['box-2']]);
  });

  it('順序違反: 付録Cの文で係数を止めるが、後ろの箱2は作って測る(途中の段は無く recomputeSolids 1回)', async () => {
    const document = usesLater(), calls = recordSolidCalls();
    const result = await recomputePart(document, bridge, { math: mathContext(document).context });
    expect(messageOf(result, '幅B')).toBe(
      '「箱1」は、後ろにある「箱2」を測った値（図形の測定値「箱2体積」）を係数「幅B」から使っています。「箱2」より後ろへ移してください。');
    expect(messageOf(result, 'box-1')).toBeDefined();
    expect(numberOf(measured(result).get('g-box2'))).toBeCloseTo(24_000, 6);
    expect(calls()).toEqual([['box-2']]);
  });

  it('段1の測定中の取消: 値も onResolved も残さず、最後の段へ進まない', async () => {
    const boxes = appendBox(appendBox(EMPTY, ev(20)), named('幅B'), ev(10), ev(10), 100);
    const document: PartDocument = { ...boxes,
      parameters: [coefficient('幅B', 1, math('coef("箱1面積")/520', [measuredInput('g-area', '箱1面積', '5200')]))],
      mathGeometry: [definition('g-area', '箱1面積', { kind: 'area', shape: { kind: 'body', featureId: 'box-1' } })] };
    // 取り消さなければ 面積5200 → 幅B=10 → 箱2体積1000。
    const completed = await recomputePart(document, bridge, { math: mathContext(document).context });
    expect(volumes(completed).get('box-2')).toBeCloseTo(1_000, 6);
    const calls = recordSolidCalls(), onResolved = vi.fn(), original = bridge.measure.bind(bridge);
    let cancelled = false;
    const measure = vi.spyOn(bridge, 'measure').mockImplementation(async (...args) => {
      const outcome = await original(...args); cancelled = true; return outcome;
    });
    const result = await recomputePart(document, bridge, { math: mathContext(document).context, onResolved,
      shouldCancel: () => cancelled });
    expect(result.cancelled).toBe(true);
    expect(result.mathGeometry).toBeUndefined();
    expect(result.bodies).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(onResolved).not.toHaveBeenCalled();
    expect(measure).toHaveBeenCalledTimes(1);
    expect(calls()).toEqual([['box-1']]);
  });

  it('最後の段(段2)の数式の評価中の取消: 値も onResolved も残さない', async () => {
    const document = appendixD(), calls = recordSolidCalls(), onResolved = vi.fn();
    let cancelled = false;
    const { context, requests } = mathContext(document, request => { if (readsMeasured(request)) cancelled = true; });
    const result = await recomputePart(document, bridge, { math: context, onResolved, shouldCancel: () => cancelled });
    expect(result.cancelled).toBe(true);
    expect(result.mathGeometry).toBeUndefined();
    expect(result.parameterAnalysis).toBeUndefined();
    expect(onResolved).not.toHaveBeenCalled();
    expect(requests.filter(readsMeasured)).toHaveLength(1);
    expect(calls()).toEqual([['box-1']]);
  });

  it('documentUpTo で測る形を切った文書: 係数は理由付きで失敗し、保存された古い値(999)も前の測定値も出さない', async () => {
    const full: PartDocument = { ...appendixD(), parameters: [...appendixD().parameters,
      coefficient('表示用', 2, math('coef("箱2体積")/1000', [measuredInput('g-box2', '箱2体積', '999000')]), 'none')] };
    const whole = await recomputePart(full, bridge, { math: mathContext(full).context });
    expect(whole.errors).toEqual([]);
    expect(whole.parameterAnalysis?.variables.get('表示用')).toBeCloseTo(2.4, 9);
    const cut = documentUpTo(full, 0);
    expect(cut.solids.map(feature => feature.id)).toEqual(['box-1']);
    const result = await recomputePart(cut, bridge, { math: mathContext(cut).context });
    expect(result.errors.map(error => [error.featureId, error.message])).toEqual([
      ['表示用', mathGeometryUnresolvedMessage('箱2体積', '表示用', MISSING_MESSAGE)]]);
    expect(result.parameterAnalysis?.variables.has('表示用')).toBe(false);
    expect(result.parameterAnalysis?.variables.get('幅B')).toBeCloseTo(24, 9);
    expect(measured(result).get('g-box2')).toBe('unresolved:missing-reference');
  });

  it('途中の段で値が得られなければ形を作り直さず、その先の定義は形の失敗の理由で未解決になる(recomputeSolids 2回)', async () => {
    const boxes = appendBox(appendBox(appendBox(EMPTY, ev(20)), named('P'), ev(10), ev(10), 100), named('Q'), ev(10), ev(10), 200);
    const document: PartDocument = { ...boxes,
      parameters: [coefficient('P', 1, math('coef("消えた体積")/1000', [measuredInput('g-gone', '消えた体積', '1')])),
        coefficient('Q', 2, math('coef("箱2体積")/1000', [measuredInput('g-box2', '箱2体積', '1')]))],
      mathGeometry: [volumeOf('g-gone', '消えた体積', 'box-deleted'), volumeOf('g-box2', '箱2体積', 'box-2')] };
    expect(planMathGeometryStages(document)?.stages.map(stage => stage.map(item => item.id))).toEqual([['g-gone'], ['g-box2']]);
    const calls = recordSolidCalls();
    const result = await recomputePart(document, bridge, { math: mathContext(document).context });
    expect(messageOf(result, 'P')).toBe(mathGeometryUnresolvedMessage('消えた体積', 'P', MISSING_MESSAGE));
    expect(messageOf(result, 'Q')).toBe(mathGeometryUnresolvedMessage('箱2体積', 'Q', FAILED_SHAPE_MESSAGE));
    expect(messageOf(result, 'box-2')).toBeDefined();
    expect(messageOf(result, 'box-3')).toBeDefined();
    expect(result.bodies.map(body => body.featureId)).toEqual(['box-1']);
    expect(measured(result)).toEqual(new Map([['g-gone', 'unresolved:missing-reference'], ['g-box2', 'unresolved:failed-geometry']]));
    // 段2は段1と同じ形しかできないので作り直さず、段1の形で測る。
    expect(calls()).toEqual([['box-1'], ['box-1']]);
  });

  it('途中の段で形の計算部の呼出しごと失敗しても、使う係数は「計算中」でなく理由付きで失敗し、最後の段は測り直す', async () => {
    const document = appendixD(), spy = vi.spyOn(bridge, 'recomputeSolids');
    spy.mockRejectedValueOnce(new Error('計算部との通信が切れました。'));
    const result = await recomputePart(document, bridge, { math: mathContext(document).context });
    expect(result.cancelled).toBe(false);
    expect(messageOf(result, '幅B')).toBe(mathGeometryUnresolvedMessage('箱1体積', '幅B', '立体を作れませんでした: 計算部との通信が切れました。'));
    expect(messageOf(result, 'box-2')).toBeDefined();
    expect(result.bodies.map(body => body.featureId)).toEqual(['box-1']);
    expect(numberOf(measured(result).get('g-box1'))).toBeCloseTo(24_000, 6);
    expect(measured(result).get('g-box2')).toBe('unresolved:failed-geometry');
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('上限8段: 8段まで測って箱を作り、9段目の値を使う係数は段数超過の理由で止め、9段目の定義は最後の段で測る', async () => {
    const document = nineStages(), calls = recordSolidCalls();
    const result = await recomputePart(document, bridge, { math: mathContext(document).context });
    expect(result.errors.map(error => error.featureId)).toEqual(['P9', 'box-10']);
    expect(messageOf(result, 'P9')).toBe('図形の測定値を使う係数の連なりが上限（8段）を超えています。');
    const values = measured(result);
    for (let stage = 1; stage <= 9; stage += 1) expect(numberOf(values.get(`g${String(stage)}`))).toBeCloseTo(24_000, 6);
    const boxes = (count: number) => Array.from({ length: count }, (_, index) => `box-${String(index + 1)}`);
    // 段k(1〜8)は箱1〜k、最後の段は箱1〜9(箱10は段数超過で作らない)。
    expect(calls()).toEqual([...Array.from({ length: 8 }, (_, index) => boxes(index + 1)), boxes(9)]);
  }, 120_000);

  it('関数作図の係数(R19): 別のスケッチの線の長さから倍率を決めて曲線 Y=2X を描き、計算待ちの間は関数の計算部を呼ばない', async () => {
    const line: SketchLineFeature = { id: 'measured-line', name: '測る線', kind: 'line', planeId: 'xy', construction: false,
      from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(20, 0, 0) };
    const formula = (source: string) => createFunctionMathSource(source, 'text', 'radian',
      { axes: ['X'], parameters: [], coefficients: [{ id: 'coefficient:1', label: '倍率' }] }, backend);
    const curve: SketchFunctionCurveFeature = { id: 'curve', name: '関数曲線', kind: 'functionCurve', planeId: FREE_WORK_PLANE_ID,
      construction: false, definition: { format: FUNCTION_DEFINITION_FORMAT, tolerance: ev(0.001),
        bounds: { X: { min: ev(-1), max: ev(1) }, Y: { min: ev(-4), max: ev(4) }, Z: { min: ev(-1), max: ev(1) } },
        formula: { kind: 'coordinate-curve', independent: 'X', outputs: { Y: formula('coef("倍率")*X'), Z: formula('0') } } } };
    // 測る線は関数曲線と別のスケッチに置く(同じスケッチを測ると、スケッチ単位の依存で循環になる。GR-02)。
    const document: PartDocument = { ...EMPTY,
      sketches: [{ ...EMPTY.sketches[0], features: [curve] }, { id: 'sketch-measured', name: '測るスケッチ', features: [line] }],
      parameters: [coefficient('倍率', 1, math('coef("線の長さ")/10', [measuredInput('g-line', '線の長さ', '10')]), 'none')],
      mathGeometry: [definition('g-line', '線の長さ', { kind: 'length', curve: { kind: 'sketch-curve', sketchId: 'sketch-measured',
        featureId: 'measured-line' } })] };
    let sampled = 0;
    const functions: FunctionRecomputeContext = { curves: { evaluate: request => {
      sampled += 1;
      return Promise.resolve({ status: 'result', identity: request.identity,
        result: executeFunctionCurveWorkRequest({ kind: 'sample-function-curve', serial: 1, request }, backend).result });
    } } };
    const result = await recomputePart(document, bridge, { math: mathContext(document).context, functions });
    expect(result.cancelled).toBe(false);
    expect(result.errors).toEqual([]);
    expect(measured(result)).toEqual(new Map([['g-line', 20]]));
    expect(result.parameterAnalysis?.variables.get('倍率')).toBe(2);
    const splines = (result.sketches[0]?.resolved.splines ?? []).filter(spline => spline.featureId === 'curve');
    expect(splines.length).toBeGreaterThan(0);
    for (const [x, y, z] of splines.flatMap(spline => sampleSpline(spline, 16))) {
      expect(Math.abs(y - 2 * x)).toBeLessThan(1e-9);
      expect(z).toBeCloseTo(0, 12);
    }
    expect(sampled).toBe(1);
  }, 60_000);

  it.each([['別のスケッチ', false], ['同じスケッチ', true]] as const)(
    'GR-06b の文書(断る曲線 floor(coef("R"))*X と陰関数の円)で、測る 2mm の線を%sに置く', async (_case, sameSketch) => {
      const parse = (source: string, axes: readonly ('X' | 'Y')[]) => createFunctionMathSource(source, 'text', 'radian',
        { axes, parameters: [], coefficients: [{ id: 'coefficient:1', label: 'R' }] }, backend);
      const bounds = { X: { min: ev(-4), max: ev(4) }, Y: { min: ev(-4), max: ev(4) }, Z: { min: ev(-4), max: ev(4) } };
      const plot = (id: string, formula: SketchFunctionCurveFeature['definition']['formula']): SketchFunctionCurveFeature => ({
        id, name: id, kind: 'functionCurve', planeId: FREE_WORK_PLANE_ID, construction: false,
        definition: { format: FUNCTION_DEFINITION_FORMAT, bounds, tolerance: ev(0.05), formula } });
      const refused = plot('refused', { kind: 'coordinate-curve', independent: 'X',
        outputs: { Y: parse('floor(coef("R"))*X', ['X']), Z: parse('0', ['X']) } });
      const circle = plot('circle', { kind: 'implicit-curve', expression: parse('X^2+Y^2-coef("R")^2', ['X', 'Y']),
        fixedAxis: 'Z', fixedCoordinate: ev(0) });
      const line: SketchLineFeature = { id: 'measured-line', name: '測る線', kind: 'line', planeId: FREE_WORK_PLANE_ID,
        construction: false, from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(2, 0, 0) };
      const first = EMPTY.sketches[0], measuredSketchId = sameSketch ? first.id : 'sketch-measured';
      const document: PartDocument = { ...EMPTY,
        sketches: sameSketch ? [{ ...first, features: [line, refused, circle] }]
          : [{ ...first, features: [refused, circle] }, { id: measuredSketchId, name: '測るスケッチ', features: [line] }],
        parameters: [coefficient('R', 1, math('coef("G")', [measuredInput('g1', 'G', '1')]))],
        mathGeometry: [definition('g1', 'G', { kind: 'length', curve: { kind: 'sketch-curve', sketchId: measuredSketchId,
          featureId: 'measured-line' } })] };
      const functions: FunctionRecomputeContext = {
        curves: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
          result: executeFunctionCurveWorkRequest({ kind: 'sample-function-curve', serial: 1, request }, backend).result }) },
        implicitCurves: { evaluate: request => Promise.resolve({ status: 'result', identity: request.identity,
          result: executeFunctionImplicitCurveWorkRequest({ kind: 'sample-function-implicit-curve', serial: 1, request }, backend).result }) },
      };
      const result = await recomputePart(document, bridge, { math: mathContext(document).context, functions });
      expect(result.cancelled).toBe(false);
      const circles = (result.sketches[0]?.resolved.splines ?? []).filter(spline => spline.featureId === 'circle');
      if (!sameSketch) {
        // 段1で線を測り(2)、最後の段で R=2 の円を描く。断るのは floor を使う曲線だけ。
        expect(result.errors.map(error => [error.featureId, error.message])).toEqual([['refused', mathGeometryOperationMessage('floor')]]);
        expect(circles.length).toBeGreaterThan(0);
        for (const [x, y] of circles.flatMap(spline => sampleSpline(spline, 16))) expect(Math.abs(Math.hypot(x, y) - 2)).toBeLessThan(0.05);
        return;
      }
      // 同じスケッチの要素は拘束・相対点で線と連動しうるので、GR-02 はスケッチ単位で上流に数え、循環として止める。
      expect(messageOf(result, 'R')).toBe(mathGeometryCycleMessage('R', 'G', first.name));
      expect(messageOf(result, 'circle')).toBeDefined();
      expect(circles).toEqual([]);
    }, 60_000);
});
