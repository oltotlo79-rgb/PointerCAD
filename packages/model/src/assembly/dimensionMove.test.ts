/**
 * 配置の補助 P-A 寸法で動かすの検査: 選んだ部品を世界の軸の向きに、基準(原点の面・ほかの部品)からの内側・芯・外側の寸法が打った数になるように
 * 平行に動かし、締結の組は一緒に動き、ほかの 2 つの座標の式はそのまま。断る理由(固定・自分が基準・量 0・合致に指されている・箱が無い)。
 * 期待は手で解いた値(箱は 20 mm 角。部品 A は x 0〜20、部品 B は x 100〜120)。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from './createAssemblyDocument.js';
import { measureComponentDimension, planDimensionMove } from './dimensionMove.js';
import type { PartBox } from './frame/frameJointCheck.js';
import type { AssemblyComponent, AssemblyDocument, Mate } from './types.js';

const A = 'comp-a', B = 'comp-b', C = 'comp-c', N = 'comp-n';

function component(id: string, x: number, overrides: Partial<AssemblyComponent> = {}): AssemblyComponent {
  return { id, name: id, source: { kind: 'part', partRef: `part-${id}` }, fixed: false, visible: true, suppressed: false,
    placement: { ...DEFAULT_COMPONENT_PLACEMENT, position: [expressionValueFromNumber(x), expressionValueFromNumber(0),
      expressionValueFromNumber(0)] }, ...overrides };
}
const box = (x: number): PartBox => ({ min: [x, 0, 0], max: [x + 20, 20, 20] });
const assembly = (...components: readonly AssemblyComponent[]): AssemblyDocument => ({ ...createAssemblyDocument('組立'), components });
const BOXES = new Map<string, PartBox>([[A, box(0)], [B, box(100)], [C, box(100)]]);
/** 計画の頼み(書き出しは関数だけにし、型は関数の引数から取る)。 */
type DimensionMoveRequest = Parameters<typeof planDimensionMove>[1];
const request = (overrides: Partial<DimensionMoveRequest>): DimensionMoveRequest =>
  ({ componentId: B, axis: 0, reference: { kind: 'component', componentId: A }, basis: 'inner', target: 50, ...overrides });
const xOf = (document: AssemblyDocument, id: string): number | undefined =>
  document.components.find((candidate) => candidate.id === id)?.placement.position[0].value;

describe('寸法で動かす', () => {
  it('寸法の取り方: 内側はすき間、芯は中心どうし、外側は外形の全体で、部品が基準の - 側でも同じ向きの寸法', () => {
    const document = assembly(component(A, 0), component(B, 100));
    const measure = (componentId: string, reference: DimensionMoveRequest['reference'], basis: DimensionMoveRequest['basis']):
    number | null => measureComponentDimension(document, { componentId, axis: 0, reference, basis }, BOXES);
    const fromA = { kind: 'component', componentId: A } as const, fromB = { kind: 'component', componentId: B } as const;
    expect([measure(B, fromA, 'inner'), measure(B, fromA, 'center'), measure(B, fromA, 'outer')]).toEqual([80, 100, 120]);
    // - 側の部品(A を B から測る)も、同じ向きの寸法(すき間 80)。原点の面から A の外側は 20。
    expect(measure(A, fromB, 'inner')).toBe(80);
    expect(measure(A, { kind: 'origin' }, 'outer')).toBe(20);
  });

  it('ほかの部品を基準に、すき間 80 を 50 にすると -30 動き、芯 100 を 150 にすると +50 動く(ほかの座標の式はそのまま)', () => {
    const document = assembly(component(A, 0, { fixed: true }), component(B, 100));
    const inner = planDimensionMove(document, request({}), BOXES);
    expect(inner.ok ? [inner.current, inner.delta, xOf(inner.document, B), inner.movedIds] : inner).toEqual([80, -30, 70, [B]]);
    const center = planDimensionMove(document, request({ basis: 'center', target: 150 }), BOXES);
    expect(center.ok ? [center.delta, xOf(center.document, B)] : center).toEqual([50, 150]);
    expect(center.ok ? center.document.components.find((item) => item.id === B)?.placement.position.slice(1) : null)
      .toEqual(document.components[1]?.placement.position.slice(1));
  });

  it('原点の面を基準に、- 側の部品の外側 120 を 200 にすると - の向きへ 80 動く', () => {
    const plan = planDimensionMove(assembly(component(N, -120)),
      request({ componentId: N, reference: { kind: 'origin' }, basis: 'outer', target: 200 }), new Map([[N, box(-120)]]));
    expect(plan.ok ? [plan.current, plan.delta, xOf(plan.document, N)] : plan).toEqual([120, -80, -200]);
  });

  it('締結で 1 つの組になった部品は一緒に動く(組の中の締結の記録は数えない)', () => {
    const document = assembly(component(A, 0), component(B, 100, { rigidGroupId: 'g1' }), component(C, 100, { rigidGroupId: 'g1' }));
    const plan = planDimensionMove(document, request({ target: 60 }), BOXES);
    expect(plan.ok ? [plan.movedIds, xOf(plan.document, B), xOf(plan.document, C), xOf(plan.document, A)] : plan)
      .toEqual([[B, C], 80, 80, 0]);
  });

  it('今の寸法(数を打つ前に窓に出す): 内側 80・芯 100、箱が無い・自分が基準の時は出さない', () => {
    const document = assembly(component(A, 0), component(B, 100));
    const base = { componentId: B, axis: 0, reference: { kind: 'component', componentId: A } } as const;
    expect(measureComponentDimension(document, { ...base, basis: 'inner' }, BOXES)).toBe(80);
    expect(measureComponentDimension(document, { ...base, basis: 'center' }, BOXES)).toBe(100);
    expect(measureComponentDimension(document, { ...base, basis: 'inner' }, new Map([[B, box(100)]]))).toBeNull();
    expect(measureComponentDimension(document, { ...base, basis: 'inner', reference: { kind: 'component', componentId: B } }, BOXES))
      .toBeNull();
  });

  it('断る: 固定・自分(か同じ組)が基準・量 0・合致に指されている・箱が無い・知らない部品・有限でない数', () => {
    const document = assembly(component(A, 0), component(B, 100));
    expect(planDimensionMove(assembly(component(A, 0), component(B, 100, { fixed: true })), request({}), BOXES))
      .toEqual({ ok: false, reason: 'fixed', count: 0 });
    expect(planDimensionMove(document, request({ reference: { kind: 'component', componentId: B } }), BOXES))
      .toEqual({ ok: false, reason: 'sameComponent', count: 0 });
    expect(planDimensionMove(document, request({ target: 80 }), BOXES)).toEqual({ ok: false, reason: 'noChange', count: 0 });
    const mate: Mate = { id: 'mate-1', name: '距離', kind: 'distance', suppressed: false, flipped: false, value: expressionValueFromNumber(80),
      a: { kind: 'origin', componentId: A, element: 'yz' }, b: { kind: 'origin', componentId: B, element: 'yz' } };
    expect(planDimensionMove({ ...document, mates: [mate] }, request({}), BOXES)).toEqual({ ok: false, reason: 'referenced', count: 1 });
    expect(planDimensionMove(document, request({}), new Map([[B, box(100)]]))).toEqual({ ok: false, reason: 'noBox', count: 0 });
    expect(planDimensionMove(document, request({ componentId: 'comp-x' }), BOXES)).toEqual({ ok: false, reason: 'unknownComponent', count: 0 });
    expect(planDimensionMove(document, request({ target: Number.NaN }), BOXES)).toEqual({ ok: false, reason: 'nonFinite', count: 0 });
  });
});
