/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { choice, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

/*
 * E-09 接合チェック: 画面の操作だけで確かめる(ファイルの差し込み・店への直入れはしない)。
 * 下ごしらえ: 系列の溝幅 6 20×20 を、線に沿って並べる道で、点 (0,0,0)・(500,0,0)・(500,500,0) の L 字に 2 本置く(角の扱いは突き当て)。
 * 期待: 接合チェックの一覧に、留めていない L 字の接続が 1 行(2 本の名前)、要約は「留めていない接続 1」・どこにも留められていない部材 2。
 * 行を押すと選んだ印が付き、閉じると一覧が消える。
 */

export function jointCheckPanel(page: Page): Locator {
  return page.getByTestId('joint-check');
}

/** 「組む」の一覧から接合チェックを開く(締結部品の自動判別の流れも使う)。 */
export async function openJointCheck(page: Page): Promise<void> {
  await chooseToolMenuItem(page, uiMessage('assembly', 'assembly.menu.build'), uiMessage('assembly', 'assembly.tool.jointCheck'));
}

/** 系列の 20×20 を L 字に 2 本置き、選ぶ窓を閉じる(締結部品の自動判別の流れも使う)。 */
export async function placeLFrames(page: Page): Promise<void> {
  const dialog = await openFramePicker(page);
  await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
  await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
  const layout = dialog.locator('details').filter({
    has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.frameLayout.title') }),
  });
  await layout.locator('summary').click();
  await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true })
    .fill(['0\t0\t0', '500\t0\t0', '500\t500\t0'].join('\n'));
  await choice(layout, 'catalog', 'catalog.frameLayout.corners').selectOption('butt');
  const token = await beginRecompute(page);
  await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
  await waitForRecompute(page, token);
  await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
  await expect(componentRows(page)).toHaveCount(2);
}

export function registerFrameJointCheckTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-09 接合チェック', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('L 字に置いた 2 本は、留めていない接続 1 行と要約になり、行を押すと選んだ印が付き、閉じると消える', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      await placeLFrames(page);
      await openJointCheck(page);
      const panel = jointCheckPanel(page);
      await expect(panel).toBeVisible();
      const rows = panel.getByTestId('joint-check-row');
      await expect(rows).toHaveCount(1);
      await expect(rows.first()).toContainText(uiMessage('assembly', 'assembly.jointCheck.kind.L'));
      await expect(rows.first()).toContainText(uiMessage('assembly', 'assembly.jointCheck.fastening.none'));
      const summary = uiMessage('assembly', 'assembly.jointCheck.summary').replace('{none}', '1').replace('{oneSided}', '0')
        .replace('{rigid}', '0').replace('{members}', '2');
      await expect(panel.getByTestId('joint-check-summary')).toHaveText(summary);
      await rows.first().click();
      await expect(rows.first()).toHaveAttribute('aria-pressed', 'true');
      await panel.getByRole('button', { name: uiMessage('assembly', 'assembly.jointCheck.close'), exact: true }).click();
      await expect(panel).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  });
}
