import { exactExpressionValueFromNumber as n } from '../../packages/expression/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import { absoluteCoordinate, appendSolid, createEmptyPartDocument, createSheetBaseFeature, createSheetFlangeFeature,
  replaceSketch, resolvePart, sheetBoundaryEdges } from '../../packages/model/src/index.js';

/** 実際のスケッチ入力だけを保存する。形状・展開・穴表はアプリのWorkerが計算する。 */
export function sheetHolePartFile(firstX = 10): Uint8Array {
  const empty = { ...createEmptyPartDocument(), name: '二つの穴を持つ板金' }, sketch = empty.sketches[0];
  let document = replaceSketch(empty, { ...sketch, features: [
    { kind: 'rectangle', id: 'rect', name: '外周', planeId: 'xy', construction: false, corner1: absoluteCoordinate(0,0,0), corner2: absoluteCoordinate(50,30,0) },
    { kind: 'face', id: 'outer', name: '基板輪郭', planeId: 'xy', boundary: [{ featureId: 'rect' }], color: '#ffffff' },
    { kind: 'arc', id: 'circle-1', name: '円1', planeId: 'xy', construction: false, center: absoluteCoordinate(firstX,8,0), radius: n(2), startAngle: n(0), endAngle: n(360) },
    { kind: 'face', id: 'hole-1', name: '穴1', planeId: 'xy', boundary: [{ featureId: 'circle-1' }], color: '#ffffff' },
    { kind: 'arc', id: 'circle-2', name: '円2', planeId: 'xy', construction: false, center: absoluteCoordinate(35,12,0), radius: n(2), startAngle: n(0), endAngle: n(360) },
    { kind: 'face', id: 'hole-2', name: '穴2', planeId: 'xy', boundary: [{ featureId: 'circle-2' }], color: '#ffffff' },
  ] });
  const base = { ...createSheetBaseFeature(document, { sketchId: sketch.id, faceFeatureId: 'outer' },
    { thickness: n(2), innerRadius: n(3), kFactor: n(0.4) }), holes: ['hole-1', 'hole-2'].map((id) => ({ sketchId: sketch.id, faceFeatureId: id })) };
  document = appendSolid(document, base);
  const panel = resolvePart(document).sheetMetalBodies?.get(base.id)?.panels[0]; if (panel === undefined) throw new Error('基板が必要です');
  const edges = sheetBoundaryEdges(panel); if (!edges.ok) throw new Error(edges.message);
  const edge = edges.value.find((item) => item.from[1] === 0 && item.to[1] === 0); if (edge === undefined) throw new Error('下縁が必要です');
  document = appendSolid(document, createSheetFlangeFeature(document, base.id, [{ panelId: panel.id, boundaryId: edge.id }]));
  return writePcadFile(document);
}
