import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { historyNotesFlow } from './historyNotesFlow.js';

test('P12-11/P12-12 実Electronの設計メモと履歴フォルダを保存再開・取消・Undo・F1まで通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await historyNotesFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
