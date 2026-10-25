import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { expressionInspectionFlow } from './expressionInspectionFlow.js';

test('R19 実Electronで数式入力中の単位・参照元・使用箇所・誤りの位置を出し、変換確定のEnterと表示切替で原式を保つ', async ({ playwright }, info) => {
  test.setTimeout(180_000);
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await expressionInspectionFlow(page);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
