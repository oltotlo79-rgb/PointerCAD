/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { appearanceChoiceValue, appearanceSection, chooseAppearance, placeBox } from './appearanceCaptureSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';

/**
 * 「ガラス・鏡と映り込み」章の1枚(`packages/help-content/docs/ja/appearance-glass.md`)。
 * 箱を1つ置き、材質を「ガラス」にすると「透過率」の欄が出る(§ガラスの透過率を数値で決める)。
 */
export async function appearanceGlassCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeBox(page);
  await expect(appearanceChoiceValue(page, '材質')).toHaveText('既定');
  await chooseAppearance(page, '材質', 'ガラス');

  await captureManualDetail(page, info, {
    name: 'appearance-glass-transmission', dialog: appearanceSection(page),
    fixture: { shape: '箱1', material: 'ガラス' }, script: new URL(import.meta.url),
  });
}
