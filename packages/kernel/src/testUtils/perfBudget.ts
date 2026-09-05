/**
 * 性能上限の判定を「厳密」と「参考」で切り替える単一の窓口(検査だけが使う)。
 *
 * 作業担当が並列にテストや E2E を走らせている間に統括がコミットすると、
 * CPU 競合で性能検査の上限判定が落ちる(`rules/06-過去の失敗と対策.md` 10.3)。
 * 上限は緩めない代わりに、環境変数 `POINTERCAD_PERF_STRICT` が `'1'` のときだけ
 * 厳密に判定してテストを落とす(push前検査・CI。`rules/03-品質ゲート.md` §7.1)。
 * それ以外(コミット前検査の既定)は実測値の記録にとどめ、上限超過でも失敗にしない。
 *
 * 呼び出し側は実測値と上限を既存の `console.log` で出力済みの前提で、
 * この関数は判定の切替と、参考モードで超過したときの警告表示だけを担う。
 * **上限の数値と検査内容は変えない。**
 *
 * ## なぜ `src/testUtils/` に置くのか
 *
 * まったく同じ関数が `worker/solidPerformance.test.ts` と `occt/*.test.ts` の
 * 合わせて 8 ファイルへ写されていた(§0.a-0.88 で「全段をこの窓口に揃える」と決めた
 * ため増えた)。判定の決め(環境変数の名前・`'1'` という値・参考モードの文言)が
 * 8 か所に散っていると、`scripts/check.ps1` 側の設定を変えたときに一部だけ古いまま
 * 残る危険がある。だから決めは 1 か所だけに置く(P5 §0.a-0.83、タスク42b)。
 *
 * このファイルは**検査からしか呼ばれない**ので、`src/index.ts` の輸出には入れない
 * (`packages/kernel/tsconfig.json` の `include` は `src` なので型検査には入る)。
 */

import { expect } from 'vitest';

/** 厳密に判定する合図。`scripts/check.ps1` が `-Level Push` のときだけ `'1'` を入れる。 */
const STRICT_FLAG = '1';

/**
 * 実測 `actualMs` が上限 `limitMs` に収まっていることを確かめる。
 *
 * @param actualMs 実測の所要(ミリ秒)。
 * @param limitMs 要件の上限(ミリ秒)。**呼び出し側が渡す数値は緩めない。**
 * @param label 参考モードで超過したときにログへ出す、何の所要かを示す日本語。
 */
export function expectWithinBudget(actualMs: number, limitMs: number, label: string): void {
  if (process.env.POINTERCAD_PERF_STRICT === STRICT_FLAG) {
    expect(actualMs).toBeLessThan(limitMs);
    return;
  }
  if (actualMs >= limitMs) {
    console.log(
      `[参考] 上限超過: ${label}(実測 ${actualMs.toFixed(1)} ms ≥ 上限 ${String(limitMs)} ms。コミット前検査のため失敗にしません)`,
    );
  }
}
