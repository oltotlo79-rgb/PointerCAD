import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { surfacesFlow } from './surfacesFlow.js';

test('P11b 曲面のロフト・平滑化・案内線を実Electronの保存再編集でも維持する', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await surfacesFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
