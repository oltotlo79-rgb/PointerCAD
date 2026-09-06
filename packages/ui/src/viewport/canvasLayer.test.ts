/**
 * 下絵の画像の表示層と寸法合わせ(計画書 docs/plans/P6-入出力.md §0.a-0.45〜0.47、§2.14、
 * タスク39)。対応要件: FR-332、NFR-UX-2。
 *
 * 4 頂点の位置と寸法合わせの式は純関数として全部ここで固定する(§2.14 の表)。three.js の
 * 部品は DOM にも WebGL にも触れないので、**部品が増えないこと**(NFR-PF-1)と
 * **テクスチャ・材質・形を捨てること**(P5 §4)を数えて確かめ、実際の見え方は撮影と目視で
 * 確かめる(`createTrackingLayer.test.ts` / `createSolidLayer.test.ts` と同じ決め方)。
 */

import {
  CANVAS_INVALID_LENGTH_MESSAGE,
  CANVAS_SAME_POINT_MESSAGE,
  WORK_PLANES,
  type SketchCanvas,
} from '@pointercad/model';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';

import type { DecodedCanvasImage } from '../file/canvasFile.js';
import {
  buildCanvasPlanePositions,
  CANVAS_CORNER_UVS,
  CANVAS_RENDER_ORDER,
  CANVAS_TRIANGLE_INDICES,
  canvasPixelPointOf,
  canvasPlacementOf,
  canvasPositionValues,
  canvasSizeForTwoPoints,
  createCanvasLayer,
  type CanvasDraw,
  type CanvasPlacement,
} from './canvasLayer.js';

/**
 * `createSketchLayer.ts` が描く順に使う数の写し(あちらは輸出していない)。
 * 下絵が**必ずこれより後ろ**に来ることを固定するために置く(§0.a-0.46)。
 */
const SKETCH_WORK_PLANE_RENDER_ORDER = -1;
const SKETCH_CURVE_RENDER_ORDER = 3;

/** 幅 400・高さ 300 を原点中心・傾き 0 で置いた下絵(§2.14 の例)。 */
function placement(overrides: Partial<CanvasPlacement> = {}): CanvasPlacement {
  return {
    widthMm: 400,
    heightMm: 300,
    centerU: 0,
    centerV: 0,
    rotationDegrees: 0,
    ...overrides,
  };
}

/** 800×600 画素の偽の画像(復号器は使わない。`DecodedCanvasImage` は幅・高さだけを求める)。 */
function fakeImage(width = 800, height = 600): DecodedCanvasImage {
  return { width, height };
}

/** 式の欄。下絵の文書は幅・高さ・向き・不透明度を式のまま持つ(FR-202)。 */
function expression(value: number): { source: string; value: number; display: string } {
  return { source: String(value), value, display: String(value) };
}

function sketchCanvas(overrides: Partial<SketchCanvas> = {}): SketchCanvas {
  return {
    id: 'canvas-1',
    name: '下絵',
    plane: 'xy',
    imageId: 'image-1',
    width: expression(400),
    height: expression(300),
    origin: {
      mode: 'absolute',
      x: expression(10),
      y: expression(-20),
      z: expression(0),
    },
    rotation: expression(30),
    opacity: expression(0.5),
    visible: true,
    ...overrides,
  };
}

function draw(overrides: Partial<CanvasDraw> = {}): CanvasDraw {
  return {
    id: 'canvas-1',
    image: fakeImage(),
    plane: WORK_PLANES.xy,
    placement: placement(),
    opacity: 0.5,
    ...overrides,
  };
}

describe('下絵の面の 4 頂点(FR-332、§2.14)', () => {
  it('XY 面に幅 400・高さ 300 を原点中心で置くと 4 頂点は (±200, ±150, 0)', () => {
    const corners = buildCanvasPlanePositions(placement(), WORK_PLANES.xy);
    // 並びは 左上 → 右上 → 左下 → 右下(uv と対になる順)。
    expect(corners).toEqual([
      [-200, 150, 0],
      [200, 150, 0],
      [-200, -150, 0],
      [200, -150, 0],
    ]);
  });

  it('傾き 30° で 4 頂点が 30° 回る(第 1 軸から第 2 軸へ)', () => {
    const corners = buildCanvasPlanePositions(placement({ rotationDegrees: 30 }), WORK_PLANES.xy);
    const cos = Math.cos(Math.PI / 6);
    const sin = Math.sin(Math.PI / 6);
    // 左上は回す前が (-200, 150)。u' = u cos − v sin、v' = u sin + v cos。
    expect(corners[0][0]).toBeCloseTo(-200 * cos - 150 * sin, 9);
    expect(corners[0][1]).toBeCloseTo(-200 * sin + 150 * cos, 9);
    expect(corners[0][2]).toBeCloseTo(0, 9);
    // 右下は回す前が (200, -150)。中心を挟んで左上の反対側に来る。
    expect(corners[3][0]).toBeCloseTo(200 * cos + 150 * sin, 9);
    expect(corners[3][1]).toBeCloseTo(200 * sin - 150 * cos, 9);
    // 回しても対角線の長さは変わらない(4 頂点が回っただけで伸び縮みしていない)。
    expect(Math.hypot(corners[0][0] - corners[3][0], corners[0][1] - corners[3][1])).toBeCloseTo(
      Math.hypot(400, 300),
      9,
    );
  });

  it('中心をずらすと 4 頂点がそのぶん平行移動する', () => {
    const corners = buildCanvasPlanePositions(
      placement({ centerU: 10, centerV: -20 }),
      WORK_PLANES.xy,
    );
    expect(corners).toEqual([
      [-190, 130, 0],
      [210, 130, 0],
      [-190, -170, 0],
      [210, -170, 0],
    ]);
  });

  it('XZ 面に貼ると作図面の軸に沿って立つ(平面の第 1 軸・第 2 軸を使う)', () => {
    const corners = buildCanvasPlanePositions(placement(), WORK_PLANES.xz);
    // XZ 面は第 1 軸が X、第 2 軸が Z(`WORK_PLANES`)。Y は 0 のまま。
    expect(corners).toEqual([
      [-200, 0, 150],
      [200, 0, 150],
      [-200, 0, -150],
      [200, 0, -150],
    ]);
  });

  it('頂点・uv・三角形の並びが対になっている(v = 1 が画像の上端)', () => {
    expect(CANVAS_CORNER_UVS).toEqual([0, 1, 1, 1, 0, 0, 1, 0]);
    expect(CANVAS_TRIANGLE_INDICES).toEqual([0, 2, 1, 2, 3, 1]);
    expect(Array.from(canvasPositionValues(buildCanvasPlanePositions(placement(), WORK_PLANES.xy))))
      .toEqual([-200, 150, 0, 200, 150, 0, -200, -150, 0, 200, -150, 0]);
  });
});

describe('文書の下絵から置き方を取り出す(FR-202)', () => {
  it('式の評価値だけを読む(幅・高さ・中心・向き)', () => {
    expect(canvasPlacementOf(sketchCanvas())).toEqual({
      widthMm: 400,
      heightMm: 300,
      centerU: 10,
      centerV: -20,
      rotationDegrees: 30,
    });
  });

  it('絶対座標でない置き方(相対・極)は基準の位置へ落とす(画面から消さない)', () => {
    const relative = sketchCanvas({
      origin: {
        mode: 'relative',
        base: { kind: 'origin' },
        dx: expression(5),
        dy: expression(5),
        dz: expression(0),
      },
    });
    expect(canvasPlacementOf(relative).centerU).toBe(0);
    expect(canvasPlacementOf(relative).centerV).toBe(0);
  });
});

describe('2 点の寸法合わせ(FR-332、§0.a-0.46、§2.14)', () => {
  it('作図面の点を画像の画素へ写し戻す(中心が画像の中心、左上が (0, 0))', () => {
    const spot = placement();
    // 中心 → 800×600 の真ん中。
    expect(canvasPixelPointOf(spot, { width: 800, height: 600 }, [0, 0])).toEqual([400, 300]);
    // 左上の頂点(-200, 150)→ 画素の (0, 0)。画素の縦は下向き。
    expect(canvasPixelPointOf(spot, { width: 800, height: 600 }, [-200, 150])).toEqual([0, 0]);
    // 右下の頂点(200, -150)→ 画素の (800, 600)。
    expect(canvasPixelPointOf(spot, { width: 800, height: 600 }, [200, -150])).toEqual([800, 600]);
  });

  it('傾けて置いても、画像の上の同じ画素を指す', () => {
    const tilted = placement({ rotationDegrees: 30, centerU: 10, centerV: -20 });
    const corners = buildCanvasPlanePositions(tilted, WORK_PLANES.xy);
    const topLeft = canvasPixelPointOf(tilted, { width: 800, height: 600 }, [
      corners[0][0],
      corners[0][1],
    ]);
    expect(topLeft[0]).toBeCloseTo(0, 9);
    expect(topLeft[1]).toBeCloseTo(0, 9);
  });

  it('(100,100)〜(500,100) の 400 画素を 200mm にすると 800×600 の画像が 400×300mm になる', () => {
    // §2.14 の検算そのもの。画素の点を作図面の点へ直してから渡す(画面が渡すのは作図面の点)。
    const spot = placement();
    const size = { width: 800, height: 600 };
    // 画素 (100,100) は幅 400mm・高さ 300mm・中心原点のいまの置き方では (-150, 100)。
    const first: readonly [number, number] = [-150, 100];
    const second: readonly [number, number] = [50, 100];
    // 画素の縦は 100/300 の割り算を通るので、丸めの端数(1e-14)ぶんは許す。
    expect(canvasPixelPointOf(spot, size, first)[0]).toBeCloseTo(100, 9);
    expect(canvasPixelPointOf(spot, size, first)[1]).toBeCloseTo(100, 9);
    expect(canvasPixelPointOf(spot, size, second)[0]).toBeCloseTo(500, 9);
    expect(canvasPixelPointOf(spot, size, second)[1]).toBeCloseTo(100, 9);

    const outcome = canvasSizeForTwoPoints(spot, size, first, second, 200);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.pixelDistance).toBeCloseTo(400, 9);
    expect(outcome.scale).toBeCloseTo(0.5, 9);
    expect(outcome.widthMm).toBeCloseTo(400, 9);
    expect(outcome.heightMm).toBeCloseTo(300, 9);
  });

  it('3-4-5 の 500 画素を 100mm にすると縮尺は 0.2 mm/画素', () => {
    const spot = placement();
    const size = { width: 800, height: 600 };
    // 画素 (0,0) と (300,400) を作図面の点で指す。
    const first: readonly [number, number] = [-200, 150];
    const second: readonly [number, number] = [-50, -50];
    expect(canvasPixelPointOf(spot, size, second)[0]).toBeCloseTo(300, 9);
    expect(canvasPixelPointOf(spot, size, second)[1]).toBeCloseTo(400, 9);

    const outcome = canvasSizeForTwoPoints(spot, size, first, second, 100);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.pixelDistance).toBeCloseTo(500, 9);
    expect(outcome.scale).toBeCloseTo(0.2, 9);
  });

  it('2 点が同じ位置なら断る(0 除算の防止、NFR-UX-5)', () => {
    const outcome = canvasSizeForTwoPoints(
      placement(),
      { width: 800, height: 600 },
      [10, 10],
      [10, 10],
      200,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('samePoint');
    // 文言の正本は model(タスク38)。ここに同じ文を書かない。
    expect(outcome.message).toBe(CANVAS_SAME_POINT_MESSAGE);
  });

  it('実寸が 0 以下なら断る(画像が消える・裏返るのを防ぐ)', () => {
    const outcome = canvasSizeForTwoPoints(
      placement(),
      { width: 800, height: 600 },
      [-150, 100],
      [50, 100],
      0,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      return;
    }
    expect(outcome.reason).toBe('invalidLength');
    expect(outcome.message).toBe(CANVAS_INVALID_LENGTH_MESSAGE);
  });
});

/**
 * 面の材質を取り出す。`THREE.Mesh` の型引数には既定が入っていて `material` が広がるため、
 * いったん `unknown` で受けてから種類で絞る(`as` を使わない、rules/02-禁止事項.md。
 * `createTrackingLayer.test.ts` の `dashedMaterialOf` と同じ流儀)。
 */
function basicMaterialOf(object: THREE.Object3D): THREE.MeshBasicMaterial | null {
  if (!(object instanceof THREE.Mesh)) {
    return null;
  }
  const material: unknown = object.material;
  return material instanceof THREE.MeshBasicMaterial ? material : null;
}

/** 同じ理由で、面の形も種類を確かめてから取り出す。 */
function geometryOf(object: THREE.Object3D): THREE.BufferGeometry | null {
  if (!(object instanceof THREE.Mesh)) {
    return null;
  }
  const geometry: unknown = object.geometry;
  return geometry instanceof THREE.BufferGeometry ? geometry : null;
}

describe('下絵の層(NFR-PF-1、P5 §4)', () => {
  it('下絵 1 枚につき面 1 枚を作り、同じ内容を渡し直しても増やさない', () => {
    const layer = createCanvasLayer();
    expect(layer.group.children).toHaveLength(0);

    const first = draw();
    layer.update([first]);
    expect(layer.group.children).toHaveLength(1);

    layer.update([first]);
    layer.update([{ ...first, placement: placement({ centerU: 50 }) }]);
    expect(layer.group.children).toHaveLength(1);

    layer.update([first, draw({ id: 'canvas-2' })]);
    expect(layer.group.children).toHaveLength(2);

    layer.dispose();
  });

  it('不透明度 0.5 が材質へそのまま入り、半透明・深度を書かない・両面で貼る', () => {
    const layer = createCanvasLayer();
    layer.update([draw({ opacity: 0.5 })]);
    const material = basicMaterialOf(layer.group.children[0]);
    expect(material).not.toBeNull();
    if (material === null) {
      return;
    }
    expect(material.opacity).toBe(0.5);
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    expect(material.side).toBe(THREE.DoubleSide);
    expect(material.map).not.toBeNull();

    // 不透明度を変えても材質は作り直さない(同じ入れ物の値だけが変わる)。
    layer.update([draw({ opacity: 0.2 })]);
    expect(basicMaterialOf(layer.group.children[0])).toBe(material);
    expect(material.opacity).toBe(0.2);

    layer.dispose();
  });

  it('スケッチの線・作図面の矩形より後ろに描く(§0.a-0.46)', () => {
    const layer = createCanvasLayer();
    layer.update([draw()]);
    expect(layer.group.children[0].renderOrder).toBe(CANVAS_RENDER_ORDER);
    expect(CANVAS_RENDER_ORDER).toBeLessThan(SKETCH_WORK_PLANE_RENDER_ORDER);
    expect(CANVAS_RENDER_ORDER).toBeLessThan(SKETCH_CURVE_RENDER_ORDER);
    layer.dispose();
  });

  it('4 頂点の位置が置き方どおりに入り、動かすと書き換わる(部品は作り直さない)', () => {
    const layer = createCanvasLayer();
    layer.update([draw()]);
    const geometry = geometryOf(layer.group.children[0]);
    expect(geometry).not.toBeNull();
    if (geometry === null) {
      return;
    }
    const positions = geometry.getAttribute('position');
    expect(Array.from(positions.array)).toEqual([
      -200, 150, 0, 200, 150, 0, -200, -150, 0, 200, -150, 0,
    ]);

    layer.update([draw({ placement: placement({ centerU: 10 }) })]);
    expect(geometry.getAttribute('position')).toBe(positions);
    expect(Array.from(positions.array)).toEqual([
      -190, 150, 0, 210, 150, 0, -190, -150, 0, 210, -150, 0,
    ]);

    layer.dispose();
  });

  it('下絵を消すと、テクスチャ・材質・形を 1 回ずつ捨てる(P5 §4)', () => {
    const layer = createCanvasLayer();
    layer.update([draw()]);
    const material = basicMaterialOf(layer.group.children[0]);
    const geometry = geometryOf(layer.group.children[0]);
    expect(material).not.toBeNull();
    if (material === null || geometry === null) {
      return;
    }
    const texture = material.map;
    expect(texture).not.toBeNull();
    if (texture === null) {
      return;
    }

    const disposed: string[] = [];
    texture.addEventListener('dispose', () => disposed.push('texture'));
    material.addEventListener('dispose', () => disposed.push('material'));
    geometry.addEventListener('dispose', () => disposed.push('geometry'));

    layer.update([]);
    expect(disposed.sort()).toEqual(['geometry', 'material', 'texture']);
    expect(layer.group.children).toHaveLength(0);

    // もう一度渡しても、消した面をもう一度捨てることはない(二重解放をしない)。
    layer.dispose();
    expect(disposed).toHaveLength(3);
  });

  it('画像を差し替えると、古いテクスチャだけを捨てて面は使い回す', () => {
    const layer = createCanvasLayer();
    const first = draw();
    layer.update([first]);
    const material = basicMaterialOf(layer.group.children[0]);
    if (material === null) {
      return;
    }
    const oldTexture = material.map;
    if (oldTexture === null) {
      return;
    }
    const disposed: string[] = [];
    oldTexture.addEventListener('dispose', () => disposed.push('texture'));
    material.addEventListener('dispose', () => disposed.push('material'));

    layer.update([{ ...first, image: fakeImage(400, 300) }]);
    expect(disposed).toEqual(['texture']);
    expect(layer.group.children).toHaveLength(1);
    expect(material.map).not.toBe(oldTexture);

    layer.dispose();
  });

  it('dispose() で出ている下絵の資源を全部捨てる', () => {
    const layer = createCanvasLayer();
    layer.update([draw(), draw({ id: 'canvas-2' })]);
    const disposed: string[] = [];
    for (const child of layer.group.children) {
      const material = basicMaterialOf(child);
      const geometry = geometryOf(child);
      if (material === null || geometry === null) {
        continue;
      }
      material.map?.addEventListener('dispose', () => disposed.push('texture'));
      material.addEventListener('dispose', () => disposed.push('material'));
      geometry.addEventListener('dispose', () => disposed.push('geometry'));
    }

    layer.dispose();
    expect(disposed.sort()).toEqual([
      'geometry',
      'geometry',
      'material',
      'material',
      'texture',
      'texture',
    ]);
    expect(layer.group.children).toHaveLength(0);
  });
});
