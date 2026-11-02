import { expect, test } from '@playwright/test';
import { resetAssemblyFileGateway } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { frictionLifecycleFlow } from './frictionFlow.js';

test.describe('摩擦: 設定・実解析・保存復元(Web)', () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.afterEach(async ({ page }) => { await resetAssemblyFileGateway(page); });
  test('負の係数を拒否し、4段の反力とゼロ除荷、保存と未計算の再開を確認する', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await disableFilePickers(page);
    await page.goto('/');
    await frictionLifecycleFlow(page, name => info.outputPath(name));
    expect(errors).toEqual([]);
  });
});
