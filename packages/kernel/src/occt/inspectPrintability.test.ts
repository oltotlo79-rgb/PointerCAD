import { beforeAll, describe, expect, it } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';
import type { PrimitiveShapeSpec, PrimitiveStepSpec, Vec3Tuple } from '../types.js';
import { booleanOp } from './booleanOp.js';
import type { ExportMesh } from './exportMesh.js';
import { buildExportMesh } from './exportMesh.js';
import {
  BUILD_PLATE_TOLERANCE_MM,
  DEFAULT_MIN_THICKNESS_MM,
  DEFAULT_OVERHANG_ANGLE_DEG,
  PRINTABILITY_MIN_THICKNESS_MESSAGE,
  PRINTABILITY_NO_TRIANGLE_MESSAGE,
  PRINTABILITY_OVERHANG_ANGLE_MESSAGE,
  inspectPrintability,
  printabilityFlagByteLength,
  readPrintabilityFlag,
} from './inspectPrintability.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeBox } from './makeBox.js';
import { makePrimitive } from './makePrimitive.js';
import { makeCompound } from './transformShape.js';

/**
 * 3D プリント向けの点検(FR-815、NFR-PF-4)の検査。計画書 P6 §2.16 の検証表と
 * タスク42 の検証表を全部たどる。
 *
 * 期待値はすべて手計算か、形の定義から導けるものにしてある。
 */

/** 検証表の箱。20³。 */
const CUBE_SIZE = 20;

/** 面 200 枚・三角形 5 万の点検の上限(ミリ秒)。§2.17-9。**この値は緩めない。** */
const INSPECTION_BUDGET_MS = 5000;

/** 半径 10 の球の、下向き 45° 以内の面積 `2πr²(1 − cos45°)` = `200π(1 − √2/2)`。 */
const SPHERE_OVERHANG_AREA = 200 * Math.PI * (1 - Math.SQRT1_2);

/** 基本形状の段の依頼を 1 つ作る(頂点を基準にする欄は使わないので `null`)。 */
function primitiveAt(
  shape: PrimitiveShapeSpec,
  origin: Vec3Tuple = [0, 0, 0],
  axis: Vec3Tuple = [0, 0, 1],
): PrimitiveStepSpec {
  return { kind: 'primitive', origin, axis, shape, originQuery: null, targetKey: null };
}

/**
 * 手で組んだ立方体の三角形の網(面 6 枚 = 三角形 12 枚、節点 8 個)。
 *
 * **OCCT を通さずに作るのは、開いた殻(面 1 枚を欠いた箱)を作るため。** OCCT からは
 * 「立方体から 1 面だけ取り除いた形」を素直に出せないが、開いた辺の数え方を確かめるには
 * この形がいちばん分かりやすい(開口の周は 4 辺と決まっている)。
 *
 * `normals` には 0 を入れてある。**点検は頂点の法線を読まない**(面の法線を頂点の並びから
 * 作る。`writeStl.ts` の `forEachExportTriangle` と同じ規則)ことを、この検査が兼ねて示す。
 */
function cubeMesh(size: number, options: { readonly omitTop?: boolean } = {}): ExportMesh {
  const corners = [
    [0, 0, 0],
    [size, 0, 0],
    [size, size, 0],
    [0, size, 0],
    [0, 0, size],
    [size, 0, size],
    [size, size, size],
    [0, size, size],
  ];
  const faces: readonly (readonly number[])[] = [
    [0, 3, 2, 1], // 下(法線 −Z)
    [4, 5, 6, 7], // 上(法線 +Z)
    [0, 1, 5, 4], // 手前(−Y)
    [1, 2, 6, 5], // 右(+X)
    [2, 3, 7, 6], // 奥(+Y)
    [3, 0, 4, 7], // 左(−X)
  ];
  const used = options.omitTop === true ? faces.filter((_, index) => index !== 1) : faces;
  const positions = new Float32Array(corners.length * 3);
  for (let corner = 0; corner < corners.length; corner += 1) {
    positions[corner * 3] = corners[corner][0];
    positions[corner * 3 + 1] = corners[corner][1];
    positions[corner * 3 + 2] = corners[corner][2];
  }
  const indices = new Uint32Array(used.length * 6);
  used.forEach((face, index) => {
    indices.set([face[0], face[1], face[2], face[0], face[2], face[3]], index * 6);
  });
  return {
    positions,
    normals: new Float32Array(positions.length),
    indices,
    triangleCount: indices.length / 3,
  };
}

/** 三角形 1 枚の面積(mm²)。オーバーハングの面積を足すのに使う。 */
function triangleArea(mesh: ExportMesh, triangle: number): number {
  const { positions, indices } = mesh;
  const a = indices[triangle * 3] * 3;
  const b = indices[triangle * 3 + 1] * 3;
  const c = indices[triangle * 3 + 2] * 3;
  const ux = positions[b] - positions[a];
  const uy = positions[b + 1] - positions[a + 1];
  const uz = positions[b + 2] - positions[a + 2];
  const vx = positions[c] - positions[a];
  const vy = positions[c + 1] - positions[a + 1];
  const vz = positions[c + 2] - positions[a + 2];
  return (
    Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2
  );
}

/** 印の付いた三角形の面積の合計。 */
function flaggedArea(mesh: ExportMesh, bits: Uint8Array): number {
  let total = 0;
  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    if (readPrintabilityFlag(bits, triangle)) {
      total += triangleArea(mesh, triangle);
    }
  }
  return total;
}

/** 印の付いた三角形の枚数(要約の数と突き合わせる)。 */
function flaggedCount(mesh: ExportMesh, bits: Uint8Array): number {
  let total = 0;
  for (let triangle = 0; triangle < mesh.triangleCount; triangle += 1) {
    if (readPrintabilityFlag(bits, triangle)) {
      total += 1;
    }
  }
  return total;
}

describe('3D プリント向けの点検(FR-815、NFR-PF-4、タスク42)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  /** 形を 1 つ作って三角形にし、使い終わったら必ず解放する。 */
  async function withMesh(
    build: () => OcctShapeHandle,
    body: (mesh: ExportMesh) => Promise<void>,
    deflectionMm = 0.1,
  ): Promise<void> {
    const handle = build();
    try {
      await body(buildExportMesh(oc, handle.shape, deflectionMm));
    } finally {
      handle.delete();
    }
  }

  it('BRepIntCurveSurface_Inter に列挙を取らない版は無い(§1.5-21 の実測)', () => {
    // 型定義にあるのは Init_1 / Init_2 / Init_3 / Load と More / Next / Point の組だけで、
    // 「1 本の光線に対して最も近い交点を 1 つ返す」ような版は無い。実行時の姿も同じことを示す。
    const inter = new oc.BRepIntCurveSurface_Inter();
    try {
      const names = new Set<string>();
      let proto: object | null = Object.getPrototypeOf(inter) as object | null;
      while (proto !== null && proto !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(proto)) {
          names.add(name);
        }
        proto = Object.getPrototypeOf(proto) as object | null;
      }
      console.log(`[実測] BRepIntCurveSurface_Inter のメソッド: ${[...names].sort().join(' ')}`);
      // 列挙の口はある(だから列挙なしでは使えない)。
      expect(names.has('More')).toBe(true);
      expect(names.has('Next')).toBe(true);
      // 「交点を 1 つ返す」形の口は無い。
      expect(names.has('NearestPoint')).toBe(false);
      expect(names.has('Perform')).toBe(false);
    } finally {
      inter.delete();
    }
  });

  it('三角形が 1 枚も無ければ「点検できる形がありません。」で断る(§2.16)', async () => {
    const empty: ExportMesh = {
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      indices: new Uint32Array(0),
      triangleCount: 0,
    };
    await expect(inspectPrintability(empty)).rejects.toThrow(PRINTABILITY_NO_TRIANGLE_MESSAGE);
  });

  it('しきい値と角度が数でなければ断る(FR-504、NFR-UX-5)', async () => {
    const mesh = cubeMesh(CUBE_SIZE);
    for (const bad of [0, -1, Number.NaN]) {
      await expect(inspectPrintability(mesh, { minThicknessMm: bad })).rejects.toThrow(
        PRINTABILITY_MIN_THICKNESS_MESSAGE,
      );
    }
    for (const bad of [-1, 91, Number.NaN]) {
      await expect(inspectPrintability(mesh, { overhangAngleDeg: bad })).rejects.toThrow(
        PRINTABILITY_OVERHANG_ANGLE_MESSAGE,
      );
    }
  });

  it('20³ の箱は、重心からの光線が反対の面まで 20(タスク42 の検証表)', async () => {
    await withMesh(
      () => makeBox(oc, { dx: CUBE_SIZE, dy: CUBE_SIZE, dz: CUBE_SIZE }),
      async (mesh) => {
        const result = await inspectPrintability(mesh);
        console.log(
          `[実測] 20³ の箱: 三角形 ${String(result.triangleCount)} 枚、最小肉厚 ${String(result.summary.minThicknessFoundMm)} mm、升目 ${String(result.summary.cellSizeMm)} mm`,
        );
        expect(result.summary.minThicknessFoundMm).toBeCloseTo(CUBE_SIZE, 6);
        expect(result.summary.thinCount).toBe(0);
        expect(result.summary.watertight).toBe(true);
        expect(result.summary.openEdgeCount).toBe(0);
        // 底面は造形台に接しているので支持は要らない(§0.51 の但し書き)。
        expect(result.summary.overhangCount).toBe(0);
        expect(result.cancelled).toBe(false);
      },
    );
  });

  it('厚さ 0.5 の板は薄く、厚さ 2 の板は薄くない(既定のしきい値 0.8mm)', async () => {
    expect(DEFAULT_MIN_THICKNESS_MM).toBe(0.8);
    await withMesh(
      () => makeBox(oc, { dx: 20, dy: 20, dz: 0.5 }),
      async (mesh) => {
        const result = await inspectPrintability(mesh);
        console.log(
          `[実測] 20×20×0.5 の板: 最小肉厚 ${String(result.summary.minThicknessFoundMm)} mm、薄い三角形 ${String(result.summary.thinCount)} / ${String(result.triangleCount)} 枚`,
        );
        expect(result.summary.minThicknessFoundMm).toBeCloseTo(0.5, 6);
        // 上下の面(2 枚ずつ)だけが薄い。側面から横へ飛ばした光線は 20mm 進む。
        expect(result.summary.thinCount).toBe(4);
        expect(flaggedCount(mesh, result.thinTriangles)).toBe(4);
      },
    );
    await withMesh(
      () => makeBox(oc, { dx: 20, dy: 20, dz: 2 }),
      async (mesh) => {
        const result = await inspectPrintability(mesh);
        console.log(`[実測] 20×20×2 の板: 最小肉厚 ${String(result.summary.minThicknessFoundMm)} mm`);
        expect(result.summary.minThicknessFoundMm).toBeCloseTo(2, 6);
        expect(result.summary.thinCount).toBe(0);
      },
    );
  });

  it('20³ を厚さ 2 でくり抜いた形の最小肉厚は 2 ± 0.05(§2.16 の検証表)', async () => {
    const outer = makePrimitive(oc, primitiveAt({ kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 20 }));
    const inner = makePrimitive(oc, primitiveAt({ kind: 'box', sizeX: 16, sizeY: 16, sizeZ: 16 }));
    const hollow = booleanOp(oc, 'subtract', outer.shape, inner.shape);
    try {
      const mesh = buildExportMesh(oc, hollow.shape, 0.1);
      const result = await inspectPrintability(mesh);
      console.log(
        `[実測] 20³ を壁 2 でくり抜いた形: 三角形 ${String(result.triangleCount)} 枚、最小肉厚 ${String(result.summary.minThicknessFoundMm)} mm、閉じている: ${String(result.summary.watertight)}`,
      );
      expect(result.summary.minThicknessFoundMm).not.toBeNull();
      expect(Math.abs((result.summary.minThicknessFoundMm ?? 0) - 2)).toBeLessThan(0.05);
      expect(result.summary.thinCount).toBe(0);
      expect(result.summary.watertight).toBe(true);

      // しきい値を 3 に上げると、壁 2 の面がすべて「薄い」に変わる(§2.16 の検証表)。
      const strict = await inspectPrintability(mesh, { minThicknessMm: 3 });
      console.log(
        `[実測] 同じ形をしきい値 3 で: 薄い三角形 ${String(strict.summary.thinCount)} / ${String(strict.triangleCount)} 枚`,
      );
      expect(strict.summary.thinCount).toBe(strict.triangleCount);
      expect(strict.summary.cellSizeMm).toBe(6);
    } finally {
      hollow.delete();
      inner.delete();
      outer.delete();
    }
  });

  it('閉じた箱は水密、面 1 枚を欠いた箱は開いた辺が 4 本(§2.16 の検証表)', async () => {
    const closed = await inspectPrintability(cubeMesh(CUBE_SIZE));
    expect(closed.summary.watertight).toBe(true);
    expect(closed.summary.openEdgeCount).toBe(0);
    expect(closed.summary.openEdgeTriangleCount).toBe(0);

    const open = cubeMesh(CUBE_SIZE, { omitTop: true });
    const result = await inspectPrintability(open);
    console.log(
      `[実測] 上面を欠いた箱: 三角形 ${String(result.triangleCount)} 枚、開いた辺 ${String(result.summary.openEdgeCount)} 本、その辺を持つ三角形 ${String(result.summary.openEdgeTriangleCount)} 枚`,
    );
    expect(result.summary.watertight).toBe(false);
    // 開口の周は 4 辺。
    expect(result.summary.openEdgeCount).toBe(4);
    // その 4 辺は、側面 4 枚の上側の三角形が 1 本ずつ持つ。
    expect(result.summary.openEdgeTriangleCount).toBe(4);
    expect(flaggedCount(open, result.openEdgeTriangles)).toBe(4);
  });

  it('球・円柱・円錐・トーラスはどれも閉じている(面ごとに節点を積む形でも溶接で数えられる)', async () => {
    const shapes: readonly { label: string; build: () => OcctShapeHandle }[] = [
      { label: '球 r=10', build: () => makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 })) },
      {
        label: '円柱 r=10 h=20',
        build: () => makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius: 10, height: 20 })),
      },
      {
        label: '円錐 r=10 h=20',
        build: () =>
          makePrimitive(oc, primitiveAt({ kind: 'cone', bottomRadius: 10, topRadius: 0, height: 20 })),
      },
      {
        label: 'トーラス R=20 r=5',
        build: () => makePrimitive(oc, primitiveAt({ kind: 'torus', majorRadius: 20, minorRadius: 5 })),
      },
    ];
    for (const { label, build } of shapes) {
      const handle = build();
      try {
        const mesh = buildExportMesh(oc, handle.shape, 0.1);
        const result = await inspectPrintability(mesh);
        console.log(
          `[実測] ${label}: 三角形 ${String(result.triangleCount)} 枚(面積 0 が ${String(result.summary.degenerateCount)} 枚)、開いた辺 ${String(result.summary.openEdgeCount)} 本`,
        );
        expect(result.summary.watertight).toBe(true);
      } finally {
        handle.delete();
      }
    }
  });

  it('頂点が上の円錐に支持は要らず、下向きの面はしきい値の角度で変わる(§2.16 の検証表)', async () => {
    expect(DEFAULT_OVERHANG_ANGLE_DEG).toBe(45);
    await withMesh(
      () => makePrimitive(oc, primitiveAt({ kind: 'cone', bottomRadius: 10, topRadius: 0, height: 20 })),
      async (mesh) => {
        const result = await inspectPrintability(mesh);
        // 側面の傾きは水平から atan(20/10) = 63.43°、法線は上向き成分を持つ。
        console.log(
          `[実測] 円錐(頂点が上): 支持が要る三角形 ${String(result.summary.overhangCount)} / ${String(result.triangleCount)} 枚`,
        );
        expect(result.summary.overhangCount).toBe(0);
      },
    );
    await withMesh(
      // 頂点を下(z=0)にし、底面(半径 10)を z=20 へ置く。
      () =>
        makePrimitive(
          oc,
          primitiveAt({ kind: 'cone', bottomRadius: 10, topRadius: 0, height: 20 }, [0, 0, 20], [0, 0, -1]),
        ),
      async (mesh) => {
        const standard = await inspectPrintability(mesh);
        // 側面は下を向いているが、水平から 63.43° と立っているので 45° の既定では支持が要らない。
        // **計画書 §2.16 の「同を上下逆さ → 側面すべてがオーバーハング」は「下向き」の意味**で、
        // 45° のしきい値をそのまま当てると支持は要らない(角度を 70° にすると全部が変わる)。
        const loose = await inspectPrintability(mesh, { overhangAngleDeg: 70 });
        const sideTriangles = loose.summary.overhangCount;
        console.log(
          `[実測] 円錐(頂点が下): 45° で ${String(standard.summary.overhangCount)} 枚、70° で ${String(sideTriangles)} 枚 / ${String(mesh.triangleCount)} 枚`,
        );
        expect(standard.summary.overhangCount).toBe(0);
        expect(sideTriangles).toBeGreaterThan(0);
        // 70° では側面の全部が支持の要る面になる(上面の円板と、頂点まわりの面積 0 を除く)。
        const sideArea = flaggedArea(mesh, loose.overhangTriangles);
        // 円錐の側面積 πr√(r² + h²) = π·10·√500。
        expect(sideArea).toBeGreaterThan(0.97 * Math.PI * 10 * Math.sqrt(500));
      },
    );
  });

  it('水平から 30° に傾いた下向きの面は支持が要る(45° より浅い)', async () => {
    // 40×40×2 の板を y 軸まわりに 30° 倒す。下面の法線は真下から 30° 傾く。
    const angle = (30 * Math.PI) / 180;
    const mesh = tiltedPlate(40, 2, angle);
    const result = await inspectPrintability(mesh, { minThicknessMm: 0.8, overhangAngleDeg: 45 });
    console.log(
      `[実測] 30° に傾けた板: 支持が要る三角形 ${String(result.summary.overhangCount)} / ${String(result.triangleCount)} 枚`,
    );
    // 下面の 2 枚だけ(上面の法線は上向き、側面は θ = 60° と 120°)。
    expect(result.summary.overhangCount).toBe(2);
    const steep = await inspectPrintability(mesh, { overhangAngleDeg: 20 });
    expect(steep.summary.overhangCount).toBe(0);
  });

  it('造形台から浮いた面だけが支持の対象になる(最下点から 0.1mm 以内は除く)', async () => {
    expect(BUILD_PLATE_TOLERANCE_MM).toBe(0.1);
    // 台に載る柱(z = 0〜10)と、その上に浮かせた板(z = 10〜12)。
    const post = makePrimitive(oc, primitiveAt({ kind: 'box', sizeX: 4, sizeY: 4, sizeZ: 10 }, [0, 0, 5]));
    const slab = makePrimitive(oc, primitiveAt({ kind: 'box', sizeX: 20, sizeY: 20, sizeZ: 2 }, [0, 0, 11]));
    const compound = makeCompound(oc, [post.shape, slab.shape]);
    try {
      const mesh = buildExportMesh(oc, compound.shape, 0.1);
      const result = await inspectPrintability(mesh);
      console.log(
        `[実測] 柱の上に浮いた板: 支持が要る三角形 ${String(result.summary.overhangCount)} / ${String(result.triangleCount)} 枚`,
      );
      // 板の下面 2 枚だけ。柱の底面 2 枚は台に接しているので除かれる。
      expect(result.summary.overhangCount).toBe(2);
      expect(flaggedArea(mesh, result.overhangTriangles)).toBeCloseTo(400, 4);
    } finally {
      compound.delete();
      slab.delete();
      post.delete();
    }
  });

  it('球の「下向き 45° 以内」の面積が 200π(1 − √2/2) ≈ 184.03 に近い(§2.16 の検証表)', async () => {
    await withMesh(
      () => makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 })),
      async (mesh) => {
        const result = await inspectPrintability(mesh);
        const area = flaggedArea(mesh, result.overhangTriangles);
        console.log(
          `[実測] 球 r=10 の支持が要る面積 ${area.toFixed(4)} mm²(式 ${SPHERE_OVERHANG_AREA.toFixed(4)})、三角形 ${String(result.summary.overhangCount)} 枚`,
        );
        // 内接する多面体なので式の値より少し小さい。偏差 0.1 で 3% 以内。
        expect(area).toBeLessThan(SPHERE_OVERHANG_AREA);
        expect(area).toBeGreaterThan(SPHERE_OVERHANG_AREA * 0.97);
      },
      0.02,
    );
  });

  it('結果は三角形 1 枚あたり 3 ビット(5 万三角形で 18,750 バイト)', async () => {
    const mesh = cubeMesh(CUBE_SIZE);
    const result = await inspectPrintability(mesh);
    const expected = printabilityFlagByteLength(mesh.triangleCount);
    expect(result.thinTriangles.byteLength).toBe(expected);
    expect(result.overhangTriangles.byteLength).toBe(expected);
    expect(result.openEdgeTriangles.byteLength).toBe(expected);
    // 12 枚なら 2 バイトずつ。5 万枚なら 6,250 バイトずつ = 3 本で 18,750 バイト。
    expect(expected).toBe(2);
    expect(printabilityFlagByteLength(50_000) * 3).toBe(18_750);
    // 範囲の外を読んでも落ちない(色を塗らない)。
    expect(readPrintabilityFlag(result.thinTriangles, -1)).toBe(false);
    expect(readPrintabilityFlag(result.thinTriangles, 10_000)).toBe(false);
  });

  it('中止を求めると途中で止まり、水密性とオーバーハングは揃ったまま返る(NFR-PF-4)', async () => {
    await withMesh(
      () => makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 })),
      async (mesh) => {
        let asked = 0;
        const result = await inspectPrintability(
          mesh,
          {},
          {
            shouldCancel: () => {
              asked += 1;
              return true;
            },
          },
        );
        console.log(
          `[実測] 中止: 尋ねた回数 ${String(asked)}、肉厚を見た三角形 ${String(result.summary.inspectedTriangleCount)} / ${String(result.triangleCount)} 枚`,
        );
        expect(result.cancelled).toBe(true);
        // 肉厚は 1 枚も測っていないが、
        expect(result.summary.inspectedTriangleCount).toBeLessThan(result.triangleCount);
        expect(result.summary.thinCount).toBe(0);
        expect(result.summary.minThicknessFoundMm).toBeNull();
        // 水密性とオーバーハングは中止より前に終えてあるので、そのまま使える。
        expect(result.summary.watertight).toBe(true);
        expect(result.summary.overhangCount).toBeGreaterThan(0);
      },
    );
  });

  it('中止しなければ最後まで進み、進捗は 0 から 1 へ増える(NFR-PF-4)', async () => {
    await withMesh(
      () => makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 })),
      async (mesh) => {
        const ratios: number[] = [];
        const phases = new Set<string>();
        const result = await inspectPrintability(
          mesh,
          {},
          {
            onProgress: (progress) => {
              ratios.push(progress.ratio);
              phases.add(progress.phase);
              expect(progress.total).toBe(mesh.triangleCount);
            },
            shouldCancel: () => false,
          },
        );
        expect(result.cancelled).toBe(false);
        expect(result.summary.inspectedTriangleCount).toBe(result.triangleCount);
        expect([...phases].sort()).toEqual(['overhang', 'thickness', 'watertight']);
        expect(ratios[0]).toBe(0);
        expect(ratios[ratios.length - 1]).toBe(1);
        for (let index = 1; index < ratios.length; index += 1) {
          expect(ratios[index]).toBeGreaterThanOrEqual(ratios[index - 1]);
        }
      },
    );
  });

  it('同じ形を 2 回点検するとまったく同じ結果になる(決定性、§0.a-0.62)', async () => {
    await withMesh(
      () => makePrimitive(oc, primitiveAt({ kind: 'torus', majorRadius: 20, minorRadius: 5 })),
      async (mesh) => {
        const first = await inspectPrintability(mesh);
        const second = await inspectPrintability(mesh);
        expect(second.summary).toEqual(first.summary);
        expect(Array.from(second.thinTriangles)).toEqual(Array.from(first.thinTriangles));
        expect(Array.from(second.overhangTriangles)).toEqual(Array.from(first.overhangTriangles));
      },
    );
  });

  it('面 200 枚・三角形 5 万の点検が 5 秒以内に終わる(§2.17-9)', async () => {
    const parts: OcctShapeHandle[] = [];
    try {
      // 球 200 個(面 200 枚)を 20 × 10 の格子に並べる。偏差 0.6 で 1 個 306 枚 = 61,200 枚。
      // **球にするのは、曲がった面でしか三角形が数万枚に届かないため**(`exportMesh.test.ts` と同じ理由)。
      for (let index = 0; index < 200; index += 1) {
        parts.push(
          makePrimitive(
            oc,
            primitiveAt({ kind: 'sphere', radius: 10 }, [(index % 20) * 25, 0, Math.floor(index / 20) * 25]),
          ),
        );
      }
      const compound = makeCompound(
        oc,
        parts.map((part) => part.shape),
      );
      try {
        const mesh = buildExportMesh(oc, compound.shape, 0.6);
        expect(mesh.triangleCount).toBeGreaterThanOrEqual(50_000);
        const start = performance.now();
        const result = await inspectPrintability(mesh);
        const elapsed = performance.now() - start;
        console.log(
          `[実測] 球 200 個(面 200 枚)の点検: 三角形 ${String(result.triangleCount)} 枚を ${elapsed.toFixed(1)} ms(上限 ${String(INSPECTION_BUDGET_MS)} ms)。升目 ${String(result.summary.cellSizeMm)} mm、最小肉厚 ${(result.summary.minThicknessFoundMm ?? 0).toFixed(4)} mm、支持が要る三角形 ${String(result.summary.overhangCount)} 枚、閉じている: ${String(result.summary.watertight)}`,
        );
        console.log(
          `[実測] 結果の大きさ: ${String(result.thinTriangles.byteLength * 3)} バイト(三角形 ${String(result.triangleCount)} 枚 × 3 ビット)`,
        );
        expect(result.summary.watertight).toBe(true);
        expect(result.summary.thinCount).toBe(0);
        expectWithinBudget(elapsed, INSPECTION_BUDGET_MS, '面 200 枚・三角形 5 万の 3D プリント点検');
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

/**
 * 板を y 軸まわりに `angle` だけ倒した三角形の網(手で組む)。
 *
 * 下面の法線は真下から `angle` だけ傾くので、オーバーハングの角度の判定を
 * ちょうど狙った値で試せる。OCCT の変換を通すと float32 の丸めで角度が
 * わずかにずれ、しきい値ちょうどの検査が環境で揺れるため、ここは手で組む。
 */
function tiltedPlate(size: number, thickness: number, angle: number): ExportMesh {
  const cube = cubeMesh(1);
  const positions = new Float32Array(cube.positions.length);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let node = 0; node < cube.positions.length / 3; node += 1) {
    const x = (cube.positions[node * 3] - 0.5) * size;
    const y = (cube.positions[node * 3 + 1] - 0.5) * size;
    const z = (cube.positions[node * 3 + 2] - 0.5) * thickness;
    // y 軸まわりの回転。
    positions[node * 3] = x * cos + z * sin;
    positions[node * 3 + 1] = y;
    positions[node * 3 + 2] = -x * sin + z * cos;
  }
  return {
    positions,
    normals: new Float32Array(positions.length),
    indices: cube.indices,
    triangleCount: cube.triangleCount,
  };
}
