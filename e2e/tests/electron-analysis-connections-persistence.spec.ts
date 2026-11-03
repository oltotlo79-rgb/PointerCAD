import { expect, test } from '@playwright/test';
import { analysisConnectionsPersistenceFlow } from './analysisConnectionsPersistenceFlow.js';
import { launchDesktop } from './electronAppFlow.js';
import { holdElectronFemAsset } from './electronFemAssetHold.js';

test('desktop joint weld span analysis stops, discards changed conditions and recomputes on a new worker after reopening', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await analysisConnectionsPersistenceFlow(page, info, () => holdElectronFemAsset(app), app);
  } finally { await app.close(); }
});
