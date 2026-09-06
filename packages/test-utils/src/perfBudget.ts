/**
 * 性能上限の判定を「厳密」と「参考」で切り替える単一の窓口(検査だけが使う)。
 *
 * 作業担当が並列にテストや E2E を走らせている間に統括がコミットすると、
 * CPU 競合で性能検査の上限判定が落ちる(`rules/06-過去の失敗と対策.md` 10.3)。
 * 共有CIランナーでも同じことが起きる(同 10.12)。
 * 上限は緩めない代わりに、環境変数 `POINTERCAD_PERF_STRICT` が `'1'` のときだけ
 * 厳密に判定してテストを落とす(push前検査。`rules/03-品質ゲート.md` §7.1)。
 * それ以外(コミット前検査・CI の既定)は実測値の記録にとどめ、上限超過でも失敗にしない。
 *
 * 呼び出し側は実測値と上限を既存の `console.log` で出力済みの前提で、
 * この関数は判定の切替と、参考モードで超過したときの警告表示だけを担う。
 * **上限の数値と検査内容は変えない。**
 *
 * ## なぜ検査専用のパッケージに置くのか
 *
 * まったく同じ関数が kernel / io / model / ui / expression の 5 つの
 * `src/testUtils/perfBudget.ts` へ写されていた。写しが増えた理由は依存方向
 * (`apps → ui → model → kernel / expression`、`rules/04-設計の規律.md`)で、
 * io / ui / expression から kernel を import できないためだった。
 * しかし判定の決め(環境変数の名前・`'1'` という値・参考モードの文言)が 5 か所に
 * 散っていると、`scripts/check.ps1` 側の設定を変えたときに一部だけ古いまま残る。
 *
 * このパッケージは**検査からしか呼ばれず、製品の実行時コードを 1 行も持たない**ので、
 * 依存方向の層(apps → ui → model → kernel / expression)の外側にある。
 * どの層からも devDependencies として参照してよい(`eslint.config.js` の
 * `no-restricted-imports` でも `@pointercad/test-utils` だけを除外している)。
 * 決定の記録は `docs/plans/P6-入出力.md` §0.a-0.60 / §0.a-0.68(利用者の承認)。
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
