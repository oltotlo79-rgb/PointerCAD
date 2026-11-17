/**
 * フレームの一括配置(J-01 包み 4a)の辺の一覧の検査: 置いた部品のまっすぐな辺が世界の座標の線・長さ・向き・中点の行になり、
 * 行の鍵はビューの強調に使う部分形状の対象の id で、長さの順・向きで絞れ、チェックした辺が予告の線になる事。
 * 部品は 200×100 の長方形の面 1 枚(辺 4 本、filletWeldBodies.testSupport の planeBody)を (1000, 0, 0) へ置いた物。
 */
import {
  createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT, PRODUCT_CATALOG_REGISTRY, type AssemblyComponent, type AssemblyDocument,
} from '@pointercad/model';
import { beforeAll, describe, expect, it } from 'vitest';

import { t } from '../i18n/t.js';
import type { AssemblyView } from '../store/assemblySlice.js';
import { filterFrameEdges, frameEdgeChoices } from './frameEdgeChoices.js';
import { planeBody } from './filletWeldBodies.testSupport.js';
import { frameEdgeText, frameLayoutView, INITIAL_FRAME_LAYOUT, toggleFrameCornerSwap, withPickedEdges, type FrameLayoutState } from './frameLayoutInput.js';
import { parseAssemblyTargetId } from './mateCommands.js';

const COMPONENT: AssemblyComponent = { id: 'plate', name: '板:1', source: { kind: 'part', partRef: 'plate' },
  placement: DEFAULT_COMPONENT_PLACEMENT, fixed: true, visible: true, suppressed: false };
const DOCUMENT: AssemblyDocument = { ...createAssemblyDocument('辺の一覧'), components: [COMPONENT] };
/** 部品の座標の長方形 (0,0,0)-(200,0,0)-(200,100,0)-(0,100,0) を、世界の (1000, 0, 0) へ置いた表示。 */
const VIEW: AssemblyView = { sourceDocument: DOCUMENT,
  resolved: { parts: new Map(), errors: [], placements: new Map([['plate', { position: [1000, 0, 0], rotation: [0, 0, 0, 1] }]]),
    partKeys: new Map([['plate', 'plate-key']]) },
  bodies: new Map([['plate-key', [planeBody([[0, 0, 0], [200, 0, 0], [200, 100, 0], [0, 100, 0]], [0, 0, 1])]]]),
  appearances: new Map(), diagnosis: null, mateTargetErrors: new Map() };
const SERIES = { kind: 'catalogItem', familyId: 't-slot-frame-series', itemKey: 's6-20x20', values: {} } as const;

beforeAll(async () => { await PRODUCT_CATALOG_REGISTRY.ensure(['t-slot-frame-series']); });

describe('選んだ部品のまっすぐな辺の一覧', () => {
  it('辺 4 本が世界の線・長さ・向き・中点の行になり、行の鍵はその部品の辺の対象の id', () => {
    const edges = frameEdgeChoices(DOCUMENT, VIEW, 'plate');
    expect(edges?.map((edge) => [edge.number, edge.lengthMm, edge.direction, edge.midpoint])).toEqual([
      [1, 200, 'x', [1100, 0, 0]], [2, 100, 'y', [1200, 50, 0]], [3, 200, 'x', [1100, 100, 0]], [4, 100, 'y', [1000, 50, 0]]]);
    expect(edges?.[0]?.line).toEqual({ start: [1000, 0, 0], end: [1200, 0, 0] });
    expect(edges?.map((edge) => parseAssemblyTargetId(edge.targetId)?.componentId)).toEqual(['plate', 'plate', 'plate', 'plate']);
    expect(edges?.[1] === undefined ? '' : frameEdgeText(edges[1])).toBe(t('catalog.frameLayout.edge').replace('{n}', '2')
      .replace('{length}', '100').replace('{direction}', t('catalog.frameLayout.direction.y')).replace('{x}', '1200').replace('{y}', '50')
      .replace('{z}', '0'));
  });

  it('部品が無い・抑制・形がまだ無い時は一覧を作らない', () => {
    expect(frameEdgeChoices(DOCUMENT, VIEW, 'none')).toBeNull();
    expect(frameEdgeChoices({ ...DOCUMENT, components: [{ ...COMPONENT, suppressed: true }] }, VIEW, 'plate')).toBeNull();
    expect(frameEdgeChoices(DOCUMENT, { ...VIEW, bodies: new Map() }, 'plate')).toBeNull();
  });

  it('長い順(同じ長さは番号の順)と向きで絞れる', () => {
    const edges = frameEdgeChoices(DOCUMENT, VIEW, 'plate') ?? [];
    expect(filterFrameEdges(edges, 'length', 'all').map((edge) => edge.number)).toEqual([1, 3, 2, 4]);
    expect(filterFrameEdges(edges, 'number', 'y').map((edge) => edge.number)).toEqual([2, 4]);
    expect(filterFrameEdges(edges, 'number', 'z')).toEqual([]);
  });

  it('チェックした辺が予告の線になり(辺の順)、4 本で閉じた枠は突き当てで 220・100・200・80', () => {
    const edges = frameEdgeChoices(DOCUMENT, VIEW, 'plate') ?? [];
    const loaded: FrameLayoutState = { ...INITIAL_FRAME_LAYOUT, source: 'edges', edges };
    expect(frameLayoutView(withPickedEdges(loaded, []), SERIES)).toEqual({ kind: 'empty' });
    const state = withPickedEdges(loaded, edges.map((edge) => edge.targetId));
    const view = frameLayoutView(state, SERIES);
    expect(view.kind === 'ready' ? view.request.lines : null).toEqual(edges.map((edge) => edge.line));
    expect(view.kind === 'ready' ? view.rows.map((row) => row.cells[1]) : null).toEqual(['220', '100', '200', '80']);
  });

  it('店のチェック(一覧と 3D の画面のクリック)を欄に入れ、チェックが同じなら角の入れ替えを保ち、変わったら初めに戻す(包み 4b)', () => {
    const edges = frameEdgeChoices(DOCUMENT, VIEW, 'plate') ?? [];
    const all = edges.map((edge) => edge.targetId);
    const swapped = toggleFrameCornerSwap(withPickedEdges({ ...INITIAL_FRAME_LAYOUT, source: 'edges', edges }, all), 0);
    expect(swapped.swapThrough).toEqual([0]);
    expect(withPickedEdges(swapped, all).swapThrough).toEqual([0]);
    const fewer = withPickedEdges(swapped, all.slice(1));
    expect([fewer.checkedEdges, fewer.swapThrough]).toEqual([all.slice(1), []]);
    expect(withPickedEdges(swapped, [...all].reverse()).swapThrough).toEqual([]);
  });
});
