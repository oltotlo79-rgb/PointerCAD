import { beforeAll, describe, expect, it } from 'vitest';

import type { PrimitiveShapeSpec, PrimitiveStepSpec } from '../types.js';
import { expectWithinBudget } from '../testUtils/perfBudget.js';
import type { ExportMesh } from './exportMesh.js';
import { buildExportMesh } from './exportMesh.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeBox } from './makeBox.js';
import { makePrimitive } from './makePrimitive.js';
import { tessellate } from './tessellate.js';
import { makeCompound } from './transformShape.js';

/** 20³ の箱(検証表の 1 行目)。makeBox は原点を角にするので中心は (10, 10, 10)。 */
const BOX_SIZE = 20;
/** 半径 10 の球の厳密な体積 `4/3·π·10³`(検証表の 3 行目)。 */
const SPHERE_EXACT_VOLUME = 4188.790204786391;
/** 10 万三角形の形を作り直す上限(ミリ秒。計画書 §2.17-3 の前提)。 */
const HUNDRED_THOUSAND_TRIANGLE_BUDGET_MS = 2000;

/**
 * 三角形の網から符号つき体積を求める(mm³)。
 *
 * 三角形 (a, b, c) と原点で作る四面体の符号つき体積 `a·(b×c)/6` を全部足す。
 * 表が外向きに揃っていれば正の値になり、1 枚でも裏返っていればその四面体だけ符号が
 * 反転して合計が狂う。**体積の一致が、そのまま向きの検査を兼ねる**(検証表の 2 行目)。
 */
function signedVolume(mesh: ExportMesh): number {
  const { positions, indices } = mesh;
  let total = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const crossX = positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1];
    const crossY = positions[b + 2] * positions[c] - positions[b] * positions[c + 2];
    const crossZ = positions[b] * positions[c + 1] - positions[b + 1] * positions[c];
    total += positions[a] * crossX + positions[a + 1] * crossY + positions[a + 2] * crossZ;
  }
  return total / 6;
}

/** 面積が実質 0 とみなす境目(法線ベクトルの長さ = 面積の 2 倍)。 */
const DEGENERATE_NORMAL_LENGTH = 1e-6;

/**
 * 三角形の向きの内訳(検証表の 6 行目)。
 *
 * 凸な形でだけ成り立つ判定なので、箱・球・円柱にだけ使う。三角形の重心から中心へ
 * 引いたベクトルと、頂点の並び (b−a)×(c−a) の内積が正なら外向き。
 *
 * **面積が 0 の三角形(`degenerate`)は向きを持たない**ので別に数える。球の極や
 * 継ぎ目では OCCT が同じ節点を 2 つ含む三角形を作ることがあり(2026-09-06 実測で
 * 球 r=10 偏差 0.1 に 2 枚)、その三角形は体積にも表示にも寄与しない。
 */
function countTriangleOrientations(
  mesh: ExportMesh,
  center: readonly [number, number, number],
): { inward: number; degenerate: number } {
  const { positions, indices } = mesh;
  let inward = 0;
  let degenerate = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const abX = positions[b] - positions[a];
    const abY = positions[b + 1] - positions[a + 1];
    const abZ = positions[b + 2] - positions[a + 2];
    const acX = positions[c] - positions[a];
    const acY = positions[c + 1] - positions[a + 1];
    const acZ = positions[c + 2] - positions[a + 2];
    const nX = abY * acZ - abZ * acY;
    const nY = abZ * acX - abX * acZ;
    const nZ = abX * acY - abY * acX;
    if (Math.hypot(nX, nY, nZ) < DEGENERATE_NORMAL_LENGTH) {
      degenerate += 1;
      continue;
    }
    const outX = (positions[a] + positions[b] + positions[c]) / 3 - center[0];
    const outY = (positions[a + 1] + positions[b + 1] + positions[c + 1]) / 3 - center[1];
    const outZ = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3 - center[2];
    if (nX * outX + nY * outY + nZ * outZ <= 0) {
      inward += 1;
    }
  }
  return { inward, degenerate };
}

/**
 * 半径 `radius` の円の上に並ぶ節点の、異なる向きの数(円柱の側面の分割数 n)。
 *
 * 底面・上面の三角形分割は円の内側にも節点を置くので、半径がちょうど `radius` の
 * 節点だけを拾う。同じ角度の節点は上面・底面・側面で重なるので、角度で束ねて数える。
 */
function countCircleDivisions(mesh: ExportMesh, radius: number): number {
  const angles: number[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i];
    const y = mesh.positions[i + 1];
    if (Math.abs(Math.hypot(x, y) - radius) > 1e-3) {
      continue;
    }
    const angle = Math.atan2(y, x);
    if (!angles.some((known) => Math.abs(known - angle) < 1e-4)) {
      angles.push(angle);
    }
  }
  return angles.length;
}

/**
 * 基本形状の段の依頼を 1 つ作る(検査で使うのは形と位置だけなので、
 * 頂点を基準にする欄(`originQuery` / `targetKey`)は使わない `null` で埋める)。
 */
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

describe('書き出し用の三角形の作り直し(FR-803、タスク11)', () => {
  let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

  beforeAll(async () => {
    oc = await loadOcctForNode();
  });

  it('偏差が正の有限な数でなければ、OCCT を呼ぶ前に断る(NFR-UX-5)', () => {
    const handle = makeBox(oc, { dx: BOX_SIZE, dy: BOX_SIZE, dz: BOX_SIZE });
    try {
      expect(() => buildExportMesh(oc, handle.shape, 0)).toThrow(/書き出しの品質/);
      expect(() => buildExportMesh(oc, handle.shape, -0.1)).toThrow(/書き出しの品質/);
      expect(() => buildExportMesh(oc, handle.shape, Number.NaN)).toThrow(/書き出しの品質/);
    } finally {
      handle.delete();
    }
  });

  it('角度の偏差が正の有限な数でなければ、OCCT を呼ぶ前に断る(NFR-UX-5)', () => {
    const handle = makeBox(oc, { dx: BOX_SIZE, dy: BOX_SIZE, dz: BOX_SIZE });
    try {
      expect(() =>
        buildExportMesh(oc, handle.shape, 0.1, { angularDeflectionRad: 0 }),
      ).toThrow(/角度の偏差/);
      expect(() =>
        buildExportMesh(oc, handle.shape, 0.1, { angularDeflectionRad: -0.2 }),
      ).toThrow(/角度の偏差/);
      expect(() =>
        buildExportMesh(oc, handle.shape, 0.1, { angularDeflectionRad: Number.NaN }),
      ).toThrow(/角度の偏差/);
    } finally {
      handle.delete();
    }
  });

  it('20³ の箱を偏差 0.1 で切ると三角形 12 枚になる(頂点の数は実測して記録する)', () => {
    const handle = makeBox(oc, { dx: BOX_SIZE, dy: BOX_SIZE, dz: BOX_SIZE });
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.1);
      expect(mesh.triangleCount).toBe(12);
      expect(mesh.indices.length).toBe(36);
      // 節点は面ごとに独立して積まれる(面 6 枚 × 4 隅 = 24)。
      expect(mesh.positions.length / 3).toBe(24);
      expect(mesh.normals.length).toBe(mesh.positions.length);
      console.log(`[実測] 20³ の箱 偏差 0.1: 三角形 ${String(mesh.triangleCount)} 枚、節点 ${String(mesh.positions.length / 3)} 個`);
    } finally {
      handle.delete();
    }
  });

  it('面ごとの三角形の範囲(faceRanges)を返す(タスク13b。面ごとの色が使う)', () => {
    const handle = makeBox(oc, { dx: BOX_SIZE, dy: BOX_SIZE, dz: BOX_SIZE });
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.1);
      const faceRanges = mesh.faceRanges ?? [];
      // 箱の面は 6 枚。並びは `TopExp.MapShapes_2`(= `subShapes.ts` の `faceAt`)と同じ。
      expect(faceRanges).toHaveLength(6);
      // 範囲は隙間なく前から並び、合計が三角形の枚数になる(面 1 枚あたり 2 枚)。
      let expectedOffset = 0;
      for (const range of faceRanges) {
        expect(range.triangleOffset).toBe(expectedOffset);
        expect(range.triangleCount).toBe(2);
        expectedOffset += range.triangleCount;
      }
      expect(expectedOffset).toBe(mesh.triangleCount);
    } finally {
      handle.delete();
    }
  });

  it('faceRanges は tessellate の返す範囲とそのまま同じ(写しを作っていない)', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.1, { angularDeflectionRad: 0.2 });
      // 球の B-rep の面は 1 枚(継ぎ目は辺であって面ではない)。
      expect(mesh.faceRanges).toHaveLength(1);
      expect(mesh.faceRanges?.[0]).toEqual({ triangleOffset: 0, triangleCount: mesh.triangleCount });
    } finally {
      handle.delete();
    }
  });

  it('20³ の箱の三角形からの体積が 8000 と一致する(平面だけなので厳密)', () => {
    const handle = makeBox(oc, { dx: BOX_SIZE, dy: BOX_SIZE, dz: BOX_SIZE });
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.1);
      expect(Math.abs(signedVolume(mesh) - 8000)).toBeLessThan(1e-6);
    } finally {
      handle.delete();
    }
  });

  it('20³ の箱の三角形はすべて外向き(3MF / STL の仕様)', () => {
    const handle = makeBox(oc, { dx: BOX_SIZE, dy: BOX_SIZE, dz: BOX_SIZE });
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.1);
      expect(countTriangleOrientations(mesh, [10, 10, 10])).toEqual({ inward: 0, degenerate: 0 });
    } finally {
      handle.delete();
    }
  });

  it('半径 10 の球は、偏差 0.02 のほうが 0.1 より三角形が多く、体積が厳密値に近い', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      const coarse = buildExportMesh(oc, handle.shape, 0.1);
      const fine = buildExportMesh(oc, handle.shape, 0.02);
      const coarseVolume = signedVolume(coarse);
      const fineVolume = signedVolume(fine);
      console.log(
        `[実測] 球 r=10 偏差 0.1: 三角形 ${String(coarse.triangleCount)} 枚、体積 ${coarseVolume.toFixed(6)} / 偏差 0.02: 三角形 ${String(fine.triangleCount)} 枚、体積 ${fineVolume.toFixed(6)}(厳密 ${String(SPHERE_EXACT_VOLUME)})`,
      );
      expect(fine.triangleCount).toBeGreaterThan(coarse.triangleCount);
      // 内接する多面体なので、どちらも厳密値より小さい。
      expect(fineVolume).toBeLessThan(SPHERE_EXACT_VOLUME);
      expect(coarseVolume).toBeLessThan(SPHERE_EXACT_VOLUME);
      expect(SPHERE_EXACT_VOLUME - fineVolume).toBeLessThan(SPHERE_EXACT_VOLUME - coarseVolume);
      // 内接多面体の体積の不足は弦のずれ d に比例し、およそ 1.5·d/r(r = 10)になる。
      // 偏差 0.02 なら 0.3%、偏差 0.1 なら 1.5% 前後(2026-09-06 実測 0.29% / 1.43%)。
      expect((SPHERE_EXACT_VOLUME - fineVolume) / SPHERE_EXACT_VOLUME).toBeLessThan(0.01);
      expect((SPHERE_EXACT_VOLUME - coarseVolume) / SPHERE_EXACT_VOLUME).toBeLessThan(0.02);
    } finally {
      handle.delete();
    }
  });

  it('角度の偏差を省略すると、足す前とまったく同じ三角形になる(タスク10 の配線を壊さない)', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      const omitted = buildExportMesh(oc, handle.shape, 0.1);
      const empty = buildExportMesh(oc, handle.shape, 0.1, {});
      const undefinedValue = buildExportMesh(oc, handle.shape, 0.1, {
        angularDeflectionRad: undefined,
      });
      const explicitDefault = buildExportMesh(oc, handle.shape, 0.1, {
        angularDeflectionRad: 0.5,
      });
      console.log(
        `[実測] 球 r=10 偏差 0.1mm 角度を省略: 三角形 ${String(omitted.triangleCount)} 枚(不足 ${(((SPHERE_EXACT_VOLUME - signedVolume(omitted)) / SPHERE_EXACT_VOLUME) * 100).toFixed(2)}%)`,
      );
      for (const other of [empty, undefinedValue, explicitDefault]) {
        expect(other.triangleCount).toBe(omitted.triangleCount);
        expect(Array.from(other.positions)).toEqual(Array.from(omitted.positions));
        expect(Array.from(other.indices)).toEqual(Array.from(omitted.indices));
      }
    } finally {
      handle.delete();
    }
  });

  it('球 r=10 を標準の対(0.1mm / 0.2rad)で切ると、体積の不足が 1% 以内に入る', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      // 長さの偏差だけを 0.1mm にしても、角度の既定 0.5rad が先に効いて丸くならない
      // (2026-09-06 実測で不足 1.43%)。角度を 0.2rad にすると 1% を切る。
      const standard = buildExportMesh(oc, handle.shape, 0.1, { angularDeflectionRad: 0.2 });
      const shortfall = (SPHERE_EXACT_VOLUME - signedVolume(standard)) / SPHERE_EXACT_VOLUME;
      console.log(
        `[実測] 球 r=10 標準の対(0.1mm / 0.2rad): 三角形 ${String(standard.triangleCount)} 枚、体積の不足 ${(shortfall * 100).toFixed(2)}%`,
      );
      expect(shortfall).toBeGreaterThan(0);
      expect(shortfall).toBeLessThan(0.01);
      // 角度を細かくしたぶん、角度が既定のままより必ず三角形が増える。
      expect(standard.triangleCount).toBeGreaterThan(buildExportMesh(oc, handle.shape, 0.1).triangleCount);
    } finally {
      handle.delete();
    }
  });

  it('品質 3 択の対(粗い / 標準 / 細かい)で、三角形が増え体積の不足が減る(FR-803)', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      const pairs = [
        { label: '粗い', mm: 0.5, rad: 0.5 },
        { label: '標準', mm: 0.1, rad: 0.2 },
        { label: '細かい', mm: 0.02, rad: 0.1 },
      ] as const;
      const measured = pairs.map((pair) => {
        const mesh = buildExportMesh(oc, handle.shape, pair.mm, { angularDeflectionRad: pair.rad });
        const shortfall = (SPHERE_EXACT_VOLUME - signedVolume(mesh)) / SPHERE_EXACT_VOLUME;
        return { ...pair, triangleCount: mesh.triangleCount, shortfall };
      });
      for (const row of measured) {
        console.log(
          `[実測] 球 r=10 ${row.label}(${String(row.mm)}mm / ${String(row.rad)}rad): 三角形 ${String(row.triangleCount)} 枚、体積の不足 ${(row.shortfall * 100).toFixed(2)}%`,
        );
      }
      expect(measured[1].triangleCount).toBeGreaterThan(measured[0].triangleCount);
      expect(measured[2].triangleCount).toBeGreaterThan(measured[1].triangleCount);
      expect(measured[1].shortfall).toBeLessThan(measured[0].shortfall);
      expect(measured[2].shortfall).toBeLessThan(measured[1].shortfall);
      // 細かい対は 0.2% を切る(2026-09-06 実測 0.18%)。
      expect(measured[2].shortfall).toBeLessThan(0.002);
    } finally {
      handle.delete();
    }
  });

  it('半径 10 の球の三角形は、面積を持つものがすべて外向き', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.02);
      const orientations = countTriangleOrientations(mesh, [0, 0, 0]);
      console.log(
        `[実測] 球 r=10 偏差 0.02: 三角形 ${String(mesh.triangleCount)} 枚のうち 面積 0 が ${String(orientations.degenerate)} 枚、内向きが ${String(orientations.inward)} 枚`,
      );
      expect(orientations.inward).toBe(0);
      // 極の 2 枚(2026-09-06 実測)は同じ節点を含む面積 0 の三角形で、体積にも寄与しない。
      expect(orientations.degenerate).toBeLessThanOrEqual(2);
    } finally {
      handle.delete();
    }
  });

  it('円柱 r=10 h=20 を偏差 0.1 で切ると、側面の分割が 23 以上になり体積が式と一致する', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius: 10, height: 20 }));
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.1);
      const divisions = countCircleDivisions(mesh, 10);
      const volume = signedVolume(mesh);
      // 弦のずれ 10(1 − cos(θ/2)) ≤ 0.1 → θ ≤ 0.28312 rad → n ≥ 22.19 → 23 以上。
      expect(divisions).toBeGreaterThanOrEqual(23);
      // 正 n 角柱の体積 (n/2)·r²·sin(2π/n)·h。
      const expected = (divisions / 2) * 100 * Math.sin((2 * Math.PI) / divisions) * 20;
      console.log(
        `[実測] 円柱 r=10 h=20 偏差 0.1: 側面の分割 n = ${String(divisions)}、三角形 ${String(mesh.triangleCount)} 枚、体積 ${volume.toFixed(6)}(式 ${expected.toFixed(6)})`,
      );
      expect(Math.abs(volume - expected) / expected).toBeLessThan(1e-5);
      expect(countTriangleOrientations(mesh, [0, 0, 10])).toEqual({ inward: 0, degenerate: 0 });
    } finally {
      handle.delete();
    }
  });

  it('作り直しても画面用の三角形は元の粗さのまま(形状キャッシュを汚さない、§0.a-0.13)', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      const before = tessellate(oc, handle.shape);
      const exported = buildExportMesh(oc, handle.shape, 0.005);
      const after = tessellate(oc, handle.shape);
      // 書き出し用のほうが必ず細かい(掛け直したことの確認)。
      expect(exported.triangleCount).toBeGreaterThan(before.triangleCount);
      // それでも画面用は前後で 1 枚も変わらない。
      expect(after.triangleCount).toBe(before.triangleCount);
      expect(after.positions.length).toBe(before.positions.length);
      console.log(
        `[実測] 画面用 ${String(before.triangleCount)} 枚 → 書き出し(偏差 0.005)${String(exported.triangleCount)} 枚 → 画面用 ${String(after.triangleCount)} 枚`,
      );
    } finally {
      handle.delete();
    }
  });

  it('同じ形から 2 回作り直すと、まったく同じ三角形になる(決定性、§0.62)', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius: 10, height: 20 }));
    try {
      const first = buildExportMesh(oc, handle.shape, 0.05);
      const second = buildExportMesh(oc, handle.shape, 0.05);
      expect(second.triangleCount).toBe(first.triangleCount);
      expect(Array.from(second.indices)).toEqual(Array.from(first.indices));
      expect(Array.from(second.positions)).toEqual(Array.from(first.positions));
    } finally {
      handle.delete();
    }
  });

  it('偏差を細かくすると三角形が増える(FR-803 の品質 3 段が効く)', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius: 10, height: 20 }));
    try {
      const low = buildExportMesh(oc, handle.shape, 0.5);
      const middle = buildExportMesh(oc, handle.shape, 0.1);
      const high = buildExportMesh(oc, handle.shape, 0.02);
      console.log(
        `[実測] 円柱の三角形: 偏差 0.5 → ${String(low.triangleCount)} 枚、0.1 → ${String(middle.triangleCount)} 枚、0.02 → ${String(high.triangleCount)} 枚`,
      );
      expect(middle.triangleCount).toBeGreaterThan(low.triangleCount);
      expect(high.triangleCount).toBeGreaterThan(middle.triangleCount);
    } finally {
      handle.delete();
    }
  });

  it('BRepBuilderAPI_Copy と BRepTools.Clean が実在し、複製の費用を記録する(§1.5-9)', () => {
    const box = makeBox(oc, { dx: BOX_SIZE, dy: BOX_SIZE, dz: BOX_SIZE });
    const parts: OcctShapeHandle[] = [];
    try {
      // 面 204 枚のコンパウンド(箱 6 面 × 34 個)。§1.5-9 の「面 200 枚程度の形」。
      for (let index = 0; index < 34; index += 1) {
        parts.push(makeBox(oc, { dx: 5, dy: 5, dz: 5 }));
      }
      const compound = makeCompound(
        oc,
        parts.map((part) => part.shape),
      );
      try {
        for (const [label, shape] of [
          ['20³ の箱(面 6 枚)', box.shape],
          ['箱 34 個のコンパウンド(面 204 枚)', compound.shape],
        ] as const) {
          const copyStart = performance.now();
          const copier = new oc.BRepBuilderAPI_Copy_2(shape, false, false);
          const copied = copier.Shape();
          const copyMs = performance.now() - copyStart;
          expect(copier.IsDone()).toBe(true);

          const meshStart = performance.now();
          const mesh = tessellate(oc, copied, { linearDeflection: 0.1 });
          const meshMs = performance.now() - meshStart;

          const cleanStart = performance.now();
          oc.BRepTools.Clean(copied, true);
          const cleanMs = performance.now() - cleanStart;
          // Clean は例外を投げずに通り、掛け直せば同じ三角形へ戻る(実在の確認)。
          expect(tessellate(oc, copied, { linearDeflection: 0.1 }).triangleCount).toBe(
            mesh.triangleCount,
          );

          console.log(
            `[実測] ${label}: Copy(false,false) ${copyMs.toFixed(3)} ms / 偏差 0.1 の三角形分割 ${meshMs.toFixed(3)} ms(${String(mesh.triangleCount)} 枚) / BRepTools.Clean ${cleanMs.toFixed(3)} ms`,
          );
          copied.delete();
          copier.delete();
        }
      } finally {
        compound.delete();
      }
    } finally {
      for (const part of parts) {
        part.delete();
      }
      box.delete();
    }
  });

  it('10 万三角形の形の作り直しが 2 秒以内に終わる(§2.17-3 の前提)', () => {
    const parts: OcctShapeHandle[] = [];
    try {
      // 半径 10 の球 1 個は偏差 0.1(書き出しの品質「中」)で 978 枚になるので、
      // 103 個並べたコンパウンドで 10 万枚を少し超える。**球にするのは、曲がった面でしか
      // 10 万枚に届かないため**(平面と円柱は偏差をいくら細かくしても数百枚で止まる。
      // 2026-09-06 実測: 円柱 r=10 h=20 は偏差 0.02 でも 280 枚)。
      for (let index = 0; index < 103; index += 1) {
        parts.push(
          makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }, index * 30)),
        );
      }
      const compound = makeCompound(
        oc,
        parts.map((part) => part.shape),
      );
      try {
        const start = performance.now();
        const mesh = buildExportMesh(oc, compound.shape, 0.1);
        const elapsed = performance.now() - start;
        console.log(
          `[実測] 球 103 個 偏差 0.1: 三角形 ${String(mesh.triangleCount)} 枚を ${elapsed.toFixed(1)} ms で作り直した(上限 ${String(HUNDRED_THOUSAND_TRIANGLE_BUDGET_MS)} ms)`,
        );
        expect(mesh.triangleCount).toBeGreaterThanOrEqual(100_000);
        expectWithinBudget(elapsed, HUNDRED_THOUSAND_TRIANGLE_BUDGET_MS, '10 万三角形の作り直し');
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
