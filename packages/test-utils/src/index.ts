/**
 * 検査専用の共通部品の入口。
 *
 * 製品の実行時コードは 1 行も置かない(依存方向の層の外側にあるため。
 * `perfBudget.ts` の冒頭の注釈と `docs/plans/P6-入出力.md` §0.a-0.68)。
 */

export { expectWithinBudget } from './perfBudget.js';
