import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { boltPreloadFlow } from './boltPreloadFlow.js';

test('ボルト締付けElectron: 現在への明示関連付け・別同意・実native・取消・入力保存1Undo', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await boltPreloadFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
