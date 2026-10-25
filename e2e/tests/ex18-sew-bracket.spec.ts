/// <reference lib="dom" />
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openToolMenu, toolMenuPanel } from './assemblyTestSupport.js';
import { disableFilePickers } from './boltedJointTestSupport.js';
import { openSaveFlowFile, saveFlowFile } from './saveResponsivenessFlow.js';
import { beginRecompute, waitForRecompute, waitForSettledRecompute } from './recompute.js';
import { uiMessage } from './uiMessages.js';
import {
  cancelPopover, clickWorldPoint, commitPopover, fillFields, popover, popoverInputs, popoverTitle,
  propertyPanel, selectionKindLabel, sketchTool, topFaceCenter, treeRow, type WorldPoint,
} from './solidCaptureSupport.js';

/*
 * EX-18 の 2 つ目の作り方(線・面・立体の混成)を、実際の画面の道具だけで通す。
 * packages/model/src/part/ex18BracketSewKernel.test.ts と同じ組み立て:
 *   点の道具で板の角 8 点と穴の中心 1 点を打つ(3 次元の座標)→ 面の道具で点 4 つずつから面を 6 枚張る →
 *   「作る」の「縫合」で 1 つの立体にする → 「加工」の「穴」で上面に φ6 の貫通穴をあける。
 * 独立した期待(手で求めた値): 板 40 × 30 × 10 = 12000 mm³、φ6 の貫通穴は π·3²·10、φ8 は π·4²·10。
 * その後に保存・開き直し・直径の式の編集(6 → 8)・1 回の Undo/Redo を確かめる。
 * 1 つ目(スケッチの押し出しと穴、solid.spec.ts)、3 つ目の面の移動、5 つ目(組立の文脈)の画面の検査と、
 * 2 つ目の幅の編集・保存の模型の検査(ex18BracketSewKernel.test.ts・ex18BracketPersistenceKernel.test.ts)は繰り返さない。
 */

const KERNEL_TIMEOUT_MS = 60_000;
const PLATE_VOLUME = 40 * 30 * 10;
const HOLE_6_THROUGH = Math.PI * 3 * 3 * 10;
const HOLE_8_THROUGH = Math.PI * 4 * 4 * 10;

/** 板の角(点1〜点8)と穴の中心(点9)。並びは ex18BracketSewKernel.test.ts の wireSketch と同じ。 */
const CORNERS: readonly WorldPoint[] = [
  [0, 0, 0], [40, 0, 0], [40, 30, 0], [0, 30, 0], [0, 0, 10], [40, 0, 10], [40, 30, 10], [0, 30, 10],
];
const HOLE_CENTER: WorldPoint = [10, 15, 10];
/** 面ごとの角(点の番号)。ex18BracketSewKernel.test.ts の loops と同じ順。 */
const FACE_LOOPS: readonly (readonly number[])[] = [
  [1, 2, 3, 4], [5, 6, 7, 8], [1, 2, 6, 5], [4, 3, 7, 8], [1, 4, 8, 5], [2, 3, 7, 6],
];

function treeSection(page: Page, title: string): Locator {
  return page.locator('.pcad-panel--left').locator('.pcad-tree__sections > li').filter({ hasText: title });
}

function solidRow(page: Page, name: string): Locator {
  return treeSection(page, 'ソリッド').getByRole('button', { name, exact: true });
}

function propertyValue(page: Page, key: string): Locator {
  return propertyPanel(page).locator('dt.pcad-properties__key', { hasText: key }).locator('xpath=following-sibling::dd[1]');
}

function propertyField(page: Page, label: string): Locator {
  return propertyPanel(page).locator('.pcad-field')
    .filter({ has: page.locator('.pcad-field__label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('input.pcad-field__input');
}

function machiningTool(page: Page, label: string): Locator {
  return page.getByRole('group', { name: '加工' }).getByRole('button', { name: label, exact: true });
}

async function volumeNumber(page: Page): Promise<number> {
  const cell = propertyValue(page, '体積');
  if ((await cell.count()) === 0) return Number.NaN;
  return Number.parseFloat(await cell.innerText());
}

/** 体積を許容差 0.01 mm³ で比べる(solid.spec.ts の expectVolume と同じ基準)。 */
async function expectVolume(page: Page, expected: number): Promise<void> {
  await expect.poll(async () => Math.abs((await volumeNumber(page)) - expected), {
    timeout: KERNEL_TIMEOUT_MS, message: `体積が ${String(expected)} mm³ ± 0.01 になること`,
  }).toBeLessThanOrEqual(0.01);
}

/** 点の道具で 3 次元の点を続けて打つ。 */
async function plotPoints(page: Page, points: readonly WorldPoint[]): Promise<void> {
  await sketchTool(page, '点').click();
  await expect(popoverTitle(page)).toHaveText('点を作る');
  for (const point of points) {
    await fillFields(page, point.map(String));
    await commitPopover(page);
  }
  await cancelPopover(page);
}

/** 公開の点の文脈コマンドで、選んだ 3 次元の点に閉じた輪郭と面を張る(facePointsFlow.ts と同じ操作)。 */
async function faceThroughPoints(page: Page, names: readonly string[]): Promise<void> {
  await waitForSettledRecompute(page);
  await sketchTool(page, '選択').click();
  const first = names[0];
  if (first === undefined) throw new Error('面の角がありません。');
  await treeRow(page, first).click();
  for (const name of names.slice(1)) await treeRow(page, name).click({ modifiers: ['Shift'] });
  await page.locator('canvas.pcad-viewport__canvas').focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('menu', { name: uiMessage('commands', 'radial.title'), exact: true });
  const command = menu.locator('[data-command-id="sketch.faceFromPoints"]');
  await expect(command).toBeVisible();
  await expect(command).not.toHaveAttribute('aria-disabled', 'true');
  const token = await beginRecompute(page);
  await command.click();
  await waitForRecompute(page, token);
  await expect(page.locator('.pcad-panel--left .pcad-tree__alert')).toHaveCount(0);
}

async function sewAllFaces(page: Page): Promise<void> {
  await treeRow(page, '面1').click();
  for (let index = 2; index <= FACE_LOOPS.length; index += 1) {
    await treeRow(page, `面${String(index)}`).click({ modifiers: ['Shift'] });
  }
  await openToolMenu(page, '作る');
  await toolMenuPanel(page, '作る').getByRole('button', { name: '縫合', exact: true }).click();
  await expect(popoverTitle(page)).toHaveText('つなぐ');
  const token = await beginRecompute(page);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await waitForRecompute(page, token);
}

async function drillThroughHole(page: Page): Promise<void> {
  await openToolMenu(page, '加工');
  const holeButton = machiningTool(page, '穴');
  await expect(holeButton).toBeDisabled();
  await holeButton.click({ force: true });
  await expect(selectionKindLabel(page)).toHaveText('選ぶもの 面');
  await clickWorldPoint(page, topFaceCenter(10));
  await treeRow(page, '点9').click({ modifiers: ['Shift'] });
  await openToolMenu(page, '加工');
  await expect(holeButton).toBeEnabled();
  await holeButton.click();
  await expect(popoverTitle(page)).toHaveText('穴をあける');
  await expect(popoverInputs(page).first()).toHaveValue('6');
  await popover(page).getByRole('switch', { name: '貫通', exact: true }).click();
  const token = await beginRecompute(page);
  await commitPopover(page);
  await expect(popover(page)).toHaveCount(0);
  await waitForRecompute(page, token);
}

test.describe('EX-18 線・面・立体の混成の画面', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('点から面を張って縫合し、穴をあけ、保存・開き直して直径を式で直し、1 回の Undo/Redo で戻せる', async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await disableFilePickers(page);
    await page.goto('/');
    await expect(page.locator('.pcad-viewport__empty-state')).toContainText('点をプロット');

    // 1) 点を 9 つ打つ。
    await plotPoints(page, [...CORNERS, HOLE_CENTER]);
    await expect(treeRow(page, '点9')).toBeVisible();

    // 2) 点 4 つずつを選んで面を 6 枚張る。
    for (const [index, loop] of FACE_LOOPS.entries()) {
      await faceThroughPoints(page, loop.map(point => `点${String(point)}`));
      await expect(treeRow(page, `面${String(index + 1)}`)).toBeVisible();
    }

    // 3) 6 枚を縫合して板にする。体積は 40 × 30 × 10。
    await sewAllFaces(page);
    await expect(solidRow(page, '縫合1')).toBeVisible();
    await solidRow(page, '縫合1').click();
    await expectVolume(page, PLATE_VOLUME);

    // 4) 縫合した板の上面と点9 で φ6 の貫通穴をあける。
    await drillThroughHole(page);
    await expect(solidRow(page, '穴1')).toBeVisible();
    await solidRow(page, '穴1').click();
    await expectVolume(page, PLATE_VOLUME - HOLE_6_THROUGH);
    await expect(propertyValue(page, '加工するもとの立体')).toHaveText('縫合1');

    // 5) 保存して開き直す。履歴(縫合1・穴1)から同じ形に戻る。
    const savedPath = info.outputPath('ex18-sew-bracket.pcad');
    await saveFlowFile(page, savedPath);
    await openSaveFlowFile(page, savedPath);
    await expect(solidRow(page, '縫合1')).toBeVisible();
    await expect(solidRow(page, '穴1')).toBeVisible();
    await solidRow(page, '穴1').click();
    await expectVolume(page, PLATE_VOLUME - HOLE_6_THROUGH);

    // 6) 開き直した穴の直径を式で 6 → 8 に直す。縫合した板の上で穴が作り直される。
    await expect(propertyField(page, '直径')).toHaveValue('6');
    //    欄から焦点を外して確定する(solid.spec.ts 1432〜1434 と同じく木の行を押す)。焦点が欄に残ったままの
    //    Ctrl+Z は欄の文字の取り消しになるので、次の段も木の行に焦点がある状態で押す。
    let token = await beginRecompute(page);
    await propertyField(page, '直径').fill('8');
    await solidRow(page, '穴1').click();
    await waitForRecompute(page, token);
    await expectVolume(page, PLATE_VOLUME - HOLE_8_THROUGH);

    // 7) 1 回の Undo で φ6 に、Redo で φ8 に戻る。
    token = await beginRecompute(page);
    await page.keyboard.press('Control+z');
    await waitForRecompute(page, token);
    await solidRow(page, '穴1').click();
    await expectVolume(page, PLATE_VOLUME - HOLE_6_THROUGH);
    token = await beginRecompute(page);
    await page.keyboard.press('Control+y');
    await waitForRecompute(page, token);
    await solidRow(page, '穴1').click();
    await expectVolume(page, PLATE_VOLUME - HOLE_8_THROUGH);

    expect(errors).toEqual([]);
  });
});
