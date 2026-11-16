import { quaternionFromAxisAngle, type SolidBody } from '@pointercad/model';
import { describe, expect, it } from 'vitest';
import { subShapeElementId } from '../solid/subShapeSelection.js';
import type { EmphasisBuffers, SketchGeometryBundle } from './buildSketchGeometry.js';
import { buildSolidGeometry, EMPTY_SOLID_GEOMETRY } from './buildSolidGeometry.js';
import { HOME_ORBIT, MAX_DISTANCE, VERTICAL_FIELD_OF_VIEW } from './cameraMath.js';
import type { AssemblyGeometryBundle } from './createAssemblyLayer.js';
import { fitOrbitToBounds, viewFitBounds, type ViewBounds } from './viewFit.js';

/* 設計 2-3(B-08c): 全体を表示・選択に合わせるの外接箱と、向きを保ったまま収める視点。期待値は手で書いた座標から作る。 */

// 一辺 10 の立方体(0〜10)。面 0 は +X、1 は −X、2 は +Y、3 は −Y、4 は +Z、5 は −Z の 2 枚ずつ。
const CORNERS = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
const TRIANGLES = [[1, 2, 6], [1, 6, 5], [0, 4, 7], [0, 7, 3], [3, 7, 6], [3, 6, 2], [0, 1, 5], [0, 5, 4], [4, 5, 6], [4, 6, 7], [0, 3, 2], [0, 2, 1]];

function cube(featureId: string, coordinateFrame?: SolidBody['coordinateFrame']): SolidBody {
  const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const;
  return {
    featureId, volume: 1000, isValid: true, threadMarks: [],
    faces: axes.map((axis, index) => ({ index, surfaceKind: 'plane', area: 100, centroid: [5, 5, 5], axis, radius: null,
      triangleOffset: index * 2, triangleCount: 2 })),
    edges: [
      { index: 0, curveKind: 'line', length: 10, midpoint: [5, 0, 0], start: [0, 0, 0], end: [10, 0, 0], axis: [1, 0, 0], radius: null,
        segmentOffset: 0, segmentCount: 1 },
      { index: 1, curveKind: 'line', length: 10, midpoint: [5, 10, 10], start: [10, 10, 10], end: [0, 10, 10], axis: [-1, 0, 0], radius: null,
        segmentOffset: 1, segmentCount: 1 },
    ],
    vertices: [{ index: 0, position: [10, 10, 10] }],
    mesh: { positions: new Float32Array(CORNERS.flat()), normals: new Float32Array(CORNERS.length * 3),
      indices: new Uint32Array(TRIANGLES.flat()), edgePositions: new Float32Array([0, 0, 0, 10, 0, 0, 10, 10, 10, 0, 10, 10]),
      triangleCount: TRIANGLES.length },
    ...(coordinateFrame === undefined ? {} : { coordinateFrame }),
  };
}

const none = (): EmphasisBuffers => ({ none: new Float32Array(0), constrained: new Float32Array(0), hovered: new Float32Array(0),
  selected: new Float32Array(0) });
function sketch(points: Partial<EmphasisBuffers>): SketchGeometryBundle {
  return { points: { ...none(), ...points }, curves: none(), constructionCurves: none(), faceOutlines: none(), faces: [], index: new Map() };
}
const box = (min: readonly [number, number, number], max: readonly [number, number, number]): ViewBounds => ({ min, max });

describe('部品の画面の外接箱', () => {
  const solid = buildSolidGeometry([cube('body-1'), cube('body-far', { space: 'local', origin: [100, 0, 0], maximumFloat32ErrorMm: 0.001 })], null, []);

  it('全体は立体(局所の原点を足した位置)とスケッチの全部の強調の並び', () => {
    const drawn = sketch({ none: new Float32Array([-5, 2, 3]), selected: new Float32Array([0, -7, 0]) });
    expect(viewFitBounds({ kind: 'part', solid, sketch: drawn }, 'all', [])).toEqual(box([-5, -7, 0], [110, 10, 10]));
    expect(viewFitBounds({ kind: 'part', solid: EMPTY_SOLID_GEOMETRY, sketch: null }, 'all', [])).toBeNull();
  });

  it('選択は、立体・面・辺・頂点の id と、スケッチの選択の強調の並びだけ', () => {
    const source = { kind: 'part', solid, sketch: sketch({ none: new Float32Array([-50, 0, 0]), selected: new Float32Array([3, 4, 5]) }) } as const;
    // スケッチの強調の並びは、今の選択をそのまま映す(選んだ物が立体だけなら選択の並びは空)。
    expect(viewFitBounds({ ...source, sketch: null }, 'selection', ['body-far'])).toEqual(box([100, 0, 0], [110, 10, 10]));
    expect(viewFitBounds({ ...source, sketch: null }, 'selection', [subShapeElementId('body-1', 'face', 0)])).toEqual(box([10, 0, 0], [10, 10, 10]));
    expect(viewFitBounds({ ...source, sketch: null }, 'selection', [subShapeElementId('body-far', 'face', 4)])).toEqual(box([100, 0, 10], [110, 10, 10]));
    expect(viewFitBounds({ ...source, sketch: null }, 'selection', [subShapeElementId('body-1', 'edge', 1)])).toEqual(box([0, 10, 10], [10, 10, 10]));
    expect(viewFitBounds({ ...source, sketch: null }, 'selection', [subShapeElementId('body-1', 'vertex', 0)])).toEqual(box([10, 10, 10], [10, 10, 10]));
    // 選んだスケッチの点(選択の強調の並び)と、無い id・無い面の番号は数えない。
    expect(viewFitBounds(source, 'selection', ['missing', subShapeElementId('body-1', 'face', 99)])).toEqual(box([3, 4, 5], [3, 4, 5]));
    expect(viewFitBounds({ ...source, sketch: null }, 'selection', ['missing'])).toBeNull();
  });
});

describe('組立の画面の外接箱', () => {
  const assembly: AssemblyGeometryBundle = {
    parts: [{ partKey: 'part', bodies: [cube('body-1')] }],
    instances: [
      { componentId: 'component-1', partKey: 'part', placement: { position: [100, 0, 0], rotation: [0, 0, 0, 1] }, visible: true, emphasis: 'none' },
      // z 軸の周りに 90° 回すと、x は −10〜0、y は 0〜10 になる。
      { componentId: 'component-2', partKey: 'part', placement: { position: [0, 50, 0], rotation: quaternionFromAxisAngle([0, 0, 1], Math.PI / 2) },
        visible: true, emphasis: 'none' },
      { componentId: 'hidden', partKey: 'part', placement: { position: [-1000, 0, 0], rotation: [0, 0, 0, 1] }, visible: false, emphasis: 'none' },
    ],
  };
  const near = (bounds: ViewBounds | null, expected: ViewBounds): void => {
    expect(bounds).not.toBeNull();
    bounds?.min.forEach((value, axis) => { expect(value).toBeCloseTo(expected.min[axis] ?? Number.NaN, 9); });
    bounds?.max.forEach((value, axis) => { expect(value).toBeCloseTo(expected.max[axis] ?? Number.NaN, 9); });
  };

  it('見えている配置ごとに部品の箱の 8 隅を配置で写す(非表示の配置は数えない)', () => {
    near(viewFitBounds({ kind: 'assembly', assembly }, 'all', []), box([-10, 0, 0], [110, 60, 10]));
  });

  it('選択は部品の id と、部品の面などの選択(組立の対象の id)から部品を選ぶ', () => {
    near(viewFitBounds({ kind: 'assembly', assembly }, 'selection', ['component-1']), box([100, 0, 0], [110, 10, 10]));
    const target = `assembly-target:${encodeURIComponent('component-2')}/${encodeURIComponent(subShapeElementId('body-1', 'face', 0))}`;
    near(viewFitBounds({ kind: 'assembly', assembly }, 'selection', [target]), box([-10, 50, 0], [0, 60, 10]));
    expect(viewFitBounds({ kind: 'assembly', assembly }, 'selection', ['hidden'])).toBeNull();
  });
});

describe('箱が収まる視点', () => {
  it('向き・上向き・ズームは今のまま、注視点を箱の中心へ、距離を外接球が狭い方の画角に収まる長さへ', () => {
    const current = { ...HOME_ORBIT, up: [0, 1, 0] as const, zoom: 1 };
    const fitted = fitOrbitToBounds(current, box([0, 0, 0], [30, 40, 0]), 2);
    // 半径 25、横長(縦の画角が狭い): 25 × 1.1 ÷ sin(25°)。
    expect(fitted?.target).toEqual([15, 20, 0]);
    expect(fitted?.distance).toBeCloseTo(25 * 1.1 / Math.sin(VERTICAL_FIELD_OF_VIEW / 2), 9);
    expect({ ...fitted, target: current.target, distance: current.distance }).toEqual(current);
    // 縦長では横の画角が狭い。ズーム 2 倍は画角を狭める。
    const halfHorizontal = Math.atan(Math.tan(VERTICAL_FIELD_OF_VIEW / 2) * 0.5);
    expect(fitOrbitToBounds(current, box([0, 0, 0], [30, 40, 0]), 0.5)?.distance).toBeCloseTo(25 * 1.1 / Math.sin(halfHorizontal), 9);
    const halfZoomed = Math.atan(Math.tan(VERTICAL_FIELD_OF_VIEW / 2) / 2);
    expect(fitOrbitToBounds({ ...current, zoom: 2 }, box([0, 0, 0], [30, 40, 0]), 2)?.distance).toBeCloseTo(25 * 1.1 / Math.sin(halfZoomed), 9);
  });

  it('点 1 つでも寄りすぎず(半径 1)、遠すぎる時は上限で止め、数でない値では作らない', () => {
    expect(fitOrbitToBounds(HOME_ORBIT, box([5, 5, 5], [5, 5, 5]), 1)?.distance).toBeCloseTo(1.1 / Math.sin(VERTICAL_FIELD_OF_VIEW / 2), 9);
    expect(fitOrbitToBounds(HOME_ORBIT, box([0, 0, 0], [1e9, 0, 0]), 1)?.distance).toBe(MAX_DISTANCE);
    expect(fitOrbitToBounds(HOME_ORBIT, box([0, 0, 0], [Number.NaN, 0, 0]), 1)).toBeNull();
    expect(fitOrbitToBounds(HOME_ORBIT, box([0, 0, 0], [1, 1, 1]), 0)).toBeNull();
  });
});
