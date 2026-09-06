import { beforeAll, describe, expect, it } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';
import { loadOcctForNode } from './loadOcct.node.js';
import { makeBox } from './makeBox.js';
import type { OcctShapeHandle } from './makeBox.js';
import { readStep } from './readStep.js';
import { measureVolume } from './solidMesh.js';
import type { StepWriteEntry } from './writeStep.js';
import { writeStep } from './writeStep.js';
import type { RgbTuple } from './xcafDocument.js';

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

describe('STEP の面ごとの色(P6 タスク7b、§2.5.1・§1.5-29)', () => {
  /** 面の色の表を組み立てる。 */
  function faceColors(entries: readonly (readonly [number, RgbTuple])[]): ReadonlyMap<number, RgbTuple> {
    return new Map<number, RgbTuple>(entries);
  }

  /** `#cc4444` を 255 で割った値(計画書の検証表の色)。純色ではないので COLOUR_RGB で書かれる。 */
  const CC4444: RgbTuple = [204 / 255, 68 / 255, 68 / 255];

  /** 6 面すべて別の色。 */
  const SIX_DISTINCT = faceColors([
    [0, [0.1, 0.2, 0.3]],
    [1, [0.2, 0.3, 0.4]],
    [2, [0.3, 0.4, 0.5]],
    [3, [0.4, 0.5, 0.6]],
    [4, [0.5, 0.6, 0.7]],
    [5, [0.6, 0.7, 0.8]],
  ]);

  /** 6 面のうち先頭 3 面が同じ色(色の種類は 4)。 */
  const THREE_SHARED = faceColors([
    [0, [0.1, 0.2, 0.3]],
    [1, [0.1, 0.2, 0.3]],
    [2, [0.1, 0.2, 0.3]],
    [3, [0.4, 0.5, 0.6]],
    [4, [0.5, 0.6, 0.7]],
    [5, [0.6, 0.7, 0.8]],
  ]);

  it('1 面だけを赤にすると STYLED_ITEM が 2 行になる(立体の色 + 面 1 枚。§1.5-29 の実測)', () => {
    const handle = box(20);
    try {
      const { bytes, colorWritten } = writeStep(oc, [
        {
          shape: handle.shape,
          name: '本体',
          color: [0.72, 0.75, 0.8],
          faceColors: faceColors([[0, CC4444]]),
        },
      ]);
      const text = decode(bytes);
      // STYLED_ITEM は「色を割り当てた相手の数」= 立体 1 + 色を付けた面 1。
      expect(countOf(text, 'STYLED_ITEM')).toBe(2);
      // COLOUR_RGB は「色の種類の数」= 立体の色 + 面の色。
      expect(countOf(text, 'COLOUR_RGB')).toBe(2);
      // #cc4444 は純色ではないので、名前つきの色(赤など)には置き換わらない。
      expect(countOf(text, 'DRAUGHTING_PRE_DEFINED_COLOUR')).toBe(0);
      expect(text).toContain('0.800000');
      expect(colorWritten).toBe(true);
    } finally {
      handle.delete();
    }
  });

  it('立体の色を渡さずに 1 面だけ色を付けると STYLED_ITEM も COLOUR_RGB も 1 行', () => {
    const handle = box(20);
    try {
      const { bytes } = writeStep(oc, [
        { shape: handle.shape, name: null, color: null, faceColors: faceColors([[0, CC4444]]) },
      ]);
      const text = decode(bytes);
      expect(countOf(text, 'STYLED_ITEM')).toBe(1);
      expect(countOf(text, 'COLOUR_RGB')).toBe(1);
    } finally {
      handle.delete();
    }
  });

  it('6 面すべてを別の色にすると STYLED_ITEM も COLOUR_RGB も 6 行', () => {
    const handle = box(20);
    try {
      const { bytes } = writeStep(oc, [
        { shape: handle.shape, name: null, color: null, faceColors: SIX_DISTINCT },
      ]);
      const text = decode(bytes);
      expect(countOf(text, 'STYLED_ITEM')).toBe(6);
      expect(countOf(text, 'COLOUR_RGB')).toBe(6);
    } finally {
      handle.delete();
    }
  });

  it('6 面のうち 3 面が同じ色なら STYLED_ITEM は 6・COLOUR_RGB は 4(同じ色は 1 つに束ねられる)', () => {
    const handle = box(20);
    try {
      const { bytes } = writeStep(oc, [
        { shape: handle.shape, name: null, color: null, faceColors: THREE_SHARED },
      ]);
      const text = decode(bytes);
      expect(countOf(text, 'STYLED_ITEM')).toBe(6);
      expect(countOf(text, 'COLOUR_RGB')).toBe(4);
    } finally {
      handle.delete();
    }
  });

  it('面の色を渡さなければタスク7 と同じバイト列になる(時刻の行を除く。回帰を出さない)', () => {
    const handle = box(20);
    try {
      const base: StepWriteEntry = { shape: handle.shape, name: '本体', color: [0.72, 0.75, 0.8] };
      const withEmpty: StepWriteEntry = { ...base, faceColors: new Map<number, RgbTuple>() };
      const first = decode(writeStep(oc, [base]).bytes).split(/\r?\n/);
      const second = decode(writeStep(oc, [withEmpty]).bytes).split(/\r?\n/);
      expect(second).toHaveLength(first.length);
      const differing: number[] = [];
      for (let index = 0; index < first.length; index += 1) {
        if (first[index] !== second[index]) {
          differing.push(index + 1);
        }
      }
      expect(differing.filter((line) => line !== 4)).toEqual([]);
    } finally {
      handle.delete();
    }
  });

  it('面の色の並べ方を変えてもバイト列が変わらない(面の通し番号の昇順にたどる)', () => {
    const handle = box(20);
    try {
      const ascending: StepWriteEntry = {
        shape: handle.shape,
        name: '本体',
        color: null,
        faceColors: SIX_DISTINCT,
      };
      const shuffled: StepWriteEntry = {
        shape: handle.shape,
        name: '本体',
        color: null,
        faceColors: new Map([...SIX_DISTINCT].reverse()),
      };
      const first = decode(writeStep(oc, [ascending]).bytes).split(/\r?\n/);
      const second = decode(writeStep(oc, [shuffled]).bytes).split(/\r?\n/);
      expect(second).toHaveLength(first.length);
      const differing: number[] = [];
      for (let index = 0; index < first.length; index += 1) {
        if (first[index] !== second[index]) {
          differing.push(index + 1);
        }
      }
      expect(differing.filter((line) => line !== 4)).toEqual([]);
    } finally {
      handle.delete();
    }
  });

  it('色を書かない指定なら面の色も出ない(§0.a-0.22 の「画面から外せる」)', () => {
    const handle = box(20);
    try {
      const { bytes, colorWritten } = writeStep(
        oc,
        [{ shape: handle.shape, name: null, color: null, faceColors: SIX_DISTINCT }],
        { withColors: false },
      );
      const text = decode(bytes);
      expect(countOf(text, 'STYLED_ITEM')).toBe(0);
      expect(countOf(text, 'COLOUR_RGB')).toBe(0);
      expect(colorWritten).toBe(false);
    } finally {
      handle.delete();
    }
  });

  it('面の通し番号が範囲の外なら日本語の理由で断る(NFR-RE-1)', () => {
    const handle = box(20);
    try {
      expect(() =>
        writeStep(oc, [
          { shape: handle.shape, name: null, color: null, faceColors: faceColors([[6, CC4444]]) },
        ]),
      ).toThrow('色を付ける面が見つかりません(面の番号 6)。');
      // 断ったあとも同じ形をふつうに書き出せる(仮想ファイルも控えも残っていない)。
      expect(writeStep(oc, [{ shape: handle.shape, name: null, color: null }]).bytes.length).toBeGreaterThan(1000);
    } finally {
      handle.delete();
    }
  });

  it('面ごとに色を付けた STEP を読み直すと形が保たれる(体積 8000)', () => {
    const handle = box(20);
    try {
      const { bytes } = writeStep(oc, [
        { shape: handle.shape, name: '本体', color: [0.72, 0.75, 0.8], faceColors: SIX_DISTINCT },
      ]);
      const read = readStep(oc, bytes);
      try {
        expect(read.bodies).toHaveLength(1);
        expect(measureVolume(oc, read.bodies[0].shape)).toBeCloseTo(8000, 3);
        // **`readStep` が返すのは立体ごとの色だけ**(面ごとの色の取り込みは §0.a-0.28 で
        // P7 以降へ送った)。面の色はファイルに残っているが、この口からは戻らない。
        expect(read.bodies[0].color).not.toBeNull();
      } finally {
        read.delete();
      }
    } finally {
      handle.delete();
    }
  });
});
