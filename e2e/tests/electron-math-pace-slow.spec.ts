import { test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { mathPaceSlowFlow, W22_SCENARIOS } from './mathPaceSlowFlow.js';

for (const scenario of W22_SCENARIOS) {
  test(`W22 ${scenario.id} real mathematics, persistence and cancellation`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      await mathPaceSlowFlow(await app.firstWindow(), info, scenario, app);
    } finally { await app.close(); }
  });
}
