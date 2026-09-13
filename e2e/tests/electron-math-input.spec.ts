import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { mathInputFlow } from './mathInputFlow.js';
import { mathLinearFlow } from './mathLinearFlow.js';

test('ADD-17 数学入力の実Electron・係数追従・改名・Undo・保存再編集', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); console.error('[数学入力の画面例外]', error.message); });
    await mathInputFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('ADD-20 連立一次式とQR分解の分野検索・成分指定・保存・F1を実Electronで通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => { errors.push(error.message); });
    await mathLinearFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
