/// <reference lib="dom" />
import { expect, type Page, type TestInfo } from '@playwright/test';
import { chooseToolMenuItem } from '../tests/assemblyTestSupport.js';
import { waitForStartupHealth } from '../tests/startupHealth.js';
import { uiMessage } from '../tests/uiMessages.js';

/** Shared acceptance conditions for unpacked/installed binaries and the single portable exe. */
export async function verifyPackagedStartup(page: Page, info: TestInfo): Promise<void> {
  expect(page.url()).toBe('app://pointercad/index.html');
  expect(await page.evaluate(() => globalThis.crossOriginIsolated), '独自スキームの隔離の見出しが効いていること').toBe(true);
  await chooseToolMenuItem(page, uiMessage('toolbar', 'toolbar.shape.groupLabel'), uiMessage('sketch', 'functionPlot.menuTitle'));
  await expect(page.locator('.pcad-function-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.pcad-function-dialog')).toHaveCount(0);
  await waitForStartupHealth(page, info);
  const search = page.locator('.pcad-panel--left input').first();
  await search.fill('startup-input'); await expect(search).toHaveValue('startup-input'); await search.fill('');
  // The first navigation predates the debugger connection. Reload with error listeners installed.
  await page.reload();
  await expect(page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.file.open'), exact: true })).toBeVisible();
  await waitForStartupHealth(page, info);
}
