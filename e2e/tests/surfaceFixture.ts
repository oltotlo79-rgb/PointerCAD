import { exactExpressionValueFromNumber as n } from '../../packages/expression/src/index.js';
import { writePcadFile } from '../../packages/io/src/index.js';
import {
  absoluteCoordinate, appendSolid, createEmptyPartDocument, replaceSketch, type SketchFeature,
} from '../../packages/model/src/index.js';

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

/**
 * 面だけのボディ 2 つ(曲面1・曲面2)。xy の線分 2 本(y=0 と y=30、x は 0〜30)を +Z へ 20 掃いた、30×20 の平らな面。
 * 上の辺(z=20)の中点は (15, 0, 20) と (15, 30, 20)。厚み付け・滑らかなつなぎの画面検査が使う。
 */
export function twoSheetsFixture(): Uint8Array {
  const document = { ...createEmptyPartDocument(), name: '2 枚の面' };
  const sketch = { ...document.sketches[0], name: '2 本の線分' };
  const lines: readonly SketchFeature[] = [0, 30].map((y, index) => ({
    id: `edge-${index}`, name: `線分${index + 1}`, kind: 'line', planeId: 'xy', construction: false,
    from: absoluteCoordinate(0, y, 0), to: absoluteCoordinate(30, y, 0),
  }));
  let part = replaceSketch(document, { ...sketch, features: lines });
  for (const [index, line] of lines.entries()) {
    part = appendSolid(part, { kind: 'surface', id: `sheet-${index}`, name: `曲面${index + 1}`, suppressed: false,
      operation: { kind: 'extrude', profile: { sketchId: sketch.id, curveIds: [line.id] }, distance: n(20), reversed: false } });
  }
  return writePcadFile(part);
}
