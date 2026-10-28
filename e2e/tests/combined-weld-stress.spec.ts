import { test } from '@playwright/test';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { combinedWeldStressFlow } from './combinedWeldStressFlow.js';

for (const initial of [false, true]) {
  test(`Combined weld stresses: initial shortening=${initial}`, async ({ page }, info) => {
    await disableFilePickers(page);
    await page.goto('/');
    await combinedWeldStressFlow(page, info, initial);
  });
}
