import { expect, test } from '@playwright/test';
import { drawingNavigationFlow } from './drawingNavigationFlow.js';
import { launchDesktop } from './electronAppFlow.js';

test('EX10 実Electronで図面の移動2枠・拡大縮小2枠とズーム中心の実選択・文書保持', async ({ playwright }, info) => {
  const session = await launchDesktop(playwright, info);
  try {
    const page = await session.app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await drawingNavigationFlow(page, info, session.app); expect(errors).toEqual([]);
  } finally { await session.app.close(); }
});
