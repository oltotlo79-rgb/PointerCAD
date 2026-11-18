/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { startAssembly } from './aluminumFrameCatalogFlow.js';
import { componentRows } from './boltedJointTestSupport.js';
import { jointCheckPanel, openJointCheck, placeLFrames } from './frameJointCheckFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

/*
 * E-07 締結部品の自動判別: 画面の操作だけで確かめる(ファイルの差し込み・店への直入れはしない)。
 * 下ごしらえ: 系列の溝幅 6 20×20 を L 字に 2 本(接合チェックの流れと同じ)。接合チェックの行の「留める」から始める。
 * 期待: 接続 1 つの候補が並び、選ぶまで締結を押せず、通る候補を 1 つ選んで締結すると部品が増え(板 1・溝用のナットとボルト)、
 * 接合チェックの留めていない接続が 0 になる(板と 2 本が溝の締結でつながる)。
 */

export function registerFrameJointBracketTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-07 締結部品の自動判別', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('L 字の接続を接合チェックの行から留めると、候補を選んで締結でき、留めていない接続が 0 になる', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      await placeLFrames(page);
      await openJointCheck(page);
      const panel = jointCheckPanel(page);
      await expect(panel.getByTestId('joint-check-row')).toHaveCount(1);
      await panel.getByTestId('joint-check-fasten').click();
      const dialog = page.getByTestId('frame-joint-bracket');
      await expect(dialog).toBeVisible();
      const joint = dialog.getByTestId('frame-joint-bracket-joint');
      await expect(joint).toHaveCount(1);
      const commit = dialog.getByTestId('frame-joint-bracket-commit');
      await expect(commit).toBeDisabled();
      const first = joint.getByRole('radio').first();
      await expect(first).toBeVisible();
      await first.check();
      await expect(commit).toBeEnabled();
      const token = await beginRecompute(page);
      await commit.click();
      await waitForRecompute(page, token);
      await expect(dialog).toHaveCount(0);
      await expect.poll(async () => componentRows(page).count()).toBeGreaterThan(4);
      await expect(panel.getByTestId('joint-check-row')).toHaveCount(0);
      await expect(panel.getByText(uiMessage('assembly', 'assembly.jointCheck.allFastened'), { exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    });
  });
}
