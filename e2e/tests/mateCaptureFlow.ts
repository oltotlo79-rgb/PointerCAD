/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { chooseToolMenuItem, twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { openAssemblyFixtureCapture, selectComponent } from './assemblyCaptureSupport.js';

/**
 * 「部品どうしを合わせる」章の1枚(`packages/help-content/docs/ja/mate.md`)。
 *
 * 1) mate-dialog: 「合わせる」→「一致」を開き、1つ目の部品の原点を選んだ画面
 *    (§別々の部品から面、辺、頂点、または基準を1つずつ選んでください)。
 */
export async function mateCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await twoBoxAssemblyFile(40);
  await openAssemblyFixtureCapture(page, fixture, 'mate.pcada');

  await chooseToolMenuItem(page, '合わせる', '一致');
  const dialog = page.getByRole('dialog', { name: '合致を作る' });
  await expect(dialog).toBeVisible();
  await selectComponent(page, 0);
  const originButton = dialog.getByRole('button', { name: '選択部品の原点', exact: true });
  await expect(originButton).toBeVisible();
  await originButton.click();

  await captureManualDetail(page, info, {
    name: 'mate-dialog', dialog,
    fixture: { kind: '一致', firstTarget: '選択部品の原点' }, script: new URL(import.meta.url),
  });
  await dialog.getByRole('button', { name: '取り消す', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
