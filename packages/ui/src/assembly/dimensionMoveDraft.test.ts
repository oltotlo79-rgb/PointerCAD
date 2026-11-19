import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT, type AssemblyComponent } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  createDimensionMoveDraft, dimensionMoveDirectionPatch, dimensionMovePickCandidates, dimensionMoveReady, dimensionMoveReferences,
  withVectorComponent,
} from './dimensionMoveDraft.js';

/* 配置の補助 P-A 寸法で動かすの打ちかけ: 初めの欄、向きの替え方(軸から斜めへ替えると成分をその軸で始める)、基準の選択肢
 * (原点の面と、組の外の抑制していない部品)、確定を押せる条件。予告(向きに沿った範囲から今の寸法と計画)は model の dimensionMove.test.ts・
 * partExtentAlong.test.ts と画面検査で確かめる。 */
/** 基準の選択の値のうち、原点の面を表す物(打ちかけの中の値。窓の select の value)。 */
const ORIGIN_REFERENCE = 'origin';
const part = (id: string, overrides: Partial<AssemblyComponent> = {}): AssemblyComponent => ({ id, name: `部品 ${id}`,
  source: { kind: 'part', partRef: `part-${id}` }, placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false,
  ...overrides });

describe('寸法で動かすの打ちかけ', () => {
  it('初めは X・成分 (1, 0, 0)・原点の面・内側・寸法は空', () => {
    expect(createDimensionMoveDraft('doc-1', 'comp-b')).toEqual({ documentId: 'doc-1', componentId: 'comp-b', direction: 0,
      vector: ['1', '0', '0'], reference: ORIGIN_REFERENCE, basis: 'inner', target: '' });
  });

  it('世界の軸から斜めへ替えると、成分をその軸の向きで始める。斜めのまま・軸へ戻す時は成分を変えない', () => {
    const draft = { ...createDimensionMoveDraft('doc-1', 'comp-b'), direction: 1 as const };
    expect(dimensionMoveDirectionPatch(draft, 'vector')).toEqual({ direction: 'vector', vector: ['0', '1', '0'] });
    const oblique = { ...draft, direction: 'vector' as const, vector: ['1', '1', '0'] as const };
    expect(dimensionMoveDirectionPatch(oblique, 'vector')).toEqual({ direction: 'vector' });
    expect(dimensionMoveDirectionPatch(oblique, 2)).toEqual({ direction: 2 });
    expect(withVectorComponent(oblique.vector, 2, '幅 / 2')).toEqual(['1', '1', '幅 / 2']);
  });

  it('基準の選択肢は原点の面と、自分と同じ組・抑制した部品を除いた部品(文書の順)', () => {
    const document = { ...createAssemblyDocument('組立'), components: [part('comp-a'), part('comp-b', { rigidGroupId: 'g1' }),
      part('comp-c', { rigidGroupId: 'g1' }), part('comp-d', { suppressed: true }), part('comp-e')] };
    expect(dimensionMoveReferences(document, 'comp-b')).toEqual([{ value: ORIGIN_REFERENCE, name: null },
      { value: 'comp-a', name: '部品 comp-a' }, { value: 'comp-e', name: '部品 comp-e' }]);
    // 3D の画面で押して選べる候補は、同じ選択肢から原点の面を除いた物(同じ組・抑制した部品・自分は押しても断る)。
    expect(dimensionMovePickCandidates(document, 'comp-b')).toEqual(['comp-a', 'comp-e']);
  });

  it('確定を押せるのは、予告の計画が通る時だけ', () => {
    expect(dimensionMoveReady(null)).toBe(false);
    expect(dimensionMoveReady({ current: 80, issue: null, plan: null, unit: [1, 0, 0], meshErrorMm: 0 })).toBe(false);
    expect(dimensionMoveReady({ current: 80, issue: null, plan: { ok: false, reason: 'fixed', count: 0 }, unit: [1, 0, 0], meshErrorMm: 0 }))
      .toBe(false);
    expect(dimensionMoveReady({ current: 80, issue: null, unit: [1, 0, 0], meshErrorMm: 0,
      plan: { ok: true, document: createAssemblyDocument('組立'), current: 80, delta: -30, movedIds: ['comp-b'], rewrittenAxes: [0], formulaAxes: [],
        meshErrorMm: 0 } }))
      .toBe(true);
  });
});
