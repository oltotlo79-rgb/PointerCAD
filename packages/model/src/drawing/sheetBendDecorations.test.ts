import { describe, expect, it, vi } from 'vitest';
import type { DrawingView } from '@pointercad/drawing';
import { createDrawingDocument } from './createDrawingDocument.js';
import { resolveDrawingWithSource, type DrawingResolveKernel, type DrawingSourceResolution, type ResolvedDrawingView } from './resolveDrawing.js';
import { addSheetBendDecorations } from './sheetBendDecorations.js';
import type { ConstructedDrawingView } from './viewConstruction.js';
import type { SheetFlatBendLine } from '../sheetMetal/flatBendLines.js';

const metadata = { sourceRef: 'source-1', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: 'hash-1', importedAt: '' } as const;
const view: DrawingView = { id: 'flat', name: '展開', kind: 'top', position: [100,100], scale: null,
  direction: [0,0,-1], xDir: [1,0,0], showHidden: false, showCenterLines: true, layerId: 'layer-1' };
const bend: SheetFlatBendLine = { bendId: 'bend', from: [10,20,0], to: [30,20,0], direction: 'up', angle: 90, radius: 3 };
const source: DrawingSourceResolution = { bodyIds: ['flat-key'], center: [20,10,1], sheetFlat: {
  geometry: { fixedPanelId: 'base', thickness: 2, panels: [], bends: [], joins: [] },
  outline: { loops: [], toleranceMm: 0.001 }, bends: [bend],
} };
function kernel() {
  return { prepareDrawingSource: () => Promise.resolve(source),
    hiddenLineViews: vi.fn<DrawingResolveKernel['hiddenLineViews']>((request) => Promise.resolve({ cancelled: false, failures: [], views: request.views.map((item) => ({
      viewId: item.id, visible: [], hidden: [],
    })) })),
    sectionViews: () => Promise.reject(new Error('断面は依頼しない')) } satisfies DrawingResolveKernel;
}
function document(scale = 1, own = view) {
  const doc = createDrawingDocument('板金図', metadata);
  return { ...doc, sheet: { ...doc.sheet, scale }, views: [own] };
}
describe('曲げ指示を図面と同じ座標・出力へ解決する', () => {
  it('縮尺と位置に線が追従し、R/角度と字高を拡大せず、投影を再実行しない', async () => {
    const bridge = kernel();
    const first = await resolveDrawingWithSource(document(), bridge, source);
    if (!first.ok) throw new Error(first.message);
    expect(first.views[0].decorations).toMatchObject([
      { style: { lineType: 'dashed' }, curves: [{ from: [90,110], to: [110,110] }] },
      { texts: [{ text: '上 90° R3', position: [100,112], sizeMm: 3.5 }] },
    ]);
    const moved = await resolveDrawingWithSource(document(2, { ...view, position: [150,150] }), bridge, source);
    if (!moved.ok) throw new Error(moved.message);
    expect(moved.views[0].decorations).toMatchObject([
      { curves: [{ from: [130,170], to: [170,170] }] },
      { texts: [{ text: '上 90° R3', position: [150,172], sizeMm: 3.5 }] },
    ]);
    expect(bridge.hiddenLineViews).toHaveBeenCalledOnce();
    expect(document()).not.toHaveProperty('sheetFlat');
  });
  it('裏面では上下が反転し、元のR・角度変更は新しい注記へ反映される', async () => {
    const flat = source.sheetFlat; if (flat === undefined) throw new Error('展開の入力が必要です');
    const next: DrawingSourceResolution = { ...source, sheetFlat: { ...flat, bends: [{ ...bend, radius: 4, angle: -45, direction: 'down' }] } };
    const result = await resolveDrawingWithSource(document(1, { ...view, direction: [0,0,1] }), kernel(), next);
    if (!result.ok) throw new Error(result.message);
    expect(result.views[0].decorations?.[1].texts?.[0].text).toBe('上 45° R4');
    const original = await resolveDrawingWithSource(document(1, { ...view, direction: [0,0,1] }), kernel(), source);
    if (!original.ok) throw new Error(original.message);
    expect(original.views[0].decorations?.[1].texts?.[0].text).toBe('下 90° R3');
  });
  it('穴で分かれた線を保ち、詳細クリップと破断で線を分けても注記は一つになる', () => {
    const decoration = { ownerId: view.id, layerId: 'layer-5', texts: [{ text: '既存符号', position: [10,10] as const, sizeMm: 3.5 }] };
    const projected: ResolvedDrawingView = { viewId: view.id, name: view.name, position: view.position, scale: 1,
      visible: [], hidden: [], cuttingCurves: [], decorations: [decoration] };
    const frames = new Map<string, ConstructedDrawingView>([[view.id, { view, modelCenter: source.center,
      clips: [{ kind: 'circle', center: [20,20], radius: 7 }], breakSpec: { axis: 'u', from: 99, to: 101, keepGap: 1 } }]]);
    const result = addSheetBendDecorations(document(), [projected], frames, source.center,
      [{ ...bend, to: [18,20,0] }, { ...bend, from: [22,20,0] }]);
    expect(result[0].decorations?.[0]).toBe(decoration);
    expect(result[0].decorations?.[1].curves).toEqual([
      { kind: 'segment', from: [93,110], to: [98,110] }, { kind: 'segment', from: [101,110], to: [106,110] },
    ]);
    expect(result[0].decorations?.flatMap((item) => item.texts ?? [])).toHaveLength(2);
  });
  it('斜視に展開の上下指示を混ぜない', async () => {
    const result = await resolveDrawingWithSource(document(1, { ...view, direction: [0,1,1] }), kernel(), source);
    if (!result.ok) throw new Error(result.message);
    expect(result.views[0].decorations).toBeUndefined();
  });
});
