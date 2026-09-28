/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { chooseToolMenuItem, twoBoxAssemblyFile } from './assemblyTestSupport.js';
import { openAssemblyFixtureCapture, selectComponent } from './assemblyCaptureSupport.js';

/**
 * 「ジョイントで動きを残す」章の1枚(`packages/help-content/docs/ja/joint.md`)。
 *
 * 1) joint-dialog: 「合わせる」→「回転」を開き、取付軸(Z軸)を2つとも選び、可動範囲
 *    30°〜120°を入れた画面(§別々の部品から取付位置を1つずつ選びます)。
 * p7-standard-parts.spec.tsの(e)と同じ手順(確定はしない)。
 */
export async function jointCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await twoBoxAssemblyFile(40);
  await openAssemblyFixtureCapture(page, fixture, 'joint.pcada');

  await chooseToolMenuItem(page, '合わせる', '回転');
  const dialog = page.getByRole('dialog', { name: 'ジョイントを作る' });
  await expect(dialog).toBeVisible();
  for (const index of [0, 1]) {
    await selectComponent(page, index);
    await dialog.getByRole('button', { name: 'Z軸', exact: true }).click();
  }
  const rangeInputs = dialog.locator('input.pcad-field__input');
  await rangeInputs.nth(0).fill('30');
  await rangeInputs.nth(1).fill('120');

  await captureManualDetail(page, info, {
    name: 'joint-dialog', dialog,
    fixture: { kind: '回転', axis: 'Z軸', rangeMin: '30', rangeMax: '120' }, script: new URL(import.meta.url),
  });
  await dialog.getByRole('button', { name: '取り消す', exact: true }).click();
  await expect(dialog).toHaveCount(0);
}
