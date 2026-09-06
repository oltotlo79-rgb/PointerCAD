import { DEFAULT_APPEARANCE } from '@pointercad/model';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';
import {
  DEFAULT_THREE_MF_COLOR,
  THREE_MF_CONTENT_TYPES_ENTRY,
  THREE_MF_INVALID_COLOR_MESSAGE,
  THREE_MF_INVALID_INDICES_MESSAGE,
  THREE_MF_INVALID_POSITIONS_MESSAGE,
  THREE_MF_MODEL_ENTRY,
  THREE_MF_RELS_ENTRY,
  writeThreeMf,
  type ThreeMfColor,
  type ThreeMfFaceRange,
  type ThreeMfMeshInput,
} from './writeThreeMf.js';

/*
 * 3MF の書き出し(計画書 docs/plans/P6-入出力.md §2.6 の検証表とタスク14 の検証表)。
 *
 * 3MF は ZIP なので、書いたバイト列をその場で展開して中身を確かめる。
 * 上限(10 万三角形 3 秒)は計画書 §2.17 #5 の数値そのままで、**緩めない**
 * (rules/02-禁止事項.md)。判定は `expectWithinBudget` の切替に乗せる(§0.a-0.60)。
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

/** 箱 1 つぶんの入力を作る。 */
function boxPart(overrides: Partial<ThreeMfMeshInput> = {}): ThreeMfMeshInput {
  const mesh = boxMesh(20);
  return {
    name: null,
    color: null,
    positions: mesh.positions,
    indices: mesh.indices,
    ...overrides,
  };
}

/** 書いたバイト列を展開して、エントリ名 → 文字列にする。 */
function unzipToText(bytes: Uint8Array): Record<string, string> {
  const entries = unzipSync(bytes);
  const result: Record<string, string> = {};
  for (const [name, content] of Object.entries(entries)) {
    result[name] = strFromU8(content);
  }
  return result;
}

/** `3D/3dmodel.model` の中身を取り出す。 */
function modelXmlOf(bytes: Uint8Array): string {
  return unzipToText(bytes)[THREE_MF_MODEL_ENTRY];
}

/** 部分文字列の出現回数。 */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('3MF の封筒(§2.6)', () => {
  it('ZIP として書かれる(先頭 2 バイトが PK)', () => {
    const bytes = writeThreeMf([boxPart()]);
    expect(bytes[0]).toBe(0x50);
    expect(bytes[1]).toBe(0x4b);
  });

  it('エントリは 3 つで、名前と並びが仕様どおり', () => {
    const bytes = writeThreeMf([boxPart()]);
    const names = Object.keys(unzipSync(bytes));
    expect(names).toEqual([
      THREE_MF_CONTENT_TYPES_ENTRY,
      THREE_MF_RELS_ENTRY,
      THREE_MF_MODEL_ENTRY,
    ]);
  });

  it('[Content_Types].xml は仕様どおりの 2 つの既定を持つ', () => {
    const text = unzipToText(writeThreeMf([boxPart()]))[THREE_MF_CONTENT_TYPES_ENTRY];
    expect(text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(text).toContain(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    );
    expect(text).toContain('Extension="rels"');
    expect(text).toContain(
      'ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"',
    );
  });

  it('_rels/.rels が 3D モデルの入口を 1 つだけ指す', () => {
    const text = unzipToText(writeThreeMf([boxPart()]))[THREE_MF_RELS_ENTRY];
    expect(text).toContain('Target="/3D/3dmodel.model"');
    expect(text).toContain(
      'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"',
    );
    expect(countOf(text, '<Relationship ')).toBe(1);
  });
});

describe('3MF の中身(§2.6)', () => {
  it('単位は millimeter(内部が mm 固定のため。§0.a-0.7)', () => {
    const model = modelXmlOf(writeThreeMf([boxPart()]));
    expect(model).toContain('unit="millimeter"');
    expect(model).toContain(
      'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"',
    );
  });

  it('20³ の箱は頂点 8・三角形 12', () => {
    const model = modelXmlOf(writeThreeMf([boxPart()]));
    expect(countOf(model, '<vertex ')).toBe(8);
    expect(countOf(model, '<triangle ')).toBe(12);
    expect(model).toContain('<vertex x="0" y="0" z="0"/>');
    expect(model).toContain('<vertex x="20" y="20" z="20"/>');
    expect(model).toContain('<triangle v1="0" v2="2" v3="1"/>');
  });

  it('立体ごとに <object> と <item> が 1 つずつ出る', () => {
    const model = modelXmlOf(writeThreeMf([boxPart()]));
    expect(countOf(model, '<object ')).toBe(1);
    expect(model).toContain('<object id="2" type="model" pid="1" pindex="0">');
    expect(countOf(model, '<item ')).toBe(1);
    expect(model).toContain('<item objectid="2"/>');
  });

  it('座標は 6 桁で丸め、末尾の 0 を落とす', () => {
    const part = boxPart({ positions: [1.5, 0.0000001, -0.0000001, 2, 3, 4, 5, 6, 7] });
    const model = modelXmlOf(writeThreeMf([{ ...part, indices: [0, 1, 2] }]));
    expect(model).toContain('<vertex x="1.5" y="0" z="0"/>');
  });

  it('立体が 2 つなら <object> が 2 つ、id は 2 と 3', () => {
    const model = modelXmlOf(writeThreeMf([boxPart(), boxPart()]));
    expect(countOf(model, '<object ')).toBe(2);
    expect(model).toContain('<object id="2" type="model" pid="1" pindex="0">');
    expect(model).toContain('<object id="3" type="model" pid="1" pindex="1">');
    expect(model).toContain('<item objectid="2"/>');
    expect(model).toContain('<item objectid="3"/>');
    expect(countOf(model, '<base ')).toBe(2);
  });
});

describe('3MF の色(§2.6、§0.a-0.22)', () => {
  it('色を渡すと displaycolor が 8 桁の小文字で出る', () => {
    const model = modelXmlOf(writeThreeMf([boxPart({ color: [0.8, 0.2667, 0.2667] })]));
    expect(model).toContain('<basematerials id="1">');
    expect(model).toContain('displaycolor="#cc4444ff"');
  });

  it('色を渡さない立体は既定の色になる(正本は model の DEFAULT_APPEARANCE)', () => {
    const model = modelXmlOf(writeThreeMf([boxPart()]));
    // 写しが正本からずれたらここで落ちる(`#b8bfcc` + 不透明の `ff`)。
    expect(model).toContain(`displaycolor="${DEFAULT_APPEARANCE.color}ff"`);
    expect(DEFAULT_THREE_MF_COLOR).toEqual([184 / 255, 191 / 255, 204 / 255]);
  });

  it('色を書かない指定なら <basematerials> も pid / pindex も出ない', () => {
    const model = modelXmlOf(
      writeThreeMf([boxPart({ color: [1, 0, 0] })], { withColors: false }),
    );
    expect(model).not.toContain('<basematerials');
    expect(model).not.toContain('pid=');
    expect(model).not.toContain('pindex=');
    // 番号は色の有無で動かさない(<item> の指す先が変わらない)。
    expect(model).toContain('<object id="2" type="model">');
    expect(model).toContain('<item objectid="2"/>');
  });

  it('色の値が 0〜1 でなければ断る', () => {
    expect(() => writeThreeMf([boxPart({ color: [1.5, 0, 0] })])).toThrow(
      THREE_MF_INVALID_COLOR_MESSAGE,
    );
    expect(() => writeThreeMf([boxPart({ color: [0, -0.1, 0] })])).toThrow(
      THREE_MF_INVALID_COLOR_MESSAGE,
    );
    expect(() => writeThreeMf([boxPart({ color: [0, 0, Number.NaN] })])).toThrow(
      THREE_MF_INVALID_COLOR_MESSAGE,
    );
  });
});

/** 箱の 6 面を面ごとの三角形の範囲にする(面 1 枚 = 三角形 2 枚。kernel の faceRanges と同じ形)。 */
function boxFaceRanges(): ThreeMfFaceRange[] {
  return Array.from({ length: 6 }, (_unused, faceIndex) => ({
    triangleOffset: faceIndex * 2,
    triangleCount: 2,
  }));
}

/** 6 面ぶんの別々の色。既定の色(立体の色)とはどれも違う。 */
function sixFaceColors(): Map<number, ThreeMfColor> {
  return new Map<number, ThreeMfColor>([
    [0, [0.8, 0.2667, 0.2667]],
    [1, [0.2, 0.7, 0.3]],
    [2, [0.1, 0.2, 0.9]],
    [3, [1, 1, 0]],
    [4, [0, 0, 0]],
    [5, [1, 1, 1]],
  ]);
}

describe('3MF の面ごとの色(§2.6、§0.a-0.22、タスク14b)', () => {
  it('6 面を別の色にすると <base> が 7 つ(既定 + 6)、p1 を持つ三角形が 12 枚', () => {
    const model = modelXmlOf(
      writeThreeMf([boxPart({ faceColors: sixFaceColors(), faceRanges: boxFaceRanges() })]),
    );
    expect(countOf(model, '<base ')).toBe(7);
    expect(countOf(model, ' p1="')).toBe(12);
    expect(countOf(model, '<triangle ')).toBe(12);
    // 立体の色は先頭のまま。面の色はその後ろ(添字 1〜6)へ足す。
    expect(model).toContain('<object id="2" type="model" pid="1" pindex="0">');
    expect(model).toContain('<triangle v1="0" v2="2" v3="1" p1="1"/>');
    expect(model).toContain('p1="6"/>');
  });

  it('立体の色と同じ色の面には p1 を書かない(<base> は 6 つ、p1 は 10 枚)', () => {
    const faceColors = sixFaceColors();
    // 面 0 だけを立体の色と同じにする(計画書の検証表の 12 − 2 枚)。
    faceColors.set(0, DEFAULT_THREE_MF_COLOR);
    const model = modelXmlOf(
      writeThreeMf([boxPart({ faceColors, faceRanges: boxFaceRanges() })]),
    );
    expect(countOf(model, '<base ')).toBe(6);
    expect(countOf(model, ' p1="')).toBe(10);
    expect(model).toContain('<triangle v1="0" v2="2" v3="1"/>');
  });

  it('3 面が同じ色なら <base> は 4 つ(既定 + 3 色)', () => {
    const faceColors = new Map<number, ThreeMfColor>([
      [0, [0.8, 0.2667, 0.2667]],
      [1, [0.8, 0.2667, 0.2667]],
      [2, [0.8, 0.2667, 0.2667]],
      [3, [0.2, 0.7, 0.3]],
      [4, [0.1, 0.2, 0.9]],
    ]);
    const model = modelXmlOf(
      writeThreeMf([boxPart({ faceColors, faceRanges: boxFaceRanges() })]),
    );
    expect(countOf(model, '<base ')).toBe(4);
    // 同じ色の 3 面(三角形 6 枚)は同じ添字を指す。
    expect(countOf(model, 'p1="1"')).toBe(6);
    expect(countOf(model, ' p1="')).toBe(10);
  });

  it('面の色も displaycolor が 8 桁の小文字で出て、<base> に名前が付く', () => {
    const model = modelXmlOf(
      writeThreeMf([
        boxPart({
          name: '本体',
          faceColors: new Map<number, ThreeMfColor>([[2, [0.8, 0.2667, 0.2667]]]),
          faceRanges: boxFaceRanges(),
        }),
      ]),
    );
    expect(model).toContain('<base name="本体" displaycolor="#b8bfccff"/>');
    expect(model).toContain('<base name="本体_face_1" displaycolor="#cc4444ff"/>');
  });

  it('色の並びは最初に現れた面の通し番号の昇順(表の作り順に左右されない)', () => {
    const ranges = boxFaceRanges();
    const ascending = new Map<number, ThreeMfColor>([
      [1, [1, 0, 0]],
      [4, [0, 1, 0]],
    ]);
    const descending = new Map<number, ThreeMfColor>([
      [4, [0, 1, 0]],
      [1, [1, 0, 0]],
    ]);
    const first = writeThreeMf([boxPart({ faceColors: ascending, faceRanges: ranges })]);
    const second = writeThreeMf([boxPart({ faceColors: descending, faceRanges: ranges })]);
    expect(Array.from(first)).toEqual(Array.from(second));
    const model = modelXmlOf(first);
    expect(model.indexOf('#ff0000ff')).toBeLessThan(model.indexOf('#00ff00ff'));
  });

  it('同じ入力から 2 回書くとバイト列が完全に一致する(§0.a-0.62)', () => {
    const write = (): Uint8Array =>
      writeThreeMf([boxPart({ faceColors: sixFaceColors(), faceRanges: boxFaceRanges() })]);
    expect(Array.from(write())).toEqual(Array.from(write()));
  });

  it('面の色を渡さなければタスク14 と同じバイト列になる', () => {
    const plain = writeThreeMf([boxPart({ name: '本体', color: [0.1, 0.2, 0.3] })]);
    // 範囲だけ・空の表だけを渡しても、色が 1 つも効かないので同じ形に戻る。
    const withRanges = writeThreeMf([
      boxPart({ name: '本体', color: [0.1, 0.2, 0.3], faceRanges: boxFaceRanges() }),
    ]);
    const withEmpty = writeThreeMf([
      boxPart({
        name: '本体',
        color: [0.1, 0.2, 0.3],
        faceColors: new Map(),
        faceRanges: boxFaceRanges(),
      }),
    ]);
    expect(Array.from(withRanges)).toEqual(Array.from(plain));
    expect(Array.from(withEmpty)).toEqual(Array.from(plain));
  });

  it('faceRanges に無い面の色は無視する(断らず、バイト列も変わらない)', () => {
    const plain = writeThreeMf([boxPart()]);
    const ignored = writeThreeMf([
      boxPart({
        faceColors: new Map<number, ThreeMfColor>([[99, [1, 0, 0]]]),
        faceRanges: boxFaceRanges(),
      }),
    ]);
    expect(Array.from(ignored)).toEqual(Array.from(plain));
  });

  it('立体が 2 つでも <basematerials> は 1 つで、面の色は立体の色の後ろに並ぶ', () => {
    const model = modelXmlOf(
      writeThreeMf([
        boxPart({
          name: '一',
          faceColors: new Map<number, ThreeMfColor>([[0, [1, 0, 0]]]),
          faceRanges: boxFaceRanges(),
        }),
        boxPart({
          name: '二',
          faceColors: new Map<number, ThreeMfColor>([[1, [0, 0, 1]]]),
          faceRanges: boxFaceRanges(),
        }),
      ]),
    );
    expect(countOf(model, '<basematerials ')).toBe(1);
    // 立体の色が添字 0・1、面の色がその後ろの 2・3。
    expect(model).toContain('<object id="2" type="model" pid="1" pindex="0"');
    expect(model).toContain('<object id="3" type="model" pid="1" pindex="1"');
    expect(countOf(model, '<base ')).toBe(4);
    expect(countOf(model, 'p1="2"')).toBe(2);
    expect(countOf(model, 'p1="3"')).toBe(2);
  });

  it('色を書かない指定なら面の色も p1 も出ない', () => {
    const model = modelXmlOf(
      writeThreeMf(
        [boxPart({ faceColors: sixFaceColors(), faceRanges: boxFaceRanges() })],
        { withColors: false },
      ),
    );
    expect(model).not.toContain('<basematerials');
    expect(model).not.toContain('p1=');
  });

  it('面の色の値が 0〜1 でなければ断る(立体の色と同じ断り)', () => {
    expect(() =>
      writeThreeMf([
        boxPart({
          faceColors: new Map<number, ThreeMfColor>([[0, [1.5, 0, 0]]]),
          faceRanges: boxFaceRanges(),
        }),
      ]),
    ).toThrow(THREE_MF_INVALID_COLOR_MESSAGE);
  });

  it('kernel の並び(Uint32Array の添字)と面の色を一緒に渡せる', () => {
    const mesh = boxMesh(20);
    const model = modelXmlOf(
      writeThreeMf([
        {
          name: null,
          color: null,
          positions: new Float32Array(mesh.positions),
          indices: new Uint32Array(mesh.indices),
          faceColors: new Map<number, ThreeMfColor>([[5, [1, 0, 0]]]),
          faceRanges: boxFaceRanges(),
        },
      ]),
    );
    expect(countOf(model, '<base ')).toBe(2);
    expect(countOf(model, ' p1="1"')).toBe(2);
  });
});

describe('3MF の名前', () => {
  it('名前は <base> と <object> の両方に出て、XML の特殊文字は逃がされる', () => {
    const model = modelXmlOf(writeThreeMf([boxPart({ name: '取っ手 <A> & "B"' })]));
    expect(model).toContain('<base name="取っ手 &lt;A&gt; &amp; &quot;B&quot;"');
    expect(model).toContain('name="取っ手 &lt;A&gt; &amp; &quot;B&quot;">');
  });

  it('名前が無ければ <object> に name を書かず、<base> は通し名になる', () => {
    const model = modelXmlOf(writeThreeMf([boxPart(), boxPart({ name: '' })]));
    expect(model).toContain('<base name="body_1"');
    expect(model).toContain('<base name="body_2"');
    expect(model).toContain('<object id="2" type="model" pid="1" pindex="0">');
  });
});

describe('3MF の決定性と断り', () => {
  it('同じ入力から 2 回書くとバイト列が完全に一致する(§0.a-0.62)', () => {
    const first = writeThreeMf([boxPart({ name: '本体', color: [0.1, 0.2, 0.3] })]);
    const second = writeThreeMf([boxPart({ name: '本体', color: [0.1, 0.2, 0.3] })]);
    expect(first.length).toBe(second.length);
    expect(Array.from(first)).toEqual(Array.from(second));
  });

  it('空の並びは断らず、立体の入っていない 3MF を返す(STL / OBJ と同じ判断)', () => {
    const bytes = writeThreeMf([]);
    const entries = unzipToText(bytes);
    expect(Object.keys(entries)).toHaveLength(3);
    const model = entries[THREE_MF_MODEL_ENTRY];
    expect(countOf(model, '<object ')).toBe(0);
    expect(countOf(model, '<item ')).toBe(0);
    // 中身の無い <basematerials> は仕様が許さないので作らない。
    expect(model).not.toContain('<basematerials');
    expect(model).toContain('<build>');
  });

  it('頂点の並びが 3 の倍数でなければ断る', () => {
    expect(() => writeThreeMf([boxPart({ positions: [0, 0, 0, 1, 1] })])).toThrow(
      THREE_MF_INVALID_POSITIONS_MESSAGE,
    );
  });

  it('添字の並びが 3 の倍数でない・頂点を指していなければ断る', () => {
    expect(() => writeThreeMf([boxPart({ indices: [0, 1] })])).toThrow(
      THREE_MF_INVALID_INDICES_MESSAGE,
    );
    expect(() => writeThreeMf([boxPart({ indices: [0, 1, 8] })])).toThrow(
      THREE_MF_INVALID_INDICES_MESSAGE,
    );
    expect(() => writeThreeMf([boxPart({ indices: [0, 1, -1] })])).toThrow(
      THREE_MF_INVALID_INDICES_MESSAGE,
    );
  });

  it('kernel の並び(Float32Array / Uint32Array)をそのまま受け取れる', () => {
    const mesh = boxMesh(20);
    const bytes = writeThreeMf([
      {
        name: null,
        color: null,
        positions: new Float32Array(mesh.positions),
        indices: new Uint32Array(mesh.indices),
      },
    ]);
    const model = modelXmlOf(bytes);
    expect(countOf(model, '<vertex ')).toBe(8);
    expect(countOf(model, '<triangle ')).toBe(12);
  });
});

/** §2.17 #5「10 万三角形の 3MF 書き出しは 3 秒以内」。 */
const THREE_MF_WRITE_LIMIT_MS = 3000;

/** 計画書 §2.17 #5 の見積もりの前提(頂点 5 万・三角形 10 万)。 */
const BIG_VERTEX_COUNT = 50_000;
const BIG_TRIANGLE_COUNT = 100_000;

describe('3MF の書き出しの性能(§2.17 #5)', () => {
  it(`10 万三角形を ${String(THREE_MF_WRITE_LIMIT_MS)} ms 以内に書く`, () => {
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

    const startedAt = performance.now();
    const bytes = writeThreeMf([{ name: '大きな形', color: null, positions, indices }]);
    const elapsedMs = performance.now() - startedAt;

    const model = unzipSync(bytes)[THREE_MF_MODEL_ENTRY];
    console.log(
      `3MF 書き出し(頂点 ${String(BIG_VERTEX_COUNT)}・三角形 ${String(BIG_TRIANGLE_COUNT)}): ` +
        `${elapsedMs.toFixed(1)} ms / 上限 ${String(THREE_MF_WRITE_LIMIT_MS)} ms、` +
        `圧縮前の XML ${(model.length / 1024 / 1024).toFixed(2)} MB、` +
        `ZIP ${(bytes.length / 1024 / 1024).toFixed(2)} MB`,
    );
    expect(model.length).toBeGreaterThan(0);
    expectWithinBudget(elapsedMs, THREE_MF_WRITE_LIMIT_MS, '3MF 書き出し(10 万三角形)');
  });
});
