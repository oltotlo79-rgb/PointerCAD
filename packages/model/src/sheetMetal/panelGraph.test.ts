// P10-5/14: 接線境界からの剛体展開。
import { describe, expect, it } from 'vitest';
import { flattenSheetPanelGraph, transformPanelPoint, type SheetPanelConnection, type SheetPanelGraph } from './panelGraph.js';

const first: SheetPanelConnection = { id: 'bend-1', first: { panelId: 'base', from: [20, 10], to: [0, 10] },
  second: { panelId: 'flange', from: [0, 0], to: [20, 0] }, allowance: 5 };
const graph: SheetPanelGraph = { panelIds: ['base', 'flange'], connections: [first], fixedPanelId: 'base', seamConnectionIds: [] };

describe('板金の接線境界と固定面からの剛体展開', () => {
  it('親の外側へ中立面の曲げ長を挟み、長さと向きを保って配置する', () => {
    const result = flattenSheetPanelGraph(graph); if (!result.ok) throw new Error(result.error);
    const transform = result.traversal.transforms.get('flange'); if (transform === undefined) throw new Error('配置なし');
    expect(transformPanelPoint([0, 0], transform)).toEqual([0, 15]);
    expect(transformPanelPoint([20, 8], transform)).toEqual([20, 23]);
    expect(result.traversal.order).toEqual(['base', 'flange']);
  });
  it('許容差内の縁長の差をパネルの拡大縮小へ変換しない', () => {
    const result = flattenSheetPanelGraph({ ...graph, connections: [{ ...first, second: { ...first.second, to: [20 + 5e-8, 0] } }] });
    if (!result.ok) throw new Error(result.error);
    const transform = result.traversal.transforms.get('flange'); if (transform === undefined) throw new Error('配置なし');
    expect(Math.hypot(...transform.x)).toBeCloseTo(1, 14);
    expect(Math.hypot(...transform.y)).toBeCloseTo(1, 14);
    expect(transform.x[0] * transform.y[1] - transform.x[1] * transform.y[0]).toBeCloseTo(1, 14);
  });
  it('枝分かれの入力順序を変えても各パネルの配置が同じで、全て一度だけ訪問する', () => {
    const second: SheetPanelConnection = { id: 'bend-2', first: { panelId: 'base', from: [0, 0], to: [20, 0] },
      second: { panelId: 'other', from: [0, 0], to: [20, 0] }, allowance: 4 };
    const base = { ...graph, panelIds: ['base', 'flange', 'other'], connections: [first, second] };
    const a = flattenSheetPanelGraph(base), b = flattenSheetPanelGraph({ ...base, panelIds: [...base.panelIds].reverse(), connections: [second, first] });
    expect(b).toEqual(a); if (!a.ok) throw new Error(a.error);
    expect(new Set(a.traversal.order).size).toBe(3);
    const transform = a.traversal.transforms.get('other'); if (transform === undefined) throw new Error('配置なし');
    expect(transformPanelPoint([0, 0], transform)).toEqual([20, -4]);
    expect(transformPanelPoint([20, 8], transform)).toEqual([0, -12]);
  });
  it('重複ID・異常な縁・存在しない固定面・孤立パネルを検出する', () => {
    expect(flattenSheetPanelGraph({ ...graph, connections: [first, first] })).toMatchObject({ ok: false, error: 'duplicateId' });
    expect(flattenSheetPanelGraph({ ...graph, panelIds: [...graph.panelIds, 'orphan'] })).toMatchObject({ ok: false, error: 'disconnected' });
    expect(flattenSheetPanelGraph({ ...graph, fixedPanelId: 'missing' })).toMatchObject({ ok: false, error: 'unknownPanel' });
    expect(flattenSheetPanelGraph({ ...graph, connections: [{ ...first, allowance: NaN }] })).toMatchObject({ ok: false, error: 'invalidEdge' });
    expect(flattenSheetPanelGraph({ ...graph, connections: [{ ...first, second: { ...first.second, to: [20.001, 0] } }] })).toMatchObject({ ok: false, error: 'invalidEdge' });
  });
  it('閉周回を勝手に切らず、指定した継ぎ目のみ除いた連結を展開する', () => {
    const closing = { ...first, id: 'closing' }, cyclic = { ...graph, connections: [first, closing] };
    expect(flattenSheetPanelGraph(cyclic)).toMatchObject({ ok: false, error: 'cycle' });
    expect(flattenSheetPanelGraph({ ...cyclic, seamConnectionIds: ['closing'] })).toEqual(flattenSheetPanelGraph(graph));
    expect(flattenSheetPanelGraph({ ...graph, seamConnectionIds: ['absent'] })).toMatchObject({ ok: false, error: 'unknownSeam' });
  });
  it('同じ指定線で分かれた帯は、既存経路と配置の両方が一致するときだけ追加接続になる', () => {
    const one = { ...first, parallelGroupId: 'line-bend' }, two = { ...one, id: 'bend-2' };
    const source = { ...graph, connections: [one, two] };
    for (const fixedPanelId of graph.panelIds) {
      const result = flattenSheetPanelGraph({ ...source, fixedPanelId }); if (!result.ok) throw new Error(result.error);
      expect(result.traversal.connections).toHaveLength(1); expect(result.traversal.redundantConnections).toEqual(['bend-2']);
    }
    for (const invalid of [{ ...two, allowance: 5.01 }, { ...two, parallelGroupId: 'another-line' }])
      expect(flattenSheetPanelGraph({ ...source, connections: [one, invalid] })).toMatchObject({ ok: false, error: 'cycle' });
    expect(flattenSheetPanelGraph({ ...source, connections: [first, two] })).toMatchObject({ ok: false, error: 'cycle' });
  });
});
