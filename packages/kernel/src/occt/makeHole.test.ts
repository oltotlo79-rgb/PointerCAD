import { beforeAll, describe, expect, it } from 'vitest';

import type { HoleStepSpec, SolidFaceInfo, SubShapeQuery, Vec3Tuple } from '../types.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeBox } from './makeBox.js';
import { makeHole, makeHoleTools, resolveHoleFrame } from './makeHole.js';
import { makeExtrudeSolid } from './makeSolidSweep.js';
import { hasSolid, isValidShape, measureVolume } from './solidMesh.js';
import type { SubShapeTables } from './subShapes.js';
import { collectSubShapes } from './subShapes.js';
import { tessellate } from './tessellate.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/** 計画書 タスク6 の検証表が使う板。体積 12000、上の面は z=10、面積 1200。 */
const PLATE = { dx: 40, dy: 30, dz: 10 } as const;

/** φ6 の穴 1 つが板から削る体積(貫通、板厚 10)。π·3²·10 = 282.743338823… */
const THROUGH_HOLE_VOLUME = Math.PI * 3 * 3 * PLATE.dz;

/**
 * 体積の突き合わせ。円柱も箱も解析的に積分されるので近似は入らない。
 * 2026-09-03 の実測では板の穴で 1e-15、200×200 の板の 20 穴で 1.2e-15(いずれも相対)だった。
 * ここでは余裕を見て相対 1e-9 で固定する(計画書の ±1e-6 より厳しい)。
 */
function expectVolume(actual: number, expected: number): void {
  expect(Math.abs(actual - expected) / Math.abs(expected)).toBeLessThan(1e-9);
}

describe('穴あけ(FR-405、FR-504)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** tessellate / extractEdges と同じ形から一覧を作る(実際の使われ方と同じ順序)。 */
  function subShapesOf(shape: Parameters<typeof collectSubShapes>[1]): SubShapeTables {
    const mesh = tessellate(oc, shape);
    const lines = extractEdges(oc, shape);
    return collectSubShapes(oc, shape, mesh.faceRanges, lines.edgeRanges);
  }

  function facesOf(shape: Parameters<typeof collectSubShapes>[1]): readonly SolidFaceInfo[] {
    return subShapesOf(shape).faces;
  }

  /** 面の素性をそのまま指紋にする(UI が選んだ直後と同じ状態)。 */
  function faceQuery(info: SolidFaceInfo): Extract<SubShapeQuery, { kind: 'face' }> {
    return {
      kind: 'face',
      index: info.index,
      surfaceKind: info.surfaceKind,
      area: info.area,
      position: info.centroid,
      axis: info.axis,
      radius: info.radius,
    };
  }

  /** 軸が axis に最も近い平面の面を 1 枚選ぶ(上の面・下の面を実名で指すため)。 */
  function planeFacing(faces: readonly SolidFaceInfo[], axis: Vec3Tuple): SolidFaceInfo {
    const found = faces.find(
      (face) =>
        face.surfaceKind === 'plane' &&
        face.axis !== null &&
        Math.abs(face.axis[0] - axis[0]) < 1e-9 &&
        Math.abs(face.axis[1] - axis[1]) < 1e-9 &&
        Math.abs(face.axis[2] - axis[2]) < 1e-9,
    );
    if (found === undefined) {
      throw new Error(`向き [${axis.join(',')}] の平面が見つかりませんでした`);
    }
    return found;
  }

  function holeSpec(overrides: Partial<HoleStepSpec> & { face: SubShapeQuery }): HoleStepSpec {
    return {
      kind: 'hole',
      targetKey: 'target',
      centers: [[20, 15, 10]],
      diameter: 6,
      depth: null,
      tiltAngle: 0,
      tiltAzimuth: 0,
      transforms: [],
      ...overrides,
    };
  }

  /** 板と、その上の面の指紋。使い終わったら handle.delete() する。 */
  function plateWithTopFace(): {
    handle: OcctShapeHandle;
    faces: readonly SolidFaceInfo[];
    top: SolidFaceInfo;
  } {
    const handle = makeBox(oc, PLATE);
    const faces = facesOf(handle.shape);
    return { handle, faces, top: planeFacing(faces, [0, 0, 1]) };
  }

  it('上の面に φ6 の貫通穴を 1 つあける', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const result = makeHole(oc, holeSpec({ face: faceQuery(top) }), handle.shape, faces);
      try {
        // 12000 − π·3²·10 = 11717.256661176919
        expectVolume(measureVolume(oc, result.shape), 12000 - THROUGH_HOLE_VOLUME);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('貫通穴の後の面は 7 枚(箱の 6 面 + 円筒面 1 枚)', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const result = makeHole(oc, holeSpec({ face: faceQuery(top) }), handle.shape, faces);
      try {
        expect(facesOf(result.shape)).toHaveLength(7);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('中心を離した 4 つの穴を 1 回であける', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const result = makeHole(
        oc,
        holeSpec({
          face: faceQuery(top),
          centers: [
            [10, 8, 10],
            [30, 8, 10],
            [10, 22, 10],
            [30, 22, 10],
          ],
        }),
        handle.shape,
        faces,
      );
      try {
        // 12000 − 4·282.743338823 = 10869.026644707674
        expectVolume(measureVolume(oc, result.shape), 12000 - 4 * THROUGH_HOLE_VOLUME);
        expect(hasSolid(oc, result.shape)).toBe(true);
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('深さ 4 の止まり穴は平底で、立体が残る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const result = makeHole(oc, holeSpec({ face: faceQuery(top), depth: 4 }), handle.shape, faces);
      try {
        // 12000 − π·3²·4 = 11886.902664470767
        expectVolume(measureVolume(oc, result.shape), 12000 - Math.PI * 3 * 3 * 4);
        expect(hasSolid(oc, result.shape)).toBe(true);
        // 底が平ら(円錐の先端が無い)なので、面は 6 + 円筒 + 底の円 = 8 枚。
        expect(facesOf(result.shape)).toHaveLength(8);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('傾き 0 の穴は、上の面の法線の逆向き([0,0,-1])へ掘る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const frame = resolveHoleFrame(oc, handle.shape, faces, holeSpec({ face: faceQuery(top) }));
      expect(frame.direction[0]).toBeCloseTo(0, 12);
      expect(frame.direction[1]).toBeCloseTo(0, 12);
      expect(frame.direction[2]).toBeCloseTo(-1, 12);
    } finally {
      handle.delete();
    }
  });

  it('下の面を選ぶと、法線の反転が効いて [0,0,1] へ掘る', () => {
    const { handle, faces } = plateWithTopFace();
    try {
      const bottom = planeFacing(faces, [0, 0, -1]);
      const frame = resolveHoleFrame(
        oc,
        handle.shape,
        faces,
        holeSpec({ face: faceQuery(bottom), centers: [[20, 15, 0]] }),
      );
      expect(frame.direction[2]).toBeCloseTo(1, 12);
    } finally {
      handle.delete();
    }
  });

  it('中心の点は面の平面へ投影される(面から 40mm 離れた点でも同じ穴になる)', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const frame = resolveHoleFrame(
        oc,
        handle.shape,
        faces,
        holeSpec({ face: faceQuery(top), centers: [[20, 15, 50]] }),
      );
      expect(frame.origins).toHaveLength(1);
      expect(frame.origins[0][0]).toBeCloseTo(20, 9);
      expect(frame.origins[0][1]).toBeCloseTo(15, 9);
      expect(frame.origins[0][2]).toBeCloseTo(10, 9);

      const result = makeHole(
        oc,
        holeSpec({ face: faceQuery(top), centers: [[20, 15, 50]] }),
        handle.shape,
        faces,
      );
      try {
        expectVolume(measureVolume(oc, result.shape), 12000 - THROUGH_HOLE_VOLUME);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('傾き 20 度・方位角 0 の穴は、面の第 1 軸(上の面では +X)へ倒れる', () => {
    const { handle, faces, top } = plateWithTopFace();
    const tilt = (20 * Math.PI) / 180;
    try {
      const spec = holeSpec({ face: faceQuery(top), tiltAngle: tilt, tiltAzimuth: 0 });
      const frame = resolveHoleFrame(oc, handle.shape, faces, spec);
      expect(frame.direction[0]).toBeCloseTo(Math.sin(tilt), 12);
      expect(frame.direction[1]).toBeCloseTo(0, 12);
      expect(frame.direction[2]).toBeCloseTo(-Math.cos(tilt), 12);

      const result = makeHole(oc, spec, handle.shape, faces);
      try {
        // 斜めに貫く円柱が削る量は π r² × 板厚 / cos(傾き)。
        expectVolume(measureVolume(oc, result.shape), 12000 - THROUGH_HOLE_VOLUME / Math.cos(tilt));
        expect(isValidShape(oc, result.shape)).toBe(true);
      } finally {
        result.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('方位角 90 度では第 2 軸(上の面では +Y)へ倒れる', () => {
    const { handle, faces, top } = plateWithTopFace();
    const tilt = (20 * Math.PI) / 180;
    try {
      const frame = resolveHoleFrame(
        oc,
        handle.shape,
        faces,
        holeSpec({ face: faceQuery(top), tiltAngle: tilt, tiltAzimuth: Math.PI / 2 }),
      );
      expect(frame.direction[0]).toBeCloseTo(0, 12);
      expect(frame.direction[1]).toBeCloseTo(Math.sin(tilt), 12);
      expect(frame.direction[2]).toBeCloseTo(-Math.cos(tilt), 12);
    } finally {
      handle.delete();
    }
  });

  it('中心が 1 つも無ければ断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(oc, holeSpec({ face: faceQuery(top), centers: [] }), handle.shape, faces),
      ).toThrow(/穴の中心になる点/);
    } finally {
      handle.delete();
    }
  });

  it('中心の座標が数でなければ断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(
          oc,
          holeSpec({ face: faceQuery(top), centers: [[Number.NaN, 15, 10]] }),
          handle.shape,
          faces,
        ),
      ).toThrow(/穴の中心の位置が数になっていません/);
    } finally {
      handle.delete();
    }
  });

  it('直径が 0 なら断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(oc, holeSpec({ face: faceQuery(top), diameter: 0 }), handle.shape, faces),
      ).toThrow(/穴の直径は 0 より大きい/);
    } finally {
      handle.delete();
    }
  });

  it('止まり穴の深さが 0 なら断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(oc, holeSpec({ face: faceQuery(top), depth: 0 }), handle.shape, faces),
      ).toThrow(/穴の深さは 0 より大きい/);
    } finally {
      handle.delete();
    }
  });

  it('傾き角が 90 度以上・負なら断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(
          oc,
          holeSpec({ face: faceQuery(top), tiltAngle: Math.PI / 2 }),
          handle.shape,
          faces,
        ),
      ).toThrow(/穴の傾きは 0 度以上 90 度未満/);
      expect(() =>
        makeHole(oc, holeSpec({ face: faceQuery(top), tiltAngle: -0.1 }), handle.shape, faces),
      ).toThrow(/穴の傾きは 0 度以上 90 度未満/);
    } finally {
      handle.delete();
    }
  });

  it('方位角が数でなければ断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(
          oc,
          holeSpec({ face: faceQuery(top), tiltAzimuth: Number.POSITIVE_INFINITY }),
          handle.shape,
          faces,
        ),
      ).toThrow(/穴の傾きの向きは数/);
    } finally {
      handle.delete();
    }
  });

  it('板より大きい径(φ100)の貫通穴は「立体が残らない」と断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(oc, holeSpec({ face: faceQuery(top), diameter: 100 }), handle.shape, faces),
      ).toThrow(/立体が残りませんでした/);
    } finally {
      handle.delete();
    }
  });

  it('材料に当たらない位置の穴は「当たらなかった」と断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(
          oc,
          holeSpec({ face: faceQuery(top), centers: [[100, 15, 10]] }),
          handle.shape,
          faces,
        ),
      ).toThrow(/穴が材料に当たりませんでした/);
    } finally {
      handle.delete();
    }
  });

  it('指紋が合わない(面積を 100 倍にした)ときは面が見つからないと断る', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const stale = { ...faceQuery(top), area: top.area * 100, index: 99 };
      expect(() => makeHole(oc, holeSpec({ face: stale }), handle.shape, faces)).toThrow(
        /もとの面が見つかりません/,
      );
    } finally {
      handle.delete();
    }
  });

  it('面以外(辺)の指紋も、面が見つからないと断る', () => {
    const { handle, faces } = plateWithTopFace();
    try {
      const edgeQuery: SubShapeQuery = {
        kind: 'edge',
        index: 0,
        curveKind: 'line',
        length: 40,
        position: [20, 0, 0],
        axis: [1, 0, 0],
        radius: null,
      };
      expect(() => makeHole(oc, holeSpec({ face: edgeQuery }), handle.shape, faces)).toThrow(
        /もとの面が見つかりません/,
      );
    } finally {
      handle.delete();
    }
  });

  it('円柱の側面(平らでない面)を指す指紋は断る', () => {
    // 半径 20 の円を Z へ 5 押し出した円柱。側面は surfaceKind = 'cylinder'。
    const handle = makeExtrudeSolid(oc, {
      kind: 'extrude',
      profile: [
        {
          kind: 'arc',
          center: [0, 0, 0],
          normal: [0, 0, 1],
          xAxis: [1, 0, 0],
          radius: 20,
          startAngle: 0,
          endAngle: 2 * Math.PI,
        },
      ],
      direction: [0, 0, 1],
      distance: 5,
    });
    try {
      const faces = facesOf(handle.shape);
      const side = faces.find((face) => face.surfaceKind === 'cylinder');
      expect(side).toBeDefined();
      if (side === undefined) {
        return;
      }
      expect(() => makeHole(oc, holeSpec({ face: faceQuery(side) }), handle.shape, faces)).toThrow(
        /平らな面だけです/,
      );
    } finally {
      handle.delete();
    }
  });

  it('パターン(変換つき)はタスク9 まで受け付けない', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      expect(() =>
        makeHole(
          oc,
          holeSpec({
            face: faceQuery(top),
            transforms: [
              {
                translation: [20, 0, 0],
                rotationOrigin: [0, 0, 0],
                rotationAxis: [0, 0, 1],
                rotationAngle: 0,
              },
            ],
          }),
          handle.shape,
          faces,
        ),
      ).toThrow(/パターンはまだ使えません/);
    } finally {
      handle.delete();
    }
  });

  it('makeHoleTools は貫通で 1 本、止まり穴でも 1 本の円柱を作る(長さが違う)', () => {
    const { handle, faces, top } = plateWithTopFace();
    try {
      const frame = resolveHoleFrame(oc, handle.shape, faces, holeSpec({ face: faceQuery(top) }));
      const through = makeHoleTools(oc, handle.shape, frame, 6, null, []);
      const blind = makeHoleTools(oc, handle.shape, frame, 6, 4, []);
      try {
        // 対角長 √2600 = 50.990195…、margin = 0.5099… + 1 = 1.5099…
        const diagonal = Math.hypot(PLATE.dx, PLATE.dy, PLATE.dz);
        const margin = diagonal * 0.01 + 1;
        expectVolume(measureVolume(oc, through.shape), Math.PI * 9 * (diagonal + 2 * margin));
        expectVolume(measureVolume(oc, blind.shape), Math.PI * 9 * (4 + margin));
      } finally {
        blind.delete();
        through.delete();
      }
    } finally {
      handle.delete();
    }
  });
});
