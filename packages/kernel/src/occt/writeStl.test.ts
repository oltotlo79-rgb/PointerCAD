import { expectWithinBudget } from '@pointercad/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';

import type { PrimitiveShapeSpec, PrimitiveStepSpec } from '../types.js';
import type { ExportMesh } from './exportMesh.js';
import { buildExportMesh } from './exportMesh.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makeBox } from './makeBox.js';
import { makePrimitive } from './makePrimitive.js';
import { STL_NO_FACE_MESSAGE, readStl } from './readStl.js';
import { makeCompound } from './transformShape.js';
import { writeStl } from './writeStl.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/** 20³ の箱(§2.4 の検証表の 1 行目)。 */
const BOX_SIZE = 20;

/** 半径 10 の球の厳密な体積 `4/3·π·10³`(§2.4 の検証表)。 */
const SPHERE_EXACT_VOLUME = 4188.790204786391;

/** バイナリ STL の見出し + 三角形の数の長さ(§2.4)。 */
const BINARY_HEADER_LENGTH = 84;

/** バイナリ STL の三角形 1 枚の長さ(§2.4)。 */
const BINARY_TRIANGLE_LENGTH = 50;

/** 10 万三角形の「作り直し + バイト列」の上限(ミリ秒。§2.17-3)。**緩めない。** */
const HUNDRED_THOUSAND_TRIANGLE_BUDGET_MS = 2000;

/** 基本形状の段の依頼を 1 つ作る(`exportMesh.test.ts` と同じ組み立て)。 */
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

/** 20³ の箱の三角形(偏差 0.1)。位置を変えられるので 2 個並べる検査にも使う。 */
function boxMesh(x = 0): ExportMesh {
  const handle = makePrimitive(
    oc,
    primitiveAt({ kind: 'box', sizeX: BOX_SIZE, sizeY: BOX_SIZE, sizeZ: BOX_SIZE }, x),
  );
  try {
    return buildExportMesh(oc, handle.shape, 0.1);
  } finally {
    handle.delete();
  }
}

/** バイト列を ASCII の文字列として読む。 */
function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** 行の先頭(空白を落としたもの)が語で始まる行を数える。 */
function countLinesStartingWith(text: string, word: string): number {
  return text.split('\n').filter((line) => line.trim().startsWith(word)).length;
}

/** バイナリ STL の頭に書いてある三角形の数(5〜8 バイト目、リトルエンディアン)。 */
function headerTriangleCount(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true);
}

/** バイナリ STL の `index` 枚目の面の法線。 */
function binaryFacetNormal(bytes: Uint8Array, index: number): [number, number, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = BINARY_HEADER_LENGTH + BINARY_TRIANGLE_LENGTH * index;
  return [view.getFloat32(base, true), view.getFloat32(base + 4, true), view.getFloat32(base + 8, true)];
}

describe('STL の書き出し(FR-803、P6 タスク12)', () => {
  it('oc.StlAPI と StlAPI.Write は実在する(§1.5-1。記録するだけで使わない)', () => {
    // 計画書 §0.a-0.14 は `StlAPI.Write` を推奨していたが、統括の決定(2026-09-06)で
    // 「書き出し用の三角形は `buildExportMesh` の 1 本の経路から全形式へ配る」となった。
    // 実在は記録に残すが、この実装は使わない(`writeStl.ts` 冒頭の 4 つの理由)。
    expect(oc.StlAPI).toBeTypeOf('function');
    // `typeof` で確かめるのは、静的メソッドを値として取り出すと `unbound-method` に触れるため。
    expect(typeof oc.StlAPI.Write).toBe('function');
    expect(oc.StlAPI_Writer).toBeTypeOf('function');
    console.log(
      `[実測] oc.StlAPI = ${typeof oc.StlAPI} / StlAPI.Write = ${typeof oc.StlAPI.Write}(実在するが使わない)`,
    );
  });

  it('20³ の箱をバイナリで書くと 684 バイト・三角形 12 枚になる(§2.4 の 1〜2 行目)', () => {
    const mesh = boxMesh();
    const { bytes, triangleCount, droppedTriangleCount } = writeStl([mesh], { ascii: false });
    // 84 + 50 × 12 = 684。
    expect(triangleCount).toBe(12);
    expect(droppedTriangleCount).toBe(0);
    expect(bytes.length).toBe(BINARY_HEADER_LENGTH + BINARY_TRIANGLE_LENGTH * 12);
    expect(bytes.length).toBe(684);
    // 5〜8 バイト目(uint32、リトルエンディアン)が三角形の数。
    expect(headerTriangleCount(bytes)).toBe(12);
    // 見出しは `PointerCAD` + 空白詰めで固定(時刻もファイル名も入れない。決定性)。
    expect(decode(bytes.subarray(0, 80))).toBe('PointerCAD'.padEnd(80, ' '));
    // 属性の 2 バイトは 0。
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(BINARY_HEADER_LENGTH + 48, true)).toBe(0);
    console.log(`[実測] 20³ の箱 バイナリ: ${String(bytes.length)} バイト、三角形 ${String(triangleCount)} 枚`);
  });

  it('書いたバイナリを読み直すと三角形 12 枚・体積 8000 になる(§2.4 の 3 行目)', () => {
    const { bytes } = writeStl([boxMesh()], { ascii: false });
    const read = readStl(oc, bytes);
    expect(read.triangleCount).toBe(12);
    // 平面だけなので三角形からの体積が厳密に一致する。
    expect(Math.abs(read.volume - 8000)).toBeLessThan(1e-6);
  });

  it('20³ の箱を ASCII で書くと solid で始まり endsolid で終わり facet normal が 12 行(§2.4 の 4 行目)', () => {
    const { bytes, triangleCount } = writeStl([boxMesh()], { ascii: true });
    const text = decode(bytes);
    expect(text.startsWith('solid ')).toBe(true);
    expect(text.trimEnd().endsWith('endsolid PointerCAD')).toBe(true);
    expect(countLinesStartingWith(text, 'facet normal')).toBe(12);
    expect(countLinesStartingWith(text, 'vertex')).toBe(36);
    expect(countLinesStartingWith(text, 'outer loop')).toBe(12);
    expect(countLinesStartingWith(text, 'endfacet')).toBe(12);
    expect(triangleCount).toBe(12);
    // 桁は固定(`toPrecision` は指数表記を出す)。基本形状の箱は原点が中心なので隅は ±10。
    expect(text).toContain('vertex 10.000000 10.000000 10.000000');
    expect(text).not.toMatch(/e[+-]/iu);
    console.log(`[実測] 20³ の箱 ASCII: ${String(bytes.length)} バイト、三角形 ${String(triangleCount)} 枚`);
  });

  it('ASCII とバイナリは、読み直すと同じ三角形の数と同じ体積になる(§2.4、タスク12 の検証表)', () => {
    const mesh = boxMesh();
    const binary = readStl(oc, writeStl([mesh], { ascii: false }).bytes);
    const ascii = readStl(oc, writeStl([mesh], { ascii: true }).bytes);
    expect(ascii.triangleCount).toBe(binary.triangleCount);
    expect(ascii.triangleCount).toBe(12);
    expect(Math.abs(ascii.volume - binary.volume)).toBeLessThan(1e-6);
    expect(Math.abs(ascii.volume - 8000)).toBeLessThan(1e-6);
  });

  it('ボディ 2 つ(箱 2 個)は 1 つの STL に連なり 24 枚・1284 バイトになる(タスク12 の検証表)', () => {
    const meshes = [boxMesh(0), boxMesh(60)];
    const { bytes, triangleCount } = writeStl(meshes, { ascii: false });
    expect(triangleCount).toBe(24);
    // 84 + 50 × 24 = 1284。
    expect(bytes.length).toBe(1284);
    expect(headerTriangleCount(bytes)).toBe(24);
    const read = readStl(oc, bytes);
    expect(read.triangleCount).toBe(24);
    // 離れた箱 2 個なので体積は 8000 × 2。
    expect(Math.abs(read.volume - 16000)).toBeLessThan(1e-6);
    const asciiRead = readStl(oc, writeStl(meshes, { ascii: true }).bytes);
    expect(asciiRead.triangleCount).toBe(24);
    expect(Math.abs(asciiRead.volume - 16000)).toBeLessThan(1e-6);
  });

  it('書くのは頂点の法線ではなく面の法線(箱の 12 枚はすべて軸に沿った単位ベクトル)', () => {
    const { bytes } = writeStl([boxMesh()], { ascii: false });
    for (let index = 0; index < 12; index += 1) {
      const normal = binaryFacetNormal(bytes, index);
      // 箱の面はどれも軸に垂直なので、成分は ±1 が 1 つと 0 が 2 つになる。
      const nonZero = normal.filter((value) => Math.abs(value) > 1e-6);
      expect(nonZero).toHaveLength(1);
      expect(Math.abs(Math.abs(nonZero[0]) - 1)).toBeLessThan(1e-6);
    }
  });

  it('球 r=10 を標準の対(0.1mm / 0.2rad)で書いて読み直すと、体積の不足が 1% 以内(§2.4 の 5 行目)', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      // 長さの偏差 0.1mm だけでは角度の既定 0.5rad が先に効き、不足が 1% を超える
      // (2026-09-06 実測 1.43%)。品質は長さと角度の対で持つ(統括の決定)。
      const loose = buildExportMesh(oc, handle.shape, 0.1);
      const looseRead = readStl(oc, writeStl([loose], { ascii: false }).bytes);
      const looseShortfall = (SPHERE_EXACT_VOLUME - looseRead.volume) / SPHERE_EXACT_VOLUME;
      console.log(
        `[実測] 球 r=10 長さ 0.1mm だけ(角度は既定 0.5rad): 三角形 ${String(looseRead.triangleCount)} 枚、体積 ${looseRead.volume.toFixed(6)}、不足 ${(looseShortfall * 100).toFixed(2)}%`,
      );

      const standard = buildExportMesh(oc, handle.shape, 0.1, { angularDeflectionRad: 0.2 });
      const { bytes, triangleCount, droppedTriangleCount } = writeStl([standard], { ascii: false });
      const read = readStl(oc, bytes);
      const shortfall = (SPHERE_EXACT_VOLUME - read.volume) / SPHERE_EXACT_VOLUME;
      console.log(
        `[実測] 球 r=10 標準の対(0.1mm / 0.2rad): 書いた三角形 ${String(triangleCount)} 枚(面積 0 を ${String(droppedTriangleCount)} 枚除いた)、${String(bytes.length)} バイト、体積 ${read.volume.toFixed(6)}、不足 ${(shortfall * 100).toFixed(2)}%`,
      );
      // 内接する多面体なので必ず厳密値より小さい。
      expect(read.volume).toBeLessThan(SPHERE_EXACT_VOLUME);
      expect(shortfall).toBeGreaterThan(0);
      expect(shortfall).toBeLessThan(0.01);
      expect(read.triangleCount).toBe(triangleCount);
    } finally {
      handle.delete();
    }
  });

  it('球の極の面積 0 の三角形は落ちて、落とした枚数が返る(統括の決定 ③)', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.02);
      const { bytes, triangleCount, droppedTriangleCount } = writeStl([mesh], { ascii: false });
      console.log(
        `[実測] 球 r=10 偏差 0.02: 三角形 ${String(mesh.triangleCount)} 枚のうち 面積 0 を ${String(droppedTriangleCount)} 枚落として ${String(triangleCount)} 枚書いた`,
      );
      // 極の 2 枚(2026-09-06 タスク11 の実測)。数は形と偏差で変わるので上限だけ固定する。
      expect(droppedTriangleCount).toBeGreaterThan(0);
      expect(droppedTriangleCount).toBeLessThanOrEqual(2);
      expect(triangleCount).toBe(mesh.triangleCount - droppedTriangleCount);
      expect(bytes.length).toBe(BINARY_HEADER_LENGTH + BINARY_TRIANGLE_LENGTH * triangleCount);
      expect(headerTriangleCount(bytes)).toBe(triangleCount);
    } finally {
      handle.delete();
    }
  });

  it('頂点が一致する三角形と NaN を含む三角形は落ちる(法線が NaN の STL を書かない)', () => {
    const degenerate: ExportMesh = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, Number.NaN, 0, 0]),
      normals: new Float32Array(12),
      // 1 枚目は面積を持つ。2 枚目は同じ頂点を 3 回、3 枚目は NaN を含む。
      indices: new Uint32Array([0, 1, 2, 0, 0, 0, 0, 1, 3]),
      triangleCount: 3,
    };
    const { bytes, triangleCount, droppedTriangleCount } = writeStl([degenerate], { ascii: false });
    expect(triangleCount).toBe(1);
    expect(droppedTriangleCount).toBe(2);
    expect(bytes.length).toBe(BINARY_HEADER_LENGTH + BINARY_TRIANGLE_LENGTH);
    // 残った 1 枚の法線は +Z の単位ベクトル。
    expect(binaryFacetNormal(bytes, 0)).toEqual([0, 0, 1]);
    const ascii = decode(writeStl([degenerate], { ascii: true }).bytes);
    expect(ascii).not.toContain('NaN');
    expect(countLinesStartingWith(ascii, 'facet normal')).toBe(1);
  });

  it('同じ三角形から 2 回書くとバイト列が完全に一致する(決定性、§0.62)', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius: 10, height: 20 }));
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.05);
      for (const ascii of [false, true]) {
        const first = writeStl([mesh], { ascii });
        const second = writeStl([mesh], { ascii });
        expect(second.bytes.length).toBe(first.bytes.length);
        expect(Array.from(second.bytes)).toEqual(Array.from(first.bytes));
        expect(second.triangleCount).toBe(first.triangleCount);
      }
      // 形から作り直しても同じ(`buildExportMesh` の決定性と合わせて端から端まで同じ)。
      const again = buildExportMesh(oc, handle.shape, 0.05);
      expect(Array.from(writeStl([again], { ascii: false }).bytes)).toEqual(
        Array.from(writeStl([mesh], { ascii: false }).bytes),
      );
    } finally {
      handle.delete();
    }
  });

  it('空の並びは断らずに三角形 0 枚を返す(バイナリは 84 バイト)', () => {
    const binary = writeStl([], { ascii: false });
    expect(binary.bytes.length).toBe(BINARY_HEADER_LENGTH);
    expect(binary.triangleCount).toBe(0);
    expect(binary.droppedTriangleCount).toBe(0);
    expect(headerTriangleCount(binary.bytes)).toBe(0);
    // 読み手(タスク17)は 0 枚を「面がありません」と断る(§2.8 の表)。書き手は組み立てるだけ。
    expect(() => readStl(oc, binary.bytes)).toThrow(STL_NO_FACE_MESSAGE);

    const ascii = writeStl([], { ascii: true });
    expect(decode(ascii.bytes)).toBe('solid PointerCAD\nendsolid PointerCAD\n');
    expect(ascii.triangleCount).toBe(0);
  });

  it('名前は ASCII の solid の行に出て、改行やタブは空白へ寄せる(空ならば既定)', () => {
    const mesh = boxMesh();
    const named = decode(writeStl([mesh], { ascii: true, name: '本体' }).bytes);
    expect(named.startsWith('solid 本体\n')).toBe(true);
    expect(named.trimEnd().endsWith('endsolid 本体')).toBe(true);
    const broken = decode(writeStl([mesh], { ascii: true, name: ' 本\n体\t2 ' }).bytes);
    expect(broken.startsWith('solid 本 体 2\n')).toBe(true);
    const blank = decode(writeStl([mesh], { ascii: true, name: '   ' }).bytes);
    expect(blank.startsWith('solid PointerCAD\n')).toBe(true);
    // バイナリの見出しは名前によらず固定(UTF-8 の切り詰めで壊さないため)。
    const binary = writeStl([mesh], { ascii: false, name: '本体' }).bytes;
    expect(decode(binary.subarray(0, 80))).toBe('PointerCAD'.padEnd(80, ' '));
  });

  it('円柱 r=10 h=20 を偏差 0.1 で書いて読み直すと、体積が正 n 角柱の式と一致する(§2.4 の 6 行目)', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius: 10, height: 20 }));
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.1);
      const { bytes, triangleCount } = writeStl([mesh], { ascii: false });
      const read = readStl(oc, bytes);
      // 半径 10 の円周上の節点を角度で束ねて、側面の分割数 n を数える。
      const angles: number[] = [];
      for (let index = 0; index < read.positions.length; index += 3) {
        const x = read.positions[index];
        const y = read.positions[index + 1];
        if (Math.abs(Math.hypot(x, y) - 10) > 1e-3) {
          continue;
        }
        const angle = Math.atan2(y, x);
        if (!angles.some((known) => Math.abs(known - angle) < 1e-4)) {
          angles.push(angle);
        }
      }
      const divisions = angles.length;
      // 弦のずれ 10(1 − cos(θ/2)) ≤ 0.1 → θ ≤ 0.28312 rad → n ≥ 22.19 → 23 以上。
      expect(divisions).toBeGreaterThanOrEqual(23);
      const expected = (divisions / 2) * 100 * Math.sin((2 * Math.PI) / divisions) * 20;
      console.log(
        `[実測] 円柱 r=10 h=20 偏差 0.1: 分割 n = ${String(divisions)}、三角形 ${String(triangleCount)} 枚、読み直した体積 ${read.volume.toFixed(6)}(式 ${expected.toFixed(6)})`,
      );
      expect(Math.abs(read.volume - expected) / expected).toBeLessThan(1e-5);
    } finally {
      handle.delete();
    }
  });

  it('10 万三角形の「作り直し + バイト列」が 2 秒以内に終わる(§2.17-3)', () => {
    const parts: OcctShapeHandle[] = [];
    try {
      // タスク11 と同じ見本(球 r=10 を 103 個、偏差 0.1 で 10 万枚を少し超える)。
      for (let index = 0; index < 103; index += 1) {
        parts.push(makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }, index * 30)));
      }
      const compound = makeCompound(
        oc,
        parts.map((part) => part.shape),
      );
      try {
        const start = performance.now();
        const mesh = buildExportMesh(oc, compound.shape, 0.1);
        const meshedAt = performance.now();
        const { bytes, triangleCount, droppedTriangleCount } = writeStl([mesh], { ascii: false });
        const elapsed = performance.now() - start;
        const meshMs = meshedAt - start;
        console.log(
          `[実測] 球 103 個 偏差 0.1: 三角形 ${String(triangleCount)} 枚(面積 0 を ${String(droppedTriangleCount)} 枚除いた)、${String(bytes.length)} バイト。作り直し ${meshMs.toFixed(1)} ms + バイト列 ${(elapsed - meshMs).toFixed(1)} ms = 合計 ${elapsed.toFixed(1)} ms(上限 ${String(HUNDRED_THOUSAND_TRIANGLE_BUDGET_MS)} ms)`,
        );
        expect(mesh.triangleCount).toBeGreaterThanOrEqual(100_000);
        expect(bytes.length).toBe(BINARY_HEADER_LENGTH + BINARY_TRIANGLE_LENGTH * triangleCount);
        expectWithinBudget(
          elapsed,
          HUNDRED_THOUSAND_TRIANGLE_BUDGET_MS,
          '10 万三角形の作り直し + STL のバイト列',
        );
      } finally {
        compound.delete();
      }
    } finally {
      for (const part of parts) {
        part.delete();
      }
    }
  });

  it('makeBox で作った箱でも同じ結果になる(基本形状の段を通さない経路)', () => {
    const handle = makeBox(oc, { dx: BOX_SIZE, dy: BOX_SIZE, dz: BOX_SIZE });
    try {
      const { bytes, triangleCount } = writeStl([buildExportMesh(oc, handle.shape, 0.1)], {
        ascii: false,
      });
      expect(triangleCount).toBe(12);
      expect(bytes.length).toBe(684);
      expect(Math.abs(readStl(oc, bytes).volume - 8000)).toBeLessThan(1e-6);
    } finally {
      handle.delete();
    }
  });
});
