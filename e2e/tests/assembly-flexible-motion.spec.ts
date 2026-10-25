import { test } from '@playwright/test';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { assemblyFlexibleMotionFlow } from './assemblyFlexibleMotionFlow.js';

test.describe('EX12 flexible subassembly motion', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('drives a child joint in one nested placement through the property field, transiently and without saving it', async ({ page }, info) => {
    await disableFilePickers(page);
    await page.goto('/');
    await assemblyFlexibleMotionFlow(page, info, undefined);
  });
});
