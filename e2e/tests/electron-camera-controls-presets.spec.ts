import { expect, test, type PlaywrightWorkerArgs, type TestInfo } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { cameraControlsPresetRestoredFlow, cameraControlsPresetsFlow, type CameraControlsPresetName } from './cameraControlsPresetsFlow.js';

async function runPreset(playwright: PlaywrightWorkerArgs['playwright'], info: TestInfo, presetName: CameraControlsPresetName): Promise<void> {
  const errors: string[] = [];
  const first = await launchDesktop(playwright, info);
  const configured = await (async () => {
    try {
      const page = await first.app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      return await cameraControlsPresetsFlow(page, info, first.app, presetName);
    } finally { await first.app.close(); }
  })();
  // The exact TestInfo/retry keys launchDesktop's real persistent userData.
  const second = await launchDesktop(playwright, info);
  try {
    const page = await second.app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await cameraControlsPresetRestoredFlow(page, info, configured, second.app);
    expect(errors).toEqual([]);
  } finally { await second.app.close(); }
}

test('EX10 Electron presets: real controls and same-profile restart', async ({ playwright }, info) => {
  await runPreset(playwright, info, 'onshape');
});

for (const presetName of ['pointercad', 'solidworks', 'fusion'] as const) {
  test(`EX10 Electron preset ${presetName}: real controls and same-profile restart`, async ({ playwright }, info) => {
    await runPreset(playwright, info, presetName);
  });
}
