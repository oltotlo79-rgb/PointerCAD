import {
  createAssemblyDocument, DEFAULT_COMPONENT_PLACEMENT, DISPLAY_MESH_DEVIATION_MM, type AssemblyComponent, type DimensionMoveExtent,
  type Quaternion, type RigidPlacement, type SolidBody, type SolidEdgeEntry, type SolidFaceEntry, type Vec3,
} from '@pointercad/model';
import { describe, expect, it } from 'vitest';

import { partExtentsAlong } from './partExtentAlong.js';

/*
 * 寸法で動かすの測り方: 部品の範囲を向きに沿って測る。式で測れる形(平面・直線の頂点、円の辺、全体の球)は式の値、
 * 式で測れない形(自由な曲面など)は網の値に、網の弦のずれ(DISPLAY_MESH_DEVIATION_MM)を誤差として載せる。期待は手で解いた値。
 * どの固定物も網は粗くしてある(円は 36° ごと・角の丸みは 30° ごと)ので、網だけで測ると値が足りなくなる所を式が直す事を見る。
 */
const part = (id: string): AssemblyComponent => ({ id, name: id, source: { kind: 'part', partRef: `part-${id}` },
  placement: DEFAULT_COMPONENT_PLACEMENT, fixed: false, visible: true, suppressed: false });

interface FaceSpec {
  readonly surfaceKind: SolidFaceEntry['surfaceKind'];
  readonly area?: number;
  readonly radius?: number;
  readonly axisOrigin?: Vec3;
  /** この面の三角形(点の番号 3 つずつ)。 */
  readonly triangles?: readonly (readonly [number, number, number])[];
}
interface CircleSpec {
  readonly center: Vec3;
  readonly radius: number;
  readonly range: readonly [number, number];
}

/** 点・面・円の辺からボディを作る(辺の網の線と、円でない辺は使わない)。 */
function solid(points: readonly Vec3[], faces: readonly FaceSpec[], circles: readonly CircleSpec[] = [], bodyKind?: 'mesh'): SolidBody {
  const indices: number[] = [];
  const faceEntries: SolidFaceEntry[] = faces.map((face, index) => {
    const triangleOffset = indices.length / 3;
    for (const triangle of face.triangles ?? []) indices.push(...triangle);
    return { index, surfaceKind: face.surfaceKind, area: face.area ?? 1, centroid: [0, 0, 0], axis: null, radius: face.radius ?? null,
      ...(face.axisOrigin === undefined ? {} : { axisOrigin: face.axisOrigin }), triangleOffset, triangleCount: (face.triangles ?? []).length };
  });
  const edges: SolidEdgeEntry[] = circles.map((circle, index) => ({ index, curveKind: 'circle', length: 1, midpoint: circle.center,
    start: circle.center, end: circle.center, axis: [0, 0, 1], radius: circle.radius, segmentOffset: 0, segmentCount: 0,
    circleBasis: { origin: circle.center, xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1], parameterRange: circle.range, orientation: 1 } }));
  return { featureId: 'body', mesh: { positions: new Float32Array(points.flat()), normals: new Float32Array(), indices: new Uint32Array(indices),
    edgePositions: new Float32Array(), triangleCount: indices.length / 3 }, volume: 1, isValid: true, faces: faceEntries, edges, vertices: [],
  threadMarks: [], ...(bodyKind === undefined ? {} : { bodyKind }) };
}

const FULL: readonly [number, number] = [0, 2 * Math.PI];
/** 円周を count 等分した点(中心 center、XY の面)。 */
const ring = (center: Vec3, radius: number, count: number): Vec3[] => Array.from({ length: count },
  (_, index): Vec3 => [center[0] + radius * Math.cos((2 * Math.PI * index) / count), center[1] + radius * Math.sin((2 * Math.PI * index) / count),
    center[2]]);
const BOX = solid([-10, 10].flatMap((x) => [-10, 10].flatMap((y) => [-10, 10].map((z): Vec3 => [x, y, z]))), [{ surfaceKind: 'plane' }]);
/** 半径 10・高さ 20(z 0〜20)の円柱。網は 36° ごと(Y の向きの網の極みは 10 × sin72° = 9.510565 で、真の 10 に足りない)。 */
const CYLINDER = solid([...ring([0, 0, 0], 10, 10), ...ring([0, 0, 20], 10, 10)],
  [{ surfaceKind: 'plane' }, { surfaceKind: 'plane' }, { surfaceKind: 'cylinder', radius: 10 }],
  [{ center: [0, 0, 0], radius: 10, range: FULL }, { center: [0, 0, 20], radius: 10, range: FULL }]);
const about = (axis: Vec3, degrees: number): Quaternion => {
  const half = (degrees * Math.PI) / 360;
  return [axis[0] * Math.sin(half), axis[1] * Math.sin(half), axis[2] * Math.sin(half), Math.cos(half)];
};
const at = (position: Vec3, rotation: Quaternion = [0, 0, 0, 1]): RigidPlacement => ({ position, rotation });

function measure(entries: readonly (readonly [string, SolidBody, RigidPlacement])[], direction: Vec3): ReadonlyMap<string, DimensionMoveExtent> {
  const document = { ...createAssemblyDocument('組立'), components: entries.map(([id]) => part(id)) };
  const view = { bodies: new Map(entries.map(([id, body]) => [`key-${id}`, [body]])),
    resolved: { partKeys: new Map(entries.map(([id]) => [id, `key-${id}`])), placements: new Map(entries.map(([id, , placement]) => [id, placement])) } };
  return partExtentsAlong(document, view, direction, entries.map(([id]) => id));
}
/** 範囲を 6 桁に丸めた [下, 上, 下の誤差, 上の誤差](頂点は Float32 なので 1e-6 の桁まで比べる)。 */
const rounded = (extent: DimensionMoveExtent | undefined): readonly number[] => extent === undefined ? []
  : [extent.low, extent.high, extent.lowErrorMm ?? 0, extent.highErrorMm ?? 0].map((value) => Math.round(value * 1e6) / 1e6);
const DIAGONAL: Vec3 = [Math.SQRT1_2, Math.SQRT1_2, 0];

describe('部品の範囲を向きに沿って測る(式で測れる形は式の値)', () => {
  it('20 mm 角の箱は、斜め 45° で ± 14.142136(頂点そのもの。誤差 0)', () => {
    const extents = measure([['a', BOX, at([0, 0, 0])], ['b', BOX, at([40, 40, 0])]], DIAGONAL);
    expect([rounded(extents.get('a')), rounded(extents.get('b'))]).toEqual([[-14.142136, 14.142136, 0, 0], [42.426407, 70.710678, 0, 0]]);
  });

  it('X の回りに 90° 回した円柱どうし: Z の範囲は円の辺の式で ± 10、すき間は 20(網だけなら 9.510565 で 20.978870)', () => {
    const turned = about([1, 0, 0], 90);
    const extents = measure([['a', CYLINDER, at([0, 0, 0], turned)], ['b', CYLINDER, at([0, 0, 40], turned)]], [0, 0, 1]);
    expect([rounded(extents.get('a')), rounded(extents.get('b'))]).toEqual([[-10, 10, 0, 0], [30, 50, 0, 0]]);
  });

  it('円柱と箱: Y の向きで円柱は ± 10(式)、箱は 30〜50、すき間は 20', () => {
    const extents = measure([['bar', CYLINDER, at([0, 0, 0])], ['box', BOX, at([0, 40, 0])]], [0, 1, 0]);
    expect([rounded(extents.get('bar')), rounded(extents.get('box'))]).toEqual([[-10, 10, 0, 0], [30, 50, 0, 0]]);
  });

  it('穴の内側の円(パイプの内径 6)は範囲を広げず、外径 10 の円が式で範囲を決める', () => {
    const pipe = solid([...ring([0, 0, 0], 10, 10), ...ring([0, 0, 0], 6, 10), ...ring([0, 0, 20], 10, 10), ...ring([0, 0, 20], 6, 10)],
      [{ surfaceKind: 'plane' }, { surfaceKind: 'cylinder', radius: 10 }, { surfaceKind: 'cylinder', radius: 6 }],
      [0, 20].flatMap((z) => [10, 6].map((radius): CircleSpec => ({ center: [0, 0, z], radius, range: FULL }))));
    expect(rounded(measure([['pipe', pipe, at([0, 0, 0])]], DIAGONAL).get('pipe'))).toEqual([-10, 10, 0, 0]);
  });

  it('角の丸み(40 × 20 の板、角の半径 5): 45° の範囲は 14.142136 + 5 = 19.142136(網だけなら 18.971765)', () => {
    const corners: readonly CircleSpec[] = [
      { center: [15, 5, 0], radius: 5, range: [0, Math.PI / 2] }, { center: [-15, 5, 0], radius: 5, range: [Math.PI / 2, Math.PI] },
      { center: [-15, -5, 0], radius: 5, range: [Math.PI, 1.5 * Math.PI] }, { center: [15, -5, 0], radius: 5, range: [1.5 * Math.PI, 2 * Math.PI] },
    ];
    const points = corners.flatMap(({ center, range }) => [0, 1, 2, 3].map((step): Vec3 => {
      const angle = range[0] + (step * Math.PI) / 6;
      return [center[0] + 5 * Math.cos(angle), center[1] + 5 * Math.sin(angle), 0];
    }));
    const plate = solid(points, [{ surfaceKind: 'plane' }, { surfaceKind: 'cylinder', radius: 5 }], corners);
    expect(rounded(measure([['plate', plate, at([0, 0, 0])]], DIAGONAL).get('plate'))).toEqual([-19.142136, 19.142136, 0, 0]);
    expect(rounded(measure([['plate', plate, at([0, 0, 0])]], [1, 0, 0]).get('plate'))).toEqual([-20, 20, 0, 0]);
  });

  it('円の辺の極みの角が角の範囲の外なら使わない(四分円 0〜90°: X の範囲は 0〜10。範囲の外の 180° の -10 を使わない)', () => {
    const quarter = solid([[0, 0, 0], [10, 0, 0], [0, 10, 0]], [{ surfaceKind: 'plane' }],
      [{ center: [0, 0, 0], radius: 10, range: [0, Math.PI / 2] }]);
    expect(rounded(measure([['quarter', quarter, at([0, 0, 0])]], [1, 0, 0]).get('quarter'))).toEqual([0, 10, 0, 0]);
  });

  it('全体の球(面積 4π × 10²)は式で ± 10。一部だけの球(面積が半分)は網の値で、両方の端に誤差(網の弦のずれ)を載せる', () => {
    const points: Vec3[] = [-45, 45].flatMap((latitude) => [0, 90, 180, 270].map((longitude): Vec3 => {
      const [phi, lambda] = [(latitude * Math.PI) / 180, (longitude * Math.PI) / 180];
      return [10 * Math.cos(phi) * Math.cos(lambda), 10 * Math.cos(phi) * Math.sin(lambda), 10 * Math.sin(phi)];
    }));
    const triangles: readonly (readonly [number, number, number])[] = [[0, 1, 4], [1, 2, 5], [2, 3, 6], [3, 0, 7]];
    const whole = solid(points, [{ surfaceKind: 'sphere', radius: 10, axisOrigin: [0, 0, 0], area: 400 * Math.PI, triangles }]);
    expect(rounded(measure([['ball', whole, at([0, 0, 0])]], [0, 0, 1]).get('ball'))).toEqual([-10, 10, 0, 0]);
    const half = solid(points, [{ surfaceKind: 'sphere', radius: 10, axisOrigin: [0, 0, 0], area: 200 * Math.PI, triangles }]);
    // 網の点の端は ± 10 × sin45° = ± 7.071068。どこまで覆う面か分からないので、真の端はそこから網の弦のずれまで外にあり得る。
    expect(rounded(measure([['cap', half, at([0, 0, 0])]], [0, 0, 1]).get('cap')))
      .toEqual([-7.071068, 7.071068, DISPLAY_MESH_DEVIATION_MM, DISPLAY_MESH_DEVIATION_MM]);
  });

  it('自由な曲面(式で測れない面)は、その面が端の時だけ誤差を載せる。端でない時と、読み込んだ三角形の形は誤差 0', () => {
    // 底は 40 角の平面(z = 0)、上に高さ 8 の自由な曲面の山(頂点と半径 10 の輪)。
    const points: Vec3[] = [[-20, -20, 0], [20, -20, 0], [20, 20, 0], [-20, 20, 0], [0, 0, 8], ...ring([0, 0, 5], 10, 4)];
    const dome = solid(points, [{ surfaceKind: 'plane' }, { surfaceKind: 'other', triangles: [[4, 5, 6], [4, 6, 7], [4, 7, 8], [4, 8, 5]] }]);
    expect(rounded(measure([['dome', dome, at([0, 0, 0])]], [0, 0, 1]).get('dome'))).toEqual([0, 8, 0, DISPLAY_MESH_DEVIATION_MM]);
    expect(rounded(measure([['dome', dome, at([0, 0, 0])]], [1, 0, 0]).get('dome'))).toEqual([-20, 20, 0, 0]);
    const imported = solid(points, [], [], 'mesh');
    expect(rounded(measure([['stl', imported, at([0, 0, 0])]], [0, 0, 1]).get('stl'))).toEqual([0, 8, 0, 0]);
  });

  it('形の情報(面の一覧)が無いボディは、全体を網の値とし、両方の端に誤差を載せる', () => {
    const bare = solid([[-10, 0, 0], [10, 0, 0]], []);
    expect(rounded(measure([['bare', bare, at([0, 0, 0])]], [1, 0, 0]).get('bare')))
      .toEqual([-10, 10, DISPLAY_MESH_DEVIATION_MM, DISPLAY_MESH_DEVIATION_MM]);
  });
});
