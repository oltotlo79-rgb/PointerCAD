/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { placeAndSelectBox, propertySection, propertyValue, runMeasure } from './measurementCaptureSupport.js';

/** 20×20×20の箱(体積8000mm³)を鋼(SS400、密度7.85g/cm³)のまま測った質量(8×7.85)。 */
const BOX_STEEL_MASS = '62.8 g';

/**
 * 「材料と重さを調べる」章の1枚(`packages/help-content/docs/ja/mass-properties.md`)。
 *
 * mass-properties-steel: 立体を選んで「測る」を押した直後の、右のプロパティ
 * 「質量特性」の節(材料は最初から鋼)。
 */
export async function massPropertiesCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // `placeAndSelectBox` は立体そのもの(既定の選ぶもの「立体」)を選んで終わる。
  await placeAndSelectBox(page);
  await runMeasure(page);
  await expect(propertyValue(page, '質量')).toHaveText(BOX_STEEL_MASS);

  await captureManualDetail(page, info, {
    name: 'mass-properties-steel', dialog: propertySection(page, '質量特性'),
    fixture: { material: '鋼(SS400)', mass: BOX_STEEL_MASS }, script: new URL(import.meta.url),
  });
}
