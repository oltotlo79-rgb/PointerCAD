/**
 * 配置の補助 P-A 寸法で動かすの検査: 選んだ部品を向き(世界の軸か、成分で決めた斜めの向き)に、基準(原点の面・ほかの部品)からの
 * 内側・芯・外側の寸法が打った数になるように平行に動かし、締結の組は一緒に動き、向きの成分が 0 の座標の式はそのまま。
 * 断る理由(固定・自分が基準・量 0・合致に指されている・範囲が無い・向きの長さが 0)。
 * 部品の範囲は呼ぶ側が向きに沿って測って渡す(ここでは手で解いた値を渡す)。
 * 世界の軸の検査の期待は手で解いた値で、範囲の渡し方を変えた後も同じ(箱は 20 mm 角。部品 A は x 0〜20、部品 B は x 100〜120)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import {
  dimensionMeasureErrorMm, dimensionMoveUnitVector, measureComponentDimension, planDimensionMove, type DimensionMoveExtent,
} from './dimensionMove.js';
import type { AssemblyComponent, AssemblyDocument, Mate } from './types.js';

const A = 'comp-a', B = 'comp-b', C = 'comp-c', N = 'comp-n';

function component(id: string, x: number, overrides: Partial<AssemblyComponent> = {}): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: `part-${id}` }, fixed: false, visible: true, suppressed: false,
    placement: { ...DEFAULT_COMPONENT_PLACEMENT, position: [expressionValueFromNumber(x), expressionValueFromNumber(0),
      expressionValueFromNumber(0)] }, ...overrides };
}
/** X の向きに沿った 20 mm 角の箱の範囲(x 〜 x + 20)。 */
const span = (x: number): DimensionMoveExtent => ({ low: x, high: x + 20 });
const assembly = (...components: readonly AssemblyComponent[]): AssemblyDocument => ({ ...createAssemblyDocument('組立'), components });
const EXTENTS = new Map<string, DimensionMoveExtent>([[A, span(0)], [B, span(100)], [C, span(100)]]);
const X_AXIS = { kind: 'axis', axis: 0 } as const;
/** 計画の頼み(書き出しは関数だけにし、型は関数の引数から取る)。 */
type DimensionMoveRequest = Parameters<typeof planDimensionMove>[1];
const request = (overrides: Partial<DimensionMoveRequest>): DimensionMoveRequest =>
  ({ componentId: B, direction: X_AXIS, reference: { kind: 'component', componentId: A }, basis: 'inner', target: 50, ...overrides });
const xOf = (document: AssemblyDocument, id: string): number | undefined =>
  document.components.find((candidate) => candidate.id === id)?.placement.position[0].value;

describe('寸法で動かす(世界の軸)', () => {
  it('寸法の取り方: 内側はすき間、芯は中心どうし、外側は外形の全体で、部品が基準の - 側でも同じ向きの寸法', () => {
    const document = assembly(component(A, 0), component(B, 100));
    const measure = (componentId: string, reference: DimensionMoveRequest['reference'], basis: DimensionMoveRequest['basis']):
    number | null => measureComponentDimension(document, { componentId, direction: X_AXIS, reference, basis }, EXTENTS);
    const fromA = { kind: 'component', componentId: A } as const, fromB = { kind: 'component', componentId: B } as const;
    expect([measure(B, fromA, 'inner'), measure(B, fromA, 'center'), measure(B, fromA, 'outer')]).toEqual([80, 100, 120]);
    // - 側の部品(A を B から測る)も、同じ向きの寸法(すき間 80)。原点の面から A の外側は 20。
    expect(measure(A, fromB, 'inner')).toBe(80);
    expect(measure(A, { kind: 'origin' }, 'outer')).toBe(20);
  });

  it('ほかの部品を基準に、すき間 80 を 50 にすると -30 動き、芯 100 を 150 にすると +50 動く(ほかの座標の式はそのまま)', () => {
    const document = assembly(component(A, 0, { fixed: true }), component(B, 100));
    const inner = planDimensionMove(document, request({}), EXTENTS);
    expect(inner.ok ? [inner.current, inner.delta, xOf(inner.document, B), inner.movedIds] : inner).toEqual([80, -30, 70, [B]]);
    const center = planDimensionMove(document, request({ basis: 'center', target: 150 }), EXTENTS);
    expect(center.ok ? [center.delta, xOf(center.document, B), center.rewrittenAxes, center.formulaAxes] : center).toEqual([50, 150, [0], []]);
    expect(center.ok ? center.document.components.find((item) => item.id === B)?.placement.position.slice(1) : null)
      .toEqual(document.components[1]?.placement.position.slice(1));
  });

  it('原点の面を基準に、- 側の部品の外側 120 を 200 にすると - の向きへ 80 動く', () => {
    const plan = planDimensionMove(assembly(component(N, -120)),
      request({ componentId: N, reference: { kind: 'origin' }, basis: 'outer', target: 200 }), new Map([[N, span(-120)]]));
    expect(plan.ok ? [plan.current, plan.delta, xOf(plan.document, N)] : plan).toEqual([120, -80, -200]);
  });

  it('締結で 1 つの組になった部品は一緒に動く(組の中の締結の記録は数えない)', () => {
    const document = assembly(component(A, 0), component(B, 100, { rigidGroupId: 'g1' }), component(C, 100, { rigidGroupId: 'g1' }));
    const plan = planDimensionMove(document, request({ target: 60 }), EXTENTS);
    expect(plan.ok ? [plan.movedIds, xOf(plan.document, B), xOf(plan.document, C), xOf(plan.document, A)] : plan)
      .toEqual([[B, C], 80, 80, 0]);
  });

  it('今の寸法(数を打つ前に窓に出す): 内側 80・芯 100、範囲が無い・自分が基準の時は出さない', () => {
    const document = assembly(component(A, 0), component(B, 100));
    const base = { componentId: B, direction: X_AXIS, reference: { kind: 'component', componentId: A } } as const;
    expect(measureComponentDimension(document, { ...base, basis: 'inner' }, EXTENTS)).toBe(80);
    expect(measureComponentDimension(document, { ...base, basis: 'center' }, EXTENTS)).toBe(100);
    expect(measureComponentDimension(document, { ...base, basis: 'inner' }, new Map([[B, span(100)]]))).toBeNull();
    expect(measureComponentDimension(document, { ...base, basis: 'inner', reference: { kind: 'component', componentId: B } }, EXTENTS))
      .toBeNull();
  });

  it('断る: 固定・自分(か同じ組)が基準・量 0・合致に指されている・範囲が無い・知らない部品・有限でない数', () => {
    const document = assembly(component(A, 0), component(B, 100));
    expect(planDimensionMove(assembly(component(A, 0), component(B, 100, { fixed: true })), request({}), EXTENTS))
      .toEqual({ ok: false, reason: 'fixed', count: 0 });
    expect(planDimensionMove(document, request({ reference: { kind: 'component', componentId: B } }), EXTENTS))
      .toEqual({ ok: false, reason: 'sameComponent', count: 0 });
    expect(planDimensionMove(document, request({ target: 80 }), EXTENTS)).toEqual({ ok: false, reason: 'noChange', count: 0 });
    const mate: Mate = { id: 'mate-1', name: '距離', kind: 'distance', suppressed: false, flipped: false, value: expressionValueFromNumber(80),
      a: { kind: 'origin', componentId: A, element: 'yz' }, b: { kind: 'origin', componentId: B, element: 'yz' } };
    expect(planDimensionMove({ ...document, mates: [mate] }, request({}), EXTENTS)).toEqual({ ok: false, reason: 'referenced', count: 1 });
    expect(planDimensionMove(document, request({}), new Map([[B, span(100)]]))).toEqual({ ok: false, reason: 'noBox', count: 0 });
    expect(planDimensionMove(document, request({ componentId: 'comp-x' }), EXTENTS)).toEqual({ ok: false, reason: 'unknownComponent', count: 0 });
    expect(planDimensionMove(document, request({ target: Number.NaN }), EXTENTS)).toEqual({ ok: false, reason: 'nonFinite', count: 0 });
  });
});

/*
 * 斜めの向き(1, 1, 0): 20 mm 角の箱 2 つ(中心 (0, 0, 0) と (40, 40, 0))。向きに沿った範囲は、中心と向きの内積 ± 10 × (|cos45°| + |sin45°|)
 * = ± 14.142136(手で解いた値): A は [-14.142136, 14.142136]、B は 56.568542 ± 14.142136 = [42.426407, 70.710678]。
 * 内側(すき間)は 42.426407 − 14.142136 = 28.284271。40 にすると 11.715729 動き、X・Y はそれぞれ 11.715729 × 0.707107 = 8.284271 増える。
 */
const ROOT_HALF = 14.142136;
const OBLIQUE = { kind: 'vector', vector: [1, 1, 0] } as const;
const OBLIQUE_EXTENTS = new Map<string, DimensionMoveExtent>([[A, { low: -ROOT_HALF, high: ROOT_HALF }], [B, { low: 42.426407, high: 70.710678 }]]);
const formula = (source: string, value: number) => ({ source, value, display: String(value) });

describe('寸法で動かす(斜めの向き)', () => {
  it('向きは長さ 1 に直す。世界の軸はその軸。長さ 0・有限でない成分は作れない', () => {
    const unit = dimensionMoveUnitVector(OBLIQUE);
    expect(unit?.map((value) => Math.round(value * 1e9) / 1e9)).toEqual([0.707106781, 0.707106781, 0]);
    expect(dimensionMoveUnitVector({ kind: 'axis', axis: 2 })).toEqual([0, 0, 1]);
    expect(dimensionMoveUnitVector({ kind: 'vector', vector: [0, 0, 0] })).toBeNull();
    expect(dimensionMoveUnitVector({ kind: 'vector', vector: [Number.NaN, 1, 0] })).toBeNull();
  });

  it('すき間 28.284271 を 40 にすると、向きに沿って 11.715729 動き、X・Y が 48.284271 になる(Z の式はそのまま)', () => {
    const second = component(B, 40, { placement: { ...DEFAULT_COMPONENT_PLACEMENT,
      position: [expressionValueFromNumber(40), expressionValueFromNumber(40), formula('高さ', 0)] } });
    const document = assembly(component(A, 0), second);
    expect(measureComponentDimension(document, { componentId: B, direction: OBLIQUE, reference: { kind: 'component', componentId: A },
      basis: 'inner' }, OBLIQUE_EXTENTS)).toBe(28.284271);
    const plan = planDimensionMove(document, request({ direction: OBLIQUE, target: 40 }), OBLIQUE_EXTENTS);
    const position = plan.ok ? plan.document.components.find((item) => item.id === B)?.placement.position : undefined;
    expect(plan.ok ? [plan.current, plan.delta, plan.rewrittenAxes, plan.formulaAxes] : plan).toEqual([28.284271, 11.715729, [0, 1], []]);
    expect(position?.slice(0, 2).map((value) => value.value)).toEqual([48.284271, 48.284271]);
    expect(position?.[2]).toEqual(formula('高さ', 0));
  });

  it('式を入れた座標を書き換える時は、その座標を計画に載せる(予告で、式が消えて数になる事を見せる)', () => {
    const second = component(B, 40, { placement: { ...DEFAULT_COMPONENT_PLACEMENT,
      position: [formula('40 + 0', 40), expressionValueFromNumber(40), expressionValueFromNumber(0)] } });
    const plan = planDimensionMove(assembly(component(A, 0), second), request({ direction: OBLIQUE, target: 40 }), OBLIQUE_EXTENTS);
    expect(plan.ok ? [plan.rewrittenAxes, plan.formulaAxes] : plan).toEqual([[0, 1], [0]]);
  });

  it('向きの長さが 0・有限でない時は断り、今の寸法も出さない', () => {
    const document = assembly(component(A, 0), component(B, 100));
    const zero = { kind: 'vector', vector: [0, 0, 0] } as const;
    expect(planDimensionMove(document, request({ direction: zero }), EXTENTS)).toEqual({ ok: false, reason: 'badDirection', count: 0 });
    expect(measureComponentDimension(document, { componentId: B, direction: zero, reference: { kind: 'origin' }, basis: 'inner' }, EXTENTS))
      .toBeNull();
  });

  it('網で測った端の誤差は、使った端だけを足して今の寸法の誤差の上限にする(式の値の端は 0)', () => {
    const document = assembly(component(A, 0), component(B, 100));
    // A の上の端は網の値(誤差 0.1)、B の下の端は網の値(誤差 0.05)、B の上の端は式の値。
    const extents = new Map<string, DimensionMoveExtent>([[A, { low: 0, high: 20, highErrorMm: 0.1 }],
      [B, { low: 100, high: 120, lowErrorMm: 0.05 }]]);
    const base = { componentId: B, direction: X_AXIS, reference: { kind: 'component', componentId: A } } as const;
    expect(dimensionMeasureErrorMm(document, { ...base, basis: 'inner' }, extents)).toBe(0.15);
    expect(dimensionMeasureErrorMm(document, { ...base, basis: 'outer' }, extents)).toBe(0);
    expect(dimensionMeasureErrorMm(document, { ...base, basis: 'center' }, extents)).toBe(0.075);
    const plan = planDimensionMove(document, request({}), extents);
    expect(plan.ok ? [plan.current, plan.meshErrorMm] : plan).toEqual([80, 0.15]);
    expect(dimensionMeasureErrorMm(document, { ...base, basis: 'inner' }, EXTENTS)).toBe(0);
  });

  it('成分 (1, 0, 0) の向きは、世界の X 軸と同じ計画になる', () => {
    const document = assembly(component(A, 0), component(B, 100));
    expect(planDimensionMove(document, request({ direction: { kind: 'vector', vector: [3, 0, 0] } }), EXTENTS))
      .toEqual(planDimensionMove(document, request({}), EXTENTS));
  });
});
