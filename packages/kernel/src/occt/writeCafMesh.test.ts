import { beforeAll, describe, expect, it } from 'vitest';

import type { PrimitiveShapeSpec, PrimitiveStepSpec } from '../types.js';
import type { ExportMesh } from './exportMesh.js';
import { buildExportMesh } from './exportMesh.js';
import { loadOcctForNode } from './loadOcct.node.js';
import type { OcctShapeHandle } from './makeBox.js';
import { makePrimitive } from './makePrimitive.js';
import type { CafMeshFormat } from './readCafMesh.js';
import { CAF_MESH_NO_SHAPE_MESSAGE, readCafMesh } from './readCafMesh.js';
import { faceAt } from './subShapes.js';
import { makeCompound } from './transformShape.js';
import type { CafMeshBody } from './writeCafMesh.js';
import { DEFAULT_BODY_COLOR, MESH_NO_FACE_RANGES_MESSAGE, writeCafMesh } from './writeCafMesh.js';
import { forEachExportTriangle, writeStl } from './writeStl.js';
import type { RgbTuple } from './xcafDocument.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/** 20³ の箱(計画書 §2.4 の検証表と同じ見本)。 */
const BOX_SIZE = 20;

/** 基本形状の段の依頼を 1 つ作る(`writeStl.test.ts` と同じ組み立て)。 */
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

/** バイト列を UTF-8 の文字列として読む。 */
function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** 行の先頭(空白を落としたもの)が語で始まる行を数える。 */
function countLinesStartingWith(text: string, word: string): number {
  return text.split('\n').filter((line) => line.trim().startsWith(`${word} `)).length;
}

/** 文字列の中に語が何回出るか。 */
function countOccurrences(text: string, word: string): number {
  return text.split(word).length - 1;
}

/**
 * GLB を頭・JSON チャンク・BIN チャンクへ切り分ける。
 *
 * **JSON は文字列のまま調べる。** `JSON.parse` の戻りは `any` なので、そこから欄をたどると
 * `no-unsafe-member-access` に触れる(型を絞るには述語ガードが要り、それは増やさない決まり)。
 * 文字列と正規表現で確かめれば「ファイルに何が書いてあるか」を直接固定できる。
 */
function splitGlb(bytes: Uint8Array): {
  readonly magic: string;
  readonly version: number;
  readonly totalLength: number;
  readonly json: string;
  readonly bin: DataView | null;
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  const json = decode(bytes.subarray(20, 20 + jsonLength));
  const binChunkStart = 20 + jsonLength;
  let bin: DataView | null = null;
  if (binChunkStart + 8 <= bytes.byteLength) {
    const binLength = view.getUint32(binChunkStart, true);
    bin = new DataView(
      bytes.buffer,
      bytes.byteOffset + binChunkStart + 8,
      Math.min(binLength, bytes.byteLength - binChunkStart - 8),
    );
  }
  return {
    magic: decode(bytes.subarray(0, 4)),
    version: view.getUint32(4, true),
    totalLength: view.getUint32(8, true),
    json,
    bin,
  };
}

/** JSON の中の `"<key>":[...]` を数の並びとして取り出す(最初の 1 つ)。 */
function numbersOf(json: string, key: string): number[] {
  const matched = new RegExp(`"${key}":\\[([^\\]]*)\\]`, 'u').exec(json);
  if (matched === null) {
    return [];
  }
  return matched[1].split(',').map((piece) => Number(piece));
}

/**
 * sRGB(0〜1)→ 線形。**実装とは別に、検証表(§2.5)の式からここで組み直す。**
 * 同じ関数を輸入して比べると「実装が間違っていても検査が通る」ことになる。
 */
function expectedLinear(srgb: number): number {
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

describe('OBJ / glTF の書き出し(FR-803 / FR-1106、P6 タスク13)', () => {
  it('§1.5-1 の実測: RWObj_CafWriter / RWGltf_CafWriter は実在する(記録するだけで使わない)', () => {
    // 統括の決定(2026-09-06)により、書き出し用の三角形は `buildExportMesh` の 1 本の
    // 経路から全形式へ配る。OCCT の XCAF の書き手は使わないが、実在は記録に残す。
    expect(oc.RWObj_CafWriter).toBeTypeOf('function');
    expect(oc.RWGltf_CafWriter).toBeTypeOf('function');
    console.log(
      `[実測] oc.RWObj_CafWriter = ${typeof oc.RWObj_CafWriter} / oc.RWGltf_CafWriter = ${typeof oc.RWGltf_CafWriter}(実在するが使わない)`,
    );
  });

  it('20³ の箱の .glb は先頭 4 バイトが glTF・版 2・全長が書いてある(glTF の仕様)', () => {
    const { files, triangleCount, droppedTriangleCount } = writeCafMesh(
      [{ mesh: boxMesh(), name: null, color: null }],
      { format: 'gltf' },
    );
    expect(files).toHaveLength(1);
    expect(files[0].fileName).toBe('model.glb');
    const glb = splitGlb(files[0].bytes);
    expect(glb.magic).toBe('glTF');
    expect(glb.version).toBe(2);
    expect(glb.totalLength).toBe(files[0].bytes.length);
    // チャンクは 4 バイト境界に揃う決まり。
    expect(files[0].bytes.length % 4).toBe(0);
    expect(triangleCount).toBe(12);
    expect(droppedTriangleCount).toBe(0);
    // 生成元は固定で、時刻は 1 バイトも入らない(§0.a-0.62)。
    expect(glb.json).toContain('"generator":"PointerCAD"');
    expect(glb.json).toContain('"version":"2.0"');
    console.log(
      `[実測] 20³ の箱 .glb: ${String(files[0].bytes.length)} バイト(JSON ${String(glb.json.length)} バイト)、三角形 ${String(triangleCount)} 枚`,
    );
  });

  it('20³ の箱の .obj は v が頂点の数・vn が頂点の数・f が 12 行(OBJ の仕様)', () => {
    const mesh = boxMesh();
    const { files, triangleCount } = writeCafMesh([{ mesh, name: null, color: null }], {
      format: 'obj',
    });
    expect(files).toHaveLength(2);
    expect(files[0].fileName).toBe('model.obj');
    const text = decode(files[0].bytes);
    const vertexCount = mesh.positions.length / 3;
    expect(countLinesStartingWith(text, 'v')).toBe(vertexCount);
    expect(countLinesStartingWith(text, 'vn')).toBe(vertexCount);
    expect(countLinesStartingWith(text, 'f')).toBe(12);
    expect(triangleCount).toBe(12);
    // 桁は固定(`toPrecision` は指数表記を出す)。箱は原点が中心なので隅は ±10(mm)。
    expect(text).toContain('v 10.000000 10.000000 10.000000');
    expect(text).not.toMatch(/e[+-]/iu);
    console.log(
      `[実測] 20³ の箱 .obj: ${String(files[0].bytes.length)} バイト、頂点 ${String(vertexCount)}、三角形 ${String(triangleCount)} 枚`,
    );
  });

  it('.mtl は 2 ファイル目で、newmtl が立体の数だけ出て mtllib の行と名前が一致する', () => {
    const { files } = writeCafMesh(
      [
        { mesh: boxMesh(0), name: '本体', color: null },
        { mesh: boxMesh(60), name: '蓋', color: [1, 0, 0] },
      ],
      { format: 'obj', baseName: '部品 一式' },
    );
    expect(files).toHaveLength(2);
    // 空白は `_` へ寄せる(`mtllib` の行は空白で区切るため)。
    expect(files[0].fileName).toBe('部品_一式.obj');
    expect(files[1].fileName).toBe('部品_一式.mtl');
    const objText = decode(files[0].bytes);
    const mtlText = decode(files[1].bytes);
    expect(objText).toContain('mtllib 部品_一式.mtl');
    expect(countLinesStartingWith(mtlText, 'newmtl')).toBe(2);
    expect(countLinesStartingWith(objText, 'usemtl')).toBe(2);
    expect(mtlText).toContain('newmtl material_1');
    expect(mtlText).toContain('newmtl material_2');
    // 立体の名前は `o` の行に UTF-8 のまま出る(材質の名前には使わない)。
    expect(objText).toContain('o 本体');
    expect(objText).toContain('o 蓋');
    console.log(`[実測] .mtl の中身:\n${mtlText.trimEnd()}`);
  });

  it('色を割り当てた立体の baseColorFactor が sRGB → 線形になる(§2.5。#b8bfcc の先頭は約 0.4793)', () => {
    const { files } = writeCafMesh(
      [{ mesh: boxMesh(), name: null, color: DEFAULT_BODY_COLOR }],
      { format: 'gltf' },
    );
    const glb = splitGlb(files[0].bytes);
    const factor = numbersOf(glb.json, 'baseColorFactor');
    expect(factor).toHaveLength(4);
    // 検証表の分解 `184/255`、`191/255`、`204/255`。
    const srgb = [184 / 255, 191 / 255, 204 / 255];
    expect(srgb[0]).toBe(0.7215686274509804);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(factor[axis]).toBeCloseTo(expectedLinear(srgb[axis]), 12);
    }
    // 計画書が「先頭は約 0.4793」と書いている値を、独立に組んだ式から確かめる。
    expect(factor[0]).toBeGreaterThan(0.4792);
    expect(factor[0]).toBeLessThan(0.4795);
    // 不透明度は必ず 1(透過率は書かない。§0.a-0.22)。
    expect(factor[3]).toBe(1);
    // glTF の既定は完全な金属(1)なので、色が見えるように 0 を書く。
    expect(glb.json).toContain('"metallicFactor":0');
    console.log(
      `[実測] #b8bfcc の baseColorFactor(線形) = [${factor.map((value) => value.toFixed(10)).join(', ')}]`,
    );
  });

  it('色を割り当てない立体は既定の色 #b8bfcc で書かれる(OBJ の Kd は sRGB のまま)', () => {
    const gltf = writeCafMesh([{ mesh: boxMesh(), name: null, color: null }], { format: 'gltf' });
    const factor = numbersOf(splitGlb(gltf.files[0].bytes).json, 'baseColorFactor');
    expect(factor[0]).toBeCloseTo(expectedLinear(184 / 255), 12);
    expect(factor[1]).toBeCloseTo(expectedLinear(191 / 255), 12);
    expect(factor[2]).toBeCloseTo(expectedLinear(204 / 255), 12);

    const obj = writeCafMesh([{ mesh: boxMesh(), name: null, color: null }], { format: 'obj' });
    // MTL に色空間の定めは無く、慣行として画面の色(sRGB)をそのまま書く。
    expect(decode(obj.files[1].bytes)).toContain('Kd 0.721569 0.749020 0.800000');
  });

  it('色の値が 0〜1 の外なら断る(呼び出し側の取り違えを黙って通さない)', () => {
    const mesh = boxMesh();
    const badColors: readonly RgbTuple[] = [
      [1.5, 0, 0],
      [0, -0.1, 0],
      [0, 0, Number.NaN],
    ];
    for (const color of badColors) {
      expect(() => writeCafMesh([{ mesh, name: null, color }], { format: 'obj' })).toThrow(
        '書き出しの色の値が正しくありません。',
      );
    }
  });

  it('glTF は m(20mm の箱が 0.02)・OBJ は mm(20)で書かれる(§0.a-0.7)', () => {
    const mesh = boxMesh();
    const glb = splitGlb(
      writeCafMesh([{ mesh, name: null, color: null }], { format: 'gltf' }).files[0].bytes,
    );
    // accessor の min / max は m。箱は原点が中心なので ±0.01。
    const min = numbersOf(glb.json, 'min');
    const max = numbersOf(glb.json, 'max');
    expect(min).toHaveLength(3);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(min[axis]).toBeCloseTo(-0.01, 7);
      expect(max[axis]).toBeCloseTo(0.01, 7);
    }
    // BIN チャンクの生の float32 も m(ファイルの中身そのもの)。
    expect(glb.bin).not.toBeNull();
    if (glb.bin !== null) {
      for (let index = 0; index < 24; index += 1) {
        expect(Math.abs(glb.bin.getFloat32(index * 4, true))).toBeCloseTo(0.01, 7);
      }
    }

    const objText = decode(
      writeCafMesh([{ mesh, name: null, color: null }], { format: 'obj' }).files[0].bytes,
    );
    for (const line of objText.split('\n')) {
      if (!line.startsWith('v ')) {
        continue;
      }
      for (const piece of line.slice(2).split(' ')) {
        expect(Math.abs(Number(piece))).toBeCloseTo(10, 9);
      }
    }
    console.log('[実測] glTF の座標は ±0.01(m)、OBJ の座標は ±10(mm)');
  });

  it('書いた OBJ / glb を読み直すと三角形 12 枚・体積 8000 に戻る(往復)', () => {
    const mesh = boxMesh();
    const obj = writeCafMesh([{ mesh, name: '本体', color: null }], { format: 'obj' });
    const readObj = readCafMesh(oc, obj.files[0].bytes, { format: 'obj' });
    expect(readObj.triangleCount).toBe(12);
    expect(Math.abs(readObj.volume - 8000)).toBeLessThan(1e-3);

    const glb = writeCafMesh([{ mesh, name: '本体', color: null }], { format: 'gltf' });
    const readGlb = readCafMesh(oc, glb.files[0].bytes, { format: 'gltf' });
    expect(readGlb.triangleCount).toBe(12);
    // 読み手は OCCT に 1000 倍させるので、0.02(m)がちょうど 20(mm)に戻る(タスク18 の実測)。
    expect(Math.abs(readGlb.volume - 8000)).toBeLessThan(1e-3);
    console.log(
      `[実測] 往復の体積: OBJ ${readObj.volume.toFixed(6)} / glb ${readGlb.volume.toFixed(6)}(厳密 8000)`,
    );
  });

  it('箱 2 個は 2 メッシュ・2 材質になり、読み直すと 24 枚・体積 16000 になる', () => {
    const bodies: readonly CafMeshBody[] = [
      { mesh: boxMesh(0), name: '左', color: null },
      { mesh: boxMesh(60), name: '右', color: [1, 0, 0] },
    ];
    const glb = writeCafMesh(bodies, { format: 'gltf' });
    const json = splitGlb(glb.files[0].bytes).json;
    // メッシュ 1 つにつき primitives が 1 つ、材質 1 つにつき baseColorFactor が 1 つ。
    expect(countOccurrences(json, '"primitives"')).toBe(2);
    expect(countOccurrences(json, '"baseColorFactor"')).toBe(2);
    expect(countOccurrences(json, '"POSITION"')).toBe(2);
    expect(json).toContain('"name":"左"');
    expect(json).toContain('"name":"右"');
    expect(json).toContain('"scenes":[{"nodes":[0,1]}]');
    expect(glb.triangleCount).toBe(24);
    const readGlb = readCafMesh(oc, glb.files[0].bytes, { format: 'gltf' });
    expect(readGlb.triangleCount).toBe(24);
    expect(Math.abs(readGlb.volume - 16000)).toBeLessThan(1e-2);

    const obj = writeCafMesh(bodies, { format: 'obj' });
    const objText = decode(obj.files[0].bytes);
    expect(countLinesStartingWith(objText, 'o')).toBe(2);
    expect(countLinesStartingWith(objText, 'usemtl')).toBe(2);
    expect(countLinesStartingWith(objText, 'f')).toBe(24);
    const readObj = readCafMesh(oc, obj.files[0].bytes, { format: 'obj' });
    expect(readObj.triangleCount).toBe(24);
    expect(Math.abs(readObj.volume - 16000)).toBeLessThan(1e-2);
  });

  it('面だけのボディ(箱の面 1 枚)も書けて、読み直すと三角形 2 枚になる', () => {
    const handle = makePrimitive(
      oc,
      primitiveAt({ kind: 'box', sizeX: BOX_SIZE, sizeY: BOX_SIZE, sizeZ: BOX_SIZE }),
    );
    const face = faceAt(oc, handle.shape, 0);
    expect(face).not.toBeNull();
    try {
      if (face === null) {
        return;
      }
      const mesh = buildExportMesh(oc, face, 0.1);
      expect(mesh.triangleCount).toBe(2);
      const obj = writeCafMesh([{ mesh, name: '面', color: null }], { format: 'obj' });
      expect(obj.triangleCount).toBe(2);
      expect(countLinesStartingWith(decode(obj.files[0].bytes), 'f')).toBe(2);
      expect(readCafMesh(oc, obj.files[0].bytes, { format: 'obj' }).triangleCount).toBe(2);

      const glb = writeCafMesh([{ mesh, name: '面', color: null }], { format: 'gltf' });
      expect(glb.triangleCount).toBe(2);
      expect(readCafMesh(oc, glb.files[0].bytes, { format: 'gltf' }).triangleCount).toBe(2);
      console.log(
        `[実測] 面 1 枚: .obj ${String(obj.files[0].bytes.length)} バイト / .glb ${String(glb.files[0].bytes.length)} バイト`,
      );
    } finally {
      face?.delete();
      handle.delete();
    }
  });

  it('三角形 0 枚は断らずに中身の無いファイルを返す(断りは model の仕事)', () => {
    const obj = writeCafMesh([], { format: 'obj' });
    expect(obj.triangleCount).toBe(0);
    expect(obj.droppedTriangleCount).toBe(0);
    expect(decode(obj.files[0].bytes)).toBe('# PointerCAD\nmtllib model.mtl\n');
    expect(decode(obj.files[1].bytes)).toBe('# PointerCAD\n');
    // 読み手は「このファイルには形が入っていません。」で断る(§2.8 の表)。
    expect(() => readCafMesh(oc, obj.files[0].bytes, { format: 'obj' })).toThrow(
      CAF_MESH_NO_SHAPE_MESSAGE,
    );

    const glb = writeCafMesh([], { format: 'gltf' });
    const split = splitGlb(glb.files[0].bytes);
    expect(split.magic).toBe('glTF');
    expect(split.version).toBe(2);
    expect(split.totalLength).toBe(glb.files[0].bytes.length);
    // 中身が無いので BIN チャンクも buffers も置かない。
    expect(split.json).toContain('"meshes":[]');
    expect(split.json).not.toContain('"buffers"');
    expect(glb.files[0].bytes.length).toBe(12 + 8 + split.json.length);
  });

  it('面積 0 の三角形だけの立体は材質ごと落ちる(落とした枚数は返る)', () => {
    const degenerate: ExportMesh = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, Number.NaN, 0, 0]),
      normals: new Float32Array(12),
      // 1 枚目は面積を持つ。2 枚目は同じ頂点を 3 回、3 枚目は NaN を含む。
      indices: new Uint32Array([0, 1, 2, 0, 0, 0, 0, 1, 3]),
      triangleCount: 3,
    };
    const kept = writeCafMesh([{ mesh: degenerate, name: null, color: null }], { format: 'obj' });
    expect(kept.triangleCount).toBe(1);
    expect(kept.droppedTriangleCount).toBe(2);
    const keptText = decode(kept.files[0].bytes);
    // 残った三角形が使わない頂点(NaN を含む 4 つ目)は書かない。書くとどの道具でも開けない。
    expect(keptText).not.toContain('NaN');
    expect(countLinesStartingWith(keptText, 'v')).toBe(3);
    expect(countLinesStartingWith(keptText, 'f')).toBe(1);
    expect(keptText).toContain('f 1//1 2//2 3//3');
    // glTF も同じ。accessor の min / max が NaN になるとファイルごと開けなくなる。
    const keptGlb = splitGlb(
      writeCafMesh([{ mesh: degenerate, name: null, color: null }], { format: 'gltf' }).files[0]
        .bytes,
    );
    expect(keptGlb.json).not.toContain('NaN');
    expect(keptGlb.json).toContain('"count":3');

    const allDegenerate: ExportMesh = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0]),
      normals: new Float32Array(6),
      indices: new Uint32Array([0, 0, 0, 0, 1, 1]),
      triangleCount: 2,
    };
    const empty = writeCafMesh([{ mesh: allDegenerate, name: null, color: null }], {
      format: 'gltf',
    });
    expect(empty.triangleCount).toBe(0);
    expect(empty.droppedTriangleCount).toBe(2);
    // 三角形が 1 枚も残らない立体は材質も作らない(添字 0 個の accessor は glTF が許さない)。
    expect(splitGlb(empty.files[0].bytes).json).toContain('"materials":[]');
  });

  it('書き出す三角形の集合は STL とまったく同じ(球の極の面積 0 も同じだけ落ちる)', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.02);
      const stl = writeStl([mesh], { ascii: false });
      const obj = writeCafMesh([{ mesh, name: null, color: null }], { format: 'obj' });
      const glb = writeCafMesh([{ mesh, name: null, color: null }], { format: 'gltf' });
      expect(obj.triangleCount).toBe(stl.triangleCount);
      expect(obj.droppedTriangleCount).toBe(stl.droppedTriangleCount);
      expect(glb.triangleCount).toBe(stl.triangleCount);
      expect(glb.droppedTriangleCount).toBe(stl.droppedTriangleCount);
      expect(stl.droppedTriangleCount).toBeGreaterThan(0);

      // STL の側がたどる三角形(座標そのもの)を並べる。
      const fromStl: string[] = [];
      forEachExportTriangle([mesh], ({ vertices }) => {
        fromStl.push(Array.from(vertices, (value) => value.toFixed(6)).join(' '));
      });
      // OBJ の `f` の行から同じ並びを組み直す(`v` の番号は 1 始まりの通し番号)。
      const objText = decode(obj.files[0].bytes);
      const vertexLines = objText.split('\n').filter((line) => line.startsWith('v '));
      const fromObj = objText
        .split('\n')
        .filter((line) => line.startsWith('f '))
        .map((line) =>
          line
            .slice(2)
            .split(' ')
            .map((piece) => vertexLines[Number(piece.split('//')[0]) - 1].slice(2))
            .join(' '),
        );
      expect(fromObj).toHaveLength(fromStl.length);
      expect(fromObj).toEqual(fromStl);
      console.log(
        `[実測] 球 r=10 偏差 0.02: STL / OBJ / glTF とも ${String(stl.triangleCount)} 枚(面積 0 を ${String(stl.droppedTriangleCount)} 枚落とした)`,
      );
    } finally {
      handle.delete();
    }
  });

  it('同じ三角形から 2 回書くとバイト列が完全に一致する(決定性、§0.a-0.62)', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'cylinder', radius: 10, height: 20 }));
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.05);
      const bodies: readonly CafMeshBody[] = [{ mesh, name: '円柱', color: [0.2, 0.4, 0.6] }];
      const formats: readonly CafMeshFormat[] = ['obj', 'gltf'];
      for (const format of formats) {
        const first = writeCafMesh(bodies, { format });
        const second = writeCafMesh(bodies, { format });
        expect(second.files).toHaveLength(first.files.length);
        for (let index = 0; index < first.files.length; index += 1) {
          expect(second.files[index].fileName).toBe(first.files[index].fileName);
          expect(Array.from(second.files[index].bytes)).toEqual(
            Array.from(first.files[index].bytes),
          );
        }
      }
      // 形から作り直しても同じ(`buildExportMesh` の決定性と合わせて端から端まで同じ)。
      const again = buildExportMesh(oc, handle.shape, 0.05);
      expect(
        Array.from(writeCafMesh([{ mesh: again, name: '円柱', color: [0.2, 0.4, 0.6] }], {
          format: 'gltf',
        }).files[0].bytes),
      ).toEqual(Array.from(writeCafMesh(bodies, { format: 'gltf' }).files[0].bytes));
    } finally {
      handle.delete();
    }
  });

  it('位置と法線は添字で共有する(頂点が三角形 ×3 に膨らまない)', () => {
    const mesh = boxMesh();
    const vertexCount = mesh.positions.length / 3;
    // 箱の 6 面はそれぞれ別の法線を持つので、頂点は 8 ではなく 24。三角形 12 × 3 = 36 より少ない。
    expect(vertexCount).toBeLessThan(36);
    const objText = decode(
      writeCafMesh([{ mesh, name: null, color: null }], { format: 'obj' }).files[0].bytes,
    );
    expect(countLinesStartingWith(objText, 'v')).toBe(vertexCount);
    const glb = splitGlb(
      writeCafMesh([{ mesh, name: null, color: null }], { format: 'gltf' }).files[0].bytes,
    );
    // 位置と法線の accessor の `count` はどちらも頂点の数。
    expect(countOccurrences(glb.json, `"count":${String(vertexCount)}`)).toBe(2);
    // 添字の accessor は三角形 12 × 3 = 36。
    expect(glb.json).toContain('"count":36');
    console.log(
      `[実測] 20³ の箱: 頂点 ${String(vertexCount)}(三角形ごとに書けば 36)、添字 36`,
    );
  });

  it('立体の名前は nodes と meshes に UTF-8 のまま入り、空なら通し名になる', () => {
    const glb = writeCafMesh(
      [
        { mesh: boxMesh(0), name: '外枠 A', color: null },
        { mesh: boxMesh(60), name: '  ', color: null },
      ],
      { format: 'gltf' },
    );
    const json = splitGlb(glb.files[0].bytes).json;
    expect(json).toContain('"name":"外枠 A"');
    // 空白だけの名前は通し名(依頼の並びの番号)へ落ちる。
    expect(json).toContain('"name":"body_2"');
  });

  it('10 万三角形の OBJ / glb を書き出せる(§2.17 に上限の行が無いので記録だけ)', () => {
    const parts: OcctShapeHandle[] = [];
    try {
      // `writeStl.test.ts` と同じ見本(球 r=10 を 103 個、偏差 0.1 で 10 万枚を少し超える)。
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
        const obj = writeCafMesh([{ mesh, name: null, color: null }], { format: 'obj' });
        const objAt = performance.now();
        const glb = writeCafMesh([{ mesh, name: null, color: null }], { format: 'gltf' });
        const glbAt = performance.now();
        expect(mesh.triangleCount).toBeGreaterThanOrEqual(100_000);
        expect(obj.triangleCount).toBe(glb.triangleCount);
        console.log(
          `[実測] 球 103 個 偏差 0.1: 三角形 ${String(obj.triangleCount)} 枚。作り直し ${(meshedAt - start).toFixed(1)} ms / OBJ のバイト列 ${(objAt - meshedAt).toFixed(1)} ms(${String(obj.files[0].bytes.length + obj.files[1].bytes.length)} バイト、合計 ${(objAt - start).toFixed(1)} ms) / glb のバイト列 ${(glbAt - objAt).toFixed(1)} ms(${String(glb.files[0].bytes.length)} バイト、合計 ${(meshedAt - start + (glbAt - objAt)).toFixed(1)} ms)。**計画書 §2.17 に OBJ / glTF の行が無いので上限の判定は置かない**`,
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
});

describe('OBJ / glTF の面ごとの色(P6 タスク13b、§0.a-0.22)', () => {
  /** 面の色の表を組み立てる。 */
  function faceColorsOf(
    entries: readonly (readonly [number, RgbTuple])[],
  ): ReadonlyMap<number, RgbTuple> {
    return new Map<number, RgbTuple>(entries);
  }

  /** 6 面すべて別の色。 */
  const SIX_DISTINCT = faceColorsOf([
    [0, [0.1, 0.2, 0.3]],
    [1, [0.2, 0.3, 0.4]],
    [2, [0.3, 0.4, 0.5]],
    [3, [0.4, 0.5, 0.6]],
    [4, [0.5, 0.6, 0.7]],
    [5, [0.6, 0.7, 0.8]],
  ]);

  /** 6 面のうち先頭 3 面が同じ色(色の種類は 4)。 */
  const THREE_SHARED = faceColorsOf([
    [0, [0.1, 0.2, 0.3]],
    [1, [0.1, 0.2, 0.3]],
    [2, [0.1, 0.2, 0.3]],
    [3, [0.4, 0.5, 0.6]],
    [4, [0.5, 0.6, 0.7]],
    [5, [0.6, 0.7, 0.8]],
  ]);

  /** glb の JSON の中の材質の数(材質が必ず 1 つずつ持つ欄で数える)。 */
  function materialCount(json: string): number {
    return countOccurrences(json, '"pbrMetallicRoughness"');
  }

  /** glb の JSON の中の描き単位(primitive)の数。 */
  function primitiveCount(json: string): number {
    return countOccurrences(json, '"mode":4');
  }

  it('6 面を別の色にすると glb の materials が 6・primitives が 6 になる(三角形は 12 のまま)', () => {
    const mesh = boxMesh();
    const { files, triangleCount, droppedTriangleCount } = writeCafMesh(
      [{ mesh, name: '本体', color: null, faceColors: SIX_DISTINCT }],
      { format: 'gltf' },
    );
    const glb = splitGlb(files[0].bytes);
    // 材質は「実際に使った色」だけ。6 面すべてに色を付けたので立体の色の材質は作らない。
    expect(materialCount(glb.json)).toBe(6);
    expect(primitiveCount(glb.json)).toBe(6);
    // 面ごとに切っても三角形は増えない(箱は 12 枚のまま)。
    expect(triangleCount).toBe(12);
    expect(droppedTriangleCount).toBe(0);
    console.log(
      `[実測] 箱の 6 面別色 .glb: materials ${String(materialCount(glb.json))} / primitives ${String(primitiveCount(glb.json))} / 三角形 ${String(triangleCount)} 枚 / ${String(files[0].bytes.length)} バイト`,
    );
  });

  it('同じ表を .obj へ書くと usemtl が 6 回・newmtl が 6 つ', () => {
    const mesh = boxMesh();
    const { files, triangleCount } = writeCafMesh(
      [{ mesh, name: '本体', color: null, faceColors: SIX_DISTINCT }],
      { format: 'obj' },
    );
    const objText = decode(files[0].bytes);
    const mtlText = decode(files[1].bytes);
    expect(countLinesStartingWith(objText, 'usemtl')).toBe(6);
    expect(countLinesStartingWith(mtlText, 'newmtl')).toBe(6);
    // `f` の行は面ごとに 2 枚ずつ、合わせて 12 行のまま。
    expect(countLinesStartingWith(objText, 'f')).toBe(12);
    expect(triangleCount).toBe(12);
    // MTL の `Kd` は sRGB のまま(面の色も立体の色と同じ扱い)。
    expect(mtlText).toContain('Kd 0.100000 0.200000 0.300000');
    expect(mtlText).toContain('Kd 0.600000 0.700000 0.800000');
    console.log(`[実測] 箱の 6 面別色 .mtl:\n${mtlText.trimEnd()}`);
  });

  it('6 面のうち 3 面が同じ色なら材質は 4 つ(同じ色を 1 つの区間へまとめる)', () => {
    const mesh = boxMesh();
    const glb = writeCafMesh([{ mesh, name: null, color: null, faceColors: THREE_SHARED }], {
      format: 'gltf',
    });
    const json = splitGlb(glb.files[0].bytes).json;
    expect(materialCount(json)).toBe(4);
    expect(primitiveCount(json)).toBe(4);

    const obj = writeCafMesh([{ mesh, name: null, color: null, faceColors: THREE_SHARED }], {
      format: 'obj',
    });
    expect(countLinesStartingWith(decode(obj.files[1].bytes), 'newmtl')).toBe(4);
    expect(countLinesStartingWith(decode(obj.files[0].bytes), 'usemtl')).toBe(4);
    // 同じ色にした 3 面の三角形は 1 つの区間へまとまる。合計の枚数は変わらない。
    expect(obj.triangleCount).toBe(12);
  });

  it('色を付けなかった面は立体の色になる(面の割り当てが立体より優先する)', () => {
    const mesh = boxMesh();
    const partial = faceColorsOf([
      [0, [0.1, 0.2, 0.3]],
      [1, [0.1, 0.2, 0.3]],
      [2, [0.1, 0.2, 0.3]],
    ]);
    const glb = writeCafMesh([{ mesh, name: null, color: [0.9, 0.9, 0.9], faceColors: partial }], {
      format: 'gltf',
    });
    const json = splitGlb(glb.files[0].bytes).json;
    // 面の色 1 種 + 色を付けなかった 3 面ぶんの立体の色 = 材質 2。
    expect(materialCount(json)).toBe(2);
    expect(primitiveCount(json)).toBe(2);
    const obj = writeCafMesh([{ mesh, name: null, color: [0.9, 0.9, 0.9], faceColors: partial }], {
      format: 'obj',
    });
    const mtlText = decode(obj.files[1].bytes);
    expect(mtlText).toContain('Kd 0.100000 0.200000 0.300000');
    expect(mtlText).toContain('Kd 0.900000 0.900000 0.900000');
  });

  it('面が 1 枚しかない球へ面の色を渡すと材質は 1 つ', () => {
    const handle = makePrimitive(oc, primitiveAt({ kind: 'sphere', radius: 10 }));
    try {
      const mesh = buildExportMesh(oc, handle.shape, 0.1);
      expect(mesh.faceRanges).toHaveLength(1);
      const glb = writeCafMesh(
        [{ mesh, name: null, color: null, faceColors: faceColorsOf([[0, [0.2, 0.4, 0.6]]]) }],
        { format: 'gltf' },
      );
      const json = splitGlb(glb.files[0].bytes).json;
      expect(materialCount(json)).toBe(1);
      expect(primitiveCount(json)).toBe(1);
      const factor = numbersOf(json, 'baseColorFactor');
      expect(factor[0]).toBeCloseTo(expectedLinear(0.2), 12);
      expect(factor[1]).toBeCloseTo(expectedLinear(0.4), 12);
      expect(factor[2]).toBeCloseTo(expectedLinear(0.6), 12);
    } finally {
      handle.delete();
    }
  });

  it('面の色を渡さない/空の表を渡すとタスク13 と同じバイト列になる(回帰を出さない)', () => {
    const mesh = boxMesh();
    for (const format of ['obj', 'gltf'] as const) {
      const base = writeCafMesh([{ mesh, name: '本体', color: [0.2, 0.4, 0.6] }], { format });
      const empty = writeCafMesh(
        [{ mesh, name: '本体', color: [0.2, 0.4, 0.6], faceColors: new Map<number, RgbTuple>() }],
        { format },
      );
      expect(empty.files).toHaveLength(base.files.length);
      for (let index = 0; index < base.files.length; index += 1) {
        expect(empty.files[index].fileName).toBe(base.files[index].fileName);
        expect(Array.from(empty.files[index].bytes)).toEqual(Array.from(base.files[index].bytes));
      }
      expect(empty.triangleCount).toBe(base.triangleCount);
      expect(empty.droppedTriangleCount).toBe(base.droppedTriangleCount);
    }
  });

  it('面の色の並べ方を変えてもバイト列が変わらない(面の通し番号の昇順にたどる)', () => {
    const mesh = boxMesh();
    const reversed = new Map([...SIX_DISTINCT].reverse());
    for (const format of ['obj', 'gltf'] as const) {
      const ascending = writeCafMesh(
        [{ mesh, name: '本体', color: null, faceColors: SIX_DISTINCT }],
        { format },
      );
      const shuffled = writeCafMesh([{ mesh, name: '本体', color: null, faceColors: reversed }], {
        format,
      });
      for (let index = 0; index < ascending.files.length; index += 1) {
        expect(Array.from(shuffled.files[index].bytes)).toEqual(
          Array.from(ascending.files[index].bytes),
        );
      }
    }
  });

  it('面ごとに色を付けた OBJ / glb を読み直すと三角形 12 枚・体積 8000 に戻る(往復)', () => {
    const mesh = boxMesh();
    const bodies: readonly CafMeshBody[] = [
      { mesh, name: '本体', color: null, faceColors: SIX_DISTINCT },
    ];
    const obj = writeCafMesh(bodies, { format: 'obj' });
    const readObj = readCafMesh(oc, obj.files[0].bytes, { format: 'obj' });
    expect(readObj.triangleCount).toBe(12);
    expect(Math.abs(readObj.volume - 8000)).toBeLessThan(1e-3);

    const glb = writeCafMesh(bodies, { format: 'gltf' });
    const readGlb = readCafMesh(oc, glb.files[0].bytes, { format: 'gltf' });
    expect(readGlb.triangleCount).toBe(12);
    expect(Math.abs(readGlb.volume - 8000)).toBeLessThan(1e-3);
  });

  it('面の区切りを持たない網へ面の色を渡すと日本語の理由で断る', () => {
    const source = boxMesh();
    // 読み込んだファイルの網や、複数の立体を連ねた網には B-rep の面の区切りが無い。
    const withoutRanges: ExportMesh = {
      positions: source.positions,
      normals: source.normals,
      indices: source.indices,
      triangleCount: source.triangleCount,
    };
    expect(() =>
      writeCafMesh([{ mesh: withoutRanges, name: null, color: null, faceColors: SIX_DISTINCT }], {
        format: 'obj',
      }),
    ).toThrow(MESH_NO_FACE_RANGES_MESSAGE);
    expect(MESH_NO_FACE_RANGES_MESSAGE).toBe(
      'この形には面の区切りが無いので、面ごとの色を書き出せません。',
    );
    // 面の色を渡さなければ、面の区切りが無くてもこれまでどおり書ける。
    expect(
      writeCafMesh([{ mesh: withoutRanges, name: null, color: null }], { format: 'obj' })
        .triangleCount,
    ).toBe(12);
  });

  it('面の通し番号が範囲の外・負なら日本語の理由で断る', () => {
    const mesh = boxMesh();
    expect(() =>
      writeCafMesh([{ mesh, name: null, color: null, faceColors: faceColorsOf([[6, [0, 0, 0]]]) }], {
        format: 'gltf',
      }),
    ).toThrow('色を付ける面が見つかりません(面の番号 6)。');
    expect(() =>
      writeCafMesh(
        [{ mesh, name: null, color: null, faceColors: faceColorsOf([[-1, [0, 0, 0]]]) }],
        { format: 'gltf' },
      ),
    ).toThrow('色を付ける面が見つかりません(面の番号 -1)。');
  });

  it('面の色の値が 0〜1 の外なら断る(立体の色と同じ判定)', () => {
    const mesh = boxMesh();
    expect(() =>
      writeCafMesh(
        [{ mesh, name: null, color: null, faceColors: faceColorsOf([[0, [1.5, 0, 0]]]) }],
        { format: 'obj' },
      ),
    ).toThrow('書き出しの色の値が正しくありません。');
  });
});
