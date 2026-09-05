import { describe, expect, it } from 'vitest';

import { expectWithinBudget } from '../testUtils/perfBudget.js';
import { formatDxfTags, parseDxfTags, type DxfTag } from './dxfTags.js';

/*
 * DXF の字句の性能(計画書 docs/plans/P6-入出力.md §2.17 の #6)。
 *
 * 上限は計画書の数値そのままで、**緩めない**
 * (rules/02-禁止事項.md「性能テストの上限値を緩めることも禁止する」)。
 * 上限に届かない実測が出たときは、上限を書き換えるのではなく原因を統括へ報告する。
 *
 * 判定は `expectWithinBudget` の切替(`POINTERCAD_PERF_STRICT`)に乗せる(§0.a-0.60)。
 * push前検査・統括の手動実行だけが厳密で、コミット前検査と CI は参考の記録にとどまる
 * (rules/06-過去の失敗と対策.md 10.3・10.12)。
 *
 * 測るのは字句の段だけで、DXF テキストの組み立て(検査の下ごしらえ)は計測に含めない。
 */

/** §2.17 #6「1 万エンティティの DXF 読み込みは 3 秒以内」。 */
const DXF_TAGS_LIMIT_MS = 3000;

/** 計画書 §2.17 #6 の見積もりの前提「1 エンティティあたり平均 10 タグ」。 */
const ENTITY_COUNT = 10_000;
const TAGS_PER_ENTITY = 10;
const TAG_COUNT = ENTITY_COUNT * TAGS_PER_ENTITY;

/**
 * 1 万エンティティぶんの DXF テキストを組み立てる。
 * 1 エンティティ = `LINE` の 10 タグ(0/5/8/10/20/30/11/21/31/62)で、合わせて 10 万タグ・20 万行。
 */
function buildDxfText(): string {
  const lines: string[] = [];
  for (let index = 0; index < ENTITY_COUNT; index += 1) {
    const x = (index % 500).toFixed(9);
    const y = (index % 300).toFixed(9);
    lines.push(
      '0', 'LINE',
      '5', (index + 256).toString(16).toUpperCase(),
      '8', '0',
      '10', x,
      '20', y,
      '30', '0.000000000',
      '11', ((index % 500) + 10).toFixed(9),
      '21', ((index % 300) + 10).toFixed(9),
      '31', '0.000000000',
      '62', '7',
    );
  }
  return lines.join('\r\n') + '\r\n';
}

describe('DXF の字句の性能(§2.17 #6)', () => {
  const text = buildDxfText();

  it(`1 万エンティティ(10 万タグ)を ${String(DXF_TAGS_LIMIT_MS)} ms 以内に読む`, () => {
    const startedAt = performance.now();
    const tags = parseDxfTags(text);
    const elapsedMs = performance.now() - startedAt;

    console.log(
      `DXF 読み(1 万エンティティ = ${String(TAG_COUNT)} タグ): ${elapsedMs.toFixed(1)} ms / 上限 ${String(DXF_TAGS_LIMIT_MS)} ms`,
    );
    expect(tags).toHaveLength(TAG_COUNT);
    expectWithinBudget(elapsedMs, DXF_TAGS_LIMIT_MS, 'DXF 読み(1 万エンティティ)');
  });

  it(`1 万エンティティ(10 万タグ)を ${String(DXF_TAGS_LIMIT_MS)} ms 以内に書く`, () => {
    const tags: readonly DxfTag[] = parseDxfTags(text);

    const startedAt = performance.now();
    const written = formatDxfTags(tags);
    const elapsedMs = performance.now() - startedAt;

    console.log(
      `DXF 書き(1 万エンティティ = ${String(TAG_COUNT)} タグ): ${elapsedMs.toFixed(1)} ms / 上限 ${String(DXF_TAGS_LIMIT_MS)} ms`,
    );
    // 組み立てた元は正規形(コードに余分な空白が無く、末尾の改行が 1 つ)なので、そのまま戻る。
    expect(written).toBe(text);
    expectWithinBudget(elapsedMs, DXF_TAGS_LIMIT_MS, 'DXF 書き(1 万エンティティ)');
  });
});
