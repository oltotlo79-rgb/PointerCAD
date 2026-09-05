import { beforeAll, describe, expect, it } from 'vitest';

import type { OpenCascadeInstance, TopoDS_Shape } from 'opencascade.js/dist/opencascade.full.js';

import {
  BREP_EMPTY_SHAPE_MESSAGE,
  BREP_READ_FAILED_MESSAGE,
  readBrepBytes,
  writeBrepBytes,
} from './brepBytes.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { measureVolume } from './solidMesh.js';
import { withVirtualFile } from './virtualFile.js';

/**
 * 形(B-rep)とバイト列の相互変換の検査(計画書 P6 タスク9。FR-802 / FR-801)。
 *
 * 期待値の根拠は計画書「タスク9」の検証表。B-rep は厳密な面(平面・球面)を持つので、
 * 三角形近似と違い往復しても体積が寸分も動かない。
 */

/** 20³ の箱の体積(mm³)。往復の前後で一致することを確かめる。 */
const BOX_VOLUME_MM3 = 8000;

/** 半径 10 の球の体積(mm³)= 4/3·π·1000。B-rep は厳密な球面を保つ。 */
const SPHERE_VOLUME_MM3 = 4188.790204786391;

/** 体積の許容差(計画書の検証表)。 */
const VOLUME_TOLERANCE_MM3 = 1e-9;

/**
 * 20³ の箱(三角形分割を掛けていない状態)を `BinTools` で書いたバイト数。
 *
 * **2026-09-06 の実測値**(opencascade.js 2.0.0-beta.b5ff984)。見積もりではない。
 * OCCT に時刻や連番は入らないので、同じ版なら OS が変わっても同じ数になる
 * (決定性。計画書 §0.a-0.62)。この数が動いたときは OCCT の版か、渡す形に
 * 三角形分割が付いたことの合図なので、黙って通さずここで気づけるようにする。
 */
const BOX_BREP_BYTE_COUNT = 4494;

/** 半径 10 の球を `BinTools` で書いたバイト数(同じく 2026-09-06 の実測値)。 */
const SPHERE_BREP_BYTE_COUNT = 939;

let oc: OpenCascadeInstance;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/**
 * 面・辺・頂点の数。`makePrimitive.test.ts` と同じく `TopExp.MapShapes_2` +
 * `ShapeType()` の値どうしの比較で数える(列挙は引数に渡せないため)。
 */
function countSubShapes(
  shape: TopoDS_Shape,
): { readonly faces: number; readonly edges: number; readonly vertices: number } {
  const map = new oc.TopTools_IndexedMapOfShape_1();
  try {
    oc.TopExp.MapShapes_2(shape, map, true, true);
    const faceType = oc.TopAbs_ShapeEnum.TopAbs_FACE;
    const edgeType = oc.TopAbs_ShapeEnum.TopAbs_EDGE;
    const vertexType = oc.TopAbs_ShapeEnum.TopAbs_VERTEX;
    let faces = 0;
    let edges = 0;
    let vertices = 0;
    const total = map.Size();
    for (let position = 1; position <= total; position += 1) {
      const subShape = map.FindKey(position);
      const shapeType = subShape.ShapeType();
      if (shapeType === faceType) {
        faces += 1;
      } else if (shapeType === edgeType) {
        edges += 1;
      } else if (shapeType === vertexType) {
        vertices += 1;
      }
      subShape.delete();
    }
    return { faces, edges, vertices };
  } finally {
    map.delete();
  }
}

/** 20³ の箱を 1 つ作る。使い終わったら `delete()` する。 */
function makeTestBox(): { readonly shape: TopoDS_Shape; delete: () => void } {
  const maker = new oc.BRepPrimAPI_MakeBox_2(20, 20, 20);
  const shape = maker.Shape();
  return {
    shape,
    delete(): void {
      shape.delete();
      maker.delete();
    },
  };
}

/** 半径 10 の球を 1 つ作る。使い終わったら `delete()` する。 */
function makeTestSphere(): { readonly shape: TopoDS_Shape; delete: () => void } {
  const maker = new oc.BRepPrimAPI_MakeSphere_1(10);
  const shape = maker.Shape();
  return {
    shape,
    delete(): void {
      shape.delete();
      maker.delete();
    },
  };
}

/** 2 つのバイト列で値が違う位置の数(長さが違うぶんも 1 つずつ数える)。 */
function countDifferences(left: Uint8Array, right: Uint8Array): number {
  let differences = 0;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      differences += 1;
    }
  }
  return differences;
}

/** 置き場に残っているファイル名(`.` と `..` を除く)。片付けの確認に使う。 */
function remaining(): string[] {
  // FS.readdir の戻りは型の上では any なので、as で決めつけずに実行時に確かめる。
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

describe('B-rep ↔ バイト列(P6 タスク9)', () => {
  it('BinTools と BRepTools が実行時に存在する(計画書 §1.5-8 の実測)', () => {
    expect(oc.BinTools).toBeTypeOf('function');
    expect(oc.BRepTools).toBeTypeOf('function');
    // 静的メソッドは値として渡さない(@typescript-eslint/unbound-method)ので typeof で判定する。
    expect(typeof oc.BinTools.Write_3).toBe('function');
    expect(typeof oc.BinTools.Read_2).toBe('function');
    // 後退先(§0.a-0.10)も揃っていることを記録しておく。
    expect(typeof oc.BRepTools.Write_3).toBe('function');
    expect(typeof oc.BRepTools.Read_2).toBe('function');
  });

  it('20³ の箱が往復して、体積・面・辺・頂点の数が変わらない', () => {
    const box = makeTestBox();
    try {
      const before = countSubShapes(box.shape);
      expect(measureVolume(oc, box.shape)).toBeCloseTo(BOX_VOLUME_MM3, 9);
      expect(before).toEqual({ faces: 6, edges: 12, vertices: 8 });

      const bytes = writeBrepBytes(oc, box.shape);
      const restored = readBrepBytes(oc, bytes);
      try {
        expect(Math.abs(measureVolume(oc, restored) - BOX_VOLUME_MM3)).toBeLessThan(
          VOLUME_TOLERANCE_MM3,
        );
        expect(countSubShapes(restored)).toEqual({ faces: 6, edges: 12, vertices: 8 });
      } finally {
        restored.delete();
      }
    } finally {
      box.delete();
    }
  });

  it('半径 10 の球が往復して、厳密な球面のままの体積を保つ', () => {
    const sphere = makeTestSphere();
    try {
      const bytes = writeBrepBytes(oc, sphere.shape);
      const restored = readBrepBytes(oc, bytes);
      try {
        // 三角形近似なら数 % ずれる。B-rep は球面そのものを持つので 1e-9 未満で一致する。
        expect(Math.abs(measureVolume(oc, restored) - SPHERE_VOLUME_MM3)).toBeLessThan(
          VOLUME_TOLERANCE_MM3,
        );
        // 球は「面 1 枚・辺 3 本(継ぎ目と 2 つの極)・頂点 2 つ」で表される。
        expect(countSubShapes(restored)).toEqual({ faces: 1, edges: 3, vertices: 2 });
      } finally {
        restored.delete();
      }
    } finally {
      sphere.delete();
    }
  });

  it('同じ形から 2 回書くとバイト列が完全に一致する(決定性。§0.a-0.62)', () => {
    const box = makeTestBox();
    try {
      const first = writeBrepBytes(oc, box.shape);
      const second = writeBrepBytes(oc, box.shape);
      expect(second.length).toBe(first.length);
      expect(Array.from(second)).toEqual(Array.from(first));
    } finally {
      box.delete();
    }
  });

  it('往復して読み直した形は、2 回目からのバイト列が完全に安定する', () => {
    const box = makeTestBox();
    try {
      const first = writeBrepBytes(oc, box.shape);
      const once = readBrepBytes(oc, first);
      try {
        const second = writeBrepBytes(oc, once);
        // 長さは変わらないが、20³ の箱では 6 バイトだけ値が違う(2026-09-06 実測。
        // 読み込みが辺の向きや「同じ媒介変数」の印を整えるため)。形は変わらない。
        expect(second.length).toBe(first.length);
        expect(countDifferences(first, second)).toBe(6);
        expect(Math.abs(measureVolume(oc, once) - BOX_VOLUME_MM3)).toBeLessThan(
          VOLUME_TOLERANCE_MM3,
        );

        // 2 周目からは 1 バイトも動かない。保存し直しても .pcad の中身が
        // 毎回変わることはない(§0.a-0.62 の決定性)。
        const twice = readBrepBytes(oc, second);
        try {
          expect(Array.from(writeBrepBytes(oc, twice))).toEqual(Array.from(second));
        } finally {
          twice.delete();
        }
      } finally {
        once.delete();
      }
    } finally {
      box.delete();
    }
  });

  it('20³ の箱と半径 10 の球のバイト数を記録する(見積もりを持たない)', () => {
    const box = makeTestBox();
    const sphere = makeTestSphere();
    try {
      const boxBytes = writeBrepBytes(oc, box.shape);
      const sphereBytes = writeBrepBytes(oc, sphere.shape);
      console.log(
        `[実測] B-rep のバイト数(BinTools): 20³ の箱 ${boxBytes.length} バイト / 半径 10 の球 ${sphereBytes.length} バイト`,
      );
      expect(boxBytes.length).toBe(BOX_BREP_BYTE_COUNT);
      expect(sphereBytes.length).toBe(SPHERE_BREP_BYTE_COUNT);
    } finally {
      sphere.delete();
      box.delete();
    }
  });

  it('BinTools と BRepTools の大きさを比べて記録する(§0.a-0.10 の判断の根拠)', () => {
    const box = makeTestBox();
    try {
      const binary = writeBrepBytes(oc, box.shape);
      // 後退先の大きさは比較のためだけに測る。実装は BinTools を使う。
      const range = new oc.Message_ProgressRange_1();
      try {
        const files = withVirtualFile(oc, 'brep', (path) => {
          expect(oc.BRepTools.Write_3(box.shape, path, range)).toBe(true);
        });
        console.log(
          `[実測] 20³ の箱: BinTools ${binary.length} バイト / BRepTools ${files[0].bytes.length} バイト`,
        );
        // どちらの形式でも .pcad へ収まる大きさであることだけを条件にする
        // (どちらが小さいかは版によって動きうるため、大小の判定は入れない)。
        expect(files[0].bytes.length).toBeGreaterThan(0);
        expect(binary.length).toBeGreaterThan(0);
      } finally {
        range.delete();
      }
    } finally {
      box.delete();
    }
  });

  it('壊れたバイト列は日本語の理由で断る(落ちない。NFR-RE-1)', () => {
    const broken = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() => readBrepBytes(oc, broken)).toThrow(BREP_READ_FAILED_MESSAGE);
  });

  it('B-rep でないバイト列(STEP の断片)も日本語の理由で断る', () => {
    const notBrep = new TextEncoder().encode('ISO-10303-21;\nHEADER;\nENDSEC;\n');
    expect(() => readBrepBytes(oc, notBrep)).toThrow(BREP_READ_FAILED_MESSAGE);
  });

  it('空のバイト列は日本語の理由で断る', () => {
    expect(() => readBrepBytes(oc, new Uint8Array())).toThrow(BREP_READ_FAILED_MESSAGE);
  });

  it('中身の無い形は書く前に断る(空のまま保存させない)', () => {
    const empty = new oc.TopoDS_Shape();
    try {
      expect(() => writeBrepBytes(oc, empty)).toThrow(BREP_EMPTY_SHAPE_MESSAGE);
    } finally {
      empty.delete();
    }
  });

  it('書き出しと読み込みのあと、仮想の置き場にファイルが残らない', () => {
    const box = makeTestBox();
    try {
      const bytes = writeBrepBytes(oc, box.shape);
      const restored = readBrepBytes(oc, bytes);
      restored.delete();
      // 壊れた入力で断ったときも残らない。
      expect(() => readBrepBytes(oc, new Uint8Array([9, 9, 9, 9]))).toThrow();
      expect(remaining()).toEqual([]);
    } finally {
      box.delete();
    }
  });
});
