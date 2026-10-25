import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { assemblyCoupledDragFlow } from './assemblyCoupledDragFlow.js';

/** The same viewport drag flow in the desktop app (files through the app's own open/save targets). */
test('EX12 dragging a cross-level coupled parent in the viewport of the desktop app', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    expect(page.url()).toBe('app://pointercad/index.html');
    await page.setViewportSize({ width: 1440, height: 900 });
    await assemblyCoupledDragFlow(page, info, app);
  } finally {
    await app.close();
  }
});
