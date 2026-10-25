import { test } from '@playwright/test';
import { cutPlaneMaterialsFlow } from './cutPlaneMaterialsFlow.js';

/*
 * EX-04 W1 切る面の材料(ブラウザー)。functional の枠に入る(firefox の許可名簿には入らない)。
 * Electron は electron-cut-plane-materials.spec.ts。操作の中身は cutPlaneMaterialsFlow.ts。
 */
test.describe('EX-04 切る面の材料', () => {
  test('スケッチの点・座標の式・XYZ 軸・辺・作業平面で切った体積が出て、元に戻す 1 回で箱へ戻る', async ({ page }) => {
    await cutPlaneMaterialsFlow(page, '/');
  });
});
