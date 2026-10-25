import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { sketchConnected1000Flow } from './sketchConnected1000Flow.js';

/** The same fixed 1000-point sketch and drag in the desktop app (files through the app's own open/save targets). */
test('EX-13 W01 the fixed connected 1000-point sketch is opened and one dragged point is committed in the desktop app', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await page.setViewportSize({ width: 1440, height: 900 });
    await sketchConnected1000Flow(page, info, app);
  } finally {
    await app.close();
  }
});
