import { test } from '@playwright/test';
import { resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { impactCancelAndInvalidationFlow } from './impactCancelFlow.js';
import { impactLifecycleFlow } from './impactFlow.js';

/*
 * 衝撃の画面検査の Web の入口(Chromium は functional、Firefox は playwright.config.ts の firefox の許可の一覧の
 * impact-browser)。流れと独立した期待は impactFlow.ts、編集による無効化と取消しは impactCancelFlow.ts。
 * 開き方・後片付けは weld-layer-browser.spec.ts と同じ。
 */
test.describe('衝撃: 規格の平鋼の片持ちと固定面(Web)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });

  test('断られた入力を残して直し、実計算し、適用・保存・開き直しで入力が戻り結果は計算し直すまで無い', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await disableFilePickers(page);
    await page.goto('/');
    await impactLifecycleFlow(page, name => info.outputPath(name));
    await impactCancelAndInvalidationFlow(page);
    test.expect(errors).toEqual([]);
  });
});
