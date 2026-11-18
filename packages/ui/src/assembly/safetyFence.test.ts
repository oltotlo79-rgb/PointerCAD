/**
 * 平面から安全柵(E-12 第 1 段)の窓の欄と置く動作: 点(1 行に X Y)と欄の値から予告(柱・横の材・パネルの数と寸法)を作り、
 * 読めない値は理由を出し、置くと柱・横の材・パネルが 1 回で入って元に戻す 1 回で全部戻る事。期待は手で解いた値。
 */
import {
  classifyFrameJoints, createAssemblyDocument, EMPTY_PART_LIBRARY, placedFrameMembers, PRODUCT_CATALOG_REGISTRY, type RigidPlacement,
} from '@pointercad/model';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import { resetTestStore } from '../store/testing/createTestStore.js';
import { useAppStore } from '../store/useAppStore.js';
import {
  FENCE_FOOT_FAMILIES, FENCE_PANEL_FAMILY, fencePointsOrNull, INITIAL_SAFETY_FENCE, safetyFenceView, withFenceStroke,
} from './safetyFenceInput.js';
import { placeSafetyFence } from './safetyFencePlacement.js';

const POST = { kind: 'catalogItem', familyId: 't-slot-frame-series', itemKey: 's6-20x20', values: {} } as const;
const RECTANGLE = ['0 0', '2000 0', '2000 1000', '0 1000'].join('\n');

/** 注文の寸法の板の最初の行(族の初めの値 600 × 400 で作れる行)。 */
function panelKey(): string {
  const row = PRODUCT_CATALOG_REGISTRY.loaded(FENCE_PANEL_FAMILY)?.rows[0];
  if (row === undefined) throw new Error('板の族が読めません');
  return row.key;
}

/** 族の最初の行の鍵。 */
function firstRow(familyId: string): string {
  const row = PRODUCT_CATALOG_REGISTRY.loaded(familyId)?.rows[0];
  if (row === undefined) throw new Error(`${familyId} が読めません`);
  return row.key;
}

beforeAll(async () => {
  await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-frame-series', FENCE_PANEL_FAMILY, FENCE_FOOT_FAMILIES.base, FENCE_FOOT_FAMILIES.adjuster]);
});
beforeEach(resetTestStore);

describe('安全柵の欄', () => {
  it('点が無ければ空。2000 × 1000 の囲いは柱 6・横の材 12(どれも柱の面の間の 980)・パネル無し', () => {
    expect(safetyFenceView(INITIAL_SAFETY_FENCE, POST)).toEqual({ kind: 'empty' });
    const view = safetyFenceView({ ...INITIAL_SAFETY_FENCE, pointsText: RECTANGLE }, POST);
    if (view.kind !== 'ready') throw new Error(view.kind === 'error' ? view.message : view.kind);
    expect([view.request.plan.posts.length, view.request.plan.rails.length, view.request.plan.panels.length]).toEqual([6, 12, 0]);
    // 長辺の区画は柱の中心の間 1000 から柱の半分 10 を 2 つ引いた 980、短辺も 1000 なので 980。
    expect(view.summary).toBe(t('catalog.fence.previewNoPanel').replace('{posts}', '6').replace('{rails}', '12').replace('{panels}', '0')
      .replace('{railLengths}', '980 × 12').replace('{panelSizes}', ''));
  });

  it('パネルあり(600 × 400 の囲い・高さ 600・横の材 100 と 500): 区画 4 で、パネルは 580 × 380 と 380 × 380 が 2 枚ずつ', () => {
    const view = safetyFenceView({ ...INITIAL_SAFETY_FENCE, pointsText: ['0 0', '600 0', '600 400', '0 400'].join('\n'), height: '600',
      railHeights: '100, 500', panelItemKey: panelKey() }, POST);
    if (view.kind !== 'ready') throw new Error(view.kind === 'error' ? view.message : view.kind);
    expect(view.request.plan.panels.map((panel) => [panel.width, panel.height])).toEqual([[580, 380], [380, 380], [580, 380], [380, 380]]);
  });

  it('読めない点・数でない高さ・柱の外の横の材は理由(区画の番号は 1 から)', () => {
    expect(safetyFenceView({ ...INITIAL_SAFETY_FENCE, pointsText: '0 0 0' }, POST)).toEqual({ kind: 'error', message: t('catalog.fence.error.badPoint') });
    expect(safetyFenceView({ ...INITIAL_SAFETY_FENCE, pointsText: RECTANGLE, height: 'abc' }, POST))
      .toEqual({ kind: 'error', message: t('catalog.fence.error.invalidNumber').replace('{bay}', '1') });
    expect(safetyFenceView({ ...INITIAL_SAFETY_FENCE, pointsText: '0 0\n15 0', closed: false }, POST))
      .toEqual({ kind: 'error', message: t('catalog.fence.error.noRoom').replace('{bay}', '1') });
  });
});

describe('安全柵の第 2 段(足・3D の画面で打った点)', () => {
  it('足の板: 柱の下に足を 1 つずつ置き、柱の下端は板厚の分だけ上がる。行を選ばない時は理由', () => {
    const footKey = firstRow(FENCE_FOOT_FAMILIES.base);
    const thickness = PRODUCT_CATALOG_REGISTRY.loaded(FENCE_FOOT_FAMILIES.base)?.rows[0]?.dims.thickness;
    const view = safetyFenceView({ ...INITIAL_SAFETY_FENCE, pointsText: RECTANGLE, footKind: 'base', footItemKey: footKey }, POST);
    if (view.kind !== 'ready') throw new Error(view.kind === 'error' ? view.message : view.kind);
    expect(view.request.plan.feet).toHaveLength(6);
    expect(view.request.plan.posts.every((post) => post.line.start[2] === thickness)).toBe(true);
    expect(view.request.foot).toEqual({ familyId: FENCE_FOOT_FAMILIES.base, itemKey: footKey });
    expect(safetyFenceView({ ...INITIAL_SAFETY_FENCE, pointsText: RECTANGLE, footKind: 'base' }, POST))
      .toEqual({ kind: 'error', message: t('catalog.fence.error.noFoot').replace('{bay}', '1') });
  });

  it('アジャスター: 高さが皿の厚さより低い時は理由、皿以上なら柱の下端はその高さ', () => {
    const adjuster = firstRow(FENCE_FOOT_FAMILIES.adjuster);
    const pad = PRODUCT_CATALOG_REGISTRY.loaded(FENCE_FOOT_FAMILIES.adjuster)?.rows[0]?.dims.padThickness ?? Number.NaN;
    const base = { ...INITIAL_SAFETY_FENCE, pointsText: RECTANGLE, footKind: 'adjuster' as const, footItemKey: adjuster };
    expect(safetyFenceView({ ...base, footHeight: String(pad - 1) }, POST))
      .toEqual({ kind: 'error', message: t('catalog.fence.error.footTooLow').replace('{bay}', '1') });
    const view = safetyFenceView({ ...base, footHeight: String(pad + 20) }, POST);
    if (view.kind !== 'ready') throw new Error(view.kind === 'error' ? view.message : view.kind);
    expect(view.request.plan.posts[0]?.line.start[2]).toBe(pad + 20);
  });

  it('打った点の欄: 1 行に X Y で書き、同じ点の列を表す文字(カンマ区切り)はそのまま、点が増えた時だけ書き直す', () => {
    expect(fencePointsOrNull('0 0\n600,0')).toEqual([[0, 0, 0], [600, 0, 0]]);
    expect(fencePointsOrNull('0 0\n6')).toBeNull();
    // 閉じるは打った点の列(閉じていない)に合わせておく(初めの値は閉じる)。
    const typed = { ...INITIAL_SAFETY_FENCE, pointsText: '0,0\n600,0\n', closed: false };
    expect(withFenceStroke(typed, { points: [[0, 0, 0], [600, 0, 0]], closed: false })).toBe(typed);
    expect(withFenceStroke(typed, { points: [[0, 0, 0], [600, 0, 0], [600, 400, 0]], closed: true }))
      .toEqual({ ...typed, pointsText: '0 0\n600 0\n600 400', closed: true });
  });
});

describe('安全柵の接続の数(画面検査の期待の元)', () => {
  it('600 × 400 の囲い・横の材 100 と 500・足の板: 柵の部材どうしの接続は 24(横の材の端の T 16 と、角で横の材どうしが接する L 8)', () => {
    const view = safetyFenceView({ ...INITIAL_SAFETY_FENCE, pointsText: ['0 0', '600 0', '600 400', '0 400'].join('\n'), height: '600',
      railHeights: '100, 500', footKind: 'base', footItemKey: firstRow(FENCE_FOOT_FAMILIES.base) }, POST);
    if (view.kind !== 'ready') throw new Error(view.kind === 'error' ? view.message : view.kind);
    useAppStore.getState().openAssembly(createAssemblyDocument('柵'), EMPTY_PART_LIBRARY);
    const placed = placeSafetyFence(view.request);
    if (!placed.ok) throw new Error(placed.reason);
    const assembly = useAppStore.getState().assembly;
    if (assembly === null) throw new Error('no assembly');
    const placements = new Map<string, RigidPlacement>(assembly.components.map((component) => [component.id, {
      position: [component.placement.position[0].value, component.placement.position[1].value, component.placement.position[2].value],
      rotation: component.placement.rotation }]));
    expect(classifyFrameJoints(placedFrameMembers(assembly, placements)).length).toBe(24);
  });
});

describe('安全柵の第 3 段(区画ごとの指定)', () => {
  const SMALL = { ...INITIAL_SAFETY_FENCE, pointsText: ['0 0', '600 0', '600 400', '0 400'].join('\n'), height: '600', railHeights: '100, 500' };

  it('区画 2 をパネル無し、区画 3 を出入口にすると、パネルは区画 1・4 の 2 枚、横の材は区画 3 の 2 本が無くなって 6 本', () => {
    const view = safetyFenceView({ ...SMALL, panelItemKey: panelKey(), bayOverrides: { 1: 'none', 2: 'open' } }, POST);
    if (view.kind !== 'ready') throw new Error(view.kind === 'error' ? view.message : view.kind);
    expect(view.request.panels.map((panel) => panel.bay)).toEqual([0, 3]);
    expect(view.request.plan.rails).toHaveLength(6);
  });

  it('区画ごとに別の板の行を選ぶと、その区画の板はその行になる', () => {
    // 区画 1 の板(580 × 380)が収まる、最初の行の次の行(上限の無い行か、上限が 580 × 380 以上の行)。
    const rows = PRODUCT_CATALOG_REGISTRY.loaded(FENCE_PANEL_FAMILY)?.rows ?? [];
    const other = rows.slice(1).find((row) => {
      const { maxWidth: w, maxHeight: h } = row.dims;
      return w === undefined || h === undefined || (w >= 580 && h >= 380) || (w >= 380 && h >= 580);
    })?.key ?? panelKey();
    const view = safetyFenceView({ ...SMALL, panelItemKey: panelKey(), bayOverrides: { 0: other } }, POST);
    if (view.kind !== 'ready') throw new Error(view.kind === 'error' ? view.message : view.kind);
    expect(view.request.panels.map((panel) => panel.itemKey)).toEqual([other, panelKey(), panelKey(), panelKey()]);
  });
});

describe('安全柵を置く', () => {
  it('柱 4・横の材 8・パネル 4 の 16 個が 1 回で入り、元に戻す 1 回で全部戻る', () => {
    const view = safetyFenceView({ ...INITIAL_SAFETY_FENCE, pointsText: ['0 0', '600 0', '600 400', '0 400'].join('\n'), height: '600',
      railHeights: '100, 500', panelItemKey: panelKey() }, POST);
    if (view.kind !== 'ready') throw new Error('not ready');
    useAppStore.getState().openAssembly(createAssemblyDocument('柵'), EMPTY_PART_LIBRARY);
    const placed = placeSafetyFence(view.request);
    if (!placed.ok) throw new Error(placed.reason);
    expect(placed.componentIds).toHaveLength(16);
    expect(useAppStore.getState().selection).toEqual(placed.componentIds);
    expect(useAppStore.getState().assembly?.components).toHaveLength(16);
    useAppStore.getState().undoAssembly();
    expect(useAppStore.getState().assembly?.components).toHaveLength(0);
  });
});
