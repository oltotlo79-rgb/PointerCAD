import { beforeAll, describe, expect, it } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import type { OcctShapeHandle } from './makeBox.js';
import type { StepWriteEntry } from './writeStep.js';
import { writeStep } from './writeStep.js';

let oc: Awaited<ReturnType<typeof loadOcctForNode>>;

beforeAll(async () => {
  oc = await loadOcctForNode();
});

/** 検査用の箱。 */
function box(size: number): OcctShapeHandle {
  return makeBox(oc, { dx: size, dy: size, dz: size });
}

/** 検査用の球(基本形状の作り手をそのまま使う)。 */
function sphere(radius: number): OcctShapeHandle {
  const maker = new oc.BRepPrimAPI_MakeSphere_1(radius);
  const shape = maker.Shape();
  return {
    shape,
    delete(): void {
      shape.delete();
      maker.delete();
    },
  };
}

/** バイト列を文字列にする。STEP は ASCII か UTF-8。 */
function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/** 語が何回出るかを数える。 */
function countOf(text: string, word: string): number {
  return text.split(word).length - 1;
}

describe('STEP の書き出し(P6 タスク7)', () => {
  it('箱 1 つを書き出すと STEP のヘッダと終端がそろう(計画書 §1.5-3、-4 の実測)', () => {
    const handle = box(20);
    try {
      const { bytes } = writeStep(oc, [{ shape: handle.shape, name: '本体', color: null }]);
      const text = decode(bytes);
      const lines = text.split(/\r?\n/);
      expect(bytes.length).toBeGreaterThan(1000);
      expect(text.startsWith('ISO-10303-21;')).toBe(true);
      expect(text).toContain('ENDSEC;');
      expect(text).toContain('END-ISO-10303-21;');
      // §1.5-3: 書き出しは AP214(AUTOMOTIVE_DESIGN)。素の書き手の設定を触る必要はない。
      const schema = lines.filter((line) => line.includes('FILE_SCHEMA'));
      expect(schema).toHaveLength(1);
      expect(schema[0]).toContain('AUTOMOTIVE_DESIGN');
      expect(schema[0]).toContain('10303 214');
      // §1.5-4: 時刻が入るのは 4 行目の FILE_NAME だけ。決定性の比較はこの 1 行を除く。
      expect(lines[3]).toMatch(/^FILE_NAME\('Open CASCADE Shape Model','\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'/);
      const timestamps = lines.filter((line) => /'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}'/.test(line));
      expect(timestamps).toHaveLength(1);
    } finally {
      handle.delete();
    }
  });

  it('箱 1 つで立体が 1 つ書かれる', () => {
    const handle = box(20);
    try {
      const { bytes } = writeStep(oc, [{ shape: handle.shape, name: null, color: null }]);
      const text = decode(bytes);
      expect(countOf(text, 'MANIFOLD_SOLID_BREP')).toBe(1);
      expect(countOf(text, 'ADVANCED_BREP_SHAPE_REPRESENTATION')).toBe(1);
      // 箱の平らな面は 6 枚。
      expect(countOf(text, 'ADVANCED_FACE')).toBe(6);
    } finally {
      handle.delete();
    }
  });

  it('箱と球の 2 立体を 1 つのファイルへ書ける', () => {
    const first = box(20);
    const second = sphere(10);
    try {
      const { bytes } = writeStep(oc, [
        { shape: first.shape, name: '箱', color: null },
        { shape: second.shape, name: '球', color: null },
      ]);
      const text = decode(bytes);
      expect(countOf(text, 'MANIFOLD_SOLID_BREP')).toBe(2);
      expect(countOf(text, 'ADVANCED_BREP_SHAPE_REPRESENTATION')).toBe(2);
      // 球は厳密な球面として書かれる(三角形に崩さない)。
      expect(text).toContain('SPHERICAL_SURFACE');
    } finally {
      second.delete();
      first.delete();
    }
  });

  it('名前が STEP の中へ入る(日本語も含めて)', () => {
    const first = box(20);
    const second = box(10);
    try {
      const { bytes } = writeStep(oc, [
        { shape: first.shape, name: '外枠', color: null },
        { shape: second.shape, name: 'Inner Part', color: null },
      ]);
      const text = decode(bytes);
      expect(text).toContain("PRODUCT('外枠','外枠'");
      expect(text).toContain("PRODUCT('Inner Part','Inner Part'");
    } finally {
      second.delete();
      first.delete();
    }
  });

  it('名前を渡さなければ OCCT の既定(SOLID)になる', () => {
    const handle = box(20);
    try {
      const { bytes } = writeStep(oc, [{ shape: handle.shape, name: null, color: null }]);
      expect(decode(bytes)).toContain("PRODUCT('SOLID','SOLID'");
    } finally {
      handle.delete();
    }
  });

  it('色が COLOUR_RGB として入り、渡した値がそのまま出る(§2.5 の検証表)', () => {
    const handle = box(20);
    try {
      // #b8bfcc = (184, 191, 204)。P5 の既定の外観の色。
      const color: readonly [number, number, number] = [184 / 255, 191 / 255, 204 / 255];
      const result = writeStep(oc, [{ shape: handle.shape, name: '本体', color }]);
      expect(result.colorWritten).toBe(true);
      const text = decode(result.bytes);
      expect(countOf(text, 'COLOUR_RGB')).toBe(1);
      expect(countOf(text, 'STYLED_ITEM')).toBe(1);
      const line = text.split(/\r?\n/).find((candidate) => candidate.includes('COLOUR_RGB'));
      expect(line).toBeDefined();
      const numbers = (line ?? '').match(/-?\d+\.\d+/g) ?? [];
      expect(numbers).toHaveLength(3);
      // OCCT は色を float で持つので、往復の差は 1e-7 台に収まる。
      expect(Number(numbers[0])).toBeCloseTo(color[0], 6);
      expect(Number(numbers[1])).toBeCloseTo(color[1], 6);
      expect(Number(numbers[2])).toBeCloseTo(color[2], 6);
    } finally {
      handle.delete();
    }
  });

  it('立体ごとに別の色を書ける', () => {
    const first = box(20);
    const second = box(10);
    try {
      const result = writeStep(oc, [
        { shape: first.shape, name: '一', color: [0.1, 0.2, 0.3] },
        { shape: second.shape, name: '二', color: [0.4, 0.5, 0.6] },
      ]);
      expect(result.colorWritten).toBe(true);
      const text = decode(result.bytes);
      expect(countOf(text, 'COLOUR_RGB')).toBe(2);
      expect(countOf(text, 'STYLED_ITEM')).toBe(2);
    } finally {
      second.delete();
      first.delete();
    }
  });

  it('色を渡さなければ COLOUR_RGB も STYLED_ITEM も出ない', () => {
    const handle = box(20);
    try {
      const result = writeStep(oc, [{ shape: handle.shape, name: '本体', color: null }]);
      expect(result.colorWritten).toBe(false);
      const text = decode(result.bytes);
      expect(countOf(text, 'COLOUR_RGB')).toBe(0);
      expect(countOf(text, 'STYLED_ITEM')).toBe(0);
    } finally {
      handle.delete();
    }
  });

  it('色を書かない指定なら、色を渡しても出ない(§0.a-0.22 の「画面から外せる」)', () => {
    const handle = box(20);
    try {
      const result = writeStep(oc, [{ shape: handle.shape, name: '本体', color: [0.1, 0.2, 0.3] }], {
        withColors: false,
      });
      expect(result.colorWritten).toBe(false);
      const text = decode(result.bytes);
      expect(countOf(text, 'COLOUR_RGB')).toBe(0);
      expect(countOf(text, 'STYLED_ITEM')).toBe(0);
      // 形と名前はそのまま書かれている。
      expect(countOf(text, 'MANIFOLD_SOLID_BREP')).toBe(1);
      expect(text).toContain("PRODUCT('本体','本体'");
    } finally {
      handle.delete();
    }
  });

  it('空の一覧は日本語の理由で断る(NFR-UX-5)', () => {
    expect(() => writeStep(oc, [])).toThrow('書き出せる立体がありません。');
  });

  it('色の値が範囲外なら日本語の理由で断る', () => {
    const handle = box(20);
    try {
      expect(() =>
        writeStep(oc, [{ shape: handle.shape, name: null, color: [0, 0, 2] }]),
      ).toThrow('書き出しの色の値が正しくありません。');
    } finally {
      handle.delete();
    }
  });

  it('同じ立体から 2 回書き出すと、時刻の行を除いてバイト列が一致する(§0.a-0.62)', () => {
    const handle = box(20);
    try {
      const entry: StepWriteEntry = { shape: handle.shape, name: '本体', color: null };
      const first = decode(writeStep(oc, [entry]).bytes).split(/\r?\n/);
      const second = decode(writeStep(oc, [entry]).bytes).split(/\r?\n/);
      expect(second).toHaveLength(first.length);
      const differing: number[] = [];
      for (let index = 0; index < first.length; index += 1) {
        if (first[index] !== second[index]) {
          differing.push(index + 1);
        }
      }
      // 違ってよいのは時刻を含む 4 行目だけ(同じ秒に書けば 0 行になる)。
      expect(differing.filter((line) => line !== 4)).toEqual([]);
    } finally {
      handle.delete();
    }
  });

  it('書き出しのあとに仮想ファイルの置き場が空になっている', () => {
    const handle = box(20);
    try {
      writeStep(oc, [{ shape: handle.shape, name: '本体', color: [0.1, 0.2, 0.3] }]);
      // FS.readdir の戻りは型の上では any なので、実行時に配列と文字列を確かめる。
      const listed: unknown = oc.FS.readdir('/pointercad');
      const entries: readonly unknown[] = Array.isArray(listed) ? listed : [];
      const names = entries.filter(
        (entry) => typeof entry === 'string' && entry !== '.' && entry !== '..',
      );
      expect(names).toEqual([]);
    } finally {
      handle.delete();
    }
  });

  it('箱 10 個の書き出しの所要を記録する(§2.17-1 の上限は 5 秒)', () => {
    const handles: OcctShapeHandle[] = [];
    for (let index = 0; index < 10; index += 1) {
      handles.push(box(10 + index));
    }
    try {
      const startedAt = performance.now();
      const entries: readonly StepWriteEntry[] = handles.map((handle, index) => ({
        shape: handle.shape,
        name: `箱${index + 1}`,
        color: [0.5, 0.5, 0.5],
      }));
      const { bytes } = writeStep(oc, entries);
      const elapsedMs = performance.now() - startedAt;
      // 数値そのものは環境差が大きいので、上限判定は §2.17 の性能検査(タスク16)へ譲る。
      console.log(`STEP 書き出し(箱 10 個): ${elapsedMs.toFixed(0)} ms / ${bytes.length} バイト`);
      const text = decode(bytes);
      expect(countOf(text, 'MANIFOLD_SOLID_BREP')).toBe(10);
      // 10 個とも同じ色なので、色そのものは 1 つにまとめられ、割り当てだけが 10 個になる
      // (2026-09-06 実測。XCAF が同じ色を 1 つのラベルへ束ねる。タスク7b の手順 4 と同じ性質)。
      expect(countOf(text, 'COLOUR_RGB')).toBe(1);
      expect(countOf(text, 'STYLED_ITEM')).toBe(10);
      expectWithinBudget(elapsedMs, 5000, 'STEP 書き出し(箱 10 個)');
    } finally {
      for (const handle of handles) {
        handle.delete();
      }
    }
  });
});
