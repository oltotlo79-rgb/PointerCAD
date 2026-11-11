import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchDesktop } from './electronAppFlow.js';
import { impactCancelAndInvalidationFlow } from './impactCancelFlow.js';
import { impactLifecycleFlow } from './impactFlow.js';

/*
 * 衝撃の画面検査の Electron の入口(playwright.config.ts の electron の名前 electron-*.spec.ts)。流れと独立した期待は
 * impactFlow.ts、編集による無効化と取消しは impactCancelFlow.ts。起動と後片付けは electron-intersections.spec.ts と同じ
 * launchDesktop … finally app.close()。開く・保存は native のダイアログ(electronAppFlow.ts openTarget・saveTarget を
 * saveResponsivenessFlow.ts 経由)で、ファイルは launchDesktop の native の置き場所(info.outputPath('native'))に残る。
 */
test('衝撃: 断られた入力を残して直し、実計算し、適用・保存・開き直しで入力が戻り結果は計算し直すまで無い(Electron)', async ({ playwright }, info) => {
  const { app, directory } = await launchDesktop(playwright, info);
  try {
    const page = await app.firstWindow(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await impactLifecycleFlow(page, name => join(directory, name), app);
    await impactCancelAndInvalidationFlow(page);
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
