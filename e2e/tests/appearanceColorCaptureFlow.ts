/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { appearanceChoiceValue, appearanceSection, chooseAppearance, placeBox } from './appearanceCaptureSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';

/**
 * 「色と材質を選ぶ」章の1枚(`packages/help-content/docs/ja/appearance-color.md`)。
 * 箱を1つ置き、材質を「プラスチック」にした状態のプロパティの「外観」の節を撮る
 * (プラスチックは色を自由に選べる材質なので、色の見本8色も一緒に見える。
 * §色を変える(見本と数値))。
 */
export async function appearanceColorCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeBox(page);
  await expect(appearanceChoiceValue(page, '材質')).toHaveText('既定');
  await chooseAppearance(page, '材質', 'プラスチック');

  await captureManualDetail(page, info, {
    name: 'appearance-color-material', dialog: appearanceSection(page),
    fixture: { shape: '箱1', material: 'プラスチック' }, script: new URL(import.meta.url),
  });
}
