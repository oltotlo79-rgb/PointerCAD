/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test';
// 入れる時に aluminumFrameCatalogFlow.ts から choice・expectPreviewLengths・openFramePicker・startAssembly を export する(同じ探し方を使い回す)。
import { choice, expectPreviewLengths, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { chooseToolMenuItem } from './assemblyTestSupport.js';
import { clickWorldPointChecked, componentRows } from './boltedJointTestSupport.js';
import type { WorldPoint } from './homeViewProjection.js';
import { beginRecompute, waitForRecompute } from './recompute.js';
import { uiMessage, uiMessagePattern } from './uiMessages.js';

/*
 * J-02 P6b・P7: フレームの溝への締結を、画面の操作だけで確かめる(ファイルの差し込み・店への直入れはしない)。
 * 下ごしらえ: 系列の溝幅 6 20×20 を線 (−250, y, −10)-(250, y, −10) に 1 本(上の面は z = 0。断面の半分 10)、資料の平板の
 * ブラケット 溝幅 6 36×16×2(穴 2・φ5.5。穴の中心は外形の中心から x = ±10、y = 0。資料の行の値)を原点に置く(板の下の面 z = 0 が
 * フレームの上の面に当たる)。y = 0 なら穴は溝の中心線の上、y = 3 なら 3 mm ずれる(通るずれは (口の幅 − 径)/2 で 1 mm 未満)。
 * 期待: 溝用のナットは溝幅 6・M5・後入れ・鋼の行(資料の行の呼び)、ボルトは M5。部品は 2 + ナット 2 + ボルト 2 = 6、Undo 1 回で 2。
 */
const PLATE_HOLES: readonly WorldPoint[] = [[-10, 0, 2], [10, 0, 2]];
/** ホーム視点の視線の水平の向き(カメラは +X・−Y の側)。穴の上の面の点を奥の壁の側へ 1 mm 寄せて押すと、視線は穴の中の奥の壁に当たる。 */
const TOWARD_FAR_WALL: WorldPoint = [-Math.SQRT1_2, Math.SQRT1_2, 0];
const NUT_NAME = 'T 溝用ナット 溝幅 6 M5（後入れ・鋼）';

function frameSlotDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.frameSlot.title'), exact: true });
}

/** フレーム 1 本(中心線の y を指定)と平板のブラケット 1 つを置き、選ぶ窓を閉じる。 */
async function placeFrameAndPlate(page: Page, frameY: number): Promise<void> {
  const dialog = await openFramePicker(page);
  await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-frame-series');
  await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-20x20');
  const layout = dialog.locator('details').filter({
    has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.frameLayout.title') }),
  });
  await layout.locator('summary').click();
  await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true })
    .fill([`-250\t${String(frameY)}\t-10`, `250\t${String(frameY)}\t-10`].join('\n'));
  await expectPreviewLengths(layout, ['500']);
  let token = await beginRecompute(page);
  await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
  await waitForRecompute(page, token);
  await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-flat-plate');
  await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption('s6-36x16x2-h2');
  token = await beginRecompute(page);
  await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.place'), exact: true }).click();
  await waitForRecompute(page, token);
  await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.standardPart.close'), exact: true }).click();
  await expect(componentRows(page)).toHaveCount(2);
}

async function openFrameSlotTool(page: Page): Promise<Locator> {
  await chooseToolMenuItem(page, uiMessage('assembly', 'assembly.menu.build'), uiMessage('assembly', 'assembly.frameSlot.tool'));
  const dialog = frameSlotDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

/** 予告の表の行(穴ごと)。 */
function previewRows(dialog: Locator): Locator {
  return dialog.getByTestId('frame-slot-preview').locator('tbody tr');
}

/** 締結して部品が 6 つになり、Undo 1 回で 2 つ、Redo で 6 つに戻る。 */
async function commitAndUndo(page: Page, dialog: Locator): Promise<void> {
  let token = await beginRecompute(page);
  await dialog.getByTestId('frame-slot-commit').click();
  await waitForRecompute(page, token);
  await expect(componentRows(page)).toHaveCount(6);
  token = await beginRecompute(page);
  await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.undo'), exact: true }).click();
  await waitForRecompute(page, token);
  await expect(componentRows(page)).toHaveCount(2);
  token = await beginRecompute(page);
  await page.getByRole('button', { name: uiMessage('toolbar', 'toolbar.history.redo'), exact: true }).click();
  await waitForRecompute(page, token);
  await expect(componentRows(page)).toHaveCount(6);
}

export function registerFrameSlotFasteningTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('J-02 フレームの溝への締結', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('P7 選んだブラケットの全部の穴: 予告は 2 行(上の面・溝幅 6 M5 後入れ・鋼・M5)で、締結すると 6 部品、Undo 1 回で 2', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      await placeFrameAndPlate(page, 0);
      await componentRows(page).nth(1).click();
      const dialog = await openFrameSlotTool(page);
      await expect(dialog.getByTestId('frame-slot-prompt')).toHaveText(uiMessage('assembly', 'assembly.frameSlot.promptBracket'));
      await expect(previewRows(dialog)).toHaveCount(2);
      for (const row of await previewRows(dialog).all()) {
        await expect(row).toContainText(uiMessage('assembly', 'assembly.frameSlot.face.top'));
        await expect(row).toContainText(NUT_NAME);
        await expect(row).toContainText('M5');
      }
      await expect(dialog.getByText(uiMessage('assembly', 'assembly.frameSlot.depthSimplified'), { exact: true })).toBeVisible();
      await commitAndUndo(page, dialog);
      expect(errors).toEqual([]);
    });

    test('P6b 穴の面を選ぶ: 1 つ目を選び、Shift で 2 つ目を足すと予告が 2 行になり、締結すると 6 部品', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      await placeFrameAndPlate(page, 0);
      // フレームだけを選んで開く(溝つきのフレームはブラケットにしないので、穴を選ぶ形で始まる)。
      await componentRows(page).nth(0).click();
      const dialog = await openFrameSlotTool(page);
      await expect(dialog.getByTestId('frame-slot-prompt')).toHaveText(uiMessage('assembly', 'assembly.frameSlot.pickHole'));
      const [first, second] = PLATE_HOLES.map((point): WorldPoint => [point[0] + TOWARD_FAR_WALL[0], point[1] + TOWARD_FAR_WALL[1], point[2]]);
      if (first === undefined || second === undefined) throw new Error('holes');
      await clickWorldPointChecked(page, first);
      await expect(previewRows(dialog)).toHaveCount(1);
      await page.keyboard.down('Shift');
      await clickWorldPointChecked(page, second);
      await page.keyboard.up('Shift');
      await expect(previewRows(dialog)).toHaveCount(2);
      await commitAndUndo(page, dialog);
      expect(errors).toEqual([]);
    });

    test('溝から 3 mm ずれたブラケットは、予告の 2 行が理由(3 mm ずれ)になり、締結を押せない', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      await placeFrameAndPlate(page, 3);
      await componentRows(page).nth(1).click();
      const dialog = await openFrameSlotTool(page);
      await expect(previewRows(dialog).and(page.getByRole('alert'))).toHaveCount(2);
      await expect(previewRows(dialog).first()).toContainText('3 mm');
      await expect(dialog.getByTestId('frame-slot-commit')).toBeDisabled();
      await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.frameSlot.cancel'), exact: true }).click();
      await expect(componentRows(page)).toHaveCount(2);
      expect(errors).toEqual([]);
    });
  });
}
