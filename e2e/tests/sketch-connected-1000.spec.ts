import { test } from '@playwright/test';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { sketchConnected1000Flow } from './sketchConnected1000Flow.js';

test.describe('EX-13 W01 the fixed connected 1000-point sketch', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('opens the 1000-point sketch with 1998 constraints and commits one dragged point as one rigid translation after an unfinished Escape cancels without document or history change', async ({ page }, info) => {
    await disableFilePickers(page);
    await page.goto('/');
    await sketchConnected1000Flow(page, info, undefined);
  });
});
