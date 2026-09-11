import { exactExpressionValueFromNumber as n } from '../../packages/expression/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import { absoluteCoordinate, createEmptyPartDocument, replaceSketch, type SketchFeature } from '../../packages/model/src/index.js';

/** 形状結果を含めず、基板矩形・台形フランジ・円穴の作図入力を渡す。 */
export function sheetProfileFile(): Uint8Array {
  const document = { ...createEmptyPartDocument(), name: '穴付き台形の両側フランジ' }, sketch = document.sketches[0];
  const points = [[60,0], [110,0], [100,20], [70,20]] as const;
  const lines: SketchFeature[] = points.map((from, i) => {
    const to = points[(i + 1) % points.length];
    return { kind: 'line', id: `side-${i}`, name: `台形の辺${i + 1}`, planeId: 'xy', construction: false,
      from: absoluteCoordinate(from[0], from[1], 0), to: absoluteCoordinate(to[0], to[1], 0) };
  });
  return writePcadFile(replaceSketch(document, { ...sketch, features: [
    { kind: 'rectangle', id: 'rect', name: '基板矩形', planeId: 'xy', construction: false,
      corner1: absoluteCoordinate(0,0,0), corner2: absoluteCoordinate(50,30,0) },
    { kind: 'face', id: 'base-face', name: '基板の面', planeId: 'xy', boundary: [{ featureId: 'rect' }], color: '#ffffff' },
    ...lines,
    { kind: 'face', id: 'profile-face', name: '台形の面', planeId: 'xy', boundary: lines.map((line) => ({ featureId: line.id })), color: '#ffffff' },
    { kind: 'arc', id: 'circle', name: '円穴', planeId: 'xy', construction: false,
      center: absoluteCoordinate(85,10,0), radius: n(2), startAngle: n(0), endAngle: n(360) },
    { kind: 'face', id: 'hole-face', name: '穴の面', planeId: 'xy', boundary: [{ featureId: 'circle' }], color: '#ffffff' },
  ] }));
}
