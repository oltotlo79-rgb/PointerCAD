import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { analysisFatigueNativeFlow } from './analysisFatigueNativeFlow.js';

test('desktop native solid stress feeds solid-proportional fatigue and stale results are not reused', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await page.setViewportSize({ width: 1440, height: 900 });
    await analysisFatigueNativeFlow(page, info, app);
  } finally { await app.close(); }
});
