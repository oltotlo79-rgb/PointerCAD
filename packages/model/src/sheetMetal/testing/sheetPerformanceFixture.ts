/** 25個のU板×基板・2フランジ・切欠き。全て異なる実座標を持つ、100段の入力文書。 */
import { exactExpressionValueFromNumber as n } from '@pointercad/expression';
import { appendSolid, createEmptyPartDocument, replaceSketch } from '../../part/createPartDocument.js';
import { resolvePart } from '../../part/resolvePart.js';
import type { PartDocument } from '../../part/types.js';
import { absoluteCoordinate } from '../../sketch/createSketchDocument.js';
import { createSheetBaseFeature, createSheetFlangeFeature, createSheetReliefFeature } from '../createSheetFeature.js';
import { sheetBoundaryEdges } from '../panelGeometry.js';

export function sheetPerformanceFixture(count = 25, offset = 0, offsetY = 0): PartDocument {
  let document = { ...createEmptyPartDocument(), name: '切欠き付きU板25個・板金100段' };
  for (let i = 0; i < count; i++) {
    const x = offset + (i % 5) * 100, y = offsetY + Math.floor(i / 5) * 100;
    const empty = createEmptyPartDocument(), sketch = empty.sketches[0];
    let unit = replaceSketch(empty, { ...sketch, features: [
      { kind: 'rectangle', id: `rect-${i}`, name: `輪郭${i + 1}`, planeId: 'xy', construction: false,
        corner1: absoluteCoordinate(x, y, 0), corner2: absoluteCoordinate(x + 50, y + 30, 0) },
      { kind: 'face', id: `face-${i}`, name: `面${i + 1}`, planeId: 'xy', boundary: [{ featureId: `rect-${i}` }], color: '#ffffff' },
    ] });
    const base = { ...createSheetBaseFeature(unit, { sketchId: sketch.id, faceFeatureId: `face-${i}` },
      { thickness: n(2), innerRadius: n(3), kFactor: n(0.4) }), id: `base-${i}`, name: `基板${i + 1}` };
    unit = appendSolid(unit, base);
    const panel = resolvePart(unit).sheetMetalBodies?.get(base.id)?.panels[0];
    if (panel === undefined) throw new Error('実スケッチから基板を解決できません');
    const edges = sheetBoundaryEdges(panel); if (!edges.ok) throw new Error(edges.message);
    const bottom = edges.value.find((edge) => edge.from[1] === y && edge.to[1] === y);
    const top = edges.value.find((edge) => edge.from[1] === y + 30 && edge.to[1] === y + 30);
    const right = edges.value.find((edge) => edge.from[0] === x + 50 && edge.to[0] === x + 50);
    if (bottom === undefined || top === undefined || right === undefined) throw new Error('基板の三つの直線縁が必要です');
    const first = { ...createSheetFlangeFeature(unit, base.id, [{ panelId: panel.id, boundaryId: bottom.id }]),
      id: `first-${i}`, name: `手前フランジ${i + 1}` };
    unit = appendSolid(unit, first);
    const second = { ...createSheetFlangeFeature(unit, first.id, [{ panelId: panel.id, boundaryId: top.id }]),
      id: `second-${i}`, name: `奥フランジ${i + 1}` };
    unit = appendSolid(unit, second);
    const relief = { ...createSheetReliefFeature(unit, second.id, { panelId: panel.id, boundaryId: right.id }, base.rule),
      id: `relief-${i}`, name: `切欠き付きU板${i + 1}`, position: n(30), width: n(4), depth: n(5) };
    const combined = document.sketches[0];
    document = replaceSketch(document, { ...combined, features: [...combined.features, ...unit.sketches[0].features] });
    for (const solid of [base, first, second, relief]) document = appendSolid(document, solid);
  }
  return document;
}

/** 平面体積7000＋2本の四分円管400π−板20−曲げ帯400/19。 */
export const U_BRACKET_VOLUME = 7000 + 400 * Math.PI - 780 / 19;
