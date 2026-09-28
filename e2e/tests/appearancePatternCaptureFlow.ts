/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { appearanceChoiceValue, appearancePatternButton, appearanceSection, chooseAppearance, placeBox } from './appearanceCaptureSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';

/**
 * 「柄を選ぶ」章の1枚(`packages/help-content/docs/ja/appearance-pattern.md`)。
 * 箱を1つ置き、材質を「縞鋼板」にすると柄が自動で「縞鋼板」に決まり、「模様の大きさ」の
 * 欄も出る(§柄を選ぶ(3種)・§模様の大きさを数値で決める)。
 */
export async function appearancePatternCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeBox(page);
  await expect(appearanceChoiceValue(page, '材質')).toHaveText('既定');
  await chooseAppearance(page, '材質', '縞鋼板');
  await expect(appearancePatternButton(page, '縞鋼板')).toHaveAttribute('aria-pressed', 'true');

  await captureManualDetail(page, info, {
    name: 'appearance-pattern-checker', dialog: appearanceSection(page),
    fixture: { shape: '箱1', material: '縞鋼板', pattern: '縞鋼板' }, script: new URL(import.meta.url),
  });
}
