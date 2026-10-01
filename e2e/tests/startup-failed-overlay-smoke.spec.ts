import { expect, test } from '@playwright/test';
import { waitForStartupHealth } from './startupHealth.js';
import { uiMessage } from './uiMessages.js';

test('起動中のエラーの後に本体が描けたら復旧画面を外して操作できる', async ({ page }, info) => {
  let release = (): void => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/assets/ViewportCanvas-*.js', async route => { await held; await route.continue(); });
  try {
    await page.goto('/');
    await expect(page.locator('.pcad-shell')).toBeAttached();
    await expect(page.locator('canvas.pcad-viewport__canvas')).toHaveCount(0);
    // Inject an error while the real lazy viewport is pending, then let that same
    // module finish. Do not remove the splash or alter the application's state in the test.
    await page.evaluate(() => { window.dispatchEvent(new ErrorEvent('error', { message: 'startup recovery probe' })); });
    await expect(page.locator('[data-startup-failure]')).toBeVisible();
    await expect(page.getByRole('link', { name: uiMessage('view', 'bootstrap.retry'), exact: true })).toBeVisible();
    expect(await page.locator('#root').evaluate(root => root instanceof HTMLElement && root.inert)).toBe(true);
  } finally { release(); }
  await waitForStartupHealth(page, info);
  expect(await page.locator('#root').evaluate(root => root instanceof HTMLElement && root.inert)).toBe(false);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  await expect(page.locator('.pcad-parameter')).toHaveCount(1);
});

test('起動後の専用パネルの取得失敗は区画内に表示し、本体と編集内容を保つ', async ({ page }, info) => {
  await page.goto('/');
  await waitForStartupHealth(page, info);
  await page.getByRole('tab', { name: 'パラメータ', exact: true }).click();
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  const name = page.locator('.pcad-parameter').locator('.pcad-field').first().locator('input');
  await name.fill('読み込み失敗後も残る係数'); await name.press('Enter');
  let blocked = 0, navigations = 0;
  page.on('request', request => { if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigations++; });
  await page.route('**/assets/HelpHost-*.js', async route => { blocked++; await route.abort('failed'); });
  await page.getByRole('button', { name: 'ヘルプ (F1)', exact: true }).click();
  const failure = page.locator('.pcad-card[role="alert"]');
  await expect(failure).toContainText(uiMessage('view', 'bootstrap.failed'));
  await expect(failure.getByRole('button', { name: uiMessage('view', 'viewport.retry'), exact: true })).toBeEnabled();
  expect(blocked).toBeGreaterThan(0);
  await expect(page.locator('[data-startup-shell]')).toHaveCount(0);
  expect(await page.locator('#root').evaluate(root => root instanceof HTMLElement && root.inert)).toBe(false);
  await expect(name).toHaveValue('読み込み失敗後も残る係数');
  await page.getByRole('button', { name: '名前を付けた数値を足します', exact: true }).click();
  await expect(page.locator('.pcad-parameter')).toHaveCount(2);
  expect(navigations).toBe(0);
});
