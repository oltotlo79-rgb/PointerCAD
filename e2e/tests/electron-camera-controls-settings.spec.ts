import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { cameraControlsRestoredFlow, cameraControlsSettingsFlow, prepareMalformedCameraSettings, malformedCameraSettingsRestored } from './cameraControlsSettingsFlow.js';

test('EX10 実Electronで視点設定の実操作・終了再起動・保存復元', async ({ playwright }, info) => {
  const errors: string[] = [];
  const first = await launchDesktop(playwright, info);
  const configured = await (async () => {
    try {
      const page = await first.app.firstWindow();
      page.on('pageerror', error => errors.push(error.message));
      return await cameraControlsSettingsFlow(page, info, first.app);
    } finally { await first.app.close(); }
  })();
  // launchDesktop keys userData by this exact TestInfo/retry, so this is a real same-profile restart.
  let malformed: string;
  const second = await launchDesktop(playwright, info);
  try {
    const page = await second.app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await cameraControlsRestoredFlow(page, info, configured, second.app);
    malformed = await prepareMalformedCameraSettings(page);
    expect(errors).toEqual([]);
  } finally { await second.app.close(); }
  const third = await launchDesktop(playwright, info);
  try {
    const page = await third.app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await malformedCameraSettingsRestored(page, info, malformed, third.app);
    expect(errors).toEqual([]);
  } finally { await third.app.close(); }
});
