import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { analysisResultBindingFlow } from './analysisResultBindingFlow.js';
import { holdElectronFemAsset } from './electronFemAssetHold.js';

test('desktop static analysis discards stale and cancelled results', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await page.setViewportSize({ width: 1440, height: 900 });
    await analysisResultBindingFlow(page, info, true, () => holdElectronFemAsset(app));
  } finally { await app.close(); }
});
