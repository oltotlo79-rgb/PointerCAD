import { beforeAll, describe, expect, it } from 'vitest';

import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import type { PlacementSpec, QuaternionTuple, Vec3Tuple } from '../types.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import {
  IDENTITY_PLACEMENT,
  boundingBoxOf,
  boundingBoxRange,
  boundingBoxesOverlap,
  makePlacementTransform,
  placeShape,
  transformedBoundingBox,
  type BoundingBoxRange,
} from './placeBodies.js';
import { measureVolume } from './solidMesh.js';

type Occt = Awaited<ReturnType<typeof loadOcctForNode>>;

/** 計画書 タスク8 の検証表が使う箱。20³、原点が角。 */
const CUBE = { dx: 20, dy: 20, dz: 20 } as const;

/** Z 軸まわり 90°。`q = (0, 0, sin45°, cos45°)`(§2.4 の検算)。 */
const TURN_Z_90: QuaternionTuple = [0, 0, Math.SQRT1_2, Math.SQRT1_2];

function placement(overrides: Partial<PlacementSpec>): PlacementSpec {
  return { ...IDENTITY_PLACEMENT, ...overrides };
}

function expectTuple(actual: Vec3Tuple, expected: Vec3Tuple, digits = 9): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
  expect(actual[2]).toBeCloseTo(expected[2], digits);
}

/**
 * 配置を点へ掛ける式(§2.4 の `p' = R(q)·p + t`)を、OCCT を使わずに書いたもの。
 *
 * model の `assembly/placementMath.ts` の `applyPlacementToPoint` と同じ式で、
 * kernel は model を輸入できない(依存方向は model → kernel。`rules/04`)ので、
 * **突き合わせのためにここへ同じ式を書いてある**。「OCCT の順序が式と一致するか」
 * (§1.5-4)を確かめるのがこの検査の目的なので、比べる相手は式そのものでなければならない。
 */
function applyPlacementByFormula(spec: PlacementSpec, point: Vec3Tuple): Vec3Tuple {
  const size = Math.hypot(spec.rotation[0], spec.rotation[1], spec.rotation[2], spec.rotation[3]);
  const [x, y, z, w] = spec.rotation.map((value) => value / size);
  const [px, py, pz] = point;
  return [
    (1 - 2 * (y * y + z * z)) * px +
      2 * (x * y - w * z) * py +
      2 * (x * z + w * y) * pz +
      spec.position[0],
    2 * (x * y + w * z) * px +
      (1 - 2 * (x * x + z * z)) * py +
      2 * (y * z - w * x) * pz +
      spec.position[1],
    2 * (x * z - w * y) * px +
      2 * (y * z + w * x) * py +
      (1 - 2 * (x * x + y * y)) * pz +
      spec.position[2],
  ];
}

/** 形の中の面・辺・頂点の数を数える(`subShapes.ts` と同じ MapShapes_2 の並び)。 */
function countSubShapes(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
): { faces: number; edges: number; vertices: number } {
  const { keep, release } = createAllocations();
  try {
    const map = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
    const edgeType = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
    const vertexType = oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
    let faces = 0;
    let edges = 0;
    let vertices = 0;
    for (let position = 1; position <= map.Size(); position += 1) {
      const subShape = keep(map.FindKey(position));
      const shapeType = subShape.ShapeType();
      if (shapeType === faceType) {
        faces += 1;
      } else if (shapeType === edgeType) {
        edges += 1;
      } else if (shapeType === vertexType) {
        vertices += 1;
      }
    }
    return { faces, edges, vertices };
  } finally {
    release();
  }
}

/** 形の頂点の座標を、X → Y → Z の順に並べて返す(並びを決めて突き合わせるため)。 */
function vertexPoints(oc: OpenCascadeInstance, shape: TopoDS_Shape): Vec3Tuple[] {
  const { keep, release } = createAllocations();
  try {
    const map = keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, map, true, true);
    const vertexType = oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
    const points: Vec3Tuple[] = [];
    for (let position = 1; position <= map.Size(); position += 1) {
      const subShape = keep(map.FindKey(position));
      if (subShape.ShapeType() !== vertexType) {
        continue;
      }
      const vertex = keep(oc.TopoDS.Vertex_1(subShape));
      const point = keep(oc.BRep_Tool.Pnt(vertex));
      points.push([point.X(), point.Y(), point.Z()]);
    }
    return points.sort(
      (left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2],
    );
  } finally {
    release();
  }
}

/** 形の境界箱を数で読む(作った箱はその場で返す)。 */
function rangeOf(oc: OpenCascadeInstance, shape: TopoDS_Shape): BoundingBoxRange {
  const handle = boundingBoxOf(oc, shape);
  try {
    return boundingBoxRange(handle.box);
  } finally {
    handle.delete();
  }
}

describe('配置つきの立体の組み立てと境界箱(FR-601、FR-615)', () => {
  let oc: Occt;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  describe('手順1: 実行時の実測(§1.5-1、§1.5-2、§1.5-4)', () => {
    it('§1.5-2: 使うクラスが実行時にも束縛されている', () => {
      expect(oc.gp_Trsf_1).toBeTypeOf('function');
      expect(oc.gp_Quaternion_2).toBeTypeOf('function');
      expect(oc.gp_Quaternion_5).toBeTypeOf('function');
      expect(oc.Bnd_Box_1).toBeTypeOf('function');
      expect(oc.BRepBndLib).toBeTypeOf('function');
      expect(oc.TopLoc_Location_2).toBeTypeOf('function');
      expect(oc.gp_Vec_4).toBeTypeOf('function');
    });

    it('§1.5-1: 作った Bnd_Box を BRepBndLib.Add へ渡すと、角が更新された値で返る', () => {
      const handle = makeBox(oc, CUBE);
      try {
        const { keep, release } = createAllocations();
        try {
          const box = keep(new oc.Bnd_Box_1());
          // Add の前は「中身が無い箱」で、角を読むこともできない。
          expect(box.IsVoid()).toBe(true);
          oc.BRepBndLib.Add(handle.shape, box, false);
          box.SetGap(0);
          expect(box.IsVoid()).toBe(false);
          const low = keep(box.CornerMin());
          const high = keep(box.CornerMax());
          // out の入れ物として渡した箱が、JS 側で読める値に更新されている。
          expectTuple([low.X(), low.Y(), low.Z()], [0, 0, 0]);
          expectTuple([high.X(), high.Y(), high.Z()], [20, 20, 20]);
        } finally {
          release();
        }
      } finally {
        handle.delete();
      }
    });

    it('§1.5-4: SetRotation_2 + SetTranslationPart は「回してから移す」', () => {
      const spec = placement({ position: [10, 0, 0], rotation: TURN_Z_90 });
      const handle = makeBox(oc, CUBE);
      try {
        const placed = placeShape(oc, handle.shape, spec);
        try {
          // 20³ の箱の 8 頂点は (x, y, z ∈ {0, 20})。回してから移すなら (x, y) → (−y + 10, x)、
          // 先に移してから回すなら (x, y) → (−y, x + 10) になり、X の値で見分けられる。
          const expected: Vec3Tuple[] = [];
          for (const x of [0, 20]) {
            for (const y of [0, 20]) {
              for (const z of [0, 20]) {
                expected.push(applyPlacementByFormula(spec, [x, y, z]));
              }
            }
          }
          expected.sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);

          const actual = vertexPoints(oc, placed.shape);
          expect(actual).toHaveLength(8);
          for (const [index, point] of actual.entries()) {
            expectTuple(point, expected[index]);
          }
          // 実測値そのものを残す(§1.5-4 の報告用)。統括はこの並びを model の
          // applyPlacementToPoint の出力と突き合わせられる。
          console.log(
            `§1.5-4 の実測(20³ を Z 90° 回して (10,0,0) へ): ${actual
              .map((point) => `(${point.map((value) => value.toFixed(12)).join(', ')})`)
              .join(' ')}`,
          );
          // 式で出した値そのもの(報告用に読める形で 1 つ固定する)。
          // 「回してから移す」なら X は 10 と −10 の 2 通りしか出ない。
          expect([...new Set(actual.map((point) => Math.round(point[0])))].sort((a, b) => a - b)).toEqual([
            -10, 10,
          ]);
        } finally {
          placed.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('§1.5-4: 配置を掛けた頂点は、§2.4 の式(model の applyPlacementToPoint と同じ)と一致する', () => {
      // 軸も角も中途半端な配置で、90° の倍数だけで合っているのではないことを確かめる。
      const spec = placement({
        position: [3, -7, 11],
        rotation: [0.2, -0.3, 0.5, 0.7],
      });
      const handle = makeBox(oc, CUBE);
      try {
        const placed = placeShape(oc, handle.shape, spec);
        try {
          const expected: Vec3Tuple[] = [];
          for (const x of [0, 20]) {
            for (const y of [0, 20]) {
              for (const z of [0, 20]) {
                expected.push(applyPlacementByFormula(spec, [x, y, z]));
              }
            }
          }
          expected.sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);
          const actual = vertexPoints(oc, placed.shape);
          for (const [index, point] of actual.entries()) {
            expectTuple(point, expected[index]);
          }
        } finally {
          placed.delete();
        }
      } finally {
        handle.delete();
      }
    });
  });

  describe('検証表', () => {
    it('20³ の箱を (10,0,0) へ移した境界箱は min=(10,0,0)・max=(30,20,20)', () => {
      const handle = makeBox(oc, CUBE);
      try {
        const placed = placeShape(oc, handle.shape, placement({ position: [10, 0, 0] }));
        try {
          const range = rangeOf(oc, placed.shape);
          expectTuple(range.min, [10, 0, 0]);
          expectTuple(range.max, [30, 20, 20]);
        } finally {
          placed.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('境界箱そのものを移しても、置いた形から測った箱と同じになる', () => {
      const spec = placement({ position: [10, 0, 0] });
      const handle = makeBox(oc, CUBE);
      try {
        const box = boundingBoxOf(oc, handle.shape);
        try {
          const moved = transformedBoundingBox(oc, box.box, spec);
          try {
            const range = boundingBoxRange(moved.box);
            expectTuple(range.min, [10, 0, 0]);
            expectTuple(range.max, [30, 20, 20]);
          } finally {
            moved.delete();
          }
        } finally {
          box.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('20³ の箱(原点が角)を Z 90° 回した境界箱は min=(−20,0,0)・max=(0,20,20)', () => {
      const handle = makeBox(oc, CUBE);
      try {
        const placed = placeShape(oc, handle.shape, placement({ rotation: TURN_Z_90 }));
        try {
          // (x, y) → (−y, x)。x ∈ [0,20]・y ∈ [0,20] なので X は [−20, 0] へ移る。
          const range = rangeOf(oc, placed.shape);
          expectTuple(range.min, [-20, 0, 0]);
          expectTuple(range.max, [0, 20, 20]);
        } finally {
          placed.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('配置を掛けても体積が変わらない(剛体変換)', () => {
      const handle = makeBox(oc, CUBE);
      try {
        const placed = placeShape(
          oc,
          handle.shape,
          placement({ position: [10, -5, 3], rotation: TURN_Z_90 }),
        );
        try {
          expect(measureVolume(oc, placed.shape)).toBeCloseTo(8000, 9);
          expect(measureVolume(oc, handle.shape)).toBeCloseTo(8000, 9);
        } finally {
          placed.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('恒等の配置では形が同じ(体積・面数・辺数・頂点数が一致)', () => {
      const handle = makeBox(oc, CUBE);
      try {
        const placed = placeShape(oc, handle.shape, IDENTITY_PLACEMENT);
        try {
          expect(measureVolume(oc, placed.shape)).toBeCloseTo(measureVolume(oc, handle.shape), 9);
          expect(countSubShapes(oc, placed.shape)).toEqual(countSubShapes(oc, handle.shape));
          expect(countSubShapes(oc, placed.shape)).toEqual({ faces: 6, edges: 12, vertices: 8 });
          const placedRange = rangeOf(oc, placed.shape);
          expectTuple(placedRange.min, [0, 0, 0]);
          expectTuple(placedRange.max, [20, 20, 20]);
        } finally {
          placed.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('配置を掛けても元の形は変わらない(元の境界箱が同じ)', () => {
      const handle = makeBox(oc, CUBE);
      try {
        const before = rangeOf(oc, handle.shape);
        const placed = placeShape(
          oc,
          handle.shape,
          placement({ position: [100, 200, 300], rotation: TURN_Z_90 }),
        );
        try {
          const after = rangeOf(oc, handle.shape);
          expectTuple(after.min, before.min);
          expectTuple(after.max, before.max);
          expectTuple(after.min, [0, 0, 0]);
          expectTuple(after.max, [20, 20, 20]);
        } finally {
          placed.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('2 つの箱(中心距離 30、半分の大きさ 20)の境界箱は重なる', () => {
      // 計画書の導出「30 < 20 + 20」は**半分の大きさ 20**(= 一辺 40)の箱の条件なので、
      // 一辺 40 の箱で測る(検証表の「一辺 20」との差は統括へ報告した)。
      const handle = makeBox(oc, { dx: 40, dy: 40, dz: 40 });
      try {
        const first = boundingBoxOf(oc, handle.shape);
        try {
          const second = transformedBoundingBox(oc, first.box, placement({ position: [30, 0, 0] }));
          try {
            expect(boundingBoxesOverlap(first.box, second.box)).toBe(true);
            expect(first.box.IsOut_4(second.box)).toBe(false);
          } finally {
            second.delete();
          }
        } finally {
          first.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('2 つの箱(中心距離 50、半分の大きさ 20)の境界箱は重ならない', () => {
      const handle = makeBox(oc, { dx: 40, dy: 40, dz: 40 });
      try {
        const first = boundingBoxOf(oc, handle.shape);
        try {
          const second = transformedBoundingBox(oc, first.box, placement({ position: [50, 0, 0] }));
          try {
            expect(boundingBoxesOverlap(first.box, second.box)).toBe(false);
            expect(first.box.IsOut_4(second.box)).toBe(true);
          } finally {
            second.delete();
          }
        } finally {
          first.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('一辺 20 の箱どうしなら、中心距離 30 では重ならない(半分の大きさ 10 + 10 < 30)', () => {
      const handle = makeBox(oc, CUBE);
      try {
        const first = boundingBoxOf(oc, handle.shape);
        try {
          const second = transformedBoundingBox(oc, first.box, placement({ position: [30, 0, 0] }));
          try {
            expect(boundingBoxesOverlap(first.box, second.box)).toBe(false);
          } finally {
            second.delete();
          }
        } finally {
          first.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('確保の解放: delete() のあとは OCCT の実体が残らない', () => {
      const handle = makeBox(oc, CUBE);
      try {
        const placed = placeShape(oc, handle.shape, placement({ position: [1, 2, 3] }));
        expect(placed.shape.IsNull()).toBe(false);
        placed.delete();
        // 解放済みの実体へ触ると embind が断る(= 確かに delete() された)。
        expect(() => placed.shape.IsNull()).toThrow();
        // 2 度目の delete() は何もしない(createAllocations が控えを空にする)。
        expect(() => {
          placed.delete();
        }).not.toThrow();
        // もとの形は生きている(引数には触れない)。
        expect(handle.shape.IsNull()).toBe(false);
      } finally {
        handle.delete();
      }
    });
  });

  describe('断りと数の扱い', () => {
    it('位置や向きに数でない値が混ざっていたら断る', () => {
      const handle = makeBox(oc, CUBE);
      try {
        expect(() => placeShape(oc, handle.shape, placement({ position: [Number.NaN, 0, 0] }))).toThrow(
          /数になっていません/,
        );
        expect(() =>
          placeShape(oc, handle.shape, placement({ rotation: [0, 0, 0, Number.POSITIVE_INFINITY] })),
        ).toThrow(/数になっていません/);
      } finally {
        handle.delete();
      }
    });

    it('長さ 0 の向きは断る(0 で割らない)', () => {
      const handle = makeBox(oc, CUBE);
      try {
        expect(() => placeShape(oc, handle.shape, placement({ rotation: [0, 0, 0, 0] }))).toThrow(
          /向きが決まりません/,
        );
      } finally {
        handle.delete();
      }
    });

    it('長さが 1 でない向きでも、長さ 1 へ揃えて同じ形になる', () => {
      const handle = makeBox(oc, CUBE);
      try {
        // TURN_Z_90 を 3 倍しただけの値。回転としては同じもの。
        const scaled = placeShape(
          oc,
          handle.shape,
          placement({ rotation: [0, 0, 3 * Math.SQRT1_2, 3 * Math.SQRT1_2] }),
        );
        try {
          const range = rangeOf(oc, scaled.shape);
          expectTuple(range.min, [-20, 0, 0]);
          expectTuple(range.max, [0, 20, 20]);
          expect(measureVolume(oc, scaled.shape)).toBeCloseTo(8000, 9);
        } finally {
          scaled.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('符号を反転した向き(−q)は同じ形を作る', () => {
      const handle = makeBox(oc, CUBE);
      try {
        const negated = placeShape(
          oc,
          handle.shape,
          placement({ rotation: [0, 0, -Math.SQRT1_2, -Math.SQRT1_2] }),
        );
        try {
          const range = rangeOf(oc, negated.shape);
          expectTuple(range.min, [-20, 0, 0]);
          expectTuple(range.max, [0, 20, 20]);
        } finally {
          negated.delete();
        }
      } finally {
        handle.delete();
      }
    });

    it('中身の無い境界箱から角を読もうとしたら断る', () => {
      const { keep, release } = createAllocations();
      try {
        const box = keep(new oc.Bnd_Box_1());
        expect(() => boundingBoxRange(box)).toThrow(/大きさが取れません/);
      } finally {
        release();
      }
    });

    it('makePlacementTransform は控えへ積むので、呼び出し側の release で解放できる', () => {
      const { keep, release } = createAllocations();
      const trsf = makePlacementTransform(oc, placement({ position: [1, 2, 3] }), keep);
      const part = trsf.TranslationPart();
      try {
        // SetTranslationPart で入れた t が、そのまま平行移動の欄に入っている。
        expectTuple([part.X(), part.Y(), part.Z()], [1, 2, 3]);
      } finally {
        part.delete();
      }
      release();
      expect(() => trsf.TranslationPart()).toThrow();
    });
  });

  describe('実測(報告用。上限の判定はしない)', () => {
    it('同じ形を 50 個置いて境界箱まで出す所要を記録する', () => {
      const handle = makeBox(oc, CUBE);
      try {
        const box = boundingBoxOf(oc, handle.shape);
        try {
          const startedAt = performance.now();
          for (let index = 0; index < 50; index += 1) {
            const spec = placement({ position: [index * 30, 0, 0], rotation: TURN_Z_90 });
            const placed = placeShape(oc, handle.shape, spec);
            const moved = transformedBoundingBox(oc, box.box, spec);
            try {
              expect(placed.shape.IsNull()).toBe(false);
              expect(moved.box.IsVoid()).toBe(false);
            } finally {
              moved.delete();
              placed.delete();
            }
          }
          const elapsedMs = performance.now() - startedAt;
          // 数そのものは環境差が大きいので上限の判定はしない(統括への報告用)。
          console.log(`50 個の配置 + 境界箱: ${elapsedMs.toFixed(1)} ms`);
          expect(elapsedMs).toBeGreaterThan(0);
        } finally {
          box.delete();
        }
      } finally {
        handle.delete();
      }
    });
  });
});
