import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT, type AssemblyComponent } from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import {
  createDimensionMoveDraft, dimensionMoveReady, dimensionMoveReferences,
} from './dimensionMoveDraft.js';

/* 配置の補助 P-A 寸法で動かすの打ちかけ: 初めの欄、基準の選択肢(原点の面と、組の外の抑制していない部品)、確定を押せる条件。
 * 予告(外接箱から今の寸法と計画)は model の dimensionMove.test.ts と画面検査で確かめる。 */
/** 基準の選択の値のうち、原点の面を表す物(打ちかけの中の値。窓の select の value)。 */
const ORIGIN_REFERENCE = 'origin';
const part = (id: string, overrides: Partial<AssemblyComponent> = {}): AssemblyComponent => ({ id, name: `部品 ${id}`,
  source: { kind: 'part', partRef: `part-${id}` }, placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false,
  ...overrides });

describe('寸法で動かすの打ちかけ', () => {
  it('初めは X・原点の面・内側・寸法は空', () => {
    expect(createDimensionMoveDraft('doc-1', 'comp-b')).toEqual({ documentId: 'doc-1', componentId: 'comp-b', axis: 0,
      reference: ORIGIN_REFERENCE, basis: 'inner', target: '' });
  });

  it('基準の選択肢は原点の面と、自分と同じ組・抑制した部品を除いた部品(文書の順)', () => {
    const document = { ...createAssemblyDocument('組立'), components: [part('comp-a'), part('comp-b', { rigidGroupId: 'g1' }),
      part('comp-c', { rigidGroupId: 'g1' }), part('comp-d', { suppressed: true }), part('comp-e')] };
    expect(dimensionMoveReferences(document, 'comp-b')).toEqual([{ value: ORIGIN_REFERENCE, name: null },
      { value: 'comp-a', name: '部品 comp-a' }, { value: 'comp-e', name: '部品 comp-e' }]);
  });

  it('確定を押せるのは、予告の計画が通る時だけ', () => {
    expect(dimensionMoveReady(null)).toBe(false);
    expect(dimensionMoveReady({ current: 80, issue: null, plan: null })).toBe(false);
    expect(dimensionMoveReady({ current: 80, issue: null, plan: { ok: false, reason: 'fixed', count: 0 } })).toBe(false);
    expect(dimensionMoveReady({ current: 80, issue: null,
      plan: { ok: true, document: createAssemblyDocument('組立'), current: 80, delta: -30, movedIds: ['comp-b'] } })).toBe(true);
  });
});
