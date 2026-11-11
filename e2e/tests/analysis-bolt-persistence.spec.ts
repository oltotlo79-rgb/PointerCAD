import { test } from '@playwright/test';
import { analysisBoltPersistenceFlow } from './analysisBoltPersistenceFlow.js';
import { holdFirstFemAsset } from './analysisResultBindingFlow.js';
import { disableFilePickers } from './boltedJointTestSupport.js';

test('axial bolt joint analysis stops, discards changed conditions and recomputes on a new worker after reopening', async ({ page }, info) => {
  await disableFilePickers(page);
  await page.goto('/');
  await analysisBoltPersistenceFlow(page, info, () => holdFirstFemAsset(page));
});
