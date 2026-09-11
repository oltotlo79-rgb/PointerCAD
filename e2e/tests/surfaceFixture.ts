import { exactExpressionValueFromNumber as n } from '../../packages/expression/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import { absoluteCoordinate, createEmptyPartDocument, replaceSketch, type SketchFeature } from '../../packages/model/src/index.js';

/** 結果形状を含まない作図入力。ロフト/スイープは画面で新規作成する。 */
export function surfaceFixture(kind: 'loft' | 'sweep'): Uint8Array {
  const document = { ...createEmptyPartDocument(), name: kind === 'loft' ? '閉じた自由曲線をつなぐ' : '案内線で細くする' };
  const sketch = { ...document.sketches[0], name: '輪郭と案内線' };
  const features: readonly SketchFeature[] = kind === 'loft'
    ? [[0, 1], [20, 2], [60, 1.5], [100, 1]].map(([z, scale]) => ({
      id: `spline-${z}`, name: `輪郭${z}`, kind: 'spline', planeId: 'free', mode: 'control', closed: true, construction: false,
      points: [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => absoluteCoordinate(x * scale, y * scale, z)),
    }))
    : [
      { id: 'circle', name: '半径5の円', kind: 'arc', planeId: 'xy', construction: false,
        center: absoluteCoordinate(0, 0, 0), radius: n(5), startAngle: n(0), endAngle: n(360) },
      { id: 'profile', name: '円の断面', kind: 'face', planeId: 'xy', boundary: [{ featureId: 'circle' }], color: '#77aadd' },
      { id: 'path', name: '高さ100の経路', kind: 'line', planeId: 'free', construction: false,
        from: absoluteCoordinate(0, 0, 0), to: absoluteCoordinate(0, 0, 100) },
      { id: 'guide', name: '半分にする案内線', kind: 'line', planeId: 'free', construction: false,
        from: absoluteCoordinate(5, 0, 0), to: absoluteCoordinate(2.5, 0, 100) },
    ];
  return writePcadFile(replaceSketch(document, { ...sketch, features }));
}
