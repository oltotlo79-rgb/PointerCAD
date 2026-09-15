import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { shortcutConflictFlow, shortcutSettingsFlow, shortcutToolFlow } from './shortcutSettingsFlow.js';

for (const [name, flow] of [
  ['割当の適用・実ファイル保存・再開・現在の説明', shortcutSettingsFlow],
  ['重複と予約の拒否・取消・文字と日本語入力の保護', shortcutConflictFlow],
  ['道具と表示と板金を同じ入口で使い、入力のF1と実保存を保持', shortcutToolFlow],
] as const) {
  test(`P12-7 実Electronでキー設定の${name}`, async ({ playwright }, info) => {
    const { app } = await launchDesktop(playwright, info);
    try {
      const page = await app.firstWindow(), errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await flow(page, info, app); expect(errors).toEqual([]);
    } finally { await app.close(); }
  });
}
