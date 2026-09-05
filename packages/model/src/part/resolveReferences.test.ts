import { expressionValueFromNumber } from '@pointercad/expression';
import { describe, expect, it } from 'vitest';

import type { SubShapeRef } from '../geometry/subShapeRef.js';
import { createEmptySketchDocument } from '../sketch/createSketchDocument.js';
import { resolveSketch } from '../sketch/resolveSketch.js';
import type { SketchDocument, SketchFeature } from '../sketch/types.js';
import type { Vec3 } from '../sketch/vec3.js';
import { createEmptyPartDocument } from './createPartDocument.js';
import { createReferenceResolver } from './resolveReferences.js';
import type {
  PartDocument,
  PrimitiveFeature,
  ReferenceFeature,
  SolidFeature,
} from './types.js';

const ev = expressionValueFromNumber;

function expectVec3(actual: Vec3, expected: Vec3): void {
  expect(actual[0]).toBeCloseTo(expected[0], 12);
  expect(actual[1]).toBeCloseTo(expected[1], 12);
  expect(actual[2]).toBeCloseTo(expected[2], 12);
}

/** 点 1 つと線分 1 本を持つスケッチ。基準ジオメトリの参照先にする。 */
function sketchWithPoints(planeId = 'xy'): SketchDocument {
  const features: readonly SketchFeature[] = [
    {
      id: 'point-1',
      kind: 'point',
      name: '点1',
      planeId,
      at: { mode: 'absolute', x: ev(0), y: ev(0), z: ev(10) },
    },
    {
      id: 'line-1',
      kind: 'line',
      name: '線分1',
      planeId,
      construction: false,
      from: { mode: 'absolute', x: ev(0), y: ev(0), z: ev(0) },
      to: { mode: 'absolute', x: ev(0), y: ev(40), z: ev(0) },
    },
  ];
  return { ...createEmptySketchDocument(), features };
}

function documentWith(
  references: readonly ReferenceFeature[],
  sketch: SketchDocument = sketchWithPoints(),
): PartDocument {
  return { ...createEmptyPartDocument(), sketches: [sketch], activeSketchId: sketch.id, references };
}

/** 解決器を作る(スケッチはその場で解く。循環の検出はこの往復で起きる)。 */
function resolverFor(document: PartDocument) {
  const resolving = new Set<string>();
  const done = new Map<string, ReturnType<typeof resolveSketch>>();
  const resolver = createReferenceResolver(document, {
    sketch: (sketchId) => {
      const remembered = done.get(sketchId);
      if (remembered !== undefined) {
        return remembered;
      }
      if (resolving.has(sketchId)) {
        return null;
      }
      const found = document.sketches.find((sketch) => sketch.id === sketchId);
      if (found === undefined) {
        return null;
      }
      resolving.add(sketchId);
      const resolved = resolveSketch(found, { workPlane: (id) => resolver.workPlane(id) });
      resolving.delete(sketchId);
      done.set(sketchId, resolved);
      return resolved;
    },
  });
  return resolver;
}

function planeFace(position: Vec3, axis: Vec3, index: number): SubShapeRef {
  return {
    bodyFeatureId: 'extrude-1',
    index,
    fingerprint: {
      kind: 'face',
      surfaceKind: 'plane',
      area: 1200,
      position,
      axis,
      radius: null,
    },
  };
}

describe('基準ジオメトリの解決(FR-328、FR-329)', () => {
  it('基準点は座標の式・立体の頂点・辺の中点・面の中心から作れる', () => {
    const document = documentWith([
      {
        id: 'referencePoint-1',
        kind: 'referencePoint',
        name: '基準点1',
        visible: true,
        definition: {
          kind: 'coordinate',
          at: { mode: 'absolute', x: ev(1), y: ev(2), z: ev(3) },
        },
      },
      {
        id: 'referencePoint-2',
        kind: 'referencePoint',
        name: '基準点2',
        visible: true,
        definition: {
          kind: 'vertex',
          vertex: {
            bodyFeatureId: 'extrude-1',
            index: 0,
            fingerprint: { kind: 'vertex', position: [5, 5, 5] },
          },
        },
      },
      {
        id: 'referencePoint-3',
        kind: 'referencePoint',
        name: '基準点3',
        visible: true,
        definition: {
          kind: 'edgeMidpoint',
          edge: {
            bodyFeatureId: 'extrude-1',
            index: 1,
            fingerprint: {
              kind: 'edge',
              curveKind: 'line',
              length: 40,
              position: [20, 0, 0],
              axis: [1, 0, 0],
              radius: null,
            },
          },
        },
      },
      {
        id: 'referencePoint-4',
        kind: 'referencePoint',
        name: '基準点4',
        visible: false,
        definition: { kind: 'faceCenter', face: planeFace([0, 0, 10], [0, 0, 1], 3) },
      },
    ]);
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.errors).toEqual([]);
    expect(resolved.points).toHaveLength(4);
    expectVec3(resolved.points[0].position, [1, 2, 3]);
    expectVec3(resolved.points[1].position, [5, 5, 5]);
    expectVec3(resolved.points[2].position, [20, 0, 0]);
    expectVec3(resolved.points[3].position, [0, 0, 10]);
    expect(resolved.points[3].visible).toBe(false);
  });

  it('基準点の相対座標は、先に作った基準点を基準にできる', () => {
    const document = documentWith([
      {
        id: 'referencePoint-1',
        kind: 'referencePoint',
        name: '基準点1',
        visible: true,
        definition: { kind: 'coordinate', at: { mode: 'absolute', x: ev(1), y: ev(0), z: ev(0) } },
      },
      {
        id: 'referencePoint-2',
        kind: 'referencePoint',
        name: '基準点2',
        visible: true,
        definition: {
          kind: 'coordinate',
          at: {
            mode: 'relative',
            base: { kind: 'point', pointId: 'referencePoint-1' },
            dx: ev(2),
            dy: ev(3),
            dz: ev(4),
          },
        },
      },
    ]);
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.errors).toEqual([]);
    expectVec3(resolved.points[1].position, [3, 3, 4]);
  });

  it('基準軸は 2 点・辺・面の法線・2 面の交線から作れる', () => {
    const document = documentWith([
      {
        id: 'referenceAxis-1',
        kind: 'referenceAxis',
        name: '基準軸1',
        visible: true,
        // 原点 → スケッチの点 (0,0,10) なので向きは +Z。
        definition: { kind: 'twoPoints', from: { kind: 'origin' }, to: { kind: 'point', pointId: 'point-1' } },
      },
      {
        id: 'referenceAxis-2',
        kind: 'referenceAxis',
        name: '基準軸2',
        visible: true,
        definition: { kind: 'faceNormal', face: planeFace([0, 0, 10], [0, 0, 1], 3) },
      },
      {
        id: 'referenceAxis-3',
        kind: 'referenceAxis',
        name: '基準軸3',
        visible: true,
        // 面1 は z=10(法線 +Z)、面2 は x=20(法線 +X)。交線は (0,1,0) で、(20,0,10) を通る。
        definition: {
          kind: 'faceIntersection',
          face1: planeFace([0, 0, 10], [0, 0, 1], 3),
          face2: planeFace([20, 0, 5], [1, 0, 0], 4),
        },
      },
    ]);
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.errors).toEqual([]);
    expect(resolved.axes).toHaveLength(3);
    expectVec3(resolved.axes[0].origin, [0, 0, 0]);
    expectVec3(resolved.axes[0].direction, [0, 0, 1]);
    expectVec3(resolved.axes[1].direction, [0, 0, 1]);
    expectVec3(resolved.axes[2].direction, [0, 1, 0]);
    expectVec3(resolved.axes[2].origin, [20, 0, 10]);
  });

  it('平行な 2 面には交線が無いので degenerate で断る', () => {
    const document = documentWith([
      {
        id: 'referenceAxis-1',
        kind: 'referenceAxis',
        name: '基準軸1',
        visible: true,
        definition: {
          kind: 'faceIntersection',
          face1: planeFace([0, 0, 10], [0, 0, 1], 3),
          face2: planeFace([0, 0, 0], [0, 0, 1], 4),
        },
      },
    ]);
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.axes).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('degenerate');
    expect(resolved.errors[0].message).toContain('平行');
  });

  it('基準座標系は原点+2 軸で、第 3 軸は X × Y から導く(右手系)', () => {
    const document = documentWith([
      {
        id: 'referenceCoordinateSystem-1',
        kind: 'referenceCoordinateSystem',
        name: '座標系1',
        visible: true,
        origin: { kind: 'point', pointId: 'point-1' },
        xAxis: { kind: 'world', axis: 'x' },
        yAxis: { kind: 'world', axis: 'y' },
      },
    ]);
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.errors).toEqual([]);
    const system = resolved.coordinateSystems[0];
    expectVec3(system.origin, [0, 0, 10]);
    expectVec3(system.xAxis, [1, 0, 0]);
    expectVec3(system.yAxis, [0, 1, 0]);
    expectVec3(system.zAxis, [0, 0, 1]);
  });

  it('座標系の 2 軸が平行なら degenerate で断る', () => {
    const document = documentWith([
      {
        id: 'referenceCoordinateSystem-1',
        kind: 'referenceCoordinateSystem',
        name: '座標系1',
        visible: true,
        origin: { kind: 'origin' },
        xAxis: { kind: 'world', axis: 'z' },
        yAxis: { kind: 'world', axis: 'z' },
      },
    ]);
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.coordinateSystems).toEqual([]);
    expect(resolved.errors[0].code).toBe('degenerate');
  });

  it('作業平面は基準軸を「点+軸と角度」から参照できる(FR-329 の軸の使い回し)', () => {
    const document = documentWith([
      {
        id: 'referenceAxis-1',
        kind: 'referenceAxis',
        name: '基準軸1',
        visible: true,
        definition: { kind: 'twoPoints', from: { kind: 'origin' }, to: { kind: 'point', pointId: 'point-1' } },
      },
      {
        id: 'referencePlane-1',
        kind: 'referencePlane',
        name: '作業平面1',
        visible: true,
        plane: {
          kind: 'pointAndAxis',
          point: { kind: 'origin' },
          axis: { kind: 'reference', referenceFeatureId: 'referenceAxis-1' },
          tilt: ev(0),
          azimuth: ev(0),
        },
      },
    ]);
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.errors).toEqual([]);
    expectVec3(resolved.planes[0].plane.normal, [0, 0, 1]);
  });

  it('作業平面は自分より前の作業平面を基準にできる(履歴順)', () => {
    const document = documentWith([
      {
        id: 'referencePlane-1',
        kind: 'referencePlane',
        name: '作業平面1',
        visible: true,
        plane: { kind: 'workPlane', planeId: 'xy', offset: ev(10) },
      },
      {
        id: 'referencePlane-2',
        kind: 'referencePlane',
        name: '作業平面2',
        visible: true,
        plane: { kind: 'workPlane', planeId: 'referencePlane-1', offset: ev(5) },
      },
    ]);
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.errors).toEqual([]);
    expectVec3(resolved.planes[0].plane.origin, [0, 0, 10]);
    expectVec3(resolved.planes[1].plane.origin, [0, 0, 15]);
  });

  it('自分より後に作られた作業平面は参照できない(履歴順の制約)', () => {
    const document = documentWith([
      {
        id: 'referencePlane-1',
        kind: 'referencePlane',
        name: '作業平面1',
        visible: true,
        plane: { kind: 'workPlane', planeId: 'referencePlane-2', offset: ev(5) },
      },
      {
        id: 'referencePlane-2',
        kind: 'referencePlane',
        name: '作業平面2',
        visible: true,
        plane: { kind: 'workPlane', planeId: 'xy', offset: ev(10) },
      },
    ]);
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.planes).toHaveLength(1);
    expect(resolved.planes[0].featureId).toBe('referencePlane-2');
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].featureId).toBe('referencePlane-1');
    expect(resolved.errors[0].code).toBe('missingPlane');
    expect(resolved.errors[0].message).toContain('後から作られた');
  });

  it('無い作業平面を指すと missingPlane で断り、他は解決される(FR-504)', () => {
    const document = documentWith([
      {
        id: 'referencePlane-1',
        kind: 'referencePlane',
        name: '作業平面1',
        visible: true,
        plane: { kind: 'workPlane', planeId: 'referencePlane-9', offset: ev(5) },
      },
      {
        id: 'referencePlane-2',
        kind: 'referencePlane',
        name: '作業平面2',
        visible: true,
        plane: { kind: 'workPlane', planeId: 'xy', offset: ev(10) },
      },
    ]);
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.planes).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('missingPlane');
  });

  it('作業平面が自分の上に描かれたスケッチの点を使うと、循環として日本語で断る', () => {
    // 作業平面1 は「スケッチの点1」を通る 3 点指定で、その点1 は作業平面1 の上に描かれている。
    const sketch = sketchWithPoints('referencePlane-1');
    const document = documentWith(
      [
        {
          id: 'referencePlane-1',
          kind: 'referencePlane',
          name: '作業平面1',
          visible: true,
          plane: {
            kind: 'threePoints',
            p1: { kind: 'origin' },
            p2: { kind: 'point', pointId: 'point-1' },
            p3: { kind: 'vertex', featureId: 'line-1', vertex: 'end' },
          },
        },
      ],
      sketch,
    );
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.planes).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('circularReference');
    expect(resolved.errors[0].message).toContain('循環');
  });

  it('作図面の引き口は基準の 3 面と任意平面の両方を返す', () => {
    const document = documentWith([
      {
        id: 'referencePlane-1',
        kind: 'referencePlane',
        name: '作業平面1',
        visible: true,
        plane: { kind: 'workPlane', planeId: 'xy', offset: ev(10) },
      },
    ]);
    const resolver = resolverFor(document);
    const base = resolver.workPlane('xz');
    expect(base?.id).toBe('xz');
    const custom = resolver.workPlane('referencePlane-1');
    expect(custom?.id).toBe('referencePlane-1');
    expectVec3(custom?.origin ?? [0, 0, 0], [0, 0, 10]);
    expect(resolver.workPlane('referencePlane-9')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 球面上の点(FR-431、P5 計画書 §2.8、タスク19)
// ---------------------------------------------------------------------------

describe('球面上の点(FR-431)', () => {
  /** 球の基本形状 1 つ。基準点は座標の式で指定する(FR-429 の 3 通りのうち 1 つ目)。 */
  function sphere(
    center: Vec3,
    radius: number,
    options: { readonly id?: string; readonly suppressed?: boolean } = {},
  ): PrimitiveFeature {
    return {
      id: options.id ?? 'primitive-1',
      name: '球1',
      suppressed: options.suppressed ?? false,
      kind: 'primitive',
      origin: {
        kind: 'coordinate',
        value: { mode: 'absolute', x: ev(center[0]), y: ev(center[1]), z: ev(center[2]) },
      },
      axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'sphere', radius: ev(radius) },
    };
  }

  /** 球面上の点を原点にした基準点 1 つを持つ部品文書。 */
  function documentWithSphere(
    solids: readonly SolidFeature[],
    latitude: number,
    longitude: number,
    sphereFeatureId = 'primitive-1',
  ): PartDocument {
    return {
      ...documentWith([
        {
          id: 'referencePoint-1',
          kind: 'referencePoint',
          name: '基準点1',
          visible: true,
          definition: {
            kind: 'coordinate',
            at: {
              mode: 'relative',
              base: {
                kind: 'sphereGrid',
                sphereFeatureId,
                latitude: ev(latitude),
                longitude: ev(longitude),
              },
              dx: ev(0),
              dy: ev(0),
              dz: ev(0),
            },
          },
        },
      ]),
      solids,
    };
  }

  it('球の中心と半径から緯度・経度の位置を出す(r=10、30°、45°)', () => {
    const document = documentWithSphere([sphere([0, 0, 0], 10)], 30, 45);
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.errors).toEqual([]);
    expect(resolved.points).toHaveLength(1);
    expectVec3(resolved.points[0].position, [6.123724356957945, 6.123724356957945, 5]);
  });

  it('球の半径を 10 → 20 にすると点も外へ動く(追従、FR-431)', () => {
    const before = resolverFor(documentWithSphere([sphere([0, 0, 0], 10)], 30, 45)).resolveAll();
    const after = resolverFor(documentWithSphere([sphere([0, 0, 0], 20)], 30, 45)).resolveAll();
    expectVec3(before.points[0].position, [6.123724356957945, 6.123724356957945, 5]);
    expectVec3(after.points[0].position, [12.24744871391589, 12.24744871391589, 10]);
  });

  it('球の中心を [5,5,5] へ動かすと点も同じだけ動く(追従、FR-431)', () => {
    const resolved = resolverFor(documentWithSphere([sphere([5, 5, 5], 10)], 30, 45)).resolveAll();
    expectVec3(resolved.points[0].position, [11.123724356957945, 11.123724356957945, 10]);
  });

  it('球を消すと基準点が解けなくなる(日本語で断る)', () => {
    const resolved = resolverFor(documentWithSphere([], 30, 45)).resolveAll();
    expect(resolved.points).toEqual([]);
    expect(resolved.errors).toHaveLength(1);
    expect(resolved.errors[0].code).toBe('missingPoint');
    expect(resolved.errors[0].message).toContain('見つかりません');
  });

  it('球でない基本形状(箱)を指しても断る', () => {
    const box: SolidFeature = {
      id: 'primitive-1',
      name: '箱1',
      suppressed: false,
      kind: 'primitive',
      origin: {
        kind: 'coordinate',
        value: { mode: 'absolute', x: ev(0), y: ev(0), z: ev(0) },
      },
      axis: { kind: 'world', axis: 'z' },
      shape: { kind: 'box', sizeX: ev(10), sizeY: ev(10), sizeZ: ev(10) },
    };
    const resolved = resolverFor(documentWithSphere([box], 30, 45)).resolveAll();
    expect(resolved.points).toEqual([]);
    expect(resolved.errors[0].code).toBe('missingPoint');
  });

  it('抑制した球は画面に無いので、その球面上の点も置けない(FR-503)', () => {
    const document = documentWithSphere([sphere([0, 0, 0], 10, { suppressed: true })], 30, 45);
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.points).toEqual([]);
    expect(resolved.errors[0].code).toBe('missingPoint');
  });

  it('緯度が範囲外なら点を置かない(緯度 95)', () => {
    const resolved = resolverFor(documentWithSphere([sphere([0, 0, 0], 10)], 95, 0)).resolveAll();
    expect(resolved.points).toEqual([]);
    expect(resolved.errors[0].code).toBe('missingPoint');
  });

  it('球の中心をスケッチの点で指定しても解ける(FR-429 の 3 通りのうち 2 つ目)', () => {
    // sketchWithPoints の point-1 は (0,0,10)。
    const bySketchPoint: PrimitiveFeature = {
      ...sphere([0, 0, 0], 10),
      origin: { kind: 'sketchPoint', ref: { sketchId: 'sketch-1', pointFeatureId: 'point-1' } },
    };
    const base = documentWithSphere([bySketchPoint], 0, 0);
    const document: PartDocument = {
      ...base,
      solids: [
        {
          ...bySketchPoint,
          origin: {
            kind: 'sketchPoint',
            ref: { sketchId: base.sketches[0].id, pointFeatureId: 'point-1' },
          },
        },
      ],
    };
    const resolved = resolverFor(document).resolveAll();
    expect(resolved.errors).toEqual([]);
    expectVec3(resolved.points[0].position, [10, 0, 10]);
  });

  it('球の中心が自分の球面上の点を指していたら、たどり続けずに断る(循環)', () => {
    const circular: PrimitiveFeature = {
      ...sphere([0, 0, 0], 10),
      origin: {
        kind: 'coordinate',
        value: {
          mode: 'relative',
          base: {
            kind: 'sphereGrid',
            sphereFeatureId: 'primitive-1',
            latitude: ev(0),
            longitude: ev(0),
          },
          dx: ev(1),
          dy: ev(0),
          dz: ev(0),
        },
      },
    };
    const resolved = resolverFor(documentWithSphere([circular], 30, 45)).resolveAll();
    expect(resolved.points).toEqual([]);
    expect(resolved.errors[0].code).toBe('missingPoint');
  });
});
