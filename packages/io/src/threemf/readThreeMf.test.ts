import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  readAttributes,
  readThreeMf,
  THREE_MF_MAX_TRIANGLE_COUNT,
  THREE_MF_NO_FACE_MESSAGE,
  THREE_MF_READ_FAILED_MESSAGE,
  threeMfTooLargeMessage,
  type ThreeMfMesh,
} from './readThreeMf.js';
import {
  THREE_MF_CONTENT_TYPES_ENTRY,
  THREE_MF_MODEL_ENTRY,
  THREE_MF_RELS_ENTRY,
  writeThreeMf,
} from './writeThreeMf.js';

/*
 * 3MF の読み込み(計画書 docs/plans/P6-入出力.md タスク19 の検証表と §2.6 の往復)。
 *
 * 書いたものを読み直す往復(`writeThreeMf` → `readThreeMf`)と、他の道具が書いた
 * 書き方の揺れ(属性の順序・引用符・名前空間・注釈)、単位の換算、壊れたファイルの
 * 断りを固定する。**断りの文言は kernel の `occt/exchangeShared.ts` と同文**である
 * ことも、文字列を書き写して照合する(io は kernel を輸入できないため)。
 */

/** 20³ の箱(頂点 8・三角形 12)。面の向きは外向き(反時計回り)。 */
function boxMesh(size: number): { positions: number[]; indices: number[] } {
  const s = size;
  return {
    positions: [
      0, 0, 0,
      s, 0, 0,
      s, s, 0,
      0, s, 0,
      0, 0, s,
      s, 0, s,
      s, s, s,
      0, s, s,
    ],
    indices: [
      0, 2, 1, 0, 3, 2, // 底(z = 0)
      4, 5, 6, 4, 6, 7, // 天(z = s)
      0, 1, 5, 0, 5, 4, // 手前(y = 0)
      1, 2, 6, 1, 6, 5, // 右(x = s)
      2, 3, 7, 2, 7, 6, // 奥(y = s)
      3, 0, 4, 3, 4, 7, // 左(x = 0)
    ],
  };
}

/** `3D/3dmodel.model` の中身から 3MF のバイト列を作る(ZIP の 3 エントリ)。 */
function packThreeMf(modelXml: string): Uint8Array {
  return zipSync({
    [THREE_MF_CONTENT_TYPES_ENTRY]: strToU8('<?xml version="1.0" encoding="UTF-8"?><Types/>'),
    [THREE_MF_RELS_ENTRY]: strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships/>'),
    [THREE_MF_MODEL_ENTRY]: strToU8(modelXml),
  });
}

/** 箱 1 つの `<object>` の中身(`<mesh>` の行)を組み立てる。 */
function boxMeshXml(size: number): string {
  const mesh = boxMesh(size);
  const vertices: string[] = [];
  for (let index = 0; index < mesh.positions.length; index += 3) {
    vertices.push(
      `<vertex x="${String(mesh.positions[index])}" y="${String(mesh.positions[index + 1])}" ` +
        `z="${String(mesh.positions[index + 2])}"/>`,
    );
  }
  const triangles: string[] = [];
  for (let index = 0; index < mesh.indices.length; index += 3) {
    triangles.push(
      `<triangle v1="${String(mesh.indices[index])}" v2="${String(mesh.indices[index + 1])}" ` +
        `v3="${String(mesh.indices[index + 2])}"/>`,
    );
  }
  return `<mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh>`;
}

/** 箱 1 つだけの 3MF の XML(単位と `<item>` の属性を差し替えられる)。 */
function boxModelXml(options: { unit?: string; itemAttributes?: string; size?: number } = {}): string {
  const unit = options.unit === undefined ? '' : ` unit="${options.unit}"`;
  const itemAttributes = options.itemAttributes ?? '';
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<model${unit} xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">` +
    '<resources>' +
    `<object id="2" type="model">${boxMeshXml(options.size ?? 20)}</object>` +
    '</resources>' +
    `<build><item objectid="2"${itemAttributes}/></build>` +
    '</model>'
  );
}

/** 読み込みが成功したことを確かめて、立体の並びを取り出す。 */
function readMeshes(bytes: Uint8Array): readonly ThreeMfMesh[] {
  const result = readThreeMf(bytes);
  if (!result.ok) {
    throw new Error(`読み込みに失敗した: ${result.reason}`);
  }
  return result.meshes;
}

/** 頂点の平均(重心の目安。平行移動で動くことを見るために使う)。 */
function averageOf(positions: Float32Array): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  const count = positions.length / 3;
  for (let index = 0; index < count; index += 1) {
    x += positions[index * 3];
    y += positions[index * 3 + 1];
    z += positions[index * 3 + 2];
  }
  return [x / count, y / count, z / count];
}

describe('readAttributes(タスク19 の手順 2)', () => {
  it('属性の順序に依らずに読める', () => {
    const inOrder = readAttributes('<vertex x="1" y="2" z="3"/>');
    const shuffled = readAttributes('<vertex z="3" x="1" y="2"/>');
    expect(inOrder).toEqual({ x: '1', y: '2', z: '3' });
    expect(shuffled).toEqual(inOrder);
  });

  it("引用符が ' でも読める", () => {
    expect(readAttributes("<vertex x='1' y='2' z='3'/>")).toEqual({ x: '1', y: '2', z: '3' });
    // 片方だけ `'` の混在も XML としては正しい。
    expect(readAttributes(`<vertex x='1' y="2"/>`)).toEqual({ x: '1', y: '2' });
  });

  it('逃がしの 8 種を元の文字へ戻す(xmlText.ts の逆)', () => {
    const attributes = readAttributes(
      '<base name="&amp;&lt;&gt;&quot;&apos;&#x9;&#xA;&#xD;"/>',
    );
    expect(attributes.name).toBe('&<>"\'\t\n\r');
  });

  it('二重に逃がした文字列を二重に戻さない', () => {
    // 元の文字列が `&lt;`(4 文字)なら、書き出しは `&amp;lt;` になる。
    expect(readAttributes('<base name="&amp;lt;"/>').name).toBe('&lt;');
  });

  it('10 進の数値参照と、知らない実体参照の扱い', () => {
    expect(readAttributes('<base name="&#65;&#x42;"/>').name).toBe('AB');
    // 知らない実体はそのまま残す(名前の見た目が変わるだけで、形は読めるほうがよい)。
    expect(readAttributes('<base name="&nbsp;"/>').name).toBe('&nbsp;');
    // 範囲の外の符号位置でも例外を投げない。
    expect(readAttributes('<base name="&#x110000;"/>').name).toBe('&#x110000;');
  });

  it('属性の無いタグは空の連想配列になる', () => {
    expect(readAttributes('<vertices>')).toEqual({});
    expect(readAttributes('</object>')).toEqual({});
  });
});

describe('3MF の往復(§2.6 の検証表)', () => {
  it('タスク14 が書いた 20³ の箱を読むと 頂点 8・三角形 12・体積 8000', () => {
    const mesh = boxMesh(20);
    const bytes = writeThreeMf([
      { name: null, color: null, positions: mesh.positions, indices: mesh.indices },
    ]);
    const result = readThreeMf(bytes);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.unit).toBe('millimeter');
    expect(result.meshes).toHaveLength(1);
    const read = result.meshes[0];
    expect(read.positions).toHaveLength(8 * 3);
    expect(read.indices).toHaveLength(12 * 3);
    expect(read.triangleCount).toBe(12);
    expect(read.volume).toBeCloseTo(8000, 6);
    expect(read.name).toBeNull();
  });

  it('名前(逃がしが要る文字を含む)と色が往復する', () => {
    const mesh = boxMesh(20);
    const bytes = writeThreeMf([
      {
        name: 'A & B <C>',
        color: [1, 0.5, 0],
        positions: mesh.positions,
        indices: mesh.indices,
      },
    ]);
    const read = readMeshes(bytes)[0];
    expect(read.name).toBe('A & B <C>');
    expect(read.color).not.toBeNull();
    // `#ff8000`(0.5 は 128/255 へ丸められる)。
    expect(read.color?.[0]).toBeCloseTo(1, 6);
    expect(read.color?.[1]).toBeCloseTo(128 / 255, 6);
    expect(read.color?.[2]).toBeCloseTo(0, 6);
  });

  it('色を書かずに書き出した 3MF は色が null になる', () => {
    const mesh = boxMesh(20);
    const bytes = writeThreeMf(
      [{ name: '色なし', color: null, positions: mesh.positions, indices: mesh.indices }],
      { withColors: false },
    );
    const read = readMeshes(bytes)[0];
    expect(read.color).toBeNull();
    expect(read.name).toBe('色なし');
  });

  it('立体が 2 つある 3MF は 2 つに分かれて読める', () => {
    const first = boxMesh(20);
    const second = boxMesh(10);
    const bytes = writeThreeMf([
      { name: '大', color: null, positions: first.positions, indices: first.indices },
      { name: '小', color: null, positions: second.positions, indices: second.indices },
    ]);
    const meshes = readMeshes(bytes);
    expect(meshes).toHaveLength(2);
    expect(meshes.map((mesh) => mesh.name)).toEqual(['大', '小']);
    expect(meshes[0].volume).toBeCloseTo(8000, 6);
    expect(meshes[1].volume).toBeCloseTo(1000, 6);
  });

  it('法線は単位ベクトルで、箱の角では 3 面の向きが混ざる', () => {
    const mesh = boxMesh(20);
    const bytes = writeThreeMf([
      { name: null, color: null, positions: mesh.positions, indices: mesh.indices },
    ]);
    const read = readMeshes(bytes)[0];
    expect(read.normals).toHaveLength(8 * 3);
    for (let index = 0; index < 8; index += 1) {
      const base = index * 3;
      const length = Math.hypot(
        read.normals[base],
        read.normals[base + 1],
        read.normals[base + 2],
      );
      expect(length).toBeCloseTo(1, 5);
    }
    // 原点の角(0,0,0)は −X・−Y・−Z の 3 面に囲まれるので、どの成分も負になる。
    expect(read.normals[0]).toBeLessThan(0);
    expect(read.normals[1]).toBeLessThan(0);
    expect(read.normals[2]).toBeLessThan(0);
  });
});

describe('単位の換算(§0.a-0.6、FR-811)', () => {
  it('unit="inch" の座標は 25.4 倍される', () => {
    const result = readThreeMf(packThreeMf(boxModelXml({ unit: 'inch' })));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.unit).toBe('inch');
    const read = result.meshes[0];
    // 20 inch = 508mm ちょうど(20 × 25.4)。
    expect(read.positions[3]).toBeCloseTo(508, 4);
    // 体積は 508³ = 131,096,512 mm³。
    expect(read.volume).toBeCloseTo(508 ** 3, 0);
  });

  it('unit が無ければ millimeter とみなす(3MF の既定)', () => {
    const result = readThreeMf(packThreeMf(boxModelXml()));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.unit).toBe('millimeter');
    expect(result.meshes[0].volume).toBeCloseTo(8000, 4);
  });

  it('6 種の単位がそれぞれの倍率で mm になる', () => {
    // 単位 → 1 単位が何 mm か(§0.a-0.6)。foot は 12 inch なので 304.8。
    const table: readonly (readonly [string, number])[] = [
      ['micron', 0.001],
      ['millimeter', 1],
      ['centimeter', 10],
      ['inch', 25.4],
      ['foot', 304.8],
      ['meter', 1000],
    ];
    for (const [unit, scale] of table) {
      const result = readThreeMf(packThreeMf(boxModelXml({ unit, size: 1 })));
      expect(result.ok).toBe(true);
      if (!result.ok) {
        continue;
      }
      expect(result.unit).toBe(unit);
      // 1 単位の立方体なので、体積は倍率の 3 乗になる。
      expect(result.meshes[0].volume / scale ** 3).toBeCloseTo(1, 4);
    }
  });

  it('知らない単位は断る(黙って mm とみなさない)', () => {
    const result = readThreeMf(packThreeMf(boxModelXml({ unit: 'furlong' })));
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe(THREE_MF_READ_FAILED_MESSAGE);
  });
});

describe('他の道具が書いた XML の揺れ', () => {
  it('属性の順序を入れ替えた XML も同じに読める', () => {
    const shuffled =
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<model xml:lang="en-US" unit="millimeter">' +
      '<resources><object type="model" id="2"><mesh>' +
      '<vertices><vertex z="0" x="0" y="0"/><vertex y="0" z="0" x="20"/>' +
      '<vertex z="0" y="20" x="20"/><vertex x="0" z="20" y="0"/></vertices>' +
      '<triangles><triangle v3="2" v1="0" v2="1"/><triangle v2="2" v3="3" v1="0"/></triangles>' +
      '</mesh></object></resources>' +
      '<build><item objectid="2"/></build></model>';
    const meshes = readMeshes(packThreeMf(shuffled));
    expect(meshes).toHaveLength(1);
    expect(meshes[0].positions).toHaveLength(4 * 3);
    expect(meshes[0].triangleCount).toBe(2);
    // 2 枚目の三角形の頂点は 0, 2, 3。
    expect(Array.from(meshes[0].indices)).toEqual([0, 1, 2, 0, 2, 3]);
  });

  it("引用符が ' の XML も読める", () => {
    const singleQuoted = boxModelXml().replace(/"/g, "'");
    const meshes = readMeshes(packThreeMf(singleQuoted));
    expect(meshes[0].triangleCount).toBe(12);
    expect(meshes[0].volume).toBeCloseTo(8000, 4);
  });

  it('名前空間の接頭辞つきのタグも読める', () => {
    const prefixed = boxModelXml()
      .replace(/<(\/?)(model|resources|object|mesh|vertices|vertex|triangles|triangle|build|item)/g, '<$1m:$2');
    const meshes = readMeshes(packThreeMf(prefixed));
    expect(meshes[0].triangleCount).toBe(12);
  });

  it('注釈が挟まっていても読める', () => {
    const commented = boxModelXml().replace(
      '<resources>',
      '<!-- 他の道具が書いた注釈 <object id="99"/> --><resources>',
    );
    const meshes = readMeshes(packThreeMf(commented));
    expect(meshes).toHaveLength(1);
    expect(meshes[0].triangleCount).toBe(12);
  });

  it('属性の中の > を数えずにタグを切る', () => {
    const withAngle = boxModelXml().replace('<object id="2"', '<object name="a>b" id="2"');
    const meshes = readMeshes(packThreeMf(withAngle));
    expect(meshes[0].name).toBe('a>b');
    expect(meshes[0].triangleCount).toBe(12);
  });
});

describe('<build> の <item> の変換', () => {
  it('平行移動では体積が変わらず、重心だけ動く', () => {
    const moved = readMeshes(
      packThreeMf(boxModelXml({ itemAttributes: ' transform="1 0 0 0 1 0 0 0 1 5 -3 7"' })),
    )[0];
    const plain = readMeshes(packThreeMf(boxModelXml()))[0];
    expect(moved.volume).toBeCloseTo(plain.volume, 4);
    expect(moved.volume).toBeCloseTo(8000, 4);
    const [x, y, z] = averageOf(moved.positions);
    // 20³ の箱の頂点の平均は (10,10,10)。そこから (5,−3,7) 動く。
    expect(x).toBeCloseTo(15, 4);
    expect(y).toBeCloseTo(7, 4);
    expect(z).toBeCloseTo(17, 4);
  });

  it('2 倍に拡大する変換では体積が 8 倍になる', () => {
    const scaled = readMeshes(
      packThreeMf(boxModelXml({ itemAttributes: ' transform="2 0 0 0 2 0 0 0 2 0 0 0"' })),
    )[0];
    expect(scaled.volume).toBeCloseTo(8000 * 8, 3);
  });

  it('平行移動は単位の換算より先に掛かる(inch の平行移動も 25.4 倍される)', () => {
    const moved = readMeshes(
      packThreeMf(
        boxModelXml({ unit: 'inch', itemAttributes: ' transform="1 0 0 0 1 0 0 0 1 1 0 0"' }),
      ),
    )[0];
    const [x] = averageOf(moved.positions);
    // (10 + 1) inch = 279.4mm。単位の換算だけを後に掛けるので 11 × 25.4 になる。
    expect(x).toBeCloseTo(11 * 25.4, 3);
  });

  it('<build> が空なら <resources> の <object> をそのまま返す', () => {
    const noBuild = boxModelXml().replace('<build><item objectid="2"/></build>', '<build/>');
    const meshes = readMeshes(packThreeMf(noBuild));
    expect(meshes).toHaveLength(1);
    expect(meshes[0].volume).toBeCloseTo(8000, 4);
  });

  it('同じ <object> を 2 回置くと 2 つの立体になる', () => {
    const twice = boxModelXml().replace(
      '<item objectid="2"/>',
      '<item objectid="2"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 50 0 0"/>',
    );
    const meshes = readMeshes(packThreeMf(twice));
    expect(meshes).toHaveLength(2);
    expect(averageOf(meshes[0].positions)[0]).toBeCloseTo(10, 4);
    expect(averageOf(meshes[1].positions)[0]).toBeCloseTo(60, 4);
  });
});

describe('壊れたファイルの断り(§0.a-0.27、NFR-RE-1)', () => {
  it('ZIP でないバイト列は断る', () => {
    const result = readThreeMf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(result).toEqual({ ok: false, reason: THREE_MF_READ_FAILED_MESSAGE });
  });

  it('空のバイト列でも例外を投げない', () => {
    expect(readThreeMf(new Uint8Array(0)).ok).toBe(false);
  });

  it('3D/3dmodel.model の無い ZIP は断る', () => {
    const bytes = zipSync({ 'readme.txt': strToU8('ZIP ではあるが 3MF ではない') });
    const result = readThreeMf(bytes);
    expect(result).toEqual({ ok: false, reason: THREE_MF_READ_FAILED_MESSAGE });
  });

  it('閉じていないタグ(壊れた XML)は断る', () => {
    const broken = boxModelXml().replace('</model>', '</mode');
    const result = readThreeMf(packThreeMf(broken));
    expect(result).toEqual({ ok: false, reason: THREE_MF_READ_FAILED_MESSAGE });
  });

  it('<model> が無い XML は断る', () => {
    const result = readThreeMf(packThreeMf('<?xml version="1.0"?><nothing/>'));
    expect(result).toEqual({ ok: false, reason: THREE_MF_READ_FAILED_MESSAGE });
  });

  it('座標が数でない XML は断る', () => {
    const broken = boxModelXml().replace('<vertex x="0"', '<vertex x="なし"');
    const result = readThreeMf(packThreeMf(broken));
    expect(result).toEqual({ ok: false, reason: THREE_MF_READ_FAILED_MESSAGE });
  });

  it('添字が頂点を指していない XML は断る', () => {
    const broken = boxModelXml().replace('<triangle v1="0" v2="2" v3="1"/>', '<triangle v1="0" v2="2" v3="99"/>');
    const result = readThreeMf(packThreeMf(broken));
    expect(result).toEqual({ ok: false, reason: THREE_MF_READ_FAILED_MESSAGE });
  });

  it('<item> が存在しない <object> を指していたら断る', () => {
    const broken = boxModelXml().replace('<item objectid="2"/>', '<item objectid="99"/>');
    const result = readThreeMf(packThreeMf(broken));
    expect(result).toEqual({ ok: false, reason: THREE_MF_READ_FAILED_MESSAGE });
  });

  it('三角形が 0 枚なら「この形には面がありません。」', () => {
    const empty =
      '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter">' +
      '<resources><object id="2" type="model"><mesh>' +
      '<vertices><vertex x="0" y="0" z="0"/></vertices><triangles/>' +
      '</mesh></object></resources><build><item objectid="2"/></build></model>';
    const result = readThreeMf(packThreeMf(empty));
    expect(result).toEqual({ ok: false, reason: THREE_MF_NO_FACE_MESSAGE });
  });

  it('立体が 1 つも入っていない 3MF も「面がありません」で断る', () => {
    const empty =
      '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter">' +
      '<resources/><build/></model>';
    const result = readThreeMf(packThreeMf(empty));
    expect(result).toEqual({ ok: false, reason: THREE_MF_NO_FACE_MESSAGE });
  });

  it('断りの文言と上限は kernel の occt/exchangeShared.ts と同文である', () => {
    // io は kernel を輸入できない(依存方向)ので、正本の文字列をここへ書き写して照合する。
    expect(THREE_MF_READ_FAILED_MESSAGE).toBe(
      'このファイルを読めませんでした。ファイルが壊れているか、対応していない形式です。',
    );
    expect(THREE_MF_NO_FACE_MESSAGE).toBe('この形には面がありません。');
    expect(THREE_MF_MAX_TRIANGLE_COUNT).toBe(5_000_000);
    expect(threeMfTooLargeMessage(5_000_001)).toBe(
      'この形は大きすぎて開けません(三角形が 5000001 個)。',
    );
  });
});

describe('大きすぎる形の門(§2.8 の断りの表)', () => {
  it('三角形が 500 万を超えるファイルは、組み立てる前に個数つきで断る', () => {
    // 中身を組み立てずに `<triangle` の数だけで断る(記憶を食い尽くさないための門)。
    const count = THREE_MF_MAX_TRIANGLE_COUNT + 1;
    const xml =
      '<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter"><resources>' +
      '<object id="2" type="model"><mesh><vertices/><triangles>' +
      '<triangle/>'.repeat(count) +
      '</triangles></mesh></object></resources><build><item objectid="2"/></build></model>';
    const result = readThreeMf(packThreeMf(xml));
    expect(result).toEqual({ ok: false, reason: threeMfTooLargeMessage(count) });
  });
});

/** §2.17 に 3MF の読み込みの行は無いので、**上限は置かず実測の記録だけ**にする。 */
const BIG_VERTEX_COUNT = 50_000;
const BIG_TRIANGLE_COUNT = 100_000;

describe('3MF の読み込みの所要(記録のみ)', () => {
  it('10 万三角形を読める(所要を記録する)', () => {
    const positions = new Float32Array(BIG_VERTEX_COUNT * 3);
    for (let index = 0; index < BIG_VERTEX_COUNT; index += 1) {
      positions[index * 3] = (index % 200) * 0.37;
      positions[index * 3 + 1] = Math.floor(index / 200) * 0.41;
      positions[index * 3 + 2] = (index % 17) * 1.125;
    }
    const indices = new Uint32Array(BIG_TRIANGLE_COUNT * 3);
    for (let index = 0; index < BIG_TRIANGLE_COUNT; index += 1) {
      const first = index % (BIG_VERTEX_COUNT - 2);
      indices[index * 3] = first;
      indices[index * 3 + 1] = first + 1;
      indices[index * 3 + 2] = first + 2;
    }
    const bytes = writeThreeMf([{ name: '大きな形', color: null, positions, indices }]);

    const startedAt = performance.now();
    const result = readThreeMf(bytes);
    const elapsedMs = performance.now() - startedAt;

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.meshes[0].triangleCount).toBe(BIG_TRIANGLE_COUNT);
    expect(result.meshes[0].positions).toHaveLength(BIG_VERTEX_COUNT * 3);
    console.log(
      `3MF 読み込み(頂点 ${String(BIG_VERTEX_COUNT)}・三角形 ${String(BIG_TRIANGLE_COUNT)}): ` +
        `${elapsedMs.toFixed(1)} ms、ZIP ${(bytes.length / 1024 / 1024).toFixed(2)} MB` +
        '(計画書 §2.17 に 3MF の読み込みの行は無いので上限は置かず、記録だけ)',
    );
  });
});
