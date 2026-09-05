import { beforeAll, describe, expect, it } from 'vitest';

import type { Allocations, OcctDeletable } from './allocations.js';
import { createAllocations } from './allocations.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import type { OcctShapeHandle } from './makeBox.js';
import { buildXcafDocument } from './xcafDocument.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/** 確保と解放の回数を数える控え(検証表「delete() の回数が確保の回数と一致」)。 */
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
        // 実体はそのまま返しつつ、delete() の呼び出しだけを数える包みへ差し替える。
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

/** 検査用の箱を作り、後始末を呼び出し側へ返す。 */
function box(size: number): OcctShapeHandle {
  return makeBox(oc, { dx: size, dy: size, dz: size });
}

describe('XCAF の文書の組み立て(P6 タスク7)', () => {
  it('文書の組み立てに要るクラスが実行時に束縛されている(計画書 §1.5-1 の実測)', () => {
    expect(oc.TDocStd_Document).toBeTypeOf('function');
    expect(oc.Handle_TDocStd_Document_2).toBeTypeOf('function');
    expect(oc.TCollection_ExtendedString_2).toBeTypeOf('function');
    expect(oc.XCAFDoc_DocumentTool).toBeTypeOf('function');
    expect(oc.XCAFDoc_ShapeTool).toBeTypeOf('function');
    expect(oc.XCAFDoc_ColorTool).toBeTypeOf('function');
    expect(oc.Quantity_Color_3).toBeTypeOf('function');
    expect(oc.TDataStd_Name).toBeTypeOf('function');
    expect(oc.STEPCAFControl_Writer_1).toBeTypeOf('function');
    expect(oc.TColStd_IndexedDataMapOfStringString_1).toBeTypeOf('function');
    expect(oc.Message_ProgressRange_1).toBeTypeOf('function');
    // 静的メソッドは値として渡さない(@typescript-eslint/unbound-method)ので typeof で判定する。
    expect(typeof oc.XCAFDoc_DocumentTool.ShapeTool).toBe('function');
    expect(typeof oc.XCAFDoc_DocumentTool.ColorTool).toBe('function');
    expect(typeof oc.TDataStd_Name.Set_1).toBe('function');
  });

  it('色に要る 2 つの列挙が実行時に取れる(§0.a-0.17 の前提)', () => {
    const typeOfColor: unknown = oc.Quantity_TypeOfColor.Quantity_TOC_sRGB;
    const colorType: unknown = oc.XCAFDoc_ColorType.XCAFDoc_ColorSurf;
    expect(typeOfColor).toBeTypeOf('object');
    expect(colorType).toBeTypeOf('object');
    expect(typeOfColor).not.toBeNull();
    expect(colorType).not.toBeNull();
  });

  it('立体 3 つでラベルが 3 つできる', () => {
    const shapes = [box(10), box(12), box(14)];
    try {
      const document = buildXcafDocument(
        oc,
        shapes.map((handle, index) => ({
          shape: handle.shape,
          name: `箱${index + 1}`,
          color: null,
        })),
      );
      try {
        expect(document.labels).toHaveLength(3);
        for (const label of document.labels) {
          expect(label.IsNull()).toBe(false);
        }
      } finally {
        document.delete();
      }
    } finally {
      for (const handle of shapes) {
        handle.delete();
      }
    }
  });

  it('空の一覧は日本語の理由で断る', () => {
    expect(() => buildXcafDocument(oc, [])).toThrow('書き出せる立体がありません。');
  });

  it('色を渡さなければ色は載らない', () => {
    const handle = box(20);
    try {
      const document = buildXcafDocument(oc, [{ shape: handle.shape, name: null, color: null }]);
      try {
        expect(document.colorWritten).toBe(false);
      } finally {
        document.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('色を渡せば色が載る', () => {
    const handle = box(20);
    try {
      const document = buildXcafDocument(oc, [
        // #b8bfcc(P5 の既定の外観の色)を 255 で割った値。
        { shape: handle.shape, name: '本体', color: [184 / 255, 191 / 255, 204 / 255] },
      ]);
      try {
        expect(document.colorWritten).toBe(true);
      } finally {
        document.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('色を書かない指定なら、色を渡しても載らない', () => {
    const handle = box(20);
    try {
      const document = buildXcafDocument(
        oc,
        [{ shape: handle.shape, name: '本体', color: [1, 0.5, 0] }],
        { withColors: false },
      );
      try {
        expect(document.colorWritten).toBe(false);
      } finally {
        document.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('述語ガードが偽になっても落ちず、色なしで組み立てる(§2.5 の検証表)', () => {
    // 列挙の入れ物だけを空のものに差し替えた見かけを作る。Proxy は元の型を保つので、
    // as / any を使わずに「列挙が取れない環境」を再現できる。
    const withoutEnums = new Proxy(oc, {
      get(target, property, receiver): unknown {
        if (property === 'Quantity_TypeOfColor' || property === 'XCAFDoc_ColorType') {
          return {};
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const handle = box(20);
    try {
      const document = buildXcafDocument(withoutEnums, [
        { shape: handle.shape, name: '本体', color: [0.2, 0.4, 0.6] },
      ]);
      try {
        expect(document.colorWritten).toBe(false);
        expect(document.labels).toHaveLength(1);
      } finally {
        document.delete();
      }
    } finally {
      handle.delete();
    }
  });

  it('色の値が 0〜1 の外なら日本語の理由で断る', () => {
    const handle = box(20);
    try {
      expect(() =>
        buildXcafDocument(oc, [{ shape: handle.shape, name: null, color: [1.5, 0, 0] }]),
      ).toThrow('書き出しの色の値が正しくありません。');
      expect(() =>
        buildXcafDocument(oc, [{ shape: handle.shape, name: null, color: [0, -1, 0] }]),
      ).toThrow('書き出しの色の値が正しくありません。');
      expect(() =>
        buildXcafDocument(oc, [{ shape: handle.shape, name: null, color: [0, 0, Number.NaN] }]),
      ).toThrow('書き出しの色の値が正しくありません。');
    } finally {
      handle.delete();
    }
  });

  it('確保した数だけ解放する(P5 §4 の規律)', () => {
    const counter = countingAllocations();
    const handle = box(20);
    try {
      const document = buildXcafDocument(
        oc,
        [{ shape: handle.shape, name: '本体', color: [0.2, 0.4, 0.6] }],
        { allocations: counter.allocations },
      );
      expect(counter.kept()).toBeGreaterThan(0);
      expect(counter.deleted()).toBe(0);
      document.delete();
      expect(counter.deleted()).toBe(counter.kept());
      // 2 度目の解放は何もしない(控えが空になっている)。
      document.delete();
      expect(counter.deleted()).toBe(counter.kept());
    } finally {
      handle.delete();
    }
  });

  it('組み立ての途中で断ったら、その場で全部返す', () => {
    const counter = countingAllocations();
    const reason = new Error('名前を付ける途中で断った');
    // 名前を付ける段だけが失敗する見かけを作る(Proxy は元の型を保つ)。
    const failing = new Proxy(oc, {
      get(target, property, receiver): unknown {
        if (property === 'TDataStd_Name') {
          return {
            Set_1: (): never => {
              throw reason;
            },
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const handle = box(20);
    try {
      expect(() =>
        buildXcafDocument(failing, [{ shape: handle.shape, name: '本体', color: null }], {
          allocations: counter.allocations,
        }),
      ).toThrow(reason);
      // 断った時点までに確保したものは、その場で全部返っている。
      expect(counter.kept()).toBeGreaterThan(0);
      expect(counter.deleted()).toBe(counter.kept());
    } finally {
      handle.delete();
    }
  });
});
