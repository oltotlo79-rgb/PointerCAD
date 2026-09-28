/// <reference lib="dom" />
import type { Locator, Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, commandLineInput, commandLineSuggestions, popoverTitle, typeCommand,
} from './sketchDrawCaptureSupport.js';

/** コマンドの欄そのものの入れ物(`.pcad-commandline`)。 */
function commandLineContainer(page: Page): Locator {
  return page.locator('.pcad-commandline');
}

/**
 * 「キーボードだけでかく(コマンドの欄)」章の2枚(`packages/help-content/docs/ja/command-line.md`)。
 *
 * 1) command-line-suggestions: 打ちかけの`circl`に合う道具の名前が欄の上に並んだ画面
 *    (§打っている途中の助け)。
 * 2) command-line-relative: `L`→`0,0`で始点を決めた後、欄に`@40,0`(直前の点から
 *    右へ40mm)を打った画面(§座標の書き方、§例: L字の2本の線をかく)。
 */
export async function commandLineCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 1) 候補の一覧。
  const input = commandLineInput(page);
  await input.click();
  await input.fill('circl');
  const suggestions = commandLineSuggestions(page);
  await expect(suggestions).toBeVisible();
  await expect(suggestions.getByRole('option')).toHaveCount(1);
  await captureManualDetail(page, info, {
    name: 'command-line-suggestions', dialog: commandLineContainer(page),
    fixture: { typed: 'circl' }, script: new URL(import.meta.url),
  });
  await input.fill('');
  await input.press('Escape');

  // 2) L字の線分。始点を決めた後、欄に「@40,0」を打った状態(まだEnterを押していない)。
  await typeCommand(page, 'L');
  await expect(popoverTitle(page)).toHaveText('線分の始点');
  await typeCommand(page, '0,0');
  await expect(popoverTitle(page)).toHaveText('線分の終点');
  await input.click();
  await input.fill('@40,0');
  await captureManualDetail(page, info, {
    name: 'command-line-relative', dialog: commandLineContainer(page),
    fixture: { start: [0, 0], typed: '@40,0' }, script: new URL(import.meta.url),
  });
  await input.press('Enter');
  await cancelPopover(page);
}
