import { expect, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { panel, writeDraft } from './scriptsFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

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
  // Actual order of main navigations, chunk aborts and the public startup wait.
  const order: string[] = [];
  let release: () => void = () => undefined;
  const released = new Promise<void>(resolve => { release = resolve; });
  page.on('request', request => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) { navigations++; order.push(`navigation:${navigations}`); }
  });
  const pattern = '**/assets/pcad-core-*.js';
  await page.route(pattern, async route => {
    if (persistent || navigations === 1) {
      // The first load fails only after the public startup wait has been registered.
      if (!persistent) await released;
      blocked++; order.push(`abort:${navigations}`); await route.abort('failed');
    }
    else await route.continue();
  });
  if (persistent) {
    await page.reload();
    const failure = page.locator('[data-startup-failure]');
    await expect(failure).toBeVisible();
    expect(navigations).toBe(2);
    await page.screenshot({ path: info.outputPath('startup-load-failure.png') });
    await page.unroute(pattern);
    await page.getByRole('link', { name: '画面を読み込み直す', exact: true }).click();
  } else {
    // The failed import makes the product reload once (shell/startupRecovery.ts); wait across it.
    await page.reload({ waitUntil: 'commit' });
    const health = waitForStartupHealth(page, info).then(() => { order.push('health-ready'); });
    order.push('health-registered');
    release();
    await health;
    const at = (entry: string): number => {
      const index = order.indexOf(entry);
      expect(index, entry).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at('navigation:1')).toBeLessThan(at('health-registered'));
    expect(at('health-registered')).toBeLessThan(at('abort:1'));
    expect(at('abort:1')).toBeLessThan(at('navigation:2'));
    expect(at('navigation:2')).toBeLessThan(at('health-ready'));
    // Read-only entry evidence (installStartupDiagnostics) of the product's own retry record.
    expect(await page.evaluate(() => Reflect.get(globalThis, 'pcadStartupRetryAddressAtEntry'))).toBe(page.url());
    expect(await page.evaluate(() => sessionStorage.getItem('pointercad.startup-retry.v1'))).toBeNull();
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
