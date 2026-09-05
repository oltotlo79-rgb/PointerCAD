/**
 * 面の走査の高速化が出力を 1 ビットも変えないことの検査(P6 タスク11b)。
 *
 * `tessellate.ts` は節点 1 個ごとに `Node(i)` → `Transformed(transformation)` →
 * `delete()` × 2 と embind をまたいでいたのを、位置(`TopLoc_Location`)の中身を
 * 面 1 枚につき 1 回だけ読み出して JS 側で掛ける形へ変えた。**画面用のキャッシュも
 * 当たり判定も面ごとの範囲表も、いまの数値にそのまま乗っている**ので、速くなった
 * 代わりに 1 ビットでもずれてはいけない。
 *
 * そこでこのファイルは**変える前の走査をそのまま写した `walkLegacy` を持ち**、
 * 位置(位置なし・平行移動だけ・回転つき)と面の向き(順・逆)を変えた形について、
 * 位置・法線・添字・面ごとの範囲表を `Object.is` で 1 個ずつ突き合わせる。
 * 写しがあると二重管理になるが、**比較の相手が無ければ「変えていない」ことを
 * 示せない**ので、この 1 か所だけは意図して残す。
 */

import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_ANGULAR_DEFLECTION, DEFAULT_LINEAR_DEFLECTION } from '../types.js';
import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeBox } from './makeBox.js';
import { makePrimitive } from './makePrimitive.js';
import type { FaceTriangleRange, SurfaceMesh } from './tessellate.js';
import { tessellate } from './tessellate.js';
import { makeCompound } from './transformShape.js';
import type { PrimitiveShapeSpec, PrimitiveStepSpec } from '../types.js';

/** 走査 1 回ぶんの結果と、内訳の所要(ミリ秒)。 */
interface WalkResult {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint32Array;
  readonly faceRanges: readonly FaceTriangleRange[];
  readonly nodeMs: number;
  readonly normalMs: number;
  readonly indexMs: number;
  readonly totalMs: number;
}

/**
 * 変える前の走査(2026-09-06 以前の `tessellate.ts` の写し)。
 *
 * **`BRepMesh` は掛けない。** 呼び出し側が先に `tessellate` を通して三角形分割を
 * 付けておく約束で、こうすると「走査だけ」の所要が測れる(内訳も返す)。
 */
function walkLegacy(oc: OpenCascadeInstance, shape: TopoDS_Shape): WalkResult {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const faceRanges: FaceTriangleRange[] = [];
  let nodeMs = 0;
  let normalMs = 0;
  let indexMs = 0;
  const startedAt = performance.now();

  const shared = createAllocations();
  try {
    const subShapes = shared.keep(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_2(shape, subShapes, true, true);
    const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
    const subShapeCount = subShapes.Size();

    for (let subShapeIndex = 1; subShapeIndex <= subShapeCount; subShapeIndex += 1) {
      const subShape = subShapes.FindKey(subShapeIndex);
      if (subShape.ShapeType() !== faceType) {
        continue;
      }
      const triangleOffset = indices.length / 3;
      const perFace = createAllocations();
      try {
        const face = perFace.keep(oc.TopoDS.Face_1(subShape));
        const location = perFace.keep(new oc.TopLoc_Location_1());
        const triangulationHandle = perFace.keep(oc.BRep_Tool.Triangulation(face, location, 0));
        if (!triangulationHandle.IsNull()) {
          const inner = createAllocations();
          try {
            const triangulation = triangulationHandle.get();
            const nodeCount = Number(triangulation.NbNodes());
            const nodeOffset = positions.length / 3;
            const transformation = inner.keep(location.Transformation());

            let phaseStart = performance.now();
            for (let i = 1; i <= nodeCount; i += 1) {
              const node = triangulation.Node(i);
              const moved = node.Transformed(transformation);
              positions.push(moved.X(), moved.Y(), moved.Z());
              node.delete();
              moved.delete();
            }
            nodeMs += performance.now() - phaseStart;

            phaseStart = performance.now();
            const polyConnect = inner.keep(new oc.Poly_Connect_2(triangulationHandle));
            const nodeNormals = inner.keep(new oc.TColgp_Array1OfDir_2(1, nodeCount));
            oc.StdPrs_ToolTriangulatedShape.Normal(face, polyConnect, nodeNormals);
            for (let i = nodeNormals.Lower(); i <= nodeNormals.Upper(); i += 1) {
              const direction = nodeNormals.Value(i);
              const moved = direction.Transformed(transformation);
              normals.push(moved.X(), moved.Y(), moved.Z());
              direction.delete();
              moved.delete();
            }
            normalMs += performance.now() - phaseStart;

            phaseStart = performance.now();
            const reversed = face.Orientation_1() !== oc.TopAbs_Orientation.TopAbs_FORWARD;
            const triangles = inner.keep(triangulation.Triangles());
            const triangleCount = Number(triangulation.NbTriangles());
            for (let i = 1; i <= triangleCount; i += 1) {
              const triangle = triangles.Value(i);
              const a = nodeOffset + triangle.Value(1) - 1;
              const b = nodeOffset + triangle.Value(2) - 1;
              const c = nodeOffset + triangle.Value(3) - 1;
              if (reversed) {
                indices.push(b, a, c);
              } else {
                indices.push(a, b, c);
              }
              triangle.delete();
            }
            indexMs += performance.now() - phaseStart;
          } finally {
            inner.release();
          }
        }
      } finally {
        perFace.release();
      }
      faceRanges.push({
        triangleOffset,
        triangleCount: indices.length / 3 - triangleOffset,
      });
    }
  } finally {
    shared.release();
  }

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    faceRanges,
    nodeMs,
    normalMs,
    indexMs,
    totalMs: performance.now() - startedAt,
  };
}

/**
 * 変える前と変えたあとで、面ごとの範囲表・位置・法線・添字が完全に一致することを確かめる。
 *
 * `toEqual` ではなく `Object.is` を 1 個ずつ回すのは、Float32Array の 1 要素でも
 * 違えば**どこが何個違うかを数えて報告できる**ようにするため(`toEqual` は
 * 10 万個の配列が食い違ったときに読めない差分を出す)。
 */
function expectSameMesh(fresh: SurfaceMesh, legacy: WalkResult): void {
  expect(fresh.faceRanges.map((range) => range.triangleOffset)).toEqual(
    legacy.faceRanges.map((range) => range.triangleOffset),
  );
  expect(fresh.faceRanges.map((range) => range.triangleCount)).toEqual(
    legacy.faceRanges.map((range) => range.triangleCount),
  );
  expect(fresh.positions.length).toBe(legacy.positions.length);
  expect(fresh.normals.length).toBe(legacy.normals.length);
  expect(fresh.indices.length).toBe(legacy.indices.length);

  let positionDiff = 0;
  let normalDiff = 0;
  for (let i = 0; i < legacy.positions.length; i += 1) {
    if (!Object.is(fresh.positions[i], legacy.positions[i])) {
      positionDiff += 1;
    }
    if (!Object.is(fresh.normals[i], legacy.normals[i])) {
      normalDiff += 1;
    }
  }
  let indexDiff = 0;
  for (let i = 0; i < legacy.indices.length; i += 1) {
    if (fresh.indices[i] !== legacy.indices[i]) {
      indexDiff += 1;
    }
  }
  expect({ positionDiff, normalDiff, indexDiff }).toEqual({
    positionDiff: 0,
    normalDiff: 0,
    indexDiff: 0,
  });
}

/** 基本形状の段の依頼を 1 つ作る(検査では形と位置しか使わない)。 */
function primitiveAt(shape: PrimitiveShapeSpec, x = 0): PrimitiveStepSpec {
  return {
    kind: 'primitive',
    origin: [x, 0, 0],
    axis: [0, 0, 1],
    shape,
    originQuery: null,
    targetKey: null,
  };
}

describe('面の走査の高速化(P6 タスク11b、出力は 1 ビットも変えない)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /**
   * 形へ位置(`TopLoc_Location`)を貼った複製を作る。
   *
   * `transformShape` は下地の幾何ごと作り直すので位置が残らない。**位置つきの面**
   * (`location.IsIdentity()` が偽になる面)を作らないと、平行移動だけの道と
   * 回転つきの道が 1 度も通らないため、ここでは `TopoDS_Shape.Moved` を直に使う。
   */
  function movedShape(
    shape: TopoDS_Shape,
    translation: readonly [number, number, number],
    rotationAngle: number,
  ): OcctShapeHandle {
    const { keep, release } = createAllocations();
    try {
      const trsf = keep(new oc.gp_Trsf_1());
      const vector = keep(new oc.gp_Vec_4(translation[0], translation[1], translation[2]));
      trsf.SetTranslation_1(vector);
      if (rotationAngle !== 0) {
        const turned = keep(new oc.gp_Trsf_1());
        const origin = keep(new oc.gp_Pnt_3(0, 0, 0));
        const direction = keep(new oc.gp_Dir_4(1, 2, 3));
        turned.SetRotation_1(keep(new oc.gp_Ax1_2(origin, direction)), rotationAngle);
        // 回転 → 平行移動(transformShape.ts の makeTransform と同じ順序)。
        const composed = keep(trsf.Multiplied(turned));
        const location = keep(new oc.TopLoc_Location_2(composed));
        return { shape: keep(shape.Moved(location, true)), delete: release };
      }
      const location = keep(new oc.TopLoc_Location_2(trsf));
      return { shape: keep(shape.Moved(location, true)), delete: release };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** 位置つきの面がいくつあるかを数える(道が本当に通っていることの確認に使う)。 */
  function countPlacedFaces(shape: TopoDS_Shape): { placed: number; total: number } {
    const { keep, release } = createAllocations();
    try {
      const subShapes = keep(new oc.TopTools_IndexedMapOfShape_1());
      oc.TopExp.MapShapes_2(shape, subShapes, true, true);
      const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
      let placed = 0;
      let total = 0;
      for (let index = 1; index <= subShapes.Size(); index += 1) {
        const subShape = subShapes.FindKey(index);
        if (subShape.ShapeType() !== faceType) {
          continue;
        }
        total += 1;
        const face = keep(oc.TopoDS.Face_1(subShape));
        const location = keep(new oc.TopLoc_Location_1());
        keep(oc.BRep_Tool.Triangulation(face, location, 0));
        if (!location.IsIdentity()) {
          placed += 1;
        }
      }
      return { placed, total };
    } finally {
      release();
    }
  }

  it('位置の無い箱で、変える前と 1 ビットも変わらない', () => {
    const handle = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    try {
      const fresh = tessellate(oc, handle.shape);
      expectSameMesh(fresh, walkLegacy(oc, handle.shape));
      expect(countPlacedFaces(handle.shape).placed).toBe(0);
    } finally {
      handle.delete();
    }
  });

  it('位置の無い球(曲面の法線)で、変える前と 1 ビットも変わらない', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      const fresh = tessellate(oc, handle.shape, { linearDeflection: 0.02 });
      expectSameMesh(fresh, walkLegacy(oc, handle.shape));
    } finally {
      handle.delete();
    }
  });

  it('平行移動だけの位置がついた箱で、変える前と 1 ビットも変わらない', () => {
    const source = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    try {
      const moved = movedShape(source.shape, [3.25, -7.5, 11.125], 0);
      try {
        const counts = countPlacedFaces(moved.shape);
        expect(counts.placed).toBe(counts.total);
        expect(counts.placed).toBe(6);
        const fresh = tessellate(oc, moved.shape);
        expectSameMesh(fresh, walkLegacy(oc, moved.shape));
        // 位置がきちんと効いている(動かす前と座標が違う)ことも見る。
        const before = tessellate(oc, source.shape);
        expect(Array.from(fresh.positions)).not.toEqual(Array.from(before.positions));
      } finally {
        moved.delete();
      }
    } finally {
      source.delete();
    }
  });

  it('回転と移動を含む位置がついた球で、変える前と 1 ビットも変わらない(法線もそろう)', () => {
    const source = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      const moved = movedShape(source.shape, [4, -2.5, 6], 0.7);
      try {
        expect(countPlacedFaces(moved.shape).placed).toBe(1);
        const fresh = tessellate(oc, moved.shape, { linearDeflection: 0.05 });
        expectSameMesh(fresh, walkLegacy(oc, moved.shape));
        // 法線はどれも単位ベクトルのまま(割り直しが効いている)。
        for (let i = 0; i < fresh.normals.length; i += 3) {
          expect(Math.hypot(fresh.normals[i], fresh.normals[i + 1], fresh.normals[i + 2])).toBeCloseTo(
            1,
            5,
          );
        }
      } finally {
        moved.delete();
      }
    } finally {
      source.delete();
    }
  });

  it('回転と移動を含む位置がついた円柱(平面と曲面が混ざる形)でも変わらない', () => {
    const source = makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius: 10, height: 20 }));
    try {
      const moved = movedShape(source.shape, [-12, 8, 3], 1.3);
      try {
        const fresh = tessellate(oc, moved.shape, { linearDeflection: 0.05 });
        expectSameMesh(fresh, walkLegacy(oc, moved.shape));
      } finally {
        moved.delete();
      }
    } finally {
      source.delete();
    }
  });

  it('向きを裏返した形(面の順序が入れ替わる形)でも変わらない', () => {
    const source = makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius: 10, height: 20 }));
    try {
      const { keep, release } = createAllocations();
      try {
        const reversed = keep(source.shape.Reversed());
        const fresh = tessellate(oc, reversed, { linearDeflection: 0.1 });
        const legacy = walkLegacy(oc, reversed);
        expectSameMesh(fresh, legacy);
        // 裏返すと、もとの形と添字の並びが変わる(裏返しの道を本当に通っている)。
        const straight = tessellate(oc, source.shape, { linearDeflection: 0.1 });
        expect(Array.from(fresh.indices)).not.toEqual(Array.from(straight.indices));
      } finally {
        release();
      }
    } finally {
      source.delete();
    }
  });

  it('位置つきと位置なしが混ざったコンパウンドでも変わらない', () => {
    const box = makeBox(oc, { dx: 10, dy: 20, dz: 30 });
    const sphere = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 6 }, 50));
    try {
      const moved = movedShape(sphere.shape, [0, 40, 0], 0.4);
      try {
        const compound = makeCompound(oc, [box.shape, moved.shape, sphere.shape]);
        try {
          const counts = countPlacedFaces(compound.shape);
          expect(counts.placed).toBe(1);
          expect(counts.total).toBe(8);
          const fresh = tessellate(oc, compound.shape);
          expectSameMesh(fresh, walkLegacy(oc, compound.shape));
        } finally {
          compound.delete();
        }
      } finally {
        moved.delete();
      }
    } finally {
      sphere.delete();
      box.delete();
    }
  });

  it('10 万三角形の走査の所要を、変える前と後で測って記録する(§2.17-3 の余裕)', () => {
    const parts: OcctShapeHandle[] = [];
    try {
      for (let index = 0; index < 103; index += 1) {
        parts.push(makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }, index * 30)));
      }
      const compound = makeCompound(
        oc,
        parts.map((part) => part.shape),
      );
      try {
        // 先に三角形分割を掛けておく(以降の tessellate は BRepMesh を素通りする)ので、
        // 測っているのは面の走査だけになる。
        const warmed = tessellate(oc, compound.shape, {
          linearDeflection: DEFAULT_LINEAR_DEFLECTION,
          angularDeflection: DEFAULT_ANGULAR_DEFLECTION,
        });
        expect(warmed.triangleCount).toBeGreaterThanOrEqual(100_000);

        // **測る順は「変える前を 3 回 → 変えたあとを 3 回」に分ける。** 交互に測ると
        // 片方が出したごみの回収がもう片方の計測に乗り、差が見えなくなる(最初にそう
        // 書いて 3 回とも順序どおりに揺れた)。どちらも 1 回空回ししてから測る。
        const legacyMs: number[] = [];
        walkLegacy(oc, compound.shape);
        let last = walkLegacy(oc, compound.shape);
        for (let run = 0; run < 3; run += 1) {
          last = walkLegacy(oc, compound.shape);
          legacyMs.push(last.totalMs);
        }

        const freshMs: number[] = [];
        tessellate(oc, compound.shape);
        for (let run = 0; run < 3; run += 1) {
          const start = performance.now();
          tessellate(oc, compound.shape);
          freshMs.push(performance.now() - start);
        }

        console.log(
          `[実測] 球 103 個 偏差 0.1(三角形 ${String(warmed.triangleCount)} 枚)の走査: 変える前 ${legacyMs
            .map((ms) => ms.toFixed(1))
            .join(' / ')} ms(内訳 節点 ${last.nodeMs.toFixed(1)} / 法線 ${last.normalMs.toFixed(1)} / 添字 ${last.indexMs.toFixed(1)} ms)、変えたあと ${freshMs
            .map((ms) => ms.toFixed(1))
            .join(' / ')} ms(最小 ${Math.min(...legacyMs).toFixed(1)} → ${Math.min(...freshMs).toFixed(1)} ms)`,
        );
        expectSameMesh(tessellate(oc, compound.shape), last);
      } finally {
        compound.delete();
      }
    } finally {
      for (const part of parts) {
        part.delete();
      }
    }
  });
});
