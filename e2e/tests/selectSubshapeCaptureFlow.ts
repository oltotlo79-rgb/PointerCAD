/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import { selectionKindLabel, sketchTool } from './solidCaptureSupport.js';
import { BOX_TOP_FACE_CENTER, clickWorldPoint, placeAndSelectBox, statusBar } from './measurementCaptureSupport.js';

/**
 * 「面・辺・頂点を選ぶ」章の1枚(`packages/help-content/docs/ja/select-subshape.md`)。
 *
 * select-subshape-kind: `3` キーで「選ぶもの」を面に切り替え、立体の上面をクリックした
 * あとの画面いちばん下の帯(§いま何を選ぶかは画面下に出ている)。
 */
export async function selectSubshapeCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await placeAndSelectBox(page);

  // 選択ツールのまま `3` を押して「面」に切り替え、上面をクリックする。
  await sketchTool(page, '選択').click();
  await page.keyboard.press('3');
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, BOX_TOP_FACE_CENTER);

  await captureManualDetail(page, info, {
    name: 'select-subshape-kind', dialog: statusBar(page),
    fixture: { selectedKind: '面', clicked: 'topFace' }, script: new URL(import.meta.url),
  });
}
