import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { autoSaveSettingsFlow } from './autoSaveSettingsFlow.js';
import { waitForStartupHealth } from './startupHealth.js';

test('P12-8 実Electronで自動保存の間隔を変更し、実際の控えと保存・再起動・F1を通す', async ({ playwright }, info) => {
  const { app } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    // 最初の空画面を読み直し、アプリのタイマー作成前から同じ時計を使う。
    await page.clock.install(); await page.reload(); await autoSaveSettingsFlow(page, info, app);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
  // 同じ試験の通常プロファイルでプロセスを起動し直し、端末への永続化を実物で確かめる。
  const reopened = await launchDesktop(playwright, info);
  try {
    const page = await reopened.app.firstWindow(); await waitForStartupHealth(page, info);
    await page.getByRole('button', { name: '設定', exact: true }).click();
    await expect(page.getByRole('form', { name: '自動保存の間隔', exact: true })
      .getByLabel('保存する間隔（分）', { exact: true })).toHaveValue('1');
  } finally { await reopened.app.close(); }
});
