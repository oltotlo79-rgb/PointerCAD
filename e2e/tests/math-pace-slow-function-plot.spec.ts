import { test } from '@playwright/test';
import { mathPaceSlowFlow, W22_SCENARIOS } from './mathPaceSlowFlow.js';

test.use({ viewport: { width: 1440, height: 900 } });

// The existing Firefox function-plot matcher includes this file; no project/configuration change.
for (const scenario of W22_SCENARIOS) {
  test(`W22 ${scenario.id} real mathematics, persistence and cancellation`, async ({ page }, info) => {
    await page.addInitScript(() => {
      for (const name of ['showOpenFilePicker', 'showSaveFilePicker']) {
        Object.defineProperty(globalThis, name, { configurable: true, value: undefined });
      }
    });
    await mathPaceSlowFlow(page, info, scenario, undefined, async () => { await page.goto('/'); });
  });
}
