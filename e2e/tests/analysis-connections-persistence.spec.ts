import { test } from '@playwright/test';
import { analysisConnectionsPersistenceFlow } from './analysisConnectionsPersistenceFlow.js';
import { holdFirstFemAsset } from './analysisResultBindingFlow.js';
import { disableFilePickers } from './boltedJointTestSupport.js';

test('joint weld span analysis stops, discards changed conditions and recomputes on a new worker after reopening', async ({ page }, info) => {
  await disableFilePickers(page);
  await page.goto('/');
  await analysisConnectionsPersistenceFlow(page, info, () => holdFirstFemAsset(page));
});
