import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { combinedWeldStressFlow } from './combinedWeldStressFlow.js';

for (const initial of [false, true]) {
  test(`Electron combined weld stresses: initial shortening=${initial}`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow();
      expect(page.url()).toBe('app://pointercad/index.html');
      await combinedWeldStressFlow(page, info, initial, app);
    } finally { await app.close(); }
  });
}
