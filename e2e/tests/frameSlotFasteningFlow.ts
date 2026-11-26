/// <reference lib="dom" />
import { expect, test as base, type ElectronApplication, type Locator, type Page } from '@playwright/test';
// 入れる時に aluminumFrameCatalogFlow.ts から choice・expectPreviewLengths・openFramePicker・startAssembly を export する(同じ探し方を使い回す)。
import { choice, expectPreviewLengths, openFramePicker, startAssembly } from './aluminumFrameCatalogFlow.js';
import { ex18ReadAssembly } from './ex18RoutesOracle.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
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
 * 溝の情報: 溝の位置を対称に置いた印つきの小さい溝つきフレーム(20×10・上の溝 口 6)では予告に位置の簡略の知らせが出て、溝幅の呼びが
 * 決まらない溝(20×10 の左右の口 4.5。90° 回して上へ向ける)では、予告の行が専用の理由になる。
 */
const PLATE_HOLES: readonly WorldPoint[] = [[-10, 0, 2], [10, 0, 2]];
/** ホーム視点の視線の水平の向き(カメラは +X・−Y の側)。穴の上の面の点を奥の壁の側へ 1 mm 寄せて押すと、視線は穴の中の奥の壁に当たる。 */
const TOWARD_FAR_WALL: WorldPoint = [-Math.SQRT1_2, Math.SQRT1_2, 0];
const NUT_NAME = 'T 溝用ナット 溝幅 6 M5（後入れ・鋼）';

function frameSlotDialog(page: Page): Locator {
  return page.getByRole('dialog', { name: uiMessage('assembly', 'assembly.frameSlot.title'), exact: true });
}

/** 置くフレーム: 族と行、線の z(断面の外形の中心を線に乗せるので、上の面が z = 0 になる値)、断面を線のまわりに回す 90° の回数。 */
interface FrameSetup {
  readonly kind: string;
  readonly size: string;
  readonly z: number;
  readonly quarterTurns: number;
}

/** 系列の溝幅 6 20×20(断面の半分 10)。 */
const SERIES_FRAME: FrameSetup = { kind: 't-slot-frame-series', size: 's6-20x20', z: -10, quarterTurns: 0 };
/**
 * 小さい溝つきフレーム 20×10・上の溝 口 6(呼び 6。溝と穴の横の位置は、図に記入が無いので幅の中央に対して対称に置いた印つきの行)。
 * 溝の形(口 6・中の幅 12・肩 2・中の高さ 4)は系列の溝幅 6 と同じなので、同じナットとボルトが入る。断面の高さ 10 の半分で線は z = −5。
 */
const SMALL_FRAME_SYMMETRIC: FrameSetup = { kind: 't-slot-frame-small', size: 'small-20x10-t6', z: -5, quarterTurns: 0 };
/**
 * 小さい溝つきフレーム 20×10・左右の溝 口 4.5(標準の溝の組に当たらないので溝幅の呼びが決まらない溝)。90° 回して左右の溝の 1 つを
 * 上へ向ける(左右どちらでも呼びは決まらない)。回すと幅 20 が縦になるので、線は z = −10。
 */
const SMALL_FRAME_NO_NOMINAL: FrameSetup = { kind: 't-slot-frame-small', size: 'small-20x10-l4.5-r4.5', z: -10, quarterTurns: 1 };

/** フレーム 1 本(中心線の y を指定)と平板のブラケット 1 つを置き、選ぶ窓を閉じる。 */
async function placeFrameAndPlate(page: Page, frameY: number, frame: FrameSetup = SERIES_FRAME,
  plate = 's6-36x16x2-h2'): Promise<void> {
  const dialog = await openFramePicker(page);
  await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption(frame.kind);
  await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption(frame.size);
  const layout = dialog.locator('details').filter({
    has: page.locator('summary', { hasText: uiMessagePattern('catalog', 'catalog.frameLayout.title') }),
  });
  await layout.locator('summary').click();
  if (frame.quarterTurns !== 0) await choice(layout, 'catalog', 'catalog.frameLayout.turn').selectOption(String(frame.quarterTurns));
  const z = String(frame.z);
  await layout.getByRole('textbox', { name: uiMessage('catalog', 'catalog.frameLayout.points'), exact: true })
    .fill([`-250\t${String(frameY)}\t${z}`, `250\t${String(frameY)}\t${z}`].join('\n'));
  await expectPreviewLengths(layout, ['500']);
  let token = await beginRecompute(page);
  await layout.getByRole('button', { name: uiMessage('catalog', 'catalog.frameLayout.place'), exact: true }).click();
  await waitForRecompute(page, token);
  await choice(dialog, 'catalog', 'catalog.frame.kind').selectOption('t-slot-flat-plate');
  await choice(dialog, 'assembly', 'assembly.standardPart.size').selectOption(plate);
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

// The top slot offsets are ±10 mm for the first two sections and 0 for the third.
const REGISTERED_TOP_SLOTS = [
  { width: 6, size: 's6-40x60-t2s3', y: 10, z: -30, plate: 's6-36x16x2-h2', thread: 'M5', length: '8' },
  { width: 8, size: 's8-50x100-t2s4', y: 10, z: -50, plate: 's8-55x24x3-h2', thread: 'M6', length: '12' },
  { width: 10, size: 's10-45x60-t1s1', y: 0, z: -30, plate: 's10-75x34x3-h2', thread: 'M8', length: '16' },
] as const;

type RegisteredTopSlot = (typeof REGISTERED_TOP_SLOTS)[number];

async function registeredSlotPreview(page: Page, scenario: RegisteredTopSlot): Promise<Locator> {
  await componentRows(page).nth(1).click();
  const dialog = await openFrameSlotTool(page);
  await choice(dialog, 'assembly', 'assembly.frameSlot.nominal').selectOption(scenario.thread);
  await expect(previewRows(dialog)).toHaveCount(2);
  for (const row of await previewRows(dialog).all()) {
    await expect(row).toContainText(uiMessage('assembly', 'assembly.frameSlot.face.top'));
    await expect(row.getByRole('cell').nth(2)).toContainText(`T 溝用ナット 溝幅 ${scenario.width} ${scenario.thread}`);
    await expect(row.getByRole('cell').nth(3)).toContainText(scenario.thread);
  }
  await expect(dialog.getByText(uiMessage('assembly', 'assembly.frameSlot.positionSimplified'), { exact: true })).toBeVisible();
  return dialog;
}

async function savedFrameSlotDocument(bytes: Uint8Array) {
  const bundle = await ex18ReadAssembly(bytes).catch((cause: unknown) => {
    throw new Error('保存した締結の組立を読み戻せません。', { cause });
  });
  return bundle.document;
}

export function registerFrameSlotFasteningTests(test: typeof base,
  appForPage: (page: Page) => ElectronApplication | undefined = () => undefined): void {
  test.describe('J-02 フレームの溝への締結', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    for (const scenario of REGISTERED_TOP_SLOTS) {
      test(`K-29 登録溝幅 ${scenario.width} の上面溝で締結し、保存した金物を開き直す`, async ({ page }, info) => {
        const app = appForPage(page);
        const kind = `t-slot-frame-s${scenario.width}`;
        await startAssembly(page, app);
        await placeFrameAndPlate(page, scenario.y, { kind, size: scenario.size, z: scenario.z, quarterTurns: 0 }, scenario.plate);
        const dialog = await registeredSlotPreview(page, scenario);
        const token = await beginRecompute(page);
        await dialog.getByRole('button', { name: uiMessage('assembly', 'assembly.frameSlot.commit'), exact: true }).click();
        await waitForRecompute(page, token);
        await expect(componentRows(page)).toHaveCount(6);

        const file = info.outputPath('registered-slot.pcada');
        const document = await savedFrameSlotDocument(await saveFlowFile(page, file, app));
        expect(document.components).toHaveLength(6);
        expect(document.components[0]?.source).toMatchObject({ options: { family: kind, item: scenario.size, length: '500' } });
        expect(document.components[1]?.source).toMatchObject({ options: { family: 't-slot-flat-plate', item: scenario.plate } });
        const installed = document.components.slice(2).map(({ source }) => source);
        expect(installed.filter((source) => source.kind === 'standardPart' &&
          source.options.item === `s${scenario.width}-${scenario.thread.toLowerCase()}-post-steel`)).toHaveLength(2);
        expect(installed.filter((source) => source.kind === 'standardPart' &&
          source.options.family === 'socket-head-cap-screw' && source.size === scenario.thread &&
          source.options.length === scenario.length)).toHaveLength(2);

        await openSaveFlowFile(page, file, app);
        await expect(componentRows(page)).toHaveCount(6);
        const reopened = await saveFlowFile(page, info.outputPath('registered-slot-reopened.pcada'), app);
        expect(await savedFrameSlotDocument(reopened)).toEqual(document);
        await registeredSlotPreview(page, scenario);
      });
    }

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

    test('溝の位置を中央に対して対称に置いた印つきの小さい溝つきフレームに留めると、予告の 2 行の下に溝の位置の簡略の知らせが出る', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      await placeFrameAndPlate(page, 0, SMALL_FRAME_SYMMETRIC);
      await componentRows(page).nth(1).click();
      const dialog = await openFrameSlotTool(page);
      await expect(previewRows(dialog)).toHaveCount(2);
      for (const row of await previewRows(dialog).all()) await expect(row).toContainText(NUT_NAME);
      await expect(dialog.getByText(uiMessage('assembly', 'assembly.frameSlot.positionSimplified'), { exact: true })).toBeVisible();
      await expect(dialog.getByTestId('frame-slot-commit')).toBeEnabled();
      expect(errors).toEqual([]);
    });

    test('溝幅の呼びが決まらない溝(口 4.5)に穴を合わせると、予告の 2 行が専用の理由になり、締結を押せない', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await startAssembly(page, appForPage(page));
      await placeFrameAndPlate(page, 0, SMALL_FRAME_NO_NOMINAL);
      await componentRows(page).nth(1).click();
      const dialog = await openFrameSlotTool(page);
      await expect(previewRows(dialog).and(page.getByRole('alert'))).toHaveCount(2);
      for (const row of await previewRows(dialog).all()) {
        await expect(row).toContainText(uiMessage('assembly', 'assembly.frameSlot.reason.slotNominalUnknown'));
      }
      await expect(dialog.getByText(uiMessage('assembly', 'assembly.frameSlot.positionSimplified'), { exact: true })).toHaveCount(0);
      await expect(dialog.getByTestId('frame-slot-commit')).toBeDisabled();
      expect(errors).toEqual([]);
    });
  });
}
