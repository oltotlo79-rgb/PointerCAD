/**
 * フレームの一括配置(J-01 包み 1・2)の店の動作の検査: 長さを持つ部材(族の行・鋼材の行)と線の列から、部材を 1 本ずつ普通の部品として並べ、
 * 長さ(突き当ての伸び縮みを含む)・名前・材質・配置が入り、Undo 1 回で全部戻り、作れない時は何も置かずに理由を返す事。
 */
import { evaluateExpression } from '@pointercad/expression';
import { createAssemblyDocument, PRODUCT_CATALOG_REGISTRY, type AssemblyComponent } from '@pointercad/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import type { FrameMembersRequest } from './frameMembersPlacement.js';

const SERIES = { kind: 'catalogItem', familyId: 't-slot-frame-series', itemKey: 's6-20x20', values: {} } as const;
const GENERIC = { kind: 'catalogItem', familyId: 't-slot-frame-specified', itemKey: 'specified', values: {} } as const;

/** 500×300 の長方形の枠(閉じた 4 本)を、系列の溝幅 6 20×20 で突き当てに並べる。 */
const REQUEST: FrameMembersRequest = {
  member: SERIES,
  lines: [
    { start: [0, 0, 0], end: [500, 0, 0] }, { start: [500, 0, 0], end: [500, 300, 0] },
    { start: [500, 300, 0], end: [0, 300, 0] }, { start: [0, 300, 0], end: [0, 0, 0] },
  ],
  up: [0, 0, 1], quarterTurns: 0, startExtension: 0, endExtension: 0, corners: 'butt', swapThrough: [],
};

function components(): readonly AssemblyComponent[] {
  return useAppStore.getState().assembly?.components ?? [];
}

const lengths = (): readonly (string | null)[] =>
  components().map((component) => component.source.kind === 'standardPart' ? component.source.options.length ?? null : null);

const positionOf = (component: AssemblyComponent | undefined): readonly number[] =>
  component?.placement.position.map((value) => {
    const result = evaluateExpression(value.source);
    return result.ok ? result.value.value : NaN;
  }) ?? [];

beforeEach(async () => {
  resetTestStore();
  await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-frame-series', 't-slot-frame-specified', 'angle-bracket-specified']);
  useAppStore.getState().openAssembly(createAssemblyDocument('フレームの一括配置'));
  expect(useAppStore.getState().openStandardPartPicker()).toBe(true);
});
afterEach(() => { resetTestStore(); });

describe('J-01 フレームの一括配置の店の動作', () => {
  it('長方形の枠は 4 本の普通の部品になり、長さは突き当ての伸び縮みを含み、名前・材質・保存の形は 1 本ずつ置く時と同じ', () => {
    const placed = useAppStore.getState().placeFrameMembers(REQUEST);
    expect(placed.ok).toBe(true);
    const list = components();
    expect(placed.ok ? placed.componentIds : []).toEqual(list.map((component) => component.id));
    expect(lengths()).toEqual(['520', '300', '500', '280']);
    expect(list.map((component) => component.name)).toEqual(['アルミフレーム 溝幅 6 20×20×520:1', 'アルミフレーム 溝幅 6 20×20×300:1',
      'アルミフレーム 溝幅 6 20×20×500:1', 'アルミフレーム 溝幅 6 20×20×280:1']);
    expect(list.map((component) => component.materialId)).toEqual(['aluminum', 'aluminum', 'aluminum', 'aluminum']);
    expect(list.map((component) => component.source.kind === 'standardPart'
      ? [component.source.catalog, component.source.options.family, component.source.options.item] : null))
      .toEqual(list.map(() => ['catalogItem', 't-slot-frame-series', 's6-20x20']));
    // 線 0 は x = -10 から(外形の中心が線に乗る)、線 3 は y = 290 から。
    expect(positionOf(list[0])).toEqual([-10, 0, 0]);
    expect(positionOf(list[3])).toEqual([0, 290, 0]);
    // 1 つ目だけ自動で固定する(1 本ずつ置く時と同じ)。置いた後も窓は開いたまま(1 本ずつ置く時と同じ)。
    expect(list.map((component) => component.fixed)).toEqual([true, false, false, false]);
    expect(useAppStore.getState().standardPartPickerOpen).toBe(true);
  });

  it('Undo 1 回で 4 本とも戻る', () => {
    expect(useAppStore.getState().placeFrameMembers(REQUEST).ok).toBe(true);
    expect(components()).toHaveLength(4);
    useAppStore.getState().undo();
    expect(components()).toHaveLength(0);
  });

  it('作れない時は何も置かずに理由を返す(長さを持たない族・形が作れない欄・縮めすぎ・無い行・無い鋼材・窓が閉じている)', () => {
    const state = (): ReturnType<typeof useAppStore.getState> => useAppStore.getState();
    expect(state().placeFrameMembers({ ...REQUEST, member: { ...GENERIC, familyId: 'angle-bracket-specified' } }))
      .toEqual({ ok: false, reason: 'notLinear', lineIndex: null });
    expect(state().placeFrameMembers({ ...REQUEST, member: { ...GENERIC, values: { slotOpening: '18' } } }))
      .toEqual({ ok: false, reason: 'invalidOption', lineIndex: null });
    expect(state().placeFrameMembers({ ...REQUEST, startExtension: -400 }))
      .toEqual({ ok: false, reason: 'nonPositiveLength', lineIndex: 1 });
    expect(state().placeFrameMembers({ ...REQUEST, member: { ...SERIES, itemKey: 'no-such-row' } }))
      .toEqual({ ok: false, reason: 'unknownChoice', lineIndex: null });
    expect(state().placeFrameMembers({ ...REQUEST, member: { kind: 'steel', choiceKey: 'steel:SS400:flatBar:FB 0×0' } }))
      .toEqual({ ok: false, reason: 'unknownChoice', lineIndex: null });
    state().closeStandardPartPicker();
    expect(state().placeFrameMembers(REQUEST)).toEqual({ ok: false, reason: 'unavailable', lineIndex: null });
    expect(components()).toHaveLength(0);
  });

  it('汎用のフレームは入れていない欄を初めの値(外形 40)で読み、外形の半分(20)で突き当ての伸び縮みを決める', () => {
    const placed = useAppStore.getState().placeFrameMembers({ ...REQUEST, member: GENERIC });
    expect(placed.ok).toBe(true);
    expect(lengths()).toEqual(['540', '300', '500', '260']);
    const first = components()[0]?.source;
    expect(first?.kind === 'standardPart' ? first.options.width : null).toBe('40');
  });

  it('鋼材(SS400 平鋼 50×6、角が原点の断面)は外形の中心が線に乗り、幅 50 の半分で突き当て、材質は鋼', () => {
    const placed = useAppStore.getState().placeFrameMembers({ ...REQUEST, member: { kind: 'steel', choiceKey: 'steel:SS400:flatBar:FB 50×6' } });
    expect(placed.ok).toBe(true);
    expect(lengths()).toEqual(['550', '300', '500', '250']);
    expect(components().map((component) => component.source.kind === 'standardPart'
      ? [component.source.catalog, component.source.size, component.source.options.steelProduct] : null))
      .toEqual(components().map(() => ['flatBar', 'FB 50×6', 'SS400:flatBar:FB 50×6']));
    expect(components().map((component) => component.materialId)).toEqual(['steel', 'steel', 'steel', 'steel']);
    // 断面の (25, 3) が線の始点(線 0 は x = -25 から)に乗る: 位置 = 始点 − 25·線の向き − (25·局所の X + 3·局所の Y)。
    expect(positionOf(components()[0])).toEqual([-25, -25, -3]);
  });
});
