import { scriptToolsFlow } from './scriptToolsFlow.js';
import { scriptLimitsFlow } from './scriptLimitsFlow.js';
import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { scriptsFlow } from './scriptsFlow.js';
test('P11 自動作図の実Electron・保存・Undo・道具登録・隔離と中止', async ({ playwright }, info) => {
  test.setTimeout(150000);
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await scriptsFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('P11 自動作図の実Electron・資源上限・中止応答・コード競合からの復旧', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await scriptLimitsFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('P11 自動作図の実Electron・20道具の登録編集削除・moduleの編集と行表示', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await scriptToolsFlow(page, info, app); expect(errors).toEqual([]);
  } finally { await app.close(); }
});
