import { expectWithinBudget } from '@pointercad/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';

import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import {
  CAF_MESH_MAX_TRIANGLE_COUNT,
  CAF_MESH_NO_SHAPE_MESSAGE,
  CAF_MESH_READ_FAILED_MESSAGE,
  cafMeshTooLargeMessage,
  readCafMesh,
} from './readCafMesh.js';
import { withVirtualFileInput } from './virtualFile.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/** 10 万三角形の読み込みの上限(計画書 §2.17-4。タスク17 の STL と同じ)。**緩めない。** */
const HUNDRED_THOUSAND_TRIANGLES_LIMIT_MS = 2000;

/**
 * 箱 1 つぶんの頂点(8 個)と三角形(12 枚)。
 *
 * タスク13(OBJ / glTF の書き出し)が未着手なので、**見本はこの検査の中で自分で組む**。
 * 並びと向きはタスク17(`readStl.test.ts`)の `boxTriangles` と同じ——原点の隅に置いた
 * 外向きの箱なので、符号付き四面体の和がそのまま体積(`size³`)になる。
 */
const BOX_FACES: readonly (readonly [number, number, number])[] = [
  [0, 2, 1],
  [0, 3, 2],
  [4, 5, 6],
  [4, 6, 7],
  [0, 1, 5],
  [0, 5, 4],
  [1, 2, 6],
  [1, 6, 5],
  [2, 3, 7],
  [2, 7, 6],
  [3, 0, 4],
  [3, 4, 7],
];

/** 一辺 `size` の箱の 8 頂点(`ox, oy, oz` の隅に置く)。 */
function boxVertices(
  size: number,
  ox = 0,
  oy = 0,
  oz = 0,
): readonly (readonly [number, number, number])[] {
  return [
    [ox, oy, oz],
    [ox + size, oy, oz],
    [ox + size, oy + size, oz],
    [ox, oy + size, oz],
    [ox, oy, oz + size],
    [ox + size, oy, oz + size],
    [ox + size, oy + size, oz + size],
    [ox, oy + size, oz + size],
  ];
}

/** 箱 1 つぶんの指定。 */
interface BoxSpec {
  readonly size: number;
  readonly ox?: number;
  readonly oy?: number;
  readonly oz?: number;
}

/**
 * 箱を並べた OBJ を文字列で組む(`v` が 8 行・`f` が 12 行 ×箱の数)。
 *
 * `withNormals` が真なら `vn` を書いて `f v//vn` の形にする。**OCCT の読み手が
 * 法線を保持するか**を確かめるための見本(検査の中で実測を記録する)。
 */
function objBoxes(boxes: readonly BoxSpec[], withNormals = false): Uint8Array {
  const lines: string[] = ['# PointerCAD test fixture'];
  const normals: (readonly [number, number, number])[] = [];
  const faceLines: string[] = [];
  let vertexBase = 0;

  for (const box of boxes) {
    const vertices = boxVertices(box.size, box.ox, box.oy, box.oz);
    for (const vertex of vertices) {
      lines.push(`v ${String(vertex[0])} ${String(vertex[1])} ${String(vertex[2])}`);
    }
    for (const face of BOX_FACES) {
      const a = vertices[face[0]];
      const b = vertices[face[1]];
      const c = vertices[face[2]];
      const numbers = face.map((index) => vertexBase + index + 1);
      if (withNormals) {
        const ux = b[0] - a[0];
        const uy = b[1] - a[1];
        const uz = b[2] - a[2];
        const vx = c[0] - a[0];
        const vy = c[1] - a[1];
        const vz = c[2] - a[2];
        const nx = uy * vz - uz * vy;
        const ny = uz * vx - ux * vz;
        const nz = ux * vy - uy * vx;
        const length = Math.hypot(nx, ny, nz);
        normals.push([nx / length, ny / length, nz / length]);
        const normalNumber = normals.length;
        faceLines.push(
          `f ${numbers.map((n) => `${String(n)}//${String(normalNumber)}`).join(' ')}`,
        );
      } else {
        faceLines.push(`f ${numbers.map((n) => String(n)).join(' ')}`);
      }
    }
    vertexBase += vertices.length;
  }

  for (const normal of normals) {
    lines.push(`vn ${String(normal[0])} ${String(normal[1])} ${String(normal[2])}`);
  }
  lines.push(...faceLines);
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

/**
 * 箱を並べた GLB(バイナリ glTF)を手で組む。
 *
 * **タスク13 の書き手(`RWGltf_CafWriter`)を使わない理由:** タスク13 は未着手で、
 * 書き手が何を書くかがまだ決まっていない。**単位の検証(0.02m → 20mm)は「ファイルに
 * 何が入っているか」を 1 バイト単位で決められないと成立しない**ので、見本を自分で組む。
 *
 * 形は仕様どおりの最小構成: 12 バイトの頭(`glTF` / 版 2 / 全長)+ JSON チャンク
 * (asset / scene / scenes / nodes / meshes / accessors / bufferViews / buffers)+
 * BIN チャンク(位置 float32 ×3 ×8頂点、添字 uint16 ×36)。**glTF の単位は m** なので、
 * 20mm の箱は 0.02 で書く。
 */
function glbBoxes(boxes: readonly BoxSpec[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  const accessors: unknown[] = [];
  const bufferViews: unknown[] = [];
  const meshes: unknown[] = [];
  const nodes: unknown[] = [];
  let offset = 0;

  for (const box of boxes) {
    const vertices = boxVertices(box.size, box.ox, box.oy, box.oz);
    const positions = new Float32Array(vertices.flatMap((vertex) => [...vertex]));
    const indices = new Uint16Array(BOX_FACES.flatMap((face) => [...face]));
    chunks.push(new Uint8Array(positions.buffer));
    chunks.push(new Uint8Array(indices.buffer));

    const positionView = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: positions.byteLength,
      target: 34962,
    });
    offset += positions.byteLength;
    const indexView = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: indices.byteLength,
      target: 34963,
    });
    offset += indices.byteLength;

    const positionAccessor = accessors.length;
    accessors.push({
      bufferView: positionView,
      componentType: 5126,
      count: vertices.length,
      type: 'VEC3',
      min: [...vertices[0]],
      max: [...vertices[6]],
    });
    const indexAccessor = accessors.length;
    accessors.push({
      bufferView: indexView,
      componentType: 5123,
      count: indices.length,
      type: 'SCALAR',
    });

    nodes.push({ mesh: meshes.length });
    meshes.push({
      primitives: [
        { attributes: { POSITION: positionAccessor }, indices: indexAccessor, mode: 4 },
      ],
    });
  }

  const bin = new Uint8Array(offset);
  let cursor = 0;
  for (const chunk of chunks) {
    bin.set(chunk, cursor);
    cursor += chunk.length;
  }

  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_node, index) => index) }],
    nodes,
    meshes,
    accessors,
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  const jsonRaw = new TextEncoder().encode(JSON.stringify(json));
  // チャンクは 4 バイト境界に揃える決まり。JSON は空白、BIN は 0 で埋める。
  const jsonBytes = new Uint8Array(jsonRaw.length + ((4 - (jsonRaw.length % 4)) % 4));
  jsonBytes.fill(0x20);
  jsonBytes.set(jsonRaw);
  const binBytes = new Uint8Array(bin.length + ((4 - (bin.length % 4)) % 4));
  binBytes.set(bin);

  const total = 12 + 8 + jsonBytes.length + 8 + binBytes.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  view.setUint32(20 + jsonBytes.length, binBytes.length, true);
  view.setUint32(24 + jsonBytes.length, 0x004e4942, true); // 'BIN\0'
  out.set(binBytes, 28 + jsonBytes.length);
  return out;
}

/** 位置の並びから座標の最小・最大を求める(単位の検査に使う)。 */
function bounds(positions: Float32Array): { min: number; max: number } {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of positions) {
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return { min, max };
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

describe('OBJ / glTF の読み込み(P6 タスク18)', () => {
  it('§1.5-1 の実測: 読み手が実行時に存在する', () => {
    expect(oc.RWObj_CafReader).toBeTypeOf('function');
    expect(oc.RWGltf_CafReader).toBeTypeOf('function');
    expect(oc.RWMesh_CafReader).toBeTypeOf('function');
    // 書き出し(タスク13)の相手も同じ実測でまとめて確かめておく。
    expect(oc.RWObj_CafWriter).toBeTypeOf('function');
    expect(oc.RWGltf_CafWriter).toBeTypeOf('function');
  });

  it('§1.5-12 の実測: SetDocument なしで Perform が成功し、三角形分割が最初から付いている', () => {
    withVirtualFileInput(oc, 'probe.obj', objBoxes([{ size: 20 }]), (path) => {
      const { keep, release } = createAllocations();
      try {
        const reader = keep(new oc.RWObj_CafReader());
        // 単位を持たない形式なので、読む前は受け手も送り手も -1(倍率を掛けない)。
        expect(reader.SystemLengthUnit()).toBe(-1);
        expect(reader.FileLengthUnit()).toBe(-1);
        // 受け手側の座標系は最初から未設定なので、回転は掛からない(列挙を使わずに済む)。
        expect(reader.HasSystemCoordinateSystem()).toBe(false);

        const range = keep(new oc.Message_ProgressRange_1());
        // 型定義の XCAFDoc_PartId は any だが、実行時の束縛は TCollection_AsciiString。
        // 素の文字列を渡すと embind が断る(この落とし穴を検査で固定する)。
        let bindingError: unknown = undefined;
        try {
          reader.Perform(path, range);
        } catch (error) {
          bindingError = error;
        }
        expect(bindingError).toBeDefined();

        // SetDocument は呼ばない。
        const performed = reader.Perform(keep(new oc.TCollection_AsciiString_2(path)), range);
        expect(performed).toBe(true);

        const shape = keep(reader.SingleShape());
        expect(shape.IsNull()).toBe(false);

        const map = keep(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_2(shape, map, true, true);
        const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
        let faceCount = 0;
        let triangulated = 0;
        let hasNormals = true;
        for (let index = 1; index <= map.Size(); index += 1) {
          const subShape = keep(map.FindKey(index));
          if (subShape.ShapeType() !== faceType) {
            continue;
          }
          faceCount += 1;
          const face = keep(oc.TopoDS.Face_1(subShape));
          const location = keep(new oc.TopLoc_Location_1());
          const handle = keep(oc.BRep_Tool.Triangulation(face, location, 0));
          if (!handle.IsNull()) {
            triangulated += 1;
            hasNormals = hasNormals && handle.get().HasNormals();
          }
        }
        console.log(
          `[実測] SetDocument なしの Perform: ${String(performed)} / 面 ${String(faceCount)} 枚のうち三角形分割あり ${String(triangulated)} 枚 / HasNormals ${String(hasNormals)}`,
        );
        // 三角形分割が最初から付いているので BRepMesh_IncrementalMesh は掛けない。
        expect(faceCount).toBe(1);
        expect(triangulated).toBe(1);
        // 法線は保持されないので、こちらで三角形から計算する。
        expect(hasNormals).toBe(false);
      } finally {
        release();
      }
    });
  });

  it('実測: `vn` を書いた OBJ は法線が残り、節点が面ごとに分かれる', () => {
    withVirtualFileInput(oc, 'normals.obj', objBoxes([{ size: 20 }], true), (path) => {
      const { keep, release } = createAllocations();
      try {
        const reader = keep(new oc.RWObj_CafReader());
        const range = keep(new oc.Message_ProgressRange_1());
        expect(reader.Perform(keep(new oc.TCollection_AsciiString_2(path)), range)).toBe(true);
        const shape = keep(reader.SingleShape());
        const map = keep(new oc.TopTools_IndexedMapOfShape_1());
        oc.TopExp.MapShapes_2(shape, map, true, true);
        const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
        for (let index = 1; index <= map.Size(); index += 1) {
          const subShape = keep(map.FindKey(index));
          if (subShape.ShapeType() !== faceType) {
            continue;
          }
          const face = keep(oc.TopoDS.Face_1(subShape));
          const location = keep(new oc.TopLoc_Location_1());
          const handle = keep(oc.BRep_Tool.Triangulation(face, location, 0));
          expect(handle.IsNull()).toBe(false);
          const triangulation = handle.get();
          expect(triangulation.HasNormals()).toBe(true);
          const first = keep(triangulation.Normal_1(1));
          console.log(
            `[実測] vn ありの OBJ: HasNormals=${String(triangulation.HasNormals())} 節点${String(triangulation.NbNodes())} 三角形${String(triangulation.NbTriangles())} Normal_1(1)=(${String(first.X())}, ${String(first.Y())}, ${String(first.Z())})`,
          );
          // 面ごとに違う法線を持たせるため、OCCT は節点を分ける(8 → 36)。
          expect(Number(triangulation.NbNodes())).toBe(36);
          expect(Number(triangulation.NbTriangles())).toBe(12);
          // 1 番目の三角形は底面なので、外向きの法線は -Z。
          expect(first.X()).toBeCloseTo(0, 9);
          expect(first.Y()).toBeCloseTo(0, 9);
          expect(first.Z()).toBeCloseTo(-1, 9);
        }
      } finally {
        release();
      }
    });
  });

  it('20³ の箱の .obj は三角形 12 枚・体積 8000 になる', () => {
    const mesh = readCafMesh(oc, objBoxes([{ size: 20 }]), { format: 'obj' });
    expect(mesh.triangleCount).toBe(12);
    expect(mesh.indices).toHaveLength(36);
    // 頂点は 8 個のまま(OBJ の `f` が同じ番号を指すので束ね直しは起きない)。
    expect(mesh.positions).toHaveLength(24);
    expect(mesh.volume).toBeCloseTo(8000, 6);
    // OBJ は単位を持たないので、書いた数がそのまま mm になる。
    expect(bounds(mesh.positions)).toEqual({ min: 0, max: 20 });
  });

  it('20mm の箱の .glb(0.02m)は三角形 12 枚・体積 8000 になる', () => {
    const mesh = readCafMesh(oc, glbBoxes([{ size: 0.02 }]), { format: 'gltf' });
    expect(mesh.triangleCount).toBe(12);
    expect(mesh.positions).toHaveLength(24);
    // glTF は float32 なので誤差が大きい(計画書の検証表は ±1e-3)。
    expect(mesh.volume).toBeCloseTo(8000, 3);
  });

  it('glTF の単位: 0.02(m)が 20(mm)になる', () => {
    const mesh = readCafMesh(oc, glbBoxes([{ size: 0.02 }]), { format: 'gltf' });
    const { min, max } = bounds(mesh.positions);
    console.log(`[実測] glb の 0.02m の箱: 座標 ${String(min)} 〜 ${String(max)} mm`);
    expect(min).toBe(0);
    // OCCT が節点を作る前に 1000 倍するので、float32 への丸めが 1 度で済んでちょうど 20 になる
    // (読んでから自分で 1000 倍すると 19.999999552965164 になる)。
    expect(max).toBe(20);
  });

  it('壊れた .glb は「このファイルを読めませんでした。」で断る(例外は飛ばない)', () => {
    const garbage = new Uint8Array(256).fill(0xab);
    expect(() => readCafMesh(oc, garbage, { format: 'gltf' })).toThrow(
      CAF_MESH_READ_FAILED_MESSAGE,
    );
    // 頭だけ glTF に見せかけて中身が壊れているものも同じ断りになる。
    const fakeHeader = new Uint8Array(64);
    new DataView(fakeHeader.buffer).setUint32(0, 0x46546c67, true);
    new DataView(fakeHeader.buffer).setUint32(4, 2, true);
    new DataView(fakeHeader.buffer).setUint32(8, fakeHeader.length, true);
    expect(() => readCafMesh(oc, fakeHeader, { format: 'gltf' })).toThrow(
      CAF_MESH_READ_FAILED_MESSAGE,
    );
  });

  it('形の入っていない .obj は「このファイルには形が入っていません。」で断る', () => {
    // 面が 1 つも無いもの(注釈だけ / 頂点だけ)は Perform が true を返して空の形になる。
    const commentOnly = new TextEncoder().encode('# nothing here\n');
    expect(() => readCafMesh(oc, commentOnly, { format: 'obj' })).toThrow(
      CAF_MESH_NO_SHAPE_MESSAGE,
    );
    const verticesOnly = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\n');
    expect(() => readCafMesh(oc, verticesOnly, { format: 'obj' })).toThrow(
      CAF_MESH_NO_SHAPE_MESSAGE,
    );
    // 0 バイトのファイルだけは Perform が false を返す(OCCT が「開けない」と扱う)ので、
    // 「形が入っていない」ではなく「読めませんでした」になる(実測。どちらも断りである)。
    expect(() => readCafMesh(oc, new Uint8Array(0), { format: 'obj' })).toThrow(
      CAF_MESH_READ_FAILED_MESSAGE,
    );
  });

  it('法線はすべて単位ベクトルで、頂点の数と揃う', () => {
    for (const mesh of [
      readCafMesh(oc, objBoxes([{ size: 20 }]), { format: 'obj' }),
      readCafMesh(oc, glbBoxes([{ size: 0.02 }]), { format: 'gltf' }),
    ]) {
      expect(mesh.normals).toHaveLength(mesh.positions.length);
      for (let base = 0; base < mesh.normals.length; base += 3) {
        const length = Math.hypot(
          mesh.normals[base],
          mesh.normals[base + 1],
          mesh.normals[base + 2],
        );
        expect(length).toBeCloseTo(1, 6);
      }
    }
  });

  it('ファイルに法線があればそれを使い、無ければ三角形から計算する', () => {
    // `vn` あり: OCCT が節点を面ごとに分けるので、法線は軸に揃った平らな面の向きになる。
    const withNormals = readCafMesh(oc, objBoxes([{ size: 20 }], true), { format: 'obj' });
    expect(withNormals.positions).toHaveLength(36 * 3);
    for (let base = 0; base < withNormals.normals.length; base += 3) {
      const components = [
        withNormals.normals[base],
        withNormals.normals[base + 1],
        withNormals.normals[base + 2],
      ];
      // 平らな面の法線は必ず 1 成分だけが ±1 になる(平均を取っていない証拠)。
      expect(components.filter((value) => Math.abs(Math.abs(value) - 1) < 1e-6)).toHaveLength(1);
    }

    // `vn` なし: 節点は 8 個のままなので、隅の法線は隣り合う 3 面の平均(斜め)になる。
    // 成分の値は面積の重みで決まる(箱の隅では面ごとに触れる三角形の枚数が違うため
    // 1/√3 の対称な値にはならない)ので、**軸に揃っていないこと**だけを固定する。
    const computed = readCafMesh(oc, objBoxes([{ size: 20 }]), { format: 'obj' });
    expect(computed.positions).toHaveLength(8 * 3);
    for (let base = 0; base < computed.normals.length; base += 3) {
      const components = [
        computed.normals[base],
        computed.normals[base + 1],
        computed.normals[base + 2],
      ];
      expect(components.filter((value) => Math.abs(value) > 1e-6)).toHaveLength(3);
      expect(components.filter((value) => Math.abs(Math.abs(value) - 1) < 1e-6)).toHaveLength(0);
    }
  });

  it('OBJ の法線あり/なしで体積も三角形の数も変わらない', () => {
    const plain = readCafMesh(oc, objBoxes([{ size: 20 }]), { format: 'obj' });
    const withNormals = readCafMesh(oc, objBoxes([{ size: 20 }], true), { format: 'obj' });
    expect(withNormals.triangleCount).toBe(plain.triangleCount);
    expect(withNormals.volume).toBeCloseTo(plain.volume, 9);
    expect(withNormals.volume).toBeCloseTo(8000, 6);
  });

  it('メッシュを 2 つ持つ .glb は三角形 24 枚・体積 16000 になる', () => {
    const bytes = glbBoxes([{ size: 0.02 }, { size: 0.02, ox: 0.05 }]);
    const mesh = readCafMesh(oc, bytes, { format: 'gltf' });
    expect(mesh.triangleCount).toBe(24);
    expect(mesh.positions).toHaveLength(48);
    // 離れた 2 つの閉じた箱なので、発散定理の和は体積の和になる。
    expect(mesh.volume).toBeCloseTo(16000, 3);
  });

  it('箱を 2 つ並べた .obj も三角形 24 枚・体積 16000 になる', () => {
    const mesh = readCafMesh(oc, objBoxes([{ size: 20 }, { size: 20, ox: 50 }]), {
      format: 'obj',
    });
    expect(mesh.triangleCount).toBe(24);
    expect(mesh.volume).toBeCloseTo(16000, 6);
  });

  it('体積は三角形の並びだけから決まる(位置をずらしても同じ)', () => {
    const moved = readCafMesh(oc, objBoxes([{ size: 20, ox: 100, oy: -50, oz: 7 }]), {
      format: 'obj',
    });
    expect(moved.volume).toBeCloseTo(8000, 5);
  });

  it('三角形 500 万超の断りの文言(タスク17 と同じ数え方・同じ形)', () => {
    expect(CAF_MESH_MAX_TRIANGLE_COUNT).toBe(5_000_000);
    expect(cafMeshTooLargeMessage(CAF_MESH_MAX_TRIANGLE_COUNT + 1)).toBe(
      'この形は大きすぎて開けません(三角形が 5000001 個)。',
    );
  });

  it('読み込みのあと仮想の置き場が空になる(壊れた入力でも残さない)', () => {
    readCafMesh(oc, objBoxes([{ size: 20 }]), { format: 'obj' });
    expect(remainingVirtualFiles()).toEqual([]);
    expect(() => readCafMesh(oc, new Uint8Array(256).fill(0xab), { format: 'gltf' })).toThrow(
      CAF_MESH_READ_FAILED_MESSAGE,
    );
    expect(remainingVirtualFiles()).toEqual([]);
  });

  it('続けて 20 回読んでも結果が変わらない(解放漏れの見張り。rules/06 10.13)', () => {
    const objBytes = objBoxes([{ size: 20 }]);
    const glbBytes = glbBoxes([{ size: 0.02 }]);
    const started = performance.now();
    for (let count = 0; count < 20; count += 1) {
      expect(readCafMesh(oc, objBytes, { format: 'obj' }).volume).toBeCloseTo(8000, 6);
      expect(readCafMesh(oc, glbBytes, { format: 'gltf' }).volume).toBeCloseTo(8000, 3);
    }
    console.log(`[実測] 箱の読み込み 20 往復(obj + glb): ${(performance.now() - started).toFixed(1)} ms`);
    expect(remainingVirtualFiles()).toEqual([]);
  });

  it('10 万三角形の .obj の読み込みが 2 秒以内(§2.17-4)', () => {
    // 箱 8334 個を離して並べて 100,008 枚にする(タスク17 の STL の検査と同じ組み方)。
    const boxes: BoxSpec[] = [];
    const perRow = 21;
    for (let index = 0; index < 8334; index += 1) {
      boxes.push({
        size: 20,
        ox: (index % perRow) * 30,
        oy: (Math.floor(index / perRow) % perRow) * 30,
        oz: Math.floor(index / (perRow * perRow)) * 30,
      });
    }
    const bytes = objBoxes(boxes);

    const started = performance.now();
    const mesh = readCafMesh(oc, bytes, { format: 'obj' });
    const elapsed = performance.now() - started;
    console.log(
      `[実測] 10 万三角形の OBJ(${String(bytes.length)} バイト)の読み込み: ${elapsed.toFixed(1)} ms(上限 ${String(HUNDRED_THOUSAND_TRIANGLES_LIMIT_MS)} ms)`,
    );
    expect(mesh.triangleCount).toBe(100008);
    // 箱 8334 個ぶんの体積(1 個 8000)。三角形の並びから正しく積み上がっていることの確認。
    expect(mesh.volume).toBeCloseTo(8334 * 8000, 0);
    expectWithinBudget(elapsed, HUNDRED_THOUSAND_TRIANGLES_LIMIT_MS, '10 万三角形の OBJ の読み込み');
  });
});
