import { test } from '@playwright/test';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { assemblyCoupledDragFlow } from './assemblyCoupledDragFlow.js';

test.describe('EX12 dragging a cross-level coupled parent in the viewport', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('turns the coupled parent by a viewport drag as joint motion, keeps an ordinary drag one Undo step, and saves neither motion', async ({ page }, info) => {
    await disableFilePickers(page);
    await page.goto('/');
    await assemblyCoupledDragFlow(page, info, undefined);
  });
});
