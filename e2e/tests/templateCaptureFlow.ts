/// <reference lib="dom" />
import { writeFile } from 'node:fs/promises';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { PCAD_TEMPLATE_KIND, writePcadFile } from '../../packages/io/src/index.js';
import { appendSolid, createEmptyPartDocument, createPrimitiveFeature, DEFAULT_TOOL_DEFAULTS } from '../../packages/model/src/index.js';
import { chooseToolMenuItem, openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { diskFile, openTarget, saveTarget } from './electronAppFlow.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { statusBar } from './fileCaptureSupport.js';

const FILE_MENU = 'ファイルのほかの操作';

/**
 * 「ひな形を使う」章の2枚(`packages/help-content/docs/ja/template.md`)。
 *
 * 1) template-menu: 「ファイルのほかの操作」一覧に残したひな形の名前が並ぶ様子(§ひな形として残す)。
 * 2) template-has-history: 形の入ったひな形を選んだときの案内(§形の入ったひな形を選んだとき)。
 */
export async function templateCaptureFlow(page: Page, info: TestInfo, app?: ElectronApplication): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 1) 箱を1つ置いた状態でひな形として残す(形入りのひな形を用意する)。まだ一度も保存していない
  //    ので、ひな形の名前は部品の名前「部品1」に落ちる(`packages/ui/src/shell/menus/
  //    fileToolbarActions.tsx` の`templateNameOf`/`runSaveAsTemplate`)。
  await chooseToolMenuItem(page, '作る', '箱');
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  if (await page.locator('.pcad-popover').count() > 0) await page.locator('.pcad-popover input').first().press('Escape');
  await expect(page.locator('.pcad-popover')).toHaveCount(0);
  const templatePath = info.outputPath('template-box.pcadt');
  if (app !== undefined) await saveTarget(app, templatePath);
  const templateDownload = app === undefined ? page.waitForEvent('download') : null;
  await chooseToolMenuItem(page, FILE_MENU, 'ひな形として保存');
  if (templateDownload !== null) await (await templateDownload).saveAs(templatePath); else await diskFile(templatePath);
  await expect(page.locator('.pcad-statusbar__text')).toHaveText('ひな形として保存しました');

  // 2) 一覧を開き直し、残したひな形の名前が並ぶ様子を撮る。
  await openToolMenu(page, FILE_MENU);
  const panel = toolMenuPanel(page, FILE_MENU);
  await expect(panel.getByRole('button', { name: 'ひな形として保存', exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'ひな形から新規', exact: true })).toBeVisible();
  const storedTemplateButton = panel.getByRole('button', { name: '部品1', exact: true });
  await expect(storedTemplateButton).toBeVisible();
  await captureManualDetail(page, info, {
    name: 'template-menu', dialog: panel,
    fixture: { storedTemplateName: '部品1' }, script: new URL(import.meta.url),
  });

  // 3) 履歴入りのひな形を選んだときの案内を撮る。「ひな形として保存」は履歴を必ず空にする
  //    (`packages/model/src/part/templates.ts` の`templateFromDocument`/`emptyHistory`。
  //    §0.a-0.35「フィーチャー履歴は空」)ため、置き場の一覧(上の「部品1」)を選んでも
  //    この案内は絶対に出ない。履歴(箱1つ)を持つ`.pcadt`を直に書き出し、「ひな形から新規」の
  //    ファイル選択から開いて再現する(`templateToolDefaultsFlow.ts`と同じ作り方)。
  const historyDocument = createEmptyPartDocument();
  const historyTemplatePath = info.outputPath('template-with-history.pcadt');
  await writeFile(historyTemplatePath, writePcadFile(
    appendSolid(historyDocument, createPrimitiveFeature(historyDocument, 'box')),
    { kind: PCAD_TEMPLATE_KIND, lengthUnit: 'mm', toolDefaults: DEFAULT_TOOL_DEFAULTS },
  ));
  const newFromTemplateButton = panel.getByRole('button', { name: 'ひな形から新規', exact: true });
  if (app !== undefined) await openTarget(app, historyTemplatePath);
  const chooser = app === undefined ? page.waitForEvent('filechooser') : null;
  await newFromTemplateButton.click();
  // いまの部品は保存済み扱いではないので、選ぶと先に画面内の確認窓(`role="alertdialog"`、
  // 名前「保存していない変更があります」、「保存して続ける・保存せずに続ける・戻る」の3択。
  // w91aでブラウザ既定の`window.confirm`から差し替え済み)が開く。撮影は最終状態だけなので、
  // 「保存せずに続ける」を選んで閉じる。
  await page.getByRole('alertdialog', { name: '保存していない変更があります' })
    .getByRole('button', { name: '保存せずに続ける', exact: true }).click();
  if (chooser !== null) await (await chooser).setFiles(historyTemplatePath);
  await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');
  await expect(page.locator('.pcad-statusbar__text')).toHaveText(
    'このひな形には形が入っています。形は引き継がずに新しい部品を始めます。',
  );
  await captureManualDetail(page, info, {
    name: 'template-has-history', dialog: statusBar(page),
    fixture: { fromTemplate: 'template-with-history' }, script: new URL(import.meta.url),
  });
}
