import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { installStartupDiagnostics, waitForStartupHealth } from './startupHealth.js';
import { cameraControlsPresetRestoredFlow, cameraControlsPresetsFlow, type CameraControlsPresetName } from './cameraControlsPresetsFlow.js';

test.beforeEach(async ({ page }) => {
  await installStartupDiagnostics(page);
  await page.addInitScript(() => {
    for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
      Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
    }
  });
});

async function runPreset(page: Page, info: TestInfo,
  presetName: CameraControlsPresetName): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await waitForStartupHealth(page, info);
  const configured = await cameraControlsPresetsFlow(page, info, undefined, presetName);
  await page.reload(); await waitForStartupHealth(page, info);
  await cameraControlsPresetRestoredFlow(page, info, configured);
  expect(errors).toEqual([]);
}

// Keep the original identity and its Onshape -> PointerCAD restoration path.
test('EX10 視点操作のプリセット・入力の誤りの伝え方・実操作とreload復元', async ({ page }, info) => {
  await runPreset(page, info, 'onshape');
});

for (const presetName of ['pointercad', 'solidworks', 'fusion'] as const) {
  test(`EX10 視点操作のプリセット ${presetName}・実操作とreload復元`, async ({ page }, info) => {
    await runPreset(page, info, presetName);
  });
}
