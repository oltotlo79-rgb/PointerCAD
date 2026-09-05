import { beforeAll, describe, expect, it } from 'vitest';

import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { PrimitiveStepSpec, Vec3Tuple } from '../types.js';
import { extractEdges } from './extractEdges.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import { makePrimitive } from './makePrimitive.js';
import {
  angleBetween,
  distanceBetween,
  edgeLength,
  measureMassProperties,
} from './measureShape.js';
import { measureArea } from './solidMesh.js';
import { collectSubShapes, edgeAt, faceAt, type SubShapeTables } from './subShapes.js';
import { tessellate } from './tessellate.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/** 40×30×10 の板。角が原点にあるので重心は (20, 15, 5)(手計算)。 */
const PLATE = { dx: 40, dy: 30, dz: 10 } as const;
/** 体積 40×30×10。 */
const PLATE_VOLUME = 12000;
/** 表面積 2(40·30 + 40·10 + 30·10) = 2(1200 + 400 + 300)。 */
const PLATE_AREA = 3800;

/** 面・辺・頂点の一覧(指紋の材料)。makePrimitive.test.ts と同じ組み立て方。 */
function tablesOf(oc: OpenCascadeInstance, shape: TopoDS_Shape): SubShapeTables {
  const surface = tessellate(oc, shape, {});
  const edges = extractEdges(oc, shape, {});
  return collectSubShapes(oc, shape, surface.faceRanges, edges.edgeRanges);
}

/** 中心と 1 辺の長さから、基本形状の立方体の依頼を作る。 */
function cubeSpec(centre: Vec3Tuple, size: number): PrimitiveStepSpec {
  return {
    kind: 'primitive',
    origin: centre,
    axis: [0, 0, 1],
    shape: { kind: 'box', sizeX: size, sizeY: size, sizeZ: size },
    originQuery: null,
    targetKey: null,
  };
}

describe('測定と質量特性(measureShape)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  describe('手順1: 使うクラスが実行時にも束縛されている(計画書 §1.4-15、§1.5-1)', () => {
    it('距離と主慣性のクラスが関数として存在する', () => {
      expect(oc.BRepExtrema_DistShapeShape_1).toBeTypeOf('function');
      expect(oc.GProp_PrincipalProps).toBeTypeOf('function');
      expect(oc.GProp_GProps_1).toBeTypeOf('function');
      expect(oc.gp_Ax1_2).toBeTypeOf('function');
      expect(oc.gp_Dir_2).toBeTypeOf('function');
      expect(oc.Message_ProgressRange_1).toBeTypeOf('function');
      expect(oc.BRepAdaptor_Surface_2).toBeTypeOf('function');
      expect(oc.BRepAdaptor_Curve_2).toBeTypeOf('function');
      expect(typeof oc.BRepGProp.VolumeProperties_1).toBe('function');
      expect(typeof oc.BRepGProp.LinearProperties).toBe('function');
    });

    it('out 引数の Moments からは値が返らない(§1.5-2 の実測。だから MomentOfInertia を使う)', () => {
      const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
      const properties = new oc.GProp_GProps_1();
      try {
        oc.BRepGProp.VolumeProperties_1(box.shape, properties, false, false, false);
        const principal = properties.PrincipalProperties();
        try {
          // C++ の参照渡し(Ixx, Iyy, Izz)へ JavaScript の数値を渡しても、
          // 数値は値渡しなので書き換えは呼び出し側へ返らない。戻り値も無い。
          const returned = principal.Moments(0, 0, 0);
          console.log(`GProp_PrincipalProps.Moments の戻り値: ${String(returned)}`);
          expect(returned).toBeUndefined();
        } finally {
          principal.delete();
        }
      } finally {
        properties.delete();
        box.delete();
      }
    });
  });

  describe('質量特性(FR-1101)', () => {
    it('40×30×10 の板は体積 12000 mm³・表面積 3800 mm²・重心 (20, 15, 5)', () => {
      const box = makeBox(oc, PLATE);
      try {
        const found = measureMassProperties(oc, box.shape);
        expect(found.volume).toBeCloseTo(PLATE_VOLUME, 6);
        expect(found.area).toBeCloseTo(PLATE_AREA, 6);
        expect(found.centreOfMass[0]).toBeCloseTo(20, 9);
        expect(found.centreOfMass[1]).toBeCloseTo(15, 9);
        expect(found.centreOfMass[2]).toBeCloseTo(5, 9);
      } finally {
        box.delete();
      }
    });

    it('40×30×10 の板の主軸まわりの 2 次モーメントは V(b²+c²)/12 の 3 通り', () => {
      const box = makeBox(oc, PLATE);
      try {
        const found = measureMassProperties(oc, box.shape);
        // V(b²+c²)/12: X まわり 12000(900+100)/12、Y まわり 12000(1600+100)/12、
        // Z まわり 12000(1600+900)/12(手計算)。主軸の並びは形しだいなので順不同で比べる。
        const sorted = [...found.principalMoments].sort((a, b) => a - b);
        expect(sorted[0]).toBeCloseTo(1000000, 3);
        expect(sorted[1]).toBeCloseTo(1700000, 3);
        expect(sorted[2]).toBeCloseTo(2500000, 3);
      } finally {
        box.delete();
      }
    });

    it('主軸は 3 本とも長さ 1 で、たがいに直交する', () => {
      const box = makeBox(oc, PLATE);
      try {
        const [first, second, third] = measureMassProperties(oc, box.shape).principalAxes;
        const dot = (a: Vec3Tuple, b: Vec3Tuple): number =>
          a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        expect(Math.hypot(...first)).toBeCloseTo(1, 12);
        expect(Math.hypot(...second)).toBeCloseTo(1, 12);
        expect(Math.hypot(...third)).toBeCloseTo(1, 12);
        expect(dot(first, second)).toBeCloseTo(0, 9);
        expect(dot(second, third)).toBeCloseTo(0, 9);
        expect(dot(third, first)).toBeCloseTo(0, 9);
      } finally {
        box.delete();
      }
    });

    it('20³ の箱は重心 (10, 10, 10)、2 次モーメントは 3 つとも 533333.33 mm⁵', () => {
      const box = makeBox(oc, { dx: 20, dy: 20, dz: 20 });
      try {
        const found = measureMassProperties(oc, box.shape);
        expect(found.volume).toBeCloseTo(8000, 6);
        expect(found.centreOfMass[0]).toBeCloseTo(10, 9);
        expect(found.centreOfMass[1]).toBeCloseTo(10, 9);
        expect(found.centreOfMass[2]).toBeCloseTo(10, 9);
        // V(b²+c²)/12 = 8000 × (400 + 400) / 12 = 533333.3333333333(手計算)。
        // 計画書タスク28 の検証表はこの行を 2666666.6666666665 と書いているが、
        // 同じ式(8000×800/12)からは 533333.33 にしかならない(2026-09-05 実測も同じ)。
        // 期待値を実測に合わせたのではなく、計画書の掛け算の誤りである。
        for (const moment of found.principalMoments) {
          expect(moment / 533333.3333333333).toBeCloseTo(1, 6);
        }
      } finally {
        box.delete();
      }
    });

    it('10×20×30 の箱の 2 次モーメントは 650000 / 500000 / 250000 mm⁵', () => {
      const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
      try {
        const found = measureMassProperties(oc, box.shape);
        expect(found.volume).toBeCloseTo(6000, 6);
        // 6000(400+900)/12、6000(100+900)/12、6000(100+400)/12(手計算)。
        const sorted = [...found.principalMoments].sort((a, b) => a - b);
        expect(sorted[0]).toBeCloseTo(250000, 4);
        expect(sorted[1]).toBeCloseTo(500000, 4);
        expect(sorted[2]).toBeCloseTo(650000, 4);
      } finally {
        box.delete();
      }
    });

    /**
     * **密度を引数に取る版(旧 `massProperties` / `ShapeMassProperties`)は §0.a-0.78 で
     * kernel から削除した**(タスク42b)。質量への密度の掛け算は model の
     * `measure/massProperties.ts`(`massFromVolume` / `inertiaWithDensity`)の 1 か所だけで
     * 行う決めなので、kernel が返す欄に g や g·mm² が混ざっていないことをここで固定する。
     * 削除前の期待値(12000 mm³ × 7.85e-3 = 94.2 g、1.0e6 / 1.7e6 / 2.5e6 mm⁵ × 7.85e-3 =
     * 7850 / 13345 / 19625 g·mm²)は、model 側の掛け算を通せばそのまま再現できる。
     */
    it('返る欄は幾何量だけで、質量(g)や密度の欄を持たない', () => {
      const box = makeBox(oc, PLATE);
      try {
        const found = measureMassProperties(oc, box.shape);
        expect(Object.keys(found).sort()).toEqual([
          'area',
          'centreOfMass',
          'principalAxes',
          'principalMoments',
          'volume',
        ]);
      } finally {
        box.delete();
      }
    });

    it('球 r=10 は体積 4188.79 mm³、2 次モーメントは 2/5·V·r² = 167551.6 mm⁵', () => {
      const sphere = makePrimitive(oc, {
        kind: 'primitive',
        origin: [0, 0, 0],
        axis: [0, 0, 1],
        shape: { kind: 'sphere', radius: 10 },
        originQuery: null,
        targetKey: null,
      });
      try {
        const found = measureMassProperties(oc, sphere.shape);
        // 4/3·π·1000 = 4188.790204786391、4πr² = 1256.6370614359173(手計算)。
        expect(found.volume).toBeCloseTo(4188.790204786391, 6);
        expect(found.area).toBeCloseTo(1256.6370614359173, 5);
        // 2/5·V·r² = 0.4 × (4/3)π·1000 × 100 ≒ 167551.6 mm⁵。どの軸でも同じ。
        // 期待値は倍精度に載らない桁までは書かず、式のまま持つ(no-loss-of-precision)。
        // 密度 2.70 g/cm³ を model 側で掛ければ 452.38934211693015 g·mm² になり、
        // 削除前の期待値と一致する。
        const sphereMoment = 0.4 * ((4 / 3) * Math.PI * 1000) * 100;
        for (const moment of found.principalMoments) {
          expect(moment / sphereMoment).toBeCloseTo(1, 4);
        }
      } finally {
        sphere.delete();
      }
    });

    it('円柱 r=10 h=20 は体積 πr²h、軸まわりの慣性 V·r²/2、横は V(3r²+h²)/12', () => {
      const cylinder = makePrimitive(oc, {
        kind: 'primitive',
        origin: [0, 0, 0],
        axis: [0, 0, 1],
        shape: { kind: 'cylinder', radius: 10, height: 20 },
        originQuery: null,
        targetKey: null,
      });
      try {
        const found = measureMassProperties(oc, cylinder.shape);
        // π·100·20 = 6283.185307179587、2πr² + 2πrh = 1884.9555921538758(手計算)。
        expect(found.volume).toBeCloseTo(6283.185307179587, 5);
        expect(found.area).toBeCloseTo(1884.9555921538758, 5);
        // 底面の中心が原点なので重心は (0, 0, 10)(§0.a-0.17)。
        expect(found.centreOfMass[0]).toBeCloseTo(0, 8);
        expect(found.centreOfMass[1]).toBeCloseTo(0, 8);
        expect(found.centreOfMass[2]).toBeCloseTo(10, 8);
        // V·r²/2 = 314159.26535897935、V(3r²+h²)/12 = 366519.1429188091(手計算)。
        const sorted = [...found.principalMoments].sort((a, b) => a - b);
        expect(sorted[0] / 314159.26535897935).toBeCloseTo(1, 4);
        expect(sorted[1] / 366519.1429188091).toBeCloseTo(1, 4);
        expect(sorted[2] / 366519.1429188091).toBeCloseTo(1, 4);
      } finally {
        cylinder.delete();
      }
    });
  });

  describe('最短距離(FR-1102)', () => {
    it('5 mm 離した 2 つの立方体の最短距離は 5 mm で、最近点は向かい合う面の上にある', () => {
      const near = makePrimitive(oc, cubeSpec([0, 0, 0], 10));
      const far = makePrimitive(oc, cubeSpec([15, 0, 0], 10));
      try {
        const found = distanceBetween(oc, near.shape, far.shape);
        // 1 辺 10 の立方体を中心どうし 15 mm 離すと、面の間は 15 − 10 = 5 mm(手計算)。
        expect(found.distance).toBeCloseTo(5, 6);
        expect(found.inner).toBe(false);
        expect(found.pointA[0]).toBeCloseTo(5, 6);
        expect(found.pointB[0]).toBeCloseTo(10, 6);
        expect(Math.hypot(
          found.pointB[0] - found.pointA[0],
          found.pointB[1] - found.pointA[1],
          found.pointB[2] - found.pointA[2],
        )).toBeCloseTo(5, 6);
      } finally {
        far.delete();
        near.delete();
      }
    });

    it('交わっている 2 つの立方体の最短距離は 0', () => {
      const first = makePrimitive(oc, cubeSpec([0, 0, 0], 10));
      const second = makePrimitive(oc, cubeSpec([5, 0, 0], 10));
      try {
        const found = distanceBetween(oc, first.shape, second.shape);
        expect(found.distance).toBeCloseTo(0, 6);
        // 2026-09-05 実測: 交わっていても InnerSolution() は false になる。
        // 一方が完全に他方の内側にあるときのための札で、面どうしが交わっている形では
        // 距離 0 の解が普通に見つかるため立たない(計画書 §2.10.3 の
        // 「交わっている 2 つの箱は InnerSolution() が true」は成り立たない)。
        // 表示は距離 0 で足りるので、この札には頼らない。
        console.log(`交わっている立方体の InnerSolution: ${String(found.inner)}`);
        expect(found.inner).toBe(false);
      } finally {
        second.delete();
        first.delete();
      }
    });

    it('同じ板の向かい合う 2 面の距離は板の厚み 10 mm', () => {
      const box = makeBox(oc, PLATE);
      try {
        const tables = tablesOf(oc, box.shape);
        const flat = tables.faces.filter((face) => Math.abs(face.area - 1200) < 1e-6);
        expect(flat).toHaveLength(2);
        const lower = faceAt(oc, box.shape, flat[0].index);
        const upper = faceAt(oc, box.shape, flat[1].index);
        expect(lower).not.toBeNull();
        expect(upper).not.toBeNull();
        if (lower === null || upper === null) {
          return;
        }
        try {
          expect(distanceBetween(oc, lower, upper).distance).toBeCloseTo(10, 6);
        } finally {
          upper.delete();
          lower.delete();
        }
      } finally {
        box.delete();
      }
    });

    it('距離 1 回の所要を実測して記録する(目標 100ms 未満、NFR-PF-4)', () => {
      const near = makePrimitive(oc, cubeSpec([0, 0, 0], 10));
      const far = makePrimitive(oc, cubeSpec([15, 0, 0], 10));
      try {
        // 1 回目は OCCT の内部の準備を含むので、2 回目以降の平均も出す。
        const startedAt = performance.now();
        distanceBetween(oc, near.shape, far.shape);
        const firstMs = performance.now() - startedAt;
        const repeatStartedAt = performance.now();
        for (let index = 0; index < 5; index += 1) {
          distanceBetween(oc, near.shape, far.shape);
        }
        const averageMs = (performance.now() - repeatStartedAt) / 5;
        console.log(
          `立方体どうしの最短距離: 初回 ${firstMs.toFixed(1)} ms / 平均 ${averageMs.toFixed(1)} ms`,
        );
        expect(firstMs).toBeGreaterThan(0);
      } finally {
        far.delete();
        near.delete();
      }
    });
  });

  describe('辺の長さと面の面積(FR-1102)', () => {
    it('40×30×10 の板の 12 本の辺は 40 / 30 / 10 が 4 本ずつ', () => {
      const box = makeBox(oc, PLATE);
      try {
        const tables = tablesOf(oc, box.shape);
        expect(tables.edges).toHaveLength(12);
        const lengths: number[] = [];
        for (const edge of tables.edges) {
          const shape = edgeAt(oc, box.shape, edge.index);
          expect(shape).not.toBeNull();
          if (shape === null) {
            continue;
          }
          try {
            lengths.push(edgeLength(oc, shape));
          } finally {
            shape.delete();
          }
        }
        expect(lengths.filter((value) => Math.abs(value - 40) < 1e-9)).toHaveLength(4);
        expect(lengths.filter((value) => Math.abs(value - 30) < 1e-9)).toHaveLength(4);
        expect(lengths.filter((value) => Math.abs(value - 10) < 1e-9)).toHaveLength(4);
      } finally {
        box.delete();
      }
    });

    it('板の広い面の面積は 1200 mm²(面積は solidMesh.ts の measureArea が正本)', () => {
      const box = makeBox(oc, PLATE);
      try {
        const tables = tablesOf(oc, box.shape);
        const widest = [...tables.faces].sort((a, b) => b.area - a.area)[0];
        const face = faceAt(oc, box.shape, widest.index);
        expect(face).not.toBeNull();
        if (face === null) {
          return;
        }
        try {
          expect(measureArea(oc, face)).toBeCloseTo(1200, 9);
        } finally {
          face.delete();
        }
      } finally {
        box.delete();
      }
    });
  });

  describe('なす角(FR-1102)', () => {
    it('隣り合う 2 面は 90 度、向かい合う 2 面は 0 度', () => {
      const box = makeBox(oc, PLATE);
      try {
        const tables = tablesOf(oc, box.shape);
        const wide = tables.faces.filter((face) => Math.abs(face.area - 1200) < 1e-6);
        const side = tables.faces.filter((face) => Math.abs(face.area - 400) < 1e-6);
        expect(wide).toHaveLength(2);
        expect(side.length).toBeGreaterThan(0);
        const first = faceAt(oc, box.shape, wide[0].index);
        const second = faceAt(oc, box.shape, wide[1].index);
        const neighbour = faceAt(oc, box.shape, side[0].index);
        if (first === null || second === null || neighbour === null) {
          throw new Error('面を取り出せませんでした');
        }
        try {
          expect(angleBetween(oc, first, neighbour)).toBeCloseTo(90, 9);
          expect(angleBetween(oc, first, second)).toBeCloseTo(0, 9);
        } finally {
          neighbour.delete();
          second.delete();
          first.delete();
        }
      } finally {
        box.delete();
      }
    });

    it('直交する 2 本の辺は 90 度、平行な 2 本は 0 度', () => {
      const box = makeBox(oc, PLATE);
      try {
        const tables = tablesOf(oc, box.shape);
        const long = tables.edges.filter((edge) => Math.abs(edge.length - 40) < 1e-9);
        const short = tables.edges.filter((edge) => Math.abs(edge.length - 30) < 1e-9);
        const alongX = edgeAt(oc, box.shape, long[0].index);
        const alongXAgain = edgeAt(oc, box.shape, long[1].index);
        const alongY = edgeAt(oc, box.shape, short[0].index);
        if (alongX === null || alongXAgain === null || alongY === null) {
          throw new Error('辺を取り出せませんでした');
        }
        try {
          expect(angleBetween(oc, alongX, alongY)).toBeCloseTo(90, 9);
          expect(angleBetween(oc, alongX, alongXAgain)).toBeCloseTo(0, 9);
        } finally {
          alongY.delete();
          alongXAgain.delete();
          alongX.delete();
        }
      } finally {
        box.delete();
      }
    });

    it('曲面や立体が混じる組み合わせでは角度を返さない(null)', () => {
      const cylinder = makePrimitive(oc, {
        kind: 'primitive',
        origin: [0, 0, 0],
        axis: [0, 0, 1],
        shape: { kind: 'cylinder', radius: 10, height: 20 },
        originQuery: null,
        targetKey: null,
      });
      try {
        const tables = tablesOf(oc, cylinder.shape);
        const curved = tables.faces.filter((face) => face.surfaceKind === 'cylinder');
        const flat = tables.faces.filter((face) => face.surfaceKind === 'plane');
        expect(curved.length).toBeGreaterThan(0);
        expect(flat.length).toBeGreaterThan(0);
        const round = faceAt(oc, cylinder.shape, curved[0].index);
        const plane = faceAt(oc, cylinder.shape, flat[0].index);
        if (round === null || plane === null) {
          throw new Error('面を取り出せませんでした');
        }
        try {
          expect(angleBetween(oc, round, plane)).toBeNull();
          // 立体そのものにも向きが無いので測れない。
          expect(angleBetween(oc, cylinder.shape, plane)).toBeNull();
        } finally {
          plane.delete();
          round.delete();
        }
      } finally {
        cylinder.delete();
      }
    });
  });
});
