/**
 * 全パッケージの性能測定を、同じ目標・実用性の判定へ渡す検査専用の入口。
 *
 * 2026-09-14利用者指示により、旧速度目標の未達だけでは公開を止めない。
 * 元の目標、実測、大幅な遅延の境界はreleasePerformanceへ一元化する。
 * POINTERCAD_PERF_STRICTは実行順・測定条件の指定に残し、判定は全環境で同じにする。
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

import { reportDuration } from './releasePerformance.js';

/**
 * 元の目標と実測を記録し、実用上の大幅な遅延だけを失敗にする。
 *
 * @param actualMs 実測の所要(ミリ秒)。
 * @param limitMs リリース後も追跡する元の速度目標(ミリ秒)。
 * @param label 何の所要かを示す日本語。
 */
export function expectWithinBudget(actualMs: number, limitMs: number, label: string): void {
  reportDuration(actualMs, limitMs, label);
}
