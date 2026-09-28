/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { sketchTool } from './solidCaptureSupport.js';
import {
  BOX_TOP_LEFT_CORNER, BOX_TOP_RIGHT_CORNER, clickWorldPoint, placeAndSelectBox,
  propertySection, propertyValue, runMeasure,
} from './measurementCaptureSupport.js';

/** 20×20×20 の箱の上面の対角線の長さ(`primitives.spec.ts` の CORNER_DISTANCE と同じ実測)。 */
const CORNER_DISTANCE = '28.2842712475 mm';

/**
 * 「長さ・角度・面積を測る」章の1枚(`packages/help-content/docs/ja/measure.md`)。
 *
 * measure-two-points: 頂点を2つ選び「測る」を押した直後の、右のプロパティ「測定」の節
 * (§測り方・§選べるもの)。
 */
export async function measureCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeAndSelectBox(page);

  // `1` で頂点にして、上面の角を2つ選ぶ(2つ目はShiftで足す)。
  await sketchTool(page, '選択').click();
  await page.keyboard.press('1');
  await clickWorldPoint(page, BOX_TOP_LEFT_CORNER);
  await clickWorldPoint(page, BOX_TOP_RIGHT_CORNER, true);
  await expect(propertyValue(page, '選んでいるもの')).toHaveText('頂点 / 頂点');
  await expect(propertyValue(page, '測れるもの')).toHaveText('2 点の距離');

  await runMeasure(page);
  await expect(propertyValue(page, '結果')).toHaveText(`2 点の距離: ${CORNER_DISTANCE}`);

  await captureManualDetail(page, info, {
    name: 'measure-two-points', dialog: propertySection(page, '測定'),
    fixture: { selected: '頂点 / 頂点', result: CORNER_DISTANCE }, script: new URL(import.meta.url),
  });
}
