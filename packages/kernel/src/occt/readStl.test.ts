import { expectWithinBudget } from '@pointercad/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';

import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import {
  STL_MAX_TRIANGLE_COUNT,
  STL_NO_FACE_MESSAGE,
  STL_READ_FAILED_MESSAGE,
  readStl,
  stlTooLargeMessage,
} from './readStl.js';
import { tessellate } from './tessellate.js';
import { withVirtualFileInput } from './virtualFile.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/** 10 万三角形の読み込みの上限(計画書 §2.17-4)。**この数値は緩めない。** */
const HUNDRED_THOUSAND_TRIANGLES_LIMIT_MS = 2000;

/** 半径 10 の球の厳密な体積(`4/3 · π · 10³`)。内接多面体はこれより小さくなる。 */
const EXACT_SPHERE_VOLUME = 4188.790204786391;

/**
 * 球の見本を作るときの角度の偏差(ラジアン)。
 *
 * **実測(2026-09-06):** 画面用の既定 `DEFAULT_ANGULAR_DEFLECTION`(0.5 rad)のままだと、
 * 長さの偏差 0.1mm より**角度のほうが先に効いてしまう**(三角形 976 枚・体積の誤差 1.43%)。
 * 角度を細かくしていくと 0.2 で 2,020 枚・0.72%、0.1 で 8,000 枚・0.18%、0.05 で
 * 32,202 枚・0.046% となり、0.2 以下で「長さの偏差 0.1mm が効いている」状態になる。
 * 検証表の「偏差 0.1 で相対誤差 1% 以内」は**長さの偏差が効いている前提**なので、
 * 見本は角度を 0.1 に固定して作る。
 */
const FIXTURE_ANGULAR_DEFLECTION = 0.1;

/** 三角形 1 枚(見本を組み立てるための、頂点 3 つの並び)。 */
interface Triangle {
  readonly a: readonly [number, number, number];
  readonly b: readonly [number, number, number];
  readonly c: readonly [number, number, number];
}

/**
 * 一辺 `size` の箱を 12 枚の三角形で組む(外向き、反時計回り)。
 *
 * タスク12(STL の書き出し)が未着手なので、見本は**この検査の中で自分で組む**。
 * 原点の隅に置くので、符号付き四面体の和がそのまま体積(`size³`)になる。
 */
function boxTriangles(size: number, ox = 0, oy = 0, oz = 0): Triangle[] {
  const at = (x: number, y: number, z: number): readonly [number, number, number] => [
    ox + x,
    oy + y,
    oz + z,
  ];
  const a = at(0, 0, 0);
  const b = at(size, 0, 0);
  const c = at(size, size, 0);
  const d = at(0, size, 0);
  const e = at(0, 0, size);
  const f = at(size, 0, size);
  const g = at(size, size, size);
  const h = at(0, size, size);
  return [
    { a, b: c, c: b },
    { a, b: d, c },
    { a: e, b: f, c: g },
    { a: e, b: g, c: h },
    { a, b, c: f },
    { a, b: f, c: e },
    { a: b, b: c, c: g },
    { a: b, b: g, c: f },
    { a: c, b: d, c: h },
    { a: c, b: h, c: g },
    { a: d, b: a, c: e },
    { a: d, b: e, c: h },
  ];
}

/** 三角形の面の法線(単位ベクトル)。STL のファイルに書く値。 */
function faceNormal(t: Triangle): [number, number, number] {
  const ux = t.b[0] - t.a[0];
  const uy = t.b[1] - t.a[1];
  const uz = t.b[2] - t.a[2];
  const vx = t.c[0] - t.a[0];
  const vy = t.c[1] - t.a[1];
  const vz = t.c[2] - t.a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  return length === 0 ? [0, 0, 0] : [nx / length, ny / length, nz / length];
}

/** バイナリ STL(80 バイトの見出し + 三角形の数 + 50 バイト × n)を組む。 */
function binaryStl(triangles: readonly Triangle[]): Uint8Array {
  const bytes = new Uint8Array(84 + 50 * triangles.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(80, triangles.length, true);
  let offset = 84;
  for (const triangle of triangles) {
    const values = [
      ...faceNormal(triangle),
      ...triangle.a,
      ...triangle.b,
      ...triangle.c,
    ];
    for (const value of values) {
      view.setFloat32(offset, value, true);
      offset += 4;
    }
    // 属性の 2 バイトは 0 のまま空ける。
    offset += 2;
  }
  return bytes;
}

/** ASCII STL を組む。 */
function asciiStl(triangles: readonly Triangle[]): Uint8Array {
  const lines: string[] = ['solid pointercad'];
  for (const triangle of triangles) {
    const normal = faceNormal(triangle);
    lines.push(`  facet normal ${String(normal[0])} ${String(normal[1])} ${String(normal[2])}`);
    lines.push('    outer loop');
    for (const vertex of [triangle.a, triangle.b, triangle.c]) {
      lines.push(
        `      vertex ${String(vertex[0])} ${String(vertex[1])} ${String(vertex[2])}`,
      );
    }
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push('endsolid pointercad');
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

/**
 * 半径 `radius` の球を偏差 `deflection` で三角形へ割り、バイナリ STL のバイト列にする。
 *
 * 三角形分割は実運用の `tessellate.ts` に任せる(書き出しのタスク12 はまだ無いので、
 * 出来た並びを自分でバイナリ STL の形に並べ直す)。
 */
function sphereStl(radius: number, deflection: number, angular = 0.5): Uint8Array {
  const { keep, release } = createAllocations();
  try {
    const maker = keep(new oc.BRepPrimAPI_MakeSphere_1(radius));
    const shape = keep(maker.Shape());
    const mesh = tessellate(oc, shape, {
      linearDeflection: deflection,
      angularDeflection: angular,
    });
    const triangles: Triangle[] = [];
    const vertexAt = (index: number): readonly [number, number, number] => [
      mesh.positions[index * 3],
      mesh.positions[index * 3 + 1],
      mesh.positions[index * 3 + 2],
    ];
    for (let offset = 0; offset < mesh.indices.length; offset += 3) {
      triangles.push({
        a: vertexAt(mesh.indices[offset]),
        b: vertexAt(mesh.indices[offset + 1]),
        c: vertexAt(mesh.indices[offset + 2]),
      });
    }
    return binaryStl(triangles);
  } finally {
    release();
  }
}

/** 置き場に残っているファイル名(`.` と `..` を除く)。片付けの確認に使う。 */
function remainingVirtualFiles(): string[] {
  const listed: unknown = oc.FS.readdir('/pointercad');
  const entries: readonly unknown[] = Array.isArray(listed) ? listed : [];
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string' && entry !== '.' && entry !== '..') {
      names.push(entry);
    }
  }
  return names;
}

describe('STL の読み込み(P6 タスク17)', () => {
  it('§1.5-1 の実測: oc.RWStl と ReadFile_2 が実行時に存在する', () => {
    expect(oc.RWStl).toBeTypeOf('function');
    // 静的メソッドは値として渡さない(@typescript-eslint/unbound-method)ので typeof で判定する。
    expect(typeof oc.RWStl.ReadFile_2).toBe('function');
    expect(typeof oc.RWStl.WriteBinary).toBe('function');
    expect(typeof oc.RWStl.WriteAscii).toBe('function');
  });

  it('§1.5-13 の実測: 読み込んだ Poly_Triangulation は法線を持たず、Normal_1 は投げる', () => {
    withVirtualFileInput(oc, 'probe.stl', binaryStl(boxTriangles(20)), (path) => {
      const { keep, release } = createAllocations();
      try {
        const range = keep(new oc.Message_ProgressRange_1());
        const handle = keep(oc.RWStl.ReadFile_2(path, range));
        expect(handle.IsNull()).toBe(false);
        const triangulation = handle.get();
        // STL には面ごとの法線が書いてあるが、OCCT の読み手は保持しない(実測)。
        expect(triangulation.HasNormals()).toBe(false);
        let threw = false;
        try {
          keep(triangulation.Normal_1(1));
        } catch {
          // Error ではなく数値(WASM の番地)が飛ぶので、種類は問わず「投げた」だけを見る。
          threw = true;
        }
        expect(threw).toBe(true);
        console.log(
          `[実測] HasNormals: ${String(triangulation.HasNormals())} / Normal_1(1) は投げた: ${String(threw)}`,
        );
      } finally {
        release();
      }
    });
  });

  it('バイナリの 20³ の箱は三角形 12 枚・体積 8000 になる', () => {
    const mesh = readStl(oc, binaryStl(boxTriangles(20)));
    expect(mesh.triangleCount).toBe(12);
    expect(mesh.indices).toHaveLength(36);
    // 頂点は OCCT が束ねる(36 個ぶん書いても 8 個になる)。
    expect(mesh.positions).toHaveLength(24);
    expect(mesh.volume).toBeCloseTo(8000, 6);
  });

  it('ASCII の 20³ の箱も三角形 12 枚・体積 8000 になる', () => {
    const mesh = readStl(oc, asciiStl(boxTriangles(20)));
    expect(mesh.triangleCount).toBe(12);
    expect(mesh.positions).toHaveLength(24);
    expect(mesh.volume).toBeCloseTo(8000, 6);
  });

  it('体積は三角形の並びだけから決まる(位置をずらしても同じ)', () => {
    // 発散定理の和は原点の取り方に依らない(閉じた形なら平行移動で変わらない)。
    const moved = readStl(oc, binaryStl(boxTriangles(20, 100, -50, 7)));
    expect(moved.volume).toBeCloseTo(8000, 5);
  });

  it('法線はすべて単位ベクトルで、頂点の数と揃う', () => {
    const mesh = readStl(oc, binaryStl(boxTriangles(20)));
    expect(mesh.normals).toHaveLength(mesh.positions.length);
    for (let base = 0; base < mesh.normals.length; base += 3) {
      const length = Math.hypot(mesh.normals[base], mesh.normals[base + 1], mesh.normals[base + 2]);
      expect(length).toBeCloseTo(1, 6);
    }
  });

  it('半径 10 の球(偏差 0.1)は厳密な体積より小さく、相対誤差 1% 以内', () => {
    const mesh = readStl(oc, sphereStl(10, 0.1, FIXTURE_ANGULAR_DEFLECTION));
    const relativeError = (EXACT_SPHERE_VOLUME - mesh.volume) / EXACT_SPHERE_VOLUME;
    console.log(
      `[実測] 球 r10 偏差 0.1: 三角形 ${String(mesh.triangleCount)} 枚、体積 ${mesh.volume.toFixed(6)}(厳密 ${String(EXACT_SPHERE_VOLUME)}、相対誤差 ${(relativeError * 100).toFixed(4)}%)`,
    );
    // 内接多面体なので必ず小さくなる。
    expect(mesh.volume).toBeLessThan(EXACT_SPHERE_VOLUME);
    expect(relativeError).toBeLessThan(0.01);
  });

  it('三角形 0 枚(84 バイトちょうど)は「この形には面がありません。」で断る', () => {
    const bytes = binaryStl([]);
    expect(bytes).toHaveLength(84);
    expect(() => readStl(oc, bytes)).toThrow(STL_NO_FACE_MESSAGE);
  });

  it('84 バイト未満は「このファイルを読めませんでした。」で断る', () => {
    expect(() => readStl(oc, new Uint8Array(83))).toThrow(STL_READ_FAILED_MESSAGE);
    expect(() => readStl(oc, new Uint8Array(0))).toThrow(STL_READ_FAILED_MESSAGE);
  });

  it('壊れたバイト列は「このファイルを読めませんでした。」で断る(例外は飛ばない)', () => {
    // 長さは足りるが中身が STL でないもの。OCCT は投げずに空の Handle を返す(実測)。
    const garbage = new Uint8Array(400).fill(0xab);
    new DataView(garbage.buffer).setUint32(80, 999, true);
    expect(() => readStl(oc, garbage)).toThrow(STL_READ_FAILED_MESSAGE);
  });

  it('三角形 500 万超は「この形は大きすぎて開けません」で断る(実データは作らない)', () => {
    // 500 万枚ぶんのバイト列は約 250MB になり、断るためだけに WASM の記憶を食い尽くす。
    // 頭に書いてある個数だけが大きい 84 バイトの偽物で、読む前の門が働くことを確かめる。
    const fake = new Uint8Array(84);
    const claimed = STL_MAX_TRIANGLE_COUNT + 1;
    new DataView(fake.buffer).setUint32(80, claimed, true);
    expect(() => readStl(oc, fake)).toThrow(stlTooLargeMessage(claimed));
    expect(stlTooLargeMessage(claimed)).toBe('この形は大きすぎて開けません(三角形が 5000001 個)。');
  });

  it('頭の個数だけが大きい壊れたファイルも「大きすぎる」で断る(割り切りを固定する)', () => {
    // 80〜83 バイト目がたまたま大きな数になっている壊れたファイルは、「壊れている」ではなく
    // 「大きすぎる」で断る。実際の三角形の並びを読まないと区別できず、読めば断るためだけに
    // 記憶を食う。どちらにしても開けないので、記憶を食わないほうを採る(readStl.ts の注釈)。
    const garbage = new Uint8Array(400).fill(0xcd);
    expect(() => readStl(oc, garbage)).toThrow(stlTooLargeMessage(0xcdcdcdcd));
  });

  it('上限ちょうど(500 万)は大きすぎるとは言わない', () => {
    const fake = new Uint8Array(84);
    new DataView(fake.buffer).setUint32(80, STL_MAX_TRIANGLE_COUNT, true);
    // 実際の中身が無いので読み込みは失敗するが、**大きすぎるとは言わない**ことを確かめる。
    expect(() => readStl(oc, fake)).toThrow(STL_READ_FAILED_MESSAGE);
  });

  it('読み込みのあと仮想の置き場が空になる(壊れた入力でも残さない)', () => {
    readStl(oc, binaryStl(boxTriangles(20)));
    expect(remainingVirtualFiles()).toEqual([]);
    const broken = new Uint8Array(400).fill(0xcd);
    // 頭の個数だけは上限の内側に直す(でないと「大きすぎる」の門で先に断られ、
    // OCCT へ渡らないので置き場の片付けを確かめられない)。
    new DataView(broken.buffer).setUint32(80, 6, true);
    expect(() => readStl(oc, broken)).toThrow(STL_READ_FAILED_MESSAGE);
    expect(remainingVirtualFiles()).toEqual([]);
  });

  it('続けて 20 回読んでも結果が変わらない(解放漏れの見張り。rules/06 10.13)', () => {
    const bytes = binaryStl(boxTriangles(20));
    const first = readStl(oc, bytes);
    const started = performance.now();
    for (let count = 0; count < 20; count += 1) {
      const mesh = readStl(oc, bytes);
      expect(mesh.triangleCount).toBe(first.triangleCount);
      expect(mesh.volume).toBeCloseTo(first.volume, 9);
    }
    console.log(`[実測] 箱の読み込み 20 回: ${(performance.now() - started).toFixed(1)} ms`);
    expect(remainingVirtualFiles()).toEqual([]);
  });

  it('10 万三角形の読み込みが 2 秒以内(§2.17-4)', () => {
    // 箱 8334 個を離して並べて 100,008 枚にする(球を細かく割るより枚数を狙って作れる)。
    const triangles: Triangle[] = [];
    const perRow = 21;
    for (let index = 0; index < 8334; index += 1) {
      const x = (index % perRow) * 30;
      const y = (Math.floor(index / perRow) % perRow) * 30;
      const z = Math.floor(index / (perRow * perRow)) * 30;
      triangles.push(...boxTriangles(20, x, y, z));
    }
    expect(triangles).toHaveLength(100008);
    const bytes = binaryStl(triangles);
    expect(bytes).toHaveLength(84 + 50 * 100008);

    const started = performance.now();
    const mesh = readStl(oc, bytes);
    const elapsed = performance.now() - started;
    console.log(
      `[実測] 10 万三角形(${String(bytes.length)} バイト)の読み込み: ${elapsed.toFixed(1)} ms(上限 ${String(HUNDRED_THOUSAND_TRIANGLES_LIMIT_MS)} ms)`,
    );
    expect(mesh.triangleCount).toBe(100008);
    // 箱 8334 個ぶんの体積(1 個 8000)。三角形の並びから正しく積み上がっていることの確認。
    expect(mesh.volume).toBeCloseTo(8334 * 8000, 0);
    expectWithinBudget(elapsed, HUNDRED_THOUSAND_TRIANGLES_LIMIT_MS, '10 万三角形の STL の読み込み');
  });
});
