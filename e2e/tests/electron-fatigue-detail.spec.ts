import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { fatigueDetailFlow } from './fatigueDetailFlow.js';

test('joint fatigue detail input, independent result, persistence and history (Electron)', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await fatigueDetailFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
