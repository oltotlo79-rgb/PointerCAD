/**
 * 置いた部材の分割と統合(E-11)の純関数の検査: 分けると前の 1 本は元の部品で長さと始点の留めを保ち、後ろの 1 本は新しい部品で
 * 位置が軸に沿って進み終点の留めを保つ事。まとめると軸の上で一番前の部品が合計の長さで残る事。接続の記録の付け替えと、
 * 作れない時に何も変えずに理由(と数)を返す事。期待の長さ・位置は手で解いた値。
 */
import { expressionValueFromNumber } from '@pointercad/expression';
import { beforeAll, describe, expect, it } from 'vitest';

import { T_SLOT_FRAME_SERIES_FAMILY } from '../catalog/families/tSlotFrameSeries.js';
import { PRODUCT_CATALOG_REGISTRY } from '../catalog/registry.js';
import { createCatalogItemSource } from '../catalog/source.js';
import { createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT } from '../createAssemblyDocument.js';
import type { Quaternion } from '../placementMath.js';
import { createStandardPartSource } from '../standard/buildStandardPart.js';
import { ALL_STEEL_PRODUCTS, steelProductOptions } from '../standard/steelCatalog.js';
import type { AssemblyComponent, AssemblyDocument, ComponentSource, MateTarget } from '../types.js';
import type { FrameJointRecord } from './frameJointRecord.js';
import { componentReferenceCount, planMemberMerge, planMemberSplit } from './memberSplitMerge.js';

const FAMILY = T_SLOT_FRAME_SERIES_FAMILY;
const ROW_20 = FAMILY.rows.find((row) => row.key === 's6-20x20');
const ROW_40 = FAMILY.rows.find((row) => row.key === 's6-20x40');
const FLAT = ALL_STEEL_PRODUCTS.find((row) => row.key === 'SS400:flatBar:FB 50×6');
/** 局所の +Z(長さの向き)をワールドの +X へ向ける回転(Y のまわりに +90°)。 */
const ALONG_X: Quaternion = [0, Math.SQRT1_2, 0, Math.SQRT1_2];

function component(id: string, source: ComponentSource, at: readonly [number, number, number] = [0, 0, 0],
  rotation: Quaternion = DEFAULT_COMPONENT_PLACEMENT.rotation): AssemblyComponent {
  return { id, name: `溝幅 6 20×20:${id.slice(-1)}`, source, fixed: false, visible: true, suppressed: false,
    placement: { position: [expressionValueFromNumber(at[0]), expressionValueFromNumber(at[1]), expressionValueFromNumber(at[2])], rotation } };
}

function frame(id: string, values: Readonly<Record<string, string>>, at?: readonly [number, number, number], rotation?: Quaternion,
  row = ROW_20): AssemblyComponent {
  if (row === undefined) throw new Error('row');
  return component(id, createCatalogItemSource(FAMILY, row, values), at, rotation);
}

const documentOf = (components: readonly AssemblyComponent[], frameJoints?: readonly FrameJointRecord[]): AssemblyDocument => ({
  ...createAssemblyDocument('分割'), components, ...(frameJoints === undefined ? {} : { frameJoints }),
});

/** 接続の記録(板 bracketId と、部材の指し先)。 */
function joint(id: string, bracketId: string, members: FrameJointRecord['members']): FrameJointRecord {
  return { id, kind: 'butt', members, bracket: { componentId: bracketId, orientation: 'plate', faces: [] }, fastenerIds: [],
    choices: { nominal: 'M5', nutEntry: 'drop-in', nutMaterial: 'steel' } };
}

const optionsOf = (document: AssemblyDocument, id: string): Readonly<Record<string, string>> | undefined => {
  const source = document.components.find((item) => item.id === id)?.source;
  return source?.kind === 'standardPart' ? source.options : undefined;
};
const positionOf = (document: AssemblyDocument, id: string): readonly number[] | undefined =>
  document.components.find((item) => item.id === id)?.placement.position.map((value) => value.value);

beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure([FAMILY.id]); });

describe('部材を分ける', () => {
  it('前の 1 本は元の部品で長さ 400・始点の留めを保ち、後ろの 1 本は新しい部品で長さ 600・位置 z=400・終点の留めを保つ', () => {
    const assembly = documentOf([frame('component-1', { length: '1000', startMiter: 'x+', endMiter: 'y-' })]);
    const result = planMemberSplit(assembly, 'component-1', 400);
    if (!result.ok) throw new Error(result.reason);
    const [first, second] = result.componentIds;
    expect(first).toBe('component-1');
    expect(result.lengths).toEqual([400, 600]);
    expect(optionsOf(result.document, 'component-1')).toMatchObject({ length: '400', startMiter: 'x+' });
    expect(optionsOf(result.document, 'component-1')).not.toHaveProperty('endMiter');
    expect(optionsOf(result.document, second ?? '')).toMatchObject({ length: '600', endMiter: 'y-' });
    expect(optionsOf(result.document, second ?? '')).not.toHaveProperty('startMiter');
    expect(positionOf(result.document, second ?? '')).toEqual([0, 0, 400]);
    // 後ろの 1 本は元の部品のすぐ後ろに並び、名前は置く時と同じ連番。
    expect(result.document.components.map((item) => item.id)).toEqual(['component-1', second]);
    expect(result.document.components[1]?.name).toBe('溝幅 6 20×20:2');
  });

  it('軸がワールドの +X の部材は、後ろの 1 本が X の向きに進む。長さの式は数に置き換わる', () => {
    const assembly = documentOf([frame('component-1', { length: '500*2' }, [10, 20, 30], ALONG_X)]);
    const result = planMemberSplit(assembly, 'component-1', 250);
    if (!result.ok) throw new Error(result.reason);
    expect(positionOf(result.document, result.componentIds[1] ?? '')).toEqual([260, 20, 30]);
    expect(optionsOf(result.document, 'component-1')?.length).toBe('250');
    expect(optionsOf(result.document, result.componentIds[1] ?? '')?.length).toBe('750');
  });

  it('接続の記録: 始点は前の 1 本のまま、終点は後ろの 1 本へ、途中は板の位置が分ける位置より後なら後ろの 1 本へ', () => {
    const assembly = documentOf([frame('component-1', { length: '1000' }), frame('component-2', { length: '100' }, [0, 0, 700]),
      frame('component-3', { length: '100' }, [0, 0, 100])], [
      joint('j1', 'component-2', [{ componentId: 'component-1', part: 'start' }, { componentId: 'component-1', part: 'end' }]),
      joint('j2', 'component-2', [{ componentId: 'component-1', part: 'side' }]),
      joint('j3', 'component-3', [{ componentId: 'component-1', part: 'side' }]),
    ]);
    const result = planMemberSplit(assembly, 'component-1', 400);
    if (!result.ok) throw new Error(result.reason);
    const second = result.componentIds[1];
    expect(result.document.frameJoints?.map((record) => record.members.map((member) => member.componentId))).toEqual([
      ['component-1', second], [second], ['component-1']]);
  });

  it('鋼材の部材も分けられる', () => {
    if (FLAT === undefined) throw new Error('flat bar');
    const assembly = documentOf([component('component-1', createStandardPartSource(FLAT.catalog, FLAT.size,
      { ...steelProductOptions(FLAT), length: '1000' }))]);
    const result = planMemberSplit(assembly, 'component-1', 300);
    if (!result.ok) throw new Error(result.reason);
    expect(result.lengths).toEqual([300, 700]);
    expect(optionsOf(result.document, result.componentIds[1] ?? '')?.length).toBe('700');
  });

  it('範囲の外・部材でない部品・合致に指されている・留めの端が作れない長さは、何も変えずに理由(と数)', () => {
    const assembly = documentOf([frame('component-1', { length: '1000', endMiter: 'x+' }),
      component('component-2', { kind: 'part', partRef: 'box' })]);
    for (const at of [0, 1000, -5, 1200, Number.NaN]) expect(planMemberSplit(assembly, 'component-1', at)).toMatchObject({ reason: 'outOfRange' });
    expect(planMemberSplit(assembly, 'component-2', 10)).toMatchObject({ ok: false, reason: 'notMember' });
    // 終点の留め(断面 20 の 45°)を持つ後ろの 1 本が 5 では作れない。
    expect(planMemberSplit(assembly, 'component-1', 995)).toMatchObject({ ok: false, reason: 'invalidOption' });
    const target = (componentId: string): MateTarget => ({ kind: 'origin', componentId, element: 'xy' });
    const mated: AssemblyDocument = { ...assembly, mates: [
      { id: 'm1', name: 'm1', kind: 'coincident', a: target('component-1'), b: target('component-2'), flipped: false, suppressed: false }] };
    expect(planMemberSplit(mated, 'component-1', 400)).toEqual({ ok: false, reason: 'referenced', count: 1 });
  });
});

describe('部品を指している記録の数(公開の口)', () => {
  it('合致と分解の段の記録を数え、id の頭が同じ別の部品(component-10)とフレームの接続の記録は数えない', () => {
    const target = (componentId: string): MateTarget => ({ kind: 'origin', componentId, element: 'xy' });
    const base = documentOf([frame('component-1', { length: '1000' }), frame('component-10', { length: '1000' })],
      [joint('j1', 'component-10', [{ componentId: 'component-1', part: 'side' }])]);
    const assembly: AssemblyDocument = { ...base, mates: [
      { id: 'm1', name: 'm1', kind: 'coincident', a: target('component-1'), b: target('component-10'), flipped: false, suppressed: false },
      { id: 'm2', name: 'm2', kind: 'coincident', a: target('component-10'), b: target('component-10'), flipped: false, suppressed: false }] };
    expect(componentReferenceCount(assembly, ['component-1'])).toBe(1);
    expect(componentReferenceCount(assembly, ['component-10'])).toBe(2);
    expect(componentReferenceCount(base, ['component-1'])).toBe(0);
  });
});

describe('部材をまとめる', () => {
  const pair = (second: AssemblyComponent, frameJoints?: readonly FrameJointRecord[]): AssemblyDocument =>
    documentOf([frame('component-1', { length: '400', startMiter: 'x+' }), second], frameJoints);

  it('一番前の部品が合計の長さで残り、外側の留めを保ち、後ろの部品は消える。選ぶ順に関わらない', () => {
    const assembly = pair(frame('component-2', { length: '600', endMiter: 'y-' }, [0, 0, 400]));
    for (const ids of [['component-1', 'component-2'], ['component-2', 'component-1']]) {
      const result = planMemberMerge(assembly, ids);
      if (!result.ok) throw new Error(result.reason);
      expect(result.componentIds).toEqual(['component-1']);
      expect(result.lengths).toEqual([1000]);
      expect(result.document.components.map((item) => item.id)).toEqual(['component-1']);
      expect(optionsOf(result.document, 'component-1')).toMatchObject({ length: '1000', startMiter: 'x+', endMiter: 'y-' });
    }
  });

  it('接続の記録: 後ろの部品の終点と途中の記録は、残る部品へ付け替える', () => {
    const assembly = pair(frame('component-2', { length: '600' }, [0, 0, 400]), [
      joint('j1', 'component-3', [{ componentId: 'component-2', part: 'end' }]),
      joint('j2', 'component-3', [{ componentId: 'component-2', part: 'side' }, { componentId: 'component-1', part: 'start' }])]);
    const result = planMemberMerge(assembly, ['component-1', 'component-2']);
    if (!result.ok) throw new Error(result.reason);
    expect(result.document.frameJoints?.map((record) => record.members)).toEqual([
      [{ componentId: 'component-1', part: 'end' }],
      [{ componentId: 'component-1', part: 'side' }, { componentId: 'component-1', part: 'start' }]]);
  });

  it('1 本だけ・行が混ざる・軸が揃わない・間がある・接する端に留め・接する端をつなぐ記録は、何も変えずに理由', () => {
    const touching = frame('component-2', { length: '600' }, [0, 0, 400]);
    expect(planMemberMerge(pair(touching), ['component-1'])).toMatchObject({ reason: 'noSelection' });
    expect(planMemberMerge(pair(frame('component-2', { length: '600' }, [0, 0, 400], undefined, ROW_40)), ['component-1', 'component-2']))
      .toMatchObject({ reason: 'mixed' });
    expect(planMemberMerge(pair(frame('component-2', { length: '600' }, [0, 0, 400], ALONG_X)), ['component-1', 'component-2']))
      .toMatchObject({ reason: 'notAligned' });
    expect(planMemberMerge(pair(frame('component-2', { length: '600' }, [0, 0, 401])), ['component-1', 'component-2']))
      .toMatchObject({ reason: 'notTouching' });
    expect(planMemberMerge(pair(frame('component-2', { length: '600', startMiter: 'x-' }, [0, 0, 400])), ['component-1', 'component-2']))
      .toMatchObject({ reason: 'miteredJoin' });
    const joined = pair(touching, [joint('j1', 'component-3', [{ componentId: 'component-1', part: 'end' },
      { componentId: 'component-2', part: 'start' }])]);
    expect(planMemberMerge(joined, ['component-1', 'component-2'])).toEqual({ ok: false, reason: 'jointAtJoin', count: 1 });
  });
});
