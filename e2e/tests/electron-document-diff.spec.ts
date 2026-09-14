import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { documentDiffFlow } from './documentDiffFlow.js';

test('P12-13 実Electronで2ファイルを比較し、読込みの取消・破損・F1・現在の文書とUndoを通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await documentDiffFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
