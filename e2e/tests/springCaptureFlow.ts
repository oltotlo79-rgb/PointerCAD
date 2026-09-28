/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { captureManualDetail } from './captureManualDetail.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  cancelPopover, commitPopover, fillFields, popover, popoverInputs, popoverTitle, sketchTool, treeRow,
} from './solidCaptureSupport.js';

/**
 * 「ばねを作る」章の2枚(`packages/help-content/docs/ja/spring.md`)。始点を1つ打ち、
 * 「ばね」を押す手順は`e2e/tests/solid.spec.ts`「点からコイルばねが作れる(FR-414)」と同じ。
 *
 * 1) spring-shape: 1段目「ばねの形を決める」。コイル径20・線径2が既定(§手順)。
 * 2) spring-length: 2段目「ばねの長さを決める」。ピッチ5・巻数4が既定(§全長・ピッチ・巻数は、2つ決めれば残りが決まる)。
 */
export async function springCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  await sketchTool(page, '点').click();
  await expect(popoverTitle(page)).toHaveText('点を作る');
  await fillFields(page, ['0', '0', '0']);
  await commitPopover(page);
  await cancelPopover(page);
  await expect(treeRow(page, '点1')).toBeVisible();
  await treeRow(page, '点1').click();

  await openToolMenu(page, '作る');
  const menu = toolMenuPanel(page, '作る');
  await menu.getByRole('button', { name: 'ばね', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('ばねの形を決める');
  await expect(popoverInputs(page).nth(0)).toHaveValue('20');
  await expect(popoverInputs(page).nth(1)).toHaveValue('2');
  await captureManualDetail(page, info, {
    name: 'spring-shape', dialog: popover(page),
    fixture: { start: '点1', coilDiameter: '20', wireDiameter: '2' }, script: new URL(import.meta.url),
  });
  await commitPopover(page);

  await expect(popoverTitle(page)).toHaveText('ばねの長さを決める');
  await expect(popoverInputs(page).nth(0)).toHaveValue('5');
  await expect(popoverInputs(page).nth(1)).toHaveValue('4');
  await captureManualDetail(page, info, {
    name: 'spring-length', dialog: popover(page),
    fixture: { start: '点1', pitch: '5', turns: '4' }, script: new URL(import.meta.url),
  });
  await commitPopover(page);
  await expect(treeRow(page, 'ばね1')).toBeVisible();
}
