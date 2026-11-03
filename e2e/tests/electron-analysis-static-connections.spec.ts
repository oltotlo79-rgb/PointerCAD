import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { analysisStaticPersistenceFlow } from './analysisStaticPersistenceFlow.js';

test('desktop static analysis persists inputs and recomputes after reopening', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await page.setViewportSize({ width: 1440, height: 900 });
    await analysisStaticPersistenceFlow(page, info, app);
  } finally { await app.close(); }
});
