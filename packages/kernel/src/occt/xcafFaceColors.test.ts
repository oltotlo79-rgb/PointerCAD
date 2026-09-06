import { beforeAll, describe, expect, it } from 'vitest';

import type { Allocations, OcctDeletable } from './allocations.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import type { OcctShapeHandle } from './makeBox.js';
import type { RgbTuple, XcafDocument } from './xcafDocument.js';
import { buildXcafDocument } from './xcafDocument.js';
import type { FaceColorMap } from './xcafFaceColors.js';
import { checkExportColor, checkFaceColors, exportColorKey } from './xcafFaceColors.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/** 検査用の箱(面は 6 枚)。 */
function box(size: number): OcctShapeHandle {
  return makeBox(oc, { dx: size, dy: size, dz: size });
}

/** 確保と解放の回数を数える控え(`xcafDocument.test.ts` と同じ仕掛け)。 */
function countingAllocations(): {
  readonly allocations: Allocations;
  kept: () => number;
  deleted: () => number;
} {
  const inner = createAllocations();
  let keptCount = 0;
  let deletedCount = 0;
  return {
    allocations: {
      keep<T extends OcctDeletable>(item: T): T {
        keptCount += 1;
        const original = item.delete.bind(item);
        item.delete = (): void => {
          deletedCount += 1;
          original();
        };
        return inner.keep(item);
      },
      release: (): void => {
        inner.release();
      },
    },
    kept: () => keptCount,
    deleted: () => deletedCount,
  };
}

/**
 * 文書に登録されている色ラベルの数を数える。
 *
 * `handle.get()` の戻りは**借り物**なので解放しない(rules/06 10.13)。
 * `ColorTool(main)` が返す `Handle_...` のほうは自分で作ったものなので解放する。
 */
function colorLabelCount(document: XcafDocument): number {
  const main = document.handle.get().Main();
  const holder = oc.XCAFDoc_DocumentTool.ColorTool(main);
  const labels = new oc.TDF_LabelSequence_1();
  try {
    holder.get().GetColors(labels);
    return labels.Length();
  } finally {
    labels.delete();
    holder.delete();
    main.delete();
  }
}

/** 面の色の表を組み立てる(番号 → 色)。 */
function faceColorMap(entries: readonly (readonly [number, RgbTuple])[]): FaceColorMap {
  return new Map<number, RgbTuple>(entries);
}

/** 6 面すべてを別の色にする表。 */
const SIX_DISTINCT: FaceColorMap = faceColorMap([
  [0, [0.1, 0.2, 0.3]],
  [1, [0.2, 0.3, 0.4]],
  [2, [0.3, 0.4, 0.5]],
  [3, [0.4, 0.5, 0.6]],
  [4, [0.5, 0.6, 0.7]],
  [5, [0.6, 0.7, 0.8]],
]);

/** 6 面のうち先頭の 3 面が同じ色、残り 3 面が別々の色(= 色の種類は 4)。 */
const THREE_SHARED: FaceColorMap = faceColorMap([
  [0, [0.1, 0.2, 0.3]],
  [1, [0.1, 0.2, 0.3]],
  [2, [0.1, 0.2, 0.3]],
  [3, [0.4, 0.5, 0.6]],
  [4, [0.5, 0.6, 0.7]],
  [5, [0.6, 0.7, 0.8]],
]);

describe('面ごとの色(P6 タスク7b、§2.5.1)', () => {
  it('§1.5-29 の実測: 面へ直接 SetColor_5 で色が付く(AddSubShape_1 は使わない)', () => {
    // ① 面のラベルを作る道(`AddSubShape_1`)は実行時にも在る。記録だけ残して使わない
    //    ——面へ直接 `SetColor_5` で色が付くことを実測したため(このファイル冒頭の表)。
    //    メソッドは参照だけすると @typescript-eslint/unbound-method が働くので typeof で書く。
    expect(typeof oc.XCAFDoc_ShapeTool.prototype.AddSubShape_1).toBe('function');
    expect(typeof oc.XCAFDoc_ColorTool.prototype.FindColor_3).toBe('function');

    // ② 面へ直接渡す道で本当に色が載ることを、文書の色ラベルの数で確かめる。
    const handle = box(20);
    const document = buildXcafDocument(oc, [
      { shape: handle.shape, name: null, color: null, faceColors: faceColorMap([[0, [0.8, 0.2667, 0.2667]]]) },
    ]);
    try {
      expect(document.colorWritten).toBe(true);
      expect(colorLabelCount(document)).toBe(1);
    } finally {
      document.delete();
      handle.delete();
    }
  });

  it('6 面すべてを別の色にすると色ラベルが 6 つになる', () => {
    const handle = box(20);
    const document = buildXcafDocument(oc, [
      { shape: handle.shape, name: null, color: null, faceColors: SIX_DISTINCT },
    ]);
    try {
      expect(colorLabelCount(document)).toBe(6);
    } finally {
      document.delete();
      handle.delete();
    }
  });

  it('6 面のうち 3 面が同じ色なら色ラベルは 4 つ(同じ色を 1 つにまとめる)', () => {
    const handle = box(20);
    const document = buildXcafDocument(oc, [
      { shape: handle.shape, name: null, color: null, faceColors: THREE_SHARED },
    ]);
    try {
      // 色の種類は [0.1,0.2,0.3] / [0.4,0.5,0.6] / [0.5,0.6,0.7] / [0.6,0.7,0.8] の 4 つ。
      expect(colorLabelCount(document)).toBe(4);
    } finally {
      document.delete();
      handle.delete();
    }
  });

  it('立体の色と面の色を両方渡すと色ラベルは 1 + 面の色の種類になる', () => {
    const handle = box(20);
    const document = buildXcafDocument(oc, [
      { shape: handle.shape, name: null, color: [0.72, 0.75, 0.8], faceColors: THREE_SHARED },
    ]);
    try {
      expect(colorLabelCount(document)).toBe(5);
    } finally {
      document.delete();
      handle.delete();
    }
  });

  it('面の色を渡さない/空の表を渡すと、面の色を足す前と同じ文書になる', () => {
    const handle = box(20);
    const plain = buildXcafDocument(oc, [{ shape: handle.shape, name: null, color: [0.72, 0.75, 0.8] }]);
    const empty = buildXcafDocument(oc, [
      { shape: handle.shape, name: null, color: [0.72, 0.75, 0.8], faceColors: faceColorMap([]) },
    ]);
    try {
      expect(colorLabelCount(plain)).toBe(1);
      expect(colorLabelCount(empty)).toBe(1);
      expect(empty.colorWritten).toBe(plain.colorWritten);
    } finally {
      empty.delete();
      plain.delete();
      handle.delete();
    }
  });

  it('色を書かない指定(withColors: false)では面の色も載らない', () => {
    const handle = box(20);
    const document = buildXcafDocument(
      oc,
      [{ shape: handle.shape, name: null, color: null, faceColors: SIX_DISTINCT }],
      { withColors: false },
    );
    try {
      expect(document.colorWritten).toBe(false);
      expect(colorLabelCount(document)).toBe(0);
    } finally {
      document.delete();
      handle.delete();
    }
  });

  it('面の通し番号が範囲の外なら日本語の理由で断る(落ちない)', () => {
    const handle = box(20);
    try {
      expect(() =>
        buildXcafDocument(oc, [
          { shape: handle.shape, name: null, color: null, faceColors: faceColorMap([[99, [0.1, 0.2, 0.3]]]) },
        ]),
      ).toThrow('色を付ける面が見つかりません(面の番号 99)。');
      // 断ったあとも OCCT は使える(記憶が壊れていない)。
      const ok = buildXcafDocument(oc, [{ shape: handle.shape, name: null, color: null }]);
      ok.delete();
    } finally {
      handle.delete();
    }
  });

  it('面の通し番号が負・整数でないときも日本語の理由で断る', () => {
    const handle = box(20);
    try {
      expect(() =>
        buildXcafDocument(oc, [
          { shape: handle.shape, name: null, color: null, faceColors: faceColorMap([[-1, [0.1, 0.2, 0.3]]]) },
        ]),
      ).toThrow('色を付ける面が見つかりません(面の番号 -1)。');
      expect(() =>
        buildXcafDocument(oc, [
          { shape: handle.shape, name: null, color: null, faceColors: faceColorMap([[1.5, [0.1, 0.2, 0.3]]]) },
        ]),
      ).toThrow('色を付ける面が見つかりません(面の番号 1.5)。');
    } finally {
      handle.delete();
    }
  });

  it('面の色の値が 0〜1 の外なら日本語の理由で断る', () => {
    const handle = box(20);
    try {
      expect(() =>
        buildXcafDocument(oc, [
          { shape: handle.shape, name: null, color: null, faceColors: faceColorMap([[0, [1.5, 0, 0]]]) },
        ]),
      ).toThrow('書き出しの色の値が正しくありません。');
      expect(() =>
        buildXcafDocument(oc, [
          { shape: handle.shape, name: null, color: null, faceColors: faceColorMap([[0, [0, Number.NaN, 0]]]) },
        ]),
      ).toThrow('書き出しの色の値が正しくありません。');
    } finally {
      handle.delete();
    }
  });

  it('確保したものは全部解放される(delete() の回数が確保の回数と一致)', () => {
    const handle = box(20);
    const counter = countingAllocations();
    const document = buildXcafDocument(
      oc,
      [{ shape: handle.shape, name: '本体', color: [0.72, 0.75, 0.8], faceColors: THREE_SHARED }],
      { allocations: counter.allocations },
    );
    try {
      // 面 6 枚 + 色 4 種を積んでいるので、面の色を渡さないときより確保が増えている。
      expect(counter.kept()).toBeGreaterThan(6);
      expect(counter.deleted()).toBe(0);
    } finally {
      document.delete();
      handle.delete();
    }
    expect(counter.deleted()).toBe(counter.kept());
  });

  it('checkExportColor は 0〜1 の有限の数だけを通す', () => {
    expect(() => {
      checkExportColor([0, 0.5, 1]);
    }).not.toThrow();
    expect(() => {
      checkExportColor([-0.001, 0, 0]);
    }).toThrow('書き出しの色の値が正しくありません。');
    expect(() => {
      checkExportColor([0, 1.001, 0]);
    }).toThrow('書き出しの色の値が正しくありません。');
    expect(() => {
      checkExportColor([0, 0, Number.POSITIVE_INFINITY]);
    }).toThrow('書き出しの色の値が正しくありません。');
  });

  it('checkFaceColors は面の番号と色をまとめて確かめる(範囲は見ない)', () => {
    expect(() => {
      checkFaceColors(SIX_DISTINCT);
    }).not.toThrow();
    // 面の枚数は形を見ないと分からないので、大きな番号はここでは通る。
    expect(() => {
      checkFaceColors(faceColorMap([[9999, [0, 0, 0]]]));
    }).not.toThrow();
    expect(() => {
      checkFaceColors(faceColorMap([[-2, [0, 0, 0]]]));
    }).toThrow('色を付ける面が見つかりません(面の番号 -2)。');
  });

  it('exportColorKey は同じ色を同じ鍵に、違う色を違う鍵にする', () => {
    expect(exportColorKey([0.1, 0.2, 0.3])).toBe(exportColorKey([0.1, 0.2, 0.3]));
    // 区切りが無いと "0.1"+"0.23" と "0.12"+"0.3" が同じ文字列になってしまう。
    expect(exportColorKey([0.1, 0.23, 0])).not.toBe(exportColorKey([0.12, 0.3, 0]));
  });
});
