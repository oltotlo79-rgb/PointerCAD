import { describe, expect, it } from 'vitest';
import type { ResolvedDrawingView } from '@pointercad/model';
import { drawingProjectionRenderViews, selectedDrawingProjectionOwners } from './projectionDisplay.js';

const curve = { kind: 'segment' as const, from: [1, 2] as const, to: [3, 4] as const };
function view(viewId: string): ResolvedDrawingView {
  return { viewId, name: viewId, position: [100, 100], scale: 1,
    visible: [{ curve, provenance: { occurrenceId: 'sub/first' } }, { curve, provenance: { occurrenceId: 'second' } },
      { curve, provenance: { occurrenceId: null } }],
    hidden: [{ curve, provenance: { occurrenceId: 'sub/first' } }], cuttingCurves: [curve] };
}
const owner = (viewId: string, componentId: string) => `projection:${JSON.stringify([viewId, componentId])}`;

describe('組図の投影と部品表の選択を結ぶ', () => {
  it('同じ箱の配置を分け、実線と隠れ線は同じ配置を指す', () => {
    const source = view('front'), result = drawingProjectionRenderViews([source])[0];
    expect(result.visible.map((item) => item.ownerId)).toEqual([owner('front', 'sub/first'), owner('front', 'second'), 'front']);
    expect(result.hidden[0].ownerId).toBe(result.visible[0].ownerId);
    expect(result.visible.map((item) => item.curve)).toEqual(source.visible.map((item) => item.curve));
    expect(result.cuttingCurves).toBe(source.cuttingCurves);
  });
  it('部品表の行を選ぶと全ビューの同じ配置だけが強調される', () => {
    const owners = selectedDrawingProjectionOwners([view('front'), view('top')], ['table-1', 'component:sub/first']);
    expect(owners.has(owner('front', 'sub/first'))).toBe(true);
    expect(owners.has(owner('top', 'sub/first'))).toBe(true);
    expect(owners.has(owner('front', 'second'))).toBe(false);
    expect(owners.has('front')).toBe(false);
    expect(owners.has('table-1')).toBe(true);
  });
  it('ビューを選んだ場合は他のビューの同じ部品を強調しない', () => {
    const owners = selectedDrawingProjectionOwners([view('front'), view('top')], ['front']);
    expect(owners.has(owner('front', 'sub/first'))).toBe(true);
    expect(owners.has(owner('front', 'second'))).toBe(true);
    expect(owners.has(owner('top', 'sub/first'))).toBe(false);
  });
  it('不明な由来を架空の部品として扱わず、区切りを含むIDも衝突しない', () => {
    const original = view('front');
    const result = drawingProjectionRenderViews([{ ...original,
      visible: ['', 1, undefined].map((occurrenceId) => ({ curve, provenance: { occurrenceId } })) }])[0];
    expect(result.visible.every((item) => item.ownerId === 'front')).toBe(true);
    expect(owner('a:b', 'c')).not.toBe(owner('a', 'b:c'));
    expect(selectedDrawingProjectionOwners([original], [])).toEqual(new Set());
  });
});
