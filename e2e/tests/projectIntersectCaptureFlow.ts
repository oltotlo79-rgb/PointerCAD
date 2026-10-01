/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { waitForStartupHealth } from './startupHealth.js';
import {
  choosePlaneMenuItem, chooseEditTool, clickWorldPoint, drawRectangle, extrudeFace,
  featureTree, makeFace, planeBadge, statusText, treeRow,
} from './sketchFinishCaptureSupport.js';

const KERNEL_TIMEOUT_MS = 60_000;

/**
 * 「立体から線を取り込む(投影・断面)」章の2枚
 * (`packages/help-content/docs/ja/project-intersect.md`)。実際のマウスホバー(面が
 * 光る予告)は使わず、クリックで取り込みが確定した直後の状態(モデルブラウザに新しい
 * 行が増えた画面)を撮る。手順は`e2e/tests/workplane-3d.spec.ts`の通し検査
 * (立体の面を別のスケッチへ投影・作業平面で切った断面)と同じ組み立て。
 *
 * 1) project-face-outline: 40×30の板を10押し出した上面を、2本目のスケッチへ投影した
 *    直後(モデルブラウザに「投影1」が増えた状態)。
 * 2) section-plane-outline: 板の高さの半分にオフセットした作業平面で断面を取った直後
 *    (モデルブラウザに「断面1」が増えた状態)。
 */
export async function projectIntersectCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await waitForStartupHealth(page, info);

  // 1) 40×30の板を10押し出す。
  await drawRectangle(page, ['0', '0'], ['40', '30']);
  await expect(treeRow(page, '矩形1')).toBeVisible();
  await makeFace(page, ['矩形1']);
  await expect(treeRow(page, '面1')).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  const extrusion = await beginRecompute(page);
  await extrudeFace(page, '面1', '10');
  await treeRow(page, '押し出し1').click();
  await waitForRecompute(page, extrusion);

  // 2) スケッチを1本足し、板の上面を投影する。
  await featureTree(page).getByRole('button', { name: 'スケッチを追加', exact: true }).click();
  await expect(treeRow(page, 'スケッチ2')).toBeVisible();
  await waitForRecompute(page);
  await chooseEditTool(page, '投影');
  await expect(statusText(page)).toContainText('写したい立体の面か辺をクリック');
  await clickWorldPoint(page, [20, 15, 10]);
  await expect(featureTree(page).getByRole('button', { name: '投影1', exact: true })).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await captureManualDetail(page, info, {
    name: 'project-face-outline', dialog: featureTree(page),
    fixture: { step: 'project' }, script: new URL(import.meta.url),
  });

  // 3) 板の高さの半分(5)にオフセットした作業平面を作り、そこで断面を取る。
  await choosePlaneMenuItem(page, '作業平面(オフセット)');
  await expect(page.locator('.pcad-popover__title')).toHaveText('面から離す');
  await page.locator('.pcad-popover input.pcad-field__input').first().fill('5');
  await page.locator('.pcad-popover input.pcad-field__input').first().press('Enter');
  await expect(treeRow(page, '作業平面1')).toBeVisible();

  await featureTree(page).getByRole('button', { name: 'スケッチを追加', exact: true }).click();
  await expect(treeRow(page, 'スケッチ3')).toBeVisible();
  await choosePlaneMenuItem(page, '作業平面1');
  await expect(planeBadge(page)).toContainText('作業平面1');
  await waitForRecompute(page);
  await chooseEditTool(page, '断面');
  await expect(statusText(page)).toContainText('断面をとりたい立体をクリック');
  await clickWorldPoint(page, [20, 15, 10]);
  await expect(featureTree(page).getByRole('button', { name: '断面1', exact: true })).toBeVisible({ timeout: KERNEL_TIMEOUT_MS });
  await captureManualDetail(page, info, {
    name: 'section-plane-outline', dialog: featureTree(page),
    fixture: { step: 'section' }, script: new URL(import.meta.url),
  });
}
