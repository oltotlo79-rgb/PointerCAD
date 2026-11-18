/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Page } from '@playwright/test';
import { startAssembly } from './aluminumFrameCatalogFlow.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { componentRows } from './boltedJointTestSupport.js';
import { jointCheckPanel, openJointCheck, placeLFrames } from './frameJointCheckFlow.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';

/*
 * E-13 結合の入れ替えと伸縮: 画面の操作だけで確かめる(ファイルの差し込み・店への直入れはしない)。
 * 下ごしらえ: 系列の溝幅 6 20×20 を L 字に 2 本(接合チェックの流れと同じ)。接合チェックの行の「留める」で、通る最初の板で留める。
 * 期待: 留めた直後(板・ナット・ボルトを選んだまま)に「結合を入れ替える」を開くと、今の板に「今」の印が付き、別の板を選んで入れ替えると
 * 部品の数は変わらず、接合チェックは「留めていない接続はありません」のまま。続けて「伸縮」で +X の面 250 を 100 伸ばすと、
 * 予告に伸びる部材 1 本が出て、確定の後も部品の数が変わらず、接合チェックは留めたまま(板・ナット・ボルトが相手と一緒に動いた)。
 */

const BUILD = (): string => uiMessage('assembly', 'assembly.menu.build');

/** 接合チェックの行の「留める」から、通る最初の板で留める。 */
async function fastenFirst(page: Page): Promise<void> {
  const panel = jointCheckPanel(page);
  await panel.getByTestId('joint-check-fasten').click();
  const dialog = page.getByTestId('frame-joint-bracket');
  await dialog.getByTestId('frame-joint-bracket-joint').getByRole('radio').first().check();
  const token = await beginRecompute(page);
  await dialog.getByTestId('frame-joint-bracket-commit').click();
  await waitForRecompute(page, token);
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByText(uiMessage('assembly', 'assembly.jointCheck.allFastened'), { exact: true })).toBeVisible();
}

export function registerFrameJointSwapStretchTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('E-13 結合の入れ替えと伸縮', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('留めた板を別の板へ入れ替え、+X の面 250 で 100 伸ばしても、部品の数が変わらず接合チェックは留めたまま', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      await placeLFrames(page);
      await openJointCheck(page);
      await fastenFirst(page);
      const count = await componentRows(page).count();
      const panel = jointCheckPanel(page);

      await chooseToolMenuItem(page, BUILD(), uiMessage('assembly', 'assembly.tool.jointSwap'));
      const dialog = page.getByTestId('frame-joint-bracket');
      await expect(dialog.getByTestId('frame-joint-bracket-current')).toHaveCount(1);
      const commit = dialog.getByTestId('frame-joint-bracket-commit');
      await expect(commit).toBeDisabled();
      const other = dialog.getByTestId('frame-joint-bracket-joint').locator('label')
        .filter({ hasNot: page.getByTestId('frame-joint-bracket-current') }).getByRole('radio').first();
      await other.check();
      const swapToken = await beginRecompute(page);
      await commit.click();
      await waitForRecompute(page, swapToken);
      await expect(dialog).toHaveCount(0);
      await expect(componentRows(page)).toHaveCount(count);
      await expect(panel.getByText(uiMessage('assembly', 'assembly.jointCheck.allFastened'), { exact: true })).toBeVisible();

      await chooseToolMenuItem(page, BUILD(), uiMessage('assembly', 'assembly.tool.memberStretch'));
      const stretch = page.getByTestId('member-stretch');
      await stretch.getByTestId('member-stretch-direction').selectOption('+x');
      await stretch.getByTestId('member-stretch-plane').fill('250');
      await stretch.getByTestId('member-stretch-amount').fill('100');
      // 予告の文の「伸び縮みする部材 {stretched} 本・動く部品 」までが、部材 1 本で出る(動く部品の数は板の穴の数で変わるので照らさない)。
      const [head = '', rest = ''] = uiMessage('assembly', 'assembly.memberStretch.summary').split('{stretched}');
      await expect(stretch.getByTestId('member-stretch-preview')).toContainText(`${head}1${rest.split('{moved}')[0] ?? ''}`);
      const stretchToken = await beginRecompute(page);
      await stretch.getByTestId('member-stretch-commit').click();
      await waitForRecompute(page, stretchToken);
      await expect(stretch).toHaveCount(0);
      await expect(componentRows(page)).toHaveCount(count);
      await expect(panel.getByText(uiMessage('assembly', 'assembly.jointCheck.allFastened'), { exact: true })).toBeVisible();
      expect(errors).toEqual([]);
    });
  });
}
