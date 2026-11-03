import { expect, test } from '@playwright/test';
import { analysisBoltPersistenceFlow } from './analysisBoltPersistenceFlow.js';
import { launchDesktop } from './electronAppFlow.js';
import { holdElectronFemAsset } from './electronFemAssetHold.js';

test('desktop axial bolt joint analysis stops, discards changed conditions and recomputes on a new worker after reopening', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await analysisBoltPersistenceFlow(page, info, () => holdElectronFemAsset(app), app);
  } finally { await app.close(); }
});
