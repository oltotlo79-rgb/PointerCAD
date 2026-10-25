import { test } from '@playwright/test';
import { faceOffsetFlow } from './faceOffsetFlow.js';

/*
 * EX-18 平らな面の移動(ブラウザー)。名前が `solid.spec.ts` で終わるので、playwright.config.ts の functional と
 * firefox の両方の枠に入る(firefox の testMatch は末尾の `solid\.spec\.ts$` で当たる)。Electron は
 * electron-face-offset.spec.ts。
 */
test.describe('EX-18 平らな面の移動', () => {
  test('穴のある板の端面を符号付きで動かし、寸法の変更・元に戻す・保存と開き直し・衝突の断りが実物で通る', async ({ page }, info) => {
    await faceOffsetFlow(page, info, '/');
  });
});
