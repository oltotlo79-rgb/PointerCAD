import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { assemblyFlexibleMotionFlow } from './assemblyFlexibleMotionFlow.js';

test('EX12 flexible subassembly motion in one nested placement of the desktop app', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await page.setViewportSize({ width: 1440, height: 900 });
    await assemblyFlexibleMotionFlow(page, info, app);
  } finally {
    await app.close();
  }
});
