/// <reference lib="dom" />
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { chooseToolMenuItem, openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { diskFile, saveTarget } from './electronAppFlow.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { fileAction, statusBar } from './fileCaptureSupport.js';

const FILE_MENU = 'ファイルのほかの操作';

/**
 * 「印刷する・別名で保存する」章の2枚(`packages/help-content/docs/ja/print-save-as.md`)。
 *
 * 1) print-save-as-menu: 「ファイルのほかの操作」一覧(印刷・名前を付けて保存・最近使ったファイル)。
 * 2) print-save-as-status: 「名前を付けて保存」の直後、帯にファイル名と完了案内が出た状態。
 *
 * 印刷そのもの(OSの印刷窓やブラウザの`window.print()`)は頁の外の窓のため撮影しない。
 */
export async function printSaveAsCaptureFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 1) 箱を1つ置いて保存し、「最近使ったファイル」に1件残す。
  await chooseToolMenuItem(page, '作る', '箱');
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  // 既定値のままのEnterで閉じない実装もあるため、残っていたらEscで閉じる
  // (`e2e/tests/drawingManufacturingFixture.ts` のcreateBoxと同じ確認)。
  if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
  await expect(page.locator('.pcad-popover')).toHaveCount(0);
  const firstSavePath = info.outputPath('print-save-as-first.pcad');
  if (app !== undefined) await saveTarget(app, firstSavePath);
  const firstDownload = app === undefined ? page.waitForEvent('download') : null;
  await fileAction(page, '保存').click();
  if (firstDownload !== null) await (await firstDownload).saveAs(firstSavePath); else await diskFile(firstSavePath);
  await expect(page.locator('.pcad-statusbar__text')).toHaveText('保存しました');

  // 2) 「ファイルのほかの操作」を開き、印刷・名前を付けて保存・最近使ったファイルが並ぶ様子を撮る。
  await openToolMenu(page, FILE_MENU);
  const panel = toolMenuPanel(page, FILE_MENU);
  await expect(panel.getByRole('button', { name: '印刷', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: '名前を付けて保存', exact: true })).toBeVisible();
  await captureManualDetail(page, info, {
    name: 'print-save-as-menu', dialog: panel,
    fixture: { recentFiles: 1 }, script: new URL(import.meta.url),
  });

  // 3) 「名前を付けて保存」を選び、完了後の帯(ファイル名+完了案内)を撮る。
  const secondSavePath = info.outputPath('print-save-as-renamed.pcad');
  if (app !== undefined) await saveTarget(app, secondSavePath);
  const secondDownload = app === undefined ? page.waitForEvent('download') : null;
  await chooseToolMenuItem(page, FILE_MENU, '名前を付けて保存');
  if (secondDownload !== null) await (await secondDownload).saveAs(secondSavePath); else await diskFile(secondSavePath);
  await expect(page.locator('.pcad-statusbar__text')).toHaveText('保存しました');
  await captureManualDetail(page, info, {
    name: 'print-save-as-status', dialog: statusBar(page),
    fixture: { savedAs: true }, script: new URL(import.meta.url),
  });
}
