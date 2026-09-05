/**
 * 測定の描画(計画書 docs/plans/P5-高度なソリッド・外観と測定.md タスク31、FR-1102)の検査。
 *
 * 座標の組み立て(`buildMeasureShapes` / `measureArcFrame`)は純関数なので Node のまま
 * 期待値を手で出して固定する。`createMeasureLayer()` 本体は three.js の入れ物を作るだけで
 * WebGL には触れないので、描く範囲・表示の入切・資源の解放もここで確かめられる
 * (`createSolidLayer.test.ts` と同じ方針)。実際の見え方(色・読みやすさ)は
 * ヘッドレスの撮影で確かめる。
 *
 * 期待値の材料は、タスク30 の検査と同じ **40×30×10 の板**(角を原点に置く)。
 *
 *   向かい合う面(下面 z=0 と上面 z=10)の距離  10 mm、線は (20,15,0)–(20,15,10)
 *   隣り合う面(上面と右面)のなす角            90 度(法線 [0,0,1] と [1,0,0])
 *   半径 10 の弧の中ほど(45 度)               10/√2 = 7.0710678118654755
 */

import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';

import {
  formatMeasure,
  measureLocally,
  measureReadiness,
  type MeasureBody,
} from '../solid/measure.js';
import type { SolidFaceEntry } from '../solid/subShapeSelection.js';
import {
  buildMeasureShapes,
  createMeasureLayer,
  measureArcFrame,
  MEASURE_ARC_SEGMENTS,
  type MeasureAngleSpec,
  type MeasureLayer,
  type MeasurementState,
} from './createMeasureLayer.js';
import { DEFAULT_THEME_COLORS, type ThemeColors } from './themeColors.js';

/* ---------------------------------------------------------------------------
 * 材料
 * ------------------------------------------------------------------------- */

function planeFace(
  index: number,
  area: number,
  centroid: readonly [number, number, number],
  normal: readonly [number, number, number],
): SolidFaceEntry {
  return {
    index,
    surfaceKind: 'plane',
    area,
    centroid,
    axis: normal,
    radius: null,
    triangleOffset: index * 2,
    triangleCount: 2,
  };
}

/** 40×30×10 の板。測定に使う面だけを、カーネルと同じ並びで持つ。 */
const BOX: MeasureBody = {
  featureId: 'extrude-1',
  mesh: { edgePositions: new Float32Array() },
  volume: 12000,
  faces: [
    planeFace(0, 1200, [20, 15, 0], [0, 0, -1]), // 下面
    planeFace(1, 1200, [20, 15, 10], [0, 0, 1]), // 上面
    planeFace(2, 400, [20, 0, 5], [0, -1, 0]), // 手前
    planeFace(3, 400, [20, 30, 5], [0, 1, 0]), // 奥
    planeFace(4, 300, [0, 15, 5], [-1, 0, 0]), // 左
    planeFace(5, 300, [40, 15, 5], [1, 0, 0]), // 右
  ],
  edges: [],
  vertices: [],
};

/** 選んだ 2 つを測って、画面に出す形(`MeasurementState`)まで組み立てる。 */
function measurementOf(
  selection: readonly string[],
  angle: MeasureAngleSpec | null = null,
  anchor: readonly [number, number, number] | null = null,
): MeasurementState {
  const readiness = measureReadiness(selection, [BOX]);
  const kind = readiness.kind;
  if (kind === null) {
    throw new Error(`測れない組み合わせです: ${selection.join(', ')}`);
  }
  const result = measureLocally(kind, readiness.targets, [BOX]);
  if (result === null) {
    throw new Error(`一覧から測れませんでした: ${kind}`);
  }
  return { result, text: formatMeasure(result), angle, anchor };
}

/** 面積・体積のように線を引けない測定(札だけを出す)。 */
function labelOnlyMeasurement(anchor: readonly [number, number, number] | null): MeasurementState {
  return measurementOf(['extrude-1#face:1'], null, anchor);
}

/* ---------------------------------------------------------------------------
 * 座標の組み立て(純関数)
 * ------------------------------------------------------------------------- */

describe('buildMeasureShapes(FR-1102)', () => {
  it('測定が無ければ何も描かない', () => {
    const shapes = buildMeasureShapes(null);
    expect(shapes.lineCount).toBe(0);
    expect(shapes.arcCount).toBe(0);
    expect(shapes.endCount).toBe(0);
    expect(shapes.labelPosition).toBeNull();
  });

  it('向かい合う面の距離は線 1 本・両端の丸 2 つ・中点の札になる(40×30×10 の板)', () => {
    const measurement = measurementOf(['extrude-1#face:0', 'extrude-1#face:1']);
    // タスク30 の計算そのまま: 距離 10mm、線は下面の重心から真上へ。
    expect(measurement.result.value).toBeCloseTo(10, 12);
    expect(measurement.result.segment).toEqual([
      [20, 15, 0],
      [20, 15, 10],
    ]);
    expect(measurement.text).toBe('10.000 mm');

    const shapes = buildMeasureShapes(measurement);
    expect(shapes.lineCount).toBe(1);
    expect(Array.from(shapes.linePositions.slice(0, 6))).toEqual([20, 15, 0, 20, 15, 10]);
    expect(shapes.endCount).toBe(2);
    expect(Array.from(shapes.endPositions)).toEqual([20, 15, 0, 20, 15, 10]);
    expect(shapes.arcCount).toBe(0);
    expect(shapes.labelPosition).toEqual([20, 15, 5]);
  });

  it('隣り合う面の角度は 2 本の線と弧になる(90 度、半径 10)', () => {
    const measurement = measurementOf(['extrude-1#face:1', 'extrude-1#face:5'], {
      apex: [40, 15, 10],
      from: [0, 0, 1],
      to: [1, 0, 0],
      radius: 10,
    });
    expect(measurement.result.value).toBeCloseTo(90, 12);
    expect(measurement.text).toBe('90.000 度');
    expect(measurement.result.segment).toBeNull();

    const shapes = buildMeasureShapes(measurement);
    // 線は頂から 2 本(長さは半径の 1.5 倍 = 15mm)。
    expect(shapes.lineCount).toBe(2);
    expect(Array.from(shapes.linePositions)).toEqual([
      40, 15, 10, 40, 15, 25, // 1 本目: +Z へ 15mm
      40, 15, 10, 55, 15, 10, // 2 本目: +X へ 15mm
    ]);
    // 弧は 32 分割の折れ線(点は 33 個)。
    expect(shapes.arcCount).toBe(MEASURE_ARC_SEGMENTS + 1);
    expect(Array.from(shapes.arcPositions.slice(0, 3))).toEqual([40, 15, 20]);
    const last = shapes.arcPositions.slice(MEASURE_ARC_SEGMENTS * 3, MEASURE_ARC_SEGMENTS * 3 + 3);
    expect(last[0]).toBeCloseTo(50, 12);
    expect(last[1]).toBeCloseTo(15, 12);
    expect(last[2]).toBeCloseTo(10, 12);
    // 中ほど(45 度)は 10/√2 = 7.0710678118654755 ずつ。
    const middle = shapes.arcPositions.slice(
      (MEASURE_ARC_SEGMENTS / 2) * 3,
      (MEASURE_ARC_SEGMENTS / 2) * 3 + 3,
    );
    expect(middle[0]).toBeCloseTo(40 + 7.0710678118654755, 6);
    expect(middle[2]).toBeCloseTo(10 + 7.0710678118654755, 6);
    // 頂に丸を 1 つ、札は弧の外側(半径の 1.15 倍)へ。
    expect(shapes.endCount).toBe(1);
    expect(Array.from(shapes.endPositions.slice(0, 3))).toEqual([40, 15, 10]);
    expect(shapes.labelPosition?.[0]).toBeCloseTo(40 + 11.5 * Math.SQRT1_2, 6);
    expect(shapes.labelPosition?.[2]).toBeCloseTo(10 + 11.5 * Math.SQRT1_2, 6);
  });

  it('2 本が平行なら弧を描かない(角を張れない)', () => {
    const angle: MeasureAngleSpec = {
      apex: [0, 0, 0],
      from: [0, 0, 1],
      to: [0, 0, -1],
      radius: 10,
    };
    expect(measureArcFrame(angle)).toBeNull();
    const shapes = buildMeasureShapes(
      measurementOf(['extrude-1#face:1', 'extrude-1#face:5'], angle),
    );
    expect(shapes.arcCount).toBe(0);
    expect(shapes.lineCount).toBe(2);
    expect(shapes.labelPosition).toEqual([0, 0, 0]);
  });

  it('弧の半径が 0 以下・数でないときも落ちない(線と札だけになる)', () => {
    for (const radius of [0, -5, Number.NaN]) {
      expect(
        measureArcFrame({ apex: [0, 0, 0], from: [1, 0, 0], to: [0, 1, 0], radius }),
      ).toBeNull();
    }
  });

  it('面積のように線を引けない測定は、札だけを置く', () => {
    const shapes = buildMeasureShapes(labelOnlyMeasurement([20, 15, 10]));
    expect(shapes.lineCount).toBe(0);
    expect(shapes.arcCount).toBe(0);
    expect(shapes.endCount).toBe(0);
    expect(shapes.labelPosition).toEqual([20, 15, 10]);
  });

  it('置く場所が分からない測定は札も出さない(何も描かない)', () => {
    const shapes = buildMeasureShapes(labelOnlyMeasurement(null));
    expect(shapes.labelPosition).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 * 層(three.js の入れ物)
 * ------------------------------------------------------------------------- */

/*
 * 層の中身の絞り込み。**中身(形と材質)まで確かめてから絞り込む**ので、後の取り出しで
 * 型を偽らずに済む(`createSolidLayer.test.ts` の `isBodyMesh` と同じ流儀)。
 */
type MeasureLines = THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
type MeasureArc = THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
type MeasureEnds = THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
type MeasureLabel = THREE.Sprite;

function isMeasureLines(object: THREE.Object3D): object is MeasureLines {
  if (!(object instanceof THREE.LineSegments)) {
    return false;
  }
  const geometry: unknown = object.geometry;
  const material: unknown = object.material;
  return geometry instanceof THREE.BufferGeometry && material instanceof THREE.LineBasicMaterial;
}

function isMeasureArc(object: THREE.Object3D): object is MeasureArc {
  if (!(object instanceof THREE.Line) || object instanceof THREE.LineSegments) {
    return false;
  }
  const geometry: unknown = object.geometry;
  const material: unknown = object.material;
  return geometry instanceof THREE.BufferGeometry && material instanceof THREE.LineBasicMaterial;
}

function isMeasureEnds(object: THREE.Object3D): object is MeasureEnds {
  if (!(object instanceof THREE.Points)) {
    return false;
  }
  const geometry: unknown = object.geometry;
  const material: unknown = object.material;
  return geometry instanceof THREE.BufferGeometry && material instanceof THREE.PointsMaterial;
}

function isMeasureLabel(object: THREE.Object3D): object is MeasureLabel {
  if (!(object instanceof THREE.Sprite)) {
    return false;
  }
  const material: unknown = object.material;
  return material instanceof THREE.SpriteMaterial;
}

/** 層の中身。入れ物は作った順に線・弧・端の丸・札の 4 つ。 */
function partsOf(layer: MeasureLayer): {
  readonly lines: MeasureLines;
  readonly arc: MeasureArc;
  readonly ends: MeasureEnds;
  readonly label: MeasureLabel;
} {
  const [lines, arc, ends, label] = layer.group.children;
  if (
    !isMeasureLines(lines) ||
    !isMeasureArc(arc) ||
    !isMeasureEnds(ends) ||
    !isMeasureLabel(label)
  ) {
    throw new Error('測定の層の中身が想定と違います。');
  }
  return { lines, arc, ends, label };
}

/** 位置の並び。書き換えの回数(version)を見たいので BufferAttribute へ絞る。 */
function positionsOf(object: THREE.Object3D & { geometry: THREE.BufferGeometry }): THREE.BufferAttribute {
  const attribute = object.geometry.getAttribute('position');
  if (!(attribute instanceof THREE.BufferAttribute)) {
    throw new Error('位置の並びが BufferAttribute ではありません。');
  }
  return attribute;
}

describe('createMeasureLayer(FR-1102、NFR-PF-1)', () => {
  it('作った直後は何も出ていない', () => {
    const layer = createMeasureLayer();
    const { lines, arc, ends, label } = partsOf(layer);
    expect(lines.visible).toBe(false);
    expect(arc.visible).toBe(false);
    expect(ends.visible).toBe(false);
    expect(label.visible).toBe(false);
    layer.dispose();
  });

  it('距離を渡すと線 1 本と丸 2 つが出て、null で消える', () => {
    const layer = createMeasureLayer();
    layer.update(measurementOf(['extrude-1#face:0', 'extrude-1#face:1']));
    const { lines, arc, ends } = partsOf(layer);
    expect(lines.visible).toBe(true);
    expect(lines.geometry.drawRange.count).toBe(2);
    expect(Array.from(positionsOf(lines).array.slice(0, 6))).toEqual([20, 15, 0, 20, 15, 10]);
    expect(ends.visible).toBe(true);
    expect(ends.geometry.drawRange.count).toBe(2);
    // 距離に弧は要らない。
    expect(arc.visible).toBe(false);

    layer.update(null);
    expect(lines.visible).toBe(false);
    expect(ends.visible).toBe(false);
    expect(arc.visible).toBe(false);
    layer.dispose();
  });

  it('角度を渡すと弧(33 点)と線 2 本が出る', () => {
    const layer = createMeasureLayer();
    layer.update(
      measurementOf(['extrude-1#face:1', 'extrude-1#face:5'], {
        apex: [40, 15, 10],
        from: [0, 0, 1],
        to: [1, 0, 0],
        radius: 10,
      }),
    );
    const { lines, arc, ends } = partsOf(layer);
    expect(arc.visible).toBe(true);
    expect(arc.geometry.drawRange.count).toBe(MEASURE_ARC_SEGMENTS + 1);
    expect(lines.geometry.drawRange.count).toBe(4);
    expect(ends.geometry.drawRange.count).toBe(1);
    layer.dispose();
  });

  it('同じ測定を渡し直すと並びを 1 度も書き換えない(NFR-PF-1)', () => {
    const layer = createMeasureLayer();
    const measurement = measurementOf(['extrude-1#face:0', 'extrude-1#face:1']);
    layer.update(measurement);
    const { lines, ends } = partsOf(layer);
    const lineVersion = positionsOf(lines).version;
    const endVersion = positionsOf(ends).version;

    layer.update(measurement);
    layer.update(measurement);
    expect(positionsOf(lines).version).toBe(lineVersion);
    expect(positionsOf(ends).version).toBe(endVersion);

    // 別の測定なら書き換える(早く返るのは「同じもの」のときだけ)。
    layer.update(measurementOf(['extrude-1#face:1', 'extrude-1#face:0']));
    expect(positionsOf(lines).version).toBeGreaterThan(lineVersion);
    layer.dispose();
  });

  it('テーマを変えると線と丸の色が変わる(FR-908)', () => {
    const layer = createMeasureLayer();
    const { lines, ends } = partsOf(layer);
    expect(lines.material.color.getHex()).toBe(DEFAULT_THEME_COLORS.measure);

    const light: ThemeColors = { ...DEFAULT_THEME_COLORS, measure: 0xa34700 };
    layer.setThemeColors(light);
    expect(lines.material.color.getHex()).toBe(0xa34700);
    expect(ends.material.color.getHex()).toBe(0xa34700);
    layer.dispose();
  });

  it('dispose() で線・弧・丸・札の資源を捨てる', () => {
    const layer = createMeasureLayer();
    const { lines, arc, ends, label } = partsOf(layer);
    const disposed: string[] = [];
    lines.geometry.addEventListener('dispose', () => disposed.push('line'));
    arc.geometry.addEventListener('dispose', () => disposed.push('arc'));
    ends.geometry.addEventListener('dispose', () => disposed.push('end'));
    lines.material.addEventListener('dispose', () => disposed.push('lineMaterial'));
    ends.material.addEventListener('dispose', () => disposed.push('endMaterial'));
    label.material.addEventListener('dispose', () => disposed.push('labelMaterial'));

    layer.dispose();
    expect(disposed.sort()).toEqual(
      ['arc', 'end', 'endMaterial', 'labelMaterial', 'line', 'lineMaterial'].sort(),
    );
  });
});

/* ---------------------------------------------------------------------------
 * 値の札(canvas がある環境だけ)
 * ------------------------------------------------------------------------- */

/**
 * 文字の絵を描くところだけを確かめるための、最小限の偽の canvas。
 *
 * Node の検査環境には `document` が無く、`createMeasureLayer` はそのとき札を出さずに
 * 線と丸だけを描く(実装の後退路)。ここではその後退路ではなく**本来の道**を通したいので、
 * `document.createElement('canvas')` が返すものだけを差し替える(three.js は
 * `CanvasTexture` に受け取った絵をそのまま持つだけなので、これで足りる)。
 */
function installFakeCanvas(): void {
  const context = {
    font: '',
    textBaseline: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 0,
    lineJoin: '',
    // 1 文字 10 画素として測る(幅の期待値を手で出せるようにする)。
    measureText: (text: string) => ({ width: text.length * 10 }),
    fillText: () => undefined,
    strokeText: () => undefined,
    beginPath: () => undefined,
    arc: () => undefined,
    fill: () => undefined,
  };
  const canvas = { width: 0, height: 0, getContext: () => context };
  Object.defineProperty(globalThis, 'document', {
    value: { createElement: () => ({ ...canvas }) },
    configurable: true,
  });
}

function removeFakeCanvas(): void {
  Reflect.deleteProperty(globalThis, 'document');
}

describe('値の札(定数サイズのスプライト)', () => {
  afterEach(() => {
    removeFakeCanvas();
  });

  it('文字の幅に合わせた札を、測った場所へ定数サイズで置く', () => {
    installFakeCanvas();
    const layer = createMeasureLayer();
    layer.update(measurementOf(['extrude-1#face:0', 'extrude-1#face:1']));
    const { label } = partsOf(layer);
    expect(label.visible).toBe(true);
    // 札は線の中点(20,15,5)へ。
    expect([label.position.x, label.position.y, label.position.z]).toEqual([20, 15, 5]);

    // 「10.000 mm」は 9 文字 = 90 画素 + 余白 8×2 = 106 画素幅、高さは 22 + 16 = 38 画素。
    layer.updateScreenScale(100, 800, 100);
    expect(label.scale.y).toBeGreaterThan(0);
    expect(label.scale.x / label.scale.y).toBeCloseTo(106 / 38, 10);

    // 拡大率を上げると札も大きくなる(比は変わらない)。
    const before = label.scale.y;
    layer.updateScreenScale(100, 800, 150);
    expect(label.scale.y).toBeCloseTo(before * 1.5, 10);
    expect(label.scale.x / label.scale.y).toBeCloseTo(106 / 38, 10);

    // 消したら札も消える。
    layer.update(null);
    expect(label.visible).toBe(false);
    layer.dispose();
  });

  it('canvas が無い環境では札を出さず、線と丸だけを描く(落ちない)', () => {
    const layer = createMeasureLayer();
    layer.update(measurementOf(['extrude-1#face:0', 'extrude-1#face:1']));
    const { lines, label } = partsOf(layer);
    expect(lines.visible).toBe(true);
    expect(label.visible).toBe(false);
    layer.dispose();
  });
});
