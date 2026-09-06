import { expectWithinBudget } from '@pointercad/test-utils';
import { beforeAll, describe, expect, it } from 'vitest';

import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import type { OcctShapeHandle } from './makeBox.js';
import { STEP_NO_SOLID_MESSAGE, STEP_READ_FAILED_MESSAGE, readStep } from './readStep.js';
import { measureVolume } from './solidMesh.js';
import { boundingDiagonal, faceAt } from './subShapes.js';
import { makeCompound } from './transformShape.js';
import type { StepWriteEntry } from './writeStep.js';
import { writeStep } from './writeStep.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/** P5 の既定の外観の色 `#b8bfcc` を 0〜1 で表したもの。 */
const DEFAULT_COLOR: readonly [number, number, number] = [184 / 255, 191 / 255, 204 / 255];

/** 検査用の箱。 */
function box(dx: number, dy: number, dz: number): OcctShapeHandle {
  return makeBox(oc, { dx, dy, dz });
}

/** 立体の一覧を STEP のバイト列にする(タスク7 の書き出しをそのまま使う)。 */
function writeBytes(entries: readonly StepWriteEntry[]): Uint8Array {
  return writeStep(oc, entries).bytes;
}

/** 箱 1 つを名前と色つきで書き出す。 */
function boxStep(dx: number, dy: number, dz: number, name: string | null): Uint8Array {
  const handle = box(dx, dy, dz);
  try {
    return writeBytes([{ shape: handle.shape, name, color: DEFAULT_COLOR }]);
  } finally {
    handle.delete();
  }
}

/**
 * 単位が INCH の STEP を作る。
 *
 * OCCT の設定表 `write.step.unit` を `INCH` にすると、書き出しの座標が inch になり、
 * ヘッダに `CONVERSION_BASED_UNIT('INCH',…)` が入る(2026-09-06 実測)。
 * 設定表は OCCT の実体ごとに 1 つしかないので、**必ず `MM` へ戻す**。
 */
function inchStep(millimetres: number, name: string): Uint8Array {
  oc.Interface_Static.SetCVal('write.step.unit', 'INCH');
  try {
    return boxStep(millimetres, millimetres, millimetres, name);
  } finally {
    oc.Interface_Static.SetCVal('write.step.unit', 'MM');
  }
}

/** 形の中の面・辺・頂点の数を数える(`hasSolid` と同じ数え方)。 */
function countSubShapes(shape: Parameters<typeof boundingDiagonal>[1]): {
  faces: number;
  edges: number;
  vertices: number;
} {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_2(shape, map, true, true);
    const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
    const edgeType = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
    const vertexType = oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
    let faces = 0;
    let edges = 0;
    let vertices = 0;
    const count = Number(map.Size());
    for (let index = 1; index <= count; index += 1) {
      const sub = map.FindKey(index);
      const kind = sub.ShapeType();
      if (kind === faceType) {
        faces += 1;
      } else if (kind === edgeType) {
        edges += 1;
      } else if (kind === vertexType) {
        vertices += 1;
      }
      sub.delete();
    }
    return { faces, edges, vertices };
  } finally {
    map.delete();
  }
}

/** 形の体積を測る(読み込んだ形をそのまま測る)。 */
function volumeOf(shape: Parameters<typeof boundingDiagonal>[1]): number {
  return measureVolume(oc, shape);
}

describe('STEP の読み込み(P6 タスク8)', () => {
  it('読み込みに使うクラスが実行時に束縛されている(計画書 §1.5-1)', () => {
    expect(oc.STEPCAFControl_Reader_1).toBeTypeOf('function');
    expect(oc.STEPControl_Reader_1).toBeTypeOf('function');
    expect(oc.TDF_LabelSequence_1).toBeTypeOf('function');
    expect(oc.Handle_TDF_Attribute_1).toBeTypeOf('function');
    expect(oc.TDataStd_Name).toBeTypeOf('function');
    expect(oc.TDataStd_TreeNode).toBeTypeOf('function');
    expect(oc.TDF_AttributeIterator_2).toBeTypeOf('function');
    expect(oc.TCollection_AsciiString_13).toBeTypeOf('function');
    expect(oc.Quantity_Color_1).toBeTypeOf('function');
    expect(oc.TColStd_SequenceOfAsciiString_1).toBeTypeOf('function');
    // 静的メソッドは参照だけすると @typescript-eslint/unbound-method が働くので typeof で書く。
    expect(typeof oc.Interface_Static.SetCVal).toBe('function');
    expect(typeof oc.XCAFDoc_ShapeTool.GetShape_2).toBe('function');
    expect(typeof oc.Quantity_Color.Convert_LinearRGB_To_sRGB_1).toBe('function');
  });

  it('書き出した箱 40×30×10 を読むと体積・面・辺・頂点がそろう(§2.3 の検証表)', () => {
    const read = readStep(oc, boxStep(40, 30, 10, '本体'));
    try {
      expect(read.bodies).toHaveLength(1);
      const body = read.bodies[0];
      // 40 × 30 × 10 = 12000。STEP は平面をそのまま保つので誤差は丸めの範囲。
      expect(volumeOf(body.shape)).toBeCloseTo(12000, 6);
      expect(countSubShapes(body.shape)).toEqual({ faces: 6, edges: 12, vertices: 8 });
      expect(body.kind).toBe('solid');
    } finally {
      read.delete();
    }
  });

  it('名前が日本語のまま戻る', () => {
    const read = readStep(oc, boxStep(40, 30, 10, '本体'));
    try {
      expect(read.bodies[0].name).toBe('本体');
    } finally {
      read.delete();
    }
  });

  it('色が戻る(書き出した #b8bfcc がそのまま)', () => {
    const read = readStep(oc, boxStep(40, 30, 10, '本体'));
    try {
      const color = read.bodies[0].color;
      expect(color).not.toBeNull();
      expect(color?.[0]).toBeCloseTo(DEFAULT_COLOR[0], 6);
      expect(color?.[1]).toBeCloseTo(DEFAULT_COLOR[1], 6);
      expect(color?.[2]).toBeCloseTo(DEFAULT_COLOR[2], 6);
    } finally {
      read.delete();
    }
  });

  it('mm の STEP は単位が mm と分かる(FR-811)', () => {
    const read = readStep(oc, boxStep(40, 30, 10, '本体'));
    try {
      expect(read.unit).toBe('mm');
      expect(read.unitNames).toEqual(['millimetre']);
    } finally {
      read.delete();
    }
  });

  it('箱と球の 2 立体を、名前と色を立体ごとに分けて読める', () => {
    const first = box(40, 30, 10);
    const maker = new oc.BRepPrimAPI_MakeSphere_1(10);
    const second = maker.Shape();
    let bytes: Uint8Array;
    try {
      bytes = writeBytes([
        { shape: first.shape, name: '箱', color: [1, 0.5, 0.25] },
        { shape: second, name: '球', color: [0.25, 0.5, 1] },
      ]);
    } finally {
      second.delete();
      maker.delete();
      first.delete();
    }

    const read = readStep(oc, bytes);
    try {
      expect(read.bodies).toHaveLength(2);
      expect(read.bodies.map((body) => body.name)).toEqual(['箱', '球']);
      expect(volumeOf(read.bodies[0].shape)).toBeCloseTo(12000, 6);
      // 4/3 · π · 10³ = 4188.790204786391。STEP は厳密な球面を保つ。
      expect(volumeOf(read.bodies[1].shape)).toBeCloseTo(4188.790204786391, 6);
      expect(read.bodies[0].color?.[0]).toBeCloseTo(1, 6);
      expect(read.bodies[0].color?.[2]).toBeCloseTo(0.25, 6);
      expect(read.bodies[1].color?.[0]).toBeCloseTo(0.25, 6);
      expect(read.bodies[1].color?.[2]).toBeCloseTo(1, 6);
    } finally {
      read.delete();
    }
  });

  it('inch の STEP は寸法が 25.4 倍で入り、単位が inch と分かる(FR-811、§1.5-6)', () => {
    const bytes = inchStep(25.4, 'インチの箱');
    // ファイルの中の座標は 1(= 1 inch)で、単位は CONVERSION_BASED_UNIT('INCH',…)。
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("CONVERSION_BASED_UNIT('INCH'");
    expect(text).toContain("CARTESIAN_POINT('',(1.,1.,1.))");

    const read = readStep(oc, bytes);
    try {
      expect(read.unit).toBe('inch');
      expect(read.unitNames).toEqual(['INCH']);
      // 1 inch = 25.4mm。25.4³ = 16387.064(= 645.16 × 25.4)。
      expect(volumeOf(read.bodies[0].shape)).toBeCloseTo(16387.064, 6);
      // 一辺 25.4 の立方体の対角線は 25.4 × √3 = 43.99184469667614。
      expect(boundingDiagonal(oc, read.bodies[0].shape)).toBeCloseTo(25.4 * Math.sqrt(3), 6);
      expect(countSubShapes(read.bodies[0].shape).faces).toBe(6);
    } finally {
      read.delete();
    }
  });

  it('色を読まない指定なら色は付かず、形と名前はそのまま読める', () => {
    const read = readStep(oc, boxStep(40, 30, 10, '本体'), { withColors: false });
    try {
      expect(read.bodies[0].color).toBeNull();
      expect(read.bodies[0].name).toBe('本体');
      expect(volumeOf(read.bodies[0].shape)).toBeCloseTo(12000, 6);
    } finally {
      read.delete();
    }
  });

  it('名前を渡さずに書き出したものは OCCT の既定の名前(SOLID)で戻る', () => {
    const read = readStep(oc, boxStep(20, 20, 20, null));
    try {
      expect(read.bodies[0].name).toBe('SOLID');
    } finally {
      read.delete();
    }
  });

  it('STEP でないバイト列は日本語の理由で断る(NFR-RE-1)', () => {
    const bytes = new TextEncoder().encode('これは STEP ではありません');
    expect(() => readStep(oc, bytes)).toThrow(STEP_READ_FAILED_MESSAGE);
  });

  it('空のバイト列も日本語の理由で断る', () => {
    expect(() => readStep(oc, new Uint8Array(0))).toThrow(STEP_READ_FAILED_MESSAGE);
  });

  it('面だけの形(閉じた立体が無い)は日本語の理由で断る', () => {
    const handle = box(40, 30, 10);
    let bytes: Uint8Array;
    try {
      const face = faceAt(oc, handle.shape, 0);
      expect(face).not.toBeNull();
      if (face === null) {
        return;
      }
      try {
        bytes = writeBytes([{ shape: face, name: '一枚の面', color: null }]);
      } finally {
        face.delete();
      }
    } finally {
      handle.delete();
    }
    expect(() => readStep(oc, bytes)).toThrow(STEP_NO_SOLID_MESSAGE);
  });

  it('形の入っていない STEP も日本語の理由で断る(2026-09-06 実測)', () => {
    // OCCT の書き出しが作ったヘッダをそのまま使い、DATA 節だけを空にする。
    // **実測: STEP では「読めない」と「形が無い」を区別できない。** 中身が空でも、
    // APPLICATION_CONTEXT だけでも、PRODUCT だけでも、`Perform_2` は一様に false を返す
    // (取り込むものが 1 つも無いと失敗とみなす)。だから断りは「読めませんでした」になる。
    // `readStep` の「形が入っていません」は、読み手が成功を返したのに自由な形が 0 個だった
    // 場合の備えとして残してある(STL / OBJ の読み込み——タスク17・18——では区別が要る)。
    const handle = box(10, 10, 10);
    let text: string;
    try {
      text = new TextDecoder().decode(
        writeBytes([{ shape: handle.shape, name: '本体', color: null }]),
      );
    } finally {
      handle.delete();
    }
    const empty = `${text.slice(0, text.indexOf('DATA;'))}DATA;\nENDSEC;\nEND-ISO-10303-21;\n`;
    expect(() => readStep(oc, new TextEncoder().encode(empty))).toThrow(STEP_READ_FAILED_MESSAGE);
  });

  it('読み込みのあとに仮想ファイルの置き場が空になっている', () => {
    const read = readStep(oc, boxStep(40, 30, 10, '本体'));
    read.delete();
    // FS.readdir の戻りは型の上では any なので、実行時に配列と文字列を確かめる。
    const listed: unknown = oc.FS.readdir('/pointercad');
    const entries: readonly unknown[] = Array.isArray(listed) ? listed : [];
    const names = entries.filter(
      (entry) => typeof entry === 'string' && entry !== '.' && entry !== '..',
    );
    expect(names).toEqual([]);
  });

  it('同じバイト列を 2 回読んでも同じ値になる(§0.a-0.62 の決定性)', () => {
    const bytes = boxStep(40, 30, 10, '本体');
    const first = readStep(oc, bytes);
    const firstVolume = volumeOf(first.bodies[0].shape);
    const firstName = first.bodies[0].name;
    first.delete();
    const second = readStep(oc, bytes);
    try {
      expect(volumeOf(second.bodies[0].shape)).toBe(firstVolume);
      expect(second.bodies[0].name).toBe(firstName);
    } finally {
      second.delete();
    }
  });

  it('面 504 枚の形を読めることと、その所要を記録する(§2.17-2 への実測)', () => {
    const handles: OcctShapeHandle[] = [];
    for (let index = 0; index < 84; index += 1) {
      handles.push(box(10, 10, 10 + index));
    }
    let bytes: Uint8Array;
    try {
      const compound = makeCompound(
        oc,
        handles.map((handle) => handle.shape),
      );
      try {
        bytes = writeBytes([{ shape: compound.shape, name: '面の多い部品', color: null }]);
      } finally {
        compound.delete();
      }
    } finally {
      for (const handle of handles) {
        handle.delete();
      }
    }

    const startedAt = performance.now();
    const read = readStep(oc, bytes);
    const elapsedMs = performance.now() - startedAt;
    try {
      // 箱 84 個 × 6 面 = 504 面。
      expect(countSubShapes(read.bodies[0].shape).faces).toBe(504);
      console.log(
        `STEP 読み込み(面 504 枚): ${elapsedMs.toFixed(0)} ms / ${String(bytes.length)} バイト`,
      );
      // 計画書 §2.17-2 の上限は 5 秒。2026-09-06 の実測は **2,859 / 4,335 / 4,437ms**
      // (同じ機械での 3 回。ばらつきが大きく、余裕は 1.1〜1.7 倍しかない)。
      // 判定は既存の切替(`POINTERCAD_PERF_STRICT`)に乗せる——並列作業中の CPU 競合で
      // 落ちないようにするため(`rules/06` 10.3、`rules/03` §7.1)。**上限は緩めない。**
      // 注意 1: `readStep` が `Reader()` の複製を解放していなかったときは同じ検査が
      // 9,081ms かかっていた。この数値が 5 秒へ近づいたら、まず解放の漏れを疑う。
      // 注意 2: ここで読ませるのは「箱 84 個を 1 つにまとめた形」(1.27MB)で、
      // 面の数が同じでも立体 1 つの実用部品より重い。上限の置き場は §2.17 のとおり
      // タスク16(`worker/exchangePerformance.test.ts`)なので、そちらで題材を
      // 見直すかどうかは統括が決める。
      expectWithinBudget(elapsedMs, 5000, '面 504 枚の STEP 読み込み(§2.17-2)');
    } finally {
      read.delete();
    }
  });

  it('箱 1 つの往復(書いて読む)の所要を記録する', () => {
    const handle = box(40, 30, 10);
    try {
      const startedAt = performance.now();
      const bytes = writeBytes([{ shape: handle.shape, name: '本体', color: DEFAULT_COLOR }]);
      const read = readStep(oc, bytes);
      const elapsedMs = performance.now() - startedAt;
      try {
        expect(volumeOf(read.bodies[0].shape)).toBeCloseTo(12000, 6);
      } finally {
        read.delete();
      }
      // 数値そのものは環境差が大きいので、上限判定は §2.17 の性能検査(タスク16)へ譲る。
      console.log(`STEP 往復(箱 1 つ): ${elapsedMs.toFixed(0)} ms`);
      expect(elapsedMs).toBeLessThan(5000);
    } finally {
      handle.delete();
    }
  });
});
