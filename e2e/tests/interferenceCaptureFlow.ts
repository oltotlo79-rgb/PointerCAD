/// <reference lib="dom" />
import type { Page, TestInfo } from '@playwright/test';
import { expect } from '@playwright/test';
import { captureManualDetail } from './captureManualDetail.js';
import { readAssemblyStats } from './assemblyTestSupport.js';
import { createOriginCoincidentMate, placeTwoBoxesCapture, startNewAssemblyCapture } from './assemblyCaptureSupport.js';

/**
 * 「部品の干渉を調べる」章の1枚(`packages/help-content/docs/ja/interference.md`)。
 *
 * 1) interference-result: 原点を一致させて重ねた箱2個で「干渉を調べる」を実行し、
 *    結果の組を選んだ画面(§終わると干渉している組の件数が画面下に出ます)。
 * assembly.spec.tsの(a)と同じ手順(原点一致で完全に重ねる)。
 */
export async function interferenceCaptureFlow(page: Page, info: TestInfo): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await startNewAssemblyCapture(page);
  await placeTwoBoxesCapture(page);
  await createOriginCoincidentMate(page);

  await page.getByRole('group', { name: '組む' })
    .getByRole('button', { name: '干渉を調べる', exact: true }).click();
  const panel = page.locator('.pcad-interference');
  const row = panel.locator('.pcad-interference__row').first();
  await expect(row).toBeVisible();
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await readAssemblyStats(page)).interferenceSelectedKey).not.toBeNull();

  await captureManualDetail(page, info, {
    name: 'interference-result', dialog: panel,
    fixture: { overlappingPairs: 1 }, script: new URL(import.meta.url),
  });
  await panel.getByRole('button', { name: '干渉の結果を閉じる', exact: true }).click();
}
