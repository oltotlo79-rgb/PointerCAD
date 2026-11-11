import { test } from '@playwright/test';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { assemblyCoupledDragFlow } from './assemblyCoupledDragFlow.js';
import { ORACLE_RATIOS } from './assemblyMechanismOracleFixture.js';
import { assemblyMechanismOracleFlow, assemblyMechanismRefusalFlow } from './assemblyMechanismOracleFlow.js';

test.describe('EX12 dragging a cross-level coupled parent in the viewport', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('turns the coupled parent by a viewport drag as joint motion, keeps an ordinary drag one Undo step, and saves neither motion', async ({ page }, info) => {
    await disableFilePickers(page);
    await page.goto('/');
    await assemblyCoupledDragFlow(page, info, undefined);
  });

  for (const ratio of ORACLE_RATIOS) {
    test(`exact angle field: ratio ${String(ratio)}, nonzero phase, both half-turn boundaries and persistence`, async ({ page }, info) => {
      await disableFilePickers(page);
      await page.goto('/');
      await assemblyMechanismOracleFlow(page, info, undefined, ratio);
    });
  }

  test('rejects contradictory phase and missing reference files without changing the scene or history, then drives normally', async ({ page }, info) => {
    await disableFilePickers(page);
    await page.goto('/');
    await assemblyMechanismRefusalFlow(page, info, undefined);
  });
});
