import { expect, test } from '@playwright/test';
import { canvasAssetLifetimeFlow, prepareCanvasCold, verifyCanvasCold, type CanvasColdReceipt } from './canvasAssetLifetimeFlow.js';
import { canvasStateFlow } from './canvasStateFlow.js';
import { launchDesktop } from './electronAppFlow.js';

test('実Electronの下絵の状態・濃さ途中入力・再試行を狭い画面とキーボードで操作し、保存再開する', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    expect(page.url()).toBe('app://pointercad/index.html');
    await canvasStateFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('実Electronの下絵の削除と追加をUndo/Redoし、保存再開と同じ画像番号の部品切替でも画像を保つ', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    expect(page.url()).toBe('app://pointercad/index.html');
    await canvasAssetLifetimeFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

for (const state of ['deleted', 'visible', 'off'] as const) test(`V103 R20 実Electronの下絵 ${state} を保存しprocess終了・新launchでPNG/ZIP/文書を保つ`, async ({ playwright }, info) => {
  const first = await launchDesktop(playwright, info), errors: string[] = [];
  let receipt: CanvasColdReceipt;
  try {
    const page = await first.app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    receipt = await prepareCanvasCold(page, info, state, first.app);
  } finally { await first.app.close(); }
  // Same test attempt preserves the real desktop profile, while the old app process is gone.
  const fresh = await launchDesktop(playwright, info);
  try {
    const page = await fresh.app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await verifyCanvasCold(page, info, receipt, fresh.app); expect(errors).toEqual([]);
  } finally { await fresh.app.close(); }
});
