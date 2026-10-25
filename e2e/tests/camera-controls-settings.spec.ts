import { expect, test } from '@playwright/test';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';
import { cameraControlsRestoredFlow, cameraControlsSettingsFlow, prepareMalformedCameraSettings, malformedCameraSettingsRestored } from './cameraControlsSettingsFlow.js';

test.beforeEach(async ({ page }) => {
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
});

test('EX10 視点設定の適用・取消・衝突・実操作とreload復元', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await waitForStartupHealth(page, info);
  const configured = await cameraControlsSettingsFlow(page, info);
  await page.reload(); await waitForStartupHealth(page, info);
  await cameraControlsRestoredFlow(page, info, configured);
  const malformed = await prepareMalformedCameraSettings(page);
  await page.reload(); await waitForStartupHealth(page, info);
  await malformedCameraSettingsRestored(page, info, malformed);
  expect(errors).toEqual([]);
});
