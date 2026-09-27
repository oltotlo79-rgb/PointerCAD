import { expect, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { panel, writeDraft } from './scriptsFlow.js';

/** Fail a real application chunk after saving a tool, without replacing the application. */
export async function startupRecoveryFlow(page: Page, info: TestInfo, persistent: boolean): Promise<void> {
  await page.goto('/');
  await chooseToolMenuItem(page, '自動作図', '自動作図');
  await writeDraft(page, '起動後も残る道具', "console.log('復旧後の道具');");
  await panel(page).getByRole('button', { name: '道具に登録・更新', exact: true }).click();
  await expect(panel(page).locator('.pcad-script__tool')).toHaveCount(1);
  const saved = await page.evaluate(() => localStorage.getItem('pointercad.script-tools.v1'));
  expect(saved).not.toBeNull();
  let navigations = 0, blocked = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  const pattern = '**/assets/pcad-core-*.js';
  await page.route(pattern, async route => {
    if (persistent || navigations === 1) { blocked++; await route.abort('failed'); }
    else await route.continue();
  });
  await page.reload();
  if (persistent) {
    const failure = page.locator('[data-startup-failure]');
    await expect(failure).toBeVisible();
    expect(navigations).toBe(2);
    await page.screenshot({ path: info.outputPath('startup-load-failure.png') });
    await page.unroute(pattern);
    await page.getByRole('link', { name: '画面を読み込み直す', exact: true }).click();
  }
  await expect(page.getByRole('button', { name: '新規', exact: true })).toBeVisible();
  expect(blocked).toBeGreaterThan(0);
  expect(navigations).toBe(persistent ? 3 : 2);
  expect(await page.evaluate(() => localStorage.getItem('pointercad.script-tools.v1'))).toBe(saved);
  await chooseToolMenuItem(page, '自動作図', '起動後も残る道具');
  await expect(panel(page)).toContainText('復旧後の道具');
  await expect(panel(page)).toContainText('実行が完了しました');
  await expect(page.locator('[data-startup-shell]')).toHaveCount(0);
}
