import { describe, expect, it } from 'vitest';
import { createDrawingDocument } from '@pointercad/model';
import type { DimensionTarget, DrawingPlaneDefinition, DrawingView, DrawingViewConstruction } from '@pointercad/model';
import { parseDrawing, serializeDrawing } from './drawingJson.js';
import { isRecord, isUnknownArray } from './guards.js';

const expression = (value: number) => ({ source: String(value), value, display: String(value) });
const target: DimensionTarget = { kind: 'subShape', viewId: 'front', sourceRef: 'source', componentId: 'frame/plate',
  ref: { bodyFeatureId: 'plate', index: 2, fingerprint: { kind: 'face', surfaceKind: 'plane', area: 100, position: [0, 0, 0], axis: [0, 0, 1], radius: null } } };
const point: DimensionTarget = { kind: 'point', viewId: 'front', paperPoint: [0, 0], modelPoint: [1, 2, 3] };
const planes: readonly DrawingPlaneDefinition[] = [
  { kind: 'workPlane', planeId: 'xy', offset: { ...expression(3), source: '6/2' } },
  { kind: 'face', target, offset: expression(0) },
  { kind: 'threePoints', points: [point, { ...point, modelPoint: [2, 3, 4] }, { ...point, modelPoint: [0, 3, 5] }] },
  { kind: 'viewLine', sourceViewId: 'front', from: [-10, 0], to: [10, 0] },
];
const constructions: readonly DrawingViewConstruction[] = [
  ...planes.map((plane): DrawingViewConstruction => ({ kind: 'section', plane, mode: 'full', keepSide: 'positive', reversed: false, label: 'A' })),
  { kind: 'section', plane: planes[0], mode: 'half', keepSide: 'negative', reversed: true, label: 'B', boundary: [[0, 0], [10, 0]] },
  { kind: 'section', plane: planes[0], mode: 'local', keepSide: 'positive', reversed: false, label: 'C', boundary: [[0, 0], [10, 0], [0, 10]] },
  { kind: 'detail', sourceViewId: 'front', center: [2, 3], radius: expression(10), scale: { ...expression(2), source: '8/4' }, label: 'D' },
  { kind: 'auxiliary', sourceViewId: 'front', plane: planes[1] },
  { kind: 'partial', sourceViewId: 'front', region: { kind: 'circle', center: [1, 2], radius: expression(5) } },
  { kind: 'partial', sourceViewId: 'front', region: { kind: 'polygon', points: [[0, 0], [3, 0], [0, 4]] } },
  { kind: 'broken', sourceViewId: 'front', axis: 'v', from: expression(-10), to: expression(10), gap: expression(3) },
];
const base: DrawingView = { id: 'front', name: '正面', kind: 'front', position: [100, 100], direction: [0, 0, 1], xDir: [1, 0, 0],
  scale: null, showHidden: true, showCenterLines: true, layerId: 'layer-1' };
const source = { sourceRef: 'source', sourceKind: 'part', fileName: 'part.pcad', path: '', contentHash: 'hash', importedAt: '2026-09-10T00:00:00Z' } as const;
function envelope(construction: DrawingViewConstruction = constructions[0]): string {
  const saved = { ...createDrawingDocument('図面', source), views: [base, { ...base, id: 'derived', kind: construction.kind, construction }] };
  return serializeDrawing(saved, { savedAt: '2026-09-10T00:00:00Z' });
}
function tamper(value: unknown, viewKind = 'section'): string {
  const raw: unknown = JSON.parse(envelope());
  if (!isRecord(raw) || !isRecord(raw['document']) || !isUnknownArray(raw['document']['views']) || !isRecord(raw['document']['views'][1])) throw new Error('fixture');
  raw['document']['views'][1]['construction'] = value; raw['document']['views'][1]['kind'] = viewKind;
  return JSON.stringify(raw);
}

describe('派生図の保存条件', () => {
  it.each(constructions)('式と参照を失わず往復する: $kind', (construction) => {
    const result = parseDrawing(envelope(construction));
    expect(result.ok && result.document.views[1].construction).toEqual(construction);
    if (result.ok) expect(serializeDrawing(result.document, { savedAt: result.savedAt })).toBe(envelope(construction));
  });
  it.each([
    null, {}, { ...constructions[0], kind: 'unknown' }, { ...constructions[0], plane: { kind: 'face', target: {}, offset: expression(0) } },
    { ...constructions[0], plane: { kind: 'threePoints', points: [point, point] } },
    { ...constructions[0], plane: { kind: 'viewLine', sourceViewId: '', from: [1, 2], to: [3, 4] } },
    { ...constructions[0], plane: { kind: 'workPlane', planeId: 'xy', offset: 2 } },
    { ...constructions[0], mode: 'half' }, { ...constructions[0], mode: 'local', boundary: [[0, 0], [1, 0]] },
    { ...constructions[0], label: ' ' }, { ...constructions[0], reversed: 'yes' },
  ])('壊れた作成条件を開かない: %j', (value) => expect(parseDrawing(tamper(value)).ok).toBe(false));
  it('図種と作成条件が異なるファイルを拒否する', () => expect(parseDrawing(tamper(constructions[0], 'detail')).ok).toBe(false));
  it('未知の将来の欄は残し、再生成できる図の座標や破断線は保存しない', () => {
    const extra = { ...constructions[0], futureOption: { style: 2 } };
    const result = parseDrawing(tamper(extra));
    if (!result.ok) throw new Error('parse failed');
    const withCache = { ...result.document, viewFrames: { temporary: true },
      views: result.document.views.map((view) => ({ ...view, breakCurves: [{ generated: true }] })) };
    const text = serializeDrawing(withCache);
    expect(text).toContain('futureOption'); expect(text).not.toContain('viewFrames'); expect(text).not.toContain('breakCurves');
  });
});
