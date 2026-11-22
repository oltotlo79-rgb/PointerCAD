import { test } from '@playwright/test';
import { faceOffsetFlow, faceOffsetHandleFlow, pushPullFlow } from './faceOffsetFlow.js';

/*
 * EX-18 平らな面の移動(ブラウザー)。名前が `solid.spec.ts` で終わるので、playwright.config.ts の functional と
 * firefox の両方の枠に入る(firefox の testMatch は末尾の `solid\.spec\.ts$` で当たる)。Electron は
 * electron-face-offset.spec.ts。
 */
test.describe('EX-18 平らな面の移動', () => {
  test('穴のある板の端面を符号付きで動かし、寸法の変更・元に戻す・保存と開き直し・衝突の断りと修正後の1回確定・失敗履歴の元形状が実物で通る', async ({ page }, info) => {
    await faceOffsetFlow(page, info, '/');
  });
  test('押し引き(M-05 4-1a・4-1b): 立体だけを選んだ時は理由を出し、平らな面は面の移動の欄が開いて 1 段で確定・元に戻し、穴の内側の面は穴の直径の欄へ移る', async ({ page }) => {
    await pushPullFlow(page, '/');
  });
  test('矢印のつまみ(M-05 4-2a): 打った距離の所に出るつまみを引くと欄の数が動き、掴んだままの Esc で戻り、離しても計算せず、Enter で欄の数どおりに確定する', async ({ page }) => {
    await faceOffsetHandleFlow(page, '/');
  });
});
